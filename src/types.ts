// ============================================================
// Shared TypeScript interfaces for the CC Agent Starter Kit.
// All modules import from here — keep this the canonical [single
// authoritative] source of type definitions.
//
// Provider-level types (PaymentProvider, PaymentParams, etc.)
// live in src/providers/types.ts. This file holds the higher-
// level CCAP protocol types that sit above the provider layer.
// ============================================================

// ------------------------------------------------------------
// Safety
// ------------------------------------------------------------

export interface BudgetConstraints {
  dailyLimitUsd: number;
  softLimitUsd: number;       // Warn but don't block
  transactionLimitUsd: number;
  humanApprovalThresholdUsd: number;
}

export interface RateLimitConfig {
  requestsPerMinute: number;
  burstAllowance: number;
}

export interface EscalationConfig {
  webhookUrls: string[];
  timeoutMinutes: number;
}

export interface SafetyConfig {
  budget: BudgetConstraints;
  rateLimits: RateLimitConfig;
  escalation: EscalationConfig;
}

export type OperationType = 'payment' | 'invoice' | 'escrow' | 'tool_call' | 'agent_invoke';

export interface Operation {
  type: OperationType;
  costUsd: number;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface SafetyResult {
  allowed: boolean;
  reason?: string;
  requiresHumanApproval?: boolean;
  escalationUrl?: string;
  retryAfterSeconds?: number;
}

// ------------------------------------------------------------
// Audit
// ------------------------------------------------------------

export interface AuditEntry {
  id: string;
  timestamp: string;            // ISO 8601
  action: string;
  details: Record<string, unknown>;
  previousHash: string;         // Hash of previous entry (or 'genesis' for first)
  hash: string;                 // SHA-256 of: id + timestamp + action + details + previousHash
}

export interface AuditVerifyResult {
  valid: boolean;
  entriesChecked: number;
  firstBrokenAt?: string;       // Entry ID where chain breaks
  error?: string;
}

// ------------------------------------------------------------
// CCAP Economic
// Wallet-specific PayParams / PayResult removed — those live in
// providers/coinbase.ts. Here we define the CCAP-level types
// that callers of CCAPEconomic use.
// ------------------------------------------------------------

export interface InvoiceParams {
  amount: number;
  currency: string;
  description: string;
  recipientWallet: string;
  dueDateIso?: string;          // Defaults to now + 24h
}

export interface InvoiceResult {
  invoiceId: string;
  paymentUrl: string;
  expiresAt: string;
  amount: number;
  currency: string;
}

/** CCAP-level payment params. method is optional; router picks best provider. */
export interface PaymentParams {
  amount: number;
  currency: string;
  recipientWallet: string;
  memo: string;
  invoiceId?: string;           // Optional: link payment to an invoice
  method?: import('./providers/types.js').PaymentMethod; // Routing hint
}

export interface BalanceParams {
  wallet?: string;
  currency: string;
}

export interface BalanceResult {
  wallet: string;
  currency: string;
  balance: string;
  timestamp: string;
}

export interface EscrowParams {
  amount: number;
  currency: string;
  beneficiary: string;          // Who can claim the funds
  condition: string;            // Human-readable condition description
  timeoutSeconds: number;
}

export interface EscrowResult {
  escrowId: string;
  status: 'locked' | 'released' | 'refunded' | 'expired';
  amount: number;
  currency: string;
  expiresAt: string;
}

// Internal escrow record (stored in memory / future: Redis)
export interface EscrowRecord extends EscrowResult {
  beneficiary: string;
  condition: string;
  createdAt: string;
}

// ------------------------------------------------------------
// Escrow (extended: create / verify / release / refund)
// ------------------------------------------------------------

export type DisputeResolutionMethod = 'arbitration_agent' | 'multi_sig' | 'automatic';

export interface CreateEscrowParams {
  amount: number;
  currency: string;
  beneficiaryAgentId: string;
  completionCriteria: string;
  timeoutSeconds: number;
  disputeResolutionMethod: DisputeResolutionMethod;
  arbitrationAgentId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateEscrowResult {
  escrowId: string;
  status: 'created';
  amount: number;
  currency: string;
  beneficiaryAgentId: string;
  createdAt: string;
  expiresAt: string;
}

export type EscrowStatusValue = 'created' | 'funded' | 'released' | 'refunded' | 'expired' | 'disputed';

export interface EscrowStatusResult {
  escrowId: string;
  status: EscrowStatusValue;
  amount: number;
  currency: string;
  buyerAgentId?: string;
  beneficiaryAgentId: string;
  completionCriteria: string;
  expiresAt: string;
  disputeResolutionMethod: DisputeResolutionMethod;
  verifiedAt: string;
}

export interface ReleaseEscrowResult {
  escrowId: string;
  status: 'released';
  amount: number;
  currency: string;
  releasedTo: string;
  releasedAt: string;
  transactionId: string;
}

export interface RefundEscrowResult {
  escrowId: string;
  status: 'refunded';
  amount: number;
  currency: string;
  refundedTo: string;
  refundedAt: string;
  transactionId: string;
}

// Internal extended escrow record
export interface ExtendedEscrowRecord {
  escrowId: string;
  status: EscrowStatusValue;
  amount: number;
  currency: string;
  buyerAgentId: string;
  beneficiaryAgentId: string;
  completionCriteria: string;
  disputeResolutionMethod: DisputeResolutionMethod;
  arbitrationAgentId?: string;
  createdAt: string;
  expiresAt: string;
  fundedAt?: string;
  releasedAt?: string;
  refundedAt?: string;
  completionEvidence?: string;
  idempotencyKey?: string;
}

// ------------------------------------------------------------
// Liability Bond
// ------------------------------------------------------------

export type BondScope =
  | 'legal_document_handling'
  | 'financial_transaction_routing'
  | 'email_processing'
  | 'code_generation'
  | 'code_deployment'
  | 'general_purpose';

export type BondStatusValue = 'active' | 'expired' | 'fully_claimed' | 'released';

export interface PostBondParams {
  amount: number;
  currency: string;
  scope: BondScope;
  scopeDescription: string;
  durationSeconds: number;
  claimConditions: string;
  maxClaimAmount: number;
  arbitrationAgentId: string;
  humanEscalationThresholdUsd?: number;
  idempotencyKey?: string;
}

export interface BondResult {
  bondId: string;
  status: BondStatusValue;
  amount: number;
  currency: string;
  scope: BondScope;
  agentId: string;
  activeFrom: string;
  expiresAt: string;
  transactionId: string;
}

export interface BondRecord {
  bondId: string;
  status: BondStatusValue;
  agentId: string;
  amount: number;
  remainingAmount: number;
  currency: string;
  scope: BondScope;
  scopeDescription: string;
  claimConditions: string;
  maxClaimAmount: number;
  arbitrationAgentId: string;
  humanEscalationThresholdUsd: number;
  activeFrom: string;
  expiresAt: string;
  claimsHistory: ClaimRecord[];
  idempotencyKey?: string;
}

export interface VerifyBondResult {
  agentId: string;
  hasActiveBond: boolean;
  bondId?: string;
  amount?: number;
  currency?: string;
  scope?: BondScope;
  expiresAt?: string;
  claimsHistory?: {
    totalPeriods: number;
    claimsFiled: number;
    claimsUpheld: number;
  };
}

export interface ClaimBondParams {
  bondId: string;
  claimedBy: string;
  claimAmount: number;
  description: string;
  evidenceUrl?: string;
  idempotencyKey?: string;
}

export interface ClaimRecord {
  claimId: string;
  bondId: string;
  claimedBy: string;
  claimAmount: number;
  description: string;
  evidenceUrl?: string;
  status: 'under_review' | 'upheld' | 'rejected';
  filedAt: string;
  resolvedAt?: string;
}

export interface ClaimBondResult {
  claimId: string;
  bondId: string;
  status: 'under_review';
  claimAmount: number;
  arbitrationAgentId: string;
  reviewDeadline: string;
}

// ------------------------------------------------------------
// Credit Score
// ------------------------------------------------------------

export type CreditScoreTier = 'excellent' | 'good' | 'fair' | 'poor';

export interface ScoreComponent {
  score: number;
  weight: number;
  dataPoints: number;
  detail: string;
}

export interface TransactionVolumeComponent extends ScoreComponent {
  totalUsd: number;
}

export interface DisputeRateComponent extends ScoreComponent {
  rate: number;
}

export interface CreditScore {
  agentId: string;
  score: number;
  tier: CreditScoreTier;
  computedAt: string;
  nextUpdateAt: string;
  historyWindowDays: number;
  components: {
    paymentReliability: ScoreComponent;
    bondHistory: ScoreComponent;
    transactionVolume: TransactionVolumeComponent;
    disputeRate: DisputeRateComponent;
    counterpartyDiversity: ScoreComponent;
  };
  flags: CreditScoreFlag[];
}

export interface CreditScoreFlag {
  code:
    | 'self_dealing_detected'
    | 'volume_velocity_spike'
    | 'claim_under_review'
    | 'insufficient_history'
    | 'new_agent';
  description: string;
  appliedAt: string;
}

// ------------------------------------------------------------
// CCAP Composition
// ------------------------------------------------------------

export interface DiscoveryParams {
  capabilities: string[];
  maxCostUsd?: number;
  minReputation?: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  capabilities: string[];
  reputation: number;           // 0–1 score
  pricing: Record<string, number>;
  mcpEndpoint: string;
  walletAddress: string;
}

export interface AgentDirectory {
  agents: AgentInfo[];
  total: number;
}

export interface InvokeAgentParams {
  agentId?: string;
  capability: string;
  input: Record<string, unknown>;
  timeoutSeconds?: number;
}

export interface AgentInvokeResult {
  output: unknown;
  costUsd: number;
  durationMs: number;
  transactionId?: string;
}

export interface SubscribeParams {
  agentId: string;
  events: string[];
  callbackUrl: string;
}

export interface SubscribeResult {
  subscriptionId: string;
  agentId: string;
  events: string[];
  callbackUrl: string;
  createdAt: string;
}

// ------------------------------------------------------------
// Capabilities
// ------------------------------------------------------------

export interface CapabilityConfig {
  id: string;
  name: string;
  description: string;
  version: string;
  pricing: {
    model: 'per_call' | 'per_page' | 'success_based' | 'subscription';
    baseCostUsd: number;
    scalingFactor?: number;
  };
  sla: {
    p95LatencyMs: number;
    availability: number;
  };
  safety: {
    maxInputSizeBytes?: number;
    allowedFileTypes?: string[];
    requiresHumanApproval?: boolean;
  };
  inputSchema: object;
}

export interface Capability {
  config: CapabilityConfig;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

// ------------------------------------------------------------
// Health / Status
// ------------------------------------------------------------

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptimeSeconds: number;
  providers: {
    count: number;
    names: string[];
  };
  safety: {
    killSwitchActive: boolean;
    dailySpendUsd: number;
    dailyBudgetUsd: number;
  };
  timestamp: string;
}
