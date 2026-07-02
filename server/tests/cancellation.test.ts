import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { cancellationQuote, canReschedule } from '../src/core/cancellation.js';

const shop = { cancelCutoffHours: 24, lateCancelFeeCents: 1000, currency: 'usd' };
const starts = DateTime.fromISO('2026-08-10T15:00:00Z');
const booking = { startsAt: starts.toJSDate(), amountCents: 3500 };

describe('cancellation policy (single source of truth)', () => {
  it('outside cutoff → free, full refund', () => {
    const q = cancellationQuote(booking, shop, starts.minus({ hours: 25 }));
    expect(q.kind).toBe('free');
    expect(q.refundCents).toBe(3500);
    expect(q.feeCents).toBe(0);
  });

  it('exactly at cutoff boundary → late fee applies (now === cutoff is inside)', () => {
    const q = cancellationQuote(booking, shop, starts.minus({ hours: 24 }));
    expect(q.kind).toBe('late_fee');
    expect(q.refundCents).toBe(2500);
    expect(q.feeCents).toBe(1000);
  });

  it('inside cutoff → refund = amount − fee', () => {
    const q = cancellationQuote(booking, shop, starts.minus({ hours: 2 }));
    expect(q.kind).toBe('late_fee');
    expect(q.refundCents).toBe(2500);
    expect(q.feeCents).toBe(1000);
  });

  it('refund floor 0: fee larger than amount', () => {
    const q = cancellationQuote({ ...booking, amountCents: 700 }, shop, starts.minus({ hours: 1 }));
    expect(q.refundCents).toBe(0);
    expect(q.feeCents).toBe(700); // fee capped at amount — never negative refund
  });

  it('after start → not allowed self-serve', () => {
    const q = cancellationQuote(booking, shop, starts.plus({ minutes: 1 }));
    expect(q.kind).toBe('not_allowed');
    expect(q.refundCents).toBe(0);
  });

  it('policy text mentions hours and fee', () => {
    const q = cancellationQuote(booking, shop, starts.minus({ hours: 48 }));
    expect(q.policyText).toBe(
      'Free cancellation until 24 hours before your appointment. Cancellations within 24 hours incur a $10 fee.',
    );
  });

  it('per-shop overrides flow through', () => {
    const q = cancellationQuote(booking, { cancelCutoffHours: 48, lateCancelFeeCents: 2500, currency: 'usd' }, starts.minus({ hours: 30 }));
    expect(q.kind).toBe('late_fee');
    expect(q.feeCents).toBe(2500);
  });

  it('reschedule only outside cutoff', () => {
    expect(canReschedule(booking, shop, starts.minus({ hours: 30 }))).toBe(true);
    expect(canReschedule(booking, shop, starts.minus({ hours: 3 }))).toBe(false);
    expect(canReschedule(booking, shop, starts.plus({ hours: 1 }))).toBe(false);
  });
});
