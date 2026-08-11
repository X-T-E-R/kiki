import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ErrorCodes } from '#/errors';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  type TerminalAttachSink,
  type TerminalFrame,
  type TerminalProcess,
  type TerminalSpawnOptions,
  IHostTerminalService,
} from '#/os/interface/terminal';
import { HostTerminalService } from '#/os/backends/node-local/hostTerminalService';
import {
  ISessionTerminalService,
  resolveDefaultShell,
  SessionTerminalService,
} from '#/session/terminal/terminalService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

class FakeTerminalProcess implements TerminalProcess {
  private readonly dataEmitter = new Emitter<string>();
  private readonly exitEmitter = new Emitter<{ exitCode: number | null }>();
  readonly onProcessData = this.dataEmitter.event;
  readonly onProcessExit = this.exitEmitter.event;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;

  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
  }
  emitData(data: string): void {
    this.dataEmitter.fire(data);
  }
  emitExit(exitCode: number | null): void {
    this.exitEmitter.fire({ exitCode });
  }
  dispose(): void {
    this.dataEmitter.dispose();
    this.exitEmitter.dispose();
  }
}

class FakeHostTerminalService implements IHostTerminalService {
  declare readonly _serviceBrand: undefined;
  readonly processes: FakeTerminalProcess[] = [];
  readonly lastOptions: TerminalSpawnOptions[] = [];

  spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    this.lastOptions.push(options);
    const proc = new FakeTerminalProcess();
    this.processes.push(proc);
    return Promise.resolve(proc);
  }
}

function stubWorkspace(workDir = '/ws'): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir,
    additionalDirs: [],
    resolve: (rel) => resolve(workDir, rel),
    isWithin: () => true,
    assertAllowed: (absPath) => resolve(workDir, absPath),
  };
}

function stubSessionContext(sessionId = 's1'): ISessionContext {
  return makeSessionContext({
    sessionId,
    workspaceId: 'w1',
    sessionDir: '/ws/.session',
    sessionScope: `session:${sessionId}`,
    metaScope: `session:${sessionId}`,
    cwd: '/ws',
  });
}

function collectSink(id = 'sink-1'): { sink: TerminalAttachSink; frames: TerminalFrame[] } {
  const frames: TerminalFrame[] = [];
  return { sink: { id, send: (frame) => frames.push(frame) }, frames };
}

describe('SessionTerminalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let host: FakeHostTerminalService;

  beforeEach(() => {
    disposables = new DisposableStore();
    host = new FakeHostTerminalService();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IHostTerminalService, host);
        reg.define(ISessionTerminalService, SessionTerminalService);
        reg.defineInstance(ISessionWorkspaceContext, stubWorkspace());
        reg.defineInstance(ISessionContext, stubSessionContext());
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('creates a terminal and resolves cwd through the workspace', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ cwd: 'sub', cols: 100, rows: 40 });

    expect(terminal.status).toBe('running');
    expect(terminal.session_id).toBe('s1');
    expect(terminal.cwd).toBe(resolve('/ws', 'sub'));
    expect(terminal.cols).toBe(100);
    expect(terminal.rows).toBe(40);
    expect(host.processes).toHaveLength(1);
    expect(host.lastOptions[0]?.cwd).toBe(resolve('/ws', 'sub'));
  });

  it('uses the workspace workDir when cwd is omitted', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    expect(terminal.cwd).toBe('/ws');
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(24);
  });

  it('preserves an explicit shell override', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ shell: 'example-shell' });
    expect(terminal.shell).toBe('example-shell');
    expect(host.lastOptions[0]?.shell).toBe('example-shell');
  });

  it('lists and gets terminals', async () => {
    const svc = ix.get(ISessionTerminalService);
    const created = await svc.create({});
    const listed = await svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const fetched = await svc.get(created.id);
    expect(fetched.id).toBe(created.id);
  });

  it('throws TERMINAL_NOT_FOUND for an unknown terminal', async () => {
    const svc = ix.get(ISessionTerminalService);
    await expect(svc.get('nope')).rejects.toMatchObject({
      code: ErrorCodes.TERMINAL_NOT_FOUND,
    });
  });

  it('attaches a sink, replays buffered frames, then streams live output', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;

    proc.emitData('hello');
    const { sink, frames } = collectSink();
    const { replayed } = await svc.attach(terminal.id, sink);
    expect(replayed).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'terminal_output',
      seq: 1,
      session_id: 's1',
      terminal_id: terminal.id,
      payload: { data: 'hello' },
    });

    proc.emitData('world');
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ type: 'terminal_output', seq: 2, payload: { data: 'world' } });
  });

  it('replays only frames after sinceSeq', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;
    proc.emitData('a');
    proc.emitData('b');
    proc.emitData('c');

    const { sink, frames } = collectSink();
    const result = await svc.attach(terminal.id, sink, { sinceSeq: 1 });
    expect(result).toEqual({ replayed: 2, earliestSeq: 1, truncated: false });
    expect(frames.map((f) => (f as { seq?: number }).seq)).toEqual([2, 3]);
  });

  it('reports a truncated replay when the requested cursor predates the 2,000-frame suffix', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;
    for (let seq = 1; seq <= 2001; seq += 1) proc.emitData(`frame-${seq}`);

    const first = collectSink('first');
    const truncated = await svc.attach(terminal.id, first.sink, { sinceSeq: 0 });
    expect(truncated).toEqual({ replayed: 2000, earliestSeq: 2, truncated: true });
    expect(first.frames[0]).toMatchObject({ type: 'terminal_output', seq: 2 });
    expect(first.frames.at(-1)).toMatchObject({ type: 'terminal_output', seq: 2001 });

    svc.detach(terminal.id, first.sink.id);
    const second = collectSink('second');
    const complete = await svc.attach(terminal.id, second.sink, { sinceSeq: 1 });
    expect(complete).toEqual({ replayed: 2000, earliestSeq: 2, truncated: false });
  });

  it('emits an exit frame and marks the terminal exited on process exit', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;
    const { sink, frames } = collectSink();
    await svc.attach(terminal.id, sink);

    proc.emitExit(7);

    const exitFrame = frames.find((f) => f.type === 'terminal_exit');
    expect(exitFrame).toMatchObject({
      type: 'terminal_exit',
      terminal_id: terminal.id,
      payload: { exit_code: 7 },
    });
    const fetched = await svc.get(terminal.id);
    expect(fetched.status).toBe('exited');
    expect(fetched.exit_code).toBe(7);
  });

  it('delegates write and resize to the process', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;

    await svc.write(terminal.id, 'ls\n');
    await svc.resize(terminal.id, 120, 50);

    expect(proc.writes).toEqual(['ls\n']);
    expect(proc.resizes).toEqual([[120, 50]]);
    expect((await svc.get(terminal.id)).cols).toBe(120);
  });

  it('closes a terminal by killing the process and marking it exited', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;

    const result = await svc.close(terminal.id);
    expect(result).toEqual({ closed: true });
    expect(proc.killed).toBe(true);
    expect((await svc.get(terminal.id)).status).toBe('exited');
  });

  it('detaches a sink so it stops receiving frames', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;
    const { sink, frames } = collectSink();
    await svc.attach(terminal.id, sink);

    svc.detach(terminal.id, sink.id);
    proc.emitData('after-detach');
    expect(frames).toHaveLength(0);
  });

  it('kills every live process when the service is disposed', async () => {
    const svc = ix.get(ISessionTerminalService);
    await svc.create({});
    const proc = host.processes[0]!;

    disposables.dispose();
    expect(proc.killed).toBe(true);
  });
});

describe('resolveDefaultShell', () => {
  it('keeps the POSIX SHELL preference and /bin/sh fallback', () => {
    expect(resolveDefaultShell('linux', { SHELL: '/bin/zsh' }, () => false)).toBe('/bin/zsh');
    expect(resolveDefaultShell('linux', {}, () => false)).toBe('/bin/sh');
  });

  it('uses an existing ComSpec on Windows and falls back to an existing PowerShell', () => {
    const existing = new Set([
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
    const isExecutable = (candidate: string): boolean => existing.has(candidate);

    expect(
      resolveDefaultShell(
        'win32',
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe', SystemRoot: 'C:\\Windows' },
        isExecutable,
      ),
    ).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(
      resolveDefaultShell(
        'win32',
        { ComSpec: 'C:\\missing\\cmd.exe', SystemRoot: 'C:\\Windows' },
        isExecutable,
      ),
    ).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('fails instead of selecting a nonexistent Windows executable', () => {
    expect(() => resolveDefaultShell('win32', {}, () => false)).toThrow(
      /No usable Windows shell executable/,
    );
  });
});

describe('HostTerminalService (App scope)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostTerminalService, HostTerminalService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('spawns a PTY through node-pty and forwards events', async () => {
    const { spawn } = await import('node-pty');
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: { exitCode: number }) => void>();
    const mockPty = {
      onData: (listener: (data: string) => void) => {
        dataListeners.add(listener);
        return toDisposable(() => dataListeners.delete(listener));
      },
      onExit: (listener: (event: { exitCode: number }) => void) => {
        exitListeners.add(listener);
        return toDisposable(() => exitListeners.delete(listener));
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    vi.mocked(spawn).mockReturnValue(mockPty as unknown as import('node-pty').IPty);

    const svc = ix.get(IHostTerminalService);
    const proc = await svc.spawn({ cwd: '/ws', shell: '/bin/sh', cols: 80, rows: 24 });

    expect(spawn).toHaveBeenCalledWith('/bin/sh', [], {
      name: 'xterm-256color',
      cwd: '/ws',
      cols: 80,
      rows: 24,
      env: process.env,
    });

    let receivedData = '';
    proc.onProcessData((data) => {
      receivedData += data;
    });
    for (const listener of dataListeners) listener('hello');
    expect(receivedData).toBe('hello');

    let receivedExit: { exitCode: number | null } | undefined;
    proc.onProcessExit((event) => {
      receivedExit = event;
    });
    for (const listener of exitListeners) listener({ exitCode: 5 });
    expect(receivedExit).toEqual({ exitCode: 5 });

    proc.write('ls\n');
    expect(mockPty.write).toHaveBeenCalledWith('ls\n');

    proc.resize(120, 50);
    expect(mockPty.resize).toHaveBeenCalledWith(120, 50);

    proc.kill();
    expect(mockPty.kill).toHaveBeenCalled();
  });
});
