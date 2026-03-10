// ============================================================
// Tests for CCAPEconomic — invoice creation, payment routing,
// balance aggregation, escrow lifecycle, and safety gate.
//
// Dependencies are replaced by lightweight test doubles so no
// network calls or blockchain access is required.
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AuditLogger } from '../src/audit.js';
import { SafetyMonitor } from '../src/safety.js';
import { PaymentRouter } from '../src/router.js';
import { CCAPEconomic, SafetyViolationError } from '../src/ccap/economic.js';
import type { PaymentProvider, Balance, PaymentParams, PaymentResult } from '../src/providers/types.js';
import type { SafetyConfig } from '../src/types.js';

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

function tempLogPath(): string {
  return path.join(os.tmpdir(), `econ_test_${crypto.randomBytes(4).toString('hex')}.jsonl`);
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

/**
 * Minimal mock PaymentProvider that succeeds without any network calls.
 */
function makeMockProvider(name: string = 'mock_crypto'): PaymentProvider {
  return {
    name,
    initialize: vi.fn().mockResolvedValue(undefined),
    getBalance: vi.fn().mockResolvedValue({
      amount: '100.00',
      currency: 'USDC',
      provider: name,
    } satisfies Balance),
    pay: vi.fn().mockResolvedValue({
      transactionId: `0xdeadbeef_${name}`,
      provider: name,
      status: 'completed',
      timestamp: new Date().toISOString(),
    } satisfies PaymentResult),
    supportsMethod: vi.fn().mockReturnValue(true),
  };
}

// ----------------------------------------------------------
// Test suite
// ----------------------------------------------------------

describe('CCAPEconomic', () => {
  let audit: AuditLogger;
  let safety: SafetyMonitor;
  let router: PaymentRouter;
  let provider: PaymentProvider;
  let economic: CCAPEconomic;

  beforeEach(() => {
    audit = new AuditLogger(tempLogPath());
    safety = new SafetyMonitor(makeConfig(), audit);
    router = new PaymentRouter(safety, audit);
    provider = makeMockProvider();
    router.registerProvider(provider);
    economic = new CCAPEconomic(router, safety, audit);
  });

  // ----------------------------------------------------------
  // invoice()
  // ----------------------------------------------------------

  describe('invoice()', () => {
    it('creates an invoice and returns invoiceId and paymentUrl', async () => {
      const result = await economic.invoice({
        amount: 10,
        currency: 'USDC',
        description: 'Test invoice',
        recipientWallet: '0xRecipient',
      });

      expect(result.invoiceId).toMatch(/^inv_/);
      expect(result.paymentUrl).toContain(result.invoiceId);
      expect(result.amount).toBe(10);
      expect(result.currency).toBe('USDC');
      expect(result.expiresAt).toBeTruthy();
    });

    it('stores the invoice retrievably', async () => {
      const result = await economic.invoice({
        amount: 25,
        currency: 'USDC',
        description: 'Stored invoice test',
        recipientWallet: '0xRecipient',
      });

      const stored = economic.getInvoice(result.invoiceId);
      expect(stored).toBeTruthy();
      expect(stored?.amount).toBe(25);
    });

    it('records invoice creation in the audit log', async () => {
      await economic.invoice({
        amount: 5,
        currency: 'USDC',
        description: 'Audit test',
        recipientWallet: '0xRecipient',
      });

      const entries = audit.export();
      expect(entries.some((e) => e.action === 'invoice_created')).toBe(true);
    });

    it('respects custom due date', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const result = await economic.invoice({
        amount: 1,
        currency: 'USDC',
        description: 'Custom due date',
        recipientWallet: '0xRecipient',
        dueDateIso: futureDate,
      });

      expect(result.expiresAt).toBe(futureDate);
    });
  });

  // ----------------------------------------------------------
  // pay() via router
  // ----------------------------------------------------------

  describe('pay()', () => {
    it('routes payment through the registered provider', async () => {
      const result = await economic.pay({
        amount: 10,
        currency: 'USDC',
        recipientWallet: '0xRecipient',
        memo: 'Service payment',
      });

      expect(result.transactionId).toContain('0xdeadbeef');
      expect(result.status).toBe('completed');
      expect(provider.pay).toHaveBeenCalledOnce();
    });

    it('records payment_sent in the audit log', async () => {
      await economic.pay({
        amount: 5,
        currency: 'USDC',
        recipientWallet: '0xRecipient',
        memo: 'Audit test',
      });

      const entries = audit.export();
      expect(entries.some((e) => e.action === 'payment_sent')).toBe(true);
    });

    it('throws SafetyViolationError when safety blocks the payment', async () => {
      // Amount exceeds the transactionLimitUsd (500)
      await expect(
        economic.pay({
          amount: 600,
          currency: 'USDC',
          recipientWallet: '0xRecipient',
          memo: 'Too large',
        }),
      ).rejects.toThrow(SafetyViolationError);
    });

    it('does NOT call provider.pay when safety check fails', async () => {
      try {
        await economic.pay({ amount: 600, currency: 'USDC', recipientWallet: '0x', memo: 'blocked' });
      } catch {
        // Expected
      }

      expect(provider.pay).not.toHaveBeenCalled();
    });

    it('falls back to a second provider when the first fails', async () => {
      // Make the first provider fail
      vi.mocked(provider.pay).mockRejectedValueOnce(new Error('Provider offline'));

      // Register a second provider that succeeds
      const fallback = makeMockProvider('fallback_stripe');
      router.registerProvider(fallback);

      const result = await economic.pay({
        amount: 10,
        currency: 'USD',
        recipientWallet: '0xRecipient',
        memo: 'Fallback test',
      });

      expect(result.status).toBe('completed');
      expect(fallback.pay).toHaveBeenCalledOnce();
    });
  });

  // ----------------------------------------------------------
  // balance() — aggregate across providers
  // ----------------------------------------------------------

  describe('balance()', () => {
    it('returns balances from all registered providers', async () => {
      const results = await economic.balance({ currency: 'USDC' });

      expect(results).toHaveLength(1);
      expect(results[0]!.balance).toBe('100.00');
      expect(results[0]!.currency).toBe('USDC');
    });

    it('aggregates across multiple providers', async () => {
      const second = makeMockProvider('stripe');
      vi.mocked(second.getBalance).mockResolvedValue({
        amount: '50.00',
        currency: 'USD',
        provider: 'stripe',
      });
      router.registerProvider(second);

      const results = await economic.balance({ currency: 'USD' });
      expect(results).toHaveLength(2);
    });

    it('records balance_queried in audit log', async () => {
      await economic.balance({ currency: 'USDC' });

      const entries = audit.export();
      expect(entries.some((e) => e.action === 'balance_queried')).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // escrow()
  // ----------------------------------------------------------

  describe('escrow()', () => {
    it('creates an escrow record with locked status', async () => {
      const result = await economic.escrow({
        amount: 50,
        currency: 'USDC',
        beneficiary: '0xBeneficiary',
        condition: 'Deliver document within 24h',
        timeoutSeconds: 86400,
      });

      expect(result.escrowId).toMatch(/^escrow_/);
      expect(result.status).toBe('locked');
      expect(result.amount).toBe(50);
      expect(result.currency).toBe('USDC');
      expect(result.expiresAt).toBeTruthy();
    });

    it('stores escrow retrievably', async () => {
      const result = await economic.escrow({
        amount: 20,
        currency: 'USDC',
        beneficiary: '0xBeneficiary',
        condition: 'Test condition',
        timeoutSeconds: 3600,
      });

      const stored = economic.getEscrow(result.escrowId);
      expect(stored).toBeTruthy();
      expect(stored?.beneficiary).toBe('0xBeneficiary');
      expect(stored?.condition).toBe('Test condition');
    });

    it('records escrow_created in audit log', async () => {
      await economic.escrow({
        amount: 10,
        currency: 'USDC',
        beneficiary: '0xB',
        condition: 'Condition',
        timeoutSeconds: 60,
      });

      const entries = audit.export();
      expect(entries.some((e) => e.action === 'escrow_created')).toBe(true);
    });

    it('throws SafetyViolationError when escrow amount exceeds transaction limit', async () => {
      await expect(
        economic.escrow({
          amount: 600, // exceeds 500 USD limit
          currency: 'USDC',
          beneficiary: '0xB',
          condition: 'Too large',
          timeoutSeconds: 60,
        }),
      ).rejects.toThrow(SafetyViolationError);
    });

    it('sets expiry time based on timeoutSeconds', async () => {
      const before = Date.now();
      const result = await economic.escrow({
        amount: 10,
        currency: 'USDC',
        beneficiary: '0xB',
        condition: 'Timed escrow',
        timeoutSeconds: 3600,
      });
      const after = Date.now();

      const expiresAtMs = new Date(result.expiresAt).getTime();
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(expiresAtMs).toBeLessThanOrEqual(after + 3600 * 1000 + 1000);
    });
  });

  // ----------------------------------------------------------
  // Audit chain integrity
  // ----------------------------------------------------------

  it('audit chain is valid after a full payment workflow', async () => {
    await economic.invoice({ amount: 50, currency: 'USDC', description: 'Invoice', recipientWallet: '0xR' });
    await economic.pay({ amount: 10, currency: 'USDC', recipientWallet: '0xR', memo: 'Pay' });
    await economic.balance({ currency: 'USDC' });
    await economic.escrow({ amount: 20, currency: 'USDC', beneficiary: '0xB', condition: 'Cond', timeoutSeconds: 60 });

    const result = audit.verify();
    expect(result.valid).toBe(true);
  });
});
