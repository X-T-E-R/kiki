import { outputLayerConfigurationSchema, outputLayerEventSchema, outputLayerRequestSchema } from '@kiki/protocol';
import type { OutputLayerFacade } from '../../core/facade/output-layer.js';
import type { HttpRestTransport } from './rest.js';

export function createOutputLayerFacade(transport: HttpRestTransport): OutputLayerFacade {
  return {
    configuration: async (options) => outputLayerConfigurationSchema.parse(await transport.json('/output-layer/configuration', {
      ...options, query: { session_id: options?.sessionId },
    })),
    configure: async (body, options) => outputLayerConfigurationSchema.parse(await transport.json('/output-layer/configuration', { ...options, method: 'PUT', body })),
    stream: (input, onEvent, options) => transport.raw('/output-layer/stream', {
      ...options, method: 'POST', body: outputLayerRequestSchema.parse(input), timeoutMs: options?.timeoutMs ?? 0,
    }, async (response) => {
      if (!response.ok) throw new Error(`Output layer request failed (${response.status})`);
      if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
        const envelope = await response.json() as { msg?: string };
        throw new Error(envelope.msg ?? 'Output layer stream unavailable');
      }
      if (response.body === null) throw new Error('Output layer response has no body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let terminal = false;
      const deliver = (line: string) => {
        if (!line.trim()) return;
        const event = outputLayerEventSchema.parse(JSON.parse(line));
        terminal ||= ['completed', 'cancelled', 'failed'].includes(event.type);
        onEvent(event);
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            deliver(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
          if (done) break;
        }
        deliver(pending);
        if (!terminal) throw new Error('Output layer stream ended before completion');
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }),
  };
}
