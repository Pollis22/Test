// Payment webhooks. Stripe mode: signature-verified events. Mock mode:
// POST /api/payments/mock/confirm drives the identical success path so the
// full lifecycle is testable without keys.
import { Router, raw, json } from 'express';
import { z } from 'zod';
import { paymentsProvider } from '../payments/index.js';
import { StripePaymentsProvider } from '../payments/stripeProvider.js';
import { markMockIntentSucceeded, getMockIntent } from '../payments/mockProvider.js';
import { handlePaymentSucceeded, handlePaymentFailed } from '../core/bookingService.js';

export const webhooksRouter = Router();

// Stripe requires the raw body for signature verification.
webhooksRouter.post('/stripe', raw({ type: 'application/json' }), async (req, res) => {
  if (!(paymentsProvider instanceof StripePaymentsProvider)) {
    return res.status(400).json({ error: 'stripe not configured' });
  }
  let event;
  try {
    event = paymentsProvider.verifyWebhook(req.body as Buffer, req.header('stripe-signature') ?? '');
  } catch (err) {
    return res.status(400).json({ error: `webhook signature: ${(err as Error).message}` });
  }
  try {
    if (event.type === 'payment_intent.succeeded') {
      await handlePaymentSucceeded((event.data.object as { id: string }).id);
    } else if (event.type === 'payment_intent.payment_failed') {
      await handlePaymentFailed((event.data.object as { id: string }).id);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error', err);
    res.status(500).json({ error: 'handler failed' });
  }
});

// Mock checkout confirm — only exists in mock mode. This router mounts before
// the app-level express.json() (stripe needs the raw body), so parse json here.
webhooksRouter.post('/mock/confirm', json(), async (req, res) => {
  try {
    if (paymentsProvider.mode !== 'mock') return res.status(404).json({ error: 'NOT_FOUND' });
    const body = z.object({ intentId: z.string(), outcome: z.enum(['succeed', 'fail']).default('succeed') }).parse(req.body ?? {});
    const intent = getMockIntent(body.intentId);
    if (!intent) return res.status(404).json({ error: 'intent not found' });
    if (body.outcome === 'fail') {
      await handlePaymentFailed(body.intentId);
      return res.json({ ok: true, status: 'failed' });
    }
    markMockIntentSucceeded(body.intentId);
    const bookingId = await handlePaymentSucceeded(body.intentId);
    res.json({ ok: true, status: 'succeeded', bookingId });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'BAD_REQUEST', issues: err.issues });
    console.error('[webhook:mock]', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});
