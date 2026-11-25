import { spawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'pathe';
import { z } from 'zod';
import { removeInjectedHeapOption } from '@kiki/node-sdk/worker-heap-policy';
import {
  desktopPluginFocusResponseSchema,
  desktopSpacesResponseSchema,
  desktopSshConnectResponseSchema,
  desktopSshProfilesResponseSchema,
  desktopSshResumeResponseSchema,
  type DesktopSshResolvedConnection,
} from '@kiki/protocol';
import { canonicalHomeKey } from '#/main/launchArgs';
import { ELECTRON_RUN_AS_NODE_ENV, filterGuiChildEnv } from '#/main/releaseRedirect';
import {
  desktopBackendLogPath,
  openDetachedBackendLogFd,
  readBackendLogTail,
} from '#/main/rotatingLog';
import type {
  BackendStagePayload,
  ConnectionConfig,
  DesktopFailureKind,
  DesktopFailurePayload,
  DesktopLogLevel,
  DesktopSpaceStatus,
  DiscoverConnectionEnvelope,
  LocalConnection,
  LocalSpaceSummary,
  PluginFocusIntent,
  SshProfile,
  SshResolvedConnection,
} from '#/shared/types';

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const HEARTBEAT_FRESHNESS_MS = 60_000;
const ENSURE_LOCK_STALE_MS = 30_000;
const RECOVERY_MAX_ATTEMPTS = 3;
const RECOVERY_STABLE_WINDOW_MS = 60_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const instanceRecordSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  host: z.string().optional(),
  serverId: z.string().optional(),
  server_id: z.string().optional(),
  startedAt: z.number().optional(),
  started_at: z.number().optional(),
  heartbeatAt: z.number().optional(),
  heartbeat_at: z.number().optional(),
});

const metaEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      server_id: z.string().optional(),
      serverId: z.string().optional(),
      current_space_id: z.string().optional(),
      server_home_id: z.string().optional(),
      home_id: z.string().optional(),
      homeId: z.string().optional(),
      build_id: z.string().nullable().optional(),
      buildId: z.string().nullable().optional(),
      build_channel: z.string().nullable().optional(),
      buildChannel: z.string().nullable().optional(),
      desktop_managed: z.boolean().optional(),
      desktopManaged: z.boolean().optional(),
    })
    .optional(),
});

const lifecycleStateSchema = z.object({
  server_id: z.string(),
  home_id: z.string(),
  managed: z.boolean(),
  draining: z.boolean(),
  hot_switch_prepared: z.boolean().optional(),
  work_pending: z.array(z.string()),
  impact: z.string().optional(),
});

export type DaemonLifecycleState = z.infer<typeof lifecycleStateSchema>;

export interface SpawnedDaemonChild {
  readonly pid?: number;
  unref(): void;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  off?(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface DaemonRuntimeDescriptor {
  readonly electronBinary: string;
  readonly serverEntry: string;
  readonly homeDir: string;
  readonly oauthHomeDir?: string;
  readonly buildId?: string;
  readonly buildChannel?: string;
  readonly logLevel?: DesktopLogLevel;
  readonly idleExit?: boolean;
}

export interface DaemonSupervisorDeps {
  readonly fetchFn?: typeof fetch;
  readonly spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedDaemonChild;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly openLogFd?: (homeDir: string) => { readonly path: string; readonly fd: number };
  readonly closeFd?: (fd: number) => void;
  readonly readLogTail?: (homeDir: string) => Promise<readonly string[]>;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly totalMemoryBytes?: () => number;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly autoRecoverManagedExit?: boolean;
}

export interface StopManagedDaemonResult {
  readonly stopped: boolean;
  readonly reason: 'stopped' | 'not-running' | 'external' | 'pending-work';
  readonly pendingWork?: readonly string[];
}

interface EnsureLease {
  transferTo(pid: number): Promise<void>;
  retain(): void;
}

export function computeDaemonHeapMb(totalMemoryBytes: number): number {
  return Math.max(8192, Math.floor(totalMemoryBytes / 1_048_576 / 4));
}

export function buildDaemonNodeOptions(
  existingNodeOptions: string,
  totalMemoryBytes: number = totalmem(),
): { readonly nodeOptions: string; readonly injectedHeapOption: string } {
  const normalized = existingNodeOptions.replaceAll('_', '-');
  if (normalized.includes('--max-old-space-size')) {
    return { nodeOptions: existingNodeOptions, injectedHeapOption: '' };
  }
  const heapOption = `--max-old-space-size=${computeDaemonHeapMb(totalMemoryBytes)}`;
  const trimmed = existingNodeOptions.trim();
  return {
    nodeOptions: trimmed === '' ? heapOption : `${trimmed} ${heapOption}`,
    injectedHeapOption: heapOption,
  };
}

export function buildDaemonSpawnEnv(
  descriptor: DaemonRuntimeDescriptor,
  baseEnv: NodeJS.ProcessEnv = process.env,
  totalMemoryBytes: number = totalmem(),
): NodeJS.ProcessEnv {
  const cleanEnv = filterGuiChildEnv(baseEnv);
  removeInjectedHeapOption(cleanEnv);
  const { nodeOptions, injectedHeapOption } = buildDaemonNodeOptions(
    cleanEnv['NODE_OPTIONS'] ?? '',
    totalMemoryBytes,
  );
  const threadpoolSize = cleanEnv['UV_THREADPOOL_SIZE']?.trim() || '32';

  cleanEnv[ELECTRON_RUN_AS_NODE_ENV] = '1';
  cleanEnv['KIKI_HOME'] = descriptor.homeDir;
  cleanEnv['KIKI_DESKTOP_BUNDLED'] = '1';
  cleanEnv['NODE_OPTIONS'] = nodeOptions;
  cleanEnv['UV_THREADPOOL_SIZE'] = threadpoolSize;
  if (injectedHeapOption !== '') {
    cleanEnv['KIKI_INJECTED_HEAP_OPTION'] = injectedHeapOption;
  }
  if (descriptor.oauthHomeDir !== undefined) {
    cleanEnv['KIKI_DESKTOP_OAUTH_HOME'] = descriptor.oauthHomeDir;
  }
  if (descriptor.buildId !== undefined && descriptor.buildId !== '') {
    cleanEnv['KIKI_BUILD_ID'] = descriptor.buildId;
  }
  if (descriptor.buildChannel !== undefined && descriptor.buildChannel !== '') {
    cleanEnv['KIKI_BUILD_CHANNEL'] = descriptor.buildChannel;
  }
  return cleanEnv;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal });
}

interface VerifiedBackend {
  readonly config: ConnectionConfig;
  readonly serverId: string;
  readonly homeId: string;
  readonly managed: boolean;
}

export class DaemonSupervisor extends EventEmitter {
  private readonly fetchFn: typeof fetch;
  private readonly spawnFn: NonNullable<DaemonSupervisorDeps['spawnFn']>;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly openLogFd: NonNullable<DaemonSupervisorDeps['openLogFd']>;
  private readonly closeFd: (fd: number) => void;
  private readonly readLogTail: NonNullable<DaemonSupervisorDeps['readLogTail']>;
  private readonly now: () => number;
  private readonly sleep: NonNullable<DaemonSupervisorDeps['sleep']>;
  private readonly totalMemoryBytes: () => number;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly autoRecoverManagedExit: boolean;

  private descriptor: DaemonRuntimeDescriptor;
  private attached: VerifiedBackend | null = null;
  private discoveryFlight: Promise<LocalConnection> | null = null;
  private startupAbort: AbortController | null = null;
  private preReadyChild: SpawnedDaemonChild | null = null;
  private readonly cancelledChildren = new WeakSet<SpawnedDaemonChild>();
  private stagedScopeHandoff: { profile: SshProfile; connection: SshResolvedConnection } | null = null;
  private intentionalStopCount = 0;
  private detachedFromUi = false;
  private recoveryAttempts = 0;
  private lastReadyAt = 0;
  private recoveryInFlight: Promise<void> | null = null;

  constructor(descriptor: DaemonRuntimeDescriptor, deps: DaemonSupervisorDeps = {}) {
    super();
    this.descriptor = descriptor;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.spawnFn = deps.spawnFn ?? ((cmd, args, opts) => spawn(cmd, [...args], opts));
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
    this.openLogFd = deps.openLogFd ?? openDetachedBackendLogFd;
    this.closeFd = deps.closeFd ?? closeSync;
    this.readLogTail = deps.readLogTail ?? ((homeDir) => readBackendLogTail(homeDir, 100));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.totalMemoryBytes = deps.totalMemoryBytes ?? totalmem;
    this.startupTimeoutMs = deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.baseEnv = deps.baseEnv ?? process.env;
    this.autoRecoverManagedExit = deps.autoRecoverManagedExit ?? false;
  }

  get activeHomeDir(): string {
    return this.descriptor.homeDir;
  }

  get currentConnection(): ConnectionConfig | null {
    return this.attached?.config ?? null;
  }

  get isAttachedManaged(): boolean {
    return this.attached?.managed === true;
  }

  private isActiveHome(homeDir: string): boolean {
    return canonicalHomeKey(homeDir) === canonicalHomeKey(this.descriptor.homeDir);
  }

  setTargetHome(homeDir: string, oauthHomeDir?: string): void {
    if (this.isActiveHome(homeDir)) return;
    this.discoveryFlight?.catch(() => undefined);
    this.startupAbort?.abort(new Error('A newer space switch replaced this request'));
    this.startupAbort = null;
    this.discoveryFlight = null;
    this.descriptor = {
      ...this.descriptor,
      homeDir,
      oauthHomeDir: oauthHomeDir ?? this.descriptor.oauthHomeDir,
    };
    this.attached = null;
    this.recoveryAttempts = 0;
    this.lastReadyAt = 0;
  }

  onBackendStage(listener: (payload: BackendStagePayload) => void): () => void {
    this.on('stage', listener);
    return () => {
      this.off('stage', listener);
    };
  }

  private emitStagePayload(payload: BackendStagePayload): void {
    this.emit('stage', payload);
  }

  private async buildFailurePayload(
    homeDir: string,
    error: unknown,
    kind?: DesktopFailureKind,
  ): Promise<DesktopFailurePayload> {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const stderrTail = await this.readLogTail(homeDir).catch(() => []);
    const candidateLogPath = desktopBackendLogPath(homeDir);
    const logPath = existsSync(candidateLogPath) || stderrTail.length > 0 ? candidateLogPath : null;
    const message =
      stderrTail.length > 0 && !baseMessage.includes('stderr (last ')
        ? `${baseMessage}\nstderr (last ${stderrTail.length} lines):\n${stderrTail.join('\n')}`
        : baseMessage;
    return {
      ...(kind !== undefined ? { kind } : {}),
      message,
      stderrTail,
      logPath,
    };
  }

  private async readOwnerToken(homeDir: string): Promise<string | null> {
    try {
      const token = (await readFile(join(homeDir, 'server.local-owner'), 'utf8')).trim();
      return token === '' ? null : token;
    } catch {
      return null;
    }
  }

  private async readLiveInstanceRecords(homeDir: string): Promise<Array<z.infer<typeof instanceRecordSchema>>> {
    const dir = join(homeDir, 'server', 'instances');
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const records: Array<z.infer<typeof instanceRecordSchema>> = [];
    const nowMs = this.now();
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(dir, entry), 'utf8');
        const parsed = instanceRecordSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) continue;
        const record = parsed.data;
        if (record.host !== undefined && !LOOPBACK_HOSTS.has(record.host.toLowerCase())) continue;
        if (!this.isPidAlive(record.pid)) continue;
        const heartbeatAt = record.heartbeat_at ?? record.heartbeatAt;
        if (heartbeatAt !== undefined && nowMs - heartbeatAt > HEARTBEAT_FRESHNESS_MS) {
          continue;
        }
        records.push(record);
      } catch {
        continue;
      }
    }
    return records;
  }

  private async verifyEndpoint(
    port: number,
    token: string,
    signal?: AbortSignal,
  ): Promise<VerifiedBackend | null> {
    const url = `http://127.0.0.1:${port}`;
    const timeoutSignal = AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS);
    const combinedSignal =
      signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await this.fetchFn(`${url}/api/meta`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: combinedSignal,
      });
      if (!response.ok) return null;
      const parsed = metaEnvelopeSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.code !== 0 || parsed.data.data === undefined) return null;
      const data = parsed.data.data;
      const serverId = data.server_id ?? data.serverId ?? '';
      const homeId = data.current_space_id ?? data.home_id ?? data.homeId ?? 'main';
      if (this.descriptor.buildId !== undefined && this.descriptor.buildId !== '') {
        const reportedBuild = data.build_id ?? data.buildId;
        if (reportedBuild !== null && reportedBuild !== undefined && reportedBuild !== this.descriptor.buildId) {
          return null;
        }
      }
      return {
        config: { url, token },
        serverId,
        homeId,
        managed: data.desktop_managed ?? data.desktopManaged ?? false,
      };
    } catch {
      return null;
    }
  }

  private async discoverVerifiedForHome(
    homeDir: string,
    signal?: AbortSignal,
  ): Promise<VerifiedBackend | null> {
    if (this.isActiveHome(homeDir) && this.attached !== null) {
      const parsedUrl = URL.parse(this.attached.config.url);
      const port = parsedUrl !== null ? Number(parsedUrl.port) : 0;
      if (port > 0) {
        const verified = await this.verifyEndpoint(port, this.attached.config.token, signal);
        if (verified !== null) {
          if (this.isActiveHome(homeDir)) {
            this.attached = verified;
          }
          return verified;
        }
      }
      if (this.isActiveHome(homeDir)) {
        this.attached = null;
      }
    }
    const token = await this.readOwnerToken(homeDir);
    if (token === null) return null;
    const records = await this.readLiveInstanceRecords(homeDir);
    for (const record of records) {
      const verified = await this.verifyEndpoint(record.port, token, signal);
      if (verified !== null) {
        if (this.isActiveHome(homeDir)) {
          this.attached = verified;
        }
        return verified;
      }
    }
    return null;
  }

  private async withEnsureLock<T>(
    homeDir: string,
    work: (lease: EnsureLease) => Promise<T>,
    signal: AbortSignal,
    onWait: () => Promise<T | null>,
  ): Promise<T> {
    const serverDir = join(homeDir, 'server');
    const lockPath = join(serverDir, 'ensure.lock');
    await mkdir(serverDir, { recursive: true });
    const deadline = this.now() + this.startupTimeoutMs;

    for (;;) {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('Desktop daemon startup was cancelled');
      }
      if (this.now() >= deadline) {
        throw new Error(
          'This space is still starting or updating. Keep its owner running and retry when it finishes; its lifecycle lock was not removed.',
        );
      }

      let handle;
      try {
        handle = await open(lockPath, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const ready = await onWait();
        if (signal.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error('Desktop daemon startup was cancelled');
        }
        if (ready !== null) return ready;

        let info;
        try {
          info = await stat(lockPath);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }

        const ownerText = (await readFile(lockPath, 'utf8').catch(() => '')).trim();
        const ownerPid = Number(ownerText);
        const ownerAlive =
          Number.isInteger(ownerPid) && ownerPid > 0 ? this.isPidAlive(ownerPid) : false;

        if (
          !ownerAlive &&
          (ownerPid > 0 || this.now() - info.mtimeMs >= ENSURE_LOCK_STALE_MS) &&
          (await readFile(lockPath, 'utf8').catch(() => '')).trim() === ownerText
        ) {
          await unlink(lockPath).catch(() => undefined);
        } else {
          await this.sleep(Math.min(100, this.pollIntervalMs), signal);
        }
        continue;
      }

      let owner = String(process.pid);
      let release = true;
      try {
        await handle.writeFile(owner);
        await handle.close();
        return await work({
          transferTo: async (pid: number) => {
            if (!Number.isSafeInteger(pid) || pid <= 0) {
              throw new Error('The starting server has no valid PID');
            }
            if ((await readFile(lockPath, 'utf8').catch(() => '')).trim() !== owner) {
              throw new Error('The service startup lease changed ownership');
            }
            const leaseHandle = await open(lockPath, 'r+');
            try {
              await leaseHandle.truncate(0);
              await leaseHandle.write(String(pid), 0, 'utf8');
              owner = String(pid);
            } finally {
              await leaseHandle.close();
            }
          },
          retain: () => {
            release = false;
          },
        });
      } finally {
        await handle.close().catch(() => undefined);
        if (release && (await readFile(lockPath, 'utf8').catch(() => '')).trim() === owner) {
          await unlink(lockPath).catch(() => undefined);
        }
      }
    }
  }

  private async stopUnreadyChild(child: SpawnedDaemonChild): Promise<boolean> {
    if (child.pid === undefined || !this.isPidAlive(child.pid)) return true;
    let resolvedExit = false;
    const exitPromise = new Promise<boolean>((resolve) => {
      const onExit = (): void => {
        resolvedExit = true;
        resolve(true);
      };
      child.on('exit', onExit);
    });
    if (!this.cancelledChildren.has(child)) {
      this.cancelledChildren.add(child);
      try {
        child.kill('SIGTERM');
      } catch {
        return !this.isPidAlive(child.pid);
      }
    }
    if (resolvedExit || !this.isPidAlive(child.pid)) return true;
    const exited = await Promise.race([
      exitPromise,
      this.sleep(Math.min(2_000, this.pollIntervalMs * 10)).then(() => !this.isPidAlive(child.pid!)),
    ]);
    return exited;
  }

  /**
   * Non-spawning discovery for `--tray-only`: attaches only if a verified daemon is already running.
   */
  async attachIfRunning(signal?: AbortSignal): Promise<LocalConnection | null> {
    const verified = await this.discoverVerifiedForHome(this.descriptor.homeDir, signal);
    return verified !== null ? { config: verified.config, persist: false } : null;
  }

  async discoverConnection(): Promise<LocalConnection> {
    if (this.discoveryFlight !== null) return this.discoveryFlight;
    this.detachedFromUi = false;
    const abort = new AbortController();
    this.startupAbort = abort;
    const flight = this.ensureDaemonForHome(this.descriptor.homeDir, {
      active: true,
      signal: abort.signal,
    }).finally(() => {
      if (this.discoveryFlight === flight) this.discoveryFlight = null;
      if (this.startupAbort === abort) this.startupAbort = null;
    });
    this.discoveryFlight = flight;
    return flight;
  }

  async discoverConnectionEnvelope(): Promise<DiscoverConnectionEnvelope> {
    try {
      const connection = await this.discoverConnection();
      return { ok: true, connection };
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'stderrTail' in error &&
        'logPath' in error &&
        'message' in error &&
        typeof (error as { message: unknown }).message === 'string'
      ) {
        const enriched = error as DesktopFailurePayload;
        return {
          ok: false,
          failure: {
            ...(enriched.kind !== undefined ? { kind: enriched.kind } : {}),
            message: enriched.message,
            stderrTail: enriched.stderrTail,
            logPath: enriched.logPath,
          },
        };
      }
      const failure = await this.buildFailurePayload(this.descriptor.homeDir, error);
      return { ok: false, failure };
    }
  }

  private async ensureDaemonForHome(
    homeDir: string,
    options: {
      readonly active: boolean;
      readonly signal: AbortSignal;
    },
  ): Promise<LocalConnection> {
    const { active, signal } = options;
    if (active) {
      this.emitStagePayload({ stage: 'checking' });
    }

    const existing = await this.discoverVerifiedForHome(homeDir, signal);
    if (existing !== null) {
      if (active && this.isActiveHome(homeDir)) {
        this.attached = existing;
        this.lastReadyAt = this.now();
        this.emitStagePayload({
          stage: 'ready',
          connection: existing.config,
          homeId: existing.homeId,
        });
      }
      return { config: existing.config, persist: false };
    }

    try {
      const verified = await this.withEnsureLock<VerifiedBackend>(
        homeDir,
        async (lease) => {
          const raced = await this.discoverVerifiedForHome(homeDir, signal);
          if (raced !== null) return raced;

          if (active) {
            this.emitStagePayload('waiting');
          }

          const drainDeadline = this.now() + this.startupTimeoutMs;
          while ((await this.readLiveInstanceRecords(homeDir)).length > 0) {
            if (signal.aborted) {
              throw signal.reason instanceof Error
                ? signal.reason
                : new Error('Desktop daemon startup was cancelled');
            }
            const recovered = await this.discoverVerifiedForHome(homeDir, signal);
            if (recovered !== null) return recovered;
            if (this.now() >= drainDeadline) {
              throw new Error(
                'A live Kiki service in this home is still draining or unreachable. Retry after it stops; no second service was started.',
              );
            }
            await this.sleep(this.pollIntervalMs, signal);
          }

          if (active) {
            this.emitStagePayload({ stage: 'starting' });
            this.emitStagePayload('waiting');
          }

          const targetDescriptor: DaemonRuntimeDescriptor = this.isActiveHome(homeDir)
            ? this.descriptor
            : {
                ...this.descriptor,
                homeDir,
                idleExit: true,
              };
          const logLevel = targetDescriptor.logLevel ?? 'warn';
          const idleExit = targetDescriptor.idleExit === true ? '30m' : '0ms';
          const totalMem = this.totalMemoryBytes();
          const heapArg = `--max-old-space-size=${computeDaemonHeapMb(totalMem)}`;
          const args = [
            heapArg,
            targetDescriptor.serverEntry,
            'serve',
            '--port',
            '0',
            '--log-level',
            logLevel,
            '--idle-exit',
            idleExit,
          ];
          const env = buildDaemonSpawnEnv(targetDescriptor, this.baseEnv, totalMem);

          let logFd: number | undefined;
          try {
            logFd = this.openLogFd(homeDir).fd;
          } catch {
            logFd = undefined;
          }

          const childStatus: {
            exited: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
            spawnError: Error | null;
          } = { exited: null, spawnError: null };

          const child = this.spawnFn(targetDescriptor.electronBinary, args, {
            env,
            detached: true,
            windowsHide: true,
            stdio: logFd !== undefined ? ['ignore', logFd, logFd] : 'ignore',
          });
          if (logFd !== undefined) {
            this.closeFd(logFd);
          }

          if (active) {
            this.preReadyChild = child;
          }
          child.on('exit', (code, exitSignal) => {
            childStatus.exited = { code, signal: exitSignal };
            if (active && this.preReadyChild === child) {
              this.preReadyChild = null;
            }
          });
          child.on('error', (error) => {
            childStatus.spawnError = error;
            if (active && this.preReadyChild === child) {
              this.preReadyChild = null;
            }
          });

          let becameReady = false;
          try {
            if (child.pid !== undefined && child.pid > 0) {
              await lease.transferTo(child.pid);
            }

            const deadline = this.now() + this.startupTimeoutMs;
            while (this.now() < deadline) {
              if (signal.aborted) {
                throw new Error('Desktop daemon startup was cancelled');
              }
              if (childStatus.spawnError !== null) {
                throw new Error(`Cannot start Kiki backend: ${childStatus.spawnError.message}`);
              }
              if (childStatus.exited !== null) {
                throw new Error(
                  `Kiki backend exited during startup (code ${String(childStatus.exited.code)}, signal ${String(childStatus.exited.signal)})`,
                );
              }

              const token = await this.readOwnerToken(homeDir);
              if (token !== null) {
                const records = await this.readLiveInstanceRecords(homeDir);
                const matching =
                  child.pid !== undefined
                    ? records.filter((record) => record.pid === child.pid)
                    : records;
                for (const record of matching) {
                  const candidate = await this.verifyEndpoint(record.port, token, signal);
                  if (candidate !== null) {
                    becameReady = true;
                    if (active && this.preReadyChild === child) {
                      this.preReadyChild = null;
                    }
                    child.unref();
                    if (active && this.autoRecoverManagedExit) {
                      this.attachRuntimeExitWatcher(child, homeDir, candidate.serverId);
                    }
                    return candidate;
                  }
                }
              }

              await this.sleep(this.pollIntervalMs, signal);
            }

            throw new Error(
              `Kiki backend did not become ready within ${Math.round(this.startupTimeoutMs / 1000)}s`,
            );
          } catch (spawnAttemptError) {
            if (!becameReady) {
              if (active && this.preReadyChild === child) {
                this.preReadyChild = null;
              }
              const stopped = await this.stopUnreadyChild(child);
              if (!stopped) {
                lease.retain();
              }
            }
            throw spawnAttemptError;
          }
        },
        signal,
        () => this.discoverVerifiedForHome(homeDir, signal),
      );

      if (active && this.isActiveHome(homeDir)) {
        this.attached = verified;
        this.lastReadyAt = this.now();
        this.emitStagePayload({
          stage: 'ready',
          connection: verified.config,
          homeId: verified.homeId,
        });
      }
      return { config: verified.config, persist: false };
    } catch (error) {
      const normalizedError =
        signal.aborted && signal.reason instanceof Error ? signal.reason : error;
      if (active && this.isActiveHome(homeDir)) {
        const failure = await this.buildFailurePayload(homeDir, normalizedError);
        this.emitStagePayload({
          stage: 'failed',
          message: failure.message,
          failure,
          homeId: this.attached?.homeId,
        });
        throw Object.assign(
          normalizedError instanceof Error ? normalizedError : new Error(failure.message),
          failure,
        );
      }
      throw normalizedError;
    }
  }

  private attachRuntimeExitWatcher(
    child: SpawnedDaemonChild,
    homeDir: string,
    serverId: string,
  ): void {
    child.on('exit', () => {
      if (this.detachedFromUi || this.intentionalStopCount > 0) return;
      if (!this.isActiveHome(homeDir)) return;
      if (this.attached !== null && this.attached.serverId !== serverId) return;
      this.attached = null;
      void this.triggerManagedRecovery('unexpected_exit');
    });
  }

  async checkHealthAndRecoverIfNeeded(): Promise<void> {
    if (this.detachedFromUi || this.intentionalStopCount > 0 || this.discoveryFlight !== null) return;
    if (this.attached === null || !this.attached.managed) return;
    const parsedUrl = URL.parse(this.attached.config.url);
    const port = parsedUrl !== null ? Number(parsedUrl.port) : 0;
    if (port <= 0) return;
    const healthy = await this.verifyEndpoint(port, this.attached.config.token);
    if (healthy !== null) {
      this.attached = healthy;
      if (this.lastReadyAt > 0 && this.now() - this.lastReadyAt >= RECOVERY_STABLE_WINDOW_MS) {
        this.recoveryAttempts = 0;
      }
      return;
    }
    this.attached = null;
    await this.triggerManagedRecovery('health_unreachable');
  }

  private async triggerManagedRecovery(reason: string): Promise<void> {
    if (this.recoveryInFlight !== null) return this.recoveryInFlight;
    const run = (async () => {
      if (this.lastReadyAt > 0 && this.now() - this.lastReadyAt >= RECOVERY_STABLE_WINDOW_MS) {
        this.recoveryAttempts = 0;
      }
      if (this.recoveryAttempts >= RECOVERY_MAX_ATTEMPTS) {
        const exhaustedError = new Error(
          `Kiki backend stopped repeatedly (${reason}); automatic recovery paused after ${RECOVERY_MAX_ATTEMPTS} attempts.`,
        );
        const failure = await this.buildFailurePayload(
          this.descriptor.homeDir,
          exhaustedError,
          'protocol',
        );
        this.emitStagePayload({
          stage: 'failed',
          message: failure.message,
          failure,
        });
        return;
      }
      this.recoveryAttempts += 1;
      try {
        await this.discoverConnection();
      } catch {
        // Stage 'failed' has already been emitted by ensureDaemonForHome.
      }
    })().finally(() => {
      if (this.recoveryInFlight === run) {
        this.recoveryInFlight = null;
      }
    });
    this.recoveryInFlight = run;
    return run;
  }

  /**
   * Cancels an in-flight pre-ready startup and terminates ONLY the pre-ready child
   * spawned by this attempt. Never stops an already-ready shared daemon.
   */
  async cancelStartup(): Promise<void> {
    const child = this.preReadyChild;
    this.preReadyChild = null;
    this.startupAbort?.abort(new Error('Desktop daemon startup was cancelled'));
    if (child !== null && !this.cancelledChildren.has(child)) {
      this.cancelledChildren.add(child);
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore already-exited pre-ready child.
      }
    }
    await this.discoveryFlight?.catch(() => undefined);
  }

  /**
   * Detaches desktop UI ownership on ordinary window close or non-tray exit.
   * Kills any unready startup child, but deliberately leaves a ready shared daemon running.
   */
  detachDesktop(): void {
    this.detachedFromUi = true;
    const preReady = this.preReadyChild;
    this.preReadyChild = null;
    this.startupAbort?.abort(new Error('Desktop window closed during startup'));
    if (preReady !== null && !this.cancelledChildren.has(preReady)) {
      this.cancelledChildren.add(preReady);
      try {
        preReady.kill('SIGTERM');
      } catch {
        // Ignore already-exited pre-ready child.
      }
    }
  }

  async readLifecycleStateForHome(homeDir: string): Promise<{
    readonly backend: VerifiedBackend;
    readonly state: DaemonLifecycleState;
  } | null> {
    const backend = await this.discoverVerifiedForHome(homeDir);
    if (backend === null) return null;
    const response = await this.fetchFn(`${backend.config.url}/api/desktop-lifecycle`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${backend.config.token}` },
      signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { code?: number; data?: unknown };
    if (payload.code !== 0) return null;
    const parsed = lifecycleStateSchema.safeParse(payload.data);
    return parsed.success ? { backend, state: parsed.data } : null;
  }

  async readLifecycleState(): Promise<DaemonLifecycleState | null> {
    const resolved = await this.readLifecycleStateForHome(this.descriptor.homeDir);
    return resolved?.state ?? null;
  }

  /**
   * Home-scoped managed stop: stops a desktop-managed local daemon for `homeDir`
   * without mutating the active window's bound target home or connection unless
   * `homeDir` is the active home itself. Never kills externally managed daemons.
   */
  async stopManagedDaemonForHome(
    homeDir: string,
    options: {
      readonly action: 'quit' | 'restart' | 'update';
      readonly interruptWork?: boolean;
    },
  ): Promise<StopManagedDaemonResult> {
    this.intentionalStopCount += 1;
    try {
      const resolved = await this.readLifecycleStateForHome(homeDir);
      if (resolved === null) {
        return { stopped: false, reason: 'not-running' };
      }
      const { backend, state } = resolved;
      if (!state.managed) {
        return { stopped: false, reason: 'external' };
      }
      if (state.work_pending.length > 0 && options.interruptWork !== true) {
        return {
          stopped: false,
          reason: 'pending-work',
          pendingWork: state.work_pending,
        };
      }

      const response = await this.fetchFn(`${backend.config.url}/api/desktop-lifecycle`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${backend.config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: options.action,
          server_id: state.server_id,
          consent: true,
          interrupt_work: options.interruptWork === true,
        }),
        signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
      });
      const payload = (await response.json()) as { code?: number; msg?: string };
      if (!response.ok || payload.code !== 0) {
        throw new Error(payload.msg ?? 'Failed to stop managed Kiki daemon');
      }
      if (this.isActiveHome(homeDir)) {
        this.attached = null;
      }
      return { stopped: true, reason: 'stopped' };
    } finally {
      this.intentionalStopCount = Math.max(0, this.intentionalStopCount - 1);
    }
  }

  async stopManagedDaemon(options: {
    readonly action: 'quit' | 'restart' | 'update';
    readonly interruptWork?: boolean;
  }): Promise<StopManagedDaemonResult> {
    return this.stopManagedDaemonForHome(this.descriptor.homeDir, options);
  }

  async restartServer(interruptWork = false): Promise<LocalConnection> {
    const result = await this.stopManagedDaemon({ action: 'restart', interruptWork });
    if (result.reason === 'external') {
      throw new Error(
        'The connected Kiki daemon is externally managed; restart is unsupported from this desktop window',
      );
    }
    if (result.reason === 'pending-work') {
      throw new Error(
        'Some work is still settling; wait for its saved outcome before restarting this service',
      );
    }
    this.recoveryAttempts = 0;
    return this.discoverConnection();
  }

  /**
   * Restarts ONLY `homeDir`'s daemon. When `homeDir` is a background sibling space,
   * the active window's `descriptor.homeDir` and `attached` connection remain untouched.
   */
  async restartSpace(homeDir: string, interruptWork = false): Promise<LocalConnection> {
    if (this.isActiveHome(homeDir)) {
      return this.restartServer(interruptWork);
    }
    const result = await this.stopManagedDaemonForHome(homeDir, {
      action: 'restart',
      interruptWork,
    });
    if (result.reason === 'external') {
      throw new Error(
        'The target space daemon is externally managed; restart is unsupported from this desktop window',
      );
    }
    if (result.reason === 'pending-work') {
      throw new Error(
        'Some work in that space is still settling; wait for its saved outcome before restarting it',
      );
    }
    const abort = new AbortController();
    return this.ensureDaemonForHome(homeDir, {
      active: false,
      signal: abort.signal,
    });
  }

  private async requestDesktopApi<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const conn = this.attached?.config ?? (await this.discoverConnection()).config;
    const response = await this.fetchFn(`${conn.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${conn.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
    });
    const envelope = (await response.json()) as { code?: number; msg?: string; data?: T };
    if (!response.ok || envelope.code !== 0 || envelope.data === undefined) {
      throw new Error(envelope.msg ?? `Desktop API ${method} ${path} failed (${response.status})`);
    }
    return envelope.data;
  }

  private normalizeSshConnection(connection: DesktopSshResolvedConnection): SshResolvedConnection {
    return {
      config: connection.config,
      tunnelId: connection.tunnelId,
      serverHomeId: connection.serverHomeId,
      serverInstanceId: connection.serverInstanceId,
      serverVersion: connection.serverVersion,
      buildId: connection.buildId ?? null,
      buildChannel: connection.buildChannel ?? null,
    };
  }

  async listSshProfiles(): Promise<SshProfile[]> {
    const raw = await this.requestDesktopApi<unknown>('GET', '/api/desktop/ssh/profiles');
    return desktopSshProfilesResponseSchema.parse(raw).profiles;
  }

  async saveSshProfile(profile: SshProfile): Promise<SshProfile[]> {
    const raw = await this.requestDesktopApi<unknown>(
      'PUT',
      '/api/desktop/ssh/profiles',
      { profile },
    );
    return desktopSshProfilesResponseSchema.parse(raw).profiles;
  }

  async removeSshProfile(id: string): Promise<SshProfile[]> {
    const raw = await this.requestDesktopApi<unknown>(
      'DELETE',
      `/api/desktop/ssh/profiles/${encodeURIComponent(id)}`,
    );
    return desktopSshProfilesResponseSchema.parse(raw).profiles;
  }

  async connectSshProfile(id: string, token: string, staged = false): Promise<SshResolvedConnection> {
    const raw = await this.requestDesktopApi<unknown>(
      'POST',
      '/api/desktop/ssh/connect',
      { id, token, home_id: this.attached?.homeId, staged },
    );
    return this.normalizeSshConnection(desktopSshConnectResponseSchema.parse(raw).connection);
  }

  async resumeScopeConnection(
    homeId: string,
    id: string,
    tunnelId: string,
  ): Promise<{ profile: SshProfile; connection: SshResolvedConnection }> {
    const raw = await this.requestDesktopApi<unknown>(
      'POST',
      '/api/desktop/ssh/resume',
      { home_id: homeId, id, tunnel_id: tunnelId },
    );
    const parsed = desktopSshResumeResponseSchema.parse(raw);
    return {
      profile: parsed.profile,
      connection: this.normalizeSshConnection(parsed.connection),
    };
  }

  async commitScopeConnection(
    homeId: string,
    id: string,
    tunnelId: string,
    reload: boolean,
  ): Promise<void> {
    if (reload) {
      this.stagedScopeHandoff = await this.resumeScopeConnection(homeId, id, tunnelId);
    }
    await this.requestDesktopApi<{ committed: true }>('POST', '/api/desktop/ssh/commit', {
      home_id: homeId,
      id,
      tunnel_id: tunnelId,
      reload,
    });
  }

  takeScopeConnection(): { profile: SshProfile; connection: SshResolvedConnection } | null {
    const handoff = this.stagedScopeHandoff;
    this.stagedScopeHandoff = null;
    return handoff;
  }

  async sshTunnelRunning(id: string, tunnelId: string): Promise<boolean> {
    const data = await this.requestDesktopApi<{ running: boolean }>(
      'GET',
      `/api/desktop/ssh/tunnels/${encodeURIComponent(id)}/${encodeURIComponent(tunnelId)}`,
    );
    return data.running;
  }

  async disconnectSshProfile(id: string, tunnelId: string): Promise<void> {
    await this.requestDesktopApi<{ disconnected: true }>(
      'DELETE',
      `/api/desktop/ssh/tunnels/${encodeURIComponent(id)}/${encodeURIComponent(tunnelId)}`,
    );
  }

  async listSpacesAndStatuses(activeHomeId?: string): Promise<{
    readonly spaces: LocalSpaceSummary[];
    readonly statuses: DesktopSpaceStatus[];
  }> {
    const raw = await this.requestDesktopApi<unknown>('GET', '/api/desktop/spaces');
    const parsed = desktopSpacesResponseSchema.parse(raw);
    const effectiveActive = activeHomeId ?? this.attached?.homeId;
    const statusByHome = new Map(parsed.statuses.map((entry) => [entry.home_id, entry]));

    const spaces: LocalSpaceSummary[] = parsed.spaces.map((entry) => {
      const wireStatus = statusByHome.get(entry.home_id);
      const active =
        effectiveActive !== undefined ? entry.home_id === effectiveActive : wireStatus?.state === 'active';
      const status: LocalSpaceSummary['status'] = !entry.running
        ? 'stopped'
        : active
          ? 'running'
          : 'background';
      return {
        homeId: entry.home_id,
        name: entry.name,
        path: entry.path,
        status,
        active,
        ...(entry.desktop_managed !== undefined ? { managed: entry.desktop_managed } : {}),
      };
    });

    const statuses: DesktopSpaceStatus[] = parsed.statuses.map((entry) => ({
      homeId: entry.home_id,
      active: effectiveActive !== undefined ? entry.home_id === effectiveActive : entry.state === 'active',
      hot: entry.state !== 'offline',
      pendingCount: entry.needs_you_sessions,
      busyCount: entry.busy_sessions,
      ...(entry.needs_you_session_ids !== undefined
        ? { needsYouSessionIds: entry.needs_you_session_ids }
        : {}),
    }));

    return { spaces, statuses };
  }

  async readPluginFocus(homeId?: string): Promise<PluginFocusIntent | null> {
    const targetHome = homeId ?? this.attached?.homeId;
    const query = targetHome !== undefined ? `?home_id=${encodeURIComponent(targetHome)}` : '';
    const raw = await this.requestDesktopApi<unknown>(
      'GET',
      `/api/desktop/plugin-focus${query}`,
    );
    return desktopPluginFocusResponseSchema.parse(raw).focus;
  }

  async ackPluginFocus(homeId: string, requestId: number): Promise<void> {
    await this.requestDesktopApi<{ cleared: boolean }>('POST', '/api/desktop/plugin-focus/ack', {
      home_id: homeId,
      request_id: requestId,
    });
  }

  async rememberPluginFocus(homeId: string, requestId: number): Promise<void> {
    await this.requestDesktopApi<{ remembered: true }>('POST', '/api/desktop/plugin-focus/remember', {
      home_id: homeId,
      request_id: requestId,
    });
  }
}
