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
  mcpServerConfigsEqual,
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
    @IPluginService private readonly plugins?: IPluginService,
    @IPluginUsageService private readonly usage?: IPluginUsageService,
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
        const overlay = this.plugins === undefined
          ? this.sessionOverlay(overlayServers, { stdioCwd: event.readSeed(ISessionContext).cwd, sessionId })
          : this.sessionOverlay(overlayServers, {
              stdioCwd: event.readSeed(ISessionContext).cwd,
              sessionId,
            }, baseline.connectionManager);
        overlay.setCallerServers?.(new Set(Object.keys(servers)));
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
    const view = new FilteredMcpConnectionView(this.manager, hidden);
    const baseline = this.sessionBaseline(view, this.ready);
    const selection = { overrides: new Map<string, 'on' | 'off'>() };
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      connectionManager: view,
      selection,
      isBaselineServer: baseline.isBaselineServer,
      admitCurrentServers: baseline.admitCurrentServers,
      setServerEnabled: (name, enabled) => view.setServerEnabled(name, enabled),
      clearServerEnabledOverride: (name) => view.clearServerOverride(name),
    };
  }

  sessionOverlay(
    servers: Readonly<Record<string, McpServerConfig>>,
    opts?: SessionMcpOverlayOptions,
    baseView: McpConnectionView = this.manager,
  ): ISessionMcpOverlay {
    const callerNames = new Set(Object.keys(servers));
    const initialCallerNames = new Set(Object.keys(servers));
    const configuredSources = new Map<string, 'global' | 'plugin' | 'caller'>();
    const selection = { overrides: new Map<string, 'on' | 'off'>() };
    const configuredGlobalNames = new Set<string>();
    const sessionManager = new McpConnectionManager({
      log: this.log,
      oauthService: this.oauthService,
      stdioCwd: opts?.stdioCwd ?? this.stdioCwd,
      runtimeResolver: this.runtimeResolver,
      workspaceId: this.workspaceId,
      runtimeId: 'local',
      requireStdioRuntimeId: true,
      allowsCall: async (name) => {
        if (configuredGlobalNames.has(name) || callerNames.has(name)) return true;
        if (opts?.sessionId !== undefined && this.plugins !== undefined && this.usage?.enabled()) {
          const owner = (await this.plugins.mcpServerEntries()).find((entry) => entry.name === name);
          return owner !== undefined && owner.config.enabled !== false &&
            await this.usage.allows(this.workspaceId, owner.pluginId, opts.sessionId);
        }
        return this.mcpConfig.allowsCall?.(name) ?? true;
      },
      resolveDefaultTimeouts: () => this.mcpConfig.tunables(),
      resolveClientName: this.resolveClientName,
    });
    let overlayNames = new Set(Object.keys(servers));
    const initialOverlayNames = new Set(overlayNames);
    const admittedOverlayNames = new Set(overlayNames);
    const configuredOverrides = new Map<string, McpServerConfig>();
    const configuredOverlayNames = new Set<string>();
    let mutationTail: Promise<void> = Promise.resolve();
    const mutate = (work: () => Promise<void>): Promise<void> => {
      const next = mutationTail.catch(() => undefined).then(work);
      mutationTail = next.then(() => undefined, () => undefined);
      return next;
    };
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
    const canReuseBase = (name: string, config: McpServerConfig): boolean => {
      const entry = baseView.get(name);
      const baseConfig = baseView.configOf(name);
      return entry !== undefined && entry.status !== 'disabled' && entry.status !== 'removed' && baseConfig !== undefined &&
        sessionMcpConfigsEqual(baseConfig, config);
    };
    const removeConfiguredOverlay = async (name: string): Promise<void> => {
      if (!configuredOverlayNames.has(name) || initialOverlayNames.has(name)) return;
      await sessionManager.remove(name);
      configuredOverlayNames.delete(name);
      overlayNames.delete(name);
      view.replaceOverlayNames(overlayNames);
    };
    const update = (next: Readonly<Record<string, McpServerConfig>>): Promise<void> => mutate(async () => {
      await connect;
      const previousNames = overlayNames;
      const nextNames = new Set(Object.keys(next));
      for (const name of nextNames) admittedOverlayNames.add(name);
      overlayNames = nextNames;
      view.replaceOverlayNames(overlayNames);
      for (const name of previousNames) {
        if (nextNames.has(name)) continue;
        const config = sessionManager.configOf(name);
        if (config !== undefined) await sessionManager.connect(name, { ...config, enabled: false });
        else await sessionManager.remove(name);
        configuredOverlayNames.delete(name);
      }
      for (const [name, config] of Object.entries(next)) {
        if (
          configuredOverrides.has(name) &&
          baseView instanceof FilteredMcpConnectionView &&
          baseView.isBaselineHidden(name)
        ) {
          const activeConfig = sessionManager.configOf(name);
          if (activeConfig !== undefined) await sessionManager.connect(name, { ...activeConfig, enabled: false });
          await removeConfiguredOverlay(name);
          continue;
        }
        if (!initialOverlayNames.has(name) && canReuseBase(name, config)) {
          await removeConfiguredOverlay(name);
          continue;
        }
        await sessionManager.connect(name, config);
      }
    });
    const enableConfiguredServer = (
      runtimeName: string,
      config: McpServerConfig,
      source?: 'global' | 'plugin' | 'caller',
    ): Promise<void> => mutate(async () => {
      await connect;
      if (baseView instanceof FilteredMcpConnectionView && baseView.isBaselineHidden(runtimeName)) return;
      if (baseView instanceof FilteredMcpConnectionView && baseView.isSessionHidden(runtimeName)) {
        baseView.clearServerOverride(runtimeName);
      }
      const enabledConfig = configuredSessionMcpConfig(config);
      if (source !== undefined) {
        const previousSource = configuredSources.get(runtimeName);
        configuredSources.set(runtimeName, source);
        if (source === 'global') configuredGlobalNames.add(runtimeName);
        else configuredGlobalNames.delete(runtimeName);
        if (previousSource === 'caller' && source !== 'caller' && !initialCallerNames.has(runtimeName)) {
          callerNames.delete(runtimeName);
        }
        if (source === 'caller') callerNames.add(runtimeName);
      }
      configuredOverrides.set(runtimeName, enabledConfig);
      if (canReuseBase(runtimeName, enabledConfig)) {
        await removeConfiguredOverlay(runtimeName);
        view.setServerEnabled(runtimeName, true);
        return;
      }
      overlayNames.add(runtimeName);
      admittedOverlayNames.add(runtimeName);
      view.replaceOverlayNames(overlayNames);
      await sessionManager.connect(runtimeName, enabledConfig);
      configuredOverlayNames.add(runtimeName);
      view.setServerEnabled(runtimeName, true);
    });
    const clearConfiguredServer = (runtimeName: string): Promise<void> => mutate(async () => {
      await connect;
      configuredOverrides.delete(runtimeName);
      const source = configuredSources.get(runtimeName);
      configuredSources.delete(runtimeName);
      if (source === 'global') configuredGlobalNames.delete(runtimeName);
      if (source === 'caller' && !initialCallerNames.has(runtimeName)) callerNames.delete(runtimeName);
      await removeConfiguredOverlay(runtimeName);
      view.clearServerOverride(runtimeName);
      if (baseView instanceof FilteredMcpConnectionView) baseView.clearServerOverride(runtimeName);
    });
    const ready = Promise.all([this.ready, connect]).then(() => undefined);
    const baseline = this.sessionBaseline(baseView, this.ready, Object.keys(servers));
    return {
      handle: {
        _serviceBrand: undefined,
        ready,
        connectionManager: view,
        selection,
        isBaselineServer: (name) => admittedOverlayNames.has(name) || baseline.isBaselineServer(name),
        admitCurrentServers: () => {
          const admitted = new Set(baseline.admitCurrentServers());
          for (const name of overlayNames) admitted.add(name);
          return admitted;
        },
        setServerEnabled: (name, enabled) => view.setServerEnabled(name, enabled),
        clearServerEnabledOverride: (name) => clearConfiguredServer(name).then(() => true),
        enableConfiguredServer,
      },
      update,
      enableConfiguredServer,
      clearConfiguredServer,
      configuredServers: () => Object.fromEntries(configuredOverrides),
      setCallerServers: (names) => {
        callerNames.clear();
        initialCallerNames.clear();
        for (const name of names) {
          callerNames.add(name);
          initialCallerNames.add(name);
        }
      },
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
    await entry.overlay.update?.({
      ...pluginOverlay,
      ...entry.explicit,
      ...entry.overlay.configuredServers?.(),
    });
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
  ): {
    readonly isBaselineServer: (name: string) => boolean;
    readonly admitCurrentServers: () => ReadonlySet<string>;
  } {
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
    const isBaselineServer = (name: string): boolean => {
      const names = snapshot();
      if (names.has(name)) return true;
      if (frozen) return false;
      if (view.get(name) === undefined) return false;
      names.add(name);
      return true;
    };
    const admitCurrentServers = (): ReadonlySet<string> => {
      const names = snapshot();
      const admitted = new Set<string>();
      for (const entry of view.list()) {
        if (names.has(entry.name)) continue;
        names.add(entry.name);
        admitted.add(entry.name);
      }
      return admitted;
    };
    return { isBaselineServer, admitCurrentServers };
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

function configuredSessionMcpConfig(config: McpServerConfig): McpServerConfig {
  if (config.transport === 'stdio' && config.runtime_id === undefined) {
    return { ...config, enabled: true, runtime_id: 'local' };
  }
  return { ...config, enabled: true };
}

function sessionMcpConfigsEqual(left: McpServerConfig, right: McpServerConfig): boolean {
  if (left.enabled === false || right.enabled === false) return false;
  return mcpServerConfigsEqual(
    normalizeSessionConfig(left),
    normalizeSessionConfig(right),
  );
}

function normalizeSessionConfig(config: McpServerConfig): McpServerConfig {
  if (config.transport === 'stdio' && config.runtime_id === undefined) {
    return { ...config, enabled: true, runtime_id: 'local' };
  }
  return { ...config, enabled: true };
}
