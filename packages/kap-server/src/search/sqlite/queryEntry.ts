import { parentPort, workerData } from 'node:worker_threads';
import { SqliteSearchIndex } from './index';
import type { QueryEvent, QueryRequest } from './processProtocol';

const port = parentPort;
if (!port) throw new Error('query entry requires a worker thread');
let reader: SqliteSearchIndex | undefined;
const send = (event: QueryEvent): void => port.postMessage(event);
send({ type: 'ready' });
port.on('message', async (message: QueryRequest) => {
  if (message.type === 'close') {
    reader?.close();
    port.close();
    return;
  }
  try {
    if (!reader) reader = SqliteSearchIndex.openReader(workerData as string);
    const value = await reader.search(message.query, message.pageToken, message.budgets);
    send({ id: message.id, type: 'result', value });
  } catch (error) {
    send({ id: message.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
