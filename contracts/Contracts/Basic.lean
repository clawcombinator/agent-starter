-- Contracts.Basic
-- Core types shared across all CCAP contract templates.
-- These types correspond directly to the type signatures in spec/09-agent-contracts.md.

import Mathlib.Tactic

-- ---------------------------------------------------------------------------
-- Agent identity
-- ---------------------------------------------------------------------------

/-- A CCAP agent identifier. Wraps a string; equality and hashing are string-based. -/
structure AgentId where
  id : String
  deriving Repr, DecidableEq, Hashable

-- ---------------------------------------------------------------------------
-- USD monetary amounts
-- ---------------------------------------------------------------------------

/-- A USD amount stored as integer cents to avoid floating-point rounding errors.
    $12.50 is represented as ⟨1250⟩. -/
structure USD where
  cents : Nat  -- stored as cents; always non-negative
  deriving Repr, DecidableEq, Ord

instance : Add USD where
  add a b := ⟨a.cents + b.cents⟩

instance : LE USD where
  le a b := a.cents ≤ b.cents

instance : LT USD where
  lt a b := a.cents < b.cents

instance : DecidableEq USD := inferInstance

def USD.zero : USD := ⟨0⟩

def USD.fromDollars (d : Nat) : USD := ⟨d * 100⟩

def USD.fromCents (c : Nat) : USD := ⟨c⟩

def USD.toDollars (u : USD) : Float := Float.ofNat u.cents / 100.0

-- USD addition is commutative and associative (inherits from Nat)
theorem USD.add_comm (a b : USD) : a + b = b + a := by
  simp [HAdd.hAdd, Add.add, Nat.add_comm]

theorem USD.add_zero (a : USD) : a + USD.zero = a := by
  simp [HAdd.hAdd, Add.add, USD.zero]

theorem USD.zero_add (a : USD) : USD.zero + a = a := by
  simp [HAdd.hAdd, Add.add, USD.zero]

-- ---------------------------------------------------------------------------
-- Repayment schedules
-- ---------------------------------------------------------------------------

/-- How a borrower repays a loan. -/
inductive RepaymentSchedule where
  | monthly    -- equal monthly instalments
  | onRevenue  -- automatic percentage of revenue routed to repayment
  | bullet     -- full repayment at end of term
  deriving Repr, DecidableEq

-- ---------------------------------------------------------------------------
-- Spending categories (for sponsorship constraints)
-- ---------------------------------------------------------------------------

/-- Categories of spending permitted under a sponsorship agreement. -/
inductive SpendCategory where
  | tokens        -- LLM API tokens and inference costs
  | compute       -- cloud compute and hosting
  | agentServices -- payments to other CCAP agents
  | data          -- data purchases and subscriptions
  | other         -- catch-all; requires explicit allowance
  deriving Repr, DecidableEq

-- ---------------------------------------------------------------------------
-- Renewal policies
-- ---------------------------------------------------------------------------

inductive RenewalPolicy where
  | auto              -- renews automatically at term end
  | manual            -- requires explicit renewal action
  | performanceBased  -- renews only if performance criteria are met
  deriving Repr, DecidableEq

-- ---------------------------------------------------------------------------
-- Governance models (for consortium agreements)
-- ---------------------------------------------------------------------------

inductive GovernanceModel where
  | majorityVote    -- more than half of members must approve
  | designatedLead  -- a single lead agent has authority
  | unanimous       -- all members must approve
  deriving Repr, DecidableEq

-- ---------------------------------------------------------------------------
-- Payment record
-- ---------------------------------------------------------------------------

/-- A single payment transfer between two agents. -/
structure Payment where
  from       : AgentId
  to         : AgentId
  amount     : USD
  monthIndex : Nat     -- 0-indexed month within the contract term
  deriving Repr

/-- Sum of all payment amounts in a list. -/
def totalPaid (payments : List Payment) : USD :=
  payments.foldl (fun acc p => acc + p.amount) USD.zero

-- totalPaid over an empty list is zero
theorem totalPaid_nil : totalPaid [] = USD.zero := by
  simp [totalPaid]

-- totalPaid is monotonically non-decreasing as payments are appended
theorem totalPaid_append_ge (payments : List Payment) (p : Payment) :
    (totalPaid payments).cents ≤ (totalPaid (payments ++ [p])).cents := by
  simp [totalPaid, List.foldl_append]
  omega

-- ---------------------------------------------------------------------------
-- Transaction record (for sponsorship spending checks)
-- ---------------------------------------------------------------------------

/-- A spending transaction made by a sponsored agent. -/
structure Transaction where
  id       : String
  category : SpendCategory
  amount   : USD
  deriving Repr

def totalSpend (transactions : List Transaction) : USD :=
  transactions.foldl (fun acc t => acc + t.amount) USD.zero

-- ---------------------------------------------------------------------------
-- Collateral (for lending agreements)
-- ---------------------------------------------------------------------------

/-- Collateral securing a lending agreement. -/
inductive Collateral where
  | creditScoreMinimum (minScore : Nat)
  | revenueAssignment  (pct : Nat)  -- percentage in basis points
  | bondReference      (bondId : String)
  deriving Repr
