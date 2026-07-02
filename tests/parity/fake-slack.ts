import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * In-memory fake Slack + fake Cloudflare Workers AI backend.
 *
 * A single core records every outbound request to a wire log and is dual-exposed:
 *   - `asFetch()` returns a `fetch`-compatible function (Lane A injects this).
 *   - `listen()` serves the SAME core over HTTP for a future HTTP-transport lane.
 *
 * Everything asserted by the scenario suite is read back from `wireLog` via the
 * behavioral helpers (`finals`, `statusCalls`, `providerCalls`, `callsOfMethod`,
 * `progressPosts`) so the suite only ever depends on wire-observable behavior.
 */

export const STUB_REPLY_MARKER = 'stub-reply::glm-parity-marker';
export const RAW_PROVIDER_ERROR_MARKER = 'raw_provider_error_marker';

export interface WireEntry {
  kind: 'slack' | 'provider';
  method: string;
  url: string;
  body: Record<string, unknown>;
}

/**
 * Internal route outcome. `body` is JSON-encoded; `rawBody` (with `contentType`)
 * is written verbatim, used for the OpenAI SSE stream.
 */
interface RouteResult {
  status: number;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
}

/**
 * One "final" answer as seen on the wire. Either a `chat.startStream`(markdown_text)
 * paired with a following `chat.stopStream`, or a final `chat.postMessage`.
 */
export interface FinalOnWire {
  channel: string;
  threadTs: string;
  text: string;
  /** The wireLog index of the call that delivered this final (lane-agnostic). */
  index: number;
}

export interface RepliesPage {
  messages: unknown[];
  next_cursor?: string;
}

export interface FakeSlackBehaviorConfig {
  rejectSetStatus?: boolean;
  rejectStartStream?: boolean;
  failStopStreamOnce?: boolean;
  repliesPages?: RepliesPage[];
  historyMessages?: unknown[];
}

export interface FakeProviderConfig {
  mode: 'ok' | 'http_500';
  replyText?: string;
}

export interface FakeSlackBackendConfig {
  slack?: FakeSlackBehaviorConfig;
  provider?: FakeProviderConfig;
}

/** Default 2-page cursor fixture copied from tests/slack-events-route.test.ts. */
export const DEFAULT_REPLIES_PAGES: RepliesPage[] = [
  {
    messages: [
      { user: 'U_ALICE', text: 'root thread topic', ts: '1782770400.000100' },
      { bot_id: 'B_OTHER', text: 'bot prior reply', ts: '1782770405.000100' },
    ],
    next_cursor: 'cursor_2',
  },
  {
    messages: [
      { user: 'U_BOB', text: 'prior thread detail', ts: '1782770406.000100' },
      { user: 'U_ALICE', text: 'continue from the prior answer', ts: '1782770410.000200' },
    ],
  },
];

/** Default channel/DM history messages (human-authored). */
export const DEFAULT_HISTORY_MESSAGES: unknown[] = [
  { user: 'U_BOB', text: 'recent channel context', ts: '1782770300.000100' },
];

export class FakeSlackBackend {
  readonly wireLog: WireEntry[] = [];

  private readonly rejectSetStatus: boolean;
  private readonly rejectStartStream: boolean;
  private readonly failStopStreamOnce: boolean;
  private readonly repliesPages: RepliesPage[];
  private readonly historyMessages: unknown[];
  private readonly providerMode: 'ok' | 'http_500';
  private readonly replyText: string;
  private readonly cursorToIndex = new Map<string, number>();

  private tsCounter = 0;
  private stopStreamCalls = 0;
  private servers: Server[] = [];

  constructor(config: FakeSlackBackendConfig = {}) {
    const slack = config.slack ?? {};
    this.rejectSetStatus = slack.rejectSetStatus ?? false;
    this.rejectStartStream = slack.rejectStartStream ?? false;
    this.failStopStreamOnce = slack.failStopStreamOnce ?? false;
    this.repliesPages = slack.repliesPages ?? DEFAULT_REPLIES_PAGES;
    this.historyMessages = slack.historyMessages ?? DEFAULT_HISTORY_MESSAGES;
    this.providerMode = config.provider?.mode ?? 'ok';
    this.replyText = config.provider?.replyText ?? STUB_REPLY_MARKER;

    this.repliesPages.forEach((page, index) => {
      if (page.next_cursor) {
        this.cursorToIndex.set(page.next_cursor, index + 1);
      }
    });
  }

  /** fetch-compatible function that routes into the shared core. */
  asFetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const bodyString = init?.body == null ? '' : String(init.body);
      const result = this.route(url, bodyString);
      if (result.rawBody !== undefined) {
        return new Response(result.rawBody, {
          status: result.status,
          headers: { 'content-type': result.contentType ?? 'text/plain' },
        });
      }
      return Response.json(result.body, { status: result.status });
    }) as typeof fetch;
  }

  /** Serve the SAME core over HTTP (for a future HTTP-transport lane). */
  async listen(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const bodyString = Buffer.concat(chunks).toString('utf8');
        const result = this.route(req.url ?? '/', bodyString);
        if (result.rawBody !== undefined) {
          res.writeHead(result.status, { 'content-type': result.contentType ?? 'text/plain' });
          res.end(result.rawBody);
        } else {
          res.writeHead(result.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result.body));
        }
      });
    });
    this.servers.push(server);

    await new Promise<void>((resolve) => server.listen(port, resolve));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    return {
      url,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    };
  }

  /** Close any HTTP servers started via listen(). */
  async close(): Promise<void> {
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    this.servers = [];
  }

  /**
   * Resolve once no new wire entries have landed for `idleMs` (cap `capMs`).
   * Lets floating async turn handlers drain before assertions run.
   */
  async quiesce(idleMs = 150, capMs = 5000): Promise<void> {
    const startedAt = Date.now();
    let lastLength = this.wireLog.length;
    let lastChangeAt = Date.now();

    while (Date.now() - startedAt < capMs) {
      await delay(25);
      if (this.wireLog.length !== lastLength) {
        lastLength = this.wireLog.length;
        lastChangeAt = Date.now();
      } else if (Date.now() - lastChangeAt >= idleMs) {
        return;
      }
    }
  }

  callsOfMethod(method: string): WireEntry[] {
    return this.wireLog.filter((entry) => entry.method === method);
  }

  statusCalls(): WireEntry[] {
    return this.callsOfMethod('assistant.threads.setStatus');
  }

  providerCalls(): WireEntry[] {
    return this.wireLog.filter((entry) => entry.kind === 'provider');
  }

  /** Progress placeholder posts (plain-text `chat.postMessage`, i.e. no markdown blocks). */
  progressPosts(): WireEntry[] {
    return this.callsOfMethod('chat.postMessage').filter((entry) => !isMarkdownPost(entry.body));
  }

  /**
   * The finals delivered on the wire. A stream final is a `chat.startStream`
   * carrying `markdown_text` paired with a subsequent `chat.stopStream`; a
   * post final is a markdown `chat.postMessage`. Progress posts are excluded.
   */
  finals(): FinalOnWire[] {
    const finals: FinalOnWire[] = [];
    const pendingStreams: Array<{ entry: WireEntry; index: number }> = [];

    this.wireLog.forEach((entry, index) => {
      if (entry.kind !== 'slack') {
        return;
      }
      if (entry.method === 'chat.startStream' && hasText(entry.body.markdown_text)) {
        pendingStreams.push({ entry, index });
      } else if (entry.method === 'chat.stopStream') {
        const start = pendingStreams.shift();
        if (start) {
          finals.push({
            channel: String(start.entry.body.channel ?? ''),
            threadTs: String(start.entry.body.thread_ts ?? ''),
            text: String(start.entry.body.markdown_text ?? ''),
            index: start.index,
          });
        }
      } else if (entry.method === 'chat.postMessage' && isMarkdownPost(entry.body)) {
        finals.push({
          channel: String(entry.body.channel ?? ''),
          threadTs: String(entry.body.thread_ts ?? ''),
          text: postText(entry.body),
          index,
        });
      }
    });

    return finals;
  }

  private route(url: string, bodyString: string): RouteResult {
    const pathname = url.startsWith('http') ? new URL(url).pathname : (url.split('?')[0] ?? url);
    const apiIndex = pathname.indexOf('/api/');
    const isSlack = apiIndex >= 0;
    // OpenAI-completions surface for the Flue `local-stub` provider. The
    // official OpenAI SDK posts to `<base>/chat/completions` and streams SSE.
    const isOpenAiCompletions = !isSlack && pathname.endsWith('/chat/completions');
    const method = isSlack
      ? pathname.slice(apiIndex + '/api/'.length)
      : isOpenAiCompletions
        ? 'chat/completions'
        : 'provider.run';
    const body = decodeWireBody(bodyString);

    this.wireLog.push({ kind: isSlack ? 'slack' : 'provider', method, url, body });

    if (!isSlack) {
      return isOpenAiCompletions ? this.openAiCompletionsResponse() : this.providerResponse();
    }
    return { status: 200, body: this.slackResponse(method, body) };
  }

  private slackResponse(method: string, body: Record<string, unknown>): Record<string, unknown> {
    switch (method) {
      case 'assistant.threads.setStatus':
        return this.rejectSetStatus ? { ok: false, error: 'missing_scope' } : { ok: true };
      case 'chat.postMessage':
        return { ok: true, ts: this.nextTs() };
      case 'chat.startStream':
        return this.rejectStartStream
          ? { ok: false, error: 'missing_scope' }
          : { ok: true, channel: body.channel, ts: this.nextTs() };
      case 'chat.stopStream':
        if (this.failStopStreamOnce && this.stopStreamCalls === 0) {
          this.stopStreamCalls += 1;
          return { ok: false, error: 'timeout' };
        }
        this.stopStreamCalls += 1;
        return { ok: true };
      case 'conversations.replies':
        return this.repliesResponse(body);
      case 'conversations.history':
        return { ok: true, messages: this.historyMessages };
      case 'auth.test':
        return { ok: true, user_id: 'U_BOT' };
      default:
        return { ok: true };
    }
  }

  private repliesResponse(body: Record<string, unknown>): Record<string, unknown> {
    const cursor = body.cursor ? String(body.cursor) : undefined;
    const index = cursor ? (this.cursorToIndex.get(cursor) ?? 0) : 0;
    const page = this.repliesPages[index] ?? { messages: [] };
    return {
      ok: true,
      messages: page.messages,
      ...(page.next_cursor ? { response_metadata: { next_cursor: page.next_cursor } } : {}),
    };
  }

  private providerResponse(): RouteResult {
    if (this.providerMode === 'http_500') {
      return {
        status: 500,
        body: {
          success: false,
          errors: [{ message: `${RAW_PROVIDER_ERROR_MARKER} upstream failure`, code: 500 }],
          result: { response: RAW_PROVIDER_ERROR_MARKER },
        },
      };
    }
    return {
      status: 200,
      body: { success: true, result: { response: this.replyText } },
    };
  }

  /**
   * OpenAI chat-completions streaming response. The Flue `local-stub` provider
   * uses the official OpenAI SDK with `stream: true`, so the reply is delivered
   * as `text/event-stream` chunks terminated by `data: [DONE]`.
   */
  private openAiCompletionsResponse(): RouteResult {
    if (this.providerMode === 'http_500') {
      return {
        status: 500,
        contentType: 'application/json',
        rawBody: JSON.stringify({
          error: {
            message: `${RAW_PROVIDER_ERROR_MARKER} upstream failure`,
            type: 'server_error',
            code: 500,
          },
        }),
      };
    }

    const base = { id: 'chatcmpl-parity', object: 'chat.completion.chunk', created: 0, model: 'parity-stub' };
    const chunks: Record<string, unknown>[] = [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: this.replyText }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    const rawBody = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
    return { status: 200, contentType: 'text/event-stream', rawBody };
  }

  private nextTs(): string {
    this.tsCounter += 1;
    return `1990000000.${String(this.tsCounter).padStart(6, '0')}`;
  }
}

export function isMarkdownPost(body: Record<string, unknown>): boolean {
  return Array.isArray(body.blocks) && body.blocks.length > 0;
}

function postText(body: Record<string, unknown>): string {
  if (Array.isArray(body.blocks) && body.blocks.length > 0) {
    const first = body.blocks[0] as { text?: unknown };
    if (first && typeof first.text === 'string') {
      return first.text;
    }
  }
  return String(body.text ?? '');
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function decodeWireBody(raw: string): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(
    Array.from(new URLSearchParams(raw).entries()).map(([key, value]) => [
      key,
      coerceFormValue(value),
    ]),
  );
}

function coerceFormValue(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
