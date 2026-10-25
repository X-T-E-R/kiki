import {
  type IDisposable,
  type ISessionScopeHandle,
  ISessionWorkspaceContext,
  ISessionContext,
  IRuntimeResolver,
  IWorkspaceInstanceManager,
  ISessionManager,
  getLiveSessionById,
  type Scope,
} from '@kiki/agent-core-v2';
import type { Runtime, RuntimeLease } from '@kiki/agent-core-v2/runtime/runtime';
import { RuntimeWorkspaceView } from '@kiki/agent-core-v2/runtime/runtimeWorkspaceView';
import type { IHostFsWatchHandle, HostFsChange } from '@kiki/agent-core-v2/os/interface/hostFsWatch';
import type { FsChangeEntry, FsChangeEvent } from '@kiki/agent-core-v2/workspace/workspaceFs/fsWatch';

import { acquireSessionOperation, type SessionOperationLease } from '../../../lib/sessionOperationLease';
import type { EventEnvelope, JournalLogger } from './sessionEventJournal';

const MAX_PATHS_PER_CONNECTION = 100;
const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_CHANGES_PER_WINDOW = 500;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sessionRuntimeKey(sessionId: string, runtimeId: string): string {
  return `${sessionId}\0${runtimeId}`;
}

export const FS_WATCH_CODE = {
  OK: 0,
  PATH_ESCAPES: 41304,
  LIMIT_EXCEEDED: 42902,
  SESSION_NOT_FOUND: 40409,
} as const;

export interface FsChangedFrame {
  readonly type: 'event.fs.changed';
  readonly seq: number;
  readonly session_id: string;
  readonly timestamp: string;
  readonly payload: FsChangeEvent;
}

/** Minimal connection surface the bridge needs (satisfied by `WsConnectionV1`). */
export interface FsWatchConnection {
  readonly id: string;
  send(envelope: EventEnvelope): void;
}

export interface FsWatchAck {
  readonly code: number;
  readonly msg: string;
  readonly watched_paths?: readonly string[];
  readonly current_count?: number;
}

interface ConnEntry {
  readonly conn: FsWatchConnection;
  readonly paths: Set<string>;
}

interface SessionWatch {
  readonly id: string;
  readonly runtimeId: string;
  readonly workspaceId: string;
  readonly generation: string;
  readonly session: ISessionScopeHandle;
  readonly runtime: Runtime;
  readonly view: RuntimeWorkspaceView;
  readonly handle: IHostFsWatchHandle;
  readonly lease: RuntimeLease;
  readonly sessionLease: SessionOperationLease;
  readonly workspace: ISessionWorkspaceContext;
  readonly conns: Map<string, ConnEntry>;
  union: Set<string>;
  seq: number;
  sub: IDisposable | undefined;
  pending: FsChangeEntry[];
  rawCount: number;
  truncated: boolean;
  debounceTimer: NodeJS.Timeout | undefined;
  readonly debounceMs: number;
  readonly maxChangesPerWindow: number;
}

interface PendingWatchBuild {
  readonly task: Promise<SessionWatch | undefined>;
  readonly connections: Set<FsWatchConnection>;
  readonly abort: AbortController;
}

export class FsWatchBridge {
  private readonly core: Scope;
  private readonly logger: JournalLogger | undefined;
  private readonly bySession = new Map<string, SessionWatch>();
  private readonly connPathCount = new Map<string, number>();
  private readonly rebuilding = new Map<string, PendingWatchBuild>();
  private readonly detached = new WeakSet<FsWatchConnection>();
  private readonly tornDown = new WeakSet<SessionWatch>();
  private readonly registrySubscriptions = new Map<string, IDisposable>();
  private readonly pendingDisposals = new Set<Promise<void>>();
  private readonly sessionLifecycles: IDisposable[];
  private disposed = false;

  constructor(opts: { core: Scope; logger?: JournalLogger }) {
    this.core = opts.core;
    this.logger = opts.logger;
    const manager = this.core.accessor.get(ISessionManager);
    this.sessionLifecycles = [
      manager.onDidCloseSession?.(({ sessionId }) => this.teardownSessionWatches(sessionId)),
      manager.onDidArchiveSession?.(({ sessionId }) => this.teardownSessionWatches(sessionId)),
    ].filter((subscription): subscription is IDisposable => subscription !== undefined);
  }

  private collect(result: void | Promise<void>): void {
    if (!(result instanceof Promise)) return;
    this.pendingDisposals.add(result);
    result.finally(() => this.pendingDisposals.delete(result)).catch(() => {});
  }

  async addWatch(
    conn: FsWatchConnection,
    sessionId: string,
    rawPaths: readonly string[],
    runtimeId: string,
  ): Promise<FsWatchAck> {
    const key = sessionRuntimeKey(sessionId, runtimeId);
    if (rawPaths.length === 0) {
      const pending = this.rebuilding.get(key);
      if (pending !== undefined) {
        pending.connections.delete(conn);
        if (pending.connections.size === 0) pending.abort.abort();
      }
      if (getLiveSessionById(this.core.accessor, sessionId) === undefined) {
        return { code: FS_WATCH_CODE.SESSION_NOT_FOUND, msg: 'session not found' };
      }
      const sw = this.bySession.get(key);
      const paths = sw?.conns.get(conn.id)?.paths;
      if (paths !== undefined && paths.size > 0) return this.removeWatch(conn, sessionId, [...paths], runtimeId);
      return { code: FS_WATCH_CODE.OK, msg: 'success', watched_paths: [], current_count: this.countFor(conn.id) };
    }
    const resolving = this.resolveSession(conn, sessionId, runtimeId);
    const pending = this.rebuilding.get(key);
    const sw = await resolving;
    if (
      sw === undefined ||
      this.disposed ||
      this.detached.has(conn) ||
      this.bySession.get(key) !== sw ||
      this.tornDown.has(sw) ||
      (pending !== undefined && (pending.abort.signal.aborted || !pending.connections.has(conn))) ||
      sw.sessionLease.handle !== getLiveSessionById(this.core.accessor, sessionId) ||
      !this.isCurrentGeneration(sw)
    ) {
      if (sw !== undefined) this.cleanupOrphan(sw);
      return { code: FS_WATCH_CODE.SESSION_NOT_FOUND, msg: 'session not found' };
    }
    try {
      const normalized: string[] = [];
      for (const raw of rawPaths) {
        const rel = this.normalize(sw, raw);
        if (rel === undefined) return { code: FS_WATCH_CODE.PATH_ESCAPES, msg: 'fs.path_escapes_session' };
        normalized.push(rel);
      }

      let entry = sw.conns.get(conn.id);
      const toAdd: string[] = [];
      for (const rel of normalized) {
        if (entry?.paths.has(rel)) continue;
        toAdd.push(rel);
      }
      const current = this.connPathCount.get(conn.id) ?? 0;
      if (current + toAdd.length > MAX_PATHS_PER_CONNECTION) {
        return { code: FS_WATCH_CODE.LIMIT_EXCEEDED, msg: 'fs.watch_limit_exceeded' };
      }

      if (entry === undefined) {
        entry = { conn, paths: new Set() };
        sw.conns.set(conn.id, entry);
      }
      for (const rel of toAdd) entry.paths.add(rel);
      this.connPathCount.set(conn.id, current + toAdd.length);
      this.recomputeAndApply(sw);
      return this.ok(sw, conn);
    } finally {
      this.cleanupOrphan(sw);
    }
  }

  async removeWatch(
    conn: FsWatchConnection,
    sessionId: string,
    rawPaths: readonly string[],
    runtimeId: string,
  ): Promise<FsWatchAck> {
    const sw = this.bySession.get(sessionRuntimeKey(sessionId, runtimeId));
    const entry = sw?.conns.get(conn.id);
    if (sw === undefined || entry === undefined) {
      return { code: FS_WATCH_CODE.OK, msg: 'success', watched_paths: [], current_count: this.countFor(conn.id) };
    }

    let removed = 0;
    for (const raw of rawPaths) {
      const rel = this.normalize(sw, raw) ?? raw;
      if (entry.paths.delete(rel)) removed += 1;
    }
    this.connPathCount.set(conn.id, Math.max(0, this.countFor(conn.id) - removed));
    if (entry.paths.size === 0) sw.conns.delete(conn.id);
    this.recomputeAndApply(sw);
    if (sw.conns.size === 0) this.teardownSession(sw);

    return this.ok(sw, conn);
  }

  /** Drop every subscription held by `conn` (called on socket close). */
  detachConnection(conn: FsWatchConnection): void {
    this.detached.add(conn);
    for (const pending of this.rebuilding.values()) {
      pending.connections.delete(conn);
      if (pending.connections.size === 0) pending.abort.abort();
    }
    for (const sw of Array.from(this.bySession.values())) {
      const entry = sw.conns.get(conn.id);
      if (entry === undefined) continue;
      sw.conns.delete(conn.id);
      this.connPathCount.set(conn.id, Math.max(0, this.countFor(conn.id) - entry.paths.size));
      this.recomputeAndApply(sw);
      if (sw.conns.size === 0) this.teardownSession(sw);
    }
    this.connPathCount.delete(conn.id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.sessionLifecycles) this.collect(subscription.dispose());
    for (const pending of this.rebuilding.values()) pending.abort.abort();
    for (const subscription of this.registrySubscriptions.values()) this.collect(subscription.dispose());
    this.registrySubscriptions.clear();
    for (const sw of this.bySession.values()) this.teardownSession(sw);
    this.connPathCount.clear();
  }

  private teardownSessionWatches(sessionId: string): void {
    for (const [key, pending] of this.rebuilding) {
      if (key.startsWith(`${sessionId}\0`)) pending.abort.abort();
    }
    for (const sw of this.bySession.values()) {
      if (sw.id !== sessionId) continue;
      for (const { conn, paths } of sw.conns.values()) {
        this.connPathCount.set(conn.id, Math.max(0, this.countFor(conn.id) - paths.size));
      }
      this.teardownSession(sw);
    }
  }

  private async resolveSession(conn: FsWatchConnection, sessionId: string, runtimeId: string): Promise<SessionWatch | undefined> {
    if (this.disposed || this.detached.has(conn)) return undefined;
    const key = sessionRuntimeKey(sessionId, runtimeId);
    const pending = this.rebuilding.get(key);
    if (pending !== undefined) {
      pending.connections.add(conn);
      return pending.task;
    }
    const existing = this.bySession.get(key);
    if (existing !== undefined) {
      if (this.isCurrentGeneration(existing)) return existing;
      return this.rebuild(existing, conn);
    }
    if (getLiveSessionById(this.core.accessor, sessionId) === undefined) return undefined;
    return this.build(key, [conn], (signal) => this.createSessionWatch(sessionId, runtimeId, undefined, signal));
  }

  private build(
    key: string,
    connections: readonly FsWatchConnection[],
    work: (signal: AbortSignal) => Promise<SessionWatch | undefined>,
  ): Promise<SessionWatch | undefined> {
    const abort = new AbortController();
    let pending!: PendingWatchBuild;
    const task = work(abort.signal).finally(() => {
      if (this.rebuilding.get(key) === pending) this.rebuilding.delete(key);
    });
    pending = { task, connections: new Set(connections), abort };
    this.rebuilding.set(key, pending);
    return task;
  }

  private async createSessionWatch(
    sessionId: string,
    runtimeId: string,
    carried: { readonly conns: Map<string, ConnEntry>; readonly seq: number } | undefined,
    signal: AbortSignal,
  ): Promise<SessionWatch | undefined> {
    const key = sessionRuntimeKey(sessionId, runtimeId);
    const sessionLease = await acquireSessionOperation(this.core, sessionId, 'fs-watch');
    let lease: RuntimeLease | undefined;
    let handle: IHostFsWatchHandle | undefined;
    let sw: SessionWatch | undefined;
    try {
      const session = sessionLease.handle;
      if (session === undefined || signal.aborted || this.disposed) return undefined;
      const context = session.accessor.get(ISessionWorkspaceContext);
      const sessionContext = session.accessor.get(ISessionContext);
      lease = this.core.accessor.get(IRuntimeResolver).acquire(
        { workspaceId: sessionContext.workspaceId, runtimeId },
        ['watch'],
      );
      const view = new RuntimeWorkspaceView(lease.runtime, context);
      handle = lease.track(lease.runtime.watch!.watch(view.workDir, { recursive: true }));
      await readyOrAborted(handle.ready, signal);
      if (signal.aborted || this.disposed) return undefined;
      sw = {
        id: sessionId,
        runtimeId,
        workspaceId: sessionContext.workspaceId,
        generation: lease.runtime.identity.generation,
        session,
        runtime: lease.runtime,
        view,
        handle,
        lease,
        sessionLease,
        workspace: context,
        conns: carried?.conns ?? new Map(),
        union: new Set(),
        seq: carried?.seq ?? 0,
        sub: undefined,
        pending: [],
        rawCount: 0,
        truncated: false,
        debounceTimer: undefined,
        debounceMs: readPositiveIntEnv('KIKI_FS_WATCH_DEBOUNCE_MS', DEFAULT_DEBOUNCE_MS),
        maxChangesPerWindow: readPositiveIntEnv('KIKI_FS_WATCH_MAX_CHANGES_PER_WINDOW', DEFAULT_MAX_CHANGES_PER_WINDOW),
      };
      sw.sub = handle.onDidChange((event) => this.onRuntimeEvent(key, event));
      this.recomputeAndApply(sw);
      this.bySession.set(key, sw);
      this.subscribeRegistry(sessionContext.workspaceId);
      return sw;
    } catch (error) {
      if (sw !== undefined && this.bySession.get(key) === sw) {
        const created = sw;
        sw = undefined;
        handle = undefined;
        lease = undefined;
        this.teardownSession(created);
      }
      if (!signal.aborted) throw error;
      return undefined;
    } finally {
      if (sw === undefined || this.bySession.get(key) !== sw) {
        this.collect(sw?.sub?.dispose());
        this.collect(handle?.dispose());
        this.collect(lease?.dispose());
        this.collect(sessionLease.dispose());
      }
    }
  }

  private rebuild(sw: SessionWatch, joining?: FsWatchConnection): Promise<SessionWatch | undefined> {
    const key = sessionRuntimeKey(sw.id, sw.runtimeId);
    const pending = this.rebuilding.get(key);
    if (pending !== undefined) {
      if (joining !== undefined) pending.connections.add(joining);
      return pending.task;
    }
    const connections = [...sw.conns.values()].map((entry) => entry.conn);
    if (joining !== undefined && !connections.includes(joining)) connections.push(joining);
    return this.build(key, connections, async (signal) => {
      const next = await this.createSessionWatch(sw.id, sw.runtimeId, { conns: sw.conns, seq: sw.seq }, signal);
      if (next !== undefined) this.teardownSession(sw);
      return next;
    });
  }

  private async refreshIfStale(sw: SessionWatch): Promise<void> {
    const key = sessionRuntimeKey(sw.id, sw.runtimeId);
    const pending = this.rebuilding.get(key);
    if (pending !== undefined) await pending.task.catch(() => undefined);
    const current = this.bySession.get(key);
    if (current === undefined || this.isCurrentGeneration(current)) return;
    try {
      await this.rebuild(current);
    } catch (error) {
      this.logger?.warn({ sessionId: sw.id, err: String(error) }, 'fs-watch rebuild after runtime generation change failed');
    }
  }

  private isCurrentGeneration(sw: SessionWatch): boolean {
    try {
      const runtime = this.core.accessor.get(IRuntimeResolver).inspect({ workspaceId: sw.workspaceId, runtimeId: sw.runtimeId });
      return runtime.identity.generation === sw.generation;
    } catch {
      return false;
    }
  }

  private subscribeRegistry(workspaceId: string): void {
    if (this.registrySubscriptions.has(workspaceId)) return;
    const workspace = this.core.accessor.get(IWorkspaceInstanceManager).get(workspaceId);
    if (workspace === undefined) return;
    const subscription = workspace.runtimes.onDidChange((change) => {
      for (const sw of this.bySession.values()) {
        if (sw.workspaceId !== workspaceId || sw.runtimeId !== change.runtimeId) continue;
        void this.refreshIfStale(sw);
      }
    });
    this.registrySubscriptions.set(workspaceId, subscription);
  }

  private recomputeAndApply(sw: SessionWatch): void {
    const union = new Set<string>();
    for (const { paths } of sw.conns.values()) {
      for (const p of paths) union.add(p);
    }
    sw.union = union;
  }

  private teardownSession(sw: SessionWatch): void {
    if (this.tornDown.has(sw)) return;
    this.tornDown.add(sw);
    const key = sessionRuntimeKey(sw.id, sw.runtimeId);
    if (this.bySession.get(key) === sw) this.bySession.delete(key);
    if (sw.debounceTimer !== undefined) clearTimeout(sw.debounceTimer);
    sw.debounceTimer = undefined;
    this.collect(sw.sub?.dispose());
    sw.sub = undefined;
    this.collect(sw.handle.dispose());
    this.collect(sw.lease.dispose());
    this.collect(sw.sessionLease.dispose());
  }

  private cleanupOrphan(sw: SessionWatch): void {
    queueMicrotask(() => {
      if (sw.conns.size === 0 && this.bySession.get(sessionRuntimeKey(sw.id, sw.runtimeId)) === sw) {
        try {
          this.teardownSession(sw);
        } catch (error) {
          this.logger?.warn({ sessionId: sw.id, err: String(error) }, 'fs-watch orphan teardown failed');
        }
      }
    });
  }

  private onRuntimeEvent(key: string, event: HostFsChange): void {
    const sw = this.bySession.get(key);
    if (sw === undefined) return;
    const relative = sw.runtime.path.relative(sw.view.workDir, event.path);
    const path = relative === '' ? '.' : relative.split(sw.runtime.path.separator).join('/');
    if (!isUnderAny(path, sw.union)) return;
    sw.pending.push({ path, change: event.action, kind: event.kind });
    sw.rawCount += 1;
    if (sw.pending.length > sw.maxChangesPerWindow) {
      sw.truncated = true;
      sw.pending = [];
    }
    if (sw.debounceTimer === undefined) {
      sw.debounceTimer = setTimeout(() => this.flush(key), sw.debounceMs);
      sw.debounceTimer.unref?.();
    }
  }

  private flush(key: string): void {
    const sw = this.bySession.get(key);
    if (sw === undefined) return;
    sw.debounceTimer = undefined;
    if (sw.rawCount === 0) return;
    const truncated = sw.truncated;
    const count = sw.rawCount;
    const changes = truncated ? [] : sw.pending;
    sw.pending = [];
    sw.rawCount = 0;
    sw.truncated = false;
    this.onSessionEvent(key, {
      changes,
      coalesced_window_ms: sw.debounceMs,
      ...(truncated ? { truncated: true, count } : {}),
    });
  }

  private onSessionEvent(key: string, ev: FsChangeEvent): void {
    const sw = this.bySession.get(key);
    if (sw === undefined) return;
    for (const { conn, paths } of sw.conns.values()) {
      let changes: FsChangeEntry[];
      if (ev.truncated === true) {
        changes = [];
      } else {
        changes = ev.changes.filter((c) => isUnderAny(c.path, paths));
        if (changes.length === 0) continue;
      }
      sw.seq += 1;
      const frame: FsChangedFrame = {
        type: 'event.fs.changed',
        seq: sw.seq,
        session_id: sw.id,
        timestamp: new Date().toISOString(),
        payload: {
          changes,
          coalesced_window_ms: ev.coalesced_window_ms,
          ...(ev.truncated === true ? { truncated: true, count: ev.count } : {}),
        },
      };
      try {
        conn.send(frame as EventEnvelope);
      } catch (error) {
        this.logger?.warn({ sessionId: sw.id, err: String(error) }, 'fs-watch send failed');
      }
    }
  }

  /** Lexical confinement + workspace-relative normalization (no `stat`). */
  private normalize(sw: SessionWatch, raw: string): string | undefined {
    if (raw === '' || raw === '/') return undefined;
    if (sw.runtime.path.isAbsolute(raw)) return undefined;
    if (raw.split(/[/\\]+/).some((s) => s === '..')) return undefined;
    try {
      const absolute = sw.view.resolve(raw);
      const relative = sw.runtime.path.relative(sw.view.workDir, absolute);
      return relative === '' ? '.' : relative.split(sw.runtime.path.separator).join('/');
    } catch {
      return undefined;
    }
  }

  private ok(sw: SessionWatch, conn: FsWatchConnection): FsWatchAck {
    const entry = sw.conns.get(conn.id);
    return {
      code: FS_WATCH_CODE.OK,
      msg: 'success',
      watched_paths: entry === undefined ? [] : [...entry.paths].sort(),
      current_count: this.countFor(conn.id),
    };
  }

  private countFor(connId: string): number {
    return this.connPathCount.get(connId) ?? 0;
  }
}

function readyOrAborted(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('fs watch cancelled'));
  return new Promise<void>((resolve, reject) => {
    const cancel = (): void => { finish(); reject(new Error('fs watch cancelled')); };
    const finish = (): void => { signal.removeEventListener('abort', cancel); };
    signal.addEventListener('abort', cancel, { once: true });
    void ready.then(
      () => { finish(); resolve(); },
      (error: unknown) => { finish(); reject(error); },
    );
  });
}

function isUnderAny(rel: string, parents: ReadonlySet<string>): boolean {
  for (const parent of parents) {
    if (parent === '.' || parent === '') return true;
    if (rel === parent) return true;
    if (rel.startsWith(`${parent}/`)) return true;
  }
  return false;
}
