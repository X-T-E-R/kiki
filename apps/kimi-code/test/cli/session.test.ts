import { appendFile, mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '#/cli/commands';
import {
  handleSessionShow,
  registerSessionCommand,
  type SessionCommandDeps,
} from '#/cli/sub/session';
import {
  followOfflineSession,
  inspectOfflineSession,
  normalizeSessionReference,
  SessionInspectionError,
} from '#/kiki/session-inspect';
import { renderSessionInspection } from '#/kiki/session-inspect-render';
import * as sessionWire from '#/kiki/session-inspect-wire';

const UUID = '2fd93c4b-8945-479b-b61a-cf106bcf2e9b';
const SESSION_ID = `session_${UUID}`;

let homeDir: string;
const cleanup: string[] = [];

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kiki-session-inspect-'));
  cleanup.push(homeDir);
});

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('session reference parsing', () => {
  it.each([
    [`/s/${SESSION_ID}`, SESSION_ID],
    [`/s/${SESSION_ID}/`, SESSION_ID],
    [SESSION_ID, SESSION_ID],
    [UUID, SESSION_ID],
    [UUID.toUpperCase(), SESSION_ID],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeSessionReference(input)).toBe(expected);
  });

  it('rejects ambiguous or path-like inputs with accepted forms', () => {
    expect(() => normalizeSessionReference(`https://example.test/s/${SESSION_ID}`)).toThrowError(
      expect.objectContaining({ code: 'invalid_reference' }),
    );
    expect(() => normalizeSessionReference(`/s/${SESSION_ID}/extra`)).toThrow(/bare UUID/i);
  });
});

describe('offline session inspection', () => {
  it('scopes metadata, status, and timeline projection to one selected agent', async () => {
    await createSessionFixture(homeDir, 'wd_alpha', SESSION_ID, {
      title: 'Investigate build',
      cwd: '/repo/alpha',
      agents: {
        main: { type: 'main', model: 'kimi-k2' },
        'agent-child': {
          type: 'sub',
          parentAgentId: 'main',
          displayName: 'explore',
          userLabel: 'Map tests',
          labels: { profileName: 'explore-profile' },
          model: 'fast-model',
        },
      },
    });
    const mainWire = await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'main', standardWire('hello', 'done'));
    await writeFile(mainWire, '{broken main wire\n', 'utf8');
    await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'agent-child', standardWire('child prompt', 'child answer'));

    const result = await inspectOfflineSession({
      homeDir,
      reference: `/s/${SESSION_ID}`,
      agent: 'Map tests',
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      session: {
        id: SESSION_ID,
        title: 'Investigate build',
        workDir: '/repo/alpha',
        workspaceId: 'wd_alpha',
        model: 'kimi-k2',
        status: 'completed',
        statusBasis: 'metadata',
        agentCount: 2,
      },
      selectedAgent: { id: 'agent-child', name: 'Map tests' },
    });
    expect(result.agents).toEqual([
      expect.objectContaining({
        id: 'agent-child',
        name: 'Map tests',
        label: 'Map tests',
        parentId: 'main',
        status: 'completed',
        lastActivityAt: new Date(5_000).toISOString(),
      }),
    ]);
    expect(result.timeline).toEqual([
      expect.objectContaining({ type: 'message', role: 'user', text: 'child prompt' }),
      expect.objectContaining({ type: 'message', role: 'assistant', text: 'child answer' }),
    ]);
    await expect(inspectOfflineSession({
      homeDir,
      reference: SESSION_ID,
      agent: 'explore-profile',
    })).resolves.toMatchObject({ selectedAgent: { id: 'agent-child' } });
  });

  it('lists every matching workspace instead of guessing when ids collide', async () => {
    await createSessionFixture(homeDir, 'wd_alpha', SESSION_ID, { cwd: '/repo/alpha' });
    await createSessionFixture(homeDir, 'wd_beta', SESSION_ID, { cwd: '/repo/beta' });
    await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'main', standardWire('a', 'a'));
    await writeWire(homeDir, 'wd_beta', SESSION_ID, 'main', standardWire('b', 'b'));

    await expect(inspectOfflineSession({ homeDir, reference: UUID })).rejects.toMatchObject({
      code: 'ambiguous_session',
      matches: [
        expect.objectContaining({ workspaceId: 'wd_alpha', workDir: '/repo/alpha' }),
        expect.objectContaining({ workspaceId: 'wd_beta', workDir: '/repo/beta' }),
      ],
    });

    const selected = await inspectOfflineSession({
      homeDir,
      reference: UUID,
      workspace: 'wd_beta',
    });
    expect(selected.session.workspaceId).toBe('wd_beta');
    expect(selected.timeline).toEqual([
      expect.objectContaining({ type: 'message', role: 'user', text: 'b' }),
      expect.objectContaining({ type: 'message', role: 'assistant', text: 'b' }),
    ]);
  });

  it('offers nearby ids and the list command when a session is missing', async () => {
    await createSessionFixture(homeDir, 'wd_alpha', SESSION_ID, { title: 'Nearby' });
    await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'main', standardWire('a', 'b'));
    const missing = 'session_2fd93c4b-8945-479b-b61a-cf106bcf2e9c';

    try {
      await inspectOfflineSession({ homeDir, reference: missing });
      throw new Error('expected not_found');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionInspectionError);
      expect(error).toMatchObject({ code: 'not_found' });
      expect((error as Error).message).toContain(SESSION_ID);
      expect((error as Error).message).toContain('kiki session list');
    }
  });

  it('reports a damaged state document with the directory to inspect', async () => {
    const sessionDir = join(homeDir, 'sessions', 'wd_alpha', SESSION_ID);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{broken', 'utf8');

    await expect(inspectOfflineSession({ homeDir, reference: UUID })).rejects.toMatchObject({
      code: 'damaged_session',
      message: expect.stringContaining(sessionDir),
    });
  });

  it('shows a valid empty session without creating its main wire', async () => {
    const sessionDir = join(homeDir, 'sessions', 'wd_alpha', SESSION_ID);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({
      id: SESSION_ID,
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      agents: {},
    }), 'utf8');

    const result = await inspectOfflineSession({ homeDir, reference: UUID });

    expect(result.session).toMatchObject({ agentCount: 1, status: 'idle', statusBasis: 'wire' });
    expect(result.timeline).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/roster is empty/i);
  });

  it('rejects state files that escape the session through a symlink', async () => {
    if (process.platform === 'win32') return;
    const sessionDir = join(homeDir, 'sessions', 'wd_alpha', SESSION_ID);
    const outside = join(homeDir, 'outside.json');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(outside, JSON.stringify({ id: SESSION_ID, agents: {} }), 'utf8');
    await symlink(outside, join(sessionDir, 'state.json'), 'file');

    await expect(inspectOfflineSession({ homeDir, reference: UUID })).rejects.toMatchObject({
      code: 'damaged_session',
      message: expect.stringMatching(/regular file/i),
    });
  });

  it('ignores directories outside the wd_* workspace namespace', async () => {
    await createSessionFixture(homeDir, 'scratch', SESSION_ID);
    await writeWire(homeDir, 'scratch', SESSION_ID, 'main', standardWire('a', 'b'));

    await expect(inspectOfflineSession({ homeDir, reference: UUID })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('does not write or touch any target-session file', async () => {
    await createSessionFixture(homeDir, 'wd_alpha', SESSION_ID, { cwd: '/repo/readonly' });
    await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'main', standardWire('read only', 'confirmed'));
    const before = await snapshotTree(homeDir);

    await inspectOfflineSession({ homeDir, reference: SESSION_ID });

    const after = await snapshotTree(homeDir);
    expect(after).toEqual(before);
  });

  it('reports a partial-tail-only read without calling it a bounded window', async () => {
    await createSessionFixture(homeDir, 'wd_alpha', SESSION_ID);
    const wirePath = await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'main', standardWire('safe', 'answer'));
    await writeFile(wirePath, `${await readFile(wirePath, 'utf8')}{"type":"turn.prompt"`, 'utf8');

    const result = await inspectOfflineSession({ homeDir, reference: UUID });

    expect(result.timeline).toContainEqual(
      expect.objectContaining({ type: 'message', role: 'assistant', text: 'answer' }),
    );
    expect(result.wire).toMatchObject({ startByteOffset: 0, partialTail: true });
    expect(result.wire?.endByteOffset).toBe(result.wire?.watermark);
    expect(result.warnings.join('\n')).toMatch(/incomplete tail was ignored/i);
    expect(result.warnings.join('\n')).not.toMatch(/bounded wire window/i);
    expect(result.agents[0]?.wireComplete).toBe(false);
  });

  it('uses persisted session outcome instead of stale child-agent activity', async () => {
    await createSessionFixture(homeDir, 'wd_alpha', SESSION_ID, {
      lastTurnReason: 'completed',
      agents: {
        main: { type: 'main', model: 'test-model' },
        child: { type: 'sub', parentAgentId: 'main', userLabel: 'Child' },
      },
    });
    await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'main', standardWire('done', 'done'));
    await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'child', [{
      type: 'turn.prompt',
      turnId: 0,
      input: [{ type: 'text', text: 'stale' }],
      origin: { kind: 'user' },
      time: 1,
    }]);

    const result = await inspectOfflineSession({ homeDir, reference: UUID });

    expect(result.session).toMatchObject({ status: 'completed', statusBasis: 'metadata' });
    expect(result.agents.find((agent) => agent.id === 'child')?.status).toBe('running');
  });

  it('pages a timeline through the real inspector without gaps and keeps an appended tail outside the original watermark', async () => {
    await createSessionFixture(homeDir, 'wd_alpha', SESSION_ID);
    const records = Array.from({ length: 12 }, (_, turn) => standardWire(`prompt-${turn}`, `answer-${turn}`)
      .map((record) => remapWireTurn(record, turn, `-${turn}`))).flat();
    const wire = await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'main', records);
    const options = { homeDir, reference: SESSION_ID, workspace: 'wd_alpha', agent: 'main', maxBytes: 1500 };
    const first = await inspectOfflineSession(options);
    expect(first.selectedAgent.wireComplete).toBe(false);
    expect(first.warnings.join('\n')).toMatch(/bounded wire window/);
    expect(renderSessionInspection(first)).toContain('--before ');
    const watermark = first.wire!.watermark;
    await appendFile(wire, `${standardWire('later', 'later answer').map((record) => JSON.stringify(remapWireTurn(record, 12, '-12'))).join('\n')}\n`);
    const answers: string[] = [];
    let page = first;
    for (let pages = 0; pages < 20; pages++) {
      answers.unshift(...page.timeline.filter((entry) => entry.type === 'message' && entry.role === 'assistant').map((entry) => entry.type === 'message' ? entry.text : ''));
      if (page.wire!.nextCursor === null) break;
      const older = await inspectOfflineSession({ ...options, before: page.wire!.nextCursor });
      expect(older.wire!.watermark).toBe(watermark);
      expect(older.wire!.endByteOffset).toBe(page.wire!.startByteOffset);
      page = older;
    }
    expect(page.wire!.startByteOffset).toBe(0);
    expect(page.selectedAgent.wireComplete).toBe(false);
    expect(page.warnings.join('\n')).toMatch(/bounded wire window/);
    expect(answers).toEqual(Array.from({ length: 12 }, (_, index) => `answer-${index}`));
    const reopened = await inspectOfflineSession(options);
    expect(reopened.wire!.watermark).toBeGreaterThan(watermark);
    expect(reopened.timeline).toContainEqual(expect.objectContaining({ type: 'message', text: 'later answer' }));
  });

  it.each([true, false])('keeps the actual prompt and early answer before a mid-turn user injection (delivery: %s)', async (delivery) => {
    await createSessionFixture(homeDir, 'wd_alpha', SESSION_ID);
    const records = standardWire('Q1', 'A1');
    records.splice(records.length - 1, 0, {
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text: 'injected note' }] },
      delivery: delivery ? { turnId: 0, step: 1, origin: 'injection', messageId: 'injected' } : undefined,
      time: 3,
    }, {
      type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: 'A2' }] }, time: 4,
    });
    await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'main', records);
    const page = await inspectOfflineSession({ homeDir, reference: SESSION_ID, agent: 'main', maxBytes: 80 });
    expect(page.wire?.startByteOffset).toBe(0);
    expect(page.wire?.startBoundary).toBe('turn');
    expect(page.timeline).toContainEqual(expect.objectContaining({ type: 'message', role: 'user', text: 'Q1' }));
    expect(page.timeline).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', text: 'A1' }));
    expect(page.timeline).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', text: 'A2' }));
  });

  it.each(['start', 'end'] as const)('shows actual records, including unanchored tool results, when the %s boundary splits a turn', async (split) => {
    await createSessionFixture(homeDir, 'wd_alpha', SESSION_ID, {
      agents: { main: { type: 'main' }, child: { type: 'sub', parentAgentId: 'main' } },
    });
    await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'main', []);
    await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'child', []);
    const records = [
      { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'outside-call', result: { output: 'actual output', isError: false } }, time: 1 },
      { type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: 'actual continuation' }] }, time: 2 },
    ];
    vi.spyOn(sessionWire, 'readSessionWireWindow').mockImplementation(async (_handle, _info, _identity, _options, onRecord) => {
      for (const [index, record] of records.entries()) onRecord(record, index + 1, { byteOffset: 100 + index * 100, continuation: true });
      return {
        startBoundary: split === 'start' ? 'record' : 'turn', endBoundary: split === 'end' ? 'record' : 'watermark',
        watermark: 1000, startByteOffset: 100, endByteOffset: 500, bytesRead: 400,
        recordCount: records.length, partialTail: false, nextCursor: 'older',
      };
    });
    const page = await inspectOfflineSession({ homeDir, reference: SESSION_ID });
    expect(page.selectedAgent.wireComplete).toBe(false);
    expect(page.agents).toHaveLength(2);
    expect(page.warnings.filter((warning) => warning.includes('bounded wire window'))).toHaveLength(1);
    expect(page.timeline.map((entry) => entry.type === 'wire-record' ? entry.record : undefined)).toEqual(records);
    expect(page.timeline.map((entry) => entry.id)).toEqual(['main:wire:100', 'main:wire:200']);
    expect(page.warnings.join('\n')).toMatch(/splits a turn at a record boundary/);
    const text = renderSessionInspection(page);
    expect(text).toContain('actual output');
    expect(text).toContain('actual continuation');
    expect(text).toContain('turn continuation');
    expect(text).not.toContain('USER');
  });

  it('follows the initial snapshot and appended wire events until aborted', async () => {
    await createSessionFixture(homeDir, 'wd_alpha', SESSION_ID);
    const wirePath = await writeWire(
      homeDir,
      'wd_alpha',
      SESSION_ID,
      'main',
      standardWire('first prompt', 'first answer'),
    );
    const controller = new AbortController();
    const followed = followOfflineSession({
      homeDir,
      reference: SESSION_ID,
      signal: controller.signal,
      pollIntervalMs: 10,
    });

    const first = await followed.next();
    expect(first.done).toBe(false);
    expect(first.value?.timeline).toContainEqual(
      expect.objectContaining({ type: 'message', text: 'first answer' }),
    );

    const appended = standardWire('second prompt', 'second answer').map((record) =>
      remapWireTurn(record, 1, '-2'),
    );
    await appendFile(wirePath, `${appended.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

    const second = await followed.next();
    expect(second.done).toBe(false);
    expect(second.value?.timeline).toContainEqual(
      expect.objectContaining({ type: 'message', text: 'second answer' }),
    );

    controller.abort();
    await expect(followed.next()).resolves.toMatchObject({ done: true });
  });
});

describe('kiki session command', () => {
  it('registers a discoverable session show command', () => {
    const program = new Command('kiki');
    registerSessionCommand(program, makeDeps().deps);

    const session = program.commands.find((command) => command.name() === 'session');
    const show = session?.commands.find((command) => command.name() === 'show');
    const list = session?.commands.find((command) => command.name() === 'list');
    expect(session?.description()).toMatch(/without resuming/i);
    expect(show?.description()).toMatch(/timeline/i);
    expect(list?.alias()).toBe('ls');
  });

  it('prints stable JSON and passes --agent and --workspace through', async () => {
    const seen: unknown[] = [];
    const fixture = makeInspection();
    const { deps, stdout, stderr, exitCodes } = makeDeps({
      inspectSession: async (options) => {
        seen.push(options);
        return fixture;
      },
    });
    const program = new Command('kiki');
    registerSessionCommand(program, deps);

    await program.parseAsync([
      'node',
      'kiki',
      'session',
      'show',
      `/s/${SESSION_ID}`,
      '--agent',
      'worker',
      '--workspace',
      'wd_alpha',
      '--json',
    ]);

    expect(stderr).toEqual([]);
    expect(exitCodes).toEqual([]);
    expect(seen).toEqual([{
      homeDir,
      reference: `/s/${SESSION_ID}`,
      agent: 'worker',
      workspace: 'wd_alpha',
    }]);
    expect(JSON.parse(stdout.join(''))).toEqual(fixture);
  });

  it('passes bounded-window controls through the command and refuses a frozen page with follow', async () => {
    const seen: unknown[] = [];
    const { deps, stderr, exitCodes } = makeDeps({ inspectSession: async (options) => {
      seen.push(options);
      return makeInspection();
    } });
    const program = new Command('kiki');
    registerSessionCommand(program, deps);
    await program.parseAsync(['node', 'kiki', 'session', 'show', SESSION_ID, '--before', 'cursor', '--max-bytes', '4096', '--json']);
    expect(seen).toEqual([expect.objectContaining({ before: 'cursor', maxBytes: 4096 })]);
    await expect(handleSessionShow(deps, SESSION_ID, { json: true, before: 'cursor', follow: true })).rejects.toBeInstanceOf(ExitCalled);
    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('--before cannot be combined with --follow');
  });

  it('prints a full observational first render before follow updates', async () => {
    const fixture = makeInspection();
    const updated = {
      ...fixture,
      timeline: [{
        type: 'message' as const,
        id: 'm1',
        turnId: 't0',
        timestamp: null,
        role: 'assistant' as const,
        origin: 'other' as const,
        text: 'new follow event',
      }],
    };
    const { deps, stdout, stderr, exitCodes } = makeDeps({
      followSession: async function* () {
        yield fixture;
        yield updated;
      },
    });

    await handleSessionShow(deps, SESSION_ID, { json: false, follow: true });

    expect(stderr).toEqual([]);
    expect(exitCodes).toEqual([]);
    expect(stdout.join('')).toMatch(/persisted session files only/i);
    expect(stdout.join('')).toContain(`ID: ${SESSION_ID}`);
    expect(stdout.join('')).toContain('Timeline — main (main):');
    expect(stdout.join('')).toContain('new follow event');
  });

  it('emits complete snapshots as NDJSON while following with --json', async () => {
    const first = makeInspection();
    const second = {
      ...first,
      timeline: [{
        type: 'message' as const,
        id: 'm1',
        turnId: 't0',
        timestamp: null,
        role: 'assistant' as const,
        origin: 'other' as const,
        text: 'new event',
      }],
    };
    const { deps, stdout } = makeDeps({
      followSession: async function* () {
        yield first;
        yield second;
      },
    });

    await handleSessionShow(deps, SESSION_ID, { json: true, follow: true });

    const snapshots = stdout.join('').trim().split('\n').map((line) => JSON.parse(line));
    expect(snapshots).toEqual([first, second]);
  });

  it('parses the subcommand --agent instead of the root new-session option', async () => {
    await createSessionFixture(homeDir, 'wd_alpha', SESSION_ID, {
      agents: {
        main: { type: 'main', model: 'test-model' },
        child: { type: 'sub', parentAgentId: 'main', userLabel: 'worker' },
      },
    });
    await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'main', standardWire('main', 'main'));
    await writeWire(homeDir, 'wd_alpha', SESSION_ID, 'child', standardWire('child', 'child'));
    vi.stubEnv('KIKI_HOME', homeDir);
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const program = createProgram('test', () => {
      throw new Error('main handler should not run');
    });

    await program.parseAsync([
      'node',
      'kiki',
      'session',
      'show',
      UUID,
      '--agent',
      'worker',
      '--json',
    ]);

    expect(JSON.parse(stdout.join('')).selectedAgent).toMatchObject({ id: 'child', name: 'worker' });
  });

  it('rejects the root new-session --agent before session show', async () => {
    const { deps, stderr, exitCodes } = makeDeps();
    const program = new Command('kiki').option('--agent <name>');
    registerSessionCommand(program, deps);

    try {
      await program.parseAsync([
        'node',
        'kiki',
        '--agent',
        'root-profile',
        'session',
        'show',
        UUID,
      ]);
    } catch (error) {
      if (!(error instanceof ExitCalled)) throw error;
    }

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toMatch(/place --agent after/i);
  });

  it('emits structured JSON errors on stderr', async () => {
    const { deps, stdout, stderr, exitCodes } = makeDeps({
      inspectSession: async () => {
        throw new SessionInspectionError('not_found', 'not here');
      },
    });

    await runShow(deps, UUID, { json: true });

    expect(stdout).toEqual([]);
    expect(exitCodes).toEqual([1]);
    expect(JSON.parse(stderr.join(''))).toEqual({
      schemaVersion: 1,
      error: { code: 'not_found', message: 'not here', matches: [], suggestions: [] },
    });
  });

  it('removes terminal control sequences from human-readable errors', async () => {
    const { deps, stderr } = makeDeps({
      inspectSession: async () => {
        throw new SessionInspectionError('not_found', '\u001B[31mnot here\u001B[0m');
      },
    });

    await runShow(deps, UUID, { json: false });

    expect(stderr.join('')).toContain('not here');
    expect(stderr.join('')).not.toContain('\u001B');
  });

  it('lists local sessions as stable JSON', async () => {
    const listed = [{
      sessionId: SESSION_ID,
      workspaceId: 'wd_alpha',
      sessionDir: '/home/.kiki/sessions/wd_alpha/example',
      title: 'Example',
      workDir: '/repo/example',
      updatedAt: '2023-11-14T22:15:00.000Z',
      damaged: false,
    }];
    const { deps, stdout } = makeDeps({ listSessions: async () => listed });
    const program = new Command('kiki');
    registerSessionCommand(program, deps);

    await program.parseAsync(['node', 'kiki', 'session', 'list', '--json']);

    expect(JSON.parse(stdout.join(''))).toEqual({ schemaVersion: 1, sessions: listed });
  });

  it('removes terminal control sequences from human output', () => {
    const inspection = makeInspection();
    const output = renderSessionInspection({
      ...inspection,
      session: { ...inspection.session, title: '\u001B[31mDanger\u001B[0m' },
      timeline: [{
        type: 'message',
        id: 'm1',
        turnId: 't0',
        timestamp: null,
        role: 'assistant',
        origin: 'other',
        text: 'ok\u001B]0;owned\u0007',
      }],
    });

    expect(output).toContain('Danger');
    expect(output).not.toContain('\u001B');
    expect(output).not.toContain('\u0007');
  });
});

async function createSessionFixture(
  root: string,
  workspaceId: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const sessionDir = join(root, 'sessions', workspaceId, sessionId);
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
  const agents = overrides['agents'] ?? { main: { type: 'main', model: 'test-model' } };
  await writeFile(join(sessionDir, 'state.json'), JSON.stringify({
    id: sessionId,
    title: 'Test session',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    archived: false,
    cwd: '/repo/test',
    lastTurnReason: 'completed',
    agents,
    ...overrides,
  }), 'utf8');
  for (const agentId of Object.keys(agents as Record<string, unknown>)) {
    await mkdir(join(sessionDir, 'agents', agentId), { recursive: true });
  }
}

async function writeWire(
  root: string,
  workspaceId: string,
  sessionId: string,
  agentId: string,
  records: readonly Record<string, unknown>[],
): Promise<string> {
  const wirePath = join(root, 'sessions', workspaceId, sessionId, 'agents', agentId, 'wire.jsonl');
  await mkdir(join(root, 'sessions', workspaceId, sessionId, 'agents', agentId), { recursive: true });
  await writeFile(wirePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return wirePath;
}

function standardWire(prompt: string, answer: string): Record<string, unknown>[] {
  return [
    {
      type: 'turn.prompt',
      turnId: 0,
      promptId: 'prompt-1',
      input: [{ type: 'text', text: prompt }],
      origin: { kind: 'user' },
      time: 1_000,
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'step.begin', turnId: 0, step: 0, uuid: 'step-1' },
      time: 2_000,
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        turnId: 0,
        stepUuid: 'step-1',
        uuid: 'part-1',
        part: { type: 'text', text: answer },
      },
      time: 3_000,
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'step.end', turnId: 0, step: 0, uuid: 'step-1' },
      time: 4_000,
    },
    { type: 'turn.ended', turnId: 0, reason: 'completed', time: 5_000 },
  ];
}

function remapWireTurn(
  record: Record<string, unknown>,
  turnId: number,
  idSuffix: string,
): Record<string, unknown> {
  const next = structuredClone(record);
  if (typeof next['turnId'] === 'number') next['turnId'] = turnId;
  if (typeof next['promptId'] === 'string') next['promptId'] += idSuffix;
  const event = next['event'];
  if (typeof event === 'object' && event !== null && !Array.isArray(event)) {
    const mutable = event as Record<string, unknown>;
    if (typeof mutable['turnId'] === 'number') mutable['turnId'] = turnId;
    if (typeof mutable['uuid'] === 'string') mutable['uuid'] += idSuffix;
    if (typeof mutable['stepUuid'] === 'string') mutable['stepUuid'] += idSuffix;
  }
  return next;
}

async function snapshotTree(root: string): Promise<Record<string, { size: number; mtimeMs: number; data: string }>> {
  const result: Record<string, { size: number; mtimeMs: number; data: string }> = {};
  const visit = async (dir: string, prefix = ''): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const relative = prefix === '' ? entry.name : join(prefix, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else {
        const info = await stat(absolute);
        result[relative] = {
          size: info.size,
          mtimeMs: info.mtimeMs,
          data: (await readFile(absolute)).toString('base64'),
        };
      }
    }
  };
  await visit(root);
  return result;
}

function makeDeps(overrides: Partial<SessionCommandDeps> = {}): {
  deps: SessionCommandDeps;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const deps: SessionCommandDeps = {
    homeDir: () => homeDir,
    inspectSession: async () => makeInspection(),
    followSession: async function* () {
      yield makeInspection();
    },
    listSessions: async () => [],
    stdout: { write: (chunk) => (stdout.push(chunk), true) },
    stderr: { write: (chunk) => (stderr.push(chunk), true) },
    exit: ((code: number) => {
      exitCodes.push(code);
      throw new ExitCalled(code);
    }) as SessionCommandDeps['exit'],
    ...overrides,
  };
  return { deps, stdout, stderr, exitCodes };
}

async function runShow(
  deps: SessionCommandDeps,
  reference: string,
  options: { json: boolean; agent?: string; workspace?: string },
): Promise<void> {
  try {
    await handleSessionShow(deps, reference, options);
  } catch (error) {
    if (!(error instanceof ExitCalled)) throw error;
  }
}

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

function makeInspection() {
  return {
    schemaVersion: 1 as const,
    session: {
      id: SESSION_ID,
      title: 'Test',
      workDir: '/repo/test',
      sessionDir: '/home/.kiki/sessions/wd_alpha/test',
      workspaceId: 'wd_alpha',
      createdAt: '2023-11-14T22:13:20.000Z',
      updatedAt: '2023-11-14T22:15:00.000Z',
      archived: false,
      model: 'test-model',
      status: 'completed' as const,
      statusBasis: 'metadata' as const,
      lastTurnReason: 'completed' as const,
      agentCount: 1,
    },
    selectedAgent: {
      id: 'main',
      name: 'main',
      status: 'completed' as const,
      lastActivityAt: '2023-11-14T22:15:00.000Z',
      wireComplete: true,
    },
    agents: [{
      id: 'main',
      name: 'main',
      label: null,
      type: 'main' as const,
      parentId: null,
      model: 'test-model',
      status: 'completed' as const,
      lastActivityAt: '2023-11-14T22:15:00.000Z',
      wireComplete: true,
    }],
    timeline: [],
    warnings: [],
  };
}
