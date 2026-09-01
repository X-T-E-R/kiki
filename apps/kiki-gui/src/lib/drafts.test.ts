import { beforeEach, describe, expect, it } from 'vitest';

import type { PermissionMode } from '@moonshot-ai/protocol';

import type { ComposerAttachment } from './attachments';
import {
  clearComposerState,
  INPUT_HISTORY_LIMIT,
  pushInputHistory,
  readComposerState,
  readInputHistory,
  resetComposerMemoryForTests,
  resetInputHistoryForTests,
  writeComposerState,
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
