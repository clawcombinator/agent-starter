// ============================================================
// MCP Server — implements the Model Context Protocol using
// @modelcontextprotocol/sdk and exposes both legacy economic
// tools and the newer ClawCombinator reference-stack tools.
// ============================================================

import crypto from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  AgentCardDocument,
  Capability,
  ContractVerifyResult,
  OutputContractDocument,
  VerificationStatus,
  VerificationTier,
} from './types.js';
import type { SafetyMonitor } from './safety.js';
import type { AuditLogger } from './audit.js';
import type { CCAPEconomic } from './ccap/economic.js';
import type { PaymentRouter } from './router.js';
import { settlementStatusAllowed, validateStructuredDeliverable } from './output-contracts.js';
import { getVerificationPolicy } from './verification-policy.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

const WORLD_SPEC_VERSION = '0.1.0';
const PUBLIC_WORLD_SPEC_URL = 'https://clawcombinator.ai/formal/category_spec.lean';
const PUBLIC_INVARIANTS_URL = 'https://clawcombinator.ai/feeds/invariants.json';
const LOCAL_WORLD_SPEC_FILE = new URL('../contracts/Contracts/CategorySpec.lean', import.meta.url);

interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  mutatesState?: boolean;
  handler(args: Record<string, unknown>): Promise<unknown>;
}

interface RegisteredAgentEntry {
  agentCard: AgentCardDocument;
  signature: string;
  registeredAt: string;
}

interface MutationCacheEntry {
  fingerprint: string;
  result: unknown;
  recordedAt: string;
}

interface ListedTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

interface EscrowVerificationRequirement {
  contractName: string;
  workflowClass?: string;
  verificationTier: VerificationTier;
  outputContractRef?: string;
  allowedStatuses: VerificationStatus[];
  settlementMode: 'automatic' | 'manual';
}

export class AgentMCPServer {
  private readonly server: Server;
  readonly capabilities = new Map<string, Capability>();
  private readonly tools: ToolDefinition[];
  private readonly toolIndex = new Map<string, ToolDefinition>();
  private readonly mutationCache = new Map<string, MutationCacheEntry>();
  private readonly agentRegistry = new Map<string, RegisteredAgentEntry>();
  private readonly escrowVerificationRequirements = new Map<string, EscrowVerificationRequirement>();
  private readonly escrowVerificationResults = new Map<string, ContractVerifyResult>();

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

    this.tools = this.buildTools();
    for (const tool of this.tools) {
      this.toolIndex.set(tool.name, tool);
    }

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
  // Public helpers shared by stdio MCP and HTTP JSON-RPC
  // ----------------------------------------------------------

  listTools(): ListedTool[] {
    const builtIns = this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    const capabilityTools = Array.from(this.capabilities.values()).map((capability) => ({
      name: capability.config.id,
      description: `${capability.config.description} — Base cost: $${capability.config.pricing.baseCostUsd} USD`,
      inputSchema: capability.config.inputSchema as ToolInputSchema,
    }));

    return [...builtIns, ...capabilityTools];
  }

  async executeTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.safety.isKillSwitchActive) {
      throw new McpError(ErrorCode.InternalError, 'Agent is in emergency stop mode');
    }

    const startTime = Date.now();
    const tool = this.toolIndex.get(name);
    if (tool) {
      this.audit.record('tool_call_started', { tool: name, args });
      try {
        const result = tool.mutatesState
          ? await this.executeMutationTool(tool, name, args)
          : await tool.handler(args);
        this.audit.record('tool_call_completed', { tool: name, durationMs: Date.now() - startTime });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.audit.record('tool_call_failed', { tool: name, error: message });
        if (err instanceof McpError) {
          throw err;
        }
        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${message}`);
      }
    }

    const capability = this.capabilities.get(name);
    if (!capability) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

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
      const result = await capability.execute(args);
      this.audit.record('tool_call_completed', { tool: name, durationMs: Date.now() - startTime });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit.record('tool_call_failed', { tool: name, error: message });
      throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${message}`);
    }
  }

  // ----------------------------------------------------------
  // MCP protocol handlers
  // ----------------------------------------------------------

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.listTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const result = await this.executeTool(name, args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    });
  }

  // ----------------------------------------------------------
  // Tool catalogue
  // ----------------------------------------------------------

  private buildTools(): ToolDefinition[] {
    return [
      {
        name: 'pay',
        description:
          'Route a payment through the best available provider. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: ['amount', 'currency', 'recipientWallet', 'memo', 'nonce'],
          properties: {
            amount: { type: 'number', description: 'Amount to pay in the given currency' },
            currency: { type: 'string', description: 'Currency code, e.g. USDC, USD, ETH' },
            recipientWallet: { type: 'string', description: 'Recipient address, customer ID, or URL' },
            memo: { type: 'string', description: 'Payment description' },
            method: {
              type: 'string',
              enum: ['crypto', 'card', 'x402', 'bank_transfer'],
              description: 'Payment method. Omit to let the router choose.',
            },
            invoiceId: { type: 'string', description: 'Optional invoice ID to link this payment to' },
            nonce: { type: 'string', description: 'Replay-safe nonce for this mutation' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.economic.pay({
            amount: args['amount'] as number,
            currency: args['currency'] as string,
            recipientWallet: args['recipientWallet'] as string,
            memo: args['memo'] as string,
            method: args['method'] as 'crypto' | 'card' | 'x402' | 'bank_transfer' | undefined,
            invoiceId: args['invoiceId'] as string | undefined,
          }),
      },
      {
        name: 'balance',
        description: 'Return the balance across all configured payment providers.',
        inputSchema: {
          type: 'object',
          properties: {
            currency: { type: 'string', description: 'Currency to query. Omit for provider default.' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.economic.balance({
            currency: (args['currency'] as string | undefined) ?? 'USDC',
          }),
      },
      {
        name: 'invoice',
        description: 'Create a payment request. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: ['amount', 'currency', 'description', 'recipientWallet', 'nonce'],
          properties: {
            amount: { type: 'number', description: 'Amount to invoice' },
            currency: { type: 'string', description: 'Currency code' },
            description: { type: 'string', description: 'What the invoice is for' },
            recipientWallet: { type: 'string', description: 'Recipient address or identifier' },
            dueDateIso: { type: 'string', description: 'Optional ISO 8601 due date (default: 24h from now)' },
            nonce: { type: 'string', description: 'Replay-safe nonce for this mutation' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.economic.invoice({
            amount: args['amount'] as number,
            currency: args['currency'] as string,
            description: args['description'] as string,
            recipientWallet: args['recipientWallet'] as string,
            dueDateIso: args['dueDateIso'] as string | undefined,
          }),
      },
      {
        name: 'escrow',
        description:
          'Create a simple time-locked escrow. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: ['amount', 'currency', 'beneficiary', 'condition', 'timeoutSeconds', 'nonce'],
          properties: {
            amount: { type: 'number', description: 'Amount to lock in escrow' },
            currency: { type: 'string', description: 'Currency code' },
            beneficiary: { type: 'string', description: 'Who can claim the funds' },
            condition: { type: 'string', description: 'Human-readable condition for release' },
            timeoutSeconds: { type: 'number', description: 'Seconds until escrow expires' },
            nonce: { type: 'string', description: 'Replay-safe nonce for this mutation' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.economic.escrow({
            amount: args['amount'] as number,
            currency: args['currency'] as string,
            beneficiary: args['beneficiary'] as string,
            condition: args['condition'] as string,
            timeoutSeconds: args['timeoutSeconds'] as number,
          }),
      },
      {
        name: 'list_providers',
        description: 'List the names of all registered payment providers.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
        handler: async () => ({ providers: this.router.listProviders() }),
      },
      {
        name: 'provider_status',
        description: 'Return health and balance information for each registered provider.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
        },
        handler: async () => this.router.providerStatus(),
      },
      {
        name: 'create_escrow',
        description:
          'Create an escrow record without funding it yet. Use fund_escrow before release. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: [
            'amount',
            'currency',
            'beneficiaryAgentId',
            'completionCriteria',
            'timeoutSeconds',
            'disputeResolutionMethod',
            'nonce',
          ],
          properties: {
            amount: { type: 'number', description: 'Amount to lock in escrow' },
            currency: { type: 'string', description: 'Currency code (USDC, USD, ETH, USDT)' },
            buyerAgentId: { type: 'string', description: 'CCAP agent ID of the buyer' },
            beneficiaryAgentId: { type: 'string', description: 'CCAP agent ID of the seller' },
            completionCriteria: { type: 'string', description: 'What must happen for the escrow to release' },
            timeoutSeconds: { type: 'number', description: 'Seconds until escrow expires and refund triggers' },
            disputeResolutionMethod: {
              type: 'string',
              enum: ['arbitration_agent', 'multi_sig', 'automatic'],
              description: 'How disputes are resolved if raised',
            },
            arbitrationAgentId: { type: 'string', description: 'Arbitration agent ID' },
            nonce: { type: 'string', description: 'Replay-safe nonce for this mutation' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.economic.createEscrow({
            amount: args['amount'] as number,
            currency: args['currency'] as string,
            buyerAgentId: args['buyerAgentId'] as string | undefined,
            beneficiaryAgentId: args['beneficiaryAgentId'] as string,
            completionCriteria: args['completionCriteria'] as string,
            timeoutSeconds: args['timeoutSeconds'] as number,
            disputeResolutionMethod: args['disputeResolutionMethod'] as 'arbitration_agent' | 'multi_sig' | 'automatic',
            arbitrationAgentId: args['arbitrationAgentId'] as string | undefined,
            idempotencyKey: args['nonce'] as string,
          }),
      },
      {
        name: 'fund_escrow',
        description:
          'Fund a previously created escrow so settlement can proceed. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: ['escrowId', 'nonce'],
          properties: {
            escrowId: { type: 'string', description: 'Escrow ID returned from create_escrow' },
            buyerAgentId: { type: 'string', description: 'Optional buyer agent ID override' },
            nonce: { type: 'string', description: 'Replay-safe nonce for this mutation' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.economic.fundEscrow(
            args['escrowId'] as string,
            args['buyerAgentId'] as string | undefined,
          ),
      },
      {
        name: 'verify_escrow',
        description:
          'Verify that an escrow exists and check its current status. Sellers should call this before starting work.',
        inputSchema: {
          type: 'object',
          required: ['escrowId'],
          properties: {
            escrowId: { type: 'string', description: 'Escrow ID returned from create_escrow' },
          },
          additionalProperties: false,
        },
        handler: async (args) => this.economic.verifyEscrow(args['escrowId'] as string),
      },
      {
        name: 'release_escrow',
        description:
          'Release funded escrow to the beneficiary. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: ['escrowId', 'nonce'],
          properties: {
            escrowId: { type: 'string', description: 'Escrow ID to release' },
            completionEvidence: { type: 'string', description: 'URL or description of the deliverable' },
            manualReviewRef: {
              type: 'string',
              description:
                'Required when the workflow policy marks settlement as manual.',
            },
            nonce: { type: 'string', description: 'Replay-safe nonce for this mutation' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.releaseEscrowWithVerification(
            args['escrowId'] as string,
            args['completionEvidence'] as string | undefined,
            args['manualReviewRef'] as string | undefined,
          ),
      },
      {
        name: 'refund_escrow',
        description:
          'Return escrow funds to the buyer. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: ['escrowId', 'nonce'],
          properties: {
            escrowId: { type: 'string', description: 'Escrow ID to refund' },
            reason: { type: 'string', description: 'Reason for the refund' },
            nonce: { type: 'string', description: 'Replay-safe nonce for this mutation' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.economic.refundEscrow(
            args['escrowId'] as string,
            args['reason'] as string | undefined,
          ),
      },
      {
        name: 'post_bond',
        description:
          'Post a liability bond as a costly signal. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: [
            'amount',
            'currency',
            'scope',
            'scopeDescription',
            'durationSeconds',
            'claimConditions',
            'maxClaimAmount',
            'arbitrationAgentId',
            'nonce',
          ],
          properties: {
            agentId: { type: 'string', description: 'CCAP agent ID that owns the bond' },
            amount: { type: 'number', description: 'Total bond amount to lock' },
            currency: { type: 'string', description: 'Currency code' },
            scope: {
              type: 'string',
              enum: [
                'legal_document_handling',
                'financial_transaction_routing',
                'email_processing',
                'code_generation',
                'code_deployment',
                'general_purpose',
              ],
              description: 'Category of operations the bond covers',
            },
            scopeDescription: { type: 'string', description: 'Human-readable description of covered operations' },
            durationSeconds: { type: 'number', description: 'How long the bond is active' },
            claimConditions: { type: 'string', description: 'What constitutes a valid claim against the bond' },
            maxClaimAmount: { type: 'number', description: 'Maximum amount claimable in a single claim' },
            arbitrationAgentId: { type: 'string', description: 'CCAP agent ID of the designated arbitrator' },
            humanEscalationThresholdUsd: { type: 'number', description: 'Claims above this amount require human review' },
            nonce: { type: 'string', description: 'Replay-safe nonce for this mutation' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.economic.postBond({
            agentId: args['agentId'] as string | undefined,
            amount: args['amount'] as number,
            currency: args['currency'] as string,
            scope: args['scope'] as import('./types.js').BondScope,
            scopeDescription: args['scopeDescription'] as string,
            durationSeconds: args['durationSeconds'] as number,
            claimConditions: args['claimConditions'] as string,
            maxClaimAmount: args['maxClaimAmount'] as number,
            arbitrationAgentId: args['arbitrationAgentId'] as string,
            humanEscalationThresholdUsd: args['humanEscalationThresholdUsd'] as number | undefined,
            idempotencyKey: args['nonce'] as string,
          }),
      },
      {
        name: 'verify_bond',
        description:
          'Check whether an agent has an active liability bond for a given scope.',
        inputSchema: {
          type: 'object',
          required: ['agentId'],
          properties: {
            agentId: { type: 'string', description: 'CCAP agent ID to check' },
            scope: {
              type: 'string',
              enum: [
                'legal_document_handling',
                'financial_transaction_routing',
                'email_processing',
                'code_generation',
                'code_deployment',
                'general_purpose',
              ],
              description: 'Scope to check. Omit to check any active bond.',
            },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.economic.verifyBond(
            args['agentId'] as string,
            args['scope'] as import('./types.js').BondScope | undefined,
          ),
      },
      {
        name: 'claim_bond',
        description:
          'Submit a claim against an agent liability bond. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: ['bondId', 'claimedBy', 'claimAmount', 'description', 'nonce'],
          properties: {
            bondId: { type: 'string', description: 'Bond ID to claim against' },
            claimedBy: { type: 'string', description: 'Agent ID of the claimant' },
            claimAmount: { type: 'number', description: 'Amount claimed' },
            description: { type: 'string', description: 'Description of the alleged damage' },
            evidenceUrl: { type: 'string', description: 'URL to supporting evidence' },
            nonce: { type: 'string', description: 'Replay-safe nonce for this mutation' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.economic.claimBond({
            bondId: args['bondId'] as string,
            claimedBy: args['claimedBy'] as string,
            claimAmount: args['claimAmount'] as number,
            description: args['description'] as string,
            evidenceUrl: args['evidenceUrl'] as string | undefined,
            idempotencyKey: args['nonce'] as string,
          }),
      },
      {
        name: 'get_credit_score',
        description:
          'Query an agent credit score. Returns a 0-1000 score with component breakdown.',
        inputSchema: {
          type: 'object',
          required: ['agentId'],
          properties: {
            agentId: { type: 'string', description: 'CCAP agent ID to query' },
          },
          additionalProperties: false,
        },
        handler: async (args) => this.economic.getCreditScore(args['agentId'] as string),
      },
      {
        name: 'read_world_spec',
        description:
          'Load the canonical world-spec root and return the published URLs plus the local proof-checkable source path.',
        inputSchema: {
          type: 'object',
          properties: {
            spec_version: { type: 'string', description: 'Requested world-spec version' },
          },
          additionalProperties: false,
        },
        handler: async (args) => this.readWorldSpec(args['spec_version']),
      },
      {
        name: 'agent_register',
        description:
          'Register an Agent Card in the local starter-kit registry. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: ['agent_card', 'nonce', 'signature', 'spec_version'],
          properties: {
            agent_card: { type: 'object', description: 'Agent Card payload matching the public schema' },
            nonce: { type: 'string', description: 'Replay-safe nonce for this mutation' },
            signature: { type: 'string', description: 'Detached signature over the agent card payload' },
            spec_version: { type: 'string', description: 'World-spec version targeted by the card' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.registerAgent(
            args['agent_card'] as AgentCardDocument,
            args['signature'] as string,
            args['spec_version'] as string,
          ),
      },
      {
        name: 'agent_discover',
        description:
          'Discover locally registered agents by capability, contract shape, and reputation floor.',
        inputSchema: {
          type: 'object',
          properties: {
            capability: { type: 'string' },
            input_type: { type: 'string' },
            output_type: { type: 'string' },
            min_reputation_score: { type: 'integer', minimum: 0 },
            spec_version: { type: 'string' },
          },
          additionalProperties: false,
        },
        handler: async (args) => this.discoverAgents(args),
      },
      {
        name: 'escrow_lock',
        description:
          'Create and fund an escrow in one canonical reference-stack call. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: [
            'buyer_agent_id',
            'beneficiary_agent_id',
            'amount_usd_cents',
            'contract_name',
            'completion_criteria',
            'nonce',
            'spec_version',
          ],
          properties: {
            buyer_agent_id: { type: 'string' },
            beneficiary_agent_id: { type: 'string' },
            amount_usd_cents: { type: 'integer', minimum: 0 },
            contract_name: { type: 'string' },
            completion_criteria: { type: 'string' },
            timeout_seconds: { type: 'integer', minimum: 1 },
            dispute_resolution_method: {
              type: 'string',
              enum: ['arbitration_agent', 'multi_sig', 'automatic'],
            },
            arbitration_agent_id: { type: 'string' },
            workflow_class: { type: 'string' },
            verification_tier: {
              type: 'string',
              enum: ['proof', 'replayableTest', 'quorum'],
            },
            output_contract_ref: { type: 'string' },
            nonce: { type: 'string' },
            spec_version: { type: 'string' },
          },
          additionalProperties: false,
        },
        handler: async (args) => {
          this.assertSupportedSpecVersion(args['spec_version']);
          const workflowClass = args['workflow_class'] as string | undefined;
          const policy = workflowClass ? getVerificationPolicy(workflowClass) : undefined;
          const declaredTier =
            (args['verification_tier'] as VerificationTier | undefined) ??
            policy?.required_tier ??
            'replayableTest';

          if (policy && declaredTier !== policy.required_tier) {
            throw new Error(
              `workflow_class '${workflowClass}' requires verification_tier '${policy.required_tier}'`,
            );
          }

          const created = await this.economic.createEscrow({
            amount: Number(args['amount_usd_cents']) / 100,
            currency: 'USD',
            buyerAgentId: args['buyer_agent_id'] as string,
            beneficiaryAgentId: args['beneficiary_agent_id'] as string,
            completionCriteria: `${args['contract_name'] as string}: ${args['completion_criteria'] as string}`,
            timeoutSeconds: Number(args['timeout_seconds'] ?? 86_400),
            disputeResolutionMethod: (args['dispute_resolution_method'] as 'arbitration_agent' | 'multi_sig' | 'automatic' | undefined) ?? 'automatic',
            arbitrationAgentId: args['arbitration_agent_id'] as string | undefined,
            idempotencyKey: args['nonce'] as string,
          });
          this.escrowVerificationRequirements.set(created.escrowId, {
            contractName: args['contract_name'] as string,
            workflowClass,
            verificationTier: declaredTier,
            outputContractRef: args['output_contract_ref'] as string | undefined,
            allowedStatuses: this.allowedStatusesForTier(
              declaredTier,
              policy?.passing_status,
            ),
            settlementMode: policy?.settlement_mode ?? 'automatic',
          });
          const funded = await this.economic.fundEscrow(
            created.escrowId,
            args['buyer_agent_id'] as string,
          );
          return {
            escrow_id: funded.escrowId,
            status: funded.status,
            funded: true,
            expires_at: created.expiresAt,
            transaction_id: funded.transactionId,
            verification_tier: declaredTier,
            output_contract_ref: args['output_contract_ref'] ?? null,
          };
        },
      },
      {
        name: 'bond_post',
        description:
          'Post a canonical reference-stack bond. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: [
            'agent_id',
            'amount_usd_cents',
            'scope',
            'claim_conditions',
            'nonce',
            'spec_version',
          ],
          properties: {
            agent_id: { type: 'string' },
            amount_usd_cents: { type: 'integer', minimum: 0 },
            scope: { type: 'string' },
            duration_hours: { type: 'integer', minimum: 1 },
            claim_conditions: { type: 'string' },
            nonce: { type: 'string' },
            spec_version: { type: 'string' },
          },
          additionalProperties: false,
        },
        handler: async (args) => {
          this.assertSupportedSpecVersion(args['spec_version']);
          const result = await this.economic.postBond({
            agentId: args['agent_id'] as string,
            amount: Number(args['amount_usd_cents']) / 100,
            currency: 'USD',
            scope: this.parseBondScope(args['scope']),
            scopeDescription: `Canonical bond scope: ${args['scope'] as string}`,
            durationSeconds: Number(args['duration_hours'] ?? 24) * 60 * 60,
            claimConditions: args['claim_conditions'] as string,
            maxClaimAmount: Number(args['amount_usd_cents']) / 100,
            arbitrationAgentId: args['agent_id'] as string,
            idempotencyKey: args['nonce'] as string,
          });
          return {
            bond_id: result.bondId,
            status: result.status,
            posted_at: result.activeFrom,
            transaction_id: result.transactionId,
          };
        },
      },
      {
        name: 'contract_verify',
        description:
          'Evaluate whether a contract subject satisfies the declared verification tier.',
        inputSchema: {
          type: 'object',
          required: [
            'contract_name',
            'subject_type',
            'subject_ref',
            'verification_tier',
            'spec_version',
          ],
          properties: {
            contract_name: { type: 'string' },
            subject_type: { type: 'string' },
            subject_ref: { type: 'string' },
            escrow_id: { type: 'string' },
            verification_tier: {
              type: 'string',
              enum: ['proof', 'replayableTest', 'quorum'],
            },
            output_contract_ref: { type: 'string' },
            output_contract: {
              type: 'object',
              description:
                'Structured output-contract document aligned to output-contract.schema.json',
            },
            subject_payload: {
              description:
                'Structured deliverable to validate against output_contract.deliverable_schema',
            },
            evidence_refs: {
              type: 'array',
              items: { type: 'string' },
            },
            spec_version: { type: 'string' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.contractVerify({
            contract_name: args['contract_name'] as string,
            subject_type: args['subject_type'] as string,
            subject_ref: args['subject_ref'] as string,
            escrow_id: args['escrow_id'] as string | undefined,
            verification_tier: args['verification_tier'] as VerificationTier,
            output_contract_ref: args['output_contract_ref'] as string | undefined,
            output_contract: args['output_contract'] as OutputContractDocument | undefined,
            subject_payload: args['subject_payload'],
            evidence_refs: (args['evidence_refs'] as string[] | undefined) ?? [],
            spec_version: args['spec_version'] as string,
          }),
      },
      {
        name: 'reputation_score',
        description:
          'Return a canonical reputation view for an agent, including active bond capacity.',
        inputSchema: {
          type: 'object',
          required: ['agent_id', 'spec_version'],
          properties: {
            agent_id: { type: 'string' },
            spec_version: { type: 'string' },
          },
          additionalProperties: false,
        },
        handler: async (args) => {
          this.assertSupportedSpecVersion(args['spec_version']);
          const agentId = args['agent_id'] as string;
          const score = this.economic.getCreditScore(agentId);
          const bondCapacityUsdCents = Math.round(
            this.economic
              .listBonds(agentId)
              .filter((bond) => bond.status === 'active')
              .reduce((sum, bond) => sum + bond.remainingAmount, 0) * 100,
          );

          return {
            agent_id: agentId,
            reputation_score: score.score,
            bond_capacity_usd_cents: bondCapacityUsdCents,
            last_updated: score.computedAt,
            tier: score.tier,
          };
        },
      },
      {
        name: 'open_dispute',
        description:
          'Open a dispute on an escrow and move it into disputed state. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: ['escrow_id', 'claimant_agent_id', 'reason', 'nonce', 'spec_version'],
          properties: {
            escrow_id: { type: 'string' },
            claimant_agent_id: { type: 'string' },
            reason: { type: 'string' },
            evidence_refs: {
              type: 'array',
              items: { type: 'string' },
            },
            nonce: { type: 'string' },
            spec_version: { type: 'string' },
          },
          additionalProperties: false,
        },
        handler: async (args) => {
          this.assertSupportedSpecVersion(args['spec_version']);
          const dispute = await this.economic.openDispute({
            escrowId: args['escrow_id'] as string,
            claimantAgentId: args['claimant_agent_id'] as string,
            reason: args['reason'] as string,
            evidenceRefs: (args['evidence_refs'] as string[] | undefined) ?? [],
            idempotencyKey: args['nonce'] as string,
          });
          return {
            dispute_id: dispute.disputeId,
            status: dispute.status,
            dispute_record_type: dispute.disputeRecordType,
            opened_at: dispute.openedAt,
          };
        },
      },
    ];
  }

  // ----------------------------------------------------------
  // Internal tool helpers
  // ----------------------------------------------------------

  private async executeMutationTool(
    tool: ToolDefinition,
    requestedName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const nonce = this.readMutationNonce(args);
    if (!nonce) {
      throw new Error(`Tool ${requestedName} requires a nonce or idempotencyKey`);
    }

    const cacheKey = `${requestedName}:${nonce}`;
    const fingerprint = this.stableStringify(args);
    const cached = this.mutationCache.get(cacheKey);

    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new Error(`Nonce replay mismatch for tool ${requestedName}: payload differs from the original call`);
      }
      this.audit.record('tool_call_replayed', { tool: requestedName, nonce, recordedAt: cached.recordedAt });
      return cached.result;
    }

    const result = await tool.handler(args);
    this.mutationCache.set(cacheKey, {
      fingerprint,
      result,
      recordedAt: new Date().toISOString(),
    });
    return result;
  }

  private readMutationNonce(args: Record<string, unknown>): string | undefined {
    for (const field of ['nonce', 'idempotencyKey']) {
      const value = args[field];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }
    return undefined;
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }

    const objectValue = value as Record<string, unknown>;
    const pairs = Object.keys(objectValue)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${this.stableStringify(objectValue[key])}`);
    return `{${pairs.join(',')}}`;
  }

  private async readWorldSpec(requestedVersion: unknown): Promise<Record<string, unknown>> {
    if (requestedVersion !== undefined) {
      this.assertSupportedSpecVersion(requestedVersion);
    }

    const contents = await readFile(LOCAL_WORLD_SPEC_FILE, 'utf8');
    const contentSha256 = crypto.createHash('sha256').update(contents).digest('hex');

    return {
      spec_version: WORLD_SPEC_VERSION,
      world_spec_url: PUBLIC_WORLD_SPEC_URL,
      world_spec_path: fileURLToPath(LOCAL_WORLD_SPEC_FILE),
      invariants_url: PUBLIC_INVARIANTS_URL,
      content_sha256: contentSha256,
      bytes: Buffer.byteLength(contents, 'utf8'),
    };
  }

  private async registerAgent(
    agentCard: AgentCardDocument,
    signature: string,
    specVersion: string,
  ): Promise<Record<string, unknown>> {
    this.assertSupportedSpecVersion(specVersion);

    if (!agentCard || typeof agentCard !== 'object') {
      throw new Error('agent_card must be an object');
    }
    if (typeof signature !== 'string' || signature.trim().length === 0) {
      throw new Error('signature is required');
    }
    if (agentCard.spec_version !== specVersion || agentCard.contract.spec_version !== specVersion) {
      throw new Error('agent_card spec_version does not match requested spec_version');
    }
    if (!agentCard.agent_id || !agentCard.contract?.name) {
      throw new Error('agent_card is missing required identity or contract fields');
    }

    const registeredAt = new Date().toISOString();
    this.agentRegistry.set(agentCard.agent_id, {
      agentCard,
      signature,
      registeredAt,
    });

    this.audit.record('agent_registered', {
      agentId: agentCard.agent_id,
      capability: agentCard.capability,
      contractName: agentCard.contract.name,
      registeredAt,
    });

    return {
      agent_id: agentCard.agent_id,
      registration_status: 'registered',
      spec_version: specVersion,
    };
  }

  private async discoverAgents(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestedVersion = args['spec_version'] as string | undefined;
    if (requestedVersion) {
      this.assertSupportedSpecVersion(requestedVersion);
    }

    const capability = args['capability'] as string | undefined;
    const inputType = args['input_type'] as string | undefined;
    const outputType = args['output_type'] as string | undefined;
    const minReputation = Number(args['min_reputation_score'] ?? 0);

    const results = Array.from(this.agentRegistry.values())
      .map((entry) => entry.agentCard)
      .filter((card) => (requestedVersion ? card.spec_version === requestedVersion : true))
      .filter((card) => (capability ? card.capability === capability : true))
      .filter((card) => (inputType ? card.contract.input_type === inputType : true))
      .filter((card) => (outputType ? card.contract.output_type === outputType : true))
      .filter((card) => card.reputation_score >= minReputation)
      .sort((left, right) => right.reputation_score - left.reputation_score)
      .map((card) => ({
        agent_id: card.agent_id,
        reputation_score: card.reputation_score,
        bond_capacity_usd_cents: card.bond_capacity_usd_cents,
        agent_card: card,
        compatibility: {
          compatible: true,
          matched_fields: [
            ...(capability ? ['capability'] : []),
            ...(inputType ? ['input_type'] : []),
            ...(outputType ? ['output_type'] : []),
            ...(requestedVersion ? ['spec_version'] : []),
          ],
          requested_capability: capability ?? null,
          requested_input_type: inputType ?? null,
          requested_output_type: outputType ?? null,
          requested_spec_version: requestedVersion ?? null,
        },
      }));

    return { results };
  }

  private async contractVerify(args: {
    contract_name: string;
    subject_type: string;
    subject_ref: string;
    escrow_id?: string;
    verification_tier: VerificationTier;
    output_contract_ref?: string;
    output_contract?: OutputContractDocument;
    subject_payload?: unknown;
    evidence_refs: string[];
    spec_version: string;
  }): Promise<ContractVerifyResult> {
    this.assertSupportedSpecVersion(args.spec_version);

    const evidenceRefs = args.evidence_refs ?? [];
    const requirement = args.escrow_id
      ? this.escrowVerificationRequirements.get(args.escrow_id)
      : undefined;

    if (requirement && args.contract_name !== requirement.contractName) {
      throw new Error(
        `Escrow ${args.escrow_id} is bound to contract '${requirement.contractName}', not '${args.contract_name}'`,
      );
    }
    if (requirement && args.verification_tier !== requirement.verificationTier) {
      throw new Error(
        `Escrow ${args.escrow_id} requires verification_tier '${requirement.verificationTier}'`,
      );
    }

    const localWorldSpecPath = fileURLToPath(LOCAL_WORLD_SPEC_FILE);
    const subjectLooksLikeWorldSpec =
      args.subject_ref === PUBLIC_WORLD_SPEC_URL ||
      args.subject_ref === localWorldSpecPath ||
      args.subject_ref.endsWith('CategorySpec.lean');

    let status: VerificationStatus;
    let evidenceRef: string;

    if (args.output_contract) {
      this.assertOutputContract(args.output_contract, args.contract_name, args.spec_version);

      if (args.output_contract.verification_tier !== args.verification_tier) {
        throw new Error(
          `output_contract '${args.output_contract.contract_id}' requires verification_tier '${args.output_contract.verification_tier}'`,
        );
      }
      if (args.subject_payload === undefined) {
        throw new Error('subject_payload is required when output_contract is provided');
      }
      if (
        requirement?.outputContractRef &&
        args.output_contract.contract_id !== requirement.outputContractRef &&
        args.output_contract_ref !== requirement.outputContractRef
      ) {
        throw new Error(
          `Escrow ${args.escrow_id} requires output_contract_ref '${requirement.outputContractRef}'`,
        );
      }

      const validation = validateStructuredDeliverable(
        args.output_contract,
        args.subject_payload,
      );
      status = validation.valid ? 'validated' : 'rejected';
      evidenceRef = validation.evidenceRef;

      if (args.escrow_id) {
        this.escrowVerificationRequirements.set(args.escrow_id, {
          contractName: args.contract_name,
          workflowClass: requirement?.workflowClass ?? args.output_contract.workflow_class,
          verificationTier: args.verification_tier,
          outputContractRef: args.output_contract_ref ?? args.output_contract.contract_id,
          allowedStatuses: args.output_contract.settlement_rules.required_verification_statuses,
          settlementMode: requirement?.settlementMode ?? 'automatic',
        });
      }
    } else if (args.verification_tier === 'proof') {
      const proofEvidence = evidenceRefs.find((ref) => ref.startsWith('lean:') || ref.startsWith('proof:'));
      if (proofEvidence || subjectLooksLikeWorldSpec) {
        status = 'proven';
        evidenceRef = proofEvidence ?? PUBLIC_WORLD_SPEC_URL;
      } else {
        status = 'resourceHit';
        evidenceRef = evidenceRefs[0] ?? 'proof-pending';
      }
    } else if (args.verification_tier === 'replayableTest') {
      const replayEvidence = evidenceRefs[0] ?? (await this.isReadablePath(args.subject_ref) ? args.subject_ref : undefined);
      if (replayEvidence) {
        status = 'validated';
        evidenceRef = replayEvidence;
      } else {
        status = 'rejected';
        evidenceRef = 'missing-replayable-evidence';
      }
    } else {
      if (evidenceRefs.length >= 2) {
        status = 'validated';
        evidenceRef = evidenceRefs[0]!;
      } else {
        status = 'resourceHit';
        evidenceRef = evidenceRefs[0] ?? 'missing-quorum-evidence';
      }
    }

    const result = {
      subject: `${args.subject_type}:${args.subject_ref}`,
      tier: args.verification_tier,
      status,
      evidence_ref: evidenceRef,
      reviewer: `${process.env['CC_AGENT_ID'] ?? 'agent-starter'}::contract_verify@${WORLD_SPEC_VERSION}`,
    } satisfies ContractVerifyResult;

    if (args.escrow_id) {
      this.escrowVerificationResults.set(args.escrow_id, result);
    }

    this.audit.record('contract_verified', {
      contractName: args.contract_name,
      subjectType: args.subject_type,
      subjectRef: args.subject_ref,
      escrowId: args.escrow_id,
      tier: args.verification_tier,
      status,
      evidenceRef,
      outputContractRef: args.output_contract_ref ?? args.output_contract?.contract_id,
    });

    return result;
  }

  private async isReadablePath(candidate: string): Promise<boolean> {
    try {
      await access(candidate);
      return true;
    } catch {
      return false;
    }
  }

  private assertSupportedSpecVersion(specVersion: unknown): void {
    if (specVersion !== WORLD_SPEC_VERSION) {
      throw new Error(`Unsupported spec_version '${String(specVersion)}'; expected '${WORLD_SPEC_VERSION}'`);
    }
  }

  private parseBondScope(scope: unknown): import('./types.js').BondScope {
    const allowed: import('./types.js').BondScope[] = [
      'legal_document_handling',
      'financial_transaction_routing',
      'email_processing',
      'code_generation',
      'code_deployment',
      'general_purpose',
    ];

    if (typeof scope === 'string' && allowed.includes(scope as import('./types.js').BondScope)) {
      return scope as import('./types.js').BondScope;
    }

    return 'general_purpose';
  }

  private async releaseEscrowWithVerification(
    escrowId: string,
    completionEvidence?: string,
    manualReviewRef?: string,
  ) {
    const requirement = this.escrowVerificationRequirements.get(escrowId);

    if (requirement) {
      const result = this.escrowVerificationResults.get(escrowId);
      if (!result) {
        throw new Error(
          `Escrow ${escrowId} cannot be released: no verification result recorded`,
        );
      }
      if (result.tier !== requirement.verificationTier) {
        throw new Error(
          `Escrow ${escrowId} cannot be released: verification tier '${result.tier}' does not satisfy required tier '${requirement.verificationTier}'`,
        );
      }
      if (!requirement.allowedStatuses.includes(result.status)) {
        throw new Error(
          `Escrow ${escrowId} cannot be released: verification status '${result.status}' is not settlement-eligible`,
        );
      }
      if (
        requirement.outputContractRef &&
        !settlementStatusAllowed(
          {
            contract_id: requirement.outputContractRef,
            name: requirement.contractName,
            spec_version: WORLD_SPEC_VERSION,
            workflow_class: requirement.workflowClass ?? 'service_delivery',
            input_type: 'productSpec',
            output_type: 'structuredDeliverable',
            verification_tier: requirement.verificationTier,
            deliverable_schema: { type: 'object' },
            settlement_rules: {
              requires_funded_escrow: true,
              required_verification_statuses: requirement.allowedStatuses,
            },
          },
          result.status,
        )
      ) {
        throw new Error(
          `Escrow ${escrowId} cannot be released: settlement rules rejected status '${result.status}'`,
        );
      }
      if (requirement.settlementMode === 'manual' && (!manualReviewRef || manualReviewRef.trim().length === 0)) {
        throw new Error(
          `Escrow ${escrowId} requires manualReviewRef before release because workflow_class '${requirement.workflowClass ?? 'unknown'}' is manual-settlement`,
        );
      }
    }

    return this.economic.releaseEscrow(escrowId, completionEvidence);
  }

  private assertOutputContract(
    outputContract: OutputContractDocument,
    contractName: string,
    specVersion: string,
  ): void {
    if (!outputContract || typeof outputContract !== 'object') {
      throw new Error('output_contract must be an object');
    }
    if (outputContract.spec_version !== specVersion) {
      throw new Error('output_contract spec_version does not match requested spec_version');
    }
    if (outputContract.name !== contractName) {
      throw new Error(
        `output_contract name '${outputContract.name}' does not match contract_name '${contractName}'`,
      );
    }
  }

  private allowedStatusesForTier(
    tier: VerificationTier,
    passingStatus?: VerificationStatus,
  ): VerificationStatus[] {
    if (passingStatus) {
      return [passingStatus];
    }
    if (tier === 'proof') {
      return ['proven'];
    }
    return ['validated'];
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
    const builtInSummaries: CapabilitySummary[] = this.tools.map((tool) => ({
      id: tool.name,
      name: tool.name,
      description: tool.description,
      version: WORLD_SPEC_VERSION,
      pricing: { model: 'per_call' as const, baseCostUsd: 0 },
      sla: { p95LatencyMs: 5000, availability: 0.999 },
    }));

    const capabilitySummaries: CapabilitySummary[] = Array.from(this.capabilities.values()).map((capability) => ({
      id: capability.config.id,
      name: capability.config.name,
      description: capability.config.description,
      version: capability.config.version,
      pricing: capability.config.pricing,
      sla: capability.config.sla,
    }));

    return [...builtInSummaries, ...capabilitySummaries];
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
