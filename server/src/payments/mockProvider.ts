// Mock provider: deterministic, in-memory, API-shaped like Stripe test mode.
// Used automatically when STRIPE_SECRET_KEY is absent. The client's mock
// checkout calls POST /api/payments/mock/confirm which routes through the
// same success path the Stripe webhook uses — so the whole booking lifecycle
// is exercised even without keys.
import { randomBytes } from 'node:crypto';
import type { PaymentsProvider, CreateIntentInput, RefundInput } from './provider.js';

export interface MockIntent {
  id: string;
  clientSecret: string;
  amountCents: number;
  currency: string;
  bookingId: string;
  shopId: string;
  status: 'requires_payment' | 'succeeded' | 'canceled';
  refundedCents: number;
}

const intents = new Map<string, MockIntent>();

export function getMockIntent(id: string): MockIntent | undefined {
  return intents.get(id);
}

export function markMockIntentSucceeded(id: string): MockIntent | undefined {
  const it = intents.get(id);
  if (it && it.status === 'requires_payment') it.status = 'succeeded';
  return it;
}

export class MockPaymentsProvider implements PaymentsProvider {
  readonly mode = 'mock' as const;

  async createIntent(input: CreateIntentInput) {
    const id = `pi_mock_${randomBytes(10).toString('hex')}`;
    const intent: MockIntent = {
      id,
      clientSecret: `${id}_secret_${randomBytes(8).toString('hex')}`,
      amountCents: input.amountCents,
      currency: input.currency,
      bookingId: input.bookingId,
      shopId: input.shopId,
      status: 'requires_payment',
      refundedCents: 0,
    };
    intents.set(id, intent);
    return { intentId: id, clientSecret: intent.clientSecret, provider: this.mode };
  }

  async refund(input: RefundInput) {
    const it = intents.get(input.intentId);
    if (it) it.refundedCents += input.amountCents;
    return { refundId: `re_mock_${randomBytes(10).toString('hex')}` };
  }

  async cancelIntent(intentId: string) {
    const it = intents.get(intentId);
    if (it && it.status === 'requires_payment') it.status = 'canceled';
  }

  async connectOnboardingLink(shopId: string, returnUrl: string) {
    return {
      url: `${returnUrl}?mock_connect=1&shop=${shopId}`,
      accountId: `acct_mock_${randomBytes(6).toString('hex')}`,
    };
  }

  publishableKey() {
    return null;
  }
}
