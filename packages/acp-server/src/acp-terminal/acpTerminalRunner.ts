import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';
import { PassThrough, Writable, type Readable } from 'node:stream';

import type {
  HostEnvironmentInfo,
  HostProcessOptions,
  IHostEnvironment,
  IHostFileSystem,
  IHostProcess,
  IHostProcessService,
  ISessionContext,
  Runtime,
  RuntimePath,
  RuntimeProviderAttachment,
  RuntimeProviderContext,
  RuntimeProviderFactory,
  RuntimeProviderHost,
} from '@kiki/agent-core-v2';

import { AcpHostFileSystem, IAcpConnection, type IAcpTerminalHandle } from '../acp-fs';

const OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024;
const OUTPUT_POLL_MIN_MS = 250;
const OUTPUT_POLL_MAX_MS = 2_000;
const OUTPUT_POLL_TRUNCATED_MS = 4_000;
let nextGeneration = 1;

function isBashToolInvocation(args: readonly string[], options?: HostProcessOptions): boolean {
  return (
    args.length === 2 &&
    args[0] === '-c' &&
    options?.env?.['NO_COLOR'] === '1' &&
    options?.env?.['TERM'] === 'dumb'
  );
}

function envRecordToAcp(
  env: Record<string, string> | undefined,
): Array<{ name: string; value: string }> | undefined {
  if (env === undefined) return undefined;
  return Object.entries(env).map(([name, value]) => ({ name, value }));
}

class AcpProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly connection: IAcpConnection,
    private readonly local: IHostProcessService,
  ) {}

  async spawn(
    command: string,
    args: readonly string[] = [],
    options?: HostProcessOptions,
  ): Promise<IHostProcess> {
    if (!this.connection.terminalEnabled || !isBashToolInvocation(args, options)) {
      return this.local.spawn(command, args, { ...options, cwd: options?.cwd ?? this.cwd });
    }

    const handle = await this.connection.get().createTerminal({
      sessionId: this.sessionId,
      command,
      args: [...args],
      env: envRecordToAcp(options?.env),
      cwd: options?.cwd ?? this.cwd,
      outputByteLimit: OUTPUT_BYTE_LIMIT,
    });
    this.connection.notifyTerminalCreated({
      sessionId: this.sessionId,
      shellCommand: args[1] ?? '',
      terminalId: handle.id,
    });
    return new AcpTerminalProcess(handle);
  }
}

class AcpTerminalProcess implements IHostProcess {
  declare readonly _serviceBrand: undefined;
  readonly stdin: Writable;
  readonly stdout: PassThrough;
  readonly stderr: Readable;
  readonly pid = 0;

  private _exitCode: number | null = null;
  private emitted = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollStopped = false;
  private pollDelayMs = OUTPUT_POLL_MIN_MS;
  private pollInFlight: Promise<boolean> | undefined;
  private readonly waitPromise: Promise<number>;
  private released = false;

  constructor(private readonly handle: IAcpTerminalHandle) {
    this.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    this.stdout = new PassThrough();
    const stderr = new PassThrough();
    stderr.end();
    this.stderr = stderr;
    const waitPromise = this.run();
    waitPromise.catch(() => {});
    this.waitPromise = waitPromise;
    this.schedulePoll();
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  wait(): Promise<number> {
    return this.waitPromise;
  }

  async kill(_signal?: NodeJS.Signals): Promise<void> {
    await this.handle.kill();
  }

  async dispose(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopPolling();
    try {
      await this.handle.release();
    } catch {
    }
  }

  private async run(): Promise<number> {
    try {
      const status = await this.handle.waitForExit();
      this._exitCode = status.exitCode ?? -1;
      this.stopPolling();
      await this.pumpFinal();
      return this._exitCode;
    } finally {
      this.stopPolling();
      this.stdout.end();
    }
  }

  private schedulePoll(): void {
    if (this.pollStopped || this.pollTimer !== undefined) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      if (this.pollStopped) return;
      void this.pump().finally(() => {
        if (!this.pollStopped) this.schedulePoll();
      });
    }, this.pollDelayMs);
    this.pollTimer.unref?.();
  }

  private async pumpFinal(): Promise<void> {
    if (this.pollInFlight !== undefined) {
      await this.pollInFlight;
    }
    await this.pumpOnce();
  }

  private pump(): Promise<boolean> {
    if (this.pollInFlight !== undefined) return this.pollInFlight;
    const flight = this.pumpOnce().finally(() => {
      if (this.pollInFlight === flight) this.pollInFlight = undefined;
    });
    this.pollInFlight = flight;
    return flight;
  }

  private async pumpOnce(): Promise<boolean> {
    try {
      const { output, truncated } = await this.handle.currentOutput();
      let changed = false;
      if (output.length > this.emitted) {
        this.stdout.write(output.slice(this.emitted));
        this.emitted = output.length;
        changed = true;
      } else if (output.length < this.emitted) {
        this.emitted = output.length;
        changed = true;
      }
      if (changed) {
        this.pollDelayMs = OUTPUT_POLL_MIN_MS;
      } else {
        const cap = truncated === true ? OUTPUT_POLL_TRUNCATED_MS : OUTPUT_POLL_MAX_MS;
        this.pollDelayMs = Math.min(cap, this.pollDelayMs * 2);
      }
      return changed;
    } catch {
      this.pollDelayMs = Math.min(OUTPUT_POLL_MAX_MS, this.pollDelayMs * 2);
      return false;
    }
  }

  private stopPolling(): void {
    this.pollStopped = true;
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}

class AcpSessionRuntime implements Runtime {
  readonly identity;
  readonly capabilities = new Set(['process', 'fs'] as const);
  readonly environment: HostEnvironmentInfo;
  readonly path: RuntimePath;
  readonly workspace = { mapRoots: (roots: { workDir: string; additionalDirs?: readonly string[] }) => roots };
  readonly fs: IHostFileSystem;
  readonly process;
  readonly watch = undefined;
  readonly terminal = undefined;
  readonly status = 'ready' as const;
  readonly onDidChangeStatus = () => ({ dispose: () => {} });

  constructor(
    workspaceId: string,
    sessionId: string,
    cwd: string,
    connection: IAcpConnection,
    environment: IHostEnvironment,
    local: IHostProcessService,
  ) {
    this.identity = {
      workspaceId,
      runtimeId: AcpRuntimeProviderFactory.runtimeId(sessionId),
      generation: `acp-${String(nextGeneration++)}`,
    };
    this.environment = {
      osKind: environment.osKind,
      osArch: environment.osArch,
      osVersion: environment.osVersion,
      shellName: environment.shellName,
      shellPath: environment.shellPath,
      pathClass: environment.pathClass,
      homeDir: environment.homeDir,
    };
    const path = environment.pathClass === 'win32' ? win32Path : posixPath;
    this.path = {
      separator: path.sep as '/' | '\\',
      delimiter: path.delimiter as ':' | ';',
      isAbsolute: (p: string) => path.isAbsolute(p),
      join: (...paths: readonly string[]) => path.join(...paths),
      relative: (from: string, to: string) => path.relative(from, to),
      resolve: (...paths: readonly string[]) => path.resolve(...paths),
      basename: (p: string) => path.basename(p),
      dirname: (p: string) => path.dirname(p),
    };
    this.fs = new AcpHostFileSystem({ sessionId } as unknown as ISessionContext, connection);
    this.process = new AcpProcessService(sessionId, cwd, connection, local);
  }

  dispose(): void {}
}

class AcpWorkspaceRuntimeAttachment implements RuntimeProviderAttachment {
  private readonly sessions = new Map<string, { remove(): Promise<void> }>();

  constructor(
    private readonly workspace: RuntimeProviderContext,
    private readonly host: RuntimeProviderHost,
    private readonly connection: IAcpConnection,
    private readonly environment: IHostEnvironment,
    private readonly local: IHostProcessService,
  ) {}

  bindSession(sessionId: string, cwd: string): string {
    const runtimeId = AcpRuntimeProviderFactory.runtimeId(sessionId);
    if (this.sessions.has(sessionId)) return runtimeId;
    const registration = this.host.registerRuntime(
      new AcpSessionRuntime(
        this.workspace.id,
        sessionId,
        cwd,
        this.connection,
        this.environment,
        this.local,
      ),
    );
    this.sessions.set(sessionId, registration);
    return runtimeId;
  }

  async unbindSession(sessionId: string): Promise<void> {
    const registration = this.sessions.get(sessionId);
    if (registration === undefined) return;
    this.sessions.delete(sessionId);
    await registration.remove();
  }

  async dispose(): Promise<void> {
    const registrations = [...this.sessions.values()];
    this.sessions.clear();
    for (const registration of registrations.reverse()) await registration.remove();
  }
}

export class AcpRuntimeProviderFactory implements RuntimeProviderFactory {
  readonly id = 'acp';
  readonly imports = { root: [], imports: [], local: [] };
  private readonly attachments = new Map<string, AcpWorkspaceRuntimeAttachment>();

  constructor(
    private readonly connection: IAcpConnection,
    private readonly environment: IHostEnvironment,
    private readonly local: IHostProcessService,
  ) {}

  static runtimeId(sessionId: string): string {
    return `acp:${sessionId}`;
  }

  async attach(workspace: RuntimeProviderContext, host: RuntimeProviderHost): Promise<RuntimeProviderAttachment> {
    const attachment = new AcpWorkspaceRuntimeAttachment(
      workspace,
      host,
      this.connection,
      this.environment,
      this.local,
    );
    this.attachments.set(workspace.id, attachment);
    return {
      dispose: async () => {
        if (this.attachments.get(workspace.id) !== attachment) return;
        this.attachments.delete(workspace.id);
        await attachment.dispose();
      },
    };
  }

  bindSession(workspaceId: string, sessionId: string, cwd: string): string {
    const attachment = this.attachments.get(workspaceId);
    if (attachment === undefined) throw new Error(`ACP runtime provider is not attached to workspace ${workspaceId}`);
    return attachment.bindSession(sessionId, cwd);
  }

  async unbindSession(workspaceId: string, sessionId: string): Promise<void> {
    await this.attachments.get(workspaceId)?.unbindSession(sessionId);
  }
}
