// Environment parsing + feature-flag derivation.
// House rule: missing secret → mock + flag + runbook entry, never a crash.

export interface Env {
  nodeEnv: string;
  port: number;
  appBaseUrl: string;
  sessionSecret: string;
  databaseUrl: string | null;
  paymentsMode: 'stripe' | 'mock';
  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
  stripePublishableKey: string | null;
  emailMode: 'resend' | 'mock';
  resendApiKey: string | null;
  emailFrom: string;
  elevenLabsApiKey: string | null;
  elevenLabsToolSecret: string;
  googleCalendarEnabled: boolean;
  googleClientId: string | null;
  googleClientSecret: string | null;
}

function opt(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : null;
}

export function loadEnv(): Env {
  const stripeSecretKey = opt('STRIPE_SECRET_KEY');
  // SAFETY RAIL: test mode only. A live key is treated as absent (mock mode).
  const stripeTestKey =
    stripeSecretKey && stripeSecretKey.startsWith('sk_test_') ? stripeSecretKey : null;
  if (stripeSecretKey && !stripeTestKey) {
    console.warn('[env] STRIPE_SECRET_KEY is not a test key — refusing it; payments=mock');
  }
  const resendApiKey = opt('RESEND_API_KEY');
  const googleClientId = opt('GOOGLE_CLIENT_ID');
  const googleClientSecret = opt('GOOGLE_CLIENT_SECRET');

  const paymentsMode =
    (opt('PAYMENTS_MODE') as 'stripe' | 'mock' | null) ?? (stripeTestKey ? 'stripe' : 'mock');
  const emailMode =
    (opt('EMAIL_MODE') as 'resend' | 'mock' | null) ?? (resendApiKey ? 'resend' : 'mock');
  const googleCalendarEnabled =
    opt('GOOGLE_CALENDAR_ENABLED') === 'true' ||
    (opt('GOOGLE_CALENDAR_ENABLED') === null && !!googleClientId && !!googleClientSecret);

  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3001),
    appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5173',
    sessionSecret: process.env.SESSION_SECRET ?? 'dev-session-secret',
    databaseUrl: opt('DATABASE_URL'),
    paymentsMode: paymentsMode === 'stripe' && stripeTestKey ? 'stripe' : 'mock',
    stripeSecretKey: stripeTestKey,
    stripeWebhookSecret: opt('STRIPE_WEBHOOK_SECRET'),
    stripePublishableKey: opt('STRIPE_PUBLISHABLE_KEY'),
    emailMode,
    resendApiKey,
    emailFrom: process.env.EMAIL_FROM ?? 'bookings@prelobooking.example',
    elevenLabsApiKey: opt('ELEVENLABS_API_KEY'),
    elevenLabsToolSecret: process.env.ELEVENLABS_TOOL_SECRET ?? 'dev-tool-secret-change-me',
    googleCalendarEnabled,
    googleClientId,
    googleClientSecret,
  };
}

export const env = loadEnv();
