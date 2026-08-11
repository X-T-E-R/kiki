import { describe, expect, it } from 'vitest';

import type { Terminal } from '@moonshot-ai/protocol';

import type { TerminalSignal } from '../lib/ws';
import {
  shellDisplayName,
  TerminalManager,
  type TerminalRestClient,
  type TerminalTransport,
} from './terminalManager';

function fakeTerminal(overrides: Partial<Terminal> = {}): Terminal {
  const id = overrides.id ?? `term_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    session_id: 'sess_1',
    cwd: 'C:/fixture/workshop',
    shell: '/bin/sh',
    cols: 80,
    rows: 24,
    status: 'running',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

class FakeTransport implements TerminalTransport {
  readonly attached: string[] = [];
  readonly detached: string[] = [];
  readonly inputs: Array<{ id: string; data: string }> = [];
  readonly resizes: Array<{ id: string; cols: number; rows: number }> = [];
  attachError: Error | undefined;
  autoAck = true;
  private listener: ((signal: TerminalSignal) => void) | undefined;
  private pending = new Map<string, (result: { replayed: number }) => void>();

  terminalAttach(sessionId: string, terminalId: string): Promise<{ replayed: number }> {
    this.attached.push(terminalId);
    if (this.attachError !== undefined) return Promise.reject(this.attachError);
    if (!this.autoAck) {
      return new Promise((resolve) => {
        this.pending.set(terminalId, resolve);
      });
    }
    queueMicrotask(() => {
      this.listener?.({ kind: 'attached', sessionId, terminalId, replayed: 0 });
    });
    return Promise.resolve({ replayed: 0 });
  }

  terminalDetach(_sessionId: string, terminalId: string): void {
    this.detached.push(terminalId);
  }

  terminalInput(_sessionId: string, terminalId: string, data: string): void {
    this.inputs.push({ id: terminalId, data });
  }

  terminalResize(_sessionId: string, terminalId: string, cols: number, rows: number): void {
    this.resizes.push({ id: terminalId, cols, rows });
  }

  onTerminalSignal(listener: (signal: TerminalSignal) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(signal: TerminalSignal): void {
    this.listener?.(signal);
  }

  flushAttach(terminalId: string): void {
    this.pending.get(terminalId)?.({ replayed: 0 });
    this.pending.delete(terminalId);
    this.emit({ kind: 'attached', sessionId: 'sess_1', terminalId, replayed: 0 });
  }
}

class FakeRest implements TerminalRestClient {
  terminals: Terminal[] = [];
  readonly created: Array<Record<string, unknown>> = [];
  readonly closed: string[] = [];
  listError: Error | undefined;
  createError: Error | undefined;
  nextCreated: Terminal | undefined;

  listTerminals(): Promise<{ items: Terminal[] }> {
    if (this.listError !== undefined) return Promise.reject(this.listError);
    return Promise.resolve({ items: [...this.terminals] });
  }

  createTerminal(
    sessionId: string,
    body: Record<string, unknown> = {},
  ): Promise<Terminal> {
    if (this.createError !== undefined) return Promise.reject(this.createError);
    this.created.push(body);
    const terminal =
      this.nextCreated ?? fakeTerminal({ id: `term_new_${this.created.length}`, session_id: sessionId });
    this.nextCreated = undefined;
    this.terminals.push(terminal);
    return Promise.resolve(terminal);
  }

  closeTerminal(_sessionId: string, terminalId: string): Promise<unknown> {
    this.closed.push(terminalId);
    return Promise.resolve({ closed: true });
  }
}

function makeManager(rest: FakeRest, transport: FakeTransport): TerminalManager {
  return new TerminalManager({ sessionId: 'sess_1', client: rest, transport });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('shellDisplayName', () => {
  it('takes the basename across path separators', () => {
    expect(shellDisplayName('/bin/sh')).toBe('sh');
    expect(shellDisplayName('C:\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
    expect(shellDisplayName('pwsh')).toBe('pwsh');
  });
});

describe('TerminalManager.open', () => {
  it('lists server terminals and attaches the running ones', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    const running = fakeTerminal({ id: 'term_run' });
    const dead = fakeTerminal({ id: 'term_dead', status: 'exited', exit_code: 1 });
    rest.terminals = [running, dead];
    const manager = makeManager(rest, transport);

    await manager.open();
    const state = manager.getState();
    expect(state.loaded).toBe(true);
    expect(state.tabs.map((tab) => tab.id)).toEqual(['term_run', 'term_dead']);
    expect(transport.attached).toEqual(['term_run']);
    await tick();
    expect(manager.getState().tabs[0]?.status).toBe('live');
    expect(manager.getState().tabs[1]?.status).toBe('exited');
    expect(manager.getState().tabs[1]?.exitCode).toBe(1);
  });

  it('surfaces a list failure as a panel error and allows retry', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    rest.listError = new Error('connection refused');
    const manager = makeManager(rest, transport);

    await manager.open();
    expect(manager.getState().error).toBe('connection refused');
    expect(manager.getState().errorKey).toBe('term.loadFailed');
    expect(manager.getState().loaded).toBe(true);

    rest.listError = undefined;
    rest.terminals = [fakeTerminal({ id: 'term_ok' })];
    await manager.open();
    expect(manager.getState().error).toBeUndefined();
    expect(manager.getState().tabs).toHaveLength(1);
  });

  it('reports a create failure with the create copy', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    rest.createError = new Error('Failed to load native module: conpty.node');
    const manager = makeManager(rest, transport);
    await manager.open();

    await manager.create();
    expect(manager.getState().error).toContain('conpty');
    expect(manager.getState().errorKey).toBe('term.createFailed');
    expect(manager.getState().tabs).toHaveLength(0);
  });
});

describe('TerminalManager.create / kill', () => {
  it('creates a terminal, activates its tab, and attaches', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    const manager = makeManager(rest, transport);
    await manager.open();

    await manager.create();
    const state = manager.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeId).toBe('term_new_1');
    expect(transport.attached).toEqual(['term_new_1']);
    await tick();
    expect(manager.getState().tabs[0]?.status).toBe('live');
  });

  it('kill detaches, closes over REST, and removes the tab', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    rest.terminals = [fakeTerminal({ id: 'term_a' })];
    const manager = makeManager(rest, transport);
    await manager.open();

    await manager.kill('term_a');
    expect(manager.getState().tabs).toHaveLength(0);
    expect(transport.detached).toEqual(['term_a']);
    expect(rest.closed).toEqual(['term_a']);
  });

  it('activates the first remaining tab when the active one is killed', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    rest.terminals = [fakeTerminal({ id: 'term_a' }), fakeTerminal({ id: 'term_b' })];
    const manager = makeManager(rest, transport);
    await manager.open();
    manager.activate('term_b');
    await manager.kill('term_b');
    expect(manager.getState().activeId).toBe('term_a');
  });
});

describe('TerminalManager input/output', () => {
  it('routes output to the bound listener and exit flips the tab dead', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    rest.terminals = [fakeTerminal({ id: 'term_a' })];
    const manager = makeManager(rest, transport);
    await manager.open();
    await tick();

    const chunks: string[] = [];
    manager.bindOutput('term_a', (data) => chunks.push(data));
    transport.emit({ kind: 'output', sessionId: 'sess_1', terminalId: 'term_a', seq: 1, data: '$ ' });
    transport.emit({ kind: 'output', sessionId: 'sess_1', terminalId: 'term_a', seq: 2, data: 'hi\r\n' });
    expect(chunks.join('')).toBe('$ hi\r\n');

    transport.emit({ kind: 'exit', sessionId: 'sess_1', terminalId: 'term_a', exitCode: 0 });
    expect(manager.getState().tabs[0]?.status).toBe('exited');
    expect(manager.getState().tabs[0]?.exitCode).toBe(0);
  });

  it('buffers output until a renderer binds (replay racing the mount)', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    rest.terminals = [fakeTerminal({ id: 'term_a' })];
    const manager = makeManager(rest, transport);
    await manager.open();

    transport.emit({ kind: 'output', sessionId: 'sess_1', terminalId: 'term_a', seq: 1, data: 'early' });
    const chunks: string[] = [];
    manager.bindOutput('term_a', (data) => chunks.push(data));
    expect(chunks.join('')).toBe('early');
  });

  it('buffers keystrokes while attaching and flushes them on attached', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    transport.autoAck = false;
    rest.terminals = [fakeTerminal({ id: 'term_a' })];
    const manager = makeManager(rest, transport);
    await manager.open();

    manager.input('term_a', 'echo hi\r');
    expect(transport.inputs).toHaveLength(0);
    transport.flushAttach('term_a');
    await tick();
    expect(transport.inputs).toEqual([{ id: 'term_a', data: 'echo hi\r' }]);
  });

  it('ignores signals for other sessions and unknown terminals', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    rest.terminals = [fakeTerminal({ id: 'term_a' })];
    const manager = makeManager(rest, transport);
    await manager.open();
    await tick();

    transport.emit({ kind: 'exit', sessionId: 'sess_other', terminalId: 'term_a', exitCode: 9 });
    transport.emit({ kind: 'exit', sessionId: 'sess_1', terminalId: 'term_unknown', exitCode: 9 });
    expect(manager.getState().tabs[0]?.status).toBe('live');
  });
});

describe('TerminalManager resize', () => {
  it('sends resize when live and the size changed', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    rest.terminals = [fakeTerminal({ id: 'term_a' })];
    const manager = makeManager(rest, transport);
    await manager.open();
    await tick();

    manager.resize('term_a', 120, 40);
    expect(transport.resizes).toEqual([{ id: 'term_a', cols: 120, rows: 40 }]);
    manager.resize('term_a', 120, 40); // unchanged — no duplicate frame
    expect(transport.resizes).toHaveLength(1);
  });

  it('defers the fitted size until the attach completes', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    transport.autoAck = false;
    rest.terminals = [fakeTerminal({ id: 'term_a', cols: 80, rows: 24 })];
    const manager = makeManager(rest, transport);
    await manager.open();

    manager.resize('term_a', 132, 43);
    expect(transport.resizes).toHaveLength(0);
    transport.flushAttach('term_a');
    await tick();
    expect(transport.resizes).toEqual([{ id: 'term_a', cols: 132, rows: 43 }]);
  });
});

describe('TerminalManager restart / unavailable', () => {
  it('restart swaps a dead tab for a fresh PTY keeping its display index', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    rest.terminals = [
      fakeTerminal({ id: 'term_a', status: 'exited', exit_code: 0, shell: '/bin/sh', cwd: 'sub/dir' }),
    ];
    const manager = makeManager(rest, transport);
    await manager.open();
    expect(manager.getState().tabs[0]?.status).toBe('exited');

    rest.nextCreated = fakeTerminal({ id: 'term_b' });
    await manager.restart('term_a');
    const tabs = manager.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.id).toBe('term_b');
    expect(tabs[0]?.index).toBe(1);
    expect(rest.created[0]).toEqual({ shell: '/bin/sh', cwd: 'sub/dir' });
    expect(transport.detached).toEqual(['term_a']);
    expect(transport.attached).toContain('term_b');
  });

  it('omits an absolute cwd on restart (the server rejects it)', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    rest.terminals = [
      fakeTerminal({ id: 'term_a', status: 'exited', cwd: 'C:/fixture/workshop' }),
    ];
    const manager = makeManager(rest, transport);
    await manager.open();
    await manager.restart('term_a');
    expect(rest.created[0]).toEqual({ shell: '/bin/sh', cwd: undefined });
  });

  it('marks the tab unavailable when the attach rejects', async () => {
    const rest = new FakeRest();
    const transport = new FakeTransport();
    transport.attachError = new Error('terminal attach timed out');
    rest.terminals = [fakeTerminal({ id: 'term_a' })];
    const manager = makeManager(rest, transport);
    await manager.open();
    await tick();
    expect(manager.getState().tabs[0]?.status).toBe('unavailable');
  });
});
