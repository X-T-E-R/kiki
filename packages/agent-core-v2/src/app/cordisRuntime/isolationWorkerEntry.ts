import { deserialize, getHeapStatistics, serialize } from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';

import type { IsolationMessage, IsolationRequest, IsolationResponse, IsolationWorkerData } from './isolationProtocol';

type Handler = (payload: unknown, context: Omit<IsolationRequest, 'payload'> & {
  readonly settings: Readonly<Record<string, unknown>>;
}) => unknown;

const { entryUrl, settings, maxPayloadBytes, oldSpaceMb } = workerData as IsolationWorkerData;
const port = parentPort!;
const observedMb = getHeapStatistics().heap_size_limit / (1024 * 1024);
if (observedMb > oldSpaceMb + 256 || observedMb < oldSpaceMb * 0.9) {
  process.emitWarning(`Plugin isolate heap limit ${Math.round(observedMb)} MiB differs from requested old space ${oldSpaceMb} MiB`);
}

let handlers: Promise<Readonly<Record<string, Handler>>> | undefined;

async function loadHandlers(): Promise<Readonly<Record<string, Handler>>> {
  const entry = await import(entryUrl);
  const slots = entry.slots ?? entry.default?.slots;
  if (typeof slots !== 'object' || slots === null) throw new TypeError('Plugin entry must export a slots handler map');
  return slots;
}

port.on('message', async ({ id, bytes }: IsolationMessage) => {
  const { payload, ...context } = deserialize(bytes) as IsolationRequest;
  const { pluginId, generation, attemptId, conversationRevision, slot } = context;
  const started = performance.now();
  const identity = () => ({ pluginId, generation, attemptId, conversationRevision, durationMs: performance.now() - started });
  let result: Uint8Array;
  try {
    const table = await (handlers ??= loadHandlers());
    const handler = Object.hasOwn(table, slot) ? table[slot] : undefined;
    if (typeof handler !== 'function') throw new Error(`Plugin did not register slot ${slot}`);
    const value = await handler(payload, { ...context, settings });
    result = serialize({ ...identity(), ok: true, value } satisfies IsolationResponse);
    if (result.byteLength > maxPayloadBytes) throw new RangeError('Plugin isolate response exceeds the byte limit');
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
    result = serialize({ ...identity(), ok: false, message } satisfies IsolationResponse);
  }
  port.postMessage({ id, bytes: result } satisfies IsolationMessage);
});
