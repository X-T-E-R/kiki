import { copyFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SqliteSearchIndex, type SqliteSessionInput } from '../src/search/sqlite/index';

const [snapshot, source, target] = process.argv.slice(2);
if (!snapshot || !source || !target) throw new Error('usage: search-sqlite-s2-measure.mts <L1-dir> <built-db> <scratch-db>');
await copyFile(source, target);
const sessions: SqliteSessionInput[] = [];
for (const workspace of await readdir(snapshot, { withFileTypes: true })) {
  if (!workspace.isDirectory()) continue;
  const workspaceDir = join(snapshot, workspace.name);
  for (const entry of await readdir(workspaceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(workspaceDir, entry.name);
    const info = await stat(dir);
    sessions.push({ id: entry.name, workspaceId: workspace.name, dir, updatedAt: Math.floor(info.mtimeMs) });
  }
}
const start = performance.now();
const index = await SqliteSearchIndex.open(target);
const readyMs = performance.now() - start;
console.log(JSON.stringify({ readyMs, ...index.syncStatus }));
let changed = 0;
try {
  for (const session of sessions) {
    const before = index.syncStatus.wireBytesRead;
    await index.syncSession(session);
    if (index.syncStatus.wireBytesRead !== before) changed++;
  }
  const check = (index.db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
  console.log(JSON.stringify({ elapsedMs: performance.now() - start, sessions: sessions.length,
    changedSessions: changed, ...index.syncStatus, quickCheck: check }));
} finally { index.close(); }
const readonly = new DatabaseSync(source, { readOnly: true });
console.log(JSON.stringify({ sourceFiles: (readonly.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n }));
readonly.close();
