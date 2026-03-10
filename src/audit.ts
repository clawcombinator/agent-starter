// ============================================================
// AuditLogger — append-only log with SHA-256 hash chaining.
//
// Each entry hashes the content of the PREVIOUS entry, forming
// a tamper-evident chain: altering any historical entry
// invalidates all subsequent hashes (like a blockchain but
// without consensus — sufficient for single-agent auditing).
// ============================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AuditEntry, AuditVerifyResult } from './types.js';

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export class AuditLogger {
  private entries: AuditEntry[] = [];
  private logPath: string;
  private lastHash: string = GENESIS_HASH;

  constructor(logPath: string = './logs/audit.jsonl') {
    this.logPath = logPath;
    this.ensureLogDirectory();
    this.loadExisting();
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /**
   * Record a new action in the audit log.
   * The entry is appended to the in-memory list AND flushed to disk.
   */
  record(action: string, details: Record<string, unknown>): AuditEntry {
    const id = this.generateId();
    const timestamp = new Date().toISOString();
    const previousHash = this.lastHash;

    const hash = this.computeHash({ id, timestamp, action, details, previousHash });

    const entry: AuditEntry = {
      id,
      timestamp,
      action,
      details,
      previousHash,
      hash,
    };

    this.entries.push(entry);
    this.lastHash = hash;
    this.appendToDisk(entry);

    return entry;
  }

  /**
   * Walk the chain and verify every hash.
   * Returns { valid: true } if untampered, or { valid: false, firstBrokenAt } if not.
   */
  verify(): AuditVerifyResult {
    let expectedPreviousHash = GENESIS_HASH;

    for (const entry of this.entries) {
      // Check back-link
      if (entry.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          entriesChecked: this.entries.indexOf(entry),
          firstBrokenAt: entry.id,
          error: `Back-link mismatch at entry ${entry.id}: expected ${expectedPreviousHash}, got ${entry.previousHash}`,
        };
      }

      // Recompute and compare hash
      const recomputed = this.computeHash({
        id: entry.id,
        timestamp: entry.timestamp,
        action: entry.action,
        details: entry.details,
        previousHash: entry.previousHash,
      });

      if (recomputed !== entry.hash) {
        return {
          valid: false,
          entriesChecked: this.entries.indexOf(entry),
          firstBrokenAt: entry.id,
          error: `Hash mismatch at entry ${entry.id}`,
        };
      }

      expectedPreviousHash = entry.hash;
    }

    return { valid: true, entriesChecked: this.entries.length };
  }

  /**
   * Export all entries as an array (e.g. for shipping to a remote sink).
   */
  export(): AuditEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get length(): number {
    return this.entries.length;
  }

  getLastEntry(): AuditEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private computeHash(parts: {
    id: string;
    timestamp: string;
    action: string;
    details: Record<string, unknown>;
    previousHash: string;
  }): string {
    const payload = JSON.stringify(parts, Object.keys(parts).sort());
    return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  private generateId(): string {
    return `audit_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  private ensureLogDirectory(): void {
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private loadExisting(): void {
    if (!fs.existsSync(this.logPath)) return;

    const raw = fs.readFileSync(this.logPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        this.entries.push(entry);
        this.lastHash = entry.hash;
      } catch {
        // Skip malformed lines — they will show up as a chain break in verify()
      }
    }
  }

  private appendToDisk(entry: AuditEntry): void {
    try {
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      // Non-fatal: log to stderr but don't crash the agent
      process.stderr.write(`[AuditLogger] Failed to write to disk: ${String(err)}\n`);
    }
  }
}
