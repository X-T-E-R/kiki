import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SqliteSearchIndex } from '../src/search/sqlite/index';

const root = await mkdtemp(join(process.cwd(), '.tmp-search-s2-soak-'));
const index = await SqliteSearchIndex.open(join(root, 'index.sqlite'));
const sessions = Array.from({ length: 3 }, (_, n) => ({ id: `s${n}`, workspaceId: 'w',
  dir: join(root, `s${n}`), updatedAt: 1_700_000_000_000 }));
const paths: string[] = [];
const started = performance.now();
try {
  for (const session of sessions) {
    const dir = join(session.dir, 'agents', 'main');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'wire.jsonl');
    await writeFile(path, '');
    paths.push(path);
  }
  for (let tick = 0; tick < 60; tick++) {
    for (const [n, session] of sessions.entries()) {
      await appendFile(paths[n]!, Array.from({ length: 100 }, (_, i) => JSON.stringify({
        type: 'context.append_message', time: 1_700_000_000_000 + tick * 100 + i,
        message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: `session ${n} tick ${tick} event ${i} ${'abc'.repeat(80)}` }] },
      }) + '\n').join(''));
      await index.syncSession(session);
    }
  }
  const seconds = (performance.now() - started) / 1000;
  const count = (index.db.prepare('SELECT count(*) AS n FROM docs').get() as { n: number }).n;
  const quickCheck = (index.db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
  console.log(JSON.stringify({ simulatedSeconds: 600, actualSeconds: seconds, acceleration: 600 / seconds,
    sessions: 3, documents: count, peakWalBytes: index.syncStatus.peakWalBytes,
    finalWalBytes: index.syncStatus.walBytes, totalWireBytes: (await Promise.all(paths.map(stat))).reduce((sum, s) => sum + s.size, 0), quickCheck }));
} finally {
  index.close();
  await rm(root, { recursive: true, force: true });
}
