// Public customer API — no auth; shop scoping via :slug, booking access via
// unguessable manage_token.
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/client.js';
import {
  getShopBySlug,
  availability,
  createBooking,
  quoteCancellation,
  cancelBooking,
  rescheduleBooking,
  expirePendingHolds,
  BookingError,
} from '../core/bookingService.js';
import { policyText } from '@prelo-booking/shared';
import { paymentsProvider } from '../payments/index.js';

export const publicRouter = Router();

function fail(res: import('express').Response, err: unknown) {
  if (err instanceof BookingError) {
    const status =
      err.code === 'NOT_FOUND' ? 404 : err.code === 'SLOT_TAKEN' ? 409 : 400;
    return res.status(status).json({ error: err.code, message: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'INTERNAL', message: 'something went wrong' });
}

publicRouter.get('/shops/:slug', async (req, res) => {
  const shop = await getShopBySlug(req.params.slug);
  if (!shop) return res.status(404).json({ error: 'NOT_FOUND' });
  const [services, staff] = await Promise.all([
    pool.query(
      'SELECT id, name, duration_min, price_cents FROM services WHERE shop_id = $1 AND active ORDER BY price_cents',
      [shop.id],
    ),
    pool.query(
      'SELECT id, display_name, color FROM staff WHERE shop_id = $1 AND active ORDER BY display_name',
      [shop.id],
    ),
  ]);
  res.json({
    shop: {
      slug: shop.slug,
      name: shop.name,
      timezone: shop.timezone,
      currency: shop.currency,
      cancelCutoffHours: shop.cancel_cutoff_hours,
      lateCancelFeeCents: shop.late_cancel_fee_cents,
      policyText: policyText(shop.cancel_cutoff_hours, shop.late_cancel_fee_cents, shop.currency),
    },
    services: services.rows.map((s) => ({
      id: s.id, name: s.name, durationMin: s.duration_min, priceCents: s.price_cents,
    })),
    staff: staff.rows.map((s) => ({ id: s.id, displayName: s.display_name, color: s.color })),
    payments: { mode: paymentsProvider.mode, publishableKey: paymentsProvider.publishableKey() },
  });
});

publicRouter.get('/shops/:slug/availability', async (req, res) => {
  try {
    const q = z
      .object({ service: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), staff: z.string().uuid().optional() })
      .parse(req.query);
    const shop = await getShopBySlug(req.params.slug);
    if (!shop) return res.status(404).json({ error: 'NOT_FOUND' });
    await expirePendingHolds(); // lazily release stale holds before quoting
    const { slots } = await availability(shop, q.service, q.date, q.staff);
    res.json({ slots });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'BAD_REQUEST', issues: err.issues });
    fail(res, err);
  }
});

publicRouter.post('/shops/:slug/bookings', async (req, res) => {
  try {
    const body = z
      .object({
        serviceId: z.string().uuid(),
        staffId: z.union([z.string().uuid(), z.literal('any')]),
        startsAt: z.string(),
        customer: z.object({
          name: z.string().min(1).max(120),
          phone: z.string(),
          email: z.string().email().optional().nullable(),
        }),
        policyAck: z.boolean(),
      })
      .parse(req.body);
    const shop = await getShopBySlug(req.params.slug);
    if (!shop) return res.status(404).json({ error: 'NOT_FOUND' });
    const result = await createBooking({ shop, ...body, source: 'web' });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'BAD_REQUEST', issues: err.issues });
    fail(res, err);
  }
});

// ── Manage page (token = capability) ─────────────────────────────────────────

publicRouter.get('/manage/:token', async (req, res) => {
  try {
    const { booking: b, quote } = await quoteCancellation(req.params.token);
    res.json({
      booking: {
        id: b.id, status: b.status, startsAt: b.starts_at, endsAt: b.ends_at,
        serviceName: b.service_name, staffName: b.staff_name,
        shopName: b.shop_name, shopSlug: b.shop_slug, timezone: b.timezone,
        amountCents: b.amount_cents, currency: b.currency,
        customerName: b.customer_name, lateFeeCents: b.late_fee_cents,
      },
      cancellation: quote,
      rescheduleAllowed: quote.kind === 'free' && b.status === 'confirmed',
    });
  } catch (err) {
    fail(res, err);
  }
});

publicRouter.post('/manage/:token/cancel', async (req, res) => {
  try {
    const body = z.object({ feeAccepted: z.boolean().optional() }).parse(req.body ?? {});
    const result = await cancelBooking(req.params.token, {
      actor: 'customer:self-serve',
      feeAccepted: body.feeAccepted,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    fail(res, err);
  }
});

publicRouter.post('/manage/:token/reschedule', async (req, res) => {
  try {
    const body = z.object({ startsAt: z.string() }).parse(req.body);
    const result = await rescheduleBooking(req.params.token, body.startsAt, 'customer:self-serve');
    res.json({ ok: true, ...result });
  } catch (err) {
    fail(res, err);
  }
});
