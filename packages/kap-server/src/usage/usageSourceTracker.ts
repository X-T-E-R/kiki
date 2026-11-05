import { watch } from 'node:fs';

import {
  AGENT_WIRE_RECORD_KEY,
  Disposable,
  IAppendLogStore,
  IBootstrapService,
  IFileSystemStorageService,
  ILogService,
  RETAINED_USAGE_SCOPE,
  RETAINED_USAGE_KEY,
  EPHEMERAL_USAGE_KEY,
  type Scope,
} from '@kiki/agent-core-v2';
import { onUnexpectedError } from '@kiki/agent-core-v2/_base/errors/unexpectedError';
import { isPromiseLike } from '@kiki/agent-core-v2/_base/lifecycle/disposer';

export type UsageSourceChange = string | {
  readonly kind: 'agent';
  readonly sessionKey: string;
  readonly agentId: string;
} | { readonly kind: 'retained' } | undefined;

export interface UsageSourceChanges {
  readonly ready: boolean;
  onDidChange(listener: (change: UsageSourceChange) => void): { dispose(): void };
}

type WatchSource = (root: string, listener: (filename: string | null, event?: 'rename' | 'change') => void) => {
  close(): void;
  on(event: 'error', listener: (error: unknown) => void): unknown;
};

const watchSource: WatchSource = (root, listener) => watch(root, {
  recursive: true, persistent: false,
}, (event, filename) => { listener(filename, event); });

export class UsageSourceTracker extends Disposable implements UsageSourceChanges {
  private watching = false;
  private startWatch: (() => void) | undefined;
  private readonly listeners = new Set<(change: UsageSourceChange) => void>();

  get ready(): boolean {
    const start = this.startWatch;
    this.startWatch = undefined;
    start?.();
    return this.watching;
  }

  onDidChange(listener: (change: UsageSourceChange) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  constructor(core: Scope, createWatch: WatchSource = watchSource) {
    super();
    const storage = core.accessor.get(IFileSystemStorageService);
    const root = storage.pathFor('sessions', '');
    const retainedScope = core.accessor.get(IBootstrapService).scope(RETAINED_USAGE_SCOPE);
    const invalidate = (change?: UsageSourceChange): void => {
      for (const listener of this.listeners) listener(change);
    };
    this._register(core.accessor.get(IAppendLogStore).onDidWrite(({ scope, key }) => {
      if (scope === retainedScope && (key === RETAINED_USAGE_KEY || key === EPHEMERAL_USAGE_KEY)) {
        invalidate({ kind: 'retained' });
        return;
      }
      if (key !== AGENT_WIRE_RECORD_KEY) return;
      const parts = scope.split('/');
      if (parts.length === 5 && parts[0] === 'sessions' && parts[3] === 'agents') {
        invalidate({ kind: 'agent', sessionKey: `${parts[1]}\0${parts[2]}`, agentId: parts[4]! });
      }
    }));
    const watchLedger = storage.watch?.bind(storage);
    if (root === undefined || watchLedger === undefined) return;
    this.startWatch = () => {
      const failed = (error: unknown): void => {
        this.watching = false;
        invalidate();
        core.accessor.get(ILogService).warn('usage source watch failed; validating sources on each query', { error: String(error) });
      };
      try {
        const watcher = createWatch(root, (filename, event) => {
          const parts = filename?.split(/[\\/]/);
          if (parts === undefined || parts.length < 2) {
            invalidate();
          } else if (parts.length <= 2 || (parts[2] === 'agents' && (
            parts.length <= 4 && event !== 'change' || (parts.length === 5 && parts[4] === AGENT_WIRE_RECORD_KEY)
          ))) {
            const sessionKey = `${parts[0]}\0${parts[1]}`;
            invalidate(parts[2] === 'agents' && parts.length >= 4
              ? { kind: 'agent', sessionKey, agentId: parts[3]! }
              : sessionKey);
          }
        });
        watcher.on('error', (error) => {
          watcher.close();
          failed(error);
        });
        this._register({ dispose: () => { watcher.close(); } });
        for (const key of [RETAINED_USAGE_KEY, EPHEMERAL_USAGE_KEY]) {
          this._register(watchLedger(retainedScope, key)(() => { invalidate({ kind: 'retained' }); }));
        }
        this.watching = true;
        invalidate();
      } catch (error) {
        failed(error);
      }
    };
  }

  override dispose(): void {
    this.watching = false;
    this.startWatch = undefined;
    this.listeners.clear();
    const pending = super.dispose();
    if (isPromiseLike(pending)) pending.then(undefined, onUnexpectedError);
  }
}
