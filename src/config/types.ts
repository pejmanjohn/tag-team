export type ProviderId = 'claude' | 'workers-ai';

export interface CustomAgentConfig {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  model?: string;
  defaultModels: Record<ProviderId, string>;
  allowedTools: string[];
}

export interface ChannelAssignment {
  workspaceId: string;
  channelId: string;
  agentId: string;
  enabled: boolean;
  channelLabel?: string;
  channelPromptAddendum?: string;
}

export interface BotIdentityConfig {
  avatarPath: string;
}

export interface ResolvedAssignment {
  workspaceId: string;
  channelId: string;
  agentId: string;
  channelPromptAddendum?: string;
  agent: CustomAgentConfig;
}

export interface AgentSnapshot {
  workspaceId: string;
  channelId: string;
  agentId: string;
  channelPromptAddendum?: string;
  agent: CustomAgentConfig;
  model: string;
  providerId: string;
  allowedTools: string[];
  instructions: string;
  snapshotHash: string;
  createdAt: number;
}
