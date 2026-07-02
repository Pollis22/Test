# build-report-v1.md — Prelo Booking autonomous build (7/2/26)

Master prompt: "PRELO BOOKING — MASTER BUILD PROMPT v1 (7/1/26)". Fully remote,
autonomous, mock-degraded where secrets were missing. One commit per phase on
`claude/appointment-setter-init-c8ffec` in `Pollis22/test` (repo-creation was
proxy-blocked — see runbook §1).

## Per-phase results

### Phase 0 — repo + scaffold ✅ (with repo degradation)
- `gh` CLI absent; GitHub MCP `create_repository` → 403; REST `POST /user/repos`
  with the provided PAT → 403 *"sessions are bound to their configured
  repositories"*. Fallback target `Pollis22/prelo` also out of scope.
  → Built in `Pollis22/test` on the session's designated branch.
- npm-workspaces monorepo (`shared` / `server` / `client`) mirroring the
  jarvis-rehearsal chassis conventions (prelo itself unreachable).
- Brand: navy `#0B2545`, cyan `#06B6D4`, "Prelo Booking — Powered by JIE
  Mastery", no red anywhere.

### Phase 1 — data model ✅
- `booking-schema-v1.sql` (idempotent, pgcrypto + btree_gist), drizzle schema,
  journal-registered boot migrator (`_migrations` table).
- `user_role` enum exactly `('owner','admin','member')`.
- **Double-booking prevented at the DB level**: gist exclusion constraint on
  `staff_id` + `tstzrange(starts_at, blocked_until)` over live statuses
  (`pending_payment`,`confirmed`). `blocked_until = ends_at + buffer` — design
  addition so the constraint covers service buffers, not just duration.
- Executed live against local Postgres 16: overlap rejected (23P01), cancelled
  overlap accepted. Seed verified: Demo Cuts / America/Chicago, owner
  `pollis@jiemastery.ai` (bcrypt `$2b$10` — swapped bcryptjs→bcrypt when the
  smoke check caught `$2a$` output), 2 staff, 4 services at spec prices,
  Mon–Sat 9–18.

### Phase 2 — slot engine + booking API + customer app ✅
- Pure slot engine; shop-timezone wall-time windows. **DST bug caught by its own
  test** (window built with `plus(minutes)` shifted 9:00→10:00 on spring-forward
  day) and fixed with wall-time `set()`; both DST transition dates now asserted.
- Booking: `pending_payment` + 10-minute hold → payment → `confirmed`; expiry
  sweep releases slots (cron + lazy sweep before availability queries).
- Cancellation single source of truth (`core/cancellation.ts`):
  free / late_fee (refund = amount − fee, floor 0) / not_allowed; the manage
  API refuses a late cancel without explicit `feeAccepted` (verified 400).
- Customer app: wizard with policy ack checkbox (stored as `policy_ack_at`),
  manage page with keep-or-cancel-with-fee UI, reschedule grid (outside cutoff only).

### Phase 3 — payments ✅ (mock active)
- `PaymentsProvider` interface; env refuses non-`sk_test_` keys by design.
- Mock provider drives the identical webhook success path; Stripe test-mode
  impl ready (PaymentIntent metadata, Connect destination charges, partial
  refunds, signature-verified webhook) — untested against live Stripe (no key),
  flagged in runbook §3.
- Ledger rows: charge / refund / partial_refund (asserted in integration tests).

### Phase 4 — dashboard ✅
- bcrypt + DB sessions; roles enforced (`requireRole`); everything scoped by
  `shop_id`.
- Day/week per-staff calendar, staff create (skip payment → confirmed),
  staff cancel (fee waived per `staff_cancel_waives_fee` toggle), block time,
  completed/no_show, services/staff/availability/time-off CRUD, customers with
  visit history, policy + Stripe Connect settings.

### Phase 5 — voice agent ✅ (config committed; provisioning needs key)
- 7 HMAC-verified tool webhooks (timing-safe compare; bad signature → 401
  verified live). Raw-body capture bug found in E2E (global json parser ate the
  bytes) and fixed.
- **Fee disclosure is enforced server-side**: inside the cutoff,
  `cancel_appointment` first returns the verbatim sentence to read and
  `requiresFeeConfirmation:true`; only a second call with `fee_accepted=true`
  cancels. The model cannot skip the disclosure.
- Returning-caller memory verified live ("Returning customer: E2E Tester").
- `config/elevenlabs-agent-config-v1.json` committed (prompt, 6 tools,
  post-call webhook, widget note).

### Phase 6 — Google Calendar + email worker ✅ (flag off / mock)
- One-way push + freebusy subtraction wired into the slot engine; no-op without
  Google creds. Two-way sync → backlog.
- Cron: hold expiry (1m), T-24h reminder restating the policy (15m, idempotent
  via event_log). All templates restate the policy + manage link.

### Phase 7 — deploy ⚠ skipped (no Railway token) + final audit ✅
- Runbook §2 has exact phone-friendly Railway UI steps.
- Fresh-clone audit by an independent sub-agent: see "Verification" below.

## Verification summary
- `npm run typecheck` ✅ · `npm run build` (shared+server+client) ✅
- Test suite **24/24** (vitest): slot engine 9 (incl. 2 DST), cancellation 8,
  HMAC 1, DB integration 6:
  - book >24h + cancel → full refund, ledger `charge,refund` ✅
  - book <24h + cancel → refund 2500 / fee 1000; unaccepted fee rejected ✅
  - $7 service late-cancel → fee capped 700, refund 0 (floor 0) ✅
  - 3-way concurrent double-book race → exactly 1 winner (DB constraint) ✅
  - hold expiry frees slot; rebooking succeeds ✅
  - reschedule outside cutoff ok; inside cutoff refused ✅
- Live HTTP round-trips on the running server (mock payments): free-cancel
  path and late-cancel path both verified end-to-end, incl. policy emails
  (4 mock emails observed) and voice tools.
- **Fresh-clone audit (independent sub-agent): PASS.** From a fresh clone +
  fresh database: `npm ci` clean against the lockfile, full build green,
  **24/24 tests**, seed exact (1 shop / 2 staff / 4 services / 12 rules /
  `$2b$10` owner hash), live HTTP round-trip verified (book → mock pay →
  manage quote free → cancel → full $35 refund), zero server-log errors.
  Audit recommendations acted on post-audit: availability endpoint now accepts
  both `?service=`/`?serviceId=` (and staff variants); runtime `bcrypt` bumped
  5.x → 6.x (npm-audit high), tests re-run 24/24. Remaining recommendations
  logged: dev-tooling npm-audit findings (vitest/vite, dev-only), pre-existing
  `index.html` notebook artifact at repo root (predates this build — remove
  during the repo move, runbook §1), seed default password must be overridden
  in real environments (runbook §6).

## Bugs found & fixed during verification
1. bcryptjs emits `$2a$` — violates the `$2b$10` house rule → swapped to native bcrypt.
2. Seed `event_log` insert: one param used as uuid and text → explicit casts.
3. Slot engine DST: physical-minute window construction → wall-time `set()`.
4. Mock-confirm webhook mounted before the json parser → parsed per-route +
   route-level try/catch + app-level error handler + unhandledRejection guard
   (a bad request could previously crash the process).
5. Voice HMAC: global json parser consumed the raw body before the tools
   router could capture it → raw-body capture moved to the app-level parser.

## Degraded items (all logged in runbook §5)
Repo home · Railway deploy · Stripe (mock) · Resend (mock) · ElevenLabs
(config only) · Google Calendar (flag off) · canonical .env unavailable.

## Backlog
Two-way Google Calendar sync · Twilio SMS reminders · no-show fee · per-shop
theming · platform fee % on destination charges · live-Stripe cutover checklist ·
repo move to Appointment-Setter · Railway provisioning · Stripe Elements
client-side confirm for stripe mode (mock flow is complete; the stripe-mode
manage-page `?pay=1` path needs Elements wiring when keys exist).
