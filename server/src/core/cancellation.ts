// SINGLE SERVER-SIDE SOURCE OF TRUTH for cancellation & reschedule policy.
// Every surface (web manage page, dashboard, voice agent, emails) calls this.
import { DateTime } from 'luxon';
import { policyText, type CancellationQuote } from '@prelo-booking/shared';

export interface PolicyShop {
  cancelCutoffHours: number;
  lateCancelFeeCents: number;
  currency: string;
}

export interface PolicyBooking {
  startsAt: Date;
  amountCents: number;
}

export function cancellationQuote(
  booking: PolicyBooking,
  shop: PolicyShop,
  now: DateTime = DateTime.utc(),
): CancellationQuote {
  const starts = DateTime.fromJSDate(booking.startsAt);
  const cutoffAt = starts.minus({ hours: shop.cancelCutoffHours });
  const text = policyText(shop.cancelCutoffHours, shop.lateCancelFeeCents, shop.currency);

  if (now >= starts) {
    // after start: no self-serve cancel (dashboard marks completed / no_show)
    return { kind: 'not_allowed', refundCents: 0, feeCents: 0, cutoffAt: cutoffAt.toISO()!, policyText: text };
  }
  if (now < cutoffAt) {
    return {
      kind: 'free',
      refundCents: booking.amountCents,
      feeCents: 0,
      cutoffAt: cutoffAt.toISO()!,
      policyText: text,
    };
  }
  const fee = Math.min(shop.lateCancelFeeCents, booking.amountCents); // refund floor 0
  return {
    kind: 'late_fee',
    refundCents: booking.amountCents - fee,
    feeCents: fee,
    cutoffAt: cutoffAt.toISO()!,
    policyText: text,
  };
}

/** Reschedule allowed only OUTSIDE the cutoff (and before start). */
export function canReschedule(
  booking: PolicyBooking,
  shop: PolicyShop,
  now: DateTime = DateTime.utc(),
): boolean {
  return cancellationQuote(booking, shop, now).kind === 'free';
}
