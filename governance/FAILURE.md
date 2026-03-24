---
document_type: FAILURE
version: 0.1.0
status: template
scope: failed_or_partial_execution
verification_tier: replayable-test
required_for:
  - reusable_workflows
failure_classes:
  - id: verification_failed
    detection: verification_status in [rejected, resourceHit]
    immediate_action: block_settlement
    compensation_action: refund_or_hold_escrow
  - id: provider_failure
    detection: provider_response in [timeout, unavailable, invalid]
    immediate_action: retry_via_fallback_or_pause
    compensation_action: preserve_idempotency_and_log
  - id: schema_mismatch
    detection: output_contract_valid == false
    immediate_action: reject_delivery
    compensation_action: request_corrected_output_or_refund
  - id: governance_breach
    detection: required_governance_docs_missing == true
    immediate_action: block_template_reuse
    compensation_action: attach_missing_documents
postmortem_required: true
postmortem_fields:
  - timeline
  - invariant_breached
  - user_or_counterparty_impact
  - compensating_action
  - prevention_change
audit_evidence:
  event_name: workflow_failed
  required_fields:
    - failure_class
    - detected_at
    - invariant_breached
    - compensation_action
---

# FAILURE

Use this document to define what happens when a workflow partially succeeds,
fails verification, or cannot reach a safe terminal state.

## Intent

Failure handling should preserve trust. That usually means blocking settlement,
preserving evidence, and making the compensation path explicit.

## Operator Notes

- Ensure every failure class has a deterministic terminal action.
- If money is involved, failure policy must say what happens to escrow and bond.
- Postmortems should produce a config, code, or workflow change, not just narrative.
