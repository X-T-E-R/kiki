import {
  interactionRespondRequestSchema,
  interactionRespondResultSchema,
  llmCompleteRequestSchema,
  llmCompleteResponseSchema,
  llmCompleteStreamEventSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  rawEventFrameSchema,
  sessionCreateSchema,
  sessionSchema,
} from '@kiki/protocol';
import type { RawSubstrateFacade } from '../../core/facade/raw-substrate.js';
import type { HttpRestTransport } from './rest.js';

async function readEventStream(
  response: Response,
  format: 'sse' | 'ndjson',
  onJson: (raw: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok) {
    throw new Error(`Stream request failed (${response.status})`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const envelope = (await response.json()) as { msg?: string; code?: number };
    throw new Error(envelope.msg ?? `Stream endpoint returned JSON envelope (${envelope.code ?? response.status})`);
  }
  if (response.body === null) throw new Error('Stream response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  let pending = '';
  let sseDataLines: string[] = [];

  const flushSseEvent = () => {
    if (sseDataLines.length === 0) return;
    const payload = sseDataLines.join('\n').trim();
    sseDataLines = [];
    if (payload.length > 0) onJson(JSON.parse(payload));
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (format === 'ndjson') {
      if (line.trim().length > 0) onJson(JSON.parse(line));
      return;
    }
    if (line === '') {
      flushSseEvent();
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('data:')) {
      const value = line.slice(5);
      sseDataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  };

  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        processLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (done) break;
    }
    if (pending.length > 0) processLine(pending);
    if (format === 'sse') flushSseEvent();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createRawSubstrateFacade(transport: HttpRestTransport): RawSubstrateFacade {
  return {
    createSession: async (body, options) =>
      sessionSchema.parse(
        await transport.json('/sessions', {
          ...options,
          method: 'POST',
          body: sessionCreateSchema.parse(body),
        }),
      ),

    submitPrompt: async (sessionId, body, options) =>
      promptSubmitResultSchema.parse(
        await transport.json(`/sessions/${encodeURIComponent(sessionId)}/prompts`, {
          ...options,
          method: 'POST',
          body: promptSubmissionSchema.parse(body),
          timeoutMs: options?.timeoutMs ?? (body.wait === true ? 0 : undefined),
        }),
      ),

    streamSessionEvents: async (sessionId, onFrame, options) => {
      const format = options?.format ?? 'ndjson';
      await transport.raw(
        `/sessions/${encodeURIComponent(sessionId)}/events`,
        {
          ...options,
          method: 'GET',
          query: {
            after: options?.after,
            grade: options?.grade,
          },
          headers: {
            accept: format === 'ndjson' ? 'application/x-ndjson' : 'text/event-stream',
          },
          timeoutMs: options?.timeoutMs ?? 0,
        },
        (response) =>
          readEventStream(
            response,
            format,
            (raw) => onFrame(rawEventFrameSchema.parse(raw)),
            options?.signal,
          ),
      );
    },

    streamGlobalEvents: async (onFrame, options) => {
      const format = options?.format ?? 'ndjson';
      await transport.raw(
        '/events',
        {
          ...options,
          method: 'GET',
          query: { after: options?.after },
          headers: {
            accept: format === 'ndjson' ? 'application/x-ndjson' : 'text/event-stream',
          },
          timeoutMs: options?.timeoutMs ?? 0,
        },
        (response) =>
          readEventStream(
            response,
            format,
            (raw) => onFrame(rawEventFrameSchema.parse(raw)),
            options?.signal,
          ),
      );
    },

    llmComplete: async (input, options) =>
      llmCompleteResponseSchema.parse(
        await transport.json('/llm:complete', {
          ...options,
          method: 'POST',
          body: llmCompleteRequestSchema.parse({ ...input, stream: false }),
          timeoutMs: options?.timeoutMs ?? 0,
        }),
      ),

    llmCompleteStream: async (input, onEvent, options) => {
      const format = options?.format ?? 'ndjson';
      await transport.raw(
        '/llm:complete',
        {
          ...options,
          method: 'POST',
          body: llmCompleteRequestSchema.parse({ ...input, stream: true }),
          headers: {
            accept: format === 'ndjson' ? 'application/x-ndjson' : 'text/event-stream',
          },
          timeoutMs: options?.timeoutMs ?? 0,
        },
        (response) =>
          readEventStream(
            response,
            format,
            (raw) => onEvent(llmCompleteStreamEventSchema.parse(raw)),
            options?.signal,
          ),
      );
    },

    respondInteraction: async (sessionId, interactionId, body, options) =>
      interactionRespondResultSchema.parse(
        await transport.json(
          `/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}:respond`,
          {
            ...options,
            method: 'POST',
            body: interactionRespondRequestSchema.parse(body),
          },
        ),
      ),
  };
}
