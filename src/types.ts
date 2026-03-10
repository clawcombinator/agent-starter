// ============================================================
// Shared TypeScript interfaces for the CC Agent Starter Kit.
// All modules import from here — keep this the canonical [single
// authoritative] source of type definitions.
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
// Wallet
// ------------------------------------------------------------

export interface PayParams {
  amount: number;
  currency: string;             // e.g. 'USDC', 'ETH'
  recipient: string;            // wallet address
  memo: string;
}

export interface PayResult {
  transactionHash: string;
  idempotencyKey: string;
  fromCache: boolean;
}

export interface WalletStatus {
  address: string;
  network: string;
  balances: Record<string, string>;
}

// ------------------------------------------------------------
// CCAP Economic
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

export interface PaymentParams {
  amount: number;
  currency: string;
  recipientWallet: string;
  memo: string;
  invoiceId?: string;           // Optional: link payment to an invoice
}

export interface PaymentResult {
  transactionId: string;
  status: 'completed' | 'pending' | 'failed';
  timestamp: string;
  costUsd: number;
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
  wallet: {
    connected: boolean;
    address?: string;
    network?: string;
  };
  safety: {
    killSwitchActive: boolean;
    dailySpendUsd: number;
    dailyBudgetUsd: number;
  };
  timestamp: string;
}
