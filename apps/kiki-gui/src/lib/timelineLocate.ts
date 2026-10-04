/**
 * Timeline locate — the one entry point for "show me that place in the
 * conversation" (search hits, the usage drilldown, the Needs-you tray, the
 * notes tray, subagent jump-backs, opening an agent tab at its latest reply).
 *
 * Callers name WHAT they want (a block, a turn, a subagent card, an approval
 * or question record, an annotation, or the latest message); the mounted
 * Transcript that owns that agent's timeline resolves it against its own
 * virtualized rows — paging older history in, opening a folded run, scrolling
 * the virtualizer to an unmounted row — and reports back. Requests made
 * before the target Transcript mounts (a navigation that is still rendering)
 * wait for it for a bounded time instead of polling the DOM.
 */

import { detectLocale, LOCALE_STORAGE_KEY, translate, type I18nKey } from '@kiki/session-core/i18n';

import { pushToast } from './toasts';

export type TimelineTarget =
  | { readonly kind: 'block'; readonly blockId: string }
  | { readonly kind: 'turn'; readonly turnId: string }
  | { readonly kind: 'subagent'; readonly agentId: string }
  | { readonly kind: 'interaction'; readonly id: string }
  | { readonly kind: 'annotation'; readonly annotationId: string; readonly blockId: string }
  /**
   * The newest message. `respectReader` leaves a reader who scrolled up
   * where they are (opening an agent tab); without it the jump always lands.
   */
  | { readonly kind: 'latest'; readonly respectReader?: boolean };

export type LocateOutcome =
  | { readonly status: 'found' }
  | { readonly status: 'kept' }
  | { readonly status: 'not-found' }
  | { readonly status: 'load-failed' }
  | { readonly status: 'no-timeline' };

/** What a mounted Transcript registers for its (session, agent). */
export interface TimelineLocator {
  /** False while the timeline is hidden (inactive tab, collapsed panel). */
  readonly isVisible: () => boolean;
  readonly locate: (target: TimelineTarget, options?: { readonly signal?: AbortSignal }) => Promise<LocateOutcome>;
  /** True only while the reader is still at this explicit target (not merely its URL). */
  readonly isAtTarget?: (target: TimelineTarget) => boolean;
}

export interface LocateOptions {
  readonly sessionId: string;
  readonly agentId?: string;
  /** Toast on failure (default true). */
  readonly notify?: boolean;
  /** How long to wait for the timeline to mount and become visible. */
  readonly waitMs?: number;
  /** Cancel stale visits without emitting a failure toast. Never serialized. */
  readonly signal?: AbortSignal;
}

const DEFAULT_WAIT_MS = 4000;
const locators = new Map<string, TimelineLocator[]>();
const waiters = new Map<string, Set<() => void>>();

function keyOf(sessionId: string, agentId: string): string {
  return `${sessionId}\0${agentId}`;
}

/** Mount-time registration; returns the unregister. */
export function registerTimelineLocator(
  sessionId: string,
  agentId: string,
  locator: TimelineLocator,
): () => void {
  const key = keyOf(sessionId, agentId);
  const list = locators.get(key) ?? [];
  list.push(locator);
  locators.set(key, list);
  notifyWaiters(key);
  return () => {
    const current = locators.get(key);
    if (current === undefined) return;
    const next = current.filter((candidate) => candidate !== locator);
    if (next.length === 0) locators.delete(key);
    else locators.set(key, next);
  };
}

/** A registered timeline became visible (tab shown); wake pending requests. */
export function timelineBecameVisible(sessionId: string, agentId: string): void {
  notifyWaiters(keyOf(sessionId, agentId));
}

function notifyWaiters(key: string): void {
  for (const wake of waiters.get(key) ?? []) wake();
}

function visibleLocators(key: string): TimelineLocator[] {
  return (locators.get(key) ?? []).filter((locator) => locator.isVisible()).reverse();
}

function waitForVisible(key: string, waitMs: number, signal?: AbortSignal): Promise<TimelineLocator[]> {
  if (signal?.aborted) return Promise.resolve([]);
  const ready = visibleLocators(key);
  if (ready.length > 0) return Promise.resolve(ready);
  return new Promise((resolve) => {
    let settled = false;
    let frame: number | null = null;
    const finish = (value: TimelineLocator[]) => {
      if (settled) return;
      settled = true;
      waiters.get(key)?.delete(check);
      if (frame !== null) cancelAnimationFrame(frame);
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    // Visibility has no event of its own (a tab un-hides by a class flip),
    // so a waiting request also re-checks once per frame.
    const check = () => {
      const found = visibleLocators(key);
      if (found.length > 0) finish(found);
    };
    const tick = () => {
      check();
      if (!settled) frame = requestAnimationFrame(tick);
    };
    const set = waiters.get(key) ?? new Set();
    set.add(check);
    waiters.set(key, set);
    frame = requestAnimationFrame(tick);
    const timer = setTimeout(() => { finish([]); }, waitMs);
    const abort = () => { finish([]); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function currentLocale() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    stored = null;
  }
  return detectLocale({
    stored,
    navigatorLanguage: typeof navigator === 'undefined' ? null : navigator.language,
  });
}

function failureKey(target: TimelineTarget, outcome: LocateOutcome): I18nKey | undefined {
  if (outcome.status === 'found' || outcome.status === 'kept') return undefined;
  if (outcome.status === 'load-failed') return 'locate.failedLoad';
  if (target.kind === 'latest') return undefined;
  return target.kind === 'turn' ? 'locate.turnNotFound' : 'locate.notFound';
}

function turnLabel(turnId: string): string {
  return turnId.startsWith('t') ? turnId.slice(1) : turnId;
}

/**
 * Locate a place in a session's timeline. Resolves once the timeline has
 * scrolled there (or reported why it could not); failures toast unless
 * `notify: false`.
 */
export async function locateInTimeline(target: TimelineTarget, options: LocateOptions): Promise<LocateOutcome> {
  const key = keyOf(options.sessionId, options.agentId ?? 'main');
  const ready = await waitForVisible(key, options.waitMs ?? DEFAULT_WAIT_MS, options.signal);
  let outcome: LocateOutcome = { status: 'no-timeline' };
  if (options.signal?.aborted) return outcome;
  try {
    if (target.kind === 'latest') {
      // Every visible copy of this agent's timeline lands (routed view + tab).
      const results = await Promise.all(ready.map((locator) => locator.locate(target, { signal: options.signal })));
      outcome = results[0] ?? outcome;
    } else if (ready[0] !== undefined) {
      outcome = await ready[0].locate(target, { signal: options.signal });
    }
  } catch {
    outcome = { status: 'load-failed' };
  }
  if (options.signal?.aborted) return { status: 'no-timeline' };
  const key18n = failureKey(target, outcome.status === 'no-timeline' ? { status: 'not-found' } : outcome);
  if (options.notify !== false && key18n !== undefined) {
    const turn = target.kind === 'turn' ? turnLabel(target.turnId) : '';
    pushToast({
      tone: outcome.status === 'load-failed' ? 'error' : 'info',
      text: translate(currentLocale(), key18n, { turn }),
    });
  }
  return outcome;
}

/** `/s/{id}?turn=3` and search hits carry bare ordinals; rows carry `t3`. */
export function normalizeTurnId(turn: string | number): string {
  const raw = String(turn).trim();
  return raw.startsWith('t') ? raw : `t${raw}`;
}

/** Stable identity of a locate target: dedupe repeats without comparing URLs. */
export function timelineTargetKey(target: TimelineTarget): string {
  switch (target.kind) {
    case 'block': return JSON.stringify(['block', target.blockId]);
    case 'turn': return JSON.stringify(['turn', normalizeTurnId(target.turnId)]);
    case 'subagent': return JSON.stringify(['subagent', target.agentId]);
    case 'interaction': return JSON.stringify(['interaction', target.id]);
    case 'annotation': return JSON.stringify(['annotation', target.annotationId, target.blockId]);
    case 'latest': return JSON.stringify(['latest', target.respectReader === true]);
  }
}

/** True only while the reader is still exactly at this target (geometry, not URL). */
export function isTimelineTargetCurrent(target: TimelineTarget, options: LocateOptions): boolean {
  return visibleLocators(keyOf(options.sessionId, options.agentId ?? 'main'))[0]?.isAtTarget?.(target) === true;
}

/**
 * Where a child's 派发处 lives: the parent agent's timeline plus the card that
 * spawned this child. A nested child's card sits on its parent's page, not the
 * main session's, so both the route and the locate scope name the parent.
 */
export function locateSpawnTarget(sessionId: string, childAgentId: string, parentAgentId = 'main'): {
  route: string; target: TimelineTarget; options: LocateOptions;
} {
  const base = `/s/${encodeURIComponent(sessionId)}`;
  return {
    route: parentAgentId === 'main' ? base : `${base}/agent/${encodeURIComponent(parentAgentId)}`,
    target: { kind: 'subagent', agentId: childAgentId },
    options: { sessionId, agentId: parentAgentId },
  };
}

/** Test-only: drop every registration and pending request. */
export function resetTimelineLocatorsForTests(): void {
  locators.clear();
  waiters.clear();
}
