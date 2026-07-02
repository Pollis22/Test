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

## Pending / next session
- See `docs/deploy-runbook-v1.md` — everything that needs Pollis.
