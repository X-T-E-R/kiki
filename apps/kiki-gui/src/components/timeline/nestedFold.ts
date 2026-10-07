/**
 * Which nested subagents (a subagent's own subagents, and deeper) start
 * folded in this timeline view, and which of a dispatch's descendants start
 * open.
 *
 * A nested agent that had already finished when the view first saw it folds
 * to its one-line summary; one that is running, waiting on the user, or
 * failed never folds, and one that finishes while the view is open stays as
 * it was until the view is left. A click opens a folded one for the rest of
 * the view. The store lives as long as one timeline view (Transcript is keyed
 * per session and agent), so the main timeline and each subagent tab apply
 * the same rule on their own.
 *
 * A dispatch card's descendants split a second way, by which dispatch created
 * them (`groupDescendantsByDispatch`): the ones this dispatch provably created
 * lay out, and every other one — an earlier dispatch's, or one this cannot
 * place — folds into a single line the reader opens by hand. Folding hides
 * nothing and asserts nothing about age; it only keeps a whole subtree from
 * filling the timeline by default. That choice is the reader's for the rest
 * of the view — a later status update never writes over it.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';

/** Settled at first sight: these fold. Failures stay open so they are read. */
const FOLDS_AT_OPEN = new Set(['completed', 'cancelled']);

export class NestedFoldStore {
  private readonly firstSeen = new Map<string, string>();
  private readonly opened = new Set<string>();
  private readonly groupChoice = new Map<string, boolean>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  /** Record initial history; a resumed run stays expanded even after settling again. */
  see(agentId: string, status: string): void {
    if (!this.firstSeen.has(agentId) || !FOLDS_AT_OPEN.has(status)) this.firstSeen.set(agentId, status);
  }

  folded(agentId: string, status: string): boolean {
    if (this.opened.has(agentId)) return false;
    // Only a still-settled agent folds: one that was resumed reads as live.
    if (!FOLDS_AT_OPEN.has(status)) return false;
    return FOLDS_AT_OPEN.has(this.firstSeen.get(agentId) ?? status);
  }

  open(agentId: string): void {
    if (this.opened.has(agentId)) return;
    this.opened.add(agentId);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /**
   * Whether a dispatch's fold group is open. It starts closed, and once the
   * reader opens or closes it themselves that choice is the answer for the
   * rest of the view. Later status updates never write over it: a descendant
   * that starts running does not unfold a group the reader closed.
   */
  groupOpen(key: string): boolean {
    return this.groupChoice.get(key) ?? false;
  }

  /** Record the reader's own open/close for a dispatch's fold group. */
  setGroupOpen(key: string, open: boolean): void {
    if (this.groupChoice.get(key) === open) return;
    this.groupChoice.set(key, open);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  snapshot = (): number => this.version;
}

export const NestedFoldContext = createContext<NestedFoldStore | null>(null);

/**
 * Where a descendant of a dispatch card sits, relative to the dispatch being
 * shown. The names say only WHAT WE KNOW, never a story about it: a
 * descendant is `this-dispatch` when the record proves this dispatch created
 * it, and `other` in every other case — earlier, not from this dispatch, or
 * simply not knowable. Nothing is discarded either way; `other` is folded
 * behind one line the reader opens, not hidden.
 */
export type DescendantOrigin = 'this-dispatch' | 'other';

/**
 * The identity facts this rule reads. The two sides are deliberately different
 * kinds of fact, because the question has two different answers.
 */
export interface DispatchIdentity {
  readonly agentId: string;
  /**
   * When this agent was CREATED, ISO — written once at birth and never
   * re-stamped, unlike a run start, which a resume moves. Records written
   * before this field existed carry none, and then the descendant folds.
   */
  readonly createdAt?: string;
}

/**
 * The window of the ONE dispatch this card is showing: when this particular
 * run of the parent began, and when it ended if it has.
 *
 * This is deliberately NOT the parent's birth. A parent born at T10 whose
 * dispatch resumed at T40 still owns descendants born at T20, and comparing
 * those against T10 would wrongly expand them — which is the whole problem
 * this rule exists to solve. It is also not "whatever the parent's newest run
 * is": a card is a fixed dispatch, and the node's live run would drift onto
 * a later one and fold this card's own children out from under the reader.
 * When this card carries no run window, nothing can be placed.
 */
export interface DispatchWindow {
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly status?: string;
}

/**
 * The birth time of a record, when it carries a usable one. A record written
 * before birth times existed has none, and that is a missing fact rather than
 * an error: it simply cannot be placed.
 */
function birthTimeOf(record: { readonly createdAt?: unknown }): string | undefined {
  const birth = record.createdAt;
  return typeof birth === 'string' ? birth : undefined;
}

/** A run with no end yet cannot bound the dispatch window. */
function isLive(status: string | undefined): boolean {
  return status === 'running' || status === 'background' || status === 'suspended';
}

export interface DispatchGroups<T> {
  /** Proven to be created by this dispatch; laid out as cards. */
  readonly current: readonly T[];
  /** Everything else, in the forest's own order; carried by the fold group. */
  readonly other: readonly T[];
}

/**
 * Split a dispatch card's descendants into the ones this dispatch provably
 * created and everything else.
 *
 * The two sides answer different questions, and mixing them up is the bug
 * this rule exists to prevent. A DESCENDANT is placed by when it was born: an
 * immutable creation time, never its run start, because a resume re-stamps
 * that and would make an old descendant look new. The DISPATCH is placed by
 * the run window of the very dispatch being shown — not by the parent's birth,
 * which can predate every descendant on the card.
 *
 * Taken together: parent born T10, an old descendant born T20, the parent's
 * dispatch resuming at T40, that old descendant resuming again at T50. The
 * descendant's birth T20 falls before the dispatch window opens at T40, so it
 * folds no matter that it is running now and no matter that its own resume was
 * later than the dispatch. A child born at T60, after the window opened, is
 * this dispatch's.
 *
 * No clock and no duration threshold is involved: the only comparison is one
 * immutable birth time against one fixed run window. Where either is missing
 * — a legacy record with no birth, or a card with no run window — nothing is
 * claimed, and the descendant folds.
 */
export function groupDescendantsByDispatch<T>(
  dispatch: DispatchWindow,
  descendants: readonly (T & DispatchIdentity)[],
): DispatchGroups<T> {
  const current: T[] = [];
  const other: T[] = [];
  for (const descendant of descendants) {
    if (createdByDispatch(dispatch, descendant)) current.push(descendant);
    else other.push(descendant);
  }
  return { current, other };
}

/**
 * Whether a descendant's birth falls inside this dispatch's run window.
 *
 * Both facts must be present and comparable. The window's end bounds it when
 * the card's run has finished, so a descendant born after the card ended is
 * also not this card's. A boundary where the two values are equal, or where
 * the clock moved backwards, is not resolved by this rule: an equal pair and
 * an unorderable pair both fold, because "created at the same instant" is not
 * a fact either side can establish.
 *
 * Only a genuinely LIVE run may have an open upper bound. A card that has
 * settled, or whose status is simply unknown, has an end in reality: treating
 * its missing or unparseable end as "still running" would leave the window
 * open forever and let every descendant born after this dispatch fold into it,
 * which is precisely the historical expansion this rule exists to prevent. So
 * a settled or unknown card with no usable end cannot be bounded, and folds.
 */
export function createdByDispatch(dispatch: DispatchWindow, descendant: DispatchIdentity): boolean {
  const start = parseMs(dispatch.startedAt);
  if (start === undefined) return false;
  if (!isLive(dispatch.status) && parseMs(dispatch.endedAt) === undefined) return false;
  const end = isLive(dispatch.status) ? undefined : parseMs(dispatch.endedAt);
  const birth = parseMs(birthTimeOf(descendant));
  if (birth === undefined) return false;
  if (birth <= start) return false;
  if (end !== undefined && birth >= end) return false;
  return true;
}

/** Counts a fold group states on its own line, from live status alone. */
export interface FoldedDescendantCounts {
  readonly total: number;
  readonly running: number;
  readonly failed: number;
}

const RUNNING = new Set(['running', 'background', 'suspended']);

/**
 * What a fold group says about the descendants it holds: how many, and how
 * many of those still run or failed. Unknown status counts as neither, so the
 * numbers only ever claim what the records actually show.
 */
export function countFoldedDescendants(
  descendants: readonly { readonly status?: string }[],
): FoldedDescendantCounts {
  let running = 0;
  let failed = 0;
  for (const descendant of descendants) {
    if (descendant.status !== undefined && RUNNING.has(descendant.status)) running += 1;
    else if (descendant.status === 'failed') failed += 1;
  }
  return { total: descendants.length, running, failed };
}

function parseMs(value: string | undefined): number | undefined {
  const cleaned = value?.trim();
  if (cleaned === undefined || cleaned === '') return undefined;
  const ms = new Date(cleaned).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Whether this nested agent renders folded in the current view, and the
 * action that opens it. Outside a view (no provider) nothing folds.
 */
export function useNestedFold(agentId: string, status: string, nested: boolean): { folded: boolean; open: () => void } {
  const store = useContext(NestedFoldContext);
  useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.snapshot ?? zero, zero);
  if (store === null || !nested) return { folded: false, open: noop };
  store.see(agentId, status);
  return { folded: store.folded(agentId, status), open: () => { store.open(agentId); } };
}

/**
 * The fold group's open state for one dispatch, and the toggle that records
 * the reader's choice. Outside a view nothing is folded and the toggle is a
 * no-op, so the group renders closed without a store to hold it.
 */
export function useDispatchGroup(key: string | undefined): { open: boolean; toggle: () => void } {
  const store = useContext(NestedFoldContext);
  useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.snapshot ?? zero, zero);
  if (store === null || key === undefined) return { open: false, toggle: noop };
  return { open: store.groupOpen(key), toggle: () => { store.setGroupOpen(key, !store.groupOpen(key)); } };
}

const noop = (): void => {};
const zero = (): number => 0;
const noopSubscribe = (): (() => void) => noop;
