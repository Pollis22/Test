// Stripe TEST-MODE provider. Instantiated only when env.stripeSecretKey is a
// verified sk_test_ key. Destination charges to the shop's connected account
// (application_fee_amount 0 for now — platform fee % is backlog); a shop with
// no connected account charges the platform account (runbook-flagged).
import Stripe from 'stripe';
import type { PaymentsProvider, CreateIntentInput, RefundInput } from './provider.js';
import { env } from '../env.js';

export class StripePaymentsProvider implements PaymentsProvider {
  readonly mode = 'stripe' as const;
  private stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, { apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion });
  }

  async createIntent(input: CreateIntentInput) {
    const params: Stripe.PaymentIntentCreateParams = {
      amount: input.amountCents,
      currency: input.currency,
      metadata: { booking_id: input.bookingId, shop_id: input.shopId },
      automatic_payment_methods: { enabled: true },
      receipt_email: input.customerEmail ?? undefined,
    };
    if (input.stripeAccountId) {
      params.transfer_data = { destination: input.stripeAccountId };
      params.application_fee_amount = 0;
    }
    const pi = await this.stripe.paymentIntents.create(params);
    return { intentId: pi.id, clientSecret: pi.client_secret!, provider: this.mode };
  }

  async refund(input: RefundInput) {
    const re = await this.stripe.refunds.create({
      payment_intent: input.intentId,
      amount: input.amountCents,
    });
    return { refundId: re.id };
  }

  async cancelIntent(intentId: string) {
    try {
      await this.stripe.paymentIntents.cancel(intentId);
    } catch {
      /* already succeeded/canceled — expiry sweep tolerates this */
    }
  }

  async connectOnboardingLink(shopId: string, returnUrl: string) {
    const account = await this.stripe.accounts.create({
      type: 'express',
      metadata: { shop_id: shopId },
    });
    const link = await this.stripe.accountLinks.create({
      account: account.id,
      refresh_url: returnUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });
    return { url: link.url, accountId: account.id };
  }

  publishableKey() {
    return env.stripePublishableKey;
  }

  verifyWebhook(payload: Buffer, signature: string): Stripe.Event {
    if (!env.stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET missing');
    return this.stripe.webhooks.constructEvent(payload, signature, env.stripeWebhookSecret);
  }
}
