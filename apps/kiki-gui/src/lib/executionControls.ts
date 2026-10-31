/**
 * Session execution pause/resume — the GUI consumer of producer-965's
 * `session(id).execution` facade (klient SHA 4a8a24ebd).
 *
 * A pause never kills an in-flight step: the server persists the receipt,
 * settles the current step, then reports `paused`. Only a durably `paused`
 * phase means the session is safe to restart; `failed` keeps the server error
 * and waits for the user's explicit recovery action. There is no local pause
 * flag — the state always comes from `session.execution.read()`, with
 * `execution.changed` observations as the primary channel and a slow poll as
 * the reconnect fallback. One read feeds every control (row, pause-all,
 * paused overview); the event wins over a stale poll so a late response never
 * rolls the UI back. Repeated clicks never send a second request while one is
 * in flight; the idempotent operationId makes a safe retry return the same
 * receipt, and a fresh operation gets a fresh id once the previous one settled.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SessionEventPayloads } from '@kiki/klient';

import { useConnection } from '../state/connection';

export type ExecutionControlState = SessionEventPayloads['execution.changed'];
export type ExecutionPauseAgent = ExecutionControlState['agents'][number];
export type ExecutionPhase = ExecutionControlState['phase'];

const EXECUTION_KEY = 'session-execution';
/** Poll cadence: a reconnect/read-failure fallback only — events carry freshness. */
const EXECUTION_POLL_MS = 5000;
export function executionQueryKey(scopeId: string | undefined, sessionId: string): readonly unknown[] {
  return [EXECUTION_KEY, scopeId, sessionId] as const;
}

/**
 * The GUI's connection client is `KikiClient`: it wraps the klient as
 * `.klient`, so the execution facade and event hub live one level down. A
 * bare klient (tests, future consumers) is accepted too.
 */
function sessionHandleOf(client: unknown, sessionId: string) {
  const source = client as {
    session?: (id: string) => unknown;
    klient?: { session?: (id: string) => unknown };
  };
  const session = typeof source.klient?.session === 'function'
    ? source.klient.session(sessionId)
    : typeof source.session === 'function'
      ? source.session(sessionId)
      : undefined;
  return session as {
    execution?: import('@kiki/klient').SessionFacade['execution'];
    events?: import('@kiki/klient').KlientEvents<SessionEventPayloads>;
  } | undefined;
}

function executionOf(client: unknown, sessionId: string) {
  return sessionHandleOf(client, sessionId)?.execution;
}

function eventsOf(client: unknown, sessionId: string) {
  return sessionHandleOf(client, sessionId)?.events;
}

function newOperationId(prefix: string, sessionId: string): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${sessionId}:${random}`;
}

/** True when a session summary needs a detailed execution read. */
export function executionPhaseNeedsRead(phase: string | undefined): boolean {
  return phase !== undefined && phase !== 'running';
}

export interface ExecutionBatch {
  readonly states: Record<string, ExecutionControlState | undefined>;
  readonly anyAvailable: boolean;
  readonly resolved: boolean;
  /** A read failed (network/server, not "older server without the facade"). */
  readonly readError: unknown;
  readonly refetch: () => void;
}

/**
 * Live execution state of the given sessions. One batched read keeps the
 * shared `session-execution` cache; `execution.changed` observations push
 * freshness per session and stamp a per-session generation so a slower poll
 * response never overwrites a newer event. A session whose facade is absent
 * (an older server) is unavailable; a session whose read failed keeps its
 * last state and reports `readError` rather than flickering away.
 */
export function useSessionExecutions(
  sessionIds: readonly string[],
  options?: { readonly enabled?: boolean },
): ExecutionBatch {
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const joined = sessionIds.join('\n');
  const ids = useMemo(() => (joined === '' ? [] : joined.split('\n')), [joined]);
  const batchKey = useMemo(() => [EXECUTION_KEY, scopeId, 'batch', joined] as const, [scopeId, joined]);
  // Per-session freshness generation, bumped by an event. A poll response is
  // committed per session against the CURRENT cache at completion time, so a
  // slower read never rolls a newer event back — neither on success nor on a
  // read failure.
  const generations = useRef(new Map<string, number>());
  const lastReadError = useRef<unknown>(undefined);
  const bump = (sessionId: string) => {
    generations.current.set(sessionId, (generations.current.get(sessionId) ?? 0) + 1);
  };
  // Commit one session's state into the batch cache, but only if no event has
  // superseded the read that produced it.
  const commit = (sessionId: string, state: ExecutionControlState | null, readGeneration: number) => {
    if ((generations.current.get(sessionId) ?? 0) !== readGeneration) return;
    queryClient.setQueryData(batchKey, (current: Record<string, ExecutionControlState | null> | undefined) => ({
      ...(current ?? {}),
      [sessionId]: state,
    }));
  };

  const query = useQuery({
    queryKey: batchKey,
    queryFn: async (): Promise<Record<string, ExecutionControlState | null>> => {
      const started = new Map(ids.map((sessionId) => [sessionId, generations.current.get(sessionId) ?? 0]));
      let readFailure: unknown;
      await Promise.all(ids.map(async (sessionId) => {
        const execution = executionOf(client, sessionId);
        const readGeneration = started.get(sessionId) ?? 0;
        if (execution === undefined) { commit(sessionId, null, readGeneration); return; }
        try {
          const state = await execution.read();
          commit(sessionId, state, readGeneration);
        } catch (error) {
          readFailure = error;
          // On a read failure keep whatever the cache currently holds for this
          // session — including a newer event — instead of writing anything.
        }
      }));
      lastReadError.current = readFailure;
      // The batch cache is the source of truth; this return only satisfies the
      // query contract. Commits above already merged per session.
      return queryClient.getQueryData<Record<string, ExecutionControlState | null>>(batchKey) ?? {};
    },
    refetchInterval: EXECUTION_POLL_MS,
    retry: false,
    enabled: enabled && ids.length > 0,
    placeholderData: (previous) => previous,
  });

  // Per-session event observations are the primary freshness channel; an
  // unknown `execution.changed` event (older server) drops the observation and
  // the poll alone carries the state.
  useEffect(() => {
    if (!enabled || ids.length === 0) return;
    const observations: { dispose(): void }[] = [];
    for (const sessionId of ids) {
      const events = eventsOf(client, sessionId);
      const execution = executionOf(client, sessionId);
      if (events === undefined || execution === undefined) continue;
      try {
        observations.push(events.observe(
          { events: ['execution.changed'], read: () => execution.read() },
          (state) => {
            bump(sessionId);
            queryClient.setQueryData(batchKey, (current: Record<string, ExecutionControlState | null> | undefined) => ({
              ...(current ?? {}),
              [sessionId]: state,
            }));
            queryClient.setQueryData(executionQueryKey(scopeId, sessionId), state);
          },
        ));
      } catch {
        // observation unsupported — the poll keeps this session truthful
      }
    }
    return () => { for (const observation of observations) observation.dispose(); };
  }, [client, enabled, ids, batchKey, scopeId, queryClient]);

  const states = useMemo(() => {
    const data = query.data;
    if (data === undefined) return {};
    const out: Record<string, ExecutionControlState | undefined> = {};
    for (const [sessionId, state] of Object.entries(data)) {
      if (state !== null) out[sessionId] = state;
    }
    return out;
  }, [query.data]);
  const anyAvailable = query.data !== undefined && Object.values(query.data).some((state) => state !== null);
  const readError = query.isError ? query.error : lastReadError.current;
  return { states, anyAvailable, resolved: query.data !== undefined, readError, refetch: query.refetch };
}

/** Single-session convenience wrapper. */
export function useSessionExecution(sessionId: string | undefined, options?: { readonly enabled?: boolean }) {
  const ids = useMemo(() => (sessionId === undefined ? [] : [sessionId]), [sessionId]);
  const { states } = useSessionExecutions(ids, options);
  const state = sessionId === undefined ? undefined : states[sessionId];
  return { state, available: state !== undefined };
}

/**
 * Every session id the live inventory knows about, deduplicated: the full
 * per-agent inventory, not the visible page subset.
 */
export function liveInventorySessionIds(agents: readonly { readonly sessionId: string }[] | undefined): readonly string[] {
  if (agents === undefined) return [];
  return [...new Set(agents.map((agent) => agent.sessionId))];
}

/** One discovery page; the loop walks every page so a paused session past the first page is still found. */
const DISCOVERY_PAGE_LIMIT = 100;

/** True when a sessions.list RPC failure means "this server predates the index". */
function isUnsupportedSessionsRpc(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 40401;
}

/**
 * Sessions the cold summary projects a non-running execution for — the
 * restart-recovery discovery path. Walks the existing paginated session index
 * (`klient.global.sessions.list`) strictly OLDER page by page (the keyset
 * `nextCursor` is the page's last session id, passed as `before`), never
 * activates a session, and keeps only summaries whose `executionPhase` the
 * server projected as paused / pausing / resuming / failed.
 *
 * This is a triggered read, not a standing full scan: it runs on first mount,
 * on a reconnect, on a relevant session-list change (metaUpdated / archived /
 * workChanged), and on an explicit refresh — never on a wall-clock interval.
 * A pagination in flight when the component unmounts is abandoned. A genuine
 * read failure surfaces as `error`; a server that predates the index (RPC
 * 40401) reads as simply "no discovery support", not an error.
 */
export function usePausedSessionDiscovery(options?: { readonly enabled?: boolean }) {
  const { client, scopeId, wsStatus } = useConnection();
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const queryKey = useMemo(() => [EXECUTION_KEY, scopeId, 'paused-summaries'] as const, [scopeId]);
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<readonly string[]> => {
      const sessions = (client as { klient?: { global?: { sessions?: { list(query: unknown): Promise<{ items: readonly { id: string; executionPhase?: string }[]; nextCursor?: string }> } } } })
        .klient?.global?.sessions;
      if (sessions === undefined) return [];
      const found: string[] = [];
      let before: string | undefined;
      for (;;) {
        if (cancelled.current) return found;
        let page: { items: readonly { id: string; executionPhase?: string }[]; nextCursor?: string };
        try {
          page = await sessions.list({ includeArchived: true, limit: DISCOVERY_PAGE_LIMIT, ...(before === undefined ? {} : { before }) });
        } catch (error) {
          if (isUnsupportedSessionsRpc(error)) return found;
          throw error;
        }
        for (const item of page.items) {
          if (item.executionPhase !== undefined && item.executionPhase !== 'running') found.push(item.id);
        }
        if (page.nextCursor === undefined || page.items.length === 0) return found;
        before = page.nextCursor;
      }
    },
    retry: false,
    enabled,
  });

  // Trigger a re-read on a reconnect and on a relevant session-list change —
  // never on an interval.
  useEffect(() => {
    if (!enabled) return;
    const events = (client as { klient?: { events?: import('@kiki/klient').KlientEvents } }).klient?.events;
    if (events === undefined) return;
    const refresh = () => { if (!cancelled.current) void queryClient.invalidateQueries({ queryKey }); };
    const subscriptions = [
      events.on('session.metaUpdated', refresh),
      events.on('session.archived', refresh),
      events.on('session.workChanged', refresh),
    ];
    return () => { for (const subscription of subscriptions) subscription.dispose(); };
  }, [client, enabled, queryClient, queryKey]);

  // Reconnect: re-read once the socket is open again.
  useEffect(() => {
    if (enabled && wsStatus === 'open') void queryClient.invalidateQueries({ queryKey });
  }, [enabled, wsStatus, queryClient, queryKey]);

  return {
    sessionIds: query.data ?? [],
    resolved: query.data !== undefined,
    error: query.isError && !isUnsupportedSessionsRpc(query.error) ? query.error : undefined,
    refresh: query.refetch,
  };
}

export interface ExecutionAction {
  readonly available: boolean;
  readonly pending: boolean;
  readonly error: unknown;
  readonly run: () => void;
  readonly reset: () => void;
}

export interface ExecutionActionError {
  readonly failures: readonly { readonly sessionId: string; readonly error: unknown }[];
  readonly succeeded: readonly string[];
  readonly total: number;
  readonly kind: 'pause' | 'resume';
}

export function isExecutionActionError(error: unknown): error is ExecutionActionError {
  return typeof error === 'object' && error !== null && Array.isArray((error as ExecutionActionError).failures);
}

/**
 * One action hook shape shared by pause and resume. The operationId lives for
 * exactly one operation attempt: a network-uncertain retry replays the same id
 * (the server answers with its receipt), and once an attempt settles the id is
 * dropped so the next user action mints a fresh operation. Resume always reads
 * the session's current durably paused `pauseOperationId` from the state the
 * caller rendered — it never resumes a stale pause.
 */
function useExecutionAction(
  sessionIds: readonly string[],
  kind: 'pause' | 'resume',
  call: (execution: import('@kiki/klient').SessionFacade['execution'], sessionId: string, operationId: string) => Promise<ExecutionControlState>,
) {
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  // operationId per session for the CURRENT in-flight attempt only.
  const inFlight = useRef(new Map<string, string>());
  const joined = sessionIds.join('\n');
  const ids = useMemo(() => (joined === '' ? [] : joined.split('\n')), [joined]);
  const mutation = useMutation({
    mutationFn: async (): Promise<readonly { sessionId: string; state?: ExecutionControlState; error?: unknown }[]> => {
      return Promise.all(ids.map(async (sessionId) => {
        const execution = executionOf(client, sessionId);
        if (execution === undefined) return { sessionId, error: new Error('execution-unavailable') };
        // One in-flight attempt per session: reuse its id on retry; a new run
        // mints a new id. The id clears once the attempt settles either way.
        let operationId = inFlight.current.get(sessionId);
        if (operationId === undefined) {
          operationId = newOperationId(kind, sessionId);
          inFlight.current.set(sessionId, operationId);
        }
        try {
          const state = await call(execution, sessionId, operationId);
          inFlight.current.delete(sessionId);
          return { sessionId, state };
        } catch (error) {
          // Network-uncertain: keep the id so a retry replays the same receipt.
          // A definite server rejection (already held / not paused) also keeps
          // it — the next read re-derives whether a fresh attempt is valid.
          return { sessionId, error };
        }
      }));
    },
    onSuccess: (results) => {
      for (const result of results) {
        if (result.state !== undefined) {
          queryClient.setQueryData(executionQueryKey(scopeId, result.sessionId), result.state);
        }
      }
      // The batch read picks the new states up on its next tick; nudge it now.
      void queryClient.invalidateQueries({ queryKey: [EXECUTION_KEY, scopeId, 'batch'] });
    },
  });
  const failures = (mutation.data?.filter((result) => result.error !== undefined) ?? [])
    .map((result) => ({ sessionId: result.sessionId, error: result.error }));
  const succeeded = (mutation.data?.filter((result) => result.state !== undefined) ?? []).map((result) => result.sessionId);
  const actionError: ExecutionActionError | undefined = failures.length > 0
    ? { failures, succeeded, total: ids.length, kind }
    : undefined;
  return {
    available: ids.length > 0,
    pending: mutation.isPending,
    error: mutation.error ?? actionError,
    run: () => { if (!mutation.isPending) mutation.mutate(); },
    reset: mutation.reset,
  };
}

export function useExecutionPause(sessionIds: readonly string[]): ExecutionAction {
  const joined = sessionIds.join('\n');
  const ids = useMemo(() => (joined === '' ? [] : joined.split('\n')), [joined]);
  return useExecutionAction(ids, 'pause', (execution, _sessionId, operationId) => execution.pause({ operationId }));
}

/**
 * Resume needs each session's current durably paused operationId, so the
 * caller supplies the states it rendered; sessions not durably paused are
 * skipped rather than resumed implicitly.
 */
export function useExecutionResume(
  states: Readonly<Record<string, ExecutionControlState | undefined>>,
): ExecutionAction {
  const resumable = useMemo(
    () => Object.entries(states)
      .filter((entry): entry is [string, ExecutionControlState] => entry[1]?.phase === 'paused' && entry[1].pauseOperationId !== undefined)
      .map(([sessionId]) => sessionId),
    [states],
  );
  return useExecutionAction(resumable, 'resume', (execution, sessionId, operationId) =>
    execution.resume({ operationId, pauseOperationId: states[sessionId]!.pauseOperationId! }));
}

/**
 * One session's resume, for a row that must resume exactly its own session —
 * never every paused session the overview knows about.
 */
export function useExecutionResumeOne(sessionId: string, state: ExecutionControlState | undefined): ExecutionAction {
  const states = useMemo(() => ({ [sessionId]: state }), [sessionId, state]);
  return useExecutionResume(states);
}
