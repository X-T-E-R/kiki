import { deserialize, serialize } from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';

parentPort.on('message', ({ id, bytes }) => {
  const request = deserialize(bytes);
  const response = {
    pluginId: request.pluginId,
    generation: request.generation,
    attemptId: request.attemptId,
    conversationRevision: request.conversationRevision,
    durationMs: 0,
    ok: true,
    value: 'ghost response',
  };
  if (workerData.settings.mismatch === 'attemptId') response.attemptId = 'attempt-ghost';
  if (workerData.settings.mismatch === 'conversationRevision') response.conversationRevision += 1;
  parentPort.postMessage({ id, bytes: serialize(response) });
});
