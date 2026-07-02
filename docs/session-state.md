# session-state.md — Prelo Booking

## 7/2/26 — initial autonomous build (remote session)
- **Repo home degradation:** session was repo-scoped to `Pollis22/jarvis-rehearsal` +
  `Pollis22/test`; GitHub proxy hard-blocked `POST /user/repos` for both the app
  integration and the PAT ("sessions are bound to their configured repositories").
  → Built in `Pollis22/test` on `claude/appointment-setter-init-c8ffec`. Move steps in
  `docs/deploy-runbook-v1.md`.
- **Reference chassis:** `Pollis22/prelo` also out of session scope; used the locally
  available `jarvis-rehearsal` for house conventions (npm workspaces, TS+Express,
  drizzle, versioned SQL + journal, tool-webhook pattern).
- **Secrets found in session:** none (no Stripe/Resend/ElevenLabs/Google/Railway; the
  canonical Windows .env is not mounted in remote containers). All integrations run in
  mock mode behind feature flags.
- Build progress is tracked per-phase in `docs/build-report-v1.md`.

## What was built (7/2/26, phases 0–7 complete)
Full Prelo Booking vertical slice, verified green: schema + exclusion-constraint
double-booking guard (executed on local PG 16), slot engine (DST-safe), booking
lifecycle with 10-min holds, cancellation single-source-of-truth (24h/$10,
refund floor 0, explicit fee acceptance gates on web AND voice), mock payments
driving the real webhook path, barber dashboard, 7 HMAC voice tools +
committed agent config, cron reminders/expiry, Google flag-off.
24/24 tests incl. 6 DB integration (race, expiry, refund math); live HTTP
round-trips for free-cancel, late-cancel, and voice paths. 5 real bugs found
and fixed during verification (see build-report-v1.md).

## Decisions made
- `blocked_until` column so the DB constraint covers service buffers.
- Non-test Stripe keys refused at env parse (live charges impossible).
- Late-fee disclosure enforced server-side for the voice agent (two-call
  confirm pattern) — the model can't skip it.
- Local Postgres cluster used for real verification since no remote DB existed.

## Pending / next session
- See `docs/deploy-runbook-v1.md` — repo move (§1), Railway (§2), secrets (§3),
  ElevenLabs provisioning (§4), Stripe test verification (§3.1).
- Backlog list at the end of `docs/build-report-v1.md`.
