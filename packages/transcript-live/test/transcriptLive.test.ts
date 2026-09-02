import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentTranscript } from '@moonshot-ai/transcript';
import { describe, expect, it } from 'vitest';

import {
  AgentTranscriptLiveAdapter,
  descriptorFromMeta,
  projectPromptContentParts,
  readWireRecords,
  toLegacyPhase,
  type LiveAdapterBusEvent,
} from '../src';

function event(payload: Record<string, unknown>): LiveAdapterBusEvent {
  return payload as unknown as LiveAdapterBusEvent;
}

describe('@kiki/transcript-live', () => {
  it('projects engine turn events into canonical transcript operations', () => {
    const adapter = new AgentTranscriptLiveAdapter('main');
    const transcript = new AgentTranscript('main');

    transcript.apply(adapter.map(event({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'hello' })));
    transcript.apply(adapter.map(event({ type: 'turn.step.started', turnId: 1, step: 1, stepId: 'step-1' })));
    transcript.apply(adapter.map(event({ type: 'assistant.delta', turnId: 1, delta: 'world' })));
    transcript.apply(adapter.map(event({ type: 'turn.ended', turnId: 1, reason: 'completed' })));

    expect(transcript.getTurn('t1')).toMatchObject({
      state: 'completed',
      prompt: 'hello',
      steps: [
        expect.objectContaining({
          frames: [expect.objectContaining({ kind: 'text', role: 'assistant', text: 'world' })],
        }),
      ],
    });
  });

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

  it('reads complete wire records and ignores a truncated final line', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-live-wire-'));
    const wirePath = join(home, 'wire.jsonl');
    try {
      await writeFile(wirePath, '{"type":"turn.started","turnId":1}\n{"type":"turn.ended"');
      await expect(readWireRecords(wirePath)).resolves.toEqual([
        { type: 'turn.started', turnId: 1 },
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
