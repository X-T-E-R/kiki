import { watch } from 'node:fs';

import {
  AGENT_WIRE_RECORD_KEY,
  Disposable,
  IAppendLogStore,
  IFileSystemStorageService,
  ILogService,
  type Scope,
} from '@kiki/agent-core-v2';

export interface UsageSourceChanges {
  readonly ready: boolean;
  onDidChange(listener: (sessionKey?: string) => void): { dispose(): void };
}

type WatchSource = (root: string, listener: (filename: string | null) => void) => {
  close(): void;
  on(event: 'error', listener: (error: unknown) => void): unknown;
};

const watchSource: WatchSource = (root, listener) => watch(root, {
  recursive: true, persistent: false,
}, (_event, filename) => { listener(filename); });

export class UsageSourceTracker extends Disposable implements UsageSourceChanges {
  private watching = false;
  private startWatch: (() => void) | undefined;
  private readonly listeners = new Set<(sessionKey?: string) => void>();

  get ready(): boolean {
    const start = this.startWatch;
    this.startWatch = undefined;
    start?.();
    return this.watching;
  }

  onDidChange(listener: (sessionKey?: string) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  constructor(core: Scope, createWatch: WatchSource = watchSource) {
    super();
    const root = core.accessor.get(IFileSystemStorageService).pathFor('sessions', '');
    const invalidate = (key?: string): void => {
      for (const listener of this.listeners) listener(key);
    };
    this._register(core.accessor.get(IAppendLogStore).onDidWrite(({ scope, key }) => {
      if (key !== AGENT_WIRE_RECORD_KEY) return;
      const parts = scope.split('/');
      if (parts.length === 5 && parts[0] === 'sessions' && parts[3] === 'agents') {
        invalidate(`${parts[1]}\0${parts[2]}`);
      }
    }));
    if (root === undefined) return;
    this.startWatch = () => {
      const failed = (error: unknown): void => {
        this.watching = false;
        invalidate();
        core.accessor.get(ILogService).warn('usage source watch failed; validating sources on each query', { error: String(error) });
      };
      try {
        const watcher = createWatch(root, (filename) => {
          const parts = filename?.split(/[\\/]/);
          if (parts === undefined || parts.length < 2) {
            invalidate();
          } else if (parts.length <= 2 || (parts[2] === 'agents' && (
            parts.length <= 4 || (parts.length === 5 && parts[4] === AGENT_WIRE_RECORD_KEY)
          ))) {
            invalidate(`${parts[0]}\0${parts[1]}`);
          }
        });
        watcher.on('error', (error) => {
          watcher.close();
          failed(error);
        });
        this._register({ dispose: () => { watcher.close(); } });
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
    super.dispose();
  }
}
