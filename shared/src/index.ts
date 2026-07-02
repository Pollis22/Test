// ── Prelo Booking shared types & policy text ────────────────────────────────

export type BookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export type BookingSource = 'web' | 'phone' | 'dashboard';

export type UserRole = 'owner' | 'admin' | 'member';

export interface Slot {
  /** ISO 8601 with offset, shop timezone */
  startsAt: string;
  endsAt: string;
  staffId: string;
}

export interface PublicShop {
  slug: string;
  name: string;
  timezone: string;
  currency: string;
  cancelCutoffHours: number;
  lateCancelFeeCents: number;
}

export interface PublicService {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
}

export interface PublicStaff {
  id: string;
  displayName: string;
  color: string | null;
}

export type CancellationKind = 'free' | 'late_fee' | 'not_allowed';

export interface CancellationQuote {
  kind: CancellationKind;
  /** cents refunded if cancelled now */
  refundCents: number;
  /** cents kept as late fee (0 when free) */
  feeCents: number;
  cutoffAt: string;
  policyText: string;
}

export function formatMoney(cents: number, currency = 'usd'): string {
  const symbol = currency === 'usd' ? '$' : '';
  return `${symbol}${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/**
 * Canonical policy sentence. Rendered at checkout, in every email, and spoken
 * verbatim by the voice agent. Parametrized per shop but defaults to 24h/$10.
 */
export function policyText(cutoffHours = 24, feeCents = 1000, currency = 'usd'): string {
  return (
    `Free cancellation until ${cutoffHours} hours before your appointment. ` +
    `Cancellations within ${cutoffHours} hours incur a ${formatMoney(feeCents, currency)} fee.`
  );
}
