/**
 * `terminal` domain — Session-scoped terminal facade.
 *
 * Owns this session's terminal set and its per-terminal output buffers and
 * attached sinks; spawns PTYs through the App-scoped `IHostTerminalService`,
 * resolves the working directory through `workspaceContext`, and reads the
 * session id through `sessionContext` to tag frames. Bound at Session scope.
 */

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { win32 } from 'node:path';

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type {
  CreateTerminalRequest,
  Terminal,
  TerminalAttachOptions,
  TerminalAttachSink,
  TerminalExitMessage,
  TerminalFrame,
  TerminalOutputMessage,
  TerminalProcess,
} from '#/os/interface/terminal';
import { IHostTerminalService } from '#/os/interface/terminal';
import { ErrorCodes, Error2 } from '#/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_MAX_BUFFERED_FRAMES = 2000;

interface TerminalRecord {
  terminal: Terminal;
  process: TerminalProcess;
  sinks: Map<string, TerminalAttachSink>;
  buffer: TerminalFrame[];
  nextSeq: number;
  disposables: IDisposable[];
  closed: boolean;
}

export interface ISessionTerminalService {
  readonly _serviceBrand: undefined;

  create(input: CreateTerminalRequest): Promise<Terminal>;
  list(): Promise<readonly Terminal[]>;
  get(terminalId: string): Promise<Terminal>;
  attach(
    terminalId: string,
    sink: TerminalAttachSink,
    options?: TerminalAttachOptions,
  ): Promise<TerminalAttachResult>;
  detach(terminalId: string, sinkId: string): void;
  detachAllForSink(sinkId: string): void;
  write(terminalId: string, data: string): Promise<void>;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  close(terminalId: string): Promise<{ closed: true }>;
}

export interface TerminalAttachResult {
  readonly replayed: number;
  /** First retained output sequence, or null when no output has been retained. */
  readonly earliestSeq: number | null;
  /** True when `sinceSeq` predates the retained contiguous suffix. */
  readonly truncated: boolean;
}

export const ISessionTerminalService: ServiceIdentifier<ISessionTerminalService> =
  createDecorator<ISessionTerminalService>('sessionTerminalService');

// NOTE: stays Disposable — its own 'get' collides with the Fiber
export class SessionTerminalService extends Disposable implements ISessionTerminalService {
  declare readonly _serviceBrand: undefined;

  private readonly records = new Map<string, TerminalRecord>();

  constructor(
    @IHostTerminalService private readonly terminalService: IHostTerminalService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ISessionContext private readonly sessionContext: ISessionContext,
  ) {
    super();
  }

  async create(input: CreateTerminalRequest): Promise<Terminal> {
    const cwd =
      input.cwd === undefined
        ? this.workspace.workDir
        : this.workspace.assertAllowed(input.cwd, 'execute');
    const shell = input.shell ?? resolveDefaultShell();
    const cols = input.cols ?? DEFAULT_COLS;
    const rows = input.rows ?? DEFAULT_ROWS;
    const process = await this.terminalService.spawn({ cwd, shell, cols, rows });
    const terminal: Terminal = {
      id: `term_${randomUUID()}`,
      session_id: this.sessionContext.sessionId,
      cwd,
      shell,
      cols,
      rows,
      status: 'running',
      created_at: new Date().toISOString(),
    };
    const record: TerminalRecord = {
      terminal,
      process,
      sinks: new Map(),
      buffer: [],
      nextSeq: 0,
      disposables: [],
      closed: false,
    };
    record.disposables.push(
      process.onProcessData((data) => this.onData(record, data)),
      process.onProcessExit((event) => this.onExit(record, event.exitCode)),
    );
    this.records.set(terminal.id, record);
    return { ...terminal };
  }

  list(): Promise<readonly Terminal[]> {
    return Promise.resolve(
      [...this.records.values()].map((record) => ({ ...record.terminal })),
    );
  }

  async get(terminalId: string): Promise<Terminal> {
    return { ...this.requireRecord(terminalId).terminal };
  }

  async attach(
    terminalId: string,
    sink: TerminalAttachSink,
    options: TerminalAttachOptions = {},
  ): Promise<TerminalAttachResult> {
    const record = this.requireRecord(terminalId);
    record.sinks.set(sink.id, sink);
    const sinceSeq = options.sinceSeq ?? 0;
    const earliestSeq = earliestOutputSeq(record.buffer);
    const replay = record.buffer.filter((frame) => frameSeq(frame) > sinceSeq);
    for (const frame of replay) {
      sink.send(frame);
    }
    return {
      replayed: replay.length,
      earliestSeq,
      truncated: earliestSeq !== null && sinceSeq + 1 < earliestSeq,
    };
  }

  detach(terminalId: string, sinkId: string): void {
    this.records.get(terminalId)?.sinks.delete(sinkId);
  }

  detachAllForSink(sinkId: string): void {
    for (const record of this.records.values()) {
      record.sinks.delete(sinkId);
    }
  }

  async write(terminalId: string, data: string): Promise<void> {
    const record = this.requireRecord(terminalId);
    record.process.write(data);
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const record = this.requireRecord(terminalId);
    record.terminal = { ...record.terminal, cols, rows };
    record.process.resize(cols, rows);
  }

  async close(terminalId: string): Promise<{ closed: true }> {
    const record = this.requireRecord(terminalId);
    if (!record.closed) {
      record.closed = true;
      record.process.kill();
      this.markExited(record, null);
    }
    return { closed: true };
  }

  override dispose(): void {
    for (const record of this.records.values()) {
      disposeAll(record.disposables);
      try {
        record.process.kill();
      } catch {
      }
    }
    this.records.clear();
    super.dispose();
  }

  private requireRecord(terminalId: string): TerminalRecord {
    const record = this.records.get(terminalId);
    if (record === undefined) {
      throw new Error2(
        ErrorCodes.TERMINAL_NOT_FOUND,
        `terminal ${terminalId} does not exist in session ${this.sessionContext.sessionId}`,
      );
    }
    return record;
  }

  private onData(record: TerminalRecord, data: string): void {
    const frame: TerminalOutputMessage = {
      type: 'terminal_output',
      seq: ++record.nextSeq,
      session_id: record.terminal.session_id,
      terminal_id: record.terminal.id,
      timestamp: new Date().toISOString(),
      payload: { data },
    };
    this.pushFrame(record, frame);
  }

  private onExit(record: TerminalRecord, exitCode: number | null): void {
    this.markExited(record, exitCode);
  }

  private markExited(record: TerminalRecord, exitCode: number | null): void {
    if (record.terminal.status === 'exited') return;
    record.closed = true;
    record.terminal = {
      ...record.terminal,
      status: 'exited',
      exited_at: new Date().toISOString(),
      exit_code: exitCode,
    };
    const frame: TerminalExitMessage = {
      type: 'terminal_exit',
      session_id: record.terminal.session_id,
      terminal_id: record.terminal.id,
      timestamp: new Date().toISOString(),
      payload: { exit_code: exitCode },
    };
    this.pushFrame(record, frame);
    disposeAll(record.disposables);
    record.disposables = [];
  }

  private pushFrame(record: TerminalRecord, frame: TerminalFrame): void {
    record.buffer.push(frame);
    if (record.buffer.length > DEFAULT_MAX_BUFFERED_FRAMES) {
      record.buffer.splice(0, record.buffer.length - DEFAULT_MAX_BUFFERED_FRAMES);
    }
    for (const sink of record.sinks.values()) {
      sink.send(frame);
    }
  }
}

function disposeAll(items: Iterable<IDisposable>): void {
  for (const item of items) {
    item.dispose();
  }
}

function frameSeq(frame: TerminalFrame): number {
  return frame.type === 'terminal_output' ? frame.seq : Number.MAX_SAFE_INTEGER;
}

function earliestOutputSeq(frames: readonly TerminalFrame[]): number | null {
  for (const frame of frames) {
    if (frame.type === 'terminal_output') return frame.seq;
  }
  return null;
}

export function resolveDefaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  isExecutableFile: (path: string) => boolean = isFile,
): string {
  if (platform !== 'win32') {
    const shell = env['SHELL']?.trim();
    return shell === undefined || shell.length === 0 ? '/bin/sh' : shell;
  }

  const windowsDir = env['SystemRoot'] ?? env['WINDIR'];
  const pathDirs = (env['Path'] ?? env['PATH'] ?? '')
    .split(win32.delimiter)
    .map((entry) => entry.trim().replaceAll(/^"|"$/g, ''))
    .filter((entry) => entry.length > 0);
  const candidates = [
    env['ComSpec'],
    windowsDir === undefined
      ? undefined
      : win32.join(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ...pathDirs.map((entry) => win32.join(entry, 'pwsh.exe')),
    ...pathDirs.map((entry) => win32.join(entry, 'powershell.exe')),
    windowsDir === undefined ? undefined : win32.join(windowsDir, 'System32', 'cmd.exe'),
    ...pathDirs.map((entry) => win32.join(entry, 'cmd.exe')),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.length > 0 && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  throw new Error('No usable Windows shell executable was found');
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTerminalService,
  SessionTerminalService,
  ScopeActivation.OnScopeCreated,
  'terminal',
);
