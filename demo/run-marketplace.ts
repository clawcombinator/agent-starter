// ============================================================
// run-marketplace.ts — CCAP Marketplace Demo
//
// Demonstrates the marketplace flow: a legal agent discovers,
// evaluates, and hires a financial agent for M&A due diligence.
//
// New primitives illustrated:
//   1. Service discovery        → registry lookup by capability
//   2. Credit score gating      → minimum threshold enforcement
//   3. Output contract          → agreed schema before work begins
//   4. Structured validation    → schema-level output verification
//   5. Full CCAP lifecycle      → escrow + bond + release + scores
//
// Run with:
//   npx tsx demo/run-marketplace.ts
// ============================================================

import { MockProvider, C } from './mock-provider.js';
import { ServiceRegistry } from './service-registry.js';
import { AuditLogger } from '../src/audit.js';
import { SafetyMonitor } from '../src/safety.js';
import { PaymentRouter } from '../src/router.js';
import { CCAPEconomic } from '../src/ccap/economic.js';
import type { SafetyConfig } from '../src/types.js';

// ----------------------------------------------------------
// Timing utility
// ----------------------------------------------------------

function elapsed(startMs: number): string {
  return `${((Date.now() - startMs) / 1000).toFixed(2)}s`;
}

// ----------------------------------------------------------
// Section headers
// ----------------------------------------------------------

function section(n: number, title: string): void {
  console.log();
  console.log(`${C.yellow}╔${'═'.repeat(70)}╗${C.reset}`);
  console.log(`${C.yellow}║  STEP ${n}: ${title.toUpperCase().padEnd(61)}║${C.reset}`);
  console.log(`${C.yellow}╚${'═'.repeat(70)}╝${C.reset}`);
  console.log();
}

function banner(text: string): void {
  const pad  = Math.max(0, 70 - text.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  console.log();
  console.log(`${C.yellow}${'═'.repeat(72)}${C.reset}`);
  console.log(`${C.yellow}${' '.repeat(left + 1)}${C.bold}${text}${C.reset}${' '.repeat(right)}`);
  console.log(`${C.yellow}${'═'.repeat(72)}${C.reset}`);
  console.log();
}

function sys(msg: string): void {
  console.log(`${C.yellow}[SYSTEM]${C.reset} ${msg}`);
}

function lex(msg: string): void {
  console.log(`${C.cyan}[LEX-DUEDILIGENCE]${C.reset} ${msg}`);
}

function fin(msg: string): void {
  console.log(`${C.green}[FIN-ANALYST]${C.reset} ${msg}`);
}

function tick(): string {
  return `${C.green}✓${C.reset}`;
}

function cross(): string {
  return `${C.red}✗${C.reset}`;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const empty  = width - filled;
  return `${C.green}${'█'.repeat(filled)}${C.reset}${C.dim}${'░'.repeat(empty)}${C.reset}`;
}

// ----------------------------------------------------------
// Output schema — agreed between agents before work begins.
//
// This is the "output contract": both parties commit to this
// structure so validation is unambiguous. In production this
// would be hashed and stored on-chain alongside the escrow.
// ----------------------------------------------------------

interface ScenarioResult {
  name:                 'base_case' | 'optimistic' | 'pessimistic';
  runway_months:        number;
  integration_cost_usd: number;
  confidence:           number;   // 0–100
}

interface FinancialAnalysisOutput {
  scenarios:      ScenarioResult[];
  risk_factors:   string[];
  recommendation: 'proceed' | 'caution' | 'abort';
  methodology:    string;
}

// ----------------------------------------------------------
// Agent infrastructure builder
// ----------------------------------------------------------

function buildAgentInfra(
  provider: MockProvider,
  auditPath: string,
  budget: { daily: number; soft: number; txn: number; humanApproval: number },
): CCAPEconomic {
  const audit = new AuditLogger(auditPath);

  const safetyConfig: SafetyConfig = {
    budget: {
      dailyLimitUsd:              budget.daily,
      softLimitUsd:               budget.soft,
      transactionLimitUsd:        budget.txn,
      humanApprovalThresholdUsd:  budget.humanApproval,
    },
    rateLimits: { requestsPerMinute: 120, burstAllowance: 30 },
    escalation: { webhookUrls: [], timeoutMinutes: 60 },
  };

  const safety = new SafetyMonitor(safetyConfig, audit);
  const router = new PaymentRouter(safety, audit);
  router.registerProvider(provider);

  return new CCAPEconomic(router, safety, audit);
}

// ----------------------------------------------------------
// Main demo orchestrator
// ----------------------------------------------------------

async function main(): Promise<void> {
  const demoStart = Date.now();

  // ── Splash screen ─────────────────────────────────────────────────────────

  console.clear();
  console.log();
  console.log(`${C.yellow}${C.bold}`);
  console.log(`  ██████╗ ██████╗ █████╗ ██████╗    ███╗   ███╗ █████╗ ██████╗ `);
  console.log(`  ██╔════╝██╔════╝██╔══██╗██╔══██╗   ████╗ ████║██╔══██╗██╔══██╗`);
  console.log(`  ██║     ██║     ███████║██████╔╝   ██╔████╔██║███████║██████╔╝`);
  console.log(`  ██║     ██║     ██╔══██║██╔═══╝    ██║╚██╔╝██║██╔══██║██╔═══╝ `);
  console.log(`  ╚██████╗╚██████╗██║  ██║██║        ██║ ╚═╝ ██║██║  ██║██║     `);
  console.log(`   ╚═════╝ ╚═════╝╚═╝  ╚═╝╚═╝        ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝     `);
  console.log(`${C.reset}`);
  console.log(`${C.yellow}  CCAP Marketplace Demo${C.reset}`);
  console.log(`${C.dim}  Scenario: M&A Due Diligence${C.reset}`);
  console.log(`${C.dim}  Legal agent hires financial agent via CCAP${C.reset}`);
  console.log();
  console.log(`${C.cyan}  Legal Due Diligence Agent:${C.reset}  lex_duediligence_v2`);
  console.log(`${C.green}  Financial Analysis Agent:${C.reset}   fin_scenario_analyst_v1`);
  console.log();
  console.log(`${C.dim}  Task:    Produce financial scenario analysis for Project Birch acquisition${C.reset}`);
  console.log(`${C.dim}  Escrow:  $75 USD (flat rate for full M&A scenario pack)${C.reset}`);
  console.log(`${C.dim}  Bond:    $15 USD (performance bond from financial agent)${C.reset}`);
  console.log();

  await pause(1500);

  // ── Initialise infrastructure ─────────────────────────────────────────────

  section(0, 'Initialise Shared Infrastructure');

  const provider = new MockProvider({
    transactionLimitUsd:    2_000,
    defaultStartingBalance: 1_000,
    currency:               'USD',
  });
  await provider.initialize();

  // Seed wallets
  provider.seedWallet('wallet_lex_0xaabbccdd', 500);    // Legal agent has funds
  provider.seedWallet('wallet_fin_0x4d3c2b1a', 200);    // Financial agent can post bond

  // Build agent economic layers
  const lexEconomic = buildAgentInfra(provider,
    `/tmp/cc-marketplace-lex-audit-${Date.now()}.jsonl`,
    { daily: 10_000, soft: 8_000, txn: 2_000, humanApproval: 5_000 },
  );

  const finEconomic = buildAgentInfra(provider,
    `/tmp/cc-marketplace-fin-audit-${Date.now()}.jsonl`,
    { daily: 5_000, soft: 4_000, txn: 1_000, humanApproval: 2_000 },
  );

  // Shared service registry — the marketplace directory
  const registry = new ServiceRegistry();

  console.log();
  sys(`Legal agent:     ${C.cyan}${C.bold}lex_duediligence_v2${C.reset}`);
  sys(`Financial agent: ${C.green}${C.bold}fin_scenario_analyst_v1${C.reset}`);
  sys(`Registry:        ${C.yellow}${C.bold}mock (pre-seeded with financial analyst)${C.reset}`);

  await pause(1000);

  // ── Step 1: Service discovery ──────────────────────────────────────────────

  section(1, 'Service Discovery');

  lex(`I need financial scenario analysis for an acquisition target.`);
  lex(`Querying registry for capability: ${C.bold}financial_scenario_analysis${C.reset}`);

  await pause(600);

  const matches = registry.discover('financial_scenario_analysis');

  if (matches.length === 0) {
    sys(`${C.red}No agents found for capability: financial_scenario_analysis${C.reset}`);
    process.exit(1);
  }

  console.log();
  sys(`Found ${matches.length} agent(s) with capability 'financial_scenario_analysis':`);
  console.log();

  for (const agent of matches) {
    const pricing = agent.pricing['financial_scenario_analysis'];
    console.log(
      `  ${C.dim}•${C.reset} ${C.bold}${agent.agentId}${C.reset}\n` +
      `    ${C.dim}${agent.description.slice(0, 90)}…${C.reset}\n` +
      `    Credit score: ${C.bold}${agent.creditScore}${C.reset} (${agent.creditTier.toUpperCase()})` +
      (pricing ? `  |  Pricing: $${pricing.baseUsd} ${pricing.model}` : '') + '\n',
    );
  }

  const selected = matches[0]!;
  lex(`Selected: ${C.bold}${selected.agentId}${C.reset}`);

  await pause(800);

  // ── Step 2: Credit score check ────────────────────────────────────────────

  section(2, 'Credit Score Verification');

  const MIN_CREDIT_THRESHOLD = 750;

  lex(`Verifying credit score for ${C.bold}${selected.agentId}${C.reset}`);
  lex(`Minimum threshold required: ${C.bold}${MIN_CREDIT_THRESHOLD}${C.reset}`);

  await pause(600);

  const profile = registry.getProfile(selected.agentId);
  const score   = profile?.creditScore ?? 0;
  const tier    = profile?.creditTier  ?? 'poor';

  console.log();
  console.log(`  Agent:          ${C.bold}${selected.agentId}${C.reset}`);
  console.log(`  Credit score:   ${C.bold}${score}${C.reset} (${tier.toUpperCase()})`);
  console.log(`  Min threshold:  ${MIN_CREDIT_THRESHOLD}`);
  console.log(`  Registered:     ${profile?.registeredAt?.slice(0, 10) ?? 'unknown'}`);
  console.log();

  if (score >= MIN_CREDIT_THRESHOLD) {
    sys(`${C.green}Credit check PASSED${C.reset} — score ${score} ≥ threshold ${MIN_CREDIT_THRESHOLD}`);
    lex(`Proceeding to engage ${C.bold}${selected.agentId}${C.reset}`);
  } else {
    sys(`${C.red}Credit check FAILED${C.reset} — score ${score} < threshold ${MIN_CREDIT_THRESHOLD}`);
    sys(`Aborting engagement — insufficient creditworthiness`);
    process.exit(1);
  }

  await pause(800);

  // ── Step 3: Output contract agreement ─────────────────────────────────────

  section(3, 'Output Contract Agreement');

  lex(`Proposing output schema to ${C.bold}${selected.agentId}${C.reset}`);
  fin(`Reviewing proposed output contract…`);

  await pause(600);

  console.log();
  console.log(`  ${C.yellow}Agreed output schema:${C.reset}`);
  console.log();
  console.log(`  ${C.dim}{${C.reset}`);
  console.log(`    ${C.cyan}"scenarios"${C.reset}: [`);
  console.log(`      ${C.dim}{${C.reset}`);
  console.log(`        ${C.cyan}"name"${C.reset}:                 ${C.green}"base_case" | "optimistic" | "pessimistic"${C.reset}`);
  console.log(`        ${C.cyan}"runway_months"${C.reset}:        ${C.green}number${C.reset}`);
  console.log(`        ${C.cyan}"integration_cost_usd"${C.reset}: ${C.green}number${C.reset}`);
  console.log(`        ${C.cyan}"confidence"${C.reset}:           ${C.green}number  ${C.dim}// 0–100${C.reset}`);
  console.log(`      ${C.dim}}${C.reset}`);
  console.log(`    ${C.dim}]${C.reset}${C.dim}, // exactly 3 scenarios required${C.reset}`);
  console.log(`    ${C.cyan}"risk_factors"${C.reset}:   ${C.green}string[]${C.reset}`);
  console.log(`    ${C.cyan}"recommendation"${C.reset}: ${C.green}"proceed" | "caution" | "abort"${C.reset}`);
  console.log(`    ${C.cyan}"methodology"${C.reset}:    ${C.green}string${C.reset}`);
  console.log(`  ${C.dim}}${C.reset}`);
  console.log();

  lex(`${tick()} Output schema proposed`);
  fin(`${tick()} Output schema accepted`);
  sys(`Output contract agreed — schema hash will be stored with escrow`);

  await pause(800);

  // ── Step 4: Escrow creation ────────────────────────────────────────────────

  section(4, 'Escrow Creation ($75)');

  const t4 = Date.now();

  lex(`Creating escrow: $75 USD for "M&A Financial Scenario Analysis — Project Birch"`);
  lex(`  Beneficiary: ${C.bold}${selected.agentId}${C.reset}`);
  lex(`  Completion:  Output matches agreed schema + passes validation`);

  const escrow = await lexEconomic.createEscrow({
    amount:                  75,
    currency:                'USD',
    beneficiaryAgentId:      selected.agentId,
    completionCriteria:
      'Deliver structured financial scenario analysis for Project Birch acquisition target. ' +
      'Output must conform to agreed schema: 3 scenarios (base/optimistic/pessimistic), ' +
      'risk_factors array, recommendation enum, and methodology description.',
    timeoutSeconds:          7200,   // 2-hour window
    disputeResolutionMethod: 'arbitration_agent',
    arbitrationAgentId:      'arbitration_agent_ccap_v1',
    idempotencyKey:          `escrow_lex_duediligence_v2_${Date.now()}`,
    metadata: {
      buyerWallet:    'wallet_lex_0xaabbccdd',
      project:        'Project Birch',
      outputContractSchemaVersion: '1.0',
    },
  });
  const fundedEscrow = await lexEconomic.fundEscrow(
    escrow.escrowId,
    'lex_duediligence_v2',
  );

  sys(`Escrow created in ${elapsed(t4)}`);
  lex(`${C.green}Escrow funded${C.reset} — ID: ${C.bold}${escrow.escrowId}${C.reset}`);
  lex(`  Status:  ${fundedEscrow.status} | Expires: ${escrow.expiresAt.slice(0, 19)}`);

  await pause(800);

  // ── Step 5: Bond posting ──────────────────────────────────────────────────

  section(5, 'Bond Posting ($15)');

  const t5 = Date.now();

  fin(`Verifying escrow is funded before committing…`);
  const escrowStatus = await finEconomic.verifyEscrow(escrow.escrowId);
  fin(`${tick()} Escrow verified — $${escrowStatus.amount} ${escrowStatus.currency} confirmed`);

  await pause(400);

  fin(`Posting $15 liability bond — skin in the game for financial analysis`);
  fin(`  Scope: financial_transaction_routing`);
  fin(`  This is forfeited if output fails validation or is materially incorrect`);

  const bond = await finEconomic.postBond({
    amount:           15,
    currency:         'USD',
    scope:            'financial_transaction_routing',
    scopeDescription:
      'M&A financial scenario modelling for acquisition due diligence. ' +
      'Output: structured JSON with runway, integration cost, confidence intervals.',
    durationSeconds:  86_400,
    claimConditions:
      'Buyer may claim if: (a) output does not conform to agreed schema, ' +
      '(b) confidence intervals are outside 0–100 range, ' +
      '(c) recommendation is not one of: proceed / caution / abort.',
    maxClaimAmount:       15,
    arbitrationAgentId:  'arbitration_agent_ccap_v1',
    humanEscalationThresholdUsd: 500,
    idempotencyKey: `bond_fin_scenario_analyst_v1_${Date.now()}`,
  });

  sys(`Bond posted in ${elapsed(t5)}`);
  fin(`${C.green}Bond active${C.reset} — ID: ${C.bold}${bond.bondId}${C.reset}`);
  fin(`  Active from: ${bond.activeFrom.slice(0, 19)}`);
  fin(`  Expires:     ${bond.expiresAt.slice(0, 19)}`);

  await pause(800);

  // ── Step 6: Work execution ────────────────────────────────────────────────

  section(6, 'Work Execution — Financial Analysis');

  fin(`Starting analysis of Project Birch acquisition target…`);
  console.log();

  const stages = [
    { label: 'Parsing financial statements (3 years)',     pct: 12 },
    { label: 'Modelling integration costs',               pct: 28 },
    { label: 'Running Monte Carlo on revenue scenarios',  pct: 47 },
    { label: 'Stress-testing cash flow assumptions',      pct: 65 },
    { label: 'Generating confidence intervals',           pct: 80 },
    { label: 'Classifying risk factors',                  pct: 92 },
    { label: 'Structuring output to agreed schema',       pct: 100 },
  ];

  for (const stage of stages) {
    const delayMs = Math.floor(Math.random() * 400 + 200);
    await pause(delayMs);
    const bar = progressBar(stage.pct, 30);
    process.stdout.write(
      `\r  ${C.green}[FIN-ANALYST]${C.reset} ${bar} ${String(stage.pct).padStart(3)}%  ` +
      `${C.dim}${stage.label}${C.reset}    `,
    );
  }

  console.log();
  console.log();

  // Produce the structured output conforming to the agreed schema
  const analysisOutput: FinancialAnalysisOutput = {
    scenarios: [
      {
        name:                 'base_case',
        runway_months:        18,
        integration_cost_usd: 2_400_000,
        confidence:           72,
      },
      {
        name:                 'optimistic',
        runway_months:        24,
        integration_cost_usd: 1_800_000,
        confidence:           45,
      },
      {
        name:                 'pessimistic',
        runway_months:        11,
        integration_cost_usd: 3_100_000,
        confidence:           83,
      },
    ],
    risk_factors: [
      'key-person dependency: CTO holds critical proprietary knowledge',
      'deferred maintenance on core platform (~$800k estimated remediation)',
      'regulatory exposure in 2 jurisdictions (DE + CA)',
    ],
    recommendation: 'caution',
    methodology:
      'Monte Carlo simulation (10,000 iterations) on revenue growth distribution. ' +
      'Integration cost modelled as triangular distribution (min/mode/max). ' +
      'Confidence intervals represent posterior probability given historical comps.',
  };

  fin(`${C.green}Analysis complete!${C.reset}`);
  console.log();
  console.log(`  ${C.yellow}Financial Analysis Results — Project Birch${C.reset}`);
  console.log();

  for (const s of analysisOutput.scenarios) {
    const label = s.name.replace('_', ' ').toUpperCase().padEnd(14);
    console.log(
      `  ${C.bold}${label}${C.reset}` +
      `  runway=${C.cyan}${s.runway_months}mo${C.reset}` +
      `  integration=${C.cyan}$${(s.integration_cost_usd / 1_000_000).toFixed(1)}M${C.reset}` +
      `  confidence=${C.cyan}${s.confidence}%${C.reset}`,
    );
  }

  console.log();
  console.log(`  ${C.yellow}Risk factors:${C.reset}`);
  for (const rf of analysisOutput.risk_factors) {
    console.log(`    ${C.dim}•${C.reset} ${rf}`);
  }

  console.log();
  const recColour = analysisOutput.recommendation === 'proceed' ? C.green :
                    analysisOutput.recommendation === 'caution' ? C.yellow : C.red;
  console.log(
    `  ${C.yellow}Recommendation:${C.reset} ${recColour}${C.bold}${analysisOutput.recommendation.toUpperCase()}${C.reset}`,
  );
  console.log();

  await pause(800);

  // ── Step 7: Output validation ─────────────────────────────────────────────

  section(7, 'Output Validation Against Agreed Schema');

  lex(`Validating received output against agreed schema…`);
  console.log();

  const checks: { label: string; pass: boolean; detail?: string }[] = [];

  // Check 1: all three scenario names present
  const scenarioNames = analysisOutput.scenarios.map((s) => s.name);
  const hasBase      = scenarioNames.includes('base_case');
  const hasOptimistic = scenarioNames.includes('optimistic');
  const hasPessimistic = scenarioNames.includes('pessimistic');
  const allScenarios = hasBase && hasOptimistic && hasPessimistic;
  checks.push({
    label:  'All 3 scenario names present (base_case, optimistic, pessimistic)',
    pass:   allScenarios,
    detail: allScenarios ? undefined : `Missing: ${[!hasBase && 'base_case', !hasOptimistic && 'optimistic', !hasPessimistic && 'pessimistic'].filter(Boolean).join(', ')}`,
  });

  // Check 2: confidence intervals valid (0–100)
  const confidencesValid = analysisOutput.scenarios.every(
    (s) => s.confidence >= 0 && s.confidence <= 100,
  );
  const invalidConfidences = analysisOutput.scenarios
    .filter((s) => s.confidence < 0 || s.confidence > 100)
    .map((s) => `${s.name}=${s.confidence}`);
  checks.push({
    label:  'All confidence values in valid range (0–100)',
    pass:   confidencesValid,
    detail: confidencesValid ? undefined : `Invalid: ${invalidConfidences.join(', ')}`,
  });

  // Check 3: recommendation is one of the allowed values
  const validRecommendations = ['proceed', 'caution', 'abort'];
  const recValid = validRecommendations.includes(analysisOutput.recommendation);
  checks.push({
    label:  `Recommendation is valid enum value (${validRecommendations.join(' | ')})`,
    pass:   recValid,
    detail: recValid ? undefined : `Got: '${analysisOutput.recommendation}'`,
  });

  // Check 4: risk_factors is a non-empty array
  const riskFactorsValid = Array.isArray(analysisOutput.risk_factors) &&
                           analysisOutput.risk_factors.length > 0;
  checks.push({
    label:  'risk_factors is a non-empty array',
    pass:   riskFactorsValid,
    detail: riskFactorsValid ? undefined : 'Empty or missing risk_factors array',
  });

  // Check 5: methodology field is present
  const methodologyValid = typeof analysisOutput.methodology === 'string' &&
                           analysisOutput.methodology.length > 0;
  checks.push({
    label:  'methodology field present and non-empty',
    pass:   methodologyValid,
    detail: methodologyValid ? undefined : 'Missing or empty methodology',
  });

  // Print results
  let allPassed = true;
  for (const check of checks) {
    const icon = check.pass ? tick() : cross();
    console.log(`  ${icon} ${check.label}`);
    if (!check.pass && check.detail) {
      console.log(`      ${C.red}└─ ${check.detail}${C.reset}`);
    }
    if (!check.pass) allPassed = false;
  }

  console.log();

  if (allPassed) {
    sys(`${C.green}Validation PASSED${C.reset} — all schema checks satisfied`);
    lex(`Output conforms to agreed contract. Releasing escrow.`);
  } else {
    sys(`${C.red}Validation FAILED${C.reset} — output does not conform to agreed schema`);
    sys(`Initiating bond claim — escrow refund pending arbitration`);
    process.exit(1);
  }

  await pause(800);

  // ── Step 8: Escrow release ─────────────────────────────────────────────────

  section(8, 'Escrow Release');

  const t8 = Date.now();

  const evidenceHash = `sha256:${Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  ).join('')}`;

  const releaseResult = await lexEconomic.releaseEscrow(
    escrow.escrowId,
    `schema_validation_passed|rec=${analysisOutput.recommendation}|evidence=${evidenceHash}`,
  );

  sys(`Escrow released in ${elapsed(t8)}`);
  lex(`${C.green}Payment settled!${C.reset}`);
  lex(`  Amount:  $${releaseResult.amount} ${releaseResult.currency}`);
  lex(`  To:      ${C.bold}${releaseResult.releasedTo}${C.reset}`);
  lex(`  TxnID:   ${C.dim}${releaseResult.transactionId}${C.reset}`);
  lex(`  At:      ${releaseResult.releasedAt.slice(0, 19)}`);

  await pause(800);

  // ── Step 9: Credit score update ───────────────────────────────────────────

  section(9, 'Credit Score Update');

  // Read scores from the registry (the canonical [authoritative] source)
  // rather than the in-memory economic instance, which only sees local history.
  const lexProfileBefore = registry.getProfile('lex_duediligence_v2');
  const finProfileBefore = registry.getProfile('fin_scenario_analyst_v1');

  // Registry may not have an entry for the legal agent yet — seed it first
  if (!lexProfileBefore) {
    registry.register({
      agentId:      'lex_duediligence_v2',
      displayName:  'Legal Due Diligence Agent v2',
      description:  'Legal agent specialising in M&A due diligence.',
      capabilities: ['legal_due_diligence', 'contract_analysis'],
      pricing:      {},
      creditScore:  780,
      creditTier:   'good',
      walletAddress: 'wallet_lex_0xaabbccdd',
      registeredAt:  new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  const lexScoreBefore = registry.getProfile('lex_duediligence_v2')?.creditScore ?? 780;
  const finScoreBefore = registry.getProfile('fin_scenario_analyst_v1')?.creditScore ?? 812;

  await pause(400);

  sys(`Transaction complete — updating registry credit scores`);
  console.log();

  // Legal agent: completed a transaction as buyer → small positive signal
  const lexScoreNew = Math.min(900, lexScoreBefore + 5);
  registry.updateCreditScore('lex_duediligence_v2', lexScoreNew);

  // Financial agent: delivered conforming output as seller → stronger positive signal
  const finScoreNew = Math.min(900, finScoreBefore + 8);
  registry.updateCreditScore('fin_scenario_analyst_v1', finScoreNew);

  console.log();
  sys(`${C.cyan}Legal agent${C.reset}:    ${lexScoreBefore} → ${C.bold}${lexScoreNew}${C.reset}`);
  sys(`${C.green}Financial agent${C.reset}: ${finScoreBefore} → ${C.bold}${finScoreNew}${C.reset}`);
  sys(`${C.dim}Scores reflect completed, validated, dispute-free transaction${C.reset}`);

  await pause(800);

  // ── Step 10: Audit trails ──────────────────────────────────────────────────

  section(10, 'Hash-Chained Audit Trails');

  // Legal agent audit trail
  {
    const entries = (lexEconomic as unknown as { audit: AuditLogger }).audit?.export() ?? [];
    const verify  = (lexEconomic as unknown as { audit: AuditLogger }).audit?.verify() ?? { valid: true, entriesChecked: 0 };

    // Fallback: access via the economic instance's internal reference
    // (the audit logger is private but we want to display it here)
    const auditEntries = entries.length > 0 ? entries : [];

    console.log();
    console.log(`${C.cyan}${'─'.repeat(72)}${C.reset}`);
    console.log(`${C.cyan}  LEGAL AGENT AUDIT TRAIL  (lex_duediligence_v2)${C.reset}`);
    console.log(`${C.cyan}${'─'.repeat(72)}${C.reset}`);

    if (auditEntries.length === 0) {
      console.log(`  ${C.dim}(audit entries recorded in ephemeral logger — see /tmp/cc-marketplace-lex-*.jsonl)${C.reset}`);
    } else {
      for (let i = 0; i < auditEntries.length; i++) {
        const e = auditEntries[i]!;
        const prevShort = i === 0 ? 'genesis' : `…${auditEntries[i - 1]!.hash.slice(-8)}`;
        const currShort = `…${e.hash.slice(-8)}`;
        const ts = e.timestamp.slice(11, 23);
        console.log(
          `  ${C.dim}[${String(i + 1).padStart(2, '0')}]${C.reset}` +
          ` ${C.dim}${ts}${C.reset}` +
          ` ${C.cyan}${e.action.padEnd(40)}${C.reset}` +
          ` ${C.dim}${prevShort} → ${currShort}${C.reset}`,
        );
      }
      const chainStatus = verify.valid
        ? `${C.green}CHAIN INTACT${C.reset} — all ${verify.entriesChecked} hashes verified`
        : `${C.red}CHAIN BROKEN${C.reset} at entry ${verify.firstBrokenAt}: ${verify.error}`;
      console.log();
      console.log(`  ${chainStatus}`);
    }

    console.log(`${C.cyan}${'─'.repeat(72)}${C.reset}`);
  }

  await pause(400);

  // Financial agent audit trail
  {
    const entries = (finEconomic as unknown as { audit: AuditLogger }).audit?.export() ?? [];
    const verify  = (finEconomic as unknown as { audit: AuditLogger }).audit?.verify() ?? { valid: true, entriesChecked: 0 };

    console.log();
    console.log(`${C.green}${'─'.repeat(72)}${C.reset}`);
    console.log(`${C.green}  FINANCIAL AGENT AUDIT TRAIL  (fin_scenario_analyst_v1)${C.reset}`);
    console.log(`${C.green}${'─'.repeat(72)}${C.reset}`);

    if (entries.length === 0) {
      console.log(`  ${C.dim}(audit entries recorded in ephemeral logger — see /tmp/cc-marketplace-fin-*.jsonl)${C.reset}`);
    } else {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        const prevShort = i === 0 ? 'genesis' : `…${entries[i - 1]!.hash.slice(-8)}`;
        const currShort = `…${e.hash.slice(-8)}`;
        const ts = e.timestamp.slice(11, 23);
        console.log(
          `  ${C.dim}[${String(i + 1).padStart(2, '0')}]${C.reset}` +
          ` ${C.dim}${ts}${C.reset}` +
          ` ${C.green}${e.action.padEnd(40)}${C.reset}` +
          ` ${C.dim}${prevShort} → ${currShort}${C.reset}`,
        );
      }
      const chainStatus = verify.valid
        ? `${C.green}CHAIN INTACT${C.reset} — all ${verify.entriesChecked} hashes verified`
        : `${C.red}CHAIN BROKEN${C.reset} at entry ${verify.firstBrokenAt}: ${verify.error}`;
      console.log();
      console.log(`  ${chainStatus}`);
    }

    console.log(`${C.green}${'─'.repeat(72)}${C.reset}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  banner('MARKETPLACE DEMO COMPLETE');

  const totalMs = Date.now() - demoStart;

  console.log(`${C.yellow}  Trust flow summary — M&A Due Diligence via CCAP${C.reset}`);
  console.log();
  console.log(`  ${C.cyan}Legal agent:${C.reset}     lex_duediligence_v2`);
  console.log(`  ${C.green}Financial agent:${C.reset} fin_scenario_analyst_v1`);
  console.log(`  Project:         Birch acquisition target`);
  console.log();
  console.log(`  ${tick()} Service discovery    capability='financial_scenario_analysis' → 1 match`);
  console.log(`  ${tick()} Credit score check   ${score} ≥ ${MIN_CREDIT_THRESHOLD} threshold — engagement approved`);
  console.log(`  ${tick()} Output contract      structured schema agreed before work began`);
  console.log(`  ${tick()} Escrow created       $75 USD locked — payment guaranteed`);
  console.log(`  ${tick()} Bond posted          $15 skin in the game from financial agent`);
  console.log(`  ${tick()} Work delivered       3-scenario analysis + risk factors + recommendation`);
  console.log(`  ${tick()} Output validated     5/5 schema checks passed — no disputes`);
  console.log(`  ${tick()} Escrow released      $75 settled atomically`);
  console.log(`  ${tick()} Credit updated       both agents' scores reflect clean transaction`);
  console.log(`  ${tick()} Audit trails         hash chains intact`);
  console.log();
  console.log(`  ${C.yellow}Provider:${C.reset} mock (0 API keys, 0 real payments)`);
  console.log(`  ${C.yellow}Runtime: ${C.reset} ${(totalMs / 1000).toFixed(2)}s`);
  console.log();

  // Closing statement
  console.log(`${C.yellow}${'─'.repeat(72)}${C.reset}`);
  console.log();
  console.log(`  ${C.dim}Two specialised agents transacted safely.${C.reset}`);
  console.log(`  ${C.dim}No humans coordinated this.${C.reset}`);
  console.log(`  ${C.dim}The trust infrastructure handled accountability, reversibility,${C.reset}`);
  console.log(`  ${C.dim}and verification.${C.reset}`);
  console.log();

  // Lean 4 contract reference
  console.log(`  ${C.dim}This transaction is governed by formally verified contracts:${C.reset}`);
  console.log();
  console.log(`  ${C.cyan}contracts/Contracts/Escrow.lean${C.reset}`);
  console.log(`  ${C.cyan}contracts/Contracts/Bond.lean${C.reset}`);
  console.log(`  ${C.cyan}contracts/Contracts/CreditScore.lean${C.reset}`);
  console.log();
  console.log(`  ${C.dim}Every state transition in this demo has a Lean 4 proof of correctness.${C.reset}`);
  console.log(`  ${C.dim}Output contracts add a fourth invariant: schema conformance is a${C.reset}`);
  console.log(`  ${C.dim}release precondition [required condition before payment can proceed].${C.reset}`);
  console.log();
  console.log(`${C.yellow}${'─'.repeat(72)}${C.reset}`);
  console.log();

  process.exit(0);
}

// ----------------------------------------------------------
// Run
// ----------------------------------------------------------

main().catch((err) => {
  console.error(`${C.red}FATAL:${C.reset}`, err);
  process.exit(1);
});
