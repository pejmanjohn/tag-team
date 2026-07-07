// flue-blueprint: channel/slack@1
import {
  createSlackChannel,
  type SlackChannel,
  type SlackChannelOptions,
} from '@flue/slack';
import { WebClient } from '@slack/web-api';

import { resolveEffectiveSlackConfig } from '../config/effective-config.ts';
import { ModelResolutionError, NoAssignmentError } from '../config/errors.ts';
import { resolveAgentModel } from '../config/model-policy.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { resolveAssignment, type AssignmentSurface } from '../config/resolver.ts';
import { getOrCreateSnapshot } from '../config/snapshot-store.ts';
import { resolveStores, type AppStores, type PlatformEnv } from '../config/state-backend.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import { promptSlackThreadAgent } from '../slack/agent-dispatch.ts';
import type { SlackClaimStore } from '../slack/claim-store.ts';
import { resolveSlackCredentials } from '../slack/credentials.ts';
import {
  renderChannelOnboarding,
  renderUnassignedChannelHint,
} from '../slack/message-format.ts';
import type { SlackStatusUpdate } from '../slack/replies.ts';
import { registerSlackStatusTurn } from '../slack/status-registry.ts';
import { slackThreadKey } from '../slack/thread-key.ts';
import type { SlackTurnContext } from '../slack/thread-context.ts';
import { normalizeSlackTurn } from '../slack/turn-normalization.ts';
import {
  isSlackMemberJoinedChannelEvent,
  type NormalizedSlackTurn,
  type SlackEventFixture,
} from '../slack/types.ts';
import {
  assembleSlackPrompt,
  hydrateSlackContextViaWebClient,
} from '../slack/web-client-context.ts';
import { PROVIDER_FAILURE_TEXT, WebClientPresenter } from '../slack/web-client-presenter.ts';

/**
 * Run `task` past the events ack. On Cloudflare the response completing would
 * otherwise cancel in-flight work, so register it on the platform's
 * ExecutionContext (`waitUntil` keeps the isolate alive — hard platform cap:
 * ~30s after the response). On node Hono's `executionCtx` getter THROWS
 * (there is no ExecutionContext); a floating promise already outlives the
 * response there, so the catch arm is the whole node implementation.
 * Callers attach their own `.catch` before detaching — `task` must never be a
 * rejection-unhandled promise.
 *
 * Typed structurally (not hono's `Context`): `c` arrives from @flue/slack,
 * which bundles its own hono whose Context type is not assignable to the
 * app's — and `executionCtx` is the only surface this helper touches.
 */
function detach(
  c: { executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  task: Promise<unknown>,
): void {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // node: no ExecutionContext — the promise simply runs detached.
  }
}

/**
 * Lazily-constructed outbound Slack client, keyed by the RESOLVED bot token
 * (env > wizard-stored; see slack/credentials.ts). Resolving at first use (not
 * module load) lets the offline verification point `slackApiUrl` at a fake
 * Slack, keeps the cloudflare build from binding a token at import time, and
 * — because the cache is token-keyed — makes a wizard save take effect on the
 * next event instead of pinning the first-seen token for the isolate's
 * lifetime. The v8 client appends the method to `slackApiUrl`, which must end
 * with `/` (it self-corrects if not). `retryConfig` is pinned to no retries to
 * match the hand-rolled lane's raw-fetch sinks (deterministic, no 30-minute
 * backoff on a transient upstream).
 */
let cachedClient: { botToken: string | undefined; client: WebClient } | undefined;
async function getClient(env: PlatformEnv | undefined): Promise<WebClient> {
  const { botToken } = await resolveSlackCredentials(env);
  if (!cachedClient || cachedClient.botToken !== botToken) {
    const slackApiUrl = process.env.SLACK_API_URL;
    const client = new WebClient(botToken, {
      retryConfig: { retries: 0 },
      // Two measured workerd incompatibilities in the WebClient's fetch use,
      // both fixed by this wrapper and both no-ops on node:
      //   1. It stores the function and calls it as a method
      //      (`this.fetchFn(url, ...)`), so the receiver is the client
      //      instance — workerd rejects fetch invoked with any receiver other
      //      than globalThis ("Illegal invocation").
      //   2. It hardcodes `redirect: 'error'`, which workerd refuses to
      //      implement (only 'follow'/'manual' exist at the edge). Slack's API
      //      never redirects, and under 'manual' a hypothetical redirect still
      //      fails the call (3xx body isn't the JSON envelope) — same outcome
      //      as 'error', without the unsupported value.
      fetch: (input, init) => {
        const patchedInit =
          isCloudflareTarget() && init?.redirect === 'error'
            ? { ...init, redirect: 'manual' as RequestRedirect }
            : init;
        return globalThis.fetch(input, patchedInit);
      },
      ...(slackApiUrl ? { slackApiUrl } : {}),
    });
    cachedClient = { botToken, client };
  }
  return cachedClient.client;
}

// Bot user id resolution: prefer the configured value (env, then the
// wizard-stored setting — resolveSlackCredentials preserves the env
// "explicitly empty = no bot user id, do not probe" knob, S14); otherwise
// resolve once via auth.test() and cache. On auth.test failure leave it
// undefined so message-family events fail closed in normalization (matching
// the hand-rolled lane).
let probedBotUserId: string | undefined;
let botUserIdProbed = false;
async function resolveBotUserId(env: PlatformEnv | undefined): Promise<string | undefined> {
  const { botUserId } = await resolveSlackCredentials(env);
  if (botUserId !== undefined) {
    return botUserId === '' ? undefined : botUserId;
  }
  if (botUserIdProbed) {
    return probedBotUserId;
  }
  try {
    const auth = await (await getClient(env)).auth.test();
    probedBotUserId = typeof auth.user_id === 'string' ? auth.user_id : undefined;
    // Latch only on a successful call: a definitive answer (including "no
    // user_id") is cached, but a transient auth.test failure must not pin
    // the probe result to undefined for the process lifetime — the next
    // event retries.
    botUserIdProbed = true;
  } catch {
    probedBotUserId = undefined;
  }
  return probedBotUserId;
}

/**
 * The real @flue/slack channel is (re)built per RESOLVED signing secret:
 * `createSlackChannel` captures the secret at construction, but on a first-run
 * install the secret does not exist until the /admin wizard stores it — so
 * construction moves from module load (where a missing secret used to crash
 * the whole app) into the events gate below, keyed so a rotated/stored secret
 * replaces the instance instead of being ignored.
 */
let verifiedChannel: { signingSecret: string; channel: SlackChannel } | undefined;
function channelForSecret(signingSecret: string): SlackChannel {
  if (verifiedChannel?.signingSecret !== signingSecret) {
    verifiedChannel = {
      signingSecret,
      channel: createSlackChannel({ signingSecret, events: handleSlackEvents }),
    };
  }
  return verifiedChannel.channel;
}

// conversationKey/parseConversationKey are pure identity helpers, independent
// of the signing secret; serve them from whichever instance exists. The
// placeholder-keyed instance can never verify anything — its routes are not
// the ones exported below, and the events gate always resolves the real
// secret first.
function identityChannel(): SlackChannel {
  return verifiedChannel?.channel ?? channelForSecret('unconfigured-placeholder');
}

type SlackRouteHandler = SlackChannel['routes'][number]['handler'];

/**
 * Events gate: resolve the signing secret (env > wizard-stored) per request,
 * then delegate to the real channel's verification + dispatch. No secret yet
 * (first-run, wizard not completed) → a graceful 401 — Slack will retry the
 * event later and the rest of the app (notably /admin) keeps serving.
 */
const verifiedEventsHandler: SlackRouteHandler = async (c, next) => {
  const { signingSecret } = await resolveSlackCredentials(c.env as PlatformEnv | undefined);
  if (!signingSecret) {
    return c.json({ error: 'slack_not_configured' }, 401);
  }
  const route = channelForSecret(signingSecret).routes.find((r) => r.path === '/events');
  if (!route) {
    // Unreachable: createSlackChannel with an events handler always mounts
    // /events. Guarded (not asserted away) so a library change fails loudly.
    throw new Error('slack channel lost its /events route');
  }
  return route.handler(c, next);
};

export const channel: SlackChannel = {
  // Path: /channels/slack/events
  routes: [{ method: 'POST', path: '/events', handler: verifiedEventsHandler }],
  conversationKey: (ref) => identityChannel().conversationKey(ref),
  parseConversationKey: (id) => identityChannel().parseConversationKey(id),
};

const handleSlackEvents: NonNullable<SlackChannelOptions['events']> = async ({ c, payload }) => {
  // a. Admission: only Events API callbacks; ack Assistant lifecycle events.
  if (payload.type !== 'event_callback') return;
  const eventType = payload.event.type;
  if (
    eventType === 'assistant_thread_started' ||
    eventType === 'assistant_thread_context_changed'
  ) {
    return;
  }
  // Capture the platform env up front — and BEFORE anything detaches: the
  // stores, the credential resolver, and the dispatch on Cloudflare all need
  // the bindings object `c` carries, and `c` itself must not be touched after
  // the events ack returns (its request scope ends with the response). On
  // node the env is ignored everywhere it is threaded.
  const platformEnv = c.env as PlatformEnv | undefined;

  // Store resolution is per-request and target-aware: on Node the factories
  // return the process-cached SQLite stores (claims + thread registry are
  // SQLite-backed in their own file, sibling of the Flue transcript DB, so a
  // Slack redelivery right after a restart is still suppressed and joined
  // threads stay continuable); on Cloudflare they proxy the state Durable
  // Object, which is why the handler threads `c.env` through.
  const stores = resolveStores(platformEnv);

  if (eventType === 'member_joined_channel') {
    await handleMemberJoinedChannel(payload as unknown as SlackEventFixture, stores, platformEnv);
    return;
  }

  // b. Normalize with the shared admission policy (imported verbatim).
  const resolvedBotUserId = await resolveBotUserId(platformEnv);
  const normalization = normalizeSlackTurn(
    payload as unknown as SlackEventFixture,
    resolvedBotUserId ? { botUserId: resolvedBotUserId } : {},
  );
  if (normalization.status !== 'runnable') return;
  const turn = normalization.turn;
  const threadKey = slackThreadKey(turn);
  const state = stores.slackState;

  // c. Implicit thread replies require a thread this app already started (a
  //    prior mention/DM). An unknown thread key produces nothing on the wire
  //    (S13). With the file-backed state store the registry survives
  //    restarts; `:memory:` keeps the old process-local semantics. Checked
  //    before any claim so a dropped reply stays fully silent.
  if (turn.source === 'implicit_thread_reply' && !(await state.has(threadKey))) {
    return;
  }

  // c2. Direct messages / App Home are a separate surface, on by default.
  //     When SLACK_TAG_ALLOW_DMS is turned off, the bot is reachable only in
  //     channels (an org-wide direct-message opt-out). Checked before any
  //     claim so a disabled DM stays fully silent.
  const surface = turnSurface(turn);
  if (surface === 'direct' && !directMessagesEnabled()) {
    return;
  }

  // d. Claim BOTH the event id and the (channel, message-ts) so the
  //    app_mention + message fan-out for a single mention replies once.
  const evtKey = `evt:${payload.event_id}`;
  const msgKey = `msg:${turn.channelId}:${turn.messageTs}`;
  if (!(await state.claim(evtKey))) return;
  if (!(await state.claim(msgKey))) {
    await state.release(evtKey);
    return;
  }

  // e. Resolve the config for this turn — inside a try so any failure releases
  //    the claims (a Slack retry can then re-drive the turn) rather than
  //    leaking them and dropping the message.
  //    - CHANNELS freeze at the first turn: the gate resolves the effective
  //      config ONCE and writes the write-once snapshot, so the presenter and
  //      the durable agent both serve that same row (no first-turn attribution
  //      drift). A started thread is served from its snapshot even if its
  //      profile was since disabled/removed — a disable must not break an
  //      in-flight thread — and a snapshot exists only for a thread whose first
  //      turn passed this gate, so it cannot bypass fail-closed. Channels fail
  //      closed if unassigned and never fall through to the global '*,*'
  //      wildcard (see turnSurface / the resolver).
  //    - DIRECT conversations (DMs, App Home) are one continuous session, not a
  //      discrete thread, so they are NOT frozen: they resolve current config
  //      every turn, so admin edits to the DM profile reach existing DM users.
  let assignment: ResolvedAssignment;
  try {
    const store = stores.config;
    const configStores = { agents: store, assignments: store };
    assignment =
      surface === 'channel'
        ? await getOrCreateSnapshot(stores.snapshots, threadKey, () =>
            resolveEffectiveSlackConfig(turn.workspaceId, turn.channelId, configStores),
          )
        : await resolveAssignment(turn.workspaceId, turn.channelId, configStores, { surface });
  } catch (err) {
    // A model that cannot resolve is NOT fail-closed: admit with a best-effort
    // assignment so the turn still delivers the sanitized provider-failure
    // final (no snapshot is written — a misconfigured-model thread has no
    // usable config to freeze). Everything else (unassigned/disabled channel,
    // disabled DM default) is fail-closed: release the claims and stay silent.
    const store = stores.config;
    if (err instanceof ModelResolutionError) {
      assignment = await resolveAssignment(
        turn.workspaceId,
        turn.channelId,
        { agents: store, assignments: store },
        { surface },
      );
    } else {
      await state.release(evtKey);
      await state.release(msgKey);
      console.error('[tag-team] no assignment for turn:', sanitizeError(err));
      // Fail-closed with feedback: the channel stays silent, but the person
      // who explicitly mentioned the bot gets an ephemeral pointer at /admin.
      // Detached so the events ack is not delayed by the Slack Web API call.
      if (err instanceof NoAssignmentError) {
        detach(
          c,
          postUnassignedChannelHint(turn, surface, state, platformEnv).catch((hintErr) => {
            console.error('[tag-team] unassigned-channel hint failed:', sanitizeError(hintErr));
          }),
        );
      }
      return;
    }
  }

  // f. The old HTTP self-call — and the Host-derived origin trust it forced,
  //    since Slack signatures don't cover Host — is gone: the agent prompt
  //    now dispatches in-process (see slack/agent-dispatch.ts) with the
  //    platform env captured at the top of this handler, so there is no
  //    origin to spoof and no TAG_SELF_URL to configure.

  // g. Mark this thread as started so its later implicit replies are admitted
  //    (mentions and DMs both open a thread the app owns). Registered
  //    pre-turn (before runTurn) on purpose: it admits implicit replies that
  //    arrive while the root turn is still in flight, matching the old lane's
  //    session-created-before-provider-call semantics. A failed turn leaves
  //    the thread registered (only the claims are released, for retry).
  await state.start(threadKey);

  // h. Run the turn past the fast events ack — waitUntil on Cloudflare, a
  //    plain floating promise on node (see detach).
  detach(
    c,
    runTurn(turn, assignment, platformEnv).catch(async (err) => {
      // Release on a genuine delivery failure so a Slack retry can re-drive
      // the turn. A completed turn (including a delivered provider-failure
      // final) returns normally and keeps its claim, so it never re-runs.
      await state.release(evtKey);
      await state.release(msgKey);
      console.error('[tag-team] turn failed:', sanitizeError(err));
    }),
  );
};

/**
 * Full turn lifecycle for the Flue lane, at parity with the hand-rolled lane:
 *   1. set Assistant status (or post a durable progress placeholder on reject),
 *   2. hydrate the bounded Slack context per contextMode,
 *   3. prompt the durable agent in-process (slack/agent-dispatch.ts) with the
 *      trigger text + hydrated (bot-filtered) context rows,
 *   4. stream the final (fallback to a markdown post), and clear status.
 * A provider failure is delivered as the sanitized static final (no provider
 * error text ever reaches Slack) and the turn still completes.
 */
async function runTurn(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  platformEnv: PlatformEnv | undefined,
): Promise<void> {
  const client = await getClient(platformEnv);
  // A frozen assignment (from a thread snapshot) carries its model; otherwise
  // resolve it from the agent via policy.
  const resolvedModel = assignment.model ?? tryResolveAgentModel(assignment.agent);
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    agentName: assignment.agent.name,
    agentId: assignment.agent.id,
    modelLabel: resolvedModel,
    publicUrl: process.env.SLACK_TAG_PUBLIC_URL,
    userId: turn.userId,
    workspaceId: turn.workspaceId,
  });
  const conversationKey = slackThreadKey(turn);
  const statusTurn = registerSlackStatusTurn(conversationKey, presenter);

  // 1. Visible work: set status; if it is rejected, post a durable progress
  //    placeholder so the user still sees work in-flight before the final.
  try {
    const statusSet = await statusTurn.setStatus(readingThreadStatus());
    if (!statusSet) {
      await presenter.postProgress(`${assignment.agent.name} is reading the thread.`);
    }

    // 2. Hydrate bounded context (degrades to current-message-only on failure).
    const context = await hydrateSlackContextViaWebClient(client, turn);
    await statusTurn.setStatus(hydratedContextStatus(context));
    const prompt = assembleSlackPrompt(turn, context);

    // 3 + 4. Prompt the durable agent, then deliver the final — with clearStatus
    //    in a finally so a status that was actually set is cleared even if
    //    delivery throws (old-lane parity: the clear happened in a finally; keeps
    //    S03/S15/S16 green). clearStatus is a no-op when no status was set. A
    //    provider failure surfaces as a non-2xx ?wait=result envelope; we deliver
    //    the sanitized static final (no provider error text ever reaches Slack).
    // The model status is cosmetic: resolving it must never abort the turn.
    // If the model is unresolvable (misconfig), skip the status and let the
    // durable agent's own resolution fail, so the prompt's catch below still
    // delivers the sanitized provider-failure final (not silence + a Slack
    // retry loop from the claims being released on an uncaught throw).
    if (resolvedModel) {
      await statusTurn.setStatus(modelStatus(resolvedModel));
    }
    let text: string;
    try {
      text = await promptSlackThreadAgent(conversationKey, prompt, platformEnv);
    } catch (err) {
      console.error('[tag-team] provider call failed:', sanitizeError(err));
      await statusTurn.drain();
      await presenter.deliverFinal(PROVIDER_FAILURE_TEXT, 'plain_text');
      return;
    }
    await statusTurn.drain();
    await presenter.deliverFinal(text, 'markdown');
  } finally {
    // Close the status registration BEFORE clearing: a late tool_start observed
    // during the clear window is then a no-op instead of writing a fresh status
    // the turn never clears.
    statusTurn.close();
    await presenter.clearStatus();
  }
}

async function handleMemberJoinedChannel(
  payload: SlackEventFixture,
  stores: AppStores,
  platformEnv: PlatformEnv | undefined,
): Promise<void> {
  const event = payload.event;
  if (!isSlackMemberJoinedChannelEvent(event)) {
    return;
  }

  const resolvedBotUserId = await resolveBotUserId(platformEnv);
  if (!resolvedBotUserId || event.user !== resolvedBotUserId) {
    return;
  }

  // Fail-closed, exactly like every turn: only greet in a channel that has an
  // enabled assignment. The direct-message wildcard must never cause an
  // unsolicited onboarding message in a channel the bot was never configured for.
  const workspaceId = payload.team_id ?? event.team;
  if (!workspaceId) {
    return;
  }
  try {
    const store = stores.config;
    await resolveAssignment(
      workspaceId,
      event.channel,
      { agents: store, assignments: store },
      { surface: 'channel' },
    );
  } catch {
    return;
  }

  const state = stores.slackState;
  const evtKey = `evt:${payload.event_id}`;
  if (!(await state.claim(evtKey))) {
    return;
  }

  try {
    await (await getClient(platformEnv)).chat.postMessage({
      channel: event.channel,
      text: renderChannelOnboarding({
        botUserId: resolvedBotUserId,
        channelId: event.channel,
        publicUrl: process.env.SLACK_TAG_PUBLIC_URL,
      }),
    });
  } catch (err) {
    // Best-effort courtesy: log and KEEP the claim so a Slack retry cannot
    // double-post the disclosure. Never rethrow — the events route turns a
    // throw into a 500, which is exactly what makes Slack redeliver the event.
    console.error('[tag-team] channel onboarding post failed:', sanitizeError(err));
  }
}

function tryResolveAgentModel(agent: Parameters<typeof resolveAgentModel>[0]): string | undefined {
  try {
    return resolveAgentModel(agent);
  } catch {
    return undefined;
  }
}

// The turn's surface, from the normalizer's authoritative source/channel_type
// (not a channel-id prefix): a DM or App Home message ('dm_message'), and any
// im/app_home/mpim thread, is 'direct'; everything else is a channel. A group-DM
// app_mention carries no channel_type and falls through to 'channel' — the
// fail-closed default (see surfaceForChannelId for the id ambiguity).
function turnSurface(turn: NormalizedSlackTurn): AssignmentSurface {
  if (turn.source === 'dm_message') {
    return 'direct';
  }
  const channelType = turn.channelType;
  if (channelType === 'im' || channelType === 'app_home' || channelType === 'mpim') {
    return 'direct';
  }
  return 'channel';
}

// Direct messages / App Home are on by default; SLACK_TAG_ALLOW_DMS=false (or
// 0/off/no) turns them off so the bot is reachable only in channels.
function envFlagDefaultOn(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

function directMessagesEnabled(): boolean {
  return envFlagDefaultOn('SLACK_TAG_ALLOW_DMS');
}

function unassignedChannelHintEnabled(): boolean {
  return envFlagDefaultOn('SLACK_TAG_UNASSIGNED_HINT');
}

// Fail-closed feedback: an EXPLICIT mention in a channel with no enabled
// assignment posts an ephemeral hint to the mentioner only — the channel gets
// nothing and ambient messages get nothing. A claim on the channel rate-limits
// the hint to one per claim-TTL window; a FAILED post releases the claim (it
// delivered nothing, so a later mention re-hinting cannot double-post). The
// whole body is fenced: this runs detached and must never throw into the
// events route, even if the claim store itself errors.
async function postUnassignedChannelHint(
  turn: NormalizedSlackTurn,
  surface: AssignmentSurface,
  state: SlackClaimStore,
  platformEnv: PlatformEnv | undefined,
): Promise<void> {
  try {
    if (surface !== 'channel' || turn.source !== 'app_mention') {
      return;
    }
    // A 'G…' id is ambiguous (legacy private channel vs group DM) and is only
    // classified as a channel to stay fail-closed for turns. The hint must not
    // treat it as a configurable channel — /admin?channel=G… would point at a
    // group DM — so hint only for unambiguous 'C…' channel ids.
    if (!turn.channelId.startsWith('C')) {
      return;
    }
    if (!unassignedChannelHintEnabled()) {
      return;
    }
    const botUserId = await resolveBotUserId(platformEnv);
    if (!botUserId) {
      return;
    }
    const hintKey = `hint:${turn.workspaceId}:${turn.channelId}`;
    if (!(await state.claim(hintKey))) {
      return;
    }
    try {
      await (await getClient(platformEnv)).chat.postEphemeral({
        channel: turn.channelId,
        user: turn.userId,
        text: renderUnassignedChannelHint({
          botUserId,
          channelId: turn.channelId,
          publicUrl: process.env.SLACK_TAG_PUBLIC_URL,
        }),
      });
    } catch (err) {
      await state.release(hintKey);
      throw err;
    }
  } catch (err) {
    console.error('[tag-team] unassigned-channel hint failed:', sanitizeError(err));
  }
}

function readingThreadStatus(): SlackStatusUpdate {
  return { text: 'is reading the thread' };
}

function hydratedContextStatus(context: SlackTurnContext): SlackStatusUpdate {
  const count = context.messages.length;
  const noun = count === 1 ? 'message' : 'messages';
  return {
    text: `is using ${count} ${noun} of ${context.mode} context`,
  };
}

function modelStatus(modelId: string): SlackStatusUpdate {
  return {
    text: `is using ${modelId}`,
  };
}

function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
