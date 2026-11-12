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

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueries } from '@tanstack/react-query';

import type { Session } from '@kiki/protocol';
import type { SessionController } from '@kiki/session-core/session';

import { buildActivityModel, type ActivityEntry, type ActivityModel } from '@kiki/session-core/sessions';
import { useI18n } from '../i18n';
import { useConnection, useOptionalControllerRegistry } from '../state/connection';

const noopSubscribe = () => () => {};

export function activityPollInterval(busyCount: number): number {
  if (busyCount <= 2) return 5_000;
  if (busyCount <= 5) return 10_000;
  return 15_000;
}

/**
 * `polling` false pauses the per-session prompt and task reads (the drawer
 * that shows them is closed); the model keeps building from the cached
 * answers, and the reads resume — at once, being stale — when it is true.
 */
export function useSessionActivity(sessions: readonly Session[], polling = true): {
  readonly model: ActivityModel;
  readonly byId: ReadonlyMap<string, ActivityEntry>;
  /**
   * Epoch ms a running main turn's clock counts from, or undefined. The
   * ticking belongs to whoever shows the number (`useElapsedSince`), so this
   * hook's owner — the whole session list — does not re-render every second
   * for as long as any session is working.
   */
  readonly anchorFor: (entry: ActivityEntry) => number | undefined;
} {
  const { client } = useConnection();
  const registry = useOptionalControllerRegistry();
  const { t } = useI18n();
  const untitled = t('sidebar.untitled');
  const subscribeLiveState = useCallback(
    (listener: () => void) => {
      if (registry === null) return noopSubscribe();
      const controllerUnsubs = new Map<SessionController, () => void>();

      const syncControllerSubscriptions = () => {
        const currentControllers = new Set<SessionController>();
        for (const controller of registry) {
          currentControllers.add(controller);
          if (!controllerUnsubs.has(controller)) {
            controllerUnsubs.set(controller, controller.subscribe(listener));
          }
        }
        for (const [controller, unsub] of controllerUnsubs) {
          if (!currentControllers.has(controller)) {
            unsub();
            controllerUnsubs.delete(controller);
          }
        }
      };

      syncControllerSubscriptions();

      const unsubRegistry = registry.subscribe(() => {
        syncControllerSubscriptions();
        listener();
      });

      return () => {
        unsubRegistry();
        for (const unsub of controllerUnsubs.values()) {
          unsub();
        }
        controllerUnsubs.clear();
      };
    },
    [registry],
  );

  const getLiveSnapshot = useCallback(() => {
    if (registry === null) return '';
    let snap = `${registry.snapshot()}:`;
    for (const controller of registry) {
      snap += `${controller.sessionId}=${controller.getState().queuedPromptIds.length};`;
    }
    return snap;
  }, [registry]);

  const liveSnapshot = useSyncExternalStore(
    subscribeLiveState,
    getLiveSnapshot,
    () => '',
  );

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
      enabled: polling,
    })),
  });
  const taskQueries = useQueries({
    queries: busyIds.map((sessionId) => ({
      queryKey: ['activity-tasks', sessionId],
      queryFn: () => client.listTasks(sessionId, { status: 'running' }).then((data) => data.items),
      refetchInterval: pollInterval,
      staleTime: pollInterval - 1_000,
      enabled: polling,
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
  }, [sessions, busyIds, promptQueries, taskQueries, untitled, registry, liveSnapshot]);

  // First-seen-busy anchors: the timer's fallback when the active prompt (and
  // its created_at) has not been fetched yet.
  // Kept in step during render rather than in an effect: a row reads its
  // anchor in the same pass that first shows it running, and nothing ticks
  // here any more to hand it one a moment later. Idempotent, so a repeated
  // render changes nothing.
  const anchorsRef = useRef(new Map<string, number>());
  const anchoredRunningRef = useRef<ActivityModel['running'] | null>(null);
  if (anchoredRunningRef.current !== model.running) {
    anchoredRunningRef.current = model.running;
    const anchors = anchorsRef.current;
    const runningIds = new Set(model.running.map((entry) => entry.sessionId));
    for (const id of runningIds) {
      if (!anchors.has(id)) anchors.set(id, Date.now());
    }
    for (const id of anchors.keys()) {
      if (!runningIds.has(id)) anchors.delete(id);
    }
  }

  const anchorFor = useCallback((entry: ActivityEntry): number | undefined => {
    if (!entry.mainTurnActive) return undefined;
    const anchor = entry.turnStartedAt !== undefined
      ? new Date(entry.turnStartedAt).getTime()
      : anchorsRef.current.get(entry.sessionId);
    return anchor !== undefined && !Number.isNaN(anchor) ? anchor : undefined;
  }, []);
  const byId = useMemo(
    () => new Map([...model.running, ...model.waiting].map((entry) => [entry.sessionId, entry])),
    [model.running, model.waiting],
  );
  return { model, byId, anchorFor };
}
