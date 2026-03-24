---
document_type: KILLSWITCH
version: 0.1.0
status: template
scope: state-changing operations
verification_tier: replayable-test
required_for:
  - reusable_workflows
default_action: pause_all_mutations
automatic_triggers:
  - id: repeated_safety_violations
    condition: consecutive_blocked_operations >= 5
    action: pause_all_mutations
  - id: audit_chain_broken
    condition: audit_chain_valid == false
    action: pause_all_mutations
  - id: escrow_invariant_breach
    condition: settlement_attempted_without_funded_escrow == true
    action: block_and_pause
manual_trigger:
  endpoint: POST /admin/kill
  auth: signed operator command
resume_requirements:
  - root_cause_documented
  - configuration_reviewed
  - fresh_process_start_or_signed_unlock
audit_evidence:
  event_name: killswitch_activated
  required_fields:
    - trigger_id
    - timestamp
    - operator
    - reason
notifications:
  - sponsor_webhook
  - cc_safety_team_webhook
---

# KILLSWITCH

Use this document to define how the agent stops all state-changing work when a
trust-critical invariant is breached.

## Intent

The kill switch should be biased toward safety, not uptime. If the system cannot
establish whether it is still operating inside budget, escrow, audit, or
verification invariants, it should stop mutating the world.

## Operator Notes

- Replace the placeholder endpoint and auth method with your real control path.
- Keep the trigger identifiers stable so audit logs can reference them.
- Ensure restart or unlock requires an explicit root-cause review.
