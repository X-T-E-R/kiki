import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import { isAbsolute, join, normalize } from 'pathe';
import type { Readable, Writable } from 'node:stream';

import * as ssh2 from 'ssh2';
import type {
  AnyAuthMethod,
  Client,
  ClientChannel,
  ConnectConfig,
  SFTPWrapper,
  Stats as SFTPStats,
} from 'ssh2';

import type { Environment } from './environment';
import { KaosError, KaosFileExistsError, KaosValueError } from './errors';
import { BufferedReadable, decodeTextWithErrors, globPatternToRegex } from './internal';
import type { Kaos } from './kaos';
import type { KaosProcess } from './process';
import type { StatResult } from './types';
import { SshWindowsOutput } from './ssh-output';

const POWERSHELL_PREAMBLE = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding=[Console]::OutputEncoding; $OutputEncoding=[Console]::OutputEncoding";
function powershellCommand(script: string): string {
  const source = `${POWERSHELL_PREAMBLE}; ${script}`;
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

// ── stat mode constants ────────────────────────────────────────────────
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;
const S_IFCHR = 0o020000;
const S_IFBLK = 0o060000;
const S_IFIFO = 0o010000;

const DEFAULT_SFTP_STATUS_CODE = {
  BAD_MESSAGE: 5,
  CONNECTION_LOST: 7,
  FAILURE: 4,
  NO_CONNECTION: 6,
  NO_SUCH_FILE: 2,
  OP_UNSUPPORTED: 8,
  PERMISSION_DENIED: 3,
} as const;

const DEFAULT_SSH_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_SSH_CLOSE_TIMEOUT_MS = 5_000;

function isPrematureCloseError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ERR_STREAM_PREMATURE_CLOSE'
  );
}

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

interface SshOperationOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly client?: Client;
  readonly mapError?: (error: unknown) => Error;
  readonly destroyOnTimeout?: boolean;
}

function withSshOperationGuard<T>(
  operation: string,
  invoke: (done: (error: unknown, value?: T) => void) => void,
  options: SshOperationOptions = {},
): Promise<T> {
  const { signal, client, mapError, destroyOnTimeout = true } = options;
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new KaosConnectionError(`SSH ${operation} aborted`),
    );
  }
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_SSH_OPERATION_TIMEOUT_MS);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (typeof client?.off === 'function') client.off('close', onClientClose);
    };
    const finishResolve = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      finishReject(
        signal?.reason instanceof Error
          ? signal.reason
          : new KaosConnectionError(`SSH ${operation} aborted`),
      );
    };
    const onClientClose = (): void => {
      finishReject(new KaosConnectionError(`SSH ${operation} failed: connection closed`));
    };
    const timer = setTimeout(() => {
      finishReject(new KaosConnectionError(`SSH ${operation} timed out after ${timeoutMs}ms`));
      if (destroyOnTimeout && typeof client?.destroy === 'function') {
        try {
          client.destroy();
        } catch {
          // Ignore synchronous destroy errors on an already-closed socket.
        }
      }
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (typeof client?.once === 'function') client.once('close', onClientClose);
    try {
      invoke((error, value) => {
        if (error) {
          finishReject(mapError ? mapError(error) : error);
        } else {
          finishResolve(value as T);
        }
      });
    } catch (error) {
      finishReject(mapError ? mapError(error) : error);
    }
  });
}

// ── SSH options ────────────────────────────────────────────────────────

/**
 * Advanced ssh2 connect options that may be passed through `SSHKaosOptions.extraOptions`.
 *
 * Excludes fields that SSHKaos manages itself (`host`, `port`, `username`,
 * `password`, `privateKey`, `authHandler`, `hostVerifier`, `hostHash`) — those
 * are derived from top-level options or intentionally disabled.
 */
export type SSHKaosExtraOptions = Omit<
  ConnectConfig,
  'host' | 'port' | 'username' | 'password' | 'privateKey' | 'authHandler' | 'hostVerifier' | 'hostHash'
>;

export interface SSHKaosOptions {
  signal?: AbortSignal;
  host: string;
  port?: number;
  username: string;
  password?: string;
  keyPaths?: string[];
  keyContents?: string[];
  passphrase?: string;
  keyboardInteractive?: (prompts: readonly { readonly prompt: string; readonly echo: boolean }[]) => Promise<readonly string[]>;
  cwd?: string;
  /** Verify the raw server key against an independently trusted record. Missing verifier rejects every connection. */
  hostVerifier?: ConnectConfig['hostVerifier'];
  /**
   * Pass-through for advanced ssh2 `ConnectConfig` fields such as `algorithms`,
   * `keepaliveInterval`, `readyTimeout`, `debug`, `tryKeyboard`, `agent`, etc.
   *
   * Managed fields (`host`, `port`, `username`, `password`, `privateKey`,
   * `authHandler`, `hostVerifier`, `hostHash`) are excluded from this type;
   * host key verification always receives raw key bytes.
   */
  extraOptions?: SSHKaosExtraOptions;
  /** Maximum time in milliseconds for a single SFTP/exec control callback before timing out (default: 60_000). */
  operationTimeoutMs?: number;
  /** Maximum time in milliseconds for graceful `close()` before forcing `client.destroy()` (default: 5_000). */
  closeTimeoutMs?: number;
}

// ── SSH error types ───────────────────────────────────────────────────

export class KaosSSHError extends KaosError {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'KaosSSHError';
    this.code = code;
  }
}

export class KaosFileNotFoundError extends KaosSSHError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = 'KaosFileNotFoundError';
  }
}

export class KaosPermissionError extends KaosSSHError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = 'KaosPermissionError';
  }
}

export class KaosConnectionError extends KaosSSHError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = 'KaosConnectionError';
  }
}

// ── shell quoting ──────────────────────────────────────────────────────

/**
 * Shell-escape a single argument (POSIX sh compatible).
 * Mirrors Python's shlex.quote().
 */
function shellQuote(arg: string): string {
  if (arg === '') return "''";
  // If the string is safe (only contains safe chars), return as-is
  if (/^[A-Za-z0-9_./:=@%^,+-]+$/.test(arg)) return arg;
  // Otherwise wrap in single quotes, escaping any embedded single quotes
  return "'" + arg.replaceAll("'", "'\"'\"'") + "'";
}

// ── stat mode builder ──────────────────────────────────────────────────

/**
 * Build a POSIX st_mode from SFTP Stats.
 * ssh2's Stats has .mode which already includes both file-type bits and
 * permission bits, but we also check the boolean helpers as a fallback.
 */
function buildStMode(attrs: SFTPStats): number {
  const raw = attrs.mode;
  // If mode already contains file-type bits, return as-is
  if ((raw & S_IFMT) !== 0) return raw;

  // Derive file-type bits from the is* helpers
  let typeBits = 0;
  if (attrs.isDirectory()) typeBits = S_IFDIR;
  else if (attrs.isFile()) typeBits = S_IFREG;
  else if (attrs.isSymbolicLink()) typeBits = S_IFLNK;
  else if (attrs.isSocket()) typeBits = S_IFSOCK;
  else if (attrs.isCharacterDevice()) typeBits = S_IFCHR;
  else if (attrs.isBlockDevice()) typeBits = S_IFBLK;
  else if (attrs.isFIFO()) typeBits = S_IFIFO;

  return (raw & ~S_IFMT) | typeBits;
}

function getSftpStatusCode(): typeof DEFAULT_SFTP_STATUS_CODE {
  return {
    ...DEFAULT_SFTP_STATUS_CODE,
    ...ssh2.utils?.sftp?.STATUS_CODE,
  };
}

function getErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === 'number' ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function mapSftpError(operation: string, error: unknown): KaosSSHError {
  const code = getErrorCode(error);
  const message = `${operation} failed: ${getErrorMessage(error)}`;
  const statusCode = getSftpStatusCode();

  if (code === statusCode.NO_SUCH_FILE) {
    return new KaosFileNotFoundError(message, code);
  }
  if (code === statusCode.PERMISSION_DENIED) {
    return new KaosPermissionError(message, code);
  }
  if (code === statusCode.NO_CONNECTION || code === statusCode.CONNECTION_LOST) {
    return new KaosConnectionError(message, code);
  }
  return new KaosSSHError(message, code);
}

function buildAuthHandler(
  username: string,
  privateKeys: readonly (Buffer | string | ssh2.ParsedKey)[],
  password?: string,
  agent?: ConnectConfig['agent'],
  keyboardInteractive?: SSHKaosOptions['keyboardInteractive'],
): ConnectConfig['authHandler'] {
  const authQueue: AnyAuthMethod[] = [];
  if (agent !== undefined) authQueue.push({ type: 'agent', username, agent });
  for (const key of privateKeys) authQueue.push({ key, type: 'publickey', username });
  if (password !== undefined) {
    authQueue.push({
      password,
      type: 'password',
      username,
    });
  }
  if (keyboardInteractive !== undefined) authQueue.push({
    type: 'keyboard-interactive', username,
    prompt: (_name, _instructions, _lang, prompts, finish) => {
      void keyboardInteractive(prompts.map(({ prompt, echo }) => ({ prompt, echo: echo === true })))
        .then((answers) => finish([...answers]), () => finish([]));
    },
  });

  let index = 0;
  return (_authsLeft, _partialSuccess, next) => {
    const nextAuth = authQueue[index];
    index += 1;
    const nextWithFalse = next as (auth: AnyAuthMethod | false) => void;
    nextWithFalse(nextAuth ?? false);
  };
}

// ── SSH process ────────────────────────────────────────────────────────

/** Exported for unit tests only. Do not use directly. */
export class SSHProcess implements KaosProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number = -1;

  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;
  private readonly _channel: ClientChannel;
  private _disposed = false;

  constructor(channel: ClientChannel, windowsCodePage?: number) {
    this._channel = channel;
    this.stdin = channel;
    const stdout = new BufferedReadable(channel as unknown as Readable);
    const stderr = new BufferedReadable(channel.stderr);
    const decode = (source: Readable): Readable => {
      if (windowsCodePage === undefined) return source;
      const output = new SshWindowsOutput(windowsCodePage);
      source.on('error', (error) => { output.destroy(error); });
      output.once('close', () => { source.destroy(); });
      return source.pipe(output);
    };
    this.stdout = decode(stdout);
    this.stderr = decode(stderr);

    this._exitPromise = new Promise<number>((resolve) => {
      // Listen to 'close' on the channel, not 'exit', to ensure all
      // buffered output is flushed before we resolve.
      channel.on('close', (code: number | null) => {
        // Some ssh2 backends surface the exit status only on 'close'.
        this._exitCode ??= code ?? 1;
        resolve(this._exitCode);
      });
      channel.on('exit', (code: number | null) => {
        this._exitCode = code ?? 1;
      });
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  async wait(): Promise<number> {
    return this._exitPromise;
  }

  kill(signal?: NodeJS.Signals): Promise<void> {
    // SSH signals must be stripped of the "SIG" prefix (RFC 4254 §6.9):
    // e.g. 'SIGTERM' → 'TERM', 'SIGKILL' → 'KILL', 'SIGINT' → 'INT'.
    // Honor the caller's requested signal so that remote processes can
    // perform graceful shutdown on SIGTERM/SIGINT.
    const rawSignal = signal ?? 'SIGTERM';
    const sshSignal = rawSignal.startsWith('SIG') ? rawSignal.slice(3) : rawSignal;
    this._channel.signal(sshSignal);
    return Promise.resolve();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
  }
}

// ── Promisified SSH helpers ────────────────────────────────────────────

function connectClient(config: ConnectConfig, signal?: AbortSignal): Promise<Client> {
  signal?.throwIfAborted();
  if (config.sock?.destroyed) throw config.sock.errored ?? new KaosConnectionError('SSH transport closed before connecting');
  const client = new ssh2.Client();
  return new Promise<Client>((resolve, reject) => {
    let ready = false;
    const onAbort = (): void => {
      reject(signal!.reason);
      client.destroy();
    };
    const cleanup = (): void => { signal?.removeEventListener('abort', onAbort); };
    client.once('ready', () => {
      ready = true;
      cleanup();
      resolve(client);
    });
    client.on('error', (err: Error) => {
      cleanup();
      reject(err);
      client.destroy();
    });
    client.once('close', () => {
      cleanup();
      if (!ready) reject(new KaosConnectionError('SSH connection closed before becoming ready'));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      client.connect(config);
    } catch (error) {
      cleanup();
      client.destroy();
      reject(error);
    }
  });
}

function getSftp(client: Client, options?: SshOperationOptions): Promise<SFTPWrapper> {
  return withSshOperationGuard<SFTPWrapper>(
    'sftp',
    (done) => {
      client.sftp((err, sftp) => {
        if (err) done(err);
        else done(undefined, sftp);
      });
    },
    { ...options, client },
  );
}

// Every promisified SFTP helper funnels rejections through `mapSftpError` so
// callers see a KaosSSHError subclass (KaosFileNotFoundError / KaosPermissionError /
// KaosConnectionError / generic KaosSSHError) instead of the raw ssh2 error.
// The operation label is the underlying SFTP RPC name — it shows up in the
// error message for debugging and is the same label used by `stat()` before
// this was hoisted into the helpers.

function sftpRealpath(sftp: SFTPWrapper, path: string, options?: SshOperationOptions): Promise<string> {
  return withSshOperationGuard<string>(
    'realpath',
    (done) => {
      sftp.realpath(path, (err, absPath) => {
        if (err) {
          done(mapSftpError('realpath', err));
        } else if (typeof absPath !== 'string' || absPath.length === 0) {
          done(new KaosSSHError(`SFTP realpath returned no canonical path for ${JSON.stringify(path)}`));
        } else {
          done(undefined, absPath);
        }
      });
    },
    options,
  );
}

function sftpStat(sftp: SFTPWrapper, path: string, options?: SshOperationOptions): Promise<SFTPStats> {
  return withSshOperationGuard<SFTPStats>(
    'stat',
    (done) => {
      sftp.stat(path, (err, stats) => {
        if (err) done(err);
        else done(undefined, stats);
      });
    },
    { ...options, mapError: (err) => mapSftpError('stat', err) },
  );
}

function sftpLstat(sftp: SFTPWrapper, path: string, options?: SshOperationOptions): Promise<SFTPStats> {
  return withSshOperationGuard<SFTPStats>(
    'lstat',
    (done) => {
      sftp.lstat(path, (err, stats) => {
        if (err) done(err);
        else done(undefined, stats);
      });
    },
    { ...options, mapError: (err) => mapSftpError('lstat', err) },
  );
}

interface SFTPFileEntry {
  filename: string;
  attrs: SFTPStats;
}

function sftpReaddir(sftp: SFTPWrapper, path: string, options?: SshOperationOptions): Promise<SFTPFileEntry[]> {
  return withSshOperationGuard<SFTPFileEntry[]>(
    'readdir',
    (done) => {
      sftp.readdir(path, (err, list) => {
        if (err) done(err);
        else done(undefined, list as SFTPFileEntry[]);
      });
    },
    { ...options, mapError: (err) => mapSftpError('readdir', err) },
  );
}

function sftpMkdir(sftp: SFTPWrapper, path: string, options?: SshOperationOptions): Promise<void> {
  return withSshOperationGuard<void>(
    'mkdir',
    (done) => {
      sftp.mkdir(path, (err) => {
        if (err) done(err);
        else done(undefined, undefined);
      });
    },
    { ...options, mapError: (err) => mapSftpError('mkdir', err) },
  );
}

function sftpExists(sftp: SFTPWrapper, path: string, options?: SshOperationOptions): Promise<boolean> {
  return withSshOperationGuard<boolean>(
    'exists',
    (done) => {
      sftp.exists(path, (exists) => {
        done(undefined, exists);
      });
    },
    options,
  );
}

function sftpReadFile(sftp: SFTPWrapper, path: string, options?: SshOperationOptions): Promise<Buffer> {
  return withSshOperationGuard<Buffer>(
    'readFile',
    (done) => {
      sftp.readFile(path, (err, data) => {
        if (err) done(err);
        else done(undefined, data);
      });
    },
    { ...options, mapError: (err) => mapSftpError('readFile', err) },
  );
}

function sftpWriteFile(
  sftp: SFTPWrapper,
  path: string,
  data: string | Buffer,
  options?: SshOperationOptions,
): Promise<void> {
  return withSshOperationGuard<void>(
    'writeFile',
    (done) => {
      sftp.writeFile(path, data, (err) => {
        if (err) done(err);
        else done(undefined, undefined);
      });
    },
    { ...options, mapError: (err) => mapSftpError('writeFile', err) },
  );
}

function sftpAppendFile(
  sftp: SFTPWrapper,
  path: string,
  data: string | Buffer,
  options?: SshOperationOptions,
): Promise<void> {
  return withSshOperationGuard<void>(
    'appendFile',
    (done) => {
      sftp.appendFile(path, data, (err) => {
        if (err) done(err);
        else done(undefined, undefined);
      });
    },
    { ...options, mapError: (err) => mapSftpError('appendFile', err) },
  );
}

function clientExec(client: Client, command: string, options?: SshOperationOptions): Promise<ClientChannel> {
  return withSshOperationGuard<ClientChannel>(
    'exec',
    (done) => {
      client.exec(command, (err: Error | undefined, channel: ClientChannel) => {
        if (err) done(err);
        else done(undefined, channel);
      });
    },
    { ...options, client },
  );
}

// ── SSHKaos ────────────────────────────────────────────────────────────

/**
 * A KAOS implementation that interacts with a remote machine via SSH and SFTP.
 */
export class SSHKaos implements Kaos {
  readonly name: string = 'ssh';

  private _client: Client;
  private _sftp: SFTPWrapper;
  private _home: string;
  private _cwd: string;
  private readonly _envLayers: readonly Record<string, string>[];
  private readonly _activity: { count: number; closed: boolean };
  private readonly _operationTimeoutMs: number;
  private readonly _closeTimeoutMs: number;
  private _environmentProbe?: Promise<Environment>;
  private _osEnv: Environment & { defaultShellName?: string; codePage?: number; tempDir?: string } = {
    osKind: 'POSIX', osArch: 'unknown', osVersion: 'unknown', shellName: 'sh', shellPath: '/bin/sh',
    pathClass: 'posix', homeDir: '',
  };

  get osEnv(): Environment & { defaultShellName?: string; codePage?: number; tempDir?: string } {
    return this._osEnv;
  }

  private _opOptions(overrides?: { signal?: AbortSignal; timeoutMs?: number }): SshOperationOptions {
    return {
      client: this._client,
      timeoutMs: overrides?.timeoutMs ?? this._operationTimeoutMs ?? DEFAULT_SSH_OPERATION_TIMEOUT_MS,
      signal: overrides?.signal,
    };
  }

  private async _probe(command: string, signal?: AbortSignal): Promise<string | undefined> {
    this._activity.count += 1;
    let proc: SSHProcess | undefined;
    try {
      proc = new SSHProcess(await clientExec(this._client, command, this._opOptions({ signal })));
      proc.stdin.on('error', () => {});
      proc.stdin.end();
      proc.stderr.on('error', () => {});
      proc.stderr.resume();
      const chunks: Buffer[] = [];
      for await (const chunk of proc.stdout) chunks.push(Buffer.from(chunk as Buffer));
      return await proc.wait() === 0 ? Buffer.concat(chunks).toString('utf8').trim() : undefined;
    } catch (error) {
      if (isPrematureCloseError(error)) return undefined;
      throw error;
    } finally {
      proc?.dispose();
      this._activity.count -= 1;
    }
  }

  probeEnvironment(): Promise<Environment> {
    this._environmentProbe ??= this._probeEnvironment().catch((error: unknown) => {
      this._environmentProbe = undefined;
      throw error;
    });
    return this._environmentProbe;
  }

  private async _probeEnvironment(): Promise<Environment> {
    if (this.pathClass() !== 'win32') {
      const output = await this._probe(SSHKaos._buildExecCommand(['/bin/sh', '-c', 'printf "KIKI_SSH_ENV\\n%s\\n%s\\n%s\\n" "$(uname -s)" "$(uname -m)" "$(uname -r)"; printf "%s\\n" "$SHELL"'], ''));
      const [marker, kind, arch, version, shell] = output?.split(/\r?\n/) ?? [];
      if (marker === 'KIKI_SSH_ENV' && kind && arch && version) {
        const shellPath = shell?.startsWith('/') && !/[\r\n]/.test(shell) ? shell : '/bin/sh';
        this._osEnv = {
          osKind: kind === 'Darwin' ? 'macOS' : kind === 'Linux' ? 'Linux' : kind,
          osArch: arch, osVersion: version,
          shellName: shellPath.endsWith('/bash') ? 'bash' : 'sh', shellPath,
          pathClass: 'posix', homeDir: this._home,
        };
        return this._osEnv;
      }
    }
    const script = `$ErrorActionPreference='Stop'; $default=[Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH','DefaultShell','cmd.exe'); 'KIKI_SSH_WINDOWS'; $env:PROCESSOR_ARCHITECTURE; [Environment]::OSVersion.Version.ToString(); (Get-Process -Id $PID).Path; if ($default -match '(?i)(powershell|pwsh)') { 'powershell' } elseif ($default -match '(?i)cmd(\\.exe)?$') { 'cmd' } else { $default }; [System.Text.Encoding]::Default.CodePage; [IO.Path]::GetTempPath()`;
    const output = await this._probe(powershellCommand(script));
    const [marker, arch, version, shell, defaultShellName, codePage, tempDir] = output?.split(/\r?\n/) ?? [];
    if (marker !== 'KIKI_SSH_WINDOWS' || !arch || !version || !shell || !tempDir) throw new KaosSSHError('Could not probe the remote SSH platform; neither POSIX nor Windows returned valid environment data');
    this._osEnv = { osKind: 'Windows', osArch: arch, osVersion: version, shellName: 'powershell', shellPath: shell.replaceAll('\\', '/'), pathClass: 'win32', homeDir: this._home, defaultShellName, codePage: Number(codePage) || 936, tempDir: tempDir.replaceAll('\\', '/') };
    this._home = this._nativePath(this._home);
    this._cwd = this._nativePath(this._cwd);
    this._osEnv = { ...this._osEnv, homeDir: this._home };
    return this._osEnv;
  }

  private _nativePath(path: string): string {
    if (this.pathClass() !== 'win32') return path;
    const colonDrive = /^\/([A-Za-z]):(?:[\\/](.*))?$/.exec(path);
    if (colonDrive !== null) return `${colonDrive[1]!.toUpperCase()}:/${(colonDrive[2] ?? '').replaceAll('\\', '/')}`;
    const cygdrive = /^\/cygdrive\/([A-Za-z])(?:\/(.*))?$/.exec(path);
    if (cygdrive !== null) return `${cygdrive[1]!.toUpperCase()}:/${(cygdrive[2] ?? '').replaceAll('\\', '/')}`;
    const msysDrive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(path);
    if (msysDrive !== null) return `${msysDrive[1]!.toUpperCase()}:/${(msysDrive[2] ?? '').replaceAll('\\', '/')}`;
    return path.replaceAll('\\', '/');
  }

  private constructor(
    client: Client,
    sftp: SFTPWrapper,
    home: string,
    cwd: string,
    envLayers: readonly Record<string, string>[] = [],
    activity?: { count: number; closed: boolean },
    operationTimeoutMs = DEFAULT_SSH_OPERATION_TIMEOUT_MS,
    closeTimeoutMs = DEFAULT_SSH_CLOSE_TIMEOUT_MS,
  ) {
    this._client = client;
    this._sftp = sftp;
    this._home = home;
    this._cwd = cwd;
    this._envLayers = envLayers;
    this._operationTimeoutMs = normalizeTimeoutMs(operationTimeoutMs, DEFAULT_SSH_OPERATION_TIMEOUT_MS);
    this._closeTimeoutMs = normalizeTimeoutMs(closeTimeoutMs, DEFAULT_SSH_CLOSE_TIMEOUT_MS);
    if (activity === undefined) {
      const shared = { count: 0, closed: false };
      client.once('close', () => { shared.closed = true; });
      this._activity = shared;
    } else {
      this._activity = activity;
    }
  }

  get activeProcesses(): number {
    return this._activity.count;
  }

  onDidDisconnect(listener: () => void): () => void {
    this._client.on('close', listener);
    return () => { this._client.off('close', listener); };
  }

  withCwd(cwd: string): SSHKaos {
    const scoped = new SSHKaos(
      this._client,
      this._sftp,
      this._home,
      this._resolvePath(cwd),
      this._envLayers,
      this._activity,
      this._operationTimeoutMs,
      this._closeTimeoutMs,
    );
    scoped._osEnv = this._osEnv;
    return scoped;
  }

  withEnv(env: Record<string, string>): SSHKaos {
    const scoped = new SSHKaos(
      this._client,
      this._sftp,
      this._home,
      this._cwd,
      [...this._envLayers, env],
      this._activity,
      this._operationTimeoutMs,
      this._closeTimeoutMs,
    );
    scoped._osEnv = this._osEnv;
    return scoped;
  }

  private _resolvePath(path: string): string {
    const native = this._nativePath(path);
    if (this.pathClass() === 'win32') {
      const cwd = this._nativePath(this._cwd);
      if (![native, cwd].some((value) => /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]/.test(value))) {
        throw new KaosValueError('Remote Windows paths require an absolute drive or UNC working directory');
      }
      return win32.resolve(cwd, native).replaceAll('\\', '/');
    }
    if (isAbsolute(native)) return native;
    return join(this._cwd, native);
  }

  /**
   * Factory method to create an SSHKaos instance.
   * Establishes the SSH connection and SFTP session.
   */
  static async create(options: SSHKaosOptions): Promise<SSHKaos> {
    // Start from extraOptions (advanced ssh2 options) so our managed fields
    // below take precedence.
    const config: ConnectConfig = {
      ...options.extraOptions,
      hostHash: undefined,
      host: options.host,
      port: options.port ?? 22,
      username: options.username,
    };

    if (options.password !== undefined) {
      config.password = options.password;
    }

    // Build private keys from keyContents and keyPaths
    const privateKeys: (Buffer | string)[] = [];
    if (options.keyContents) {
      for (const content of options.keyContents) {
        privateKeys.push(content);
      }
    }
    if (options.keyPaths) {
      const keyPromises = options.keyPaths.map(async (keyPath) => {
        if (typeof keyPath !== 'string' || keyPath.length === 0) throw new KaosValueError('SSH private key path must be a non-empty string');
        try {
          return await readFile(keyPath, { encoding: 'utf-8', signal: options.signal });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      });
      const keyData = await Promise.all(keyPromises);
      for (const key of keyData) {
        if (key !== undefined) privateKeys.push(key);
      }
    }
    const parsedKeys = privateKeys.map((key) => {
      if (options.passphrase === undefined) return key;
      const parsed = ssh2.utils.parseKey(key, options.passphrase);
      if (parsed instanceof Error) throw new Error('SSH private key or passphrase is invalid');
      return parsed;
    });
    if (parsedKeys.length > 0 || config.agent !== undefined || options.keyboardInteractive !== undefined) {
      const authHandler = buildAuthHandler(options.username, parsedKeys, options.password, config.agent, options.keyboardInteractive);
      if (authHandler !== undefined) {
        config.authHandler = authHandler;
      }
    }

    // A missing trust source must not silently accept an unknown or changed server key.
    config.hostVerifier = options.hostVerifier ?? (() => false);

    const operationTimeoutMs = normalizeTimeoutMs(options.operationTimeoutMs, DEFAULT_SSH_OPERATION_TIMEOUT_MS);
    const closeTimeoutMs = normalizeTimeoutMs(options.closeTimeoutMs, DEFAULT_SSH_CLOSE_TIMEOUT_MS);
    const client = await connectClient(config, options.signal);
    const onAbort = (): void => { client.destroy(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const initOp: SshOperationOptions = { client, signal: options.signal, timeoutMs: operationTimeoutMs };
    try {
      options.signal?.throwIfAborted();
      const sftp = await getSftp(client, initOp);

      // Determine home and cwd
      const home = await sftpRealpath(sftp, '.', initOp);
      let cwd: string;
      if (options.cwd === undefined) {
        cwd = home;
      } else {
        cwd = await sftpRealpath(sftp, options.cwd, initOp);
        const attrs = await sftpStat(sftp, cwd, initOp);
        if (!attrs.isDirectory()) {
          throw new KaosValueError(`${cwd} is not a directory`);
        }
      }

      options.signal?.throwIfAborted();
      return new SSHKaos(client, sftp, home, cwd, [], undefined, operationTimeoutMs, closeTimeoutMs);
    } catch (error) {
      client.destroy();
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  // ── Path operations (sync) ─────────────────────────────────────────

  pathClass(): 'posix' | 'win32' {
    return this._osEnv.osKind === 'Windows' || /^\/?[A-Za-z]:[\\/]/.test(this._home) ? 'win32' : 'posix';
  }

  normpath(path: string): string {
    return this.pathClass() === 'win32' ? win32.normalize(this._nativePath(path)).replaceAll('\\', '/') : normalize(path);
  }

  gethome(): string {
    return this._home;
  }

  getcwd(): string {
    return this._cwd;
  }

  // ── Directory operations (async) ───────────────────────────────────

  async chdir(path: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
    const op = this._opOptions(options);
    const resolved = this._nativePath(await sftpRealpath(this._sftp, this._resolvePath(path), op));
    // Verify the resolved target is actually a directory. Without this
    // guard, `realpath` happily returns file paths, causing later relative
    // reads/writes/execs to treat a regular file as a working directory.
    const attrs = await sftpStat(this._sftp, resolved, op);
    if (!attrs.isDirectory()) {
      throw new KaosValueError(`${resolved} is not a directory`);
    }
    this._cwd = resolved;
  }

  async stat(path: string, options?: { followSymlinks?: boolean; signal?: AbortSignal; timeoutMs?: number }): Promise<StatResult> {
    const resolved = this._resolvePath(path);
    const followSymlinks = options?.followSymlinks ?? true;
    const op = this._opOptions(options);
    // sftpStat / sftpLstat already wrap errors via mapSftpError.
    const st = followSymlinks
      ? await sftpStat(this._sftp, resolved, op)
      : await sftpLstat(this._sftp, resolved, op);

    return {
      stMode: buildStMode(st),
      // SFTP does not provide inode
      stIno: 0,
      // SFTP does not provide device
      stDev: 0,
      // ssh2 Stats does not expose nlink
      stNlink: 0,
      stUid: st.uid,
      stGid: st.gid,
      stSize: st.size,
      stAtime: st.atime,
      stMtime: st.mtime,
      // SFTP v3 has no ctime, fallback to mtime
      stCtime: st.mtime,
    };
  }

  async *iterdir(path: string, options?: { signal?: AbortSignal; timeoutMs?: number }): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const entries = await sftpReaddir(this._sftp, resolved, this._opOptions(options));
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') continue;
      yield join(resolved, entry.filename);
    }
  }

  async *glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const caseSensitive = options?.caseSensitive ?? true;
    if (!caseSensitive) {
      throw new KaosValueError('Case insensitive glob is not supported in current environment');
    }
    // Use local glob implementation over SFTP readdir
    const patternParts = pattern.split('/');
    yield* this._globWalk(resolved, patternParts, caseSensitive);
  }

  private async *_globWalk(
    basePath: string,
    patternParts: string[],
    caseSensitive: boolean,
  ): AsyncGenerator<string> {
    if (patternParts.length === 0) return;

    const [currentPattern, ...remainingParts] = patternParts;

    if (currentPattern === '**') {
      // `**` matches zero or more directory components.
      //
      // Two cases to handle:
      //   (a) `**` matches zero directories → continue at basePath with
      //       the remaining pattern parts (or yield basePath when `**` is
      //       the final segment).
      //   (b) `**` matches one or more directories → recurse into each
      //       subdirectory, keeping `**` (the full patternParts) at the
      //       front. The "zero directories" case is re-evaluated at the
      //       subdirectory level by that recursive call.
      //
      // Do NOT additionally recurse with `remainingParts` on subdirectories
      // — that would double-count matches at depth ≥ 1 because case (a)
      // inside the child recursion already yields those results.
      if (remainingParts.length > 0) {
        yield* this._globWalk(basePath, remainingParts, caseSensitive);
      } else {
        // Pattern ends with `**`: yield basePath itself (zero-dir match).
        yield basePath;
      }

      const entries = await sftpReaddir(this._sftp, basePath, this._opOptions());

      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        const fullPath = join(basePath, entry.filename);
        if (entry.attrs.isDirectory()) {
          yield* this._globWalk(fullPath, patternParts, caseSensitive);
        } else if (remainingParts.length === 0) {
          // Pattern ends with `**`: non-directory entries match too.
          yield fullPath;
        }
      }
    } else {
      const regex = globPatternToRegex(currentPattern ?? '', caseSensitive);

      const entries = await sftpReaddir(this._sftp, basePath, this._opOptions());

      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        if (!regex.test(entry.filename)) continue;

        const fullPath = join(basePath, entry.filename);

        if (remainingParts.length === 0) {
          yield fullPath;
        } else if (entry.attrs.isDirectory()) {
          yield* this._globWalk(fullPath, remainingParts, caseSensitive);
        }
      }
    }
  }

  // ── File operations (async) ────────────────────────────────────────

  /** Stream an inclusive byte range in bounded chunks and close its SFTP handle on completion, return or cancellation. */
  async *readByteStream(path: string, options: { start?: number; end?: number; signal?: AbortSignal } = {}): AsyncGenerator<Buffer> {
    options.signal?.throwIfAborted();
    const stream = this._sftp.createReadStream(this._resolvePath(path), {
      start: options.start ?? 0,
      end: options.end,
      highWaterMark: 64 * 1024,
      autoClose: true,
    });
    stream.on('error', () => {});
    const onAbort = () => { stream.destroy(options.signal?.reason instanceof Error ? options.signal.reason : new Error('SSH file read aborted')); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const chunk of stream) {
        options.signal?.throwIfAborted();
        yield Buffer.from(chunk as Buffer);
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      throw mapSftpError('read', error);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      stream.destroy();
    }
  }

  async readBytes(path: string, n?: number, offset = 0, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Buffer> {
    const resolved = this._resolvePath(path);
    const op = this._opOptions(options);
    if (n === undefined && offset === 0) return sftpReadFile(this._sftp, resolved, op);
    if (typeof this._sftp.createReadStream !== 'function') {
      return (await sftpReadFile(this._sftp, resolved, op)).subarray(offset, n === undefined ? undefined : offset + n);
    }
    options?.signal?.throwIfAborted();
    const stream = this._sftp.createReadStream(resolved, {
      start: offset,
      ...(n === undefined ? {} : { end: offset + n - 1 }),
    });
    if (n === 0) {
      stream.destroy();
      return Buffer.alloc(0);
    }
    stream.on('error', () => {});
    const onAbort = () => {
      stream.destroy(options?.signal?.reason instanceof Error ? options.signal.reason : new KaosConnectionError('SSH readBytes aborted'));
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of stream) {
        options?.signal?.throwIfAborted();
        chunks.push(Buffer.from(chunk as Buffer));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      options?.signal?.throwIfAborted();
      throw mapSftpError('read', error);
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
      stream.destroy();
    }
  }

  async readdir(path: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<readonly { name: string; mode: number }[]> {
    const entries = await sftpReaddir(this._sftp, this._resolvePath(path), this._opOptions(options));
    return entries.filter((entry) => entry.filename !== '.' && entry.filename !== '..')
      .map((entry) => ({ name: entry.filename, mode: buildStMode(entry.attrs) }));
  }

  async realpath(path: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
    return this._nativePath(await sftpRealpath(this._sftp, this._resolvePath(path), this._opOptions(options)));
  }

  async createExclusive(path: string, data: Buffer, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<boolean> {
    const target = this._resolvePath(path);
    const op = this._opOptions(options);
    let handle: Buffer;
    try {
      handle = await withSshOperationGuard<Buffer>(
        'open',
        (done) => {
          this._sftp.open(target, 'wx', (error, fd) => {
            if (error) done(error);
            else done(undefined, fd);
          });
        },
        op,
      );
    } catch (error) {
      if (error instanceof KaosConnectionError) throw error;
      const code = getErrorCode(error);
      const stringCode = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
      if (stringCode === 'EEXIST' || (code === getSftpStatusCode().FAILURE && await sftpExists(this._sftp, target, op))) {
        return false;
      }
      throw mapSftpError('createExclusive', error);
    }
    let writeError: unknown;
    try {
      const chunkSize = 32 * 1024;
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        const length = Math.min(chunkSize, data.length - offset);
        await withSshOperationGuard<void>(
          'write',
          (done) => {
            this._sftp.write(handle, data, offset, length, offset, (error) => {
              if (error) done(error);
              else done(undefined, undefined);
            });
          },
          op,
        );
      }
    } catch (error) {
      writeError = error;
    }
    let closeError: unknown;
    try {
      await withSshOperationGuard<void>(
        'close',
        (done) => {
          this._sftp.close(handle, (error) => {
            if (error) done(error);
            else done(undefined, undefined);
          });
        },
        op,
      );
    } catch (error) {
      closeError = error;
    }
    if (writeError !== undefined) throw writeError instanceof KaosConnectionError ? writeError : mapSftpError('createExclusive', writeError);
    if (closeError !== undefined) throw closeError instanceof KaosConnectionError ? closeError : mapSftpError('createExclusive', closeError);
    return true;
  }

  async remove(path: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
    const target = this._resolvePath(path);
    const op = this._opOptions(options);
    const attrs = await sftpLstat(this._sftp, target, op);
    await withSshOperationGuard<void>(
      'remove',
      (done) => {
        const callback = (error: Error | null | undefined): void => {
          if (error) done(error);
          else done(undefined, undefined);
        };
        if (attrs.isDirectory()) this._sftp.rmdir(target, callback);
        else this._sftp.unlink(target, callback);
      },
      { ...op, mapError: (error) => mapSftpError('remove', error) },
    );
  }

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore'; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<string> {
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    const data = await sftpReadFile(this._sftp, this._resolvePath(path), this._opOptions(options));
    return decodeTextWithErrors(data, encoding, errors);
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore'; signal?: AbortSignal; timeoutMs?: number },
  ): AsyncGenerator<string> {
    // SFTP does not support streaming line reads; read all then split.
    // Match Python's splitlines() semantics: returned lines do NOT include
    // the line terminator, and a trailing newline does not create an extra
    // empty line.
    const text = await this.readText(this._resolvePath(path), options);
    if (text === '') {
      return;
    }

    const lines = text.split(/\r\n|[\n\r]/u);
    if (/(?:\r\n|[\n\r])$/u.test(text)) {
      lines.pop();
    }
    for (const line of lines) {
      yield line ?? '';
    }
  }

  async writeBytes(path: string, data: Buffer, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<number> {
    await sftpWriteFile(this._sftp, this._resolvePath(path), data, this._opOptions(options));
    return data.length;
  }

  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<number> {
    const resolved = this._resolvePath(path);
    const mode = options?.mode ?? 'w';
    const encoding = options?.encoding ?? 'utf-8';
    const buf = Buffer.from(data, encoding);
    const op = this._opOptions(options);
    if (mode === 'a') {
      await sftpAppendFile(this._sftp, resolved, buf, op);
    } else {
      await sftpWriteFile(this._sftp, resolved, buf, op);
    }
    return data.length;
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean; signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
    const resolved = this._resolvePath(path);
    const parents = options?.parents ?? false;
    const existOk = options?.existOk ?? false;
    const op = this._opOptions(options);

    if (parents) {
      await this._mkdirRecursive(resolved, existOk, op);
    } else {
      const exists = await sftpExists(this._sftp, resolved, op);
      if (exists) {
        if (!existOk) {
          throw new KaosFileExistsError(`${resolved} already exists`);
        }
        // `existOk` only applies when the conflicting path is itself a
        // directory. A regular file sitting at the target path is still
        // a conflict — we must not pretend mkdir succeeded.
        const st = await sftpStat(this._sftp, resolved, op);
        if (!st.isDirectory()) {
          throw new KaosFileExistsError(`${resolved} already exists but is not a directory`);
        }
        return;
      }
      await sftpMkdir(this._sftp, resolved, op);
    }
  }

  private async _mkdirRecursive(path: string, existOk: boolean, op: SshOperationOptions): Promise<void> {
    // Split path into components and create each level.
    const parts = path.split('/').filter(Boolean);
    let current = path.startsWith('/') ? '/' : '';
    const lastIndex = parts.length - 1;
    for (const [i, part] of parts.entries()) {
      current = current ? join(current, part) : part;

      const isFinal = i === lastIndex;

      // eslint-disable-next-line no-await-in-loop
      const exists = await sftpExists(this._sftp, current, op);
      if (exists) {
        // For intermediate components, it's fine (and expected) for the
        // path to already exist. For the final target, honor `existOk`.
        if (isFinal && !existOk) {
          throw new KaosFileExistsError(`${current} already exists`);
        }
        // Regardless of whether this is an intermediate or the final
        // component, an existing path must actually be a directory.
        // An intermediate non-directory would cause the next `sftpMkdir`
        // to fail with a confusing error; a final non-directory would
        // otherwise be silently accepted when `existOk` is true.
        // eslint-disable-next-line no-await-in-loop
        const st = await sftpStat(this._sftp, current, op);
        if (!st.isDirectory()) {
          throw new KaosFileExistsError(`${current} already exists but is not a directory`);
        }
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await sftpMkdir(this._sftp, current, op);
      } catch (error) {
        if (error instanceof KaosConnectionError) throw error;
        // Race condition: another process may have created it.
        // eslint-disable-next-line no-await-in-loop
        const nowExists = await sftpExists(this._sftp, current, op);
        if (!nowExists) throw new Error(`Failed to create directory: ${current}`, { cause: error });
        // A raced path must still be a directory. Another process may have
        // created a regular file at the same pathname after our exists()
        // check but before mkdir(), which must remain a hard conflict.
        // eslint-disable-next-line no-await-in-loop
        const st = await sftpStat(this._sftp, current, op);
        if (!st.isDirectory()) {
          throw new KaosFileExistsError(`${current} already exists but is not a directory`);
        }
        // If the final component lost a race and existOk=false, surface the
        // conflict to match the non-race path above.
        if (isFinal && !existOk) {
          throw new KaosFileExistsError(`${current} already exists`);
        }
      }
    }
  }

  // ── Process execution ──────────────────────────────────────────────

  exec(...args: string[]): Promise<KaosProcess> {
    if (args.length === 0) {
      throw new KaosValueError(
        'SSHKaos.exec(): at least one argument (the command to run) is required.',
      );
    }
    return this._execInternal(args, this._buildExecEnv());
  }

  execWithEnv(
    args: string[],
    env?: Record<string, string>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<KaosProcess> {
    if (args.length === 0) {
      throw new KaosValueError(
        'SSHKaos.execWithEnv(): at least one argument (the command to run) is required.',
      );
    }
    return this._execInternal(args, this._buildExecEnv(env), options);
  }

  private _buildExecEnv(invocationEnv?: Record<string, string>): Record<string, string> | undefined {
    if (this._envLayers.length === 0) return invocationEnv;
    const merged: Record<string, string> = { ...invocationEnv };
    for (const layer of this._envLayers) {
      Object.assign(merged, layer);
    }
    return merged;
  }

  /**
   * Build the full remote shell command string that will be handed to
   * `client.exec`. Exposed as a static so it can be unit-tested without
   * needing a live SSH connection — see `ssh.test.ts`.
   *
   * Shape: `cd '<cwd>' && KEY1='v1' KEY2='v2' <cmd> <arg1> <arg2> ...`
   *
   * Environment variables are injected as POSIX inline assignments instead
   * of being passed through ssh2's `ExecOptions.env`. The env-request path
   * silently drops anything not whitelisted by sshd's `AcceptEnv` directive
   * (stock OpenSSH only allows LANG/LC_*), which is a well-known footgun
   * inherited from the Python / asyncssh implementation. Inline assignments
   * run inside the remote shell itself, so they bypass AcceptEnv entirely
   * and reach the command regardless of server configuration.
   */
  private static _buildExecCommand(
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ): string {
    let command = args.map((arg) => shellQuote(arg)).join(' ');

    if (env !== undefined) {
      const assignments: string[] = [];
      for (const [key, value] of Object.entries(env)) {
        // Reject anything that isn't a POSIX-valid shell variable name so
        // the injected prefix can never become a shell-injection vector.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new KaosValueError(
            `SSHKaos.execWithEnv(): invalid env variable name ${JSON.stringify(key)}`,
          );
        }
        assignments.push(`${key}=${shellQuote(value)}`);
      }
      if (assignments.length > 0) {
        command = `${assignments.join(' ')} ${command}`;
      }
    }

    if (cwd !== '') {
      command = `cd ${shellQuote(cwd)} && ${command}`;
    }

    return command;
  }

  private static _buildWindowsScript(script: string, cwd: string, env?: Record<string, string>): string {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const statements = ["$ErrorActionPreference='Stop'", '$global:LASTEXITCODE=0'];
    if (cwd !== '') statements.push(`Set-Location -LiteralPath ${quote(cwd)}`);
    for (const [key, value] of Object.entries(env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new KaosValueError(`SSHKaos.execWithEnv(): invalid env variable name ${JSON.stringify(key)}`);
      statements.push(`$env:${key}=${quote(value)}`);
    }
    statements.push(`& {\n${script}\n} | ForEach-Object { $__kikiSshOutput.Process($_) }`, '$ok=$?', 'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (!$ok) { exit 1 }; exit 0');
    return `$__kikiSshOutput = { Out-Default }.GetSteppablePipeline(); $__kikiSshOutput.Begin($true); try { ${statements.join('; ')} } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 } finally { $__kikiSshOutput.End() }`;
  }

  private static _buildWindowsExecCommand(args: string[], cwd: string, env?: Record<string, string>): string {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return SSHKaos._buildWindowsScript(`& ${args.map(quote).join(' ')}`, cwd, env);
  }

  execPowerShell(
    script: string,
    env?: Record<string, string>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<KaosProcess> {
    if (this.pathClass() !== 'win32') throw new KaosValueError('PowerShell execution requires a Windows SSH host');
    return this._execWindowsScript(SSHKaos._buildWindowsScript(script, this._cwd, this._buildExecEnv(env)), options);
  }

  private _execInternal(
    args: string[],
    env?: Record<string, string>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<KaosProcess> {
    return this.pathClass() === 'win32'
      ? this._execWindowsScript(SSHKaos._buildWindowsExecCommand(args, this._cwd, env), options)
      : this._execCommand(SSHKaos._buildExecCommand(args, this._cwd, env), options);
  }

  private async _execWindowsScript(
    script: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<KaosProcess> {
    const command = powershellCommand(script);
    if (command.length <= 8191) return this._execCommand(command, options);
    const tempDir = this._osEnv.tempDir;
    if (!tempDir || !win32.isAbsolute(tempDir)) throw new KaosSSHError('Windows SSH host did not provide an absolute TEMP directory for script execution');
    const path = win32.join(tempDir, `kiki-ssh-${randomUUID()}.ps1`).replaceAll('\\', '/');
    const quoted = `'${path.replaceAll("'", "''")}'`;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => cleanupPromise ??= this.remove(path).catch((error: unknown) => {
      if (!(error instanceof KaosFileNotFoundError)) throw new KaosSSHError(`Could not remove temporary SSH script ${path}: ${getErrorMessage(error)}`);
    });
    try {
      await this.writeBytes(path, Buffer.from(`\uFEFF${POWERSHELL_PREAMBLE}; ${script}`, 'utf8'), options);
      const process = await this._execCommand(powershellCommand(`try { & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quoted}; exit $LASTEXITCODE } finally { Remove-Item -LiteralPath ${quoted} -Force -ErrorAction SilentlyContinue }`), options);
      const completion = process.wait().then(async (code) => { await cleanup(); return code; });
      void completion.catch(() => {});
      return {
        pid: process.pid, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
        get exitCode() { return process.exitCode; }, wait: () => completion,
        kill: (signal) => process.kill(signal),
        dispose: async () => { await process.dispose(); await cleanup(); },
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  private async _execCommand(
    command: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<KaosProcess> {
    this._activity.count += 1;
    try {
      const channel = await clientExec(this._client, command, this._opOptions(options));
      const process = new SSHProcess(channel, this.pathClass() === 'win32' ? this._osEnv.codePage ?? 936 : undefined);
      const release = (): void => { this._activity.count -= 1; };
      void process.wait().then(release, release);
      return process;
    } catch (error) {
      this._activity.count -= 1;
      throw error;
    }
  }

  // ── SSH lifecycle ──────────────────────────────────────────────────

  /**
   * Close the SSH connection. After this, the SSHKaos instance is unusable.
   */
  close(timeoutMs?: number): Promise<void> {
    if (this._activity?.closed) return Promise.resolve();
    const effectiveTimeoutMs = normalizeTimeoutMs(
      timeoutMs ?? this._closeTimeoutMs,
      DEFAULT_SSH_CLOSE_TIMEOUT_MS,
    );
    try {
      this._sftp?.end();
    } catch {
      // Ignore synchronous SFTP teardown errors on an already-closed socket.
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (typeof this._client?.off === 'function') this._client.off('close', finish);
        if (this._activity !== undefined) this._activity.closed = true;
        resolve();
      };
      const deadline = setTimeout(() => {
        if (typeof this._client?.destroy === 'function') {
          try {
            this._client.destroy();
          } catch {
            // Ignore synchronous destroy errors on an already-closed socket.
          }
        }
        finish();
      }, effectiveTimeoutMs);
      deadline.unref();
      this._client.once('close', finish);
      try {
        this._client.end();
      } catch {
        if (typeof this._client?.destroy === 'function') {
          try {
            this._client.destroy();
          } catch {
            // Ignore synchronous destroy errors on an already-closed socket.
          }
        }
        finish();
      }
    });
  }
}
