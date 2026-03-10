// ============================================================
// SafetyMonitor — enforces budget limits, rate limiting,
// kill switch, and human escalation for high-value operations.
//
// The token-bucket rate limiter is idempotent [safe to call
// repeatedly without side-effects beyond consuming tokens].
// Budget state resets daily at midnight UTC.
// ============================================================

import type { BudgetConstraints, EscalationConfig, Operation, SafetyConfig, SafetyResult } from './types.js';
import type { AuditLogger } from './audit.js';

// ----------------------------------------------------------
// Token-bucket rate limiter
// ----------------------------------------------------------

class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly capacity: number,    // Max tokens (= burst allowance)
    private readonly refillRatePerMs: number, // Tokens per millisecond
  ) {
    this.tokens = capacity;
    this.lastRefillAt = Date.now();
  }

  /** Attempt to consume `count` tokens. Returns true if allowed, false if rate-limited. */
  consume(count: number = 1): boolean {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  /** Seconds until the bucket has enough tokens again (0 if already sufficient). */
  retryAfterSeconds(count: number = 1): number {
    this.refill();
    const deficit = count - this.tokens;
    if (deficit <= 0) return 0;
    return Math.ceil(deficit / (this.refillRatePerMs * 1000));
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    const newTokens = elapsed * this.refillRatePerMs;
    this.tokens = Math.min(this.capacity, this.tokens + newTokens);
    this.lastRefillAt = now;
  }
}

// ----------------------------------------------------------
// Budget tracker (resets daily at midnight UTC)
// ----------------------------------------------------------

class DailyBudgetTracker {
  private spentToday: number = 0;
  private dayStart: number = this.todayStartMs();

  constructor(private readonly constraints: BudgetConstraints) {}

  get remaining(): number {
    this.rolloverIfNewDay();
    return this.constraints.dailyLimitUsd - this.spentToday;
  }

  get spent(): number {
    this.rolloverIfNewDay();
    return this.spentToday;
  }

  get limit(): number {
    return this.constraints.dailyLimitUsd;
  }

  /** Returns true if the spend was accepted, false if it would exceed the hard limit. */
  trySpend(amount: number): boolean {
    this.rolloverIfNewDay();
    if (this.spentToday + amount > this.constraints.dailyLimitUsd) return false;
    this.spentToday += amount;
    return true;
  }

  isSoftLimitReached(): boolean {
    this.rolloverIfNewDay();
    return this.spentToday >= this.constraints.softLimitUsd;
  }

  private rolloverIfNewDay(): void {
    const now = Date.now();
    if (now - this.dayStart >= 86_400_000) {
      this.spentToday = 0;
      this.dayStart = this.todayStartMs();
    }
  }

  private todayStartMs(): number {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
}

// ----------------------------------------------------------
// SafetyMonitor
// ----------------------------------------------------------

export class SafetyMonitor {
  private killSwitchActive = false;
  private killSwitchReason: string | null = null;
  private readonly budget: DailyBudgetTracker;
  private readonly rateLimiter: TokenBucket;
  private readonly escalationConfig: EscalationConfig;
  private readonly transactionLimitUsd: number;
  private readonly humanApprovalThresholdUsd: number;

  constructor(
    private readonly config: SafetyConfig,
    private readonly audit: AuditLogger,
  ) {
    this.budget = new DailyBudgetTracker(config.budget);
    this.rateLimiter = new TokenBucket(
      config.rateLimits.burstAllowance,
      config.rateLimits.requestsPerMinute / 60 / 1000, // convert to per-ms
    );
    this.escalationConfig = config.escalation;
    this.transactionLimitUsd = config.budget.transactionLimitUsd;
    this.humanApprovalThresholdUsd = config.budget.humanApprovalThresholdUsd;
  }

  /**
   * Evaluate whether an operation is allowed.
   * This is the primary enforcement point — called before every payment or tool invocation.
   * Does NOT mutate budget; call `recordSpend` after the operation actually executes.
   */
  async checkOperation(operation: Operation): Promise<SafetyResult> {
    // 1. Kill switch — absolute block
    if (this.killSwitchActive) {
      return {
        allowed: false,
        reason: `Kill switch active: ${this.killSwitchReason ?? 'emergency stop'}`,
        requiresHumanApproval: true,
      };
    }

    // 2. Rate limit
    if (!this.rateLimiter.consume(1)) {
      return {
        allowed: false,
        reason: 'Rate limit exceeded',
        retryAfterSeconds: this.rateLimiter.retryAfterSeconds(1),
      };
    }

    // 3. Per-transaction hard cap
    if (operation.costUsd > this.transactionLimitUsd) {
      this.audit.record('safety_block_transaction_limit', {
        operation,
        limitUsd: this.transactionLimitUsd,
      });
      return {
        allowed: false,
        reason: `Transaction amount $${operation.costUsd} exceeds per-transaction limit $${this.transactionLimitUsd}`,
        requiresHumanApproval: true,
      };
    }

    // 4. Human approval threshold
    if (operation.costUsd > this.humanApprovalThresholdUsd) {
      await this.triggerEscalation(operation, 'high_value_transaction');
      this.audit.record('safety_escalation_required', {
        operation,
        thresholdUsd: this.humanApprovalThresholdUsd,
      });
      return {
        allowed: false,
        reason: `Amount $${operation.costUsd} exceeds human approval threshold $${this.humanApprovalThresholdUsd}`,
        requiresHumanApproval: true,
        escalationUrl: `https://clawcombinator.ai/agents/approve?op=${encodeURIComponent(operation.description)}`,
      };
    }

    // 5. Daily budget check (does NOT commit the spend yet)
    if (this.budget.remaining < operation.costUsd) {
      this.audit.record('safety_block_budget', {
        operation,
        remaining: this.budget.remaining,
        dailyLimit: this.budget.limit,
      });
      return {
        allowed: false,
        reason: `Daily budget exhausted. Remaining: $${this.budget.remaining.toFixed(2)}, requested: $${operation.costUsd}`,
        requiresHumanApproval: false,
      };
    }

    // 6. Soft limit warning (allowed but logged)
    if (this.budget.isSoftLimitReached()) {
      this.audit.record('safety_soft_limit_warning', {
        spent: this.budget.spent,
        softLimit: this.config.budget.softLimitUsd,
      });
    }

    this.audit.record('safety_check_passed', { operation });
    return { allowed: true };
  }

  /**
   * Commit a spend after an operation has successfully executed.
   * Must be called after every approved payment.
   */
  recordSpend(amountUsd: number): void {
    const accepted = this.budget.trySpend(amountUsd);
    if (!accepted) {
      // Should not happen if checkOperation was called first — log and continue
      this.audit.record('safety_budget_desync', { amountUsd, remaining: this.budget.remaining });
    }
  }

  /**
   * Activate the kill switch. All subsequent operations are blocked
   * until the switch is manually cleared (restart the process).
   */
  async activateKillSwitch(reason: string): Promise<void> {
    this.killSwitchActive = true;
    this.killSwitchReason = reason;
    this.audit.record('kill_switch_activated', { reason });
    await this.triggerEscalation({ type: 'tool_call', costUsd: 0, description: 'kill switch' }, 'emergency_stop');
  }

  get isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  get dailySpendUsd(): number {
    return this.budget.spent;
  }

  get dailyBudgetUsd(): number {
    return this.budget.limit;
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private async triggerEscalation(operation: Operation, event: string): Promise<void> {
    const payload = JSON.stringify({
      event,
      operation,
      agentId: process.env['CC_AGENT_ID'] ?? 'unknown',
      timestamp: new Date().toISOString(),
    });

    for (const url of this.escalationConfig.webhookUrls) {
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Non-fatal — escalation failure must not block the safety check response
      }
    }
  }
}

