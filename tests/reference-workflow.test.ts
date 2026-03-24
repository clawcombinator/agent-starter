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
  FINANCIAL_SCENARIO_AGENT_CARD,
  LEGAL_DUE_DILIGENCE_AGENT_CARD,
  PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
  PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
} from '../src/reference-examples.js';
import type { Balance, PaymentParams, PaymentProvider, PaymentResult } from '../src/providers/types.js';
import type { SafetyConfig } from '../src/types.js';

function tempLogPath(): string {
  return path.join(os.tmpdir(), `reference_workflow_${crypto.randomBytes(4).toString('hex')}.jsonl`);
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
  router.registerProvider(makeMockProvider());
  const economic = new CCAPEconomic(router, safety, audit);
  const mcp = new AgentMCPServer(safety, audit, economic, router);

  return { audit, economic, mcp };
}

describe('reference workflow demo path', () => {
  it('runs discovery to settlement with the canonical MCP tools', async () => {
    const { audit, economic, mcp } = makeServer();

    const worldSpec = await mcp.executeTool('read_world_spec', {
      spec_version: '0.1.0',
    }) as Record<string, unknown>;
    expect(worldSpec['world_spec_url']).toBe('https://clawcombinator.ai/formal/category_spec.lean');

    await mcp.executeTool('agent_register', {
      agent_card: LEGAL_DUE_DILIGENCE_AGENT_CARD,
      signature: 'sig_lex_reference',
      nonce: 'register-lex-reference',
      spec_version: '0.1.0',
    });
    await mcp.executeTool('agent_register', {
      agent_card: FINANCIAL_SCENARIO_AGENT_CARD,
      signature: 'sig_fin_reference',
      nonce: 'register-fin-reference',
      spec_version: '0.1.0',
    });

    const discovered = await mcp.executeTool('agent_discover', {
      capability: 'syntheticSimulation',
      input_type: 'productSpec',
      output_type: 'structuredDeliverable',
      min_reputation_score: 800,
      spec_version: '0.1.0',
    }) as { results: Array<Record<string, unknown>> };

    expect(discovered.results).toHaveLength(1);
    expect(discovered.results[0]!['agent_id']).toBe(FINANCIAL_SCENARIO_AGENT_CARD.agent_id);
    expect(
      ((discovered.results[0]!['compatibility'] as Record<string, unknown>)['matched_fields'] as string[]),
    ).toContain('output_type');

    await mcp.executeTool('bond_post', {
      agent_id: FINANCIAL_SCENARIO_AGENT_CARD.agent_id,
      amount_usd_cents: 15000,
      scope: 'financial_transaction_routing',
      claim_conditions: 'Losses caused by incorrect scenario analysis or failed settlement',
      duration_hours: 24,
      nonce: 'bond-post-reference',
      spec_version: '0.1.0',
    });

    const locked = await mcp.executeTool('escrow_lock', {
      buyer_agent_id: LEGAL_DUE_DILIGENCE_AGENT_CARD.agent_id,
      beneficiary_agent_id: FINANCIAL_SCENARIO_AGENT_CARD.agent_id,
      amount_usd_cents: 7500,
      contract_name: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.name,
      completion_criteria: 'Deliver the Project Birch scenario pack with deterministic validation evidence',
      workflow_class: 'service_delivery',
      verification_tier: 'replayableTest',
      output_contract_ref: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
      nonce: 'escrow-lock-reference',
      spec_version: '0.1.0',
    }) as Record<string, unknown>;

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
      nonce: 'release-reference',
    }) as Record<string, unknown>;

    const score = await mcp.executeTool('reputation_score', {
      agent_id: FINANCIAL_SCENARIO_AGENT_CARD.agent_id,
      spec_version: '0.1.0',
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
