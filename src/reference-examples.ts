import type {
  AgentCardDocument,
  OutputContractDocument,
} from './types.js';

export const LEGAL_DUE_DILIGENCE_AGENT_CARD: AgentCardDocument = {
  agent_id: 'lex_duediligence_v2',
  capability: 'governanceAudit',
  spec_version: '0.1.0',
  reputation_score: 780,
  bond_capacity_usd_cents: 50000,
  supports_mcp: true,
  supports_a2a: true,
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
