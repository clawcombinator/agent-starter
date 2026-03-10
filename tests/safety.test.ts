// ============================================================
// Tests for SafetyMonitor — budget enforcement, rate limiting,
// kill switch, and audit integration.
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AuditLogger } from '../src/audit.js';
import { SafetyMonitor } from '../src/safety.js';
import type { Operation, SafetyConfig } from '../src/types.js';

function tempLogPath(): string {
  return path.join(os.tmpdir(), `safety_test_${crypto.randomBytes(4).toString('hex')}.jsonl`);
}

function makeConfig(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    budget: {
      dailyLimitUsd: 100,
      softLimitUsd: 80,
      transactionLimitUsd: 50,
      humanApprovalThresholdUsd: 75,
      ...overrides.budget,
    },
    rateLimits: {
      requestsPerMinute: 60,
      burstAllowance: 90,
      ...overrides.rateLimits,
    },
    escalation: {
      webhookUrls: [],    // No real webhooks in tests
      timeoutMinutes: 60,
      ...overrides.escalation,
    },
  };
}

function makeOp(costUsd: number, type: Operation['type'] = 'payment'): Operation {
  return { type, costUsd, description: `Test ${type} of $${costUsd}` };
}

describe('SafetyMonitor', () => {
  let audit: AuditLogger;
  let safety: SafetyMonitor;

  beforeEach(() => {
    audit = new AuditLogger(tempLogPath());
    safety = new SafetyMonitor(makeConfig(), audit);
  });

  // ----------------------------------------------------------
  // Budget enforcement
  // ----------------------------------------------------------

  it('allows an operation within the daily budget', async () => {
    const result = await safety.checkOperation(makeOp(10));
    expect(result.allowed).toBe(true);
  });

  it('blocks an operation that would exceed the daily budget', async () => {
    // Spend up to limit in increments below the per-transaction and approval thresholds
    for (let i = 0; i < 4; i++) {
      const op = makeOp(25);
      const check = await safety.checkOperation(op);
      expect(check.allowed).toBe(true);
      safety.recordSpend(25);
    }

    // Next operation should be blocked
    const second = await safety.checkOperation(makeOp(1));
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/budget/i);
  });

  it('blocks a single transaction above the per-transaction limit', async () => {
    // Transaction limit is 50 USD in our test config
    const result = await safety.checkOperation(makeOp(60));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/transaction/i);
    expect(result.requiresHumanApproval).toBe(true);
  });

  it('blocks and flags for approval when amount exceeds humanApprovalThreshold', async () => {
    // Threshold is 75 USD; transaction limit is 50 USD.
    // Test with config where transaction limit > approval threshold.
    const customAudit = new AuditLogger(tempLogPath());
    const customSafety = new SafetyMonitor(
      makeConfig({ budget: { dailyLimitUsd: 10000, softLimitUsd: 8000, transactionLimitUsd: 5000, humanApprovalThresholdUsd: 100 } }),
      customAudit,
    );

    const result = await customSafety.checkOperation(makeOp(150));
    expect(result.allowed).toBe(false);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.reason).toMatch(/approval/i);
  });

  it('recordSpend reduces the remaining budget', async () => {
    // Allow then spend
    const op = makeOp(30);
    await safety.checkOperation(op);
    safety.recordSpend(30);

    // Budget should now have 70 remaining — an op for 71 should be blocked
    const result = await safety.checkOperation(makeOp(71));
    expect(result.allowed).toBe(false);
  });

  it('tracks daily spend correctly', async () => {
    expect(safety.dailySpendUsd).toBe(0);
    await safety.checkOperation(makeOp(20));
    safety.recordSpend(20);
    expect(safety.dailySpendUsd).toBe(20);
  });

  // ----------------------------------------------------------
  // Rate limiting
  // ----------------------------------------------------------

  it('allows operations within rate limit', async () => {
    const result = await safety.checkOperation(makeOp(1));
    expect(result.allowed).toBe(true);
  });

  it('rate-limits when the token bucket is exhausted', async () => {
    // Configure a very tight rate limit so we can exhaust it quickly
    const tightAudit = new AuditLogger(tempLogPath());
    const tightSafety = new SafetyMonitor(
      makeConfig({ rateLimits: { requestsPerMinute: 2, burstAllowance: 2 } }),
      tightAudit,
    );

    // First two should pass (burst allowance = 2)
    const r1 = await tightSafety.checkOperation(makeOp(1));
    const r2 = await tightSafety.checkOperation(makeOp(1));
    const r3 = await tightSafety.checkOperation(makeOp(1)); // Should be rate-limited

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);
    expect(r3.retryAfterSeconds).toBeGreaterThan(0);
  });

  // ----------------------------------------------------------
  // Kill switch
  // ----------------------------------------------------------

  it('blocks all operations when kill switch is active', async () => {
    await safety.activateKillSwitch('test emergency');
    expect(safety.isKillSwitchActive).toBe(true);

    const result = await safety.checkOperation(makeOp(1));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/kill switch/i);
  });

  it('records kill switch activation in the audit log', async () => {
    await safety.activateKillSwitch('test reason');

    const entries = audit.export();
    const ksEntry = entries.find((e) => e.action === 'kill_switch_activated');
    expect(ksEntry).toBeTruthy();
    expect(ksEntry?.details['reason']).toBe('test reason');
  });

  // ----------------------------------------------------------
  // Audit integration
  // ----------------------------------------------------------

  it('records a passed safety check in the audit log', async () => {
    await safety.checkOperation(makeOp(5));

    const entries = audit.export();
    expect(entries.some((e) => e.action === 'safety_check_passed')).toBe(true);
  });

  it('records a blocked transaction in the audit log', async () => {
    // Exceed per-transaction limit (50 USD)
    await safety.checkOperation(makeOp(60));

    const entries = audit.export();
    expect(entries.some((e) => e.action === 'safety_block_transaction_limit')).toBe(true);
  });

  it('audit chain remains valid after multiple safety checks', async () => {
    await safety.checkOperation(makeOp(10));
    await safety.checkOperation(makeOp(20));
    await safety.checkOperation(makeOp(60)); // Blocked
    await safety.activateKillSwitch('test');

    const result = audit.verify();
    expect(result.valid).toBe(true);
  });

  // ----------------------------------------------------------
  // Budget exposure
  // ----------------------------------------------------------

  it('exposes dailyBudgetUsd from config', () => {
    expect(safety.dailyBudgetUsd).toBe(100);
  });
});
