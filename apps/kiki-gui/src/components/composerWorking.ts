import { useEffect, useMemo, useRef, useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import type { Block, UserBlock } from '@kiki/session-core/session';

export const WORKING_QUIET_THRESHOLD_MS = 10_000;
const LAST_RESPONSE_RESOLUTION_MS = 1_000;

type Translator = (key: I18nKey, params?: Record<string, string | number>) => string;

function parseIsoMs(iso: string | undefined): number | undefined {
  if (iso === undefined || iso === '') return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteTimestamp(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isSettledUserPrompt(block: UserBlock): boolean {
  if (block.promptOutcome !== undefined) return true;
  return block.promptStatus !== undefined
    && block.promptStatus !== 'running'
    && block.promptStatus !== 'queued';
}

/**
 * Timestamp (epoch ms) of the newest activity represented by a single agent
 * block. Completed frame-timed tools use their completion instant instead of
 * their start instant so a long tool that just finished does not look stale.
 */
export function blockActivityTimestamp(block: Block): number | undefined {
  switch (block.kind) {
    case 'assistant':
    case 'thinking':
      return parseIsoMs(block.createdAt);
    case 'tool': {
      const startedAt = finiteTimestamp(block.startedAt);
      if (startedAt === undefined) return undefined;
      if (
        block.status !== 'running'
        && block.durationSource === 'frame'
        && typeof block.durationMs === 'number'
        && Number.isFinite(block.durationMs)
        && block.durationMs >= 0
      ) {
        return startedAt + block.durationMs;
      }
      return startedAt;
    }
    case 'shell':
      return finiteTimestamp(block.startedAt);
    case 'subagent':
      return parseIsoMs(block.endedAt) ?? parseIsoMs(block.startedAt);
    default:
      return undefined;
  }
}

function isAgentBlock(block: Block): boolean {
  return block.kind === 'assistant'
    || block.kind === 'thinking'
    || block.kind === 'tool'
    || block.kind === 'shell'
    || block.kind === 'subagent';
}

export interface CurrentTurnScope {
  readonly userBlock: UserBlock | undefined;
  readonly agentBlocks: readonly Block[];
}

/**
 * Slice `blocks` to the currently executing turn only so earlier completed
 * turns can never leak timestamps or output signatures into the working line.
 */
export function currentTurnScope(
  blocks: readonly Block[],
  turnStartedAt: number | undefined,
): CurrentTurnScope {
  const startedAt = finiteTimestamp(turnStartedAt);
  let boundaryIndex = -1;
  let userBlock: UserBlock | undefined;

  // Prefer an explicitly running user prompt when present.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind === 'user' && block.promptStatus === 'running') {
      boundaryIndex = index;
      userBlock = block;
      break;
    }
  }

  if (boundaryIndex === -1) {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]!;
      if (block.kind !== 'user') continue;
      if (block.promptStatus === 'queued') continue;
      const createdMs = parseIsoMs(block.createdAt);
      if (startedAt !== undefined) {
        // Steer messages arrive after the turn started; keep scanning back to
        // the prompt that opened this turn.
        if (createdMs !== undefined && createdMs > startedAt) continue;
        boundaryIndex = index;
        userBlock = block;
        break;
      }
      // Without `turnStartedAt`, a mid-turn steer message is not the turn root.
      if (block.steerStatus !== undefined) continue;
      // A settled prior user prompt means the new turn's prompt has not landed
      // in `blocks` yet — never scan back into that completed turn.
      if (isSettledUserPrompt(block)) {
        return { userBlock: undefined, agentBlocks: [] };
      }
      boundaryIndex = index;
      userBlock = block;
      break;
    }
  }

  const candidateSlice = boundaryIndex >= 0 ? blocks.slice(boundaryIndex + 1) : blocks;
  let agentBlocks = candidateSlice.filter(isAgentBlock);

  if (startedAt !== undefined) {
    agentBlocks = agentBlocks.filter((block) => {
      const ts = blockActivityTimestamp(block);
      return ts === undefined || ts >= startedAt;
    });
  } else if (boundaryIndex === -1 && agentBlocks.length > 0) {
    // No user prompt in `blocks` (e.g. a directly spawned child agent): keep
    // only the trailing turnId when present so earlier turns stay isolated.
    const trailing = agentBlocks[agentBlocks.length - 1]!;
    const trailingTurnId = 'turnId' in trailing ? trailing.turnId : undefined;
    if (trailingTurnId !== undefined) {
      let start = agentBlocks.length - 1;
      while (start > 0) {
        const prev = agentBlocks[start - 1]!;
        const prevTurnId = 'turnId' in prev ? prev.turnId : undefined;
        if (prevTurnId !== undefined && prevTurnId !== trailingTurnId) break;
        start -= 1;
      }
      agentBlocks = agentBlocks.slice(start);
    }
  }

  return { userBlock, agentBlocks };
}

/**
 * A fingerprint of the newest agent output in a block list: it changes when
 * the agent streams text, starts or finishes a tool, or a subagent moves, and
 * stays put for the user's own rows (a queued prompt, an approval answer).
 */
export function agentOutputSignature(blocks: readonly Block[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    switch (block.kind) {
      case 'assistant':
      case 'thinking':
        return `${block.id}:${block.text.length}:${block.streaming ? 1 : 0}`;
      case 'tool':
        return `${block.id}:${block.status}:${block.progressText ?? ''}`;
      case 'shell':
        return `${block.id}:${block.output.length}:${block.done ? 1 : 0}`;
      case 'subagent':
        return `${block.id}:${block.status}:${block.toolCallCount}`;
      default:
        break;
    }
  }
  return undefined;
}

/** Epoch ms of the newest agent output within the active turn whose timestamp is known. */
export function latestTurnAgentTimestamp(
  blocks: readonly Block[],
  turnStartedAt: number | undefined,
): number | undefined {
  const startedAt = finiteTimestamp(turnStartedAt);
  const { agentBlocks } = currentTurnScope(blocks, startedAt);
  let latest: number | undefined;
  for (let index = agentBlocks.length - 1; index >= 0; index -= 1) {
    const ts = blockActivityTimestamp(agentBlocks[index]!);
    if (ts === undefined) continue;
    if (startedAt !== undefined && ts < startedAt) continue;
    if (latest === undefined || ts > latest) latest = ts;
  }
  return latest;
}

/** Authoritative start timestamp of the active turn, if derivable from state/blocks. */
export function activeTurnStartedAt(
  blocks: readonly Block[],
  turnStartedAt: number | undefined,
): number | undefined {
  const explicit = finiteTimestamp(turnStartedAt);
  if (explicit !== undefined) return explicit;
  const { userBlock, agentBlocks } = currentTurnScope(blocks, undefined);
  const userMs = parseIsoMs(userBlock?.createdAt);
  if (userMs !== undefined) return userMs;
  let earliest: number | undefined;
  for (const block of agentBlocks) {
    const ts = blockActivityTimestamp(block);
    if (ts !== undefined && (earliest === undefined || ts < earliest)) earliest = ts;
  }
  return earliest;
}

/** Whole-second live duration for the 1s working ticker (`8s`, `1m 24s`, `1h 5m`). */
export function formatWorkingDuration(ms: number, t: Translator): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  if (totalSeconds < 60) {
    return t('time.durationSeconds', { n: totalSeconds });
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return t('time.durationMinutes', { m: totalMinutes, s: totalSeconds % 60 });
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return t('time.durationHours', { h: totalHours, m: totalMinutes % 60 });
  }
  return t('time.durationDays', { d: Math.floor(totalHours / 24), h: totalHours % 24 });
}

/** Relative quiet-age label synchronized to the same clock tick as elapsed time. */
export function formatWorkingQuietAgo(ms: number, t: Translator): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 10) return t('time.justNow');
  if (seconds < 60) return t('time.secondsAgo', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { n: hours });
  return t('time.daysAgo', { n: Math.floor(hours / 24) });
}

export interface ComposerWorkingInput {
  readonly busy: boolean;
  /** Stable identity of the viewed session or child agent. */
  readonly scopeKey: string;
  /** False while the transcript snapshot is still loading after mount or switch. */
  readonly loaded: boolean;
  readonly blocks: readonly Block[];
  readonly turnStartedAt: number | undefined;
}

export interface ComposerWorkingTiming {
  readonly startedAt: number | undefined;
  readonly lastResponseAt: number | undefined;
}

interface WorkingTracker {
  scopeKey: string;
  hydrated: boolean;
  seenSignature: string | undefined;
  turnStartedAt: number | undefined;
}

/**
 * Authoritative live timing for the composer's working line:
 * - `startedAt`: active turn start time (server `turnStartedAt`, falling back
 *   to the current turn's prompt/first block timestamp, and latching mount time
 *   only when a brand-new loaded turn has no timestamp yet).
 * - `lastResponseAt`: newest agent output timestamp within the current turn
 *   only, seeded cleanly on hydration / scope switch without ever calling
 *   `Date.now()` for pre-existing blocks or crossing into earlier turns.
 */
export function useComposerWorking({
  busy,
  scopeKey,
  loaded,
  blocks,
  turnStartedAt,
}: ComposerWorkingInput): ComposerWorkingTiming {
  const explicitStart = finiteTimestamp(turnStartedAt);
  const scope = useMemo(() => currentTurnScope(blocks, explicitStart), [blocks, explicitStart]);
  const signature = useMemo(() => agentOutputSignature(scope.agentBlocks), [scope.agentBlocks]);
  const derivedStart = useMemo(
    () => (loaded ? activeTurnStartedAt(blocks, explicitStart) : explicitStart),
    [loaded, blocks, explicitStart],
  );

  const trackerRef = useRef<WorkingTracker>({
    scopeKey,
    hydrated: false,
    seenSignature: undefined,
    turnStartedAt: undefined,
  });

  const [fallbackStartedAt, setFallbackStartedAt] = useState<number | undefined>(undefined);
  const [lastResponseAt, setLastResponseAt] = useState<number | undefined>(undefined);

  useEffect(() => {
    const tracker = trackerRef.current;

    if (!busy) {
      tracker.scopeKey = scopeKey;
      tracker.hydrated = false;
      tracker.seenSignature = undefined;
      tracker.turnStartedAt = undefined;
      setFallbackStartedAt(undefined);
      setLastResponseAt(undefined);
      return;
    }

    if (tracker.scopeKey !== scopeKey) {
      tracker.scopeKey = scopeKey;
      tracker.hydrated = false;
      tracker.seenSignature = undefined;
      tracker.turnStartedAt = undefined;
      setFallbackStartedAt(undefined);
      setLastResponseAt(undefined);
    }

    // Wait for the transcript snapshot to hydrate before latching a signature
    // so loading historical blocks of a stalled turn never counts as fresh output.
    if (!loaded) return;

    const seeded = latestTurnAgentTimestamp(blocks, explicitStart);

    // First hydration for this scope/turn, or a newer back-to-back turn started
    // without `busy` flickering to false.
    const nextTurnStarted =
      tracker.hydrated
      && explicitStart !== undefined
      && tracker.turnStartedAt !== undefined
      && explicitStart > tracker.turnStartedAt;

    if (!tracker.hydrated || nextTurnStarted) {
      tracker.hydrated = true;
      tracker.seenSignature = signature ?? '';
      tracker.turnStartedAt = explicitStart;
      setLastResponseAt(seeded);
      setFallbackStartedAt(derivedStart === undefined ? Date.now() : undefined);
      return;
    }

    if (derivedStart !== undefined) {
      setFallbackStartedAt((prev) => (prev === undefined ? prev : undefined));
    }

    if (explicitStart !== undefined && tracker.turnStartedAt === undefined) {
      tracker.turnStartedAt = explicitStart;
      setLastResponseAt((previous) => {
        if (previous !== undefined && previous >= explicitStart) return previous;
        return seeded;
      });
    }

    if (signature !== undefined && signature !== tracker.seenSignature) {
      tracker.seenSignature = signature;
      // The fingerprint moves on every streamed token frame, while the label
      // reads in whole seconds. Advancing at most once per second keeps a
      // steady stream from re-rendering the view on every frame.
      const now = Date.now();
      setLastResponseAt((previous) =>
        previous !== undefined && now >= previous && now - previous < LAST_RESPONSE_RESOLUTION_MS
          ? previous
          : now,
      );
      return;
    }

    if (seeded !== undefined) {
      setLastResponseAt((previous) => (previous === undefined ? seeded : previous));
    }
    // `blocks` is read on hydration/turn boundaries; `signature` carries live updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, scopeKey, loaded, signature, explicitStart, derivedStart]);

  if (!busy) {
    return { startedAt: undefined, lastResponseAt: undefined };
  }

  return {
    startedAt: derivedStart ?? fallbackStartedAt,
    lastResponseAt,
  };
}

/** Backwards-compatible wrapper returning only `lastResponseAt`. */
export function useLastResponseAt(
  busy: boolean,
  blocks: readonly Block[],
  turnStartedAt: number | undefined,
  scopeKey = 'default',
  loaded = true,
): number | undefined {
  return useComposerWorking({ busy, scopeKey, loaded, blocks, turnStartedAt }).lastResponseAt;
}
