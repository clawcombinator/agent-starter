// ============================================================
// Tests for CCAPEconomic — invoice creation, payment flow,
// balance query, escrow lifecycle, and safety gate integration.
//
// All external dependencies (wallet, safety) are replaced by
// lightweight test doubles to avoid network calls.
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AuditLogger } from '../src/audit.js';
import { SafetyMonitor } from '../src/safety.js';
import { CCAPEconomic, SafetyViolationError } from '../src/ccap/economic.js';
import type { AgentWallet } from '../src/wallet.js';
import type { SafetyConfig } from '../src/types.js';

// ----------------------------------------------------------
// Test doubles
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

/** Minimal mock wallet that returns predictable results without hitting Coinbase. */
function makeMockWallet(address = '0xTestAddress'): AgentWallet {
  return {
    address,
    isConnected: true,
    initialize: vi.fn().mockResolvedValue(undefined),
    getBalance: vi.fn().mockResolvedValue('100.00'),
    getStatus: vi.fn().mockResolvedValue({ address, network: 'base-sepolia', balances: { USDC: '100.00' } }),
    pay: vi.fn().mockResolvedValue({
      transactionHash: '0xdeadbeef1234567890',
      idempotencyKey: 'pay_test_key',
      fromCache: false,
    }),
    generateIdempotencyKey: vi.fn().mockReturnValue('pay_test_key'),
  } as unknown as AgentWallet;
}

// ----------------------------------------------------------
// Test suite
// ----------------------------------------------------------

describe('CCAPEconomic', () => {
  let audit: AuditLogger;
  let safety: SafetyMonitor;
  let wallet: AgentWallet;
  let economic: CCAPEconomic;

  beforeEach(() => {
    audit = new AuditLogger(tempLogPath());
    safety = new SafetyMonitor(makeConfig(), audit);
    wallet = makeMockWallet();
    economic = new CCAPEconomic(wallet, safety, audit);
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

    it('records invoice creation in audit log', async () => {
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
  // pay()
  // ----------------------------------------------------------

  describe('pay()', () => {
    it('executes a payment and returns transactionId', async () => {
      const result = await economic.pay({
        amount: 10,
        currency: 'USDC',
        recipientWallet: '0xRecipient',
        memo: 'Service payment',
      });

      expect(result.transactionId).toBe('0xdeadbeef1234567890');
      expect(result.status).toBe('completed');
      expect(result.costUsd).toBe(10);
    });

    it('calls wallet.pay with correct parameters', async () => {
      await economic.pay({
        amount: 15,
        currency: 'USDC',
        recipientWallet: '0xRecipient',
        memo: 'Test memo',
      });

      expect(wallet.pay).toHaveBeenCalledWith({
        amount: 15,
        currency: 'USDC',
        recipient: '0xRecipient',
        memo: 'Test memo',
      });
    });

    it('records payment in audit log', async () => {
      await economic.pay({
        amount: 5,
        currency: 'USDC',
        recipientWallet: '0xRecipient',
        memo: 'Audit test',
      });

      const entries = audit.export();
      expect(entries.some((e) => e.action === 'payment_sent')).toBe(true);
    });

    it('throws SafetyViolationError when amount exceeds transaction limit', async () => {
      await expect(
        economic.pay({
          amount: 600, // exceeds 500 USD transactionLimitUsd
          currency: 'USDC',
          recipientWallet: '0xRecipient',
          memo: 'Too large',
        }),
      ).rejects.toThrow(SafetyViolationError);
    });

    it('records blocked payments in audit log', async () => {
      try {
        await economic.pay({
          amount: 600,
          currency: 'USDC',
          recipientWallet: '0xRecipient',
          memo: 'Blocked payment',
        });
      } catch {
        // Expected
      }

      const entries = audit.export();
      expect(entries.some((e) => e.action === 'payment_blocked')).toBe(true);
    });

    it('does NOT call wallet.pay when safety check fails', async () => {
      try {
        await economic.pay({ amount: 600, currency: 'USDC', recipientWallet: '0x', memo: 'blocked' });
      } catch {
        // Expected
      }

      expect(wallet.pay).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // balance()
  // ----------------------------------------------------------

  describe('balance()', () => {
    it('returns current balance from wallet', async () => {
      const result = await economic.balance({ currency: 'USDC' });

      expect(result.balance).toBe('100.00');
      expect(result.currency).toBe('USDC');
      expect(result.timestamp).toBeTruthy();
    });

    it('records balance query in audit log', async () => {
      await economic.balance({ currency: 'USDC' });

      const entries = audit.export();
      expect(entries.some((e) => e.action === 'balance_queried')).toBe(true);
    });

    it('uses wallet address when no wallet param provided', async () => {
      const result = await economic.balance({ currency: 'USDC' });
      expect(result.wallet).toBe('0xTestAddress');
    });

    it('uses provided wallet address when specified', async () => {
      const result = await economic.balance({ wallet: '0xCustomAddress', currency: 'USDC' });
      expect(result.wallet).toBe('0xCustomAddress');
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

    it('records escrow creation in audit log', async () => {
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
      // Should expire between 3600s from before and 3600s from after
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(expiresAtMs).toBeLessThanOrEqual(after + 3600 * 1000 + 1000);
    });
  });

  // ----------------------------------------------------------
  // Audit chain integrity after multiple operations
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
