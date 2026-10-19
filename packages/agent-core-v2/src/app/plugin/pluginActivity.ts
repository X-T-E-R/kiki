import type { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { DisposableStore, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';

export interface PluginActivity {
  readonly sessionId: string;
  readonly busy: boolean;
  readonly pendingInteraction: 'none' | 'approval' | 'question';
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly at: number;
}

export function observePluginActivity(manager: ISessionManager, listener: (activity: readonly PluginActivity[]) => void): IDisposable {
  const store = new DisposableStore();
  const sessions = new Map<string, { state: PluginActivity; subscription: IDisposable }>();
  const publish = () => listener([...sessions.values()].map(value => value.state));
  const reconcile = () => {
    const live = manager.list();
    const ids = new Set(live.map(handle => handle.id));
    for (const [id, entry] of sessions) if (!ids.has(id)) {
      const disposed = entry.subscription.dispose();
      if (isPromiseLike(disposed)) disposed.catch(onUnexpectedError);
      sessions.delete(id);
    }
    for (const handle of live) {
      if (sessions.has(handle.id)) continue;
      const view = handle.accessor.get(ISessionActivityView);
      const read = (): PluginActivity => ({ sessionId: handle.id, busy: view.state().busy,
        pendingInteraction: view.state().pendingInteraction, lastTurnReason: view.state().lastTurnReason, at: Date.now() });
      const entry = { state: read(), subscription: view.onDidChange(() => { entry.state = read(); publish(); }) };
      sessions.set(handle.id, entry);
    }
    publish();
  };
  if (manager.onDidCreateSession !== undefined) store.add(manager.onDidCreateSession(reconcile));
  if (manager.onDidCloseSession !== undefined) store.add(manager.onDidCloseSession(reconcile));
  store.add(toDisposable(async () => {
    const subscriptions = [...sessions.values()];
    sessions.clear();
    for (const value of subscriptions) await value.subscription.dispose();
  }));
  reconcile();
  return store;
}
