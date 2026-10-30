import { parentPort } from 'node:worker_threads';
import { toErrorPayload, isCodedError } from '#/_base/errors/serialize';
import type { CpuRequest, CpuResponse } from './protocol';
import { executeCpuOperation, type CpuOperation } from './tasks';

const port = parentPort;
if (port === null) throw new Error('CPU worker requires a parent port');

async function execute(request: CpuRequest): Promise<void> {
  let response: CpuResponse;
  try { response = { id: request.id, result: await executeCpuOperation(request.operation as CpuOperation) }; }
  catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    response = { id: request.id, error: { name: value.name, message: value.message,
      code: 'code' in value && typeof value.code === 'string' ? value.code : undefined,
      payload: isCodedError(error) ? toErrorPayload(error) : undefined } };
  }
  port!.postMessage(response, 'result' in response && response.result instanceof ArrayBuffer ? [response.result] : []);
}

port.on('message', (request: CpuRequest) => { void execute(request); });
