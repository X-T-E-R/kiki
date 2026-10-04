import { randomUUID } from 'node:crypto';
import { ISessionManager, ISessionActivityView, type Scope } from '@kiki/agent-core-v2';
import type { ISessionScopeHandle } from '@kiki/agent-core-v2/_base/di/scope';
import type { IDisposable } from '@kiki/agent-core-v2/_base/di/lifecycle';
import type { SpaceSummary } from '@kiki/protocol';

export class SpaceSummaryProjection {
  private revision = 0;
  private readonly epoch = randomUUID();
  private readonly watchers = new Map<string, IDisposable>();
  private readonly listeners: IDisposable[] = [];
  constructor(private readonly core: Scope) {
    const manager = core.accessor.get(ISessionManager);
    for (const session of manager.list()) this.watch(session);
    const created = manager.onDidCreateSession?.(({ sessionId }) => { const session = manager.get(sessionId); if (session !== undefined) this.watch(session); });
    const closed = manager.onDidCloseSession?.(({ sessionId }) => this.unwatch(sessionId));
    const archived = manager.onDidArchiveSession?.(({ sessionId }) => this.unwatch(sessionId));
    for (const listener of [created, closed, archived]) if (listener !== undefined) this.listeners.push(listener);
  }
  read(): SpaceSummary {
    let busy = 0; let needsYou = 0;
    for (const session of this.core.accessor.get(ISessionManager).list()) {
      const state = session.accessor.get(ISessionActivityView).state();
      if (state.busy) busy += 1;
      if (state.pendingInteraction !== 'none') needsYou += 1;
    }
    return { online: true, busy_sessions: busy, needs_you_sessions: needsYou, revision: `${this.epoch}:${this.revision}`, as_of: Date.now() };
  }
  dispose(): void { for (const watcher of this.watchers.values()) watcher.dispose(); for (const listener of this.listeners) listener.dispose(); this.watchers.clear(); }
  private watch(session: ISessionScopeHandle): void {
    this.unwatch(session.id);
    this.watchers.set(session.id, session.accessor.get(ISessionActivityView).onDidChange(() => { this.revision += 1; }));
    this.revision += 1;
  }
  private unwatch(sessionId: string): void { this.watchers.get(sessionId)?.dispose(); this.watchers.delete(sessionId); this.revision += 1; }
}
