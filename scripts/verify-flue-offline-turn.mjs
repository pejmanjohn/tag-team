#!/usr/bin/env node
/**
 * Stage-2 gate: prove the Flue lane's full turn policy works completely offline
 * under `flue dev --target node` with zero external traffic. This is the fast
 * feedback loop for Task 2b; the parity suite (Stage 3) is the real gate.
 *
 * One `flue dev` process + one in-memory fake Slack/provider backend. The fake's
 * behavior knobs are reconfigured in-process between scenarios (the same knobs
 * are also exposed over `POST /__config` for the future Lane B adapter), and
 * each scenario uses a distinct event id / message ts so the process-local claim
 * store does not dedupe across scenarios.
 *
 * Checks:
 *   1. signed url_verification -> 200 + challenge echoed
 *   2. tampered signature      -> 401, no wire calls
 *   3. mention full turn       -> conversations.history (24h window), status
 *      set then cleared, ONE streamed final (startStream+stopStream) carrying
 *      the stub reply marker
 *   4. status rejected         -> a durable plain progress post precedes the
 *      final, final still delivered, no status retry storm
 *   5. provider 500            -> ONE sanitized final (verbatim failure text, no
 *      raw provider error marker), status cleared
 *   6. NET_GUARD_LOG empty     -> zero external traffic across all scenarios
 *   7. direct POST to the internal agent endpoint without the internal token
 *      -> 401 (the agent route is not reachable unauthenticated)
 *
 * Run with Node >= 22.19 (flue requirement):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH node scripts/verify-flue-offline-turn.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FLUE_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'flue');
const NET_GUARD = join(REPO_ROOT, 'scripts', 'net-guard.mjs');
const PORT = 3599;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const EVENTS_URL = `${BASE_URL}/channels/slack/events`;
const SIGNING_SECRET = 'test-signing-secret';
const EXEC_CHANNEL = 'C_EXEC';
const ROOT_THREAD_TS = '1782770400.000100';

// Load the Stage-0 fake backend (TypeScript) through tsx's runtime loader.
const { register } = await import('tsx/esm/api');
const unregister = register();
const { FakeSlackBackend, STUB_REPLY_MARKER, RAW_PROVIDER_ERROR_MARKER } = await import(
  join(REPO_ROOT, 'tests', 'parity', 'fake-slack.ts')
);
unregister();

const PROVIDER_FAILURE_TEXT =
  'I reached the Slack thread, but the model provider call failed before completion. I did not expose provider error details in Slack.';

const netGuardLog = join(mkdtempSync(join(tmpdir(), 'flue-net-guard-')), 'external-hosts.log');

const appMention = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'slack', 'app-mention.json'), 'utf8'),
);

/** Clone the base mention fixture with per-scenario overrides (fresh dedupe keys). */
function craftMention({ eventId, ts }) {
  return {
    ...appMention,
    event_id: eventId,
    event: { ...appMention.event, ts, event_ts: ts },
  };
}

function signedHeaders(rawBody, { tamper = false } = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  let digest = createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex');
  if (tamper) {
    const last = digest.at(-1);
    digest = `${digest.slice(0, -1)}${last === '0' ? '1' : '0'}`;
  }
  return {
    'content-type': 'application/json',
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': `v0=${digest}`,
  };
}

async function postSignedEvent(payload, opts = {}) {
  const rawBody = JSON.stringify(payload);
  const response = await fetch(EVENTS_URL, {
    method: 'POST',
    headers: signedHeaders(rawBody, opts),
    body: rawBody,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/** Poll the wire log until at least `minFinals` finals have landed (or timeout). */
async function waitForFinals(minFinals, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backend.finals().length >= minFinals) {
      return backend.finals();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return backend.finals();
}

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const backend = new FakeSlackBackend();
const fake = await backend.listen();
console.log(`fake Slack/provider backend listening at ${fake.url}`);

const child = spawn(FLUE_BIN, ['dev', '--target', 'node', '--port', String(PORT)], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    PATH: `/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? ''}`,
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_BOT_TOKEN: 'test-bot-token',
    SLACK_BOT_USER_ID: 'U_BOT',
    SLACK_API_URL: `${fake.url}/api/`,
    LOCAL_STUB_URL: `${fake.url}/v1`,
    SLACK_FLUE_MODEL: 'local-stub/parity-stub-1',
    NET_GUARD_LOG: netGuardLog,
    NODE_OPTIONS: `--import ${NET_GUARD}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
child.stdout.on('data', (chunk) => {
  serverOutput += chunk;
});
child.stderr.on('data', (chunk) => {
  serverOutput += chunk;
});

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`flue dev exited early (code ${child.exitCode}):\n${serverOutput}`);
    }
    try {
      // The dev server accepts requests before the in-memory runtime finishes
      // loading (503 runtime_unavailable). Ready = any non-503 HTTP response.
      const response = await fetch(`${BASE_URL}/`, { method: 'GET' });
      if (response.status !== 503) {
        return;
      }
    } catch {
      // not accepting connections yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`flue dev never became ready:\n${serverOutput}`);
}

try {
  await waitForReady();
  console.log(`flue dev ready at ${BASE_URL}`);

  // Check 1: signed url_verification echoes the challenge.
  {
    const response = await postSignedEvent({
      type: 'url_verification',
      challenge: 'offline-turn-challenge',
    });
    const passed =
      response.status === 200 &&
      typeof response.body === 'object' &&
      response.body !== null &&
      response.body.challenge === 'offline-turn-challenge';
    record(
      'url_verification signed -> 200 + challenge echoed',
      passed,
      `status=${response.status} body=${JSON.stringify(response.body)}`,
    );
  }

  // Check 2: tampered signature is rejected before the events callback.
  {
    const wireBefore = backend.wireLog.length;
    const response = await postSignedEvent(appMention, { tamper: true });
    await backend.quiesce();
    const passed = response.status === 401 && backend.wireLog.length === wireBefore;
    record(
      'tampered signature -> 401, no wire calls',
      passed,
      `status=${response.status} newWireCalls=${backend.wireLog.length - wireBefore}`,
    );
  }

  // Check 3: signed app_mention drives one full offline turn — hydration,
  // status set->clear, and a single streamed final with the stub marker.
  {
    backend.reset();
    backend.configure({ slack: { rejectSetStatus: false }, provider: { mode: 'ok' } });
    const response = await postSignedEvent(appMention);
    const finals = await waitForFinals(1, 15_000);
    const [final] = finals;

    const historyCalls = backend.callsOfMethod('conversations.history');
    const history = historyCalls[0];
    const windowSeconds = history
      ? Math.round(Number(history.body.latest) - Number(history.body.oldest))
      : -1;
    const startStreams = backend
      .callsOfMethod('chat.startStream')
      .filter((entry) => typeof entry.body.markdown_text === 'string');
    const stopStreams = backend.callsOfMethod('chat.stopStream');
    const statuses = backend.statusCalls();
    const nonEmpty = statuses.filter((entry) => String(entry.body.status) !== '');
    const lastStatus = statuses.at(-1);

    const passed =
      response.status === 200 &&
      finals.length === 1 &&
      final !== undefined &&
      final.channel === EXEC_CHANNEL &&
      final.threadTs === ROOT_THREAD_TS &&
      final.text.includes(STUB_REPLY_MARKER) &&
      historyCalls.length === 1 &&
      Number(history.body.limit) <= 50 &&
      windowSeconds === 86_400 &&
      startStreams.length === 1 &&
      stopStreams.length === 1 &&
      nonEmpty.length >= 1 &&
      lastStatus !== undefined &&
      String(lastStatus.body.status) === '';
    record(
      'mention full turn -> history(24h) + status set/clear + one streamed final',
      passed,
      `finals=${finals.length} history=${historyCalls.length} window=${windowSeconds}s ` +
        `startStream=${startStreams.length} stopStream=${stopStreams.length} ` +
        `nonEmptyStatus=${nonEmpty.length} lastStatus="${String(lastStatus?.body.status)}"`,
    );
  }

  // Check 4: status rejection falls back to a durable progress post before the
  // final and does not storm setStatus.
  {
    backend.reset();
    backend.configure({ slack: { rejectSetStatus: true }, provider: { mode: 'ok' } });
    await postSignedEvent(craftMention({ eventId: 'Ev_OFFLINE_REJECT', ts: '1782770910.000100' }));
    const finals = await waitForFinals(1, 15_000);
    const [final] = finals;

    const progressPosts = backend.progressPosts();
    const firstProgressIndex = backend.wireLog.findIndex(
      (entry) => entry.method === 'chat.postMessage' && !isMarkdownBody(entry.body),
    );
    const nonEmpty = backend
      .statusCalls()
      .filter((entry) => String(entry.body.status) !== '');

    const passed =
      finals.length === 1 &&
      final !== undefined &&
      progressPosts.length >= 1 &&
      firstProgressIndex >= 0 &&
      firstProgressIndex < final.index &&
      nonEmpty.length <= 2;
    record(
      'status rejected -> durable progress post precedes the final',
      passed,
      `finals=${finals.length} progressPosts=${progressPosts.length} ` +
        `progressIndex=${firstProgressIndex} finalIndex=${final?.index} nonEmptyStatus=${nonEmpty.length}`,
    );
  }

  // Check 5: provider 500 still delivers one sanitized final and clears status.
  // Flue retries the 5xx a few times before failing, so allow a generous poll.
  {
    backend.reset();
    backend.configure({ slack: { rejectSetStatus: false }, provider: { mode: 'http_500' } });
    await postSignedEvent(craftMention({ eventId: 'Ev_OFFLINE_500', ts: '1782770920.000100' }));
    const finals = await waitForFinals(1, 40_000);
    const [final] = finals;
    const lastStatus = backend.statusCalls().at(-1);

    const passed =
      finals.length === 1 &&
      final !== undefined &&
      final.text.includes(PROVIDER_FAILURE_TEXT) &&
      !final.text.includes(RAW_PROVIDER_ERROR_MARKER) &&
      lastStatus !== undefined &&
      String(lastStatus.body.status) === '';
    record(
      'provider 500 -> one sanitized final, status cleared, no raw error leak',
      passed,
      `finals=${finals.length} sanitized=${final?.text.includes(PROVIDER_FAILURE_TEXT)} ` +
        `rawLeak=${final?.text.includes(RAW_PROVIDER_ERROR_MARKER)} lastStatus="${String(lastStatus?.body.status)}"`,
    );
  }

  // Check 6: zero external traffic across every scenario above.
  {
    const attempted = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
    record(
      'NET_GUARD_LOG empty -> zero external traffic',
      attempted === '',
      attempted === '' ? 'no external hosts attempted' : `attempted: ${attempted}`,
    );
  }

  // Check 7: the internal agent endpoint rejects direct callers that don't
  // present the internal token (the channel's self-call is signature-verified
  // upstream on /channels/slack/events; this endpoint has no other gate).
  {
    const response = await fetch(`${BASE_URL}/agents/slack-thread/some-id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'unauthenticated probe' }),
    });
    const text = await response.text();
    record(
      'unauthenticated POST /agents/slack-thread/:id -> 401',
      response.status === 401,
      `status=${response.status} body=${text}`,
    );
  }
} catch (error) {
  record('verification harness', false, error instanceof Error ? error.message : String(error));
} finally {
  child.kill('SIGKILL');
  await backend.close();
}

/** A markdown chat.postMessage carries at least one block; a plain progress post does not. */
function isMarkdownBody(body) {
  return Array.isArray(body.blocks) && body.blocks.length > 0;
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
