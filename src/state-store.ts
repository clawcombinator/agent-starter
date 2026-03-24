import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentCardDocument,
  ContractVerifyResult,
  CreditScore,
  DisputeRecord,
  ExtendedEscrowRecord,
  VerificationStatus,
  VerificationTier,
  BondRecord,
  EscrowRecord,
  EscrowHoldingRecord,
  InvoiceParams,
  InvoiceResult,
  OutputContractDocument,
  SignedVerificationAttestation,
} from './types.js';

export interface MutationCacheRecord {
  fingerprint: string;
  result: unknown;
  recordedAt: string;
}

export interface RegisteredAgentRegistryEntry {
  agentCard: AgentCardDocument;
  registrationSignature: string;
  signatureKeyId: string;
  registeredAt: string;
}

export interface EscrowVerificationRequirementRecord {
  contractName: string;
  workflowClass?: string;
  verificationTier: VerificationTier;
  outputContractRef?: string;
  outputContractHash?: string;
  allowedStatuses: VerificationStatus[];
  settlementMode: 'automatic' | 'manual';
}

export interface TrustedOutputContractRecord {
  contract: OutputContractDocument;
  contentSha256: string;
  registeredBy: string;
  registeredAt: string;
}

export interface PersistedRuntimeState {
  version: string;
  updatedAt: string;
  invoices: Record<string, InvoiceResult & InvoiceParams>;
  escrows: Record<string, EscrowRecord>;
  extendedEscrows: Record<string, ExtendedEscrowRecord>;
  bonds: Record<string, BondRecord>;
  disputes: Record<string, DisputeRecord>;
  creditScores: Record<string, CreditScore>;
  mutationCache: Record<string, MutationCacheRecord>;
  agentRegistry: Record<string, RegisteredAgentRegistryEntry>;
  outputContracts: Record<string, TrustedOutputContractRecord>;
  escrowVerificationRequirements: Record<string, EscrowVerificationRequirementRecord>;
  escrowVerificationResults: Record<string, ContractVerifyResult>;
  escrowHoldings: Record<string, EscrowHoldingRecord>;
  verificationAttestations: Record<string, SignedVerificationAttestation>;
}

function defaultState(): PersistedRuntimeState {
  return {
    version: '1',
    updatedAt: new Date(0).toISOString(),
    invoices: {},
    escrows: {},
    extendedEscrows: {},
    bonds: {},
    disputes: {},
    creditScores: {},
    mutationCache: {},
    agentRegistry: {},
    outputContracts: {},
    escrowVerificationRequirements: {},
    escrowVerificationResults: {},
    escrowHoldings: {},
    verificationAttestations: {},
  };
}

export class DurableStateStore {
  private state: PersistedRuntimeState;

  constructor(
    private readonly filePath: string = './data/ccap-runtime-state.json',
  ) {
    this.ensureDirectory();
    this.state = this.loadState();
  }

  read(): PersistedRuntimeState {
    this.state = this.loadState();
    return structuredClone(this.state);
  }

  transaction<T>(mutator: (draft: PersistedRuntimeState) => T): T {
    const latest = this.loadState();
    const draft = structuredClone(latest);
    const result = mutator(draft);
    draft.updatedAt = new Date().toISOString();
    this.flush(draft);
    this.state = draft;
    return result;
  }

  private ensureDirectory(): void {
    const directory = path.dirname(this.filePath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  private loadState(): PersistedRuntimeState {
    if (!fs.existsSync(this.filePath)) {
      const fresh = defaultState();
      this.flush(fresh);
      return fresh;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<PersistedRuntimeState>;
      return {
        ...defaultState(),
        ...parsed,
      };
    } catch {
      const fresh = defaultState();
      this.flush(fresh);
      return fresh;
    }
  }

  private flush(nextState: PersistedRuntimeState): void {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(nextState, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }
}
