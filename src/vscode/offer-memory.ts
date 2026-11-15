import type * as vscode from 'vscode';

type Memento = Pick<vscode.Memento, 'get' | 'update'>;

interface OfferState {
  asked?: number;
  done?: boolean;
}

/**
 * What an offer made once per workspace, and in a few workspaces at most, remembers: whether this
 * workspace was asked, how many were, and whether to stop asking. What cannot be remembered is asked
 * again; that is no reason to fail, so every write is best effort.
 */
export class OfferMemory {
  constructor(
    private readonly workspace: Memento,
    private readonly global: Memento,
    private readonly key: string,
    private readonly workspaceKey: string,
    private readonly limit: number,
  ) {}

  /** Whether this workspace may still be asked. */
  allowed(): boolean {
    const state = this.state();
    return !state.done && (state.asked ?? 0) < this.limit && !this.workspace.get<boolean>(this.workspaceKey);
  }

  /** Count one more workspace asked. */
  counted(): Promise<void> {
    const state = this.state();
    return this.save({ ...state, asked: (state.asked ?? 0) + 1 });
  }

  /** Take back one counted workspace, for an answer that did not last. */
  uncounted(): Promise<void> {
    const state = this.state();
    return this.save({ ...state, asked: Math.max(0, (state.asked ?? 1) - 1) });
  }

  /** Stop asking anywhere. Read afresh: other windows may have asked, or been answered, meanwhile. */
  done(): Promise<void> {
    return this.save({ ...this.state(), done: true });
  }

  /** Mark this workspace asked, or with false, not asked. */
  askedHere(asked = true): Promise<void> {
    return put(this.workspace, this.workspaceKey, asked ? true : undefined);
  }

  private state(): OfferState {
    return this.global.get<OfferState>(this.key) ?? {};
  }

  private save(state: OfferState): Promise<void> {
    return put(this.global, this.key, state);
  }
}

function put(memento: Memento, key: string, value: unknown): Promise<void> {
  return Promise.resolve(memento.update(key, value)).then(
    () => undefined,
    () => undefined,
  );
}
