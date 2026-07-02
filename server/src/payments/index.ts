import { env } from '../env.js';
import type { PaymentsProvider } from './provider.js';
import { MockPaymentsProvider } from './mockProvider.js';
import { StripePaymentsProvider } from './stripeProvider.js';

export const paymentsProvider: PaymentsProvider =
  env.paymentsMode === 'stripe' && env.stripeSecretKey
    ? new StripePaymentsProvider(env.stripeSecretKey)
    : new MockPaymentsProvider();

console.log(`[payments] mode=${paymentsProvider.mode}`);
export type { PaymentsProvider };
