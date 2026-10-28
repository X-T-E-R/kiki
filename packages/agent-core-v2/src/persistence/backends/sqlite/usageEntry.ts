import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
// oxlint-disable-next-line import/extensions
import { UsageDatabase } from './usageDatabase.ts';
import type { UsageStoreRequest, UsageStoreResponse } from './usageProtocol.ts';

const port = parentPort;
if (port === null) throw new Error('Usage database requires a worker');
const options = workerData as { database: string; writable: boolean };
let database: UsageDatabase | undefined;
let cancellation: Int32Array | undefined;
const check = (): void => { if (cancellation !== undefined && Atomics.load(cancellation, 0) !== 0) throw new DOMException('Usage read cancelled', 'AbortError'); };
let lane = Promise.resolve();
port.on('message', (request: UsageStoreRequest) => {
  lane = lane.then(async () => {
    cancellation = request.cancellation === undefined ? undefined : new Int32Array(request.cancellation);
    let response: UsageStoreResponse;
    try {
      const deadline = Date.now() + 5000;
      let result: unknown;
      for (let retry = 25; ; retry = Math.min(retry * 2, 250)) {
        try {
          check();
          database ??= new UsageDatabase(options.database, options.writable, check);
          result = database.execute(request.operation);
          break;
        } catch (error) {
          const code = Number((error as { errcode?: number }).errcode) & 255;
          if ((code !== 5 && code !== 6) || Date.now() + retry > deadline) throw error;
          await delay(retry);
        }
      }
      response = { id: request.id, result };
    } catch (error) {
      const value = error as { message?: string; code?: string; committed?: boolean };
      response = { id: request.id, error: { message: value.message ?? String(error), code: value.code, committed: value.committed } };
    }
    cancellation = undefined;
    port.postMessage(response);
    if (request.operation.type === 'close') port.close();
  });
});
