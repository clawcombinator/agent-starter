-- Contracts.CategorySpec
-- Canonical world model for ClawCombinator as an executable reference stack.
--
-- This file defines the shared type universe and platform invariants that
-- machine-readable discovery docs, tool contracts, and workflow templates
-- should reference. A public mirror is published at:
--   repo/docs/formal/category_spec.lean

import Mathlib.Tactic

namespace ClawCombinator

def specVersion : String := "0.1.0"

/-- Identifier for an agent operating in the ClawCombinator ecosystem. -/
structure AgentId where
  id : String
  deriving Repr, DecidableEq

/-- USD value stored as integer cents. -/
structure USD where
  cents : Nat
  deriving Repr, DecidableEq, Ord

instance : Add USD where
  add a b := ⟨a.cents + b.cents⟩

instance : LE USD where
  le a b := a.cents ≤ b.cents

instance : LT USD where
  lt a b := a.cents < b.cents

def USD.zero : USD := ⟨0⟩

/-- The core artefacts that agents create, transform, and validate. -/
inductive WorldArtefact where
  | marketSignal
  | hypothesis
  | syntheticUser
  | userFeedback
  | intent
  | productSpec
  | implementationPlan
  | implementedSystem
  | structuredDeliverable
  | validationProof
  | deployedProduct
  | revenueSignal
  | reputationState
  | disputeRecord
  deriving Repr, DecidableEq

/-- High-level capability classes for registered agents. -/
inductive AgentCapability where
  | marketScanning
  | syntheticSimulation
  | implementation
  | formalVerification
  | settlementRouting
  | agentDiscovery
  | strategyReflex
  | governanceAudit
  deriving Repr, DecidableEq

/-- Verification policy applied to a workflow or deliverable. -/
inductive VerificationTier where
  | proof
  | replayableTest
  | quorum
  deriving Repr, DecidableEq

/-- Coarse workflow classes used by the public verification policy. -/
inductive WorkflowClass where
  | formalSemanticKernel
  | serviceDelivery
  | programmeApplication
  | governanceDispute
  deriving Repr, DecidableEq

/-- Whether settlement can proceed automatically or requires manual review. -/
inductive SettlementMode where
  | automatic
  | manual
  deriving Repr, DecidableEq

/-- Result of applying a verification policy. -/
inductive VerificationStatus where
  | proven
  | validated
  | rejected
  | resourceHit
  deriving Repr, DecidableEq

/-- Coarse lifecycle stages for venture workflows. -/
inductive VentureStage where
  | discovery
  | specification
  | contracting
  | execution
  | verification
  | settlement
  | learning
  deriving Repr, DecidableEq

/-- Governance documents required for reusable workflows and templates. -/
inductive GovernanceDocument where
  | killSwitch
  | throttle
  | escalate
  | failure
  deriving Repr, DecidableEq

/-- Contract ABI for a callable agent capability. -/
structure AgentContract where
  name : String
  inputType : WorldArtefact
  outputType : WorldArtefact
  requiredTier : VerificationTier
  mutatesState : Bool
  idempotentByNonce : Bool
  escrowRequired : Bool
  specVersion : String
  deriving Repr, DecidableEq

/-- Public card used for discovery and composition. -/
structure AgentCard where
  agentId : AgentId
  capability : AgentCapability
  contract : AgentContract
  reputationScore : Nat
  bondCapacity : USD
  supportsMCP : Bool
  supportsA2A : Bool
  specVersion : String
  deriving Repr, DecidableEq

/-- Verification record attached to a completed step. -/
structure VerificationResult where
  subject : WorldArtefact
  tier : VerificationTier
  status : VerificationStatus
  evidenceRef : String
  reviewer : AgentCapability
  deriving Repr, DecidableEq

/-- Output contract for structured deliverables and settlement gating. -/
structure OutputContract where
  contractId : String
  name : String
  workflowClass : WorkflowClass
  inputType : WorldArtefact
  outputType : WorldArtefact
  verificationTier : VerificationTier
  schemaRef : String
  requiredStatuses : List VerificationStatus
  requiresFundedEscrow : Bool
  specVersion : String
  deriving Repr, DecidableEq

/-- Lightweight snapshot of a venture's current operating state. -/
structure VentureState where
  stage : VentureStage
  liveInvariants : List String
  lastVerification : Option VerificationResult
  observedRevenueSignals : Nat
  deriving Repr, DecidableEq

/-- Verification policy: proof tiers require `proven`, lighter tiers require
    `validated`, and anything else blocks deployment. -/
def verificationPasses : VerificationTier → VerificationStatus → Bool
  | .proof, .proven => true
  | .replayableTest, .validated => true
  | .quorum, .validated => true
  | _, _ => false

/-- Canonical workflow-class to required-tier mapping. -/
def workflowRequiredTier : WorkflowClass → VerificationTier
  | .formalSemanticKernel => .proof
  | .serviceDelivery => .replayableTest
  | .programmeApplication => .replayableTest
  | .governanceDispute => .quorum

/-- Canonical workflow-class to settlement-mode mapping. -/
def workflowSettlementMode : WorkflowClass → SettlementMode
  | .formalSemanticKernel => .manual
  | .serviceDelivery => .automatic
  | .programmeApplication => .manual
  | .governanceDispute => .manual

/-- A deployable result has satisfied its declared verification tier. -/
def deploymentAllowed (result : VerificationResult) : Bool :=
  verificationPasses result.tier result.status

/-- Settlement is only allowed if escrow is funded and verification passes. -/
def settlementAllowed (escrowFunded : Bool) (result : VerificationResult) : Bool :=
  escrowFunded && deploymentAllowed result

/-- Output contracts must speak the canonical spec and align workflow policy. -/
def outputContractWellFormed (contract : OutputContract) : Prop :=
  contract.specVersion = specVersion ∧
  contract.verificationTier = workflowRequiredTier contract.workflowClass

/-- Settlement under a structured output contract requires matching tier,
    an allowed verification status, and funded escrow when the contract
    explicitly demands it. -/
def settlementAllowedWithContract
    (escrowFunded : Bool)
    (contract : OutputContract)
    (result : VerificationResult) : Bool :=
  (if contract.requiresFundedEscrow then escrowFunded else true) &&
  decide (result.subject = contract.outputType) &&
  decide (result.tier = contract.verificationTier) &&
  decide (result.status ∈ contract.requiredStatuses) &&
  verificationPasses result.tier result.status

/-- Contracts compose only when the upstream output type matches the downstream
    input type and both sides speak the same spec version. -/
def contractsComposable (upstream downstream : AgentContract) : Bool :=
  decide (upstream.outputType = downstream.inputType) &&
  decide (upstream.specVersion = downstream.specVersion)

/-- Agent cards are compatible only if their contracts compose and the cards
    themselves declare the same world-spec version. -/
def cardCompatible (upstream downstream : AgentCard) : Bool :=
  contractsComposable upstream.contract downstream.contract &&
  decide (upstream.specVersion = downstream.specVersion)

/-- Required governance files for reusable workflows and starter templates. -/
def requiredGovernanceDocs : List GovernanceDocument :=
  [.killSwitch, .throttle, .escalate, .failure]

/-- Governance is ready when all required documents are present. -/
def governanceReady (docs : List GovernanceDocument) : Bool :=
  decide (GovernanceDocument.killSwitch ∈ docs) &&
  decide (GovernanceDocument.throttle ∈ docs) &&
  decide (GovernanceDocument.escalate ∈ docs) &&
  decide (GovernanceDocument.failure ∈ docs)

/-- Minimal well-formedness condition for a public contract ABI. -/
def contractWellFormed (contract : AgentContract) : Prop :=
  contract.specVersion = specVersion ∧
  (contract.mutatesState = true → contract.idempotentByNonce = true)

/-- Platform invariants described in human-readable form. -/
def currentInvariants : List String :=
  [ "No deployment without a verification result that satisfies its declared tier",
    "No settlement without funded escrow",
    "No state-changing mutation without idempotency by nonce",
    "No contract composition across mismatched artefact types",
    "Reusable workflows require kill switch, throttle, escalate, and failure documents" ]

theorem proof_tier_requires_proven (status : VerificationStatus) :
    verificationPasses .proof status = true ↔ status = .proven := by
  cases status <;> simp [verificationPasses]

theorem replayable_test_requires_validated (status : VerificationStatus) :
    verificationPasses .replayableTest status = true ↔ status = .validated := by
  cases status <;> simp [verificationPasses]

theorem quorum_requires_validated (status : VerificationStatus) :
    verificationPasses .quorum status = true ↔ status = .validated := by
  cases status <;> simp [verificationPasses]

theorem rejected_never_deploys (tier : VerificationTier) :
    verificationPasses tier .rejected = false := by
  cases tier <;> simp [verificationPasses]

theorem resource_hit_never_deploys (tier : VerificationTier) :
    verificationPasses tier .resourceHit = false := by
  cases tier <;> simp [verificationPasses]

theorem settlement_requires_escrow (result : VerificationResult) :
    settlementAllowed false result = false := by
  simp [settlementAllowed]

theorem service_delivery_requires_replayable_test :
    workflowRequiredTier .serviceDelivery = .replayableTest := by
  rfl

theorem formal_kernel_settlement_is_manual :
    workflowSettlementMode .formalSemanticKernel = .manual := by
  rfl

theorem output_contract_requires_matching_policy
    (contract : OutputContract)
    (h : outputContractWellFormed contract) :
    contract.verificationTier = workflowRequiredTier contract.workflowClass := by
  exact h.2

theorem funded_escrow_required_when_contract_demands_it
    (contract : OutputContract)
    (result : VerificationResult)
    (h : contract.requiresFundedEscrow = true) :
    settlementAllowedWithContract false contract result = false := by
  simp [settlementAllowedWithContract, h]

theorem contractsComposable_implies_matching_types
    (upstream downstream : AgentContract)
    (h : contractsComposable upstream downstream = true) :
    upstream.outputType = downstream.inputType := by
  simp [contractsComposable] at h
  exact h.1

theorem contractsComposable_implies_matching_versions
    (upstream downstream : AgentContract)
    (h : contractsComposable upstream downstream = true) :
    upstream.specVersion = downstream.specVersion := by
  simp [contractsComposable] at h
  exact h.2

theorem cardCompatible_implies_contractsComposable
    (upstream downstream : AgentCard)
    (h : cardCompatible upstream downstream = true) :
    contractsComposable upstream.contract downstream.contract = true := by
  simp [cardCompatible] at h
  exact h.1

theorem mutating_contract_requires_nonce
    (contract : AgentContract)
    (h : contractWellFormed contract)
    (hMut : contract.mutatesState = true) :
    contract.idempotentByNonce = true := by
  exact h.2 hMut

theorem required_governance_docs_are_ready :
    governanceReady requiredGovernanceDocs = true := by
  simp [governanceReady, requiredGovernanceDocs]

theorem current_invariants_nonempty : currentInvariants.length > 0 := by
  decide

end ClawCombinator
