// ============================================================
// Tests for the MCP server reference-stack tools.
//
// These cover:
//   - world-spec access
//   - signed agent registration and signed mutations
//   - replay-safe escrow locking
//   - proof/replay verification helpers
//   - dispute opening
//   - trusted output-contract registration and pinning
//   - canonical reputation view
// ============================================================

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
  CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT,
  CLAWCOMBINATOR_RELAY_OPERATOR_AGENT_CARD,
  CLAWCOMBINATOR_SAMPLE_INBOUND_TRIAGE_DELIVERABLE,
  FINANCIAL_SCENARIO_AGENT_CARD,
  LEGAL_DUE_DILIGENCE_AGENT_CARD,
  PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
  PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
} from '../src/reference-examples.js';
import { DurableStateStore } from '../src/state-store.js';
import { VerificationWorker } from '../src/verifier.js';
import type { Balance, PaymentParams, PaymentProvider, PaymentResult } from '../src/providers/types.js';
import type { AgentCardDocument, OutputContractDocument, SafetyConfig } from '../src/types.js';

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
  return tempFilePath('mcp_test', '.jsonl');
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

function issueAgentIdentity(base: Omit<AgentCardDocument, 'auth'>): TestAgentIdentity {
  const keys = generateEd25519KeyPair();
  const keyId = `${base.agent_id}_ed25519_v1`;
  return {
    card: {
      ...structuredClone(base),
      auth: {
        keyset_id: `${base.agent_id}_keys_v1`,
        signing_keys: [
          {
            key_id: keyId,
            algorithm: 'ed25519',
            public_key_pem: keys.publicKeyPem,
          },
        ],
      },
    },
    keyId,
    privateKeyPem: keys.privateKeyPem,
  };
}

function issueFromReference(card: AgentCardDocument): TestAgentIdentity {
  const cloned = structuredClone(card);
  const { auth: _auth, ...rest } = cloned;
  return issueAgentIdentity(rest);
}

function makeGenericAgent(params: {
  agentId: string;
  capability: AgentCardDocument['capability'];
  contractName?: string;
  inputType?: AgentCardDocument['contract']['input_type'];
  outputType?: AgentCardDocument['contract']['output_type'];
  reputationScore?: number;
  bondCapacityUsdCents?: number;
  requiredTier?: AgentCardDocument['contract']['required_tier'];
  escrowRequired?: boolean;
}): TestAgentIdentity {
  return issueAgentIdentity({
    agent_id: params.agentId,
    capability: params.capability,
    spec_version: WORLD_SPEC_VERSION,
    reputation_score: params.reputationScore ?? 700,
    bond_capacity_usd_cents: params.bondCapacityUsdCents ?? 25_000,
    supports_mcp: true,
    supports_a2a: true,
    contract: {
      name: params.contractName ?? `${params.agentId}_contract`,
      input_type: params.inputType ?? 'intent',
      output_type: params.outputType ?? 'structuredDeliverable',
      required_tier: params.requiredTier ?? 'replayableTest',
      mutates_state: false,
      idempotent_by_nonce: true,
      escrow_required: params.escrowRequired ?? true,
      spec_version: WORLD_SPEC_VERSION,
    },
  });
}

function makeServer() {
  const audit = new AuditLogger(tempLogPath());
  const safety = new SafetyMonitor(makeConfig(), audit);
  const router = new PaymentRouter(safety, audit);
  const provider = makeMockProvider();
  const stateStore = new DurableStateStore(tempFilePath('mcp_state', '.json'));
  const verificationWorker = new VerificationWorker(
    {
      verifierId: 'clawcombinator_platform_verifier_v1',
      contractsDir: CONTRACTS_DIR,
      verifierKeyPath: tempFilePath('mcp_verifier', '.json'),
      commandTimeoutMs: 5_000,
    },
    audit,
  );
  router.registerProvider(provider);
  const economic = new CCAPEconomic(router, safety, audit, 'https://api.clawcombinator.ai', stateStore);
  const mcp = new AgentMCPServer(safety, audit, economic, router, stateStore, verificationWorker);

  return { audit, economic, mcp, provider };
}

async function registerSignedAgent(
  mcp: AgentMCPServer,
  agent: TestAgentIdentity,
  nonce: string,
): Promise<Record<string, unknown>> {
  const signature = signStructuredPayload(
    buildAgentCardSignaturePayload(agent.card),
    agent.privateKeyPem,
  );
  return await mcp.executeTool('agent_register', {
    agent_card: agent.card,
    signature,
    nonce,
    spec_version: WORLD_SPEC_VERSION,
  }) as Record<string, unknown>;
}

function signedArgs(
  toolName: string,
  args: Record<string, unknown>,
  agent: TestAgentIdentity,
): Record<string, unknown> {
  return {
    ...args,
    auth: signToolRequest(
      toolName,
      args,
      agent.card.agent_id,
      agent.keyId,
      agent.privateKeyPem,
    ),
  };
}

async function executeToolAs(
  mcp: AgentMCPServer,
  toolName: string,
  args: Record<string, unknown>,
  agent: TestAgentIdentity,
): Promise<unknown> {
  return await mcp.executeTool(toolName, signedArgs(toolName, args, agent));
}

function buildCustomOutputContract(contractId: string, name: string): OutputContractDocument {
  return {
    contract_id: contractId,
    name,
    spec_version: WORLD_SPEC_VERSION,
    workflow_class: 'service_delivery',
    input_type: 'productSpec',
    output_type: 'structuredDeliverable',
    verification_tier: 'replayableTest',
    deliverable_schema: {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    settlement_rules: {
      requires_funded_escrow: true,
      required_verification_statuses: ['validated'],
    },
    example_subject_ref: `deliverable:${contractId}`,
  };
}

describe('AgentMCPServer reference-stack tools', () => {
  it('read_world_spec returns published URLs and the local Lean source path', async () => {
    const { mcp } = makeServer();

    const result = await mcp.executeTool('read_world_spec', {
      spec_version: WORLD_SPEC_VERSION,
    }) as Record<string, unknown>;

    expect(result['spec_version']).toBe(WORLD_SPEC_VERSION);
    expect(result['world_spec_url']).toBe('https://clawcombinator.ai/formal/category_spec.lean');
    expect(result['invariants_url']).toBe('https://clawcombinator.ai/feeds/invariants.json');
    expect(String(result['world_spec_path'])).toContain('contracts/Contracts/CategorySpec.lean');
    expect(typeof result['content_sha256']).toBe('string');
  });

  it('agent_register stores a signed Agent Card that agent_discover can query', async () => {
    const { mcp } = makeServer();
    const marketScanAgent = makeGenericAgent({
      agentId: 'market_scan_v1',
      capability: 'marketScanning',
      contractName: 'market_scan_contract',
      inputType: 'intent',
      outputType: 'marketSignal',
      reputationScore: 712,
      bondCapacityUsdCents: 250_000,
    });

    const registered = await registerSignedAgent(mcp, marketScanAgent, 'register-market-scan');

    const result = await mcp.executeTool('agent_discover', {
      capability: 'marketScanning',
      spec_version: WORLD_SPEC_VERSION,
    }) as { results: Array<Record<string, unknown>> };

    expect(registered['registration_status']).toBe('registered');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!['agent_id']).toBe('market_scan_v1');
    expect(result.results[0]!['reputation_score']).toBe(712);
    expect(
      ((result.results[0]!['compatibility'] as Record<string, unknown>)['matched_fields'] as string[]),
    ).toContain('capability');
  });

  it('operator_capability_map returns the first-party relay inbox and OpenClaw plan', async () => {
    const { mcp } = makeServer();

    const result = await mcp.executeTool('operator_capability_map', {
      spec_version: WORLD_SPEC_VERSION,
    }) as Record<string, unknown>;

    expect(result['canonical_inbox']).toBe('relay@clawcombinator.ai');
    expect(result['public_aliases']).toEqual(['claw@clawcombinator.ai']);

    const recommended = result['recommended_openclaw'] as Record<string, unknown>;
    expect(recommended['dm_policy']).toBe('pairing');
    expect(recommended['hook_session_key_template']).toBe('hook:gmail:{{messages[0].id}}');
  });

  it('operator_intake_record emits a replayable deliverable that contract_verify accepts', async () => {
    const { mcp } = makeServer();
    const relayOperator = issueFromReference(CLAWCOMBINATOR_RELAY_OPERATOR_AGENT_CARD);

    await registerSignedAgent(mcp, relayOperator, 'register-relay-operator');

    const triaged = await executeToolAs(
      mcp,
      'operator_intake_record',
      {
        channel: 'email',
        sender_id: 'agent@example.ai',
        sender_type: 'agent',
        subject: 'Need ClawCombinator discovery docs',
        text: 'Please send llms.txt, agents.md, and the Agent Card schema for MCP and A2A integration.',
        message_id: 'msg_operator_001',
        nonce: 'operator-intake-001',
        spec_version: WORLD_SPEC_VERSION,
      },
      relayOperator,
    ) as Record<string, unknown>;

    const verified = await executeToolAs(
      mcp,
      'contract_verify',
      {
        contract_name: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.name,
        subject_type: 'structuredDeliverable',
        subject_ref: `intake:${triaged['intake_id'] as string}`,
        verification_tier: 'replayableTest',
        output_contract_ref: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.contract_id,
        output_contract: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT,
        subject_payload: triaged,
        nonce: 'verify-intake-001',
        spec_version: WORLD_SPEC_VERSION,
      },
      relayOperator,
    ) as Record<string, unknown>;

    expect(triaged['route']).toBe('auto_reply');
    expect(triaged['risk_level']).toBe('low');
    expect(triaged['output_contract_id']).toBe(CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.contract_id);
    expect(verified['status']).toBe('validated');
    expect(verified['evidence_ref']).toMatch(/^sha256:/);
  });

  it('escrow_lock creates a funded escrow, pins the output contract, and replays safely for the same nonce', async () => {
    const { economic, mcp, provider } = makeServer();
    const buyer = makeGenericAgent({
      agentId: 'agent_buyer',
      capability: 'agentDiscovery',
      contractName: 'buyer_contract',
      escrowRequired: false,
    });
    const seller = makeGenericAgent({
      agentId: 'agent_seller',
      capability: 'implementation',
      contractName: 'seller_contract',
      inputType: 'productSpec',
      outputType: 'structuredDeliverable',
    });

    await registerSignedAgent(mcp, buyer, 'register-buyer');
    await registerSignedAgent(mcp, seller, 'register-seller');

    const args = {
      buyer_agent_id: buyer.card.agent_id,
      beneficiary_agent_id: seller.card.agent_id,
      amount_usd_cents: 12_500,
      contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
      completion_criteria: 'Deliver the agreed analysis bundle',
      workflow_class: 'service_delivery',
      output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
      nonce: 'escrow-lock-001',
      spec_version: WORLD_SPEC_VERSION,
    };

    const first = await executeToolAs(mcp, 'escrow_lock', args, buyer) as Record<string, unknown>;
    const second = await executeToolAs(mcp, 'escrow_lock', args, buyer) as Record<string, unknown>;
    const escrowId = first['escrow_id'] as string;

    expect(first['status']).toBe('funded');
    expect(first['funded']).toBe(true);
    expect(second['escrow_id']).toBe(escrowId);
    expect(provider.pay).toHaveBeenCalledOnce();
    expect(economic.getExtendedEscrow(escrowId)?.status).toBe('funded');
    expect(economic.getEscrowHolding(escrowId)?.fundsState).toBe('held');
    expect(first['verification_tier']).toBe('replayableTest');
    expect(first['output_contract_ref']).toBe(PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id);
  });

  it('escrow_lock rejects reuse of a nonce with a different payload', async () => {
    const { mcp } = makeServer();
    const buyer = makeGenericAgent({
      agentId: 'agent_buyer',
      capability: 'agentDiscovery',
    });
    const seller = makeGenericAgent({
      agentId: 'agent_seller',
      capability: 'implementation',
    });

    await registerSignedAgent(mcp, buyer, 'register-buyer');
    await registerSignedAgent(mcp, seller, 'register-seller');

    await executeToolAs(
      mcp,
      'escrow_lock',
      {
        buyer_agent_id: buyer.card.agent_id,
        beneficiary_agent_id: seller.card.agent_id,
        amount_usd_cents: 10_000,
        contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
        completion_criteria: 'Initial payload',
        workflow_class: 'service_delivery',
        output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
        nonce: 'escrow-lock-conflict',
        spec_version: WORLD_SPEC_VERSION,
      },
      buyer,
    );

    await expect(
      executeToolAs(
        mcp,
        'escrow_lock',
        {
          buyer_agent_id: buyer.card.agent_id,
          beneficiary_agent_id: seller.card.agent_id,
          amount_usd_cents: 11_000,
          contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
          completion_criteria: 'Changed payload',
          workflow_class: 'service_delivery',
          output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
          nonce: 'escrow-lock-conflict',
          spec_version: WORLD_SPEC_VERSION,
        },
        buyer,
      ),
    ).rejects.toThrow('Nonce replay mismatch');
  });

  it('contract_verify returns proven for the canonical world spec at proof tier', async () => {
    const { mcp } = makeServer();
    const verifierRequester = makeGenericAgent({
      agentId: 'formal_verifier_requester_v1',
      capability: 'formalVerification',
      contractName: 'formal_verification_request',
      inputType: 'validationProof',
      outputType: 'validationProof',
      requiredTier: 'proof',
      escrowRequired: false,
    });

    await registerSignedAgent(mcp, verifierRequester, 'register-proof-requester');

    const result = await executeToolAs(
      mcp,
      'contract_verify',
      {
        contract_name: 'category_spec',
        subject_type: 'validationProof',
        subject_ref: 'https://clawcombinator.ai/formal/category_spec.lean',
        verification_tier: 'proof',
        nonce: 'verify-proof-001',
        spec_version: WORLD_SPEC_VERSION,
      },
      verifierRequester,
    ) as Record<string, unknown>;

    expect(['proven', 'resourceHit']).toContain(result['status']);
    expect(result['evidence_ref']).toMatch(/^command:lake build Contracts\/CategorySpec\.lean:olean:sha256:/);

    const attestation = result['attestation'] as Record<string, unknown>;
    expect(attestation['verifier_id']).toBe('clawcombinator_platform_verifier_v1');
    expect((attestation['payload'] as Record<string, unknown>)['verification_method']).toBe('lean_proof');
  });

  it('contract_verify validates a structured deliverable and unlocks release_escrow', async () => {
    const { economic, mcp } = makeServer();
    const buyer = issueFromReference(LEGAL_DUE_DILIGENCE_AGENT_CARD);
    const seller = issueFromReference(FINANCIAL_SCENARIO_AGENT_CARD);

    await registerSignedAgent(mcp, buyer, 'register-lex');
    await registerSignedAgent(mcp, seller, 'register-fin');

    const locked = await executeToolAs(
      mcp,
      'escrow_lock',
      {
        buyer_agent_id: buyer.card.agent_id,
        beneficiary_agent_id: seller.card.agent_id,
        amount_usd_cents: 12_500,
        contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
        completion_criteria: 'Deliver Project Birch financial scenario analysis',
        workflow_class: 'service_delivery',
        verification_tier: 'replayableTest',
        output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
        nonce: 'escrow-lock-structured',
        spec_version: WORLD_SPEC_VERSION,
      },
      buyer,
    ) as Record<string, unknown>;

    await expect(
      executeToolAs(
        mcp,
        'release_escrow',
        {
          escrowId: locked['escrow_id'] as string,
          nonce: 'release-before-verify',
        },
        buyer,
      ),
    ).rejects.toThrow('no verification result recorded');

    const verified = await executeToolAs(
      mcp,
      'contract_verify',
      {
        escrow_id: locked['escrow_id'] as string,
        contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
        subject_type: 'structuredDeliverable',
        subject_ref: 'deliverable:project-birch:financial-analysis',
        verification_tier: 'replayableTest',
        output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
        output_contract: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
        subject_payload: PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
        nonce: 'verify-structured-001',
        spec_version: WORLD_SPEC_VERSION,
      },
      buyer,
    ) as Record<string, unknown>;

    const released = await executeToolAs(
      mcp,
      'release_escrow',
      {
        escrowId: locked['escrow_id'] as string,
        completionEvidence: verified['evidence_ref'] as string,
        nonce: 'release-after-verify',
      },
      buyer,
    ) as Record<string, unknown>;

    expect(verified['status']).toBe('validated');
    expect(verified['evidence_ref']).toMatch(/^sha256:/);
    expect(verified['output_contract_hash']).toMatch(/^[a-f0-9]{64}$/);
    expect(released['status']).toBe('released');
    expect(economic.getExtendedEscrow(locked['escrow_id'] as string)?.status).toBe('released');
    expect(economic.getEscrowHolding(locked['escrow_id'] as string)?.fundsState).toBe('released');
  });

  it('operator intake example remains valid against the canonical intake output contract', async () => {
    const { mcp } = makeServer();
    const relayOperator = issueFromReference(CLAWCOMBINATOR_RELAY_OPERATOR_AGENT_CARD);

    await registerSignedAgent(mcp, relayOperator, 'register-relay-operator');

    const verified = await executeToolAs(
      mcp,
      'contract_verify',
      {
        contract_name: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.name,
        subject_type: 'structuredDeliverable',
        subject_ref: 'intake:sample:email',
        verification_tier: 'replayableTest',
        output_contract_ref: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.contract_id,
        output_contract: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT,
        subject_payload: CLAWCOMBINATOR_SAMPLE_INBOUND_TRIAGE_DELIVERABLE,
        nonce: 'verify-intake-sample-001',
        spec_version: WORLD_SPEC_VERSION,
      },
      relayOperator,
    ) as Record<string, unknown>;

    expect(verified['status']).toBe('validated');
  });

  it('contract_verify rejects invalid structured deliverables and keeps escrow locked', async () => {
    const { economic, mcp } = makeServer();
    const buyer = issueFromReference(LEGAL_DUE_DILIGENCE_AGENT_CARD);
    const seller = issueFromReference(FINANCIAL_SCENARIO_AGENT_CARD);

    await registerSignedAgent(mcp, buyer, 'register-lex');
    await registerSignedAgent(mcp, seller, 'register-fin');

    const locked = await executeToolAs(
      mcp,
      'escrow_lock',
      {
        buyer_agent_id: buyer.card.agent_id,
        beneficiary_agent_id: seller.card.agent_id,
        amount_usd_cents: 12_500,
        contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
        completion_criteria: 'Deliver Project Birch financial scenario analysis',
        workflow_class: 'service_delivery',
        output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
        nonce: 'escrow-lock-invalid',
        spec_version: WORLD_SPEC_VERSION,
      },
      buyer,
    ) as Record<string, unknown>;

    const invalidDeliverable = {
      ...PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
      recommendation: 'ship-now',
    };

    const verified = await executeToolAs(
      mcp,
      'contract_verify',
      {
        escrow_id: locked['escrow_id'] as string,
        contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
        subject_type: 'structuredDeliverable',
        subject_ref: 'deliverable:project-birch:financial-analysis',
        verification_tier: 'replayableTest',
        output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
        output_contract: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
        subject_payload: invalidDeliverable,
        nonce: 'verify-invalid-structured-001',
        spec_version: WORLD_SPEC_VERSION,
      },
      buyer,
    ) as Record<string, unknown>;

    await expect(
      executeToolAs(
        mcp,
        'release_escrow',
        {
          escrowId: locked['escrow_id'] as string,
          completionEvidence: verified['evidence_ref'] as string,
          nonce: 'release-after-invalid-verify',
        },
        buyer,
      ),
    ).rejects.toThrow('not settlement-eligible');

    expect(verified['status']).toBe('rejected');
    expect(economic.getExtendedEscrow(locked['escrow_id'] as string)?.status).toBe('funded');
    expect(economic.getEscrowHolding(locked['escrow_id'] as string)?.fundsState).toBe('held');
  });

  it('open_dispute moves a funded escrow into disputed state', async () => {
    const { economic, mcp } = makeServer();
    const buyer = makeGenericAgent({
      agentId: 'agent_buyer',
      capability: 'agentDiscovery',
    });
    const seller = makeGenericAgent({
      agentId: 'agent_seller',
      capability: 'implementation',
    });

    await registerSignedAgent(mcp, buyer, 'register-buyer');
    await registerSignedAgent(mcp, seller, 'register-seller');

    const locked = await executeToolAs(
      mcp,
      'escrow_lock',
      {
        buyer_agent_id: buyer.card.agent_id,
        beneficiary_agent_id: seller.card.agent_id,
        amount_usd_cents: 7_500,
        contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
        completion_criteria: 'Deliver the agreed report',
        workflow_class: 'service_delivery',
        output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
        nonce: 'escrow-lock-dispute',
        spec_version: WORLD_SPEC_VERSION,
      },
      buyer,
    ) as Record<string, unknown>;

    const dispute = await executeToolAs(
      mcp,
      'open_dispute',
      {
        escrow_id: locked['escrow_id'] as string,
        claimant_agent_id: buyer.card.agent_id,
        reason: 'Deliverable failed verification',
        nonce: 'open-dispute-001',
        spec_version: WORLD_SPEC_VERSION,
      },
      buyer,
    ) as Record<string, unknown>;

    expect(dispute['status']).toBe('open');
    expect(dispute['dispute_record_type']).toBe('disputeRecord');
    expect(economic.getExtendedEscrow(locked['escrow_id'] as string)?.status).toBe('disputed');
    expect(economic.getEscrowHolding(locked['escrow_id'] as string)?.fundsState).toBe('held');
  });

  it('every state-changing MCP surface declares a replay-safe nonce and auth field where required', () => {
    const { mcp } = makeServer();
    const tools = new Map(
      mcp.listTools().map((tool) => [tool.name, tool]),
    );
    const mutatingToolNames = [
      'pay',
      'invoice',
      'escrow',
      'create_escrow',
      'fund_escrow',
      'release_escrow',
      'refund_escrow',
      'post_bond',
      'claim_bond',
      'agent_register',
      'operator_intake_record',
      'escrow_lock',
      'bond_post',
      'output_contract_register',
      'contract_verify',
      'open_dispute',
    ];

    for (const name of mutatingToolNames) {
      const tool = tools.get(name);
      expect(tool, `Missing tool schema for ${name}`).toBeTruthy();

      const required = (tool!.inputSchema.required ?? []) as string[];
      const properties = (tool!.inputSchema.properties ?? {}) as Record<string, unknown>;

      expect(
        required.includes('nonce') || required.includes('idempotencyKey'),
        `${name} must require nonce or idempotencyKey`,
      ).toBe(true);
      expect(
        'nonce' in properties || 'idempotencyKey' in properties,
        `${name} must declare nonce or idempotencyKey in its schema`,
      ).toBe(true);

      if (name !== 'agent_register') {
        expect(required.includes('auth'), `${name} must require auth`).toBe(true);
        expect('auth' in properties, `${name} must declare auth`).toBe(true);
      }
    }
  });

  it('bond_post updates the canonical reputation view with active bond capacity', async () => {
    const { mcp } = makeServer();
    const routerAgent = makeGenericAgent({
      agentId: 'agent_router_v1',
      capability: 'settlementRouting',
      contractName: 'settlement_router',
      inputType: 'intent',
      outputType: 'revenueSignal',
      escrowRequired: false,
    });

    await registerSignedAgent(mcp, routerAgent, 'register-router');

    await executeToolAs(
      mcp,
      'bond_post',
      {
        agent_id: routerAgent.card.agent_id,
        amount_usd_cents: 20_000,
        scope: 'financial_transaction_routing',
        claim_conditions: 'Misrouted funds or failed settlement',
        duration_hours: 24,
        nonce: 'bond-post-001',
        spec_version: WORLD_SPEC_VERSION,
      },
      routerAgent,
    );

    const score = await mcp.executeTool('reputation_score', {
      agent_id: routerAgent.card.agent_id,
      spec_version: WORLD_SPEC_VERSION,
    }) as Record<string, unknown>;

    expect(score['agent_id']).toBe('agent_router_v1');
    expect(Number(score['bond_capacity_usd_cents'])).toBeGreaterThanOrEqual(20_000);
    expect(Number(score['reputation_score'])).toBeGreaterThanOrEqual(0);
  });

  it('output_contract_register only accepts authorized agents', async () => {
    const { mcp } = makeServer();
    const governanceAgent = makeGenericAgent({
      agentId: 'governance_auditor_v1',
      capability: 'governanceAudit',
      contractName: 'governance_review',
      inputType: 'intent',
      outputType: 'structuredDeliverable',
      escrowRequired: false,
    });
    const implementationAgent = makeGenericAgent({
      agentId: 'implementation_agent_v1',
      capability: 'implementation',
      contractName: 'implementation_delivery',
      inputType: 'productSpec',
      outputType: 'implementedSystem',
      escrowRequired: false,
    });

    await registerSignedAgent(mcp, governanceAgent, 'register-governance');
    await registerSignedAgent(mcp, implementationAgent, 'register-implementation');

    const customContract = buildCustomOutputContract(
      'custom_due_diligence_brief_v1',
      'custom_due_diligence_brief',
    );

    await expect(
      executeToolAs(
        mcp,
        'output_contract_register',
        {
          output_contract: customContract,
          nonce: 'register-custom-contract-implementation',
          spec_version: WORLD_SPEC_VERSION,
        },
        implementationAgent,
      ),
    ).rejects.toThrow('is not allowed to register trusted output contracts');

    const registered = await executeToolAs(
      mcp,
      'output_contract_register',
      {
        output_contract: customContract,
        nonce: 'register-custom-contract-governance',
        spec_version: WORLD_SPEC_VERSION,
      },
      governanceAgent,
    ) as Record<string, unknown>;

    expect(registered['registration_status']).toBe('registered');
    expect(registered['content_sha256']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('contract_verify rejects an output contract payload that does not match the pinned trusted hash', async () => {
    const { mcp } = makeServer();
    const relayOperator = issueFromReference(CLAWCOMBINATOR_RELAY_OPERATOR_AGENT_CARD);

    await registerSignedAgent(mcp, relayOperator, 'register-relay-operator');

    const tamperedContract = structuredClone(CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT);
    tamperedContract.deliverable_schema = {
      type: 'object',
      required: ['intake_id', 'tampered_field'],
      properties: {
        intake_id: { type: 'string' },
        tampered_field: { type: 'string' },
      },
      additionalProperties: false,
    };

    await expect(
      executeToolAs(
        mcp,
        'contract_verify',
        {
          contract_name: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.name,
          subject_type: 'structuredDeliverable',
          subject_ref: 'intake:sample:email',
          verification_tier: 'replayableTest',
          output_contract_ref: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.contract_id,
          output_contract: tamperedContract,
          subject_payload: CLAWCOMBINATOR_SAMPLE_INBOUND_TRIAGE_DELIVERABLE,
          nonce: 'verify-intake-tampered-contract-001',
          spec_version: WORLD_SPEC_VERSION,
        },
        relayOperator,
      ),
    ).rejects.toThrow('content hash does not match trusted hash');
  });

  it('open_dispute rejects claimant_agent_id that does not match the signed actor', async () => {
    const { mcp } = makeServer();
    const buyer = makeGenericAgent({
      agentId: 'agent_buyer',
      capability: 'agentDiscovery',
    });
    const seller = makeGenericAgent({
      agentId: 'agent_seller',
      capability: 'implementation',
    });

    await registerSignedAgent(mcp, buyer, 'register-buyer');
    await registerSignedAgent(mcp, seller, 'register-seller');

    const locked = await executeToolAs(
      mcp,
      'escrow_lock',
      {
        buyer_agent_id: buyer.card.agent_id,
        beneficiary_agent_id: seller.card.agent_id,
        amount_usd_cents: 7_500,
        contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
        completion_criteria: 'Deliver the agreed report',
        workflow_class: 'service_delivery',
        output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
        nonce: 'escrow-lock-claimant-mismatch',
        spec_version: WORLD_SPEC_VERSION,
      },
      buyer,
    ) as Record<string, unknown>;

    await expect(
      executeToolAs(
        mcp,
        'open_dispute',
        {
          escrow_id: locked['escrow_id'] as string,
          claimant_agent_id: 'another_agent',
          reason: 'Claimant mismatch test',
          nonce: 'open-dispute-claimant-mismatch',
          spec_version: WORLD_SPEC_VERSION,
        },
        buyer,
      ),
    ).rejects.toThrow('claimant_agent_id');
  });

  it('rejects an invalid signed mutation request before state changes occur', async () => {
    const { mcp } = makeServer();
    const buyer = makeGenericAgent({
      agentId: 'agent_buyer',
      capability: 'agentDiscovery',
    });
    const seller = makeGenericAgent({
      agentId: 'agent_seller',
      capability: 'implementation',
    });

    await registerSignedAgent(mcp, buyer, 'register-buyer');
    await registerSignedAgent(mcp, seller, 'register-seller');

    const args = {
      buyer_agent_id: buyer.card.agent_id,
      beneficiary_agent_id: seller.card.agent_id,
      amount_usd_cents: 7_500,
      contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
      completion_criteria: 'Tamper test',
      workflow_class: 'service_delivery',
      output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
      nonce: 'escrow-lock-invalid-auth',
      spec_version: WORLD_SPEC_VERSION,
    };
    const request = signedArgs('escrow_lock', args, buyer);
    const auth = request['auth'] as Record<string, unknown>;
    auth['signature'] = String(auth['signature']).slice(0, -4) + 'abcd';

    await expect(
      mcp.executeTool('escrow_lock', request),
    ).rejects.toThrow('Invalid signed mutation request');
  });
});
