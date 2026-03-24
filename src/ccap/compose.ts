// ============================================================
// CCAPComposition — agent discovery and invocation.
//
// Uses the CC registry API to find agents by capability,
// then invokes them over MCP and pays for the service.
// ============================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import crypto from 'node:crypto';
import type { CCAPEconomic } from './economic.js';
import type { AuditLogger } from '../audit.js';
import type {
  AgentDirectory,
  AgentInfo,
  AgentInvokeResult,
  DiscoveryParams,
  InvokeAgentParams,
  SubscribeParams,
  SubscribeResult,
} from '../types.js';

export class CCAPComposition {
  constructor(
    private readonly economic: CCAPEconomic,
    private readonly audit: AuditLogger,
    private readonly registryUrl: string = 'https://api.clawcombinator.ai',
    private readonly ccApiKey: string = process.env['CC_API_KEY'] ?? '',
  ) {}

  // ----------------------------------------------------------
  // discoverAgents — query the CC registry
  // ----------------------------------------------------------

  async discoverAgents(params: DiscoveryParams): Promise<AgentDirectory> {
    const query = new URLSearchParams();
    if (params.capabilities.length > 0) {
      query.set('capabilities', params.capabilities.join(','));
    }
    if (params.maxCostUsd !== undefined) {
      query.set('max_cost_usd', params.maxCostUsd.toString());
    }
    if (params.minReputation !== undefined) {
      query.set('min_reputation', params.minReputation.toString());
    }

    const url = `${this.registryUrl}/agents/search?${query.toString()}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.ccApiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`CC registry responded with ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as { agents: AgentInfo[]; total: number };

    this.audit.record('agents_discovered', {
      capabilities: params.capabilities,
      resultsCount: body.total,
    });

    return { agents: body.agents, total: body.total };
  }

  // ----------------------------------------------------------
  // invokeAgent — call a remote agent over MCP, then pay
  // ----------------------------------------------------------

  async invokeAgent(params: InvokeAgentParams): Promise<AgentInvokeResult> {
    const startTime = Date.now();

    // Resolve the agent — either by ID or by discovering the best match
    const agent = params.agentId
      ? await this.getAgent(params.agentId)
      : await this.findBestAgent(params.capability);

    if (!agent) {
      throw new Error(`No agent found with capability: ${params.capability}`);
    }

    // Connect to the agent's MCP endpoint
    const transport = new StreamableHTTPClientTransport(new URL(agent.mcpEndpoint));
    const client = new Client(
      { name: process.env['CC_AGENT_ID'] ?? 'agent-starter', version: '1.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);

    let output: unknown;
    let costUsd = 0;

    try {
      const result = await client.callTool(
        { name: params.capability, arguments: params.input },
        undefined,
        { timeout: (params.timeoutSeconds ?? 30) * 1000 },
      );

      output = result.content;

      // Extract cost from result metadata if present
      const meta = result as Record<string, unknown>;
      costUsd = typeof meta['cost_usd'] === 'number' ? meta['cost_usd'] : 0;
    } finally {
      await client.close();
    }

    // Pay for the service if there is a cost
    if (costUsd > 0 && agent.walletAddress) {
      await this.economic.pay({
        amount: costUsd,
        currency: 'USDC',
        recipientWallet: agent.walletAddress,
        memo: `Service: ${params.capability} from agent ${agent.id}`,
      });
    }

    const durationMs = Date.now() - startTime;

    this.audit.record('agent_invoked', {
      agentId: agent.id,
      capability: params.capability,
      costUsd,
      durationMs,
    });

    return { output, costUsd, durationMs };
  }

  // ----------------------------------------------------------
  // subscribe — register a webhook for agent events
  // ----------------------------------------------------------

  async subscribe(params: SubscribeParams): Promise<SubscribeResult> {
    const url = `${this.registryUrl}/agents/${params.agentId}/subscriptions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.ccApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        events: params.events,
        callback_url: params.callbackUrl,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Failed to subscribe: ${response.status} ${await response.text()}`);
    }

    const result: SubscribeResult = {
      subscriptionId: `sub_${crypto.randomBytes(8).toString('hex')}`,
      agentId: params.agentId,
      events: params.events,
      callbackUrl: params.callbackUrl,
      createdAt: new Date().toISOString(),
    };

    this.audit.record('subscription_created', {
      subscriptionId: result.subscriptionId,
      agentId: params.agentId,
      events: params.events,
    });

    return result;
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private async getAgent(agentId: string): Promise<AgentInfo | null> {
    const response = await fetch(`${this.registryUrl}/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${this.ccApiKey}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;
    return (await response.json()) as AgentInfo;
  }

  private async findBestAgent(capability: string): Promise<AgentInfo | null> {
    const directory = await this.discoverAgents({
      capabilities: [capability],
      minReputation: 0.7,
    });
    return directory.agents[0] ?? null;
  }
}
