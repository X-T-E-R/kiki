/**
 * ActivityPanel — the sidebar's collapsible "what is happening globally"
 * region, pinned between the search box and the session list. The summary
 * line is always visible while anything runs or waits; expanding lists every
 * busy session with its live turn timer, current-prompt preview, queue depth,
 * and running background-task count, plus pending sessions whose turn ended
 * unanswered. Every row jumps to its session.
 *
 * Data: the polled session list (`busy` / `pending_interaction`) plus
 * per-busy-session `/tasks` queries. Queue depth for an open session comes from
 * the same `queuedPromptIds` selector QueueStrip uses; REST `/prompts` is only
 * the fallback for busy sessions that are not currently mounted.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueries } from '@tanstack/react-query';

import type { Session } from '@kiki/protocol';

import { buildActivityModel, formatElapsedClock, type ActivityEntry } from '@kiki/session-core/sessions';
import { useI18n } from '../i18n';
import { useConnection, useOptionalControllerRegistry } from '../state/connection';
import { useGuardedNavigate } from './dirtyGuard';

const OPEN_STORAGE_KEY = 'kiki.activity.open';
const noopSubscribe = () => () => {};

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0');
  } catch {
    // Private mode — the toggle still works for the session.
  }
}

function WaitingChip({ kind }: { kind: 'approval' | 'question' }) {
  const { t } = useI18n();
  return (
    <span className="shrink-0 rounded-full border border-amber-rule/40 bg-amber-card px-1.5 py-px text-[9px] font-medium text-amber-ink">
      {kind === 'approval' ? t('pending.kind.approval') : t('pending.kind.question')}
    </span>
  );
}

function RunningRow({
  entry,
  elapsed,
  onOpen,
}: {
  entry: ActivityEntry;
  /** Live elapsed ms, or undefined when the turn start is unknown. */
  elapsed: number | undefined;
  onOpen: () => void;
}) {
  const { t, tp } = useI18n();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-panel"
    >
      <span className="status-dot-busy mt-[5px] block h-2 w-2 shrink-0 rounded-full bg-accent" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[12px] font-medium text-ink">{entry.title}</span>
          {elapsed !== undefined ? (
            <span
              className="ml-auto shrink-0 font-mono text-[10px] font-semibold text-accent tabular-nums"
              title={t('activity.turnTitle', { elapsed: formatElapsedClock(elapsed) })}
            >
              {formatElapsedClock(elapsed)}
            </span>
          ) : (
            <span className="ml-auto shrink-0 text-[9.5px] text-ink-faint">
              {t('activity.background')}
            </span>
          )}
        </span>
        {entry.promptPreview !== undefined ? (
          <span className="mt-px block truncate text-[10.5px] text-ink-faint" title={entry.promptPreview}>
            {entry.promptPreview}
          </span>
        ) : null}
        {entry.queuedCount > 0 || entry.runningTaskCount > 0 || entry.pendingInteraction !== 'none' ? (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {entry.pendingInteraction !== 'none' ? <WaitingChip kind={entry.pendingInteraction} /> : null}
            {entry.queuedCount > 0 ? (
              <span className="shrink-0 rounded-full border border-amber-rule/40 bg-amber-card px-1.5 py-px text-[9px] font-medium text-amber-ink">
                {tp('activity.queueChip', entry.queuedCount)}
              </span>
            ) : null}
            {entry.runningTaskCount > 0 ? (
              <span className="shrink-0 rounded-full border border-hairline bg-panel px-1.5 py-px text-[9px] font-medium text-ink-soft">
                {tp('activity.taskChip', entry.runningTaskCount)}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function WaitingRow({ entry, onOpen }: { entry: ActivityEntry; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-panel"
    >
      <span className="block h-2 w-2 shrink-0 rounded-full bg-amber-rule shadow-[0_0_0_2px_rgba(232,176,75,0.25)]" />
      {entry.pendingInteraction !== 'none' ? <WaitingChip kind={entry.pendingInteraction} /> : null}
      <span className="min-w-0 truncate text-[12px] text-ink">{entry.title}</span>
    </button>
  );
}

export function activityPollInterval(busyCount: number): number {
  if (busyCount <= 2) return 5_000;
  if (busyCount <= 5) return 10_000;
  return 15_000;
}

export function ActivityPanel({ sessions }: { sessions: readonly Session[] }) {
  const { client } = useConnection();
  const registry = useOptionalControllerRegistry();
  const { t, tp } = useI18n();
  const navigate = useGuardedNavigate();
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
      queryFn: () => client.listTasks(sessionId).then((data) => data.items),
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

  const [open, setOpen] = useState(readOpen);
  const toggle = () => {
    setOpen((value) => {
      writeOpen(!value);
      return !value;
    });
  };

  if (!hasRunning && model.waiting.length === 0) return null;

  const segments = [
    hasRunning ? tp('activity.runningCount', model.running.length) : undefined,
    model.waiting.length > 0 ? tp('activity.waitingCount', model.waiting.length) : undefined,
    model.queuedTotal > 0 ? tp('activity.queuedCount', model.queuedTotal) : undefined,
    model.runningTaskTotal > 0 ? tp('activity.tasksCount', model.runningTaskTotal) : undefined,
  ]
    .filter((segment) => segment !== undefined)
    .join(' · ');

  const openSession = (sessionId: string) => void navigate(`/s/${sessionId}`);

  return (
    <section data-activity-panel className="mx-1 mb-1 rounded-xl border border-hairline bg-paper">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={t(open ? 'activity.collapseAria' : 'activity.expandAria')}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-panel/60 ${open ? 'rounded-t-xl' : 'rounded-xl'}`}
      >
        <span className="status-dot-busy block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[10.5px] font-semibold tracking-[0.04em] text-ink-soft uppercase">
            {t('activity.toggle')}
          </span>
          <span className="mt-px block font-mono text-[9.5px] font-medium tabular-nums text-ink-faint">
            {segments}
          </span>
        </span>
        <span aria-hidden className={`shrink-0 text-[10px] text-ink-faint transition-transform ${open ? '' : '-rotate-90'}`}>
          ▾
        </span>
      </button>
      {open ? (
        <div className="border-t border-hairline px-1 py-1">
          {hasRunning ? (
            <>
              <p className="px-2.5 pt-0.5 pb-0.5 text-[9px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
                {t('activity.running')}
              </p>
              {model.running.map((entry) => {
                const anchor =
                  entry.turnStartedAt !== undefined
                    ? new Date(entry.turnStartedAt).getTime()
                    : anchorsRef.current.get(entry.sessionId);
                const elapsed =
                  entry.mainTurnActive && anchor !== undefined && !Number.isNaN(anchor)
                    ? Math.max(0, now - anchor)
                    : undefined;
                return (
                  <RunningRow
                    key={entry.sessionId}
                    entry={entry}
                    elapsed={elapsed}
                    onOpen={() => { openSession(entry.sessionId); }}
                  />
                );
              })}
            </>
          ) : null}
          {model.waiting.length > 0 ? (
            <>
              <p className="px-2.5 pt-1 pb-0.5 text-[9px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
                {t('activity.waiting')}
              </p>
              {model.waiting.map((entry) => (
                <WaitingRow
                  key={entry.sessionId}
                  entry={entry}
                  onOpen={() => { openSession(entry.sessionId); }}
                />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
