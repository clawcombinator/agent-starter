// ============================================================
// BuyerAgent — posts work, creates escrow, verifies seller bond,
// releases payment on completion.
//
// This agent represents a law firm that needs 500 contracts
// analysed for compliance risks. It puts $500 in escrow to
// guarantee payment, then releases it once the seller delivers.
// ============================================================

import { AuditLogger } from '../src/audit.js';
import { SafetyMonitor } from '../src/safety.js';
import { PaymentRouter } from '../src/router.js';
import { CCAPEconomic } from '../src/ccap/economic.js';
import type { SafetyConfig, CreateEscrowResult, VerifyBondResult, CreditScore } from '../src/types.js';
import type { MockProvider } from './mock-provider.js';
import { C } from './mock-provider.js';

// ----------------------------------------------------------
// BuyerAgent
// ----------------------------------------------------------

export interface BuyerTask {
  title: string;
  description: string;
  paymentUsd: number;
  currency: string;
  sellerAgentId: string;
  timeoutSeconds: number;
}

export class BuyerAgent {
  private readonly audit: AuditLogger;
  private readonly safety: SafetyMonitor;
  private readonly router: PaymentRouter;
  readonly economic: CCAPEconomic;

  private readonly agentId = 'buyer_agent_lexcorp';
  private readonly walletAddress = 'wallet_buyer_0x1a2b3c4d';

  constructor(private readonly provider: MockProvider) {
    // Audit log written to a unique per-run temp path (avoids accumulating
    // entries across multiple demo runs — AuditLogger loads existing on init)
    this.audit = new AuditLogger(`/tmp/cc-demo-buyer-audit-${Date.now()}.jsonl`);

    const safetyConfig: SafetyConfig = {
      budget: {
        dailyLimitUsd: 10_000,
        softLimitUsd: 8_000,
        transactionLimitUsd: 2_000,
        humanApprovalThresholdUsd: 5_000,
      },
      rateLimits: { requestsPerMinute: 120, burstAllowance: 30 },
      escalation: { webhookUrls: [], timeoutMinutes: 60 },
    };

    this.safety  = new SafetyMonitor(safetyConfig, this.audit);
    this.router  = new PaymentRouter(this.safety, this.audit);
    this.economic = new CCAPEconomic(this.router, this.safety, this.audit);

    this.router.registerProvider(provider);
  }

  // ----------------------------------------------------------
  // createEscrow — lock funds in escrow before posting the task
  // ----------------------------------------------------------

  async createEscrow(task: BuyerTask): Promise<CreateEscrowResult> {
    this.log(`Creating escrow: $${task.paymentUsd} ${task.currency} for "${task.title}"`);

    const result = await this.economic.createEscrow({
      amount:                  task.paymentUsd,
      currency:                task.currency,
      beneficiaryAgentId:      task.sellerAgentId,
      completionCriteria:      `Deliver full compliance analysis for ${task.description}. ` +
                               `Output: structured JSON report with risk classification per contract.`,
      timeoutSeconds:          task.timeoutSeconds,
      disputeResolutionMethod: 'arbitration_agent',
      arbitrationAgentId:      'arbitration_agent_ccap_v1',
      idempotencyKey:          `escrow_${this.agentId}_${Date.now()}`,
      metadata: {
        buyerWallet:  this.walletAddress,
        taskTitle:    task.title,
        contractCount: 500,
      },
    });

    this.log(`${C.green}Escrow created${C.reset} — ID: ${C.bold}${result.escrowId}${C.reset}`);
    this.log(`  Status: ${result.status} | Expires: ${result.expiresAt}`);

    return result;
  }

  // ----------------------------------------------------------
  // verifySellerBond — confirm the seller has skin in the game
  // ----------------------------------------------------------

  verifySellerBond(sellerAgentId: string): VerifyBondResult {
    this.log(`Verifying bond for seller: ${sellerAgentId}`);

    // In production this would call the CCAP registry API.
    // For the demo, verifyBond only works for 'self' (the agent's own bonds).
    // We call it on the seller's economic instance, passed in via run-demo.ts.
    // Here we return a synthesised result to show the protocol.
    const result = this.economic.verifyBond(sellerAgentId);
    return result;
  }

  // ----------------------------------------------------------
  // approveAndRelease — release escrow once work is done
  // ----------------------------------------------------------

  async approveAndRelease(
    escrowId: string,
    completionEvidence: string,
  ): Promise<void> {
    this.log(`Approving completion — releasing escrow ${C.bold}${escrowId}${C.reset}`);
    this.log(`  Evidence: ${C.dim}${completionEvidence}${C.reset}`);

    const result = await this.economic.releaseEscrow(escrowId, completionEvidence);

    this.log(`${C.green}Payment released!${C.reset}`);
    this.log(`  Amount:  $${result.amount} ${result.currency}`);
    this.log(`  To:      ${result.releasedTo}`);
    this.log(`  TxnID:   ${C.dim}${result.transactionId}${C.reset}`);
    this.log(`  At:      ${result.releasedAt}`);
  }

  // ----------------------------------------------------------
  // checkCreditScore — query the seller's credit score
  // ----------------------------------------------------------

  checkCreditScore(agentId: string): CreditScore {
    this.log(`Querying credit score for: ${agentId}`);
    const score = this.economic.getCreditScore(agentId);
    this.log(`  Score: ${C.bold}${score.score}${C.reset} (${score.tier.toUpperCase()}) — computed ${score.computedAt}`);
    return score;
  }

  // ----------------------------------------------------------
  // printAuditTrail — display the full hash-chained audit log
  // ----------------------------------------------------------

  printAuditTrail(): void {
    const entries = this.audit.export();
    const verify  = this.audit.verify();

    console.log();
    console.log(`${C.yellow}${'─'.repeat(72)}${C.reset}`);
    console.log(`${C.yellow}  BUYER AUDIT TRAIL  (${entries.length} entries)${C.reset}`);
    console.log(`${C.yellow}${'─'.repeat(72)}${C.reset}`);

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const prevShort = i === 0 ? 'genesis' : `…${entries[i - 1]!.hash.slice(-8)}`;
      const currShort = `…${e.hash.slice(-8)}`;
      const ts = e.timestamp.slice(11, 23); // HH:MM:SS.mmm

      console.log(
        `  ${C.dim}[${String(i + 1).padStart(2, '0')}]${C.reset}` +
        ` ${C.dim}${ts}${C.reset}` +
        ` ${C.cyan}${e.action.padEnd(40)}${C.reset}` +
        ` ${C.dim}${prevShort} → ${currShort}${C.reset}`,
      );
    }

    console.log();
    const chainStatus = verify.valid
      ? `${C.green}CHAIN INTACT${C.reset} — all ${verify.entriesChecked} hashes verified`
      : `${C.red}CHAIN BROKEN${C.reset} at entry ${verify.firstBrokenAt}: ${verify.error}`;
    console.log(`  ${chainStatus}`);
    console.log(`${C.yellow}${'─'.repeat(72)}${C.reset}`);
  }

  // ----------------------------------------------------------
  // Private logging
  // ----------------------------------------------------------

  private log(msg: string): void {
    console.log(`${C.cyan}[BUYER]${C.reset} ${msg}`);
  }
}
