// Providers usable in this install. src/app.ts records every registerProvider()
// call here, and built-in catalog providers count as detected when their
// standard credential is present — per the Flue models guide they need no
// registration (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY alone
// enable them).
const appRegistered = new Set<string>();

export function recordRegisteredProvider(id: string): void {
  appRegistered.add(id);
}

interface ProviderCatalogEntry {
  id: string;
  envVars: readonly string[];
  suggestions: readonly string[];
}

export interface RuntimeModelProvider {
  id: string;
  configured: boolean;
  source: string;
  suggestions: string[];
}

const BUILTIN_ENV_PROVIDERS: readonly ProviderCatalogEntry[] = [
  {
    id: 'anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    suggestions: ['anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5'],
  },
  {
    id: 'openai',
    envVars: ['OPENAI_API_KEY'],
    suggestions: ['openai/gpt-4.1', 'openai/gpt-4.1-mini'],
  },
  {
    id: 'openrouter',
    envVars: ['OPENROUTER_API_KEY'],
    suggestions: ['openrouter/anthropic/claude-sonnet-4', 'openrouter/openai/gpt-4.1'],
  },
  {
    id: 'cloudflare-workers-ai',
    envVars: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    suggestions: ['cloudflare-workers-ai/@cf/zai-org/glm-5.2'],
  },
];

export function knownProviderIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    listRuntimeModelProviders({ env })
      .filter((provider) => provider.configured)
      .map((provider) => provider.id),
  );
}

export function listRuntimeModelProviders({
  env = process.env,
  registeredProviders = appRegistered,
}: {
  env?: NodeJS.ProcessEnv;
  registeredProviders?: ReadonlySet<string>;
} = {}): RuntimeModelProvider[] {
  const catalogById = new Map(BUILTIN_ENV_PROVIDERS.map((entry) => [entry.id, entry]));
  const ids = new Set([...catalogById.keys(), ...registeredProviders]);

  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => {
      const entry = catalogById.get(id) ?? customProviderEntry(id);
      const registered = registeredProviders.has(id);
      const envConfigured =
        entry.envVars.length > 0 && entry.envVars.every((envVar) => Boolean(env[envVar]));
      return {
        id,
        configured: registered || envConfigured,
        source: registered
          ? 'registered in src/app.ts'
          : entry.envVars.length > 0
            ? `via ${entry.envVars.join(' + ')}`
            : 'custom provider',
        suggestions: [...entry.suggestions],
      };
    });
}

function customProviderEntry(id: string): ProviderCatalogEntry {
  return {
    id,
    envVars: [],
    suggestions: [`${id}/admin-agent`],
  };
}
