/**
 * Scenario: Node SDK sessions persist and list through the public harness.
 * Responsibilities: workDir scoping, index recovery, fork metadata, and native path-safe listing.
 * Wiring: real in-process harness/session storage; no remote provider calls.
 * Run: pnpm exec vitest run test/list-sessions.test.ts
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  SQLITE_QUERY_STORE_SUBDIR,
  IThreadMailboxStore,
  IHomeRuntimeService,
  ILogService,
  ISessionIndex,
  ISessionIndexMirror,
} from '@kiki/agent-core-v2';
import { FileSessionIndex } from '@kiki/agent-core-v2/app/sessionIndex/sessionIndexService';
import { SessionIndexProjector } from '@kiki/agent-core-v2/app/sessionIndex/sessionIndexProjector';

import { createKimiHarness, SDKRpcClient } from '#/index';
import type { KimiError } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await drainSessionIndexMirror();
  await drainQueryStoreDisposals();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-list-'));
  tempDirs.push(dir);
  return dir;
}

async function closeClientRuntime(client: SDKRpcClient): Promise<void> {
  const mailboxClose = vi.spyOn(client.engineAccessor.get(IThreadMailboxStore), 'close');
  const runtimeClose = vi.spyOn(client.engineAccessor.get(IHomeRuntimeService), 'close');
  await client.close();
  expect(mailboxClose).toHaveBeenCalledOnce();
  expect(runtimeClose).toHaveBeenCalledOnce();
  expect(mailboxClose.mock.invocationCallOrder[0]).toBeLessThan(runtimeClose.mock.invocationCallOrder[0]!);
}

async function writeSessionState(
  sessionDir: string,
  state: Record<string, unknown>,
): Promise<string> {
  const statePath = join(sessionDir, 'state.json');
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  return statePath;
}


describe('KimiHarness.listSessions', () => {
  it('rejects whitespace-only workDir with request.work_dir_required', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(harness.listSessions({ workDir: '   ' })).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('lists all sessions when no payload is provided', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const otherWorkDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      expect(await harness.listSessions()).toEqual([]);
      await harness.createSession({ id: 'ses_harness_all_a', workDir });
      await harness.createSession({ id: 'ses_harness_all_b', workDir: otherWorkDir });

      const rpc = Reflect.get(harness, 'rpc') as SDKRpcClient;
      const status = await rpc.engineAccessor.get(ISessionIndex).prepare();
      expect(status.state, JSON.stringify(status)).toBe('ready');
      const sessions = await harness.listSessions();
      expect(sessions.map((session) => session.id).toSorted()).toEqual([
        'ses_harness_all_a',
        'ses_harness_all_b',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('recovers the complete listing after both startup projection attempts meet real session mutations', async () => {
    const homeDir = await makeTempDir();
    const workDirs = [await makeTempDir(), await makeTempDir()];
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const released = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const originalScan = SessionIndexProjector.prototype.scan;
    let scans = 0;
    const scan = vi.spyOn(SessionIndexProjector.prototype, 'scan').mockImplementation(async function (this: SessionIndexProjector, options) {
      const result = await originalScan.call(this, options);
      const attempt = scans++;
      entered[attempt]?.resolve();
      await released[attempt]?.promise;
      return result;
    });
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    const rpc = Reflect.get(harness, 'rpc') as SDKRpcClient;
    const index = rpc.engineAccessor.get(ISessionIndex);
    const mirror = rpc.engineAccessor.get(ISessionIndexMirror);
    const warning = vi.spyOn(rpc.engineAccessor.get(ILogService), 'warn');
    const epochs: Array<{ before: number; after: number }> = [];
    let preparing: ReturnType<typeof index.prepare> | undefined;
    try {
      await entered[0]!.promise;
      preparing = index.prepare();
      for (const attempt of [0, 1]) {
        await entered[attempt]!.promise;
        const before = mirror.epoch();
        await harness.createSession({ id: `ses_harness_churn_${attempt}`, workDir: workDirs[attempt]! });
        epochs.push({ before, after: mirror.epoch() });
        released[attempt]!.resolve();
      }
      const status = await preparing;
      expect(status).toMatchObject({ state: 'degraded', reason: 'projection failed', degradedCount: 1, generation: undefined });
      expect(scans).toBe(2);
      expect(epochs).toEqual([{ before: 0, after: 1 }, { before: 1, after: 2 }]);
      expect(warning).toHaveBeenCalledWith('session index read model degraded; list/count fail closed until rebuilt', {
        reason: 'projection failed', error: 'session index reconciliation is incomplete', degradedCount: 1,
      });
      expect(await index.get('ses_harness_churn_0')).toMatchObject({ id: 'ses_harness_churn_0' });
      expect(await index.get('ses_harness_churn_1')).toMatchObject({ id: 'ses_harness_churn_1' });
      await (index as FileSessionIndex).reprojectNow();
      const recovered = await index.prepare();
      expect(recovered.state, JSON.stringify(recovered)).toBe('ready');
      expect(scans).toBe(3);
      expect((await harness.listSessions()).map(session => session.id).toSorted()).toEqual(['ses_harness_churn_0', 'ses_harness_churn_1']);
      process.stdout.write(`${JSON.stringify({ sessionIndexStartupProof: { status, recovered, scans, epochs } })}\n`);
    } finally {
      for (const gate of released) gate.resolve();
      await preparing;
      scan.mockRestore(); warning.mockRestore();
      try { await harness.close(); } finally { vi.useRealTimers(); }
    }
  });

  it('lists a session from a workDir containing spaces and non-ASCII characters', async () => {
    const homeDir = await makeTempDir();
    const root = await makeTempDir();
    const workDir = join(root, 'Workspace With Spaces', '项目');
    await mkdir(workDir, { recursive: true });
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_unicode_workdir', workDir });

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      await harness.close();
    }
  });

  it('resolves relative workDir inputs before filtering', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });
    const originalCwd = process.cwd();

    try {
      process.chdir(workDir);
      const session = await harness.createSession({ id: 'ses_relative_workdir', workDir: '.' });

      const sessions = await harness.listSessions({ workDir: '.' });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      process.chdir(originalCwd);
      await harness.close();
    }
  });

  it('lists persisted sessions after the active Session has been closed', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_closed_but_listed', workDir });
      await harness.closeSession(session.id);

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      await harness.close();
    }
  });

});

describe('SDKRpcClient.listSessionsPage', () => {
  it('pages through the listing with keyset cursors (read model off)', async () => {
    vi.stubEnv('KIKI_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIKI_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL', '0');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClient({ homeDir, identity: TEST_IDENTITY });

    try {
      for (let i = 0; i < 5; i += 1) {
        const created = await client.createSession({ id: `ses_page_${i}`, workDir });
        await client.closeSession({ sessionId: created.id });
      }

      const page1 = await client.listSessionsPage({ workDir, limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBe(page1.items.at(-1)?.id);

      const page2 = await client.listSessionsPage({ workDir, limit: 2, before: page1.nextCursor });
      expect(page2.items).toHaveLength(2);
      expect(page2.nextCursor).toBe(page2.items.at(-1)?.id);

      const page3 = await client.listSessionsPage({ workDir, limit: 2, before: page2.nextCursor });
      expect(page3.items).toHaveLength(1);
      expect(page3.nextCursor).toBeUndefined();

      const pagedIds = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
      expect(new Set(pagedIds)).toEqual(
        new Set([0, 1, 2, 3, 4].map((i) => `ses_page_${String(i)}`)),
      );
      // Draining pages yields exactly the unpaged listing, in the same order.
      const full = await client.listSessions({ workDir });
      expect(pagedIds).toEqual(full.map((item) => item.id));
    } finally {
      await client.close();
      vi.unstubAllEnvs();
    }
  });

  it('answers an empty terminal page for an unknown cursor', async () => {
    vi.stubEnv('KIKI_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIKI_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL', '0');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClient({ homeDir, identity: TEST_IDENTITY });

    try {
      const created = await client.createSession({ id: 'ses_cursor_probe', workDir });
      await client.closeSession({ sessionId: created.id });

      await expect(
        client.listSessionsPage({ workDir, before: 'ses_unknown' }),
      ).resolves.toEqual({ items: [], nextCursor: undefined });
    } finally {
      await client.close();
      vi.unstubAllEnvs();
    }
  });

  it('drains follow-up pages when the mapping drops entries (read model on)', async () => {
    vi.stubEnv('KIKI_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIKI_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL', '1');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClient({ homeDir, identity: TEST_IDENTITY });

    try {
      for (let i = 0; i < 3; i += 1) {
        const created = await client.createSession({ id: `ses_drain_${i}`, workDir });
        await client.closeSession({ sessionId: created.id });
      }
      const index = client.engineAccessor.get(ISessionIndex);
      expect((await index.prepare()).state).toBe('ready');
      // A summary whose workDir can no longer be resolved (unknown workspace,
      // no cwd) is dropped by the mapping; the page must still fill.
      const mirror = client.engineAccessor.get(ISessionIndexMirror);
      mirror.record({
        id: 'ses_ghost',
        workspaceId: 'ws_missing',
        createdAt: 1,
        updatedAt: Date.now() + 60_000,
        archived: false,
      });
      await mirror.drain();
      expect(mirror.pending()).toEqual([]);
      expect((await index.listRecent({ limit: 1 })).items.map((item) => item.id)).toEqual(['ses_ghost']);

      const page1 = await client.listSessionsPage({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.items.some((item) => item.id === 'ses_ghost')).toBe(false);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await client.listSessionsPage({ limit: 2, before: page1.nextCursor });
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0]?.id).not.toBe('ses_ghost');
      expect(page2.nextCursor).toBeUndefined();

      const ids = [...page1.items, ...page2.items].map((item) => item.id).toSorted();
      expect(ids).toEqual(['ses_drain_0', 'ses_drain_1', 'ses_drain_2']);
    } finally {
      await client.close();
      // Dispose fired the mirror/query-store async closes; await them before
      // the shared afterEach removes the temp home.
      await drainSessionIndexMirror();
      await drainQueryStoreDisposals();
      vi.unstubAllEnvs();
    }
  });
});

describe('SDKRpcClient search-index separation', () => {
  it('propagates mailbox shutdown failures before closing its runtime', async () => {
    const homeDir = await makeTempDir();
    const client = new SDKRpcClient({ homeDir, identity: TEST_IDENTITY });
    const failure = new Error('Mailbox shutdown failed fixture');
    const mailboxClose = vi.spyOn(client.engineAccessor.get(IThreadMailboxStore), 'close').mockRejectedValueOnce(failure);
    const runtimeClose = vi.spyOn(client.engineAccessor.get(IHomeRuntimeService), 'close');
    try {
      await expect(client.close()).rejects.toBe(failure);
      expect(runtimeClose).not.toHaveBeenCalled();
    } finally {
      mailboxClose.mockRestore();
      await client.close();
    }
  });

  // The global full-text search database (`<homeDir>/search-index`) belongs
  // to the kap-server search surface. The TUI-side chain (rpc client →
  // klient → `ISessionIndex`) must list, resume and continue sessions without
  // ever opening it — including while the session read model is still
  // preparing.

  it('listSessions / resumeSession never open the global search index (read model off)', async () => {
    vi.stubEnv('KIKI_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIKI_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL', '0');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClient({ homeDir, identity: TEST_IDENTITY });

    try {
      const created = await client.createSession({ id: 'ses_search_sep_off', workDir });
      await client.closeSession({ sessionId: created.id });

      const sessions = await client.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([created.id]);
      const resumed = await client.resumeSession({ id: created.id });
      expect(resumed.id).toBe(created.id);

      expect(existsSync(join(homeDir, 'search-index'))).toBe(false);
      expect(existsSync(join(homeDir, 'search-index-v2'))).toBe(false);
    } finally {
      await closeClientRuntime(client);
      await drainQueryStoreDisposals();
      vi.unstubAllEnvs();
    }
  });

  it('listSessions / resumeSession never open the global search index (read model on)', async () => {
    vi.stubEnv('KIKI_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIKI_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL', '1');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClient({ homeDir, identity: TEST_IDENTITY });

    try {
      const created = await client.createSession({ id: 'ses_search_sep_on', workDir });
      await client.closeSession({ sessionId: created.id });

      // The read model is still preparing here: the first list kicks the
      // background projection and answers from authoritative metadata, the
      // resume reads the authoritative document — neither waits for, nor
      // opens, any full-text index.
      const sessions = await client.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([created.id]);
      const resumed = await client.resumeSession({ id: created.id });
      expect(resumed.id).toBe(created.id);

      expect(existsSync(join(homeDir, 'search-index'))).toBe(false);
      expect(existsSync(join(homeDir, 'search-index-v2'))).toBe(false);

      // Settle the kicked projection before close so teardown never races it,
      // and prove the read model really did engage (the flag took effect).
      const status = await client.engineAccessor.get(ISessionIndex).prepare();
      expect(status.state).toBe('ready');
      expect(existsSync(join(homeDir, 'cache', SQLITE_QUERY_STORE_SUBDIR))).toBe(true);
      expect(existsSync(join(homeDir, 'search-index'))).toBe(false);
    } finally {
      await closeClientRuntime(client);
      // Dispose fired the mirror/query-store async closes; await them before
      // the shared afterEach removes the temp home.
      await drainSessionIndexMirror();
      await drainQueryStoreDisposals();
      vi.unstubAllEnvs();
    }
  });
});
