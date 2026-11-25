import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { SESSION_LOCK_SCOPE, isSessionLockActive, sessionLockKey } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileLock';
import { afterEach, describe, expect, it } from 'vitest';

import {
  compactPersistedSession,
  discardPersistedSession,
  persistedSessionLockScope,
  sealPersistedSession,
  unsealPersistedSession,
} from '../src/retained-session';
import { foldAgentWireReplay } from '../src/v2/resume-replay';

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

  it('compacts sparse zstd journals, folds replay records logically, and restores original bytes on unseal', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kiki-retained-compact-'));
    cleanup.push(homeDir);
    const sessionDir = join(homeDir, 'sessions', WORKSPACE_ID, SESSION_ID);
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    const lines: string[] = [
      `${JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: 1000 })}\n`,
    ];
    for (let i = 0; i < 90; i += 1) {
      const marker = i === 40 ? 'SDK_REPLAY_INTERIOR_40' : `SDK_MSG_${i}`;
      lines.push(`${JSON.stringify({
        type: 'context.append_message',
        time: 1000 + i,
        message: {
          role: 'user',
          content: [{ type: 'text', text: `${marker} ${'REPEAT_'.repeat(300)}` }],
          toolCalls: [],
        },
      })}\n`);
    }
    const rawExpected = Buffer.from(lines.join(''));
    await writeFile(wirePath, rawExpected);

    const compacted = await compactPersistedSession(
      { homeDir, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, sessionDir },
      { segmentBytes: 128 * 1024, hotTailBytes: 64 * 1024 },
    );
    expect(compacted.compactedJournals).toBe(1);

    const folded = await foldAgentWireReplay(wirePath);
    expect(folded.replay.length).toBe(90);
    expect(JSON.stringify(folded.replay)).toContain('SDK_REPLAY_INTERIOR_40');

    const unsealed = await unsealPersistedSession({
      homeDir,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionDir,
    });
    expect(unsealed.unsealedJournals).toBe(1);
    expect(await readFile(wirePath)).toEqual(rawExpected);
  });

  it('streams multi-chunk journals without whole-file string allocation and propagates cold segment corruption (P1-6)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kiki-retained-stream-'));
    cleanup.push(homeDir);
    const sessionDir = join(homeDir, 'sessions', WORKSPACE_ID, SESSION_ID);
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    const lines: string[] = [
      `${JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: 1000 })}\n`,
    ];
    for (let i = 0; i < 240; i += 1) {
      const marker = i === 239 ? 'MULTI_CHUNK_FINAL_239' : `CHUNK_MSG_${i}`;
      lines.push(`${JSON.stringify({
        type: 'context.append_message',
        time: 1000 + i,
        message: {
          role: 'user',
          content: [{ type: 'text', text: `${marker} ${'UTF8_边界_'.repeat(520)}` }],
          toolCalls: [],
        },
      })}\n`);
    }
    const rawExpected = Buffer.from(lines.join(''));
    expect(rawExpected.byteLength).toBeGreaterThan(1024 * 1024);
    await writeFile(wirePath, rawExpected);

    const compacted = await compactPersistedSession(
      { homeDir, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, sessionDir },
      { segmentBytes: 256 * 1024, hotTailBytes: 64 * 1024 },
    );
    expect(compacted.compactedJournals).toBe(1);

    const folded = await foldAgentWireReplay(wirePath);
    expect(folded.replay.length).toBe(240);
    expect(JSON.stringify(folded.replay.at(-1))).toContain('MULTI_CHUNK_FINAL_239');

    const segRoot = `${wirePath}.segments`;
    const [sealDir] = await readdir(segRoot);
    const [firstSeg] = await readdir(join(segRoot, sealDir!));
    const fh = await open(join(segRoot, sealDir!, firstSeg!), 'r+');
    try {
      await fh.write(Buffer.from([0xde, 0xad, 0xbe, 0xef]), 0, 4, 0);
    } finally {
      await fh.close();
    }

    await expect(foldAgentWireReplay(wirePath)).rejects.toMatchObject({
      code: 'storage.corrupted',
    });
  });

  it('preserves context.undo replacementPrompt, agent.model_switch context, external.text, and branch.base undo bounds in resume replay', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kiki-resume-replay-parity-'));
    cleanup.push(homeDir);
    const wirePath = join(homeDir, 'wire.jsonl');
    const records = [
      { type: 'metadata', protocol_version: '1.6', created_at: 1000 },
      {
        type: 'context.append_message',
        time: 1001,
        message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }], toolCalls: [], origin: { kind: 'user' } },
      },
      {
        type: 'context.append_message',
        time: 1002,
        message: { role: 'assistant', content: [{ type: 'text', text: 'first reply' }], toolCalls: [] },
      },
      {
        type: 'context.undo',
        time: 1003,
        count: 1,
        replacementPrompt: {
          message: { role: 'user', content: [{ type: 'text', text: 'edited prompt' }], toolCalls: [], origin: { kind: 'user' } },
        },
      },
      {
        type: 'context.append_message',
        time: 1004,
        message: { role: 'assistant', content: [{ type: 'text', text: 'second reply' }], toolCalls: [] },
      },
      {
        type: 'external.text',
        time: 1005,
        recordId: 'ext-1',
        kind: 'note',
        title: 'External Note',
        text: 'captured handoff text',
        source: { connectionId: 'conn-1', clientName: 'ext-cli', sessionRef: 'ref-1', driver: 'external' },
      },
      {
        type: 'branch.base',
        time: 1006,
        version: 1,
        parentAgentId: 'main',
        seed: 'verbatim',
        inheritedCount: 3,
      },
      {
        type: 'context.undo',
        time: 1007,
        count: 1,
      },
      {
        type: 'agent.model_switch',
        time: 1008,
        context: [
          { role: 'user', content: [{ type: 'text', text: 'rebuilt summary prompt' }], toolCalls: [], origin: { kind: 'user' } },
        ],
      },
      {
        type: 'context.append_message',
        time: 1009,
        message: { role: 'assistant', content: [{ type: 'text', text: 'post-switch reply' }], toolCalls: [] },
      },
    ];
    await writeFile(wirePath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

    const folded = await foldAgentWireReplay(wirePath);
    const texts = folded.replay
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.message.content.filter((part) => part.type === 'text').map((part) => part.text).join(''));
    expect(texts).toEqual(['rebuilt summary prompt', 'post-switch reply']);

    const wireUndoOnly = join(homeDir, 'wire-undo.jsonl');
    await writeFile(wireUndoOnly, `${records.slice(0, 8).map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    const foldedBeforeSwitch = await foldAgentWireReplay(wireUndoOnly);
    const beforeTexts = foldedBeforeSwitch.replay
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.message.content.filter((part) => part.type === 'text').map((part) => part.text).join(''));
    expect(beforeTexts).toEqual(['edited prompt', 'second reply', 'captured handoff text']);
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
