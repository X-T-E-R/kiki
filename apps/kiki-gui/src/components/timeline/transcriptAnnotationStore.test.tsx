// @vitest-environment jsdom

import { act, memo, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearComposerState,
  createAnnotation,
  readComposerState,
  resetComposerMemoryForTests,
  selectionCarryoverPresentation,
  sourceTextVersion,
  writeComposerState,
  type TimelineBlockLike,
} from '@kiki/session-core/composer';
import {
  TranscriptAnnotationsContext,
  TranscriptAnnotationTargetStore,
  useBlockAnnotationMarks,
} from './transcriptAnnotationStore';
import {
  useConversationAnnotations,
  type ConversationAnnotationStore,
  type UseConversationAnnotationsResult,
} from '../agent-workspace/useConversationAnnotations';

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  resetComposerMemoryForTests();
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('TranscriptAnnotationTargetStore memo row handoff', () => {
  it('wakes memoized source rows on draft-to-sent handoff without unmounting when blocks append a carryover user message', async () => {
    const mountCount = { value: 0 };
    const MemoRow = memo(function MemoRow({ block }: { readonly block: TimelineBlockLike }) {
      const marks = useBlockAnnotationMarks(block.id);
      const mountedRef = useRef(false);
      if (!mountedRef.current) {
        mountedRef.current = true;
        if (block.id === 'assistant-1') mountCount.value += 1;
      }
      return (
        <div data-row={block.id} data-mark-ids={(marks ?? []).map((m) => m.id).join(',')}>
          {block.text}
        </div>
      );
    });

    const sourceBlock: TimelineBlockLike = {
      id: 'assistant-1',
      kind: 'assistant',
      text: 'The quick brown fox jumps over the lazy dog.',
    };
    const sourceAnchor = {
      blockId: sourceBlock.id,
      version: sourceTextVersion(sourceBlock.text!),
      start: 3,
      end: 13,
      text: 'quickbrown',
    };
    const draftAnnotation = createAnnotation('quick brown', 'check speed', sourceAnchor);

    let draftSnapshot = [draftAnnotation];
    const draftListeners = new Set<() => void>();
    const draftStore: ConversationAnnotationStore = {
      getSnapshot: () => draftSnapshot,
      subscribe: (listener) => {
        draftListeners.add(listener);
        return () => {
          draftListeners.delete(listener);
        };
      },
    };
    const store = new TranscriptAnnotationTargetStore();

    function Harness({ blocks }: { readonly blocks: readonly TimelineBlockLike[] }) {
      store.syncInputs(blocks, blocks, draftStore, undefined);
      useLayoutEffect(() => {
        store.flushPendingNotifications();
      });
      useLayoutEffect(() => store.bindSubscriptions(draftStore), []);
      return (
        <TranscriptAnnotationsContext.Provider value={store}>
          {blocks.map((block) => (
            <MemoRow key={block.id} block={block} />
          ))}
        </TranscriptAnnotationsContext.Provider>
      );
    }

    root = createRoot(container);
    await act(async () => {
      root!.render(<Harness blocks={[sourceBlock]} />);
    });
    expect(mountCount.value).toBe(1);
    expect(container.querySelector('[data-row="assistant-1"]')?.getAttribute('data-mark-ids')).toBe(
      draftAnnotation.id,
    );

    // Simulate sending the message: draft clears, then the sent user message
    // carrying the exact source anchor arrives while `sourceBlock` keeps the
    // exact same object reference (memoized row never unmounts or re-renders from props).
    const carried = selectionCarryoverPresentation([draftAnnotation], []);
    const sentUserBlock: TimelineBlockLike = {
      id: 'user-2',
      kind: 'user',
      text: `${carried.prefix}please revise`,
      presentation: carried.presentation,
    };
    await act(async () => {
      draftSnapshot = [];
      for (const listener of draftListeners) listener();
    });
    expect(container.querySelector('[data-row="assistant-1"]')?.getAttribute('data-mark-ids')).toBe('');

    await act(async () => {
      root!.render(<Harness blocks={[sourceBlock, sentUserBlock]} />);
    });
    expect(mountCount.value).toBe(1);
    const sentMarkIds = container.querySelector('[data-row="assistant-1"]')?.getAttribute('data-mark-ids') ?? '';
    expect(sentMarkIds).not.toBe('');
    expect(sentMarkIds).not.toBe(draftAnnotation.id);
  });
});

describe('useConversationAnnotations storageKey isolation', () => {
  it('reloads stored annotations when storageKey changes without overwriting the new conversation', async () => {
    const keyA = JSON.stringify(['local', 'sess-1', 'sub-a']);
    const keyB = JSON.stringify(['local', 'sess-1', 'sub-b']);
    const annA = createAnnotation('quote A', 'note A');
    const annB = createAnnotation('quote B', 'note B');
    const baseState = {
      attachments: [],
      quotes: [],
      permissionMode: undefined,
      planMode: undefined,
      planGate: undefined,
      goalObjective: undefined,
      modelOverride: undefined,
      effortOverride: undefined,
    };
    writeComposerState(keyA, { ...baseState, annotations: [annA] });
    writeComposerState(keyB, { ...baseState, annotations: [annB] });

    let latest: UseConversationAnnotationsResult | null = null;
    function Probe({ storageKey }: { readonly storageKey: string }) {
      const api = useConversationAnnotations({ storageKey, sessionId: 'sess-1', blocks: [] });
      latest = api;
      return <div data-count={api.annotationsRef.current.length} />;
    }

    root = createRoot(container);
    await act(async () => {
      root!.render(<MemoryRouter><Probe storageKey={keyA} /></MemoryRouter>);
    });
    expect(latest!.annotationsRef.current.map((item) => item.id)).toEqual([annA.id]);

    // Switching storageKey to sub-b without unmounting must reload sub-b's
    // annotations and preserve sub-a's persisted annotations intact.
    await act(async () => {
      root!.render(<MemoryRouter><Probe storageKey={keyB} /></MemoryRouter>);
    });
    expect(latest!.annotationsRef.current.map((item) => item.id)).toEqual([annB.id]);
    expect(readComposerState(keyA).annotations?.map((item) => item.id)).toEqual([annA.id]);
    expect(readComposerState(keyB).annotations?.map((item) => item.id)).toEqual([annB.id]);

    // Mutating sub-b must only write to sub-b, never touching sub-a.
    await act(async () => {
      latest!.onAnnotate('extra B', 'second note');
    });
    expect(readComposerState(keyA).annotations?.map((item) => item.id)).toEqual([annA.id]);
    expect(readComposerState(keyB).annotations).toHaveLength(2);

    clearComposerState(keyA);
    clearComposerState(keyB);
  });
});
