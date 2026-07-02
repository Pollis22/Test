// node-cron jobs: pending-hold expiry (every minute) + T-24h reminders that
// restate the cancellation policy (every 15 min, idempotent via event_log).
import cron from 'node-cron';
import { pool } from '../db/client.js';
import { expirePendingHolds, logEvent } from '../core/bookingService.js';
import { sendMail, reminderEmail } from '../email/mailer.js';
import { env } from '../env.js';

export async function sendDueReminders(): Promise<number> {
  const r = await pool.query(
    `SELECT b.id, b.starts_at, b.amount_cents, b.manage_token,
            c.name AS customer_name, c.email AS customer_email,
            sv.name AS service_name, st.display_name AS staff_name,
            sh.name AS shop_name, sh.timezone, sh.currency,
            sh.cancel_cutoff_hours, sh.late_cancel_fee_cents, sh.id AS shop_id
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN services sv ON sv.id = b.service_id
       JOIN staff st ON st.id = b.staff_id
       JOIN shops sh ON sh.id = b.shop_id
      WHERE b.status = 'confirmed'
        AND b.starts_at BETWEEN now() + interval '23 hours' AND now() + interval '24 hours'
        AND c.email IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM event_log e
           WHERE e.action = 'booking.reminder_sent' AND e.entity = 'booking:' || b.id::text)`,
  );
  for (const b of r.rows) {
    await sendMail(
      reminderEmail(b.customer_email, {
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
        manageUrl: `${env.appBaseUrl}/m/${b.manage_token}`,
      }),
    );
    await logEvent(pool, b.shop_id, 'system', 'booking.reminder_sent', `booking:${b.id}`);
  }
  return r.rowCount ?? 0;
}

export function startJobs(): void {
  cron.schedule('* * * * *', async () => {
    try {
      const n = await expirePendingHolds();
      if (n) console.log(`[jobs] expired ${n} stale holds`);
    } catch (err) {
      console.error('[jobs] hold expiry failed', err);
    }
  });
  cron.schedule('*/15 * * * *', async () => {
    try {
      const n = await sendDueReminders();
      if (n) console.log(`[jobs] sent ${n} T-24h reminders`);
    } catch (err) {
      console.error('[jobs] reminders failed', err);
    }
  });
  console.log('[jobs] cron started (hold expiry 1m, reminders 15m)');
}
