import { appendFile, copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { SqliteSearchIndex } from '../src/search/sqlite/index';

const [source] = process.argv.slice(2);
if (!source) throw new Error('usage: search-sqlite-s2-append.mts <L1-large-wire>');
const root = await mkdtemp(join(process.cwd(), '.tmp-search-s2-append-'));
const dir = join(root, 'session', 'agents', 'main');
await mkdir(dir, { recursive: true });
const path = join(dir, 'wire.jsonl');
const otherDir = join(root, 'other', 'agents', 'main');
await mkdir(otherDir, { recursive: true });
const other = join(otherDir, 'wire.jsonl');
await copyFile(source, path);
await copyFile(source, other);
const index = await SqliteSearchIndex.open(join(root, 'index.sqlite'));
const session = { id: 'session', workspaceId: 'w', dir: join(root, 'session'), updatedAt: 1_700_000_000_000 };
const second = { id: 'other', workspaceId: 'w', dir: join(root, 'other'), updatedAt: 1_700_000_000_000 };
try {
  await index.syncSession(session);
  await index.syncSession(second);
  index.resetReadCounters();
  const record = (padding: number) => JSON.stringify({ type: 'context.append_message', time: 1_700_000_000_000,
    message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: `append ${'x'.repeat(padding)}` }] } }) + '\n';
  const append = record(1048576 - Buffer.byteLength(record(0)));
  await appendFile(path, append);
  const start = performance.now();
  await index.syncSession(session);
  console.log(JSON.stringify({ largeWireBytes: (await stat(source)).size, appendBytes: Buffer.byteLength(append),
    elapsedMs: performance.now() - start, ...index.syncStatus,
    otherOffset: (index.db.prepare('SELECT offset FROM files WHERE path=?').get(other) as { offset: number }).offset }));
} finally {
  index.close();
  await rm(root, { recursive: true, force: true });
}
