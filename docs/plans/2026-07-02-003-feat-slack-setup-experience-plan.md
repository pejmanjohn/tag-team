---
title: Slack Setup Experience - Plan
type: feat
date: 2026-07-02
topic: slack-setup-experience
---

# Slack Setup Experience - Plan

Designs the first-run setup experience for `slack-flue`: a checked-in Slack app manifest ([`slack-app-manifest.json`](../../slack-app-manifest.json)) plus a local-first walkthrough. Product scope for bot identity is locked in [2026-07-02-001-feat-bot-identity-plan.md](./2026-07-02-001-feat-bot-identity-plan.md); implementation shape in [2026-07-02-002-feat-bot-identity-architecture.md](./2026-07-02-002-feat-bot-identity-architecture.md). Per the locked setup-experience decision, **the manifest file is now the source of truth for the bot's display name** (the identity-architecture doc's `src/config/identity.ts` name field, if implemented, must mirror the manifest — flagged in the punch list).

Locked decisions honored here: manifest maintained as code, operator hand-edits only the Request URL host and the two name fields; no admin UI or manifest generator; icon is a one-time manual console upload; local-first golden path (localhost + tunnel before any hosted deploy).

## 1. Research findings

### 1.1 Manifest schema (verified)

Source: official App manifest reference — https://docs.slack.dev/reference/app-manifest/

Confirmed field paths (all present in the reference and in Slack's own working template manifest):

- `display_information.name` (required, ≤35 chars), `.description` (≤140 chars, optional), `.background_color` (3- or 6-digit hex; **once set it cannot be removed, only updated**).
- `features.bot_user.display_name` (required if `bot_user` present, ≤80 chars), `features.bot_user.always_online`.
- `features.app_home.home_tab_enabled`, `.messages_tab_enabled`, `.messages_tab_read_only_enabled` (booleans).
- `oauth_config.scopes.bot` — array of bot scope strings.
- `settings.event_subscriptions.request_url` (HTTPS URL) + `settings.event_subscriptions.bot_events` (array of event type strings).
- `settings.interactivity.is_enabled` (+ `request_url` only when enabled).
- Also valid at `settings.*`: `org_deploy_enabled`, `socket_mode_enabled`, `token_rotation_enabled`. Manifest validation enforces "Event Subscription requires either Request URL or Socket Mode Enabled" (https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/).

Cross-checked against Slack's own shipped manifest in `slack-samples/bolt-js-assistant-template` (`manifest.json`, fetched verbatim 2026-07-02): identical field paths, including `features.assistant_view`. Note: the published JSON schema at `slackapi/manifest-schema` is **stale** (it does not contain `assistant_view` or `app_home` fields); the docs reference + working template are the ground truth. We keep the `$schema` pointer in our file for editor affordance only.

### 1.2 Create-from-manifest flow and request_url verification (verdict: run server + tunnel FIRST)

Sources:
- Create flow: https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/ — click path: **api.slack.com/apps → Create New App → "From a manifest" → pick workspace → Next → paste JSON → Next (review summary) → Create.**
- URL challenge: https://docs.slack.dev/apis/events-api/using-http-request-urls/ — when a Request URL is entered in the console, "After you've completed typing your URL, we'll dispatch an HTTP POST to your request URL" containing a `challenge`; the endpoint must echo it back with HTTP 200, and "Your Event request URL must be confirmed before saving the form." A **Retry** button exists for servers that fail the first attempt ("If your server takes some time to 'wake up'… use the Retry button").
- Challenge payload: https://docs.slack.dev/reference/events/url_verification/

**Verdict on ordering:** the create-from-manifest docs do *not* document whether the challenge fires at creation time (this is logged in §4 anti-assumptions). What *is* documented: any console-side entry/edit of the Request URL triggers an immediate challenge that must pass. Therefore the walkthrough puts **local server + tunnel up and answering before the manifest is pasted**, which is correct under either behavior: if Slack challenges at creation, it passes; if not, the post-creation "confirm Verified / click Retry" checkpoint passes on the first click. This ordering costs nothing and removes the only race in the flow. (The app's `POST /channels/slack/events` handler must answer the `url_verification` challenge — it does; this is the same handshake `docs/play-slack.md` already relies on.)

### 1.3 App icon (verdict: NOT in the manifest; manual console upload)

- The App manifest reference (https://docs.slack.dev/reference/app-manifest/) defines **no icon field** for the classic JSON manifest pasted at api.slack.com/apps. The only `icon:` field on that page belongs to the TypeScript `Manifest()` of the Slack automation platform (ROSI/Deno SDK) — a different manifest format that does not apply here.
- Confirmed by the identity plan's own finding: "Slack exposes no API to set an app's display icon; it is uploaded once in the app console" ([2026-07-02-001](./2026-07-02-001-feat-bot-identity-plan.md), Key Decisions).
- Console location: **app settings → Settings → Basic Information → scroll to "Display Information" → App icon & Preview → upload** (`assets/bot-avatar.png`, 512×512 minimum). Exact widget label is from common practice, not a verbatim docs quote — see §4.

### 1.4 Agents & AI Apps / Assistant surface (verdict: expressible in the manifest via `features.assistant_view`)

Sources:
- AI apps docs: https://docs.slack.dev/ai/developing-ai-apps — the feature can be enabled via a console toggle (**app settings sidebar → Agents & AI Apps → enable**), which auto-adds `assistant:write`; it is *also* expressible in the manifest under `features`.
- App manifest reference: https://docs.slack.dev/reference/app-manifest/ — documents **both** `features.agent_view` (newer "Agent" messaging experience: `app_home_opened`, `app_context_changed`, `message.im`) and `features.assistant_view` (the Assistant experience: `assistant_thread_started`, `assistant_thread_context_changed`, `message.im`), with `assistant_view: { assistant_description, suggested_prompts: [{title, message}] }`.
- Working proof: `slack-samples/bolt-js-assistant-template/manifest.json` ships `features.assistant_view` and is created via the standard from-a-manifest flow.

**This repo's code targets the Assistant surface** (`assistant:write`, `assistant_thread_started` / `assistant_thread_context_changed` — see `docs/play-slack.md` and `src/channels/slack.ts`), so the manifest uses `assistant_view`, not `agent_view`. Whether creating from a manifest containing `assistant_view` flips the console "Agents & AI Apps" toggle automatically is not documented; the walkthrough includes a 10-second confirmation checkpoint (§4).

### 1.5 Battle-tested OSS onboarding (what to emulate)

- **slackapi / slack-samples `bolt-js-assistant-template`** (https://github.com/slack-samples/bolt-js-assistant-template): ships `manifest.json` **checked into the repo with a `$schema` pointer**; setup is "create app from this manifest, copy 3 env vars, run." Borrowed: manifest-as-code with `$schema`, and the strict "paste the file, don't click through scopes" flow. Weakness to fix: no troubleshooting section, no success checkpoint.
- **slack-samples `bolt-python-assistant-template`** (https://github.com/slack-samples/bolt-python-assistant-template): `cp .env.sample .env` → fill sequentially → run; every step is one copy-paste block. Borrowed: env-file-first flow (`cp .env.example .env`) and strictly sequential single-purpose steps. Weakness to fix: no validation/checkpoint between steps.
- **Slack Events API HTTP docs + community failure reports** (https://docs.slack.dev/apis/events-api/using-http-request-urls/, e.g. n8n issues #19113/#22776 on "Your URL didn't respond with the value of the challenge parameter"): the dominant real-world failure is entering the Request URL before anything is listening. Borrowed: server-and-tunnel-first ordering, an explicit "green Verified" checkpoint, and a troubleshooting entry for the challenge failure.

Both official templates use **Socket Mode** to dodge the URL problem entirely; this repo is HTTP-based (`POST /channels/slack/events`), so the tunnel-first ordering and Verified checkpoint are our substitute for that simplicity.

## 2. Setup walkthrough draft (the actual prose)

> Golden path: 8 steps, local-first, ~10 minutes. Everything below is written to be pasted into the repo docs per the punch list in §3.

---

### Set up Slack Flue locally

You'll run the agent on your machine, expose it through a tunnel, and create the Slack app by pasting one file. Order matters only once: **the server and tunnel must be running before you create the Slack app**, so Slack's URL check passes immediately.

#### 0. Prerequisites

- **Node >= 22.19** (see `.nvmrc`)
- **A tunnel tool** — [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (used below; no account needed) or ngrok
- **A Slack workspace** where you're allowed to install apps
- **One model provider credential** — Cloudflare Workers AI (default) or an Anthropic API key

#### 1. Clone and install

```bash
git clone https://github.com/<org>/slack-flue.git
cd slack-flue
npm install
```

#### 2. Configure your environment

```bash
cp .env.example .env
```

Open `.env` and fill in your model provider (leave the Slack values empty for now — you'll get them in step 6):

```bash
# Default provider: Cloudflare Workers AI
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...   # must include the Workers AI permission

# — or use Anthropic instead —
# ANTHROPIC_API_KEY=...
# SLACK_FLUE_MODEL=anthropic/claude-haiku-4-5
```

`flue dev` loads `.env` from the project root automatically. The full variable table is in the README.

#### 3. Start the local server

```bash
npx flue dev --target node
```

This is a long-running watch-mode dev server on port **3583** (`--port` to override). It exposes `POST /channels/slack/events` — the endpoint Slack will call.

#### 4. Start the tunnel (keep both running)

In a second terminal:

```bash
cloudflared tunnel --url http://localhost:3583
```

Copy the hostname it prints (e.g. `random-words-1234.trycloudflare.com`). That's your **public host**.

#### 5. Create the Slack app from the manifest

1. Open [`slack-app-manifest.json`](../../slack-app-manifest.json) and edit **two things**:
   - Replace `<YOUR_PUBLIC_HOST>` in `settings.event_subscriptions.request_url` with your tunnel hostname (keep the `/channels/slack/events` path).
   - Optionally rename the bot: `display_information.name` **and** `features.bot_user.display_name` (keep them identical). `description` / `background_color` are yours to taste.
2. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest** → pick your workspace → **Next**.
3. Select the **JSON** tab, paste the whole file, **Next**, review the summary, **Create**.

**Checkpoint:** in the app's settings, open **Event Subscriptions** — the Request URL should show a green **Verified**. If it doesn't, click **Retry** (your server and tunnel from steps 3–4 must still be running). Also glance at **Agents & AI Apps** in the sidebar and confirm it's enabled — the manifest's `assistant_view` block should have taken care of it.

#### 6. Upload the icon, install, and copy your credentials

1. **Icon** (one-time, can't be set by manifest): **Settings → Basic Information → Display Information → App icon** → upload `assets/bot-avatar.png` (or your own, 512×512+).
2. **Install**: **Settings → Install App → Install to Workspace → Allow**.
3. Copy two values into `.env`:
   - **Basic Information → App Credentials → Signing Secret** → `SLACK_SIGNING_SECRET`
   - **Install App → Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`

Restart the dev server (Ctrl-C, then `npx flue dev --target node` again) so it picks up the tokens. `SLACK_BOT_USER_ID` is optional — the app resolves it once via `auth.test`.

#### 7. Say hello

In Slack: invite the bot to a channel (`/invite @Flue Assistant`), then mention it:

```text
@Flue Assistant please introduce yourself
```

**You should now see:** an Assistant status line (e.g. "…is checking context") appear almost immediately, then a streamed reply in the thread. DMs to the bot (its Messages tab) work without any `@`-mention. If both happen, you're done — that's the whole loop: Slack → tunnel → local server → your model provider → back into the thread.

#### 8. Verify (optional but recommended)

The repo's verify-script convention (`scripts/verify-*.mjs`) includes offline, net-guarded harnesses; run the offline turn check to confirm the app end-to-end without touching Slack:

```bash
node scripts/verify-flue-offline-turn.mjs
```

For the live checklist (thread continuation, DM behavior, duplicate safety), see `docs/play-slack.md` §5.

#### Troubleshooting

- **"Your URL didn't respond with the value of the challenge parameter"** — the server or tunnel wasn't running (or the URL path is wrong). Confirm both terminals are alive, the URL ends in `/channels/slack/events`, then **Event Subscriptions → Retry**. Note: free `trycloudflare.com` hostnames change on every restart of `cloudflared`; if you restarted it, update the Request URL to the new host and re-verify.
- **DM composer says "Sending messages to this app has been turned off"** — App Home messages are disabled. The manifest sets `features.app_home.messages_tab_enabled: true` and `messages_tab_read_only_enabled: false`; if you created the app before this manifest, sync it under **App Home → Show Tabs → Messages Tab → Allow users to send…**, then reload Slack (Cmd-R in the client).
- **Bot ignores channel/DM messages after you changed scopes or events** — scope and event changes require a **reinstall**: **Settings → Install App → Reinstall to Workspace**. Slack shows a yellow banner when this is pending.
- **Log shows `missing_bot_user_id` and thread/DM turns are ignored** — the app couldn't resolve the bot's user id via `auth.test` (bad/missing `SLACK_BOT_TOKEN`, or an explicitly empty `SLACK_BOT_USER_ID`, which means "fail closed"). Fix the token or set `SLACK_BOT_USER_ID=U…` (find it via the bot's Slack profile → three-dot menu → Copy member ID).
- **Workers AI returns 401** — your Cloudflare token lacks the Workers AI permission. Mint a dashboard API token (My Profile → API Tokens) that includes Workers AI; `wrangler` OAuth tokens do not work for this.
- **Two replies to one message** — usually two dev servers running against the same tunnel. Duplicate suppression is otherwise built in (SQLite-backed claims).

---

## 3. What lands where (punch list — no edits made yet; content above is the draft to review)

1. **`slack-app-manifest.json`** (done in this change) — checked in at repo root; version-locked to the scopes/events the code needs. Any future scope/event change in code must update this file in the same PR.
2. **`README.md`** — replace the current "Quickstart" section body with walkthrough steps 0–7 in condensed form (or steps 0–4 + a pointer), keeping the existing voice and the env-var table untouched. Specifically: swap the prose "Expose the port with a tunnel and point Slack's Events Request URL at…" for the manifest-first flow ("edit two fields in `slack-app-manifest.json`, paste it at api.slack.com/apps"), and link `docs/play-slack.md` for the live checklist as it does today.
3. **`docs/play-slack.md`** — replace §1 "Create a Slack app" (the hand-clicked scopes/events/App-Home list) with the manifest flow (walkthrough step 5 + checkpoint), keeping the scope/event *explanations* as commentary on the manifest fields. Fold walkthrough §6 (icon + install + credentials) into it. Reorder §§2–3 headers to match the new ordering (server → tunnel → create app), and merge the Troubleshooting subsection above with the existing failure notes (the "Sending messages turned off" and reinstall-after-scope-change notes already live there — dedupe them). §§4–5 (try it / live checklist) stay.
4. **`assets/bot-avatar.png`** — does **not exist yet**. The identity architecture doc specifies it (512×512 placeholder); it must land before the walkthrough ships, since step 6 references it.
5. **Identity docs alignment** — [2026-07-02-002](./2026-07-02-002-feat-bot-identity-architecture.md) makes `src/config/identity.ts` the name's home; the locked setup-experience decision makes **the manifest** the source of truth for the display name. When the identity slice lands, its config/verify script should read the name **from `slack-app-manifest.json`** (or assert equality with it) rather than duplicating it. `scripts/verify-identity-live.mjs` (planned there) becomes the natural "step 8" live identity check.
6. **`.env.example`** — no changes needed; it already matches the walkthrough.

## 4. Anti-assumptions log (could not verify; flagged, not assumed)

1. **Challenge timing at manifest creation.** No official statement on whether Slack fires the `url_verification` challenge during Create-from-manifest, only for console-typed URLs. Mitigated: server+tunnel-first ordering plus an explicit post-creation "Verified / Retry" checkpoint makes the walkthrough correct under either behavior.
2. **Whether `features.assistant_view` in a pasted manifest auto-enables the console "Agents & AI Apps" toggle.** The field is documented and shipped in Slack's own template, but the toggle interaction is not documented. Mitigated: step 5's checkpoint tells the user to confirm the toggle.
3. **Exact icon-upload widget label.** "Basic Information → Display Information → App icon" is standard practice but I found no current docs page quoting the widget label verbatim. Verify once on a real app and adjust wording if Slack has relabeled it.
4. **`slackapi/manifest-schema` staleness.** The published JSON schema lacks `assistant_view`/`app_home`; the `$schema` line in our manifest may flag valid fields as unknown in strict editors. Kept for affordance; drop it if it confuses.
5. **`message.app_home` event subscription.** Kept because `docs/play-slack.md` and the channel code depend on it; it is a real Events API type (https://docs.slack.dev/reference/events/message.app_home) but is absent from Slack's assistant template, so confirm the from-manifest validator accepts it (expected) on first real creation.
6. **`trycloudflare.com` ephemeral hostnames.** Behavior (new host per run) is well known but not re-verified against current Cloudflare docs; the troubleshooting entry states it as the common case.
