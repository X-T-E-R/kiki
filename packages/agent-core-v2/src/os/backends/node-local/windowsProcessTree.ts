import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { Writable, type Readable } from 'node:stream';

import { BufferedReadable } from '#/_base/execEnv/bufferedReadable';
import { HostProcessError, HostProcessErrorCode, type IHostProcess } from '#/os/interface/hostProcess';

const CONTROL_TIMEOUT_MS = 5_000;
const RELEASE_EXIT_CAPABILITY = 'release-exit-v1';
const RELEASE_CONFIRMED_EXIT = 5;

function quoteArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

async function connectControl(name: string, child: ChildProcess): Promise<Socket> {
  const deadline = Date.now() + CONTROL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Windows process helper exited before connecting (code ${String(child.exitCode)}).`);
    }
    const socket = connect({ path: `\\\\.\\pipe\\${name}`, allowHalfOpen: true });
    const result = await new Promise<Socket | NodeJS.ErrnoException>((done) => {
      socket.once('connect', () => done(socket));
      socket.once('error', done);
    });
    if (result === socket) return socket;
    socket.destroy();
    const error = result as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') throw error;
    await new Promise<void>((done) => { setTimeout(done, 20); });
  }
  throw new Error('Windows process helper connection timed out. Check that .NET Framework 4 is enabled.');
}

class WindowsProcessTree implements IHostProcess {
  declare readonly _serviceBrand: undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  private readonly ready = deferred<number>();
  private readonly exited = deferred<number>();
  private readonly helperExited = deferred<void>();
  private response: ReturnType<typeof deferred<string>> | undefined;
  private killPromise: Promise<void> | undefined;
  private cleanupFailure: unknown;
  private disposePromise: Promise<void> | undefined;
  private ownerShutdownPromise: Promise<void> | undefined;
  private releaseListener: (() => void) | undefined;
  private buffer = '';
  private disposed = false;
  private code: number | null = null;
  private rootPid = -1;
  private controlClosed = false;
  private helperGone = false;
  private releaseAttempted = false;
  private releaseExitCapable = false;
  private releaseConfirmed = false;
  private releaseWriteError: Error | undefined;
  private pendingCommand: 'kill' | 'release' | 'retain' | undefined;

  constructor(private readonly child: ChildProcess, private readonly control: Socket, input: Socket, output: Socket, error: Socket, mergeStderr: boolean, private readonly ownerLifetime: boolean) {
    this.stdin = new Writable({
      write(chunk: Buffer, _encoding, done) { input.write(chunk, done); },
      final(done) { input.end(() => { input.destroy(); done(); }); },
      destroy(cause, done) { input.destroy(); done(cause); },
    });
    input.on('error', (cause) => { this.stdin.destroy(cause); });
    this.stdout = new BufferedReadable(output);
    this.stderr = mergeStderr ? this.stdout : new BufferedReadable(error);
    if (mergeStderr) error.destroy();
    control.setEncoding('utf8');
    control.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        this.receive(line);
      }
    });
    control.on('error', (error) => {
      this.markControlClosed();
      this.fail(error, false);
      if (this.releaseConfirmed || this.awaitingReleaseProof()) return;
      this.settlePendingControlLoss(error);
    });
    control.on('close', () => {
      this.markControlClosed();
      if (this.disposed || this.releaseConfirmed || this.awaitingReleaseProof()) return;
      const error = new Error('Windows process helper control channel closed.');
      this.fail(error, false);
      this.settlePendingControlLoss(error);
    });
    child.on('error', (error) => { this.fail(error); });
    child.on('exit', (code, signal) => {
      this.helperGone = true;
      this.helperExited.resolve();
      if (code === RELEASE_CONFIRMED_EXIT && this.releaseExitCapable && signal == null) this.releaseConfirmed = true;
      if (this.disposed) return;
      if (this.releaseConfirmed && this.pendingCommand === 'release' && this.response !== undefined) {
        this.response.resolve('released');
        return;
      }
      const recovered = this.pendingCommand === undefined ? undefined : this.responseAfterControlLoss(this.pendingCommand);
      if (recovered !== undefined) this.response?.resolve(recovered);
      const pendingError = this.pendingCommand === 'release' ? this.releaseWriteError : undefined;
      this.fail(pendingError ?? new Error(`Windows process helper exited unexpectedly (code ${String(code)}, signal ${String(signal)}).`), recovered === undefined && pendingError === undefined);
      if (pendingError !== undefined && recovered === undefined) this.response?.reject(this.closedControlError(pendingError));
    });
  }

  get pid(): number { return this.rootPid; }
  get exitCode(): number | null { return this.code; }

  async initialize(): Promise<void> {
    this.rootPid = await this.withDeadline(this.ready.promise, 'launch');
  }

  wait(): Promise<number> { return this.exited.promise; }

  kill(): Promise<void> {
    if (this.killPromise !== undefined) return this.killPromise;
    this.cleanupFailure = undefined;
    this.killPromise = this.terminate();
    void this.killPromise.catch((error: unknown) => { this.cleanupFailure = error; this.killPromise = undefined; });
    return this.killPromise;
  }

  private async terminate(): Promise<void> {
    if (this.disposed) throw this.killError('control', 'Windows process ownership has already been released.');
    const response = await this.request('kill');
    if (response === 'active:0') return;
    if (response.startsWith('active:')) {
      throw this.killError('verify', 'Windows process tree still has active processes.', {
        remainingProcessCount: Number(response.slice(7)),
      });
    }
    throw this.decodeError(response);
  }

  onRelease(listener: () => void): void { this.releaseListener = listener; }

  dispose(): Promise<void> {
    if (this.disposePromise === undefined) {
      this.disposePromise = this.finishProcess();
      void this.disposePromise.catch(() => { this.disposePromise = undefined; });
    }
    return this.disposePromise;
  }

  shutdownOwner(): Promise<void> {
    if (this.ownerShutdownPromise === undefined) {
      this.ownerShutdownPromise = (async () => {
        await this.disposePromise;
        if (!this.disposed) await this.kill();
        await this.releaseOwnership();
      })();
      void this.ownerShutdownPromise.catch(() => { this.ownerShutdownPromise = undefined; });
    }
    return this.ownerShutdownPromise;
  }

  private async finishProcess(): Promise<void> {
    if (this.disposed) return this.releaseOwnership();
    await this.killPromise;
    if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
    if (this.ownerLifetime && this.killPromise === undefined) {
      const response = await this.request('retain');
      if (!/^active:\d+$/.test(response)) throw this.decodeError(response);
      if (response !== 'active:0') {
        this.closeStreams();
        return;
      }
    }
    await this.releaseOwnership();
  }

  private closeStreams(): void {
    this.stdin.destroy();
    this.stdout.destroy();
    if (this.stderr !== this.stdout) this.stderr.destroy();
  }

  private async releaseOwnership(): Promise<void> {
    if (!this.disposed) {
      await this.killPromise;
      if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
      if (!this.releaseConfirmed && (!this.helperGone || this.releaseAttempted)) {
        const response = await this.request('release');
        if (response !== 'released') throw this.decodeError(response);
      }
      this.disposed = true;
      this.control.destroy();
      this.closeStreams();
    }
    await this.withDeadline(this.helperExited.promise, 'deadline');
    this.releaseListener?.();
  }

  private async request(command: 'kill' | 'release' | 'retain'): Promise<string> {
    if (this.response !== undefined) throw this.killError('control', 'Windows process ownership operation is already in progress. Retry TaskStop.');
    if (this.helperGone || this.controlClosed || this.control.destroyed || this.control.writable === false) {
      this.markControlClosed();
      const recovered = this.responseAfterControlLoss(command);
      if (recovered !== undefined) return recovered;
      throw this.closedControlError();
    }
    const response = deferred<string>();
    this.response = response;
    this.pendingCommand = command;
    if (command === 'release') this.releaseAttempted = true;
    try {
      this.control.write(`${command}\n`, (error) => {
        if (!error) return;
        this.markControlClosed();
        if (command === 'release' && this.awaitingReleaseProof()) {
          this.releaseWriteError = error;
          return;
        }
        this.settlePendingControlLoss(error);
      });
    } catch (error) {
      this.markControlClosed();
      const recovered = this.responseAfterControlLoss(command);
      this.pendingCommand = undefined;
      this.response = undefined;
      if (recovered !== undefined) return recovered;
      const message = error instanceof Error ? error.message : String(error);
      throw this.killError('control', message, { controlClosed: true }, error);
    }
    try {
      return await this.withDeadline(response.promise, 'deadline');
    } finally {
      if (this.response === response) this.response = undefined;
      if (this.pendingCommand === command) this.pendingCommand = undefined;
    }
  }

  private markControlClosed(): void {
    this.controlClosed = true;
  }

  private closedControlError(cause?: unknown): HostProcessError {
    const message = cause instanceof Error ? cause.message : 'Windows process helper control channel is closed.';
    return this.killError('control', message, { controlClosed: true }, cause);
  }

  private awaitingReleaseProof(): boolean {
    return this.pendingCommand === 'release' && this.releaseExitCapable && !this.releaseConfirmed && !this.helperGone;
  }

  private responseAfterControlLoss(command: 'kill' | 'release' | 'retain'): string | undefined {
    if (!this.helperGone || this.releaseAttempted || this.releaseConfirmed || command === 'release') return undefined;
    return 'active:0';
  }

  private settlePendingControlLoss(error: Error): void {
    const response = this.response;
    const command = this.pendingCommand;
    if (response === undefined || command === undefined) return;
    const recovered = this.responseAfterControlLoss(command);
    if (recovered !== undefined) response.resolve(recovered);
    else response.reject(this.closedControlError(error));
  }

  private receive(line: string): void {
    if (line.startsWith('ready:')) {
      const fields = line.split(':');
      this.releaseExitCapable = fields.includes(RELEASE_EXIT_CAPABILITY);
      if (this.ownerLifetime && fields[2] !== 'owner-v1') {
        this.ready.reject(new Error('Windows process helper does not support owner lifetime. Rebuild or reinstall Kiki with its matching native assets.'));
      } else this.ready.resolve(Number(fields[1]));
    } else if (line.startsWith('exit:')) {
      this.code = Number(line.slice(5));
      this.exited.resolve(this.code);
    } else if (line === 'empty' && this.ownerLifetime) {
      void this.shutdownOwner().catch((error: unknown) => { this.cleanupFailure = error; });
    } else if (line.startsWith('error:watch:')) {
      this.cleanupFailure = this.decodeError(line);
    } else if (line.startsWith('error:launch:')) {
      const error = this.decodeError(line);
      this.ready.reject(error);
      this.exited.reject(error);
    } else this.response?.resolve(line);
  }

  private fail(error: Error, rejectResponse = true): void {
    this.ready.reject(error);
    this.exited.reject(this.killError('control', error.message, {}, error));
    if (rejectResponse) this.response?.reject(this.killError('control', error.message, {}, error));
  }

  private decodeError(line: string): HostProcessError {
    const [, phase, nativeCode, encoded] = line.split(':');
    const message = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : 'Invalid Windows process helper response.';
    return this.killError(phase ?? 'control', message, { win32Error: Number(nativeCode ?? 0) });
  }

  private killError(phase: string, message: string, details: Record<string, unknown> = {}, cause?: unknown): HostProcessError {
    return new HostProcessError(HostProcessErrorCode.KillFailed, message, {
      details: { cleanupComplete: false, phase, pid: this.pid, ...details }, cause,
    });
  }

  private async withDeadline<T>(promise: Promise<T>, phase: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_done, fail) => {
          timeout = setTimeout(() => { fail(this.killError(phase, 'Windows process helper did not confirm cleanup before its deadline.')); }, CONTROL_TIMEOUT_MS);
        }),
      ]);
    } finally { clearTimeout(timeout); }
  }
}

export async function spawnWindowsProcessTree(command: string, args: readonly string[], options: SpawnOptions, mergeStderr: boolean, ownerLifetime = false): Promise<WindowsProcessTree> {
  const helper = process.env['KIKI_WINDOWS_PROCESS_HELPER'] ?? [
    './windows-process-helper.exe',
    './native/windows-process-helper.exe',
    '../../../../dist/windows-process-helper.exe',
  ].map((path) => fileURLToPath(new URL(path, import.meta.url))).find(existsSync);
  if (!helper) {
    throw new HostProcessError(HostProcessErrorCode.SpawnFailed, 'Windows Bash process helper is missing. Rebuild or reinstall Kiki with its native assets.', {
      details: { command, phase: 'helper', helperMissing: true },
    });
  }
  let executable = command;
  let commandLine = [command, ...args].map(quoteArgument).join(' ');
  if (options.shell) {
    const shellCommand = [command, ...args].join(' ');
    executable = typeof options.shell === 'string' ? options.shell : process.env['ComSpec'] || 'cmd.exe';
    commandLine = /^(?:.*[\\/])?cmd(?:\.exe)?$/i.test(executable)
      ? `${quoteArgument(executable)} /d /s /c "${shellCommand}"`
      : [executable, '-c', shellCommand].map(quoteArgument).join(' ');
  }
  const name = `kiki-owned-${randomUUID()}`;
  const encoded = [executable, commandLine, resolve(options.cwd?.toString() ?? process.cwd())]
    .map((value) => Buffer.from(value).toString('base64'));
  const child = spawn(helper, [name], { ...options, stdio: 'ignore', shell: false });
  let processTree: WindowsProcessTree | undefined;
  const sockets: Socket[] = [];
  const spawnError = deferred<never>();
  const onError = (error: Error): void => { spawnError.reject(error); };
  child.once('error', onError);
  try {
    const control = await Promise.race([connectControl(name, child), spawnError.promise]);
    sockets.push(control);
    const [input, output, error] = await Promise.all(['in', 'out', 'err'].map(async (suffix) => {
      const socket = await connectControl(`${name}-${suffix}`, child);
      sockets.push(socket);
      return socket;
    }));
    processTree = new WindowsProcessTree(child, control, input!, output!, error!, mergeStderr, ownerLifetime);
    const launch = [...encoded, mergeStderr ? 'merge' : 'separate'];
    if (ownerLifetime) launch.push('owner-v1');
    control.write(`${launch.join(':')}\n`);
    await processTree.initialize();
    return processTree;
  } catch (error) {
    child.kill();
    for (const socket of sockets) socket.destroy();
    if (processTree !== undefined) {
      try { await processTree.dispose(); } catch { }
    }
    throw new HostProcessError(HostProcessErrorCode.SpawnFailed, `Failed to start Windows Bash process helper: ${error instanceof Error ? error.message : String(error)}`, {
      details: { command, helper, phase: 'launch' }, cause: error,
    });
  } finally { child.off('error', onError); }
}
