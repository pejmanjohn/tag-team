export type ProviderId = 'claude' | 'workers-ai';

/**
 * A profile-attached skill: a named playbook the agent can load on demand.
 * `name` must satisfy Flue's `defineSkill` rule (`^[a-z0-9]+(?:-[a-z0-9]+)*$`,
 * ≤64) and is unique per profile; `instructions` is the SKILL.md body Flue
 * surfaces only after the model activates the skill (progressive disclosure).
 * Only `enabled` skills are materialized at turn time.
 */
export interface SkillConfig {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
}

export interface CustomAgentConfig {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  model?: string;
  defaultModels: Record<ProviderId, string>;
  allowedTools: string[];
  skills: SkillConfig[];
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
  channelLabel?: string;
  channelPromptAddendum?: string;
  agent: CustomAgentConfig;
  // Optional pre-resolved model label. Set only when the assignment is served
  // from a frozen thread snapshot; undefined means resolve from the agent via
  // model policy at turn time.
  model?: string;
}

// A snapshot IS a resolved assignment frozen at a thread's first turn, plus the
// resolved model/provider/tools/instructions. Declaring the relation lets a
// snapshot be used directly wherever a ResolvedAssignment is expected.
export interface AgentSnapshot extends ResolvedAssignment {
  model: string;
  providerId: string;
  allowedTools: string[];
  instructions: string;
  snapshotHash: string;
  createdAt: number;
}
