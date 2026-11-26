import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { join } from 'pathe';
import { z } from 'zod';
import { removeInjectedHeapOption } from '@kiki/node-sdk/worker-heap-policy';
import {
  desktopPluginFocusResponseSchema,
  desktopSpacesResponseSchema,
  desktopSshConnectResponseSchema,
  desktopSshProfilesResponseSchema,
  desktopSshResumeResponseSchema,
  isLoopbackHost,
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

const execFileAsync = promisify(execFile);

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_QUIT_PROBE_TIMEOUT_MS = 600;
const DEFAULT_QUIT_GRACE_MS = 1_200;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
const QUIT_PLAN_CACHE_TTL_MS = 15_000;
const HEARTBEAT_FRESHNESS_MS = 60_000;
const ENSURE_LOCK_STALE_MS = 30_000;
const RECOVERY_MAX_ATTEMPTS = 3;
const RECOVERY_STABLE_WINDOW_MS = 60_000;

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
  readonly forceKillPidTree?: (pid: number) => Promise<void>;
  readonly openLogFd?: (homeDir: string) => { readonly path: string; readonly fd: number };
  readonly closeFd?: (fd: number) => void;
  readonly readLogTail?: (homeDir: string) => Promise<readonly string[]>;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly totalMemoryBytes?: () => number;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly quitProbeTimeoutMs?: number;
  readonly quitGraceMs?: number;
  readonly shutdownGraceMs?: number;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly autoRecoverManagedExit?: boolean;
}

export interface ProbedHomeLifecycle {
  readonly backend: VerifiedBackend;
  readonly state: DaemonLifecycleState;
}

export interface ManagedQuitPlan {
  readonly pendingWork: string[];
  readonly byHomeKey: ReadonlyMap<string, ProbedHomeLifecycle | null>;
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

const EXPLICIT_HEAP_FLAG_RE = /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)(?=\s|$)/i;

export function computeDaemonHeapMb(totalMemoryBytes: number): number {
  return Math.max(8192, Math.floor(totalMemoryBytes / 1_048_576 / 4));
}

export function resolveDaemonHeapCliArg(
  existingNodeOptions: string,
  totalMemoryBytes: number = totalmem(),
): { readonly cliHeapArg: string; readonly injectedHeapOption: string } {
  const match = EXPLICIT_HEAP_FLAG_RE.exec(existingNodeOptions);
  if (match !== null && match[1] !== undefined) {
    return {
      cliHeapArg: `--max-old-space-size=${match[1]}`,
      injectedHeapOption: '',
    };
  }
  const heapOption = `--max-old-space-size=${computeDaemonHeapMb(totalMemoryBytes)}`;
  return {
    cliHeapArg: heapOption,
    injectedHeapOption: heapOption,
  };
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
  options?: { readonly heapPassedViaArgv?: boolean },
): NodeJS.ProcessEnv {
  const cleanEnv = filterGuiChildEnv(baseEnv);
  removeInjectedHeapOption(cleanEnv);
  const rawNodeOptions = cleanEnv['NODE_OPTIONS'] ?? '';
  let injectedHeapOption = '';
  if (options?.heapPassedViaArgv === true) {
    const resolved = resolveDaemonHeapCliArg(rawNodeOptions, totalMemoryBytes);
    injectedHeapOption = resolved.injectedHeapOption;
    const stripped = rawNodeOptions
      .replace(/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)\d+(?=\s|$)/gi, ' ')
      .trim();
    if (stripped === '') {
      delete cleanEnv['NODE_OPTIONS'];
    } else {
      cleanEnv['NODE_OPTIONS'] = stripped;
    }
  } else {
    const built = buildDaemonNodeOptions(rawNodeOptions, totalMemoryBytes);
    cleanEnv['NODE_OPTIONS'] = built.nodeOptions;
    injectedHeapOption = built.injectedHeapOption;
  }
  const threadpoolSize = cleanEnv['UV_THREADPOOL_SIZE']?.trim() || '32';

  cleanEnv[ELECTRON_RUN_AS_NODE_ENV] = '1';
  cleanEnv['KIKI_HOME'] = descriptor.homeDir;
  cleanEnv['KIKI_DESKTOP_BUNDLED'] = '1';
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

export async function defaultForceKillPidTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
    const taskkill = join(systemRoot, 'System32', 'taskkill.exe');
    try {
      await execFileAsync(taskkill, ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 4_000,
      });
      return;
    } catch {
      // Fall back to direct kill if taskkill fails or process already exited.
    }
    try {
      process.kill(pid);
    } catch {
      // Process already exited.
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Ignore if pid is not a process group leader.
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process already exited.
  }
}

interface VerifiedBackend {
  readonly config: ConnectionConfig;
  readonly serverId: string;
  readonly homeId: string;
  readonly managed: boolean;
  readonly pid?: number;
  readonly startedAt?: number;
}

interface ManagedHomeRecord {
  readonly homeDir: string;
  pid?: number;
  serverId?: string;
  startedAt?: number;
  spawnedByThisShell: boolean;
}

export class DaemonSupervisor extends EventEmitter {
  private readonly fetchFn: typeof fetch;
  private readonly spawnFn: NonNullable<DaemonSupervisorDeps['spawnFn']>;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly forceKillPidTree: NonNullable<DaemonSupervisorDeps['forceKillPidTree']>;
  private readonly openLogFd: NonNullable<DaemonSupervisorDeps['openLogFd']>;
  private readonly closeFd: (fd: number) => void;
  private readonly readLogTail: NonNullable<DaemonSupervisorDeps['readLogTail']>;
  private readonly now: () => number;
  private readonly sleep: NonNullable<DaemonSupervisorDeps['sleep']>;
  private readonly totalMemoryBytes: () => number;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly quitProbeTimeoutMs: number;
  private readonly quitGraceMs: number;
  private readonly shutdownGraceMs: number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly autoRecoverManagedExit: boolean;

  private descriptor: DaemonRuntimeDescriptor;
  private attached: VerifiedBackend | null = null;
  private cachedQuitPlan: { readonly at: number; readonly plan: ManagedQuitPlan } | null = null;
  private discoveryFlight: Promise<LocalConnection> | null = null;
  private startupAbort: AbortController | null = null;
  private preReadyChild: SpawnedDaemonChild | null = null;
  private readonly cancelledChildren = new WeakSet<SpawnedDaemonChild>();
  private readonly managedHomes = new Map<string, ManagedHomeRecord>();
  private stagedScopeHandoff: { profile: SshProfile; connection: SshResolvedConnection } | null = null;
  private intentionalStopCount = 0;
  private detachedFromUi = false;
  private shuttingDown = false;
  private recoveryAttempts = 0;
  private lastReadyAt = 0;
  private recoveryInFlight: Promise<void> | null = null;

  constructor(descriptor: DaemonRuntimeDescriptor, deps: DaemonSupervisorDeps = {}) {
    super();
    this.descriptor = descriptor;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.spawnFn = deps.spawnFn ?? ((cmd, args, opts) => spawn(cmd, [...args], opts));
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
    this.forceKillPidTree =
      deps.forceKillPidTree ??
      (deps.isPidAlive !== undefined
        ? async () => undefined
        : (pid) => defaultForceKillPidTree(pid));
    this.openLogFd = deps.openLogFd ?? openDetachedBackendLogFd;
    this.closeFd = deps.closeFd ?? closeSync;
    this.readLogTail = deps.readLogTail ?? ((homeDir) => readBackendLogTail(homeDir, 100));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.totalMemoryBytes = deps.totalMemoryBytes ?? totalmem;
    this.startupTimeoutMs = deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.quitProbeTimeoutMs = deps.quitProbeTimeoutMs ?? DEFAULT_QUIT_PROBE_TIMEOUT_MS;
    this.quitGraceMs = deps.quitGraceMs ?? deps.shutdownGraceMs ?? DEFAULT_QUIT_GRACE_MS;
    this.shutdownGraceMs = deps.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.baseEnv = deps.baseEnv ?? process.env;
    this.autoRecoverManagedExit = deps.autoRecoverManagedExit ?? false;
    this.managedHomes.set(canonicalHomeKey(descriptor.homeDir), {
      homeDir: descriptor.homeDir,
      spawnedByThisShell: false,
    });
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

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  private isActiveHome(homeDir: string): boolean {
    return canonicalHomeKey(homeDir) === canonicalHomeKey(this.descriptor.homeDir);
  }

  private recordManagedHome(
    homeDir: string,
    update: {
      readonly pid?: number;
      readonly serverId?: string;
      readonly startedAt?: number;
      readonly spawnedByThisShell?: boolean;
    },
  ): void {
    const key = canonicalHomeKey(homeDir);
    const existing = this.managedHomes.get(key);
    this.managedHomes.set(key, {
      homeDir: existing?.homeDir ?? homeDir,
      pid: update.pid ?? existing?.pid,
      serverId: update.serverId ?? existing?.serverId,
      startedAt: update.startedAt ?? existing?.startedAt,
      spawnedByThisShell: update.spawnedByThisShell ?? existing?.spawnedByThisShell ?? false,
    });
  }

  private clearManagedHomeRuntime(homeDir: string, pid?: number): void {
    const key = canonicalHomeKey(homeDir);
    const existing = this.managedHomes.get(key);
    if (existing === undefined) return;
    if (pid !== undefined && existing.pid !== undefined && existing.pid !== pid) return;
    this.managedHomes.set(key, {
      homeDir: existing.homeDir,
      spawnedByThisShell: false,
    });
  }
  setOauthHomeDir(oauthHomeDir: string): void {
    this.descriptor = {
      ...this.descriptor,
      oauthHomeDir,
    };
  }

  setLogLevel(logLevel: DesktopLogLevel): void {
    this.descriptor = {
      ...this.descriptor,
      logLevel,
    };
  }

  markShuttingDown(): void {
    this.shuttingDown = true;
    this.startupAbort?.abort(new Error('Desktop is shutting down'));
  }

  setTargetHome(homeDir: string, oauthHomeDir?: string): void {
    if (this.isActiveHome(homeDir)) {
      if (oauthHomeDir !== undefined && oauthHomeDir !== this.descriptor.oauthHomeDir) {
        this.descriptor = { ...this.descriptor, oauthHomeDir };
      }
      return;
    }
    this.discoveryFlight?.catch(() => undefined);
    this.startupAbort?.abort(new Error('A newer space switch replaced this request'));
    this.startupAbort = null;
    this.discoveryFlight = null;
    this.descriptor = {
      ...this.descriptor,
      homeDir,
      oauthHomeDir: oauthHomeDir ?? this.descriptor.oauthHomeDir,
    };
    this.recordManagedHome(homeDir, {});
    this.attached = null;
    this.cachedQuitPlan = null;
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

  private async readLiveInstanceRecords(
    homeDir: string,
    options?: { readonly ignoreHeartbeatStaleness?: boolean },
  ): Promise<Array<z.infer<typeof instanceRecordSchema> & { readonly filePath: string }>> {
    const dir = join(homeDir, 'server', 'instances');
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const records: Array<z.infer<typeof instanceRecordSchema> & { readonly filePath: string }> = [];
    const nowMs = this.now();
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = join(dir, entry);
      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = instanceRecordSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) continue;
        const record = parsed.data;
        if (record.host !== undefined && !isLoopbackHost(record.host)) continue;
        if (!this.isPidAlive(record.pid)) continue;
        const heartbeatAt = record.heartbeat_at ?? record.heartbeatAt;
        if (
          options?.ignoreHeartbeatStaleness !== true &&
          heartbeatAt !== undefined &&
          nowMs - heartbeatAt > HEARTBEAT_FRESHNESS_MS
        ) {
          continue;
        }
        records.push({ ...record, filePath });
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
    timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
  ): Promise<VerifiedBackend | null> {
    const url = `http://127.0.0.1:${port}`;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
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
    timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
  ): Promise<VerifiedBackend | null> {
    if (this.isActiveHome(homeDir) && this.attached !== null) {
      const parsedUrl = URL.parse(this.attached.config.url);
      const port = parsedUrl !== null ? Number(parsedUrl.port) : 0;
      if (port > 0) {
        const verified = await this.verifyEndpoint(port, this.attached.config.token, signal, timeoutMs);
        if (verified !== null) {
          const enriched: VerifiedBackend = {
            ...verified,
            ...(this.attached.pid !== undefined ? { pid: this.attached.pid } : {}),
            ...(this.attached.startedAt !== undefined ? { startedAt: this.attached.startedAt } : {}),
          };
          if (this.isActiveHome(homeDir)) {
            this.attached = enriched;
          }
          return enriched;
        }
      }
      if (this.isActiveHome(homeDir)) {
        this.attached = null;
      }
    }
    const token = await this.readOwnerToken(homeDir);
    if (token === null) return null;
    const records = await this.readLiveInstanceRecords(homeDir);
    if (records.length === 0) return null;
    const probes = await Promise.all(
      records.map(async (record) => {
        const verified = await this.verifyEndpoint(record.port, token, signal, timeoutMs);
        if (verified === null) return null;
        const startedAt = record.started_at ?? record.startedAt;
        return {
          ...verified,
          pid: record.pid,
          ...(startedAt !== undefined ? { startedAt } : {}),
        } satisfies VerifiedBackend;
      }),
    );
    const matched = probes.find((item): item is NonNullable<typeof item> => item !== null) ?? null;
    if (matched !== null) {
      if (matched.managed) {
        this.recordManagedHome(homeDir, {
          pid: matched.pid,
          serverId: matched.serverId,
          startedAt: matched.startedAt,
        });
      }
      if (this.isActiveHome(homeDir)) {
        this.attached = matched;
      }
    }
    return matched;
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
    if (!exited && this.isPidAlive(child.pid)) {
      await this.forceKillPidTree(child.pid);
      return !this.isPidAlive(child.pid);
    }
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
    if (this.shuttingDown) {
      throw new Error('Desktop is shutting down');
    }
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
      readonly oauthHomeDir?: string;
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
                ...(options.oauthHomeDir !== undefined
                  ? { oauthHomeDir: options.oauthHomeDir }
                  : {}),
                idleExit: true,
              };
          const logLevel = targetDescriptor.logLevel ?? 'warn';
          const idleExit = targetDescriptor.idleExit === true ? '30m' : '0ms';
          const totalMem = this.totalMemoryBytes();
          const { cliHeapArg } = resolveDaemonHeapCliArg(
            this.baseEnv['NODE_OPTIONS'] ?? '',
            totalMem,
          );
          const args = [
            cliHeapArg,
            targetDescriptor.serverEntry,
            'serve',
            '--port',
            '0',
            '--log-level',
            logLevel,
            '--idle-exit',
            idleExit,
          ];
          const env = buildDaemonSpawnEnv(targetDescriptor, this.baseEnv, totalMem, {
            heapPassedViaArgv: true,
          });

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
                    const startedAt = record.started_at ?? record.startedAt;
                    const enriched: VerifiedBackend = {
                      ...candidate,
                      pid: child.pid ?? record.pid,
                      ...(startedAt !== undefined ? { startedAt } : {}),
                    };
                    this.recordManagedHome(homeDir, {
                      pid: enriched.pid,
                      serverId: enriched.serverId,
                      startedAt: enriched.startedAt,
                      spawnedByThisShell: true,
                    });
                    if (active && this.autoRecoverManagedExit) {
                      this.attachRuntimeExitWatcher(child, homeDir, enriched.serverId);
                    }
                    return enriched;
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
      if (this.shuttingDown || this.detachedFromUi || this.intentionalStopCount > 0) return;
      if (!this.isActiveHome(homeDir)) return;
      if (this.attached !== null && this.attached.serverId !== serverId) return;
      this.attached = null;
      void this.triggerManagedRecovery('unexpected_exit');
    });
  }

  async checkHealthAndRecoverIfNeeded(): Promise<void> {
    if (
      this.shuttingDown ||
      this.detachedFromUi ||
      this.intentionalStopCount > 0 ||
      this.discoveryFlight !== null
    ) {
      return;
    }
    if (this.attached === null || !this.attached.managed) return;
    const parsedUrl = URL.parse(this.attached.config.url);
    const port = parsedUrl !== null ? Number(parsedUrl.port) : 0;
    if (port <= 0) return;
    const healthy = await this.verifyEndpoint(port, this.attached.config.token);
    if (this.shuttingDown || this.detachedFromUi || this.intentionalStopCount > 0) return;
    if (healthy !== null) {
      this.attached = {
        ...healthy,
        ...(this.attached?.pid !== undefined ? { pid: this.attached.pid } : {}),
        ...(this.attached?.startedAt !== undefined ? { startedAt: this.attached.startedAt } : {}),
      };
      if (this.lastReadyAt > 0 && this.now() - this.lastReadyAt >= RECOVERY_STABLE_WINDOW_MS) {
        this.recoveryAttempts = 0;
      }
      return;
    }
    this.attached = null;
    await this.triggerManagedRecovery('health_unreachable');
  }

  private async triggerManagedRecovery(reason: string): Promise<void> {
    if (this.shuttingDown || this.detachedFromUi || this.intentionalStopCount > 0) return;
    if (this.recoveryInFlight !== null) return this.recoveryInFlight;
    const run = (async () => {
      if (this.shuttingDown || this.detachedFromUi || this.intentionalStopCount > 0) return;
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

  async readLifecycleStateForHome(
    homeDir: string,
    timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
  ): Promise<ProbedHomeLifecycle | null> {
    const deadlineSignal = AbortSignal.timeout(timeoutMs);
    const fetchLifecycle = async (backend: VerifiedBackend): Promise<ProbedHomeLifecycle | null> => {
      try {
        const response = await this.fetchFn(`${backend.config.url}/api/desktop-lifecycle`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${backend.config.token}` },
          signal: deadlineSignal,
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as { code?: number; data?: unknown };
        if (payload.code !== 0) return null;
        const parsed = lifecycleStateSchema.safeParse(payload.data);
        return parsed.success ? { backend, state: parsed.data } : null;
      } catch {
        return null;
      }
    };

    if (this.isActiveHome(homeDir) && this.attached !== null) {
      const fast = await fetchLifecycle(this.attached);
      if (fast !== null) return fast;
      if (deadlineSignal.aborted) return null;
    }

    const backend = await this.discoverVerifiedForHome(homeDir, deadlineSignal, timeoutMs);
    if (backend === null || deadlineSignal.aborted) return null;
    return fetchLifecycle(backend);
  }

  async readLifecycleState(timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS): Promise<DaemonLifecycleState | null> {
    const resolved = await this.readLifecycleStateForHome(this.descriptor.homeDir, timeoutMs);
    return resolved?.state ?? null;
  }

  private async cleanupStaleRuntimeArtifactsForPid(
    homeDir: string,
    pid: number,
    serverId?: string,
  ): Promise<void> {
    if (this.isPidAlive(pid)) return;
    const instancesDir = join(homeDir, 'server', 'instances');
    const entries = await readdir(instancesDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = join(instancesDir, entry);
      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = instanceRecordSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) continue;
        const recordServerId = parsed.data.server_id ?? parsed.data.serverId;
        if (
          parsed.data.pid === pid &&
          (serverId === undefined || recordServerId === undefined || recordServerId === serverId)
        ) {
          await unlink(filePath).catch(() => undefined);
        }
      } catch {
        continue;
      }
    }
    const lockPath = join(homeDir, 'server', 'ensure.lock');
    const lockOwner = (await readFile(lockPath, 'utf8').catch(() => '')).trim();
    if (lockOwner === String(pid)) {
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async verifyTargetStillOwnedBeforeKill(
    homeDir: string,
    pid: number,
    expectedServerId?: string,
    expectedStartedAt?: number,
  ): Promise<boolean> {
    if (!this.isPidAlive(pid)) return false;
    const managedEntry = this.managedHomes.get(canonicalHomeKey(homeDir));
    const records = await this.readLiveInstanceRecords(homeDir, { ignoreHeartbeatStaleness: true });
    for (const record of records) {
      const recordServerId = record.server_id ?? record.serverId;
      const recordStartedAt = record.started_at ?? record.startedAt;
      if (record.pid !== pid) {
        if (expectedServerId !== undefined && recordServerId !== undefined && recordServerId !== expectedServerId) {
          return false;
        }
        continue;
      }
      if (expectedServerId !== undefined && recordServerId !== undefined && recordServerId !== expectedServerId) {
        return false;
      }
      if (
        expectedStartedAt !== undefined &&
        recordStartedAt !== undefined &&
        recordStartedAt !== expectedStartedAt
      ) {
        return false;
      }
      return true;
    }
    if (managedEntry?.pid === pid && (expectedServerId === undefined || managedEntry.serverId === expectedServerId)) {
      return true;
    }
    const lockPath = join(homeDir, 'server', 'ensure.lock');
    const lockOwner = (await readFile(lockPath, 'utf8').catch(() => '')).trim();
    return lockOwner === String(pid);
  }

  private async waitForExitOrForceKill(
    homeDir: string,
    target: {
      readonly pid?: number;
      readonly serverId?: string;
      readonly startedAt?: number;
    },
    graceMs: number,
  ): Promise<void> {
    const { pid, serverId, startedAt } = target;
    if (pid === undefined || pid <= 0) return;

    const deadline = this.now() + Math.max(0, graceMs);
    const stepMs = Math.min(25, this.pollIntervalMs);
    while (this.now() < deadline) {
      if (!this.isPidAlive(pid)) {
        this.clearManagedHomeRuntime(homeDir, pid);
        await this.cleanupStaleRuntimeArtifactsForPid(homeDir, pid, serverId);
        return;
      }
      await this.sleep(stepMs);
    }

    if (await this.verifyTargetStillOwnedBeforeKill(homeDir, pid, serverId, startedAt)) {
      await this.forceKillPidTree(pid);
    }
    this.clearManagedHomeRuntime(homeDir, pid);
    await this.cleanupStaleRuntimeArtifactsForPid(homeDir, pid, serverId);
  }

  private async findWedgedManagedTarget(homeDir: string): Promise<{
    readonly pid: number;
    readonly serverId?: string;
    readonly startedAt?: number;
  } | null> {
    const managedEntry = this.managedHomes.get(canonicalHomeKey(homeDir));
    const records = await this.readLiveInstanceRecords(homeDir, { ignoreHeartbeatStaleness: true });
    for (const record of records) {
      const recordServerId = record.server_id ?? record.serverId;
      const recordStartedAt = record.started_at ?? record.startedAt;
      if (
        (managedEntry !== undefined &&
          (managedEntry.pid === record.pid ||
            (managedEntry.serverId !== undefined && managedEntry.serverId === recordServerId))) ||
        (await readFile(join(homeDir, 'server', 'ensure.lock'), 'utf8').catch(() => '')).trim() ===
          String(record.pid)
      ) {
        return {
          pid: record.pid,
          ...(recordServerId !== undefined ? { serverId: recordServerId } : {}),
          ...(recordStartedAt !== undefined ? { startedAt: recordStartedAt } : {}),
        };
      }
    }
    if (managedEntry?.pid !== undefined && this.isPidAlive(managedEntry.pid)) {
      return {
        pid: managedEntry.pid,
        ...(managedEntry.serverId !== undefined ? { serverId: managedEntry.serverId } : {}),
        ...(managedEntry.startedAt !== undefined ? { startedAt: managedEntry.startedAt } : {}),
      };
    }
    return null;
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
      readonly probeTimeoutMs?: number;
      readonly graceMs?: number;
      readonly preProbed?: { readonly resolved: ProbedHomeLifecycle | null };
    },
  ): Promise<StopManagedDaemonResult> {
    const probeTimeoutMs =
      options.probeTimeoutMs ??
      (options.action === 'quit' ? this.quitProbeTimeoutMs : DEFAULT_HTTP_TIMEOUT_MS);
    const graceMs =
      options.graceMs ??
      (options.action === 'quit' ? this.quitGraceMs : this.shutdownGraceMs);

    this.intentionalStopCount += 1;
    try {
      const resolved =
        options.preProbed !== undefined
          ? options.preProbed.resolved
          : await this.readLifecycleStateForHome(homeDir, probeTimeoutMs);
      if (resolved === null) {
        if (options.action === 'quit' || options.interruptWork === true) {
          const wedged = await this.findWedgedManagedTarget(homeDir);
          if (wedged !== null) {
            await this.waitForExitOrForceKill(homeDir, wedged, 0);
            if (this.isActiveHome(homeDir)) {
              this.attached = null;
            }
            return { stopped: true, reason: 'stopped' };
          }
        }
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

      const allRecords = await this.readLiveInstanceRecords(homeDir, {
        ignoreHeartbeatStaleness: true,
      });
      const matchingRecord = allRecords.find(
        (rec) => (rec.server_id ?? rec.serverId) === state.server_id || rec.pid === backend.pid,
      );
      const targetPid = matchingRecord?.pid ?? backend.pid;
      const targetStartedAt =
        matchingRecord?.started_at ?? matchingRecord?.startedAt ?? backend.startedAt;

      let postTimedOutOrFailed = false;
      try {
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
          signal: AbortSignal.timeout(probeTimeoutMs),
        });
        const payload = (await response.json()) as { code?: number; msg?: string };
        if (!response.ok || payload.code !== 0) {
          throw new Error(payload.msg ?? 'Failed to stop managed Kiki daemon');
        }
      } catch (error) {
        if (options.action !== 'quit' && options.interruptWork !== true) {
          throw error;
        }
        postTimedOutOrFailed = true;
      }

      if (this.isActiveHome(homeDir)) {
        this.attached = null;
      }

      await this.waitForExitOrForceKill(
        homeDir,
        {
          pid: targetPid,
          serverId: state.server_id,
          startedAt: targetStartedAt,
        },
        postTimedOutOrFailed ? 0 : graceMs,
      );

      return { stopped: true, reason: 'stopped' };
    } finally {
      this.intentionalStopCount = Math.max(0, this.intentionalStopCount - 1);
    }
  }

  async stopManagedDaemon(options: {
    readonly action: 'quit' | 'restart' | 'update';
    readonly interruptWork?: boolean;
    readonly probeTimeoutMs?: number;
    readonly graceMs?: number;
  }): Promise<StopManagedDaemonResult> {
    return this.stopManagedDaemonForHome(this.descriptor.homeDir, options);
  }

  private getTrackedManagedHomes(): string[] {
    const byKey = new Map<string, string>();
    for (const [key, entry] of this.managedHomes) {
      byKey.set(key, entry.homeDir);
    }
    byKey.set(canonicalHomeKey(this.descriptor.homeDir), this.descriptor.homeDir);
    return [...byKey.values()];
  }

  async probeManagedQuitPlan(
    probeTimeoutMs: number = this.quitProbeTimeoutMs,
  ): Promise<ManagedQuitPlan> {
    const homes = this.getTrackedManagedHomes();
    const entries = await Promise.all(
      homes.map(async (homeDir) => [
        canonicalHomeKey(homeDir),
        await this.readLifecycleStateForHome(homeDir, probeTimeoutMs),
      ] as const),
    );
    const byHomeKey = new Map<string, ProbedHomeLifecycle | null>(entries);
    const pending = new Set<string>();
    for (const [, resolved] of entries) {
      if (resolved === null || !resolved.state.managed) continue;
      for (const sessionId of resolved.state.work_pending) {
        pending.add(sessionId);
      }
    }
    const plan: ManagedQuitPlan = {
      pendingWork: [...pending],
      byHomeKey,
    };
    this.cachedQuitPlan = { at: this.now(), plan };
    return plan;
  }

  async collectManagedQuitPendingWork(
    probeTimeoutMs: number = this.quitProbeTimeoutMs,
  ): Promise<string[]> {
    const plan = await this.probeManagedQuitPlan(probeTimeoutMs);
    return plan.pendingWork;
  }

  async shutdownAllManagedDaemons(options: {
    readonly action?: 'quit' | 'update';
    readonly interruptWork: boolean;
    readonly probeTimeoutMs?: number;
    readonly graceMs?: number;
    readonly preProbed?: ManagedQuitPlan;
  }): Promise<StopManagedDaemonResult> {
    this.markShuttingDown();
    const action = options.action ?? 'quit';
    const cached =
      action === 'quit' &&
      this.cachedQuitPlan !== null &&
      this.now() - this.cachedQuitPlan.at <= QUIT_PLAN_CACHE_TTL_MS
        ? this.cachedQuitPlan.plan
        : undefined;
    this.cachedQuitPlan = null;
    const plan = options.preProbed ?? cached;
    const defaultProbeTimeoutMs =
      action === 'update' ? DEFAULT_HTTP_TIMEOUT_MS : this.quitProbeTimeoutMs;
    const defaultGraceMs = action === 'update' ? this.shutdownGraceMs : this.quitGraceMs;
    const preReady = this.preReadyChild;
    this.preReadyChild = null;
    if (preReady !== null) {
      await this.stopUnreadyChild(preReady);
    }
    const homes = this.getTrackedManagedHomes();
    const results = await Promise.all(
      homes.map((homeDir) => {
        const homeKey = canonicalHomeKey(homeDir);
        const hasPreProbed = plan?.byHomeKey.has(homeKey) === true;
        return this.stopManagedDaemonForHome(homeDir, {
          action,
          interruptWork: options.interruptWork,
          probeTimeoutMs: options.probeTimeoutMs ?? defaultProbeTimeoutMs,
          graceMs: options.graceMs ?? defaultGraceMs,
          ...(hasPreProbed ? { preProbed: { resolved: plan.byHomeKey.get(homeKey) ?? null } } : {}),
        }).catch((): StopManagedDaemonResult => ({ stopped: false, reason: 'not-running' }));
      }),
    );
    const anyStopped = results.some((item) => item.stopped);
    return {
      stopped: anyStopped,
      reason: anyStopped ? 'stopped' : 'not-running',
    };
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
  async restartSpace(
    homeDir: string,
    interruptWork = false,
    oauthHomeDir?: string,
  ): Promise<LocalConnection> {
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
      ...(oauthHomeDir !== undefined ? { oauthHomeDir } : {}),
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
