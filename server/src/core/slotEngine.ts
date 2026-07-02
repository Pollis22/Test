// Pure slot computation — no I/O. The booking route feeds it DB rows;
// tests feed it fixtures. All math happens in the SHOP's timezone.
import { DateTime } from 'luxon';
import { subtractBusy, timeToMinutes, type TimeRange } from '../lib/time.js';

export interface SlotStaffInput {
  staffId: string;
  /** weekday 0=Sunday … 6=Saturday, times as 'HH:mm[:ss]' in shop tz */
  rules: Array<{ weekday: number; startTime: string; endTime: string }>;
  /** absolute busy intervals (ISO): time off, existing live bookings incl.
   *  buffer (blocked_until), Google freebusy when enabled */
  busy: Array<{ startsAt: string; endsAt: string }>;
}

export interface SlotQuery {
  /** 'YYYY-MM-DD' interpreted in shop timezone */
  date: string;
  timezone: string;
  durationMin: number;
  bufferAfterMin: number;
  staff: SlotStaffInput[];
  /** current instant (injectable for tests) */
  now: DateTime;
  leadTimeMin?: number; // default 30
  slotStepMin?: number; // default 30 grid
}

export interface ComputedSlot {
  staffId: string;
  startsAt: string; // ISO with offset in shop tz
  endsAt: string;
}

export function computeSlots(q: SlotQuery): ComputedSlot[] {
  const step = q.slotStepMin ?? 30;
  const lead = q.leadTimeMin ?? 30;
  const day = DateTime.fromISO(q.date, { zone: q.timezone });
  if (!day.isValid) return [];
  const weekday = day.weekday % 7; // luxon: 1=Mon..7=Sun → 0=Sun..6=Sat
  const earliestStart = q.now.plus({ minutes: lead });
  const out: ComputedSlot[] = [];

  for (const s of q.staff) {
    const busy: TimeRange[] = s.busy.map((b) => ({
      start: DateTime.fromISO(b.startsAt),
      end: DateTime.fromISO(b.endsAt),
    }));
    for (const rule of s.rules) {
      if (rule.weekday !== weekday) continue;
      // Build the working window in shop-local WALL time (set, not plus —
      // adding physical minutes to midnight shifts hours on DST days).
      // Luxon resolves nonexistent wall times (spring-forward gap) forward.
      const startMin = timeToMinutes(rule.startTime);
      const endMin = timeToMinutes(rule.endTime);
      const windowStart = day.set({ hour: Math.floor(startMin / 60), minute: startMin % 60, second: 0, millisecond: 0 });
      const windowEnd = day.set({ hour: Math.floor(endMin / 60), minute: endMin % 60, second: 0, millisecond: 0 });
      if (windowEnd <= windowStart) continue;

      const freeSegments = subtractBusy({ start: windowStart, end: windowEnd }, busy);
      for (const seg of freeSegments) {
        // Candidate starts on the step grid, aligned to the window start.
        let offset = Math.ceil((seg.start.diff(windowStart, 'minutes').minutes) / step) * step;
        for (;;) {
          const start = windowStart.plus({ minutes: offset });
          const end = start.plus({ minutes: q.durationMin });
          const blockedEnd = end.plus({ minutes: q.bufferAfterMin });
          if (blockedEnd > seg.end || start >= seg.end) break;
          if (start >= seg.start && start >= earliestStart) {
            out.push({ staffId: s.staffId, startsAt: start.toISO()!, endsAt: end.toISO()! });
          }
          offset += step;
        }
      }
    }
  }
  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.staffId.localeCompare(b.staffId));
  return out;
}

/** "Any staff" auto-assign: pick the least-loaded staff member owning that slot. */
export function pickLeastLoaded(
  slots: ComputedSlot[],
  startsAt: string,
  loadByStaff: Record<string, number>,
): ComputedSlot | null {
  const candidates = slots.filter((s) => +new Date(s.startsAt) === +new Date(startsAt));
  if (!candidates.length) return null;
  candidates.sort(
    (a, b) =>
      (loadByStaff[a.staffId] ?? 0) - (loadByStaff[b.staffId] ?? 0) ||
      a.staffId.localeCompare(b.staffId),
  );
  return candidates[0];
}
