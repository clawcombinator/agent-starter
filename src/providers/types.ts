// ============================================================
// Provider interface types — the shared contract that all
// payment provider adapters must implement.
//
// Adding a new provider means implementing PaymentProvider
// and registering it with PaymentRouter. No changes elsewhere.
// ============================================================

// ------------------------------------------------------------
// Core interface
// ------------------------------------------------------------

export interface PaymentProvider {
  /** Human-readable name used in logs and audit entries. */
  name: string;

  /** One-time setup (connect to SDK, load wallet, etc.). Idempotent [safe to call again]. */
  initialize(): Promise<void>;

  /** Query balance. Defaults to the provider's primary currency if none given. */
  getBalance(currency?: string): Promise<Balance>;

  /** Execute a payment. Must be idempotent [safe to repeat] via idempotencyKey. */
  pay(params: PaymentParams): Promise<PaymentResult>;

  /** Return true if this provider can handle the given payment method. */
  supportsMethod(method: PaymentMethod): boolean;
}

// ------------------------------------------------------------
// Payment method enum — extensional [defined by listing all
// values] rather than structural
// ------------------------------------------------------------

export type PaymentMethod = 'crypto' | 'card' | 'x402' | 'bank_transfer';

// ------------------------------------------------------------
// Shared value types
// ------------------------------------------------------------

export interface Balance {
  amount: string;
  currency: string;
  provider: string;
}

export interface PaymentParams {
  amount: number;
  currency: string;
  recipient: string;
  memo?: string;
  method?: PaymentMethod;
  idempotencyKey?: string;
}

export interface PaymentResult {
  transactionId: string;
  provider: string;
  status: 'completed' | 'pending' | 'failed';
  timestamp: string;
}

// ------------------------------------------------------------
// Routing context — passed to the router alongside payment params
// ------------------------------------------------------------

export interface RoutingHint {
  /** Prefer a specific provider by name. Falls back to automatic routing if unavailable. */
  preferProvider?: string;
  /** Prefer cheapest, fastest, or most reliable. Defaults to 'cheapest'. */
  optimise?: 'cheapest' | 'fastest' | 'reliable';
}
