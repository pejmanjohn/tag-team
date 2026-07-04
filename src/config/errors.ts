// Typed config errors so route boundaries classify failures with instanceof
// instead of matching message substrings authored in other modules (which
// silently break on rewording).

export class UnknownAgentError extends Error {
  constructor(agentId: string) {
    super(`Unknown agent ${agentId}`);
    this.name = 'UnknownAgentError';
  }
}

export class AgentExistsError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} already exists`);
    this.name = 'AgentExistsError';
  }
}

export class AgentStillAssignedError extends Error {
  constructor(agentId: string, keys: string) {
    super(`Agent ${agentId} is still assigned to ${keys}`);
    this.name = 'AgentStillAssignedError';
  }
}

// "Nothing enabled answers in this channel" — the resolver's not-found family.
export class NoAssignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoAssignmentError';
  }
}

// Assigned but disabled: still "nothing answers here", so it subclasses
// NoAssignmentError and any instanceof NoAssignmentError check covers both.
export class DisabledAgentError extends NoAssignmentError {
  constructor(agentId: string) {
    super(`Assigned agent ${agentId} is disabled`);
    this.name = 'DisabledAgentError';
  }
}

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}
