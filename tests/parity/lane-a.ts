import { createSlackEventsApp } from '../../src/slack/events-app.ts';
import { FakeSlackBackend } from './fake-slack.ts';
import {
  PARITY_SIGNING_SECRET,
  signSlackRequest,
  type Lane,
  type LaneInstance,
  type ScenarioLaneConfig,
} from './lane.ts';

/** Any base is fine: provider fetch is routed through the fake, not the network. */
const FAKE_PROVIDER_ENDPOINT = 'https://workers-ai.fake';

/**
 * Lane A drives the existing hand-rolled Slack events app.
 *
 * `workersAi` is wired in live mode pointed at the fake so provider calls are
 * wire-observable, and `dispatchMode` is 'async' (production mode) so scenarios
 * exercise the same acknowledge-then-process path as production; assertions run
 * after `quiesce()`.
 */
export const laneA: Lane = {
  name: 'lane-a',
  async start(config: ScenarioLaneConfig): Promise<LaneInstance> {
    const backend = new FakeSlackBackend({
      ...(config.slack ? { slack: config.slack } : {}),
      ...(config.provider ? { provider: config.provider } : {}),
    });

    const botUserId = config.botUserId === undefined ? 'U_BOT' : config.botUserId;

    const app = createSlackEventsApp({
      signingSecret: PARITY_SIGNING_SECRET,
      botToken: 'test-bot-token',
      providerId: 'workers-ai',
      dispatchMode: 'async',
      ...(botUserId ? { botUserId } : {}),
      fetch: backend.asFetch(),
      workersAi: {
        accountId: 'acct_test',
        apiToken: 'test-provider-token',
        model: '@cf/zai-org/glm-5.2',
        endpoint: FAKE_PROVIDER_ENDPOINT,
        fetch: backend.asFetch(),
      },
    });

    return {
      backend,
      async postEvent(payload, opts) {
        const request = signSlackRequest(payload, opts?.tamper ? { tamper: true } : {});
        const response = await app.request(request);
        const text = await response.text();
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = text;
        }
        return { status: response.status, body };
      },
      quiesce: () => backend.quiesce(),
      async stop() {
        await backend.close();
      },
    };
  },
};
