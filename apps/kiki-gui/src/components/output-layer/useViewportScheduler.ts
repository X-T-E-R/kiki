/**
 * useViewportScheduler — coordinates priority-based chunk processing for the visible
 * viewport and preloading chunks before/after the viewport.
 */

import { useEffect, useCallback } from 'react';
import type {
  OutputLayerPreset,
  OutputLayerSettings,
  OutputLayerSource,
  OutputLayerResult,
  StreamProcessChunkOptions,
} from './types';
import {
  OutputLayerClient,
  OUTPUT_LAYER_DEFAULT_SETTINGS,
} from './types';
import { getActiveOutputLayerClient } from './useOutputLayerClient';

// Global processor adapter that can be registered for testing or custom overrides
let globalChunkProcessor: ((options: StreamProcessChunkOptions) => Promise<string>) | null = null;
let defaultBackendClient: OutputLayerClient | null = null;

export function registerChunkProcessor(processor: ((options: StreamProcessChunkOptions) => Promise<string>) | null) {
  globalChunkProcessor = processor;
}

export function bindOutputLayerBackendClient(client: OutputLayerClient | null) {
  defaultBackendClient = client;
}

export function getChunkProcessor() {
  return globalChunkProcessor;
}

export interface QueuedChunk {
  sessionId: string;
  messageId: string;
  chunkIndex: number;
  totalChunks: number;
  text: string;
  preset: OutputLayerPreset;
  settings?: OutputLayerSettings;
  priority: number; // Higher number = higher priority (visible = 100, preloaded = 50, retry = 150)
  onUpdate?: (result: OutputLayerResult) => void;
}

class SchedulerQueue {
  private queue: QueuedChunk[] = [];
  private activeControllers = new Map<string, AbortController>();
  private inFlight = 0;
  private maxConcurrency = 2;

  private itemKey(item: Pick<QueuedChunk, 'sessionId' | 'messageId' | 'chunkIndex' | 'preset'>): string {
    return `${item.sessionId}:${item.messageId}:${item.chunkIndex}:${item.preset.id}`;
  }

  public enqueue(item: QueuedChunk) {
    const key = this.itemKey(item);
    // Already in flight
    if (this.activeControllers.has(key)) return;

    // Check if already in queue
    const existingIndex = this.queue.findIndex((q) => this.itemKey(q) === key);

    if (existingIndex >= 0) {
      // Update priority and callback if higher
      if (item.priority > this.queue[existingIndex]!.priority) {
        this.queue[existingIndex]!.priority = item.priority;
        this.queue[existingIndex]!.onUpdate = item.onUpdate ?? this.queue[existingIndex]!.onUpdate;
        this.sortQueue();
      }
      return;
    }

    this.queue.push(item);
    this.sortQueue();
    this.pump();
  }

  private sortQueue() {
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  public cancel(sessionId: string, messageId: string, chunkIndex: number, presetId?: string) {
    const prefix = `${sessionId}:${messageId}:${chunkIndex}:`;
    const sourceId = `${messageId}:${chunkIndex}`;

    for (const [key, controller] of this.activeControllers.entries()) {
      if (presetId ? key === `${prefix}${presetId}` : key.startsWith(prefix)) {
        controller.abort();
        this.activeControllers.delete(key);
      }
    }
    this.queue = this.queue.filter((q) =>
      presetId
        ? this.itemKey(q) !== `${prefix}${presetId}`
        : !(q.sessionId === sessionId && q.messageId === messageId && q.chunkIndex === chunkIndex),
    );

    const client = defaultBackendClient ?? getActiveOutputLayerClient();
    client?.cancel(sessionId, sourceId);
  }

  public cancelAllForSession(sessionId: string) {
    for (const [key, controller] of this.activeControllers.entries()) {
      if (key.startsWith(`${sessionId}:`)) {
        controller.abort();
        this.activeControllers.delete(key);
      }
    }
    this.queue = this.queue.filter((q) => q.sessionId !== sessionId);

    const client = defaultBackendClient ?? getActiveOutputLayerClient();
    client?.cancel(sessionId);
  }

  public invalidateSource(sessionId: string, messageId: string, chunkIndex: number) {
    const sourceId = `${messageId}:${chunkIndex}`;
    this.cancel(sessionId, messageId, chunkIndex);
    const client = defaultBackendClient ?? getActiveOutputLayerClient();
    client?.invalidateSource(sessionId, sourceId);
  }

  private pump() {
    if (this.inFlight >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const next = this.queue.shift();
    if (!next) return;

    const key = this.itemKey(next);
    const controller = new AbortController();
    this.activeControllers.set(key, controller);
    this.inFlight++;

    const source: OutputLayerSource = {
      sessionId: next.sessionId,
      sourceId: `${next.messageId}:${next.chunkIndex}`,
      sourceRevision: '1',
      text: next.text,
    };

    const effectiveSettings: OutputLayerSettings = next.settings ?? OUTPUT_LAYER_DEFAULT_SETTINGS;

    const initialResult: OutputLayerResult = {
      ...source,
      status: 'queued',
      output: '',
    };
    next.onUpdate?.(initialResult);

    const processor = globalChunkProcessor;
    if (processor) {
      processor({
        sessionId: next.sessionId,
        messageId: next.messageId,
        chunkIndex: next.chunkIndex,
        totalChunks: next.totalChunks,
        text: next.text,
        preset: next.preset,
        settings: effectiveSettings,
        signal: controller.signal,
        onDelta: (delta: string) => {
          next.onUpdate?.({
            ...source,
            status: 'streaming',
            output: delta,
          });
        },
      })
        .then((fullResult) => {
          next.onUpdate?.({
            ...source,
            status: 'completed',
            output: fullResult,
          });
        })
        .catch((err) => {
          const status = controller.signal.aborted ? 'cancelled' : 'failed';
          next.onUpdate?.({
            ...source,
            status,
            output: '',
            error: controller.signal.aborted ? undefined : err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.activeControllers.delete(key);
          this.inFlight--;
          this.pump();
        });
      return;
    }

    const client = defaultBackendClient ?? getActiveOutputLayerClient();
    if (client) {
      client
        .process(source, next.preset, effectiveSettings, (update) => {
          next.onUpdate?.(update);
        })
        .catch((err) => {
          const status = controller.signal.aborted ? 'cancelled' : 'failed';
          next.onUpdate?.({
            ...source,
            status,
            output: '',
            error: controller.signal.aborted ? undefined : err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.activeControllers.delete(key);
          this.inFlight--;
          this.pump();
        });
      return;
    }

    // No client and no processor available
    this.activeControllers.delete(key);
    this.inFlight--;
    next.onUpdate?.({
      ...source,
      status: 'failed',
      output: '',
      error: 'No Output Layer client available',
    });
    this.pump();
  }
}

export const schedulerQueue = new SchedulerQueue();

/**
 * Hook to manage viewport processing for a chunk of a message.
 */
export function useChunkViewportScheduler({
  sessionId,
  messageId,
  chunkIndex,
  totalChunks,
  chunkText,
  preset,
  settings,
  isIntersecting,
  enabled,
  priority = 100,
  onUpdate,
}: {
  sessionId?: string;
  messageId: string;
  chunkIndex: number;
  totalChunks: number;
  chunkText: string;
  preset?: OutputLayerPreset;
  settings?: OutputLayerSettings;
  isIntersecting: boolean;
  enabled: boolean;
  priority?: number;
  onUpdate?: (result: OutputLayerResult) => void;
}) {
  const currentSessionId = sessionId ?? '__global__';

  useEffect(() => {
    if (!enabled || !preset || !chunkText.trim()) return;

    if (isIntersecting) {
      schedulerQueue.enqueue({
        sessionId: currentSessionId,
        messageId,
        chunkIndex,
        totalChunks,
        text: chunkText,
        preset,
        settings,
        priority,
        onUpdate,
      });
    }
  }, [
    enabled,
    preset,
    settings,
    chunkText,
    isIntersecting,
    currentSessionId,
    messageId,
    chunkIndex,
    totalChunks,
    priority,
    onUpdate,
  ]);

  const retry = useCallback(() => {
    if (!preset || !chunkText.trim()) return;
    schedulerQueue.enqueue({
      sessionId: currentSessionId,
      messageId,
      chunkIndex,
      totalChunks,
      text: chunkText,
      preset,
      settings,
      priority: 150, // Manual retry gets highest priority
      onUpdate,
    });
  }, [preset, settings, chunkText, currentSessionId, messageId, chunkIndex, totalChunks, onUpdate]);

  const cancel = useCallback(() => {
    schedulerQueue.cancel(currentSessionId, messageId, chunkIndex, preset?.id);
  }, [preset?.id, currentSessionId, messageId, chunkIndex]);

  return { retry, cancel };
}
