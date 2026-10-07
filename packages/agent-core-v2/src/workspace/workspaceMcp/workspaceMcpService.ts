import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import {
  McpConnectionManager,
  type McpConnectionView,
  type McpServerEntry,
} from '#/mcpCore/connection-manager';
import type { McpOAuthEvent, McpOAuthService } from '#/mcpCore/oauth/service';
import { canonicalMcpOAuthResource } from '#/mcpCore/oauth/store';
import {
  ISessionEphemeralMcpServers,
  ISessionPluginMcpServers,
  type SessionPluginMcpServers,
} from '#/session/mcp/ephemeralMcpServers';
import { FilteredMcpConnectionView } from '#/session/mcp/filteredConnectionView';
import { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import {
  IWorkspaceMcpConfigService,
  type McpServersChange,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';

import {
  IWorkspaceMcpService,
  type ISessionMcpOverlay,
  type SessionMcpOverlayOptions,
} from './workspaceMcp';

export class WorkspaceMcpService extends Disposable implements IWorkspaceMcpService {
  declare readonly _serviceBrand: undefined;

  private readonly manager: McpConnectionManager;
  private readonly oauthService: McpOAuthService;
  private readonly stdioCwd: string;
  private readonly workspaceId: string;
  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly resolveClientName = (): string | undefined => this.identity.current().slug;
  private readonly sessionLifecycle: LiveRef<ISessionManager>;
  private sessionLifecycleAttached = false;
  private readonly sessionOverlays = new Map<string, {
    readonly overlay: ISessionMcpOverlay;
    readonly explicit: Readonly<Record<string, McpServerConfig>>;
    readonly baseView: McpConnectionView;
    allNames: readonly string[];
  }>();

  constructor(
    @IWorkspaceContext workspace: IWorkspaceContext,
    @IRuntimeResolver private readonly runtimeResolver: IRuntimeResolver,
    @IWorkspaceMcpConfigService private readonly mcpConfig: IWorkspaceMcpConfigService,
    @IMcpOAuthService oauthService: McpOAuthService,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @ref(ISessionManager) sessionLifecycle: LiveRef<ISessionManager>,
    private readonly plugins?: IPluginService,
    private readonly usage?: IPluginUsageService,
  ) {
    super();
    this.sessionLifecycle = sessionLifecycle;
    this.stdioCwd = workspace.cwd;
    this.workspaceId = workspace.workspaceId;
    this.oauthService = oauthService;
    this.manager = new McpConnectionManager({
      log: this.log,
      oauthService: this.oauthService,
      stdioCwd: this.stdioCwd,
      runtimeResolver: this.runtimeResolver,
      workspaceId: workspace.workspaceId,
      runtimeId: 'local',
      allowsCall: (name) => this.mcpConfig.allowsCall?.(name) ?? Promise.resolve(true),
      resolveDefaultTimeouts: () => this.mcpConfig.tunables(),
      resolveClientName: this.resolveClientName,
    });
    this._register({ dispose: () => void this.manager.shutdown() });
    this._register(
      this.mcpConfig.onDidChange((change) => {
        change.waitUntil(this.scheduleApply(change));
      }),
    );
    if (this.usage !== undefined && this.plugins !== undefined) this._register(this.usage.onDidChange((event) => {
      if (event.workspaceId !== this.workspaceId) return;
      const refresh = event.sessionId === undefined
        ? Promise.all([...this.sessionOverlays.keys()].map((sessionId) => this.refreshSessionOverlay(sessionId)))
        : this.refreshSessionOverlay(event.sessionId);
      event.waitUntil(refresh);
    }));
    if (this.plugins !== undefined) this._register(this.plugins.onDidReload((event) => {
      event.waitUntil(Promise.all([...this.sessionOverlays.keys()].map((sessionId) => this.refreshSessionOverlay(sessionId))));
    }));
    this._register({ dispose: this.oauthEventSubscription(this.manager) });
    this.attachSessionLifecycle();
    this._register(sessionLifecycle.onDidChange(() => this.attachSessionLifecycle()));
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
    });
  }

  private attachSessionLifecycle(): void {
    if (this.sessionLifecycleAttached) return;
    const lifecycle = this.sessionLifecycle.current;
    if (lifecycle?.onWillCreateSession === undefined) return;
    this.sessionLifecycleAttached = true;
    this._register(
      lifecycle.onWillCreateSession((event) => {
        if (event.readSeed(ISessionContext).workspaceId !== this.workspaceId) return;
        let pluginServers: SessionPluginMcpServers = { allNames: [], enabled: {} };
        try {
          pluginServers = event.readSeed(ISessionPluginMcpServers) ?? pluginServers;
        } catch { }
        const servers = event.readSeed(ISessionEphemeralMcpServers) ?? {};
        const baseline = this.sessionHandle(pluginServers);
        const pluginOverlay = Object.fromEntries(
          Object.entries(pluginServers.enabled).filter(([name]) =>
            !this.mcpConfig.isFileServer?.(name) && baseline.connectionManager.get(name) === undefined),
        );
        const overlayServers = { ...pluginOverlay, ...servers };
        const sessionId = event.readSeed(ISessionContext).sessionId;
        if (Object.keys(overlayServers).length === 0 && this.plugins === undefined) return;
        const overlay = this.plugins === undefined
          ? this.sessionOverlay(overlayServers, { stdioCwd: event.readSeed(ISessionContext).cwd })
          : this.sessionOverlay(overlayServers, {
              stdioCwd: event.readSeed(ISessionContext).cwd,
            }, baseline.connectionManager);
        this.sessionOverlays.set(sessionId, {
          overlay,
          explicit: servers,
          baseView: baseline.connectionManager,
          allNames: pluginServers.allNames,
        });
        event.contributeSeed(ISessionMcpHandle, overlay.handle);
        event.onSessionDispose(() => {
          this.sessionOverlays.delete(sessionId);
          void overlay.shutdown();
        });
      }),
    );
  }

  connectionManager(): McpConnectionManager {
    return this.manager;
  }

  sessionHandle(pluginServers?: SessionPluginMcpServers): ISessionMcpHandle {
    const hidden = pluginServers === undefined
      ? new Set<string>()
      : new Set(pluginServers.allNames.filter((name) =>
        !Object.hasOwn(pluginServers.enabled, name) && !this.mcpConfig.isFileServer?.(name),
      ));
    const view: McpConnectionView = new FilteredMcpConnectionView(this.manager, hidden);
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      connectionManager: view,
      isBaselineServer: this.sessionBaseline(view, this.ready),
    };
  }

  sessionOverlay(
    servers: Readonly<Record<string, McpServerConfig>>,
    opts?: SessionMcpOverlayOptions,
    baseView: McpConnectionView = this.manager,
  ): ISessionMcpOverlay {
    const sessionManager = new McpConnectionManager({
      log: this.log,
      oauthService: this.oauthService,
      stdioCwd: opts?.stdioCwd ?? this.stdioCwd,
      runtimeResolver: this.runtimeResolver,
      workspaceId: this.workspaceId,
      runtimeId: 'local',
      requireStdioRuntimeId: true,
      resolveDefaultTimeouts: () => this.mcpConfig.tunables(),
      resolveClientName: this.resolveClientName,
    });
    let overlayNames = new Set(Object.keys(servers));
    const connect = Promise.all([this.mcpConfig.ready, this.identity.resolved()])
      .then(() => sessionManager.connectAll({ ...servers }))
      .catch((error: unknown) => {
        this.log.error('session mcp overlay initial load failed', { error });
      });
    const unsubscribeOAuth = this.oauthEventSubscription(sessionManager);
    const view = new MergedMcpConnectionView(
      baseView,
      sessionManager,
      overlayNames,
    );
    const update = async (next: Readonly<Record<string, McpServerConfig>>): Promise<void> => {
      await connect;
      const nextNames = new Set(Object.keys(next));
      for (const name of overlayNames) {
        if (nextNames.has(name)) continue;
        const config = sessionManager.configOf(name);
        if (config === undefined) await sessionManager.remove(name);
        else await sessionManager.connect(name, { ...config, enabled: false });
      }
      for (const [name, config] of Object.entries(next)) await sessionManager.connect(name, config);
      overlayNames = nextNames;
      view.replaceOverlayNames(overlayNames);
    };
    const ready = Promise.all([this.ready, connect]).then(() => undefined);
    return {
      handle: {
        _serviceBrand: undefined,
        ready,
        connectionManager: view,
        isBaselineServer: this.sessionBaseline(baseView, this.ready, Object.keys(servers)),
      },
      update,
      shutdown: () => {
        unsubscribeOAuth();
        return sessionManager.shutdown();
      },
    };
  }

  private async refreshSessionOverlay(sessionId: string): Promise<void> {
    const entry = this.sessionOverlays.get(sessionId);
    if (entry === undefined || this.plugins === undefined) return;
    const [all, enabled] = await Promise.all([
      this.plugins.enabledMcpServers('*'),
      this.plugins.enabledMcpServers(this.workspaceId, sessionId),
    ]);
    entry.allNames = Object.keys(all);
    const hidden = new Set(entry.allNames.filter((name) =>
      !Object.hasOwn(enabled, name) && !this.mcpConfig.isFileServer?.(name),
    ));
    if (entry.baseView instanceof FilteredMcpConnectionView) entry.baseView.replaceHidden(hidden);
    const pluginOverlay = Object.fromEntries(
      Object.entries(enabled).filter(([name]) =>
        !this.mcpConfig.isFileServer?.(name) && this.manager.get(name) === undefined),
    );
    await entry.overlay.update?.({ ...pluginOverlay, ...entry.explicit });
  }

  private oauthEventSubscription(manager: McpConnectionManager): () => void {
    return this.oauthService.onEvent((event) => {
      void this.handleMcpOAuthEvent(manager, event).catch((error: unknown) => {
        this.log.warn(`mcp oauth event handling failed: ${String(error)}`);
      });
    });
  }

  private async handleMcpOAuthEvent(
    manager: McpConnectionManager,
    event: McpOAuthEvent,
  ): Promise<void> {
    if (event.type === 'tokens-invalidated' && event.scope !== 'tokens' && event.scope !== 'all') {
      return;
    }
    const entry = manager.get(event.serverName);
    if (entry === undefined) return;
    const serverUrl = manager.getRemoteServerUrl(event.serverName);
    if (serverUrl === undefined || canonicalMcpOAuthResource(serverUrl) !== event.serverUrl) return;
    if (event.type === 'tokens-invalidated') {
      this.oauthService.forgetProvider(event.serverName, event.serverUrl);
      if (entry.status === 'needs-auth') return;
    }
    if (entry.status === 'disabled' || entry.status === 'removed') return;
    if (entry.status === 'pending') {
      await new Promise<void>((resolve, reject) => {
        let unsubscribe = (): void => {};
        let settled = false;
        const reconnect = (next: McpServerEntry | undefined): void => {
          if (settled) return;
          if (next !== undefined && (next.name !== event.serverName || next.status === 'pending')) {
            return;
          }
          settled = true;
          unsubscribe();
          if (next === undefined || next.status === 'disabled' || next.status === 'removed') {
            resolve();
            return;
          }
          void manager.reconnectAfterCurrent(event.serverName).then(resolve, reject);
        };
        unsubscribe = manager.onStatusChange(reconnect);
        if (settled) unsubscribe();
        else reconnect(manager.get(event.serverName));
      });
      return;
    }
    if (
      event.type === 'tokens-saved' &&
      entry.status !== 'needs-auth' &&
      entry.status !== 'failed'
    ) {
      return;
    }
    if (event.type === 'refresh-failed' && entry.status !== 'connected') return;
    await manager.reconnectAndJoin(event.serverName);
  }

  private sessionBaseline(
    view: McpConnectionView,
    ready: Promise<void>,
    extra?: readonly string[],
  ): (name: string) => boolean {
    let baseline: Set<string> | undefined;
    let frozen = false;
    const snapshot = (): Set<string> => {
      if (baseline === undefined) {
        baseline = new Set<string>(extra);
        for (const entry of view.list()) {
          baseline.add(entry.name);
        }
      }
      return baseline;
    };
    void ready.then(
      () => {
        snapshot();
        frozen = true;
      },
      () => {
        snapshot();
        frozen = true;
      },
    );
    return (name) => {
      const names = snapshot();
      if (names.has(name)) return true;
      if (frozen) return false;
      if (view.get(name) === undefined) return false;
      names.add(name);
      return true;
    };
  }

  private mutate(work: () => Promise<void>): Promise<void> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail;
    return tail;
  }

  private async initialize(): Promise<void> {
    await this.mcpConfig.ready;
    await this.identity.resolved();
    const servers = this.mcpConfig.servers();
    if (Object.keys(servers).length === 0) return;
    await this.manager.connectAll(servers);
    this.trackMcpInitialLoad();
  }

  private scheduleApply(change: McpServersChange): Promise<void> {
    return this.ready
      .then(() => this.mutate(() => this.apply(change)))
      .catch((error) => {
        this.log.warn(`mcp server change apply failed: ${String(error)}`);
        change.reportFailure?.(error);
      });
  }

  private async apply(change: McpServersChange): Promise<void> {
    for (const name of change.remove) {
      await this.manager.markRemoved(name);
    }
    for (const [name, config] of Object.entries(change.upsert)) {
      await this.manager.connect(name, config);
    }
  }

  private trackMcpInitialLoad(): void {
    const entries = this.manager.list().filter((entry) => entry.status !== 'disabled');
    const totalCount = entries.length;
    if (totalCount === 0) return;

    const connectedCount = entries.filter((entry) => entry.status === 'connected').length;
    if (connectedCount > 0) {
      this.telemetry.track2('mcp_connected', {
        server_count: connectedCount,
        total_count: totalCount,
      });
    }

    const failedCount = entries.filter((entry) => entry.status === 'failed').length;
    if (failedCount > 0) {
      this.telemetry.track2('mcp_failed', {
        failed_count: failedCount,
        total_count: totalCount,
      });
    }
  }
}
