// ============================================================
// MCP Server — implements the Model Context Protocol using
// @modelcontextprotocol/sdk and exposes both legacy economic
// tools and the newer ClawCombinator reference-stack tools.
// ============================================================

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  RequestAuthEnvelope,
  SignedVerificationAttestation,
  VerificationStatus,
  VerificationTier,
} from './types.js';
import type { SafetyMonitor } from './safety.js';
import type { AuditLogger } from './audit.js';
import type { CCAPEconomic } from './ccap/economic.js';
import type { PaymentRouter } from './router.js';
import {
  OperatorIntakeEngine,
} from './operator-intake.js';
import { hashOutputContract, settlementStatusAllowed } from './output-contracts.js';
import {
  buildToolRequestSignaturePayload,
  stripAuthFromArgs,
  verifyAgentRegistrationSignature,
  verifyStructuredPayload,
  verifyVerificationAttestation,
} from './auth.js';
import {
  DurableStateStore,
  type EscrowVerificationRequirementRecord,
  type MutationCacheRecord,
  type RegisteredAgentRegistryEntry,
  type TrustedOutputContractRecord,
} from './state-store.js';
import { VerificationWorker } from './verifier.js';
import {
  CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT,
  PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
} from './reference-examples.js';
import { stableStringify } from './canonical-json.js';
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

interface ListedTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export class AgentMCPServer {
  private readonly server: Server;
  readonly capabilities = new Map<string, Capability>();
  private readonly tools: ToolDefinition[];
  private readonly toolIndex = new Map<string, ToolDefinition>();
  private readonly mutationCache = new Map<string, MutationCacheRecord>();
  private readonly agentRegistry = new Map<string, RegisteredAgentRegistryEntry>();
  private readonly escrowVerificationRequirements = new Map<string, EscrowVerificationRequirementRecord>();
  private readonly escrowVerificationResults = new Map<string, ContractVerifyResult>();
  private readonly trustedOutputContracts = new Map<string, TrustedOutputContractRecord>();
  private readonly verificationAttestations = new Map<string, SignedVerificationAttestation>();
  private readonly operatorIntake: OperatorIntakeEngine;
  private readonly stateStore: DurableStateStore;
  private readonly verificationWorker: VerificationWorker;

  constructor(
    private readonly safety: SafetyMonitor,
    private readonly audit: AuditLogger,
    private readonly economic: CCAPEconomic,
    private readonly router: PaymentRouter,
    stateStore: DurableStateStore = new DurableStateStore(
      process.env['CC_RUNTIME_STATE_PATH'] ?? './data/ccap-runtime-state.json',
    ),
    verificationWorker: VerificationWorker = new VerificationWorker(
      {
        verifierId: process.env['CC_VERIFIER_ID'] ?? 'clawcombinator_platform_verifier_v1',
        contractsDir: fileURLToPath(new URL('../contracts', import.meta.url)),
        verifierKeyPath: process.env['CC_VERIFIER_KEY_PATH'] ?? './data/verifier-keypair.json',
        commandTimeoutMs: Number(process.env['CC_VERIFIER_COMMAND_TIMEOUT_MS'] ?? 600_000),
      },
      audit,
    ),
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

    this.stateStore = stateStore;
    this.verificationWorker = verificationWorker;
    this.operatorIntake = new OperatorIntakeEngine(this.audit);
    this.loadPersistedState();
    this.seedTrustedOutputContracts();

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
    const tools: ToolDefinition[] = [
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
          (() => {
            const actor = this.requireRequestAuth(args).agent_id;
            const declaredBuyer = args['buyerAgentId'] as string | undefined;
            if (declaredBuyer && declaredBuyer !== actor) {
              throw new Error(`buyerAgentId '${declaredBuyer}' does not match signed actor '${actor}'`);
            }
            return this.economic.createEscrow({
              amount: args['amount'] as number,
              currency: args['currency'] as string,
              buyerAgentId: actor,
              beneficiaryAgentId: args['beneficiaryAgentId'] as string,
              completionCriteria: args['completionCriteria'] as string,
              timeoutSeconds: args['timeoutSeconds'] as number,
              disputeResolutionMethod: args['disputeResolutionMethod'] as 'arbitration_agent' | 'multi_sig' | 'automatic',
              arbitrationAgentId: args['arbitrationAgentId'] as string | undefined,
              idempotencyKey: args['nonce'] as string,
            });
          })(),
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
          (() => {
            const actor = this.requireRequestAuth(args).agent_id;
            this.assertEscrowRole(args['escrowId'] as string, actor, ['buyer']);
            return this.economic.fundEscrow(
              args['escrowId'] as string,
              actor,
            );
          })(),
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
            this.requireRequestAuth(args).agent_id,
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
          (() => {
            const actor = this.requireRequestAuth(args).agent_id;
            this.assertEscrowRole(args['escrowId'] as string, actor, ['buyer', 'arbitrator']);
            return this.economic.refundEscrow(
              args['escrowId'] as string,
              args['reason'] as string | undefined,
            );
          })(),
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
          (() => {
            const actor = this.requireRequestAuth(args).agent_id;
            const declaredAgentId = args['agentId'] as string | undefined;
            if (declaredAgentId && declaredAgentId !== actor) {
              throw new Error(`agentId '${declaredAgentId}' does not match signed actor '${actor}'`);
            }
            return this.economic.postBond({
              agentId: actor,
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
            });
          })(),
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
          (() => {
            const actor = this.requireRequestAuth(args).agent_id;
            const claimedBy = args['claimedBy'] as string;
            if (claimedBy !== actor) {
              throw new Error(`claimedBy '${claimedBy}' does not match signed actor '${actor}'`);
            }
            return this.economic.claimBond({
              bondId: args['bondId'] as string,
              claimedBy,
              claimAmount: args['claimAmount'] as number,
              description: args['description'] as string,
              evidenceUrl: args['evidenceUrl'] as string | undefined,
              idempotencyKey: args['nonce'] as string,
            });
          })(),
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
        name: 'operator_capability_map',
        description:
          'Return the first-party OpenClaw operator envelope, authority boundaries, and recommended routing surfaces.',
        inputSchema: {
          type: 'object',
          properties: {
            spec_version: { type: 'string', description: 'Requested world-spec version' },
          },
          additionalProperties: false,
        },
        handler: async (args) => {
          if (args['spec_version'] !== undefined) {
            this.assertSupportedSpecVersion(args['spec_version']);
          }
          return this.operatorIntake.getCapabilityMap();
        },
      },
      {
        name: 'operator_intake_record',
        description:
          'Normalize and triage first-party inbound traffic into a replayable intake record. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: ['channel', 'sender_id', 'text', 'nonce', 'spec_version'],
          properties: {
            channel: {
              type: 'string',
              enum: ['email', 'form', 'api', 'mcp', 'a2a', 'webhook', 'telegram', 'discord', 'slack', 'whatsapp'],
            },
            sender_id: { type: 'string' },
            sender_type: {
              type: 'string',
              enum: ['agent', 'human', 'unknown'],
            },
            sender_display: { type: 'string' },
            subject: { type: 'string' },
            text: { type: 'string' },
            message_id: { type: 'string' },
            thread_id: { type: 'string' },
            requested_capabilities: {
              type: 'array',
              items: { type: 'string' },
            },
            attachments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  media_type: { type: 'string' },
                  size_bytes: { type: 'integer', minimum: 0 },
                  evidence_ref: { type: 'string' },
                },
                required: ['name', 'media_type'],
                additionalProperties: false,
              },
            },
            metadata: {
              type: 'object',
              description: 'Opaque metadata carried through the intake envelope',
            },
            received_at: { type: 'string', description: 'Optional ISO 8601 timestamp override' },
            nonce: { type: 'string' },
            spec_version: { type: 'string' },
          },
          additionalProperties: false,
        },
        handler: async (args) => {
          this.assertSupportedSpecVersion(args['spec_version']);
          const actor = this.requireRequestAuth(args).agent_id;
          if (actor !== this.operatorIntake.getCapabilityMap().operator_agent_id) {
            throw new Error(`operator_intake_record is reserved for '${this.operatorIntake.getCapabilityMap().operator_agent_id}'`);
          }
          return this.operatorIntake.recordInbound({
            channel: args['channel'] as import('./operator-intake.js').InboundChannel,
            sender_id: args['sender_id'] as string,
            sender_type: args['sender_type'] as import('./operator-intake.js').InboundSenderType | undefined,
            sender_display: args['sender_display'] as string | undefined,
            subject: args['subject'] as string | undefined,
            text: args['text'] as string,
            message_id: args['message_id'] as string | undefined,
            thread_id: args['thread_id'] as string | undefined,
            requested_capabilities: args['requested_capabilities'] as string[] | undefined,
            attachments: args['attachments'] as import('./operator-intake.js').IntakeAttachment[] | undefined,
            metadata: args['metadata'] as Record<string, unknown> | undefined,
            received_at: args['received_at'] as string | undefined,
          });
        },
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
          const actor = this.requireRequestAuth(args).agent_id;
          const buyerAgentId = args['buyer_agent_id'] as string;
          if (buyerAgentId !== actor) {
            throw new Error(`buyer_agent_id '${buyerAgentId}' does not match signed actor '${actor}'`);
          }
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

          const outputContractRef = args['output_contract_ref'] as string | undefined;
          let trustedOutputContract: TrustedOutputContractRecord | undefined;
          if (outputContractRef) {
            trustedOutputContract = this.resolveTrustedOutputContract(outputContractRef);
            if (trustedOutputContract.contract.name !== (args['contract_name'] as string)) {
              throw new Error(
                `output_contract_ref '${outputContractRef}' is bound to contract '${trustedOutputContract.contract.name}', not '${args['contract_name'] as string}'`,
              );
            }
            if (trustedOutputContract.contract.verification_tier !== declaredTier) {
              throw new Error(
                `output_contract_ref '${outputContractRef}' requires verification_tier '${trustedOutputContract.contract.verification_tier}'`,
              );
            }
            if (
              workflowClass &&
              trustedOutputContract.contract.workflow_class !== workflowClass
            ) {
              throw new Error(
                `output_contract_ref '${outputContractRef}' is bound to workflow_class '${trustedOutputContract.contract.workflow_class}', not '${workflowClass}'`,
              );
            }
          }

          if (declaredTier === 'replayableTest' && !outputContractRef) {
            throw new Error(
              `contract '${args['contract_name'] as string}' with verification_tier 'replayableTest' requires output_contract_ref at escrow lock time`,
            );
          }

          const created = await this.economic.createEscrow({
            amount: Number(args['amount_usd_cents']) / 100,
            currency: 'USD',
            buyerAgentId: actor,
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
            outputContractRef,
            outputContractHash: trustedOutputContract?.contentSha256,
            allowedStatuses: this.allowedStatusesForTier(
              declaredTier,
              policy?.passing_status,
            ),
            settlementMode: policy?.settlement_mode ?? 'automatic',
          });
          this.persistServerState();
          const funded = await this.economic.fundEscrow(
            created.escrowId,
            actor,
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
          const actor = this.requireRequestAuth(args).agent_id;
          const agentId = args['agent_id'] as string;
          if (agentId !== actor) {
            throw new Error(`agent_id '${agentId}' does not match signed actor '${actor}'`);
          }
          const result = await this.economic.postBond({
            agentId,
            amount: Number(args['amount_usd_cents']) / 100,
            currency: 'USD',
            scope: this.parseBondScope(args['scope']),
            scopeDescription: `Canonical bond scope: ${args['scope'] as string}`,
            durationSeconds: Number(args['duration_hours'] ?? 24) * 60 * 60,
            claimConditions: args['claim_conditions'] as string,
            maxClaimAmount: Number(args['amount_usd_cents']) / 100,
            arbitrationAgentId: agentId,
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
        name: 'output_contract_register',
        description:
          'Register a trusted output contract and pin its content hash for future settlement workflows. State-changing calls require a nonce.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: ['output_contract', 'nonce', 'spec_version'],
          properties: {
            output_contract: {
              type: 'object',
              description: 'Output contract document aligned to output-contract.schema.json',
            },
            nonce: { type: 'string' },
            spec_version: { type: 'string' },
          },
          additionalProperties: false,
        },
        handler: async (args) =>
          this.registerOutputContract(
            args['output_contract'] as OutputContractDocument,
            args['spec_version'] as string,
            this.requireRequestAuth(args).agent_id,
          ),
      },
      {
        name: 'contract_verify',
        description:
          'Evaluate whether a contract subject satisfies the declared verification tier.',
        mutatesState: true,
        inputSchema: {
          type: 'object',
          required: [
            'contract_name',
            'subject_type',
            'subject_ref',
            'verification_tier',
            'nonce',
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
            reviewer_attestations: {
              type: 'array',
              items: {
                type: 'object',
              },
            },
            nonce: { type: 'string' },
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
            reviewer_attestations: (args['reviewer_attestations'] as SignedVerificationAttestation[] | undefined) ?? [],
            spec_version: args['spec_version'] as string,
            auth: this.requireRequestAuth(args),
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
          const actor = this.requireRequestAuth(args).agent_id;
          const claimantAgentId = args['claimant_agent_id'] as string;
          if (claimantAgentId !== actor) {
            throw new Error(`claimant_agent_id '${claimantAgentId}' does not match signed actor '${actor}'`);
          }
          this.assertDisputeRole(args['escrow_id'] as string, actor);
          const dispute = await this.economic.openDispute({
            escrowId: args['escrow_id'] as string,
            claimantAgentId: actor,
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

    return tools.map((tool) => {
      if (!tool.mutatesState || tool.name === 'agent_register') {
        return tool;
      }

      const properties = {
        ...(tool.inputSchema.properties ?? {}),
        auth: {
          type: 'object',
          required: ['agent_id', 'key_id', 'signed_at', 'signature'],
          properties: {
            agent_id: { type: 'string' },
            key_id: { type: 'string' },
            signed_at: { type: 'string' },
            signature: { type: 'string' },
          },
          additionalProperties: false,
        },
      };
      const required = Array.from(new Set([...(tool.inputSchema.required ?? []), 'auth']));

      return {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties,
          required,
          additionalProperties: false,
        },
      };
    });
  }

  // ----------------------------------------------------------
  // Internal tool helpers
  // ----------------------------------------------------------

  private async executeMutationTool(
    tool: ToolDefinition,
    requestedName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (requestedName !== 'agent_register') {
      this.authenticateMutationRequest(requestedName, args);
    }

    const nonce = this.readMutationNonce(args);
    if (!nonce) {
      throw new Error(`Tool ${requestedName} requires a nonce or idempotencyKey`);
    }

    const cacheKey = `${requestedName}:${nonce}`;
    const fingerprint = stableStringify(stripAuthFromArgs(args));
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
    this.persistServerState();
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

  private requireRequestAuth(args: Record<string, unknown>): RequestAuthEnvelope {
    const auth = args['auth'];
    if (!auth || typeof auth !== 'object') {
      throw new Error('auth is required for this mutation');
    }

    const authRecord = auth as Record<string, unknown>;
    const agent_id = authRecord['agent_id'];
    const key_id = authRecord['key_id'];
    const signed_at = authRecord['signed_at'];
    const signature = authRecord['signature'];

    if (
      typeof agent_id !== 'string' ||
      typeof key_id !== 'string' ||
      typeof signed_at !== 'string' ||
      typeof signature !== 'string'
    ) {
      throw new Error('auth must include string agent_id, key_id, signed_at, and signature fields');
    }

    return {
      agent_id,
      key_id,
      signed_at,
      signature,
    };
  }

  private authenticateMutationRequest(
    toolName: string,
    args: Record<string, unknown>,
  ): RegisteredAgentRegistryEntry {
    const auth = this.requireRequestAuth(args);
    const entry = this.agentRegistry.get(auth.agent_id);
    if (!entry) {
      throw new Error(`Unknown agent_id '${auth.agent_id}' for signed mutation`);
    }

    const signingKey = entry.agentCard.auth.signing_keys.find((key) => key.key_id === auth.key_id);
    if (!signingKey) {
      throw new Error(`Agent '${auth.agent_id}' does not have signing key '${auth.key_id}'`);
    }

    const valid = verifyStructuredPayload(
      buildToolRequestSignaturePayload(toolName, args, {
        agent_id: auth.agent_id,
        key_id: auth.key_id,
        signed_at: auth.signed_at,
      }),
      signingKey.public_key_pem,
      auth.signature,
    );

    if (!valid) {
      throw new Error(`Invalid signed mutation request for tool ${toolName}`);
    }

    return entry;
  }

  private loadPersistedState(): void {
    const persisted = this.stateStore.read();
    for (const [cacheKey, record] of Object.entries(persisted.mutationCache)) {
      this.mutationCache.set(cacheKey, record);
    }
    for (const [agentId, record] of Object.entries(persisted.agentRegistry)) {
      this.agentRegistry.set(agentId, record);
    }
    for (const [escrowId, record] of Object.entries(persisted.escrowVerificationRequirements)) {
      this.escrowVerificationRequirements.set(escrowId, record);
    }
    for (const [escrowId, record] of Object.entries(persisted.escrowVerificationResults)) {
      this.escrowVerificationResults.set(escrowId, record);
    }
    for (const [contractId, record] of Object.entries(persisted.outputContracts)) {
      this.trustedOutputContracts.set(contractId, record);
    }
    for (const [attestationId, record] of Object.entries(persisted.verificationAttestations)) {
      this.verificationAttestations.set(attestationId, record);
    }
  }

  private persistServerState(): void {
    this.stateStore.transaction((draft) => {
      draft.mutationCache = Object.fromEntries(this.mutationCache);
      draft.agentRegistry = Object.fromEntries(this.agentRegistry);
      draft.escrowVerificationRequirements = Object.fromEntries(this.escrowVerificationRequirements);
      draft.escrowVerificationResults = Object.fromEntries(this.escrowVerificationResults);
      draft.outputContracts = Object.fromEntries(this.trustedOutputContracts);
      draft.verificationAttestations = Object.fromEntries(this.verificationAttestations);
    });
  }

  private seedTrustedOutputContracts(): void {
    const seeds = [
      PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
      CLAWCOMBINATOR_INBOUND_TRIAGE_CONTRACT,
    ];

    let changed = false;
    for (const contract of seeds) {
      if (this.trustedOutputContracts.has(contract.contract_id)) {
        continue;
      }

      this.trustedOutputContracts.set(contract.contract_id, {
        contract,
        contentSha256: hashOutputContract(contract),
        registeredBy: 'clawcombinator_seed',
        registeredAt: new Date().toISOString(),
      });
      changed = true;
    }

    if (changed) {
      this.persistServerState();
    }
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
    if (!agentCard.auth || !Array.isArray(agentCard.auth.signing_keys) || agentCard.auth.signing_keys.length === 0) {
      throw new Error('agent_card.auth.signing_keys must include at least one signing key');
    }
    if (!agentCard.agent_id || !agentCard.contract?.name) {
      throw new Error('agent_card is missing required identity or contract fields');
    }

    const verifiedSignature = verifyAgentRegistrationSignature(agentCard, signature);
    if (!verifiedSignature) {
      throw new Error(`agent_card registration signature could not be verified for '${agentCard.agent_id}'`);
    }

    const registeredAt = new Date().toISOString();
    this.agentRegistry.set(agentCard.agent_id, {
      agentCard,
      registrationSignature: signature,
      signatureKeyId: verifiedSignature.keyId,
      registeredAt,
    });
    this.persistServerState();

    this.audit.record('agent_registered', {
      agentId: agentCard.agent_id,
      capability: agentCard.capability,
      contractName: agentCard.contract.name,
      registeredAt,
      signatureKeyId: verifiedSignature.keyId,
    });

    return {
      agent_id: agentCard.agent_id,
      registration_status: 'registered',
      spec_version: specVersion,
      signature_key_id: verifiedSignature.keyId,
    };
  }

  private async registerOutputContract(
    outputContract: OutputContractDocument,
    specVersion: string,
    registeredBy: string,
  ): Promise<Record<string, unknown>> {
    this.assertSupportedSpecVersion(specVersion);
    this.assertOutputContract(outputContract, outputContract.name, specVersion);

    const actor = this.agentRegistry.get(registeredBy);
    if (!actor) {
      throw new Error(`Unknown registeredBy agent '${registeredBy}'`);
    }
    if (!['formalVerification', 'governanceAudit', 'agentDiscovery'].includes(actor.agentCard.capability)) {
      throw new Error(`Agent '${registeredBy}' is not allowed to register trusted output contracts`);
    }

    const contentSha256 = hashOutputContract(outputContract);
    const registeredAt = new Date().toISOString();
    this.trustedOutputContracts.set(outputContract.contract_id, {
      contract: outputContract,
      contentSha256,
      registeredBy,
      registeredAt,
    });
    this.persistServerState();

    this.audit.record('output_contract_registered', {
      contractId: outputContract.contract_id,
      registeredBy,
      contentSha256,
      registeredAt,
    });

    return {
      contract_id: outputContract.contract_id,
      registration_status: 'registered',
      content_sha256: contentSha256,
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
    reviewer_attestations: SignedVerificationAttestation[];
    spec_version: string;
    auth: RequestAuthEnvelope;
  }): Promise<ContractVerifyResult> {
    this.assertSupportedSpecVersion(args.spec_version);
    if (args.escrow_id) {
      this.assertVerificationRole(args.escrow_id, args.auth.agent_id);
    }

    const subject = `${args.subject_type}:${args.subject_ref}`;
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

    let status: VerificationStatus;
    let evidenceRef: string;
    let attestation: SignedVerificationAttestation;
    let outputContractHash: string | undefined;

    const trustedOutputContract = (() => {
      const contractRef =
        requirement?.outputContractRef ??
        args.output_contract_ref ??
        args.output_contract?.contract_id;
      if (!contractRef) {
        return undefined;
      }
      return this.resolveTrustedOutputContract(contractRef);
    })();

    if (args.output_contract) {
      if (!trustedOutputContract) {
        throw new Error(`output_contract '${args.output_contract.contract_id}' must be pre-registered before verification`);
      }
      this.assertOutputContract(
        args.output_contract,
        args.contract_name,
        args.spec_version,
        trustedOutputContract.contentSha256,
      );
    }

    if (trustedOutputContract) {
      if (trustedOutputContract.contract.name !== args.contract_name) {
        throw new Error(
          `Trusted output_contract '${trustedOutputContract.contract.contract_id}' does not match contract_name '${args.contract_name}'`,
        );
      }
      if (trustedOutputContract.contract.verification_tier !== args.verification_tier) {
        throw new Error(
          `output_contract '${trustedOutputContract.contract.contract_id}' requires verification_tier '${trustedOutputContract.contract.verification_tier}'`,
        );
      }
      if (args.subject_payload === undefined) {
        throw new Error('subject_payload is required when verifying against a trusted output contract');
      }
      if (
        requirement?.outputContractRef &&
        trustedOutputContract.contract.contract_id !== requirement.outputContractRef &&
        args.output_contract_ref !== requirement.outputContractRef
      ) {
        throw new Error(
          `Escrow ${args.escrow_id} requires output_contract_ref '${requirement.outputContractRef}'`,
        );
      }

      const validation = this.verificationWorker.verifyStructuredOutput(
        trustedOutputContract.contract,
        args.subject_payload,
        subject,
      );
      status = validation.status;
      evidenceRef = validation.evidenceRef;
      attestation = validation.attestation;
      outputContractHash = validation.outputContractHash;

      if (args.escrow_id) {
        this.escrowVerificationRequirements.set(args.escrow_id, {
          contractName: args.contract_name,
          workflowClass: requirement?.workflowClass ?? trustedOutputContract.contract.workflow_class,
          verificationTier: args.verification_tier,
          outputContractRef: args.output_contract_ref ?? trustedOutputContract.contract.contract_id,
          outputContractHash,
          allowedStatuses: trustedOutputContract.contract.settlement_rules.required_verification_statuses,
          settlementMode: requirement?.settlementMode ?? 'automatic',
        });
      }
    } else if (args.verification_tier === 'proof') {
      const proof = this.verificationWorker.verifyProof(args.subject_ref, subject);
      status = proof.status;
      evidenceRef = proof.evidenceRef;
      attestation = proof.attestation;
    } else if (args.verification_tier === 'replayableTest') {
      throw new Error('replayableTest verification requires a trusted output contract in the current runtime');
    } else {
      const quorum = this.verificationWorker.aggregateQuorumAttestations(
        subject,
        args.verification_tier,
        args.reviewer_attestations,
        (verifierId, keyId) => this.resolveAttestationPublicKey(verifierId, keyId),
      );
      status = quorum.status;
      evidenceRef = quorum.evidenceRef;
      attestation = quorum.attestation;
    }

    const result = {
      subject,
      tier: args.verification_tier,
      status,
      evidence_ref: evidenceRef,
      reviewer: `${process.env['CC_AGENT_ID'] ?? 'agent-starter'}::contract_verify@${WORLD_SPEC_VERSION}`,
      verified_at: new Date().toISOString(),
      output_contract_hash: outputContractHash,
      attestation,
      quorum_attestations: args.reviewer_attestations.length > 0 ? args.reviewer_attestations : undefined,
    } satisfies ContractVerifyResult;

    this.verificationAttestations.set(attestation.attestation_id, attestation);
    for (const reviewerAttestation of args.reviewer_attestations) {
      this.verificationAttestations.set(reviewerAttestation.attestation_id, reviewerAttestation);
    }

    if (args.escrow_id) {
      this.escrowVerificationResults.set(args.escrow_id, result);
    }
    this.persistServerState();

    this.audit.record('contract_verified', {
      contractName: args.contract_name,
      subjectType: args.subject_type,
      subjectRef: args.subject_ref,
      escrowId: args.escrow_id,
      tier: args.verification_tier,
      status,
      evidenceRef,
      attestationId: attestation.attestation_id,
      outputContractRef: args.output_contract_ref ?? trustedOutputContract?.contract.contract_id,
      outputContractHash,
    });

    return result;
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
    actorAgentId?: string,
  ) {
    if (actorAgentId) {
      this.assertEscrowRole(escrowId, actorAgentId, ['buyer', 'arbitrator']);
    }

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
      if (requirement.outputContractHash && result.output_contract_hash !== requirement.outputContractHash) {
        throw new Error(
          `Escrow ${escrowId} cannot be released: verification result is bound to output contract hash '${result.output_contract_hash ?? 'missing'}' not '${requirement.outputContractHash}'`,
        );
      }
      if (!result.attestation) {
        throw new Error(`Escrow ${escrowId} cannot be released: no signed verification attestation recorded`);
      }
      const attestationPublicKey = this.resolveAttestationPublicKey(
        result.attestation.verifier_id,
        result.attestation.key_id,
      );
      if (!attestationPublicKey || !verifyVerificationAttestation(result.attestation, attestationPublicKey)) {
        throw new Error(`Escrow ${escrowId} cannot be released: verification attestation signature is invalid`);
      }
      if (result.attestation.payload.subject !== result.subject) {
        throw new Error(`Escrow ${escrowId} cannot be released: attestation subject does not match recorded verification subject`);
      }
      if (result.attestation.payload.tier !== result.tier) {
        throw new Error(`Escrow ${escrowId} cannot be released: attestation tier does not match recorded verification tier`);
      }
      if (result.attestation.payload.status !== result.status) {
        throw new Error(`Escrow ${escrowId} cannot be released: attestation status does not match recorded verification status`);
      }
      if (result.attestation.payload.evidence_ref !== result.evidence_ref) {
        throw new Error(`Escrow ${escrowId} cannot be released: attestation evidence ref does not match recorded verification evidence`);
      }
      if ((result.attestation.payload.output_contract_hash ?? undefined) !== (result.output_contract_hash ?? undefined)) {
        throw new Error(`Escrow ${escrowId} cannot be released: attestation output contract hash does not match recorded verification result`);
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
    expectedHash?: string,
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
    if (expectedHash && hashOutputContract(outputContract) !== expectedHash) {
      throw new Error(`output_contract content hash does not match trusted hash '${expectedHash}'`);
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

  private resolveTrustedOutputContract(contractRef: string): TrustedOutputContractRecord {
    const record = this.trustedOutputContracts.get(contractRef);
    if (!record) {
      throw new Error(`Trusted output contract '${contractRef}' is not registered`);
    }
    return record;
  }

  private resolveAgentPublicKey(agentId: string, keyId: string): string | undefined {
    const entry = this.agentRegistry.get(agentId);
    return entry?.agentCard.auth.signing_keys.find((key) => key.key_id === keyId)?.public_key_pem;
  }

  private resolveAttestationPublicKey(verifierId: string, keyId: string): string | undefined {
    if (verifierId === this.verificationWorker.verifierId && keyId === this.verificationWorker.keyId) {
      return this.verificationWorker.publicKeyPem;
    }
    return this.resolveAgentPublicKey(verifierId, keyId);
  }

  private assertEscrowRole(
    escrowId: string,
    actorAgentId: string,
    allowedRoles: Array<'buyer' | 'beneficiary' | 'arbitrator'>,
  ): void {
    const escrow = this.economic.getExtendedEscrow(escrowId);
    if (!escrow) {
      throw new Error(`Escrow not found: ${escrowId}`);
    }

    const allowed = allowedRoles.some((role) => {
      if (role === 'buyer') {
        return escrow.buyerAgentId === actorAgentId;
      }
      if (role === 'beneficiary') {
        return escrow.beneficiaryAgentId === actorAgentId;
      }
      return escrow.arbitrationAgentId === actorAgentId;
    });

    if (!allowed) {
      throw new Error(`Agent '${actorAgentId}' is not authorized for escrow '${escrowId}' as one of [${allowedRoles.join(', ')}]`);
    }
  }

  private assertDisputeRole(escrowId: string, actorAgentId: string): void {
    this.assertEscrowRole(escrowId, actorAgentId, ['buyer', 'beneficiary', 'arbitrator']);
  }

  private assertVerificationRole(escrowId: string, actorAgentId: string): void {
    try {
      this.assertEscrowRole(escrowId, actorAgentId, ['buyer', 'beneficiary', 'arbitrator']);
      return;
    } catch {
      const entry = this.agentRegistry.get(actorAgentId);
      if (entry && ['formalVerification', 'governanceAudit'].includes(entry.agentCard.capability)) {
        return;
      }
      throw new Error(`Agent '${actorAgentId}' is not allowed to request escrow-bound verification for '${escrowId}'`);
    }
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
