import '#/_base/utils/fsWatchGuard';
import { watch as fsWatch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, posix, relative, win32 } from 'node:path';

import { FSWatcher } from 'chokidar';

import type { IDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';

import {
  type HostFsChange,
  type HostFsChangeAction,
  type HostFsChangeKind,
  type HostFsWatchIgnore,
  type HostFsWatchOptions,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

const DEFAULT_IGNORED = (p: string): boolean => /(?:^|[/\\])\.git(?:$|[/\\])/.test(p);

const NATIVE_RETRY_BASE_MS = 1000;
const NATIVE_RETRY_MAX_MS = 30000;
const NATIVE_ERROR_LIMIT = 5;
const WATCH_ERROR_THROTTLE_MS = 300000;
const IGNORED_TOP_LEVEL_CACHE_SIZE = 4096;

type WatchErrorReporter = (root: string, error: unknown, source: 'native' | 'chokidar') => void;

interface NativeFsWatcher {
  close(): void;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): this;
}

interface HostFsWatchRuntime {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  watchNative(
    root: string,
    listener: (eventType: string, filename: string | null) => void,
  ): NativeFsWatcher;
  watchFallback(
    root: string,
    options: HostFsWatchOptions | undefined,
    reportError: WatchErrorReporter,
  ): IHostFsWatchHandle;
  scheduleRetry(callback: () => void, delayMs: number): IDisposable;
}

const NODE_HOST_FS_WATCH_RUNTIME: HostFsWatchRuntime = {
  platform: process.platform,
  homeDir: homedir(),
  watchNative: (root, listener) =>
    fsWatch(root, { persistent: false, recursive: true }, listener),
  watchFallback: (root, options, reportError) =>
    new HostFsWatchHandle(root, options, reportError),
  scheduleRetry: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return {
      dispose: () => {
        clearTimeout(timer);
      },
    };
  },
};

interface WatchReadiness {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function createWatchReadiness(): WatchReadiness {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

class HostFsWatchHandle implements IHostFsWatchHandle {
  readonly ready: Promise<void>;
  readonly onDidChange: Event<HostFsChange>;

  private readonly readiness = createWatchReadiness();
  private readonly emitter: Emitter<HostFsChange>;
  private readonly watcher: FSWatcher;
  private disposed = false;

  constructor(
    private readonly root: string,
    options: HostFsWatchOptions | undefined,
    private readonly reportError: WatchErrorReporter,
  ) {
    this.ready = this.readiness.promise;
    this.emitter = new Emitter<HostFsChange>();
    this.onDidChange = this.emitter.event;
    this.watcher = new FSWatcher({
      ignoreInitial: true,
      persistent: false,
      followSymlinks: false,
      depth: options?.recursive === false ? 0 : undefined,
      ignored: options?.ignored ?? DEFAULT_IGNORED,
    });
    this.watcher.on('all', (eventName: string, absPath: string) => {
      const mapped = mapChokidarEvent(eventName, absPath);
      if (mapped !== undefined) this.emitter.fire(mapped);
    });
    this.watcher.on('error', (error: unknown) => {
      this.readiness.reject(error);
      this.reportError(this.root, error, 'chokidar');
    });
    this.watcher.once('ready', () => this.readiness.resolve());
    this.watcher.add(this.root);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readiness.resolve();
    void this.watcher.close().catch(() => undefined);
    this.emitter.dispose();
  }
}

class SignalWatchHandle implements IHostFsWatchHandle {
  readonly ready: Promise<void>;
  readonly onDidChange: Event<HostFsChange>;

  private readonly readiness = createWatchReadiness();
  private readonly emitter: Emitter<HostFsChange>;
  private readonly ignored: HostFsWatchIgnore;
  private readonly ignoredTopLevel = new Map<string, boolean>();
  private nativeWatcher: NativeFsWatcher | undefined;
  private chokidarLeg: IHostFsWatchHandle | undefined;
  private retry: IDisposable | undefined;
  private retryAttempts = 0;
  private recovering = false;
  private recoveryInvalidated = false;
  private disposed = false;

  constructor(
    private readonly root: string,
    options: HostFsWatchOptions | undefined,
    private readonly runtime: HostFsWatchRuntime,
    private readonly reportError: WatchErrorReporter,
  ) {
    this.ready = this.readiness.promise;
    this.emitter = new Emitter<HostFsChange>();
    this.onDidChange = this.emitter.event;
    this.ignored = options?.ignored ?? DEFAULT_IGNORED;
    this.startNativeLeg();
  }

  private startNativeLeg(): void {
    if (this.disposed) return;
    try {
      const watcher = this.runtime.watchNative(this.root, (_eventType, filename) => {
        if (this.disposed) return;
        this.retryAttempts = 0;
        this.recoveryInvalidated = false;
        if (this.isIgnoredTopLevel(filename)) return;
        const absPath = resolveNativeSignalPath(this.root, filename);
        if (absPath !== this.root && this.ignored(absPath)) return;
        this.fireInvalidation();
      });
      watcher.on('error', (error: NodeJS.ErrnoException) => {
        this.onNativeError(watcher, error);
      });
      this.nativeWatcher = watcher;
      this.readiness.resolve();
      if (this.recovering) {
        this.recovering = false;
        this.fireRecoveryInvalidation();
      }
    } catch (error) {
      this.onNativeError(undefined, error as NodeJS.ErrnoException);
    }
  }

  private onNativeError(watcher: NativeFsWatcher | undefined, error: NodeJS.ErrnoException): void {
    if (this.disposed) return;
    if (watcher !== undefined && watcher !== this.nativeWatcher) return;
    watcher?.close();
    this.nativeWatcher = undefined;
    if (error.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
      this.recovering = false;
      this.startChokidarLeg();
      this.fireRecoveryInvalidation();
      return;
    }
    this.recovering = true;
    this.retryAttempts += 1;
    this.retry?.dispose();
    this.retry = undefined;
    if (this.retryAttempts >= NATIVE_ERROR_LIMIT) {
      this.recovering = false;
      this.readiness.resolve();
      this.fireRecoveryInvalidation();
      this.reportError(this.root, error, 'native');
      return;
    }
    const delay = Math.min(
      NATIVE_RETRY_BASE_MS * 2 ** (this.retryAttempts - 1),
      NATIVE_RETRY_MAX_MS,
    );
    this.retry = this.runtime.scheduleRetry(() => {
      this.retry = undefined;
      this.startNativeLeg();
    }, delay);
  }

  private startChokidarLeg(): void {
    if (this.chokidarLeg !== undefined) return;
    const leg = this.runtime.watchFallback(
      this.root,
      { recursive: true, ignored: this.ignored },
      this.reportError,
    );
    leg.onDidChange((event) => {
      if (!this.disposed) this.emitter.fire(event);
    });
    void leg.ready.then(
      () => this.readiness.resolve(),
      (error: unknown) => this.readiness.reject(error),
    );
    this.chokidarLeg = leg;
  }

  private fireRecoveryInvalidation(): void {
    if (this.recoveryInvalidated) return;
    this.recoveryInvalidated = true;
    this.fireInvalidation();
  }

  private isIgnoredTopLevel(filename: string | null): boolean {
    const subtree = this.ignored.subtree;
    if (subtree === undefined || filename === null || filename === '' || isAbsolute(filename)) {
      return false;
    }
    const top = topLevelSegment(filename);
    if (top === '' || top === '.' || top === '..' || top === basename(this.root)) return false;
    let verdict = this.ignoredTopLevel.get(top);
    if (verdict === undefined) {
      verdict = subtree(join(this.root, top));
      if (this.ignoredTopLevel.size >= IGNORED_TOP_LEVEL_CACHE_SIZE) this.ignoredTopLevel.clear();
      this.ignoredTopLevel.set(top, verdict);
    }
    return verdict;
  }

  private fireInvalidation(): void {
    this.emitter.fire({ path: this.root, action: 'modified', kind: 'directory' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readiness.resolve();
    this.retry?.dispose();
    this.nativeWatcher?.close();
    this.chokidarLeg?.dispose();
    this.emitter.dispose();
  }
}

function topLevelSegment(filename: string): string {
  let end = filename.length;
  for (let i = 0; i < filename.length; i += 1) {
    const ch = filename.charCodeAt(i);
    if (ch === 47 || ch === 92) {
      end = i;
      break;
    }
  }
  return filename.slice(0, end);
}

export class HostFsWatchService implements IHostFsWatchService {
  declare readonly _serviceBrand: undefined;

  private readonly reportedErrors = new Map<string, number>();
  private readonly reportError: WatchErrorReporter = (root, error, source) => {
    const code = watchErrorCode(error);
    const key = `${normalizeWatchRoot(root, this.runtime.platform)}\0${code}`;
    const now = Date.now();
    const lastReported = this.reportedErrors.get(key);
    if (lastReported !== undefined && now - lastReported < WATCH_ERROR_THROTTLE_MS) return;
    if (this.reportedErrors.size >= IGNORED_TOP_LEVEL_CACHE_SIZE) this.reportedErrors.clear();
    this.reportedErrors.set(key, now);
    const message =
      source === 'native'
        ? 'native recursive filesystem watch disabled after repeated errors'
        : 'filesystem watch failed';
    const payload = { root, code, source, message: describeWatchError(error) };
    this.log?.warn(message, payload);
  };

  constructor(
    private readonly runtime: HostFsWatchRuntime = NODE_HOST_FS_WATCH_RUNTIME,
    @ILogService private readonly log?: ILogService,
  ) {}

  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle {
    if (
      useNativeRecursive(options, this.runtime.platform) &&
      !isExpansiveNativeRoot(path, this.runtime)
    ) {
      return new SignalWatchHandle(path, options, this.runtime, this.reportError);
    }
    return this.runtime.watchFallback(path, options, this.reportError);
  }
}

function useNativeRecursive(
  options: HostFsWatchOptions | undefined,
  platform: NodeJS.Platform,
): boolean {
  return (
    options?.signal === true &&
    options.recursive !== false &&
    (platform === 'darwin' || platform === 'win32')
  );
}

function isExpansiveNativeRoot(root: string, runtime: HostFsWatchRuntime): boolean {
  const pathApi = runtime.platform === 'win32' ? win32 : posix;
  const normalizedRoot = normalizeWatchRoot(root, runtime.platform);
  const normalizedHome = normalizeWatchRoot(runtime.homeDir, runtime.platform);
  const filesystemRoot = normalizeWatchRoot(
    pathApi.parse(pathApi.resolve(root)).root,
    runtime.platform,
  );
  return normalizedRoot === normalizedHome || normalizedRoot === filesystemRoot;
}

function normalizeWatchRoot(root: string, platform: NodeJS.Platform): string {
  const resolved = (platform === 'win32' ? win32 : posix).resolve(root);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function watchErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'UNKNOWN';
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN';
}

function describeWatchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveNativeSignalPath(root: string, filename: string | null): string {
  if (filename === null || filename === '' || filename === basename(root)) return root;
  return clampToRoot(root, isAbsolute(filename) ? filename : join(root, filename));
}

function clampToRoot(root: string, absPath: string): string {
  const rel = relative(root, absPath);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return absPath;
  return root;
}

function mapChokidarEvent(eventName: string, absPath: string): HostFsChange | undefined {
  const mapped = mapActionAndKind(eventName);
  if (mapped === undefined) return undefined;
  return { path: absPath, action: mapped.action, kind: mapped.kind };
}

function mapActionAndKind(
  eventName: string,
): { action: HostFsChangeAction; kind: HostFsChangeKind } | undefined {
  switch (eventName) {
    case 'add':
      return { action: 'created', kind: 'file' };
    case 'addDir':
      return { action: 'created', kind: 'directory' };
    case 'change':
      return { action: 'modified', kind: 'file' };
    case 'unlink':
      return { action: 'deleted', kind: 'file' };
    case 'unlinkDir':
      return { action: 'deleted', kind: 'directory' };
    default:
      return undefined;
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostFsWatchService,
  HostFsWatchService,
  ScopeActivation.OnScopeCreated,
  'hostFsWatch',
  [NODE_HOST_FS_WATCH_RUNTIME],
);
