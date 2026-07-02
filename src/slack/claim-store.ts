/**
 * Application-owned duplicate-admission store.
 *
 * `@flue/slack` deliberately does NOT dedupe Events API retries or the
 * app_mention + message fan-out (Slack delivers both for a single mention).
 * The channel claims each event before dispatch and releases on failure so a
 * Slack retry can re-drive the turn.
 */
export interface SlackClaimStore {
  /** Returns true if the key was newly claimed; false if it was already held. */
  claim(key: string): boolean;
  /** Release a previously claimed key so a retry can re-claim it. */
  release(key: string): void;
}

export class InMemoryClaimStore implements SlackClaimStore {
  private readonly claimed = new Set<string>();

  claim(key: string): boolean {
    if (this.claimed.has(key)) {
      return false;
    }
    this.claimed.add(key);
    return true;
  }

  release(key: string): void {
    this.claimed.delete(key);
  }
}
