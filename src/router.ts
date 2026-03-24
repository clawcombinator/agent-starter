// ============================================================
// PaymentRouter — the clearing house for agent payments
//
// This is CC's core contribution. The router holds multiple
// PaymentProvider instances and automatically selects the best
// one for each payment request based on:
//
//   - Payment method compatibility (crypto / card / x402 / bank)
//   - Currency support
//   - Caller hint (preferProvider, optimise mode)
//   - Provider availability (falls back if one fails)
//
// Every routing decision passes through SafetyMonitor first,
// and every outcome is recorded in AuditLogger.
//
// The router is the single choke-point for all money movement.
// Nothing pays without the router's knowledge.
// ============================================================

import type { AuditLogger } from './audit.js';
import type { SafetyMonitor } from './safety.js';
import type {
  Balance,
  PaymentMethod,
  PaymentParams,
  PaymentProvider,
  PaymentResult,
  RoutingHint,
} from './providers/types.js';

// Re-export the provider types so callers can import from a
// single location
export type { Balance, PaymentMethod, PaymentParams, PaymentResult, RoutingHint } from './providers/types.js';

// ----------------------------------------------------------
// Routing decision — attached to each routing audit entry
// ----------------------------------------------------------

interface RoutingDecision {
  selectedProvider: string;
  candidateProviders: string[];
  hint?: RoutingHint;
  reason: string;
}

// ----------------------------------------------------------
// PaymentRouter
// ----------------------------------------------------------

export class PaymentRouter {
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    private readonly safety: SafetyMonitor,
    private readonly audit: AuditLogger,
  ) {}

  // ----------------------------------------------------------
  // Provider registration
  // ----------------------------------------------------------

  registerProvider(provider: PaymentProvider): void {
    this.providers.set(provider.name, provider);
    this.audit.record('provider_registered', { provider: provider.name });
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  getProvider(name: string): PaymentProvider | undefined {
    return this.providers.get(name);
  }

  // ----------------------------------------------------------
  // route — select, check, execute, audit
  // ----------------------------------------------------------

  /**
   * Route a payment to the best available provider.
   *
   * Routing logic (in order):
   * 1. If `hint.preferProvider` is set and that provider exists → use it
   * 2. Filter to providers that support the requested PaymentMethod
   *    (if params.method is specified)
   * 3. Apply optimise preference (cheapest / fastest / reliable)
   * 4. Attempt the selected provider; on failure, try the next candidate
   * 5. If all candidates fail, throw with a composite error message
   */
  async route(params: PaymentParams, hint?: RoutingHint): Promise<PaymentResult> {
    // Safety gate — must pass before any provider is touched
    const check = await this.safety.checkOperation({
      type: 'payment',
      costUsd: params.amount,
      description: `Routed payment to ${params.recipient}: ${params.memo ?? 'no memo'}`,
    });

    if (!check.allowed) {
      this.audit.record('router_payment_blocked', {
        reason: check.reason,
        params,
        requiresHumanApproval: check.requiresHumanApproval ?? false,
      });
      throw new RouterError(check.reason ?? 'Safety check failed', 'SAFETY_BLOCKED');
    }

    // Build ordered list of candidates
    const candidates = this.selectCandidates(params, hint);

    if (candidates.length === 0) {
      throw new RouterError(
        `No provider can handle ${params.method ?? 'any'} payment in ${params.currency}`,
        'NO_PROVIDER',
      );
    }

    const decision: RoutingDecision = {
      selectedProvider: candidates[0]!.name,
      candidateProviders: candidates.map((p) => p.name),
      hint,
      reason: this.describeRouting(candidates, hint),
    };

    this.audit.record('router_routing_decision', { ...decision, params });

    // Attempt providers in order, falling back on failure
    const errors: string[] = [];

    for (const provider of candidates) {
      try {
        const result = await provider.pay(params);

        // Commit spend to safety budget tracker
        this.safety.recordSpend(params.amount);

        this.audit.record('router_payment_completed', {
          provider: provider.name,
          transactionId: result.transactionId,
          amount: params.amount,
          currency: params.currency,
          recipient: params.recipient,
        });

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${provider.name}: ${message}`);

        this.audit.record('router_provider_failed', {
          provider: provider.name,
          error: message,
          willRetry: candidates.indexOf(provider) < candidates.length - 1,
        });
      }
    }

    // All providers failed
    const composite = errors.join(' | ');
    this.audit.record('router_all_providers_failed', { errors, params });
    throw new RouterError(`All providers failed: ${composite}`, 'ALL_FAILED');
  }

  // ----------------------------------------------------------
  // getAggregateBalance — balance across all providers
  // ----------------------------------------------------------

  async getAggregateBalance(currency?: string): Promise<Balance[]> {
    const results: Balance[] = [];

    for (const provider of this.providers.values()) {
      try {
        const balance = await provider.getBalance(currency);
        results.push(balance);
      } catch (err) {
        // Non-fatal: a failing balance query should not block the others
        this.audit.record('router_balance_query_failed', {
          provider: provider.name,
          error: String(err),
        });
        results.push({
          amount: '0.00',
          currency: currency ?? 'UNKNOWN',
          provider: provider.name,
        });
      }
    }

    this.audit.record('router_balance_queried', {
      providers: results.map((r) => r.provider),
      currency: currency ?? 'all',
    });

    return results;
  }

  // ----------------------------------------------------------
  // providerStatus — per-provider health summary
  // ----------------------------------------------------------

  async providerStatus(): Promise<ProviderStatus[]> {
    const statuses: ProviderStatus[] = [];

    for (const provider of this.providers.values()) {
      try {
        const balance = await provider.getBalance();
        statuses.push({
          name: provider.name,
          available: true,
          balance: balance.amount,
          currency: balance.currency,
          supportedMethods: (['crypto', 'card', 'x402', 'bank_transfer'] as PaymentMethod[]).filter(
            (m) => provider.supportsMethod(m),
          ),
        });
      } catch {
        statuses.push({
          name: provider.name,
          available: false,
          supportedMethods: [],
        });
      }
    }

    return statuses;
  }

  // ----------------------------------------------------------
  // Private routing helpers
  // ----------------------------------------------------------

  /**
   * Build an ordered list of provider candidates for this payment.
   * Ordering strategy depends on `hint.optimise` (cheapest by default).
   */
  private selectCandidates(params: PaymentParams, hint?: RoutingHint): PaymentProvider[] {
    let candidates = Array.from(this.providers.values());

    // 1. Preferred provider first (if it exists and is compatible)
    if (hint?.preferProvider) {
      const preferred = this.providers.get(hint.preferProvider);
      if (preferred) {
        candidates = [preferred, ...candidates.filter((p) => p !== preferred)];
      }
    }

    // 2. Filter to providers that support the requested method
    if (params.method) {
      const method = params.method;
      candidates = candidates.filter((p) => p.supportsMethod(method));
    }

    // 3. Apply optimise preference
    // Currently all providers are treated as equivalent cost/speed.
    // In a full implementation this would consult a fee oracle and
    // latency measurements to rank providers. For now the ordering
    // is: preferred (if any) → crypto → card → x402 → bank_transfer.
    const methodPriority: PaymentMethod[] = ['crypto', 'card', 'x402', 'bank_transfer'];

    if (!hint?.preferProvider && hint?.optimise !== 'fastest') {
      candidates.sort((a, b) => {
        const aIdx = methodPriority.findIndex((m) => a.supportsMethod(m));
        const bIdx = methodPriority.findIndex((m) => b.supportsMethod(m));
        return aIdx - bIdx;
      });
    }

    return candidates;
  }

  private describeRouting(candidates: PaymentProvider[], hint?: RoutingHint): string {
    if (hint?.preferProvider && candidates[0]?.name === hint.preferProvider) {
      return `User-preferred provider ${hint.preferProvider}`;
    }
    const optimise = hint?.optimise ?? 'cheapest';
    return `Automatic selection (${optimise}): ${candidates.map((c) => c.name).join(', ')}`;
  }
}

// ----------------------------------------------------------
// RouterError — carries an error code for structured handling
// ----------------------------------------------------------

export class RouterError extends Error {
  constructor(
    message: string,
    public readonly code: 'SAFETY_BLOCKED' | 'NO_PROVIDER' | 'ALL_FAILED',
  ) {
    super(message);
    this.name = 'RouterError';
  }
}

// ----------------------------------------------------------
// ProviderStatus — returned by providerStatus()
// ----------------------------------------------------------

export interface ProviderStatus {
  name: string;
  available: boolean;
  balance?: string;
  currency?: string;
  supportedMethods: PaymentMethod[];
}
