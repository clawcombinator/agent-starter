// ============================================================
// Entry point — wires all components together and starts
// the Express HTTP server.
//
// Endpoints:
//   GET  /health          — health check (providers, safety state)
//   GET  /capabilities    — list registered MCP tools
//   POST /mcp             — MCP protocol handler (JSON-RPC)
//
// Provider initialisation is best-effort: if a provider's
// credentials are absent or invalid the agent still starts but
// that provider is simply not registered with the router.
// ============================================================

import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import winston from 'winston';

import { AuditLogger } from './audit.js';
import { SafetyMonitor } from './safety.js';
import { PaymentRouter } from './router.js';
import { CoinbaseProvider } from './providers/coinbase.js';
import { StripeProvider } from './providers/stripe.js';
import { X402Provider } from './providers/x402.js';
import { AgentMCPServer } from './mcp-server.js';
import { CCAPEconomic } from './ccap/economic.js';
import { CCAPComposition } from './ccap/compose.js';
import { ExampleReviewCapability } from './capabilities/example-review.js';
import { DurableStateStore } from './state-store.js';
import { VerificationWorker } from './verifier.js';
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
  const auditLogPath = process.env['AUDIT_LOG_PATH'] ?? './logs/audit.jsonl';
  const runtimeStatePath = process.env['CC_RUNTIME_STATE_PATH'] ?? './data/ccap-runtime-state.json';

  // 1. Audit log — initialised first so all subsequent actions are recorded
  const audit = new AuditLogger(auditLogPath, {
    anchorPath: process.env['CC_AUDIT_ANCHOR_PATH'],
    immutableSinkUrl: process.env['CC_AUDIT_IMMUTABLE_SINK_URL'],
  });
  audit.record('agent_start', { agentId: process.env['CC_AGENT_ID'] ?? 'unknown' });

  // 2. Safety config from env (with sensible defaults for development)
  const safetyConfig: SafetyConfig = {
    budget: {
      dailyLimitUsd: Number(process.env['DAILY_BUDGET_USD'] ?? 100),
      softLimitUsd: Number(process.env['DAILY_BUDGET_USD'] ?? 100) * 0.8,
      transactionLimitUsd: Number(process.env['TRANSACTION_LIMIT_USD'] ?? 50),
      humanApprovalThresholdUsd: Number(process.env['HUMAN_APPROVAL_THRESHOLD_USD'] ?? 75),
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
  const stateStore = new DurableStateStore(runtimeStatePath);
  const verificationWorker = new VerificationWorker(
    {
      verifierId: process.env['CC_VERIFIER_ID'] ?? 'clawcombinator_platform_verifier_v1',
      contractsDir: new URL('../contracts', import.meta.url).pathname,
      verifierKeyPath: process.env['CC_VERIFIER_KEY_PATH'] ?? './data/verifier-keypair.json',
      commandTimeoutMs: Number(process.env['CC_VERIFIER_COMMAND_TIMEOUT_MS'] ?? 600_000),
    },
    audit,
  );

  // 3. Payment router — the central routing layer
  const router = new PaymentRouter(safety, audit);

  // 4. Initialise providers (only if credentials are configured)
  //    Each is independent; one failing does not block the others.

  // --- Coinbase AgentKit (crypto payments) ---
  if (process.env['COINBASE_API_KEY_NAME'] && process.env['COINBASE_API_KEY_PRIVATE_KEY']) {
    const coinbase = new CoinbaseProvider(
      process.env['COINBASE_API_KEY_NAME'],
      process.env['COINBASE_API_KEY_PRIVATE_KEY'],
      process.env['COINBASE_NETWORK'] ?? 'base-sepolia',
    );
    try {
      await coinbase.initialize();
      router.registerProvider(coinbase);
      logger.info('Coinbase provider registered', { address: coinbase.address });
      audit.record('provider_initialised', { provider: 'coinbase', address: coinbase.address });
    } catch (err) {
      logger.warn('Coinbase provider failed to initialise', { error: String(err) });
      audit.record('provider_init_failed', { provider: 'coinbase', error: String(err) });
    }
  } else {
    logger.info('Coinbase provider skipped — COINBASE_API_KEY_NAME or COINBASE_API_KEY_PRIVATE_KEY not set');
  }

  // --- Stripe (card / bank-transfer payments) ---
  if (process.env['STRIPE_SECRET_KEY']) {
    const stripe = new StripeProvider(process.env['STRIPE_SECRET_KEY']);
    try {
      await stripe.initialize();
      router.registerProvider(stripe);
      logger.info('Stripe provider registered');
      audit.record('provider_initialised', { provider: 'stripe' });
    } catch (err) {
      logger.warn('Stripe provider failed to initialise', { error: String(err) });
      audit.record('provider_init_failed', { provider: 'stripe', error: String(err) });
    }
  } else {
    logger.info('Stripe provider skipped — STRIPE_SECRET_KEY not set');
  }

  // --- x402 (HTTP-native micropayments) ---
  if (process.env['X402_WALLET_ADDRESS'] && process.env['X402_PRIVATE_KEY']) {
    const x402 = new X402Provider(
      process.env['X402_WALLET_ADDRESS'],
      process.env['X402_PRIVATE_KEY'],
    );
    try {
      await x402.initialize();
      router.registerProvider(x402);
      logger.info('x402 provider registered');
      audit.record('provider_initialised', { provider: 'x402' });
    } catch (err) {
      logger.warn('x402 provider failed to initialise', { error: String(err) });
      audit.record('provider_init_failed', { provider: 'x402', error: String(err) });
    }
  } else {
    logger.info('x402 provider skipped — X402_WALLET_ADDRESS or X402_PRIVATE_KEY not set');
  }

  const ccApiBaseUrl = process.env['CC_API_URL'] ?? 'https://api.clawcombinator.ai';

  // 5. CCAP economic layer (router-backed)
  const economic = new CCAPEconomic(
    router,
    safety,
    audit,
    ccApiBaseUrl,
    stateStore,
  );

  // 6. CCAP composition layer (agent discovery and invocation)
  const composition = new CCAPComposition(
    economic,
    audit,
    ccApiBaseUrl,
    process.env['CC_API_KEY'] ?? '',
  );

  // Suppress unused-variable warning (composition available for future route handlers)
  void composition;

  // 7. MCP server — register capabilities and economic tools
  const mcpServer = new AgentMCPServer(safety, audit, economic, router, stateStore, verificationWorker);
  mcpServer.registerCapability(new ExampleReviewCapability());

  // 8. Express HTTP server
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger);

  // GET /health
  app.get('/health', async (_req: Request, res: Response) => {
    const providerNames = router.listProviders();

    const body: HealthResponse = {
      status: safety.isKillSwitchActive ? 'error' : 'ok',
      version: process.env['CC_AGENT_VERSION'] ?? '1.0.0',
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      providers: {
        count: providerNames.length,
        names: providerNames,
      },
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
  app.post('/mcp', safetyMiddleware(safety), async (req: Request, res: Response) => {
    try {
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
        const tools = mcpServer.listTools();
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

        const result = await mcpServer.executeTool(
          name,
          (args ?? {}) as Record<string, unknown>,
        );

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
      providers: router.listProviders(),
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
