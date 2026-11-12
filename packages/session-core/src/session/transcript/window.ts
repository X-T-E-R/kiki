/**
 * One agent's transcript window: how two copies of the same timeline entity
 * are resolved when a read brings in one the window already holds, and how
 * the window describes the turns it holds only in part.
 *
 * Every copy carries the transcript cursor it was read at (its read mark).
 * Placement — where an item sits in the timeline — is the store's job
 * (`placeTranscriptItems`, by the server's ordering); this module only
 * decides content.
 */

import {
  carryContentHydration,
  mergeContentPreview,
  type TranscriptCursor,
  type TranscriptItem,
  type TranscriptTaskRef,
  type TranscriptTurn,
} from '@kiki/transcript';
import type { TurnGap } from './types';

/** The transcript cursor a copy of an entity reflects. */
export type ReadMark = Pick<TranscriptCursor, 'seq' | 'epoch'>;

/**
 * Whether a copy read at `incoming` replaces one read at `resident`.
 *
 * Within one live epoch the higher cursor is the newer read, and a tie goes
 * to the incoming copy: it describes the same state and was received later.
 * Nothing else can be ordered by cursor — a cold source answers every read
 * with the fixed `{seq: 0, epoch: 'cold:<session>:<agent>'}`, two epochs are
 * unrelated journals, and an unknown epoch or a missing mark says nothing —
 * so there the copy received later, the incoming one, wins.
 */
export function readMarkWins(incoming: ReadMark | undefined, resident: ReadMark | undefined): boolean {
  if (incoming === undefined || resident === undefined) return true;
  const epoch = incoming.epoch;
  if (epoch === undefined || epoch !== resident.epoch || epoch.startsWith('cold:')) return true;
  return incoming.seq >= resident.seq;
}

/** The identity of a timeline item across kinds (a turn, a marker and a task reference may share an id). */
export function windowItemKey(item: TranscriptItem): string {
  if (item.kind === 'turn') return `turn:${item.turnId}`;
  if (item.kind === 'marker') return `marker:${item.markerId}`;
  return `taskref:${item.refId}`;
}

export function isOpeninglessTurn(turn: TranscriptTurn): boolean {
  return turn.origin.kind === 'other' && turn.message === undefined && turn.promptId === undefined && turn.startedAt === undefined;
}

/** How two copies of one turn were resolved. */
export interface ResolvedTurn {
  readonly turn: TranscriptTurn;
  /** The incoming copy's read decided the content: its read mark, and its grade, now describe the turn. */
  readonly fromIncoming: boolean;
  /**
   * The turn was assembled from a head and a tail this client read
   * separately and is still incomplete: the gap lies after this step of the
   * head, or right after the opening when the head brought no steps (`null`).
   */
  readonly join?: string | null;
}

/**
 * Resolve the copy of a turn the window holds against one a read brought in.
 *
 * - A tail that lacks its opening meets a copy that has it: the two are
 *   halves of one turn, not rival copies; they are joined (the tail keeps its
 *   run state and steps, the head adds its opening and leading steps).
 * - A complete copy beats a partial window of the same turn: the window is
 *   not a newer copy, only a smaller one.
 * - A copy with no steps where the held one has steps carries a header only:
 *   if newer, its header is taken over the held steps.
 * - Otherwise the newer read wins (`incomingFresher`). Bodies already read for
 *   a field whose content revision did not change are kept, on the turn and on
 *   every surviving frame; two partial windows are unioned step by step.
 */
export function resolveTurnCopies(resident: TranscriptTurn, incoming: TranscriptTurn, incomingFresher: boolean): ResolvedTurn {
  const residentOpeningless = isOpeninglessTurn(resident);
  const incomingOpeningless = isOpeninglessTurn(incoming);
  if (residentOpeningless && incoming.startedAt !== undefined) {
    const turn = recoverTranscriptTurn(resident, incoming);
    return { turn, fromIncoming: false, join: turn.stepsPartial === true ? headJoin(incoming, resident) : undefined };
  }
  if (incomingOpeningless && !residentOpeningless) {
    if (resident.stepsPartial !== true) return { turn: resident, fromIncoming: false };
    const turn = recoverTranscriptTurn(incoming, resident);
    return { turn, fromIncoming: false, join: turn.stepsPartial === true ? headJoin(resident, incoming) : undefined };
  }
  if (incoming.stepsPartial === true && resident.stepsPartial !== true) return { turn: resident, fromIncoming: false };
  if (!incomingFresher) return { turn: resident, fromIncoming: false };
  if (incoming.steps.length === 0 && resident.steps.length > 0) {
    const { steps: _steps, ...header } = incoming;
    const turn = carryContentHydration(resident, {
      ...header,
      steps: resident.steps,
      stepsPartial: resident.stepsPartial,
      contentRefs: [
        ...(resident.contentRefs ?? []).filter((ref) => ref.path[0] === 'steps'),
        ...(incoming.contentRefs ?? []).filter((ref) => ref.path[0] !== 'steps'),
      ],
    });
    return { turn, fromIncoming: false };
  }
  if (incoming.stepsPartial === true && resident.stepsPartial === true) {
    const steps = new Map(resident.steps.map((step) => [step.stepId, step]));
    for (const step of incoming.steps) steps.set(step.stepId, step);
    const merged = refreshTurn(resident, { ...incoming, steps: [...steps.values()].toSorted((a, b) => a.ordinal - b.ordinal) });
    return { turn: merged, fromIncoming: true };
  }
  return { turn: refreshTurn(resident, incoming), fromIncoming: true };
}

/**
 * Join the opening-bearing head of a turn (`opening`) to a tail of it read
 * without its opening (`current`): the tail keeps its run state and its steps,
 * the head adds its opening fields and the steps the tail does not hold. The
 * result is still `stepsPartial` when either half was.
 */
export function recoverTranscriptTurn(current: TranscriptTurn, opening: TranscriptTurn): TranscriptTurn {
  const steps = new Map(opening.steps.map(step => [step.stepId, step]));
  for (const step of current.steps) {
    const prefix = steps.get(step.stepId);
    steps.set(step.stepId, prefix === undefined ? step : { ...prefix, ...step, ordinal: prefix.ordinal,
      frames: [...new Map([...prefix.frames, ...step.frames].map(frame => [frame.frameId, frame])).values()] });
  }
  const roots = opening.contentRefs?.filter(ref => ref.path.length === 1 && ref.path[0] === 'steps') ?? [];
  const reindexed = opening.steps.some((step, index) => current.steps[index]?.stepId !== step.stepId);
  const refs = reindexed ? [
    ...roots.map(ref => ({ ...ref, direction: 'forward' as const, offset: 0 })),
    ...(opening.contentRefs ?? []).filter(ref => ref.path[0] !== 'steps' || ref.path.length > 1),
  ] : [...(current.contentRefs ?? []).filter(ref => ref.path[0] === 'steps'),
    ...(opening.contentRefs ?? []).filter(ref => ref.path[0] !== 'steps')];
  return carryContentHydration(current, { ...current, origin: opening.origin, prompt: opening.prompt,
    promptId: opening.promptId, message: opening.message, delivery: opening.delivery, presentation: opening.presentation,
    attachmentIds: opening.attachmentIds, startedAt: opening.startedAt,
    stepsPartial: current.stepsPartial === true || opening.stepsPartial === true ? true : undefined,
    steps: opening.steps.length === 0 ? current.steps : [...steps.values()].toSorted((a, b) => a.ordinal - b.ordinal), contentRefs: refs });
}

/** Lay a newer copy of a turn over the held one, keeping bodies already read for unchanged content revisions. */
export function refreshTurn(resident: TranscriptTurn, incoming: TranscriptTurn): TranscriptTurn {
  const merged = mergeContentPreview(resident, incoming);
  return carryContentHydration(merged, { ...merged, steps: merged.steps.map((step) => {
    const previous = resident.steps.find((entry) => entry.stepId === step.stepId);
    return previous === undefined ? step : { ...step, frames: step.frames.map((frame) => {
      const saved = previous.frames.find((entry) => entry.frameId === frame.frameId);
      return saved === undefined ? frame : mergeContentPreview(saved, frame);
    }) };
  }) });
}

function headJoin(head: TranscriptTurn, tail: TranscriptTurn): string | null {
  const tailSteps = new Set(tail.steps.map((step) => step.stepId));
  const own = head.steps.filter((step) => !tailSteps.has(step.stepId));
  return own.toSorted((a, b) => a.ordinal - b.ordinal).at(-1)?.stepId ?? null;
}

/**
 * Resolve two copies of a timeline item that is not a turn. A task
 * reference keeps the earlier of the two times it was seen at (a live copy is
 * stamped when it arrived, the history copy when it happened).
 */
export function resolveItemCopies(resident: TranscriptItem, incoming: TranscriptItem, incomingFresher: boolean): TranscriptItem {
  const base = incomingFresher ? incoming : resident;
  if (resident.kind !== 'taskref' || incoming.kind !== 'taskref' || base.kind !== 'taskref') return base;
  const at = earlierAt(resident.at, incoming.at);
  return at === base.at ? base : { ...base, at } satisfies TranscriptTaskRef;
}

function earlierAt(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined || left === '') return right;
  if (right === undefined || right === '') return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(rightMs)) return left;
  if (Number.isNaN(leftMs)) return right;
  return rightMs < leftMs ? right : left;
}

/**
 * The gap description of one held turn, or none when it is complete.
 * `stale` — the turn changed while this client received it below the grade
 * the window was built at (or did not receive it at all), so what is held may
 * be out of date anywhere: the whole turn counts as not loaded. A turn the
 * source window cut (`stepsPartial`) is missing a part: before its first held
 * step when it lacks its opening, between a head and a tail when this client
 * read both, and at an unknown place otherwise.
 */
export function turnGapOf(turn: TranscriptTurn, stale: boolean, join: string | null | undefined): TurnGap | undefined {
  if (stale) return { at: 'turn', reason: 'stale' };
  if (turn.stepsPartial !== true) return undefined;
  if (isOpeninglessTurn(turn)) return { at: 'start', reason: 'partial' };
  if (join === null) return { at: 'start', reason: 'partial' };
  if (join !== undefined && turn.steps.some((step) => step.stepId === join)) return { at: 'between', afterStepId: join, reason: 'partial' };
  return { at: 'turn', reason: 'partial' };
}
