import { z } from 'zod';
import { SeatKlientError } from './client.js';

export const contextProcedureTable = [
  { name: 'memory_read', toolName: 'kiki_memory_read', nativeName: 'MemoryRead', group: 'memory' },
  { name: 'memory_search', toolName: 'kiki_memory_search', nativeName: 'MemorySearch', group: 'memory' },
  { name: 'memory_write', toolName: 'kiki_memory_write', nativeName: 'MemoryWrite', group: 'memory' },
  { name: 'board_read', toolName: 'kiki_board_read', nativeName: 'BoardRead', group: 'board' },
  { name: 'board_write', toolName: 'kiki_board_write', nativeName: 'BoardWrite', group: 'board' },
  { name: 'cron', toolName: 'kiki_cron', nativeName: 'Cron', group: 'cron' },
  { name: 'thread_list', toolName: 'kiki_thread_list', nativeName: 'ThreadList', group: 'threads' },
  { name: 'thread_read', toolName: 'kiki_thread_read', nativeName: 'ThreadRead', group: 'threads' },
  { name: 'thread_send', toolName: 'kiki_thread_send', nativeName: 'ThreadSend', group: 'threads' },
  { name: 'history_search', toolName: 'kiki_history_search', nativeName: 'HistorySearch', group: 'history' },
  { name: 'history_read', toolName: 'kiki_history_read', nativeName: 'HistoryRead', group: 'history' },
] as const;

export const contextReadOnlyTools: ReadonlySet<string> = new Set([
  'kiki_memory_read', 'kiki_memory_search', 'kiki_board_read', 'kiki_thread_list', 'kiki_thread_read', 'kiki_history_search', 'kiki_history_read',
]);

export const contextCatalogSchema = z.object({
  delegation: z.boolean(),
  tools: z.array(z.object({
    name: z.string(),
    toolName: z.string(),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  })),
});
export type ContextCatalog = z.infer<typeof contextCatalogSchema>;
export const contextCallSchema = z.object({
  name: z.enum(contextProcedureTable.map((entry) => entry.name)),
  arguments: z.record(z.string(), z.unknown()),
}).strict();
export const contextResultSchema = z.object({ output: z.unknown(), isError: z.boolean().optional() });

export function createContextKlient(options: {
  readonly endpoint: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const request = async (action: string, input: unknown, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetchImpl(`${options.endpoint.replace(/\/$/u, '')}/api/klient/delegation/context/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
    const envelope = await response.json() as { code: number; msg: string; data?: unknown; details?: unknown };
    if (!response.ok || envelope.code !== 0) throw new SeatKlientError(envelope.code, envelope.msg, envelope.details);
    return envelope.data;
  };
  return {
    catalog: async (signal?: AbortSignal) => contextCatalogSchema.parse(await request('catalog', {}, signal)),
    call: async (input: z.infer<typeof contextCallSchema>, signal?: AbortSignal) =>
      contextResultSchema.parse(await request('call', contextCallSchema.parse(input), signal)),
    hook: async (input: unknown, signal?: AbortSignal) => request('hook', input, signal),
  };
}
