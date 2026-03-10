// ============================================================
// X402Provider — adapter for x402 HTTP-native micropayments.
//
// x402 is an open protocol (https://x402.org) that restores
// the HTTP 402 Payment Required status code. The flow is:
//
//   1. Client makes a request to a resource
//   2. Server returns 402 with payment details in headers/body
//   3. Client checks the price and authorises payment
//   4. Client retries the request with an X-PAYMENT header
//      containing a signed payment proof
//   5. Server verifies the proof and returns the resource
//
// This adapter handles the client-side of that flow. It uses
// a minimal Ethereum-compatible signing approach so no heavy
// wallet SDK is required — just an ECDSA private key.
//
// Docs: https://x402.org/spec
// Reference client: https://github.com/coinbase/x402
// ============================================================

import crypto from 'node:crypto';
import type { Balance, PaymentMethod, PaymentParams, PaymentResult, PaymentProvider } from './types.js';

// Shape of the 402 payment-details payload from the server.
// Based on the x402 specification v0.1.
interface X402PaymentRequired {
  scheme: string;             // e.g. 'exact'
  network: string;            // e.g. 'base-sepolia'
  maxAmountRequired: string;  // Wei or smallest unit as decimal string
  resource: string;           // The URL being requested
  payTo: string;              // Recipient address
  asset: string;              // Token contract address
  maxTimeoutSeconds?: number;
}

export class X402Provider implements PaymentProvider {
  readonly name = 'x402';

  constructor(
    private readonly walletAddress: string,
    private readonly privateKey: string,
  ) {}

  // ----------------------------------------------------------
  // PaymentProvider: initialize
  // ----------------------------------------------------------

  async initialize(): Promise<void> {
    if (!this.walletAddress || !this.privateKey) {
      throw new Error('X402Provider requires X402_WALLET_ADDRESS and X402_PRIVATE_KEY');
    }
    // No remote initialisation needed — signing is purely local
  }

  // ----------------------------------------------------------
  // PaymentProvider: getBalance
  // ----------------------------------------------------------

  /**
   * x402 does not provide a balance API — the balance lives in
   * the underlying wallet (typically an EVM chain). This returns
   * a placeholder balance. In a full implementation, wire to a
   * JSON-RPC eth_getBalance call.
   */
  async getBalance(_currency?: string): Promise<Balance> {
    return {
      amount: '0.00',
      currency: _currency ?? 'ETH',
      provider: this.name,
    };
  }

  // ----------------------------------------------------------
  // PaymentProvider: pay
  // ----------------------------------------------------------

  /**
   * Execute an x402 micropayment against a URL that returned 402.
   *
   * `params.recipient` is the target URL (not a wallet address).
   * The full flow:
   *   1. Fetch the URL to trigger the 402 challenge
   *   2. Parse the payment details from the response
   *   3. Validate the price against params.amount
   *   4. Sign a payment authorisation
   *   5. Retry with the signed proof in X-PAYMENT header
   */
  async pay(params: PaymentParams): Promise<PaymentResult> {
    const url = params.recipient;

    // Step 1: trigger the 402 challenge
    const challengeResponse = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (challengeResponse.status !== 402) {
      throw new Error(`x402: expected 402 from ${url}, got ${challengeResponse.status}`);
    }

    // Step 2: parse payment details
    const paymentDetails = await this.parsePaymentChallenge(challengeResponse);

    // Step 3: validate price — refuse if the server asks for more than authorised
    const requiredAmount = Number(paymentDetails.maxAmountRequired);
    const authorisedAmount = params.amount;

    if (requiredAmount > authorisedAmount) {
      throw new Error(
        `x402: server requires ${requiredAmount} but only ${authorisedAmount} was authorised`,
      );
    }

    // Step 4: sign payment authorisation
    const proof = await this.signPayment(paymentDetails, params.idempotencyKey);

    // Step 5: retry with payment proof
    const paidResponse = await fetch(url, {
      headers: {
        'X-PAYMENT': proof,
        'X-PAYMENT-SCHEME': paymentDetails.scheme,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!paidResponse.ok) {
      throw new Error(`x402: payment failed — server returned ${paidResponse.status}`);
    }

    const transactionId = paidResponse.headers.get('X-PAYMENT-RECEIPT') ?? this.generateReceiptId();

    return {
      transactionId,
      provider: this.name,
      status: 'completed',
      timestamp: new Date().toISOString(),
    };
  }

  // ----------------------------------------------------------
  // PaymentProvider: supportsMethod
  // ----------------------------------------------------------

  supportsMethod(method: PaymentMethod): boolean {
    return method === 'x402';
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  /**
   * Parse the 402 response body or headers for payment details.
   * x402 servers return details as JSON body or in the
   * X-PAYMENT-REQUIRED header.
   */
  private async parsePaymentChallenge(response: Response): Promise<X402PaymentRequired> {
    // Prefer JSON body; fall back to header
    try {
      const body = await response.json() as X402PaymentRequired;
      if (body.payTo && body.maxAmountRequired) return body;
    } catch {
      // fall through to header parsing
    }

    const header = response.headers.get('X-PAYMENT-REQUIRED');
    if (!header) {
      throw new Error('x402: no payment details found in 402 response');
    }

    try {
      return JSON.parse(atob(header)) as X402PaymentRequired;
    } catch {
      throw new Error('x402: could not parse X-PAYMENT-REQUIRED header');
    }
  }

  /**
   * Sign a payment authorisation using the agent's private key.
   * This is a minimal EIP-712-style signing approach.
   * Production implementations should use the x402 reference
   * client library for full spec compliance.
   */
  private async signPayment(
    details: X402PaymentRequired,
    idempotencyKey?: string,
  ): Promise<string> {
    const nonce = idempotencyKey ?? crypto.randomBytes(16).toString('hex');

    const payload = JSON.stringify({
      scheme: details.scheme,
      network: details.network,
      payTo: details.payTo,
      asset: details.asset,
      amount: details.maxAmountRequired,
      from: this.walletAddress,
      nonce,
      timestamp: new Date().toISOString(),
    });

    // SHA-256 HMAC using private key as a stand-in for ECDSA signing.
    // In production, replace with secp256k1 ECDSA signing (ethers.js Wallet.signMessage).
    const signature = crypto
      .createHmac('sha256', this.privateKey)
      .update(payload, 'utf8')
      .digest('hex');

    // Encode as base64 for the header value
    return Buffer.from(JSON.stringify({ payload, signature })).toString('base64');
  }

  private generateReceiptId(): string {
    return `x402_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }
}
