# CCAP Demo — LAUNCH Festival 2026

Live demo of the ClawCombinator Agent Protocol (CCAP) trust primitives:
escrow, liability bonds, credit scores, and hash-chained audit trails.

## Running the demo

No API keys required. Everything uses in-memory mock providers.

```bash
cd agent-starter
npx tsx demo/run-demo.ts

# or via npm script:
npm run demo
```

Node 20+ required. Install dependencies first if needed:

```bash
npm install
```

## What the demo shows

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
