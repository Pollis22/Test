// PaymentsProvider — one interface, two implementations.
// SAFETY RAIL: stripe implementation only ever receives sk_test_ keys (env.ts
// refuses anything else); no live charges are possible from this codebase.

export interface CreateIntentInput {
  amountCents: number;
  currency: string;
  bookingId: string;
  shopId: string;
  /** Stripe Connect destination account; absent → charge platform account */
  stripeAccountId?: string | null;
  customerEmail?: string | null;
}

export interface CreatedIntent {
  intentId: string;
  clientSecret: string;
  provider: 'stripe' | 'mock';
}

export interface RefundInput {
  intentId: string;
  amountCents: number; // partial allowed (late-fee refunds)
}

export interface PaymentsProvider {
  readonly mode: 'stripe' | 'mock';
  createIntent(input: CreateIntentInput): Promise<CreatedIntent>;
  refund(input: RefundInput): Promise<{ refundId: string }>;
  cancelIntent(intentId: string): Promise<void>;
  /** Connect onboarding link for a shop (mock returns a placeholder URL). */
  connectOnboardingLink(shopId: string, returnUrl: string): Promise<{ url: string; accountId: string }>;
  publishableKey(): string | null;
}
