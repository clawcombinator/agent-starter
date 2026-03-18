import type { VerificationTier } from './types.js';

export interface VerificationPolicyEntry {
  workflow_class: string;
  required_tier: VerificationTier;
  passing_status: 'proven' | 'validated';
  settlement_mode: 'automatic' | 'manual';
  rationale: string;
}

export const VERIFICATION_POLICY: VerificationPolicyEntry[] = [
  {
    workflow_class: 'formal_semantic_kernel',
    required_tier: 'proof',
    passing_status: 'proven',
    settlement_mode: 'manual',
    rationale: 'World-model and invariant claims need proof-level assurance before they are treated as canonical.',
  },
  {
    workflow_class: 'service_delivery',
    required_tier: 'replayableTest',
    passing_status: 'validated',
    settlement_mode: 'automatic',
    rationale: 'Structured service deliverables should settle automatically only after deterministic schema and evidence replay succeeds.',
  },
  {
    workflow_class: 'programme_application',
    required_tier: 'replayableTest',
    passing_status: 'validated',
    settlement_mode: 'manual',
    rationale: 'Applications need deterministic validation, but final programme acceptance remains operator-mediated.',
  },
  {
    workflow_class: 'governance_dispute',
    required_tier: 'quorum',
    passing_status: 'validated',
    settlement_mode: 'manual',
    rationale: 'Dispute handling should rely on bounded consensus from independent reviewers rather than a single automated judge.',
  },
  {
    workflow_class: 'first_party_operator_intake',
    required_tier: 'replayableTest',
    passing_status: 'validated',
    settlement_mode: 'manual',
    rationale: 'Inbound triage should be replayable and auditable, but any external commitment or privileged action still requires human review.',
  },
];

export function getVerificationPolicy(
  workflowClass: string,
): VerificationPolicyEntry | undefined {
  return VERIFICATION_POLICY.find((entry) => entry.workflow_class === workflowClass);
}
