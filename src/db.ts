import { sqlite } from '@flue/runtime/node';

// File-backed persistence for the Flue lane (Stage 4). The default Node
// persistence is an in-memory SQLite DB that is lost on process exit, so a
// Slack redelivery after a restart would re-run a turn and lose the thread's
// conversation history. A file-backed adapter makes the agent's conversation
// transcript survive restarts, so a second turn in the same thread replays the
// prior turn from durable storage. (Dedupe claims, joined-thread registry, and
// per-thread config snapshots live in a sibling SQLite file — see
// SqliteSlackStateStore in src/slack/claim-store.ts and SLACK_STATE_DB_PATH.)
//
// The path defaults to `./tmp/flue.db` (tmp/ is git-ignored). Override with
// TAG_DB_PATH — parity/offline harnesses pass `:memory:` for per-process
// isolation. NOTE: db.ts is only supported on the Node build target; the
// Cloudflare target uses Durable Object SQLite automatically and rejects it,
// which is why flue.config.ts and `flue:build` target Node.
export default sqlite(process.env.TAG_DB_PATH ?? './tmp/flue.db');
