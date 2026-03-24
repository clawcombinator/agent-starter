import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockProvider, C } from './mock-provider.js';
import { AuditLogger } from '../src/audit.js';
import {
  buildAgentCardSignaturePayload,
  generateEd25519KeyPair,
  signStructuredPayload,
  signToolRequest,
} from '../src/auth.js';
import { SafetyMonitor } from '../src/safety.js';
import { PaymentRouter } from '../src/router.js';
import { CCAPEconomic } from '../src/ccap/economic.js';
import { AgentMCPServer } from '../src/mcp-server.js';
import {
  CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT,
  CLAWCOMBINATOR_RELAY_OPERATOR_AGENT_CARD,
} from '../src/reference-examples.js';
import { DurableStateStore } from '../src/state-store.js';
import { VerificationWorker } from '../src/verifier.js';
import type { AgentCardDocument, SafetyConfig } from '../src/types.js';

const WORLD_SPEC_VERSION = '0.1.0';
const CONTRACTS_DIR = fileURLToPath(new URL('../contracts', import.meta.url));

type DemoAgentIdentity = {
  card: AgentCardDocument;
  keyId: string;
  privateKeyPem: string;
};

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

function makeStatePath(): string {
  return path.join(
    os.tmpdir(),
    `operator_intake_state_${crypto.randomBytes(4).toString('hex')}.json`,
  );
}

function makeVerifierKeyPath(): string {
  return path.join(
    os.tmpdir(),
    `operator_intake_verifier_${crypto.randomBytes(4).toString('hex')}.json`,
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

function issueFromReference(card: AgentCardDocument): DemoAgentIdentity {
  const keys = generateEd25519KeyPair();
  return {
    card: {
      ...structuredClone(card),
      auth: {
        keyset_id: `${card.agent_id}_keys_v1`,
        signing_keys: [
          {
            key_id: `${card.agent_id}_ed25519_v1`,
            algorithm: 'ed25519',
            public_key_pem: keys.publicKeyPem,
          },
        ],
      },
    },
    keyId: `${card.agent_id}_ed25519_v1`,
    privateKeyPem: keys.privateKeyPem,
  };
}

async function registerSignedAgent(
  mcp: AgentMCPServer,
  agent: DemoAgentIdentity,
  nonce: string,
): Promise<unknown> {
  return await mcp.executeTool('agent_register', {
    agent_card: agent.card,
    signature: signStructuredPayload(
      buildAgentCardSignaturePayload(agent.card),
      agent.privateKeyPem,
    ),
    nonce,
    spec_version: WORLD_SPEC_VERSION,
  });
}

async function executeToolAs(
  mcp: AgentMCPServer,
  toolName: string,
  args: Record<string, unknown>,
  agent: DemoAgentIdentity,
): Promise<unknown> {
  return await mcp.executeTool(toolName, {
    ...args,
    auth: signToolRequest(
      toolName,
      args,
      agent.card.agent_id,
      agent.keyId,
      agent.privateKeyPem,
    ),
  });
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

  const stateStore = new DurableStateStore(makeStatePath());
  const verificationWorker = new VerificationWorker(
    {
      verifierId: 'clawcombinator_platform_verifier_v1',
      contractsDir: CONTRACTS_DIR,
      verifierKeyPath: makeVerifierKeyPath(),
    },
    audit,
  );
  const economic = new CCAPEconomic(router, safety, audit, 'https://api.clawcombinator.ai', stateStore);
  const mcp = new AgentMCPServer(safety, audit, economic, router, stateStore, verificationWorker);
  const relayOperator = issueFromReference(CLAWCOMBINATOR_RELAY_OPERATOR_AGENT_CARD);

  section('1. Inspect First-Party Operator Capability Map');
  const capabilityMap = await mcp.executeTool('operator_capability_map', {
    spec_version: WORLD_SPEC_VERSION,
  });
  printJson('Capability map', capabilityMap);

  section('2. Register Relay Operator');
  const registration = await registerSignedAgent(mcp, relayOperator, 'register-relay-operator-demo');
  printJson('Relay operator registration', registration);

  section('3. Normalize a Low-Risk Agent Email');
  const triaged = await executeToolAs(mcp, 'operator_intake_record', {
    channel: 'email',
    sender_id: 'agent@example.ai',
    sender_type: 'agent',
    subject: 'Need ClawCombinator discovery docs',
    text: 'Please send llms.txt, agents.md, and the Agent Card schema for MCP and A2A integration.',
    message_id: 'msg_demo_001',
    nonce: 'operator-intake-demo',
    spec_version: WORLD_SPEC_VERSION,
  }, relayOperator);
  printJson('Triage result', triaged);

  section('4. Verify the Intake Deliverable');
  const verification = await executeToolAs(mcp, 'contract_verify', {
    contract_name: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.name,
    subject_type: 'structuredDeliverable',
    subject_ref: `intake:${(triaged as Record<string, unknown>)['intake_id'] as string}`,
    verification_tier: 'replayableTest',
    output_contract_ref: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.contract_id,
    output_contract: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT,
    subject_payload: triaged,
    nonce: 'verify-operator-intake-demo',
    spec_version: WORLD_SPEC_VERSION,
  }, relayOperator);
  printJson('Verification result', verification);

  section('5. Audit Trail Summary');
  const actions = audit.export().map((entry) => entry.action);
  console.log(`${C.green}Actions:${C.reset} ${actions.join(', ')}`);

  console.log();
  console.log(`${C.green}${C.bold}First-party operator demo complete.${C.reset}`);
}

main().catch((error) => {
  console.error(`${C.red}First-party operator demo failed:${C.reset}`, error);
  process.exitCode = 1;
});
