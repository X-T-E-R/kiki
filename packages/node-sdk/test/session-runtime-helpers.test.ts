import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir, removeTempDirs, waitForAgentWireEvent } from './session-runtime-helpers';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

async function journal(homeDir: string, sessionId: string, body: string): Promise<void> {
  const sessionDir = await makeTempDir(tempDirs, 'kimi-sdk-wire-session-');
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
  await writeFile(
    join(homeDir, 'session_index.jsonl'),
    `${JSON.stringify({ sessionId, sessionDir })}\n`,
    'utf-8',
  );
  await writeFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), body, 'utf-8');
}

describe('live wire journal reads', () => {
  it('reads a committed profile.bind while an append is still open', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-wire-home-');
    const tail = `{"type":"profile.bind","modelAlias":"${'x'.repeat(240)}`;
    await journal(
      homeDir,
      'ses_wire_tail',
      `${JSON.stringify({ type: 'profile.bind', modelAlias: 'alias-model' })}\n${tail}`,
    );

    const event = await waitForAgentWireEvent(
      homeDir,
      'ses_wire_tail',
      'profile.bind',
      (candidate) => candidate['modelAlias'] === 'alias-model',
    );

    expect(event).toMatchObject({
      type: 'profile.bind',
      modelAlias: 'alias-model',
    });
    expect(event).not.toHaveProperty('provider');
  });

  it('waits until the open tail is committed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-wire-home-');
    const sessionDir = await makeTempDir(tempDirs, 'kimi-sdk-wire-session-');
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await writeFile(
      join(homeDir, 'session_index.jsonl'),
      `${JSON.stringify({ sessionId: 'ses_wire_wait', sessionDir })}\n`,
      'utf-8',
    );
    const partial = '{"type":"profile.bind","modelAlias":"alias-';
    await writeFile(wirePath, partial, 'utf-8');

    const pending = waitForAgentWireEvent(
      homeDir,
      'ses_wire_wait',
      'profile.bind',
      (candidate) => candidate['modelAlias'] === 'alias-model',
    );
    await writeFile(wirePath, `${partial}model"}\n`, 'utf-8');

    await expect(pending).resolves.toMatchObject({
      type: 'profile.bind',
      modelAlias: 'alias-model',
    });
  });

  it('throws when a newline-terminated line is corrupt', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-wire-home-');
    await journal(homeDir, 'ses_wire_corrupt', '{"type":"profile.bind"\n');

    await expect(waitForAgentWireEvent(
      homeDir,
      'ses_wire_corrupt',
      'profile.bind',
    )).rejects.toBeInstanceOf(SyntaxError);
  });
});
