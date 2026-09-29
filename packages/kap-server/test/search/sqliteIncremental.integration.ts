import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeLiteral } from '@kiki/minidb';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { SqliteSearchIndex } from '../../src/search/sqlite/index';

let home: string;
let index: SqliteSearchIndex;
const time = 1_700_000_000_000;
const session = (id: string) => ({ id, workspaceId: 'w', dir: join(home, id), updatedAt: time });
const line = (text: string) => JSON.stringify({ type: 'context.append_message', time,
  message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text }] } }) + '\n';
const wire = async (id: string, text: string) => {
  const path = join(home, id, 'agents', 'main', 'wire.jsonl');
  await mkdir(join(home, id, 'agents', 'main'), { recursive: true });
  await writeFile(path, line(text));
  return path;
};
const count = () => (index.db.prepare('SELECT count(*) AS n FROM docs WHERE role=?').get('user') as { n: number }).n;
const offset = (path: string) => (index.db.prepare('SELECT offset FROM files WHERE path=?').get(path) as { offset: number }).offset;

beforeEach(async () => {
  home = await mkdtemp(join(process.cwd(), '.tmp-search-s2-'));
  index = await SqliteSearchIndex.open(join(home, 'index.sqlite'));
});
afterEach(async () => {
  index.close();
  await rm(home, { recursive: true, force: true });
});

it('reads zero unchanged wire bytes, reads only the appended 1 MiB, and isolates a replace', async () => {
  const first = await wire('s1', 'original');
  const other = await wire('s2', 'independent');
  await index.syncSession(session('s1'));
  await index.syncSession(session('s2'));
  index.resetReadCounters();
  await index.syncSession(session('s1'));
  await index.syncSession(session('s2'));
  expect(index.syncStatus).toMatchObject({ wireBytesRead: 0, wireFilesRead: 0 });
  const oneMiB = line('more ' + 'x'.repeat(1048576 - Buffer.byteLength(line('more '))));
  expect(Buffer.byteLength(oneMiB)).toBe(1048576);
  await appendFile(first, oneMiB);
  index.resetReadCounters();
  await index.syncSession(session('s1'));
  expect(index.syncStatus.wireBytesRead).toBeLessThanOrEqual(1.1 * 1048576);
  expect(index.syncStatus.wireFilesRead).toBe(1);
  expect(offset(first)).toBe((await stat(first)).size);
  expect(offset(other)).toBe((await stat(other)).size);
  await writeFile(first, line('replacement'));
  index.resetReadCounters();
  await index.syncSession(session('s1'));
  expect(index.syncStatus.wireFilesRead).toBe(1);
  expect(count()).toBe(2);
  expect((index.db.prepare('SELECT text FROM docs WHERE role=? ORDER BY text').all('user') as { text: string }[])
    .map((row) => row.text)).toEqual(['independent', 'replacement']);
});

it('does not mark a completed NFKC two-character literal scan as incomplete', async () => {
  await wire('s1', 'ＡＢ normalized');
  await index.syncSession(session('s1'));
  const query = { query: 'ab', literalQuery: normalizeLiteral('ab'), mode: 'literal' as const,
    sort: 'time_desc' as const, op: 'AND' as const, pageSize: 10 };
  const result = await index.search(query);
  expect(result.rows.map((row) => row.value.text)).toEqual(['ＡＢ normalized']);
  expect(result.incomplete).toBeUndefined();
  await appendFile(join(home, 's1', 'agents', 'main', 'wire.jsonl'), line('another document'));
  await index.syncSession(session('s1'));
  const capped = await index.search(query, undefined, { literalCandidateCap: 1, maxTextHits: 100,
    postingsVisitBudget: 100, queryDeadlineMs: 500, queryTextBudgetChars: 100_000 });
  expect(capped.incomplete).toBe('candidate_cap');
});

it('quarantines a file after two consecutive recorded indexer exits and keeps other files searchable', async () => {
  const bad = await wire('s1', 'first');
  await wire('s2', 'unaffected');
  await index.syncSession(session('s1'));
  await index.syncSession(session('s2'));
  for (let strike = 1; strike <= 2; strike++) {
    index.db.prepare("INSERT INTO meta(k,v) VALUES('inflight',?)").run(bad);
    index.close();
    index = await SqliteSearchIndex.open(join(home, 'index.sqlite'));
    expect((index.db.prepare('SELECT strikes FROM file_failures WHERE path=?').get(bad) as { strikes: number }).strikes).toBe(strike);
  }
  expect((index.db.prepare('SELECT policy FROM files WHERE path=?').get(bad) as { policy: string }).policy)
    .toBe('quarantined');
  await appendFile(bad, line('ignored'));
  await index.syncSession(session('s1'));
  expect(count()).toBe(2);
  expect(offset(bad)).toBeLessThan((await stat(bad)).size);
  expect((index.db.prepare("SELECT count(*) AS n FROM docs WHERE text='unaffected'").get() as { n: number }).n).toBe(1);
});

it('quarantines an in-flight file even if it crashed before its files row was created', async () => {
  const bad = await wire('s1', 'never indexed');
  for (let strike = 1; strike <= 2; strike++) {
    index.db.prepare("INSERT INTO meta(k,v) VALUES('inflight',?)").run(bad);
    index.close();
    index = await SqliteSearchIndex.open(join(home, 'index.sqlite'));
  }
  await index.syncSession(session('s1'));
  expect((index.db.prepare('SELECT policy,offset FROM files WHERE path=?').get(bad) as
    { policy: string; offset: number })).toEqual({ policy: 'quarantined', offset: 0 });
  expect(count()).toBe(0);
});

it('halts on a blocked WAL checkpoint and automatically resumes after the reader releases', async () => {
  index.close();
  const path = join(home, 'index.sqlite');
  index = await SqliteSearchIndex.open(path, { walPauseBytes: 64 * 1024, walRetryMs: 20 });
  const file = await wire('s1', 'first');
  await index.syncSession(session('s1'));
  const reader = new DatabaseSync(path, { readOnly: true });
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) AS n FROM docs').get();
  try {
    await appendFile(file, Array.from({ length: 300 }, (_, i) => line(`entry-${i} ${'xyz'.repeat(50)}`)).join(''));
    await index.syncSession(session('s1'));
    expect(index.syncStatus.state).toBe('wal_stuck');
    await appendFile(file, line('held while blocked'));
    await index.syncSession(session('s1'));
    expect(offset(file)).toBeLessThan((await stat(file)).size);
    const blockedWalBytes = index.syncStatus.walBytes;
    reader.exec('COMMIT');
    const releasedAt = performance.now();
    const until = Date.now() + 5000;
    while (index.syncStatus.state !== 'ready' || offset(file) !== (await stat(file)).size) {
      if (Date.now() > until) throw new Error('blocked checkpoint did not automatically resume');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(count()).toBe(302);
    expect(index.syncStatus.peakWalBytes).toBeLessThan(1048576);
    console.log(JSON.stringify({ blockedWalBytes, peakWalBytes: index.syncStatus.peakWalBytes,
      recoveryMs: performance.now() - releasedAt, documents: count() }));
  } finally { if (reader.isTransaction) reader.exec('ROLLBACK'); reader.close(); }
});
