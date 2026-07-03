#!/usr/bin/env node
/**
 * Follow-up C probe: DM transcript growth.
 *
 * All DM turns share one conversation key (`workspace:channel:dm`), so with the
 * file-backed `db.ts` a DM channel is one perpetual Flue conversation. This
 * probe MEASURES (rather than code-reads) whether the provider request payload
 * grows without bound turn over turn, and whether Flue's auto-compaction can
 * bound it.
 *
 * Two phases, each a fresh built server + fresh file-backed DB + fresh fake
 * Slack backend + a recording provider stub (openai-completions SSE) that
 * logs, per request: raw body bytes, messages[] count, and total content
 * chars — and reports REALISTIC usage numbers (chars/4) so Flue's threshold
 * check sees true context growth:
 *
 *   A) As configured. `registerProvider('local-stub', ...)` in src/app.ts
 *      passes no contextWindow and the model is not in any catalog, so the
 *      resolved model has contextWindow=0 — and the runtime's shouldCompact()
 *      returns false when contextWindow <= 0. Expectation to verify: unbounded
 *      linear growth, zero compaction.
 *   B) Same app binary, plus a preload (NODE_OPTIONS --import) that re-registers
 *      the local-stub provider WITH contextWindow=20000 (last-write-wins
 *      registry; nothing in the repo is modified). Expectation to verify:
 *      threshold auto-compaction kicks in and bounds the payload.
 *
 * ~26 sequential DM turns per phase (message-im events, distinct event_id/ts,
 * same DM channel). Net-guarded: zero external traffic. No real credentials —
 * the shared harness pins fake tokens and points SLACK_API_URL/LOCAL_STUB_URL
 * at loopback stubs.
 *
 * Run with Node >= 22.19:
 *   node scripts/probe-dm-transcript.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import {
  NET_GUARD,
  REPO_ROOT,
  assertNodeVersion,
  buildNodeServer,
  delay,
  getFreePort,
  loadFake,
  postSignedEvent,
  spawnServer,
  stopChild,
  waitForFinals,
  waitForReady,
} from './lib/offline-harness.mjs';

const TURNS = Number(process.env.PROBE_TURNS ?? '26');
const PHASE_B_CONTEXT_WINDOW = Number(process.env.PROBE_CONTEXT_WINDOW ?? '20000');
const RESULTS_JSON = process.env.PROBE_RESULTS_JSON; // optional dump path

// Sized so context growth is realistic: each DM question ~640 chars, each
// assistant reply ~4000 chars (~1000 tokens) — a plausible chatty DM assistant.
const QUESTION_PAD =
  'Please compare the rollout options again and be explicit about tradeoffs. '.repeat(8) + ' ';
const REPLY_SENTENCE =
  'Here is a detailed considered answer covering rollout, risk, and Slack specifics. ';
const REPLY_FILLER = REPLY_SENTENCE.repeat(Math.ceil(4000 / REPLY_SENTENCE.length));
const SUMMARY_REPLY =
  'Compaction summary: the user asked a long series of DM questions about rollout ' +
  'tradeoffs and the assistant answered each in detail. Key facts: same DM channel, ' +
  'sequential turns, no unresolved action items. '.trim();

const { FakeSlackBackend } = await loadFake();

const dmFixture = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'slack', 'message-im.json'), 'utf8'),
);

/** Distinct event_id + ts per turn; same DM channel so one conversation key. */
function craftDmTurn(phase, i) {
  const ts = `${1782771000 + i}.000100`;
  return {
    ...dmFixture,
    event_id: `Ev_DM_PROBE_${phase}_${String(i).padStart(2, '0')}`,
    event_time: 1782771000 + i,
    event: {
      ...dmFixture.event,
      text: `DM turn ${i}: ${QUESTION_PAD}`,
      ts,
      event_ts: ts,
    },
  };
}

/** Flatten one openai-completions message to text (string, blocks, tool bits). */
function messageChars(message) {
  if (!message || typeof message !== 'object') return 0;
  let chars = 0;
  const content = message.content;
  if (typeof content === 'string') {
    chars += content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && typeof block.text === 'string') {
        chars += block.text.length;
      }
    }
  }
  if (Array.isArray(message.tool_calls)) {
    chars += JSON.stringify(message.tool_calls).length;
  }
  return chars;
}

function messageIncludes(message, needle) {
  const content = message?.content;
  if (typeof content === 'string') return content.includes(needle);
  if (Array.isArray(content)) {
    return content.some(
      (block) => typeof block?.text === 'string' && block.text.includes(needle),
    );
  }
  return false;
}

/**
 * Recording provider stub (openai-completions). Records raw request bytes,
 * messages[] count and content chars, answers over SSE (or plain JSON when
 * stream:false), and reports usage as chars/4 so threshold compaction sees
 * realistic context sizes. Compaction summarization requests (their single
 * user message wraps the transcript in <conversation> tags) get a short
 * summary reply instead of the 4000-char turn reply.
 */
async function createRecordingProvider() {
  const requests = [];
  let turnCounter = 0;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const pathname = (req.url ?? '/').split('?')[0];
      if (!pathname.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `unexpected provider path ${pathname}` }));
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        // keep {}
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const contentChars = messages.reduce((sum, m) => sum + messageChars(m), 0);
      const isSummarization = messages.some((m) => messageIncludes(m, '<conversation>'));

      let replyText;
      if (isSummarization) {
        replyText = SUMMARY_REPLY;
      } else {
        turnCounter += 1;
        replyText = `turn-reply ${turnCounter} :: ${REPLY_FILLER}`;
      }

      requests.push({
        at: Date.now(),
        bytes: raw.length,
        messageCount: messages.length,
        contentChars,
        isSummarization,
        stream: body.stream !== false,
      });

      const usage = {
        prompt_tokens: Math.ceil(contentChars / 4),
        completion_tokens: Math.ceil(replyText.length / 4),
        total_tokens: Math.ceil(contentChars / 4) + Math.ceil(replyText.length / 4),
      };

      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-dm-probe',
            object: 'chat.completion',
            created: 0,
            model: 'parity-stub-1',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: replyText },
                finish_reason: 'stop',
              },
            ],
            usage,
          }),
        );
        return;
      }

      const base = {
        id: 'chatcmpl-dm-probe',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'parity-stub-1',
      };
      const sse = [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: replyText }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { ...base, choices: [], usage },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`${sse.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Wait until the provider has seen no new requests for `idleMs` (cap `capMs`). */
async function providerQuiesce(provider, idleMs = 400, capMs = 20_000) {
  const startedAt = Date.now();
  let lastLength = provider.requests.length;
  let lastChangeAt = Date.now();
  while (Date.now() - startedAt < capMs) {
    await delay(50);
    if (provider.requests.length !== lastLength) {
      lastLength = provider.requests.length;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= idleMs) {
      return;
    }
  }
}

function dbSizes(dbPath) {
  const size = (p) => (existsSync(p) ? statSync(p).size : 0);
  return { db: size(dbPath), wal: size(`${dbPath}-wal`) };
}

/** One phase: fresh backend + provider + server + DB; drive TURNS DM turns. */
async function runPhase({ label, serverEntry, workDir, preloadPath }) {
  const backend = new FakeSlackBackend();
  const fake = await backend.listen();
  const provider = await createRecordingProvider();
  const dbPath = join(workDir, `flue-dm-probe-${label}.db`);
  const netGuardLog = join(workDir, `net-guard-${label}.log`);
  const port = await getFreePort();

  const env = {
    FLUE_DB_PATH: dbPath,
    LOCAL_STUB_URL: `${provider.url}/v1`,
  };
  // PROBE_MODEL: drive a different model id (e.g. the production
  // `cloudflare-workers-ai/@cf/zai-org/glm-5.2`) through the same recording
  // provider, to measure compaction with the metadata src/app.ts declares.
  if (process.env.PROBE_MODEL) {
    env.SLACK_FLUE_MODEL = process.env.PROBE_MODEL;
    env.CLOUDFLARE_WORKERS_AI_BASE_URL = `${provider.url}/v1`;
    env.CLOUDFLARE_API_TOKEN = 'probe-offline-key';
  }
  if (preloadPath) {
    // spawnServer sets NODE_OPTIONS to import the net-guard; keep it AND add
    // the provider-metadata preload (env merges last, so restate both).
    env.NODE_OPTIONS = `--import ${NET_GUARD} --import ${preloadPath}`;
    env.PROBE_CONTEXT_WINDOW = String(PHASE_B_CONTEXT_WINDOW);
  }

  const spawned = spawnServer({ serverEntry, port, fakeUrl: fake.url, netGuardLog, env });
  const rows = [];
  let compactionLog = [];
  let netGuardHits = '';
  try {
    await waitForReady(spawned.child, spawned.eventsUrl, spawned.getOutput);
    console.log(`\n=== phase ${label} — server ready at ${spawned.baseUrl} (db: ${dbPath}) ===`);
    console.log(
      preloadPath
        ? `    preload re-registers local-stub with contextWindow=${PHASE_B_CONTEXT_WINDOW}`
        : '    as configured: local-stub has no contextWindow metadata (resolves to 0)',
    );
    console.log('turn | req bytes | messages | content chars | prov calls (compaction) | reply | db+wal bytes');

    for (let i = 1; i <= TURNS; i += 1) {
      const before = provider.requests.length;
      const response = await postSignedEvent(spawned.eventsUrl, craftDmTurn(label, i));
      if (response.status !== 200) {
        rows.push({ turn: i, failed: `events POST -> ${response.status}` });
        break;
      }
      const finals = await waitForFinals(backend, i, 30_000);
      if (finals.length < i) {
        rows.push({ turn: i, failed: `no final (have ${finals.length})` });
        console.log(`turn ${i}: FAILED — no final delivered (server output tail below)`);
        console.log(spawned.getOutput().split('\n').slice(-15).join('\n'));
        break;
      }
      // Let post-turn work (threshold compaction summarization) land in this
      // turn's window before slicing.
      await providerQuiesce(provider);

      const turnRequests = provider.requests.slice(before);
      const main = turnRequests.find((r) => !r.isSummarization);
      const compactions = turnRequests.filter((r) => r.isSummarization).length;
      const reply = finals[i - 1]?.text ?? '';
      const db = dbSizes(dbPath);
      const row = {
        turn: i,
        requestBytes: main?.bytes ?? 0,
        messages: main?.messageCount ?? 0,
        contentChars: main?.contentChars ?? 0,
        providerCalls: turnRequests.length,
        compactionCalls: compactions,
        replyOk: reply.includes('turn-reply'),
        dbBytes: db.db,
        walBytes: db.wal,
      };
      rows.push(row);
      console.log(
        `${String(i).padStart(4)} | ${String(row.requestBytes).padStart(9)} | ${String(row.messages).padStart(8)} | ` +
          `${String(row.contentChars).padStart(13)} | ${String(row.providerCalls).padStart(10)} (${compactions})` +
          `          | ${row.replyOk ? 'ok' : 'MISSING'}   | ${db.db + db.wal}`,
      );
    }

    compactionLog = spawned
      .getOutput()
      .split('\n')
      .filter((line) => line.toLowerCase().includes('compaction'));
    netGuardHits = existsSync(netGuardLog) ? readFileSync(netGuardLog, 'utf8').trim() : '';
  } finally {
    await stopChild(spawned.child);
    await backend.close();
    await provider.close();
  }

  return { label, rows, compactionLog, netGuardHits, dbPath };
}

// ---------------------------------------------------------------------------

assertNodeVersion();
const workDir = mkdtempSync(join(ensureTmp(), 'dm-probe-'));

function ensureTmp() {
  const tmp = join(REPO_ROOT, 'tmp');
  mkdirSync(tmp, { recursive: true });
  return tmp;
}

// Phase B preload: written to the git-ignored tmp workDir (inside the repo so
// bare `@flue/runtime` resolves to the SAME module instance the built server
// imports). registerProvider is last-write-wins and re-read on every model
// resolution, so an unref'd interval keeps our metadata-carrying registration
// on top after src/app.ts's boot-time registration.
const preloadPath = join(workDir, 'preload-context-window.mjs');
writeFileSync(
  preloadPath,
  `import { registerProvider } from '@flue/runtime';
const contextWindow = Number(process.env.PROBE_CONTEXT_WINDOW ?? '20000');
const timer = setInterval(() => {
  if (!process.env.LOCAL_STUB_URL) return;
  registerProvider('local-stub', {
    api: 'openai-completions',
    baseUrl: process.env.LOCAL_STUB_URL,
    apiKey: process.env.LOCAL_STUB_API_KEY ?? 'offline-stub-key',
    contextWindow,
  });
}, 100);
timer.unref();
console.error('[dm-probe] preload active: local-stub contextWindow=' + contextWindow);
`,
);

const serverEntry = await buildNodeServer();
console.log(`built node server; node ${assertNodeVersion()}; workDir ${workDir}`);

const phaseA = await runPhase({ label: 'A', serverEntry, workDir });
// Under PROBE_MODEL the preload phase is meaningless (it re-registers
// local-stub, not the probed provider) — phase A alone is the measurement.
const phaseB = process.env.PROBE_MODEL
  ? undefined
  : await runPhase({ label: 'B', serverEntry, workDir, preloadPath });

for (const phase of [phaseA, phaseB].filter(Boolean)) {
  console.log(`\n--- phase ${phase.label} compaction log lines (${phase.compactionLog.length}) ---`);
  for (const line of phase.compactionLog.slice(0, 20)) console.log(line);
  console.log(
    `phase ${phase.label} net-guard: ${phase.netGuardHits === '' ? 'zero external traffic' : `HITS: ${phase.netGuardHits}`}`,
  );
}

if (RESULTS_JSON) {
  writeFileSync(RESULTS_JSON, JSON.stringify({ phaseA, ...(phaseB ? { phaseB } : {}) }, null, 2));
  console.log(`\nresults JSON written to ${RESULTS_JSON}`);
}

// Verdict summary: growth of the LAST 5 turns vs first 5 (per phase).
function growthSummary(rows) {
  const ok = rows.filter((r) => !r.failed);
  if (ok.length < 10) return 'insufficient data';
  const first = ok.slice(0, 5);
  const last = ok.slice(-5);
  const avg = (xs, k) => Math.round(xs.reduce((s, r) => s + r[k], 0) / xs.length);
  return (
    `avg first5 ${avg(first, 'requestBytes')}B/${avg(first, 'messages')}msg → ` +
    `avg last5 ${avg(last, 'requestBytes')}B/${avg(last, 'messages')}msg; ` +
    `compaction turns: [${ok.filter((r) => r.compactionCalls > 0).map((r) => r.turn).join(', ') || 'none'}]`
  );
}
console.log(`\nphase A (${process.env.PROBE_MODEL ?? 'as configured'}): ${growthSummary(phaseA.rows)}`);
if (phaseB) {
  console.log(`phase B (contextWindow=${PHASE_B_CONTEXT_WINDOW}): ${growthSummary(phaseB.rows)}`);
}
