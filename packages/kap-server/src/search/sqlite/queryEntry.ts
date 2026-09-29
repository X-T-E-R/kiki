import { parentPort, workerData } from 'node:worker_threads';
import { SqliteSearchIndex, type SqliteSearchResult } from './index';
import type { QueryEvent, QueryRequest } from './processProtocol';

const port = parentPort;
if (!port) throw new Error('query entry requires a worker thread');
let reader: SqliteSearchIndex | undefined;
const recent = new Map<string, { expires: number; version: number; result: Promise<SqliteSearchResult> }>();
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
    const key = JSON.stringify([message.query, message.pageToken, message.budgets]);
    const version = (reader.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
    let entry = recent.get(key);
    if (!entry || entry.expires < Date.now() || entry.version !== version) {
      if (recent.size >= 16) recent.delete(recent.keys().next().value!);
      const result = reader.search(message.query, message.pageToken, message.budgets);
      entry = { expires: Date.now() + 500, version, result };
      recent.set(key, entry);
      void result.catch(() => { if (recent.get(key) === entry) recent.delete(key); });
    }
    const value = await entry.result;
    send({ id: message.id, type: 'result', value });
  } catch (error) {
    send({ id: message.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
