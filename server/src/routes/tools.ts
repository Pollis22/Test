// ElevenLabs ConvAI tool webhooks — prelo pattern: every request carries an
// HMAC-SHA256 signature over the raw body (ELEVENLABS_TOOL_SECRET).
// The agent MUST verbally disclose the late fee inside the cutoff and get an
// explicit yes; the API enforces it (fee_accepted required) so the model
// cannot skip the disclosure.
import { Router, json, type Request, type Response, type NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { env } from '../env.js';
import { pool } from '../db/client.js';
import {
  getShopBySlug,
  availability,
  createBooking,
  quoteCancellation,
  cancelBooking,
  rescheduleBooking,
  BookingError,
} from '../core/bookingService.js';
import { formatMoney, policyText } from '@prelo-booking/shared';
import { sendMail } from '../email/mailer.js';

export const toolsRouter = Router();

// Raw-body JSON so we can verify the exact bytes that were signed.
toolsRouter.use(json({ verify: (req, _res, buf) => ((req as Request & { rawBody?: Buffer }).rawBody = buf) }));

export function signToolPayload(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifyHmac(req: Request, res: Response, next: NextFunction) {
  const signature = req.header('x-tool-signature') ?? '';
  const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
  const expected = signToolPayload(raw, env.elevenLabsToolSecret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'BAD_SIGNATURE' });
  }
  next();
}

toolsRouter.use(verifyHmac);

function speak(res: Response, message: string, data: Record<string, unknown> = {}) {
  // ConvAI tools read `message` back to the caller; `data` is for the model.
  res.json({ message, ...data });
}

function toolFail(res: Response, err: unknown) {
  if (err instanceof BookingError) {
    return speak(res, `I couldn't do that: ${err.message}`, { error: err.code });
  }
  console.error('[tools]', err);
  return speak(res, 'Something went wrong on my end. Let me transfer you to the shop.', { error: 'INTERNAL' });
}

async function findCustomerByPhone(shopId: string, phone: string) {
  const r = await pool.query(
    `SELECT c.id, c.name,
            (SELECT sv.name FROM bookings b JOIN services sv ON sv.id = b.service_id
              WHERE b.customer_id = c.id AND b.status = 'completed'
              ORDER BY b.starts_at DESC LIMIT 1) AS last_service,
            (SELECT b.starts_at FROM bookings b WHERE b.customer_id = c.id AND b.status = 'completed'
              ORDER BY b.starts_at DESC LIMIT 1) AS last_visit
       FROM customers c WHERE c.shop_id = $1 AND c.phone = $2`,
    [shopId, phone],
  );
  return r.rows[0] ?? null;
}

// Returning-caller memory: greet by name, reference last visit.
toolsRouter.post('/identify_caller', async (req, res) => {
  try {
    const body = z.object({ shop_slug: z.string(), phone: z.string() }).parse(req.body);
    const shop = await getShopBySlug(body.shop_slug);
    if (!shop) return speak(res, 'Shop not found.', { error: 'NOT_FOUND' });
    const customer = await findCustomerByPhone(shop.id, body.phone);
    if (!customer) return speak(res, 'New caller — no record on file.', { known: false });
    const lastVisit = customer.last_visit
      ? DateTime.fromJSDate(customer.last_visit).setZone(shop.timezone).toFormat('LLLL d')
      : null;
    return speak(
      res,
      `Returning customer: ${customer.name}.` +
        (lastVisit ? ` Last visit ${lastVisit} (${customer.last_service}).` : ''),
      { known: true, name: customer.name, lastService: customer.last_service, lastVisit },
    );
  } catch (err) {
    toolFail(res, err);
  }
});

toolsRouter.post('/check_availability', async (req, res) => {
  try {
    const body = z.object({
      shop_slug: z.string(),
      service_name: z.string(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      staff_name: z.string().optional(),
    }).parse(req.body);
    const shop = await getShopBySlug(body.shop_slug);
    if (!shop) return speak(res, 'Shop not found.', { error: 'NOT_FOUND' });

    const svc = await pool.query(
      'SELECT id, name FROM services WHERE shop_id = $1 AND active AND lower(name) = lower($2)',
      [shop.id, body.service_name],
    );
    if (!svc.rowCount) {
      const all = await pool.query('SELECT name FROM services WHERE shop_id = $1 AND active', [shop.id]);
      return speak(res, `We don't offer "${body.service_name}". Available: ${all.rows.map((r) => r.name).join(', ')}.`);
    }
    let staffId: string | undefined;
    if (body.staff_name) {
      const st = await pool.query(
        'SELECT id FROM staff WHERE shop_id = $1 AND active AND lower(display_name) LIKE lower($2)',
        [shop.id, `%${body.staff_name}%`],
      );
      if (!st.rowCount) return speak(res, `I don't see ${body.staff_name} on the team.`);
      staffId = st.rows[0].id;
    }
    const { slots } = await availability(shop, svc.rows[0].id, body.date, staffId);
    if (!slots.length) return speak(res, `No openings for ${svc.rows[0].name} on ${body.date}.`, { slots: [] });
    const spoken = slots.slice(0, 6)
      .map((s) => DateTime.fromISO(s.startsAt).setZone(shop.timezone).toFormat('h:mm a'))
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .join(', ');
    return speak(res, `Openings on ${body.date}: ${spoken}${slots.length > 6 ? ', and more' : ''}.`, {
      slots: slots.slice(0, 12),
    });
  } catch (err) {
    toolFail(res, err);
  }
});

toolsRouter.post('/book_appointment', async (req, res) => {
  try {
    const body = z.object({
      shop_slug: z.string(),
      service_name: z.string(),
      staff_name: z.string().optional(),
      starts_at: z.string(),
      customer_name: z.string(),
      phone: z.string(),
      email: z.string().email().optional(),
    }).parse(req.body);
    const shop = await getShopBySlug(body.shop_slug);
    if (!shop) return speak(res, 'Shop not found.', { error: 'NOT_FOUND' });

    const svc = await pool.query(
      'SELECT id, name, price_cents FROM services WHERE shop_id = $1 AND active AND lower(name) = lower($2)',
      [shop.id, body.service_name],
    );
    if (!svc.rowCount) return speak(res, `We don't offer "${body.service_name}".`);

    let staffId: string | 'any' = 'any';
    if (body.staff_name) {
      const st = await pool.query(
        'SELECT id FROM staff WHERE shop_id = $1 AND active AND lower(display_name) LIKE lower($2)',
        [shop.id, `%${body.staff_name}%`],
      );
      if (st.rowCount) staffId = st.rows[0].id;
    }

    // Phone bookings: policy is spoken by the agent BEFORE calling this tool
    // (system prompt requirement) — the ack is recorded here.
    const result = await createBooking({
      shop,
      serviceId: svc.rows[0].id,
      staffId,
      startsAt: body.starts_at,
      customer: { name: body.customer_name, phone: body.phone, email: body.email ?? null },
      source: 'phone',
      policyAck: true,
    });

    const payUrl = `${env.appBaseUrl}/m/${result.manageToken}`;
    if (body.email) {
      await sendMail({
        to: body.email,
        subject: `Complete your booking at ${shop.name}`,
        text:
          `Hi ${body.customer_name},\n\nTo confirm your ${svc.rows[0].name}, complete payment within 10 minutes: ${payUrl}\n\n` +
          `${policyText(shop.cancel_cutoff_hours, shop.late_cancel_fee_cents, shop.currency)}\n\n— ${shop.name}`,
      });
    }
    const when = DateTime.fromISO(body.starts_at).setZone(shop.timezone).toFormat("cccc h:mm a");
    return speak(
      res,
      `Held ${svc.rows[0].name} for ${when} — ${formatMoney(svc.rows[0].price_cents, shop.currency)}. ` +
        (body.email
          ? `I emailed a payment link; the hold lasts 10 minutes. `
          : `They'll need a payment link by email to confirm — please collect an email address. `) +
        `Remember: ${policyText(shop.cancel_cutoff_hours, shop.late_cancel_fee_cents, shop.currency)}`,
      { bookingId: result.bookingId, payUrl, holdExpiresAt: result.holdExpiresAt },
    );
  } catch (err) {
    toolFail(res, err);
  }
});

toolsRouter.post('/get_my_appointments', async (req, res) => {
  try {
    const body = z.object({ shop_slug: z.string(), phone: z.string() }).parse(req.body);
    const shop = await getShopBySlug(body.shop_slug);
    if (!shop) return speak(res, 'Shop not found.', { error: 'NOT_FOUND' });
    const r = await pool.query(
      `SELECT b.id, b.starts_at, b.status, sv.name AS service, st.display_name AS staff, b.manage_token
         FROM bookings b
         JOIN customers c ON c.id = b.customer_id
         JOIN services sv ON sv.id = b.service_id
         JOIN staff st ON st.id = b.staff_id
        WHERE b.shop_id = $1 AND c.phone = $2 AND b.status IN ('pending_payment','confirmed')
          AND b.starts_at > now()
        ORDER BY b.starts_at LIMIT 5`,
      [shop.id, body.phone],
    );
    if (!r.rowCount) return speak(res, 'No upcoming appointments on file for this number.', { appointments: [] });
    const lines = r.rows.map(
      (b) =>
        `${b.service} with ${b.staff} on ${DateTime.fromJSDate(b.starts_at).setZone(shop.timezone).toFormat('cccc, LLLL d at h:mm a')} (${b.status})`,
    );
    return speak(res, `Upcoming: ${lines.join('; ')}.`, { appointments: r.rows });
  } catch (err) {
    toolFail(res, err);
  }
});

toolsRouter.post('/cancel_appointment', async (req, res) => {
  try {
    const body = z.object({
      shop_slug: z.string(),
      phone: z.string(),
      booking_id: z.string().uuid().optional(),
      /** MUST be true only after the agent read the fee aloud and the caller said yes */
      fee_accepted: z.boolean().default(false),
    }).parse(req.body);
    const shop = await getShopBySlug(body.shop_slug);
    if (!shop) return speak(res, 'Shop not found.', { error: 'NOT_FOUND' });

    // Lookup by phone; disambiguate by booking_id when multiple.
    const r = await pool.query(
      `SELECT b.id FROM bookings b JOIN customers c ON c.id = b.customer_id
        WHERE b.shop_id = $1 AND c.phone = $2 AND b.status IN ('pending_payment','confirmed')
          AND b.starts_at > now() ${body.booking_id ? 'AND b.id = $3' : ''}
        ORDER BY b.starts_at LIMIT 2`,
      body.booking_id ? [shop.id, body.phone, body.booking_id] : [shop.id, body.phone],
    );
    if (!r.rowCount) return speak(res, 'No matching upcoming appointment for this number.');
    if (r.rowCount > 1 && !body.booking_id)
      return speak(res, 'There are multiple upcoming appointments — which one? (use get_my_appointments and pass booking_id)');

    const bookingId = r.rows[0].id as string;
    const { quote } = await quoteCancellation(bookingId, false);

    if (quote.kind === 'late_fee' && !body.fee_accepted) {
      // Disclosure gate: return the exact sentence to read; no cancellation yet.
      return speak(
        res,
        `Heads up — this cancellation is within ${shop.cancel_cutoff_hours} hours, so a ` +
          `${formatMoney(quote.feeCents, shop.currency)} late fee applies and ` +
          `${formatMoney(quote.refundCents, shop.currency)} would be refunded. ` +
          `Ask the caller for an explicit yes, then call this tool again with fee_accepted=true.`,
        { requiresFeeConfirmation: true, feeCents: quote.feeCents, refundCents: quote.refundCents, bookingId },
      );
    }

    const result = await cancelBooking(bookingId, { actor: 'voice', feeAccepted: body.fee_accepted }, false);
    const refundLine =
      result.feeCents > 0
        ? `A ${formatMoney(result.feeCents, shop.currency)} late fee applied; ${formatMoney(result.refundCents, shop.currency)} is being refunded.`
        : result.refundCents > 0
          ? `A full refund of ${formatMoney(result.refundCents, shop.currency)} is on its way.`
          : 'No payment had been captured, so there is nothing to refund.';
    return speak(res, `Cancelled. ${refundLine}`, { cancelled: true, ...result });
  } catch (err) {
    toolFail(res, err);
  }
});

toolsRouter.post('/reschedule_appointment', async (req, res) => {
  try {
    const body = z.object({
      shop_slug: z.string(),
      phone: z.string(),
      booking_id: z.string().uuid().optional(),
      new_starts_at: z.string(),
    }).parse(req.body);
    const shop = await getShopBySlug(body.shop_slug);
    if (!shop) return speak(res, 'Shop not found.', { error: 'NOT_FOUND' });
    const r = await pool.query(
      `SELECT b.manage_token FROM bookings b JOIN customers c ON c.id = b.customer_id
        WHERE b.shop_id = $1 AND c.phone = $2 AND b.status = 'confirmed' AND b.starts_at > now()
          ${body.booking_id ? 'AND b.id = $3' : ''}
        ORDER BY b.starts_at LIMIT 2`,
      body.booking_id ? [shop.id, body.phone, body.booking_id] : [shop.id, body.phone],
    );
    if (!r.rowCount) return speak(res, 'No confirmed upcoming appointment for this number.');
    if (r.rowCount > 1 && !body.booking_id)
      return speak(res, 'Multiple appointments found — pass booking_id.');
    const result = await rescheduleBooking(r.rows[0].manage_token, body.new_starts_at, 'voice');
    const when = DateTime.fromISO(result.startsAt!).setZone(shop.timezone).toFormat('cccc, LLLL d at h:mm a');
    return speak(res, `Done — moved to ${when}.`, { rescheduled: true, ...result });
  } catch (err) {
    if (err instanceof BookingError && err.code === 'RESCHEDULE_NOT_ALLOWED') {
      return speak(
        res,
        `Rescheduling isn't available inside the ${(await getShopBySlug(req.body?.shop_slug))?.cancel_cutoff_hours ?? 24}-hour window. ` +
          `They can keep the appointment, or cancel with the late fee.`,
        { error: 'RESCHEDULE_NOT_ALLOWED' },
      );
    }
    toolFail(res, err);
  }
});

// Post-call webhook: store transcript + email the shop.
toolsRouter.post('/post_call', async (req, res) => {
  try {
    const body = z.object({
      shop_slug: z.string(),
      phone: z.string().optional(),
      agent_id: z.string().optional(),
      conversation_id: z.string().optional(),
      transcript: z.array(z.object({ role: z.string(), text: z.string() })).default([]),
      summary: z.string().optional(),
    }).parse(req.body);
    const shop = await getShopBySlug(body.shop_slug);
    if (!shop) return res.status(404).json({ error: 'NOT_FOUND' });
    const customer = body.phone ? await findCustomerByPhone(shop.id, body.phone) : null;
    await pool.query(
      `INSERT INTO call_transcripts (shop_id, customer_id, agent_id, conversation_id, transcript, summary)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [shop.id, customer?.id ?? null, body.agent_id ?? null, body.conversation_id ?? null,
       JSON.stringify(body.transcript), body.summary ?? null],
    );
    const ownerEmail = await pool.query(
      `SELECT email FROM users WHERE shop_id = $1 AND role = 'owner' LIMIT 1`,
      [shop.id],
    );
    if (ownerEmail.rowCount) {
      await sendMail({
        to: ownerEmail.rows[0].email,
        subject: `Call summary — ${shop.name}`,
        text: `${body.summary ?? 'A call just ended.'}\n\nCaller: ${customer?.name ?? body.phone ?? 'unknown'}\n\nTranscript:\n${body.transcript.map((t) => `${t.role}: ${t.text}`).join('\n')}`,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    toolFail(res, err);
  }
});
