// ============================================================
// service-registry.ts — mock agent service registry
//
// Agents register capabilities and pricing. Clients discover
// agents by capability and retrieve profiles including credit
// score. This simulates the CCAP registry that would exist
// in production as a decentralised on-chain directory.
//
// Design:
//   - register()    publish an agent's services
//   - discover()    find agents by capability
//   - getProfile()  retrieve full agent profile
// ============================================================

import { C } from './mock-provider.js';

// ----------------------------------------------------------
// Types
// ----------------------------------------------------------

export interface ServicePricing {
  model: 'per_call' | 'per_hour' | 'success_based' | 'flat';
  baseUsd: number;
  description: string;
}

export interface AgentProfile {
  agentId: string;
  displayName: string;
  description: string;
  capabilities: string[];
  pricing: Record<string, ServicePricing>;
  creditScore: number;
  creditTier: 'excellent' | 'good' | 'fair' | 'poor';
  walletAddress: string;
  registeredAt: string;
}

// ----------------------------------------------------------
// ServiceRegistry
// ----------------------------------------------------------

export class ServiceRegistry {
  private readonly agents = new Map<string, AgentProfile>();

  constructor() {
    // Pre-populate with the financial analyst agent
    this.seedDefaults();
  }

  // ----------------------------------------------------------
  // register — publish an agent's service profile
  // ----------------------------------------------------------

  register(profile: AgentProfile): void {
    this.agents.set(profile.agentId, {
      ...profile,
      registeredAt: profile.registeredAt ?? new Date().toISOString(),
    });
    console.log(
      `${C.yellow}[REGISTRY]${C.reset} Registered: ${C.bold}${profile.agentId}${C.reset} ` +
      `capabilities=[${profile.capabilities.join(', ')}] score=${profile.creditScore}`,
    );
  }

  // ----------------------------------------------------------
  // discover — find agents that support a given capability
  //
  // Returns agents sorted by credit score (descending), acting
  // as a simple quality signal [higher score = more trustworthy].
  // In production this would also filter by pricing, SLA, and
  // geographic jurisdiction.
  // ----------------------------------------------------------

  discover(capability: string): AgentProfile[] {
    const matches = Array.from(this.agents.values()).filter((a) =>
      a.capabilities.includes(capability),
    );

    // Sort by credit score (descending) — best agents surface first
    return matches.sort((a, b) => b.creditScore - a.creditScore);
  }

  // ----------------------------------------------------------
  // getProfile — retrieve full agent profile
  // ----------------------------------------------------------

  getProfile(agentId: string): AgentProfile | undefined {
    return this.agents.get(agentId);
  }

  // ----------------------------------------------------------
  // updateCreditScore — update an agent's score after a transaction
  // ----------------------------------------------------------

  updateCreditScore(agentId: string, newScore: number): void {
    const profile = this.agents.get(agentId);
    if (!profile) return;

    const oldScore = profile.creditScore;
    const newTier: AgentProfile['creditTier'] =
      newScore >= 800 ? 'excellent' :
      newScore >= 600 ? 'good' :
      newScore >= 400 ? 'fair' :
      'poor';

    this.agents.set(agentId, { ...profile, creditScore: newScore, creditTier: newTier });

    console.log(
      `${C.yellow}[REGISTRY]${C.reset} Credit score updated: ${C.bold}${agentId}${C.reset} ` +
      `${oldScore} → ${C.bold}${newScore}${C.reset} (${newTier.toUpperCase()})`,
    );
  }

  // ----------------------------------------------------------
  // listAll — for debugging; print all registered agents
  // ----------------------------------------------------------

  listAll(): void {
    console.log(`${C.yellow}[REGISTRY]${C.reset} ${this.agents.size} agent(s) registered:`);
    for (const a of this.agents.values()) {
      console.log(
        `  ${C.dim}•${C.reset} ${C.bold}${a.agentId}${C.reset} ` +
        `score=${a.creditScore} (${a.creditTier}) ` +
        `caps=[${a.capabilities.join(', ')}]`,
      );
    }
  }

  // ----------------------------------------------------------
  // Private — seed initial agent catalogue
  // ----------------------------------------------------------

  private seedDefaults(): void {
    this.agents.set('fin_scenario_analyst_v1', {
      agentId: 'fin_scenario_analyst_v1',
      displayName: 'Financial Scenario Analyst v1',
      description:
        'Specialised M&A financial modelling agent. Runs Monte Carlo simulations ' +
        '[probabilistic forecasts over many random trials] on revenue scenarios, ' +
        'integration cost ranges, and cash-flow stress tests. Produces structured ' +
        'output with confidence intervals and risk factor classification.',
      capabilities: [
        'financial_scenario_analysis',
        'monte_carlo_simulation',
        'integration_cost_modelling',
        'cash_flow_stress_test',
        'ma_due_diligence',
      ],
      pricing: {
        financial_scenario_analysis: {
          model: 'flat',
          baseUsd: 75,
          description: 'Full M&A scenario pack: base / optimistic / pessimistic + risk factors',
        },
        monte_carlo_simulation: {
          model: 'per_call',
          baseUsd: 40,
          description: 'Monte Carlo run with up to 10,000 iterations',
        },
      },
      creditScore: 812,
      creditTier: 'excellent',
      walletAddress: 'wallet_fin_0x4d3c2b1a',
      registeredAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days ago
    });
  }
}
