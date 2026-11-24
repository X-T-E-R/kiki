import { useCallback, useMemo, useRef, useSyncExternalStore, type Dispatch, type RefObject, type SetStateAction } from 'react';
import {
  collectDraftAnnotationTargets,
  createAnnotation,
  readComposerState,
  removeAnnotation,
  selectionCarryoverPresentation,
  writeComposerState,
  type SelectionAnnotation,
  type SelectionSourceAnchor,
} from '@kiki/session-core/composer';
import { MAIN_AGENT_ID, type Block } from '@kiki/session-core/session';
import type { TextPresentation } from '@kiki/transcript';

import { useTimelineNavigation } from '../../lib/useTimelineNavigation';

/**
 * Scoped subscription store for a conversation's unsent draft annotations.
 * Allows `<Transcript />` to track draft mark changes without re-rendering
 * `AgentWorkspace`, `WorkspaceSurface`, or the virtualized timeline shell.
 */
export interface ConversationAnnotationStore {
  readonly getSnapshot: () => readonly SelectionAnnotation[];
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Canonical timeline selection-quote + draft-annotation surface passed into
 * `WorkspaceSurface` so `main`, `branch`, and `subagent` share one rendering
 * and interaction path. Referentially stable across annotation edits.
 */
export interface ConversationAnnotationSurface {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly store: ConversationAnnotationStore;
  readonly onAnnotate: (text: string, comment: string, source?: SelectionSourceAnchor | null) => string;
  readonly onUpdate: (id: string, comment: string) => void;
  readonly onRemove: (id: string) => void;
}

type RestoredComposerState = ReturnType<typeof readComposerState>;

/** Normalize persisted composer chrome (including legacy `quotes` / `quote`) into one ordered annotation list. */
export function normalizeStoredAnnotations(restored: Partial<RestoredComposerState> | undefined): readonly SelectionAnnotation[] {
  const base = restored?.annotations ?? [];
  if (restored?.quotes !== undefined) {
    return [...base, ...restored.quotes.map((item) => ({ ...item, comment: '' }))];
  }
  const legacy = restored?.quote;
  return legacy === null || legacy === undefined
    ? base
    : [...base, createAnnotation(legacy, '', restored?.quoteSource)];
}

/** Put a failed prompt's notes back in front of any the user added since. */
export function restoreSentAnnotations<T extends { readonly id: string }>(
  current: readonly T[],
  sent: readonly T[],
): readonly T[] {
  const present = new Set(current.map((annotation) => annotation.id));
  const missing = sent.filter((annotation) => !present.has(annotation.id));
  return missing.length === 0 ? current : [...missing, ...current];
}

/** Update stored annotations for an unmounted or detached composer key without clobbering sibling fields. */
export function updateStoredAnnotations(
  storageKey: string,
  update: (current: readonly SelectionAnnotation[]) => readonly SelectionAnnotation[],
): void {
  const saved = readComposerState(storageKey);
  writeComposerState(storageKey, {
    ...saved,
    attachments: saved.attachments ?? [],
    quotes: [],
    annotations: update(saved.annotations ?? []),
    permissionMode: saved.permissionMode,
    planMode: saved.planMode,
    planGate: saved.planGate,
    goalObjective: saved.goalObjective,
    modelOverride: saved.modelOverride,
    effortOverride: saved.effortOverride,
  });
}

/** Prepend structured `<!-- kiki-source:... -->` blockquotes + comments and shift inline presentation spans. */
export function serializeSelectionCarryover(
  annotations: readonly SelectionAnnotation[],
  text: string,
  basePresentation?: TextPresentation,
): {
  readonly quotedText: string;
  readonly presentation: TextPresentation | undefined;
  readonly sentAnnotations: readonly SelectionAnnotation[];
  readonly sentIds: ReadonlySet<string>;
} {
  const carry = selectionCarryoverPresentation(annotations, []);
  const quotedText = `${carry.prefix}${text}`;
  const spans = [
    ...carry.presentation.spans,
    ...(basePresentation?.spans ?? []).map((span) => ({
      ...span,
      start: span.start + carry.prefix.length,
      end: span.end + carry.prefix.length,
    })),
  ];
  return {
    quotedText,
    presentation: spans.length === 0 ? undefined : { spans },
    sentAnnotations: annotations,
    sentIds: new Set(annotations.map((annotation) => annotation.id)),
  };
}

const NOOP_ANNOTATION_SUBSCRIBE = (): (() => void) => () => {};
const EMPTY_ANNOTATIONS: readonly SelectionAnnotation[] = [];
const EMPTY_ANNOTATIONS_SNAPSHOT = (): readonly SelectionAnnotation[] => EMPTY_ANNOTATIONS;

/** Subscribe to a conversation's draft annotations when driven by a scoped store, or return the controlled prop. */
export function useSubscribedAnnotations(
  store: ConversationAnnotationStore | undefined,
  controlled: readonly SelectionAnnotation[] | undefined,
): readonly SelectionAnnotation[] | undefined {
  const subscribed = useSyncExternalStore(
    store?.subscribe ?? NOOP_ANNOTATION_SUBSCRIBE,
    store?.getSnapshot ?? EMPTY_ANNOTATIONS_SNAPSHOT,
    store?.getSnapshot ?? EMPTY_ANNOTATIONS_SNAPSHOT,
  );
  return store !== undefined ? subscribed : controlled;
}

export interface UseConversationAnnotationsResult {
  readonly setAnnotations: Dispatch<SetStateAction<readonly SelectionAnnotation[]>>;
  readonly annotationsRef: RefObject<readonly SelectionAnnotation[]>;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly onAnnotate: (text: string, comment: string, source?: SelectionSourceAnchor | null) => string;
  readonly onRemove: (id: string) => void;
  readonly onUpdate: (id: string, comment: string) => void;
  readonly onLocate: (annotation: SelectionAnnotation) => void;
  readonly surface: ConversationAnnotationSurface;
}

export function useConversationAnnotations(options: {
  readonly storageKey: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly blocks: readonly Block[] | (() => readonly Block[]);
  readonly isMutationLocked?: () => boolean;
  readonly persistComposerState?: boolean;
}): UseConversationAnnotationsResult {
  const {
    storageKey,
    sessionId,
    agentId = MAIN_AGENT_ID,
    blocks,
    isMutationLocked,
    persistComposerState = true,
  } = options;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  const persistRef = useRef(persistComposerState);
  persistRef.current = persistComposerState;
  const storeRef = useRef<{
    items: readonly SelectionAnnotation[];
    readonly listeners: Set<() => void>;
    readonly api: ConversationAnnotationStore;
    readonly publish: (next: readonly SelectionAnnotation[]) => void;
  } | null>(null);
  if (storeRef.current === null) {
    const initial = normalizeStoredAnnotations(readComposerState(storageKey));
    const listeners = new Set<() => void>();
    const record = {
      items: initial,
      listeners,
      api: {
        getSnapshot: () => record.items,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      publish: (next: readonly SelectionAnnotation[]) => {
        if (record.items === next) return;
        record.items = next;
        for (const listener of listeners) listener();
      },
    };
    storeRef.current = record;
  }
  const annotationsRef = useRef(storeRef.current.items);
  const setAnnotations: Dispatch<SetStateAction<readonly SelectionAnnotation[]>> = useCallback((action) => {
    const record = storeRef.current;
    if (record === null) return;
    const current = record.items;
    const next = typeof action === 'function' ? action(current) : action;
    if (next === current) return;
    annotationsRef.current = next;
    if (persistRef.current) {
      updateStoredAnnotations(storageKeyRef.current, () => next);
    }
    record.publish(next);
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const lockedRef = useRef(isMutationLocked);
  lockedRef.current = isMutationLocked;
  const navigateTimeline = useTimelineNavigation();

  const onAnnotate = useCallback((text: string, comment: string, source?: SelectionSourceAnchor | null) => {
    const annotation = createAnnotation(text, comment, source);
    setAnnotations((current) => [...current, annotation]);
    return annotation.id;
  }, [setAnnotations]);

  const onRemove = useCallback((id: string) => {
    if (lockedRef.current?.() === true) return;
    setAnnotations((current) => removeAnnotation(current, id));
  }, [setAnnotations]);

  const onUpdate = useCallback((id: string, comment: string) => {
    if (lockedRef.current?.() === true) return;
    setAnnotations((current) => {
      let changed = false;
      const next = current.map((annotation) => {
        if (annotation.id !== id || annotation.comment === comment) return annotation;
        changed = true;
        return { ...annotation, comment };
      });
      return changed ? next : current;
    });
  }, [setAnnotations]);

  const onLocate = useCallback(
    (annotation: SelectionAnnotation) => {
      const source = blocksRef.current;
      const resolvedBlocks = typeof source === 'function' ? source() : source;
      const blockId = collectDraftAnnotationTargets(resolvedBlocks, [annotation]).keys().next().value;
      if (blockId !== undefined) {
        navigateTimeline(
          { kind: 'annotation', blockId, annotationId: annotation.id },
          { sessionId, agentId: agentId === MAIN_AGENT_ID ? undefined : agentId },
        );
      }
    },
    [agentId, navigateTimeline, sessionId],
  );

  const store = storeRef.current.api;
  const surface = useMemo<ConversationAnnotationSurface>(
    () => ({
      containerRef,
      store,
      onAnnotate,
      onUpdate,
      onRemove,
    }),
    [store, onAnnotate, onUpdate, onRemove],
  );

  return {
    setAnnotations,
    annotationsRef,
    containerRef,
    onAnnotate,
    onRemove,
    onUpdate,
    onLocate,
    surface,
  };
}
