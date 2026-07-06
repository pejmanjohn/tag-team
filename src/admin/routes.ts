import { createHash } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import * as v from 'valibot';

import { renderAdminPage } from './page.ts';
import {
  computeSnapshotHash,
  resolveEffectiveSlackConfig,
  type EffectiveSlackConfig,
} from '../config/effective-config.ts';
import {
  AgentExistsError,
  AgentStillAssignedError,
  ModelResolutionError,
  NoAssignmentError,
  UnknownAgentError,
} from '../config/errors.ts';
import { resolveAgentModel, type ModelResolvableAgent } from '../config/model-policy.ts';
import { knownProviderIds, listRuntimeModelProviders } from '../config/providers.ts';
import { SEED_DEFAULT_MODELS } from '../config/seed.ts';
import { getConfigStore, type SqliteConfigStore } from '../config/store.ts';
import type { ChannelAssignment, CustomAgentConfig } from '../config/types.ts';
import { constantTimeEquals } from '../slack/internal-auth.ts';

interface AdminRoutesOptions {
  store?: SqliteConfigStore | undefined;
  adminToken?: string | undefined;
  knownProviders?: ReadonlySet<string> | undefined;
}

const ADMIN_COOKIE = 'flue_admin';

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const modelSpecifier = v.pipe(v.string(), v.regex(/^[^/]+\/.+$/));

const defaultModelsSchema = v.object({
  claude: nonEmptyString,
  'workers-ai': nonEmptyString,
});

const agentSchema = v.object({
  id: nonEmptyString,
  name: nonEmptyString,
  description: v.string(),
  instructions: nonEmptyString,
  enabled: v.boolean(),
  model: v.optional(modelSpecifier),
  defaultModels: defaultModelsSchema,
  allowedTools: v.array(v.string()),
});

const agentPatchSchema = v.partial(
  v.object({
    name: nonEmptyString,
    description: v.string(),
    instructions: nonEmptyString,
    enabled: v.boolean(),
    model: v.nullable(modelSpecifier),
    defaultModels: defaultModelsSchema,
    allowedTools: v.array(v.string()),
  }),
);

const assignmentSchema = v.object({
  workspaceId: nonEmptyString,
  channelId: nonEmptyString,
  agentId: nonEmptyString,
  enabled: v.boolean(),
  channelLabel: v.optional(v.string()),
  channelPromptAddendum: v.optional(v.string()),
});

export function createAdminRoutes(options: AdminRoutesOptions = {}): Hono {
  const app = new Hono();
  const tokenFromOptions = Object.hasOwn(options, 'adminToken');
  const store = () => options.store ?? getConfigStore();
  const adminToken = () =>
    tokenFromOptions ? options.adminToken : process.env.TAG_ADMIN_TOKEN;
  const modelProviders = () =>
    options.knownProviders
      ? listRuntimeModelProviders({ registeredProviders: options.knownProviders })
      : listRuntimeModelProviders();
  const providerIds = () => options.knownProviders ?? knownProviderIds();

  const adminGate = async (c: Context, next: Next) => {
    const expected = adminToken();
    if (!expected) {
      return c.notFound();
    }

    // The cookie carries a hash of the token, never the token itself: a captured
    // cookie can't be replayed as a Bearer credential and doesn't reveal
    // TAG_ADMIN_TOKEN. Bearer/query still send the raw token (standard), but the
    // long-lived browser credential is the derived value.
    const cookieValue = cookieTokenFor(expected);

    const queryToken = c.req.query('token');
    if (constantTimeEquals(queryToken, expected)) {
      setCookie(c, ADMIN_COOKIE, cookieValue, {
        path: '/admin',
        httpOnly: true,
        sameSite: 'Lax',
        // Send only over TLS when the request arrived over TLS; on plain-http
        // dev there is no transport to protect, so forcing Secure would just
        // drop the cookie and break login.
        secure: isHttps(c),
      });
      // Strip ?token= from the URL so the secret does not linger in the address
      // bar, browser history, or proxy access logs, and is not a standing query
      // credential. Only redirect the page GET; API callers using ?token get the
      // cookie set and proceed (they have no address bar to leak into).
      if (c.req.method === 'GET' && new URL(c.req.url).pathname === '/admin') {
        return c.redirect('/admin', 303);
      }
      return next();
    }

    const candidate = bearerToken(c.req.header('authorization'));
    if (candidate !== undefined) {
      if (!constantTimeEquals(candidate, expected)) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      return next();
    }

    if (!constantTimeEquals(getCookie(c, ADMIN_COOKIE), cookieValue)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };

  app.use('/admin', adminGate);
  app.use('/admin/*', adminGate);

  app.get('/admin', (c) => c.html(renderAdminPage()));

  app.get('/admin/api/agents', (c) => c.json({ agents: store().listAgents() }));

  app.get('/admin/api/models', (c) =>
    c.json({
      automatic: { label: 'Automatic (provider default)', value: null },
      providers: modelProviders(),
      defaultModels: SEED_DEFAULT_MODELS,
    }),
  );

  app.post('/admin/api/agents', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(agentSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const agent = toAgentConfig(parsed.output);
    if (!isModelResolvable(agent)) {
      return c.json({ error: 'model_not_resolvable' }, 422);
    }
    try {
      const configStore = store();
      return c.json(
        { agent: configStore.createAgent(agent), ...providerWarnings(agent.model, providerIds()) },
        201,
      );
    } catch (err) {
      if (err instanceof AgentExistsError) {
        return c.json({ error: 'agent_exists' }, 409);
      }
      return internalError(c, err);
    }
  });

  app.get('/admin/api/agents/:id', (c) => {
    try {
      return c.json({ agent: store().getAgent(c.req.param('id')) });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, err);
    }
  });

  app.patch('/admin/api/agents/:id', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(agentPatchSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    try {
      const configStore = store();
      const agentId = c.req.param('id');
      const current = configStore.getAgent(agentId);
      const patch = toAgentPatch(parsed.output);
      const next: ModelResolvableAgent = {
        ...current,
        ...patch,
        id: agentId,
        defaultModels: patch.defaultModels ?? current.defaultModels,
      };
      if (!isModelResolvable(next)) {
        return c.json({ error: 'model_not_resolvable' }, 422);
      }
      return c.json({
        agent: configStore.updateAgent(agentId, patch),
        ...providerWarnings(next.model, providerIds()),
      });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, err);
    }
  });

  app.delete('/admin/api/agents/:id', (c) => {
    const configStore = store();
    const agentId = c.req.param('id');
    const references = configStore.listAssignmentsForAgent(agentId);
    if (references.length > 0) {
      return c.json(
        {
          error: 'agent_still_assigned',
          assignments: references.map(({ workspaceId, channelId }) => ({ workspaceId, channelId })),
        },
        409,
      );
    }
    try {
      const deleted = configStore.deleteAgent(agentId);
      return deleted ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
    } catch (err) {
      if (err instanceof AgentStillAssignedError) {
        return c.json({ error: 'agent_still_assigned' }, 409);
      }
      return internalError(c, err);
    }
  });

  app.get('/admin/api/assignments', (c) => {
    if (!c.req.query('workspaceId') && !c.req.query('channelId')) {
      return c.json({ assignments: store().listAssignments() });
    }
    const key = assignmentKey(c);
    if (!key) {
      return invalidRequest(c);
    }
    const assignment = store().getAssignment(key.workspaceId, key.channelId);
    return assignment ? c.json({ assignment }) : c.json({ error: 'not_found' }, 404);
  });

  app.put('/admin/api/assignments', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(assignmentSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    try {
      return c.json({ assignment: store().putAssignment(toAssignment(parsed.output)) });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'unknown_agent' }, 404);
      }
      return internalError(c, err);
    }
  });

  app.delete('/admin/api/assignments', (c) => {
    const key = assignmentKey(c);
    if (!key) {
      return invalidRequest(c);
    }
    const deleted = store().deleteAssignment(key.workspaceId, key.channelId);
    return deleted ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  app.get('/admin/api/effective-config', (c) => {
    const key = assignmentKey(c);
    if (!key) {
      return invalidRequest(c);
    }
    try {
      const configStore = store();
      return c.json({
        config: effectiveConfigResponse(
          resolveEffectiveSlackConfig(key.workspaceId, key.channelId, {
            agents: configStore,
            assignments: configStore,
          }),
        ),
      });
    } catch (err) {
      if (err instanceof NoAssignmentError || err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      if (err instanceof ModelResolutionError) {
        return c.json({ error: 'model_not_resolvable' }, 422);
      }
      return internalError(c, err);
    }
  });

  return app;
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer (.+)$/);
  return match?.[1];
}

// Cookie value = a hash of the admin token, so the cookie is not itself the
// admin credential (can't be sent as a Bearer, doesn't leak TAG_ADMIN_TOKEN).
function cookieTokenFor(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isHttps(c: Context): boolean {
  const forwarded = c.req.header('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]?.trim() === 'https';
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

function toAgentConfig(input: v.InferOutput<typeof agentSchema>): CustomAgentConfig {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    enabled: input.enabled,
    ...(input.model !== undefined ? { model: input.model } : {}),
    defaultModels: input.defaultModels,
    allowedTools: input.allowedTools,
  };
}

type AgentPatch = Partial<Omit<CustomAgentConfig, 'id' | 'model'>> & { model?: string | null };

function toAgentPatch(input: v.InferOutput<typeof agentPatchSchema>): AgentPatch {
  const patch: AgentPatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.instructions !== undefined) patch.instructions = input.instructions;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.model !== undefined) patch.model = input.model;
  if (input.defaultModels !== undefined) patch.defaultModels = input.defaultModels;
  if (input.allowedTools !== undefined) patch.allowedTools = input.allowedTools;
  return patch;
}

function toAssignment(input: v.InferOutput<typeof assignmentSchema>): ChannelAssignment {
  return {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    agentId: input.agentId,
    enabled: input.enabled,
    ...(input.channelLabel !== undefined ? { channelLabel: input.channelLabel } : {}),
    ...(input.channelPromptAddendum !== undefined
      ? { channelPromptAddendum: input.channelPromptAddendum }
      : {}),
  };
}

function isModelResolvable(agent: ModelResolvableAgent): boolean {
  try {
    resolveAgentModel(agent);
    return true;
  } catch {
    return false;
  }
}

async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function assignmentKey(c: { req: { query(name: string): string | undefined } }):
  | { workspaceId: string; channelId: string }
  | undefined {
  const workspaceId = c.req.query('workspaceId');
  const channelId = c.req.query('channelId');
  if (!workspaceId || !channelId) {
    return undefined;
  }
  return { workspaceId, channelId };
}

function invalidRequest(c: { json(body: { error: string }, status: 400): Response }): Response {
  return c.json({ error: 'invalid_request' }, 400);
}

// Free text accepts any provider/model specifier (locked model-picker
// decision: warn, never block — the registry approximates Flue/Pi's real
// provider surface, so an unknown prefix may still work at runtime). A warning
// on the success body keeps the pre-check honest without false blocking. An
// empty registry means "unknown environment" (route module used without
// src/app.ts registrations, e.g. unit tests) — no warning either way.
function providerWarnings(
  model: string | null | undefined,
  known: ReadonlySet<string>,
): { warnings?: Array<{ code: string; provider: string; knownProviders: string[] }> } {
  if (!model || known.size === 0) return {};
  const prefix = model.slice(0, model.indexOf('/'));
  if (known.has(prefix)) return {};
  return {
    warnings: [{ code: 'unknown_provider', provider: prefix, knownProviders: [...known].sort() }],
  };
}

// Never echo internal error text (raw SQLite messages) to API clients; log it
// server-side and return a stable retriable status instead.
function internalError(
  c: { json(body: { error: string }, status: 500): Response },
  err: unknown,
): Response {
  console.error('[tag-team] admin API failure:', err instanceof Error ? err.message : String(err));
  return c.json({ error: 'internal_error' }, 500);
}

function effectiveConfigResponse(config: EffectiveSlackConfig): object {
  return {
    workspaceId: config.workspaceId,
    channelId: config.channelId,
    agentId: config.agentId,
    profile: {
      id: config.agent.id,
      name: config.agent.name,
      description: config.agent.description,
      enabled: config.agent.enabled,
    },
    model: config.model,
    provider: config.provider,
    allowedTools: config.allowedTools,
    instructions: config.instructions,
    instructionLayers: config.instructionLayers,
    snapshotHash: computeSnapshotHash(config),
  };
}
