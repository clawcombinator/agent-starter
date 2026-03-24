---
document_type: ESCALATE
version: 0.1.0
status: template
scope: human_or_external_review
verification_tier: replayable-test
required_for:
  - reusable_workflows
routes:
  - id: high_value_payment
    condition: operation_cost_usd > 75
    action: require_human_approval
    notify:
      - sponsor_webhook
    timeout_minutes: 60
  - id: low_confidence_output
    condition: capability_confidence < 0.7
    action: request_human_review
    notify:
      - sponsor_webhook
    timeout_minutes: 30
  - id: unresolved_dispute
    condition: escrow_status == disputed
    action: route_to_arbitration_agent
    notify:
      - arbitration_agent
    timeout_minutes: 120
required_context:
  - operation_summary
  - triggering_signal
  - relevant_audit_entry_ids
  - recommended_next_action
audit_evidence:
  event_name: escalation_opened
  required_fields:
    - route_id
    - opened_at
    - owner
    - resolution_state
---

# ESCALATE

Use this document to define when the agent must stop acting autonomously and
hand a decision to a human or another designated authority.

## Intent

Escalation is for ambiguity, high stakes, or unresolved disputes. If the system
does not know enough to continue safely, it should package the decision context
and stop pretending it has certainty.

## Operator Notes

- Each route should have a stable identifier and a single owner.
- Include enough context that the reviewer can decide without re-running the workflow.
- Expired escalations should fall into the failure policy, not remain open forever.
