import { randomUUID } from 'node:crypto';
import {
  IPluginHostService,
  IPluginService,
  IPluginUsageService,
  ISessionActivityView,
  ISessionManager,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  type Scope,
} from '@kiki/agent-core-v2';
import type { ServiceIdentifier } from '@kiki/agent-core-v2/_base/di/instantiation';
import type { ISessionScopeHandle } from '@kiki/agent-core-v2/_base/di/scope';
import type { IDisposable } from '@kiki/agent-core-v2/_base/di/lifecycle';
import type { SpaceSummary } from '@kiki/protocol';
import { listExportedTools } from '../threadBridge/remoteToolsHost';
import { currentSpacePlatform, machineLabel } from './pairing';

function optionalService<T>(core: Scope, id: ServiceIdentifier<T>): T | undefined {
  try {
    return core.accessor.get(id);
  } catch {
    return undefined;
  }
}

export class SpaceSummaryProjection {
  private revision = 0;
  private readonly epoch = randomUUID();
  private readonly watchers = new Map<string, IDisposable>();
  private readonly listeners: IDisposable[] = [];
  private readonly pendingDisposals: Promise<void>[] = [];
  private workspaceCount: number | undefined;
  private borrowableToolCount: number | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshFlight: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly core: Scope) {
    const manager = core.accessor.get(ISessionManager);
    for (const session of manager.list()) this.watch(session);
    const created = manager.onDidCreateSession?.(({ sessionId }) => { const session = manager.get(sessionId); if (session !== undefined) this.watch(session); });
    const closed = manager.onDidCloseSession?.(({ sessionId }) => this.unwatch(sessionId));
    const archived = manager.onDidArchiveSession?.(({ sessionId }) => this.unwatch(sessionId));
    const plugins = optionalService(core, IPluginService);
    const pluginUsage = optionalService(core, IPluginUsageService);
    const pluginReloaded = plugins?.onDidReload?.(() => { void this.refreshCounts(); });
    const pluginUsageChanged = pluginUsage?.onDidChange?.(() => { void this.refreshCounts(); });
    const pluginUsageApplied = pluginUsage?.onDidApply?.(() => { void this.refreshCounts(); });
    for (const listener of [created, closed, archived, pluginReloaded, pluginUsageChanged, pluginUsageApplied]) {
      if (listener !== undefined) this.listeners.push(listener);
    }
    this.refreshTimer = setInterval(() => { void this.refreshCounts(); }, 30_000);
    this.refreshTimer.unref();
    void this.refreshCounts();
  }

  read(): SpaceSummary {
    let busy = 0; let needsYou = 0;
    for (const session of this.core.accessor.get(ISessionManager).list()) {
      const state = session.accessor.get(ISessionActivityView).state();
      if (state.busy) busy += 1;
      if (state.pendingInteraction !== 'none') needsYou += 1;
    }
    return {
      online: true,
      busy_sessions: busy,
      needs_you_sessions: needsYou,
      revision: `${this.epoch}:${this.revision}`,
      as_of: Date.now(),
      platform: currentSpacePlatform(),
      arch: process.arch,
      hostname: machineLabel(),
      workspace_count: this.workspaceCount,
      borrowable_tool_count: this.borrowableToolCount,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const watcher of this.watchers.values()) this.collect(watcher.dispose());
    for (const listener of this.listeners) this.collect(listener.dispose());
    this.watchers.clear();
  }

  async disposeAsync(): Promise<void> {
    if (this.refreshFlight !== undefined) await this.refreshFlight.catch(() => undefined);
    await Promise.all(this.pendingDisposals.splice(0));
  }

  private refreshCounts(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.refreshFlight !== undefined) return this.refreshFlight;
    const work = (async () => {
      try {
        const workspaces = optionalService(this.core, IWorkspaceService);
        if (workspaces !== undefined) {
          const list = await workspaces.list();
          if (!this.disposed) this.workspaceCount = list.length;
        }
      } catch {}
      try {
        const hasToolSources = optionalService(this.core, IPluginHostService) !== undefined
          || optionalService(this.core, IWorkspaceInstanceManager) !== undefined;
        if (hasToolSources) {
          const exported = await listExportedTools(this.core, undefined, { materializeCold: false });
          if (!this.disposed) this.borrowableToolCount = exported.tools.length;
        }
      } catch {}
    })().finally(() => {
      if (this.refreshFlight === work) this.refreshFlight = undefined;
    });
    this.refreshFlight = work;
    return work;
  }

  private collect(result: void | Promise<void>): void {
    if (result instanceof Promise) this.pendingDisposals.push(result);
  }

  private watch(session: ISessionScopeHandle): void {
    this.unwatch(session.id);
    this.watchers.set(session.id, session.accessor.get(ISessionActivityView).onDidChange(() => { this.revision += 1; }));
    this.revision += 1;
  }

  private unwatch(sessionId: string): void { this.collect(this.watchers.get(sessionId)?.dispose()); this.watchers.delete(sessionId); this.revision += 1; }
}
