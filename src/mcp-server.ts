// ============================================================
// MCP Server — implements the Model Context Protocol using
// @modelcontextprotocol/sdk.
//
// Exposes two sets of tools:
//
//  Economic tools (wired to CCAPEconomic / PaymentRouter):
//    - pay              — route a payment through the best provider
//    - balance          — aggregate balance across all providers
//    - invoice          — create a structured payment request
//    - escrow           — time-locked hold (CC-native primitive)
//    - list_providers   — list registered payment providers
//    - provider_status  — health and balance per provider
//
//  Capability tools (registered via registerCapability):
//    - Any Capability implementation (e.g. example_review)
// ============================================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { Capability } from './types.js';
import type { SafetyMonitor } from './safety.js';
import type { AuditLogger } from './audit.js';
import type { CCAPEconomic } from './ccap/economic.js';
import type { PaymentRouter } from './router.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

// ----------------------------------------------------------
// Built-in economic tool definitions
// ----------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  handler(args: Record<string, unknown>, economic: CCAPEconomic, router: PaymentRouter): Promise<unknown>;
}

const ECONOMIC_TOOLS: ToolDefinition[] = [
  {
    name: 'pay',
    description: 'Route a payment through the best available provider (Coinbase, Stripe, x402). ' +
      'Specify method=crypto|card|x402|bank_transfer to constrain provider selection.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount to pay in the given currency' },
        currency: { type: 'string', description: 'Currency code, e.g. USDC, USD, ETH' },
        recipientWallet: { type: 'string', description: 'Recipient address, customer ID, or URL (for x402)' },
        memo: { type: 'string', description: 'Payment description' },
        method: {
          type: 'string',
          enum: ['crypto', 'card', 'x402', 'bank_transfer'],
          description: 'Payment method. Omit to let the router choose.',
        },
        invoiceId: { type: 'string', description: 'Optional invoice ID to link this payment to' },
      },
      required: ['amount', 'currency', 'recipientWallet', 'memo'],
    },
    async handler(args, economic) {
      return economic.pay({
        amount: args['amount'] as number,
        currency: args['currency'] as string,
        recipientWallet: args['recipientWallet'] as string,
        memo: args['memo'] as string,
        method: args['method'] as 'crypto' | 'card' | 'x402' | 'bank_transfer' | undefined,
        invoiceId: args['invoiceId'] as string | undefined,
      });
    },
  },

  {
    name: 'balance',
    description: 'Return the balance across all configured payment providers.',
    inputSchema: {
      type: 'object',
      properties: {
        currency: { type: 'string', description: 'Currency to query. Omit for provider default.' },
      },
      required: [],
    },
    async handler(args, economic) {
      return economic.balance({
        currency: (args['currency'] as string | undefined) ?? 'USDC',
      });
    },
  },

  {
    name: 'invoice',
    description: 'Create a payment request (invoice) that can be settled via any provider.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount to invoice' },
        currency: { type: 'string', description: 'Currency code' },
        description: { type: 'string', description: 'What the invoice is for' },
        recipientWallet: { type: 'string', description: 'Recipient address or identifier' },
        dueDateIso: { type: 'string', description: 'Optional ISO 8601 due date (default: 24h from now)' },
      },
      required: ['amount', 'currency', 'description', 'recipientWallet'],
    },
    async handler(args, economic) {
      return economic.invoice({
        amount: args['amount'] as number,
        currency: args['currency'] as string,
        description: args['description'] as string,
        recipientWallet: args['recipientWallet'] as string,
        dueDateIso: args['dueDateIso'] as string | undefined,
      });
    },
  },

  {
    name: 'escrow',
    description: 'Lock funds in an escrow with a time-based expiry. ' +
      'A CC-native primitive: no single payment provider offers cross-provider escrow.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount to lock in escrow' },
        currency: { type: 'string', description: 'Currency code' },
        beneficiary: { type: 'string', description: 'Who can claim the funds' },
        condition: { type: 'string', description: 'Human-readable condition for release' },
        timeoutSeconds: { type: 'number', description: 'Seconds until escrow expires and funds are refunded' },
      },
      required: ['amount', 'currency', 'beneficiary', 'condition', 'timeoutSeconds'],
    },
    async handler(args, economic) {
      return economic.escrow({
        amount: args['amount'] as number,
        currency: args['currency'] as string,
        beneficiary: args['beneficiary'] as string,
        condition: args['condition'] as string,
        timeoutSeconds: args['timeoutSeconds'] as number,
      });
    },
  },

  {
    name: 'list_providers',
    description: 'List the names of all registered payment providers.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async handler(_args, _economic, router) {
      return { providers: router.listProviders() };
    },
  },

  {
    name: 'provider_status',
    description: 'Return health and balance information for each registered provider.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async handler(_args, _economic, router) {
      return router.providerStatus();
    },
  },

  // ----------------------------------------------------------
  // Escrow and Trust tools
  // ----------------------------------------------------------

  {
    name: 'create_escrow',
    description: 'Create a pre-work escrow that locks the buyer\'s funds before the seller begins work. ' +
      'The seller can verify the escrow is funded before committing effort. ' +
      'Funds release on completion or return to the buyer on timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount to lock in escrow' },
        currency: { type: 'string', description: 'Currency code (USDC, USD, ETH, USDT)' },
        beneficiaryAgentId: { type: 'string', description: 'CCAP agent ID of the seller' },
        completionCriteria: { type: 'string', description: 'What must happen for the escrow to release' },
        timeoutSeconds: { type: 'number', description: 'Seconds until escrow expires and refund triggers' },
        disputeResolutionMethod: {
          type: 'string',
          enum: ['arbitration_agent', 'multi_sig', 'automatic'],
          description: 'How disputes are resolved if raised',
        },
        arbitrationAgentId: { type: 'string', description: 'Arbitration agent ID (required for arbitration_agent method)' },
      },
      required: ['amount', 'currency', 'beneficiaryAgentId', 'completionCriteria', 'timeoutSeconds', 'disputeResolutionMethod'],
    },
    async handler(args, economic) {
      return economic.createEscrow({
        amount: args['amount'] as number,
        currency: args['currency'] as string,
        beneficiaryAgentId: args['beneficiaryAgentId'] as string,
        completionCriteria: args['completionCriteria'] as string,
        timeoutSeconds: args['timeoutSeconds'] as number,
        disputeResolutionMethod: args['disputeResolutionMethod'] as 'arbitration_agent' | 'multi_sig' | 'automatic',
        arbitrationAgentId: args['arbitrationAgentId'] as string | undefined,
      });
    },
  },

  {
    name: 'verify_escrow',
    description: 'Verify that an escrow exists and check its current status. ' +
      'Sellers SHOULD call this before starting work to confirm the escrow is funded.',
    inputSchema: {
      type: 'object',
      properties: {
        escrowId: { type: 'string', description: 'Escrow ID returned from create_escrow' },
      },
      required: ['escrowId'],
    },
    async handler(args, economic) {
      return economic.verifyEscrow(args['escrowId'] as string);
    },
  },

  {
    name: 'release_escrow',
    description: 'Release escrow funds to the beneficiary after work is complete. ' +
      'Funds transfer is atomic: either the full amount transfers or nothing moves.',
    inputSchema: {
      type: 'object',
      properties: {
        escrowId: { type: 'string', description: 'Escrow ID to release' },
        completionEvidence: { type: 'string', description: 'URL or description of the deliverable' },
      },
      required: ['escrowId'],
    },
    async handler(args, economic) {
      return economic.releaseEscrow(
        args['escrowId'] as string,
        args['completionEvidence'] as string | undefined,
      );
    },
  },

  {
    name: 'refund_escrow',
    description: 'Return escrow funds to the buyer. Valid only when status is created or funded. ' +
      'Occurs automatically on timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        escrowId: { type: 'string', description: 'Escrow ID to refund' },
        reason: { type: 'string', description: 'Reason for the refund' },
      },
      required: ['escrowId'],
    },
    async handler(args, economic) {
      return economic.refundEscrow(
        args['escrowId'] as string,
        args['reason'] as string | undefined,
      );
    },
  },

  {
    name: 'post_bond',
    description: 'Post a liability bond — a performance deposit locked as a costly signal. ' +
      'Posting a large bond signals competence: only an agent with a low private estimate of failure probability can afford to sustain bond posting over time.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Total bond amount to lock' },
        currency: { type: 'string', description: 'Currency code' },
        scope: {
          type: 'string',
          enum: ['legal_document_handling', 'financial_transaction_routing', 'email_processing', 'code_generation', 'code_deployment', 'general_purpose'],
          description: 'Category of operations the bond covers',
        },
        scopeDescription: { type: 'string', description: 'Human-readable description of covered operations' },
        durationSeconds: { type: 'number', description: 'How long the bond is active' },
        claimConditions: { type: 'string', description: 'What constitutes a valid claim against the bond' },
        maxClaimAmount: { type: 'number', description: 'Maximum amount claimable in a single claim' },
        arbitrationAgentId: { type: 'string', description: 'CCAP agent ID of the designated arbitrator' },
        humanEscalationThresholdUsd: { type: 'number', description: 'Claims above this amount require human review (default: 10000)' },
      },
      required: ['amount', 'currency', 'scope', 'scopeDescription', 'durationSeconds', 'claimConditions', 'maxClaimAmount', 'arbitrationAgentId'],
    },
    async handler(args, economic) {
      return economic.postBond({
        amount: args['amount'] as number,
        currency: args['currency'] as string,
        scope: args['scope'] as import('./types.js').BondScope,
        scopeDescription: args['scopeDescription'] as string,
        durationSeconds: args['durationSeconds'] as number,
        claimConditions: args['claimConditions'] as string,
        maxClaimAmount: args['maxClaimAmount'] as number,
        arbitrationAgentId: args['arbitrationAgentId'] as string,
        humanEscalationThresholdUsd: args['humanEscalationThresholdUsd'] as number | undefined,
      });
    },
  },

  {
    name: 'verify_bond',
    description: 'Check whether an agent has an active liability bond for a given scope. ' +
      'Clients SHOULD call this before engaging an agent for sensitive operations.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'CCAP agent ID to check' },
        scope: {
          type: 'string',
          enum: ['legal_document_handling', 'financial_transaction_routing', 'email_processing', 'code_generation', 'code_deployment', 'general_purpose'],
          description: 'Scope to check. Omit to check any active bond.',
        },
      },
      required: ['agentId'],
    },
    async handler(args, economic) {
      return economic.verifyBond(
        args['agentId'] as string,
        args['scope'] as import('./types.js').BondScope | undefined,
      );
    },
  },

  {
    name: 'claim_bond',
    description: 'Submit a claim against an agent\'s liability bond. ' +
      'Claims are placed under arbitration review — they are not automatically paid. ' +
      'Automatic payment without adjudication would create a griefing vector.',
    inputSchema: {
      type: 'object',
      properties: {
        bondId: { type: 'string', description: 'Bond ID to claim against' },
        claimedBy: { type: 'string', description: 'Agent ID of the claimant' },
        claimAmount: { type: 'number', description: 'Amount claimed' },
        description: { type: 'string', description: 'Description of the alleged damage' },
        evidenceUrl: { type: 'string', description: 'URL to supporting evidence' },
      },
      required: ['bondId', 'claimedBy', 'claimAmount', 'description'],
    },
    async handler(args, economic) {
      return economic.claimBond({
        bondId: args['bondId'] as string,
        claimedBy: args['claimedBy'] as string,
        claimAmount: args['claimAmount'] as number,
        description: args['description'] as string,
        evidenceUrl: args['evidenceUrl'] as string | undefined,
      });
    },
  },

  {
    name: 'get_credit_score',
    description: 'Query an agent\'s credit score. Returns a 0–1000 score with component breakdown. ' +
      'New agents start at 0; trust is earned from transaction history, not granted by default.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'CCAP agent ID to query' },
      },
      required: ['agentId'],
    },
    async handler(args, economic) {
      return economic.getCreditScore(args['agentId'] as string);
    },
  },
];

// ----------------------------------------------------------
// AgentMCPServer
// ----------------------------------------------------------

export class AgentMCPServer {
  private readonly server: Server;
  readonly capabilities = new Map<string, Capability>();

  constructor(
    private readonly safety: SafetyMonitor,
    private readonly audit: AuditLogger,
    private readonly economic: CCAPEconomic,
    private readonly router: PaymentRouter,
  ) {
    this.server = new Server(
      {
        name: process.env['CC_AGENT_ID'] ?? 'agent-starter',
        version: process.env['CC_AGENT_VERSION'] ?? '1.0.0',
      },
      {
        capabilities: { tools: {} },
      },
    );

    this.registerHandlers();
  }

  // ----------------------------------------------------------
  // Capability registration (domain-specific tools)
  // ----------------------------------------------------------

  registerCapability(capability: Capability): void {
    this.capabilities.set(capability.config.id, capability);
    logger.info('Capability registered', { id: capability.config.id });
  }

  // ----------------------------------------------------------
  // MCP protocol handlers
  // ----------------------------------------------------------

  private registerHandlers(): void {
    // List all tools: economic built-ins + registered capabilities
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const economicTools = ECONOMIC_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as {
          type: 'object';
          properties?: Record<string, unknown>;
          required?: string[];
        },
      }));

      const capabilityTools = Array.from(this.capabilities.values()).map((cap) => ({
        name: cap.config.id,
        description: `${cap.config.description} — Base cost: $${cap.config.pricing.baseCostUsd} USD`,
        inputSchema: cap.config.inputSchema as {
          type: 'object';
          properties?: Record<string, unknown>;
          required?: string[];
        },
      }));

      return { tools: [...economicTools, ...capabilityTools] };
    });

    // Dispatch a tool call
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (this.safety.isKillSwitchActive) {
        throw new McpError(ErrorCode.InternalError, 'Agent is in emergency stop mode');
      }

      const startTime = Date.now();

      // Check if it is an economic built-in tool
      const economicTool = ECONOMIC_TOOLS.find((t) => t.name === name);
      if (economicTool) {
        // Economic tools handle their own safety via the router/safety monitor
        this.audit.record('tool_call_started', { tool: name, args });
        try {
          const result = await economicTool.handler(
            args as Record<string, unknown>,
            this.economic,
            this.router,
          );
          this.audit.record('tool_call_completed', { tool: name, durationMs: Date.now() - startTime });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.audit.record('tool_call_failed', { tool: name, error: message });
          throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${message}`);
        }
      }

      // Check registered capability tools
      const capability = this.capabilities.get(name);
      if (!capability) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      // Safety check for capability invocations
      const safetyResult = await this.safety.checkOperation({
        type: 'tool_call',
        costUsd: capability.config.pricing.baseCostUsd,
        description: `Tool: ${name}`,
      });

      if (!safetyResult.allowed) {
        this.audit.record('tool_call_blocked', { tool: name, reason: safetyResult.reason });
        throw new McpError(
          ErrorCode.InternalError,
          `Safety check failed: ${safetyResult.reason}`,
        );
      }

      this.audit.record('tool_call_started', { tool: name, args });

      try {
        const result = await capability.execute(args as Record<string, unknown>);
        const durationMs = Date.now() - startTime;
        this.audit.record('tool_call_completed', { tool: name, durationMs });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.audit.record('tool_call_failed', { tool: name, error: message });
        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${message}`);
      }
    });
  }

  // ----------------------------------------------------------
  // Transport
  // ----------------------------------------------------------

  async connectStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('MCP server connected via stdio');
  }

  get mcpServer(): Server {
    return this.server;
  }

  listCapabilities(): CapabilitySummary[] {
    // Return both economic tools and domain capability tools
    const economicSummaries: CapabilitySummary[] = ECONOMIC_TOOLS.map((t) => ({
      id: t.name,
      name: t.name,
      description: t.description,
      version: '1.0.0',
      pricing: { model: 'per_call' as const, baseCostUsd: 0 },
      sla: { p95LatencyMs: 5000, availability: 0.999 },
    }));

    const capabilitySummaries: CapabilitySummary[] = Array.from(this.capabilities.values()).map((c) => ({
      id: c.config.id,
      name: c.config.name,
      description: c.config.description,
      version: c.config.version,
      pricing: c.config.pricing,
      sla: c.config.sla,
    }));

    return [...economicSummaries, ...capabilitySummaries];
  }
}

export interface CapabilitySummary {
  id: string;
  name: string;
  description: string;
  version: string;
  pricing: Capability['config']['pricing'];
  sla: Capability['config']['sla'];
}
