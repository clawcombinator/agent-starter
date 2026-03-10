// ============================================================
// Tests for PaymentRouter — routing logic, provider selection,
// fallback behaviour, safety gate integration, and balance
// aggregation.
//
// All providers are lightweight mocks — no network calls.
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AuditLogger } from '../src/audit.js';
import { SafetyMonitor } from '../src/safety.js';
import { PaymentRouter, RouterError } from '../src/router.js';
import type { PaymentProvider, Balance, PaymentParams, PaymentResult, PaymentMethod } from '../src/providers/types.js';
import type { SafetyConfig } from '../src/types.js';

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

function tempLogPath(): string {
  return path.join(os.tmpdir(), `router_test_${crypto.randomBytes(4).toString('hex')}.jsonl`);
}

function makeConfig(overrides: Partial<SafetyConfig['budget']> = {}): SafetyConfig {
  return {
    budget: {
      dailyLimitUsd: 1000,
      softLimitUsd: 800,
      transactionLimitUsd: 500,
      humanApprovalThresholdUsd: 750,
      ...overrides,
    },
    rateLimits: { requestsPerMinute: 600, burstAllowance: 900 },
    escalation: { webhookUrls: [], timeoutMinutes: 60 },
  };
}

function makeParams(amount: number = 10): PaymentParams {
  return {
    amount,
    currency: 'USDC',
    recipient: '0xRecipient',
    memo: 'Test payment',
  };
}

function makeProvider(name: string, methods: PaymentMethod[] = ['crypto']): PaymentProvider {
  return {
    name,
    initialize: vi.fn().mockResolvedValue(undefined),
    getBalance: vi.fn().mockResolvedValue({
      amount: '100.00',
      currency: 'USDC',
      provider: name,
    } satisfies Balance),
    pay: vi.fn().mockResolvedValue({
      transactionId: `tx_${name}_ok`,
      provider: name,
      status: 'completed',
      timestamp: new Date().toISOString(),
    } satisfies PaymentResult),
    supportsMethod: vi.fn((m: PaymentMethod) => methods.includes(m)),
  };
}

// ----------------------------------------------------------
// Test suite
// ----------------------------------------------------------

describe('PaymentRouter', () => {
  let audit: AuditLogger;
  let safety: SafetyMonitor;
  let router: PaymentRouter;

  beforeEach(() => {
    audit = new AuditLogger(tempLogPath());
    safety = new SafetyMonitor(makeConfig(), audit);
    router = new PaymentRouter(safety, audit);
  });

  // ----------------------------------------------------------
  // Provider registration
  // ----------------------------------------------------------

  describe('registerProvider()', () => {
    it('registers a provider and lists it', () => {
      const p = makeProvider('coinbase');
      router.registerProvider(p);
      expect(router.listProviders()).toContain('coinbase');
    });

    it('records provider_registered in audit log', () => {
      router.registerProvider(makeProvider('coinbase'));
      const entries = audit.export();
      expect(entries.some((e) => e.action === 'provider_registered')).toBe(true);
    });

    it('allows multiple providers', () => {
      router.registerProvider(makeProvider('coinbase'));
      router.registerProvider(makeProvider('stripe', ['card']));
      expect(router.listProviders()).toHaveLength(2);
    });
  });

  // ----------------------------------------------------------
  // route() — happy path
  // ----------------------------------------------------------

  describe('route() — happy path', () => {
    it('routes to the single registered provider', async () => {
      const p = makeProvider('coinbase');
      router.registerProvider(p);

      const result = await router.route(makeParams());
      expect(result.status).toBe('completed');
      expect(p.pay).toHaveBeenCalledOnce();
    });

    it('returns a PaymentResult with provider name', async () => {
      router.registerProvider(makeProvider('coinbase'));
      const result = await router.route(makeParams());
      expect(result.provider).toBe('coinbase');
    });

    it('records routing_decision and payment_completed in audit log', async () => {
      router.registerProvider(makeProvider('coinbase'));
      await router.route(makeParams());

      const entries = audit.export();
      expect(entries.some((e) => e.action === 'router_routing_decision')).toBe(true);
      expect(entries.some((e) => e.action === 'router_payment_completed')).toBe(true);
    });

    it('commits the spend to the safety budget tracker', async () => {
      router.registerProvider(makeProvider('coinbase'));
      expect(safety.dailySpendUsd).toBe(0);

      await router.route(makeParams(30));
      expect(safety.dailySpendUsd).toBe(30);
    });
  });

  // ----------------------------------------------------------
  // route() — provider selection
  // ----------------------------------------------------------

  describe('route() — provider selection', () => {
    it('uses preferProvider hint when specified', async () => {
      const coinbase = makeProvider('coinbase', ['crypto']);
      const stripe = makeProvider('stripe', ['card']);
      router.registerProvider(coinbase);
      router.registerProvider(stripe);

      await router.route(makeParams(), { preferProvider: 'stripe' });
      expect(stripe.pay).toHaveBeenCalledOnce();
      expect(coinbase.pay).not.toHaveBeenCalled();
    });

    it('filters providers by payment method', async () => {
      const coinbase = makeProvider('coinbase', ['crypto']);
      const stripe = makeProvider('stripe', ['card']);
      router.registerProvider(coinbase);
      router.registerProvider(stripe);

      // Request card-only payment — should only use Stripe
      const params: PaymentParams = { ...makeParams(), method: 'card' };
      await router.route(params);

      expect(stripe.pay).toHaveBeenCalledOnce();
      expect(coinbase.pay).not.toHaveBeenCalled();
    });

    it('throws RouterError with NO_PROVIDER when no provider supports the method', async () => {
      router.registerProvider(makeProvider('coinbase', ['crypto']));

      const params: PaymentParams = { ...makeParams(), method: 'x402' };
      await expect(router.route(params)).rejects.toThrow(RouterError);

      try {
        await router.route(params);
      } catch (err) {
        expect((err as RouterError).code).toBe('NO_PROVIDER');
      }
    });

    it('throws RouterError with NO_PROVIDER when router has no providers', async () => {
      await expect(router.route(makeParams())).rejects.toThrow(RouterError);
    });
  });

  // ----------------------------------------------------------
  // route() — fallback behaviour
  // ----------------------------------------------------------

  describe('route() — fallback', () => {
    it('falls back to second provider when first fails', async () => {
      const primary = makeProvider('coinbase');
      vi.mocked(primary.pay).mockRejectedValueOnce(new Error('Network error'));

      const fallback = makeProvider('stripe');
      router.registerProvider(primary);
      router.registerProvider(fallback);

      const result = await router.route(makeParams(), { preferProvider: 'coinbase' });
      expect(result.provider).toBe('stripe');
      expect(fallback.pay).toHaveBeenCalledOnce();
    });

    it('throws RouterError with ALL_FAILED when all providers fail', async () => {
      const p1 = makeProvider('coinbase');
      const p2 = makeProvider('stripe');
      vi.mocked(p1.pay).mockRejectedValue(new Error('p1 failed'));
      vi.mocked(p2.pay).mockRejectedValue(new Error('p2 failed'));

      router.registerProvider(p1);
      router.registerProvider(p2);

      await expect(router.route(makeParams())).rejects.toThrow(RouterError);

      try {
        await router.route(makeParams());
      } catch (err) {
        expect((err as RouterError).code).toBe('ALL_FAILED');
      }
    });

    it('records provider_failed entries for each failed provider', async () => {
      const p = makeProvider('coinbase');
      vi.mocked(p.pay).mockRejectedValue(new Error('failed'));
      router.registerProvider(p);

      try {
        await router.route(makeParams());
      } catch {
        // Expected
      }

      const entries = audit.export();
      expect(entries.some((e) => e.action === 'router_provider_failed')).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // route() — safety gate
  // ----------------------------------------------------------

  describe('route() — safety gate', () => {
    it('blocks payment when it exceeds transactionLimitUsd', async () => {
      router.registerProvider(makeProvider('coinbase'));

      await expect(router.route(makeParams(600))).rejects.toThrow(RouterError);

      try {
        await router.route(makeParams(600));
      } catch (err) {
        expect((err as RouterError).code).toBe('SAFETY_BLOCKED');
      }
    });

    it('does NOT call any provider when safety blocks', async () => {
      const p = makeProvider('coinbase');
      router.registerProvider(p);

      try {
        await router.route(makeParams(600));
      } catch {
        // Expected
      }

      expect(p.pay).not.toHaveBeenCalled();
    });

    it('records router_payment_blocked in audit when safety blocks', async () => {
      router.registerProvider(makeProvider('coinbase'));

      try {
        await router.route(makeParams(600));
      } catch {
        // Expected
      }

      const entries = audit.export();
      expect(entries.some((e) => e.action === 'router_payment_blocked')).toBe(true);
    });

    it('blocks all payments when kill switch is active', async () => {
      router.registerProvider(makeProvider('coinbase'));
      await safety.activateKillSwitch('test');

      await expect(router.route(makeParams(1))).rejects.toThrow(RouterError);
    });
  });

  // ----------------------------------------------------------
  // getAggregateBalance()
  // ----------------------------------------------------------

  describe('getAggregateBalance()', () => {
    it('returns one balance entry per provider', async () => {
      router.registerProvider(makeProvider('coinbase'));
      router.registerProvider(makeProvider('stripe', ['card']));

      const balances = await router.getAggregateBalance('USDC');
      expect(balances).toHaveLength(2);
      expect(balances.map((b) => b.provider)).toContain('coinbase');
      expect(balances.map((b) => b.provider)).toContain('stripe');
    });

    it('returns zero balance for a provider that errors', async () => {
      const p = makeProvider('coinbase');
      vi.mocked(p.getBalance).mockRejectedValue(new Error('offline'));
      router.registerProvider(p);

      const balances = await router.getAggregateBalance('USDC');
      expect(balances).toHaveLength(1);
      expect(balances[0]!.amount).toBe('0.00');
    });

    it('records router_balance_queried in audit log', async () => {
      router.registerProvider(makeProvider('coinbase'));
      await router.getAggregateBalance();

      const entries = audit.export();
      expect(entries.some((e) => e.action === 'router_balance_queried')).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // providerStatus()
  // ----------------------------------------------------------

  describe('providerStatus()', () => {
    it('returns available=true for a healthy provider', async () => {
      router.registerProvider(makeProvider('coinbase', ['crypto']));
      const statuses = await router.providerStatus();

      expect(statuses).toHaveLength(1);
      expect(statuses[0]!.available).toBe(true);
      expect(statuses[0]!.supportedMethods).toContain('crypto');
    });

    it('returns available=false for a provider that errors on getBalance', async () => {
      const p = makeProvider('coinbase');
      vi.mocked(p.getBalance).mockRejectedValue(new Error('offline'));
      router.registerProvider(p);

      const statuses = await router.providerStatus();
      expect(statuses[0]!.available).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // Audit chain integrity
  // ----------------------------------------------------------

  it('audit chain remains valid after multiple routing operations', async () => {
    const p = makeProvider('coinbase');
    router.registerProvider(p);

    await router.route(makeParams(10));
    await router.route(makeParams(20));

    // Trigger a safety block (does not break the chain)
    try {
      await router.route(makeParams(600));
    } catch {
      // Expected
    }

    await router.getAggregateBalance();

    const result = audit.verify();
    expect(result.valid).toBe(true);
  });
});
