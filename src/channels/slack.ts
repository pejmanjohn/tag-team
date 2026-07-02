// flue-blueprint: channel/slack@1
import { createSlackChannel } from '@flue/slack';
import { WebClient } from '@slack/web-api';

import { AgentStore, AssignmentStore, resolveAssignment } from '../config/resolver.ts';
import { InMemoryClaimStore, type SlackClaimStore } from '../slack/claim-store.ts';
import { slackThreadKey } from '../slack/thread-key.ts';
import { normalizeSlackTurn } from '../slack/turn-normalization.ts';
import type { NormalizedSlackTurn, SlackEventFixture } from '../slack/types.ts';

/**
 * Lazily-constructed outbound Slack client. Reading env at first use (not module
 * load) lets the offline verification point `slackApiUrl` at a fake Slack, and
 * keeps the cloudflare build from binding a token at import time. The v8 client
 * appends the method to `slackApiUrl`, which must end with `/` (it self-corrects
 * if not).
 */
let cachedClient: WebClient | undefined;
export function getClient(): WebClient {
  if (!cachedClient) {
    const slackApiUrl = process.env.SLACK_API_URL;
    cachedClient = new WebClient(
      process.env.SLACK_BOT_TOKEN,
      slackApiUrl ? { slackApiUrl } : {},
    );
  }
  return cachedClient;
}

const stores = {
  agents: new AgentStore(),
  assignments: new AssignmentStore(),
};

const claimStore: SlackClaimStore = new InMemoryClaimStore();

// Bot user id resolution: prefer the configured env, otherwise resolve once via
// auth.test() and cache. On failure leave it undefined so message-family events
// fail closed in normalization (matching the hand-rolled lane).
let botUserId: string | undefined;
let botUserIdResolved = false;
async function resolveBotUserId(): Promise<string | undefined> {
  if (process.env.SLACK_BOT_USER_ID) {
    return process.env.SLACK_BOT_USER_ID;
  }
  if (botUserIdResolved) {
    return botUserId;
  }
  botUserIdResolved = true;
  try {
    const auth = await getClient().auth.test();
    botUserId = typeof auth.user_id === 'string' ? auth.user_id : undefined;
  } catch {
    botUserId = undefined;
  }
  return botUserId;
}

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,

  // Path: /channels/slack/events
  async events({ c, payload }) {
    // a. Admission: only Events API callbacks; ack Assistant lifecycle events.
    if (payload.type !== 'event_callback') return;
    const eventType = payload.event.type;
    if (
      eventType === 'assistant_thread_started' ||
      eventType === 'assistant_thread_context_changed'
    ) {
      return;
    }

    // b. Normalize with the shared admission policy (imported verbatim).
    const resolvedBotUserId = await resolveBotUserId();
    const normalization = normalizeSlackTurn(
      payload as unknown as SlackEventFixture,
      resolvedBotUserId ? { botUserId: resolvedBotUserId } : {},
    );
    if (normalization.status !== 'runnable') return;
    const turn = normalization.turn;

    // c. Claim BOTH the event id and the (channel, message-ts) so the
    //    app_mention + message fan-out for a single mention replies once.
    const evtKey = `evt:${payload.event_id}`;
    const msgKey = `msg:${turn.channelId}:${turn.messageTs}`;
    if (!claimStore.claim(evtKey)) return;
    if (!claimStore.claim(msgKey)) {
      claimStore.release(evtKey);
      return;
    }

    // d. Gate on an enabled assignment (fail closed if unassigned).
    try {
      resolveAssignment(turn.workspaceId, turn.channelId, stores);
    } catch (err) {
      claimStore.release(evtKey);
      claimStore.release(msgKey);
      console.error('[slack-flue] no assignment for turn:', sanitizeError(err));
      return;
    }

    // e. Capture the self-origin BEFORE detaching, then run the turn as a
    //    detached promise so the events callback returns a fast 200.
    const selfBaseUrl = process.env.FLUE_SELF_URL ?? new URL(c.req.url).origin;
    void runTurn(turn, selfBaseUrl).catch((err) => {
      // Release on failure so a Slack retry can re-drive the turn.
      claimStore.release(evtKey);
      claimStore.release(msgKey);
      console.error('[slack-flue] turn failed:', sanitizeError(err));
    });
  },
});

/**
 * Minimal turn: prompt the durable agent over the app's own HTTP API and block
 * for the terminal result, then deliver it to the thread with a plain
 * `chat.postMessage`. Rich status/stream presentation is Task 2b.
 */
async function runTurn(turn: NormalizedSlackTurn, selfBaseUrl: string): Promise<void> {
  const conversationKey = slackThreadKey(turn);
  const url =
    `${selfBaseUrl.replace(/\/$/, '')}` +
    `/agents/slack-thread/${encodeURIComponent(conversationKey)}?wait=result`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: turn.text }),
  });
  if (!response.ok) {
    throw new Error(`agent prompt failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as { result?: unknown };
  const text = extractResultText(body.result);
  if (!text) {
    throw new Error('agent prompt returned no result text');
  }

  await getClient().chat.postMessage({
    channel: turn.channelId,
    thread_ts: turn.threadTs,
    text,
  });
}

function extractResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.data === 'string') return record.data;
  }
  return '';
}

function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
