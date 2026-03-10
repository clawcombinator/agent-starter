// ============================================================
// AgentWallet — thin wrapper around the Coinbase CDP SDK.
//
// Includes an idempotency cache so duplicate pay() calls
// (e.g. from retries) return the cached transaction hash
// without sending a second on-chain transfer.
//
// TODO: Replace the in-memory idempotency Map with Redis for
// multi-instance deployments.
// ============================================================

import { Coinbase, Wallet } from '@coinbase/coinbase-sdk';
import crypto from 'node:crypto';
import type { BalanceResult, PayParams, PayResult, WalletStatus } from './types.js';

interface IdempotencyCacheEntry {
  transactionHash: string;
  timestamp: string;
}

export class AgentWallet {
  private wallet: Wallet | null = null;
  private walletAddress: string | null = null;
  private network: string;
  // In-memory idempotency cache — keyed by SHA-256(params)
  private readonly idempotencyCache = new Map<string, IdempotencyCacheEntry>();

  constructor(
    private readonly apiKeyName: string,
    private readonly apiKeyPrivateKey: string,
    network: string = 'base-sepolia',
  ) {
    this.network = network;
  }

  // ----------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------

  async initialize(): Promise<void> {
    Coinbase.configure({
      apiKeyName: this.apiKeyName,
      privateKey: this.apiKeyPrivateKey,
    });

    // Attempt to load a persisted wallet seed from the env-provided address.
    // In a real deployment you would load the wallet seed from a secret store.
    const walletsPage = await Wallet.listWallets();
    const walletList = walletsPage.data;
    if (walletList.length > 0) {
      this.wallet = walletList[0];
    } else {
      // Create a new wallet on first run
      this.wallet = await Wallet.create({ networkId: this.network });
    }

    const defaultAddress = await this.wallet!.getDefaultAddress();
    this.walletAddress = defaultAddress.getId();
  }

  // ----------------------------------------------------------
  // Queries
  // ----------------------------------------------------------

  async getBalance(currency: string = 'USDC'): Promise<string> {
    this.assertInitialized();
    const balance = await this.wallet!.getBalance(Coinbase.assets[currency as keyof typeof Coinbase.assets] ?? currency);
    return balance.toString();
  }

  async getStatus(): Promise<WalletStatus> {
    this.assertInitialized();
    const address = this.walletAddress!;
    const usdcBalance = await this.getBalance('USDC').catch(() => '0');
    const ethBalance = await this.getBalance('ETH').catch(() => '0');
    return {
      address,
      network: this.network,
      balances: { USDC: usdcBalance, ETH: ethBalance },
    };
  }

  get address(): string | null {
    return this.walletAddress;
  }

  get isConnected(): boolean {
    return this.wallet !== null;
  }

  // ----------------------------------------------------------
  // Payments
  // ----------------------------------------------------------

  /**
   * Transfer funds to a recipient address.
   * Idempotent [safe to repeat]: duplicate calls with the same params
   * return the cached transaction hash without a second on-chain transfer.
   */
  async pay(params: PayParams): Promise<PayResult> {
    this.assertInitialized();

    const idempotencyKey = this.generateIdempotencyKey(params);

    // Cache hit — return early without a second transfer
    const cached = this.idempotencyCache.get(idempotencyKey);
    if (cached) {
      return { transactionHash: cached.transactionHash, idempotencyKey, fromCache: true };
    }

    const assetId =
      Coinbase.assets[params.currency as keyof typeof Coinbase.assets] ?? params.currency;

    const transfer = await this.wallet!.createTransfer({
      amount: params.amount,
      assetId,
      destination: params.recipient,
    });

    await transfer.wait();

    const transactionHash = transfer.getTransactionHash() ?? transfer.getId();

    // Store in idempotency cache
    this.idempotencyCache.set(idempotencyKey, {
      transactionHash,
      timestamp: new Date().toISOString(),
    });

    return { transactionHash, idempotencyKey, fromCache: false };
  }

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------

  /**
   * Derive a deterministic key from payment params.
   * SHA-256 of the canonical JSON ensures identical params → identical key.
   */
  generateIdempotencyKey(params: PayParams): string {
    const canonical = JSON.stringify(params, Object.keys(params as object).sort());
    const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
    return `pay_${hash}`;
  }

  private assertInitialized(): void {
    if (!this.wallet) {
      throw new Error('AgentWallet not initialised — call initialize() first');
    }
  }
}

// ----------------------------------------------------------
// Balance query helper that mirrors CCAP balance() tool output
// ----------------------------------------------------------

export async function queryBalance(wallet: AgentWallet, params: { wallet?: string; currency: string }): Promise<BalanceResult> {
  const balance = await wallet.getBalance(params.currency);
  return {
    wallet: params.wallet ?? wallet.address ?? 'unknown',
    currency: params.currency,
    balance,
    timestamp: new Date().toISOString(),
  };
}
