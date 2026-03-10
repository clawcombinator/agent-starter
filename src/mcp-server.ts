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
