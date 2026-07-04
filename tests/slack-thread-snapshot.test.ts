import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import slackThreadAgent from '../src/agents/slack-thread.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ChannelAssignment, CustomAgentConfig } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

const AGENT_ID = 'agent_snapshot_unit';
const THREAD_KEY = 'T_SNAPSHOT:C_SNAPSHOT:1782771900.000100';
const NEW_THREAD_KEY = 'T_SNAPSHOT:C_SNAPSHOT:1782771901.000100';
const ALPHA = 'SNAPSHOT_UNIT_ALPHA: original profile instructions.';
const BETA = 'SNAPSHOT_UNIT_BETA: edited profile instructions.';

function agent(overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
  return {
    id: AGENT_ID,
    name: 'Snapshot Unit Profile',
    description: 'Exercises thread config snapshots.',
    instructions: ALPHA,
    enabled: true,
    model: 'local-stub/snapshot-unit',
    defaultModels: {
      claude: 'anthropic/snapshot-unit',
      'workers-ai': '@cf/snapshot/unit',
    },
    allowedTools: [],
    ...overrides,
  };
}

function assignment(overrides: Partial<ChannelAssignment> = {}): ChannelAssignment {
  return {
    workspaceId: 'T_SNAPSHOT',
    channelId: 'C_SNAPSHOT',
    agentId: AGENT_ID,
    enabled: true,
    ...overrides,
  };
}

test('slack-thread freezes effective config per durable thread id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-flue-thread-snapshot-'));
  const dbPath = join(dir, 'state.db');

  try {
    const seed = new SqliteConfigStore(dbPath, { agents: [], assignments: [] });
    seed.createAgent(agent());
    seed.putAssignment(assignment());
    seed.close();

    await withEnv(
      {
        SLACK_STATE_DB_PATH: dbPath,
        SLACK_FLUE_MODEL: 'local-stub/snapshot-unit-fallback',
        ANTHROPIC_API_KEY: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
      },
      async () => {
        const first = await slackThreadAgent.initialize({ id: THREAD_KEY, env: {} });
        assert.match(String(first.instructions), /SNAPSHOT_UNIT_ALPHA/);

        const editor = new SqliteConfigStore(dbPath, { agents: [], assignments: [] });
        editor.updateAgent(AGENT_ID, { instructions: BETA });
        editor.close();

        const sameThread = await slackThreadAgent.initialize({ id: THREAD_KEY, env: {} });
        assert.match(String(sameThread.instructions), /SNAPSHOT_UNIT_ALPHA/);
        assert.doesNotMatch(String(sameThread.instructions), /SNAPSHOT_UNIT_BETA/);

        const newThread = await slackThreadAgent.initialize({ id: NEW_THREAD_KEY, env: {} });
        assert.match(String(newThread.instructions), /SNAPSHOT_UNIT_BETA/);

        const disabler = new SqliteConfigStore(dbPath, { agents: [], assignments: [] });
        disabler.updateAgent(AGENT_ID, { enabled: false });
        disabler.close();

        const disabledSameThread = await slackThreadAgent.initialize({ id: THREAD_KEY, env: {} });
        assert.match(String(disabledSameThread.instructions), /SNAPSHOT_UNIT_ALPHA/);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
