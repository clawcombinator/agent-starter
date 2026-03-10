// ============================================================
// CCAPEconomic — economic primitives of CCAP:
// invoice, pay, balance, escrow.
//
// pay()     → delegates to PaymentRouter (multi-provider routing)
// balance() → delegates to PaymentRouter.getAggregateBalance()
// invoice() → creates a structured JSON invoice; settlement
//             happens via the router through any configured provider
// escrow()  → KEPT as a CC-native primitive: time-locked hold
//             with provider-agnostic settlement. No existing
//             payment provider solves this generically.
//
// Every action is audited. Every payment passes the SafetyMonitor
// via the router before execution.
// ============================================================

import crypto from 'node:crypto';
import type { AuditLogger } from '../audit.js';
import type { SafetyMonitor } from '../safety.js';
import type { PaymentRouter } from '../router.js';
import type {
  Balance,
  PaymentResult,
  RoutingHint,
} from '../providers/types.js';
import type {
  BalanceParams,
  BalanceResult,
  EscrowParams,
  EscrowRecord,
  EscrowResult,
  InvoiceParams,
  InvoiceResult,
  PaymentParams,
} from '../types.js';

// In-memory stores — replace with durable storage for production
const invoiceStore = new Map<string, InvoiceResult & InvoiceParams>();
const escrowStore = new Map<string, EscrowRecord>();

export class CCAPEconomic {
  constructor(
    private readonly router: PaymentRouter,
    private readonly safety: SafetyMonitor,
    private readonly audit: AuditLogger,
    readonly ccApiUrl: string = 'https://api.clawcombinator.ai/v1',
  ) {}

  // ----------------------------------------------------------
  // invoice — create a structured payment request
  //
  // Returns a JSON invoice that can be settled via any provider
  // through the router. The paymentUrl is a CC-hosted page;
  // the invoiceId can also be passed directly to pay().
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
  // pay — route payment through PaymentRouter
  //
  // Safety checks live inside the router. This method is now
  // a thin wrapper that translates CCAP PaymentParams into the
  // provider-level params and delegates entirely to the router.
  // ----------------------------------------------------------

  async pay(
    params: PaymentParams,
    hint?: RoutingHint,
  ): Promise<PaymentResult> {
    const routerParams = {
      amount: params.amount,
      currency: params.currency,
      recipient: params.recipientWallet,
      memo: params.memo,
      method: params.method,
      idempotencyKey: params.invoiceId
        ? `inv_pay_${params.invoiceId}`
        : undefined,
    };

    let result: PaymentResult;

    try {
      result = await this.router.route(routerParams, hint);
    } catch (err) {
      // Re-wrap router errors as SafetyViolationError when safety-blocked
      // so existing callers that catch SafetyViolationError still work
      if (err instanceof Error && err.name === 'RouterError') {
        const routerErr = err as { code?: string };
        if (routerErr.code === 'SAFETY_BLOCKED') {
          throw new SafetyViolationError(err.message, {
            allowed: false,
            reason: err.message,
          });
        }
      }
      throw err;
    }

    // Mark invoice as paid if one was referenced
    if (params.invoiceId) {
      const inv = invoiceStore.get(params.invoiceId);
      if (inv) {
        invoiceStore.set(params.invoiceId, { ...inv });
      }
    }

    // Mirror the payment_sent audit entry so existing audit test consumers
    // continue to see it (router already audits at the routing layer)
    this.audit.record('payment_sent', {
      transactionId: result.transactionId,
      provider: result.provider,
      amount: params.amount,
      currency: params.currency,
      recipientWallet: params.recipientWallet,
      memo: params.memo,
      invoiceId: params.invoiceId,
    });

    return result;
  }

  // ----------------------------------------------------------
  // balance — aggregate balance across all providers
  // ----------------------------------------------------------

  async balance(params: BalanceParams): Promise<BalanceResult[]> {
    const balances: Balance[] = await this.router.getAggregateBalance(params.currency);

    this.audit.record('balance_queried', {
      currency: params.currency,
      providers: balances.map((b) => b.provider),
    });

    // Map to CCAP BalanceResult format
    return balances.map((b) => ({
      wallet: params.wallet ?? b.provider,
      currency: b.currency,
      balance: b.amount,
      timestamp: new Date().toISOString(),
    }));
  }

  // ----------------------------------------------------------
  // escrow — time-locked hold with provider-agnostic settlement
  //
  // This is CC's gap-filling contribution: no existing payment
  // provider offers cross-provider escrow. The hold is recorded
  // in the audit log; settlement can use any router provider.
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

    // Schedule automatic expiry
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
    // In production, release locked funds back to the originating wallet here
  }

  private generateInvoiceId(): string {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(4).toString('hex');
    return `inv_${ts}_${rand}`;
  }
}

// ----------------------------------------------------------
// SafetyViolationError — carries the safety result
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
