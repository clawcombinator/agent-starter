// ============================================================
// CCAPEconomic — implements the economic primitives of CCAP:
// invoice, pay, balance, escrow.
//
// Every payment goes through SafetyMonitor before execution.
// Every action is appended to the AuditLogger.
// Escrow records are held in-memory (TODO: persist to Redis/DB).
// ============================================================

import crypto from 'node:crypto';
import type { AuditLogger } from '../audit.js';
import type { SafetyMonitor } from '../safety.js';
import type { AgentWallet } from '../wallet.js';
import type {
  BalanceParams,
  BalanceResult,
  EscrowParams,
  EscrowRecord,
  EscrowResult,
  InvoiceParams,
  InvoiceResult,
  PaymentParams,
  PaymentResult,
} from '../types.js';

// In-memory stores — replace with durable storage for production
const invoiceStore = new Map<string, InvoiceResult & InvoiceParams>();
const escrowStore = new Map<string, EscrowRecord>();

export class CCAPEconomic {
  constructor(
    private readonly wallet: AgentWallet,
    private readonly safety: SafetyMonitor,
    private readonly audit: AuditLogger,
    readonly ccApiUrl: string = 'https://api.clawcombinator.ai/v1',
  ) {}

  // ----------------------------------------------------------
  // invoice — create a payment request
  // ----------------------------------------------------------

  async invoice(params: InvoiceParams): Promise<InvoiceResult> {
    const invoiceId = this.generateInvoiceId();
    const expiresAt = params.dueDateIso ?? new Date(Date.now() + 86_400_000).toISOString();

    const result: InvoiceResult = {
      invoiceId,
      paymentUrl: `https://pay.clawcombinator.ai/i/${invoiceId}`,
      expiresAt,
      amount: params.amount,
      currency: params.currency,
    };

    // Persist locally
    invoiceStore.set(invoiceId, { ...params, ...result });

    this.audit.record('invoice_created', {
      invoiceId,
      amount: params.amount,
      currency: params.currency,
      description: params.description,
      recipientWallet: params.recipientWallet,
    });

    return result;
  }

  // ----------------------------------------------------------
  // pay — execute a payment after safety checks
  // ----------------------------------------------------------

  async pay(params: PaymentParams): Promise<PaymentResult> {
    // Safety gate — must pass before any funds move
    const check = await this.safety.checkOperation({
      type: 'payment',
      costUsd: params.amount,
      description: `Payment to ${params.recipientWallet}: ${params.memo}`,
      metadata: { invoiceId: params.invoiceId },
    });

    if (!check.allowed) {
      this.audit.record('payment_blocked', {
        reason: check.reason,
        params,
        requiresHumanApproval: check.requiresHumanApproval ?? false,
      });
      throw new SafetyViolationError(check.reason ?? 'Safety check failed', check);
    }

    // Execute on-chain transfer
    const result = await this.wallet.pay({
      amount: params.amount,
      currency: params.currency,
      recipient: params.recipientWallet,
      memo: params.memo,
    });

    // Commit the spend to the budget tracker
    this.safety.recordSpend(params.amount);

    // Optionally mark invoice as paid
    if (params.invoiceId) {
      const inv = invoiceStore.get(params.invoiceId);
      if (inv) {
        invoiceStore.set(params.invoiceId, { ...inv });
      }
    }

    this.audit.record('payment_sent', {
      transactionHash: result.transactionHash,
      amount: params.amount,
      currency: params.currency,
      recipientWallet: params.recipientWallet,
      memo: params.memo,
      invoiceId: params.invoiceId,
      fromCache: result.fromCache,
    });

    return {
      transactionId: result.transactionHash,
      status: 'completed',
      timestamp: new Date().toISOString(),
      costUsd: params.amount,
    };
  }

  // ----------------------------------------------------------
  // balance — query wallet balance
  // ----------------------------------------------------------

  async balance(params: BalanceParams): Promise<BalanceResult> {
    const bal = await this.wallet.getBalance(params.currency);
    const result: BalanceResult = {
      wallet: params.wallet ?? this.wallet.address ?? 'unknown',
      currency: params.currency,
      balance: bal,
      timestamp: new Date().toISOString(),
    };

    this.audit.record('balance_queried', { currency: params.currency, balance: bal });
    return result;
  }

  // ----------------------------------------------------------
  // escrow — lock funds with a timeout
  // ----------------------------------------------------------

  async escrow(params: EscrowParams): Promise<EscrowResult> {
    // Safety check for the escrow amount
    const check = await this.safety.checkOperation({
      type: 'escrow',
      costUsd: params.amount,
      description: `Escrow for ${params.beneficiary}: ${params.condition}`,
    });

    if (!check.allowed) {
      this.audit.record('escrow_blocked', { reason: check.reason, params });
      throw new SafetyViolationError(check.reason ?? 'Safety check failed', check);
    }

    const escrowId = `escrow_${crypto.randomBytes(8).toString('hex')}`;
    const expiresAt = new Date(Date.now() + params.timeoutSeconds * 1000).toISOString();

    const record: EscrowRecord = {
      escrowId,
      status: 'locked',
      amount: params.amount,
      currency: params.currency,
      expiresAt,
      beneficiary: params.beneficiary,
      condition: params.condition,
      createdAt: new Date().toISOString(),
    };

    escrowStore.set(escrowId, record);
    this.safety.recordSpend(params.amount);

    this.audit.record('escrow_created', {
      escrowId,
      amount: params.amount,
      currency: params.currency,
      beneficiary: params.beneficiary,
      condition: params.condition,
      expiresAt,
    });

    // Schedule expiry check
    setTimeout(() => void this.expireEscrow(escrowId), params.timeoutSeconds * 1000);

    return {
      escrowId,
      status: 'locked',
      amount: params.amount,
      currency: params.currency,
      expiresAt,
    };
  }

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------

  getInvoice(invoiceId: string): (InvoiceResult & InvoiceParams) | undefined {
    return invoiceStore.get(invoiceId);
  }

  getEscrow(escrowId: string): EscrowRecord | undefined {
    return escrowStore.get(escrowId);
  }

  private async expireEscrow(escrowId: string): Promise<void> {
    const record = escrowStore.get(escrowId);
    if (!record || record.status !== 'locked') return;

    escrowStore.set(escrowId, { ...record, status: 'expired' });
    this.audit.record('escrow_expired', { escrowId });

    // In a real implementation, refund the locked funds here
  }

  private generateInvoiceId(): string {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(4).toString('hex');
    return `inv_${ts}_${rand}`;
  }
}

// ----------------------------------------------------------
// Custom error type — carries the SafetyResult for callers
// ----------------------------------------------------------

export class SafetyViolationError extends Error {
  constructor(
    message: string,
    public readonly safetyResult: import('../types.js').SafetyResult,
  ) {
    super(message);
    this.name = 'SafetyViolationError';
  }
}
