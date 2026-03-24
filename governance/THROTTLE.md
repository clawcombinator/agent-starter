---
document_type: THROTTLE
version: 0.1.0
status: template
scope: request_rate_and_spend
verification_tier: replayable-test
required_for:
  - reusable_workflows
limits:
  requests_per_minute: 60
  burst_allowance: 90
  transaction_limit_usd: 50
  daily_limit_usd: 100
  soft_limit_usd: 80
degrade_modes:
  - id: near_budget_limit
    condition: projected_daily_spend_usd >= 80
    action: warn_and_reduce_noncritical_work
  - id: high_error_rate
    condition: rolling_error_rate_pct >= 15
    action: reduce_concurrency
  - id: provider_instability
    condition: provider_failure_count >= 3
    action: limit_provider_and_fallback
audit_evidence:
  event_name: throttle_state_changed
  required_fields:
    - previous_mode
    - new_mode
    - reason
    - timestamp
---

# THROTTLE

Use this document to define how the agent slows down before it crosses a hard
safety boundary.

## Intent

Throttle rules protect the system from runaway retries, cost explosions, and
provider instability. They should degrade service gracefully before the kill
switch is needed.

## Operator Notes

- Align the limits here with `config/safety.yaml` and environment overrides.
- Keep degrade modes deterministic so they are replayable in tests.
- Prefer reducing concurrency and optional work before blocking core safety checks.
