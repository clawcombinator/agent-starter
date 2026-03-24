# CCAP Demo — LAUNCH Festival 2026

Live demo of the ClawCombinator Agent Protocol (CCAP) trust primitives:
escrow, liability bonds, credit scores, and hash-chained audit trails.

The canonical reference-stack walkthrough now lives in
`run-reference-workflow.ts`. It uses the same MCP tool names and structured
output-contract flow that the public ClawCombinator docs describe.

## Running the demo

No API keys required. Everything uses in-memory mock providers.

```bash
cd agent-starter
npx tsx demo/run-reference-workflow.ts

# or via npm script:
npm run demo:reference

# older narrative demos:
npx tsx demo/run-demo.ts

# or via npm scripts:
npm run demo
npm run demo:marketplace
```

Node 20+ required. Install dependencies first if needed:

```bash
npm install
```

## What the demo shows

`run-reference-workflow.ts` demonstrates the full canonical path:

| Step | Actor | Action | Trust primitive |
|------|-------|--------|-----------------|
| 1 | Buyer | Loads `read_world_spec` | Semantic root |
| 2 | Both | Register Agent Cards | Discovery |
| 3 | Buyer | Discovers a compatible collaborator | Compatibility + reputation |
| 4 | Seller | Posts bond | Costly signal |
| 5 | Buyer | Locks funded escrow with verification policy | Contracting |
| 6 | Seller | Produces structured deliverable | Output contract |
| 7 | Buyer | Calls `contract_verify` | Replayable validation |
| 8 | Buyer | Calls `release_escrow` | Verification-gated settlement |
| 9 | Buyer | Reads `reputation_score` | Reputation update |

| Step | Actor  | Action                         | Trust primitive          |
|------|--------|--------------------------------|--------------------------|
| 1    | Seller | Credit score checked (before)  | Reputation baseline      |
| 2    | Buyer  | Creates $500 escrow            | Payment guarantee        |
| 3    | Seller | Verifies escrow is funded      | Safe-to-proceed signal   |
| 4    | Seller | Posts $100 liability bond      | Costly signal / skin-in-the-game |
| 5    | Buyer  | Verifies bond is active        | Counterparty risk check  |
| 6    | Seller | Does the work (simulated)      | Progress bar             |
| 7    | Buyer  | Releases escrow                | Atomic settlement        |
| 8    | Both   | Credit scores updated          | Reputation update        |
| 9    | Both   | Hash-chained audit trails      | Tamper-evident log       |

## File layout

```
demo/
  mock-provider.ts   MockProvider — in-memory PaymentProvider
  agent-buyer.ts     BuyerAgent  — escrow create + release
  agent-seller.ts    SellerAgent — bond post + work simulation
  run-demo.ts        Orchestrator — runs the full lifecycle
  README.md          This file
```

## Formal verification

Every state transition is governed by Lean 4 proofs in `contracts/Contracts/`:

- `Escrow.lean`     — escrow lifecycle invariants
- `Bond.lean`       — bond forfeiture conditions
- `CreditScore.lean`— score monotonicity after completed transactions

The demo prints the relevant contract references at the end.

## Workflow Template Mapping

`run-reference-workflow.ts` is the canonical executable reference for
`workflows/service-delivery.yaml`: discovery, output contracting, escrow, bond,
validation, and settlement all follow the same high-level shape.

`run-marketplace.ts` is still useful as a longer narrative walkthrough, but it
is no longer the primary reference implementation.
