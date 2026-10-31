/**
 * Session execution pause/resume — the GUI consumer of producer-965's
 * `session(id).execution` facade (klient SHA 4a8a24ebd).
 *
 * A pause never kills an in-flight step: the server persists the receipt,
 * settles the current step, then reports `paused`. Only a durably `paused`
 * phase means the session is safe to restart; `failed` keeps the server error
 * and waits for the user's explicit retry. There is no local pause flag — the
 * state always comes from `session.execution.read()` (re-read on every
 * `execution.changed` event through `events.observe`, with a 1s poll as the
 * reconnect fallback). Repeated clicks never send a second request while one
 * is in flight; the idempotent operationId makes a safe retry return the same
 * receipt.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SessionEventPayloads } from '@kiki/klient';

import { useConnection } from '../state/connection';

export type ExecutionControlState = SessionEventPayloads['execution.changed'];
export type ExecutionPauseAgent = ExecutionControlState['agents'][number];
export type ExecutionPhase = ExecutionControlState['phase'];

const EXECUTION_KEY = 'session-execution';

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

/**
 * Live execution state of the given sessions: one read per session, kept in
 * the shared `session-execution` cache, refreshed every second, and pushed
 * fresh by `execution.changed` observations where the server exposes them.
 * A session whose facade is absent (an older server) is simply unavailable —
 * its controls hide rather than guessing a state.
 */
export function useSessionExecutions(
  sessionIds: readonly string[],
  options?: { readonly enabled?: boolean },
): { states: Record<string, ExecutionControlState | undefined>; anyAvailable: boolean; resolved: boolean } {
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const joined = sessionIds.join('\n');
  const ids = useMemo(() => (joined === '' ? [] : joined.split('\n')), [joined]);
  const batchKey = useMemo(() => [EXECUTION_KEY, scopeId, 'batch', joined] as const, [scopeId, joined]);

  const query = useQuery({
    queryKey: batchKey,
    queryFn: async (): Promise<Record<string, ExecutionControlState | null>> => {
      const next: Record<string, ExecutionControlState | null> = {};
      await Promise.all(ids.map(async (sessionId) => {
        const execution = executionOf(client, sessionId);
        if (execution === undefined) { next[sessionId] = null; return; }
        try {
          next[sessionId] = await execution.read();
        } catch {
          next[sessionId] = null;
        }
      }));
      return next;
    },
    refetchInterval: 1000,
    retry: false,
    enabled: enabled && ids.length > 0,
    placeholderData: (previous) => previous,
  });

  // Per-session event observations keep the cache fresh without waiting for
  // the poll; an unknown `execution.changed` event (older server) drops the
  // observation and the poll alone carries the state.
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
  // A server without the execution facade leaves every session null: the
  // batch itself is unavailable, so bulk controls hide rather than acting on
  // a subset the facade happens to answer for.
  const anyAvailable = query.data !== undefined && Object.values(query.data).some((state) => state !== null);
  return { states, anyAvailable, resolved: query.data !== undefined };
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

/**
 * Sessions the cold summary projects a non-running execution for — the
 * restart-recovery discovery path. Reads the existing paginated session index
 * (`klient.global.sessions.list`), never activates a session, and keeps only
 * summaries whose `executionPhase` the server projected as paused / pausing /
 * resuming / failed. An older server without the field returns no discovery.
 */
export function usePausedSessionDiscovery(options?: { readonly enabled?: boolean }) {
  const { client, scopeId } = useConnection();
  const enabled = options?.enabled ?? true;
  const query = useQuery({
    queryKey: [EXECUTION_KEY, scopeId, 'paused-summaries'],
    queryFn: async (): Promise<readonly string[]> => {
      const sessions = (client as { klient?: { global?: { sessions?: { list(query: unknown): Promise<{ items: readonly { id: string; executionPhase?: string }[] }> } } } })
        .klient?.global?.sessions;
      if (sessions === undefined) return [];
      const page = await sessions.list({ includeArchived: true, limit: 100 });
      return page.items
        .filter((item) => item.executionPhase !== undefined && item.executionPhase !== 'running')
        .map((item) => item.id);
    },
    refetchInterval: 1000,
    retry: false,
    enabled,
  });
  return { sessionIds: query.data ?? [], resolved: query.data !== undefined };
}

export interface ExecutionAction {
  readonly available: boolean;
  readonly pending: boolean;
  readonly error: unknown;
  readonly run: () => void;
  readonly reset: () => void;
}

/**
 * One action hook shape shared by pause and resume. The operationId is stable
 * per (action, session) on this client: a retried request replays the server's
 * receipt instead of starting a second operation, and a click while a request
 * is in flight is dropped by the button's disabled state.
 */
function useExecutionAction(
  sessionIds: readonly string[],
  kind: 'pause' | 'resume',
  call: (execution: import('@kiki/klient').SessionFacade['execution'], sessionId: string, operationId: string) => Promise<ExecutionControlState>,
) {
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const operationIdsRef = useRef(new Map<string, string>());
  const joined = sessionIds.join('\n');
  const ids = useMemo(() => (joined === '' ? [] : joined.split('\n')), [joined]);
  const mutation = useMutation({
    mutationFn: async (): Promise<readonly { sessionId: string; state?: ExecutionControlState; error?: unknown }[]> => {
      return Promise.all(ids.map(async (sessionId) => {
        const execution = executionOf(client, sessionId);
        if (execution === undefined) return { sessionId, error: new Error('execution-unavailable') };
        let operationId = operationIdsRef.current.get(sessionId);
        if (operationId === undefined) {
          operationId = newOperationId(kind, sessionId);
          operationIdsRef.current.set(sessionId, operationId);
        }
        try {
          return { sessionId, state: await call(execution, sessionId, operationId) };
        } catch (error) {
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
  const failures = mutation.data?.filter((result) => result.error !== undefined) ?? [];
  const succeeded = mutation.data?.filter((result) => result.state !== undefined) ?? [];
  return {
    available: ids.length > 0,
    pending: mutation.isPending,
    error: mutation.error ?? (failures.length > 0 ? { failures, succeeded, total: ids.length } : undefined),
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
