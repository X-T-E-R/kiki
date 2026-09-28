/**
 * Activity data for the sidebar. The separate Activity block is retired: its
 * facts now ride the session rows (live turn clock, queued prompts, running
 * background tasks, waiting-on-you tag) and the Running / Needs me filters.
 * This hook keeps the one data source those surfaces read.
 *
 * Data: the polled session list (busy / pending_interaction) plus
 * per-busy-session /tasks queries. Queue depth for an open session comes from
 * the same queuedPromptIds selector QueueStrip uses; REST /prompts is only
 * the fallback for busy sessions that are not currently mounted.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueries } from '@tanstack/react-query';

import type { Session } from '@kiki/protocol';

import { buildActivityModel, type ActivityEntry, type ActivityModel } from '@kiki/session-core/sessions';
import { useI18n } from '../i18n';
import { useConnection, useOptionalControllerRegistry } from '../state/connection';

const noopSubscribe = () => () => {};

export function activityPollInterval(busyCount: number): number {
  if (busyCount <= 2) return 5_000;
  if (busyCount <= 5) return 10_000;
  return 15_000;
}

export function useSessionActivity(sessions: readonly Session[]): {
  readonly model: ActivityModel;
  readonly byId: ReadonlyMap<string, ActivityEntry>;
  /** Live elapsed ms for a running main turn, or undefined. */
  readonly elapsedFor: (entry: ActivityEntry) => number | undefined;
} {
  const { client } = useConnection();
  const registry = useOptionalControllerRegistry();
  const { t } = useI18n();
  const untitled = t('sidebar.untitled');
  const [liveQueuedRevision, setLiveQueuedRevision] = useState(0);
  const subscribeRegistry = useCallback(
    (listener: () => void) => (registry === null ? noopSubscribe() : registry.subscribe(listener)),
    [registry],
  );
  const registryGeneration = useSyncExternalStore(
    subscribeRegistry,
    () => registry?.snapshot() ?? 0,
    () => 0,
  );
  useEffect(() => {
    if (registry === null) return;
    const bump = () => {
      setLiveQueuedRevision((value) => value + 1);
    };
    const unsubscribers: Array<() => void> = [];
    for (const controller of registry) unsubscribers.push(controller.subscribe(bump));
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [registry, registryGeneration]);

  const busyIds = useMemo(
    () => sessions.filter((session) => session.busy).map((session) => session.id),
    [sessions],
  );
  // Keep the single-session cadence; spread requests when many turns are busy.
  const pollInterval = activityPollInterval(busyIds.length);
  const promptQueries = useQueries({
    queries: busyIds.map((sessionId) => ({
      queryKey: ['activity-prompts', sessionId],
      queryFn: () => client.listPrompts(sessionId),
      refetchInterval: pollInterval,
      staleTime: pollInterval - 1_000,
    })),
  });
  const taskQueries = useQueries({
    queries: busyIds.map((sessionId) => ({
      queryKey: ['activity-tasks', sessionId],
      queryFn: () => client.listTasks(sessionId, { status: 'running' }).then((data) => data.items),
      refetchInterval: pollInterval,
      staleTime: pollInterval - 1_000,
    })),
  });

  const model = useMemo(() => {
    const prompts = Object.fromEntries(
      busyIds.map((id, index) => [id, promptQueries[index]?.data]),
    );
    const tasks = Object.fromEntries(busyIds.map((id, index) => [id, taskQueries[index]?.data]));
    const liveQueuedCounts = Object.fromEntries(
      [...(registry ?? [])].map((controller) => [
        controller.sessionId,
        controller.getState().queuedPromptIds.length,
      ]),
    );
    return buildActivityModel({ sessions, prompts, tasks, untitled, liveQueuedCounts });
  }, [sessions, busyIds, promptQueries, taskQueries, untitled, registry, liveQueuedRevision, registryGeneration]);

  // First-seen-busy anchors: the timer's fallback when the active prompt (and
  // its created_at) has not been fetched yet.
  const anchorsRef = useRef(new Map<string, number>());
  useEffect(() => {
    const anchors = anchorsRef.current;
    const runningIds = new Set(model.running.map((entry) => entry.sessionId));
    for (const id of runningIds) {
      if (!anchors.has(id)) anchors.set(id, Date.now());
    }
    for (const id of anchors.keys()) {
      if (!runningIds.has(id)) anchors.delete(id);
    }
  }, [model.running]);

  const hasRunning = model.running.length > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunning) return;
    setNow(Date.now());
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [hasRunning]);

  const elapsedFor = (entry: ActivityEntry): number | undefined => {
    const anchor = entry.turnStartedAt !== undefined
      ? new Date(entry.turnStartedAt).getTime()
      : anchorsRef.current.get(entry.sessionId);
    return entry.mainTurnActive && anchor !== undefined && !Number.isNaN(anchor)
      ? Math.max(0, now - anchor)
      : undefined;
  };
  const byId = new Map([...model.running, ...model.waiting].map((entry) => [entry.sessionId, entry]));
  return { model, byId, elapsedFor };
}
