// Booking lifecycle. All writes transactional; the DB exclusion constraint is
// the final double-booking arbiter (unique violation 23P01 → SLOT_TAKEN).
import { DateTime } from 'luxon';
import type pg from 'pg';
import { pool } from '../db/client.js';
import { computeSlots, type ComputedSlot } from './slotEngine.js';
import { cancellationQuote, canReschedule } from './cancellation.js';
import { paymentsProvider } from '../payments/index.js';
import {
  sendMail,
  confirmationEmail,
  cancellationEmail,
} from '../email/mailer.js';
import { env } from '../env.js';
import { getBusyFromGoogle, pushBookingToGoogle, removeBookingFromGoogle } from '../google/calendar.js';

export const HOLD_MINUTES = 10;

export class BookingError extends Error {
  constructor(
    public code:
      | 'SLOT_TAKEN'
      | 'NOT_FOUND'
      | 'BAD_REQUEST'
      | 'CANCEL_NOT_ALLOWED'
      | 'RESCHEDULE_NOT_ALLOWED'
      | 'POLICY_NOT_ACKED',
    message: string,
  ) {
    super(message);
  }
}

export interface ShopRow {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  currency: string;
  cancel_cutoff_hours: number;
  late_cancel_fee_cents: number;
  staff_cancel_waives_fee: boolean;
  stripe_account_id: string | null;
  subscription_tier: string;
}

export async function getShopBySlug(slug: string): Promise<ShopRow | null> {
  const r = await pool.query<ShopRow>('SELECT * FROM shops WHERE slug = $1', [slug]);
  return r.rows[0] ?? null;
}

export async function logEvent(
  client: pg.PoolClient | pg.Pool,
  shopId: string | null,
  actor: string,
  action: string,
  entity: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    'INSERT INTO event_log (shop_id, actor, action, entity, meta) VALUES ($1,$2,$3,$4,$5)',
    [shopId, actor, action, entity, JSON.stringify(meta)],
  );
}

// ── Availability ─────────────────────────────────────────────────────────────

export async function availability(
  shop: ShopRow,
  serviceId: string,
  date: string,
  staffId?: string,
  now: DateTime = DateTime.utc(),
): Promise<{ slots: ComputedSlot[]; service: { id: string; duration_min: number; buffer_after_min: number; price_cents: number; name: string } }> {
  const svc = await pool.query(
    'SELECT id, name, duration_min, buffer_after_min, price_cents FROM services WHERE id = $1 AND shop_id = $2 AND active',
    [serviceId, shop.id],
  );
  if (!svc.rowCount) throw new BookingError('NOT_FOUND', 'service not found');
  const service = svc.rows[0];

  const staffRows = await pool.query(
    `SELECT s.id FROM staff s
       JOIN staff_services ss ON ss.staff_id = s.id AND ss.service_id = $1
      WHERE s.shop_id = $2 AND s.active ${staffId ? 'AND s.id = $3' : ''}`,
    staffId ? [serviceId, shop.id, staffId] : [serviceId, shop.id],
  );
  if (!staffRows.rowCount) return { slots: [], service };

  const day = DateTime.fromISO(date, { zone: shop.timezone });
  if (!day.isValid) throw new BookingError('BAD_REQUEST', 'invalid date');
  const dayStart = day.startOf('day').toISO()!;
  const dayEnd = day.endOf('day').plus({ hours: 12 }).toISO()!; // catch bookings spilling past midnight

  const staffInputs = [];
  for (const row of staffRows.rows) {
    const sid = row.id as string;
    const [rules, off, booked] = await Promise.all([
      pool.query('SELECT weekday, start_time, end_time FROM availability_rules WHERE staff_id = $1', [sid]),
      pool.query(
        'SELECT starts_at, ends_at FROM time_off WHERE staff_id = $1 AND ends_at > $2 AND starts_at < $3',
        [sid, dayStart, dayEnd],
      ),
      pool.query(
        `SELECT starts_at, blocked_until AS ends_at FROM bookings
          WHERE staff_id = $1 AND status IN ('pending_payment','confirmed')
            AND blocked_until > $2 AND starts_at < $3`,
        [sid, dayStart, dayEnd],
      ),
    ]);
    const googleBusy = await getBusyFromGoogle(sid, dayStart, dayEnd);
    staffInputs.push({
      staffId: sid,
      rules: rules.rows.map((r) => ({ weekday: r.weekday, startTime: r.start_time, endTime: r.end_time })),
      busy: [...off.rows, ...booked.rows, ...googleBusy].map((b) => ({
        startsAt: new Date(b.starts_at ?? b.startsAt).toISOString(),
        endsAt: new Date(b.ends_at ?? b.endsAt).toISOString(),
      })),
    });
  }

  const slots = computeSlots({
    date,
    timezone: shop.timezone,
    durationMin: service.duration_min,
    bufferAfterMin: service.buffer_after_min,
    staff: staffInputs,
    now,
  });
  return { slots, service };
}

// ── Create (pending_payment + hold) ──────────────────────────────────────────

export interface CreateBookingInput {
  shop: ShopRow;
  serviceId: string;
  staffId: string | 'any';
  startsAt: string; // ISO
  customer: { name: string; phone: string; email?: string | null };
  source: 'web' | 'phone' | 'dashboard';
  policyAck: boolean;
  /** dashboard bookings skip payment and confirm immediately */
  skipPayment?: boolean;
}

export async function createBooking(input: CreateBookingInput) {
  const { shop } = input;
  if (!input.policyAck) throw new BookingError('POLICY_NOT_ACKED', 'cancellation policy must be acknowledged');
  if (!/^\+[1-9]\d{6,14}$/.test(input.customer.phone))
    throw new BookingError('BAD_REQUEST', 'phone must be E.164 (+15551234567)');

  const start = DateTime.fromISO(input.startsAt);
  if (!start.isValid) throw new BookingError('BAD_REQUEST', 'invalid startsAt');
  const date = start.setZone(shop.timezone).toISODate()!;

  // Resolve staff: explicit, or least-loaded holder of that slot ("Any").
  const { slots, service } = await availability(
    shop,
    input.serviceId,
    date,
    input.staffId === 'any' ? undefined : input.staffId,
  );
  const matching = slots.filter((s) => +new Date(s.startsAt) === +start.toMillis());
  if (!matching.length) throw new BookingError('SLOT_TAKEN', 'slot no longer available');

  let chosen: ComputedSlot = matching[0];
  if (input.staffId === 'any' && matching.length > 1) {
    const load = await pool.query(
      `SELECT staff_id, count(*)::int AS n FROM bookings
        WHERE shop_id = $1 AND status IN ('pending_payment','confirmed')
          AND starts_at >= $2 AND starts_at < $3
        GROUP BY staff_id`,
      [shop.id, start.setZone(shop.timezone).startOf('day').toISO(), start.setZone(shop.timezone).endOf('day').toISO()],
    );
    const loadBy: Record<string, number> = {};
    for (const r of load.rows) loadBy[r.staff_id] = r.n;
    matching.sort(
      (a, b) => (loadBy[a.staffId] ?? 0) - (loadBy[b.staffId] ?? 0) || a.staffId.localeCompare(b.staffId),
    );
    chosen = matching[0];
  }

  const ends = start.plus({ minutes: service.duration_min });
  const blocked = ends.plus({ minutes: service.buffer_after_min });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cust = await client.query(
      `INSERT INTO customers (shop_id, name, phone, email)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (shop_id, phone) DO UPDATE
         SET name = EXCLUDED.name, email = COALESCE(EXCLUDED.email, customers.email)
       RETURNING id, stripe_customer_id`,
      [shop.id, input.customer.name, input.customer.phone, input.customer.email ?? null],
    );
    const customerId = cust.rows[0].id as string;

    const status = input.skipPayment ? 'confirmed' : 'pending_payment';
    const holdExpires = input.skipPayment
      ? null
      : DateTime.utc().plus({ minutes: HOLD_MINUTES }).toISO();

    let bookingId: string;
    let manageToken: string;
    try {
      const b = await client.query(
        `INSERT INTO bookings
           (shop_id, staff_id, service_id, customer_id, starts_at, ends_at, blocked_until,
            status, source, amount_cents, hold_expires_at, policy_ack_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         RETURNING id, manage_token`,
        [
          shop.id, chosen.staffId, input.serviceId, customerId,
          start.toISO(), ends.toISO(), blocked.toISO(),
          status, input.source, service.price_cents, holdExpires,
        ],
      );
      bookingId = b.rows[0].id;
      manageToken = b.rows[0].manage_token;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23P01') throw new BookingError('SLOT_TAKEN', 'slot was just taken');
      throw err;
    }

    let intent = null;
    if (!input.skipPayment) {
      intent = await paymentsProvider.createIntent({
        amountCents: service.price_cents,
        currency: shop.currency,
        bookingId,
        shopId: shop.id,
        stripeAccountId: shop.stripe_account_id,
        customerEmail: input.customer.email ?? null,
      });
      await client.query('UPDATE bookings SET payment_intent_id = $1 WHERE id = $2', [
        intent.intentId,
        bookingId,
      ]);
    }

    await logEvent(client, shop.id, `customer:${customerId}`, 'booking.create', `booking:${bookingId}`, {
      source: input.source, status, startsAt: start.toISO(),
    });
    await client.query('COMMIT');

    if (input.skipPayment) await afterConfirmed(bookingId);
    return {
      bookingId,
      manageToken,
      staffId: chosen.staffId,
      status,
      amountCents: service.price_cents,
      holdExpiresAt: holdExpires,
      payment: intent
        ? { provider: intent.provider, intentId: intent.intentId, clientSecret: intent.clientSecret }
        : null,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Confirm (payment succeeded — Stripe webhook or mock confirm) ─────────────

export async function handlePaymentSucceeded(intentId: string): Promise<string | null> {
  const r = await pool.query(
    `UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL
      WHERE payment_intent_id = $1 AND status = 'pending_payment'
      RETURNING id, shop_id, amount_cents`,
    [intentId],
  );
  if (!r.rowCount) return null;
  const { id, shop_id, amount_cents } = r.rows[0];
  await pool.query(
    `INSERT INTO payments (shop_id, booking_id, kind, amount_cents, provider, provider_ref)
     VALUES ($1,$2,'charge',$3,$4,$5)`,
    [shop_id, id, amount_cents, paymentsProvider.mode, intentId],
  );
  await logEvent(pool, shop_id, 'system', 'booking.confirmed', `booking:${id}`, { intentId });
  await afterConfirmed(id);
  return id;
}

export async function handlePaymentFailed(intentId: string): Promise<void> {
  const r = await pool.query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now()
      WHERE payment_intent_id = $1 AND status = 'pending_payment'
      RETURNING id, shop_id`,
    [intentId],
  );
  if (r.rowCount) {
    await logEvent(pool, r.rows[0].shop_id, 'system', 'booking.payment_failed', `booking:${r.rows[0].id}`);
  }
}

interface FullBooking {
  id: string; shop_id: string; staff_id: string; service_id: string; customer_id: string;
  starts_at: Date; ends_at: Date; status: string; amount_cents: number;
  payment_intent_id: string | null; manage_token: string; late_fee_cents: number;
  customer_name: string; customer_email: string | null; customer_phone: string;
  service_name: string; staff_name: string;
  shop_slug: string; shop_name: string; timezone: string; currency: string;
  cancel_cutoff_hours: number; late_cancel_fee_cents: number; staff_cancel_waives_fee: boolean;
}

export async function fullBooking(where: 'id' | 'manage_token', value: string): Promise<FullBooking | null> {
  const r = await pool.query(
    `SELECT b.id, b.shop_id, b.staff_id, b.service_id, b.customer_id, b.starts_at, b.ends_at,
            b.status, b.amount_cents, b.payment_intent_id, b.manage_token, b.late_fee_cents,
            c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            sv.name AS service_name, st.display_name AS staff_name,
            sh.slug AS shop_slug, sh.name AS shop_name, sh.timezone, sh.currency,
            sh.cancel_cutoff_hours, sh.late_cancel_fee_cents, sh.staff_cancel_waives_fee
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN services sv ON sv.id = b.service_id
       JOIN staff st ON st.id = b.staff_id
       JOIN shops sh ON sh.id = b.shop_id
      WHERE b.${where === 'id' ? 'id' : 'manage_token'} = $1`,
    [value],
  );
  return (r.rows[0] as FullBooking) ?? null;
}

function emailCtx(b: FullBooking, appBaseUrl: string) {
  return {
    customerName: b.customer_name,
    shopName: b.shop_name,
    serviceName: b.service_name,
    staffName: b.staff_name,
    startsAt: b.starts_at,
    timezone: b.timezone,
    amountCents: b.amount_cents,
    currency: b.currency,
    cutoffHours: b.cancel_cutoff_hours,
    feeCents: b.late_cancel_fee_cents,
    manageUrl: `${appBaseUrl}/m/${b.manage_token}`,
  };
}

async function afterConfirmed(bookingId: string): Promise<void> {
  const b = await fullBooking('id', bookingId);
  if (!b) return;
  if (b.customer_email) await sendMail(confirmationEmail(b.customer_email, emailCtx(b, env.appBaseUrl)));
  await pushBookingToGoogle(b.staff_id, {
    bookingId: b.id,
    summary: `${b.service_name} — ${b.customer_name}`,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
  });
}

// ── Cancel — quotes come from core/cancellation.ts, nowhere else ─────────────

export async function quoteCancellation(manageTokenOrId: string, byToken = true) {
  const b = await fullBooking(byToken ? 'manage_token' : 'id', manageTokenOrId);
  if (!b) throw new BookingError('NOT_FOUND', 'booking not found');
  const quote = cancellationQuote(
    { startsAt: b.starts_at, amountCents: b.amount_cents },
    { cancelCutoffHours: b.cancel_cutoff_hours, lateCancelFeeCents: b.late_cancel_fee_cents, currency: b.currency },
  );
  return { booking: b, quote };
}

export interface CancelOptions {
  actor: string; // 'customer:<id>' | 'user:<id>' | 'voice'
  /** dashboard/staff cancel — per-shop toggle waives the fee */
  staffInitiated?: boolean;
  /** inside the cutoff the caller MUST have shown/spoken the fee and gotten a yes */
  feeAccepted?: boolean;
}

export async function cancelBooking(manageTokenOrId: string, opts: CancelOptions, byToken = true) {
  const { booking: b, quote } = await quoteCancellation(manageTokenOrId, byToken);
  if (b.status !== 'confirmed' && b.status !== 'pending_payment')
    throw new BookingError('CANCEL_NOT_ALLOWED', `booking is ${b.status}`);

  let effective = quote;
  if (quote.kind === 'not_allowed' && !opts.staffInitiated)
    throw new BookingError('CANCEL_NOT_ALLOWED', 'appointment already started — call the shop');
  if (opts.staffInitiated && b.staff_cancel_waives_fee)
    effective = { ...quote, kind: 'free', refundCents: b.amount_cents, feeCents: 0 };
  if (effective.kind === 'late_fee' && !opts.feeAccepted)
    throw new BookingError('CANCEL_NOT_ALLOWED', 'late fee must be explicitly accepted');

  const wasPaid = b.status === 'confirmed';
  let refundId: string | null = null;
  if (wasPaid && b.payment_intent_id && effective.refundCents > 0) {
    refundId = (
      await paymentsProvider.refund({ intentId: b.payment_intent_id, amountCents: effective.refundCents })
    ).refundId;
  } else if (!wasPaid && b.payment_intent_id) {
    await paymentsProvider.cancelIntent(b.payment_intent_id);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now(),
              late_fee_cents = $2, refund_id = $3
        WHERE id = $1`,
      [b.id, wasPaid ? effective.feeCents : 0, refundId],
    );
    if (refundId) {
      await client.query(
        `INSERT INTO payments (shop_id, booking_id, kind, amount_cents, provider, provider_ref)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          b.shop_id, b.id,
          effective.feeCents > 0 ? 'partial_refund' : 'refund',
          effective.refundCents, paymentsProvider.mode, refundId,
        ],
      );
    }
    await logEvent(client, b.shop_id, opts.actor, 'booking.cancel', `booking:${b.id}`, {
      kind: effective.kind, refundCents: effective.refundCents, feeCents: effective.feeCents,
      staffInitiated: !!opts.staffInitiated,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (wasPaid && b.customer_email) {
    await sendMail(
      cancellationEmail(b.customer_email, emailCtx(b, env.appBaseUrl), effective.refundCents, wasPaid ? effective.feeCents : 0),
    );
  }
  await removeBookingFromGoogle(b.staff_id, b.id);
  return { refundCents: wasPaid ? effective.refundCents : 0, feeCents: wasPaid ? effective.feeCents : 0, refundId };
}

// ── Reschedule (outside cutoff only) ─────────────────────────────────────────

export async function rescheduleBooking(manageToken: string, newStartsAt: string, actor: string) {
  const b = await fullBooking('manage_token', manageToken);
  if (!b) throw new BookingError('NOT_FOUND', 'booking not found');
  if (b.status !== 'confirmed') throw new BookingError('RESCHEDULE_NOT_ALLOWED', `booking is ${b.status}`);
  const shopLike = {
    cancelCutoffHours: b.cancel_cutoff_hours,
    lateCancelFeeCents: b.late_cancel_fee_cents,
    currency: b.currency,
  };
  if (!canReschedule({ startsAt: b.starts_at, amountCents: b.amount_cents }, shopLike))
    throw new BookingError('RESCHEDULE_NOT_ALLOWED', 'inside the cancellation window — keep it or cancel with the fee');

  const shop = await getShopBySlug(b.shop_slug);
  if (!shop) throw new BookingError('NOT_FOUND', 'shop not found');
  const start = DateTime.fromISO(newStartsAt);
  if (!start.isValid) throw new BookingError('BAD_REQUEST', 'invalid startsAt');
  const date = start.setZone(shop.timezone).toISODate()!;
  const { slots, service } = await availability(shop, b.service_id, date, b.staff_id);
  if (!slots.some((s) => +new Date(s.startsAt) === +start.toMillis()))
    throw new BookingError('SLOT_TAKEN', 'new slot not available');

  const ends = start.plus({ minutes: service.duration_min });
  const blocked = ends.plus({ minutes: service.buffer_after_min });
  try {
    await pool.query(
      `UPDATE bookings SET starts_at = $2, ends_at = $3, blocked_until = $4 WHERE id = $1`,
      [b.id, start.toISO(), ends.toISO(), blocked.toISO()],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23P01') throw new BookingError('SLOT_TAKEN', 'new slot just taken');
    throw err;
  }
  await logEvent(pool, b.shop_id, actor, 'booking.reschedule', `booking:${b.id}`, {
    from: b.starts_at, to: start.toISO(),
  });
  await removeBookingFromGoogle(b.staff_id, b.id);
  await afterConfirmed(b.id);
  return { bookingId: b.id, startsAt: start.toISO() };
}

// ── Hold expiry sweep (cron + on-demand) ─────────────────────────────────────

export async function expirePendingHolds(): Promise<number> {
  const r = await pool.query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now()
      WHERE status = 'pending_payment' AND hold_expires_at IS NOT NULL AND hold_expires_at < now()
      RETURNING id, shop_id, payment_intent_id`,
  );
  for (const row of r.rows) {
    if (row.payment_intent_id) await paymentsProvider.cancelIntent(row.payment_intent_id);
    await logEvent(pool, row.shop_id, 'system', 'booking.hold_expired', `booking:${row.id}`);
  }
  return r.rowCount ?? 0;
}
