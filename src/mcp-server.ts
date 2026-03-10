// ============================================================
// MCP Server — implements the Model Context Protocol using
// @modelcontextprotocol/sdk.
//
// Registers capabilities from the capabilities directory as
// MCP tools. Handles tool listing and tool-call dispatch.
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
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

export class AgentMCPServer {
  private readonly server: Server;
  readonly capabilities = new Map<string, Capability>();

  constructor(
    private readonly safety: SafetyMonitor,
    private readonly audit: AuditLogger,
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
  // Capability registration
  // ----------------------------------------------------------

  registerCapability(capability: Capability): void {
    this.capabilities.set(capability.config.id, capability);
    logger.info('Capability registered', { id: capability.config.id });
  }

  // ----------------------------------------------------------
  // MCP protocol handlers
  // ----------------------------------------------------------

  private registerHandlers(): void {
    // List all registered tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Array.from(this.capabilities.values()).map((cap) => ({
        name: cap.config.id,
        description: `${cap.config.description} — Base cost: $${cap.config.pricing.baseCostUsd} USD`,
        inputSchema: cap.config.inputSchema as {
          type: 'object';
          properties?: Record<string, unknown>;
          required?: string[];
        },
      }));

      return { tools };
    });

    // Dispatch a tool call to the matching capability
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Kill switch check
      if (this.safety.isKillSwitchActive) {
        throw new McpError(ErrorCode.InternalError, 'Agent is in emergency stop mode');
      }

      const capability = this.capabilities.get(name);
      if (!capability) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      // Safety check for tool invocation
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

      const startTime = Date.now();
      this.audit.record('tool_call_started', { tool: name, args });

      try {
        const result = await capability.execute(args as Record<string, unknown>);

        const durationMs = Date.now() - startTime;
        this.audit.record('tool_call_completed', { tool: name, durationMs });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
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

  /**
   * Connect to stdio transport (used when running as a subprocess MCP server).
   */
  async connectStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('MCP server connected via stdio');
  }

  /**
   * Return the underlying Server instance for use with HTTP transport.
   */
  get mcpServer(): Server {
    return this.server;
  }

  listCapabilities(): CapabilitySummary[] {
    return Array.from(this.capabilities.values()).map((c) => ({
      id: c.config.id,
      name: c.config.name,
      description: c.config.description,
      version: c.config.version,
      pricing: c.config.pricing,
      sla: c.config.sla,
    }));
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
