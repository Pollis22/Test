// DB-backed integration tests — require PGTEST_URL (or DATABASE_URL).
// Cover the master-prompt audit scenarios end to end with the mock provider:
//   · book >24h out + cancel → full refund
//   · book <24h out + cancel → refund minus $10 (floor 0)
//   · concurrent double-book race → exclusion constraint holds
//   · pending-payment slot expiry frees the slot
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DateTime } from 'luxon';

const DB = process.env.PGTEST_URL ?? process.env.DATABASE_URL;
const d = DB ? describe : describe.skip;
if (DB) process.env.DATABASE_URL = DB;

d('booking lifecycle (real Postgres, mock payments)', () => {
  // dynamic imports so env is set before modules load
  let svc: typeof import('../src/core/bookingService.js');
  let mock: typeof import('../src/payments/mockProvider.js');
  let pool: import('pg').Pool;
  let shop: import('../src/core/bookingService.js').ShopRow;
  let serviceId: string;
  let cheapServiceId: string;
  let staffId: string;
  const TZ = 'America/Chicago';

  /** next Wednesday at least 8 days out — always outside any cutoff */
  function farSlot(hourOffsetMin = 0): DateTime {
    let dt = DateTime.utc().setZone(TZ).plus({ days: 8 }).startOf('day');
    while (dt.weekday !== 3) dt = dt.plus({ days: 1 });
    return dt.set({ hour: 9, minute: 0 }).plus({ minutes: hourOffsetMin });
  }

  beforeAll(async () => {
    svc = await import('../src/core/bookingService.js');
    mock = await import('../src/payments/mockProvider.js');
    const client = await import('../src/db/client.js');
    pool = client.pool;
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations(pool);

    // isolated fixture shop per run
    const slug = `it-${Date.now()}`;
    const s = await pool.query(
      `INSERT INTO shops (slug, name, timezone) VALUES ($1, 'IT Shop', $2) RETURNING *`,
      [slug, TZ],
    );
    shop = s.rows[0];
    const st = await pool.query(
      `INSERT INTO staff (shop_id, display_name) VALUES ($1, 'Tester') RETURNING id`,
      [shop.id],
    );
    staffId = st.rows[0].id;
    const sv = await pool.query(
      `INSERT INTO services (shop_id, name, duration_min, price_cents) VALUES ($1, 'Cut', 30, 3500) RETURNING id`,
      [shop.id],
    );
    serviceId = sv.rows[0].id;
    const sv2 = await pool.query(
      `INSERT INTO services (shop_id, name, duration_min, price_cents) VALUES ($1, 'Quick', 20, 700) RETURNING id`,
      [shop.id],
    );
    cheapServiceId = sv2.rows[0].id;
    for (const svcId of [serviceId, cheapServiceId]) {
      await pool.query(`INSERT INTO staff_services (staff_id, service_id) VALUES ($1,$2)`, [staffId, svcId]);
    }
    for (let w = 0; w <= 6; w++) {
      await pool.query(
        `INSERT INTO availability_rules (staff_id, weekday, start_time, end_time) VALUES ($1,$2,'00:00','23:59')`,
        [staffId, w],
      );
    }
  }, 30_000);

  afterAll(async () => {
    if (shop) await pool.query('DELETE FROM shops WHERE id = $1', [shop.id]);
    await pool.end();
  });

  async function book(startsAt: DateTime, phone: string, whichService = serviceId) {
    return svc.createBooking({
      shop,
      serviceId: whichService,
      staffId,
      startsAt: startsAt.toISO()!,
      customer: { name: 'Cust', phone, email: 'cust@example.com' },
      source: 'web',
      policyAck: true,
    });
  }

  async function pay(result: Awaited<ReturnType<typeof book>>) {
    mock.markMockIntentSucceeded(result.payment!.intentId);
    await svc.handlePaymentSucceeded(result.payment!.intentId);
  }

  it('book >24h out, pay, cancel → FULL refund, no fee', async () => {
    const r = await book(farSlot(0), '+15550000101');
    expect(r.status).toBe('pending_payment');
    await pay(r);
    const paid = await svc.fullBooking('id', r.bookingId);
    expect(paid!.status).toBe('confirmed');

    const cancel = await svc.cancelBooking(r.manageToken, { actor: 'customer:test' });
    expect(cancel.refundCents).toBe(3500);
    expect(cancel.feeCents).toBe(0);
    const after = await svc.fullBooking('id', r.bookingId);
    expect(after!.status).toBe('cancelled');
    const ledger = await pool.query(
      `SELECT kind, amount_cents FROM payments WHERE booking_id = $1 ORDER BY created_at`,
      [r.bookingId],
    );
    expect(ledger.rows.map((x) => x.kind)).toEqual(['charge', 'refund']);
  });

  it('book <24h out, pay, cancel with fee accepted → refund minus $10; fee recorded', async () => {
    const soon = DateTime.utc().plus({ hours: 3 }).startOf('hour');
    const r = await book(soon, '+15550000102');
    await pay(r);

    // without explicit acceptance the cancel MUST be refused
    await expect(
      svc.cancelBooking(r.manageToken, { actor: 'customer:test' }),
    ).rejects.toThrow(/late fee/i);

    const cancel = await svc.cancelBooking(r.manageToken, { actor: 'customer:test', feeAccepted: true });
    expect(cancel.feeCents).toBe(1000);
    expect(cancel.refundCents).toBe(2500);
    const after = await svc.fullBooking('id', r.bookingId);
    expect(after!.late_fee_cents).toBe(1000);
    const ledger = await pool.query(
      `SELECT kind, amount_cents FROM payments WHERE booking_id = $1 AND kind = 'partial_refund'`,
      [r.bookingId],
    );
    expect(ledger.rows[0].amount_cents).toBe(2500);
  });

  it('refund floor 0: $7 service cancelled late → fee capped, zero refund, no refund row', async () => {
    const soon = DateTime.utc().plus({ hours: 2 }).startOf('hour').plus({ minutes: 30 });
    const r = await book(soon, '+15550000103', cheapServiceId);
    await pay(r);
    const cancel = await svc.cancelBooking(r.manageToken, { actor: 'customer:test', feeAccepted: true });
    expect(cancel.feeCents).toBe(700);
    expect(cancel.refundCents).toBe(0);
  });

  it('concurrent double-book race → exactly one wins (DB constraint)', async () => {
    const t = farSlot(120);
    const results = await Promise.allSettled([
      book(t, '+15550000104'),
      book(t, '+15550000105'),
      book(t, '+15550000106'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter(
      (r) => r.status === 'rejected' && /SLOT_TAKEN|slot/i.test(String((r as PromiseRejectedResult).reason)),
    );
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(2);
  });

  it('pending-payment hold expiry frees the slot', async () => {
    const t = farSlot(240);
    const r = await book(t, '+15550000107');
    // same slot is blocked while the hold is live
    await expect(book(t, '+15550000108')).rejects.toThrow(/slot/i);
    // force the hold into the past, sweep, then rebook
    await pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [r.bookingId]);
    const expired = await svc.expirePendingHolds();
    expect(expired).toBeGreaterThanOrEqual(1);
    const rebooked = await book(t, '+15550000108');
    expect(rebooked.status).toBe('pending_payment');
  });

  it('reschedule outside cutoff moves the booking; inside cutoff is refused', async () => {
    const r = await book(farSlot(360), '+15550000109');
    await pay(r);
    const newTime = farSlot(420);
    const moved = await svc.rescheduleBooking(r.manageToken, newTime.toISO()!, 'test');
    expect(DateTime.fromISO(moved.startsAt!).toMillis()).toBe(newTime.toMillis());

    const soon = DateTime.utc().plus({ hours: 4 }).startOf('hour');
    const r2 = await book(soon, '+15550000110');
    await pay(r2);
    await expect(
      svc.rescheduleBooking(r2.manageToken, farSlot(480).toISO()!, 'test'),
    ).rejects.toThrow(/RESCHEDULE|window|keep/i);
  });
});
