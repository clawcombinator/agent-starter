// ============================================================
// SellerAgent — discovers tasks, posts a liability bond, does
// the work, and receives payment via escrow release.
//
// This agent represents an AI compliance specialist. Before
// accepting the task it posts a $100 bond as a costly signal
// [a commitment device that is expensive to fake] that it has
// skin in the game. After delivering, the bond is returned
// and the credit score updates.
// ============================================================

import { AuditLogger } from '../src/audit.js';
import { SafetyMonitor } from '../src/safety.js';
import { PaymentRouter } from '../src/router.js';
import { CCAPEconomic } from '../src/ccap/economic.js';
import type { SafetyConfig, EscrowStatusResult, BondResult, CreditScore } from '../src/types.js';
import type { MockProvider } from './mock-provider.js';
import { C } from './mock-provider.js';

// ----------------------------------------------------------
// SellerAgent
// ----------------------------------------------------------

export class SellerAgent {
  private readonly audit: AuditLogger;
  private readonly safety: SafetyMonitor;
  private readonly router: PaymentRouter;
  readonly economic: CCAPEconomic;

  readonly agentId = 'seller_agent_lexalytics_ai';
  private readonly walletAddress = 'wallet_seller_0x9f8e7d6c';

  private activeBondId: string | null = null;

  constructor(private readonly provider: MockProvider) {
    this.audit = new AuditLogger(`/tmp/cc-demo-seller-audit-${Date.now()}.jsonl`);

    // Generous safety limits for the seller — they deal in large bonds
    const safetyConfig: SafetyConfig = {
      budget: {
        dailyLimitUsd: 5_000,
        softLimitUsd: 4_000,
        transactionLimitUsd: 1_000,
        humanApprovalThresholdUsd: 2_000,
      },
      rateLimits: { requestsPerMinute: 120, burstAllowance: 30 },
      escalation: { webhookUrls: [], timeoutMinutes: 60 },
    };

    this.safety   = new SafetyMonitor(safetyConfig, this.audit);
    this.router   = new PaymentRouter(this.safety, this.audit);
    this.economic = new CCAPEconomic(this.router, this.safety, this.audit);

    this.router.registerProvider(provider);

    // Pre-fund the seller's wallet so it can post a bond
    this.provider.seedWallet(this.walletAddress, 500);
  }

  // ----------------------------------------------------------
  // checkCreditScore — print score before and after to show delta
  // ----------------------------------------------------------

  checkCreditScore(): CreditScore {
    const score = this.economic.getCreditScore(this.agentId);
    this.log(`Credit score: ${C.bold}${score.score}${C.reset} (${score.tier.toUpperCase()})`);
    this.log(`  Payment reliability: ${score.components.paymentReliability.score}`);
    this.log(`  Bond history:        ${score.components.bondHistory.score}`);
    this.log(`  Transaction volume:  ${score.components.transactionVolume.score}`);
    this.log(`  Dispute rate:        ${score.components.disputeRate.score}`);
    if (score.flags.length > 0) {
      for (const flag of score.flags) {
        this.log(`  ${C.yellow}FLAG${C.reset}: ${flag.code} — ${flag.description}`);
      }
    }
    return score;
  }

  // ----------------------------------------------------------
  // verifyEscrow — confirm buyer's escrow is funded before working
  // ----------------------------------------------------------

  async verifyEscrow(escrowId: string): Promise<EscrowStatusResult> {
    this.log(`Verifying escrow: ${escrowId}`);

    const status = await this.economic.verifyEscrow(escrowId);

    this.log(`  Status:   ${C.bold}${status.status}${C.reset}`);
    this.log(`  Amount:   $${status.amount} ${status.currency}`);
    this.log(`  Criteria: ${C.dim}${status.completionCriteria.slice(0, 80)}…${C.reset}`);
    this.log(`  Expires:  ${status.expiresAt}`);

    if (status.status !== 'created' && status.status !== 'funded') {
      throw new Error(`Escrow ${escrowId} is not in a fundable state: ${status.status}`);
    }

    this.log(`${C.green}Escrow verified — safe to proceed${C.reset}`);
    return status;
  }

  // ----------------------------------------------------------
  // postBond — lock capital as a costly signal of commitment
  // ----------------------------------------------------------

  async postBond(amountUsd: number): Promise<BondResult> {
    this.log(`Posting liability bond: $${amountUsd} USD`);
    this.log(`  Scope: legal_document_handling`);
    this.log(`  This is skin in the game — forfeited if I underdeliver`);

    const result = await this.economic.postBond({
      amount:          amountUsd,
      currency:        'USD',
      scope:           'legal_document_handling',
      scopeDescription:
        'AI-powered contract analysis for compliance risk identification. ' +
        'Output: structured JSON risk report per contract.',
      durationSeconds: 86_400,          // 24-hour bond period
      claimConditions:
        'Buyer may claim if: (a) report is not delivered within SLA, ' +
        '(b) material errors found post-delivery, or (c) completeness < 95%.',
      maxClaimAmount:       amountUsd,  // Entire bond can be claimed
      arbitrationAgentId:  'arbitration_agent_ccap_v1',
      humanEscalationThresholdUsd: 500,
      idempotencyKey: `bond_${this.agentId}_${Date.now()}`,
    });

    this.activeBondId = result.bondId;
    this.log(`${C.green}Bond posted${C.reset} — ID: ${C.bold}${result.bondId}${C.reset}`);
    this.log(`  Active from: ${result.activeFrom}`);
    this.log(`  Expires:     ${result.expiresAt}`);
    this.log(`  TxnID:       ${C.dim}${result.transactionId}${C.reset}`);

    return result;
  }

  // ----------------------------------------------------------
  // doWork — simulate contract analysis with progress messages
  // ----------------------------------------------------------

  async doWork(contractCount: number): Promise<string> {
    this.log(`Starting work: analysing ${contractCount} contracts…`);
    console.log();

    const stages = [
      { label: 'Parsing contract structure',   pct: 10 },
      { label: 'Extracting clauses',           pct: 25 },
      { label: 'Running GDPR risk checks',     pct: 40 },
      { label: 'Running CCPA risk checks',     pct: 55 },
      { label: 'Identifying force-majeure gaps', pct: 70 },
      { label: 'Cross-referencing precedents', pct: 85 },
      { label: 'Generating risk scores',       pct: 95 },
      { label: 'Finalising JSON report',       pct: 100 },
    ];

    for (const stage of stages) {
      await this.simulateDelay(200, 600);
      const bar = this.progressBar(stage.pct, 30);
      process.stdout.write(
        `\r  ${C.green}[SELLER]${C.reset} ${bar} ${String(stage.pct).padStart(3)}%  ${C.dim}${stage.label}${C.reset}    `,
      );
    }

    console.log();
    console.log();

    // Produce a realistic-looking completion evidence hash
    const evidenceHash = `sha256:${Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('')}`;
    const reportUrl    = `https://storage.lexalytics.ai/reports/${evidenceHash.slice(7, 23)}.json`;

    this.log(`${C.green}Work complete!${C.reset}`);
    this.log(`  Contracts analysed: ${contractCount}`);
    this.log(`  High-risk findings: 12`);
    this.log(`  Medium-risk:        47`);
    this.log(`  Low-risk:           441`);
    this.log(`  Report URL:         ${C.dim}${reportUrl}${C.reset}`);
    this.log(`  Evidence hash:      ${C.dim}${evidenceHash}${C.reset}`);

    return `${reportUrl}|${evidenceHash}`;
  }

  // ----------------------------------------------------------
  // verifyOwnBond — show buyer that bond is active (cross-check)
  // ----------------------------------------------------------

  verifyOwnBond(): void {
    const result = this.economic.verifyBond('self');
    if (result.hasActiveBond) {
      this.log(`Bond verification (self): ${C.green}ACTIVE${C.reset}`);
      this.log(`  Bond ID:  ${result.bondId}`);
      this.log(`  Amount:   $${result.amount} ${result.currency}`);
      this.log(`  Scope:    ${result.scope}`);
    } else {
      this.log(`Bond verification: ${C.yellow}NO ACTIVE BOND${C.reset}`);
    }
  }

  // ----------------------------------------------------------
  // printAuditTrail — display the full hash-chained audit log
  // ----------------------------------------------------------

  printAuditTrail(): void {
    const entries = this.audit.export();
    const verify  = this.audit.verify();

    console.log();
    console.log(`${C.green}${'─'.repeat(72)}${C.reset}`);
    console.log(`${C.green}  SELLER AUDIT TRAIL  (${entries.length} entries)${C.reset}`);
    console.log(`${C.green}${'─'.repeat(72)}${C.reset}`);

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const prevShort = i === 0 ? 'genesis' : `…${entries[i - 1]!.hash.slice(-8)}`;
      const currShort = `…${e.hash.slice(-8)}`;
      const ts = e.timestamp.slice(11, 23);

      console.log(
        `  ${C.dim}[${String(i + 1).padStart(2, '0')}]${C.reset}` +
        ` ${C.dim}${ts}${C.reset}` +
        ` ${C.green}${e.action.padEnd(40)}${C.reset}` +
        ` ${C.dim}${prevShort} → ${currShort}${C.reset}`,
      );
    }

    console.log();
    const chainStatus = verify.valid
      ? `${C.green}CHAIN INTACT${C.reset} — all ${verify.entriesChecked} hashes verified`
      : `${C.red}CHAIN BROKEN${C.reset} at entry ${verify.firstBrokenAt}: ${verify.error}`;
    console.log(`  ${chainStatus}`);
    console.log(`${C.green}${'─'.repeat(72)}${C.reset}`);
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private log(msg: string): void {
    console.log(`${C.green}[SELLER]${C.reset} ${msg}`);
  }

  private progressBar(pct: number, width: number): string {
    const filled = Math.round((pct / 100) * width);
    const empty  = width - filled;
    return `${C.green}${'█'.repeat(filled)}${C.reset}${C.dim}${'░'.repeat(empty)}${C.reset}`;
  }

  private simulateDelay(minMs: number, maxMs: number): Promise<void> {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
