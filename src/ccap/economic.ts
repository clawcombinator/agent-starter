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
  BondRecord,
  BondResult,
  BondScope,
  ClaimBondParams,
  ClaimBondResult,
  ClaimRecord,
  CreditScore,
  CreditScoreTier,
  CreateEscrowParams,
  CreateEscrowResult,
  DisputeRecord,
  EscrowParams,
  EscrowRecord,
  EscrowResult,
  EscrowStatusResult,
  ExtendedEscrowRecord,
  FundEscrowResult,
  InvoiceParams,
  InvoiceResult,
  OpenDisputeParams,
  OpenDisputeResult,
  PaymentParams,
  PostBondParams,
  RefundEscrowResult,
  ReleaseEscrowResult,
  VerifyBondResult,
} from '../types.js';

// In-memory stores — replace with durable storage for production
const invoiceStore = new Map<string, InvoiceResult & InvoiceParams>();
const escrowStore = new Map<string, EscrowRecord>();
const extendedEscrowStore = new Map<string, ExtendedEscrowRecord>();
const bondStore = new Map<string, BondRecord>();
const disputeStore = new Map<string, DisputeRecord>();
const MAX_TIMEOUT_MS = 2_147_483_647;
// creditScoreStore is keyed by agent_id. In production this would be
// populated from the CCAP registry. Here we seed a minimal computed score.
const creditScoreStore = new Map<string, CreditScore>();

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
    this.scheduleDeferredTimer(
      params.timeoutSeconds * 1000,
      () => void this.expireEscrow(escrowId),
      'escrow_expiry',
      { escrowId },
    );

    return {
      escrowId,
      status: 'locked',
      amount: params.amount,
      currency: params.currency,
      expiresAt,
    };
  }

  // ----------------------------------------------------------
  // createEscrow — full buyer-protection escrow lifecycle
  //
  // Creates an escrow record keyed by beneficiaryAgentId and
  // completion criteria. Funds are NOT locked at creation time;
  // call fundEscrow() to lock funds via the PaymentRouter.
  // ----------------------------------------------------------

  async createEscrow(params: CreateEscrowParams): Promise<CreateEscrowResult> {
    if (params.disputeResolutionMethod === 'arbitration_agent' && !params.arbitrationAgentId) {
      throw new Error('arbitrationAgentId is required when disputeResolutionMethod=arbitration_agent');
    }

    const check = await this.safety.checkOperation({
      type: 'escrow',
      costUsd: params.amount,
      description: `Create escrow for ${params.beneficiaryAgentId}`,
    });

    if (!check.allowed) {
      this.audit.record('escrow_create_blocked', { reason: check.reason, params });
      throw new SafetyViolationError(check.reason ?? 'Safety check failed', check);
    }

    const escrowId = `escrow_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + params.timeoutSeconds * 1000).toISOString();

    const record: ExtendedEscrowRecord = {
      escrowId,
      status: 'created',
      amount: params.amount,
      currency: params.currency,
      buyerAgentId: params.buyerAgentId ?? 'self',
      beneficiaryAgentId: params.beneficiaryAgentId,
      completionCriteria: params.completionCriteria,
      disputeResolutionMethod: params.disputeResolutionMethod,
      arbitrationAgentId: params.arbitrationAgentId,
      createdAt: now,
      expiresAt,
      idempotencyKey: params.idempotencyKey,
    };

    extendedEscrowStore.set(escrowId, record);
    this.invalidateCreditScores([record.buyerAgentId, record.beneficiaryAgentId]);

    this.audit.record('extended_escrow_created', {
      escrowId,
      amount: params.amount,
      currency: params.currency,
      beneficiaryAgentId: params.beneficiaryAgentId,
      completionCriteria: params.completionCriteria,
      expiresAt,
    });

    // Schedule automatic expiry
    this.scheduleDeferredTimer(
      params.timeoutSeconds * 1000,
      () => void this.expireExtendedEscrow(escrowId),
      'extended_escrow_expiry',
      { escrowId },
    );

    return {
      escrowId,
      status: 'created',
      amount: params.amount,
      currency: params.currency,
      beneficiaryAgentId: params.beneficiaryAgentId,
      createdAt: now,
      expiresAt,
    };
  }

  // ----------------------------------------------------------
  // fundEscrow — lock buyer funds against an existing escrow
  //
  // Settlement is only allowed once status is 'funded'. This
  // enforces the "no settlement without funded escrow" invariant.
  // ----------------------------------------------------------

  async fundEscrow(escrowId: string, buyerAgentId?: string): Promise<FundEscrowResult> {
    const record = extendedEscrowStore.get(escrowId);

    if (!record) {
      throw new Error(`Escrow not found: ${escrowId}`);
    }

    if (record.status !== 'created') {
      throw new Error(`Escrow ${escrowId} cannot be funded: status is '${record.status}'`);
    }

    const payResult = await this.router.route({
      amount: record.amount,
      currency: record.currency,
      recipient: `ccap_escrow_lock:${escrowId}`,
      memo: `Escrow funding: ${escrowId}`,
      idempotencyKey: record.idempotencyKey ?? `escrow_fund_${escrowId}`,
    });

    const fundedAt = new Date().toISOString();
    const nextBuyerAgentId = buyerAgentId ?? record.buyerAgentId;

    extendedEscrowStore.set(escrowId, {
      ...record,
      buyerAgentId: nextBuyerAgentId,
      status: 'funded',
      fundedAt,
    });

    this.invalidateCreditScores([nextBuyerAgentId, record.beneficiaryAgentId]);

    this.audit.record('extended_escrow_funded', {
      escrowId,
      amount: record.amount,
      currency: record.currency,
      buyerAgentId: nextBuyerAgentId,
      beneficiaryAgentId: record.beneficiaryAgentId,
      fundedAt,
      transactionId: payResult.transactionId,
    });

    return {
      escrowId,
      status: 'funded',
      amount: record.amount,
      currency: record.currency,
      buyerAgentId: nextBuyerAgentId,
      beneficiaryAgentId: record.beneficiaryAgentId,
      fundedAt,
      transactionId: payResult.transactionId,
    };
  }

  // ----------------------------------------------------------
  // verifyEscrow — seller calls this before starting work
  //
  // Returns the current escrow status. A seller SHOULD decline
  // to work if status is not 'funded'.
  // ----------------------------------------------------------

  async verifyEscrow(escrowId: string): Promise<EscrowStatusResult> {
    const record = extendedEscrowStore.get(escrowId);

    if (!record) {
      throw new Error(`Escrow not found: ${escrowId}`);
    }

    this.audit.record('extended_escrow_verified', { escrowId, status: record.status });

    return {
      escrowId: record.escrowId,
      status: record.status,
      amount: record.amount,
      currency: record.currency,
      buyerAgentId: record.buyerAgentId,
      beneficiaryAgentId: record.beneficiaryAgentId,
      completionCriteria: record.completionCriteria,
      expiresAt: record.expiresAt,
      disputeResolutionMethod: record.disputeResolutionMethod,
      verifiedAt: new Date().toISOString(),
    };
  }

  // ----------------------------------------------------------
  // releaseEscrow — transfers funds to the beneficiary
  //
  // Funds transfer MUST be atomic. If the payment router fails,
  // the escrow status remains 'funded' and no funds move.
  // ----------------------------------------------------------

  async releaseEscrow(escrowId: string, completionEvidence?: string): Promise<ReleaseEscrowResult> {
    const record = extendedEscrowStore.get(escrowId);

    if (!record) {
      throw new Error(`Escrow not found: ${escrowId}`);
    }

    if (record.status !== 'funded') {
      throw new Error(`Escrow ${escrowId} cannot be released: status is '${record.status}'`);
    }

    // Route the payment to the beneficiary via the PaymentRouter
    const payResult = await this.router.route({
      amount: record.amount,
      currency: record.currency,
      recipient: record.beneficiaryAgentId,
      memo: `Escrow release: ${escrowId}`,
    });

    const releasedAt = new Date().toISOString();

    extendedEscrowStore.set(escrowId, {
      ...record,
      status: 'released',
      releasedAt,
      completionEvidence,
    });
    this.invalidateCreditScores([record.buyerAgentId, record.beneficiaryAgentId]);

    this.audit.record('extended_escrow_released', {
      escrowId,
      amount: record.amount,
      currency: record.currency,
      releasedTo: record.beneficiaryAgentId,
      transactionId: payResult.transactionId,
      completionEvidence,
    });

    return {
      escrowId,
      status: 'released',
      amount: record.amount,
      currency: record.currency,
      releasedTo: record.beneficiaryAgentId,
      releasedAt,
      transactionId: payResult.transactionId,
    };
  }

  // ----------------------------------------------------------
  // refundEscrow — returns funds to the buyer
  //
  // Only valid when status is 'created' or 'funded'.
  // On timeout, expireExtendedEscrow() calls this automatically.
  // ----------------------------------------------------------

  async refundEscrow(escrowId: string, reason?: string): Promise<RefundEscrowResult> {
    const record = extendedEscrowStore.get(escrowId);

    if (!record) {
      throw new Error(`Escrow not found: ${escrowId}`);
    }

    if (record.status !== 'created' && record.status !== 'funded') {
      throw new Error(`Escrow ${escrowId} cannot be refunded: status is '${record.status}'`);
    }

    // Route the payment back to the buyer. In production the buyer wallet
    // address would be stored on the record. Here we use the buyerAgentId
    // as the recipient identifier.
    const payResult = await this.router.route({
      amount: record.amount,
      currency: record.currency,
      recipient: record.buyerAgentId,
      memo: `Escrow refund: ${escrowId}${reason ? ` — ${reason}` : ''}`,
    });

    const refundedAt = new Date().toISOString();

    extendedEscrowStore.set(escrowId, {
      ...record,
      status: 'refunded',
      refundedAt,
    });
    this.invalidateCreditScores([record.buyerAgentId, record.beneficiaryAgentId]);

    this.audit.record('extended_escrow_refunded', {
      escrowId,
      amount: record.amount,
      currency: record.currency,
      refundedTo: record.buyerAgentId,
      transactionId: payResult.transactionId,
      reason,
    });

    return {
      escrowId,
      status: 'refunded',
      amount: record.amount,
      currency: record.currency,
      refundedTo: record.buyerAgentId,
      refundedAt,
      transactionId: payResult.transactionId,
    };
  }

  // ----------------------------------------------------------
  // postBond — lock a performance bond as a costly signal
  //
  // Funds are locked immediately via the PaymentRouter.
  // The bond is visible to prospective clients via verifyBond().
  // ----------------------------------------------------------

  async postBond(params: PostBondParams): Promise<BondResult> {
    const check = await this.safety.checkOperation({
      type: 'escrow',
      costUsd: params.amount,
      description: `Post liability bond: ${params.scope}`,
    });

    if (!check.allowed) {
      this.audit.record('bond_post_blocked', { reason: check.reason, params });
      throw new SafetyViolationError(check.reason ?? 'Safety check failed', check);
    }

    const bondId = `bond_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + params.durationSeconds * 1000).toISOString();

    // Lock the bond amount via the PaymentRouter (held by CCAP network)
    const payResult = await this.router.route({
      amount: params.amount,
      currency: params.currency,
      recipient: 'ccap_bond_escrow',
      memo: `Bond lock: ${bondId} scope=${params.scope}`,
    });

    const record: BondRecord = {
      bondId,
      status: 'active',
      agentId: params.agentId ?? 'self',
      amount: params.amount,
      remainingAmount: params.amount,
      currency: params.currency,
      scope: params.scope,
      scopeDescription: params.scopeDescription,
      claimConditions: params.claimConditions,
      maxClaimAmount: params.maxClaimAmount,
      arbitrationAgentId: params.arbitrationAgentId,
      humanEscalationThresholdUsd: params.humanEscalationThresholdUsd ?? 10_000,
      activeFrom: now,
      expiresAt,
      claimsHistory: [],
      idempotencyKey: params.idempotencyKey,
    };

    bondStore.set(bondId, record);
    this.invalidateCreditScores([record.agentId]);

    this.audit.record('bond_posted', {
      bondId,
      amount: params.amount,
      currency: params.currency,
      scope: params.scope,
      agentId: record.agentId,
      expiresAt,
      transactionId: payResult.transactionId,
    });

    // Schedule automatic release when bond period ends
    this.scheduleDeferredTimer(
      params.durationSeconds * 1000,
      () => void this.releaseBondOnExpiry(bondId),
      'bond_release',
      { bondId },
    );

    return {
      bondId,
      status: 'active',
      amount: params.amount,
      currency: params.currency,
      scope: params.scope,
      agentId: record.agentId,
      activeFrom: now,
      expiresAt,
      transactionId: payResult.transactionId,
    };
  }

  // ----------------------------------------------------------
  // verifyBond — client checks an agent's active bonds
  //
  // Returns the most relevant active bond for the given scope.
  // ----------------------------------------------------------

  verifyBond(agentId: string, scope?: BondScope): VerifyBondResult {
    const activeBonds = Array.from(bondStore.values()).filter(
      (b) =>
        b.agentId === agentId &&
        b.status === 'active' &&
        (scope === undefined || b.scope === scope),
    );

    if (activeBonds.length === 0) {
      this.audit.record('bond_verified_none', { agentId, scope });
      return { agentId, hasActiveBond: false };
    }

    // Select the bond with the highest remaining amount as the primary signal
    const best = activeBonds.reduce((a, b) =>
      a.remainingAmount >= b.remainingAmount ? a : b,
    );

    this.audit.record('bond_verified', {
      agentId,
      bondId: best.bondId,
      scope: best.scope,
      amount: best.remainingAmount,
    });

    return {
      agentId,
      hasActiveBond: true,
      bondId: best.bondId,
      amount: best.remainingAmount,
      currency: best.currency,
      scope: best.scope,
      expiresAt: best.expiresAt,
      claimsHistory: {
        totalPeriods: bondStore.size,
        claimsFiled: best.claimsHistory.length,
        claimsUpheld: best.claimsHistory.filter((c) => c.status === 'upheld').length,
      },
    };
  }

  // ----------------------------------------------------------
  // claimBond — client submits a claim against a bond
  //
  // Claims are placed under_review; they do not auto-pay.
  // Adjudication is handled externally by the arbitration agent.
  // ----------------------------------------------------------

  async claimBond(params: ClaimBondParams): Promise<ClaimBondResult> {
    const bond = bondStore.get(params.bondId);

    if (!bond) {
      throw new Error(`Bond not found: ${params.bondId}`);
    }

    if (bond.status !== 'active') {
      throw new Error(`Bond ${params.bondId} is not active: status is '${bond.status}'`);
    }

    if (params.claimAmount > bond.maxClaimAmount) {
      throw new Error(
        `Claim amount ${params.claimAmount} exceeds bond max claim amount ${bond.maxClaimAmount}`,
      );
    }

    const claimId = `claim_${crypto.randomBytes(8).toString('hex')}`;
    const filedAt = new Date().toISOString();
    const reviewDeadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days

    const claimRecord: ClaimRecord = {
      claimId,
      bondId: params.bondId,
      claimedBy: params.claimedBy,
      claimAmount: params.claimAmount,
      description: params.description,
      evidenceUrl: params.evidenceUrl,
      status: 'under_review',
      filedAt,
    };

    bondStore.set(params.bondId, {
      ...bond,
      claimsHistory: [...bond.claimsHistory, claimRecord],
    });
    this.invalidateCreditScores([bond.agentId, params.claimedBy]);

    this.audit.record('bond_claim_filed', {
      claimId,
      bondId: params.bondId,
      claimedBy: params.claimedBy,
      claimAmount: params.claimAmount,
      description: params.description,
      evidenceUrl: params.evidenceUrl,
      arbitrationAgentId: bond.arbitrationAgentId,
      reviewDeadline,
    });

    return {
      claimId,
      bondId: params.bondId,
      status: 'under_review',
      claimAmount: params.claimAmount,
      arbitrationAgentId: bond.arbitrationAgentId,
      reviewDeadline,
    };
  }

  // ----------------------------------------------------------
  // openDispute — move an escrow into a disputed state
  // ----------------------------------------------------------

  async openDispute(params: OpenDisputeParams): Promise<OpenDisputeResult> {
    const record = extendedEscrowStore.get(params.escrowId);

    if (!record) {
      throw new Error(`Escrow not found: ${params.escrowId}`);
    }

    if (record.status === 'refunded' || record.status === 'expired') {
      throw new Error(`Escrow ${params.escrowId} cannot be disputed from status '${record.status}'`);
    }

    const disputeId = `dispute_${crypto.randomBytes(8).toString('hex')}`;
    const openedAt = new Date().toISOString();
    const evidenceRefs = params.evidenceRefs ?? [];

    extendedEscrowStore.set(params.escrowId, {
      ...record,
      status: 'disputed',
      disputeId,
    });

    const dispute: DisputeRecord = {
      disputeId,
      status: 'open',
      disputeRecordType: 'disputeRecord',
      openedAt,
      escrowId: params.escrowId,
      claimantAgentId: params.claimantAgentId,
      reason: params.reason,
      evidenceRefs,
      arbitrationAgentId: record.arbitrationAgentId,
      specVersion: '0.1.0',
    };

    disputeStore.set(disputeId, dispute);
    this.invalidateCreditScores([record.buyerAgentId, record.beneficiaryAgentId, params.claimantAgentId]);

    this.audit.record('escrow_dispute_opened', {
      disputeId,
      escrowId: params.escrowId,
      claimantAgentId: params.claimantAgentId,
      reason: params.reason,
      evidenceRefs,
      arbitrationAgentId: record.arbitrationAgentId,
    });

    return {
      disputeId,
      status: 'open',
      disputeRecordType: 'disputeRecord',
      openedAt,
      escrowId: params.escrowId,
      claimantAgentId: params.claimantAgentId,
      reason: params.reason,
      evidenceRefs,
      arbitrationAgentId: record.arbitrationAgentId,
    };
  }

  // ----------------------------------------------------------
  // getCreditScore — query credit score from the CC registry
  //
  // In this starter kit the score is computed from the in-memory
  // transaction history. A production implementation would query
  // the CCAP registry API.
  // ----------------------------------------------------------

  getCreditScore(agentId: string): CreditScore {
    // Return a cached score if available
    const cached = creditScoreStore.get(agentId);
    if (cached) {
      this.audit.record('credit_score_queried', { agentId, score: cached.score });
      return cached;
    }

    // Derive a basic score from the in-memory bond and escrow history
    const agentBonds = Array.from(bondStore.values()).filter((bond) => bond.agentId === agentId);
    const agentEscrows = Array.from(extendedEscrowStore.values()).filter(
      (escrow) =>
        escrow.beneficiaryAgentId === agentId ||
        escrow.buyerAgentId === agentId,
    );

    const completedEscrows = agentEscrows.filter((e) => e.status === 'released');
    const disputedEscrows = agentEscrows.filter((e) => e.status === 'disputed');
    const totalEscrows = agentEscrows.length;
    const disputeRate = totalEscrows > 0 ? disputedEscrows.length / totalEscrows : 0;

    const bondPeriodsCompleted = agentBonds.filter(
      (b) => b.status === 'released' || b.status === 'expired',
    ).length;
    const claimsFiled = agentBonds.reduce((n, b) => n + b.claimsHistory.length, 0);
    const claimsUpheld = agentBonds.reduce(
      (n, b) => n + b.claimsHistory.filter((c) => c.status === 'upheld').length,
      0,
    );

    // Simple heuristic scores — production would use the full weighted formula
    const paymentReliabilityScore = completedEscrows.length > 0 ? 750 : 0;
    const bondHistoryScore = bondPeriodsCompleted > 0 && claimsUpheld === 0 ? 800 : claimsFiled > 0 ? 400 : 0;
    const volumeScore = Math.min(600, completedEscrows.length * 50);
    const disputeScore = disputeRate === 0 ? 900 : Math.max(0, 900 - Math.round(disputeRate * 3000));
    const diversityScore = 300; // Starter kit: single-agent context

    const composite = Math.round(
      paymentReliabilityScore * 0.30 +
      bondHistoryScore * 0.25 +
      volumeScore * 0.20 +
      disputeScore * 0.15 +
      diversityScore * 0.10,
    );

    const tier: CreditScoreTier =
      composite >= 800 ? 'excellent' :
      composite >= 600 ? 'good' :
      composite >= 400 ? 'fair' :
      'poor';

    const now = new Date().toISOString();
    const score: CreditScore = {
      agentId,
      score: composite,
      tier,
      computedAt: now,
      nextUpdateAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      historyWindowDays: 180,
      components: {
        paymentReliability: {
          score: paymentReliabilityScore,
          weight: 0.30,
          dataPoints: completedEscrows.length,
          detail: completedEscrows.length > 0
            ? `${completedEscrows.length} completed escrow(s)`
            : 'No payment history',
        },
        bondHistory: {
          score: bondHistoryScore,
          weight: 0.25,
          dataPoints: bondPeriodsCompleted + claimsFiled,
          detail: `${bondPeriodsCompleted} bond period(s) completed, ${claimsUpheld} claim(s) upheld`,
        },
        transactionVolume: {
          score: volumeScore,
          weight: 0.20,
          dataPoints: completedEscrows.length,
          totalUsd: completedEscrows.reduce((s, e) => s + e.amount, 0),
          detail: `${completedEscrows.length} transaction(s) in history window`,
        },
        disputeRate: {
          score: disputeScore,
          weight: 0.15,
          dataPoints: totalEscrows,
          rate: disputeRate,
          detail: `${disputedEscrows.length} dispute(s) out of ${totalEscrows} transaction(s)`,
        },
        counterpartyDiversity: {
          score: diversityScore,
          weight: 0.10,
          dataPoints: 1,
          detail: 'Single-agent context; diversity score is illustrative',
        },
      },
      flags: composite === 0 ? [{
        code: 'new_agent',
        description: 'No transaction history recorded. Score will update as escrows and bonds complete.',
        appliedAt: now,
      }] : [],
    };

    creditScoreStore.set(agentId, score);

    this.audit.record('credit_score_computed', { agentId, score: composite, tier });

    return score;
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

  getExtendedEscrow(escrowId: string): ExtendedEscrowRecord | undefined {
    return extendedEscrowStore.get(escrowId);
  }

  getBond(bondId: string): BondRecord | undefined {
    return bondStore.get(bondId);
  }

  getDispute(disputeId: string): DisputeRecord | undefined {
    return disputeStore.get(disputeId);
  }

  listBonds(agentId?: string): BondRecord[] {
    const bonds = Array.from(bondStore.values());
    if (!agentId) {
      return bonds;
    }
    return bonds.filter((bond) => bond.agentId === agentId);
  }

  private async expireEscrow(escrowId: string): Promise<void> {
    const record = escrowStore.get(escrowId);
    if (!record || record.status !== 'locked') return;

    escrowStore.set(escrowId, { ...record, status: 'expired' });
    this.audit.record('escrow_expired', { escrowId });
    // In production, release locked funds back to the originating wallet here
  }

  private async expireExtendedEscrow(escrowId: string): Promise<void> {
    const record = extendedEscrowStore.get(escrowId);
    if (!record || (record.status !== 'created' && record.status !== 'funded')) return;

    if (record.status === 'funded') {
      await this.refundEscrow(escrowId, 'timeout');
      return;
    }

    extendedEscrowStore.set(escrowId, { ...record, status: 'expired' });
    this.invalidateCreditScores([record.buyerAgentId, record.beneficiaryAgentId]);
    this.audit.record('extended_escrow_expired', { escrowId });
    // In production, trigger a refund back to the buyer wallet
  }

  private async releaseBondOnExpiry(bondId: string): Promise<void> {
    const bond = bondStore.get(bondId);
    if (!bond || bond.status !== 'active') return;

    const hasUnresolvedClaims = bond.claimsHistory.some((c) => c.status === 'under_review');
    if (hasUnresolvedClaims) {
      // Do not auto-release if there are unresolved claims
      this.audit.record('bond_expiry_deferred', { bondId, reason: 'unresolved_claims' });
      return;
    }

    bondStore.set(bondId, { ...bond, status: 'released' });
    this.invalidateCreditScores([bond.agentId]);
    this.audit.record('bond_released', {
      bondId,
      amount: bond.remainingAmount,
      currency: bond.currency,
    });
    // In production, route bond.remainingAmount back to the agent's wallet here
  }

  private generateInvoiceId(): string {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(4).toString('hex');
    return `inv_${ts}_${rand}`;
  }

  private scheduleDeferredTimer(
    delayMs: number,
    callback: () => void,
    timerType: string,
    metadata: Record<string, unknown>,
  ): void {
    if (delayMs <= MAX_TIMEOUT_MS) {
      setTimeout(callback, delayMs);
      return;
    }

    this.audit.record('timer_schedule_deferred', {
      timerType,
      delayMs,
      maxDelayMs: MAX_TIMEOUT_MS,
      ...metadata,
    });

    setTimeout(() => {
      this.scheduleDeferredTimer(
        delayMs - MAX_TIMEOUT_MS,
        callback,
        timerType,
        metadata,
      );
    }, MAX_TIMEOUT_MS);
  }

  private invalidateCreditScores(agentIds: string[]): void {
    for (const agentId of agentIds) {
      if (agentId) {
        creditScoreStore.delete(agentId);
      }
    }
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
