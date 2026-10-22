import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerSessionCommand, type SessionCommandDeps } from '#/cli/sub/session';

vi.mock('#/kiki/home', () => ({
  resolveKikiHome: () => {
    throw new Error('resolveKikiHome');
  },
}));

const SESSION_ID = 'session_2fd93c4b-8945-479b-b61a-cf106bcf2e9b';

describe('kiki session seal', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('seals and unseals one injected session without opening the user home', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kiki-session-seal-'));
    cleanup.push(homeDir);
    const sessionDir = join(homeDir, 'sessions', 'wd_alpha', SESSION_ID);
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const journal = Buffer.from(`${JSON.stringify({
      type: 'turn_begin',
      time: 1_700_000_000_000,
      userInput: 'NEEDLE_COLD',
      id: 'cold',
    })}\n`);
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await writeFile(wirePath, journal);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCodes: number[] = [];
    const deps: Partial<SessionCommandDeps> = {
      homeDir: () => homeDir,
      stdout: { write: (chunk) => (stdout.push(chunk), true) },
      stderr: { write: (chunk) => (stderr.push(chunk), true) },
      exit: ((code: number) => {
        exitCodes.push(code);
      }) as SessionCommandDeps['exit'],
    };
    const program = new Command('kiki');
    registerSessionCommand(program, deps);
    const seal = program.commands.find((command) => command.name() === 'session')?.commands.find((command) => command.name() === 'seal');
    const unseal = program.commands.find((command) => command.name() === 'session')?.commands.find((command) => command.name() === 'unseal');
    expect(seal?.description()).toMatch(/original wire file stays on disk/i);
    expect(unseal?.description()).toMatch(/not modified/i);

    await program.parseAsync(['node', 'kiki', 'session', 'seal', SESSION_ID, '--json']);

    expect(stderr).toEqual([]);
    expect(exitCodes).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      schemaVersion: 1,
      action: 'seal',
      sessionId: SESSION_ID,
      workspaceId: 'wd_alpha',
      wires: 1,
      originalRetained: true,
    });
    expect(await readFile(wirePath)).toEqual(journal);
    const manifest = await stat(join(sessionDir, 'agents', 'main', 'wire.jsonl.segments.json'));
    expect(manifest.isFile()).toBe(true);
    expect(manifest.size).toBeGreaterThan(0);

    stdout.length = 0;
    const unsealProgram = new Command('kiki');
    registerSessionCommand(unsealProgram, deps);
    await unsealProgram.parseAsync(['node', 'kiki', 'session', 'unseal', SESSION_ID, '--json']);

    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      action: 'unseal',
      sessionId: SESSION_ID,
      wires: 1,
      originalRetained: true,
    });
    await expect(stat(join(sessionDir, 'agents', 'main', 'wire.jsonl.segments.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(wirePath)).toEqual(journal);
  });

  it('refuses a session the host reports as active and leaves the journal untouched', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kiki-session-seal-busy-'));
    cleanup.push(homeDir);
    const sessionDir = join(homeDir, 'sessions', 'wd_alpha', SESSION_ID);
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const journal = Buffer.from('{"type":"turn_begin"}\n');
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await writeFile(wirePath, journal);
    const stderr: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command('kiki');
    registerSessionCommand(program, {
      homeDir: () => homeDir,
      stdout: { write: () => true },
      stderr: { write: (chunk) => (stderr.push(chunk), true) },
      exit: ((code: number) => {
        exitCodes.push(code);
      }) as SessionCommandDeps['exit'],
      sealSession: () => Promise.reject(Object.assign(new Error(`Session "${SESSION_ID}" is active in another process`), {
        code: 'storage.locked',
      })),
    });

    await program.parseAsync(['node', 'kiki', 'session', 'seal', SESSION_ID, '--json']);

    expect(exitCodes).toEqual([1]);
    expect(JSON.parse(stderr.join('')).error.code).toBe('session_active');
    expect(await readFile(wirePath)).toEqual(journal);
    await expect(stat(join(sessionDir, 'agents', 'main', 'wire.jsonl.segments.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
