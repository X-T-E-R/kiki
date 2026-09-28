import path from 'node:path';

import { createDecorator } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { toDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { ExecutableToolResult, ToolUpdate } from '#/tool/toolContract';

import { PluginHost } from './host';
import { IPluginService } from './plugin';
import { IPluginSettingsService } from './pluginSettingsService';
import type { PluginTool } from './contributions';

export interface PluginToolRegistration {
  readonly pluginId: string;
  readonly definition: PluginTool;
}

export interface PluginExecutionScope {
  readonly workspaceRoot?: string;
  readonly approvedPaths?: readonly string[];
  readonly imageIn?: boolean;
}

export interface IPluginHostService {
  readonly _serviceBrand: undefined;
  list(): Promise<readonly PluginToolRegistration[]>;
  execute(pluginId: string, tool: string, args: unknown, signal: AbortSignal, onProgress?: (update: ToolUpdate) => void, scope?: PluginExecutionScope): Promise<ExecutableToolResult>;
  installPrerequisite(pluginId: string, prerequisiteId: string, consent: boolean): Promise<string>;
  requestPanel(pluginId: string, panelId: string, action: string, args: unknown): Promise<unknown>;
  running(pluginId: string): boolean;
}

export const IPluginHostService = createDecorator<IPluginHostService>('pluginHostService');

export class PluginHostService extends Service implements IPluginHostService {
  declare readonly _serviceBrand: undefined;
  private readonly hosts = new Map<string, PluginHost>();

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IPluginSettingsService private readonly settings: IPluginSettingsService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    super();
    this._register(this.plugins.onDidReload(() => {
      for (const host of this.hosts.values()) host.stop();
      this.hosts.clear();
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

  async execute(pluginId: string, tool: string, args: unknown, signal: AbortSignal, onProgress?: (update: ToolUpdate) => void, scope: PluginExecutionScope = {}): Promise<ExecutableToolResult> {
    const info = await this.plugins.getPluginInfo({ id: pluginId });
    const entry = info.manifest?.kiki?.entry;
    const definitions = info.manifest?.kiki?.tools;
    if (!info.enabled || info.state !== 'ok' || entry === undefined || definitions?.some((definition) => definition.name === tool) !== true) {
      throw new Error(`Plugin ${pluginId} tool ${tool} is not enabled`);
    }
    let host = this.hosts.get(pluginId);
    if (host === undefined) {
      host = new PluginHost(pluginId, entry, definitions);
      this.hosts.set(pluginId, host);
    }
    const settings = await this.settings.forExecution(pluginId);
    return host.execute(tool, args, signal, onProgress, settings, scope);
  }

  async installPrerequisite(pluginId: string, prerequisiteId: string, consent: boolean): Promise<string> {
    if (consent !== true) throw new Error('Installing a plugin prerequisite requires explicit consent');
    const info = await this.plugins.getPluginInfo({ id: pluginId });
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
    const host = new PluginHost(info.id, entry, info.manifest!.kiki!.tools ?? []);
    try {
      await host.installPrerequisite(destination);
      await this.settings.update({ pluginId: info.id, values: { [setting]: destination } });
      return destination;
    } finally { host.stop(); }
  }

  async requestPanel(pluginId: string, panelId: string, action: string, args: unknown): Promise<unknown> {
    const info = await this.plugins.getPluginInfo({ id: pluginId });
    const entry = info.manifest?.kiki?.entry;
    if (!info.enabled || info.state !== 'ok' || entry === undefined ||
      !info.manifest?.kiki?.panels?.some((panel) => panel.id === panelId)) {
      throw new Error(`Plugin ${pluginId} panel ${panelId} is not enabled`);
    }
    let host = this.hosts.get(info.id);
    if (host === undefined) {
      host = new PluginHost(info.id, entry, info.manifest!.kiki!.tools ?? []);
      this.hosts.set(info.id, host);
    }
    return host.requestPanel(action, args, await this.settings.forExecution(info.id));
  }

  running(pluginId: string): boolean {
    return this.hosts.get(pluginId)?.running ?? false;
  }
}

registerScopedService(LifecycleScope.App, IPluginHostService, PluginHostService, ScopeActivation.OnScopeCreated, 'plugin');
