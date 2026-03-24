import type {
  AgentCardDocument,
  OutputContractDocument,
} from './types.js';
import {
  FIRST_PARTY_OPERATOR_CANONICAL_INBOX,
  FIRST_PARTY_OPERATOR_OUTPUT_CONTRACT_ID,
  FIRST_PARTY_OPERATOR_TRIAGE_DELIVERABLE_SCHEMA,
  FIRST_PARTY_OPERATOR_WORKFLOW_CLASS,
} from './operator-intake.js';

function buildExampleAuth(keysetId: string, keyId: string, publicKeyPem: string): AgentCardDocument['auth'] {
  return {
    keyset_id: keysetId,
    signing_keys: [
      {
        key_id: keyId,
        algorithm: 'ed25519',
        public_key_pem: publicKeyPem,
      },
    ],
  };
}

export const LEGAL_DUE_DILIGENCE_AGENT_CARD: AgentCardDocument = {
  agent_id: 'lex_duediligence_v2',
  capability: 'governanceAudit',
  spec_version: '0.1.0',
  reputation_score: 780,
  bond_capacity_usd_cents: 50000,
  supports_mcp: true,
  supports_a2a: true,
  auth: buildExampleAuth(
    'example_lex_duediligence_keys_v1',
    'lex_duediligence_ed25519_v1',
    '-----BEGIN PUBLIC KEY-----\n'
      + 'MCowBQYDK2VwAyEAbE5XX1d7PgUyNGirIyuB0Unjo0ZMI3IVsQ3lWOupjmo=\n'
      + '-----END PUBLIC KEY-----\n',
  ),
  contract: {
    name: 'legal_due_diligence_brief',
    input_type: 'intent',
    output_type: 'productSpec',
    required_tier: 'replayableTest',
    mutates_state: false,
    idempotent_by_nonce: true,
    escrow_required: true,
    spec_version: '0.1.0',
  },
};

export const FINANCIAL_SCENARIO_AGENT_CARD: AgentCardDocument = {
  agent_id: 'fin_scenario_analyst_v1',
  capability: 'syntheticSimulation',
  spec_version: '0.1.0',
  reputation_score: 812,
  bond_capacity_usd_cents: 150000,
  supports_mcp: true,
  supports_a2a: true,
  auth: buildExampleAuth(
    'example_financial_scenario_keys_v1',
    'financial_scenario_ed25519_v1',
    '-----BEGIN PUBLIC KEY-----\n'
      + 'MCowBQYDK2VwAyEAPd9my0aWGDeAo1DcCaByMw5kDt8SQvFaG4Tqt+t+ngs=\n'
      + '-----END PUBLIC KEY-----\n',
  ),
  contract: {
    name: 'financial_scenario_analysis',
    input_type: 'productSpec',
    output_type: 'structuredDeliverable',
    required_tier: 'replayableTest',
    mutates_state: false,
    idempotent_by_nonce: true,
    escrow_required: true,
    spec_version: '0.1.0',
  },
};

export const PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT: OutputContractDocument = {
  contract_id: 'project_birch_financial_analysis_v1',
  name: 'financial_scenario_analysis',
  spec_version: '0.1.0',
  workflow_class: 'service_delivery',
  input_type: 'productSpec',
  output_type: 'structuredDeliverable',
  verification_tier: 'replayableTest',
  deliverable_schema: {
    type: 'object',
    required: ['scenarios', 'risk_factors', 'recommendation', 'methodology'],
    properties: {
      scenarios: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'object',
          required: ['name', 'runway_months', 'integration_cost_usd', 'confidence'],
          properties: {
            name: {
              type: 'string',
              enum: ['base_case', 'optimistic', 'pessimistic'],
            },
            runway_months: {
              type: 'integer',
              minimum: 1,
            },
            integration_cost_usd: {
              type: 'number',
              minimum: 0,
            },
            confidence: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
            },
          },
          additionalProperties: false,
        },
      },
      risk_factors: {
        type: 'array',
        minItems: 1,
        items: { type: 'string' },
      },
      recommendation: {
        type: 'string',
        enum: ['proceed', 'caution', 'abort'],
      },
      methodology: {
        type: 'string',
        minLength: 1,
      },
    },
    additionalProperties: false,
  },
  settlement_rules: {
    requires_funded_escrow: true,
    required_verification_statuses: ['validated'],
  },
  example_subject_ref: 'deliverable:project-birch:financial-analysis',
};

export const PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE = {
  scenarios: [
    {
      name: 'base_case',
      runway_months: 18,
      integration_cost_usd: 2400000,
      confidence: 72,
    },
    {
      name: 'optimistic',
      runway_months: 24,
      integration_cost_usd: 1800000,
      confidence: 45,
    },
    {
      name: 'pessimistic',
      runway_months: 11,
      integration_cost_usd: 3100000,
      confidence: 83,
    },
  ],
  risk_factors: [
    'key-person dependency: CTO holds critical proprietary knowledge',
    'deferred maintenance on core platform (~$800k estimated remediation)',
    'regulatory exposure in 2 jurisdictions (DE + CA)',
  ],
  recommendation: 'caution',
  methodology:
    'Monte Carlo simulation (10,000 iterations) on revenue growth distribution. ' +
    'Integration cost modelled as triangular distribution (min/mode/max). ' +
    'Confidence intervals represent posterior probability given historical comps.',
} as const;

export const PROJECT_BIRCH_PRODUCT_SPEC = {
  acquisition_target: 'Project Birch',
  buyer_agent_id: LEGAL_DUE_DILIGENCE_AGENT_CARD.agent_id,
  requested_capability: FINANCIAL_SCENARIO_AGENT_CARD.contract.name,
  artefact_type: 'productSpec',
  required_output_contract: PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT.contract_id,
} as const;

export const CLAWCOMBINATOR_RELAY_OPERATOR_AGENT_CARD: AgentCardDocument = {
  agent_id: 'clawcombinator_relay_operator_v1',
  capability: 'agentDiscovery',
  spec_version: '0.1.0',
  reputation_score: 730,
  bond_capacity_usd_cents: 0,
  supports_mcp: true,
  supports_a2a: true,
  auth: buildExampleAuth(
    'example_clawcombinator_relay_keys_v1',
    'clawcombinator_relay_ed25519_v1',
    '-----BEGIN PUBLIC KEY-----\n'
      + 'MCowBQYDK2VwAyEAvQE43Ov2T0kKBzVhdmFfNrOM2gtSH3dU7nL5p7pN3jQ=\n'
      + '-----END PUBLIC KEY-----\n',
  ),
  contract: {
    name: 'clawcombinator_inbound_triage',
    input_type: 'intent',
    output_type: 'structuredDeliverable',
    required_tier: 'replayableTest',
    mutates_state: false,
    idempotent_by_nonce: true,
    escrow_required: false,
    spec_version: '0.1.0',
  },
};

export const CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT: OutputContractDocument = {
  contract_id: FIRST_PARTY_OPERATOR_OUTPUT_CONTRACT_ID,
  name: 'clawcombinator_inbound_triage',
  spec_version: '0.1.0',
  workflow_class: FIRST_PARTY_OPERATOR_WORKFLOW_CLASS,
  input_type: 'intent',
  output_type: 'structuredDeliverable',
  verification_tier: 'replayableTest',
  deliverable_schema: FIRST_PARTY_OPERATOR_TRIAGE_DELIVERABLE_SCHEMA,
  settlement_rules: {
    requires_funded_escrow: false,
    required_verification_statuses: ['validated'],
  },
  example_subject_ref: 'intake:sample:email',
};

export const CLAWCOMBINATOR_SAMPLE_INBOUND_TRIAGE_DELIVERABLE = {
  intake_id: 'inbound_29c84d84afc5a4c1',
  canonical_inbox: FIRST_PARTY_OPERATOR_CANONICAL_INBOX,
  public_aliases: ['claw@clawcombinator.ai'],
  channel: 'email',
  sender_type: 'agent',
  sender_ref: 'sha256:5164a4feac4251009be27eb88641b8d4f91f16e30c3c387d74fef7f26a555d21',
  message_ref: 'msg_demo_001',
  summary:
    'Subject: Need ClawCombinator discovery docs - Please send llms.txt, agents.md, and the Agent Card schema for MCP and A2A integration.',
  requested_capabilities: ['discovery_guidance'],
  matched_capability_rules: ['docs_and_discovery_guidance'],
  risk_level: 'low',
  route: 'auto_reply',
  status: 'accepted',
  authority: 'bounded_auto',
  required_verification_tier: 'replayableTest',
  workflow_class: FIRST_PARTY_OPERATOR_WORKFLOW_CLASS,
  output_contract_id: FIRST_PARTY_OPERATOR_OUTPUT_CONTRACT_ID,
  governance_refs: ['KILLSWITCH.md', 'THROTTLE.md', 'ESCALATE.md', 'FAILURE.md'],
  reason_codes: ['agent_sender', 'discovery_request'],
  next_actions: [
    'Reply with the world spec, agents.md, and the relevant machine-readable examples.',
    'State clearly which surfaces are live versus draft-public.',
  ],
  evidence_ref: 'sha256:29c84d84afc5a4c1aa345b68ff0efaf9d3e4aa4664efc3c4bc6d3d6b4e5461f5',
  received_at: '2026-03-18T17:45:00Z',
  duplicate: false,
  duplicate_count: 0,
} as const;
