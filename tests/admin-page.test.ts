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

interface FakeSubmitTarget extends FakeTarget {
  __formData: Record<string, string>;
}

type Listener = (event: { target: FakeTarget; preventDefault?(): void }) => void;
type AssignmentFixture = {
  workspaceId: string;
  channelId: string;
  channelLabel?: string;
  agentId: string;
  enabled: boolean;
  channelPromptAddendum?: string;
};
type SlackConnectionFixture = {
  connected: boolean;
  credentials: { botToken: string; signingSecret: string; botUserId: string };
  requestUrl: string;
  manifestUrl: string;
};

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

function submitTarget(attributes: Record<string, string>, formData: Record<string, string>): FakeSubmitTarget {
  return {
    __formData: formData,
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

function defaultAssignments(): AssignmentFixture[] {
  return [
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
  ];
}

function runAdminPageHarness(
  options: { assignments?: AssignmentFixture[]; slackConnection?: SlackConnectionFixture } = {},
): {
  app: FakeElement;
  modalRoot: FakeElement;
  listeners: Record<string, Listener>;
  putAssignments: unknown[];
  slackPosts: unknown[];
  resolveOpsEffective(): void;
} {
  const app: FakeElement = { innerHTML: '' };
  const modalRoot: FakeElement = { innerHTML: '' };
  const listeners: Record<string, Listener> = {};
  const putAssignments: unknown[] = [];
  const slackPosts: unknown[] = [];
  let assignments = options.assignments ?? defaultAssignments();
  const slackConnection = options.slackConnection;
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

  const fetch = (path: string, options?: { method?: string; body?: string }): Promise<FakeResponse> => {
    const method = options?.method ?? 'GET';
    if (path === '/admin/api/agents') {
      return Promise.resolve(jsonResponse({ agents: [releaseAgent, opsAgent] }));
    }
    if (path === '/admin/api/assignments' && method === 'PUT') {
      const body = JSON.parse(options?.body ?? '{}') as AssignmentFixture;
      putAssignments.push(body);
      assignments = [
        ...assignments.filter(
          (assignment) => assignment.workspaceId !== body.workspaceId || assignment.channelId !== body.channelId,
        ),
        body,
      ];
      return Promise.resolve(jsonResponse({ assignment: body }));
    }
    if (path === '/admin/api/assignments') {
      return Promise.resolve(
        jsonResponse({
          assignments,
        }),
      );
    }
    if (path === '/admin/api/models') {
      return Promise.resolve(jsonResponse({ automatic: { label: 'Automatic', value: null }, providers: [] }));
    }
    if (path === '/admin/api/slack-connection' && method === 'POST') {
      slackPosts.push(JSON.parse(options?.body ?? '{}'));
      // A successful save flips the fixture to connected/stored, exactly like
      // the real endpoint's follow-up GET would report.
      if (slackConnection) {
        slackConnection.connected = true;
        slackConnection.credentials = {
          botToken: 'stored',
          signingSecret: 'stored',
          botUserId: 'stored',
        };
      }
      return Promise.resolve(
        jsonResponse({
          ok: true,
          team: 'Acme Inc',
          botName: 'tag',
          botUserId: 'U_BOT',
          note: 'Signing secret saved; Slack proves it on the first signed event.',
        }),
      );
    }
    if (path === '/admin/api/slack-connection') {
      // Without a fixture, mirror an endpoint failure: the page must render
      // everything else and simply omit the card (resilience contract).
      return slackConnection
        ? Promise.resolve(jsonResponse(slackConnection))
        : Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
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
      FormData: class {
        private readonly fields: Record<string, string>;

        constructor(form: FakeSubmitTarget) {
          this.fields = form.__formData;
        }

        get(name: string) {
          return this.fields[name] ?? null;
        }
      },
      URLSearchParams,
    },
    { filename: 'admin-page-inline.js' },
  );

  return {
    app,
    modalRoot,
    listeners,
    putAssignments,
    slackPosts,
    resolveOpsEffective() {
      assert.ok(resolveOpsEffective, 'expected C_OPS effective-config request to be pending');
      resolveOpsEffective();
    },
  };
}

function disconnectedSlackFixture(): SlackConnectionFixture {
  return {
    connected: false,
    credentials: { botToken: 'missing', signingSecret: 'env', botUserId: 'missing' },
    requestUrl: 'https://tag.example.dev/channels/slack/events',
    manifestUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%22a%22%3A1%7D',
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

test('channel rail groups concrete assignments under their own workspace headers', async () => {
  const harness = runAdminPageHarness({
    assignments: [
      ...defaultAssignments(),
      {
        workspaceId: 'T_DEMO',
        channelId: 'C_DEMO',
        channelLabel: 'demo-channel',
        agentId: releaseAgent.id,
        enabled: true,
      },
      {
        workspaceId: '*',
        channelId: '*',
        agentId: releaseAgent.id,
        enabled: true,
      },
    ],
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<div class="ws-row">▾ T_DESIGN<\/div>/);
  assert.match(harness.app.innerHTML, /<div class="ws-row">▾ T_DEMO<\/div>/);

  const designHeader = harness.app.innerHTML.indexOf('<div class="ws-row">▾ T_DESIGN</div>');
  const designChannel = harness.app.innerHTML.indexOf('<span class="chan-name">#eng-releases</span>');
  const demoHeader = harness.app.innerHTML.indexOf('<div class="ws-row">▾ T_DEMO</div>');
  const demoChannel = harness.app.innerHTML.indexOf('<span class="chan-name">#demo-channel</span>');
  assert.ok(designHeader >= 0 && designHeader < designChannel);
  assert.ok(designChannel < demoHeader);
  assert.ok(demoHeader < demoChannel);
});

test('add-channel workspace prefill follows active channel and blank workspace submit validates inline', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'toggle-add-channel' }) });

  assert.match(harness.app.innerHTML, /id="rail-workspace" name="workspaceId" value="T_DESIGN"/);

  const submit = harness.listeners.submit;
  assert.ok(submit);
  submit({
    target: submitTarget(
      { 'data-action': 'add-channel-form' },
      { workspaceId: '', channelId: 'C_NEW', channelLabel: 'new-channel' },
    ),
    preventDefault() {},
  });
  await flushAsync();

  assert.equal(harness.putAssignments.length, 0);
  assert.match(harness.app.innerHTML, /Workspace ID is required\./);
});

test('add-channel workspace prefill stays empty when no concrete assignments exist', async () => {
  const harness = runAdminPageHarness({ assignments: [] });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'toggle-add-channel' }) });

  assert.doesNotMatch(harness.app.innerHTML, /T_DEMO/);
  assert.match(harness.app.innerHTML, /id="rail-workspace" name="workspaceId" value="" placeholder="T0123ABC"/);
});

test('admin page renders the Slack-connection wizard when credentials are missing', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Connect Slack/);
  assert.match(harness.app.innerHTML, /Not connected/);
  // The manifest deep-link is the server-provided URL, attribute-escaped.
  assert.match(
    harness.app.innerHTML,
    /href="https:\/\/api\.slack\.com\/apps\?new_app=1&amp;manifest_json=%7B%22a%22%3A1%7D"/,
  );
  assert.match(harness.app.innerHTML, /tag\.example\.dev\/channels\/slack\/events/);
  // Mixed provenance: the env-provided signing secret is read-only, the
  // missing bot token asks for a paste.
  assert.match(harness.app.innerHTML, /configured via environment/);
  assert.match(harness.app.innerHTML, /name="botToken"/);
  assert.match(harness.app.innerHTML, /name="signingSecret"/);
  assert.match(harness.app.innerHTML, /first signed Slack event/);
});

test('admin page shows a compact connected card without a paste form when Slack is connected', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: {
      connected: true,
      credentials: { botToken: 'env', signingSecret: 'env', botUserId: 'stored' },
      requestUrl: 'https://tag.example.dev/channels/slack/events',
      manifestUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%22a%22%3A1%7D',
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Slack connection/);
  assert.match(harness.app.innerHTML, /Connected/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);
  assert.doesNotMatch(harness.app.innerHTML, /Connect Slack/);
});

test('admin page omits the connection card when the endpoint fails (resilience)', async () => {
  const harness = runAdminPageHarness({ assignments: [] });
  await flushAsync();

  // Everything else still renders...
  assert.match(harness.app.innerHTML, /No channels yet/);
  // ...but no wizard card is painted from a failed connection fetch.
  assert.doesNotMatch(harness.app.innerHTML, /Connect Slack/);
  assert.doesNotMatch(harness.app.innerHTML, /Slack connection/);
});

test('wizard paste-back submit posts both credentials and renders the connected state', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  const submit = harness.listeners.submit;
  assert.ok(submit);
  submit({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: '  xoxb-pasted ', signingSecret: 'pasted-secret' },
    ),
    preventDefault() {},
  });
  await flushAsync();

  // Trimmed on the client before the POST.
  assert.deepEqual(harness.slackPosts, [{ botToken: 'xoxb-pasted', signingSecret: 'pasted-secret' }]);
  assert.match(harness.app.innerHTML, /Connected to Acme Inc as @tag\./);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);
});

test('wizard submit validates empty fields inline without posting', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  const submit = harness.listeners.submit;
  assert.ok(submit);
  submit({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: '', signingSecret: 'secret-only' },
    ),
    preventDefault() {},
  });
  await flushAsync();

  assert.equal(harness.slackPosts.length, 0);
  assert.match(harness.app.innerHTML, /Bot token is required\./);
});
