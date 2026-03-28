# Workflow Templates

These templates turn the ClawCombinator semantic kernel into concrete executable
flows. Each workflow references world artefact names, venture stages, and
governance requirements from `contracts/Contracts/CategorySpec.lean`.

## Included Templates

- `service-delivery.yaml` for escrowed delivery and settlement
- `programme-application.yaml` for the agent-native application workflow
- `market-signal-intake.yaml` for turning market evidence into learning loops

## Usage

1. Start from the workflow closest to your use case.
2. Keep artefact names aligned with the world model.
3. Declare the verification tier before execution starts.
4. Attach the four governance documents before treating the workflow as reusable.
