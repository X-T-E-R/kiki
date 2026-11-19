import {
  IAgentLifecycleService,
  IEventService,
  ISessionContext,
  ISessionIndex,
  ISessionManager,
  ISessionMetadata,
  type ISessionScopeHandle,
  type Scope,
  type SessionSummary,
} from '@kiki/agent-core-v2';
import type { SessionMeta } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { readColdSessionMeta } from '../services/snapshot/coldSessionMeta';

type ColdObserverResult = {
  readonly live?: undefined;
  readonly summary: SessionSummary;
  readonly metadata: SessionMeta | undefined;
} | undefined;

export type SessionObserverResult =
  | { readonly live: ISessionScopeHandle; readonly summary?: undefined; readonly metadata?: undefined }
  | { readonly live?: undefined; readonly summary: SessionSummary; readonly metadata: SessionMeta | undefined }
  | undefined;

const inflightColdObservers = new WeakMap<Scope, Map<string, Promise<ColdObserverResult>>>();

export interface SessionCursorReader {
  getCursor(
    sessionId: string,
    signal?: AbortSignal,
    indexed?: boolean,
  ): Promise<{ readonly seq: number } | undefined> | { readonly seq: number } | undefined;
}

interface ColdCursorStore {
  readonly values: Map<string, number>;
  readonly inflight: Map<string, Promise<number | undefined>>;
}

const MAX_COLD_CURSOR_CACHE = 2048;
const coldCursorStores = new WeakMap<Scope, WeakMap<object, ColdCursorStore>>();

function getColdCursorStore(core: Scope, broadcaster: object): ColdCursorStore {
  let byBroadcaster = coldCursorStores.get(core);
  if (byBroadcaster === undefined) {
    byBroadcaster = new WeakMap();
    coldCursorStores.set(core, byBroadcaster);
  }
  let store = byBroadcaster.get(broadcaster);
  if (store !== undefined) return store;
  store = { values: new Map(), inflight: new Map() };
  byBroadcaster.set(broadcaster, store);
  const evict = ({ sessionId }: { readonly sessionId: string }) => {
    store!.values.delete(sessionId);
  };
  try {
    const manager = core.accessor.get(ISessionManager);
    manager.onDidCreateSession?.(evict);
    manager.onDidCloseSession?.(evict);
    manager.onDidArchiveSession?.(evict);
  } catch {}
  try {
    core.accessor.get(IEventService).onDidPublish((event) => {
      const payload = (event as { readonly payload?: { readonly sessionId?: unknown } }).payload;
      if (typeof payload?.sessionId === 'string') {
        store!.values.delete(payload.sessionId);
      }
    });
  } catch {}
  return store;
}

export async function readSessionCursorSeq(
  core: Scope,
  broadcaster: SessionCursorReader | undefined,
  sessionId: string,
  signal?: AbortSignal,
  indexed = false,
): Promise<number | undefined> {
  if (broadcaster === undefined) return undefined;
  signal?.throwIfAborted();
  let isLive = false;
  try {
    isLive = core.accessor.get(ISessionManager).get(sessionId) !== undefined;
  } catch {}
  const store = getColdCursorStore(core, broadcaster as object);
  if (isLive) {
    store.values.delete(sessionId);
    return (await broadcaster.getCursor(sessionId, signal, indexed))?.seq;
  }
  const cached = store.values.get(sessionId);
  if (cached !== undefined) return cached;
  let pending = store.inflight.get(sessionId);
  if (pending === undefined) {
    pending = Promise.resolve(broadcaster.getCursor(sessionId, undefined, indexed))
      .then((cursor) => {
        const seq = cursor?.seq;
        let nowLive = false;
        try {
          nowLive = core.accessor.get(ISessionManager).get(sessionId) !== undefined;
        } catch {}
        if (!nowLive && seq !== undefined) {
          if (store.values.size >= MAX_COLD_CURSOR_CACHE) {
            const oldest = store.values.keys().next().value;
            if (oldest !== undefined) store.values.delete(oldest);
          }
          store.values.set(sessionId, seq);
        }
        return seq;
      })
      .finally(() => {
        if (store.inflight.get(sessionId) === pending) {
          store.inflight.delete(sessionId);
        }
      });
    store.inflight.set(sessionId, pending);
  }
  if (signal === undefined) return pending;
  return new Promise<number | undefined>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function readSessionObserver(core: Scope, sessionId: string): Promise<SessionObserverResult> {
  const manager = core.accessor.get(ISessionManager);
  const live = manager.get(sessionId);
  if (live !== undefined) return { live };
  let bySession = inflightColdObservers.get(core);
  if (bySession === undefined) {
    bySession = new Map();
    inflightColdObservers.set(core, bySession);
  }
  let pending = bySession.get(sessionId);
  if (pending === undefined) {
    pending = (async (): Promise<ColdObserverResult> => {
      const summary = await core.accessor.get(ISessionIndex).get(sessionId);
      if (summary === undefined) return undefined;
      const metadata = await readColdSessionMeta(core, summary.workspaceId, sessionId);
      return { summary, metadata };
    })().finally(() => {
      if (bySession.get(sessionId) === pending) {
        bySession.delete(sessionId);
      }
    });
    bySession.set(sessionId, pending);
  }
  const cold = await pending;
  const nowLive = manager.get(sessionId);
  if (nowLive !== undefined) return { live: nowLive };
  return cold;
}

export async function readAgentObserver(core: Scope, sessionId: string, agentId: string) {
  const session = await readSessionObserver(core, sessionId);
  if (session === undefined) return undefined;
  if (session.live !== undefined) {
    const agent = session.live.accessor.get(IAgentLifecycleService).get(agentId);
    const workspaceId = session.live.accessor.get(ISessionContext).workspaceId;
    const metadata = agent === undefined
      ? session.live.accessor.get(ISessionMetadata).snapshot().agents?.[agentId]
      : undefined;
    return { session, agent, metadata, workspaceId };
  }
  return { session, metadata: session.metadata?.agents?.[agentId], workspaceId: session.summary.workspaceId };
}
