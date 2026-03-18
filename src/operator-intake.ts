import crypto from 'node:crypto';
import type { AuditLogger } from './audit.js';
import type { VerificationTier } from './types.js';

export const FIRST_PARTY_OPERATOR_AGENT_ID = 'clawcombinator_relay_operator_v1';
export const FIRST_PARTY_OPERATOR_CANONICAL_INBOX = 'relay@clawcombinator.ai';
export const FIRST_PARTY_OPERATOR_PUBLIC_ALIASES = ['claw@clawcombinator.ai'] as const;
export const FIRST_PARTY_OPERATOR_WORKFLOW_CLASS = 'first_party_operator_intake';
export const FIRST_PARTY_OPERATOR_OUTPUT_CONTRACT_ID = 'clawcombinator_inbound_triage_v1';
export const FIRST_PARTY_OPERATOR_GOVERNANCE_REFS = [
  'KILLSWITCH.md',
  'THROTTLE.md',
  'ESCALATE.md',
  'FAILURE.md',
] as const;

export type InboundChannel =
  | 'email'
  | 'form'
  | 'api'
  | 'mcp'
  | 'a2a'
  | 'webhook'
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'whatsapp';

export type InboundSenderType = 'agent' | 'human' | 'unknown';
export type InboundRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type InboundRoute =
  | 'auto_reply'
  | 'collect_more_context'
  | 'open_workflow'
  | 'manual_review'
  | 'human_takeover'
  | 'reject';
export type InboundStatus = 'accepted' | 'needs_human' | 'blocked';
export type OperatorAuthority = 'bounded_auto' | 'human_review' | 'human_only' | 'blocked';
export type OperatorCapabilityRuleId =
  | 'docs_and_discovery_guidance'
  | 'programme_application_triage'
  | 'rfa_and_partnership_intake'
  | 'service_delivery_staging'
  | 'domain_infra_mailbox_admin'
  | 'payments_legal_and_credentials';

export interface IntakeAttachment {
  name: string;
  media_type: string;
  size_bytes?: number;
  evidence_ref?: string;
}

export interface IntakeSubmission {
  channel: InboundChannel;
  sender_id: string;
  text: string;
  sender_type?: InboundSenderType;
  sender_display?: string;
  subject?: string;
  message_id?: string;
  thread_id?: string;
  requested_capabilities?: string[];
  attachments?: IntakeAttachment[];
  metadata?: Record<string, unknown>;
  received_at?: string;
}

export interface OperatorCapabilityRule {
  id: OperatorCapabilityRuleId;
  name: string;
  description: string;
  supported_channels: InboundChannel[];
  authority: OperatorAuthority;
  required_verification_tier: VerificationTier;
  offered_actions: string[];
  human_required_actions: string[];
  blocked_actions: string[];
  openclaw_reference: {
    features: string[];
    docs: string[];
  };
}

export interface OperatorCapabilityMap {
  operator_agent_id: string;
  canonical_inbox: string;
  public_aliases: readonly string[];
  workflow_class: string;
  verification_tier: VerificationTier;
  governance_refs: readonly string[];
  capability_rules: OperatorCapabilityRule[];
  recommended_openclaw: {
    agent_id: string;
    dm_policy: 'pairing';
    allowed_session_key_prefixes: string[];
    hook_session_key_template: string;
    hook_paths: string[];
    preferred_channels: InboundChannel[];
    tooling: {
      allow: string[];
      deny: string[];
    };
    bindings: Array<{
      surface: string;
      route_to: string;
      notes: string;
    }>;
  };
  external_blockers: string[];
}

export interface OperatorIntakeRecord {
  intake_id: string;
  canonical_inbox: string;
  public_aliases: readonly string[];
  channel: InboundChannel;
  sender_type: InboundSenderType;
  sender_ref: string;
  message_ref: string;
  summary: string;
  requested_capabilities: string[];
  matched_capability_rules: OperatorCapabilityRuleId[];
  risk_level: InboundRiskLevel;
  route: InboundRoute;
  status: InboundStatus;
  authority: OperatorAuthority;
  required_verification_tier: VerificationTier;
  workflow_class: string;
  output_contract_id: string;
  governance_refs: readonly string[];
  reason_codes: string[];
  next_actions: string[];
  evidence_ref: string;
  received_at: string;
  duplicate: boolean;
  duplicate_count: number;
}

interface StoredOperatorIntakeRecord {
  record: OperatorIntakeRecord;
  fingerprint: string;
}

const OPENCLAW_DOCS_BASE = 'https://docs.openclaw.ai';

export const FIRST_PARTY_OPERATOR_TRIAGE_DELIVERABLE_SCHEMA = {
  type: 'object',
  required: [
    'intake_id',
    'canonical_inbox',
    'public_aliases',
    'channel',
    'sender_type',
    'sender_ref',
    'message_ref',
    'summary',
    'requested_capabilities',
    'matched_capability_rules',
    'risk_level',
    'route',
    'status',
    'authority',
    'required_verification_tier',
    'workflow_class',
    'output_contract_id',
    'governance_refs',
    'reason_codes',
    'next_actions',
    'evidence_ref',
    'received_at',
    'duplicate',
    'duplicate_count',
  ],
  properties: {
    intake_id: { type: 'string' },
    canonical_inbox: { type: 'string' },
    public_aliases: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
    },
    channel: {
      type: 'string',
      enum: ['email', 'form', 'api', 'mcp', 'a2a', 'webhook', 'telegram', 'discord', 'slack', 'whatsapp'],
    },
    sender_type: {
      type: 'string',
      enum: ['agent', 'human', 'unknown'],
    },
    sender_ref: { type: 'string' },
    message_ref: { type: 'string' },
    summary: { type: 'string', minLength: 1 },
    requested_capabilities: {
      type: 'array',
      items: { type: 'string' },
    },
    matched_capability_rules: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'string',
        enum: [
          'docs_and_discovery_guidance',
          'programme_application_triage',
          'rfa_and_partnership_intake',
          'service_delivery_staging',
          'domain_infra_mailbox_admin',
          'payments_legal_and_credentials',
        ],
      },
    },
    risk_level: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'critical'],
    },
    route: {
      type: 'string',
      enum: ['auto_reply', 'collect_more_context', 'open_workflow', 'manual_review', 'human_takeover', 'reject'],
    },
    status: {
      type: 'string',
      enum: ['accepted', 'needs_human', 'blocked'],
    },
    authority: {
      type: 'string',
      enum: ['bounded_auto', 'human_review', 'human_only', 'blocked'],
    },
    required_verification_tier: {
      type: 'string',
      enum: ['proof', 'replayableTest', 'quorum'],
    },
    workflow_class: { type: 'string' },
    output_contract_id: { type: 'string' },
    governance_refs: {
      type: 'array',
      minItems: 4,
      items: { type: 'string' },
    },
    reason_codes: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
    },
    next_actions: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
    },
    evidence_ref: { type: 'string' },
    received_at: { type: 'string', format: 'date-time' },
    duplicate: { type: 'boolean' },
    duplicate_count: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const;

const CAPABILITY_RULES: OperatorCapabilityRule[] = [
  {
    id: 'docs_and_discovery_guidance',
    name: 'Docs and discovery guidance',
    description:
      'Reply with llms.txt, agents.md, world-spec, verification policy, Agent Card schema, and discovery guidance.',
    supported_channels: ['email', 'form', 'api', 'mcp', 'a2a', 'webhook', 'telegram', 'discord', 'slack', 'whatsapp'],
    authority: 'bounded_auto',
    required_verification_tier: 'replayableTest',
    offered_actions: [
      'share_world_spec',
      'share_agent_card_examples',
      'explain verification tiers',
      'route the sender toward documented MCP and A2A surfaces',
    ],
    human_required_actions: [],
    blocked_actions: [],
    openclaw_reference: {
      features: ['multi-agent routing', 'sessions_send', 'webhook hooks', 'pairing-based DM gating'],
      docs: [
        `${OPENCLAW_DOCS_BASE}/concepts/multi-agent`,
        `${OPENCLAW_DOCS_BASE}/gateway/security`,
        `${OPENCLAW_DOCS_BASE}/gateway/configuration-reference`,
      ],
    },
  },
  {
    id: 'programme_application_triage',
    name: 'Programme application triage',
    description:
      'Collect or normalize applications into the published ClawCombinator schema without making acceptance decisions.',
    supported_channels: ['email', 'form', 'api', 'mcp', 'a2a', 'webhook'],
    authority: 'bounded_auto',
    required_verification_tier: 'replayableTest',
    offered_actions: [
      'request missing application fields',
      'link the sender to apply.json',
      'stage an intake package for human review',
    ],
    human_required_actions: ['programme admission decision', 'public endorsement'],
    blocked_actions: [],
    openclaw_reference: {
      features: ['webhook hooks', 'session reuse for hook traffic', 'workspace-isolated agent routing'],
      docs: [
        `${OPENCLAW_DOCS_BASE}/gateway/configuration-reference`,
        `${OPENCLAW_DOCS_BASE}/concepts/multi-agent`,
      ],
    },
  },
  {
    id: 'rfa_and_partnership_intake',
    name: 'RFA and partnership intake',
    description:
      'Capture problem statements, partnership interest, or market requests and route them into a structured review queue.',
    supported_channels: ['email', 'form', 'api', 'a2a', 'webhook', 'telegram', 'discord', 'slack'],
    authority: 'bounded_auto',
    required_verification_tier: 'replayableTest',
    offered_actions: [
      'request structured problem statements',
      'log partner or adviser interest',
      'route a sender to the right public programme surface',
    ],
    human_required_actions: ['commercial negotiation', 'final partnership commitment'],
    blocked_actions: [],
    openclaw_reference: {
      features: ['multi-channel inbox', 'pairing', 'sessions_history'],
      docs: [
        `${OPENCLAW_DOCS_BASE}/gateway/security`,
        `${OPENCLAW_DOCS_BASE}/concepts/multi-agent`,
      ],
    },
  },
  {
    id: 'service_delivery_staging',
    name: 'Service-delivery staging',
    description:
      'Stage a service-delivery workflow by asking for output contracts, escrow terms, and verification expectations before any commitment is made.',
    supported_channels: ['email', 'api', 'mcp', 'a2a', 'webhook', 'slack', 'telegram'],
    authority: 'human_review',
    required_verification_tier: 'replayableTest',
    offered_actions: [
      'request an output contract or reference example',
      'request escrow and bond details',
      'route to the MCP discovery and settlement surfaces',
    ],
    human_required_actions: [
      'accept service-delivery scope',
      'make timeline or pricing commitments',
      'trigger external work without review',
    ],
    blocked_actions: [],
    openclaw_reference: {
      features: ['hooks.gmail', 'sessions_send', 'multi-agent routing'],
      docs: [
        `${OPENCLAW_DOCS_BASE}/gateway/configuration-reference`,
        `${OPENCLAW_DOCS_BASE}/concepts/multi-agent`,
      ],
    },
  },
  {
    id: 'domain_infra_mailbox_admin',
    name: 'Domain, infra, and mailbox administration',
    description:
      'Requests that touch DNS, domains, GCP, Google Workspace, Cloudflare, or mailbox administration are always human-owned.',
    supported_channels: ['email', 'api', 'mcp', 'a2a', 'webhook', 'slack', 'telegram'],
    authority: 'human_only',
    required_verification_tier: 'replayableTest',
    offered_actions: ['capture the request and gather context for a human operator'],
    human_required_actions: [
      'change DNS or MX records',
      'create or delete mailboxes',
      'change IAM, secrets, or GCP projects',
      'modify gateway or Cloudflare routing',
    ],
    blocked_actions: ['self-authorize infrastructure or mailbox changes'],
    openclaw_reference: {
      features: ['pairing', 'workspace isolation', 'tool deny lists'],
      docs: [
        `${OPENCLAW_DOCS_BASE}/gateway/security`,
        `${OPENCLAW_DOCS_BASE}/gateway/configuration-reference`,
      ],
    },
  },
  {
    id: 'payments_legal_and_credentials',
    name: 'Payments, legal, and credentials',
    description:
      'Requests involving funds, incorporation, signatures, taxes, credentials, or secrets are either human-owned or blocked.',
    supported_channels: ['email', 'api', 'mcp', 'a2a', 'webhook', 'slack', 'telegram'],
    authority: 'blocked',
    required_verification_tier: 'replayableTest',
    offered_actions: ['pause automation and create a human escalation package'],
    human_required_actions: [
      'move money',
      'sign agreements',
      'form a Delaware entity',
      'share credentials or secrets',
    ],
    blocked_actions: [
      'execute payment instructions',
      'send or receive secrets',
      'create legal commitments without a human operator',
    ],
    openclaw_reference: {
      features: ['pairing', 'tool deny lists', 'session visibility constraints'],
      docs: [
        `${OPENCLAW_DOCS_BASE}/gateway/security`,
        `${OPENCLAW_DOCS_BASE}/concepts/multi-agent`,
      ],
    },
  },
] satisfies OperatorCapabilityRule[];

const CAPABILITY_RULE_BY_ID = new Map(
  CAPABILITY_RULES.map((rule) => [rule.id, rule]),
);

const CAPABILITY_MAP: OperatorCapabilityMap = {
  operator_agent_id: FIRST_PARTY_OPERATOR_AGENT_ID,
  canonical_inbox: FIRST_PARTY_OPERATOR_CANONICAL_INBOX,
  public_aliases: FIRST_PARTY_OPERATOR_PUBLIC_ALIASES,
  workflow_class: FIRST_PARTY_OPERATOR_WORKFLOW_CLASS,
  verification_tier: 'replayableTest',
  governance_refs: FIRST_PARTY_OPERATOR_GOVERNANCE_REFS,
  capability_rules: CAPABILITY_RULES,
  recommended_openclaw: {
    agent_id: FIRST_PARTY_OPERATOR_AGENT_ID,
    dm_policy: 'pairing',
    allowed_session_key_prefixes: ['hook:', 'inbound:'],
    hook_session_key_template: 'hook:gmail:{{messages[0].id}}',
    hook_paths: ['/hooks/gmail', '/hooks/agent'],
    preferred_channels: ['email', 'api', 'a2a', 'mcp', 'slack', 'telegram'],
    tooling: {
      allow: ['read', 'sessions_list', 'sessions_history', 'sessions_send'],
      deny: ['write', 'edit', 'apply_patch', 'exec', 'process', 'browser', 'canvas'],
    },
    bindings: [
      {
        surface: 'gmail inbound hook',
        route_to: FIRST_PARTY_OPERATOR_AGENT_ID,
        notes: 'Use hooks.gmail and keep the Gmail session key under the hook:* namespace.',
      },
      {
        surface: 'operator API or webhook intake',
        route_to: FIRST_PARTY_OPERATOR_AGENT_ID,
        notes: 'Normalize POST /hooks/agent traffic into the same intake schema used for email.',
      },
      {
        surface: 'paired messaging channels',
        route_to: FIRST_PARTY_OPERATOR_AGENT_ID,
        notes: 'Keep DM policy at pairing so unknown senders never get implicit authority.',
      },
    ],
  },
  external_blockers: [
    'Google-domain and mailbox provisioning is still required before relay@clawcombinator.ai can go live.',
    'Cloudflare gateway credentials are still required before public hook paths can be exposed safely.',
  ],
};

const LOW_RISK_HINTS = [
  { token: 'llms.txt', code: 'docs_query', ruleId: 'docs_and_discovery_guidance' },
  { token: 'agents.md', code: 'docs_query', ruleId: 'docs_and_discovery_guidance' },
  { token: 'agent card', code: 'discovery_request', ruleId: 'docs_and_discovery_guidance' },
  { token: 'a2a', code: 'discovery_request', ruleId: 'docs_and_discovery_guidance' },
  { token: 'mcp', code: 'discovery_request', ruleId: 'docs_and_discovery_guidance' },
  { token: 'registry', code: 'discovery_request', ruleId: 'docs_and_discovery_guidance' },
  { token: 'apply', code: 'programme_application', ruleId: 'programme_application_triage' },
  { token: 'application', code: 'programme_application', ruleId: 'programme_application_triage' },
  { token: 'cohort', code: 'programme_application', ruleId: 'programme_application_triage' },
  { token: 'rfa', code: 'market_request', ruleId: 'rfa_and_partnership_intake' },
  { token: 'partner', code: 'market_request', ruleId: 'rfa_and_partnership_intake' },
  { token: 'partnership', code: 'market_request', ruleId: 'rfa_and_partnership_intake' },
  { token: 'proposal', code: 'service_delivery_request', ruleId: 'service_delivery_staging' },
  { token: 'scope', code: 'service_delivery_request', ruleId: 'service_delivery_staging' },
  { token: 'escrow', code: 'service_delivery_request', ruleId: 'service_delivery_staging' },
  { token: 'output contract', code: 'service_delivery_request', ruleId: 'service_delivery_staging' },
] as const;

const CRITICAL_RISK_HINTS = [
  { token: 'dns', code: 'domain_or_mailbox_admin', ruleId: 'domain_infra_mailbox_admin' },
  { token: 'mx record', code: 'domain_or_mailbox_admin', ruleId: 'domain_infra_mailbox_admin' },
  { token: 'spf', code: 'domain_or_mailbox_admin', ruleId: 'domain_infra_mailbox_admin' },
  { token: 'dkim', code: 'domain_or_mailbox_admin', ruleId: 'domain_infra_mailbox_admin' },
  { token: 'dmarc', code: 'domain_or_mailbox_admin', ruleId: 'domain_infra_mailbox_admin' },
  { token: 'mailbox', code: 'domain_or_mailbox_admin', ruleId: 'domain_infra_mailbox_admin' },
  { token: 'google workspace', code: 'domain_or_mailbox_admin', ruleId: 'domain_infra_mailbox_admin' },
  { token: 'gcp', code: 'domain_or_mailbox_admin', ruleId: 'domain_infra_mailbox_admin' },
  { token: 'cloudflare', code: 'domain_or_mailbox_admin', ruleId: 'domain_infra_mailbox_admin' },
  { token: 'password', code: 'credential_request', ruleId: 'payments_legal_and_credentials' },
  { token: 'api key', code: 'credential_request', ruleId: 'payments_legal_and_credentials' },
  { token: 'secret', code: 'credential_request', ruleId: 'payments_legal_and_credentials' },
  { token: 'token', code: 'credential_request', ruleId: 'payments_legal_and_credentials' },
  { token: 'wire', code: 'funds_or_legal_commitment', ruleId: 'payments_legal_and_credentials' },
  { token: 'bank', code: 'funds_or_legal_commitment', ruleId: 'payments_legal_and_credentials' },
  { token: 'refund', code: 'funds_or_legal_commitment', ruleId: 'payments_legal_and_credentials' },
  { token: 'payment', code: 'funds_or_legal_commitment', ruleId: 'payments_legal_and_credentials' },
  { token: 'invoice', code: 'funds_or_legal_commitment', ruleId: 'payments_legal_and_credentials' },
  { token: 'delaware', code: 'funds_or_legal_commitment', ruleId: 'payments_legal_and_credentials' },
  { token: 'llc', code: 'funds_or_legal_commitment', ruleId: 'payments_legal_and_credentials' },
  { token: 'corp', code: 'funds_or_legal_commitment', ruleId: 'payments_legal_and_credentials' },
  { token: 'incorporat', code: 'funds_or_legal_commitment', ruleId: 'payments_legal_and_credentials' },
  { token: 'sign', code: 'funds_or_legal_commitment', ruleId: 'payments_legal_and_credentials' },
] as const;

export class OperatorIntakeEngine {
  private readonly recordsByFingerprint = new Map<string, StoredOperatorIntakeRecord>();

  constructor(private readonly audit?: AuditLogger) {}

  getCapabilityMap(): OperatorCapabilityMap {
    return structuredClone(CAPABILITY_MAP);
  }

  recordInbound(submission: IntakeSubmission): OperatorIntakeRecord {
    const normalized = this.normalizeSubmission(submission);
    const existing = this.recordsByFingerprint.get(normalized.fingerprint);

    if (existing) {
      const duplicateRecord: OperatorIntakeRecord = {
        ...existing.record,
        duplicate: true,
        duplicate_count: existing.record.duplicate_count + 1,
      };
      this.recordsByFingerprint.set(normalized.fingerprint, {
        fingerprint: normalized.fingerprint,
        record: duplicateRecord,
      });
      this.audit?.record('operator_inbound_duplicate', {
        intakeId: duplicateRecord.intake_id,
        channel: duplicateRecord.channel,
        senderRef: duplicateRecord.sender_ref,
      });
      return duplicateRecord;
    }

    const decision = this.decide(normalized);
    const record: OperatorIntakeRecord = {
      intake_id: `inbound_${normalized.fingerprint.slice(0, 16)}`,
      canonical_inbox: FIRST_PARTY_OPERATOR_CANONICAL_INBOX,
      public_aliases: FIRST_PARTY_OPERATOR_PUBLIC_ALIASES,
      channel: normalized.channel,
      sender_type: normalized.senderType,
      sender_ref: normalized.senderRef,
      message_ref: normalized.messageRef,
      summary: normalized.summary,
      requested_capabilities: normalized.requestedCapabilities,
      matched_capability_rules: decision.ruleIds,
      risk_level: decision.riskLevel,
      route: decision.route,
      status: decision.status,
      authority: decision.authority,
      required_verification_tier: 'replayableTest',
      workflow_class: FIRST_PARTY_OPERATOR_WORKFLOW_CLASS,
      output_contract_id: FIRST_PARTY_OPERATOR_OUTPUT_CONTRACT_ID,
      governance_refs: FIRST_PARTY_OPERATOR_GOVERNANCE_REFS,
      reason_codes: decision.reasonCodes,
      next_actions: decision.nextActions,
      evidence_ref: `sha256:${normalized.fingerprint}`,
      received_at: normalized.receivedAt,
      duplicate: false,
      duplicate_count: 0,
    };

    this.recordsByFingerprint.set(normalized.fingerprint, {
      fingerprint: normalized.fingerprint,
      record,
    });
    this.audit?.record('operator_inbound_recorded', {
      intakeId: record.intake_id,
      channel: record.channel,
      route: record.route,
      riskLevel: record.risk_level,
      ruleIds: record.matched_capability_rules,
    });
    return record;
  }

  private normalizeSubmission(submission: IntakeSubmission) {
    const subject = normalizeText(submission.subject ?? '');
    const text = normalizeText(submission.text);
    const requestedCapabilities = uniqueStrings([
      ...(submission.requested_capabilities ?? []),
      ...this.inferCapabilities(`${subject}\n${text}`),
    ]);

    const attachmentDigest = (submission.attachments ?? [])
      .map((attachment) => ({
        name: attachment.name,
        media_type: attachment.media_type,
        size_bytes: attachment.size_bytes ?? null,
        evidence_ref: attachment.evidence_ref ?? null,
      }));

    const fingerprint = sha256(
      stableStringify({
        channel: submission.channel,
        sender_id: submission.sender_id,
        sender_type: submission.sender_type ?? 'unknown',
        subject,
        text,
        message_id: submission.message_id ?? null,
        thread_id: submission.thread_id ?? null,
        requested_capabilities: requestedCapabilities,
        attachments: attachmentDigest,
      }),
    );

    const summary = buildSummary(subject, text);

    return {
      channel: submission.channel,
      senderType: submission.sender_type ?? 'unknown',
      senderRef: `sha256:${sha256(submission.sender_id)}`,
      messageRef:
        submission.message_id?.trim() ||
        `sha256:${sha256(`${submission.channel}:${submission.sender_id}:${subject}:${text}`).slice(0, 32)}`,
      requestedCapabilities,
      summary,
      receivedAt: submission.received_at ?? new Date().toISOString(),
      searchableText: `${subject}\n${text}`.toLowerCase(),
      fingerprint,
    };
  }

  private decide(normalized: {
    channel: InboundChannel;
    senderType: InboundSenderType;
    senderRef: string;
    messageRef: string;
    requestedCapabilities: string[];
    summary: string;
    receivedAt: string;
    searchableText: string;
    fingerprint: string;
  }) {
    const reasonCodes = new Set<string>();
    const ruleIds = new Set<OperatorCapabilityRuleId>();

    for (const capability of normalized.requestedCapabilities) {
      const mappedRule = capabilityToRule(capability);
      if (mappedRule) {
        ruleIds.add(mappedRule);
      }
    }

    for (const hint of LOW_RISK_HINTS) {
      if (normalized.searchableText.includes(hint.token)) {
        reasonCodes.add(hint.code);
        ruleIds.add(hint.ruleId);
      }
    }
    for (const hint of CRITICAL_RISK_HINTS) {
      if (normalized.searchableText.includes(hint.token)) {
        reasonCodes.add(hint.code);
        ruleIds.add(hint.ruleId);
      }
    }

    if (normalized.senderType === 'agent') {
      reasonCodes.add('agent_sender');
    }

    if (ruleIds.size === 0) {
      ruleIds.add('docs_and_discovery_guidance');
      reasonCodes.add('general_inquiry');
    }

    const riskLevel = deriveRiskLevel(ruleIds);
    const authority = deriveAuthority(ruleIds, riskLevel);
    const route = deriveRoute(ruleIds, riskLevel);
    const status = deriveStatus(route);
    const nextActions = buildNextActions(route, normalized.senderType, reasonCodes);

    return {
      reasonCodes: Array.from(reasonCodes).sort(),
      ruleIds: Array.from(ruleIds),
      riskLevel,
      authority,
      route,
      status,
      nextActions,
    };
  }

  private inferCapabilities(sourceText: string): string[] {
    const lower = sourceText.toLowerCase();
    const capabilities: string[] = [];

    if (lower.includes('apply') || lower.includes('application') || lower.includes('cohort')) {
      capabilities.push('programme_application');
    }
    if (lower.includes('rfa') || lower.includes('partner') || lower.includes('partnership')) {
      capabilities.push('market_request');
    }
    if (
      lower.includes('proposal') ||
      lower.includes('scope') ||
      lower.includes('escrow') ||
      lower.includes('output contract')
    ) {
      capabilities.push('service_delivery');
    }
    if (
      lower.includes('dns') ||
      lower.includes('mailbox') ||
      lower.includes('cloudflare') ||
      lower.includes('gcp') ||
      lower.includes('google workspace')
    ) {
      capabilities.push('domain_admin');
    }
    if (
      lower.includes('api key') ||
      lower.includes('password') ||
      lower.includes('secret') ||
      lower.includes('token') ||
      lower.includes('wire') ||
      lower.includes('delaware') ||
      lower.includes('llc') ||
      lower.includes('corp')
    ) {
      capabilities.push('restricted_request');
    }
    if (
      lower.includes('llms.txt') ||
      lower.includes('agents.md') ||
      lower.includes('mcp') ||
      lower.includes('agent card') ||
      lower.includes('a2a') ||
      lower.includes('registry')
    ) {
      capabilities.push('discovery_guidance');
    }

    return capabilities;
  }
}

function capabilityToRule(capability: string): OperatorCapabilityRuleId | undefined {
  switch (capability) {
    case 'programme_application':
      return 'programme_application_triage';
    case 'market_request':
      return 'rfa_and_partnership_intake';
    case 'service_delivery':
      return 'service_delivery_staging';
    case 'domain_admin':
      return 'domain_infra_mailbox_admin';
    case 'restricted_request':
      return 'payments_legal_and_credentials';
    case 'discovery_guidance':
      return 'docs_and_discovery_guidance';
    default:
      return undefined;
  }
}

function deriveRiskLevel(ruleIds: Set<OperatorCapabilityRuleId>): InboundRiskLevel {
  if (
    ruleIds.has('payments_legal_and_credentials') ||
    ruleIds.has('domain_infra_mailbox_admin')
  ) {
    return 'critical';
  }
  if (ruleIds.has('service_delivery_staging')) {
    return 'high';
  }
  if (
    ruleIds.has('rfa_and_partnership_intake') ||
    ruleIds.has('programme_application_triage')
  ) {
    return 'medium';
  }
  return 'low';
}

function deriveAuthority(
  ruleIds: Set<OperatorCapabilityRuleId>,
  riskLevel: InboundRiskLevel,
): OperatorAuthority {
  if (ruleIds.has('payments_legal_and_credentials')) {
    return 'blocked';
  }
  if (ruleIds.has('domain_infra_mailbox_admin') || riskLevel === 'critical') {
    return 'human_only';
  }
  if (riskLevel === 'high') {
    return 'human_review';
  }
  return 'bounded_auto';
}

function deriveRoute(
  ruleIds: Set<OperatorCapabilityRuleId>,
  riskLevel: InboundRiskLevel,
): InboundRoute {
  if (ruleIds.has('payments_legal_and_credentials')) {
    return 'human_takeover';
  }
  if (ruleIds.has('domain_infra_mailbox_admin')) {
    return 'human_takeover';
  }
  if (ruleIds.has('service_delivery_staging')) {
    return 'open_workflow';
  }
  if (riskLevel === 'high') {
    return 'manual_review';
  }
  if (ruleIds.has('programme_application_triage') || ruleIds.has('rfa_and_partnership_intake')) {
    return 'collect_more_context';
  }
  return 'auto_reply';
}

function deriveStatus(route: InboundRoute): InboundStatus {
  if (route === 'reject') {
    return 'blocked';
  }
  if (route === 'auto_reply' || route === 'collect_more_context') {
    return 'accepted';
  }
  return 'needs_human';
}

function buildNextActions(
  route: InboundRoute,
  senderType: InboundSenderType,
  reasonCodes: Set<string>,
): string[] {
  if (route === 'auto_reply') {
    return [
      'Reply with the world spec, agents.md, and the relevant machine-readable examples.',
      'State clearly which surfaces are live versus draft-public.',
    ];
  }

  if (route === 'collect_more_context') {
    return [
      'Request the missing structured fields or artefacts before any commitment is made.',
      'Keep the interaction inside the relay inbox until the request is specific enough for human review.',
    ];
  }

  if (route === 'manual_review') {
    return [
      'Prepare a structured intake summary for a human operator.',
      'Ask for an output contract, verification tier, and escrow expectations before work is accepted.',
    ];
  }

  if (route === 'human_takeover') {
    return [
      'Pause automation and route the request to a human operator immediately.',
      'Do not move funds, modify infrastructure, or disclose credentials.',
      senderType === 'agent'
        ? 'Reply that the request requires human takeover under ClawCombinator governance.'
        : 'Reply that the request has been queued for human review under ClawCombinator governance.',
      reasonCodes.has('funds_or_legal_commitment')
        ? 'Attach legal and payment context to the escalation package.'
        : 'Attach the operational context to the escalation package.',
    ];
  }

  return [
    'Reject the request and point the sender back to documented public surfaces.',
  ];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildSummary(subject: string, text: string): string {
  const pieces = [subject, text].filter(Boolean).join(' — ');
  const summary = pieces.slice(0, 240).trim();
  return summary.length > 0 ? summary : 'No summary available';
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const pairs = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${pairs.join(',')}}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function getOperatorCapabilityRule(
  id: OperatorCapabilityRuleId,
): OperatorCapabilityRule | undefined {
  return CAPABILITY_RULE_BY_ID.get(id);
}
