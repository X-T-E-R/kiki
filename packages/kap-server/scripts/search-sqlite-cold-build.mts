import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getHeapSpaceStatistics } from 'node:v8';

import { SqliteSearchIndex, type SqliteSessionInput } from '../src/search/sqlite/index';

const [snapshot, database] = process.argv.slice(2);
if (!snapshot || !database) throw new Error('usage: search-sqlite-cold-build.mts <sessions-snapshot> <new-db-path>');
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
sessions.sort((a, b) => b.updatedAt - a.updatedAt);
const index = await SqliteSearchIndex.open(database);
const began = performance.now();
let peakRss = 0;
let peakOld = 0;
let peakHeapUsed = 0;
let count = 0;
function sample(): void {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
  peakOld = Math.max(peakOld, getHeapSpaceStatistics().find((space) => space.space_name === 'old_space')?.space_used_size ?? 0);
}
const timer = setInterval(sample, 1000);
try {
  for (const session of sessions) {
    await index.syncSession(session);
    sample();
    count++;
    if (count % 25 === 0) console.log(JSON.stringify({ indexedSessions: count, elapsedSeconds: Math.round((performance.now() - began) / 1000), peakRssMiB: Math.round(peakRss / 1048576) }));
  }
  sample();
  const docCount = (index.db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n;
  const fileCount = (index.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
  const quickCheck = (index.db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
  console.log(JSON.stringify({ indexedSessions: count, fileCount, docCount, quickCheck,
    elapsedSeconds: (performance.now() - began) / 1000, peakRssMiB: peakRss / 1048576,
    peakOldSpaceMiB: peakOld / 1048576, peakHeapUsedMiB: peakHeapUsed / 1048576,
    databaseBytes: (await stat(database)).size }));
} finally {
  clearInterval(timer);
  index.close();
}
