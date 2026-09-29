import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SqliteSearchIndex } from '../src/search/sqlite/index';

const session = (root: string, n: number) => ({ id: `s${n}`, workspaceId: 'w',
  dir: join(root, `s${n}`), updatedAt: 1_700_000_000_000 });
const row = (n: number, i: number) => JSON.stringify({ type: 'context.append_message', time: 1_700_000_000_000 + i,
  message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: `crash-${n}-${i} ${'abc'.repeat(120)}` }] } }) + '\n';

if (process.argv[2] === '--child') {
  const [root, number] = process.argv.slice(3);
  const index = await SqliteSearchIndex.open(join(root!, 'index.sqlite'));
  try { await index.syncSession(session(root!, Number(number))); }
  finally { index.close(); }
} else {
  const root = await mkdtemp(join(process.cwd(), '.tmp-search-s2-fault-'));
  const dbPath = join(root, 'index.sqlite');
  let active: ReturnType<typeof spawn> | undefined;
  let maxWal = 0;
  let committed = 0;
  let probe: DatabaseSync | undefined;
  try {
    const initial = await SqliteSearchIndex.open(dbPath);
    initial.close();
    probe = new DatabaseSync(dbPath, { readOnly: true });
    const inflightQuery = probe.prepare("SELECT v FROM meta WHERE k='inflight'");
    const offsetQuery = probe.prepare('SELECT offset FROM files WHERE path=?');
    for (let n = 0; n < 20; n++) {
      const dir = join(root, `s${n}`, 'agents', 'main');
      await mkdir(dir, { recursive: true });
      const path = join(dir, 'wire.jsonl');
      await writeFile(path, Array.from({ length: 2500 }, (_, i) => row(n, i)).join(''));
      active = spawn(process.execPath, ['--import', 'tsx', process.argv[1]!, '--child', root, String(n)],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      active.stderr?.on('data', (part: Buffer) => { stderr += part.toString(); });
      const exit = new Promise<number | null>((resolve) => active!.once('exit', (code) => resolve(code)));
      const until = Date.now() + 30_000;
      let observed = false;
      while (Date.now() < until) {
        const inflight = inflightQuery.get() as { v: string } | undefined;
        const current = offsetQuery.get(path) as { offset: number } | undefined;
        if (inflight?.v === path && current && current.offset > 0 && current.offset < (await stat(path)).size) {
          observed = true;
          break;
        }
        if (active.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!observed) {
        const code = await exit;
        throw new Error(`child did not reach in-flight write: iteration=${n}, code=${code}, stderr=${stderr}`);
      }
      active.kill();
      await exit;
      const index = await SqliteSearchIndex.open(dbPath);
      try {
        const before = (index.db.prepare('SELECT offset FROM files WHERE path=?').get(path) as { offset: number } | undefined)?.offset ?? 0;
        const checkedBefore = (index.db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
        if (checkedBefore !== 'ok') throw new Error(`quick_check failed after crash ${n}: ${checkedBefore}`);
        await index.syncSession(session(root, n));
        const offset = (index.db.prepare('SELECT offset FROM files WHERE path=?').get(path) as { offset: number }).offset;
        if (offset < before || offset !== (await stat(path)).size) throw new Error(`watermark regressed at iteration ${n}`);
        committed += offset;
        const duplicate = index.db.prepare('SELECT file_id,line_offset,ord FROM docs WHERE file_id IS NOT NULL GROUP BY file_id,line_offset,ord HAVING count(*)>1 LIMIT 1').get();
        if (duplicate) throw new Error(`duplicate document at iteration ${n}`);
        const quickCheck = (index.db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
        if (quickCheck !== 'ok') throw new Error(`quick_check failed after recovery ${n}: ${quickCheck}`);
        maxWal = Math.max(maxWal, index.syncStatus.walBytes, index.syncStatus.peakWalBytes);
        console.log(JSON.stringify({ kill: n + 1, quickCheck, before, offset,
          totalCommittedBytes: committed, walBytes: maxWal }));
      } finally { index.close(); }
      active = undefined;
    }
    const documents = (probe.prepare('SELECT count(*) AS n FROM docs').get() as { n: number }).n;
    if (documents !== 50_000) throw new Error(`unexpected document count after recovery: ${documents}`);
    console.log(JSON.stringify({ kills: 20, checks: 20, documents, maxWalBytes: maxWal }));
  } finally {
    if (active && active.exitCode === null) active.kill();
    probe?.close();
    await rm(root, { recursive: true, force: true });
  }
}
