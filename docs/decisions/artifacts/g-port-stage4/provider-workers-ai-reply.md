# Provider reply — cloudflare-workers-ai (STUB)

- **Provenance:** STUB. The harness points `CLOUDFLARE_WORKERS_AI_BASE_URL`
  at a local fake OpenAI-compatible endpoint and uses a dummy token that
  the fake ignores. No external Cloudflare call is expected during this
  offline check.
- **Model:** `cloudflare-workers-ai/@cf/zai-org/glm-5.2` (via `SLACK_FLUE_MODEL`).
- **Provider wire protocol:** `POST <base>/v1/chat/completions` streaming SSE
  (OpenAI chat.completion.chunk deltas). Wire methods observed: `chat/completions`.
- **Routing:** the SAME `app-mention.json` fixture, answered through the Flue
  lane by swapping only `SLACK_FLUE_MODEL`.

## Reply delivered on the Slack wire

```
WORKERS_AI_STUB_REPLY::glm-5.2::exec-priorities-ack
```
