import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';

import { SqliteSearchHost } from '../../src/search/sqlite/host';
import { SqliteSearchIndex } from '../../src/search/sqlite/index';

const hosts: SqliteSearchHost[] = [];
const homes: string[] = [];
const time = 1_700_000_000_000;
const query = { query: 'needle', mode: 'terms' as const, op: 'AND' as const,
  sort: 'time_desc' as const, pageSize: 10 };

async function fixture(): Promise<{ host: SqliteSearchHost; database: string; home: string }> {
  const home = await mkdtemp(join(process.cwd(), '.tmp-search-s3-'));
  homes.push(home);
  const database = join(home, 'index.sqlite');
  const host = new SqliteSearchHost({ database, backoffMs: [50, 50, 50], memoryBackoffMs: [50, 50, 50] });
  hosts.push(host);
  await host.open();
  return { host, database, home };
}

async function waitFor(check: () => boolean, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for indexer state');
    await delay(25);
  }
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

it('skips idle checkpoint while a write transaction is open', async () => {
  const home = await mkdtemp(join(process.cwd(), '.tmp-search-s3-checkpoint-'));
  homes.push(home);
  const index = await SqliteSearchIndex.open(join(home, 'index.sqlite'), { idleCheckpointMs: 10 });
  try {
    const dir = join(home, 's1');
    await mkdir(join(dir, 'agents', 'main'), { recursive: true });
    await writeFile(join(dir, 'agents', 'main', 'wire.jsonl'), JSON.stringify({
      type: 'context.append_message', time,
      message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'needle' }] },
    }) + '\n');
    await index.syncSession({ id: 's1', dir, workspaceId: 'example', updatedAt: time });
    index.db.exec('BEGIN');
    await delay(30);
    expect(index.db.isTransaction).toBe(true);
    index.db.exec('ROLLBACK');
    expect((index.db.prepare('SELECT count(*) n FROM docs').get() as { n: number }).n).toBe(1);
  } finally { index.close(); }
});

it('moves a corrupt derived database aside and opens a fresh incremental index', async () => {
  const home = await mkdtemp(join(process.cwd(), '.tmp-search-s3-corrupt-'));
  homes.push(home);
  const database = join(home, 'index.sqlite');
  await writeFile(database, 'not a sqlite database');
  const host = new SqliteSearchHost({ database });
  hosts.push(host);
  await host.open();
  await waitFor(() => host.snapshot().state === 'ready');
  expect((await readdir(home)).some((file) => file.startsWith('index.sqlite.corrupt-'))).toBe(true);
  expect((await host.search(query)).rows).toEqual([]);
  const dir = join(home, 's1');
  await mkdir(join(dir, 'agents', 'main'), { recursive: true });
  await writeFile(join(dir, 'agents', 'main', 'wire.jsonl'), JSON.stringify({
    type: 'context.append_message', time,
    message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'needle rebuilt' }] },
  }) + '\n');
  host.sync([{ id: 's1', dir, workspaceId: 'example', updatedAt: time }]);
  await waitFor(() => host.snapshot().pendingSessions === 0);
  expect((await host.search(query)).rows.map((row) => row.value.text)).toEqual(['needle rebuilt']);
});

it('queues bursts past eight worker slots with bounded backpressure', async () => {
  const { host } = await fixture();
  await waitFor(() => host.snapshot().state === 'ready');
  const settled = await Promise.allSettled(Array.from({ length: 16 }, () => host.search(query)));
  expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(16);
  expect(host.snapshot().queryWorkers).toBe(3);
  expect(host.snapshot().watchdogTimeouts).toBe(0);
});

it('paginates beyond the newest-first fast page without losing older matches', async () => {
  const { host, home } = await fixture();
  const dir = join(home, 'many');
  await mkdir(join(dir, 'agents', 'main'), { recursive: true });
  await writeFile(join(dir, 'agents', 'main', 'wire.jsonl'), Array.from({ length: 100 }, (_, n) => JSON.stringify({
    type: 'context.append_message', time,
    message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: `needle ${n}` }] },
  })).join('\n') + '\n');
  host.sync([{ id: 'many', dir, workspaceId: 'example', updatedAt: time }]);
  await waitFor(() => host.snapshot().pendingSessions === 0);
  const found = new Set<string>();
  let token: string | undefined;
  do {
    const result = await host.search(query, token);
    for (const row of result.rows) found.add(row.key);
    token = result.pageToken;
  } while (token);
  expect(found.size).toBe(100);
});

it('retries an in-flight session and quarantines its wire after two indexer crashes', async () => {
  const home = await mkdtemp(join(process.cwd(), '.tmp-search-s3-strikes-'));
  homes.push(home);
  const database = join(home, 'index.sqlite');
  const dir = join(home, 's1');
  await mkdir(join(dir, 'agents', 'main'), { recursive: true });
  const path = join(dir, 'agents', 'main', 'wire.jsonl');
  const record = JSON.stringify({ type: 'context.append_message', time,
    message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'needle' }] } }) + '\n';
  await writeFile(path, record.repeat(2000));
  const host = new SqliteSearchHost({ database, indexerSoftMb: 1,
    backoffMs: [50, 50, 50] });
  hosts.push(host);
  await host.open();
  host.sync([{ id: 's1', dir, workspaceId: 'example', updatedAt: time }]);
  for (let strike = 0; strike < 2; strike++) {
    await waitFor(() => !!host.snapshot().indexerPid && host.snapshot().inflight === path, 30_000);
    const pid = host.snapshot().indexerPid!;
    process.kill(pid);
    await waitFor(() => host.snapshot().indexerPid !== pid, 30_000);
  }
  await waitFor(() => host.snapshot().pendingSessions === 0 &&
    host.snapshot().state === 'ready', 30_000);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    expect((db.prepare('SELECT strikes FROM file_failures WHERE path=?').get(path) as
      { strikes: number }).strikes).toBe(2);
    expect((db.prepare('SELECT policy FROM files WHERE path=?').get(path) as
      { policy: string }).policy).toBe('quarantined');
  } finally { db.close(); }
});

it('reindexes the owned SQLite database through the indexer and replaces obsolete documents', async () => {
  const { host, home, database } = await fixture();
  const dir = join(home, 's1');
  await mkdir(join(dir, 'agents', 'main'), { recursive: true });
  const wire = join(dir, 'agents', 'main', 'wire.jsonl');
  const record = (text: string) => JSON.stringify({ type: 'context.append_message', time,
    message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text }] } }) + '\n';
  await writeFile(wire, record('needle old'));
  const session = { id: 's1', dir, workspaceId: 'example', updatedAt: time };
  host.sync([session]);
  await waitFor(() => host.snapshot().pendingSessions === 0 && host.snapshot().documents === 1);
  await writeFile(wire, record('replacement new'));
  const stats = await host.reindex([session]);
  expect(stats).toEqual({ sessions: 1, documents: 1 });
  expect((await host.search(query)).rows).toEqual([]);
  expect((await host.search({ ...query, query: 'replacement' })).rows.map((row) => row.value.text)).toEqual(['replacement new']);
  const db = new DatabaseSync(database, { readOnly: true });
  try { expect((db.prepare('SELECT count(*) AS n FROM docs').get() as { n: number }).n).toBe(1); }
  finally { db.close(); }
});

it('indexes in a child while a read-only worker serves search from the parent', async () => {
  const { host, home } = await fixture();
  const dir = join(home, 's1');
  await mkdir(join(dir, 'agents', 'main'), { recursive: true });
  await writeFile(join(dir, 'agents', 'main', 'wire.jsonl'), JSON.stringify({
    type: 'context.append_message', time,
    message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'needle here' }] },
  }) + '\n');
  host.sync([{ id: 's1', dir, workspaceId: 'example', updatedAt: time }]);
  await waitFor(() => host.snapshot().pendingSessions === 0 && host.snapshot().state === 'ready');
  const result = await host.search(query);
  expect(result.rows.map((hit) => hit.value.text)).toEqual(['needle here']);
  expect(result.stale).toBe(false);
  expect(host.snapshot().indexerPid).not.toBe(process.pid);
  expect(host.snapshot().indexerHeapLimit).toBeLessThan(512 * 1048576);
  expect(host.snapshot().watchdogTimeouts).toBe(0);
});

it('elects one writer across hosts sharing the same database and leaves the other read-only', async () => {
  const { host, database, home } = await fixture();
  await waitFor(() => host.snapshot().state === 'ready');
  const other = new SqliteSearchHost({ database });
  hosts.push(other);
  await other.open();
  await waitFor(() => other.snapshot().state === 'readonly');
  await expect(other.reindex([])).rejects.toMatchObject({ reason: 'readonly_index' });
  expect(other.snapshot().indexerPid).not.toBe(host.snapshot().indexerPid);
  const dir = join(home, 's1');
  await mkdir(join(dir, 'agents', 'main'), { recursive: true });
  await writeFile(join(dir, 'agents', 'main', 'wire.jsonl'), JSON.stringify({ type: 'context.append_message', time,
    message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'needle writer' }] },
  }) + '\n');
  const session = { id: 's1', dir, workspaceId: 'example', updatedAt: time };
  host.sync([session]);
  other.sync([session]);
  await waitFor(() => host.snapshot().pendingSessions === 0);
  expect((await other.search(query)).rows.map((row) => row.value.text)).toEqual(['needle writer']);
  expect(other.snapshot().pendingSessions).toBe(0);
  await host.close();
  hosts.splice(hosts.indexOf(host), 1);
  await waitFor(() => other.snapshot().state === 'ready', 10_000);
  await appendFile(join(dir, 'agents', 'main', 'wire.jsonl'), JSON.stringify({ type: 'context.append_message', time: time + 1,
    message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'needle promoted' }] },
  }) + '\n');
  other.sync([session]);
  await waitFor(() => other.snapshot().pendingSessions === 0 && other.snapshot().documents === 2);
  expect((await other.search(query)).rows.map((row) => row.value.text)).toEqual(['needle promoted', 'needle writer']);
});

it('keeps old rows searchable through memory-budget backoff without restarting the parent', async () => {
  const { host, home, database } = await fixture();
  const dir = join(home, 's1');
  await mkdir(join(dir, 'agents', 'main'), { recursive: true });
  await writeFile(join(dir, 'agents', 'main', 'wire.jsonl'), JSON.stringify({
    type: 'context.append_message', time,
    message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'needle here' }] },
  }) + '\n');
  host.sync([{ id: 's1', dir, workspaceId: 'example', updatedAt: time }]);
  await waitFor(() => host.snapshot().pendingSessions === 0);
  await host.close();
  hosts.pop();
  const states: string[] = [];
  const starving = new SqliteSearchHost({ database, indexerHardMb: 64, indexerSoftMb: 32,
    backoffMs: [50, 50, 50], memoryBackoffMs: [50, 50, 50],
    onStateChange: (snapshot) => states.push(snapshot.reason ?? snapshot.state) });
  hosts.push(starving);
  await starving.open();
  await waitFor(() => states.includes('indexer_backoff'));
  expect((await starving.search(query)).stale).toBe(true);
  await waitFor(() => starving.snapshot().reason === 'memory_budget', 60_000);
  expect(states.indexOf('indexer_backoff')).toBeLessThan(states.indexOf('memory_budget'));
  const result = await starving.search(query);
  expect(result.rows.map((hit) => hit.value.text)).toEqual(['needle here']);
  expect(result.stale).toBe(true);
  await waitFor(() => starving.snapshot().indexerTerminal &&
    starving.snapshot().indexerPid === undefined, 60_000);
  await starving.open();
  expect(starving.snapshot().indexerPid).toBeUndefined();
  starving.retryIndexer();
  expect(starving.snapshot().indexerPid).toBeGreaterThan(0);
  expect(process.pid).toBeGreaterThan(0);
});
