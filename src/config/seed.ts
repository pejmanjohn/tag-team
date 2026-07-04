import type { ChannelAssignment, CustomAgentConfig } from './types.ts';

// Canonical default model pair for a brand-new profile, shared by the seed and
// surfaced to the admin UI via /admin/api/models so the client never hardcodes
// a copy that goes stale when this changes.
export const SEED_DEFAULT_MODELS = {
  claude: 'anthropic/claude-sonnet-4-6',
  'workers-ai': '@cf/zai-org/glm-5.2',
} as const;

export const seededAgents: CustomAgentConfig[] = [
  {
    id: 'agent_exec_research',
    name: 'Exec Research',
    description: 'Answers executive-channel questions with concise workspace context.',
    instructions:
      'Use only the configured Slack thread and approved tools. Reply with concise findings and next steps.',
    enabled: true,
    defaultModels: { ...SEED_DEFAULT_MODELS },
    allowedTools: ['lookup_channel_brief'],
  },
];

export const seededAssignments: ChannelAssignment[] = [
  {
    workspaceId: 'T_DEMO',
    channelId: 'C_EXEC',
    agentId: 'agent_exec_research',
    enabled: true,
  },
  {
    workspaceId: '*',
    channelId: '*',
    agentId: 'agent_exec_research',
    enabled: true,
  },
];

export const seededChannelBriefs: Record<string, string> = {
  C_EXEC:
    'The exec leadership channel tracks board prep, paid acquisition, and weekly customer-proof priorities.',
};
