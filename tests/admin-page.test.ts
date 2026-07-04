import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';

import { renderAdminPage } from '../src/admin/page.ts';

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

interface FakeElement {
  innerHTML: string;
}

interface FakeTarget {
  closest(selector: string): FakeTarget | null;
  getAttribute(name: string): string | null;
}

type Listener = (event: { target: FakeTarget }) => void;

const releaseAgent = {
  id: 'agent_release',
  name: 'Release Profile',
  description: 'Release readiness profile',
  instructions: 'Answer with release context.',
  enabled: true,
  model: 'local-stub/release',
  defaultModels: { claude: 'anthropic/release', 'workers-ai': '@cf/release' },
  allowedTools: ['lookup_channel_brief'],
};

const opsAgent = {
  id: 'agent_ops',
  name: 'Ops Profile',
  description: 'Operations profile',
  instructions: 'Answer with operations context.',
  enabled: true,
  model: 'local-stub/ops',
  defaultModels: { claude: 'anthropic/ops', 'workers-ai': '@cf/ops' },
  allowedTools: [],
};

function inlineScript(): string {
  const script = renderAdminPage().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'admin page should include one inline script');
  return script;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function actionTarget(attributes: Record<string, string>): FakeTarget {
  return {
    closest(selector: string) {
      return selector === '[data-action]' ? this : null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

function effectiveConfig(agent: typeof releaseAgent, channelId: string): unknown {
  return {
    config: {
      workspaceId: 'T_DESIGN',
      channelId,
      agentId: agent.id,
      profile: agent,
      model: agent.model,
      provider: 'local-stub',
      allowedTools: agent.allowedTools,
      instructions: `${agent.name} resolved instructions.`,
      instructionLayers: [{ source: 'profile', label: 'Profile', text: agent.instructions }],
      snapshotHash: `sha256-${channelId}`,
    },
  };
}

function runAdminPageHarness(): {
  app: FakeElement;
  modalRoot: FakeElement;
  listeners: Record<string, Listener>;
  resolveOpsEffective(): void;
} {
  const app: FakeElement = { innerHTML: '' };
  const modalRoot: FakeElement = { innerHTML: '' };
  const listeners: Record<string, Listener> = {};
  let resolveOpsEffective: (() => void) | undefined;

  const document = {
    getElementById(id: string) {
      if (id === 'app') return app;
      if (id === 'modal-root') return modalRoot;
      return null;
    },
    querySelector() {
      return null;
    },
    addEventListener(type: string, listener: Listener) {
      listeners[type] = listener;
    },
  };

  const fetch = (path: string, _options?: unknown): Promise<FakeResponse> => {
    if (path === '/admin/api/agents') {
      return Promise.resolve(jsonResponse({ agents: [releaseAgent, opsAgent] }));
    }
    if (path === '/admin/api/assignments') {
      return Promise.resolve(
        jsonResponse({
          assignments: [
            {
              workspaceId: 'T_DESIGN',
              channelId: 'C0EXR3L9T',
              channelLabel: 'eng-releases',
              agentId: releaseAgent.id,
              enabled: true,
              channelPromptAddendum: 'Release channel addendum.',
            },
            {
              workspaceId: 'T_DESIGN',
              channelId: 'C_OPS',
              agentId: opsAgent.id,
              enabled: true,
            },
          ],
        }),
      );
    }
    if (path === '/admin/api/models') {
      return Promise.resolve(jsonResponse({ automatic: { label: 'Automatic', value: null }, providers: [] }));
    }
    if (path.startsWith('/admin/api/effective-config?')) {
      const params = new URLSearchParams(path.slice(path.indexOf('?') + 1));
      const channelId = params.get('channelId');
      if (channelId === 'C_OPS') {
        return new Promise<FakeResponse>((resolve) => {
          resolveOpsEffective = () => {
            resolve(jsonResponse(effectiveConfig(opsAgent, 'C_OPS')));
          };
        });
      }
      return Promise.resolve(jsonResponse(effectiveConfig(releaseAgent, 'C0EXR3L9T')));
    }
    return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
  };

  vm.runInNewContext(
    inlineScript(),
    {
      document,
      fetch,
      console,
      URLSearchParams,
    },
    { filename: 'admin-page-inline.js' },
  );

  return {
    app,
    modalRoot,
    listeners,
    resolveOpsEffective() {
      assert.ok(resolveOpsEffective, 'expected C_OPS effective-config request to be pending');
      resolveOpsEffective();
    },
  };
}

test('admin page renders channel labels, profile secondary text, and singular channel counts', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  assert.match(harness.app.innerHTML, /<span class="chan-name">#eng-releases<\/span>/);
  // Rail secondary text is the attached profile's name (per the design mockups);
  // the channel ID secondary lives on the modal Channels tab rows instead.
  assert.match(harness.app.innerHTML, /<span class="chan-meta">Release Profile<\/span>/);
  assert.match(harness.app.innerHTML, /<h1 class="page-title mono-title">#eng-releases<\/h1>/);
  assert.match(harness.app.innerHTML, /used in 1 channel/);

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'channels' }) });

  assert.match(harness.modalRoot.innerHTML, /#eng-releases/);
  assert.match(harness.modalRoot.innerHTML, /C0EXR3L9T · has channel instructions/);
  assert.match(harness.modalRoot.innerHTML, /Used in 1 channel/);
});

test('selecting a channel re-renders after effective config finishes resolving', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({
    target: actionTarget({
      'data-action': 'select-channel',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C_OPS',
    }),
  });

  assert.match(harness.app.innerHTML, /Resolving\.\.\./);
  harness.resolveOpsEffective();
  await flushAsync();

  assert.match(harness.app.innerHTML, /#C_OPS/);
  assert.match(harness.app.innerHTML, /local-stub\/ops/);
  assert.doesNotMatch(harness.app.innerHTML, /Resolving\.\.\./);
});
