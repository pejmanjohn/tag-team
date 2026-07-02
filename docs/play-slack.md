# Play With Slack Flue

This is the smallest real Slack loop, driven by the Flue lane with `flue dev --target node`. The agent's provider and model come from `SLACK_FLUE_MODEL` (default: the seeded Cloudflare Workers AI model under the registered `cloudflare-workers-ai` provider). For offline runs, point it at a local stub with `LOCAL_STUB_URL` and `SLACK_FLUE_MODEL=local-stub/<model>`.

## 1. Create a Slack app

Create a Slack app at `https://api.slack.com/apps`.

Add bot scopes:

- `app_mentions:read`
- `chat:write`
- `assistant:write`
- `channels:history` (new for public-channel thread continuation and explicit top-level mention context)
- `im:history` (new for direct-message replies and DM thread context)

Enable Slack's Agents & AI Apps surface for the app when the workspace allows it. This makes Slack eligible to render Assistant status, working indicators, and message streams. Slack-owned visual chrome such as the purple app-name flash is not directly configurable by this codebase; verify the actual rendering in the Slack client after the app is configured.

Enable App Home messages for DM playtests:

- turn on the App Home Messages tab;
- allow users to send messages to the app.

In the manifest this is `features.app_home.messages_tab_enabled: true` and `features.app_home.messages_tab_read_only_enabled: false`. If the Slack DM composer says "Sending messages to this app has been turned off", this setting is missing or stale.

Install the app to the workspace, then copy:

- Signing Secret
- Bot User OAuth Token

## 2. Run the local server

```bash
export SLACK_SIGNING_SECRET="..."
export SLACK_BOT_TOKEN="<bot-token>"
export SLACK_BOT_USER_ID="U..." # optional; resolved via Slack auth.test if omitted
# Default provider: the seeded Cloudflare Workers AI model.
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
# Or override the agent model directly, for example:
# export SLACK_FLUE_MODEL="anthropic/claude-haiku-4-5"
# export ANTHROPIC_API_KEY="..."
flue dev --target node --port 8789
```

`flue dev` is a long-running watch-mode dev server (default port 3583; `--port` overrides). It loads `.env` from the project root by default; pass `--env <path>` to select another env file, and shell-exported values always win. See the full env-var table in `README.md`.

The server exposes:

- `POST /channels/slack/events` — the Slack Events endpoint.
- `POST /agents/slack-thread/:id` — the durable agent, gated by the shared internal token (`FLUE_AGENT_API_TOKEN`); the channel makes this self-call, you do not call it directly.

After verifying the request signature, the Slack channel returns a fast HTTP acknowledgement and then runs the turn (context hydration, agent prompt, final delivery) as detached work, so Slack is acknowledged before the reply is produced.

## 3. Expose it to Slack

Use a tunnel, for example:

```bash
cloudflared tunnel --url http://localhost:8789
```

Set Slack Events Request URL to:

```text
https://<your-tunnel-host>/channels/slack/events
```

Slack should verify the URL challenge.

Subscribe to bot event:

- `app_mention`
- `message.channels`
- `message.im`
- `message.app_home`
- `assistant_thread_started`
- `assistant_thread_context_changed`

The new `message.channels`, `message.im`, and `message.app_home` subscriptions require reinstalling the app after the scopes are added. Reinstall or reload Slack if the App Home Messages tab changes after the initial install. Pause for operator confirmation before changing live Slack app scopes, App Home DM settings, event subscriptions, or reinstall state.

`SLACK_BOT_USER_ID` is required before generic `message.*` events are admitted. If it is not configured, the Slack channel resolves it once on the first event via Slack `auth.test`. If that lookup fails, it falls closed: message events are still acknowledged, but runnable thread/DM turns are ignored with `missing_bot_user_id` so an app-authored Slack message cannot start a reply loop.

## 4. Try it in Slack

Invite the bot to a channel, then mention it:

```text
@Slack Flue please use channel context and draft an exec summary
```

Expected behavior:

- immediate Assistant status such as `Slack Flue Demo is checking context` where Slack renders Assistant status for the surface;
- transient safe loading/status text during approved tool work, such as channel-context gathering;
- no permanent progress lines such as `Gathering channel context` should remain in the thread after the final answer;
- streamed final reply from `Exec Research` when Slack accepts the streaming APIs;
- fallback final threaded reply when status or streaming is unavailable;
- fallback final replies use Slack `markdown` blocks, so standard Markdown like `**bold**`, links, lists, blockquotes, tables, and fenced code should render instead of appearing literally;
- duplicate Slack retries are acknowledged without duplicate posts.

Response defaults in this slice:

- Channel starts still require an explicit `@Slack Flue` mention.
- Once the bot has replied in a public channel thread during the current process lifetime, later human replies in that same Slack thread can continue the session without another mention when `SLACK_BOT_USER_ID` is configured.
- Direct messages and App Home messages respond without mention syntax when `SLACK_BOT_USER_ID` is configured.
- Top-level public-channel messages without a mention are acknowledged and ignored.
- Bot-authored messages, self messages, message subtypes such as edits/deletes, missing-user events, and empty messages are ignored before provider work.

Context defaults:

- Runnable channel-thread turns fetch active thread context with `conversations.replies`, capped to 50 human-authored messages and filtered to remove bot/system replies.
- Runnable root DM and App Home turns fetch bounded direct-conversation history with `conversations.history`; threaded DM/App Home replies fetch the active thread with `conversations.replies`.
- First-time mentions into an existing Slack thread use the same bounded thread read.
- Explicit top-level channel mentions fetch bounded same-channel history with `conversations.history`: `latest` is the mention timestamp, `limit` is 50, and `oldest` comes from a clear prompt window such as `today`, `yesterday`, `this week`, `last week`, `since Monday`, or `last 2 days`. If the prompt is vague, such as `what do you think?`, V1 uses the previous 24 hours.
- Mention-free channel-thread replies and ignored top-level non-mentions do not fetch broad channel history with `conversations.history`.

For a formatting smoke, mention the bot with a prompt like:

```text
@Slack Flue channel context formatting smoke: reply with a short heading, **bold text**, a bullet list, a link, a blockquote, inline code, a fenced code block, and a tiny markdown table.
```

The checked-in seed data is for local demo playtesting:

- app name: `Slack Flue Demo`;
- provider: `workers-ai`;
- Workers AI model: `@cf/zai-org/glm-5.2`;
- fallback assignment: `*/* -> agent_exec_research`.

For a new workspace, replace the seeded assignments and channel briefs in `src/config/seed.ts` with your own demo workspace/channel values. Do not commit private workspace IDs, private channel names, tokens, or customer-specific channel briefs to public docs. Replace the catch-all assignment before testing anything beyond a private demo workspace.

## 5. Live verification checklist

After the operator confirms and applies the new scopes/events:

- Channel start: mention the bot in the playtest channel; expect Assistant status and exactly one final thread reply.
- Public thread continuation: reply in that same thread without mentioning the bot; expect exactly one bot reply in the same thread. This only proves process-local joined-thread memory; restart-durable continuation is not claimed.
- Thread visibility: tag the bot into a thread that already has earlier human messages; ask it to summarize or refer to those messages; expect the answer to reflect bounded thread context.
- Top-level mention visibility: post several recent channel messages, then top-level mention the bot with `what do you think?`; expect the answer to use recent bounded channel context. Repeat with `last 2 days` or `since Monday` to verify prompt-derived windows.
- DM/App Home: send the bot a DM or App Home message without mention syntax; expect exactly one reply in that conversation. If the composer says sending messages is turned off, enable writable App Home messages first.
- Top-level ambient negative: post a public-channel message without mentioning the bot; expect no bot reply.
- Loop negative: after the bot replies in a thread or DM, confirm its own Slack message event does not trigger a second provider call or reply.
- Duplicate safety: replay the same signed fixture locally and confirm only the first event posts.

Rollback: remove `message.channels`, `message.im`, and `message.app_home` subscriptions, or revoke the new `channels:history` and `im:history` scopes and reinstall the app. Existing `app_mention` behavior remains the conservative channel-start path.

## Safety Notes

- Do not paste Slack tokens into chat, docs, tests, or fixtures.
- Redact Signing Secret, Bot User OAuth Token, app-level tokens, and request headers before capturing screenshots or logs.
- Pause for confirmation before enabling Agents & AI Apps, adding OAuth scopes, changing event subscriptions, or reinstalling the Slack app.
- Keep `.env` and `.dev.vars` uncommitted.
- For offline work, drive the app through a local stub provider (`LOCAL_STUB_URL` + `SLACK_FLUE_MODEL=local-stub/<model>`), as the `scripts/verify-*.mjs` evidence scripts do — no external network.
- Use a live provider (`cloudflare-workers-ai` via `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`, or `anthropic` via `ANTHROPIC_API_KEY`) only from an ignored local env file.
- If a general Cloudflare API token verifies but Workers AI returns `401 Authentication error`, the token likely lacks Workers AI run permission. For local-only smokes, `npx wrangler auth token` can provide a Wrangler auth token that works with the Workers AI REST endpoint; store it only in ignored local env files.
- Treat Slack formatting as an adapter contract: providers should emit concise standard Markdown, and `src/slack/message-format.ts` decides how to post it to Slack.
- Treat Slack history as per-turn ephemeral provider context in this prototype. Do not persist raw Slack messages beyond existing telemetry/degradation metadata.
- Treat duplicate suppression and mention-free channel-thread continuation as single-process prototype guarantees. Multi-instance or serverless-horizontal deployments need a shared store, such as a Durable Object, before those guarantees are production-grade.
