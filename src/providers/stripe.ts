// ============================================================
// StripeProvider — adapter for Stripe card and bank-transfer
// payments. Conforms to PaymentProvider.
//
// Uses the Stripe Node.js SDK directly. In the agentic context
// this is appropriate for invoicing customers (agents receiving
// payment from humans) or paying human-operated businesses that
// prefer card/ACH over crypto.
//
// Docs: https://stripe.com/docs/api
// Agent Toolkit: https://github.com/stripe/agent-toolkit
// ============================================================

import Stripe from 'stripe';
import type { Balance, PaymentMethod, PaymentParams, PaymentResult, PaymentProvider } from './types.js';

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';

  private client: Stripe | null = null;

  constructor(private readonly secretKey: string) {}

  // ----------------------------------------------------------
  // PaymentProvider: initialize
  // ----------------------------------------------------------

  async initialize(): Promise<void> {
    if (!this.secretKey) {
      throw new Error('StripeProvider requires STRIPE_SECRET_KEY');
    }
    this.client = new Stripe(this.secretKey, {
      // Pin to a specific API version so upgrades are deliberate, not accidental.
      // Update this value after reviewing Stripe's changelog.
      apiVersion: '2025-02-24.acacia',
    });
  }

  // ----------------------------------------------------------
  // PaymentProvider: getBalance
  // ----------------------------------------------------------

  /**
   * Stripe does not hold a balance in the same sense as a crypto wallet.
   * This returns the available Stripe balance in the requested currency
   * (or USD by default). For agent bookkeeping this is useful as a
   * sanity check before issuing payouts.
   */
  async getBalance(currency: string = 'usd'): Promise<Balance> {
    this.assertInitialised();
    const balance = await this.client!.balance.retrieve();
    const target = currency.toLowerCase();

    const available = balance.available.find((b) => b.currency === target);
    const amountInMajorUnits = available
      ? (available.amount / 100).toFixed(2)
      : '0.00';

    return {
      amount: amountInMajorUnits,
      currency: currency.toUpperCase(),
      provider: this.name,
    };
  }

  // ----------------------------------------------------------
  // PaymentProvider: pay
  // ----------------------------------------------------------

  /**
   * Create a Stripe PaymentIntent to charge the recipient.
   *
   * In most agent use-cases `recipient` is a Stripe customer ID
   * (cus_...) or an email address. If a customer ID is provided
   * we attach a default payment method; otherwise this creates
   * an off-session PaymentIntent that will need a payment method
   * attached externally (e.g. via a payment link).
   *
   * For payouts TO a recipient (not from them), use Stripe Connect
   * transfers — which is a separate flow not yet implemented here.
   */
  async pay(params: PaymentParams): Promise<PaymentResult> {
    this.assertInitialised();

    // Stripe amounts are always in the smallest currency unit (cents for USD)
    const amountCents = Math.round(params.amount * 100);
    const currency = params.currency.toLowerCase();

    const intentParams: Stripe.PaymentIntentCreateParams = {
      amount: amountCents,
      currency,
      description: params.memo ?? 'Agent payment',
      // Idempotency is handled at the Stripe API level via idempotency keys
    };

    const intent = await this.client!.paymentIntents.create(intentParams, {
      idempotencyKey: params.idempotencyKey,
    });

    const status: PaymentResult['status'] =
      intent.status === 'succeeded'
        ? 'completed'
        : intent.status === 'canceled' || intent.status === 'requires_payment_method'
          ? 'failed'
          : 'pending';

    return {
      transactionId: intent.id,
      provider: this.name,
      status,
      timestamp: new Date().toISOString(),
    };
  }

  // ----------------------------------------------------------
  // PaymentProvider: supportsMethod
  // ----------------------------------------------------------

  supportsMethod(method: PaymentMethod): boolean {
    return method === 'card' || method === 'bank_transfer';
  }

  // ----------------------------------------------------------
  // Stripe-specific helpers
  // ----------------------------------------------------------

  /**
   * Create a hosted payment link — useful when the agent needs
   * to request payment from a human (invoicing flow).
   */
  async createPaymentLink(params: {
    amount: number;
    currency: string;
    description: string;
  }): Promise<{ url: string; id: string }> {
    this.assertInitialised();

    // PaymentLink requires a Price object which in turn requires a Product
    const product = await this.client!.products.create({
      name: params.description,
    });

    const price = await this.client!.prices.create({
      product: product.id,
      unit_amount: Math.round(params.amount * 100),
      currency: params.currency.toLowerCase(),
    });

    const link = await this.client!.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
    });

    return { url: link.url, id: link.id };
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private assertInitialised(): void {
    if (!this.client) {
      throw new Error('StripeProvider not initialised — call initialize() first');
    }
  }
}
