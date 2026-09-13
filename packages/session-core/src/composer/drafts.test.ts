// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import type { PermissionMode } from '@kiki/protocol';

import type { ComposerAttachment } from './attachments';
import {
  appendToDraft,
  clearComposerState,
  clearNewSessionDraft,
  clearStoredDrafts,
  INPUT_HISTORY_LIMIT,
  pushInputHistory,
  readComposerState,
  readDraft,
  readInputHistory,
  readNewSessionDraft,
  resetComposerMemoryForTests,
  resetDraftMemoryForTests,
  resetInputHistoryForTests,
  subscribeDraftAppends,
  writeComposerState,
  writeDraft,
  writeNewSessionDraft,
} from './drafts';

function emptyState(patch: Partial<Parameters<typeof writeComposerState>[1]> = {}) {
  return {
    attachments: [],
    permissionMode: undefined,
    planMode: undefined,
    planGate: undefined,
    swarmMode: undefined,
    goalObjective: undefined,
    modelOverride: undefined,
    effortOverride: undefined,
    ...patch,
  };
}

beforeEach(() => {
  clearStoredDrafts();
});

describe('per-session composer state (memory-only)', () => {
  beforeEach(() => {
    resetComposerMemoryForTests();
  });

  it('returns an empty object for an unseen session', () => {
    expect(readComposerState('s-unseen')).toEqual({});
  });

  it('round-trips attachments and pill overrides per session', () => {
    const attachments: ComposerAttachment[] = [
      { kind: 'file', path: 'src/app.ts', name: 'app.ts', isDir: false },
    ];
    const state = emptyState({
      attachments,
      permissionMode: 'auto' as PermissionMode,
      planMode: true,
      planGate: 'gated' as const,
      goalObjective: 'ship the fix',
      modelOverride: 'kimi/k2',
      effortOverride: 'high',
    });
    writeComposerState('s1', state);
    expect(readComposerState('s1')).toEqual(state);

    writeComposerState('s2', emptyState({ swarmMode: true }));
    expect(readComposerState('s1').permissionMode).toBe('auto');
    expect(readComposerState('s2').swarmMode).toBe(true);
  });

  it('clears one session without touching its neighbours', () => {
    writeComposerState('s1', emptyState({ permissionMode: 'yolo' }));
    writeComposerState('s2', emptyState({ permissionMode: 'manual' }));
    clearComposerState('s1');
    expect(readComposerState('s1')).toEqual({});
    expect(readComposerState('s2').permissionMode).toBe('manual');
  });

  it('persists scalar model and effort overrides across memory resets without persisting permissions or attachments', () => {
    const attachments: ComposerAttachment[] = [
      { kind: 'file', path: 'src/app.ts', name: 'app.ts', isDir: false },
      {
        kind: 'image',
        name: 'example.png',
        mediaType: 'image/png',
        data: 'aW1hZ2U=',
        size: 5,
        previewUrl: 'data:image/png;base64,aW1hZ2U=',
      },
    ];
    writeComposerState('s1', emptyState({
      attachments,
      permissionMode: 'auto',
      planMode: true,
      planGate: 'gated',
      swarmMode: true,
      goalObjective: 'dangerous target',
      modelOverride: 'kimi/k2',
      effortOverride: 'high',
    }));
    expect(JSON.parse(localStorage.getItem('kiki.composerStates') ?? '{}')).toEqual({
      s1: { modelOverride: 'kimi/k2', effortOverride: 'high' },
    });

    // Reset memory as if app rebooted / reloaded
    resetComposerMemoryForTests();

    const restored = readComposerState('s1');
    expect(restored.modelOverride).toBe('kimi/k2');
    expect(restored.effortOverride).toBe('high');
    expect(restored.permissionMode).toBeUndefined();
    expect(restored.planMode).toBeUndefined();
    expect(restored.planGate).toBeUndefined();
    expect(restored.swarmMode).toBeUndefined();
    expect(restored.goalObjective).toBeUndefined();
    expect(restored.attachments).toBeUndefined();
  });

  it('ignores malformed stored scalars and removes non-whitelisted fields when updating a neighbour', () => {
    localStorage.setItem('kiki.composerStates', JSON.stringify({
      malformed: { modelOverride: 7, effortOverride: { value: 'high' } },
      previous: { modelOverride: 'fixture/model', permissionMode: 'yolo', attachments: [{ data: 'base64' }] },
    }));
    expect(readComposerState('malformed')).toEqual({});
    expect(readComposerState('previous')).toEqual({ modelOverride: 'fixture/model', effortOverride: undefined });
    writeComposerState('next', emptyState({ effortOverride: 'high' }));
    expect(JSON.parse(localStorage.getItem('kiki.composerStates') ?? '{}')).toEqual({
      previous: { modelOverride: 'fixture/model' }, next: { effortOverride: 'high' },
    });
  });

  it('round-trips and clears persisted /new draft settings', () => {
    writeNewSessionDraft({
      workspaceId: 'wd-1',
      cwd: '/path/to/work',
      profile: 'agent',
      modelOverride: 'kimi/k2',
      effortOverride: 'medium',
    });
    expect(readNewSessionDraft()).toEqual({
      workspaceId: 'wd-1',
      cwd: '/path/to/work',
      profile: 'agent',
      modelOverride: 'kimi/k2',
      effortOverride: 'medium',
    });
    clearNewSessionDraft();
    expect(readNewSessionDraft()).toEqual({});
  });
});

describe('persisted /new draft scalars', () => {
  const draft = {
    workspaceId: 'wd-1',
    cwd: '/workspace/example',
    profile: 'workspace-main',
    modelOverride: 'provider/example',
    effortOverride: 'high',
    modelFromProfile: true,
    effortFromProfile: false,
    prefillSource: JSON.stringify(['wd-1', 'workspace-main', 'entry-fixture']),
  };
  const transientState = {
    permissionMode: 'yolo',
    planMode: true,
    planGate: 'gated',
    swarmMode: true,
    goalObjective: 'Do not restore this objective',
    base64: 'aW1hZ2U=',
    attachments: [{
      kind: 'image',
      name: 'example.png',
      mediaType: 'image/png',
      data: 'aW1hZ2U=',
      size: 5,
      previewUrl: 'data:image/png;base64,aW1hZ2U=',
    }],
  };

  it.each([
    [true, true],
    [false, false],
    [true, false],
    [false, true],
  ])('round-trips modelFromProfile=%s and effortFromProfile=%s independently', (modelFromProfile, effortFromProfile) => {
    const expected = { ...draft, modelFromProfile, effortFromProfile };
    writeNewSessionDraft(expected);
    expect(JSON.parse(localStorage.getItem('kiki.newSessionDraft') ?? '{}')).toEqual(expected);

    resetComposerMemoryForTests();
    resetDraftMemoryForTests();
    expect(readNewSessionDraft()).toEqual(expected);
    clearNewSessionDraft();
    expect(localStorage.getItem('kiki.newSessionDraft')).toBeNull();
    expect(readNewSessionDraft()).toEqual({});
  });

  it('writes only the scalar whitelist, excluding permissions, modes, goal, and image payloads', () => {
    const state = { ...draft, ...transientState };
    writeNewSessionDraft(state);

    expect(JSON.parse(localStorage.getItem('kiki.newSessionDraft') ?? '{}')).toEqual(draft);
    expect(readNewSessionDraft()).toEqual(draft);
  });

  it('reads only the scalar whitelist even if storage contains transient controls and base64', () => {
    localStorage.setItem('kiki.newSessionDraft', JSON.stringify({ ...draft, ...transientState }));

    expect(readNewSessionDraft()).toEqual(draft);
  });

  it('does not coerce non-boolean source markers into profile provenance', () => {
    localStorage.setItem('kiki.newSessionDraft', JSON.stringify({
      ...draft,
      modelFromProfile: 'true',
      effortFromProfile: 1,
      prefillSource: { workspace: 'wd-1' },
    }));

    expect(readNewSessionDraft()).toEqual({
      ...draft,
      modelFromProfile: undefined,
      effortFromProfile: undefined,
      prefillSource: undefined,
    });
  });
});

describe('appendToDraft', () => {
  beforeEach(() => {
    resetDraftMemoryForTests();
  });

  it('appends to an empty draft verbatim and notifies subscribers', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeDraftAppends((sessionId) => { seen.push(sessionId); });
    appendToDraft('s1', '@src/app.ts');
    expect(readDraft('s1')).toBe('@src/app.ts');
    expect(seen).toEqual(['s1']);
    unsubscribe();
  });

  it('separates from a non-empty draft with a single space', () => {
    writeDraft('s1', 'look at this');
    appendToDraft('s1', '@src/app.ts');
    expect(readDraft('s1')).toBe('look at this @src/app.ts');
    appendToDraft('s1', '@src/boot.ts');
    expect(readDraft('s1')).toBe('look at this @src/app.ts @src/boot.ts');
  });

  it('does not double-separate after trailing whitespace and ignores empty text', () => {
    writeDraft('s1', 'trailing ');
    appendToDraft('s1', '@x.ts');
    expect(readDraft('s1')).toBe('trailing @x.ts');
    appendToDraft('s1', '');
    expect(readDraft('s1')).toBe('trailing @x.ts');
  });

  it('unsubscribed listeners stop firing', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeDraftAppends((sessionId) => { seen.push(sessionId); });
    unsubscribe();
    appendToDraft('s1', '@x.ts');
    expect(seen).toEqual([]);
  });
});

describe('per-session input history (memory-only)', () => {
  beforeEach(() => {
    resetInputHistoryForTests();
  });

  it('appends newest-last and ignores empty text', () => {
    pushInputHistory('s1', 'first');
    pushInputHistory('s1', '  second  ');
    pushInputHistory('s1', '');
    pushInputHistory('s1', '   ');
    expect(readInputHistory('s1')).toEqual(['first', 'second']);
  });

  it('scopes entries per key and dedupes a consecutive repeat', () => {
    pushInputHistory('s1', 'same');
    pushInputHistory('s1', 'same');
    pushInputHistory('s2', 'same');
    expect(readInputHistory('s1')).toEqual(['same']);
    expect(readInputHistory('s2')).toEqual(['same']);
    // A non-consecutive repeat is a new entry.
    pushInputHistory('s1', 'other');
    pushInputHistory('s1', 'same');
    expect(readInputHistory('s1')).toEqual(['same', 'other', 'same']);
  });

  it('drops the oldest entries past the cap', () => {
    for (let index = 0; index < INPUT_HISTORY_LIMIT + 5; index += 1) {
      pushInputHistory('s1', `prompt ${index}`);
    }
    const list = readInputHistory('s1');
    expect(list).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(list[0]).toBe('prompt 5');
    expect(list.at(-1)).toBe(`prompt ${INPUT_HISTORY_LIMIT + 4}`);
  });
});
