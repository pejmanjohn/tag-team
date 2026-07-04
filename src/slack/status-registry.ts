import type { SlackStatusUpdate } from './replies.ts';
import type { WebClientPresenter } from './web-client-presenter.ts';

export interface SlackStatusTurnRegistration {
  setStatus(update: SlackStatusUpdate): Promise<boolean>;
  drain(): Promise<void>;
  close(): void;
}

type StatusPresenter = Pick<WebClientPresenter, 'setStatus'>;

class ActiveSlackStatusTurn implements SlackStatusTurnRegistration {
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly instanceId: string,
    private readonly presenter: StatusPresenter,
  ) {}

  setStatus(update: SlackStatusUpdate): Promise<boolean> {
    if (this.closed) {
      return Promise.resolve(false);
    }
    const attempt = this.presenter.setStatus(update).catch(() => false);
    const pending = attempt.then(() => {
      this.pending.delete(pending);
    });
    this.pending.add(pending);
    return attempt;
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  close(): void {
    this.closed = true;
    activeSlackStatusTurns.delete(this.instanceId);
  }
}

const activeSlackStatusTurns = new Map<string, ActiveSlackStatusTurn>();

export function registerSlackStatusTurn(
  instanceId: string,
  presenter: StatusPresenter,
): SlackStatusTurnRegistration {
  const turn = new ActiveSlackStatusTurn(instanceId, presenter);
  activeSlackStatusTurns.set(instanceId, turn);
  return turn;
}

export function setObservedSlackStatus(
  instanceId: string,
  update: SlackStatusUpdate,
): void {
  const turn = activeSlackStatusTurns.get(instanceId);
  if (!turn) {
    return;
  }
  void turn.setStatus(update);
}
