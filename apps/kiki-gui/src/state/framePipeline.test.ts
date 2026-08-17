import { describe, expect, it } from 'vitest';

import type { SessionEventFrame } from '../lib/types';
import { FrameBuffer } from './framePipeline';

function frame(
  payload: SessionEventFrame['payload'],
  options: { volatile?: boolean; offset?: number; seq?: number } = {},
): SessionEventFrame {
  return {
    type: payload.type,
    seq: options.seq ?? 10,
    epoch: options.volatile === true ? undefined : 'epoch-1',
    volatile: options.volatile,
    offset: options.offset,
    session_id: 'session-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

describe('FrameBuffer', () => {
  it('concatenates consecutive cumulative assistant deltas from the first offset', () => {
    const buffer = new FrameBuffer();
    buffer.push(frame({ type: 'assistant.delta', turnId: 1, delta: 'hel' }, { volatile: true, offset: 0 }));
    buffer.push(frame({ type: 'assistant.delta', turnId: 1, delta: 'lo' }, { volatile: true, offset: 3 }));
    const frames = buffer.drain();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.offset).toBe(0);
    expect((frames[0]?.payload as { delta: string }).delta).toBe('hello');
  });

  it('concatenates a cumulative thinking burst without losing the first offset', () => {
    const buffer = new FrameBuffer();
    buffer.push(frame({ type: 'thinking.delta', turnId: 1, delta: 'think' }, { volatile: true, offset: 0 }));
    buffer.push(frame({ type: 'thinking.delta', turnId: 1, delta: 'ing' }, { volatile: true, offset: 5 }));
    const frames = buffer.drain();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.offset).toBe(0);
    expect((frames[0]?.payload as { delta: string }).delta).toBe('thinking');
  });

  it('keeps offset rewrites as a separate ordered frame', () => {
    const buffer = new FrameBuffer();
    buffer.push(frame({ type: 'assistant.delta', turnId: 1, delta: 'hello' }, { volatile: true, offset: 0 }));
    buffer.push(frame({ type: 'assistant.delta', turnId: 1, delta: 'p!' }, { volatile: true, offset: 3 }));
    expect(buffer.drain()).toHaveLength(2);
  });

  it('uses durable frames and key changes as ordering barriers', () => {
    const buffer = new FrameBuffer();
    buffer.push(frame({ type: 'tool.call.delta', turnId: 1, toolCallId: 'a', argumentsPart: '1' }, { volatile: true }));
    buffer.push(frame({ type: 'turn.step.started', turnId: 1, step: 2 }, { seq: 11 }));
    buffer.push(frame({ type: 'tool.call.delta', turnId: 1, toolCallId: 'a', argumentsPart: '2' }, { volatile: true }));
    expect(buffer.drain().map((item) => item.payload.type)).toEqual([
      'tool.call.delta',
      'turn.step.started',
      'tool.call.delta',
    ]);
  });

  it('retains only the latest consecutive progress frame and concatenates shell output', () => {
    const progress = new FrameBuffer();
    progress.push(frame({ type: 'tool.progress', turnId: 1, toolCallId: 'a', update: { kind: 'progress', text: 'one' } }, { volatile: true }));
    progress.push(frame({ type: 'tool.progress', turnId: 1, toolCallId: 'a', update: { kind: 'progress', text: 'two' } }, { volatile: true }));
    expect((progress.drain()[0]?.payload as { update: { text: string } }).update.text).toBe('two');

    const shell = new FrameBuffer();
    shell.push(frame({ type: 'shell.output', commandId: 'cmd', update: { kind: 'stdout', text: 'a' } }, { volatile: true }));
    shell.push(frame({ type: 'shell.output', commandId: 'cmd', update: { kind: 'stdout', text: 'b' } }, { volatile: true }));
    expect((shell.drain()[0]?.payload as { update: { text: string } }).update.text).toBe('ab');
  });

  it('clears an unsafe quarantine when either bound is exceeded', () => {
    const buffer = new FrameBuffer({ maxFrames: 1, maxBytes: 10_000 });
    expect(buffer.push(frame({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }, { seq: 11 })).overflowed).toBe(false);
    expect(buffer.push(frame({ type: 'turn.ended', turnId: 1, reason: 'completed' }, { seq: 12 })).overflowed).toBe(true);
    expect(buffer.length).toBe(0);
  });
});
