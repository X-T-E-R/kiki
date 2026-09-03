import { describe, expect, it } from 'vitest';

import {
  descriptorFromMeta,
  projectPromptContentParts,
  toLegacyPhase,
} from '../src';

describe('@kiki/transcript-live projection helpers', () => {
  it('projects prompt media without exposing daemon file paths', () => {
    expect(
      projectPromptContentParts([
        { type: 'text', text: 'look' },
        {
          type: 'image_url',
          imageUrl: { url: 'kimi-file://f_img1?path=%2Fexample%2Fsession%2Fmedia%2Ff_img1.png' },
        },
      ]),
    ).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { kind: 'session_media', file_id: 'f_img1' } },
    ]);
  });

  it('maps native activity state to the shared protocol phase', () => {
    expect(
      toLegacyPhase({
        lifecycle: 'ready',
        turn: undefined,
        lastTurn: {
          turnId: 3,
          reason: 'completed',
          durationMs: 250,
          at: 1_700_000_000_000,
        },
        background: [],
      }),
    ).toEqual({
      kind: 'ended',
      turnId: 3,
      reason: 'completed',
      durationMs: 250,
      at: 1_700_000_000_000,
    });
  });

  it('resolves transcript agent descriptors from persisted metadata', () => {
    expect(
      descriptorFromMeta('child-1', {
        type: 'sub',
        displayName: 'explore',
        userLabel: 'source_scan',
        delegator: { kind: 'agent', agentId: 'main' },
      }),
    ).toEqual({
      agentId: 'child-1',
      type: 'sub',
      parentAgentId: 'main',
      delegator: { kind: 'agent', agentId: 'main' },
      label: 'source_scan',
    });
  });
});
