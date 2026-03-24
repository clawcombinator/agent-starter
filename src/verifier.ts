import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AuditLogger } from './audit.js';
import type {
  OutputContractDocument,
  SignedVerificationAttestation,
  VerificationStatus,
  VerificationTier,
} from './types.js';
import { sha256Hex } from './canonical-json.js';
import {
  generateEd25519KeyPair,
  signVerificationAttestation,
  verifyVerificationAttestation,
} from './auth.js';
import { hashOutputContract, validateStructuredDeliverable } from './output-contracts.js';

interface VerifierKeyMaterial {
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface ProofTarget {
  absolutePath: string;
  relativePath: string;
  command: string[];
}

export interface VerificationWorkerConfig {
  verifierId: string;
  contractsDir: string;
  verifierKeyPath: string;
  commandTimeoutMs?: number;
}

export interface ProofVerificationResult {
  status: VerificationStatus;
  evidenceRef: string;
  attestation: SignedVerificationAttestation;
}

export interface StructuredVerificationResult {
  status: VerificationStatus;
  evidenceRef: string;
  outputContractHash: string;
  validationErrors: string[];
  attestation: SignedVerificationAttestation;
}

export class VerificationWorker {
  private readonly keyMaterial: VerifierKeyMaterial;
  private readonly commandTimeoutMs: number;
  private proofEnvironmentPrepared = false;

  constructor(
    private readonly config: VerificationWorkerConfig,
    private readonly audit: AuditLogger,
  ) {
    this.keyMaterial = this.loadOrCreateKeyMaterial(config.verifierKeyPath);
    this.commandTimeoutMs = config.commandTimeoutMs ?? 600_000;
  }

  get publicKeyPem(): string {
    return this.keyMaterial.publicKeyPem;
  }

  get keyId(): string {
    return this.keyMaterial.keyId;
  }

  get verifierId(): string {
    return this.config.verifierId;
  }

  verifyProof(subjectRef: string, subject: string): ProofVerificationResult {
    const localTarget = this.resolveProofTarget(subjectRef);

    if (!localTarget) {
      const attestation = this.attest(subject, 'proof', 'resourceHit', 'proof-target-unresolved', 'lean_proof');
      return {
        status: 'resourceHit',
        evidenceRef: 'proof-target-unresolved',
        attestation,
      };
    }

    this.ensureProofEnvironment();

    const run = spawnSync(
      'lake',
      localTarget.command,
      {
        cwd: this.config.contractsDir,
        encoding: 'utf8',
        timeout: this.commandTimeoutMs,
      },
    );

    const contentSha = sha256Hex(fs.readFileSync(localTarget.absolutePath, 'utf8'));
    const evidenceRef = `command:lake ${localTarget.command.join(' ')}:sha256:${contentSha}`;
    const status: VerificationStatus = run.status === 0 ? 'proven' : 'resourceHit';

    this.audit.record('verification_worker_proof_run', {
      subjectRef,
      relativePath: localTarget.relativePath,
      status,
      exitCode: run.status,
      stderr: run.stderr,
      stdout: run.stdout,
    });

    return {
      status,
      evidenceRef,
      attestation: this.attest(subject, 'proof', status, evidenceRef, 'lean_proof'),
    };
  }

  verifyStructuredOutput(
    contract: OutputContractDocument,
    payload: unknown,
    subject: string,
  ): StructuredVerificationResult {
    const validation = validateStructuredDeliverable(contract, payload);
    const outputContractHash = hashOutputContract(contract);
    const status: VerificationStatus = validation.valid ? 'validated' : 'rejected';
    const evidenceRef = validation.evidenceRef;

    this.audit.record('verification_worker_structured_output_run', {
      contractId: contract.contract_id,
      subject,
      status,
      evidenceRef,
      errors: validation.errors,
      outputContractHash,
    });

    return {
      status,
      evidenceRef,
      outputContractHash,
      validationErrors: validation.errors,
      attestation: this.attest(
        subject,
        contract.verification_tier,
        status,
        evidenceRef,
        'structured_output',
        contract.contract_id,
        outputContractHash,
      ),
    };
  }

  aggregateQuorumAttestations(
    subject: string,
    tier: VerificationTier,
    attestations: SignedVerificationAttestation[],
    resolvePublicKey: (verifierId: string, keyId: string) => string | undefined,
  ): ProofVerificationResult {
    const distinctReviewers = new Set<string>();
    const valid = attestations.filter((attestation) => {
      const publicKey = resolvePublicKey(attestation.verifier_id, attestation.key_id);
      if (!publicKey) {
        return false;
      }
      if (!verifyVerificationAttestation(attestation, publicKey)) {
        return false;
      }
      if (attestation.payload.subject !== subject || attestation.payload.tier !== tier) {
        return false;
      }
      if (attestation.payload.status !== 'validated' && attestation.payload.status !== 'proven') {
        return false;
      }
      distinctReviewers.add(attestation.verifier_id);
      return true;
    });

    const status: VerificationStatus = distinctReviewers.size >= 2 ? 'validated' : 'resourceHit';
    const evidenceRef =
      valid.length > 0
        ? `quorum:${valid.map((attestation) => attestation.attestation_id).join(',')}`
        : 'missing-quorum-attestations';

    this.audit.record('verification_worker_quorum_run', {
      subject,
      tier,
      status,
      validAttestations: valid.map((attestation) => attestation.attestation_id),
      reviewerCount: distinctReviewers.size,
    });

    return {
      status,
      evidenceRef,
      attestation: this.attest(subject, tier, status, evidenceRef, 'quorum_review'),
    };
  }

  private attest(
    subject: string,
    tier: VerificationTier,
    status: VerificationStatus,
    evidenceRef: string,
    verificationMethod: 'lean_proof' | 'structured_output' | 'quorum_review',
    outputContractRef?: string,
    outputContractHash?: string,
  ): SignedVerificationAttestation {
    return signVerificationAttestation(
      this.config.verifierId,
      this.keyMaterial.keyId,
      {
        subject,
        tier,
        status,
        evidence_ref: evidenceRef,
        verification_method: verificationMethod,
        runner_ref: this.config.verifierId,
        output_contract_ref: outputContractRef,
        output_contract_hash: outputContractHash,
      },
      this.keyMaterial.privateKeyPem,
    );
  }

  private resolveProofTarget(subjectRef: string): ProofTarget | undefined {
    const contractsDir = path.resolve(this.config.contractsDir);

    if (subjectRef === 'https://clawcombinator.ai/formal/category_spec.lean' || subjectRef.endsWith('CategorySpec.lean')) {
      const absolutePath = path.join(contractsDir, 'Contracts', 'CategorySpec.lean');
      return {
        absolutePath,
        relativePath: 'Contracts/CategorySpec.lean',
        command: ['build', 'Contracts/CategorySpec.lean:olean'],
      };
    }

    if (subjectRef.startsWith('/')) {
      const absolutePath = path.resolve(subjectRef);
      if (absolutePath.startsWith(contractsDir) && fs.existsSync(absolutePath)) {
        return {
          absolutePath,
          relativePath: path.relative(contractsDir, absolutePath),
          command: ['env', 'lean', path.relative(contractsDir, absolutePath)],
        };
      }
    }

    return undefined;
  }

  private ensureProofEnvironment(): void {
    if (this.proofEnvironmentPrepared) {
      return;
    }

    const cacheRun = spawnSync(
      'lake',
      ['exe', 'cache', 'get'],
      {
        cwd: this.config.contractsDir,
        encoding: 'utf8',
        timeout: this.commandTimeoutMs,
      },
    );

    this.audit.record('verification_worker_cache_prepare', {
      status: cacheRun.status === 0 ? 'ready' : 'cache_prepare_failed',
      exitCode: cacheRun.status,
      stderr: cacheRun.stderr,
      stdout: cacheRun.stdout,
    });

    this.proofEnvironmentPrepared = true;
  }

  private loadOrCreateKeyMaterial(keyPath: string): VerifierKeyMaterial {
    if (fs.existsSync(keyPath)) {
      return JSON.parse(fs.readFileSync(keyPath, 'utf8')) as VerifierKeyMaterial;
    }

    const directory = path.dirname(keyPath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    const generated = generateEd25519KeyPair();
    const material: VerifierKeyMaterial = {
      keyId: `verifier_${crypto.randomBytes(6).toString('hex')}`,
      publicKeyPem: generated.publicKeyPem,
      privateKeyPem: generated.privateKeyPem,
    };

    fs.writeFileSync(keyPath, JSON.stringify(material, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });

    return material;
  }
}
