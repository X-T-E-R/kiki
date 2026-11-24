import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectAntigravitySubagentWork,
  readAntigravityChildrenAtWork,
  readAntigravityPendingReply,
  readAntigravityPreEditFileInRoots,
  watchAntigravityTurnOutcome,
} from '#/os/backends/node-local/antigravityRuntime';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const scratch = join(process.cwd(), '.tmp');
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('antigravityRuntime 1.5+ outcome, brain/ inspection, and pre-edit root reader', () => {
  it('parses agy 1.5 STATUS (code NNN), pre/post-planner 404, and step-17 INVALID_THINKING_SIGNATURE scoped after watermark', async () => {
    const home = await makeTempDir('agy-rt-outcome-');
    await mkdir(join(home, 'antigravity-acp', 'conversations'), { recursive: true });
    const dbPath = join(home, 'antigravity-acp', 'conversations', 'sess-1.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
    db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(1, 17, Buffer.from('NOT_FOUND (code 404): stale prior error'));

    try {
      const checkStale = await watchAntigravityTurnOutcome(home, 'sess-1');
      expect(await checkStale('end_turn')).toBeUndefined();

      const checkPre404 = await watchAntigravityTurnOutcome(home, 'sess-1');
      db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(2, 17, Buffer.from('NOT_FOUND (code 404): model not entitled'));
      expect(await checkPre404('end_turn')).toEqual({
        kind: 'provider_error',
        message: 'model not entitled',
        code: 'NOT_FOUND',
        retryable: false,
        resetAt: undefined,
        continuable: undefined,
      });

      const checkPost404 = await watchAntigravityTurnOutcome(home, 'sess-1');
      db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(3, 15, Buffer.from('planner response'));
      db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(4, 17, Buffer.from('NOT_FOUND (code 404): edge disconnect'));
      expect(await checkPost404('end_turn')).toEqual({
        kind: 'provider_error',
        message: 'edge disconnect',
        code: 'NOT_FOUND',
        retryable: true,
        resetAt: undefined,
        continuable: true,
      });

      const checkPoison = await watchAntigravityTurnOutcome(home, 'sess-1');
      db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(
        5,
        17,
        Buffer.from('INVALID_ARGUMENT (code 400): messages.4.content.0.thinking.signature: Field required'),
      );
      expect(await checkPoison('end_turn')).toMatchObject({
        kind: 'provider_error',
        code: 'INVALID_THINKING_SIGNATURE',
        retryable: true,
        poisonedSession: true,
      });
    } finally {
      db.close();
    }
  });

  it('inspects detached subagent records under brain/<sessionId> and enforces 24-entry and byte budgets', async () => {
    const home = await makeTempDir('agy-rt-brain-');
    const parentSubagents = join(home, 'antigravity-acp', 'brain', 'root-1', '.system_generated', 'subagents');
    const parentMessages = join(home, 'antigravity-acp', 'brain', 'root-1', '.system_generated', 'messages');
    const childMessages = join(home, 'antigravity-acp', 'brain', 'child-a', '.system_generated', 'messages');
    const childLogs = join(home, 'antigravity-acp', 'brain', 'child-a', '.system_generated', 'logs');
    await Promise.all([
      mkdir(parentSubagents, { recursive: true }),
      mkdir(parentMessages, { recursive: true }),
      mkdir(childMessages, { recursive: true }),
      mkdir(childLogs, { recursive: true }),
    ]);

    await writeFile(join(parentSubagents, 'child-a.json'), JSON.stringify({
      conversationId: 'child-a',
      state: 'SUBAGENT_STATE_RUNNING',
      subagentDescriptor: { role: 'explorer' },
    }));
    await writeFile(join(childMessages, 'm1.json'), JSON.stringify({
      sender: 'root-1',
      content: 'fallback prompt',
      sourceMetadata: {
        tool: {
          conversationId: 'root-1',
          toolCall: {
            id: 'call-sub-1',
            name: 'invoke_subagent',
            argumentsJson: JSON.stringify({ Role: 'code_auditor', Prompt: 'Audit parser edge cases' }),
          },
        },
      },
    }));
    await writeFile(join(childLogs, 'transcript.jsonl'), [
      JSON.stringify({ step_index: 0, type: 'SYSTEM_MESSAGE', content: 'boot' }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'in_progress',
        content: 'Scanning files',
        tool_calls: [{ name: 'view_file', args: { path: 'src/index.ts' } }],
      }),
    ].join('\n'));

    const snapshot = await inspectAntigravitySubagentWork({
      profileDirectory: home,
      sessionId: 'root-1',
      toolCallId: 'call-sub-1',
    });
    expect(snapshot.incomplete).toBe(false);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({
      conversationId: 'child-a',
      toolCallId: 'call-sub-1',
      role: 'code_auditor',
      prompt: 'Audit parser edge cases',
      reported: false,
      latestStep: {
        index: 3,
        type: 'PLANNER_RESPONSE',
        text: 'Scanning files',
        toolCalls: [{ name: 'view_file' }],
      },
    });

    expect(await readAntigravityChildrenAtWork({
      profileDirectory: home,
      sessionId: 'root-1',
      toolCallIds: ['call-sub-1'],
    })).toEqual({ activeToolCallIds: ['call-sub-1'], incomplete: false });

    await writeFile(join(parentMessages, 'wake.json'), JSON.stringify({
      id: 'wake-1',
      sender: 'child-a',
      priority: 'MESSAGE_PRIORITY_HIGH',
      content: 'Finished audit',
    }));
    expect(await readAntigravityChildrenAtWork({
      profileDirectory: home,
      sessionId: 'root-1',
      toolCallIds: ['call-sub-1'],
    })).toEqual({ activeToolCallIds: [], incomplete: false });
    expect(await readAntigravityPendingReply({ profileDirectory: home, sessionId: 'root-1' })).toBe(true);

    await writeFile(join(parentMessages, 'read.json'), JSON.stringify({ 'wake-1': true }));
    expect(await readAntigravityPendingReply({ profileDirectory: home, sessionId: 'root-1' })).toBe(false);

    for (let index = 0; index < 26; index += 1) {
      await writeFile(join(parentSubagents, `extra-${String(index).padStart(2, '0')}.json`), JSON.stringify({
        conversationId: `extra-${String(index).padStart(2, '0')}`,
      }));
    }
    const capped = await inspectAntigravitySubagentWork({ profileDirectory: home, sessionId: 'root-1' });
    expect(capped.entries).toHaveLength(24);
    expect(capped.incomplete).toBe(true);
  });

  it('reads pre-edit files only inside authorized workspace roots and enforces 1 MiB and UTF-8 limits', async () => {
    const base = await makeTempDir('agy-pre-edit-');
    const root = join(base, 'workspace');
    const evil = join(base, 'workspace-evil');
    await Promise.all([mkdir(root, { recursive: true }), mkdir(evil, { recursive: true })]);

    const okFile = join(root, 'ok.ts');
    const outsideFile = join(evil, 'secret.ts');
    const bigFile = join(root, 'big.txt');
    const binFile = join(root, 'bin.dat');
    await writeFile(okFile, 'export const ok = 1;\n', 'utf8');
    await writeFile(outsideFile, 'secret', 'utf8');
    await writeFile(bigFile, 'x'.repeat(1024 * 1024 + 16), 'utf8');
    await writeFile(binFile, Buffer.from([0x61, 0x00, 0x62]));

    expect(readAntigravityPreEditFileInRoots(okFile, [root])).toBe('export const ok = 1;\n');
    expect(readAntigravityPreEditFileInRoots(outsideFile, [root])).toBeUndefined();
    expect(readAntigravityPreEditFileInRoots(bigFile, [root])).toBeUndefined();
    expect(readAntigravityPreEditFileInRoots(binFile, [root])).toBeUndefined();
  });
});
