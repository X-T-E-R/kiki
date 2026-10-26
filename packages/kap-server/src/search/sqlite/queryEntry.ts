import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { GlobalSearchError } from '../contract';
import { SqliteSearchIndex } from './index';
import { SqliteSearchQueries } from './queries';
import type { QueryEvent, QueryRequest } from './processProtocol';

const port = parentPort;
if (!port) throw new Error('query entry requires a worker thread');
let reader: SqliteSearchIndex | undefined;
let queries: SqliteSearchQueries | undefined;
const source: { database: string; bootSalt?: string } = typeof workerData === 'string'
  ? { database: workerData } : workerData as { database: string; bootSalt: string };
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
    queries ??= new SqliteSearchQueries(reader, cacheMs);
    const value = await queries.search(message.query, message.pageToken, message.budgets, message.deadlineAt);
    send({ id: message.id, type: 'result', value });
  } catch (error) {
    send({ id: message.id, type: 'error', message: error instanceof Error ? error.message : String(error),
      reason: error instanceof GlobalSearchError ? error.reason : undefined });
  }
};
port.on('message', (message: QueryRequest) => { void handleMessage(message); });
