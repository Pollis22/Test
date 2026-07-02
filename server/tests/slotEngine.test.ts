import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { computeSlots } from '../src/core/slotEngine.js';

const TZ = 'America/Chicago';
const RULES_MON_SAT = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startTime: '09:00:00',
  endTime: '18:00:00',
}));

function base(overrides: Partial<Parameters<typeof computeSlots>[0]> = {}) {
  return computeSlots({
    date: '2026-08-05', // a Wednesday
    timezone: TZ,
    durationMin: 30,
    bufferAfterMin: 0,
    staff: [{ staffId: 's1', rules: RULES_MON_SAT, busy: [] }],
    now: DateTime.fromISO('2026-08-01T12:00:00', { zone: TZ }),
    ...overrides,
  });
}

describe('slot engine', () => {
  it('generates a 30-min grid across the working window', () => {
    const slots = base();
    expect(slots.length).toBe(18); // 9:00 … 17:30
    expect(DateTime.fromISO(slots[0].startsAt).setZone(TZ).toFormat('HH:mm')).toBe('09:00');
    expect(DateTime.fromISO(slots.at(-1)!.startsAt).setZone(TZ).toFormat('HH:mm')).toBe('17:30');
  });

  it('returns nothing on a closed day (Sunday)', () => {
    expect(base({ date: '2026-08-09' })).toHaveLength(0);
  });

  it('excludes past slots and honors the 30-min lead time', () => {
    const slots = base({ now: DateTime.fromISO('2026-08-05T13:45:00', { zone: TZ }) });
    // earliest start ≥ 14:15 → grid slot 14:30
    expect(DateTime.fromISO(slots[0].startsAt).setZone(TZ).toFormat('HH:mm')).toBe('14:30');
  });

  it('subtracts existing bookings including their buffer', () => {
    const slots = base({
      staff: [{
        staffId: 's1',
        rules: RULES_MON_SAT,
        busy: [{
          startsAt: DateTime.fromISO('2026-08-05T10:00:00', { zone: TZ }).toISO()!,
          endsAt: DateTime.fromISO('2026-08-05T11:00:00', { zone: TZ }).toISO()!,
        }],
      }],
    });
    const times = slots.map((s) => DateTime.fromISO(s.startsAt).setZone(TZ).toFormat('HH:mm'));
    expect(times).not.toContain('10:00');
    expect(times).not.toContain('10:30');
    expect(times).toContain('09:30'); // 9:30+30min ends exactly at busy start — allowed
    expect(times).toContain('11:00');
  });

  it('long service + buffer must fit before close', () => {
    const slots = base({ durationMin: 90, bufferAfterMin: 15 });
    // last start where start+105min ≤ 18:00 → 16:00 (grid-aligned)
    expect(DateTime.fromISO(slots.at(-1)!.startsAt).setZone(TZ).toFormat('HH:mm')).toBe('16:00');
  });

  it('subtracts time off', () => {
    const slots = base({
      staff: [{
        staffId: 's1',
        rules: RULES_MON_SAT,
        busy: [{
          startsAt: DateTime.fromISO('2026-08-05T09:00:00', { zone: TZ }).toISO()!,
          endsAt: DateTime.fromISO('2026-08-05T13:00:00', { zone: TZ }).toISO()!,
        }],
      }],
    });
    expect(DateTime.fromISO(slots[0].startsAt).setZone(TZ).toFormat('HH:mm')).toBe('13:00');
  });

  it('merges multiple staff and sorts by time', () => {
    const slots = base({
      staff: [
        { staffId: 's1', rules: RULES_MON_SAT, busy: [] },
        { staffId: 's2', rules: RULES_MON_SAT, busy: [] },
      ],
    });
    expect(slots.length).toBe(36);
    expect(slots[0].startsAt <= slots[1].startsAt).toBe(true);
  });

  describe('DST edges (America/Chicago)', () => {
    it('spring forward 2027-03-14: window still 9→18 wall time, slots unique', () => {
      const slots = base({ date: '2027-03-14', staff: [{ staffId: 's1', rules: [{ weekday: 0, startTime: '09:00', endTime: '18:00' }], busy: [] }] });
      expect(slots.length).toBe(18);
      const uniq = new Set(slots.map((s) => s.startsAt));
      expect(uniq.size).toBe(slots.length);
      expect(DateTime.fromISO(slots[0].startsAt).setZone(TZ).toFormat('HH:mm ZZ')).toBe('09:00 -05:00');
    });

    it('fall back 2026-11-01: no duplicated wall-clock slots', () => {
      const slots = base({ date: '2026-11-01', staff: [{ staffId: 's1', rules: [{ weekday: 0, startTime: '09:00', endTime: '18:00' }], busy: [] }] });
      expect(slots.length).toBe(18);
      const uniq = new Set(slots.map((s) => s.startsAt));
      expect(uniq.size).toBe(18);
      // fall-back happens at 2AM, well before opening — first slot is 9:00 CST
      expect(DateTime.fromISO(slots[0].startsAt).setZone(TZ).toFormat('HH:mm ZZ')).toBe('09:00 -06:00');
    });
  });
});
