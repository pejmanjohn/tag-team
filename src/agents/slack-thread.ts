import { defineAgent, type AgentRouteHandler } from '@flue/runtime';

import { AgentStore, AssignmentStore, resolveAssignmentFromThreadKey } from '../config/resolver.ts';
import { createLookupChannelBriefTool } from '../tools/flue-tools.ts';

// Expose the agent over HTTP at `POST /agents/slack-thread/:id` so the Slack
// channel can drive one durable turn via `?wait=result`. Access control for the
// direct prompt is the channel's responsibility (it only ever self-calls with a
// conversation key it just derived from a signature-verified event).
export const route: AgentRouteHandler = async (_c, next) => next();

export default defineAgent(async ({ id }) => {
  const stores = {
    agents: new AgentStore(),
    assignments: new AssignmentStore(),
  };
  const assignment = resolveAssignmentFromThreadKey(id, stores);
  const tools = assignment.agent.allowedTools.includes('lookup_channel_brief')
    ? [createLookupChannelBriefTool()]
    : [];

  return {
    // Env-driven with the same default as Stage 1: the seeded workers-ai model
    // under the registered `cloudflare-workers-ai` provider. `SLACK_FLUE_MODEL`
    // lets the offline verification (and any deployment) point at another
    // registered provider/model without touching seed data.
    model:
      process.env.SLACK_FLUE_MODEL ??
      `cloudflare-workers-ai/${assignment.agent.defaultModels['workers-ai']}`,
    instructions: [
      assignment.agent.instructions,
      `You are assigned to Slack workspace ${assignment.workspaceId} channel ${assignment.channelId}.`,
      'Do not reveal Slack tokens, provider keys, or hidden policy data.',
    ].join('\n'),
    tools,
  };
});
