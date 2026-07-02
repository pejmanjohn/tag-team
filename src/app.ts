import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

// Provider registrations run at module scope so they are in place before any
// agent resolves its model. Registering `cloudflare-workers-ai` is REQUIRED:
// the seeded model id `@cf/zai-org/glm-5.2` is not in Flue's catalog and only
// resolves once the provider id is registered.
const workersAiBaseUrl =
  process.env.CLOUDFLARE_WORKERS_AI_BASE_URL ??
  `https://api.cloudflare.com/client/v4/accounts/${
    process.env.CLOUDFLARE_ACCOUNT_ID ?? '{CLOUDFLARE_ACCOUNT_ID}'
  }/ai/v1`;

registerProvider('cloudflare-workers-ai', {
  baseUrl: workersAiBaseUrl,
  ...(process.env.CLOUDFLARE_API_TOKEN ? { apiKey: process.env.CLOUDFLARE_API_TOKEN } : {}),
});

// The catalog `anthropic` provider works from ANTHROPIC_API_KEY alone; only
// override it when an explicit base URL is configured.
if (process.env.ANTHROPIC_BASE_URL) {
  registerProvider('anthropic', {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
  });
}

// Offline / local stub provider speaking the OpenAI-completions wire protocol.
// Enables `SLACK_FLUE_MODEL=local-stub/<model>` against a fake provider.
if (process.env.LOCAL_STUB_URL) {
  registerProvider('local-stub', {
    api: 'openai-completions',
    baseUrl: process.env.LOCAL_STUB_URL,
    // The OpenAI-completions client requires a non-empty key even offline; the
    // fake provider ignores it.
    apiKey: process.env.LOCAL_STUB_API_KEY ?? 'offline-stub-key',
  });
}

const app = new Hono();
app.route('/', flue());

export default app;
