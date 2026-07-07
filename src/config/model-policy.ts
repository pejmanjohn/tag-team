import { ModelResolutionError } from './errors.ts';
import { isCloudflareTarget } from './runtime-target.ts';
import type { CustomAgentConfig } from './types.ts';

// Accepts `model: null` alongside the stored shape so admin PATCH previews
// (where null means "clear the pin") can be checked without re-shaping.
export type ModelResolvableAgent = Pick<CustomAgentConfig, 'id' | 'defaultModels'> & {
  model?: string | null;
};

export function resolveAgentModel(
  agent: ModelResolvableAgent,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (agent.model) {
    return agent.model;
  }
  if (env.ANTHROPIC_API_KEY) {
    return withProviderPrefix('anthropic', agent.defaultModels.claude);
  }
  // The stored workers-ai default is target-neutral (a bare `@cf/...` model
  // id); the provider prefix is decided HERE, at resolution time. On the
  // Cloudflare target it resolves via Flue's binding-backed `cloudflare`
  // provider, which needs no credentials at all — this is what makes a
  // keyless button deploy able to run a turn. On node the same default needs
  // the REST provider (`cloudflare-workers-ai`, registered in src/app.ts) and
  // its API token/account pair.
  if (isCloudflareTarget()) {
    return withProviderPrefix('cloudflare', agent.defaultModels['workers-ai']);
  }
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
    return withProviderPrefix('cloudflare-workers-ai', agent.defaultModels['workers-ai']);
  }
  const fallbackModel = env.SLACK_TAG_MODEL;
  if (fallbackModel) {
    return fallbackModel;
  }
  throw new ModelResolutionError(
    `No model configured for agent ${agent.id}. Set agent.model, ANTHROPIC_API_KEY, ` +
      'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or SLACK_TAG_MODEL.',
  );
}

function withProviderPrefix(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}
