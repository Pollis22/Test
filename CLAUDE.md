# CLAUDE.md — Prelo Booking (Appointment Setter)

> Auto-read by Claude Code at session start. Durable cross-session memory for this repo.
> If something here is stale, say so and propose an edit rather than silently ignoring it.

## This project
**Prelo Booking — Powered by JIE Mastery.** Multi-tenant appointment platform for
barbershops and beauty shops. AI voice intake (ElevenLabs ConvAI, prelo pattern),
native calendar engine, Stripe prepayment, 24-hour late-cancellation fee ($10 default,
per-shop configurable). Monorepo: `shared` + `server` (TS/Express/drizzle) + `client`
(React/Vite).

## Repo home (IMPORTANT)
Built 7/2/26 inside **Pollis22/test** on branch `claude/appointment-setter-init-c8ffec`
because the remote session was repo-scoped and GitHub blocked new-repo creation
(both the integration and the PAT — "sessions are bound to their configured
repositories"). **Intended home: a new repo `Pollis22/Appointment-Setter`.** Steps to
move it are in `docs/deploy-runbook-v1.md` § "Move to the real repo". The pre-existing
`index.html` at root predates this build — it belongs to the old test repo, not this app.

## Deploy rule
- Branches: `dev` (build) → `main` (prod) once the repo has its real home. Until then,
  everything lives on `claude/appointment-setter-init-c8ffec`.
- Railway not yet provisioned (no token in build session) — runbook has exact steps.
- SQL migrations: standalone versioned files (`booking-schema-v1.sql`), registered in
  `server/migrations/meta/_journal.json`; boot migrator applies unapplied entries.
  Run via public proxy URL only — NEVER `.railway.internal`. Idempotent SQL preferred.

## Brand tokens
Working brand "Prelo Booking — Powered by JIE Mastery". Navy `#0B2545`, cyan accent
`#06B6D4` (Prelo tokens). **Never JIE red.**

## House rules in force
- `user_role` enum EXACTLY `('owner','admin','member')`.
- Default admin: `pollis@jiemastery.ai`, role=owner, is_admin=true, shop tier
  'enterprise' (quota −1 semantics, gates skipped).
- bcrypt `$2b$10$`; if pgcrypto ever compares hashes: `REPLACE(password_hash,'$2b$','$2a$')`.
- Phone-first customer identity (E.164) for voice returning-caller matching.
- File naming: `name-vN.sql`, `name-vN.md`, `name-vN.ps1`.
- Stripe TEST MODE ONLY until an explicit live-cutover checklist is executed.

## Cancellation policy (single source of truth: `server/src/core/cancellation.ts`)
- Free cancel until `starts_at − cancel_cutoff_hours` (default 24h) → full refund.
- Inside cutoff → explicit fee disclosure + confirm; refund = amount − late fee (floor 0).
- After start → no self-serve cancel; dashboard marks completed / no_show.
- Policy text at checkout + every email + spoken by voice agent; `policy_ack_at` stored.

## Secrets
Canonical: `C:\Users\probe\OneDrive\Desktop\jie-ads-automation\.env` (Pollis's machine —
NOT present in remote containers). Missing keys degrade to mocks + feature flags; every
degradation is logged in `docs/deploy-runbook-v1.md`.

## Feature flags (derived in `server/src/env.ts`)
- `PAYMENTS_MODE`: `stripe` if STRIPE_SECRET_KEY (test) present, else `mock`.
- `EMAIL_MODE`: `resend` if RESEND_API_KEY present, else `mock` (console).
- `GOOGLE_CALENDAR_ENABLED`: only with GOOGLE_CLIENT_ID/SECRET.
- Voice tool webhooks always on; HMAC via ELEVENLABS_TOOL_SECRET.

## Backlog
Two-way Google Calendar sync · Twilio SMS reminders · no-show fee · per-shop theming ·
platform fee % on destination charges · live-Stripe cutover checklist · repo move to
Appointment-Setter · Railway provisioning.

## Session hygiene
Update `docs/session-state.md` at end of each working session: what was built, what's
pending, decisions made.
