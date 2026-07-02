# deploy-runbook-v1.md — Prelo Booking

Everything that still needs Pollis, with exact steps. Built 7/2/26 in a remote
Claude Code session with **zero secrets available** — every integration is
mocked behind a feature flag and works the moment its key lands in env vars.

---

## 1. Move to the real repo (BLOCKED in build session)

**What happened:** the remote session was repo-scoped to `Pollis22/jarvis-rehearsal`
and `Pollis22/test`. Repo creation was blocked at the proxy for both the GitHub
integration (403) and the PAT (`"sessions are bound to their configured
repositories"`). `Pollis22/prelo` (fallback target and reference chassis) was also
out of scope, so the app was built in **`Pollis22/test`**, branch
`claude/appointment-setter-init-c8ffec`, and the locally available jarvis-rehearsal
chassis supplied the house conventions.

**Phone-friendly fix (5 min):**
1. GitHub app → profile → Repositories → **New** → name `Appointment-Setter`
   (or `prelo-booking`), Private → Create.
2. Start a new Claude Code session **scoped to the new repo + test**, and say:
   *"Copy the Prelo Booking app from Pollis22/test branch
   claude/appointment-setter-init-c8ffec into this repo: push that branch's tree
   as `dev` and `main`, preserving history."*
3. After the move, archive the branch in `test` or leave it — nothing else lives there.

## 2. Railway provisioning (no token in session)

Railway UI steps (phone-friendly):
1. railway.app → **New Project** → name `prelo-booking`.
2. **+ Create** → Database → **PostgreSQL**.
3. **+ Create** → GitHub Repo → pick the new repo, branch `dev`
   (fallback while the app still lives in `test`: repo `Pollis22/test`, branch
   `claude/appointment-setter-init-c8ffec`).
4. Service → Settings → Build: build command `npm run build`, start command `npm start`.
5. Service → Variables (see §3). Add at minimum `DATABASE_URL` = the Postgres
   plugin's **`DATABASE_PUBLIC_URL`** (public proxy — NEVER `.railway.internal`),
   `SESSION_SECRET` (long random), `APP_BASE_URL` = the service's public URL.
6. The boot migrator applies `booking-schema-v1.sql` automatically on first start
   (it's journal-registered). Seed once from a shell:
   `railway run npm run seed` — or locally:
   `DATABASE_URL=<public url> npm run seed`.
7. Verify: open `<url>/healthz` → `{"ok":true,...}`, then `<url>/demo-cuts` and
   book with the mock payment button.

## 3. Secrets to add (each one flips its feature on automatically)

| Env var | Effect when present | Where it lives |
|---|---|---|
| `DATABASE_URL` | required — Postgres public proxy URL | Railway plugin |
| `SESSION_SECRET` | required — cookie signing | generate |
| `APP_BASE_URL` | manage links + emails point here | Railway URL / domain |
| `STRIPE_SECRET_KEY` (**sk_test_ only**) | payments mode mock → stripe | canonical .env / Stripe dashboard |
| `STRIPE_WEBHOOK_SECRET` | verifies Stripe webhooks (`/api/payments/stripe`) | Stripe dashboard → Webhooks |
| `STRIPE_PUBLISHABLE_KEY` | client-side confirm | Stripe dashboard |
| `RESEND_API_KEY` + `EMAIL_FROM` | email mode mock → Resend | canonical .env |
| `ELEVENLABS_API_KEY` | enables agent provisioning (§4) | canonical .env |
| `ELEVENLABS_TOOL_SECRET` | HMAC secret for tool webhooks (set NOW, any long random) | generate |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Calendar flag on | Google Cloud console |

Safety rails still in force: a non-`sk_test_` Stripe key is **refused** by the
server (payments stay mock). Live cutover has its own checklist in the backlog.

### Stripe test-mode verification (once keys are in)
1. Stripe dashboard → Developers → Webhooks → add endpoint
   `<url>/api/payments/stripe`, events `payment_intent.succeeded`,
   `payment_intent.payment_failed`; copy the signing secret into
   `STRIPE_WEBHOOK_SECRET`.
2. Book at `<url>/demo-cuts` with test card `4242 4242 4242 4242`.
3. Late-cancel it (book <24h out) → confirm in Stripe test dashboard:
   partial refund = amount − $10.
4. Connect Express: dashboard → Settings → **Connect Stripe** walks the
   onboarding link and stores `stripe_account_id`. **Note:** the Demo Cuts shop
   has no connected account → charges go to the platform account (flagged as
   designed; per-shop destination charges begin once a shop onboards).

## 4. ElevenLabs voice agent (no key in session)

The tool webhooks are LIVE already (HMAC-verified, tested). To provision the agent:
1. Put `ELEVENLABS_API_KEY` in env (canonical .env has it).
2. Create a ConvAI agent from `config/elevenlabs-agent-config-v1.json`
   (dashboard: Agents → New → paste the prompt + tools, or API `POST /v1/convai/agents`).
   Replace `{{APP_BASE_URL}}` in every tool URL; set the tool-secret header
   mechanism to send `x-tool-signature` = hex HMAC-SHA256 of the request body
   using `ELEVENLABS_TOOL_SECRET`.
3. Attach a phone number (ElevenLabs → Phone Numbers) to the agent.
4. Web widget: reuse the prelo widget bundle pattern pointed at the new agent id.
5. Test call script: book (agent must read the policy aloud), then call back and
   cancel inside 24h — the agent MUST read the $10 fee sentence and get a yes
   (the API refuses to cancel without `fee_accepted=true`, so this is enforced).

## 5. Degradations log (build session, 7/2/26)

| Item | Status | Why |
|---|---|---|
| New GitHub repo "Appointment Setter" | **BLOCKED** → built in Pollis22/test | session repo scoping (proxy-enforced) |
| Clone of Pollis22/prelo as reference | substituted jarvis-rehearsal (local) | out of session scope |
| Stripe | mock provider active | no STRIPE_SECRET_KEY |
| Resend | console mock | no RESEND_API_KEY |
| ElevenLabs agent | config committed, not provisioned | no ELEVENLABS_API_KEY |
| Google Calendar | feature flag off | no GOOGLE_CLIENT_ID/SECRET |
| Railway deploy | skipped → §2 steps | no RAILWAY_TOKEN |
| Canonical .env `C:\Users\probe\...` | not mounted in remote container | remote session |
| Schema execution | ran against LOCAL Postgres 16 (full test suite + E2E) | no remote DB existed |

## 6. Post-deploy smoke checklist (5 min, phone-friendly)

1. `<url>/healthz` → ok true.
2. `<url>/demo-cuts` → book tomorrow+ → pay → confirmation shows.
3. Confirmation email arrives (once Resend key set) and restates the policy.
4. Manage link → cancel → full refund message.
5. Book <24h out → manage page shows the $10 keep-or-cancel choice.
6. `<url>/dashboard` → login `pollis@jiemastery.ai` / seed password
   (`SEED_OWNER_PASSWORD` env at seed time, default `demo-owner-pass` — CHANGE IT) →
   calendar shows the bookings.
