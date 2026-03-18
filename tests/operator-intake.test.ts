import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLogger } from '../src/audit.js';
import { OperatorIntakeEngine } from '../src/operator-intake.js';

function tempLogPath(): string {
  return path.join(os.tmpdir(), `operator_intake_${crypto.randomBytes(4).toString('hex')}.jsonl`);
}

describe('OperatorIntakeEngine', () => {
  it('returns the canonical inbox, pairing policy, and hook plan in the capability map', () => {
    const engine = new OperatorIntakeEngine();

    const result = engine.getCapabilityMap();

    expect(result.canonical_inbox).toBe('relay@clawcombinator.ai');
    expect(result.public_aliases).toContain('claw@clawcombinator.ai');
    expect(result.recommended_openclaw.dm_policy).toBe('pairing');
    expect(result.recommended_openclaw.hook_session_key_template).toBe('hook:gmail:{{messages[0].id}}');
    expect(
      result.capability_rules.some((rule) => rule.id === 'payments_legal_and_credentials'),
    ).toBe(true);
  });

  it('auto-replies to low-risk discovery questions from agents', () => {
    const audit = new AuditLogger(tempLogPath());
    const engine = new OperatorIntakeEngine(audit);

    const record = engine.recordInbound({
      channel: 'email',
      sender_id: 'agent@example.ai',
      sender_type: 'agent',
      subject: 'Need ClawCombinator discovery docs',
      text: 'Please send llms.txt, agents.md, and the Agent Card schema for MCP and A2A integration.',
      message_id: 'msg_docs_001',
    });

    expect(record.route).toBe('auto_reply');
    expect(record.risk_level).toBe('low');
    expect(record.status).toBe('accepted');
    expect(record.authority).toBe('bounded_auto');
    expect(record.reason_codes).toContain('discovery_request');
    expect(record.reason_codes).toContain('agent_sender');
    expect(audit.export().some((entry) => entry.action === 'operator_inbound_recorded')).toBe(true);
  });

  it('deduplicates repeated intake payloads by fingerprint even if timestamps differ', () => {
    const engine = new OperatorIntakeEngine();
    const payload = {
      channel: 'email' as const,
      sender_id: 'agent@example.ai',
      sender_type: 'agent' as const,
      subject: 'Need ClawCombinator discovery docs',
      text: 'Please send llms.txt, agents.md, and the Agent Card schema for MCP and A2A integration.',
      message_id: 'msg_docs_001',
    };

    const first = engine.recordInbound({
      ...payload,
      received_at: '2026-03-18T17:45:00Z',
    });
    const second = engine.recordInbound({
      ...payload,
      received_at: '2026-03-18T17:46:00Z',
    });

    expect(second.intake_id).toBe(first.intake_id);
    expect(second.duplicate).toBe(true);
    expect(second.duplicate_count).toBe(1);
  });

  it('forces human takeover for domain, GCP, payment, and Delaware asks', () => {
    const engine = new OperatorIntakeEngine();

    const record = engine.recordInbound({
      channel: 'email',
      sender_id: 'ops@example.com',
      sender_type: 'human',
      subject: 'Please set up GCP and DNS for Delaware filing',
      text:
        'Create a mailbox, update MX and DKIM DNS, set up GCP IAM, and wire the payment for a Delaware LLC filing.',
      message_id: 'msg_ops_001',
    });

    expect(record.route).toBe('human_takeover');
    expect(record.risk_level).toBe('critical');
    expect(record.status).toBe('needs_human');
    expect(record.reason_codes).toContain('domain_or_mailbox_admin');
    expect(record.reason_codes).toContain('funds_or_legal_commitment');
    expect(record.next_actions).toContain('Pause automation and route the request to a human operator immediately.');
  });
});
