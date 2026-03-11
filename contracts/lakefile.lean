import Lake
open Lake DSL

package «ccap-contracts» where
  name := "ccap-contracts"
  version := "0.1.0"
  description := "Lean 4 contract specifications for CCAP agent-to-agent agreements"

require mathlib from git
  "https://github.com/leanprover-community/mathlib4.git"

lean_lib «Contracts» where
  -- All contract modules under Contracts/
  roots := #[`Contracts]
