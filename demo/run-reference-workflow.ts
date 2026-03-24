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
  FINANCIAL_SCENARIO_AGENT_CARD,
  LEGAL_DUE_DILIGENCE_AGENT_CARD,
  PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
  PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
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
    `reference_workflow_${crypto.randomBytes(4).toString('hex')}.jsonl`,
  );
}

function makeStatePath(): string {
  return path.join(
    os.tmpdir(),
    `reference_workflow_state_${crypto.randomBytes(4).toString('hex')}.json`,
  );
}

function makeVerifierKeyPath(): string {
  return path.join(
    os.tmpdir(),
    `reference_workflow_verifier_${crypto.randomBytes(4).toString('hex')}.json`,
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
  const legalAgent = issueFromReference(LEGAL_DUE_DILIGENCE_AGENT_CARD);
  const financialAgent = issueFromReference(FINANCIAL_SCENARIO_AGENT_CARD);

  section('1. Load World Spec');
  const worldSpec = await mcp.executeTool('read_world_spec', {
    spec_version: WORLD_SPEC_VERSION,
  });
  printJson('World spec root', worldSpec);

  section('2. Register Complementary Agents');
  const legalRegistration = await registerSignedAgent(mcp, legalAgent, 'register-lex-demo');
  const financialRegistration = await registerSignedAgent(mcp, financialAgent, 'register-fin-demo');
  printJson('Legal agent registration', legalRegistration);
  printJson('Financial agent registration', financialRegistration);

  section('3. Discover Compatible Collaborator');
  const discovered = await mcp.executeTool('agent_discover', {
      capability: 'syntheticSimulation',
      input_type: 'productSpec',
      output_type: 'structuredDeliverable',
      min_reputation_score: 800,
      spec_version: WORLD_SPEC_VERSION,
    });
  printJson('Discovery response', discovered);

  section('4. Post Seller Bond');
  const bond = await executeToolAs(mcp, 'bond_post', {
    agent_id: financialAgent.card.agent_id,
    amount_usd_cents: 15000,
    scope: 'financial_transaction_routing',
    claim_conditions: 'Losses caused by incorrect scenario analysis or failed settlement',
    duration_hours: 24,
    nonce: 'bond-post-demo',
    spec_version: WORLD_SPEC_VERSION,
  }, financialAgent);
  printJson('Bond result', bond);

  section('5. Lock Funded Escrow');
  const escrow = await executeToolAs(mcp, 'escrow_lock', {
    buyer_agent_id: legalAgent.card.agent_id,
    beneficiary_agent_id: financialAgent.card.agent_id,
    amount_usd_cents: 7500,
    contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
    completion_criteria: 'Deliver Project Birch scenario pack with deterministic validation evidence',
    workflow_class: 'service_delivery',
    verification_tier: 'replayableTest',
    output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
    nonce: 'escrow-lock-demo',
    spec_version: WORLD_SPEC_VERSION,
  }, legalAgent);
  printJson('Escrow result', escrow);

  section('6. Verify Structured Deliverable');
  const verification = await executeToolAs(mcp, 'contract_verify', {
    escrow_id: (escrow as Record<string, unknown>)['escrow_id'],
    contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
    subject_type: 'structuredDeliverable',
    subject_ref: 'deliverable:project-birch:financial-analysis',
    verification_tier: 'replayableTest',
    output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
    output_contract: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
    subject_payload: PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
    nonce: 'verify-demo',
    spec_version: WORLD_SPEC_VERSION,
  }, legalAgent);
  printJson('Verification result', verification);

  section('7. Settle Escrow');
  const released = await executeToolAs(mcp, 'release_escrow', {
    escrowId: (escrow as Record<string, unknown>)['escrow_id'],
    completionEvidence: (verification as Record<string, unknown>)['evidence_ref'],
    nonce: 'release-demo',
  }, legalAgent);
  printJson('Release result', released);

  section('8. Reputation View');
  const score = await mcp.executeTool('reputation_score', {
    agent_id: financialAgent.card.agent_id,
    spec_version: WORLD_SPEC_VERSION,
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
