import path from 'node:path';
import { createHash } from 'node:crypto';
import type { MediaProviderDefinition, PluginMediaApi, MediaConnection } from '@kiki/protocol';
import { IProviderService } from '#/kosong/provider/provider';
import { IOAuthService } from '#/app/auth/auth';
import { oauthRequestAuth } from '#/kosong/model/modelOAuth';
import { resolveConfiguredModelBaseUrl } from '#/kosong/model/modelAuth';
import { mergeProviderRequestAuth, finalizeProviderRequestHeaders } from '#/kosong/provider/bases/request-auth';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';
import { getProviderDefinition } from '#/kosong/provider/providerDefinition';
import { IRequestIdentityCatalog } from '#/app/requestIdentity/requestIdentityCatalog';
import { IConfigService } from '#/app/config/config';
import { REQUEST_IDENTITY_SECTION } from '#/app/kosongConfig/configSection';
import { defaultOAuthRequestIdentity, type RequestIdentityPolicy } from '#/kosong/requestIdentity/requestIdentityPolicy';
import { projectRequestIdentity } from '#/kosong/requestIdentity/requestIdentityProjector';
import { ProtocolSchema } from '#/kosong/protocol/protocol';

import { createDecorator } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { toDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { Error2, PluginErrors } from '#/errors';
import type { ExecutableToolResult, ToolUpdate } from '#/tool/toolContract';

import { PluginHost } from './host';
import { builtinHistory, builtinHistoryEntry } from '#/app/pluginImport/builtinHistory';
import { IPluginService } from './plugin';
import { IPluginSettingsService } from './pluginSettingsService';
import type { PluginTool } from './contributions';
import type { PluginInfo } from './types';

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
  readonly media?: PluginMediaApi;
}

export interface IPluginHostService {
  readonly _serviceBrand: undefined;
  list(): Promise<readonly PluginToolRegistration[]>;
  listMediaProviders(): Promise<readonly PluginMediaProviderRegistration[]>;
  requestMediaProvider(provider: string, action: 'describe' | 'submit' | 'poll' | 'cancel' | 'voices', input: unknown, signal: AbortSignal, context: PluginMediaCallContext, expected?: PluginMediaProviderRegistration): Promise<unknown>;
  execute(pluginId: string, tool: string, args: unknown, signal: AbortSignal, onProgress?: (update: ToolUpdate) => void, scope?: PluginExecutionScope, expectedDefinition?: PluginTool): Promise<ExecutableToolResult>;
  installPrerequisite(pluginId: string, prerequisiteId: string, consent: boolean): Promise<string>;
  requestPanel(pluginId: string, panelId: string, action: string, args: unknown): Promise<unknown>;
  requestSource(pluginId: string, sourceId: string, action: 'discover' | 'probe' | 'parse', args: unknown, signal: AbortSignal): Promise<unknown>;
  running(pluginId: string): boolean;
}

export const IPluginHostService = createDecorator<IPluginHostService>('pluginHostService');

export class PluginHostService extends Service implements IPluginHostService {
  declare readonly _serviceBrand: undefined;
  private readonly hosts = new Map<string, PluginHost>();
  private readonly active = new Map<string, Set<Promise<unknown>>>();
  private readonly gates = new Map<string, Promise<void>>();
  private globalGate: Promise<void> | undefined;

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IPluginSettingsService private readonly settings: IPluginSettingsService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IProviderService private readonly connections?: IProviderService,
    @IOAuthService private readonly oauth?: IOAuthService,
    @IRequestIdentityCatalog private readonly identityCatalog?: IRequestIdentityCatalog,
    @IConfigService private readonly configService?: IConfigService,
  ) {
    super();
    this._register(this.plugins.onWillChange((event) => {
      if (event.affected === undefined) this.globalGate = event.finished;
      else for (const id of event.affected) this.gates.set(id, event.finished);
      const ids = event.affected ?? [...new Set([...this.hosts.keys(), ...this.active.keys()])];
      event.waitUntil(Promise.all(ids.map(async (id) => {
        await Promise.allSettled(this.active.get(id) ?? new Set<Promise<unknown>>());
        const host = this.hosts.get(id);
        this.hosts.delete(id);
        await host?.stopAndWait();
      })));
    }));
    this._register(toDisposable(() => {
      for (const host of this.hosts.values()) host.stop();
      this.hosts.clear();
    }));
  }

  async list(): Promise<readonly PluginToolRegistration[]> {
    const installed = await this.plugins.listPlugins();
    const enabled = installed.filter((plugin) => plugin.enabled && plugin.state === 'ok');
    const info = await Promise.all(enabled.map((plugin) => this.plugins.getPluginInfo({ id: plugin.id })));
    return info.flatMap((plugin) => (plugin.manifest?.kiki?.tools ?? []).map((definition) => ({ pluginId: plugin.id, definition })));
  }

  async listMediaProviders(): Promise<readonly PluginMediaProviderRegistration[]> {
    await this.connections?.ready;
    const installed = await this.plugins.listPlugins();
    const items = await Promise.all(installed.filter((plugin) => plugin.enabled && plugin.state === 'ok').map(async (plugin) => {
      const info = await this.plugins.getPluginInfo({ id: plugin.id });
      const settings = await this.settings.forExecution(plugin.id);
      return (info.manifest?.kiki?.mediaProviders ?? []).map((definition) => this.mediaRegistration(info, settings, definition));
    }));
    return items.flat();
  }

  requestMediaProvider(provider: string, action: 'describe' | 'submit' | 'poll' | 'cancel' | 'voices', input: unknown, signal: AbortSignal, context: PluginMediaCallContext, expected?: PluginMediaProviderRegistration): Promise<unknown> {
    const [pluginId, providerId, extra] = provider.split('/');
    if (!pluginId || !providerId || extra !== undefined) return Promise.reject(new Error('Invalid media provider id'));
    return this.runRequest(pluginId, async (info, settings) => {
      await this.connections?.ready;
      signal.throwIfAborted();
      const definition = info.manifest?.kiki?.mediaProviders?.find((item) => item.id === providerId);
      if (!info.enabled || info.state !== 'ok' || info.manifest?.kiki?.entry === undefined || definition === undefined) throw new Error('Media provider is not enabled');
      const current = this.mediaRegistration(info, settings, definition);
      if (expected !== undefined && (expected.source !== current.source || expected.configuration !== current.configuration || expected.definition.resumeVersion !== definition.resumeVersion)) throw new Error('Media provider source, endpoint, credential or resume version changed; restore the original provider configuration');
      return this.getHost(info).requestMediaProvider(providerId, action, input, signal, settings, {
        ...context, connection: () => this.resolveMediaConnection(info, settings, definition, context),
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
    if (info.manifest?.kiki?.settings?.schema.properties[setting]?.type !== 'string') throw new Error('Media connectionSetting must name a declared string setting');
    const id = settings[setting];
    if (id === undefined || id === '') return undefined;
    if (typeof id !== 'string' || this.connections === undefined) throw new Error('Configured Kiki connection is unavailable');
    await this.connections.ready;
    const connection = this.connections.get(id);
    if (connection === undefined) throw new Error('Selected Kiki connection does not exist');
    const headers = { ...connection.customHeaders };
    const protocolValue = connection.type === undefined ? undefined : getProviderDefinition(connection.type)?.baseProtocol ?? connection.type;
    const protocol = ProtocolSchema.safeParse(protocolValue);
    if (context.owner?.identity !== undefined && this.identityCatalog !== undefined && protocol.success) {
      await this.identityCatalog.ready;
      const policy = this.identityCatalog.resolveLayers(defaultOAuthRequestIdentity(connection), this.configService?.get<RequestIdentityPolicy | undefined>(REQUEST_IDENTITY_SECTION), connection.requestIdentity);
      const projected = projectRequestIdentity({ policy, protocol: protocol.data, model: context.model ?? '', rawSessionId: context.owner.sessionId, rawAgentId: context.owner.agentId, parentAgentId: context.owner.parentAgentId,
        isKimiProvider: connection.type !== undefined && getProviderDefinition(connection.type)?.requestIdentityDeviceHeaders === true, snapshot: { ...context.owner.identity, setTurnState() {} }, runtimeVersion: this.bootstrap.clientIdentity.version, platform: this.bootstrap.platform, arch: this.bootstrap.arch,
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
      const protocol = connection.type === undefined ? undefined : getProviderDefinition(connection.type)?.baseProtocol ?? connection.type;
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
      const host = new PluginHost(info.id, entry, info.manifest!.kiki!.tools ?? [], info.manifest?.kiki?.sessionSources, info.manifest?.kiki?.mediaProviders);
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

  private getHost(info: Pick<PluginInfo, 'id' | 'manifest'>): PluginHost {
    let host = this.hosts.get(info.id);
    if (host === undefined) {
      host = new PluginHost(info.id, info.manifest!.kiki!.entry!, info.manifest!.kiki!.tools ?? [], info.manifest?.kiki?.sessionSources, info.manifest?.kiki?.mediaProviders);
      this.hosts.set(info.id, host);
    }
    return host;
  }

  private runRequest<T>(pluginId: string, action: (info: PluginInfo, settings: Record<string, string | number | boolean>) => Promise<T>): Promise<T> {
    return this.runTracked(pluginId, async () => {
      const info = await this.plugins.getPluginInfo({ id: pluginId.toLowerCase() });
      const settings = await this.settings.forExecution(info.id);
      return () => action(info, settings);
    });
  }

  private async runTracked<T>(pluginId: string, prepare: () => Promise<() => Promise<T>>): Promise<T> {
    const id = pluginId.toLowerCase();
    for (;;) {
      const globalGate = this.globalGate;
      const gate = this.gates.get(id);
      await globalGate;
      await gate;
      const action = await prepare();
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

  running(pluginId: string): boolean {
    return this.hosts.get(pluginId.toLowerCase())?.running ?? false;
  }
}

registerScopedService(LifecycleScope.App, IPluginHostService, PluginHostService, ScopeActivation.OnScopeCreated, 'plugin');
