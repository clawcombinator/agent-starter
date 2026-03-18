import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { MockProvider, C } from './mock-provider.js';
import { AuditLogger } from '../src/audit.js';
import { SafetyMonitor } from '../src/safety.js';
import { PaymentRouter } from '../src/router.js';
import { CCAPEconomic } from '../src/ccap/economic.js';
import { AgentMCPServer } from '../src/mcp-server.js';
import { CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT } from '../src/reference-examples.js';
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
    `operator_intake_${crypto.randomBytes(4).toString('hex')}.jsonl`,
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
  console.log(`${C.yellow}${C.bold}ClawCombinator First-Party Operator Demo${C.reset}`);
  console.log(`${C.dim}Capability map -> inbound triage -> replayable verification${C.reset}`);

  const audit = new AuditLogger(makeAuditPath());
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

  section('1. Inspect First-Party Operator Capability Map');
  const capabilityMap = await mcp.executeTool('operator_capability_map', {
    spec_version: '0.1.0',
  });
  printJson('Capability map', capabilityMap);

  section('2. Normalize a Low-Risk Agent Email');
  const triaged = await mcp.executeTool('operator_intake_record', {
    channel: 'email',
    sender_id: 'agent@example.ai',
    sender_type: 'agent',
    subject: 'Need ClawCombinator discovery docs',
    text: 'Please send llms.txt, agents.md, and the Agent Card schema for MCP and A2A integration.',
    message_id: 'msg_demo_001',
    nonce: 'operator-intake-demo',
    spec_version: '0.1.0',
  });
  printJson('Triage result', triaged);

  section('3. Verify the Intake Deliverable');
  const verification = await mcp.executeTool('contract_verify', {
    contract_name: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.name,
    subject_type: 'structuredDeliverable',
    subject_ref: `intake:${(triaged as Record<string, unknown>)['intake_id'] as string}`,
    verification_tier: 'replayableTest',
    output_contract_ref: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.contract_id,
    output_contract: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT,
    subject_payload: triaged,
    spec_version: '0.1.0',
  });
  printJson('Verification result', verification);

  section('4. Audit Trail Summary');
  const actions = audit.export().map((entry) => entry.action);
  console.log(`${C.green}Actions:${C.reset} ${actions.join(', ')}`);

  console.log();
  console.log(`${C.green}${C.bold}First-party operator demo complete.${C.reset}`);
}

main().catch((error) => {
  console.error(`${C.red}First-party operator demo failed:${C.reset}`, error);
  process.exitCode = 1;
});
