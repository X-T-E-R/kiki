/**
 * Scoped external store for timeline annotation targets inside `<Transcript />`.
 *
 * Keeps `Transcript` and all unaffected rows out of React's render path when
 * annotations are created, edited, or deleted:
 * - Sent annotations derive once per `blocks` identity in O(N).
 * - Draft annotations resolve via O(1) blockId lookup when anchored.
 * - Structural mark targets (`id`, `quote`, `source`) are separated from live
 *   `comment` prose: editing a comment notifies only an open popover for that
 *   exact `annotationId` and wakes zero timeline rows or Markdown blocks.
 * - Adding or removing an annotation wakes only the single affected `blockId`.
 */

import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

import {
  collectDraftAnnotationTargets,
  collectTimelineAnnotations,
  getAnnotationOverride,
  getAnnotationOverridesSnapshot,
  subscribeAnnotationOverrideChanges,
  type AnnotationOverride,
  type SelectionSourceAnchor,
  type TimelineAnnotation,
  type TimelineBlockLike,
} from '@kiki/session-core/composer';
import type { ConversationAnnotationStore } from '../agent-workspace/useConversationAnnotations';

function sameSourceAnchor(
  left: SelectionSourceAnchor | null | undefined,
  right: SelectionSourceAnchor | null | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || left === null || right === undefined || right === null) return false;
  return (
    left.blockId === right.blockId &&
    left.version === right.version &&
    left.start === right.start &&
    left.end === right.end &&
    left.text === right.text
  );
}

/** Compare structural mark properties only; comment changes never alter `<mark>` DOM. */
function markListsEqual(
  previous: readonly TimelineAnnotation[] | undefined,
  next: readonly TimelineAnnotation[] | undefined,
): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index]!;
    const right = next[index]!;
    if (
      left.id !== right.id ||
      left.quote !== right.quote ||
      !sameSourceAnchor(left.source, right.source)
    ) {
      return false;
    }
  }
  return true;
}

function sameAnnotation(
  left: TimelineAnnotation | undefined,
  right: TimelineAnnotation | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.id === right.id &&
    left.quote === right.quote &&
    left.comment === right.comment &&
    sameSourceAnchor(left.source, right.source)
  );
}

function applyOverridesToList(
  list: readonly TimelineAnnotation[],
  overrides: Readonly<Record<string, AnnotationOverride>>,
): readonly TimelineAnnotation[] {
  let changed = false;
  const resolved: TimelineAnnotation[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const annotation = list[index]!;
    const override = overrides[annotation.id];
    if (override?.deleted === true) {
      changed = true;
      continue;
    }
    if (override?.comment !== undefined && override.comment !== annotation.comment) {
      changed = true;
      resolved.push({ ...annotation, comment: override.comment });
      continue;
    }
    resolved.push(annotation);
  }
  return changed ? resolved : list;
}

export class TranscriptAnnotationTargetStore {
  private blocks: readonly TimelineBlockLike[] | null = null;
  private timelineBlocks: readonly TimelineBlockLike[] | null = null;
  private draftStore: ConversationAnnotationStore | undefined;
  private draftProp: readonly TimelineAnnotation[] | undefined;
  private currentDrafts: readonly TimelineAnnotation[] = [];

  private rawSentByBlock: ReadonlyMap<string, readonly TimelineAnnotation[]> = new Map();
  private sentBlockByAnnotationId = new Map<string, string>();
  private effectiveSentByBlock = new Map<string, readonly TimelineAnnotation[]>();
  private draftByBlock: ReadonlyMap<string, readonly TimelineAnnotation[]> = new Map();

  private marksByBlock = new Map<string, readonly TimelineAnnotation[]>();
  private liveById = new Map<string, TimelineAnnotation>();
  private draftIds = new Set<string>();

  private readonly blockListeners = new Map<string, Set<() => void>>();
  private readonly annotationListeners = new Map<string, Set<() => void>>();

  private unsubOverrides: (() => void) | null = null;
  private unsubDraftStore: (() => void) | null = null;

  /** Synchronize render-time inputs without notifying subscribers during render. */
  syncInputs(
    blocks: readonly TimelineBlockLike[],
    timelineBlocks: readonly TimelineBlockLike[],
    draftStore: ConversationAnnotationStore | undefined,
    draftProp: readonly TimelineAnnotation[] | undefined,
  ): void {
    const blocksChanged = this.blocks !== blocks;
    const timelineBlocksChanged = this.timelineBlocks !== timelineBlocks;
    const nextDrafts = draftStore !== undefined ? draftStore.getSnapshot() : (draftProp ?? []);
    const draftsChanged = this.currentDrafts !== nextDrafts;

    this.blocks = blocks;
    this.timelineBlocks = timelineBlocks;
    this.draftStore = draftStore;
    this.draftProp = draftProp;

    if (blocksChanged) {
      this.rebuildSentFromBlocks(blocks);
    }
    if (timelineBlocksChanged || draftsChanged) {
      this.currentDrafts = nextDrafts;
      this.draftByBlock = collectDraftAnnotationTargets(timelineBlocks, nextDrafts);
      this.rebuildDraftIds(nextDrafts);
    }
    if (blocksChanged || timelineBlocksChanged || draftsChanged) {
      this.reconcileAllBlocks(false);
    }
  }

  /** Activate external subscriptions for overrides and the draft store. */
  bindSubscriptions(draftStore: ConversationAnnotationStore | undefined): () => void {
    this.unsubOverrides?.();
    this.unsubDraftStore?.();
    this.draftStore = draftStore;

    this.unsubOverrides = subscribeAnnotationOverrideChanges((changedId) => {
      if (changedId === null) {
        this.rebuildAllEffectiveSent(true);
        return;
      }
      this.handleSingleOverrideChange(changedId);
    });

    if (draftStore !== undefined) {
      const handleDraftChange = () => {
        const nextDrafts = draftStore.getSnapshot();
        if (nextDrafts === this.currentDrafts) return;
        this.currentDrafts = nextDrafts;
        if (this.timelineBlocks !== null) {
          this.draftByBlock = collectDraftAnnotationTargets(this.timelineBlocks, nextDrafts);
        }
        this.rebuildDraftIds(nextDrafts);
        this.reconcileAllBlocks(true);
      };
      this.unsubDraftStore = draftStore.subscribe(handleDraftChange);
      handleDraftChange();
    } else {
      this.unsubDraftStore = null;
    }

    return () => {
      this.unsubOverrides?.();
      this.unsubOverrides = null;
      this.unsubDraftStore?.();
      this.unsubDraftStore = null;
    };
  }

  subscribeBlockMarks(blockId: string, listener: () => void): () => void {
    let set = this.blockListeners.get(blockId);
    if (set === undefined) {
      set = new Set<() => void>();
      this.blockListeners.set(blockId, set);
    }
    set.add(listener);
    return () => {
      const current = this.blockListeners.get(blockId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.blockListeners.delete(blockId);
    };
  }

  getBlockMarks(blockId: string): readonly TimelineAnnotation[] | undefined {
    return this.marksByBlock.get(blockId);
  }

  subscribeAnnotationById(annotationId: string, listener: () => void): () => void {
    let set = this.annotationListeners.get(annotationId);
    if (set === undefined) {
      set = new Set<() => void>();
      this.annotationListeners.set(annotationId, set);
    }
    set.add(listener);
    return () => {
      const current = this.annotationListeners.get(annotationId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.annotationListeners.delete(annotationId);
    };
  }

  getAnnotationById(annotationId: string): TimelineAnnotation | undefined {
    return this.liveById.get(annotationId);
  }

  isDraftAnnotation(annotationId: string): boolean {
    return this.draftIds.has(annotationId);
  }

  private rebuildDraftIds(drafts: readonly TimelineAnnotation[]): void {
    this.draftIds.clear();
    for (let index = 0; index < drafts.length; index += 1) {
      this.draftIds.add(drafts[index]!.id);
    }
  }

  private rebuildSentFromBlocks(blocks: readonly TimelineBlockLike[]): void {
    this.rawSentByBlock = collectTimelineAnnotations(blocks);
    this.sentBlockByAnnotationId.clear();
    for (const [blockId, list] of this.rawSentByBlock) {
      for (let index = 0; index < list.length; index += 1) {
        this.sentBlockByAnnotationId.set(list[index]!.id, blockId);
      }
    }
    const overrides = getAnnotationOverridesSnapshot();
    this.effectiveSentByBlock.clear();
    for (const [blockId, list] of this.rawSentByBlock) {
      const resolved = applyOverridesToList(list, overrides);
      if (resolved.length > 0) this.effectiveSentByBlock.set(blockId, resolved);
    }
  }

  private rebuildAllEffectiveSent(notify: boolean): void {
    const overrides = getAnnotationOverridesSnapshot();
    this.effectiveSentByBlock.clear();
    for (const [blockId, list] of this.rawSentByBlock) {
      const resolved = applyOverridesToList(list, overrides);
      if (resolved.length > 0) this.effectiveSentByBlock.set(blockId, resolved);
    }
    this.reconcileAllBlocks(notify);
  }

  private handleSingleOverrideChange(changedId: string): void {
    const blockId = this.sentBlockByAnnotationId.get(changedId);
    if (blockId === undefined) return;
    const rawList = this.rawSentByBlock.get(blockId);
    if (rawList === undefined) return;

    const prevLive = this.liveById.get(changedId);
    const nextSent: TimelineAnnotation[] = [];
    for (let index = 0; index < rawList.length; index += 1) {
      const annotation = rawList[index]!;
      const override = getAnnotationOverride(annotation.id);
      if (override?.deleted === true) continue;
      if (override?.comment !== undefined && override.comment !== annotation.comment) {
        nextSent.push({ ...annotation, comment: override.comment });
      } else {
        nextSent.push(annotation);
      }
    }

    if (nextSent.length > 0) {
      this.effectiveSentByBlock.set(blockId, nextSent);
    } else {
      this.effectiveSentByBlock.delete(blockId);
    }

    const drafts = this.draftByBlock.get(blockId);
    const merged = this.mergeBlockList(drafts, nextSent);
    const previousMarks = this.marksByBlock.get(blockId);
    const marksChanged = !markListsEqual(previousMarks, merged);

    if (merged === undefined) {
      this.marksByBlock.delete(blockId);
    } else if (marksChanged) {
      this.marksByBlock.set(blockId, merged);
    }

    let nextLive: TimelineAnnotation | undefined;
    for (let index = 0; index < nextSent.length; index += 1) {
      if (nextSent[index]!.id === changedId) {
        nextLive = nextSent[index]!;
        break;
      }
    }
    if (nextLive === undefined) {
      this.liveById.delete(changedId);
    } else {
      this.liveById.set(changedId, nextLive);
    }

    if (marksChanged) {
      this.notifyBlock(blockId);
    }
    if (!sameAnnotation(prevLive, nextLive)) {
      this.notifyAnnotation(changedId);
    }
  }

  private mergeBlockList(
    drafts: readonly TimelineAnnotation[] | undefined,
    sent: readonly TimelineAnnotation[] | undefined,
  ): readonly TimelineAnnotation[] | undefined {
    const hasDrafts = drafts !== undefined && drafts.length > 0;
    const hasSent = sent !== undefined && sent.length > 0;
    if (!hasDrafts && !hasSent) return undefined;
    if (!hasDrafts) return sent;
    if (!hasSent) return drafts;
    return [...drafts, ...sent];
  }

  private reconcileAllBlocks(notify: boolean): void {
    const candidateBlockIds = new Set<string>();
    for (const blockId of this.marksByBlock.keys()) candidateBlockIds.add(blockId);
    for (const blockId of this.effectiveSentByBlock.keys()) candidateBlockIds.add(blockId);
    for (const blockId of this.draftByBlock.keys()) candidateBlockIds.add(blockId);

    const changedBlocks: string[] = [];
    const nextLiveById = new Map<string, TimelineAnnotation>();

    for (const blockId of candidateBlockIds) {
      const merged = this.mergeBlockList(
        this.draftByBlock.get(blockId),
        this.effectiveSentByBlock.get(blockId),
      );
      if (merged !== undefined) {
        for (let index = 0; index < merged.length; index += 1) {
          const item = merged[index]!;
          nextLiveById.set(item.id, item);
        }
      }
      const previous = this.marksByBlock.get(blockId);
      if (!markListsEqual(previous, merged)) {
        if (merged === undefined) {
          this.marksByBlock.delete(blockId);
        } else {
          this.marksByBlock.set(blockId, merged);
        }
        changedBlocks.push(blockId);
      }
    }

    const changedAnnotationIds: string[] = [];
    if (notify && this.annotationListeners.size > 0) {
      for (const annotationId of this.annotationListeners.keys()) {
        if (!sameAnnotation(this.liveById.get(annotationId), nextLiveById.get(annotationId))) {
          changedAnnotationIds.push(annotationId);
        }
      }
    }
    this.liveById = nextLiveById;

    if (!notify) return;
    for (let index = 0; index < changedBlocks.length; index += 1) {
      this.notifyBlock(changedBlocks[index]!);
    }
    for (let index = 0; index < changedAnnotationIds.length; index += 1) {
      this.notifyAnnotation(changedAnnotationIds[index]!);
    }
  }

  private notifyBlock(blockId: string): void {
    const set = this.blockListeners.get(blockId);
    if (set === undefined) return;
    for (const listener of set) listener();
  }

  private notifyAnnotation(annotationId: string): void {
    const set = this.annotationListeners.get(annotationId);
    if (set === undefined) return;
    for (const listener of set) listener();
  }
}

export const TranscriptAnnotationsContext = createContext<TranscriptAnnotationTargetStore | null>(null);

const NOOP_SUBSCRIBE = () => () => {};
const EMPTY_SNAPSHOT = () => undefined;

/** Subscribe a single message block to its own structural annotation marks only. */
export function useBlockAnnotationMarks(blockId: string): readonly TimelineAnnotation[] | undefined {
  const store = useContext(TranscriptAnnotationsContext);
  const subscribe = useCallback(
    (listener: () => void) => (store === null ? () => {} : store.subscribeBlockMarks(blockId, listener)),
    [store, blockId],
  );
  const getSnapshot = useCallback(
    () => (store === null ? undefined : store.getBlockMarks(blockId)),
    [store, blockId],
  );
  return useSyncExternalStore(
    store === null ? NOOP_SUBSCRIBE : subscribe,
    store === null ? EMPTY_SNAPSHOT : getSnapshot,
    store === null ? EMPTY_SNAPSHOT : getSnapshot,
  );
}

/** Subscribe an open AnnotationPopover to the live annotation (including comment edits) for one id. */
export function useTranscriptAnnotationById(
  annotationId: string | null,
): TimelineAnnotation | undefined {
  const store = useContext(TranscriptAnnotationsContext);
  const subscribe = useCallback(
    (listener: () => void) =>
      store === null || annotationId === null
        ? () => {}
        : store.subscribeAnnotationById(annotationId, listener),
    [store, annotationId],
  );
  const getSnapshot = useCallback(
    () => (store === null || annotationId === null ? undefined : store.getAnnotationById(annotationId)),
    [store, annotationId],
  );
  return useSyncExternalStore(
    store === null || annotationId === null ? NOOP_SUBSCRIBE : subscribe,
    store === null || annotationId === null ? EMPTY_SNAPSHOT : getSnapshot,
    store === null || annotationId === null ? EMPTY_SNAPSHOT : getSnapshot,
  );
}
