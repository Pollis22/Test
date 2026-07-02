// Email — Resend when RESEND_API_KEY present, console mock otherwise.
// Every booking email restates the cancellation policy (product rule).
import { env } from '../env.js';
import { policyText, formatMoney } from '@prelo-booking/shared';
import { DateTime } from 'luxon';

export interface MailInput {
  to: string;
  subject: string;
  text: string;
}

export const sentMail: MailInput[] = []; // inspectable in tests / mock mode

export async function sendMail(input: MailInput): Promise<void> {
  if (env.emailMode === 'resend' && env.resendApiKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: env.emailFrom, to: input.to, subject: input.subject, text: input.text }),
    });
    if (!res.ok) console.error(`[email] resend failed ${res.status}: ${await res.text()}`);
    return;
  }
  sentMail.push(input);
  console.log(`[email:mock] to=${input.to} subject="${input.subject}"\n${input.text}\n---`);
}

interface BookingEmailCtx {
  customerName: string;
  shopName: string;
  serviceName: string;
  staffName: string;
  startsAt: Date;
  timezone: string;
  amountCents: number;
  currency: string;
  cutoffHours: number;
  feeCents: number;
  manageUrl: string;
}

function when(ctx: BookingEmailCtx): string {
  return DateTime.fromJSDate(ctx.startsAt)
    .setZone(ctx.timezone)
    .toFormat("cccc, LLLL d 'at' h:mm a ZZZZ");
}

function policyFooter(ctx: BookingEmailCtx): string {
  return `\nCancellation policy: ${policyText(ctx.cutoffHours, ctx.feeCents, ctx.currency)}\nManage your appointment: ${ctx.manageUrl}\n\n— ${ctx.shopName}, via Prelo Booking (Powered by JIE Mastery)`;
}

export function confirmationEmail(to: string, ctx: BookingEmailCtx): MailInput {
  return {
    to,
    subject: `Confirmed: ${ctx.serviceName} at ${ctx.shopName}`,
    text:
      `Hi ${ctx.customerName},\n\nYour ${ctx.serviceName} with ${ctx.staffName} is confirmed for ${when(ctx)}.\n` +
      `Amount paid: ${formatMoney(ctx.amountCents, ctx.currency)}.\n` +
      policyFooter(ctx),
  };
}

export function cancellationEmail(
  to: string,
  ctx: BookingEmailCtx,
  refundCents: number,
  lateFeeCents: number,
): MailInput {
  const feeLine =
    lateFeeCents > 0
      ? `A late-cancellation fee of ${formatMoney(lateFeeCents, ctx.currency)} applied; ${formatMoney(refundCents, ctx.currency)} was refunded.`
      : `A full refund of ${formatMoney(refundCents, ctx.currency)} was issued.`;
  return {
    to,
    subject: `Cancelled: ${ctx.serviceName} at ${ctx.shopName}`,
    text:
      `Hi ${ctx.customerName},\n\nYour ${ctx.serviceName} on ${when(ctx)} has been cancelled.\n${feeLine}\n` +
      policyFooter(ctx),
  };
}

export function reminderEmail(to: string, ctx: BookingEmailCtx): MailInput {
  return {
    to,
    subject: `Reminder: ${ctx.serviceName} tomorrow at ${ctx.shopName}`,
    text:
      `Hi ${ctx.customerName},\n\nReminder: your ${ctx.serviceName} with ${ctx.staffName} is ${when(ctx)}.\n` +
      policyFooter(ctx),
  };
}
