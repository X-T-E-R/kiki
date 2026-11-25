import type { Klient } from '@kiki/klient';
import type { QueryClient, Query } from '@tanstack/react-query';

type UsageSource = { readonly sessionId?: string; readonly agentId?: string };
type PanelUsageSession = { revision?: number; byAgent: Map<string, number>; listeners: Set<() => void> };
const MAX_IDLE_USAGE_SESSIONS = 64;
const MAX_PANEL_USAGE_AGENTS = 256;
const panelUsageByClient = new WeakMap<Pick<Klient, 'events'>, {
  attached: boolean;
  sequence: number;
  sessions: Map<string, PanelUsageSession>;
}>();

function panelUsageFor(klient: Pick<Klient, 'events'>) {
  let usage = panelUsageByClient.get(klient);
  if (usage === undefined) panelUsageByClient.set(klient, usage = { attached: false, sequence: 0, sessions: new Map() });
  return usage;
}

function pruneIdleUsageSessions(sessions: Map<string, PanelUsageSession>): void {
  if (sessions.size <= MAX_IDLE_USAGE_SESSIONS) return;
  for (const [id, entry] of sessions) {
    if (entry.listeners.size > 0) continue;
    sessions.delete(id);
    if (sessions.size <= MAX_IDLE_USAGE_SESSIONS) break;
  }
}

export function observePanelUsage(klient: Pick<Klient, 'events'>, sessionId: string, listener: () => void): () => void {
  const { sessions } = panelUsageFor(klient);
  let session = sessions.get(sessionId);
  if (session === undefined) {
    pruneIdleUsageSessions(sessions);
    sessions.set(sessionId, session = { byAgent: new Map(), listeners: new Set() });
  } else {
    sessions.delete(sessionId);
    sessions.set(sessionId, session);
  }
  session.listeners.add(listener);
  return () => {
    session.listeners.delete(listener);
    if (session.listeners.size === 0) pruneIdleUsageSessions(sessions);
  };
}

export function panelUsageRevision(klient: Pick<Klient, 'events'>, sessionId: string, agentId: string): number | undefined {
  const session = panelUsageByClient.get(klient)?.sessions.get(sessionId);
  return session?.byAgent.get(agentId) ?? session?.revision;
}

function advanceSessionUsage(session: PanelUsageSession, revision: number, agentId?: string): void {
  if (agentId === undefined) {
    session.revision = revision;
    session.byAgent.clear();
  } else {
    if (session.byAgent.has(agentId)) session.byAgent.delete(agentId);
    else if (session.byAgent.size >= MAX_PANEL_USAGE_AGENTS) {
      const oldest = session.byAgent.keys().next().value;
      if (oldest !== undefined) session.byAgent.delete(oldest);
    }
    session.byAgent.set(agentId, revision);
  }
  for (const listener of session.listeners) listener();
}

function isUsageRead(query: Query, source: UsageSource | undefined): boolean {
  const [key, scope] = query.queryKey;
  if (key === 'usage-v2' || key === 'usage-v2-strip' || key === 'usage-v2-strip-session') return true;
  if (key === 'sessions') return source === undefined;
  if (key === 'session') return source?.sessionId === undefined || scope === source.sessionId;
  if (key !== 'agentCapabilities' || query.queryKey.at(-1) === 'catalog') return false;
  if (source === undefined) return true;
  const { sessionId, agentId } = source;
  return sessionId !== undefined && typeof scope === 'object' && scope !== null && 'session_id' in scope && scope.session_id === sessionId &&
    (agentId === undefined || 'agent_id' in scope && scope.agent_id === agentId);
}

export function subscribeUsageFreshness(klient: Pick<Klient, 'events'>, queries: QueryClient): () => void {
  let active = true;
  let refreshing = false;
  const pending = new Map<string | undefined, UsageSource | undefined>();
  const drain = async () => {
    refreshing = true;
    try {
      while (pending.size > 0) {
        if (!active) return;
        const sources = [...pending.values()];
        pending.clear();
        const filters = { predicate: (query: Query) => sources.some((source) => isUsageRead(query, source)) };
        await queries.cancelQueries(filters);
        if (active) await queries.invalidateQueries(filters, { cancelRefetch: false });
      }
    } finally { refreshing = false; }
  };
  const refresh = (source?: UsageSource) => {
    pending.set(JSON.stringify(source), source);
    if (!refreshing) void drain().catch(() => {});
  };
  const usage = panelUsageFor(klient);
  const subscription = klient.events.on('usage.settled', (source) => {
    if (!active) return;
    const session = source.sessionId === undefined ? undefined : usage.sessions.get(source.sessionId);
    if (session !== undefined) advanceSessionUsage(session, ++usage.sequence, source.agentId);
    refresh(source);
  });
  void subscription.ready.then(() => {
    if (!active) return;
    if (usage.attached) for (const session of usage.sessions.values()) advanceSessionUsage(session, ++usage.sequence);
    usage.attached = true;
    refresh();
  }).catch(() => {});
  return () => { active = false; subscription.dispose(); };
}
