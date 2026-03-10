// ============================================================
// Tests for AuditLogger — chain integrity, tamper detection,
// export, and multi-entry verification.
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { AuditLogger } from '../src/audit.js';

function tempLogPath(): string {
  return path.join(os.tmpdir(), `audit_test_${crypto.randomBytes(4).toString('hex')}.jsonl`);
}

describe('AuditLogger', () => {
  let logPath: string;
  let audit: AuditLogger;

  beforeEach(() => {
    logPath = tempLogPath();
    audit = new AuditLogger(logPath);
  });

  // ----------------------------------------------------------
  // Basic recording
  // ----------------------------------------------------------

  it('records an entry and returns it', () => {
    const entry = audit.record('test_action', { foo: 'bar' });

    expect(entry.id).toMatch(/^audit_/);
    expect(entry.action).toBe('test_action');
    expect(entry.details).toEqual({ foo: 'bar' });
    expect(entry.timestamp).toBeTruthy();
    expect(entry.hash).toHaveLength(64); // SHA-256 hex
  });

  it('increments the log length', () => {
    expect(audit.length).toBe(0);
    audit.record('a', {});
    audit.record('b', {});
    expect(audit.length).toBe(2);
  });

  it('writes entries to disk', () => {
    audit.record('disk_test', { val: 42 });
    const raw = fs.readFileSync(logPath, 'utf8');
    expect(raw).toContain('disk_test');
  });

  // ----------------------------------------------------------
  // Hash chain integrity
  // ----------------------------------------------------------

  it('chains entries via previousHash', () => {
    const e1 = audit.record('first', {});
    const e2 = audit.record('second', {});
    const e3 = audit.record('third', {});

    expect(e2.previousHash).toBe(e1.hash);
    expect(e3.previousHash).toBe(e2.hash);
  });

  it('first entry has the genesis hash as previousHash', () => {
    const genesisHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const entry = audit.record('genesis_test', {});
    expect(entry.previousHash).toBe(genesisHash);
  });

  it('verify() returns valid on an untampered chain', () => {
    audit.record('action_1', { x: 1 });
    audit.record('action_2', { x: 2 });
    audit.record('action_3', { x: 3 });

    const result = audit.verify();
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(3);
  });

  it('verify() returns valid on an empty log', () => {
    const result = audit.verify();
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(0);
  });

  // ----------------------------------------------------------
  // Tamper detection
  // ----------------------------------------------------------

  it('verify() detects a tampered hash', () => {
    audit.record('entry_1', { data: 'original' });
    audit.record('entry_2', {});

    // Directly mutate the first entry's hash to simulate tampering
    const entries = (audit as unknown as { entries: import('../src/types.js').AuditEntry[] }).entries;
    entries[0]!.hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.slice(0, 64);

    const result = audit.verify();
    expect(result.valid).toBe(false);
    expect(result.firstBrokenAt).toBeTruthy();
  });

  it('verify() detects a tampered action field', () => {
    audit.record('legit_action', { amount: 100 });
    audit.record('second', {});

    const entries = (audit as unknown as { entries: import('../src/types.js').AuditEntry[] }).entries;
    // Simulate an attacker changing the action without updating the hash
    entries[0]!.action = 'tampered_action';

    const result = audit.verify();
    expect(result.valid).toBe(false);
  });

  it('verify() detects a broken back-link', () => {
    audit.record('e1', {});
    audit.record('e2', {});

    const entries = (audit as unknown as { entries: import('../src/types.js').AuditEntry[] }).entries;
    // Break the back-link of the second entry
    entries[1]!.previousHash = 'deadbeef'.padStart(64, '0');

    const result = audit.verify();
    expect(result.valid).toBe(false);
    expect(result.firstBrokenAt).toBe(entries[1]!.id);
  });

  // ----------------------------------------------------------
  // Export
  // ----------------------------------------------------------

  it('export() returns a copy of all entries', () => {
    audit.record('a', { n: 1 });
    audit.record('b', { n: 2 });

    const exported = audit.export();
    expect(exported).toHaveLength(2);
    expect(exported[0]!.action).toBe('a');
    expect(exported[1]!.action).toBe('b');

    // Should be a copy — mutating it should not affect the log
    exported[0]!.action = 'mutated';
    expect(audit.export()[0]!.action).toBe('a');
  });

  // ----------------------------------------------------------
  // Persistence — reload from disk
  // ----------------------------------------------------------

  it('reloads existing entries from disk on construction', () => {
    // Write 3 entries with the first instance
    const first = new AuditLogger(logPath);
    first.record('persisted_1', { n: 1 });
    first.record('persisted_2', { n: 2 });
    first.record('persisted_3', { n: 3 });

    // Create a second instance pointing to the same file
    const second = new AuditLogger(logPath);
    expect(second.length).toBe(3);

    // Chain should still be valid after reload
    const result = second.verify();
    expect(result.valid).toBe(true);
  });

  it('new entries appended after reload continue the chain', () => {
    const first = new AuditLogger(logPath);
    first.record('before_reload', {});

    const second = new AuditLogger(logPath);
    second.record('after_reload', {});

    const result = second.verify();
    expect(result.valid).toBe(true);
    expect(second.length).toBe(2);
  });
});
