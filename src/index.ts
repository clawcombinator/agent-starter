// ============================================================
// Entry point — wires all components together and starts
// the Express HTTP server.
//
// Endpoints:
//   GET  /health          — health check (wallet, safety state)
//   GET  /capabilities    — list registered MCP tools
//   POST /mcp             — MCP protocol handler (JSON-RPC)
// ============================================================

import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import winston from 'winston';

import { AuditLogger } from './audit.js';
import { SafetyMonitor } from './safety.js';
import { AgentWallet } from './wallet.js';
import { AgentMCPServer } from './mcp-server.js';
import { CCAPEconomic } from './ccap/economic.js';
import { CCAPComposition } from './ccap/compose.js';
import { ExampleReviewCapability } from './capabilities/example-review.js';
import type { HealthResponse, SafetyConfig } from './types.js';

// ----------------------------------------------------------
// Logger
// ----------------------------------------------------------

const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.simple(),
  ),
  transports: [new winston.transports.Console()],
});

// ----------------------------------------------------------
// Bootstrap
// ----------------------------------------------------------

async function bootstrap(): Promise<void> {
  const startTime = Date.now();

  // 1. Audit log — initialised first so all subsequent actions are recorded
  const audit = new AuditLogger(process.env['AUDIT_LOG_PATH'] ?? './logs/audit.jsonl');
  audit.record('agent_start', { agentId: process.env['CC_AGENT_ID'] ?? 'unknown' });

  // 2. Safety config from env (with sensible defaults for development)
  const safetyConfig: SafetyConfig = {
    budget: {
      dailyLimitUsd: Number(process.env['DAILY_BUDGET_USD'] ?? 100),
      softLimitUsd: Number(process.env['DAILY_BUDGET_USD'] ?? 100) * 0.8,
      transactionLimitUsd: Number(process.env['TRANSACTION_LIMIT_USD'] ?? 500),
      humanApprovalThresholdUsd: Number(process.env['HUMAN_APPROVAL_THRESHOLD_USD'] ?? 1000),
    },
    rateLimits: {
      requestsPerMinute: Number(process.env['RATE_LIMIT_PER_MINUTE'] ?? 60),
      burstAllowance: Number(process.env['RATE_LIMIT_PER_MINUTE'] ?? 60) * 1.5,
    },
    escalation: {
      webhookUrls: (process.env['ESCALATION_WEBHOOKS'] ?? '')
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean),
      timeoutMinutes: 60,
    },
  };

  const safety = new SafetyMonitor(safetyConfig, audit);

  // 3. Wallet
  const wallet = new AgentWallet(
    process.env['COINBASE_API_KEY_NAME'] ?? '',
    process.env['COINBASE_API_KEY_PRIVATE_KEY'] ?? '',
    process.env['COINBASE_NETWORK'] ?? 'base-sepolia',
  );

  let walletConnected = false;
  try {
    await wallet.initialize();
    walletConnected = true;
    logger.info('Wallet initialised', { address: wallet.address });
    audit.record('wallet_initialised', { address: wallet.address });
  } catch (err) {
    logger.warn('Wallet failed to initialise — running without payment capability', {
      error: String(err),
    });
    audit.record('wallet_init_failed', { error: String(err) });
  }

  // 4. CCAP economic and composition layers
  const economic = new CCAPEconomic(
    wallet,
    safety,
    audit,
    process.env['CC_API_URL'] ?? 'https://api.clawcombinator.ai/v1',
  );

  const composition = new CCAPComposition(
    economic,
    audit,
    process.env['CC_API_URL'] ?? 'https://api.clawcombinator.ai/v1',
    process.env['CC_API_KEY'] ?? '',
  );

  // Silence unused-variable warning (composition available for future route handlers)
  void composition;

  // 5. MCP server — register capabilities
  const mcpServer = new AgentMCPServer(safety, audit);
  mcpServer.registerCapability(new ExampleReviewCapability());

  // 6. Express HTTP server
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger);

  // GET /health
  app.get('/health', (_req: Request, res: Response) => {
    const walletStatus = walletConnected
      ? { connected: true, address: wallet.address ?? undefined, network: process.env['COINBASE_NETWORK'] ?? 'base-sepolia' }
      : { connected: false };

    const body: HealthResponse = {
      status: safety.isKillSwitchActive ? 'error' : 'ok',
      version: process.env['CC_AGENT_VERSION'] ?? '1.0.0',
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      wallet: walletStatus,
      safety: {
        killSwitchActive: safety.isKillSwitchActive,
        dailySpendUsd: safety.dailySpendUsd,
        dailyBudgetUsd: safety.dailyBudgetUsd,
      },
      timestamp: new Date().toISOString(),
    };

    res.status(200).json(body);
  });

  // GET /capabilities
  app.get('/capabilities', (_req: Request, res: Response) => {
    res.json({ capabilities: mcpServer.listCapabilities() });
  });

  // POST /mcp — MCP JSON-RPC handler
  // The MCP SDK provides a built-in HTTP handler via StreamableHTTPServerTransport.
  // For the starter kit we implement a lightweight pass-through that handles
  // initialize / tools/list / tools/call directly.
  app.post('/mcp', safetyMiddleware(safety), async (req: Request, res: Response) => {
    try {
      // Delegate to the MCP server's internal handler.
      // In production wire up StreamableHTTPServerTransport from the SDK.
      const { method, params, id } = req.body as {
        method: string;
        params?: unknown;
        id?: unknown;
      };

      if (method === 'initialize') {
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: {
              name: process.env['CC_AGENT_ID'] ?? 'agent-starter',
              version: process.env['CC_AGENT_VERSION'] ?? '1.0.0',
            },
            capabilities: { tools: {} },
          },
        });
        return;
      }

      if (method === 'tools/list') {
        const tools = mcpServer.listCapabilities().map((c) => ({
          name: c.id,
          description: c.description,
          inputSchema: { type: 'object' },
        }));
        res.json({ jsonrpc: '2.0', id, result: { tools } });
        return;
      }

      if (method === 'tools/call') {
        const { name, arguments: args } = params as { name: string; arguments: Record<string, unknown> };

        const safetyResult = await safety.checkOperation({
          type: 'tool_call',
          costUsd: 0,
          description: `HTTP MCP call: ${name}`,
        });

        if (!safetyResult.allowed) {
          res.json({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: safetyResult.reason ?? 'Safety check failed' },
          });
          return;
        }

        // Dispatch to capability
        const caps = mcpServer.listCapabilities();
        const cap = caps.find((c) => c.id === name);
        if (!cap) {
          res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
          return;
        }

        // We need the actual capability instance for execution.
        const result = await mcpServer.capabilities.get(name)?.execute(args);

        res.json({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
        });
        return;
      }

      res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
    } catch (err) {
      logger.error('MCP handler error', { error: String(err) });
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err) } });
    }
  });

  // Global error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  const port = Number(process.env['PORT'] ?? 8080);
  app.listen(port, () => {
    logger.info(`CC Agent listening`, {
      port,
      agentId: process.env['CC_AGENT_ID'] ?? 'agent-starter',
      version: process.env['CC_AGENT_VERSION'] ?? '1.0.0',
    });
    audit.record('server_started', { port });
  });
}

// ----------------------------------------------------------
// Middleware
// ----------------------------------------------------------

function requestLogger(req: Request, _res: Response, next: NextFunction): void {
  logger.debug(`${req.method} ${req.path}`);
  next();
}

function safetyMiddleware(safety: SafetyMonitor) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (safety.isKillSwitchActive) {
      res.status(503).json({ error: 'Agent is in emergency stop mode' });
      return;
    }
    next();
  };
}

// ----------------------------------------------------------
// Run
// ----------------------------------------------------------

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
