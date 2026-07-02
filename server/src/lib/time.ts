import { DateTime, Interval } from 'luxon';

export { DateTime, Interval };

/** Parse 'HH:mm' or 'HH:mm:ss' (Postgres time) into minutes since midnight. */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m ?? 0);
}

export interface TimeRange {
  start: DateTime;
  end: DateTime;
}

/** Subtract a list of busy ranges from a free range → remaining free ranges. */
export function subtractBusy(free: TimeRange, busy: TimeRange[]): TimeRange[] {
  let segments: TimeRange[] = [free];
  for (const b of busy) {
    const next: TimeRange[] = [];
    for (const seg of segments) {
      if (b.end <= seg.start || b.start >= seg.end) {
        next.push(seg); // no overlap
        continue;
      }
      if (b.start > seg.start) next.push({ start: seg.start, end: b.start });
      if (b.end < seg.end) next.push({ start: b.end, end: seg.end });
    }
    segments = next;
  }
  return segments;
}
