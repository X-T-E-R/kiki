import { MessageChannel } from 'node:worker_threads';
import type { CpuRequestOptions } from './host';

export type CpuExecutor = <T>(operation: unknown, options?: CpuRequestOptions) => Promise<T>;

export async function runCpuStream<T>(execute: CpuExecutor, operation: object, source: (signal: AbortSignal) => AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const channel = new MessageChannel();
  const controller = new AbortController();
  const abort = (): void => { controller.abort(signal!.reason); };
  signal?.addEventListener('abort', abort, { once: true });
  let credit = false;
  let ready: (() => void) | undefined;
  const wake = (): void => { const resolve = ready; ready = undefined; resolve?.(); };
  channel.port1.on('message', () => { credit = true; wake(); });
  controller.signal.addEventListener('abort', wake);
  const pull = async (): Promise<void> => {
    if (!credit && !controller.signal.aborted) await new Promise<void>((resolve) => { ready = resolve; });
    controller.signal.throwIfAborted();
    credit = false;
  };
  const request = execute<T>({ ...operation, input: channel.port2 }, { signal: controller.signal, transferList: [channel.port2] });
  const produce = (async () => {
    try {
      const iterator = source(controller.signal)[Symbol.asyncIterator]();
      try {
        for (;;) {
          await pull();
          const next = await iterator.next();
          if (next.done) { channel.port1.postMessage({ end: true }); break; }
          for (let offset = 0; offset < next.value.byteLength; offset += 1024 * 1024) {
            if (offset > 0) await pull();
            const bytes = Uint8Array.from(next.value.subarray(offset, offset + 1024 * 1024)).buffer;
            channel.port1.postMessage({ bytes }, [bytes]);
          }
          if (next.value.byteLength === 0) credit = true;
        }
      } finally { await iterator.return?.(); }
    } catch (error) { controller.abort(error); throw error; }
  })();
  try {
    const [result] = await Promise.all([request, produce]);
    return result;
  } finally {
    controller.abort(new Error('CPU stream finished'));
    wake();
    channel.port1.close();
    channel.port2.close();
    signal?.removeEventListener('abort', abort);
    await produce.catch(() => {});
  }
}
