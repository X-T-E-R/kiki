import { createHash } from 'node:crypto';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import type { Tool as KosongTool } from '#/kosong/contract/tool';

import { type IDisposable } from "#/_base/di/lifecycle";
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { IInstantiationService } from '#/_base/di/instantiation';
import type {
  McpServerAuthState,
  McpServerLocator,
} from '#/app/mcpManagement/mcpManagement';
import {
  IMcpRegistryService,
  type McpRegistryEntry,
} from '#/app/mcpRegistry/mcpRegistry';
import { toMcpServerConfigView } from '#/mcpCore/configView';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { mcpServerConfigsEqual } from '#/mcpCore/connection-manager';
import type { McpSessionCapability, McpSessionOverride, McpSessionOverrideValue } from './mcp';
import { Service } from "#/_base/di/service";
import { ErrorCodes, Error2, makeErrorPayload } from "#/errors";
import { abortable } from '#/_base/utils/abort';
import { IAgentStateService } from '#/agent/state/agentState';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { sessionMediaOriginalsDir } from '#/agent/media/image-originals';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentLoopService } from '#/agent/loop/loop';
import { createMcpAuthTool } from '#/agent/mcp/tools/auth';
import { createMcpTool } from '#/agent/mcp/tools/mcp';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import type { McpServerEntry } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { IAgentMcpService } from './mcp';
import { qualifyMcpToolName } from '#/mcpCore/tool-naming';
import { isComputerMcpConfig } from '#/mcpCore/computer';
import type { MCPClient, MCPToolDefinition } from '#/mcpCore/types';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  mcpDiscoveryKey,
  McpToolsDiscovered,
  type McpToolCollision,
} from './mcpDiscoveryOps';
import { AgentErrorEvent, McpServerStatus, ToolListUpdated } from './mcpEvents';

interface McpToolRegistration {
  readonly disposable: IDisposable;
  readonly serverName: string;
}

export const mcpMcpToolsByServerKey = defineState<Map<string, string[]>>(
  'mcp.mcpToolsByServer',
  () => new Map(),
);
export const mcpDiscoveryWritesReadyKey = defineState<boolean>(
  'mcp.discoveryWritesReady',
  () => false,
);

export class AgentMcpService extends Service implements IAgentMcpService {
  declare readonly _serviceBrand: undefined;
  private readonly mcpTools = new Map<string, McpToolRegistration>();
  private readonly pendingDiscoveries: Array<() => void> = [];
  private readonly refreshErrors = new Map<string, string>();
  private readonly sessionOverrides: Map<string, Exclude<McpSessionOverrideValue, 'inherit'>>;
  private readonly sessionOverridesLoaded: Promise<void>;
  private readonly sessionOverridesReady: Promise<void>;
  private overrideWrites: Promise<void> = Promise.resolve();

  constructor(
    @ISessionMcpHandle private readonly mcpHandle: ISessionMcpHandle,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentLoopService loop: IAgentLoopService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IMcpRegistryService private readonly serverRegistry: IMcpRegistryService,
  ) {
    super();
    this.sessionOverrides = mcpHandle.selection?.overrides ?? new Map();
    this.sessionOverridesLoaded = mcpHandle.selection?.loaded ?? this.loadSessionOverrides();
    if (mcpHandle.selection !== undefined) mcpHandle.selection.loaded = this.sessionOverridesLoaded;
    this.sessionOverridesReady = this.sessionOverridesLoaded.then(async () => {
      await this.mcpHandle.ready;
      await this.restoreSessionOverrides();
    });
    void this.sessionOverridesReady.catch(onUnexpectedError);
    this.states.contributeState(mcpDiscoveryKey);
    this.states.contributeState(mcpMcpToolsByServerKey);
    this.states.contributeState(mcpDiscoveryWritesReadyKey);
    this.attachMcpTools();
    loop.hooks.onWillBeginStep.register('mcp', async (ctx, next) => {
      await this.waitForInitialLoad(ctx.signal);
      await next();
    });
    this._register(
      toolExecutor.onWillExecuteTool((event) => {
        event.waitUntil(this.waitForInitialLoad(event.signal));
      }),
    );
    this._register(
      this.dispatcher.hooks.onDidRestore.register('mcp', async (_ctx, next) => {
        this.flushPendingDiscoveries();
        await next();
      }),
    );
  }

  private get mcpToolsByServer(): Map<string, string[]> {
    return this.states.get(mcpMcpToolsByServerKey);
  }

  private get discoveryWritesReady(): boolean {
    return this.states.get(mcpDiscoveryWritesReadyKey);
  }

  private set discoveryWritesReady(value: boolean) {
    this.states.set(mcpDiscoveryWritesReadyKey, value);
  }

  get oauthService() {
    return this.mcpHandle.connectionManager.oauthService;
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    const ready = Promise.all([this.mcpHandle.ready, this.sessionOverridesReady]).then(() => undefined);
    return signal === undefined ? ready : abortable(ready, signal);
  }

  initialLoadDurationMs(): number {
    return this.mcpHandle.connectionManager.initialLoadDurationMs();
  }

  list() {
    return this.mcpHandle.connectionManager.list();
  }

  resolved(name: string) {
    return this.mcpHandle.connectionManager.resolved(name);
  }

  getRemoteServerUrl(name: string) {
    return this.mcpHandle.connectionManager.getRemoteServerUrl(name);
  }

  async reconnect(name: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.mcpHandle.connectionManager.reconnect(name);
    signal?.throwIfAborted();
  }

  async connect(name: string, config: McpServerConfig): Promise<void> {
    const manager = this.mcpHandle.connectionManager;
    if (manager.connect === undefined) {
      throw new Error2(
        ErrorCodes.NOT_IMPLEMENTED,
        'Connecting an explicit MCP config is not supported for sessions with ephemeral MCP servers',
      );
    }
    await manager.connect(name, config);
  }

  async listMcpSessionCapabilities(): Promise<readonly McpSessionCapability[]> {
    await this.sessionOverridesLoaded;
    const registry = this.serverRegistry;
    if (registry === undefined) return [];
    const catalog = await registry.list({ cwd: this.sessionContext.cwd });
    const effective = effectiveEntries(catalog);
    return catalog.map((entry) => this.toSessionCapability(entry, effective.get(entry.name)));
  }

  setMcpSessionOverride(input: McpSessionOverride): Promise<McpSessionCapability> {
    const work = this.overrideWrites.catch(() => undefined).then(() => this.applyMcpSessionOverride(input));
    this.overrideWrites = work.then(() => undefined, () => undefined);
    return work;
  }

  async refreshCapabilities(): Promise<void> {
    await this.waitForInitialLoad();
    const registry = this.serverRegistry;
    if (registry !== undefined) {
      const catalog = await registry.list({ cwd: this.sessionContext.cwd });
      const effective = effectiveEntries(catalog);
      for (const entry of catalog) {
        const override = this.sessionOverrides.get(mcpLocatorKey(toMcpLocator(entry)));
        if (!sameRegistryEntry(entry, effective.get(entry.name))) continue;
        if (override === 'off') {
          this.mcpHandle.setServerEnabled?.(entry.name, false);
          this.unregisterMcpServer(entry.name);
        } else if (override === 'on') {
          await this.enableSessionServer(entry);
        } else if (entry.source === 'global') {
          if (entry.config.enabled === false) {
            this.mcpHandle.setServerEnabled?.(entry.name, false);
            this.unregisterMcpServer(entry.name);
          } else {
            const current = this.mcpHandle.connectionManager.configOf(entry.name);
            if (current === undefined || !mcpServerConfigsEqual(current, entry.config)) {
              await this.mcpHandle.enableConfiguredServer?.(entry.name, entry.config, entry.source);
            }
          }
        }
      }
    }
    const admitted = this.mcpHandle.admitCurrentServers?.() ?? new Set<string>();
    for (const entry of this.list()) {
      if (!admitted.has(entry.name) && !this.mcpHandle.isBaselineServer(entry.name)) continue;
      if (entry.status === 'connected') {
        try {
          await this.mcpHandle.connectionManager.refreshToolList?.(entry.name);
          this.refreshErrors.delete(entry.name);
        } catch (error) {
          this.refreshErrors.set(entry.name, `MCP tool catalog refresh failed (${error instanceof Error ? error.name : 'unknown error'})`);
        }
      }
      const current = this.mcpHandle.connectionManager.get(entry.name);
      if (current !== undefined) this.handleMcpServerStatusChange(current);
    }
  }

  private async applyMcpSessionOverride(input: McpSessionOverride): Promise<McpSessionCapability> {
    await this.waitForInitialLoad();
    const registry = this.requireServerRegistry();
    const catalog = await registry.list({ cwd: this.sessionContext.cwd });
    const selected = catalog.find((entry) => sameMcpLocator(toMcpLocator(entry), input.locator));
    if (selected === undefined) {
      throw new Error2(
        ErrorCodes.MCP_SERVER_NOT_FOUND,
        `MCP server locator ${describeMcpLocator(input.locator)} is unknown or no longer available`,
      );
    }
    const effective = effectiveEntries(catalog);
    const target = effective.get(selected.name);
    if (input.override === 'on' && !sameRegistryEntry(selected, target)) {
      throw new Error2(
        target === undefined ? ErrorCodes.REQUEST_INVALID : ErrorCodes.MCP_SERVER_NOT_FOUND,
        target === undefined
          ? `MCP server locator ${describeMcpLocator(input.locator)} is disabled by its plugin source`
          : `MCP server locator ${describeMcpLocator(input.locator)} does not own runtime name "${selected.name}"`,
      );
    }
    await this.persistSessionOverride(mcpLocatorKey(input.locator), input.override);
    if (sameRegistryEntry(selected, target)) {
      if (input.override === 'off') {
        this.mcpHandle.setServerEnabled?.(selected.name, false);
        this.unregisterMcpServer(selected.name);
      } else if (input.override === 'on') {
        await this.enableSessionServer(selected);
      } else {
        const cleared = await this.mcpHandle.clearServerEnabledOverride?.(selected.name) ?? false;
        if (selected.source === 'global') {
          if (selected.config.enabled === false) {
            this.mcpHandle.setServerEnabled?.(selected.name, false);
            this.unregisterMcpServer(selected.name);
          } else if (!cleared || this.mcpHandle.connectionManager.get(selected.name) === undefined) {
            await this.mcpHandle.enableConfiguredServer?.(selected.name, selected.config, selected.source);
          }
        }
      }
    }
    this.mcpHandle.admitCurrentServers?.();
    for (const entry of this.list()) this.handleMcpServerStatusChange(entry);
    const capability = (await this.listMcpSessionCapabilities())
      .find((candidate) => sameMcpLocator(candidate.locator, input.locator));
    if (capability === undefined) {
      throw new Error2(
        ErrorCodes.MCP_SERVER_NOT_FOUND,
        `MCP server locator ${describeMcpLocator(input.locator)} is no longer available`,
      );
    }
    return capability;
  }

  private async enableSessionServer(entry: McpRegistryEntry): Promise<void> {
    if (this.mcpHandle.enableConfiguredServer !== undefined) {
      await this.mcpHandle.enableConfiguredServer(entry.name, { ...entry.config, enabled: true }, entry.source);
    } else {
      this.mcpHandle.setServerEnabled?.(entry.name, true);
    }
  }

  private async loadSessionOverrides(): Promise<void> {
    const store = this.atomicDocumentStore();
    const sessionId = this.sessionContext.sessionId;
    if (store === undefined || sessionId === undefined) return;
    const persisted = await store.get<unknown>(SESSION_MCP_OVERRIDES_SCOPE, sessionId);
    for (const [key, value] of Object.entries(readSessionOverrides(persisted))) {
      this.sessionOverrides.set(key, value);
    }
  }

  private async restoreSessionOverrides(): Promise<void> {
    const catalog = await this.serverRegistry.list({ cwd: this.sessionContext.cwd });
    const effective = effectiveEntries(catalog);
    for (const entry of catalog) {
      const override = this.sessionOverrides.get(mcpLocatorKey(toMcpLocator(entry)));
      if (override === undefined || !sameRegistryEntry(entry, effective.get(entry.name))) continue;
      if (override === 'on') await this.enableSessionServer(entry);
      else {
        this.mcpHandle.setServerEnabled?.(entry.name, false);
        this.unregisterMcpServer(entry.name);
      }
    }
  }

  private async persistSessionOverride(
    key: string,
    override: McpSessionOverrideValue,
  ): Promise<void> {
    const store = this.atomicDocumentStore();
    const sessionId = this.sessionContext.sessionId;
    if (store === undefined || sessionId === undefined) {
      if (override === 'inherit') this.sessionOverrides.delete(key);
      else this.sessionOverrides.set(key, override);
      return;
    }
    const next = await store.update<unknown>(SESSION_MCP_OVERRIDES_SCOPE, sessionId, (current) => {
      const values = readSessionOverrides(current);
      if (override === 'inherit') delete values[key];
      else values[key] = override;
      return values;
    });
    this.sessionOverrides.clear();
    for (const [storedKey, storedValue] of Object.entries(readSessionOverrides(next))) {
      this.sessionOverrides.set(storedKey, storedValue);
    }
  }

  private atomicDocumentStore(): IAtomicDocumentStore | undefined {
    try {
      return this.instantiation.invokeFunction((accessor) => accessor.get(IAtomicDocumentStore));
    } catch {
      return undefined;
    }
  }

  private requireServerRegistry(): IMcpRegistryService {
    if (this.serverRegistry === undefined) {
      throw new Error2(ErrorCodes.NOT_IMPLEMENTED, 'MCP session capability catalog is unavailable');
    }
    return this.serverRegistry;
  }

  private toSessionCapability(
    entry: McpRegistryEntry,
    effective?: McpRegistryEntry,
  ): McpSessionCapability {
    const locator = toMcpLocator(entry);
    const override = this.sessionOverrides.get(mcpLocatorKey(locator)) ?? 'inherit';
    const managerEntry = sameRegistryEntry(entry, effective)
      ? this.mcpHandle.connectionManager.get(entry.name)
      : undefined;
    const connection = toSessionConnection(
      entry,
      managerEntry?.status,
      managerEntry !== undefined,
      override,
      effective,
    );
    const refreshError = managerEntry !== undefined && override !== 'off' ? this.refreshErrors.get(entry.name) : undefined;
    const error = refreshError ?? managerEntry?.error ?? toSessionCapabilityError(entry, effective, managerEntry, override);
    return {
      locator,
      runtimeName: entry.name,
      origin: entry.source,
      config: toMcpServerConfigView(entry.config),
      authStatus: toSessionAuthStatus(entry.config, managerEntry?.status),
      connection: refreshError === undefined ? connection : 'failed',
      override,
      error,
    };
  }

  private reconnectForToolCall(
    serverName: string,
    staleClient: MCPClient,
    signal?: AbortSignal,
  ): Promise<MCPClient | undefined> {
    const work = this.joinHealedOrReconnect(serverName, staleClient);
    return signal === undefined ? work : abortable(work, signal);
  }

  private async joinHealedOrReconnect(
    serverName: string,
    staleClient: MCPClient,
  ): Promise<MCPClient | undefined> {
    const healed = this.resolved(serverName)?.client;
    if (healed !== undefined && healed !== staleClient) return healed;
    await this.mcpHandle.connectionManager.reconnectAndJoin(serverName);
    const current = this.resolved(serverName)?.client;
    return current !== undefined && current !== staleClient ? current : undefined;
  }

  onStatusChange(listener: Parameters<IAgentMcpService['onStatusChange']>[0]) {
    const unsubscribe = this.mcpHandle.connectionManager.onStatusChange(listener);
    return {
      dispose: unsubscribe,
    };
  }

  private attachMcpTools(): void {
    for (const entry of this.list()) {
      this.handleMcpServerStatusChange(entry);
    }
    this._register(
      this.onStatusChange((entry) => {
        this.handleMcpServerStatusChange(entry);
      }),
    );
  }

  private handleMcpServerStatusChange(entry: McpServerEntry): void {
    if (!this.mcpHandle.isBaselineServer(entry.name)) return;
    void this.dispatcher.dispatch(
      new McpServerStatus({
        server: {
          name: entry.name,
          transport: entry.transport,
          status: entry.status,
          toolCount: entry.toolCount,
          error: entry.error,
        },
      }),
    );
    if (entry.status === 'connected') {
      this.registerConnectedMcpServer(entry);
      return;
    }
    if (entry.status === 'needs-auth') {
      this.registerNeedsAuthMcpServer(entry);
      return;
    }
    if (entry.status === 'failed' || entry.status === 'pending' || entry.status === 'removed') {
      return;
    }
    if (entry.status === 'disabled') {
      const removed = this.unregisterMcpServer(entry.name);
      if (removed) {
        void this.dispatcher.dispatch(
          new ToolListUpdated({
            reason: 'mcp.disconnected',
            serverName: entry.name,
          }),
        );
      }
    }
  }

  private registerConnectedMcpServer(entry: McpServerEntry): void {
    const resolved = this.resolved(entry.name);
    if (resolved === undefined) return;
    const result = this.registerMcpServer(
      entry.name,
      resolved.client,
      resolved.tools,
      resolved.enabledNames,
      resolved.admitCall,
    );
    this.emitMcpToolCollisions(entry.name, result.collisions);
    this.recordDiscovery(entry.name, resolved.rawTools, resolved.enabledNames, result.collisions);
    void this.dispatcher.dispatch(
      new ToolListUpdated({
        reason: 'mcp.connected',
        serverName: entry.name,
      }),
    );
  }

  private registerNeedsAuthMcpServer(entry: McpServerEntry): void {
    this.unregisterMcpServer(entry.name);
    const oauthService = this.oauthService;
    const serverUrl = this.getRemoteServerUrl(entry.name);
    if (oauthService === undefined || serverUrl === undefined) return;
    const tool = createMcpAuthTool({
      serverName: entry.name,
      serverUrl,
      oauthService,
      reconnect: (signal) => this.reconnect(entry.name, signal),
    });
    const disposable = this._register(this.registry.register(tool, { source: 'mcp' }));
    this.mcpTools.set(tool.name, { disposable, serverName: entry.name });
    this.mcpToolsByServer.set(entry.name, [tool.name]);
    void this.dispatcher.dispatch(
      new ToolListUpdated({
        reason: 'mcp.connected',
        serverName: entry.name,
      }),
    );
  }

  private registerMcpServer(
    serverName: string,
    client: MCPClient,
    tools: readonly KosongTool[],
    enabledTools: ReadonlySet<string>,
    admitCall?: () => Promise<{ release(): void } | undefined>,
  ): {
    readonly registered: readonly string[];
    readonly collisions: readonly McpToolCollision[];
  } {
    this.unregisterMcpServer(serverName);
    const qualifiedNames: string[] = [];
    const collisions: McpToolCollision[] = [];
    const seenInThisCall = new Map<string, string>();
    for (const tool of tools) {
      if (!enabledTools.has(tool.name)) continue;
      const qualified = qualifyMcpToolName(serverName, tool.name);
      const firstInThisCall = seenInThisCall.get(qualified);
      if (firstInThisCall !== undefined) {
        collisions.push({
          qualified,
          toolName: tool.name,
          collidesWith: { kind: 'same_server', toolName: firstInThisCall },
        });
        continue;
      }
      const existingEntry = this.mcpTools.get(qualified);
      if (existingEntry !== undefined) {
        collisions.push({
          qualified,
          toolName: tool.name,
          collidesWith: { kind: 'other_server', serverName: existingEntry.serverName },
        });
        continue;
      }
      seenInThisCall.set(qualified, tool.name);
      const disposable = this._register(
        this.registry.register(
          createMcpTool(qualified, tool, client, {
            serverName,
            admitCall,
            onUnauthorized: (error, failedClient) =>
              this.mcpHandle.connectionManager.markNeedsAuth(serverName, error, failedClient),
            originalsDir: sessionMediaOriginalsDir(this.sessionContext.sessionDir),
            telemetry: this.telemetry,
            attachmentStore: () =>
              this.instantiation.invokeFunction((accessor) => accessor.get(ISessionMediaStore)),
            providerType: () => this.profile.getModelProviderType(),
            computerControl: isComputerMcpConfig(this.mcpHandle.connectionManager.configOf(serverName)),
            reconnect: (signal) => this.reconnectForToolCall(serverName, client, signal),
            isRemoved: () =>
              this.mcpHandle.connectionManager.get(serverName)?.status === 'removed',
          }),
          { source: 'mcp' },
        ),
      );
      this.mcpTools.set(qualified, { disposable, serverName });
      qualifiedNames.push(qualified);
    }
    this.mcpToolsByServer.set(serverName, qualifiedNames);
    return { registered: qualifiedNames, collisions };
  }

  private unregisterMcpServer(serverName: string): boolean {
    const names = this.mcpToolsByServer.get(serverName);
    if (names === undefined) return false;
    for (const name of names) {
      const entry = this.mcpTools.get(name);
      const result = entry?.disposable.dispose();
      if (isPromiseLike(result)) result.catch(onUnexpectedError);
      this.mcpTools.delete(name);
    }
    this.mcpToolsByServer.delete(serverName);
    return true;
  }

  private recordDiscovery(
    serverName: string,
    rawTools: readonly MCPToolDefinition[],
    enabledNames: ReadonlySet<string>,
    collisions: readonly McpToolCollision[],
  ): void {
    const enabledNamesSnapshot = [...enabledNames].toSorted((a, b) => a.localeCompare(b));
    const work = (): void => {
      const hash = createHash('sha256')
        .update(JSON.stringify({ tools: rawTools, enabledNames: enabledNamesSnapshot, collisions }))
        .digest('hex');
      const key = `${serverName}\n${hash}`;
      if (this.states.get(mcpDiscoveryKey).seen.includes(key)) return;
      void this.dispatcher.dispatch(
        new McpToolsDiscovered({
          serverName,
          hash,
          tools: rawTools,
          enabledNames: enabledNamesSnapshot,
          collisions: collisions.length > 0 ? collisions : undefined,
        }),
      );
    };
    if (!this.discoveryWritesReady) {
      this.pendingDiscoveries.push(work);
      return;
    }
    work();
  }

  private flushPendingDiscoveries(): void {
    this.discoveryWritesReady = true;
    const pending = this.pendingDiscoveries.splice(0);
    for (const work of pending) {
      work();
    }
  }

  private emitMcpToolCollisions(
    serverName: string,
    collisions: readonly McpToolCollision[],
  ): void {
    if (collisions.length === 0) return;
    const summary = collisions
      .map((collision) =>
        collision.collidesWith.kind === 'same_server'
          ? `"${collision.toolName}" -> ${collision.qualified} (collides with "${collision.collidesWith.toolName}" from the same server)`
          : `"${collision.toolName}" -> ${collision.qualified} (collides with server "${collision.collidesWith.serverName}")`,
      )
      .join('; ');
    void this.dispatcher.dispatch(
      new AgentErrorEvent(
        makeErrorPayload(
          ErrorCodes.MCP_TOOL_NAME_COLLISION,
          `MCP server "${serverName}" registered ${collisions.length} tool name` +
            `${collisions.length === 1 ? '' : 's'} ` +
            `that collide with existing qualified names; the losing tools were dropped: ${summary}`,
          { details: { serverName, collisions: collisions as readonly unknown[] } },
        ),
      ),
    );
  }
}

const SESSION_MCP_OVERRIDES_SCOPE = 'session-mcp-overrides';

type StoredSessionOverride = Exclude<McpSessionOverrideValue, 'inherit'>;

function mcpLocatorKey(locator: McpServerLocator): string {
  return locator.source === 'global'
    ? `global:${encodeURIComponent(locator.name)}`
    : `plugin:${encodeURIComponent(locator.pluginId)}:${encodeURIComponent(locator.serverName)}`;
}

function sameMcpLocator(left: McpServerLocator, right: McpServerLocator): boolean {
  return mcpLocatorKey(left) === mcpLocatorKey(right);
}

function toMcpLocator(entry: McpRegistryEntry): McpServerLocator {
  if (entry.source === 'global') return { source: 'global', name: entry.name };
  if (entry.plugin === undefined) {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      `MCP plugin source "${entry.name}" has no stable plugin locator`,
    );
  }
  return {
    source: 'plugin',
    pluginId: entry.plugin.id,
    serverName: entry.plugin.name,
  };
}

function sameRegistryEntry(
  left: McpRegistryEntry | undefined,
  right: McpRegistryEntry | undefined,
): boolean {
  return left !== undefined && right !== undefined && sameMcpLocator(toMcpLocator(left), toMcpLocator(right));
}

function effectiveEntries(
  catalog: readonly McpRegistryEntry[],
): ReadonlyMap<string, McpRegistryEntry> {
  const effective = new Map<string, McpRegistryEntry>();
  for (const entry of catalog) {
    const current = effective.get(entry.name);
    if (entry.source === 'global') {
      effective.set(entry.name, entry);
      continue;
    }
    if (entry.config.enabled === false || current !== undefined) continue;
    effective.set(entry.name, entry);
  }
  return effective;
}

function toSessionConnection(
  entry: McpRegistryEntry,
  status: McpServerEntry['status'] | undefined,
  available: boolean,
  override: McpSessionOverrideValue,
  effective: McpRegistryEntry | undefined,
): McpSessionCapability['connection'] {
  if (override === 'off' || (override !== 'on' && entry.config.enabled === false)) return 'disabled';
  if (!sameRegistryEntry(entry, effective) || !available) return 'unavailable';
  if (status === 'pending') return 'connecting';
  if (status === 'connected') return 'connected';
  if (status === 'failed' || status === 'needs-auth') return 'failed';
  if (status === 'disabled') return 'disabled';
  return 'unavailable';
}

function toSessionCapabilityError(
  entry: McpRegistryEntry,
  effective: McpRegistryEntry | undefined,
  managerEntry: McpServerEntry | undefined,
  override: McpSessionOverrideValue,
): string | undefined {
  if (override === 'off') return undefined;
  if (override !== 'on' && entry.config.enabled === false) return 'MCP server is disabled by its source configuration';
  if (effective === undefined) return 'MCP server source is no longer available';
  if (!sameRegistryEntry(entry, effective)) {
    return `MCP runtime name "${entry.name}" is owned by another source; selected locator is unavailable`;
  }
  if (managerEntry === undefined) return `MCP server "${entry.name}" has no admitted connection in this session`;
  if (managerEntry.status === 'failed' || managerEntry.status === 'needs-auth') {
    return `MCP server "${entry.name}" finished with status ${managerEntry.status}`;
  }
  if (managerEntry.status === 'removed') return `MCP server "${entry.name}" is no longer available`;
  return undefined;
}

function toSessionAuthStatus(
  config: McpRegistryEntry['config'],
  status: McpServerEntry['status'] | undefined,
): McpServerAuthState {
  if (config.transport === 'stdio') return 'not-applicable';
  if (config.bearerTokenEnvVar !== undefined) return 'bearer-token';
  if (config.auth !== 'oauth') return 'not-applicable';
  if (status === 'needs-auth') return 'oauth-required';
  if (status === 'connected') return 'oauth-authorized';
  return 'unavailable';
}

function describeMcpLocator(locator: McpServerLocator): string {
  return locator.source === 'global'
    ? `global:${locator.name}`
    : `plugin:${locator.pluginId}:${locator.serverName}`;
}

function readSessionOverrides(value: unknown): Record<string, StoredSessionOverride> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, StoredSessionOverride> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === 'on' || entry === 'off') result[key] = entry;
  }
  return result;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMcpService,
  AgentMcpService,
  ScopeActivation.OnScopeCreated,
  'mcp',
);
