import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteSearchIndex, type SqliteSearchResult } from './index';
import type { QueryEvent, QueryRequest } from './processProtocol';

const port = parentPort;
if (!port) throw new Error('query entry requires a worker thread');
let reader: SqliteSearchIndex | undefined;
const source: { database: string; bootSalt?: string } = typeof workerData === 'string'
  ? { database: workerData } : workerData as { database: string; bootSalt: string };
const recent = new Map<string, { expires: number; version: number; result: Promise<SqliteSearchResult> }>();
const cacheMs = process.env['KIKI_SEARCH_QUERY_CACHE_MS'] === '0' ? 0 : 500;
const send = (event: QueryEvent): void => port.postMessage(event);
send({ type: 'ready' });
const handleMessage = async (message: QueryRequest): Promise<void> => {
  if (message.type === 'close') {
    reader?.close();
    port.close();
    return;
  }
  try {
    if (!reader) for (let attempt = 0; attempt < 4 && !reader; attempt++) {
      try { reader = SqliteSearchIndex.openReader(source.database, source.bootSalt); }
      catch (error) {
        if (attempt === 3 || !/SQLITE_BUSY|database is locked/i.test(String(error))) throw error;
        await delay(50 * (attempt + 1));
      }
    }
    if (!reader) throw new Error('search database reader did not open');
    const key = cacheMs ? JSON.stringify([message.query, message.pageToken, message.budgets]) : '';
    const version = cacheMs
      ? (reader.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version : 0;
    let entry = cacheMs ? recent.get(key) : undefined;
    if (!entry || entry.expires < Date.now() || entry.version !== version) {
      if (cacheMs && recent.size >= 16) recent.delete(recent.keys().next().value!);
      const result = reader.search(message.query, message.pageToken, message.budgets);
      entry = { expires: Date.now() + cacheMs, version, result };
      if (cacheMs) {
        recent.set(key, entry);
        void result.catch(() => { if (recent.get(key) === entry) recent.delete(key); });
      }
    }
    const value = await entry.result;
    send({ id: message.id, type: 'result', value });
  } catch (error) {
    send({ id: message.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
port.on('message', (message: QueryRequest) => { void handleMessage(message); });
