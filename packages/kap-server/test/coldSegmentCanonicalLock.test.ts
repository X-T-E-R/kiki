import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ISessionIndex, ISessionManager, type IHistoryArchive, type Scope } from '@kiki/agent-core-v2';
import { AppendLogStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { sealRetainedJournal } from '@kiki/agent-core-v2/persistence/retainedJournal';
import { agentScopeOf, sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import { describe, expect, it } from 'vitest';

import { HistoryNavigationDb } from '../src/services/history/historyNavigationDb';
import { HistoryLocatorStore } from '../src/services/history/historyLocatorStore';
import { historyArchiveSeed } from '../src/services/historyArchive';
import { TranscriptService } from '../src/services/transcript/transcriptService';

const SESSION_ID = 'session_2fd93c4b-8945-479b-b61a-cf106bcf2e9b';
const WORKSPACE_ID = 'wd_ws';

function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

describe('sealed canonical reads release their pin before proof', () => {
  it('returns the sealed turn from header and replay while discard waits on that pin', async () => {
    const opened = await openSealed();
    const gate = holdSegmentReads();
    let discardSettled = false;
    try {
      const header = opened.nav.readCanonicalTurnHeader(SESSION_ID, 'main', 't1');
      const replay = opened.service.readCanonicalEntity(SESSION_ID, 'main', { kind: 'turn', id: 't1' });
      await gate.entered;
      const discard = opened.log.discardCold(opened.wideScope, 'wire.jsonl').then(() => {
        discardSettled = true;
      });
      expect(await manifestGone(opened.manifestPath)).toBe(true);
      expect(discardSettled).toBe(false);
      gate.release();
      const settled = await Promise.race([
        Promise.all([header, replay, discard]).then(() => 'ok' as const),
        sleep(2_000).then(() => 'blocked' as const),
      ]);
      expect(settled).toBe('ok');
      expect(JSON.stringify(await header)).toContain('NEEDLE_COLD');
      expect(JSON.stringify(await replay)).toContain('NEEDLE_COLD');
      expect(opened.nav.canonicalReadReport().replays).toBeGreaterThan(0);
      expect(await readFile(opened.wirePath)).toEqual(opened.journal);
    } finally {
      gate.restore();
      await opened.close();
    }
  }, 30_000);

  it('rejects header and replay with history_source_changed when rewrite changes the journal before proof', async () => {
    const opened = await openSealed();
    const gate = holdSegmentReads();
    let rewriteSettled = false;
    const rewritten = Buffer.from([
      line({ type: 'turn.prompt', turnId: 1, promptId: 'prompt-1', input: [{ type: 'text', text: 'REWRITTEN' }], origin: { kind: 'user' }, time: 1000 }),
      line({ type: 'turn.ended', turnId: 1, reason: 'completed', time: 4000 }),
    ].join(''));
    try {
      const header = opened.nav.readCanonicalTurnHeader(SESSION_ID, 'main', 't1');
      const replay = opened.service.readCanonicalEntity(SESSION_ID, 'main', { kind: 'turn', id: 't1' });
      await gate.entered;
      const rewrite = opened.log.rewrite(opened.wideScope, 'wire.jsonl', [
        { type: 'turn.prompt', turnId: 1, promptId: 'prompt-1', input: [{ type: 'text', text: 'REWRITTEN' }], origin: { kind: 'user' }, time: 1000 },
        { type: 'turn.ended', turnId: 1, reason: 'completed', time: 4000 },
      ]).then(() => {
        rewriteSettled = true;
      });
      expect(await manifestGone(opened.manifestPath)).toBe(true);
      expect(rewriteSettled).toBe(false);
      gate.release();
      const settled = await Promise.race([
        Promise.all([
          header.then(() => 'header-ok', (error: unknown) => `header-error:${error instanceof Error ? error.message : String(error)}`),
          replay.then(() => 'replay-ok', (error: unknown) => `replay-error:${error instanceof Error ? error.message : String(error)}`),
          rewrite.then(() => 'rewrite-ok', (error: unknown) => `rewrite-error:${error instanceof Error ? error.message : String(error)}`),
        ]),
        sleep(2_000).then(() => undefined),
      ]);
      expect(settled).toEqual([
        'header-error:history_source_changed',
        'replay-error:history_source_changed',
        'rewrite-ok',
      ]);
      expect(await readFile(opened.wirePath)).toEqual(rewritten);
      expect((await readFile(opened.wirePath)).includes(Buffer.from('NEEDLE_COLD'))).toBe(false);
    } finally {
      gate.restore();
      await opened.close();
    }
  }, 30_000);

  it('drops the header pin on cancel so a waiting discard finishes', async () => {
    const opened = await openSealed();
    const gate = holdSegmentReads();
    const controller = new AbortController();
    let discardSettled = false;
    try {
      const header = opened.nav.readCanonicalTurnHeader(SESSION_ID, 'main', 't1', controller.signal);
      await gate.entered;
      controller.abort();
      const discard = opened.log.discardCold(opened.wideScope, 'wire.jsonl').then(() => {
        discardSettled = true;
      });
      expect(await manifestGone(opened.manifestPath)).toBe(true);
      expect(discardSettled).toBe(false);
      gate.release();
      const settled = await Promise.race([
        Promise.all([
          header.then(() => 'header-ok', (error: unknown) => error instanceof Error ? error.name : 'header-error'),
          discard.then(() => 'discard-ok'),
        ]),
        sleep(2_000).then(() => undefined),
      ]);
      expect(settled).toEqual(['AbortError', 'discard-ok']);
      expect(await readFile(opened.wirePath)).toEqual(opened.journal);
    } finally {
      gate.restore();
      await opened.close();
    }
  }, 30_000);
});

function holdSegmentReads(): { entered: Promise<void>; release: () => void; restore: () => void } {
  const original = FileStorageService.prototype.read;
  let arm = true;
  let seen = false;
  let notify: () => void = () => {};
  const entered = new Promise<void>((resolve) => { notify = resolve; });
  let releaseHold: () => void = () => {};
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  FileStorageService.prototype.read = async function (this: FileStorageService, scope, key, options) {
    if (arm && key.includes('.deflate')) {
      if (!seen) {
        seen = true;
        notify();
      }
      await hold;
    }
    return original.call(this, scope, key, options);
  };
  return {
    entered,
    release: () => {
      arm = false;
      releaseHold();
    },
    restore: () => {
      arm = false;
      releaseHold();
      FileStorageService.prototype.read = original;
    },
  };
}

async function manifestGone(path: string): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    await sleep(15);
  }
  return false;
}

async function openSealed(): Promise<{
  journal: Buffer;
  wirePath: string;
  manifestPath: string;
  wideScope: string;
  log: AppendLogStore;
  nav: HistoryLocatorStore;
  service: TranscriptService;
  close: () => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), 'cold-canonical-lock-'));
  const sessionDir = join(home, 'sessions', WORKSPACE_ID, SESSION_ID);
  const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const journal = Buffer.from([
    line({ type: 'turn.prompt', turnId: 1, promptId: 'prompt-1', input: [{ type: 'text', text: 'NEEDLE_COLD' }], origin: { kind: 'user' }, time: 1000 }),
    line({ type: 'turn.ended', turnId: 1, reason: 'completed', time: 3000 }),
  ].join(''));
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
  await writeFile(wirePath, journal);
  await sealRetainedJournal(wirePath);
  const core = {
    accessor: {
      get: (token: unknown) => token === ISessionIndex
        ? { get: async (id: string) => id === SESSION_ID ? { workspaceId: WORKSPACE_ID } : undefined }
        : token === ISessionManager
          ? { get: () => undefined, list: () => [] }
          : undefined,
    },
  } as unknown as Scope;
  const service = new TranscriptService({ homeDir: home, core });
  const db = HistoryNavigationDb.lazy(join(home, 'navigation.sqlite'));
  const nav = new HistoryLocatorStore(db, service);
  service.setHistoryLocatorReader(() => nav);
  const archive = historyArchiveSeed(() => core, () => service, () => nav)[0]![1] as IHistoryArchive;
  const page = await archive.search({
    query: 'NEEDLE_COLD',
    mode: 'auto',
    sort: 'newest',
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    agentId: 'main',
    pageSize: 5,
  });
  expect(page.items.length).toBeGreaterThan(0);
  const wideScope = agentScopeOf(sessionScopeOf(workspacePersistenceScope('sessions', WORKSPACE_ID), SESSION_ID), 'main');
  const storage = new FileStorageService(home);
  const log = new AppendLogStore(storage);
  return {
    journal,
    wirePath,
    manifestPath: `${wirePath}.segments.json`,
    wideScope,
    log,
    nav,
    service,
    close: async () => {
      log.dispose();
      await storage.close();
      service.dispose();
      await db.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
