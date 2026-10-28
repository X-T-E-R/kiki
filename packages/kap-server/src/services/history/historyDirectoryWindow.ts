import type { ColumnPageQuery, IQueryStore, WriteOp } from '@kiki/agent-core-v2/persistence/interface/queryStore';
import type { HistoryNavigationProof } from './historyNavigationProof';
import { historyNavigationProof, matchesNavigationProof } from './historyNavigationProof';
import { openLogicalWire } from './logicalWireRead';

export interface HistoryDirectoryWindow {
  readonly start: number;
  readonly end: number;
  readonly proof: HistoryNavigationProof;
  readonly mode?: 'prefix';
}

export interface HistoryDirectoryTail {
  readonly window: HistoryDirectoryWindow;
  readonly turns: readonly number[];
  readonly bytesRead: number;
  readonly recordsRead: number;
}

const DISCOVERY_BYTES = 4 << 20;
const MAX_RECORDS = 50_000;
const MAX_ROWS = 4096;

export async function discoverHistoryDirectoryTail(path: string, limit: number, signal?: AbortSignal): Promise<HistoryDirectoryTail | undefined> {
  const opened = await openLogicalWire(path, signal);
  if (opened === undefined) return undefined;
  try {
    if (opened.size <= DISCOVERY_BYTES * 2) return undefined;
    const end = opened.size;
    const proof = await historyNavigationProof(path, end, signal);
    const start = Math.max(0, end - DISCOVERY_BYTES);
    const bytes = Buffer.from(await opened.readAt(start, end - start));
    if (bytes.length !== end - start || bytes.at(-1) !== 10) return undefined;
    let position = bytes.length - 1;
    let first: number | undefined;
    const turns: number[] = [];
    let records = 0;
    for (; position > 0 && records < MAX_RECORDS;) {
      signal?.throwIfAborted();
      const previous = bytes.lastIndexOf(10, position - 1);
      if (previous < 0 && start !== 0) break;
      const line = bytes.subarray(previous + 1, position);
      position = previous;
      if (line.length === 0) continue;
      const record = JSON.parse(line.toString('utf8')) as Record<string, unknown>;
      records++;
      if (record['type'] === 'context.undo' || record['type'] === 'context.clear' || record['type'] === 'turn_begin') return undefined;
      if (record['type'] !== 'turn.prompt') continue;
      const id = record['turnId'];
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || turns.length > 0 && id >= turns.at(-1)!) return undefined;
      turns.push(id);
      first = start + previous + 1;
      if (turns.length > limit) break;
    }
    if (first === undefined) return undefined;
    const current = await historyNavigationProof(path, end, signal);
    if (!matchesNavigationProof(proof, current)) throw new Error('history_source_changed');
    return { window: { start: first, end, proof }, turns, bytesRead: bytes.length, recordsRead: records };
  } finally { opened.close(); }
}

export async function validateHistoryDirectoryWindow(path: string, window: HistoryDirectoryWindow, signal?: AbortSignal): Promise<boolean> {
  const current = await historyNavigationProof(path, window.end, signal);
  if (!matchesNavigationProof(window.proof, current)) return false;
  if (current.size === window.end) return true;
  if (current.size - window.end > DISCOVERY_BYTES * 2) return false;
  const opened = await openLogicalWire(path, signal);
  if (opened === undefined) return false;
  try {
    const bytes = Buffer.from(await opened.readAt(window.end, current.size - window.end));
    const end = bytes.lastIndexOf(10);
    if (end < 0) return true;
    for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
      signal?.throwIfAborted();
      if (!line) continue;
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record['type'] === 'context.undo' || record['type'] === 'context.clear') return false;
    }
    return true;
  } finally { opened.close(); }
}

export function historyDirectoryWindowGuard(): (record: Record<string, unknown>) => void {
  const turns = new Set<string>();
  const steps = new Set<string>();
  const tools = new Set<string>();
  const steered = new Set<string>();
  const credits = new Map<string, number>();
  let currentTurn: string | undefined;
  let currentPrompt: string | undefined;
  let lastTurn = -1;
  const unsupported = (): never => { throw new Error('history_directory_window_unsupported'); };
  return (record) => {
    const type = record['type'];
    if (type === 'context.undo' || type === 'context.clear' || type === 'turn_begin' ||
        type === 'external.activity' || type === 'external.text') unsupported();
    if (type === 'turn.prompt') {
      const id = record['turnId'];
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id <= lastTurn) unsupported();
      lastTurn = id as number;
      currentTurn = String(id);
      turns.add(currentTurn);
      currentPrompt = typeof record['promptId'] === 'string' ? record['promptId'] :
        typeof record['messageId'] === 'string' ? record['messageId'] : undefined;
      return;
    }
    if (type === 'turn.steer' && record['managed'] !== true) {
      if (typeof record['promptId'] === 'string') steered.add(record['promptId']);
      else {
        const kind = (record['origin'] as { kind?: string } | undefined)?.kind ?? 'user';
        credits.set(kind, (credits.get(kind) ?? 0) + 1);
      }
    }
    if (type === 'context.append_message') {
      const message = record['message'] as Record<string, unknown> | undefined;
      if (message?.['role'] === 'tool' && !tools.has(String(message['toolCallId']))) unsupported();
      if (message?.['role'] === 'user') {
        const delivery = record['delivery'] as { turnId?: unknown } | undefined;
        const id = message['id'];
        const kind = (message['origin'] as { kind?: string } | undefined)?.kind ?? 'user';
        if (delivery?.turnId !== undefined && !turns.has(String(delivery.turnId))) unsupported();
        if (delivery === undefined && id !== currentPrompt && !steered.has(String(id)) &&
            !['injection', 'agent_message', 'task'].includes(kind)) {
          const count = credits.get(kind) ?? 0;
          if (count === 0) unsupported();
          credits.set(kind, count - 1);
        }
      }
    }
    if (type !== 'context.append_loop_event') return;
    const event = record['event'] as Record<string, unknown> | undefined;
    if (event === undefined) return;
    if (event['turnId'] !== undefined && !turns.has(String(event['turnId']))) unsupported();
    if (event['type'] === 'step.begin') {
      if (typeof event['uuid'] !== 'string') unsupported();
      steps.add(event['uuid'] as string);
    } else if (event['type'] === 'step.end') {
      if (!steps.has(String(event['uuid']))) unsupported();
    } else if (event['type'] === 'content.part' || event['type'] === 'tool.call') {
      if (!steps.has(String(event['stepUuid']))) unsupported();
      if (event['type'] === 'tool.call') {
        if (typeof event['toolCallId'] !== 'string') unsupported();
        tools.add(event['toolCallId'] as string);
      }
    } else if (event['type'] === 'tool.result' && !tools.has(String(event['toolCallId']))) unsupported();
  };
}

export function historyDirectoryWindowStore(): Pick<IQueryStore, 'get' | 'put' | 'batch' | 'pageByColumn'> {
  const rows = new Map<string, unknown>();
  const put = (collection: string, key: string, value: unknown): void => {
    const id = `${collection}:${key}`;
    if (!rows.has(id) && rows.size >= MAX_ROWS) throw new Error('history_directory_window_limit');
    rows.set(id, value);
  };
  return {
    get: async <T>(collection: string, key: string) => rows.get(`${collection}:${key}`) as T | undefined,
    put: async (collection: string, key: string, value: unknown) => { put(collection, key, value); },
    batch: async (ops: readonly WriteOp[]) => {
      for (const op of ops) {
        if (op.kind === 'put') put(op.collection, op.key, op.value);
        else rows.delete(`${op.collection}:${op.key}`);
      }
    },
    pageByColumn: async <T>(collection: string, query: ColumnPageQuery) => {
      const items = [...rows].filter(([key]) => key.startsWith(`${collection}:`))
        .map(([, value]) => value as Record<string, unknown>)
        .filter((row) => Object.entries(query.filter ?? {}).every(([key, value]) => row[key] === value))
        .filter((row) => {
          const value = row[query.column] as number;
          return typeof value === 'number' &&
            (query.bounds?.gt === undefined || value > query.bounds.gt) &&
            (query.bounds?.gte === undefined || value >= query.bounds.gte) &&
            (query.bounds?.lt === undefined || value < query.bounds.lt) &&
            (query.bounds?.lte === undefined || value <= query.bounds.lte);
        }).toSorted((left, right) => (query.dir === 'desc' ? -1 : 1) *
          ((left[query.column] as number) - (right[query.column] as number)));
      return { items: items.slice(0, query.limit) as T[] };
    },
  };
}
