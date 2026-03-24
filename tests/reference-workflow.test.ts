import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import type { Balance, PaymentParams, PaymentProvider, PaymentResult } from '../src/providers/types.js';
import type { AgentCardDocument, SafetyConfig } from '../src/types.js';

const WORLD_SPEC_VERSION = '0.1.0';
const CONTRACTS_DIR = fileURLToPath(new URL('../contracts', import.meta.url));

type TestAgentIdentity = {
  card: AgentCardDocument;
  keyId: string;
  privateKeyPem: string;
};

function tempFilePath(prefix: string, suffix: string): string {
  return path.join(os.tmpdir(), `${prefix}_${crypto.randomBytes(4).toString('hex')}${suffix}`);
}

function tempLogPath(): string {
  return tempFilePath('reference_workflow', '.jsonl');
}

function makeConfig(overrides: Partial<SafetyConfig['budget']> = {}): SafetyConfig {
  return {
    budget: {
      dailyLimitUsd: 100_000,
      softLimitUsd: 80_000,
      transactionLimitUsd: 50_000,
      humanApprovalThresholdUsd: 75_000,
      ...overrides,
    },
    rateLimits: { requestsPerMinute: 600, burstAllowance: 900 },
    escalation: { webhookUrls: [], timeoutMinutes: 60 },
  };
}

function makeMockProvider(name: string = 'mock_crypto'): PaymentProvider {
  return {
    name,
    initialize: vi.fn().mockResolvedValue(undefined),
    getBalance: vi.fn().mockResolvedValue({
      amount: '999999.00',
      currency: 'USD',
      provider: name,
    } satisfies Balance),
    pay: vi.fn().mockImplementation((_params: PaymentParams): Promise<PaymentResult> => {
      return Promise.resolve({
        transactionId: `tx_${crypto.randomBytes(4).toString('hex')}`,
        provider: name,
        status: 'completed',
        timestamp: new Date().toISOString(),
      } satisfies PaymentResult);
    }),
    supportsMethod: vi.fn().mockReturnValue(true),
  };
}

function issueFromReference(card: AgentCardDocument): TestAgentIdentity {
  const keys = generateEd25519KeyPair();
  const cloned = structuredClone(card);
  return {
    card: {
      ...cloned,
      auth: {
        keyset_id: `${cloned.agent_id}_keys_v1`,
        signing_keys: [
          {
            key_id: `${cloned.agent_id}_ed25519_v1`,
            algorithm: 'ed25519',
            public_key_pem: keys.publicKeyPem,
          },
        ],
      },
    },
    keyId: `${cloned.agent_id}_ed25519_v1`,
    privateKeyPem: keys.privateKeyPem,
  };
}

function makeServer() {
  const audit = new AuditLogger(tempLogPath());
  const safety = new SafetyMonitor(makeConfig(), audit);
  const router = new PaymentRouter(safety, audit);
  const stateStore = new DurableStateStore(tempFilePath('reference_state', '.json'));
  const verificationWorker = new VerificationWorker(
    {
      verifierId: 'clawcombinator_platform_verifier_v1',
      contractsDir: CONTRACTS_DIR,
      verifierKeyPath: tempFilePath('reference_verifier', '.json'),
    },
    audit,
  );
  router.registerProvider(makeMockProvider());
  const economic = new CCAPEconomic(router, safety, audit, 'https://api.clawcombinator.ai', stateStore);
  const mcp = new AgentMCPServer(safety, audit, economic, router, stateStore, verificationWorker);

  return { audit, economic, mcp };
}

async function registerSignedAgent(
  mcp: AgentMCPServer,
  agent: TestAgentIdentity,
  nonce: string,
): Promise<void> {
  const signature = signStructuredPayload(
    buildAgentCardSignaturePayload(agent.card),
    agent.privateKeyPem,
  );

  await mcp.executeTool('agent_register', {
    agent_card: agent.card,
    signature,
    nonce,
    spec_version: WORLD_SPEC_VERSION,
  });
}

async function executeToolAs(
  mcp: AgentMCPServer,
  toolName: string,
  args: Record<string, unknown>,
  agent: TestAgentIdentity,
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

describe('reference workflow demo path', () => {
  it('runs discovery to settlement with the canonical MCP tools', async () => {
    const { audit, economic, mcp } = makeServer();
    const legalAgent = issueFromReference(LEGAL_DUE_DILIGENCE_AGENT_CARD);
    const financialAgent = issueFromReference(FINANCIAL_SCENARIO_AGENT_CARD);

    const worldSpec = await mcp.executeTool('read_world_spec', {
      spec_version: WORLD_SPEC_VERSION,
    }) as Record<string, unknown>;
    expect(worldSpec['world_spec_url']).toBe('https://clawcombinator.ai/formal/category_spec.lean');

    await registerSignedAgent(mcp, legalAgent, 'register-lex-reference');
    await registerSignedAgent(mcp, financialAgent, 'register-fin-reference');

    const discovered = await mcp.executeTool('agent_discover', {
      capability: 'syntheticSimulation',
      input_type: 'productSpec',
      output_type: 'structuredDeliverable',
      min_reputation_score: 800,
      spec_version: WORLD_SPEC_VERSION,
    }) as { results: Array<Record<string, unknown>> };

    expect(discovered.results).toHaveLength(1);
    expect(discovered.results[0]!['agent_id']).toBe(financialAgent.card.agent_id);
    expect(
      ((discovered.results[0]!['compatibility'] as Record<string, unknown>)['matched_fields'] as string[]),
    ).toContain('output_type');

    await executeToolAs(
      mcp,
      'bond_post',
      {
        agent_id: financialAgent.card.agent_id,
        amount_usd_cents: 15000,
        scope: 'financial_transaction_routing',
        claim_conditions: 'Losses caused by incorrect scenario analysis or failed settlement',
        duration_hours: 24,
        nonce: 'bond-post-reference',
        spec_version: WORLD_SPEC_VERSION,
      },
      financialAgent,
    );

    const locked = await executeToolAs(
      mcp,
      'escrow_lock',
      {
        buyer_agent_id: legalAgent.card.agent_id,
        beneficiary_agent_id: financialAgent.card.agent_id,
        amount_usd_cents: 7500,
        contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
        completion_criteria: 'Deliver the Project Birch scenario pack with deterministic validation evidence',
        workflow_class: 'service_delivery',
        verification_tier: 'replayableTest',
        output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
        nonce: 'escrow-lock-reference',
        spec_version: WORLD_SPEC_VERSION,
      },
      legalAgent,
    ) as Record<string, unknown>;

    const verified = await executeToolAs(
      mcp,
      'contract_verify',
      {
        escrow_id: locked['escrow_id'],
        contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
        subject_type: 'structuredDeliverable',
        subject_ref: 'deliverable:project-birch:financial-analysis',
        verification_tier: 'replayableTest',
        output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
        output_contract: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
        subject_payload: PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
        nonce: 'verify-reference',
        spec_version: WORLD_SPEC_VERSION,
      },
      legalAgent,
    ) as Record<string, unknown>;

    const released = await executeToolAs(
      mcp,
      'release_escrow',
      {
        escrowId: locked['escrow_id'],
        completionEvidence: verified['evidence_ref'],
        nonce: 'release-reference',
      },
      legalAgent,
    ) as Record<string, unknown>;

    const score = await mcp.executeTool('reputation_score', {
      agent_id: financialAgent.card.agent_id,
      spec_version: WORLD_SPEC_VERSION,
    }) as Record<string, unknown>;

    expect(verified['status']).toBe('validated');
    expect(released['status']).toBe('released');
    expect(economic.getExtendedEscrow(locked['escrow_id'] as string)?.status).toBe('released');
    expect(Number(score['bond_capacity_usd_cents'])).toBeGreaterThanOrEqual(15000);

    const actions = audit.export().map((entry) => entry.action);
    expect(actions).toContain('agent_registered');
    expect(actions).toContain('contract_verified');
    expect(actions).toContain('extended_escrow_released');
  });
});
