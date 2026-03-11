// ============================================================
// MockProvider — a fully in-memory PaymentProvider for demos
// and testing. No real API keys required.
//
// Design principles:
//   - Implements PaymentProvider interface exactly
//   - Accepts all payments up to a configurable limit
//   - Tracks balances per wallet in memory
//   - Simulates realistic network delays (100–500 ms)
//   - Logs all operations with coloured console output
// ============================================================

import crypto from 'node:crypto';
import type { Balance, PaymentMethod, PaymentParams, PaymentProvider, PaymentResult } from '../src/providers/types.js';

// ----------------------------------------------------------
// ANSI colour helpers
// ----------------------------------------------------------

export const C = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
} as const;

function sys(msg: string): void {
  console.log(`${C.yellow}[MOCK-PROVIDER]${C.reset} ${msg}`);
}

// ----------------------------------------------------------
// Simulated delay — mimics real network latency
// ----------------------------------------------------------

function delay(minMs: number = 100, maxMs: number = 500): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------
// MockProvider
// ----------------------------------------------------------

export interface MockProviderOptions {
  /** Maximum amount per single transaction. Default: 10_000. */
  transactionLimitUsd?: number;
  /** Starting balance for every wallet that first appears. Default: 1_000. */
  defaultStartingBalance?: number;
  /** Currency this provider operates in. Default: 'USD'. */
  currency?: string;
}

export class MockProvider implements PaymentProvider {
  readonly name = 'mock';

  private readonly transactionLimitUsd: number;
  private readonly defaultStartingBalance: number;
  private readonly currency: string;

  // Wallet address → balance (in provider currency units)
  private readonly balances = new Map<string, number>();

  // Set of seen idempotency keys to prevent duplicate payments
  private readonly processedKeys = new Set<string>();

  // Running total of all payments processed
  private totalProcessed = 0;
  private paymentCount = 0;

  constructor(options: MockProviderOptions = {}) {
    this.transactionLimitUsd  = options.transactionLimitUsd      ?? 10_000;
    this.defaultStartingBalance = options.defaultStartingBalance ?? 1_000;
    this.currency              = options.currency                ?? 'USD';
  }

  // ----------------------------------------------------------
  // Initialise — seed a "provider" wallet so balance queries work
  // ----------------------------------------------------------

  async initialize(): Promise<void> {
    sys(`Initialising (limit=$${this.transactionLimitUsd}, default balance=$${this.defaultStartingBalance})`);
    await delay(50, 150);
    sys(`${C.green}Ready${C.reset} — no API keys required`);
  }

  // ----------------------------------------------------------
  // getBalance — returns balance for a wallet (or provider total)
  // ----------------------------------------------------------

  async getBalance(currency?: string): Promise<Balance> {
    await delay(50, 100);

    // Aggregate across all tracked wallets for a "provider total"
    const total = Array.from(this.balances.values()).reduce((a, b) => a + b, 0);

    return {
      amount: total.toFixed(2),
      currency: currency ?? this.currency,
      provider: this.name,
    };
  }

  // ----------------------------------------------------------
  // getWalletBalance — helper for demo agents to check individual wallets
  // ----------------------------------------------------------

  getWalletBalance(wallet: string): number {
    return this.balances.get(wallet) ?? this.defaultStartingBalance;
  }

  // ----------------------------------------------------------
  // seedWallet — pre-fund a wallet address (call before demo starts)
  // ----------------------------------------------------------

  seedWallet(wallet: string, amount: number): void {
    const current = this.balances.get(wallet) ?? 0;
    this.balances.set(wallet, current + amount);
    sys(`Seeded wallet ${C.dim}${wallet.slice(0, 12)}…${C.reset} with $${amount.toFixed(2)} (total: $${(current + amount).toFixed(2)})`);
  }

  // ----------------------------------------------------------
  // pay — the core operation
  // ----------------------------------------------------------

  async pay(params: PaymentParams): Promise<PaymentResult> {
    sys(`Processing payment: $${params.amount} ${params.currency} → ${C.dim}${params.recipient.slice(0, 16)}…${C.reset}`);
    if (params.memo) sys(`  Memo: ${C.dim}${params.memo}${C.reset}`);

    // Idempotency check [safe to repeat without side-effects]
    if (params.idempotencyKey && this.processedKeys.has(params.idempotencyKey)) {
      sys(`${C.yellow}Duplicate detected${C.reset} — returning cached result for key ${params.idempotencyKey}`);
      return this.buildResult('completed');
    }

    // Simulate network delay
    await delay(150, 400);

    // Validate transaction limit
    if (params.amount > this.transactionLimitUsd) {
      const msg = `Amount $${params.amount} exceeds provider limit $${this.transactionLimitUsd}`;
      sys(`${C.red}REJECTED${C.reset} — ${msg}`);
      throw new Error(msg);
    }

    // Ensure sender has sufficient funds (look up by recipient as proxy — in mock, we track by recipient)
    // In a real provider the sender is authenticated via API keys; here we simply
    // ensure the recipient wallet gets credited and a global debit is tracked.
    const recipientBalance = this.balances.get(params.recipient) ?? this.defaultStartingBalance;
    this.balances.set(params.recipient, recipientBalance + params.amount);

    // Mark idempotency key as used
    if (params.idempotencyKey) {
      this.processedKeys.add(params.idempotencyKey);
    }

    // Update counters
    this.totalProcessed += params.amount;
    this.paymentCount += 1;

    const result = this.buildResult('completed');
    sys(`${C.green}SETTLED${C.reset} — txn ${C.dim}${result.transactionId}${C.reset} | running total: $${this.totalProcessed.toFixed(2)} across ${this.paymentCount} payment(s)`);

    return result;
  }

  // ----------------------------------------------------------
  // supportsMethod — this mock accepts crypto and card
  // ----------------------------------------------------------

  supportsMethod(method: PaymentMethod): boolean {
    return method === 'crypto' || method === 'card' || method === 'x402' || method === 'bank_transfer';
  }

  // ----------------------------------------------------------
  // Stats — expose for demo summary
  // ----------------------------------------------------------

  get stats(): { totalProcessed: number; paymentCount: number } {
    return { totalProcessed: this.totalProcessed, paymentCount: this.paymentCount };
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private buildResult(status: PaymentResult['status']): PaymentResult {
    return {
      transactionId: `mock_txn_${crypto.randomBytes(6).toString('hex')}`,
      provider: this.name,
      status,
      timestamp: new Date().toISOString(),
    };
  }
}
