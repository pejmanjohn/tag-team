// Typed config errors so route boundaries classify failures with instanceof
// instead of matching message substrings authored in other modules (which
// silently break on rewording).

// The constructor args are kept as readonly fields so boundaries that must
// SERIALIZE these errors (the state Durable Object's RPC envelope) can carry
// the args and reconstruct the identical error on the other side — never by
// parsing them back out of the message.

export class UnknownAgentError extends Error {
  constructor(readonly agentId: string) {
    super(`Unknown agent ${agentId}`);
    this.name = 'UnknownAgentError';
  }
}

export class AgentExistsError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent ${agentId} already exists`);
    this.name = 'AgentExistsError';
  }
}

export class AgentStillAssignedError extends Error {
  constructor(
    readonly agentId: string,
    readonly keys: string,
  ) {
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
