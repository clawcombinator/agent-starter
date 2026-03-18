// ============================================================
// Tests for the MCP server reference-stack tools.
//
// These cover:
//   - world-spec access
//   - local agent registration and discovery
//   - replay-safe escrow locking
//   - proof/replay verification helpers
//   - dispute opening
//   - bond posting and reputation view
//   - mutation-surface idempotency policy
// ============================================================

import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AuditLogger } from '../src/audit.js';
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
import type { Balance, PaymentParams, PaymentProvider, PaymentResult } from '../src/providers/types.js';
import type { SafetyConfig } from '../src/types.js';

function tempLogPath(): string {
  return path.join(os.tmpdir(), `mcp_test_${crypto.randomBytes(4).toString('hex')}.jsonl`);
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

function makeServer() {
  const audit = new AuditLogger(tempLogPath());
  const safety = new SafetyMonitor(makeConfig(), audit);
  const router = new PaymentRouter(safety, audit);
  const provider = makeMockProvider();
  router.registerProvider(provider);
  const economic = new CCAPEconomic(router, safety, audit);
  const mcp = new AgentMCPServer(safety, audit, economic, router);

  return { audit, economic, mcp, provider };
}

describe('AgentMCPServer reference-stack tools', () => {
  it('read_world_spec returns published URLs and the local Lean source path', async () => {
    const { mcp } = makeServer();

    const result = await mcp.executeTool('read_world_spec', {
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    expect(result['spec_version']).toBe('0.1.0');
    expect(result['world_spec_url']).toBe('https://clawcombinator.ai/formal/category_spec.lean');
    expect(result['invariants_url']).toBe('https://clawcombinator.ai/feeds/invariants.json');
    expect(String(result['world_spec_path'])).toContain('contracts/Contracts/CategorySpec.lean');
    expect(typeof result['content_sha256']).toBe('string');
  });

  it('agent_register stores an Agent Card that agent_discover can query', async () => {
    const { mcp } = makeServer();

    await mcp.executeTool('agent_register', {
      agent_card: {
        agent_id: 'market_scan_v1',
        capability: 'marketScanning',
        spec_version: '0.1.0',
        reputation_score: 712,
        bond_capacity_usd_cents: 250000,
        supports_mcp: true,
        supports_a2a: true,
        contract: {
          name: 'market_scan_contract',
          input_type: 'intent',
          output_type: 'marketSignal',
          required_tier: 'replayableTest',
          mutates_state: false,
          idempotent_by_nonce: true,
          escrow_required: true,
          spec_version: '0.1.0',
        },
      },
      signature: 'sig_market_scan_v1',
      nonce: 'register-market-scan',
      spec_version: '0.1.0',
    });

    const result = await mcp.executeTool('agent_discover', {
      capability: 'marketScanning',
      spec_version: '0.1.0',
    }) as { results: Array<Record<string, unknown>> };

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
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    expect(result['canonical_inbox']).toBe('relay@clawcombinator.ai');
    expect(result['public_aliases']).toEqual(['claw@clawcombinator.ai']);

    const recommended = result['recommended_openclaw'] as Record<string, unknown>;
    expect(recommended['dm_policy']).toBe('pairing');
    expect(recommended['hook_session_key_template']).toBe('hook:gmail:{{messages[0].id}}');
  });

  it('operator_intake_record emits a replayable deliverable that contract_verify accepts', async () => {
    const { mcp } = makeServer();

    await mcp.executeTool('agent_register', {
      agent_card: CLAWCOMBINATOR_RELAY_OPERATOR_AGENT_CARD,
      signature: 'sig_relay_operator',
      nonce: 'register-relay-operator',
      spec_version: '0.1.0',
    });

    const triaged = await mcp.executeTool('operator_intake_record', {
      channel: 'email',
      sender_id: 'agent@example.ai',
      sender_type: 'agent',
      subject: 'Need ClawCombinator discovery docs',
      text: 'Please send llms.txt, agents.md, and the Agent Card schema for MCP and A2A integration.',
      message_id: 'msg_operator_001',
      nonce: 'operator-intake-001',
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    expect(triaged['route']).toBe('auto_reply');
    expect(triaged['risk_level']).toBe('low');
    expect(triaged['output_contract_id']).toBe(CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.contract_id);

    const verified = await mcp.executeTool('contract_verify', {
      contract_name: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.name,
      subject_type: 'structuredDeliverable',
      subject_ref: `intake:${triaged['intake_id'] as string}`,
      verification_tier: 'replayableTest',
      output_contract_ref: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.contract_id,
      output_contract: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT,
      subject_payload: triaged,
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    expect(verified['status']).toBe('validated');
    expect(verified['evidence_ref']).toMatch(/^sha256:/);
  });

  it('escrow_lock creates a funded escrow and replays safely for the same nonce', async () => {
    const { economic, mcp, provider } = makeServer();
    const args = {
      buyer_agent_id: 'agent_buyer',
      beneficiary_agent_id: 'agent_seller',
      amount_usd_cents: 12500,
      contract_name: 'service_delivery',
      completion_criteria: 'Deliver the agreed analysis bundle',
      nonce: 'escrow-lock-001',
      spec_version: '0.1.0',
    };

    const first = await mcp.executeTool('escrow_lock', args) as Record<string, unknown>;
    const second = await mcp.executeTool('escrow_lock', args) as Record<string, unknown>;
    const escrowId = first['escrow_id'] as string;

    expect(first['status']).toBe('funded');
    expect(first['funded']).toBe(true);
    expect(second['escrow_id']).toBe(escrowId);
    expect(provider.pay).toHaveBeenCalledOnce();
    expect(economic.getExtendedEscrow(escrowId)?.status).toBe('funded');
    expect(first['verification_tier']).toBe('replayableTest');
  });

  it('escrow_lock rejects reuse of a nonce with a different payload', async () => {
    const { mcp } = makeServer();

    await mcp.executeTool('escrow_lock', {
      buyer_agent_id: 'agent_buyer',
      beneficiary_agent_id: 'agent_seller',
      amount_usd_cents: 10000,
      contract_name: 'service_delivery',
      completion_criteria: 'Initial payload',
      nonce: 'escrow-lock-conflict',
      spec_version: '0.1.0',
    });

    await expect(
      mcp.executeTool('escrow_lock', {
        buyer_agent_id: 'agent_buyer',
        beneficiary_agent_id: 'agent_seller',
        amount_usd_cents: 11000,
        contract_name: 'service_delivery',
        completion_criteria: 'Changed payload',
        nonce: 'escrow-lock-conflict',
        spec_version: '0.1.0',
      }),
    ).rejects.toThrow('Nonce replay mismatch');
  });

  it('contract_verify returns proven for the canonical world spec at proof tier', async () => {
    const { mcp } = makeServer();

    const result = await mcp.executeTool('contract_verify', {
      contract_name: 'category_spec',
      subject_type: 'validationProof',
      subject_ref: 'https://clawcombinator.ai/formal/category_spec.lean',
      verification_tier: 'proof',
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    expect(result['status']).toBe('proven');
    expect(result['evidence_ref']).toBe('https://clawcombinator.ai/formal/category_spec.lean');
  });

  it('contract_verify validates a structured deliverable and unlocks release_escrow', async () => {
    const { economic, mcp } = makeServer();

    await mcp.executeTool('agent_register', {
      agent_card: LEGAL_DUE_DILIGENCE_AGENT_CARD,
      signature: 'sig_lex',
      nonce: 'register-lex',
      spec_version: '0.1.0',
    });
    await mcp.executeTool('agent_register', {
      agent_card: FINANCIAL_SCENARIO_AGENT_CARD,
      signature: 'sig_fin',
      nonce: 'register-fin',
      spec_version: '0.1.0',
    });

    const locked = await mcp.executeTool('escrow_lock', {
      buyer_agent_id: LEGAL_DUE_DILIGENCE_AGENT_CARD.agent_id,
      beneficiary_agent_id: FINANCIAL_SCENARIO_AGENT_CARD.agent_id,
      amount_usd_cents: 12500,
      contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
      completion_criteria: 'Deliver Project Birch financial scenario analysis',
      workflow_class: 'service_delivery',
      verification_tier: 'replayableTest',
      output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
      nonce: 'escrow-lock-structured',
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    await expect(
      mcp.executeTool('release_escrow', {
        escrowId: locked['escrow_id'],
        nonce: 'release-before-verify',
      }),
    ).rejects.toThrow('no verification result recorded');

    const verified = await mcp.executeTool('contract_verify', {
      escrow_id: locked['escrow_id'],
      contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
      subject_type: 'structuredDeliverable',
      subject_ref: 'deliverable:project-birch:financial-analysis',
      verification_tier: 'replayableTest',
      output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
      output_contract: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
      subject_payload: PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    const released = await mcp.executeTool('release_escrow', {
      escrowId: locked['escrow_id'],
      completionEvidence: verified['evidence_ref'],
      nonce: 'release-after-verify',
    }) as Record<string, unknown>;

    expect(verified['status']).toBe('validated');
    expect(verified['evidence_ref']).toMatch(/^sha256:/);
    expect(released['status']).toBe('released');
    expect(economic.getExtendedEscrow(locked['escrow_id'] as string)?.status).toBe('released');
  });

  it('operator intake example remains valid against the canonical intake output contract', async () => {
    const { mcp } = makeServer();

    const verified = await mcp.executeTool('contract_verify', {
      contract_name: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.name,
      subject_type: 'structuredDeliverable',
      subject_ref: 'intake:sample:email',
      verification_tier: 'replayableTest',
      output_contract_ref: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT.contract_id,
      output_contract: CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT,
      subject_payload: CLAWCOMBINATOR_SAMPLE_INBOUND_TRIAGE_DELIVERABLE,
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    expect(verified['status']).toBe('validated');
  });

  it('contract_verify rejects invalid structured deliverables and keeps escrow locked', async () => {
    const { economic, mcp } = makeServer();

    const locked = await mcp.executeTool('escrow_lock', {
      buyer_agent_id: LEGAL_DUE_DILIGENCE_AGENT_CARD.agent_id,
      beneficiary_agent_id: FINANCIAL_SCENARIO_AGENT_CARD.agent_id,
      amount_usd_cents: 12500,
      contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
      completion_criteria: 'Deliver Project Birch financial scenario analysis',
      workflow_class: 'service_delivery',
      output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
      nonce: 'escrow-lock-invalid',
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    const invalidDeliverable = {
      ...PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
      recommendation: 'ship-now',
    };

    const verified = await mcp.executeTool('contract_verify', {
      escrow_id: locked['escrow_id'],
      contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
      subject_type: 'structuredDeliverable',
      subject_ref: 'deliverable:project-birch:financial-analysis',
      verification_tier: 'replayableTest',
      output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
      output_contract: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
      subject_payload: invalidDeliverable,
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    await expect(
      mcp.executeTool('release_escrow', {
        escrowId: locked['escrow_id'],
        completionEvidence: verified['evidence_ref'],
        nonce: 'release-after-invalid-verify',
      }),
    ).rejects.toThrow('not settlement-eligible');

    expect(verified['status']).toBe('rejected');
    expect(economic.getExtendedEscrow(locked['escrow_id'] as string)?.status).toBe('funded');
  });

  it('open_dispute moves a funded escrow into disputed state', async () => {
    const { economic, mcp } = makeServer();
    const locked = await mcp.executeTool('escrow_lock', {
      buyer_agent_id: 'agent_buyer',
      beneficiary_agent_id: 'agent_seller',
      amount_usd_cents: 7500,
      contract_name: 'service_delivery',
      completion_criteria: 'Deliver the agreed report',
      nonce: 'escrow-lock-dispute',
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    const dispute = await mcp.executeTool('open_dispute', {
      escrow_id: locked['escrow_id'],
      claimant_agent_id: 'agent_buyer',
      reason: 'Deliverable failed verification',
      nonce: 'open-dispute-001',
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    expect(dispute['status']).toBe('open');
    expect(dispute['dispute_record_type']).toBe('disputeRecord');
    expect(economic.getExtendedEscrow(locked['escrow_id'] as string)?.status).toBe('disputed');
  });

  it('every state-changing MCP surface declares a replay-safe nonce field', () => {
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
      'escrow_lock',
      'bond_post',
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
    }
  });

  it('bond_post updates the canonical reputation view with active bond capacity', async () => {
    const { mcp } = makeServer();

    await mcp.executeTool('bond_post', {
      agent_id: 'agent_router_v1',
      amount_usd_cents: 20000,
      scope: 'financial_transaction_routing',
      claim_conditions: 'Misrouted funds or failed settlement',
      duration_hours: 24,
      nonce: 'bond-post-001',
      spec_version: '0.1.0',
    });

    const score = await mcp.executeTool('reputation_score', {
      agent_id: 'agent_router_v1',
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

    expect(score['agent_id']).toBe('agent_router_v1');
    expect(Number(score['bond_capacity_usd_cents'])).toBeGreaterThanOrEqual(20000);
    expect(Number(score['reputation_score'])).toBeGreaterThanOrEqual(0);
  });
});
