# Provider reply — anthropic (STUB)

- **Provenance:** STUB. The harness points `ANTHROPIC_BASE_URL` at a
  local fake provider endpoint and uses a dummy SDK key that the fake ignores.
  No external Anthropic call is expected during this offline check.
- **Model:** `anthropic/claude-haiku-4-5` (via `SLACK_FLUE_MODEL`).
- **Provider wire protocol:** `POST <base>/v1/messages` streaming SSE
  (`message_start` → `content_block_delta` → `message_stop`). Wire methods observed: `messages`.
- **Routing:** the SAME `app-mention.json` fixture, answered through the Flue
  lane by swapping only `SLACK_FLUE_MODEL`.

## Reply delivered on the Slack wire

```
ANTHROPIC_STUB_REPLY::haiku-4-5::exec-priorities-ack
```
