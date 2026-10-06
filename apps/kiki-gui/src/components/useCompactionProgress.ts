import { useEffect, useState } from 'react';
import type { CompactionStartedEvent, CompactionCancelledEvent, CompactionCompletedEvent } from '@kiki/protocol';
import type { KikiClient } from '../lib/client';

export interface CompactionProgress {
  readonly source: 'manual' | 'auto';
  readonly phase: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  readonly reason?: string;
}

export type CompactionProgressEvent = CompactionStartedEvent | CompactionCancelledEvent | CompactionCompletedEvent;

export function applyCompactionProgress(current: CompactionProgress | undefined, event: CompactionProgressEvent): CompactionProgress | undefined {
  const source = event.trigger;
  if (source === undefined) return current?.phase === 'queued' ? current : undefined;
  if (current?.source === 'manual' && current.phase === 'queued' && source === 'auto') return current;
  if (event.type === 'compaction.started') return { source, phase: event.phase ?? 'running' };
  if (event.type === 'compaction.completed') return { source, phase: 'completed' };
  return { source, phase: event.reason === undefined ? 'cancelled' : 'failed', reason: event.reason };
}

export function useCompactionProgress(client: KikiClient, sessionId: string | undefined): CompactionProgress | undefined {
  const [progress, setProgress] = useState<CompactionProgress>();
  useEffect(() => {
    setProgress(undefined);
    if (sessionId === undefined) return;
    const events = client.klient.session(sessionId).agent('main').events;
    const update = (event: CompactionProgressEvent) => { setProgress((current) => applyCompactionProgress(current, event)); };
    const subscriptions = [
      events.on('compaction.started', update),
      events.on('compaction.completed', update),
      events.on('compaction.cancelled', update),
    ];
    for (const subscription of subscriptions) void subscription.ready.catch(() => undefined);
    return () => { for (const subscription of subscriptions) subscription.dispose(); };
  }, [client, sessionId]);
  return progress;
}
