import { describe, expect, it } from 'vitest';
import { agentChildren, buildAgentForest, rosterFromTranscriptAgents } from '@kiki/session-core/session';
import {
  NestedFoldStore,
  countFoldedDescendants,
  groupDescendantsByDispatch,
  type DispatchIdentity,
  type DispatchWindow,
} from './nestedFold';

describe('NestedFoldStore', () => {
  it('folds settled subagents (completed, cancelled) at first sight', () => {
    const store = new NestedFoldStore();
    store.see('agent-completed', 'completed');
    store.see('agent-cancelled', 'cancelled');

    expect(store.folded('agent-completed', 'completed')).toBe(true);
    expect(store.folded('agent-cancelled', 'cancelled')).toBe(true);
  });

  it('never folds live or failed subagents at first sight', () => {
    const store = new NestedFoldStore();
    store.see('agent-running', 'running');
    store.see('agent-background', 'background');
    store.see('agent-suspended', 'suspended');
    store.see('agent-failed', 'failed');
    store.see('agent-unknown', 'unknown');

    expect(store.folded('agent-running', 'running')).toBe(false);
    expect(store.folded('agent-background', 'background')).toBe(false);
    expect(store.folded('agent-suspended', 'suspended')).toBe(false);
    expect(store.folded('agent-failed', 'failed')).toBe(false);
    expect(store.folded('agent-unknown', 'unknown')).toBe(false);
  });

  it('keeps a subagent expanded if it was running when first seen and finished later', () => {
    const store = new NestedFoldStore();
    // First sight: subagent is running
    store.see('agent-live', 'running');
    expect(store.folded('agent-live', 'running')).toBe(false);

    // Later: subagent completes while the view is still open
    store.see('agent-live', 'completed'); // subsequent see() calls are ignored
    expect(store.folded('agent-live', 'completed')).toBe(false);
  });

  it('does not re-fold a historical agent that resumes and completes in this view', () => {
    const store = new NestedFoldStore();
    store.see('resumed', 'completed');
    expect(store.folded('resumed', 'completed')).toBe(true);
    store.see('resumed', 'running');
    expect(store.folded('resumed', 'running')).toBe(false);
    store.see('resumed', 'completed');
    expect(store.folded('resumed', 'completed')).toBe(false);
  });

  it('permanently unfolds when open() is called', () => {
    const store = new NestedFoldStore();
    store.see('agent-done', 'completed');
    expect(store.folded('agent-done', 'completed')).toBe(true);

    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    store.open('agent-done');
    expect(notified).toBe(1);
    expect(store.folded('agent-done', 'completed')).toBe(false);

    // Idempotent
    store.open('agent-done');
    expect(notified).toBe(1);

    unsubscribe();
  });

  it('keeps a fold group closed until the reader opens it, and keeps their choice', () => {
    const store = new NestedFoldStore();
    expect(store.groupOpen('agent-1')).toBe(false);

    let notified = 0;
    const unsubscribe = store.subscribe(() => { notified += 1; });
    store.setGroupOpen('agent-1', true);
    expect(notified).toBe(1);
    expect(store.groupOpen('agent-1')).toBe(true);

    // Re-reading the same state must not repaint the timeline.
    store.setGroupOpen('agent-1', true);
    expect(notified).toBe(1);

    // A later status update carries no opinion here: the reader's close wins.
    store.see('agent-1', 'running');
    expect(store.groupOpen('agent-1')).toBe(true);
    expect(notified).toBe(1);
    store.setGroupOpen('agent-1', false);
    expect(store.groupOpen('agent-1')).toBe(false);
    expect(notified).toBe(2);

    unsubscribe();
  });

  it('holds a reader choice per dispatch, so one card cannot answer for another', () => {
    const store = new NestedFoldStore();
    store.setGroupOpen('agent-1', true);
    expect(store.groupOpen('agent-2')).toBe(false);
  });

  it('keeps two dispatches of the same agent independent, and stable across reads', () => {
    // The key identifies the CALL that dispatched the card, not the agent:
    // a resumed agent has two cards, and each carries its own choice.
    const older = 'call-lead-1';
    const newer = 'call-lead-2';
    const store = new NestedFoldStore();
    store.setGroupOpen(older, true);
    expect(store.groupOpen(older)).toBe(true);
    expect(store.groupOpen(newer)).toBe(false);

    // Re-reading the same key keeps it open: a rerender must not close it.
    store.see('agent-lead', 'running');
    expect(store.groupOpen(older)).toBe(true);
    expect(store.groupOpen(newer)).toBe(false);

    store.setGroupOpen(older, false);
    expect(store.groupOpen(older)).toBe(false);
    expect(store.groupOpen(newer)).toBe(false);
  });
});

const T = (secondsFromTenOClock: number): string =>
  new Date(Date.parse('2026-10-07T10:00:00.000Z') + secondsFromTenOClock * 1000).toISOString();

/** A dispatch card's own run window: when this particular run began and ended. */
function card(startedAt?: string, endedAt?: string, status = 'running'): DispatchWindow {
  return { startedAt, endedAt, status };
}

function born(agentId: string, createdAt?: string): DispatchIdentity & { agentId: string } {
  return { agentId, createdAt };
}

const ids = (group: readonly { readonly agentId: string }[]): string[] => group.map((entry) => entry.agentId);

describe('groupDescendantsByDispatch', () => {
  it('lays out a descendant born after the card’s run began, and folds the rest', () => {
    const groups = groupDescendantsByDispatch(card(T(40)), [born('old', T(20)), born('new', T(60))]);
    expect(ids(groups.current)).toEqual(['new']);
    expect(ids(groups.other)).toEqual(['old']);
  });

  it('folds an old descendant whose own resume is later than the card’s dispatch', () => {
    // The counterexample this rule exists for. The parent was born at T10 and
    // owns a descendant born at T20, so comparing the descendant's birth
    // against the PARENT'S birth would expand it. But this card is the
    // parent's dispatch at T40, and T20 falls before that window, so it folds
    // — even though the descendant is running again right now, resumed at T50,
    // which is later than the dispatch. Neither its liveness nor its newer
    // run start may promote it.
    const groups = groupDescendantsByDispatch(card(T(40)), [born('old', T(20))]);
    expect(ids(groups.other)).toEqual(['old']);
    expect(groups.current).toEqual([]);
  });

  it('uses canonical descriptor birth after a resumed live run reaches the forest', () => {
    const roster = rosterFromTranscriptAgents([
      { agentId: 'lead', parentAgentId: 'main', createdAt: T(10) },
      { agentId: 'old', parentAgentId: 'lead', createdAt: T(20) },
      { agentId: 'new', parentAgentId: 'lead', createdAt: T(60) },
      { agentId: 'legacy', parentAgentId: 'lead' },
    ]);
    const forest = buildAgentForest([
      { subagentId: 'old', name: 'Old', parentAgentId: 'lead', status: 'running', startedAt: T(50) },
      { subagentId: 'new', name: 'New', parentAgentId: 'lead', status: 'running', startedAt: T(70) },
      { subagentId: 'legacy', name: 'Legacy', parentAgentId: 'lead', status: 'running', startedAt: T(80) },
    ], roster);
    const groups = groupDescendantsByDispatch(card(T(40)), agentChildren(forest, 'lead'));
    expect(ids(groups.current)).toEqual(['new']);
    expect(new Set(ids(groups.other))).toEqual(new Set(['old', 'legacy']));
    expect(forest.byId['old']).toMatchObject({ createdAt: T(20), startedAt: T(50) });
    expect(forest.byId['legacy']?.createdAt).toBeUndefined();
  });

  it('lays out a descendant born after the dispatch began and resumed since', () => {
    const groups = groupDescendantsByDispatch(card(T(40)), [born('new', T(60))]);
    expect(ids(groups.current)).toEqual(['new']);
  });

  it('folds a descendant born after the card’s run had already ended', () => {
    const groups = groupDescendantsByDispatch(card(T(40), T(50), 'completed'), [born('later', T(60))]);
    expect(ids(groups.other)).toEqual(['later']);
    expect(groups.current).toEqual([]);
  });

  it('places a descendant born one millisecond after the dispatch inside it', () => {
    const after = new Date(Date.parse(T(40)) + 1).toISOString();
    expect(groupDescendantsByDispatch(card(T(40)), [born('child', after)]).current).toHaveLength(1);
  });

  it('folds a descendant born one millisecond before the dispatch, and one born at the same instant', () => {
    const before = new Date(Date.parse(T(40)) - 1).toISOString();
    const groups = groupDescendantsByDispatch(card(T(40)), [born('before', before), born('same', T(40))]);
    expect(groups.current).toEqual([]);
    expect(ids(groups.other)).toEqual(['before', 'same']);
  });

  it('folds a descendant born in the same millisecond the card’s run ended', () => {
    const groups = groupDescendantsByDispatch(card(T(40), T(50), 'completed'), [born('same', T(50))]);
    expect(ids(groups.other)).toEqual(['same']);
  });

  it('folds a descendant born in the same millisecond the card’s run began', () => {
    // A zero-width instant is not evidence of anything: the two writes may
    // have happened in either order, so this claim is not made.
    const groups = groupDescendantsByDispatch(card(T(40)), [born('same', T(40))]);
    expect(ids(groups.other)).toEqual(['same']);
  });

  it('folds a descendant born after a settled card whose end is unknown', () => {
    // The card ran at T40 and has settled, but its end is missing. Leaving the
    // window open because "there is no end" would swallow a descendant born at
    // T60, from a later dispatch entirely. A settled run has an end in reality,
    // so an unknown one is not a licence to stay open.
    const groups = groupDescendantsByDispatch(card(T(40), undefined, 'completed'), [born('later', T(60))]);
    expect(ids(groups.other)).toEqual(['later']);
    expect(groups.current).toEqual([]);
  });

  it('folds a descendant born after a card whose status is unknown', () => {
    // Same rule when the status itself is unknown: only a genuinely live run
    // may have an open upper bound.
    const groups = groupDescendantsByDispatch(card(T(40), undefined, 'unknown'), [born('later', T(60))]);
    expect(ids(groups.other)).toEqual(['later']);
  });

  it('folds a descendant born after a settled card whose end is unparseable', () => {
    const groups = groupDescendantsByDispatch(card(T(40), 'not-a-timestamp', 'completed'), [born('later', T(60))]);
    expect(ids(groups.other)).toEqual(['later']);
  });

  it('folds everything when the card carries no run window', () => {
    // An unknown dispatch is not the same fact as an unknown birth, and
    // neither is a licence to expand.
    const groups = groupDescendantsByDispatch(card(undefined, undefined, 'running'), [
      born('a', T(60)),
      born('b', T(20)),
    ]);
    expect(groups.current).toEqual([]);
    expect(ids(groups.other)).toEqual(['a', 'b']);
  });

  it('does not treat a live card’s missing end as a zero-width window', () => {
    const groups = groupDescendantsByDispatch(card(T(40), undefined, 'running'), [born('new', T(60))]);
    expect(ids(groups.current)).toEqual(['new']);
  });

  it('ignores an end time on a card that is still running', () => {
    // A live run has no end; a stale one must not close the window early.
    const groups = groupDescendantsByDispatch(card(T(40), T(45), 'running'), [born('new', T(60))]);
    expect(ids(groups.current)).toEqual(['new']);
  });

  it('folds a descendant with no birth time at all', () => {
    const groups = groupDescendantsByDispatch(card(T(40)), [born('legacy'), born('bad', 'not-a-timestamp'), born('blank', '  ')]);
    expect(groups.current).toEqual([]);
    expect(ids(groups.other)).toEqual(['legacy', 'bad', 'blank']);
  });

  it('never expands from a run start, an agent id, or a later resume', () => {
    // Only the two declared facts are read. `startedAt` on the descendant, a
    // higher id, and a running status are all silent here.
    const groups = groupDescendantsByDispatch(card(T(40)), [
      { agentId: 'agent-99', createdAt: T(20), startedAt: T(70), status: 'running' } as DispatchIdentity & { agentId: string },
    ]);
    expect(ids(groups.other)).toEqual(['agent-99']);
  });

  it('folds a descendant born before the window when the clock later reads earlier', () => {
    // A wall clock that steps backwards is not corrected for; the recorded
    // values are the facts, and this pair no longer orders cleanly.
    const groups = groupDescendantsByDispatch(card(T(40)), [born('child', T(20))]);
    expect(groups.current).toEqual([]);
  });

  it('keeps nothing and folds nothing for a card with no descendants', () => {
    expect(groupDescendantsByDispatch(card(T(40)), [])).toEqual({ current: [], other: [] });
  });

  it('loses no descendant: every one lands in exactly one group', () => {
    const descendants = [born('a', T(20)), born('b', T(60)), born('c', T(60)), born('d'), born('e', T(70))];
    const groups = groupDescendantsByDispatch(card(T(40)), descendants);
    expect(groups.current.length + groups.other.length).toBe(descendants.length);
    expect(new Set([...groups.current, ...groups.other].map((entry) => entry.agentId)).size).toBe(descendants.length);
  });

  it('preserves the forest’s own order inside each group', () => {
    const groups = groupDescendantsByDispatch(card(T(40)), [
      born('a', T(60)), born('b', T(20)), born('c', T(61)), born('d', T(21)), born('e', T(62)),
    ]);
    expect(ids(groups.current)).toEqual(['a', 'c', 'e']);
    expect(ids(groups.other)).toEqual(['b', 'd']);
  });
});

describe('countFoldedDescendants', () => {
  it('counts only what the records show, and treats unknown status as neither', () => {
    const counts = countFoldedDescendants([
      { status: 'running' },
      { status: 'background' },
      { status: 'suspended' },
      { status: 'failed' },
      { status: 'completed' },
      { status: 'cancelled' },
      { status: 'unknown' },
      {},
    ]);
    expect(counts).toEqual({ total: 8, running: 3, failed: 1 });
  });

  it('reports zeros rather than nothing for an empty group', () => {
    expect(countFoldedDescendants([])).toEqual({ total: 0, running: 0, failed: 0 });
  });
});
