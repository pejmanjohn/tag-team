# Cloudflare deploy story — research + design (2026-07-06)

Goal: a magical, OSS-appropriate way for anyone to deploy Tag Team (admin plane +
flue agents) to **their own** Cloudflare account, approaching one-click, with the
admin protected without us building an auth system. Research ran as a 6-agent
workflow (repo portability audit with a live scratch build, Deploy-button
mechanics, Cloudflare OAuth feasibility, admin auth, prior art, completeness
critic). Confidence labels below: **verified** = reproduced locally or read from
primary docs by an agent; **inferred** = documentation-based reasoning, needs the
live test.

## The end-user flow we should ship

1. **Click "Deploy to Cloudflare" in the README**
   (`https://deploy.workers.cloudflare.com/?url=<repo>`). Cloudflare clones the
   repo into the user's GitHub, reads the **committed** `wrangler.jsonc`,
   auto-provisions the Durable Object SQLite classes, wires Workers Builds CI,
   and prompts for exactly **one secret: `TAG_ADMIN_TOKEN`** (described as
   "generate with `openssl rand -hex 32`"). Free Cloudflare plan suffices
   (DO SQLite + Workers AI are on free, with daily caps).
2. **Open `https://tag-team.<account>.workers.dev/admin`**, log in with the
   token (the cookie login page already works on workerd — verified). A
   first-run wizard detects "no Slack credentials yet" and renders a
   **Slack manifest deep-link** (`api.slack.com/apps?new_app=1&manifest_json=…`)
   with `request_url` pre-filled to the worker's own URL — generated
   server-side from the request host, so the step every competitor makes users
   do by hand disappears. (Manifest measures 2,601 chars URL-encoded — safely
   under URL limits; verified.)
3. **User clicks Install in Slack, pastes back bot token + signing secret** into
   the wizard, which validates live (`auth.test` + signature check) so the paste
   feels instant and verified, and stores them in the DO-backed config store
   (env/secret values take precedence when set — power users can
   `wrangler secret put` instead).
4. **First mention works with zero model keys** via the Workers AI binding
   (`cloudflare/…` provider, no API token). The wizard/admin upsells
   `ANTHROPIC_API_KEY` for a smarter default.

The paste-back in step 3 is irreducible: `apps.manifest.create` can return the
signing secret but requires a manually-generated 12-hour app-config token, and
the `xoxb` bot token only exists after install. No OSS Slack bot surveyed does
better; validating the paste live is how we make it feel magical anyway.

## Answer to the OAuth question

The linked page is **Cloudflare Access "managed OAuth"** — Access acting as an
OAuth *authorization server* to protect self-hosted apps for non-browser clients
(CLIs/MCP). It is **not** a way to get API access to a user's Cloudflare account.

Separately, the dream did just become possible: Cloudflare shipped
**self-managed OAuth clients for the account API on 2026-06-03**
(changelog `2026-06-03-public-oauth-clients`; auth-code + PKCE; public clients
need domain verification). So "OAuth in and we deploy for you" is technically
buildable — but it requires *us* to run a hosted service holding Workers-write
grants over strangers' Cloudflare accounts: a high-value target and an
operational/liability posture wrong for a self-hosted MIT project. The Deploy
button gives ~the same magic with Cloudflare hosting the flow and us holding
nothing. **Decision: button now; note hosted OAuth onboarding as a possible
future product, not part of OSS launch.** (Workers for Platforms was evaluated
and rejected: it moves users' code, billing, and Slack secrets into *our*
account.)

## Admin auth (layered, no auth system built)

1. **Baseline (default): `TAG_ADMIN_TOKEN`** + 404-if-unset + the existing
   cookie login page (Vaultwarden pattern). Works identically on Node and
   Workers; verified under workerd.
2. **Optional: Cloudflare Access** — if `POLICY_AUD` + `TEAM_DOMAIN` env vars
   are set, `/admin` verifies the `Cf-Access-Jwt-Assertion` JWT (jose +
   `createRemoteJWKSet` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
   iss + aud checks) and skips the token gate. ~0.5–1 day; Cloudflare publishes
   the exact Worker code. Since May 2026, new Zero Trust orgs default to
   **"log in with your Cloudflare account"** — zero IdP setup, free ≤50 users.
3. **Critical caveat (docs must say this):** the one-click "Enable Cloudflare
   Access" toggle on workers.dev protects the **entire hostname** — it would
   block Slack's event webhooks. Access is only viable with in-worker JWT
   validation plus a bypass/service-token arrangement for
   `/channels/slack/events`, or a separate ingress hostname. Do **not** market
   "just flip on Access" as zero-code; keep the token as the default story.

## Engineering work (from the verified port audit)

> **Status (2026-07-06, branch cf-deploy):** items 1–8 below are implemented
> (async state stores + `TagStateStore` DO, in-process dispatch — `TAG_SELF_URL`
> was deleted entirely rather than kept Node-only, waitUntil detach, CF binding
> provider, `.dev.vars.example` + `cloudflare` package block, the `/admin`
> Slack-connection wizard, and the dual-target builds with the
> `verify-cf-smoke` gate). The table is preserved as the original audit;
> "currently" claims describe the pre-port state.
>
> **Deploy-button test (2026-07-07): PASS.** Live click-through against the
> public repo (worker renamed `tag-team-button-test`, then deleted; clone repo
> flipped private). Verified: setup page prompts from `.dev.vars.example` with
> the `package.json` `cloudflare.bindings` description; build detected node
> 22.19.0 from `.nvmrc`; `npm run build` ran the db.ts park/restore script;
> `wrangler deploy` used the `.wrangler/deploy/config.json` redirect
> (58s clone→deploy); deployed worker served the 401 token form, DO-seeded
> profiles, and the wizard with the worker's own `request_url` substituted.
> One fix landed from the test: the button treats EVERY key in
> `.dev.vars.example` as a required prompt, so the optional
> `ANTHROPIC_API_KEY` line became comment-only (d9a6655).

The scratch build proved `flue build --target cloudflare` succeeds once
`src/db.ts` is out of the source root and `agents@^0.14.2` is added: it emits
`dist/tag_team/wrangler.json` (merging our committed `wrangler.jsonc`, which is
already correct) **plus `.wrangler/deploy/config.json`** — Wrangler's documented
generated-config redirect — so plain `npx wrangler deploy` Just Works in Workers
Builds. 1.59 MiB gzip, under the free-plan 3 MiB cap. Remaining work:

| # | Item | Size | Notes |
|---|------|------|-------|
| 1 | Lazy `INTERNAL_AGENT_TOKEN` (no module-scope `randomUUID`) | S | **Launch blocker**: worker currently crashes at startup on workerd when `TAG_AGENT_API_TOKEN` unset (`src/slack/internal-auth.ts:15`). Worker/DO isolates can't share a random fallback — derive or require it on Workers. |
| 2 | Async `StateStore` interface; two backends: existing `node:sqlite` + a Workers backend | L | The core port. Config/assignments, snapshots, claims, thread registry (`src/config/store.ts`, `snapshot-store.ts`, `src/slack/claim-store.ts`) all die on workerd. Recommended backend: one app-owned DO exported from `src/cloudflare.ts` (zero provisioning, strongly consistent claims). **Spike first:** `node:sqlite` may be constructible *inside* a DO — if so this shrinks a lot. ~15 call sites go async (mechanical). |
| 3 | In-process dispatch instead of HTTP self-call | M | `resolveSelfBaseUrl` loopback trust rejects every turn on Workers; call the Flue route/DO binding directly, keep `TAG_SELF_URL` as Node-only. |
| 4 | `ctx.waitUntil` for the detached turn + hint promises | S | `src/channels/slack.ts:209,238`. Watch: if turns outrun the waitUntil horizon, turn orchestration moves into the DO (upgrades item 3 to L). |
| 5 | CF-target default model → binding-backed `cloudflare/` provider | S | **Launch blocker for keyless deploy**: current seed default is the URL provider (`cloudflare-workers-ai/…`) needing an API token — a keyless button deploy couldn't run a single turn. |
| 6 | `.dev.vars.example` (CF-specific) with `TAG_ADMIN_TOKEN` + optional `ANTHROPIC_API_KEY`, and `cloudflare.bindings` descriptions in package.json | S | Drives the button's secret-prompt UI. Current `.env.example` **lacks `TAG_ADMIN_TOKEN`** and is full of Node-lane noise — don't let the button prompt from it. |
| 7 | First-run wizard in `/admin`: Slack-credential setup, manifest deep-link with substituted `request_url`, live validation, store creds in config store | M | Admin page is inline HTML, no assets binding needed (verified). App must boot healthy with only `TAG_ADMIN_TOKEN` set. |
| 8 | Dual-target build scripts (`flue:build` node / `flue:build:cf` staging db.ts out) + parity harness against the Workers state backend | M | flue CLI needs Node ≥22.18; `.nvmrc` (22.19) is auto-detected by Workers Builds — but the successful build ran on node 24. Settle 22.19 vs 24 with one run **before launch**. |
| 9 | Optional, post-launch: Access JWT validation (auth layer 2) and `npx tag-team deploy` CLI (Counterscale-style second entry point) | M | Nice-to-haves; don't block launch. |

## Mandatory pre-launch verification (one afternoon)

- **Live button test on a scratch public repo** — the single remaining
  empirical unknown: does the setup page render DO provisioning + secret
  prompts from a wrangler.jsonc with `migrations` but no
  `durable_objects.bindings` block, and does Workers Builds run the flue build
  before deploy. A failed first click is the worst possible launch outcome.
- Node 22.19 vs 24 for the CF-target flue build (see item 8).
- Re-run the parity suite (31 scenarios) against the Workers state backend;
  re-verify the app_mention+message dedupe race on the DO claim store.
- Smoke `wrangler secret put` → module-scope `process.env` reads on a real
  deploy (verified only under `wrangler dev` local so far).

## README honesty items (critic findings, currently unowned)

- **Free-tier budget:** caps are hard errors (10K Neurons/day Workers AI,
  100K DO row writes/day). Nobody has quantified Neurons-per-turn or DO
  writes-per-event; measure before claiming "free plan suffices."
- **Model quality:** is the keyless Workers AI default good enough for the
  agent loop (tool use, context)? If not, the honest default is "add
  `ANTHROPIC_API_KEY`" with Workers AI as the fallback.
- **Updates:** the button *clones* (not forks) — no sync button. Ship release
  tags + a documented upgrade path (template-sync Action or re-deploy
  instructions), and commit to append-only DO migrations across versions.
- **Scope:** single-workspace bot-token model (no multi-workspace OAuth
  distribution); no DO backup/export; `wrangler tail` is the debug story.

## Rejected alternatives

- Hosted "OAuth and we deploy" web service (possible since 2026-06-03, wrong
  security/ops posture for MIT OSS — revisit as a product).
- Workers for Platforms (inverts self-hosting; users' secrets land in our account).
- D1 instead of an app-owned DO (viable fallback if cross-isolate read fan-out
  ever matters; DO wins on zero-provisioning + consistent claims).
- Prompting for Slack secrets at button time (chronology is impossible — the
  Slack app needs the worker URL first; wizard collects them post-deploy).
