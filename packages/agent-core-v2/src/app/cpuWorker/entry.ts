import { parentPort } from 'node:worker_threads';
import { toErrorPayload, isCodedError } from '#/_base/errors/serialize';
import type { CpuRequest, CpuResponse } from './protocol';
import { executeCpuOperation, type CpuOperation } from './tasks';

import { RESOURCE_DEFAULTS } from '#/_base/node/resourceDefaults';
import { warnIfWorkerHeapLimit } from '#/_base/node/workerHeapPolicy';

warnIfWorkerHeapLimit(RESOURCE_DEFAULTS.workerHeapMb);
const port = parentPort;
if (port === null) throw new Error('CPU worker requires a parent port');

function createRequestSignal(cancellation?: SharedArrayBuffer): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const signal = controller.signal;
  if (cancellation === undefined) return { signal, dispose: () => {} };
  const view = new Int32Array(cancellation);
  const isCancelled = (): boolean => Atomics.load(view, 0) !== 0;
  const abortError = (): DOMException => new DOMException('CPU operation cancelled', 'AbortError');
  Object.defineProperties(signal, {
    aborted: { get: isCancelled },
    reason: { get: () => (isCancelled() ? abortError() : undefined) },
    throwIfAborted: { value: () => { if (isCancelled()) throw abortError(); } },
  });
  let fired = false;
  const timer = setInterval(() => {
    if (!fired && isCancelled()) {
      fired = true;
      controller.abort(abortError());
    }
  }, 10);
  timer.unref();
  return {
    signal,
    dispose: () => { clearInterval(timer); },
  };
}

async function execute(request: CpuRequest): Promise<void> {
  const { signal, dispose } = createRequestSignal(request.cancellation);
  let response: CpuResponse;
  try {
    signal.throwIfAborted();
    const result = await executeCpuOperation(request.operation as CpuOperation, signal);
    signal.throwIfAborted();
    response = { id: request.id, result };
  } catch (error) {
    if (signal.aborted) {
      response = { id: request.id, cancelled: true };
    } else {
      const value = error instanceof Error ? error : new Error(String(error));
      response = {
        id: request.id,
        error: {
          name: value.name,
          message: value.message,
          code: 'code' in value && typeof value.code === 'string' ? value.code : undefined,
          payload: isCodedError(error) ? toErrorPayload(error) : undefined,
        },
      };
    }
  } finally {
    dispose();
  }
  const transferList =
    'result' in response
      ? response.result instanceof ArrayBuffer
        ? [response.result]
        : response.result !== null &&
            typeof response.result === 'object' &&
            'data' in response.result &&
            response.result.data instanceof ArrayBuffer
          ? [response.result.data]
          : []
      : [];
  port!.postMessage(response, transferList);
}

port.on('message', (request: CpuRequest) => { void execute(request); });
port.postMessage({ type: 'ready' } satisfies CpuResponse);
if (process.env['VITEST'] === undefined) {
  void import('#/agent/media/image-compress').catch(() => undefined);
}
