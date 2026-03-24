import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { MockProvider, C } from './mock-provider.js';
import { AuditLogger } from '../src/audit.js';
import { SafetyMonitor } from '../src/safety.js';
import { PaymentRouter } from '../src/router.js';
import { CCAPEconomic } from '../src/ccap/economic.js';
import { AgentMCPServer } from '../src/mcp-server.js';
import {
  FINANCIAL_SCENARIO_AGENT_CARD,
  LEGAL_DUE_DILIGENCE_AGENT_CARD,
  PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
  PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
} from '../src/reference-examples.js';
import type { SafetyConfig } from '../src/types.js';

function section(title: string): void {
  console.log();
  console.log(`${C.yellow}${'='.repeat(72)}${C.reset}`);
  console.log(`${C.yellow}${C.bold}${title}${C.reset}`);
  console.log(`${C.yellow}${'='.repeat(72)}${C.reset}`);
}

function printJson(label: string, payload: unknown): void {
  console.log(`${C.cyan}${label}${C.reset}`);
  console.log(JSON.stringify(payload, null, 2));
}

function makeAuditPath(): string {
  return path.join(
    os.tmpdir(),
    `reference_workflow_${crypto.randomBytes(4).toString('hex')}.jsonl`,
  );
}

function makeConfig(): SafetyConfig {
  return {
    budget: {
      dailyLimitUsd: 100_000,
      softLimitUsd: 80_000,
      transactionLimitUsd: 50_000,
      humanApprovalThresholdUsd: 75_000,
    },
    rateLimits: { requestsPerMinute: 600, burstAllowance: 900 },
    escalation: { webhookUrls: [], timeoutMinutes: 60 },
  };
}

async function main(): Promise<void> {
  console.clear();
  console.log();
  console.log(`${C.yellow}${C.bold}ClawCombinator Reference Workflow Demo${C.reset}`);
  console.log(`${C.dim}Discovery -> bond -> escrow -> structured verification -> settlement${C.reset}`);

  const auditPath = makeAuditPath();
  const audit = new AuditLogger(auditPath);
  const safety = new SafetyMonitor(makeConfig(), audit);
  const router = new PaymentRouter(safety, audit);
  const provider = new MockProvider({
    transactionLimitUsd: 2_000,
    defaultStartingBalance: 1_000,
    currency: 'USD',
  });

  await provider.initialize();
  router.registerProvider(provider);

  const economic = new CCAPEconomic(router, safety, audit);
  const mcp = new AgentMCPServer(safety, audit, economic, router);

  section('1. Load World Spec');
  const worldSpec = await mcp.executeTool('read_world_spec', {
    spec_version: '0.1.0',
  });
  printJson('World spec root', worldSpec);

  section('2. Register Complementary Agents');
  const legalRegistration = await mcp.executeTool('agent_register', {
    agent_card: LEGAL_DUE_DILIGENCE_AGENT_CARD,
    signature: 'sig_lex_demo',
    nonce: 'register-lex-demo',
    spec_version: '0.1.0',
  });
  const financialRegistration = await mcp.executeTool('agent_register', {
    agent_card: FINANCIAL_SCENARIO_AGENT_CARD,
    signature: 'sig_fin_demo',
    nonce: 'register-fin-demo',
    spec_version: '0.1.0',
  });
  printJson('Legal agent registration', legalRegistration);
  printJson('Financial agent registration', financialRegistration);

  section('3. Discover Compatible Collaborator');
  const discovered = await mcp.executeTool('agent_discover', {
    capability: 'syntheticSimulation',
    input_type: 'productSpec',
    output_type: 'structuredDeliverable',
    min_reputation_score: 800,
    spec_version: '0.1.0',
  });
  printJson('Discovery response', discovered);

  section('4. Post Seller Bond');
  const bond = await mcp.executeTool('bond_post', {
    agent_id: FINANCIAL_SCENARIO_AGENT_CARD.agent_id,
    amount_usd_cents: 15000,
    scope: 'financial_transaction_routing',
    claim_conditions: 'Losses caused by incorrect scenario analysis or failed settlement',
    duration_hours: 24,
    nonce: 'bond-post-demo',
    spec_version: '0.1.0',
  });
  printJson('Bond result', bond);

  section('5. Lock Funded Escrow');
  const escrow = await mcp.executeTool('escrow_lock', {
    buyer_agent_id: LEGAL_DUE_DILIGENCE_AGENT_CARD.agent_id,
    beneficiary_agent_id: FINANCIAL_SCENARIO_AGENT_CARD.agent_id,
    amount_usd_cents: 7500,
    contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
    completion_criteria: 'Deliver Project Birch scenario pack with deterministic validation evidence',
    workflow_class: 'service_delivery',
    verification_tier: 'replayableTest',
    output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
    nonce: 'escrow-lock-demo',
    spec_version: '0.1.0',
  });
  printJson('Escrow result', escrow);

  section('6. Verify Structured Deliverable');
  const verification = await mcp.executeTool('contract_verify', {
    escrow_id: (escrow as Record<string, unknown>)['escrow_id'],
    contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
    subject_type: 'structuredDeliverable',
    subject_ref: 'deliverable:project-birch:financial-analysis',
    verification_tier: 'replayableTest',
    output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
    output_contract: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
    subject_payload: PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
    spec_version: '0.1.0',
  });
  printJson('Verification result', verification);

  section('7. Settle Escrow');
  const released = await mcp.executeTool('release_escrow', {
    escrowId: (escrow as Record<string, unknown>)['escrow_id'],
    completionEvidence: (verification as Record<string, unknown>)['evidence_ref'],
    nonce: 'release-demo',
  });
  printJson('Release result', released);

  section('8. Reputation View');
  const score = await mcp.executeTool('reputation_score', {
    agent_id: FINANCIAL_SCENARIO_AGENT_CARD.agent_id,
    spec_version: '0.1.0',
  });
  printJson('Reputation score', score);

  section('9. Audit Trail Summary');
  const entries = audit.export();
  console.log(`${C.green}Audit path:${C.reset} ${auditPath}`);
  console.log(`${C.green}Audit entries:${C.reset} ${entries.length}`);
  console.log(
    `${C.green}Actions:${C.reset} ${entries.map((entry) => entry.action).join(', ')}`,
  );

  console.log();
  console.log(`${C.green}${C.bold}Reference workflow complete.${C.reset}`);
}

main().catch((error) => {
  console.error(`${C.red}Reference workflow failed:${C.reset}`, error);
  process.exitCode = 1;
});
