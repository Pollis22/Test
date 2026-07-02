// Barber dashboard API — everything scoped to req.user.shopId (multi-tenant).
import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { pool } from '../db/client.js';
import { requireAuth, requireRole } from './auth.js';
import {
  createBooking,
  cancelBooking,
  BookingError,
  logEvent,
  type ShopRow,
} from '../core/bookingService.js';
import { paymentsProvider } from '../payments/index.js';
import { env } from '../env.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

function fail(res: import('express').Response, err: unknown) {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'BAD_REQUEST', issues: err.issues });
  if (err instanceof BookingError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'SLOT_TAKEN' ? 409 : 400;
    return res.status(status).json({ error: err.code, message: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'INTERNAL' });
}

async function myShop(shopId: string): Promise<ShopRow> {
  const r = await pool.query<ShopRow>('SELECT * FROM shops WHERE id = $1', [shopId]);
  return r.rows[0];
}

// ── Calendar ─────────────────────────────────────────────────────────────────

dashboardRouter.get('/calendar', async (req, res) => {
  try {
    const q = z.object({ from: z.string(), to: z.string() }).parse(req.query);
    const r = await pool.query(
      `SELECT b.id, b.staff_id, b.service_id, b.customer_id, b.starts_at, b.ends_at, b.status,
              b.source, b.amount_cents, b.late_fee_cents,
              c.name AS customer_name, c.phone AS customer_phone,
              sv.name AS service_name, st.display_name AS staff_name, st.color AS staff_color
         FROM bookings b
         JOIN customers c ON c.id = b.customer_id
         JOIN services sv ON sv.id = b.service_id
         JOIN staff st ON st.id = b.staff_id
        WHERE b.shop_id = $1 AND b.starts_at < $3 AND b.ends_at > $2
          AND b.status <> 'cancelled'
        ORDER BY b.starts_at`,
      [req.user!.shopId, q.from, q.to],
    );
    const off = await pool.query(
      `SELECT t.id, t.staff_id, t.starts_at, t.ends_at, t.reason
         FROM time_off t JOIN staff s ON s.id = t.staff_id
        WHERE s.shop_id = $1 AND t.starts_at < $3 AND t.ends_at > $2`,
      [req.user!.shopId, q.from, q.to],
    );
    res.json({ bookings: r.rows, timeOff: off.rows });
  } catch (err) {
    fail(res, err);
  }
});

// Staff-side booking create (skips payment, confirmed immediately).
dashboardRouter.post('/bookings', async (req, res) => {
  try {
    const body = z
      .object({
        serviceId: z.string().uuid(),
        staffId: z.string().uuid(),
        startsAt: z.string(),
        customer: z.object({
          name: z.string().min(1),
          phone: z.string(),
          email: z.string().email().optional().nullable(),
        }),
      })
      .parse(req.body);
    const shop = await myShop(req.user!.shopId);
    const result = await createBooking({
      shop, ...body, source: 'dashboard', policyAck: true, skipPayment: true,
    });
    res.status(201).json(result);
  } catch (err) {
    fail(res, err);
  }
});

dashboardRouter.post('/bookings/:id/cancel', async (req, res) => {
  try {
    const result = await cancelBooking(
      req.params.id,
      { actor: `user:${req.user!.id}`, staffInitiated: true, feeAccepted: true },
      false,
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    fail(res, err);
  }
});

dashboardRouter.post('/bookings/:id/status', async (req, res) => {
  try {
    const body = z.object({ status: z.enum(['completed', 'no_show']) }).parse(req.body);
    const r = await pool.query(
      `UPDATE bookings SET status = $1 WHERE id = $2 AND shop_id = $3 AND status = 'confirmed' RETURNING id`,
      [body.status, req.params.id, req.user!.shopId],
    );
    if (!r.rowCount) return res.status(409).json({ error: 'BAD_STATE', message: 'only confirmed bookings' });
    await logEvent(pool, req.user!.shopId, `user:${req.user!.id}`, `booking.${body.status}`, `booking:${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

// ── Bookings list + customers ────────────────────────────────────────────────

dashboardRouter.get('/bookings', async (req, res) => {
  const q = z.object({ status: z.string().optional(), limit: z.coerce.number().max(200).default(50) }).parse(req.query);
  const r = await pool.query(
    `SELECT b.id, b.starts_at, b.status, b.source, b.amount_cents, b.late_fee_cents,
            c.name AS customer_name, c.phone AS customer_phone,
            sv.name AS service_name, st.display_name AS staff_name
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN services sv ON sv.id = b.service_id
       JOIN staff st ON st.id = b.staff_id
      WHERE b.shop_id = $1 ${q.status ? 'AND b.status = $3' : ''}
      ORDER BY b.starts_at DESC LIMIT $2`,
    q.status ? [req.user!.shopId, q.limit, q.status] : [req.user!.shopId, q.limit],
  );
  res.json({ bookings: r.rows });
});

dashboardRouter.get('/customers', async (req, res) => {
  const r = await pool.query(
    `SELECT c.id, c.name, c.phone, c.email, c.notes,
            count(b.id)::int AS visits,
            max(b.starts_at) FILTER (WHERE b.status = 'completed') AS last_visit
       FROM customers c LEFT JOIN bookings b ON b.customer_id = c.id
      WHERE c.shop_id = $1
      GROUP BY c.id ORDER BY c.name`,
    [req.user!.shopId],
  );
  res.json({ customers: r.rows });
});

dashboardRouter.get('/customers/:id', async (req, res) => {
  const c = await pool.query('SELECT * FROM customers WHERE id = $1 AND shop_id = $2', [
    req.params.id, req.user!.shopId,
  ]);
  if (!c.rowCount) return res.status(404).json({ error: 'NOT_FOUND' });
  const history = await pool.query(
    `SELECT b.id, b.starts_at, b.status, b.amount_cents, sv.name AS service_name, st.display_name AS staff_name
       FROM bookings b JOIN services sv ON sv.id = b.service_id JOIN staff st ON st.id = b.staff_id
      WHERE b.customer_id = $1 ORDER BY b.starts_at DESC`,
    [req.params.id],
  );
  res.json({ customer: c.rows[0], history: history.rows });
});

// ── Services CRUD ────────────────────────────────────────────────────────────

const serviceBody = z.object({
  name: z.string().min(1),
  durationMin: z.number().int().positive(),
  priceCents: z.number().int().nonnegative(),
  bufferAfterMin: z.number().int().nonnegative().default(0),
  active: z.boolean().default(true),
  staffIds: z.array(z.string().uuid()).default([]),
});

dashboardRouter.get('/services', async (req, res) => {
  const r = await pool.query(
    `SELECT s.*, coalesce(json_agg(ss.staff_id) FILTER (WHERE ss.staff_id IS NOT NULL), '[]') AS staff_ids
       FROM services s LEFT JOIN staff_services ss ON ss.service_id = s.id
      WHERE s.shop_id = $1 GROUP BY s.id ORDER BY s.price_cents`,
    [req.user!.shopId],
  );
  res.json({ services: r.rows });
});

dashboardRouter.post('/services', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const body = serviceBody.parse(req.body);
    const r = await pool.query(
      `INSERT INTO services (shop_id, name, duration_min, price_cents, buffer_after_min, active)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.user!.shopId, body.name, body.durationMin, body.priceCents, body.bufferAfterMin, body.active],
    );
    for (const sid of body.staffIds) {
      await pool.query('INSERT INTO staff_services (staff_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sid, r.rows[0].id]);
    }
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) {
    fail(res, err);
  }
});

dashboardRouter.put('/services/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const body = serviceBody.parse(req.body);
    const r = await pool.query(
      `UPDATE services SET name=$3, duration_min=$4, price_cents=$5, buffer_after_min=$6, active=$7
        WHERE id = $1 AND shop_id = $2 RETURNING id`,
      [req.params.id, req.user!.shopId, body.name, body.durationMin, body.priceCents, body.bufferAfterMin, body.active],
    );
    if (!r.rowCount) return res.status(404).json({ error: 'NOT_FOUND' });
    await pool.query('DELETE FROM staff_services WHERE service_id = $1', [req.params.id]);
    for (const sid of body.staffIds) {
      await pool.query('INSERT INTO staff_services (staff_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sid, req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

// ── Staff CRUD + weekly availability + time off ──────────────────────────────

dashboardRouter.get('/staff', async (req, res) => {
  const r = await pool.query(
    `SELECT st.id, st.display_name, st.email, st.color, st.active, st.google_sync_enabled,
            coalesce((SELECT json_agg(json_build_object('id', ar.id, 'weekday', ar.weekday,
                     'startTime', ar.start_time, 'endTime', ar.end_time) ORDER BY ar.weekday)
                       FROM availability_rules ar WHERE ar.staff_id = st.id), '[]') AS rules
       FROM staff st WHERE st.shop_id = $1 ORDER BY st.display_name`,
    [req.user!.shopId],
  );
  res.json({ staff: r.rows });
});

dashboardRouter.post('/staff', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const body = z.object({
      displayName: z.string().min(1),
      email: z.string().email().optional().nullable(),
      color: z.string().optional().nullable(),
    }).parse(req.body);
    const r = await pool.query(
      'INSERT INTO staff (shop_id, display_name, email, color) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.user!.shopId, body.displayName, body.email ?? null, body.color ?? null],
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) {
    fail(res, err);
  }
});

dashboardRouter.put('/staff/:id/availability', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const body = z.object({
      rules: z.array(z.object({
        weekday: z.number().int().min(0).max(6),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
      })),
    }).parse(req.body);
    const owned = await pool.query('SELECT 1 FROM staff WHERE id = $1 AND shop_id = $2', [req.params.id, req.user!.shopId]);
    if (!owned.rowCount) return res.status(404).json({ error: 'NOT_FOUND' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM availability_rules WHERE staff_id = $1', [req.params.id]);
      for (const rule of body.rules) {
        await client.query(
          'INSERT INTO availability_rules (staff_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)',
          [req.params.id, rule.weekday, rule.startTime, rule.endTime],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

dashboardRouter.post('/staff/:id/time-off', async (req, res) => {
  try {
    const body = z.object({ startsAt: z.string(), endsAt: z.string(), reason: z.string().optional() }).parse(req.body);
    const owned = await pool.query('SELECT 1 FROM staff WHERE id = $1 AND shop_id = $2', [req.params.id, req.user!.shopId]);
    if (!owned.rowCount) return res.status(404).json({ error: 'NOT_FOUND' });
    if (DateTime.fromISO(body.startsAt) >= DateTime.fromISO(body.endsAt))
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'startsAt must precede endsAt' });
    const r = await pool.query(
      'INSERT INTO time_off (staff_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.params.id, body.startsAt, body.endsAt, body.reason ?? null],
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) {
    fail(res, err);
  }
});

dashboardRouter.delete('/time-off/:id', async (req, res) => {
  await pool.query(
    `DELETE FROM time_off t USING staff s WHERE t.id = $1 AND s.id = t.staff_id AND s.shop_id = $2`,
    [req.params.id, req.user!.shopId],
  );
  res.json({ ok: true });
});

// ── Settings ─────────────────────────────────────────────────────────────────

dashboardRouter.get('/settings', async (req, res) => {
  const shop = await myShop(req.user!.shopId);
  res.json({
    shop: {
      slug: shop.slug, name: shop.name, timezone: shop.timezone, currency: shop.currency,
      cancelCutoffHours: shop.cancel_cutoff_hours,
      lateCancelFeeCents: shop.late_cancel_fee_cents,
      staffCancelWaivesFee: shop.staff_cancel_waives_fee,
      stripeConnected: !!shop.stripe_account_id,
      subscriptionTier: shop.subscription_tier,
    },
    features: { payments: paymentsProvider.mode, google: env.googleCalendarEnabled },
  });
});

dashboardRouter.put('/settings', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const body = z.object({
      name: z.string().min(1),
      timezone: z.string().min(1),
      cancelCutoffHours: z.number().int().min(0).max(168),
      lateCancelFeeCents: z.number().int().min(0),
      staffCancelWaivesFee: z.boolean(),
    }).parse(req.body);
    if (!DateTime.local().setZone(body.timezone).isValid)
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'invalid timezone' });
    await pool.query(
      `UPDATE shops SET name=$2, timezone=$3, cancel_cutoff_hours=$4, late_cancel_fee_cents=$5, staff_cancel_waives_fee=$6 WHERE id=$1`,
      [req.user!.shopId, body.name, body.timezone, body.cancelCutoffHours, body.lateCancelFeeCents, body.staffCancelWaivesFee],
    );
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

dashboardRouter.post('/settings/stripe-connect', requireRole('owner'), async (req, res) => {
  try {
    const shop = await myShop(req.user!.shopId);
    const link = await paymentsProvider.connectOnboardingLink(
      shop.id,
      `${env.appBaseUrl}/dashboard/settings`,
    );
    await pool.query('UPDATE shops SET stripe_account_id = $2 WHERE id = $1', [shop.id, link.accountId]);
    res.json({ url: link.url });
  } catch (err) {
    fail(res, err);
  }
});
