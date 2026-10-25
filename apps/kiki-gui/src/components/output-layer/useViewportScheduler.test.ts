// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerChunkProcessor,
  schedulerQueue,
} from './useViewportScheduler';
import type { OutputLayerPreset, OutputLayerResult, StreamProcessChunkOptions } from './types';

describe('useViewportScheduler queue', () => {
  const dummyPreset: OutputLayerPreset = {
    id: 'test-p',
    label: 'Test',
    instruction: 'prompt',
    contextWindow: 32768,
    maxOutputTokens: 2048,
  };

  beforeEach(() => {
    schedulerQueue.cancelAllForSession('test-s');
    registerChunkProcessor(null);
  });

  it('processes queued chunks using registered processor with streaming deltas', async () => {
    const processor = vi.fn(async (options: StreamProcessChunkOptions) => {
      options.onDelta?.('chunk-');
      options.onDelta?.('processed');
      return 'chunk-processed';
    });
    registerChunkProcessor(processor);

    let lastResult: OutputLayerResult | undefined;
    schedulerQueue.enqueue({
      sessionId: 'test-s',
      messageId: 'msg-1',
      chunkIndex: 0,
      totalChunks: 1,
      text: 'source',
      preset: dummyPreset,
      priority: 100,
      onUpdate: (res) => {
        lastResult = res;
      },
    });

    // Wait for async pump
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(processor).toHaveBeenCalledTimes(1);
    expect(lastResult?.status).toBe('completed');
    expect(lastResult?.output).toBe('chunk-processed');
  });

  it('handles error in processor gracefully', async () => {
    const processor = vi.fn(async () => {
      throw new Error('Network timeout');
    });
    registerChunkProcessor(processor);

    let lastResult: OutputLayerResult | undefined;
    schedulerQueue.enqueue({
      sessionId: 'test-s',
      messageId: 'msg-2',
      chunkIndex: 0,
      totalChunks: 1,
      text: 'source text',
      preset: dummyPreset,
      priority: 100,
      onUpdate: (res) => {
        lastResult = res;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(lastResult?.status).toBe('failed');
    expect(lastResult?.error).toBe('Network timeout');
  });
});
