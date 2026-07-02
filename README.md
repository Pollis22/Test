# Prelo Booking — Powered by JIE Mastery

Multi-tenant appointment platform for barbershops and beauty shops: AI voice intake,
native calendar engine, Stripe prepayment, and a 24-hour late-cancellation fee.

> **Repo note:** built inside `Pollis22/test` (branch `claude/appointment-setter-init-c8ffec`)
> because the build session could not create new repos. Intended home:
> `Pollis22/Appointment-Setter` — see `docs/deploy-runbook-v1.md`.

## Stack
- **shared** — types + canonical cancellation policy text
- **server** — TypeScript, Express, drizzle ORM, Postgres; PaymentsProvider (Stripe
  test-mode or mock), Resend-or-mock email, node-cron jobs, ElevenLabs tool webhooks
- **client** — React + Vite; public booking flow (`/:slug`), manage page (`/m/:token`),
  barber dashboard (`/dashboard`)

## Quick start
```bash
npm ci
createdb prelo_booking            # or point DATABASE_URL anywhere Postgres 14+
cp .env.example .env              # fill DATABASE_URL at minimum
npm run seed                      # applies booking-schema-v1.sql + demo data
npm run dev                       # server :3001 + client :5173
```
Demo shop: http://localhost:5173/demo-cuts · Dashboard login: `pollis@jiemastery.ai` / `demo-owner-pass`

## Cancellation policy (product core)
Free cancellation until 24 hours before the appointment (full refund). Inside 24 hours:
$10 late fee, refund = amount − fee (floor 0). After start time: dashboard-only
(completed / no_show). One server-side source of truth: `server/src/core/cancellation.ts`.

## Tests
```bash
npm test                          # unit (slot engine, cancellation, HMAC)
PGTEST_URL=postgres://... npm test  # + DB integration (double-book race, expiry)
```

Brand: navy `#0B2545` · cyan `#06B6D4` · never red.
