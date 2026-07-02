// Google Calendar — one-way push + freebusy subtract. FEATURE-FLAGGED:
// without GOOGLE_CLIENT_ID/SECRET every function is a cheap no-op, so the
// rest of the app never needs to know. Two-way sync is backlog.
import { env } from '../env.js';
import { pool } from '../db/client.js';

interface StaffGoogle {
  google_refresh_token: string | null;
  google_calendar_id: string | null;
  google_sync_enabled: boolean;
}

async function staffGoogle(staffId: string): Promise<StaffGoogle | null> {
  if (!env.googleCalendarEnabled) return null;
  const r = await pool.query<StaffGoogle>(
    'SELECT google_refresh_token, google_calendar_id, google_sync_enabled FROM staff WHERE id = $1',
    [staffId],
  );
  const s = r.rows[0];
  return s && s.google_sync_enabled && s.google_refresh_token ? s : null;
}

async function accessToken(refreshToken: string): Promise<string | null> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.googleClientId!,
      client_secret: env.googleClientSecret!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    console.error('[google] token refresh failed', res.status);
    return null;
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Busy intervals from the staff member's Google calendar (slot engine subtracts). */
export async function getBusyFromGoogle(
  staffId: string,
  timeMinISO: string,
  timeMaxISO: string,
): Promise<Array<{ startsAt: string; endsAt: string }>> {
  const s = await staffGoogle(staffId);
  if (!s) return [];
  const token = await accessToken(s.google_refresh_token!);
  if (!token) return [];
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items: [{ id: s.google_calendar_id ?? 'primary' }],
    }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
  };
  const cal = Object.values(data.calendars ?? {})[0];
  return (cal?.busy ?? []).map((b) => ({ startsAt: b.start, endsAt: b.end }));
}

/** One-way push: booking confirmed → event on the staff member's calendar. */
export async function pushBookingToGoogle(
  staffId: string,
  ev: { bookingId: string; summary: string; startsAt: Date; endsAt: Date },
): Promise<void> {
  const s = await staffGoogle(staffId);
  if (!s) return;
  const token = await accessToken(s.google_refresh_token!);
  if (!token) return;
  const calId = encodeURIComponent(s.google_calendar_id ?? 'primary');
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: ev.summary,
      start: { dateTime: ev.startsAt.toISOString() },
      end: { dateTime: ev.endsAt.toISOString() },
      extendedProperties: { private: { prelo_booking_id: ev.bookingId } },
    }),
  });
  if (!res.ok) console.error('[google] event insert failed', res.status);
}

/** Booking cancelled/rescheduled → delete the matching event. */
export async function removeBookingFromGoogle(staffId: string, bookingId: string): Promise<void> {
  const s = await staffGoogle(staffId);
  if (!s) return;
  const token = await accessToken(s.google_refresh_token!);
  if (!token) return;
  const calId = encodeURIComponent(s.google_calendar_id ?? 'primary');
  const list = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?privateExtendedProperty=${encodeURIComponent(
      `prelo_booking_id=${bookingId}`,
    )}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!list.ok) return;
  const data = (await list.json()) as { items?: Array<{ id: string }> };
  for (const item of data.items ?? []) {
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${item.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}
