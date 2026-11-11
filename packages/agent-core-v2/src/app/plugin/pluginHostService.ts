import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  harnessAccountListInputSchema, harnessAccountPrepareInputSchema,
  type HarnessAccount, type HarnessAccountConnection, type HarnessAccountPrepareInput,
  type MediaConnection, type MediaProviderDefinition, type PluginMediaApi, type PluginMessagesApi,
} from '@kiki/protocol';
import { satisfies, valid } from 'semver';
import type { PluginImAdapterRegistration, PluginImAdapterSink } from './imAdapter';
export type { PluginImAdapterRegistration, PluginImAdapterSink, PluginImConnection } from './imAdapter';
import { IProviderService } from '#/kosong/provider/provider';
import { IModelCatalog } from '#/kosong/model/catalog';
import { pluginModelCatalog } from './pluginModelCatalog';
import { IOAuthService } from '#/app/auth/auth';
import { oauthRequestAuth } from '#/kosong/model/modelOAuth';
import { resolveConfiguredModelBaseUrl } from '#/kosong/model/modelAuth';
import { mergeProviderRequestAuth, finalizeProviderRequestHeaders } from '#/kosong/provider/bases/request-auth';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';
import { getProviderDefinition } from '#/kosong/provider/providerDefinition';
import { IRequestIdentityCatalog } from '#/app/requestIdentity/requestIdentityCatalog';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ICordisRuntimeService, IPluginIsolationPoolService, type IsolatedPluginInvocation, type IsolatedPluginResult } from '#/app/cordisRuntime/cordisRuntime';
import type { ExtensionSlotId } from './extensionSlots';
import { pluginAppLifecycleFlag } from './flag';
import { REQUEST_IDENTITY_SECTION } from '#/app/kosongConfig/configSection';
import { defaultOAuthRequestIdentity, type RequestIdentityPolicy } from '#/kosong/requestIdentity/requestIdentityPolicy';
import { projectRequestIdentity } from '#/kosong/requestIdentity/requestIdentityProjector';
import { IProtocolAdapterRegistry, ProtocolSchema } from '#/kosong/protocol/protocol';

import { createDecorator, ref, type LiveRef } from '#/_base/di/instantiation';
import { abortable } from '#/_base/utils/abort';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { toDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { Error2, PluginErrors } from '#/errors';
import type { ExecutableToolResult, ToolUpdate } from '#/tool/toolContract';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';

import { PluginHost } from './host';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { observePluginActivity } from './pluginActivity';
import { builtinHistory, builtinHistoryEntry } from '#/app/pluginImport/builtinHistory';
import { IPluginService } from './plugin';
import { IPluginSettingsService } from './pluginSettingsService';
import type { PluginTool } from './contributions';
import type { PluginInfo } from './types';
import { sourceSchema, sourceValues, sourceActive, sourceDefaults, scriptSources, scriptDefinition, scriptEnvironmentKey, type MediaSettingValues } from './mediaSourceSettings';
import type { PluginImBridge } from './pluginImBridge';
export {
  parsePluginImRequest, pluginImCaller, pluginImReceipt, sanitizePluginImCapabilities, sanitizePluginImReceipt, sanitizePluginImRoutes,
  PLUGIN_IM_DIGEST_MAX_UTF8_BYTES,
  type PluginImBridge, type PluginImCaller, type PluginImCapabilities, type PluginImErrorKind, type PluginImRoute, type PluginImSendReceipt, type PluginImSendRequest, type PluginImSendStatus,
} from './pluginImBridge';

export interface PluginToolRegistration {
  readonly pluginId: string;
  readonly definition: PluginTool;
}

export interface PluginMediaProviderRegistration {
  readonly provider: string;
  readonly definition: MediaProviderDefinition;
  readonly source: string;
  readonly version?: string;
  readonly configuration: string;
  readonly aliases?: readonly string[];
}

export interface PluginMediaCallContext {
  readonly jobId: string;
  readonly stagingDir: string;
  readonly onProgress?: (update: ToolUpdate) => void;
  readonly model?: string;
  readonly owner?: import('#/app/pluginMedia/pluginMedia').MediaJobOwner;
}

export interface PluginExecutionScope {
  readonly workspaceRoot?: string;
  readonly approvedPaths?: readonly string[];
  readonly imageIn?: boolean;
  readonly workspaceId?: string;
  readonly media?: PluginMediaApi;
  readonly messages?: PluginMessagesApi;
  readonly models?: import('@kiki/protocol').PluginModelsApi;
  readonly attachmentStore?: ISessionMediaStore;
}

export interface PluginHarnessAccountSource {
  readonly id: string;
  readonly label: string;
  readonly engineIds: readonly string[];
}

export interface PluginHarnessQuotaSource {
  readonly id: string;
  readonly label: string;
  readonly engineIds: readonly string[];
  readonly minRefreshIntervalMs: number;
}

export interface PluginHarnessAccountLease {
  readonly connection: HarnessAccountConnection;
  release(): Promise<void>;
}

export interface IPluginHostService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  stopAll(): Promise<void>;
  list(): Promise<readonly PluginToolRegistration[]>;
  listMediaProviders(): Promise<readonly PluginMediaProviderRegistration[]>;
  listHarnessAccountSources(): Promise<readonly PluginHarnessAccountSource[]>;
  listHarnessQuotaSources(): Promise<readonly PluginHarnessQuotaSource[]>;
  readHarnessQuota(source: string, signal: AbortSignal): Promise<readonly import('@kiki/protocol').HarnessQuotaReading[]>;
  cachedHarnessQuota(): Promise<{ readonly sources: readonly import('@kiki/protocol').PluginHarnessQuotaSnapshot[] }>;
  attachQuotaCache(reader: () => Promise<{ readonly sources: readonly import('@kiki/protocol').PluginHarnessQuotaSnapshot[] }>): void;
  listHarnessAccounts(source: string, engineId: string, signal: AbortSignal): Promise<readonly HarnessAccount[]>;
  prepareHarnessAccount(source: string, input: HarnessAccountPrepareInput, signal: AbortSignal): Promise<PluginHarnessAccountLease>;
  requestMediaProvider(provider: string, action: 'describe' | 'submit' | 'poll' | 'cancel' | 'voices', input: unknown, signal: AbortSignal, context: PluginMediaCallContext, expected?: PluginMediaProviderRegistration): Promise<unknown>;
  execute(pluginId: string, tool: string, args: unknown, signal: AbortSignal, onProgress?: (update: ToolUpdate) => void, scope?: PluginExecutionScope, expectedDefinition?: PluginTool): Promise<ExecutableToolResult>;
  installPrerequisite(pluginId: string, prerequisiteId: string, consent: boolean): Promise<string>;
  requestPanel(pluginId: string, panelId: string, action: string, args: unknown): Promise<unknown>;
  requestSource(pluginId: string, sourceId: string, action: 'discover' | 'probe' | 'parse', args: unknown, signal: AbortSignal): Promise<unknown>;
  running(pluginId: string): boolean;
  navigation(): { readonly id: number; readonly pluginId: string; readonly sessionId: string; readonly at: number } | undefined;
  attachOutboundIm(bridge: PluginImBridge | undefined): void;
  attachImAdapters(sink: PluginImAdapterSink): Promise<void>;
  invokeSlot?<TPayload, TResult>(invocation: Omit<IsolatedPluginInvocation<TPayload>, 'generation'>): Promise<IsolatedPluginResult<TResult>>;
}

export const IPluginHostService = createDecorator<IPluginHostService>('pluginHostService');

export class PluginHostService extends Service implements IPluginHostService {
  declare readonly _serviceBrand: undefined;
  private readonly hosts = new Map<string, PluginHost>();
  private readonly hostSignatures = new Map<string, string>();
  private readonly slotRegistrations = new Map<string, { readonly signature: string; readonly registration: Promise<{ readonly generation: number; dispose(): Promise<void> }> }>();
  private slotGeneration = 0;
  private readonly active = new Map<string, Set<Promise<unknown>>>();
  private readonly gates = new Map<string, Promise<void>>();
  private globalGate: Promise<void> | undefined;
  readonly ready: Promise<void>;
  private closing = false;
  private shutdown: Promise<void> | undefined;
  private readonly ownSettingsWrites = new Set<string>();
  private readonly activated = new WeakMap<PluginHost, string>();
  private readonly residentWork = new Set<Promise<void>>();
  private readonly residentLifecycle = new Set<Promise<void>>();
  private readonly residentChains = new Map<string, Promise<void>>();
  private navigationRequest?: { readonly id: number; readonly pluginId: string; readonly sessionId: string; readonly at: number };
  private nextNavigationId = 0;
  private outboundIm: PluginImBridge | undefined;
  private imAdaptersSink?: PluginImAdapterSink;
  private readonly knownDependencies = new Map<string, readonly string[]>();

  attachOutboundIm(bridge: PluginImBridge | undefined): void {
    this.outboundIm = bridge;
  }

  async attachImAdapters(sink: PluginImAdapterSink): Promise<void> {
    this.imAdaptersSink = sink;
    await this.reconcileImAdapters();
  }

  private async checkDependencies(info: PluginInfo, visiting = new Set<string>()): Promise<void> {
    this.knownDependencies.set(info.id, Object.keys(info.manifest?.kiki?.dependencies ?? {}));
    if (visiting.has(info.id)) throw new Error(`Plugin dependency cycle: ${info.id}`);
    visiting.add(info.id);
    for (const [id, range] of Object.entries(info.manifest?.kiki?.dependencies ?? {})) {
      const dependency = await this.plugins.getPluginInfo({ id }).catch(() => undefined);
      if (dependency === undefined || !dependency.enabled || dependency.state !== 'ok') throw new Error(`Plugin ${info.id} requires enabled plugin ${id} ${range}`);
      if (dependency.version === undefined || valid(dependency.version) === null || !satisfies(dependency.version, range)) throw new Error(`Plugin ${info.id} requires ${id} ${range}; installed version is ${dependency.version ?? 'unknown'}`);
      await this.checkDependencies(dependency, visiting);
    }
    visiting.delete(info.id);
  }

  private async reconcileImAdapters(): Promise<void> {
    const sink = this.imAdaptersSink;
    if (sink === undefined || this.closing) return;
    const installed = await this.plugins.listPlugins();
    const registrations: PluginImAdapterRegistration[] = [];
    for (const summary of installed.filter((item) => item.enabled && item.state === 'ok')) {
      const info = await this.plugins.getPluginInfo({ id: summary.id });
      try { await this.checkDependencies(info); } catch { continue; }
      const settings = await this.settings.forExecution(info.id);
      for (const definition of info.manifest?.kiki?.imAdapters ?? []) {
        const providerKind = `plugin:${info.id}/${definition.id}` as const;
        registrations.push({ pluginId: info.id, definition, providerKind, instanceId: providerKind,
          revision: JSON.stringify([info.version, info.root, definition, settings]),
          connect: (listener, offset) => {
            if (this.closing) return Promise.reject(new Error('Plugin Host is shutting down'));
            return this.getHost(info).connectImAdapter(definition.id, settings, providerKind, listener, offset);
          },
        });
      }
    }
    await sink.replace(registrations);
  }

  private affectedPlugins(ids?: readonly string[]): readonly string[] | undefined {
    if (ids === undefined) return undefined;
    const affected = new Set(ids);
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, dependencies] of this.knownDependencies) if (!affected.has(id) && dependencies.some((dependency) => affected.has(dependency))) { affected.add(id); changed = true; }
    }
    return [...affected];
  }

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IPluginSettingsService private readonly settings: IPluginSettingsService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IProviderService private readonly connections?: IProviderService,
    @IOAuthService private readonly oauth?: IOAuthService,
    @IRequestIdentityCatalog private readonly identityCatalog?: IRequestIdentityCatalog,
    @IConfigService private readonly configService?: IConfigService,
    @IFlagService private readonly flags?: IFlagService,
    @ISessionManager private readonly sessions?: ISessionManager,
    @IPluginUsageService usage?: IPluginUsageService,
    @ref(ILogService) private readonly logger?: LiveRef<ILogService>,
    @ref(IPluginIsolationPoolService) private readonly isolates?: LiveRef<IPluginIsolationPoolService>,
    @ref(ICordisRuntimeService) private readonly cordis?: LiveRef<ICordisRuntimeService>,
    @ref(IProtocolAdapterRegistry) private readonly protocolAdapters?: LiveRef<IProtocolAdapterRegistry>,
  ) {
    super();
    if (usage !== undefined) this._register(usage.onDidChange((event) => {
      event.waitUntil((async () => {
        try {
          if (!await usage.allows(event.workspaceId, event.pluginId, event.sessionId)) return;
          const info = await this.plugins.getPluginInfo({ id: event.pluginId });
          if (info.manifest?.kiki?.activation !== 'app') return;
          await this.runRequest(event.pluginId, async () => undefined);
        } catch (error) {
          this.logger?.current?.warn('plugin resident usage activation failed', {
            pluginId: event.pluginId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      })());
    }));
    this._register(this.plugins.onWillChange((event) => {
      if (event.affected === undefined) this.globalGate = event.finished;
      else for (const id of event.affected) this.gates.set(id, event.finished);
      let reloaded = false;
      const reloadedSubscription = this.plugins.onDidReload(() => { reloaded = true; });
      void event.finished.then(() => {
        reloadedSubscription.dispose();
        if (reloaded || this.closing) return;
        void this.reconcileResidents(event.affected).catch((error: unknown) => {
          this.logger?.current?.warn('plugin resident restore failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
      event.waitUntil((async () => {
        await Promise.allSettled(this.residentLifecycle);
        const affected = this.affectedPlugins(event.affected);
        if (affected !== undefined) for (const id of affected) this.gates.set(id, event.finished);
        const ids = affected ?? [...new Set([...this.hosts.keys(), ...this.active.keys(), ...this.slotRegistrations.keys()])];
        await Promise.allSettled(ids.map(id => this.withdrawSlot(id)));
        await Promise.all(ids.map((id) => Promise.allSettled(this.active.get(id) ?? new Set<Promise<unknown>>())));
        const preserved = affected === undefined
          ? new Set([...this.hosts].filter(([, host]) => host.running && host.hasActiveLeases).map(([id]) => id))
          : new Set<string>();
        if (affected !== undefined || preserved.size === 0) {
          await this.imAdaptersSink?.withdraw(affected);
        } else {
          const withdrawIds = ids.filter((id) => !preserved.has(id));
          if (withdrawIds.length > 0) await this.imAdaptersSink?.withdraw(withdrawIds);
        }
        await Promise.all(ids.map(async (id) => {
          if (preserved.has(id)) return;
          const host = this.hosts.get(id);
          this.hosts.delete(id);
          this.hostSignatures.delete(id);
          await host?.stopAndWait();
        }));
      })());
    }));
    this._register(this.plugins.onDidReload((event) => {
      event.waitUntil((async () => {
        try {
          await this.reconcilePreservedHosts();
        } catch (error) {
          this.logger?.current?.warn('plugin preserved host reconciliation failed after reload', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          await this.reconcileResidents(event.affected);
        } catch (error) {
          this.logger?.current?.warn('plugin resident activation failed after reload', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          await this.reconcileImAdapters();
        } catch (error) {
          this.logger?.current?.warn('plugin IM adapter reconciliation failed after reload', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })());
    }));
    if (this.configService !== undefined) this._register(this.configService.onDidSectionChange((event) => {
      if (event.domain !== 'pluginSettings' || this.closing) return;
      const current = event.value as Record<string, unknown> | undefined;
      const previous = event.previousValue as Record<string, unknown> | undefined;
      const ids = [...new Set([...Object.keys(current ?? {}), ...Object.keys(previous ?? {})])]
        .filter((id) => !this.ownSettingsWrites.has(id) && JSON.stringify(current?.[id]) !== JSON.stringify(previous?.[id]));
      void this.reconcileResidents(ids, true).then(() => this.reconcileImAdapters()).catch((error: unknown) => {
        this.logger?.current?.warn('plugin resident settings reconciliation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }));
    this.ready = Promise.resolve().then(() => this.reconcileResidents());
    void this.ready.catch((error: unknown) => {
      this.logger?.current?.warn('plugin initial resident activation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this._register(toDisposable(() => this.stopAll()));
  }

  stopAll(): Promise<void> {
    this.closing = true;
    return this.shutdown ??= this.shutdownHosts();
  }

  private async shutdownHosts(): Promise<void> {
    await Promise.allSettled([...this.slotRegistrations.keys()].map(id => this.withdrawSlot(id)));
    await this.imAdaptersSink?.withdraw();
    await Promise.allSettled(this.residentWork);
    await Promise.allSettled([...this.active.values()].flatMap((requests) => [...requests]));
    const hosts = [...this.hosts.values()];
    this.hosts.clear();
    this.hostSignatures.clear();
    await Promise.allSettled(hosts.map((host) => host.stopAndWait()));
  }

  private async reconcilePreservedHosts(): Promise<void> {
    if (this.closing || this.hosts.size === 0) return;
    const installed = new Map((await this.plugins.listPlugins()).map((item) => [item.id, item]));
    await Promise.all([...this.hosts.entries()].map(async ([id, host]) => {
      if (id === builtinHistory.id) return;
      const summary = installed.get(id);
      const info = summary !== undefined && summary.enabled && summary.state === 'ok'
        ? await this.plugins.getPluginInfo({ id }).catch(() => undefined)
        : undefined;
      if (info !== undefined && info.enabled && info.state === 'ok' &&
          this.hostSignatures.get(id) === hostSignature(info)) return;
      await this.imAdaptersSink?.withdraw([id]);
      if (this.hosts.get(id) === host) {
        this.hosts.delete(id);
        this.hostSignatures.delete(id);
      }
      await host.stopAndWait();
    }));
  }

  private reconcileResidents(affected?: readonly string[], reconfigure = false): Promise<void> {
    const work = this.applyResidents(affected, reconfigure);
    this.residentWork.add(work);
    void work.then(() => this.residentWork.delete(work), () => this.residentWork.delete(work));
    return work;
  }

  private async applyResidents(affected?: readonly string[], reconfigure = false): Promise<void> {
    await this.configService?.ready;
    if (this.closing) return;
    const installed = await this.plugins.listPlugins();
    if (this.closing || this.flags?.enabled(pluginAppLifecycleFlag.id) !== true) return;
    const matched = installed.filter((plugin) => plugin.enabled && plugin.state === 'ok' &&
      (affected === undefined || affected.includes(plugin.id)));
    const prepared = (await Promise.all(matched.map(async (plugin) => {
      if (this.closing) return undefined;
      const info = await this.plugins.getPluginInfo({ id: plugin.id });
      if (info.manifest?.kiki?.activation !== 'app' || this.closing) return undefined;
      try { await this.checkDependencies(info); } catch { return undefined; }
      const settings = await this.settings.forExecution(info.id);
      return { info, settings };
    }))).filter((item): item is { info: PluginInfo; settings: Record<string, string | number | boolean> } => item !== undefined);
    if (this.closing || prepared.length === 0) return;
    const lifecycle = this.activatePrepared(prepared, reconfigure);
    this.residentLifecycle.add(lifecycle);
    try { await lifecycle; }
    finally { this.residentLifecycle.delete(lifecycle); }
  }

  private async activatePrepared(prepared: readonly { readonly info: PluginInfo; readonly settings: Record<string, string | number | boolean> }[], reconfigure: boolean): Promise<void> {
    const results = await Promise.allSettled(prepared.map((item) => this.chainResident(item.info.id, async () => {
      if (this.closing) return;
      const host = this.getHost(item.info);
      if (!reconfigure && this.activated.has(host) && host.running) return;
      if (this.closing || this.hosts.get(item.info.id) !== host) return;
      await host.activate(item.settings, this.bootstrap.osHomeDir, path.join(this.bootstrap.homeDir, 'plugins', 'data', item.info.id));
      if (this.hosts.get(item.info.id) === host) this.activated.set(host, JSON.stringify(item.settings));
    })));
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  }

  private chainResident(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.residentChains.get(id) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    this.residentChains.set(id, run.then(() => undefined, () => undefined));
    return run;
  }

  async list(): Promise<readonly PluginToolRegistration[]> {
    const installed = await this.plugins.listPlugins();
    const enabled = installed.filter((plugin) => plugin.enabled && plugin.state === 'ok');
    const info = await Promise.all(enabled.map((plugin) => this.plugins.getPluginInfo({ id: plugin.id })));
    return info.flatMap((plugin) => (plugin.manifest?.kiki?.tools ?? []).map((definition) => ({ pluginId: plugin.id, definition })));
  }

  private quotaCache: (() => Promise<{ readonly sources: readonly import('@kiki/protocol').PluginHarnessQuotaSnapshot[] }>) | undefined;

  attachQuotaCache(reader: () => Promise<{ readonly sources: readonly import('@kiki/protocol').PluginHarnessQuotaSnapshot[] }>): void {
    this.quotaCache = reader;
  }

  async cachedHarnessQuota(): Promise<{ readonly sources: readonly import('@kiki/protocol').PluginHarnessQuotaSnapshot[] }> {
    const sources = await this.listHarnessQuotaSources();
    const cached = await this.quotaCache?.() ?? { sources: [] };
    const byId = new Map(cached.sources.map((source) => [source.id, source]));
    return { sources: sources.map((source) => {
      const hit = byId.get(source.id);
      return { ...source, engineIds: [...source.engineIds], readAt: hit?.readAt, readings: hit?.readings === undefined ? undefined : [...hit.readings], error: hit?.error };
    }) };
  }

  async listHarnessQuotaSources(): Promise<readonly PluginHarnessQuotaSource[]> {
    const installed = await this.plugins.listPlugins();
    const infos = await Promise.all(installed.filter((plugin) => plugin.enabled && plugin.state === 'ok').map((plugin) => this.plugins.getPluginInfo({ id: plugin.id })));
    return infos.filter((info) => info.enabled && info.state === 'ok').flatMap((info) =>
      (info.manifest?.kiki?.harnessQuotaSources ?? []).map(({ id, label, engineIds, minRefreshIntervalMs }) => ({
        id: `plugin:${info.id}/${id}`, label, engineIds: [...engineIds], minRefreshIntervalMs: Math.max(300_000, minRefreshIntervalMs ?? 300_000),
      })));
  }

  async readHarnessQuota(source: string, signal: AbortSignal): Promise<readonly import('@kiki/protocol').HarnessQuotaReading[]> {
    signal.throwIfAborted();
    const [, pluginId, sourceId] = /^plugin:([a-z0-9][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9-]{0,63})$/.exec(source) ?? [];
    if (pluginId === undefined || sourceId === undefined) throw new Error2(PluginErrors.codes.PLUGIN_LOAD_FAILED, 'Invalid plugin harness quota source id');
    return this.runRequest(pluginId, (info, settings) => {
      signal.throwIfAborted();
      const extension = info.manifest?.kiki;
      const definition = extension?.harnessQuotaSources?.find(({ id }) => id === sourceId);
      if (!info.enabled || info.state !== 'ok' || extension?.entry === undefined || definition === undefined) throw new Error('The quota source is not enabled or is no longer available');
      return this.getHost(info).readHarnessQuota(sourceId, signal, settings);
    }, signal);
  }

  async listHarnessAccountSources(): Promise<readonly PluginHarnessAccountSource[]> {
    const installed = await this.plugins.listPlugins();
    const infos = await Promise.all(installed.filter((plugin) => plugin.enabled && plugin.state === 'ok').map((plugin) => this.plugins.getPluginInfo({ id: plugin.id })));
    return infos.filter((info) => info.enabled && info.state === 'ok').flatMap((info) =>
      (info.manifest?.kiki?.harnessAccountSources ?? []).map(({ id, label, engineIds }) => ({
        id: `plugin:${info.id}/${id}`, label, engineIds: [...engineIds],
      })));
  }

  async listHarnessAccounts(source: string, engineId: string, signal: AbortSignal): Promise<readonly HarnessAccount[]> {
    if (!harnessAccountListInputSchema.safeParse({ engineId }).success) throw new Error2(PluginErrors.codes.PLUGIN_LOAD_FAILED, 'Invalid harness engine id');
    return this.runHarnessAccountRequest(source, engineId, signal, (host, sourceId, settings) => host.listHarnessAccounts(sourceId, engineId, signal, settings));
  }

  async prepareHarnessAccount(source: string, input: HarnessAccountPrepareInput, signal: AbortSignal): Promise<PluginHarnessAccountLease> {
    const parsed = harnessAccountPrepareInputSchema.safeParse(input);
    if (!parsed.success) throw new Error2(PluginErrors.codes.PLUGIN_LOAD_FAILED, 'Invalid harness account preparation input');
    return this.runHarnessAccountRequest(source, parsed.data.engineId, signal, async (host, sourceId, settings) => {
      const { connection, release } = await host.prepareHarnessAccount(sourceId, parsed.data, signal, settings);
      return { connection, release: () => release().catch((error: unknown) => { throw harnessAccountSourceError(source, error); }) };
    });
  }

  private async runHarnessAccountRequest<T>(source: string, engineId: string, signal: AbortSignal, action: (host: PluginHost, sourceId: string, settings: Record<string, unknown>) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const [, pluginId, sourceId] = /^plugin:([a-z0-9][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9-]{0,63})$/.exec(source) ?? [];
    if (pluginId === undefined || sourceId === undefined) throw new Error2(PluginErrors.codes.PLUGIN_LOAD_FAILED, 'Invalid plugin harness account source id');
    try {
      return await this.runRequest(pluginId, (info, settings) => {
        signal.throwIfAborted();
        const extension = info.manifest?.kiki;
        const definition = extension?.harnessAccountSources?.find(({ id }) => id === sourceId);
        if (!info.enabled || info.state !== 'ok' || extension?.entry === undefined || definition === undefined) throw new Error('The source is not enabled or is no longer available');
        if (!definition.engineIds.includes(engineId)) throw new Error(`The source does not support engine ${engineId}`);
        return action(this.getHost(info), sourceId, settings);
      }, signal);
    } catch (error) {
      signal.throwIfAborted();
      throw harnessAccountSourceError(source, error);
    }
  }

  async listMediaProviders(): Promise<readonly PluginMediaProviderRegistration[]> {
    await this.connections?.ready;
    const installed = await this.plugins.listPlugins();
    const infos = await Promise.all(installed.filter((plugin) => plugin.enabled && plugin.state === 'ok').map((plugin) => this.plugins.getPluginInfo({ id: plugin.id })));
    const replaced = new Set(infos.flatMap((info) => (info.manifest?.kiki?.mediaSources ?? []).flatMap((group) => group.legacyPluginId === undefined ? [] : [group.legacyPluginId])));
    const items = await Promise.all(infos.filter((info) => !replaced.has(info.id)).map(async (info) => {
      const settings = await this.settings.forExecution(info.id);
      const definitions = info.manifest?.kiki?.mediaProviders ?? [];
      const scriptId = info.manifest?.kiki?.mediaScriptProvider;
      const expanded = definitions.filter((definition) => definition.id !== scriptId);
      if (scriptId !== undefined) {
        const script = definitions.find((definition) => definition.id === scriptId)!;
        expanded.push(...scriptSources(settings).filter((source) => source.enabled && !source.removed).map((source) => scriptDefinition(source, script.resumeVersion)));
      }
      const entries = await Promise.all(expanded.map((definition) => this.mediaEntry(info, settings, definition.id)));
      return entries.filter((entry) => entry !== undefined).map((entry) => entry.registration);
    }));
    return items.flat();
  }

  private async mediaEntry(info: PluginInfo, settings: MediaSettingValues, id: string) {
    const extension = info.manifest?.kiki;
    let definition = extension?.mediaProviders?.find((item) => item.id === id);
    let execution: Record<string, unknown> = settings;
    let configuration: Record<string, unknown> = settings;
    let connectionDefinition = definition;
    let aliases: string[] = [];
    const group = extension?.mediaSources?.find((item) => item.providerIds.includes(id));
    if (group !== undefined) {
      const legacySummary = (await this.plugins.listPlugins()).find((plugin) => plugin.id === group.legacyPluginId);
      const legacyInfo = legacySummary === undefined ? undefined : await this.plugins.getPluginInfo({ id: legacySummary.id });
      const legacyInstalled = legacyInfo?.manifest !== undefined;
      if (!sourceActive(settings, group) || (settings[group.settingsPrefix + 'enabled'] === undefined && legacyInstalled && !legacyInfo.enabled)) return undefined;
      const legacy = legacyInstalled ? await this.settings.forExecution(group.legacyPluginId!) : {};
      configuration = sourceValues(settings, group, legacy);
      const schema = sourceSchema(extension!, group);
      execution = sourceDefaults(schema, configuration as MediaSettingValues);
      connectionDefinition = definition === undefined ? undefined : { ...definition, connectionSetting: 'connectionId' };
      aliases = group.legacyPluginId === undefined ? [] : [`${group.legacyPluginId}/${id.slice(group.id.length + 1)}`];
    } else if (extension?.mediaScriptProvider !== undefined && id.startsWith('script-')) {
      const source = scriptSources(settings).find((item) => `script-${item.id}` === id);
      const runtime = extension.mediaProviders?.find((item) => item.id === extension.mediaScriptProvider);
      if (source === undefined || !source.enabled || source.removed || runtime === undefined) return undefined;
      definition = scriptDefinition(source, runtime.resumeVersion);
      execution = { scriptSource: source, environment: settings[scriptEnvironmentKey(source.id)] };
      configuration = { scriptSource: { ...source, enabled: undefined, removed: undefined }, environment: execution['environment'] };
      connectionDefinition = undefined;
    }
    if (definition === undefined) return undefined;
    const registration = { ...this.mediaRegistration(info, configuration, connectionDefinition ?? definition), provider: `${info.id}/${definition.id}`, definition, aliases };
    return { registration, execution, runtimeId: group !== undefined ? definition.id : id.startsWith('script-') && extension?.mediaScriptProvider !== undefined ? extension.mediaScriptProvider : definition.id, connectionDefinition };
  }

  requestMediaProvider(provider: string, action: 'describe' | 'submit' | 'poll' | 'cancel' | 'voices', input: unknown, signal: AbortSignal, context: PluginMediaCallContext, expected?: PluginMediaProviderRegistration): Promise<unknown> {
    const [pluginId, providerId, extra] = provider.split('/');
    if (!pluginId || !providerId || extra !== undefined) return Promise.reject(new Error('Invalid media provider id'));
    return this.runRequest(pluginId, async (info, settings) => {
      await this.connections?.ready;
      signal.throwIfAborted();
      const entry = await this.mediaEntry(info, settings, providerId);
      if (!info.enabled || info.state !== 'ok' || info.manifest?.kiki?.entry === undefined || entry === undefined) throw new Error('Media provider is not enabled');
      const current = entry.registration;
      if (expected !== undefined && (expected.source !== current.source || expected.configuration !== current.configuration || expected.definition.resumeVersion !== current.definition.resumeVersion)) throw new Error('Media provider source, endpoint, credential or resume version changed; restore the original provider configuration');
      return this.getHost(info).requestMediaProvider(entry.runtimeId, action, input, signal, entry.execution, {
        ...context, connection: () => entry.connectionDefinition === undefined ? Promise.resolve(undefined) : this.resolveMediaConnection(info, entry.execution, entry.connectionDefinition, context),
      }, context.onProgress);
    });
  }

  private mediaRegistration(info: PluginInfo, settings: Record<string, unknown>, definition: MediaProviderDefinition): PluginMediaProviderRegistration {
    const connectionId = definition.connectionSetting === undefined ? undefined : settings[definition.connectionSetting];
    const connection = typeof connectionId === 'string' && connectionId ? this.connections?.get(connectionId) : undefined;
    return { provider: `${info.id}/${definition.id}`, definition, source: info.originalSource ?? info.root, version: info.version,
      configuration: createHash('sha256').update(JSON.stringify([Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)), connection === undefined ? undefined : { baseUrl: connection.baseUrl, oauth: connection.oauth, apiKey: connection.apiKey, customHeaders: connection.customHeaders }])).digest('hex') };
  }

  private async resolveMediaConnection(info: PluginInfo, settings: Record<string, unknown>, definition: MediaProviderDefinition, context: PluginMediaCallContext): Promise<MediaConnection | undefined> {
    const setting = definition.connectionSetting;
    if (setting === undefined) return undefined;
    const group = info.manifest?.kiki?.mediaSources?.find((source) => source.providerIds.includes(definition.id));
    if (info.manifest?.kiki?.settings?.schema.properties[(group?.settingsPrefix ?? '') + setting]?.type !== 'string') throw new Error('Media connectionSetting must name a declared string setting');
    const id = settings[setting];
    if (id === undefined || id === '') return undefined;
    if (typeof id !== 'string' || this.connections === undefined) throw new Error('Configured Kiki connection is unavailable');
    await this.connections.ready;
    const connection = this.connections.get(id);
    if (connection === undefined) throw new Error('Selected Kiki connection does not exist');
    const headers = { ...connection.customHeaders };
    const resolvedDef = connection.type === undefined ? undefined : (this.protocolAdapters?.current?.providerDefinition?.(connection.type) ?? getProviderDefinition(connection.type));
    const protocolValue = connection.type === undefined ? undefined : resolvedDef?.baseProtocol ?? connection.type;
    const protocol = ProtocolSchema.safeParse(protocolValue);
    if (context.owner?.identity !== undefined && this.identityCatalog !== undefined && protocol.success) {
      await this.identityCatalog.ready;
      const policy = this.identityCatalog.resolveLayers(defaultOAuthRequestIdentity(connection), this.configService?.get<RequestIdentityPolicy | undefined>(REQUEST_IDENTITY_SECTION), connection.requestIdentity);
      const projected = projectRequestIdentity({ policy, protocol: protocol.data, model: context.model ?? '', rawSessionId: context.owner.sessionId, rawAgentId: context.owner.agentId, parentAgentId: context.owner.parentAgentId,
        isKimiProvider: resolvedDef?.requestIdentityDeviceHeaders === true, snapshot: { ...context.owner.identity, setTurnState() {} }, runtimeVersion: this.bootstrap.clientIdentity.version, platform: this.bootstrap.platform, arch: this.bootstrap.arch,
        hostRequestHeaders: this.bootstrap.args.requestHeaders, profile: this.identityCatalog.render(policy, context.model ?? '') });
      Object.assign(headers, projected.headers);
    }
    let authentication: MediaConnection['authentication'] = 'none';
    let auth: ProviderRequestAuth | undefined;
    if (connection.oauth !== undefined) {
      const provider = this.oauth?.resolveTokenProvider(id, connection.oauth);
      if (provider === undefined) throw new Error('Selected Kiki OAuth connection cannot supply authentication');
      const token = await provider.getAccessToken();
      auth = mergeProviderRequestAuth(oauthRequestAuth(id, connection.oauth, token), headers);
      Object.assign(headers, auth?.headers, { Authorization: `Bearer ${token}` });
      authentication = 'oauth';
    } else if (connection.apiKey) {
      const protocol = protocolValue;
      headers[protocol === 'google_genai' ? 'x-goog-api-key' : protocol === 'anthropic' ? 'x-api-key' : 'Authorization'] = protocol === 'google_genai' || protocol === 'anthropic' ? connection.apiKey : `Bearer ${connection.apiKey}`;
      authentication = 'api-key';
    }
    const finalHeaders: Record<string, string> = {};
    finalizeProviderRequestHeaders(headers, auth).forEach((value, name) => { finalHeaders[name] = value; });
    return { id, type: connection.type, baseUrl: resolveConfiguredModelBaseUrl({}, connection), headers: finalHeaders, authentication };
  }

  execute(pluginId: string, tool: string, args: unknown, signal: AbortSignal, onProgress?: (update: ToolUpdate) => void, scope: PluginExecutionScope = {}, expectedDefinition?: PluginTool): Promise<ExecutableToolResult> {
    return this.runRequest(pluginId, (info, settings) => {
      signal.throwIfAborted();
      const definition = info.manifest?.kiki?.tools?.find((item) => item.name === tool);
      if (!info.enabled || info.state !== 'ok' || info.manifest?.kiki?.entry === undefined || definition === undefined) {
        throw new Error(`Plugin ${pluginId} tool ${tool} is not enabled`);
      }
      if (expectedDefinition !== undefined && JSON.stringify(definition) !== JSON.stringify(expectedDefinition)) {
        throw new Error(`Plugin ${pluginId} tool ${tool} definition changed before execution. Retry with the current tool schema.`);
      }
      return this.getHost(info).execute(tool, args, signal, onProgress, settings, scope);
    });
  }

  installPrerequisite(pluginId: string, prerequisiteId: string, consent: boolean): Promise<string> {
    if (consent !== true) return Promise.reject(new Error('Installing a plugin prerequisite requires explicit consent'));
    return this.runRequest(pluginId, async (info) => {
      const prereq = info.manifest?.prerequisites?.items.find((item) => item.id === prerequisiteId);
      const entry = info.manifest?.kiki?.entry;
      const setting = prereq?.setting;
      const property = setting === undefined ? undefined : info.manifest?.kiki?.settings?.schema.properties[setting];
      if (info.state !== 'ok' || entry === undefined || prereq?.kind !== 'executable' ||
        prereq.executionHost !== 'plugin-runtime' || prereq.version === undefined ||
        setting === undefined || property?.type !== 'string') {
        throw new Error(`Plugin ${pluginId} has no supported installer for prerequisite ${prerequisiteId}`);
      }
      const filename = `${prerequisiteId}-${prereq.version}${process.platform === 'win32' ? '.exe' : ''}`;
      const destination = path.join(this.bootstrap.homeDir, 'plugins', 'data', info.id, filename);
      const host = new PluginHost(info.id, entry, info.manifest!.kiki!.tools ?? [], info.manifest?.kiki?.sessionSources, info.manifest?.kiki?.mediaProviders, undefined, this.bootstrap.homeDir, info.manifest?.kiki?.imAdapters, info.manifest?.kiki?.harnessAccountSources, undefined, info.manifest?.kiki?.harnessQuotaSources);
      try {
        await host.installPrerequisite(destination);
        await this.settings.update({ pluginId: info.id, values: { [setting]: destination } });
        return destination;
      } finally { await host.stopAndWait(); }
    });
  }

  requestPanel(pluginId: string, panelId: string, action: string, args: unknown): Promise<unknown> {
    return this.runRequest(pluginId, (info, settings) => {
      if (!info.enabled || info.state !== 'ok' || info.manifest?.kiki?.entry === undefined ||
        !info.manifest?.kiki?.panels?.some((panel) => panel.id === panelId)) {
        throw new Error2(PluginErrors.codes.PLUGIN_LOAD_FAILED, `Plugin ${pluginId} panel ${panelId} has no enabled backend`);
      }
      return this.getHost(info).requestPanel(action, args, settings);
    });
  }

  requestSource(pluginId: string, sourceId: string, action: 'discover' | 'probe' | 'parse', args: unknown, signal: AbortSignal): Promise<unknown> {
    if (pluginId === builtinHistory.id) {
      return this.runTracked(pluginId, async () => {
        const settings = await this.settings.forExecution(pluginId);
        return () => {
          signal.throwIfAborted();
          if (!builtinHistory.sessionSources.some((item) => item.id === sourceId)) throw new Error('Unknown built-in history source');
          const info = { id: pluginId, manifest: { name: pluginId, kiki: { entry: builtinHistoryEntry(this.bootstrap), sessionSources: builtinHistory.sessionSources } } };
          return this.getHost(info).requestSource(sourceId, action, args, signal, settings);
        };
      });
    }
    return this.runRequest(pluginId, (info, settings) => {
      signal.throwIfAborted();
      const extension = info.manifest?.kiki;
      if (!info.enabled || info.state !== 'ok' || extension?.entry === undefined || !extension.sessionSources?.some((item) => item.id === sourceId)) throw new Error('Session source is not enabled');
      return this.getHost(info).requestSource(sourceId, action, args, signal, settings);
    });
  }

  private getHost(info: Pick<PluginInfo, 'id' | 'manifest'> & Partial<Pick<PluginInfo, 'root' | 'version'>>): PluginHost {
    let host = this.hosts.get(info.id);
    if (host === undefined) {
      const updateSettings = async (values: Record<string, string | number | boolean | null>) => {
        this.ownSettingsWrites.add(info.id);
        try { return await this.settings.update({ pluginId: info.id, values }); }
        finally { this.ownSettingsWrites.delete(info.id); }
      };
      host = new PluginHost(info.id, info.manifest!.kiki!.entry!, info.manifest!.kiki!.tools ?? [], info.manifest?.kiki?.sessionSources, info.manifest?.kiki?.mediaProviders,
        { resident: info.manifest?.kiki?.activation === 'app', updateSettings, observeActivity: this.sessions === undefined ? undefined : (listener) => observePluginActivity(this.sessions!, listener),
        focusSession: (sessionId) => {
          if (this.sessions?.get(sessionId) === undefined) throw new Error('Session is not live');
          this.navigationRequest = { id: ++this.nextNavigationId, pluginId: info.id, sessionId, at: Date.now() };
        }, im: () => this.outboundIm }, this.bootstrap.homeDir, info.manifest?.kiki?.imAdapters, info.manifest?.kiki?.harnessAccountSources, {
        models: { list: (options) => pluginModelCatalog(this.modelCatalog, options?.candidates) },
        credentials: {
          status: async (setting) => credentialStatus(await this.settings.inspect(info.id), setting),
          set: async (setting, value) => {
            credentialStatus(await this.settings.inspect(info.id), setting);
            return credentialStatus(await updateSettings({ [setting]: value }), setting);
          },
        },
      }, info.manifest?.kiki?.harnessQuotaSources, () => this.cachedHarnessQuota(), (exit) => {
        if (!this.closing) this.logger?.current?.warn('Plugin host exited unexpectedly', exit);
      });
      this.hosts.set(info.id, host);
      this.hostSignatures.set(info.id, hostSignature(info));
    }
    return host;
  }

  private runRequest<T>(pluginId: string, action: (info: PluginInfo, settings: Record<string, string | number | boolean>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.runTracked(pluginId, async () => {
      signal?.throwIfAborted();
      const info = await this.plugins.getPluginInfo({ id: pluginId.toLowerCase() });
      await this.checkDependencies(info);
      const settings = await this.settings.forExecution(info.id);
      return async () => {
        signal?.throwIfAborted();
        if (this.closing) throw new Error('Plugin Host is shutting down');
        if (info.enabled && info.state === 'ok' && info.manifest?.kiki?.activation === 'app') {
          if (this.flags?.enabled(pluginAppLifecycleFlag.id) !== true) throw new Error('App plugin lifecycle is not enabled in this Kiki build');
          const host = this.getHost(info);
          if (this.activated.get(host) !== JSON.stringify(settings) || !host.running) {
            await host.activate(settings, this.bootstrap.osHomeDir, path.join(this.bootstrap.homeDir, 'plugins', 'data', info.id));
            this.activated.set(host, JSON.stringify(settings));
          }
        }
        return action(info, settings);
      };
    }, signal);
  }

  private async runTracked<T>(pluginId: string, prepare: () => Promise<() => Promise<T>>, signal?: AbortSignal): Promise<T> {
    const id = pluginId.toLowerCase();
    for (;;) {
      const globalGate = this.globalGate;
      const gate = this.gates.get(id);
      if (signal === undefined) {
        await globalGate;
        await gate;
      } else {
        await abortable(Promise.all([globalGate, gate]), signal);
        signal.throwIfAborted();
      }
      const action = await prepare();
      signal?.throwIfAborted();
      if (globalGate !== this.globalGate || gate !== this.gates.get(id)) continue;
      const requests = this.active.get(id) ?? new Set<Promise<unknown>>();
      this.active.set(id, requests);
      const request = Promise.resolve().then(action);
      requests.add(request);
      try { return await request; }
      finally {
        requests.delete(request);
        if (requests.size === 0) this.active.delete(id);
      }
    }
  }

  invokeSlot<TPayload, TResult>(invocation: Omit<IsolatedPluginInvocation<TPayload>, 'generation'>): Promise<IsolatedPluginResult<TResult>> {
    return this.runRequest(invocation.pluginId, async (info, settings) => {
      const plugin = info.manifest?.kiki;
      if (!info.enabled || info.state !== 'ok' || !plugin?.entry || !plugin.slots?.includes(invocation.slot as ExtensionSlotId)) {
        throw new Error(`Plugin ${info.id} does not expose slot ${invocation.slot}`);
      }
      if (plugin.tier === 'in-process') throw new Error('In-process plugin slots use the Cordis runtime');
      if (invocation.agentId && !invocation.sessionId) throw new Error('Agent plugin invocation requires a session');
      const runtime = this.cordis?.current;
      const gate = invocation.sessionId
        ? invocation.agentId ? runtime?.admissionGateForAgent(invocation.sessionId, invocation.agentId)
          : runtime?.admissionGateForSession(invocation.sessionId)
        : undefined;
      if (invocation.sessionId && (!gate || gate.revoked)) throw new Error('Plugin invocation scope is unavailable');
      const signature = JSON.stringify([hostSignature(info), settings]);
      const prior = this.slotRegistrations.get(info.id);
      const pool = plugin.tier === 'worker-isolate' ? this.isolates?.current : undefined;
      if (plugin.tier === 'worker-isolate' && !pool) throw new Error('Plugin isolate pool is unavailable');
      const record = prior?.signature === signature ? prior : {
        signature,
        registration: pool
          ? pool.registerWorkerPlugin({ pluginId: info.id, entryPath: plugin.entry, settings })
          : Promise.resolve({ generation: ++this.slotGeneration, dispose: async () => { await this.hosts.get(info.id)?.terminateSlotRealm(); } }),
      };
      this.slotRegistrations.set(info.id, record);
      const { generation } = await record.registration;
      const assertAdmitted = () => {
        if (gate?.revoked || this.closing || this.slotRegistrations.get(info.id) !== record) throw new Error('Plugin invocation was withdrawn');
      };
      assertAdmitted();
      const request = { ...invocation, pluginId: info.id, generation };
      const result = pool
        ? await pool.invoke<TPayload, TResult>(request)
        : await this.getHost(info).invokeSlot<TPayload, TResult>(request, settings);
      assertAdmitted();
      return result;
    }, invocation.signal);
  }

  private async withdrawSlot(pluginId: string): Promise<void> {
    const record = this.slotRegistrations.get(pluginId);
    this.slotRegistrations.delete(pluginId);
    if (record) await (await record.registration).dispose();
  }

  running(pluginId: string): boolean {
    return this.hosts.get(pluginId.toLowerCase())?.running ?? false;
  }

  navigation(): { readonly id: number; readonly pluginId: string; readonly sessionId: string; readonly at: number } | undefined {
    return this.navigationRequest !== undefined && Date.now() - this.navigationRequest.at < 10000 ? this.navigationRequest : undefined;
  }
}

function hostSignature(info: Pick<PluginInfo, 'id' | 'manifest'> & Partial<Pick<PluginInfo, 'root' | 'version'>>): string {
  return JSON.stringify([info.id, info.root ?? '', info.version ?? '', info.manifest]);
}

function credentialStatus(view: import('./pluginSettingsService').SettingsView, setting: string): import('@kiki/protocol').PluginCredentialStatus {
  if (view.schema?.schema.properties[setting]?.secret !== true) throw new Error('Plugin credential is not declared');
  return { reference: { kind: 'plugin-setting', setting }, configured: view.secretsConfigured.includes(setting) };
}

function harnessAccountSourceError(source: string, error: unknown): Error2 {
  return new Error2(PluginErrors.codes.PLUGIN_LOAD_FAILED, `Harness account source ${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error, details: { source } });
}

registerScopedService(LifecycleScope.App, IPluginHostService, PluginHostService, ScopeActivation.OnScopeCreated, 'plugin');
