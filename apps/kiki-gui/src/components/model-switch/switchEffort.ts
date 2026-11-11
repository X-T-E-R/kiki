/**
 * The thinking effort a model switch preselects for its target. A hand-picked
 * effort carries over only when the target offers it; otherwise a supported
 * level stands in (the next lower one first, so a switch never quietly raises
 * cost, then the next higher, and the target's default when the effort has no
 * known rank). When the target offers no effort levels at all, a hand-picked
 * effort drops to undefined while recording `adjustedFrom` so the dialog can
 * note it. An automatic effort stays automatic without adjustment.
 */

const EFFORT_RANK = new Map([
  ['off', 0], ['none', 0], ['minimal', 1], ['low', 2],
  ['medium', 3], ['high', 4], ['xhigh', 5], ['max', 6],
]);

export interface SwitchEffortSelection {
  /** Concrete level to send; undefined keeps the target's own default. */
  readonly effort: string | undefined;
  /** The carried effort the target lacks or ignores, when not carried verbatim. */
  readonly adjustedFrom?: string;
}

export function resolveSwitchEffort(input: {
  /** Levels the target model offers, in display order. Empty: no effort control. */
  readonly targetEfforts: readonly string[];
  /** The user's own effort pick; undefined when the effort is automatic. */
  readonly carried: string | undefined;
  /** The target's default level, used for an unranked carried effort. */
  readonly targetDefault?: string;
}): SwitchEffortSelection {
  const { targetEfforts, carried, targetDefault } = input;
  if (carried === undefined) return { effort: undefined };
  if (targetEfforts.length === 0) return { effort: undefined, adjustedFrom: carried };
  if (targetEfforts.includes(carried)) return { effort: carried };
  const rank = EFFORT_RANK.get(carried);
  const ranked = targetEfforts.filter((level) => EFFORT_RANK.has(level));
  if (rank !== undefined && ranked.length > 0) {
    const lower = ranked.filter((level) => EFFORT_RANK.get(level)! <= rank)
      .toSorted((a, b) => EFFORT_RANK.get(b)! - EFFORT_RANK.get(a)!)[0];
    const higher = ranked.filter((level) => EFFORT_RANK.get(level)! > rank)
      .toSorted((a, b) => EFFORT_RANK.get(a)! - EFFORT_RANK.get(b)!)[0];
    return { effort: lower ?? higher, adjustedFrom: carried };
  }
  const fallback = targetDefault !== undefined && targetEfforts.includes(targetDefault) ? targetDefault : targetEfforts[0];
  return { effort: fallback, adjustedFrom: carried };
}
