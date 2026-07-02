import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerProvider } from '@flue/runtime';
// `resolveModel` is not re-exported from the root `@flue/runtime` entry point,
// but it is a documented public subpath export (see the `"./internal"` entry
// in @flue/runtime's package.json `exports` map) — not a reach into an
// unlisted dist file. It is the only way to drive Flue's real model
// resolution from a test.
import { resolveModel } from '@flue/runtime/internal';

import slackThreadAgent from '../src/agents/slack-thread.ts';

const THREAD_KEY = 'T_DEMO:C_EXEC:1782770400.000100';

test('Flue resolves the model specifier produced by the slack-thread agent', async () => {
  // The `cloudflare-workers-ai` provider id is in Flue's model catalog, but
  // the specific seeded model id is not — so it must be registered before
  // resolution will admit it. An empty registration is enough for a catalog
  // provider id to hydrate from the catalog and admit arbitrary model-id
  // suffixes under it.
  registerProvider('cloudflare-workers-ai', {});

  const config = await slackThreadAgent.initialize({ id: THREAD_KEY, env: {} });

  assert.equal(typeof config.model, 'string');

  const resolved = resolveModel(config.model as string);

  assert.ok(resolved, 'resolveModel should return a resolved model, not throw or return nothing');
  assert.equal(resolved.provider, 'cloudflare-workers-ai');
});
