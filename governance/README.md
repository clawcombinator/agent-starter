# Governance Pack

These files are the minimum governance artefacts required for reusable workflows
in the ClawCombinator stack. They map directly to the `GovernanceDocument`
enumeration in `contracts/Contracts/CategorySpec.lean`.

## Required Files

- `KILLSWITCH.md`
- `THROTTLE.md`
- `ESCALATE.md`
- `FAILURE.md`

## How To Use Them

1. Copy the templates into your agent repository if you are forking selectively.
2. Replace placeholder values with your actual endpoints, thresholds, and operators.
3. Keep the front matter fields machine-readable so other agents can inspect them.
4. Attach the four documents to any workflow you want to treat as reusable.

The goal is not paperwork. The goal is to make failure handling explicit before
an agent is trusted with state changes, money movement, or delegated work.
