import { spawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'pathe';
import { z } from 'zod';
import { removeInjectedHeapOption } from '@kiki/node-sdk/worker-heap-policy';
import { ELECTRON_RUN_AS_NODE_ENV, filterGuiChildEnv } from '#/main/releaseRedirect';
import { openDetachedBackendLogFd } from '#/main/rotatingLog';
import type {
  BackendStagePayload,
  ConnectionConfig,
  DesktopLogLevel,
  DesktopSpaceStatus,
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

const instanceRecordSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  serverId: z.string().optional(),
  server_id: z.string().optional(),
  startedAt: z.number().optional(),
  heartbeatAt: z.number().optional(),
});

const metaEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      server_id: z.string().optional(),
      serverId: z.string().optional(),
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
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly totalMemoryBytes?: () => number;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

export interface StopManagedDaemonResult {
  readonly stopped: boolean;
  readonly reason: 'stopped' | 'not-running' | 'external' | 'pending-work';
  readonly pendingWork?: readonly string[];
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
  if (descriptor.buildId !== undefined) {
    cleanEnv['KIKI_BUILD_ID'] = descriptor.buildId;
  }
  if (descriptor.buildChannel !== undefined) {
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
  private readonly now: () => number;
  private readonly sleep: NonNullable<DaemonSupervisorDeps['sleep']>;
  private readonly totalMemoryBytes: () => number;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly baseEnv: NodeJS.ProcessEnv;

  private descriptor: DaemonRuntimeDescriptor;
  private attached: VerifiedBackend | null = null;
  private discoveryFlight: Promise<LocalConnection> | null = null;
  private startupAbort: AbortController | null = null;
  private preReadyChild: SpawnedDaemonChild | null = null;
  private stagedScopeHandoff: { profile: SshProfile; connection: SshResolvedConnection } | null = null;

  constructor(descriptor: DaemonRuntimeDescriptor, deps: DaemonSupervisorDeps = {}) {
    super();
    this.descriptor = descriptor;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.spawnFn = deps.spawnFn ?? ((cmd, args, opts) => spawn(cmd, [...args], opts));
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
    this.openLogFd = deps.openLogFd ?? openDetachedBackendLogFd;
    this.closeFd = deps.closeFd ?? closeSync;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.totalMemoryBytes = deps.totalMemoryBytes ?? totalmem;
    this.startupTimeoutMs = deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.baseEnv = deps.baseEnv ?? process.env;
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

  setTargetHome(homeDir: string, oauthHomeDir?: string): void {
    if (this.descriptor.homeDir === homeDir) return;
    this.descriptor = { ...this.descriptor, homeDir, oauthHomeDir };
    this.attached = null;
  }

  onBackendStage(listener: (payload: BackendStagePayload) => void): () => void {
    this.on('stage', listener);
    return () => {
      this.off('stage', listener);
    };
  }

  private emitStage(stage: BackendStagePayload['stage'], message?: string): void {
    this.emit('stage', { stage, message, homeId: this.attached?.homeId } satisfies BackendStagePayload);
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
        if (!this.isPidAlive(record.pid)) continue;
        if (record.heartbeatAt !== undefined && nowMs - record.heartbeatAt > HEARTBEAT_FRESHNESS_MS) {
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
      const homeId = data.home_id ?? data.homeId ?? 'main';
      if (this.descriptor.buildId !== undefined) {
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
    if (homeDir === this.descriptor.homeDir && this.attached !== null) {
      const port = Number(new URL(this.attached.config.url).port);
      const verified = await this.verifyEndpoint(port, this.attached.config.token, signal);
      if (verified !== null) {
        this.attached = verified;
        return verified;
      }
      this.attached = null;
    }
    const token = await this.readOwnerToken(homeDir);
    if (token === null) return null;
    const records = await this.readLiveInstanceRecords(homeDir);
    for (const record of records) {
      const verified = await this.verifyEndpoint(record.port, token, signal);
      if (verified !== null) {
        if (homeDir === this.descriptor.homeDir) {
          this.attached = verified;
        }
        return verified;
      }
    }
    return null;
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
    const abort = new AbortController();
    this.startupAbort = abort;
    const flight = this.resolveConnection(abort.signal).finally(() => {
      if (this.discoveryFlight === flight) this.discoveryFlight = null;
      if (this.startupAbort === abort) this.startupAbort = null;
    });
    this.discoveryFlight = flight;
    return flight;
  }

  private async resolveConnection(signal: AbortSignal): Promise<LocalConnection> {
    this.emitStage('checking');
    const existing = await this.attachIfRunning(signal);
    if (existing !== null) {
      this.emitStage('ready');
      return existing;
    }

    this.emitStage('starting');
    const logLevel = this.descriptor.logLevel ?? 'warn';
    const idleExit = this.descriptor.idleExit === true ? '30m' : '0ms';
    const args = [
      this.descriptor.serverEntry,
      'serve',
      '--port',
      '0',
      '--log-level',
      logLevel,
      '--idle-exit',
      idleExit,
    ];
    const env = buildDaemonSpawnEnv(this.descriptor, this.baseEnv, this.totalMemoryBytes());

    let logFd: number | undefined;
    try {
      logFd = this.openLogFd(this.descriptor.homeDir).fd;
    } catch {
      logFd = undefined;
    }

    const childStatus: {
      exited: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
      spawnError: Error | null;
    } = { exited: null, spawnError: null };

    const child = this.spawnFn(this.descriptor.electronBinary, args, {
      env,
      detached: true,
      windowsHide: true,
      stdio: logFd !== undefined ? ['ignore', logFd, logFd] : 'ignore',
    });
    if (logFd !== undefined) {
      this.closeFd(logFd);
    }

    this.preReadyChild = child;
    child.on('exit', (code, exitSignal) => {
      childStatus.exited = { code, signal: exitSignal };
      if (this.preReadyChild === child) this.preReadyChild = null;
    });
    child.on('error', (error) => {
      childStatus.spawnError = error;
      if (this.preReadyChild === child) this.preReadyChild = null;
    });

    const deadline = this.now() + this.startupTimeoutMs;
    try {
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

        const token = await this.readOwnerToken(this.descriptor.homeDir);
        if (token !== null) {
          const records = await this.readLiveInstanceRecords(this.descriptor.homeDir);
          const matching =
            child.pid !== undefined ? records.filter((record) => record.pid === child.pid) : records;
          for (const record of matching) {
            const verified = await this.verifyEndpoint(record.port, token, signal);
            if (verified !== null) {
              // Ready is the ownership boundary: unref the detached daemon so
              // closing the desktop window leaves the shared daemon alive.
              this.preReadyChild = null;
              child.unref();
              this.attached = verified;
              this.emitStage('ready');
              return { config: verified.config, persist: false };
            }
          }
        }
        await this.sleep(this.pollIntervalMs, signal);
      }
      throw new Error(`Kiki backend did not become ready within ${Math.round(this.startupTimeoutMs / 1000)}s`);
    } catch (error) {
      if (this.preReadyChild === child) {
        this.preReadyChild = null;
        try {
          child.kill('SIGTERM');
        } catch {
          // Best-effort pre-ready termination only.
        }
      }
      const normalizedError =
        signal.aborted && signal.reason instanceof Error ? signal.reason : error;
      this.emitStage(
        'failed',
        normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
      );
      throw normalizedError;
    }
  }

  /**
   * Cancels an in-flight pre-ready startup and terminates ONLY the pre-ready child
   * spawned by this attempt. Never stops an already-ready shared daemon.
   */
  async cancelStartup(): Promise<void> {
    const child = this.preReadyChild;
    this.preReadyChild = null;
    this.startupAbort?.abort(new Error('Desktop daemon startup was cancelled'));
    if (child !== null) {
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
    const preReady = this.preReadyChild;
    this.preReadyChild = null;
    this.startupAbort?.abort(new Error('Desktop window closed during startup'));
    if (preReady !== null) {
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
    if (homeDir === this.descriptor.homeDir) {
      this.attached = null;
    }
    return { stopped: true, reason: 'stopped' };
  }

  /**
   * Stops ONLY a desktop-managed local daemon for the active home via kap-server's
   * `/api/desktop-lifecycle` consent contract. Never kills externally managed or remote daemons.
   */
  async stopManagedDaemon(options: {
    readonly action: 'quit' | 'restart' | 'update';
    readonly interruptWork?: boolean;
  }): Promise<StopManagedDaemonResult> {
    return this.stopManagedDaemonForHome(this.descriptor.homeDir, options);
  }

  async restartServer(interruptWork = false): Promise<LocalConnection> {
    const result = await this.stopManagedDaemon({ action: 'restart', interruptWork });
    if (result.reason === 'external') {
      throw new Error('The connected Kiki daemon is externally managed; restart is unsupported from this desktop window');
    }
    if (result.reason === 'pending-work') {
      throw new Error('Some work is still settling; wait for its saved outcome before restarting this service');
    }
    return this.discoverConnection();
  }

  async restartSpace(homeDir: string, interruptWork = false): Promise<LocalConnection> {
    this.setTargetHome(homeDir);
    return this.restartServer(interruptWork);
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

  async listSshProfiles(): Promise<SshProfile[]> {
    const data = await this.requestDesktopApi<{ profiles: SshProfile[] }>('GET', '/api/desktop/ssh/profiles');
    return data.profiles;
  }

  async saveSshProfile(profile: SshProfile): Promise<SshProfile[]> {
    const data = await this.requestDesktopApi<{ profiles: SshProfile[] }>(
      'PUT',
      '/api/desktop/ssh/profiles',
      { profile },
    );
    return data.profiles;
  }

  async removeSshProfile(id: string): Promise<SshProfile[]> {
    const data = await this.requestDesktopApi<{ profiles: SshProfile[] }>(
      'DELETE',
      `/api/desktop/ssh/profiles/${encodeURIComponent(id)}`,
    );
    return data.profiles;
  }

  async connectSshProfile(id: string, token: string, staged = false): Promise<SshResolvedConnection> {
    const data = await this.requestDesktopApi<{ connection: SshResolvedConnection }>(
      'POST',
      '/api/desktop/ssh/connect',
      { id, token, home_id: this.attached?.homeId, staged },
    );
    return data.connection;
  }

  async resumeScopeConnection(
    homeId: string,
    id: string,
    tunnelId: string,
  ): Promise<{ profile: SshProfile; connection: SshResolvedConnection }> {
    return this.requestDesktopApi<{ profile: SshProfile; connection: SshResolvedConnection }>(
      'POST',
      '/api/desktop/ssh/resume',
      { home_id: homeId, id, tunnel_id: tunnelId },
    );
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

  async listSpacesAndStatuses(): Promise<{
    readonly spaces: LocalSpaceSummary[];
    readonly statuses: DesktopSpaceStatus[];
  }> {
    return this.requestDesktopApi<{ spaces: LocalSpaceSummary[]; statuses: DesktopSpaceStatus[] }>(
      'GET',
      '/api/desktop/spaces',
    );
  }

  async readPluginFocus(homeId?: string): Promise<PluginFocusIntent | null> {
    const targetHome = homeId ?? this.attached?.homeId;
    const query = targetHome !== undefined ? `?home_id=${encodeURIComponent(targetHome)}` : '';
    const data = await this.requestDesktopApi<{ focus: PluginFocusIntent | null }>(
      'GET',
      `/api/desktop/plugin-focus${query}`,
    );
    return data.focus;
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
