import { parentPort } from 'node:worker_threads';
import { UsageReadAllowance, UsageWireFramer } from '@kiki/agent-core-v2/agent/usage/usageWireFramer';
import type { UsageWorkerRequest, UsageWorkerResponse } from './protocol';

if (parentPort === null) throw new Error('Usage parser requires a worker port');
const port = parentPort;
let framer: UsageWireFramer | undefined;
let allowance: UsageReadAllowance | undefined;
let deadlineAt = Infinity;
let parseMs = 0;
const cpuAt = process.threadCpuUsage();

port.on('message', (request: UsageWorkerRequest) => {
  try {
    if (request.v !== 1) throw new Error('Usage worker protocol mismatch');
    if (request.type === 'close') { port.close(); return; }
    let slice;
    if (request.type === 'begin') {
      framer = new UsageWireFramer(request.offset, request.agentId, request.state);
      allowance = new UsageReadAllowance(request.allowance);
      deadlineAt = request.deadlineAt;
    } else {
      if (framer === undefined || allowance === undefined || request.bytes.byteLength > 1 << 20) throw new Error('Usage worker has no bounded source');
      const at = performance.now();
      slice = framer.consume(new Uint8Array(request.bytes, request.start, request.end - request.start), allowance, deadlineAt);
      parseMs += performance.now() - at;
    }
    const memory = process.memoryUsage(), cpu = process.threadCpuUsage(cpuAt);
    const response: UsageWorkerResponse = { v: 1, id: request.id, type: 'result', slice, bytes: request.type === 'chunk' ? request.bytes : undefined, metrics: { heapUsed: memory.heapUsed, arrayBuffers: memory.arrayBuffers, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system, parseMs } };
    port.postMessage(response, response.bytes === undefined ? [] : [response.bytes]);
  } catch (error) {
    const response: UsageWorkerResponse = { v: 1, id: request.id, type: 'error', message: error instanceof Error ? error.message : String(error) };
    port.postMessage(response);
  }
});
port.postMessage({ v: 1, type: 'ready' } satisfies UsageWorkerResponse);
