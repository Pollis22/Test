-- booking-schema-v1.sql — Prelo Booking initial schema
-- Multi-tenant (shop_id everywhere). Idempotent. Run against the target DB's
-- PUBLIC proxy URL only — never .railway.internal.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- required by the no-double-booking exclusion constraint

-- ── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('owner', 'admin', 'member');  -- house rule: EXACTLY these
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE booking_status AS ENUM
    ('pending_payment', 'confirmed', 'completed', 'cancelled', 'no_show');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE booking_source AS ENUM ('web', 'phone', 'dashboard');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Tenancy ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shops (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  timezone              text NOT NULL DEFAULT 'America/Chicago',
  currency              text NOT NULL DEFAULT 'usd',
  cancel_cutoff_hours   integer NOT NULL DEFAULT 24,
  late_cancel_fee_cents integer NOT NULL DEFAULT 1000,
  staff_cancel_waives_fee boolean NOT NULL DEFAULT true,
  stripe_account_id     text,
  subscription_tier     text NOT NULL DEFAULT 'standard',
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  email         text NOT NULL,
  password_hash text NOT NULL,            -- bcrypt $2b$10
  role          user_role NOT NULL DEFAULT 'member',
  is_admin      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, email)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  display_name           text NOT NULL,
  email                  text,
  color                  text,
  google_refresh_token   text,
  google_calendar_id     text,
  google_sync_enabled    boolean NOT NULL DEFAULT false,
  active                 boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name             text NOT NULL,
  duration_min     integer NOT NULL,
  price_cents      integer NOT NULL,
  buffer_after_min integer NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_services (
  staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE IF NOT EXISTS availability_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  weekday    integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0=Sunday
  start_time time NOT NULL,
  end_time   time NOT NULL,
  CHECK (start_time < end_time)
);

CREATE TABLE IF NOT EXISTS time_off (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id  uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at   timestamptz NOT NULL,
  reason    text,
  CHECK (starts_at < ends_at)
);

CREATE TABLE IF NOT EXISTS customers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name               text NOT NULL,
  phone              text NOT NULL,       -- E.164; phone-first identity for voice
  email              text,
  notes              text,
  stripe_customer_id text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, phone)
);

-- ── Bookings ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id          uuid NOT NULL REFERENCES staff(id),
  service_id        uuid NOT NULL REFERENCES services(id),
  customer_id       uuid NOT NULL REFERENCES customers(id),
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,   -- includes service duration; buffer handled by slot engine via blocked_until
  blocked_until     timestamptz NOT NULL,   -- ends_at + buffer_after_min; what the exclusion constraint guards
  status            booking_status NOT NULL DEFAULT 'pending_payment',
  source            booking_source NOT NULL DEFAULT 'web',
  payment_intent_id text,
  amount_cents      integer NOT NULL DEFAULT 0,
  hold_expires_at   timestamptz,             -- pending_payment slot hold (10 min)
  cancelled_at      timestamptz,
  late_fee_cents    integer NOT NULL DEFAULT 0,
  refund_id         text,
  manage_token      text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  policy_ack_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  CHECK (ends_at <= blocked_until)
);

-- DB-level double-booking guard: two live bookings for the same staff member can
-- never overlap (buffer included). Cancelled / expired rows don't block.
DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (
      staff_id WITH =,
      tstzrange(starts_at, blocked_until) WITH &&
    ) WHERE (status IN ('pending_payment', 'confirmed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS bookings_shop_starts_idx ON bookings (shop_id, starts_at);
CREATE INDEX IF NOT EXISTS bookings_staff_starts_idx ON bookings (staff_id, starts_at);
CREATE INDEX IF NOT EXISTS bookings_hold_idx ON bookings (hold_expires_at)
  WHERE status = 'pending_payment';

-- ── Ledger + audit ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  booking_id        uuid REFERENCES bookings(id) ON DELETE SET NULL,
  kind              text NOT NULL CHECK (kind IN ('charge', 'refund', 'partial_refund')),
  amount_cents      integer NOT NULL,
  provider          text NOT NULL DEFAULT 'mock',   -- 'stripe' | 'mock'
  provider_ref      text,                            -- pi_… / re_… / mock id
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id    uuid REFERENCES shops(id) ON DELETE CASCADE,
  actor      text NOT NULL,               -- 'customer:<id>' | 'user:<id>' | 'voice' | 'system'
  action     text NOT NULL,
  entity     text NOT NULL,               -- 'booking:<id>' etc.
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_transcripts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id  uuid REFERENCES customers(id) ON DELETE SET NULL,
  agent_id     text,
  conversation_id text,
  transcript   jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
