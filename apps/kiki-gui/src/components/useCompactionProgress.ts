import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompactionStartedEvent, CompactionCancelledEvent, CompactionCompletedEvent, CompactSessionResponse } from '@kiki/protocol';
import type { KikiClient } from '../lib/client';

export interface CompactionProgress {
  readonly source: 'manual' | 'auto';
  readonly phase: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  readonly reason?: string;
  /** The live event stream is detached; the phase comes from the last receipt or read and is re-checked. */
  readonly unconfirmed?: boolean;
}

export type CompactionProgressEvent = CompactionStartedEvent | CompactionCancelledEvent | CompactionCompletedEvent;

/** How long a detached, in-flight hint waits between re-reads of the engine state. */
export const COMPACTION_RECHECK_MS = 5_000;

export function applyCompactionProgress(current: CompactionProgress | undefined, event: CompactionProgressEvent): CompactionProgress | undefined {
  const source = event.trigger;
  if (source === undefined) return current?.phase === 'queued' ? current : undefined;
  if (current?.source === 'manual' && current.phase === 'queued' && source === 'auto') return current;
  if (event.type === 'compaction.started') return { source, phase: event.phase ?? 'running' };
  if (event.type === 'compaction.completed') return { source, phase: 'completed' };
  return { source, phase: event.reason === undefined ? 'cancelled' : 'failed', reason: event.reason };
}

function same(current: CompactionProgress | undefined, next: CompactionProgress): CompactionProgress {
  return current !== undefined && current.source === next.source && current.phase === next.phase
    && current.reason === next.reason && current.unconfirmed === next.unconfirmed ? current : next;
}

function inFlight(progress: CompactionProgress | undefined): progress is CompactionProgress {
  return progress?.phase === 'queued' || progress?.phase === 'running';
}

/**
 * Folds an engine read into the hint after events may have been missed. A
 * queue only exists while a turn still runs, so an idle, non-compacting agent
 * means the run ended unseen; the transcript marker carries its outcome.
 */
export function reconcileCompactionProgress(
  current: CompactionProgress | undefined,
  read: { readonly compacting: boolean; readonly turnRunning: boolean },
  attached: boolean,
): CompactionProgress | undefined {
  const unconfirmed = !attached || undefined;
  // Without a live event the source is unknown; 'auto' keeps the manual action
  // offered, and a refused second request answers with the duplicate notice.
  if (read.compacting) return same(current, { source: current?.source ?? 'auto', phase: 'running', unconfirmed });
  if (current?.phase === 'queued' && read.turnRunning) return same(current, { ...current, unconfirmed });
  return inFlight(current) ? undefined : current;
}

/** Seeds the hint from a manual-compaction receipt; a live event already ahead of it wins. */
export function seedCompactionProgress(current: CompactionProgress | undefined, receipt: CompactSessionResponse, attached: boolean): CompactionProgress | undefined {
  if (receipt.accepted === false || receipt.status === undefined) return current;
  if (current?.source === 'manual' && (current.phase === 'queued' || current.phase === 'running' || current.phase === 'completed')) return current;
  return { source: 'manual', phase: receipt.status, unconfirmed: !attached || undefined };
}

export interface CompactionProgressHandle {
  readonly progress: CompactionProgress | undefined;
  /** Record what a manual-compaction request answered, so the hint never depends on the event stream alone. */
  readonly seed: (receipt: CompactSessionResponse) => void;
}

export function useCompactionProgress(client: KikiClient, sessionId: string | undefined): CompactionProgressHandle {
  const [progress, setProgress] = useState<CompactionProgress>();
  const attachedRef = useRef(false);
  const recheckRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    setProgress(undefined);
    attachedRef.current = false;
    recheckRef.current = () => undefined;
    if (sessionId === undefined) return;
    const agent = client.klient.session(sessionId).agent('main');
    const events = agent.events;
    let active = true;
    let generation = 0;
    let subscriptions: { dispose(): void }[] = [];
    const update = (event: CompactionProgressEvent) => {
      if (!active) return;
      attachedRef.current = true;
      setProgress((current) => applyCompactionProgress(current, event));
    };
    const recheck = () => {
      const current = generation;
      void Promise.all([agent.isCompacting(), agent.getLoopStatus()]).then(([compacting, loop]) => {
        if (!active || current !== generation) return;
        setProgress((value) => reconcileCompactionProgress(value, { compacting, turnRunning: loop.state === 'running' }, attachedRef.current));
      }, () => undefined);
    };
    recheckRef.current = recheck;
    const attach = () => {
      generation += 1;
      const current = generation;
      for (const subscription of subscriptions) subscription.dispose();
      const next = [
        events.on('compaction.started', update),
        events.on('compaction.completed', update),
        events.on('compaction.cancelled', update),
      ];
      subscriptions = next;
      void Promise.all(next.map((subscription) => subscription.ready)).then(() => {
        if (!active || current !== generation) return;
        const wasDetached = !attachedRef.current;
        attachedRef.current = true;
        if (wasDetached) recheck();
      }, () => {
        if (!active || current !== generation) return;
        attachedRef.current = false;
        setProgress((value) => inFlight(value) ? { ...value, unconfirmed: true } : value);
      });
    };
    // A dropped socket rejects every attached source; re-listening waits for
    // the transport's restored subscription and then re-reads missed state.
    const errors = events.onError(() => {
      if (!active || !attachedRef.current) return;
      attachedRef.current = false;
      setProgress((value) => inFlight(value) ? { ...value, unconfirmed: true } : value);
      attach();
    });
    attach();
    return () => {
      active = false;
      generation += 1;
      errors.dispose();
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [client, sessionId]);
  useEffect(() => {
    if (progress?.phase !== 'completed') return;
    const timer = setTimeout(() => {
      setProgress((current) => current === progress ? undefined : current);
    }, 3_000);
    return () => { clearTimeout(timer); };
  }, [progress, client, sessionId]);
  const unconfirmed = progress?.unconfirmed === true && inFlight(progress);
  useEffect(() => {
    if (!unconfirmed) return;
    const timer = setInterval(() => { recheckRef.current(); }, COMPACTION_RECHECK_MS);
    return () => { clearInterval(timer); };
  }, [unconfirmed]);
  const seed = useCallback((receipt: CompactSessionResponse) => {
    setProgress((current) => seedCompactionProgress(current, receipt, attachedRef.current));
  }, []);
  return { progress, seed };
}
