// drizzle schema — mirrors booking-schema-v1.sql (the SQL file is canonical;
// keep the two in lockstep, one versioned .sql per change).
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  time,
  jsonb,
  bigint,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const userRole = pgEnum('user_role', ['owner', 'admin', 'member']);
export const bookingStatus = pgEnum('booking_status', [
  'pending_payment',
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
]);
export const bookingSource = pgEnum('booking_source', ['web', 'phone', 'dashboard']);

export const shops = pgTable('shops', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('America/Chicago'),
  currency: text('currency').notNull().default('usd'),
  cancelCutoffHours: integer('cancel_cutoff_hours').notNull().default(24),
  lateCancelFeeCents: integer('late_cancel_fee_cents').notNull().default(1000),
  staffCancelWaivesFee: boolean('staff_cancel_waives_fee').notNull().default(true),
  stripeAccountId: text('stripe_account_id'),
  subscriptionTier: text('subscription_tier').notNull().default('standard'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('member'),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_shop_email_uq').on(t.shopId, t.email)],
);

export const userSessions = pgTable('user_sessions', {
  token: text('token').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const staff = pgTable('staff', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  email: text('email'),
  color: text('color'),
  googleRefreshToken: text('google_refresh_token'),
  googleCalendarId: text('google_calendar_id'),
  googleSyncEnabled: boolean('google_sync_enabled').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const services = pgTable('services', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  durationMin: integer('duration_min').notNull(),
  priceCents: integer('price_cents').notNull(),
  bufferAfterMin: integer('buffer_after_min').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const staffServices = pgTable(
  'staff_services',
  {
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.serviceId] })],
);

export const availabilityRules = pgTable('availability_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  staffId: uuid('staff_id')
    .notNull()
    .references(() => staff.id, { onDelete: 'cascade' }),
  weekday: integer('weekday').notNull(), // 0=Sunday
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
});

export const timeOff = pgTable('time_off', {
  id: uuid('id').primaryKey().defaultRandom(),
  staffId: uuid('staff_id')
    .notNull()
    .references(() => staff.id, { onDelete: 'cascade' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  reason: text('reason'),
});

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    phone: text('phone').notNull(), // E.164
    email: text('email'),
    notes: text('notes'),
    stripeCustomerId: text('stripe_customer_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('customers_shop_phone_uq').on(t.shopId, t.phone)],
);

export const bookings = pgTable('bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  staffId: uuid('staff_id')
    .notNull()
    .references(() => staff.id),
  serviceId: uuid('service_id')
    .notNull()
    .references(() => services.id),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  blockedUntil: timestamp('blocked_until', { withTimezone: true }).notNull(),
  status: bookingStatus('status').notNull().default('pending_payment'),
  source: bookingSource('source').notNull().default('web'),
  paymentIntentId: text('payment_intent_id'),
  amountCents: integer('amount_cents').notNull().default(0),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  lateFeeCents: integer('late_fee_cents').notNull().default(0),
  refundId: text('refund_id'),
  manageToken: text('manage_token')
    .notNull()
    .unique()
    .default(sql`encode(gen_random_bytes(24), 'hex')`),
  policyAckAt: timestamp('policy_ack_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(), // charge | refund | partial_refund
  amountCents: integer('amount_cents').notNull(),
  provider: text('provider').notNull().default('mock'),
  providerRef: text('provider_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const eventLog = pgTable('event_log', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'cascade' }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  meta: jsonb('meta').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const callTranscripts = pgTable('call_transcripts', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  agentId: text('agent_id'),
  conversationId: text('conversation_id'),
  transcript: jsonb('transcript').notNull().default([]),
  summary: text('summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
