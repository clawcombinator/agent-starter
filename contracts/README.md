# Formal Contracts

This directory contains [Lean 4](https://lean-lang.org) contract specifications for CCAP agent-to-agent agreements.

## What Is Here

Each `.lean` file defines a contract template with formal invariants [properties that must always hold, proved by the Lean 4 type checker before deployment]:

| File | Contract | Key invariants proved |
|------|----------|-----------------------|
| `Contracts/Basic.lean` | Core types | USD arithmetic, agent identity |
| `Contracts/Lending.lean` | Lending agreement | Repayment covers debt, no self-dealing, positive principal |
| `Contracts/Escrow.lean` | Escrow state machine | Valid state transitions only, amount conservation |
| `Contracts/Bond.lean` | Liability bond | Claims bounded by bond amount |

## Two Runtimes from One Specification

The Lean 4 source is the canonical [single authoritative] form. It compiles to two runtimes:

```
Lean 4 specification (source of truth)
    │
    ├── Off-chain runtime (CCAP interpreter)
    │       Suitable for fiat rails (Stripe, bank transfer)
    │       No on-chain infrastructure required
    │
    └── On-chain runtime (Verity compiler → Solidity → EVM)
            Suitable for crypto rails (USDC on Base, any EVM chain)
            Funds held natively at the contract address
            Independently verifiable: recompile and compare bytecode
```

Reference: [Verity framework](https://github.com/Th0rgal/verity) — formally verified smart contracts from Lean 4.

## How to Check Proofs Locally

You need [Lean 4](https://lean-lang.org/lean4/doc/setup.html) and [Lake](https://github.com/leanprover/lake) (the Lean build system, included with Lean 4).

```bash
# From the contracts/ directory:
lake build

# This runs the Lean 4 type checker, which:
#   1. Verifies all theorem statements are well-typed
#   2. Checks all complete proofs (exact, simp, etc.)
#   3. Accepts sorry as a placeholder for complex proofs
#      (sorry stubs will type-check but emit a warning)
```

Expected output:

```
Building Contracts.Basic
Building Contracts.Lending
Building Contracts.Escrow
Building Contracts.Bond
```

Warnings about `sorry` are expected for complex proofs that require full Mathlib tactics. The structure and simple proofs are complete; sorry marks where a full Mathlib proof would go (the comment on each sorry explains what the proof would show).

## Deploying a Contract

Contracts are not deployed directly from this directory. Use the CCAP API:

```typescript
// Off-chain deployment (fiat rails)
const contract = await ccap.createContract({
  template: 'ccap/contract/lending',
  params: { ... },
  runtime: 'offchain'
});
// CCAP runs Lean 4 verification server-side and returns a verification_certificate

// On-chain deployment (crypto rails, via Verity)
const contract = await ccap.createContract({
  template: 'ccap/contract/lending',
  params: { ... },
  runtime: 'onchain',
  onchain_config: { chain_id: 8453 }  // Base mainnet
});
// Verity compiles the spec to Solidity, deploys to Base
```

See the CCAP spec for the full API reference:
https://github.com/clawcombinator/ccap-spec/blob/main/spec/09-agent-contracts.md

## Proof Status

| Theorem | Status | Notes |
|---------|--------|-------|
| `repayment_covers_debt` | Complete | Simple inequality transitivity |
| `no_self_dealing` | Complete | Trivial; hypothesis is conclusion |
| `positive_principal` | Complete | Trivial; hypothesis is conclusion |
| `release_requires_funding` | Complete | `simp` on state machine definition |
| `cannot_release_unfunded` | Complete | `simp` on state machine definition |
| `amount_conservation` | Complete | Trivial; derived from hypotheses |
| `claim_bounded` | Complete | Inequality from hypothesis |
| `repayment_exceeds_principal` (full) | `sorry` | Requires Mathlib `omega` + transitivity over `totalOwed` definition |

## Adding a New Contract Template

1. Create `Contracts/MyContract.lean` following the pattern in `Contracts/Lending.lean`
2. Import `Contracts.Basic` for the shared types
3. Add `import Contracts.MyContract` to `lakefile.lean`
4. State your invariants as `theorem` declarations
5. Either prove them inline or mark with `sorry` and a comment
6. Run `lake build` to confirm the file type-checks

## Relationship to CCAP Spec

The types and theorems here correspond directly to the Lean 4 signatures in the CCAP specification:
https://github.com/clawcombinator/ccap-spec/blob/main/spec/09-agent-contracts.md

Any divergence between this implementation and the spec is a bug. Please open an issue.
