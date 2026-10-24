import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { SESSION_LOCK_SCOPE, isSessionLockActive, sessionLockKey } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileLock';
import { afterEach, describe, expect, it } from 'vitest';

import {
  discardPersistedSession,
  persistedSessionLockScope,
  sealPersistedSession,
} from '../src/retained-session';

const SESSION_ID = 'session_2fd93c4b-8945-479b-b61a-cf106bcf2e9b';
const WORKSPACE_ID = 'wd_alpha';

describe('persisted session journal maintenance', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('refuses seal and discard while another storage holds the session file lock', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kiki-retained-lock-'));
    cleanup.push(homeDir);
    const sessionDir = await writeJournal(homeDir);
    const scope = persistedSessionLockScope(WORKSPACE_ID, SESSION_ID);
    expect(scope).toBe(`sessions/${WORKSPACE_ID}/${SESSION_ID}`);
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const journal = await readFile(wirePath);
    const holder = new FileStorageService(homeDir, 0o700, 0o600);
    const held = await holder.acquireLock(SESSION_LOCK_SCOPE, sessionLockKey(scope), {
      waitForMs: 0,
      owner: { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, scope },
    });
    try {
      expect(await isSessionLockActive(homeDir, scope)).toBe(true);
      const input = { homeDir, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, sessionDir };
      await expect(sealPersistedSession(input)).rejects.toMatchObject({ code: 'storage.locked' });
      await expect(stat(join(sessionDir, 'agents', 'main', 'wire.jsonl.segments.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(wirePath)).toEqual(journal);
    } finally {
      await held.release();
      await holder.close();
    }

    const sealed = await sealPersistedSession({ homeDir, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, sessionDir });
    expect(sealed).toHaveLength(1);
    expect(await readFile(wirePath)).toEqual(journal);
    const again = new FileStorageService(homeDir, 0o700, 0o600);
    const blocked = await again.acquireLock(SESSION_LOCK_SCOPE, sessionLockKey(scope), { waitForMs: 0 });
    try {
      await expect(discardPersistedSession({
        homeDir,
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        sessionDir,
      })).rejects.toMatchObject({ code: 'storage.locked' });
      expect((await stat(join(sessionDir, 'agents', 'main', 'wire.jsonl.segments.json'))).isFile()).toBe(true);
      expect(await readFile(wirePath)).toEqual(journal);
    } finally {
      await blocked.release();
      await again.close();
    }
  });

  it('does not let a lock in one home block the same session id in another home', async () => {
    const homeA = await mkdtemp(join(tmpdir(), 'kiki-retained-home-a-'));
    const homeB = await mkdtemp(join(tmpdir(), 'kiki-retained-home-b-'));
    cleanup.push(homeA, homeB);
    const sessionA = await writeJournal(homeA);
    const sessionB = await writeJournal(homeB);
    const scope = persistedSessionLockScope(WORKSPACE_ID, SESSION_ID);
    const holder = new FileStorageService(homeA, 0o700, 0o600);
    const held = await holder.acquireLock(SESSION_LOCK_SCOPE, sessionLockKey(scope), { waitForMs: 0 });
    try {
      const sealed = await sealPersistedSession({
        homeDir: homeB,
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        sessionDir: sessionB,
      });
      expect(sealed).toHaveLength(1);
      await expect(stat(join(sessionA, 'agents', 'main', 'wire.jsonl.segments.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(join(sessionB, 'agents', 'main', 'wire.jsonl.segments.json'))).isFile()).toBe(true);
    } finally {
      await held.release();
      await holder.close();
    }
  });
});

async function writeJournal(homeDir: string): Promise<string> {
  const sessionDir = join(homeDir, 'sessions', WORKSPACE_ID, SESSION_ID);
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
  await writeFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), `${JSON.stringify({
    type: 'turn_begin',
    userInput: 'NEEDLE_COLD',
  })}\n`);
  return sessionDir;
}
