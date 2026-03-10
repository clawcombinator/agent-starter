// ============================================================
// CoinbaseProvider — thin adapter around @coinbase/coinbase-sdk
// AgentKit. Conforms to PaymentProvider so it can be registered
// with PaymentRouter alongside Stripe, x402, etc.
//
// Idempotency cache: duplicate pay() calls with the same key
// return the cached result without a second on-chain transfer.
// TODO: replace in-memory cache with Redis for multi-instance
// deployments.
// ============================================================

import { Coinbase, Wallet } from '@coinbase/coinbase-sdk';
import crypto from 'node:crypto';
import type { Balance, PaymentMethod, PaymentParams, PaymentResult, PaymentProvider } from './types.js';

// Internal idempotency cache entry
interface CacheEntry {
  transactionId: string;
  timestamp: string;
}

export class CoinbaseProvider implements PaymentProvider {
  readonly name = 'coinbase';

  private wallet: Wallet | null = null;
  private walletAddress: string | null = null;
  private readonly idempotencyCache = new Map<string, CacheEntry>();

  constructor(
    private readonly apiKeyName: string,
    private readonly apiKeyPrivateKey: string,
    private readonly network: string = 'base-sepolia',
  ) {}

  // ----------------------------------------------------------
  // PaymentProvider: initialize
  // ----------------------------------------------------------

  async initialize(): Promise<void> {
    Coinbase.configure({
      apiKeyName: this.apiKeyName,
      privateKey: this.apiKeyPrivateKey,
    });

    // Load existing wallet or create one on first run.
    // In production, load the seed from a secret manager (Vault, GCP Secret Manager, etc.).
    const walletsPage = await Wallet.listWallets();
    const walletList = walletsPage.data;

    if (walletList.length > 0) {
      this.wallet = walletList[0]!;
    } else {
      this.wallet = await Wallet.create({ networkId: this.network });
    }

    const defaultAddress = await this.wallet.getDefaultAddress();
    this.walletAddress = defaultAddress.getId();
  }

  // ----------------------------------------------------------
  // PaymentProvider: getBalance
  // ----------------------------------------------------------

  async getBalance(currency: string = 'USDC'): Promise<Balance> {
    this.assertInitialised();
    const assetId = Coinbase.assets[currency as keyof typeof Coinbase.assets] ?? currency;
    const raw = await this.wallet!.getBalance(assetId);
    return {
      amount: raw.toString(),
      currency,
      provider: this.name,
    };
  }

  // ----------------------------------------------------------
  // PaymentProvider: pay
  // ----------------------------------------------------------

  async pay(params: PaymentParams): Promise<PaymentResult> {
    this.assertInitialised();

    const idempotencyKey = params.idempotencyKey ?? this.deriveIdempotencyKey(params);

    // Cache hit — return early without a second on-chain transfer
    const cached = this.idempotencyCache.get(idempotencyKey);
    if (cached) {
      return {
        transactionId: cached.transactionId,
        provider: this.name,
        status: 'completed',
        timestamp: cached.timestamp,
      };
    }

    const assetId = Coinbase.assets[params.currency as keyof typeof Coinbase.assets] ?? params.currency;

    const transfer = await this.wallet!.createTransfer({
      amount: params.amount,
      assetId,
      destination: params.recipient,
    });

    await transfer.wait();

    const transactionId = transfer.getTransactionHash() ?? transfer.getId();
    const timestamp = new Date().toISOString();

    this.idempotencyCache.set(idempotencyKey, { transactionId, timestamp });

    return {
      transactionId,
      provider: this.name,
      status: 'completed',
      timestamp,
    };
  }

  // ----------------------------------------------------------
  // PaymentProvider: supportsMethod
  // ----------------------------------------------------------

  supportsMethod(method: PaymentMethod): boolean {
    return method === 'crypto';
  }

  // ----------------------------------------------------------
  // Additional helpers (used by health endpoint)
  // ----------------------------------------------------------

  get address(): string | null {
    return this.walletAddress;
  }

  get isConnected(): boolean {
    return this.wallet !== null;
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  /**
   * Derive a deterministic idempotency key from payment params.
   * SHA-256 of the canonical JSON — identical params → identical key.
   */
  private deriveIdempotencyKey(params: PaymentParams): string {
    const canonical = JSON.stringify(params, Object.keys(params as object).sort());
    const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
    return `coinbase_${hash}`;
  }

  private assertInitialised(): void {
    if (!this.wallet) {
      throw new Error('CoinbaseProvider not initialised — call initialize() first');
    }
  }
}
