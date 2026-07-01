import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeSlackBackend, STUB_REPLY_MARKER } from './parity/fake-slack.ts';

test('asFetch records Slack and provider calls and returns wire-shaped bodies', async () => {
  const backend = new FakeSlackBackend();
  const fetchImpl = backend.asFetch();

  const status = await fetchImpl('https://slack.com/api/assistant.threads.setStatus', {
    method: 'POST',
    body: JSON.stringify({ channel_id: 'C_EXEC', thread_ts: '1.1', status: 'is checking context' }),
  });
  assert.deepEqual(await status.json(), { ok: true });

  const provider = await fetchImpl(
    'https://workers-ai.fake/accounts/acct_test/ai/run/@cf/zai-org/glm-5.2',
    { method: 'POST', body: JSON.stringify({ messages: [], max_tokens: 512 }) },
  );
  assert.deepEqual(await provider.json(), {
    success: true,
    result: { response: STUB_REPLY_MARKER },
  });

  assert.equal(backend.statusCalls().length, 1);
  assert.equal(backend.providerCalls().length, 1);
});

test('listen serves the same core over HTTP', async () => {
  const backend = new FakeSlackBackend();
  const server = await backend.listen();

  try {
    const response = await fetch(`${server.url}/api/chat.postMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'C_EXEC', thread_ts: '1.1', text: 'hi' }),
    });
    const body = (await response.json()) as { ok: boolean; ts?: string };
    assert.equal(body.ok, true);
    assert.equal(typeof body.ts, 'string');

    const providerResponse = await fetch(
      `${server.url}/accounts/acct_test/ai/run/@cf/zai-org/glm-5.2`,
      { method: 'POST', body: JSON.stringify({ messages: [] }) },
    );
    assert.equal(providerResponse.status, 200);

    assert.equal(backend.callsOfMethod('chat.postMessage').length, 1);
    assert.equal(backend.providerCalls().length, 1);
  } finally {
    await server.close();
  }
});

test('http_500 provider mode surfaces a 500 with the raw marker for leak checks', async () => {
  const backend = new FakeSlackBackend({ provider: { mode: 'http_500' } });
  const fetchImpl = backend.asFetch();

  const response = await fetchImpl('https://workers-ai.fake/accounts/acct/ai/run/model', {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  });

  assert.equal(response.status, 500);
});
