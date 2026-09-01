import { beforeEach, describe, expect, it } from 'vitest';

import type { PermissionMode } from '@moonshot-ai/protocol';

import type { ComposerAttachment } from './attachments';
import {
  clearComposerState,
  readComposerState,
  resetComposerMemoryForTests,
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
