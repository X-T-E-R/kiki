import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';

import { IPluginService } from './plugin';
import { PLUGIN_SETTINGS_SECTION, PluginSettingsSectionSchema } from './settingsConfigSection';
import type { PluginSettings } from './contributions';

export interface SettingsView {
  readonly schema?: PluginSettings;
  readonly values: Readonly<Record<string, string | boolean | number>>;
  readonly secretsConfigured: readonly string[];
}

export interface PluginSettingsUpdate {
  readonly pluginId: string;
  readonly values: Record<string, string | number | boolean | null>;
}

export interface IPluginSettingsService {
  readonly _serviceBrand: undefined;
  inspect(pluginId: string): Promise<SettingsView>;
  update(input: PluginSettingsUpdate): Promise<SettingsView>;
  forExecution(pluginId: string): Promise<Record<string, string | number | boolean>>;
  clear(pluginId: string): Promise<void>;
}

export const IPluginSettingsService = createDecorator<IPluginSettingsService>('pluginSettingsService');

export class PluginSettingsService extends Service implements IPluginSettingsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IPluginService private readonly plugins: IPluginService,
  ) { super(); }

  async inspect(pluginId: string): Promise<SettingsView> {
    const info = await this.plugins.getPluginInfo({ id: pluginId });
    const schema = info.manifest?.kiki?.settings;
    const stored = await this.stored(pluginId);
    const values: Record<string, string | boolean | number> = {};
    const secretsConfigured: string[] = [];
    for (const [key, property] of Object.entries(schema?.schema.properties ?? {})) {
      const value = stored[property.secret ? secretKey(key) : key];
      if (value === undefined) continue;
      if (property.secret) secretsConfigured.push(key);
      else values[key] = value;
    }
    return { schema, values, secretsConfigured };
  }

  async update(input: PluginSettingsUpdate): Promise<SettingsView> {
    const { pluginId, values } = input;
    const info = await this.plugins.getPluginInfo({ id: pluginId });
    const schema = info.manifest?.kiki?.settings;
    if (schema === undefined) throw new Error(`Plugin ${pluginId} declares no settings`);
    const current = await this.all();
    const updated = { ...current[pluginId] };
    for (const [key, value] of Object.entries(values)) {
      const property = schema.schema.properties[key];
      if (property === undefined) throw new Error(`Unknown setting ${key} for plugin ${pluginId}`);
      if (property.secret && (info.manifest?.kiki?.permissions?.secrets !== true || property.type !== 'string')) {
        throw new Error(`Plugin ${pluginId} is not allowed to receive setting ${key}`);
      }
      const storageKey = property.secret ? secretKey(key) : key;
      if (value === null) delete updated[storageKey];
      else if (typeof value !== property.type) throw new Error(`Invalid type for setting ${key}`);
      else updated[storageKey] = value;
    }
    await this.configService.replace(PLUGIN_SETTINGS_SECTION, { ...current, [pluginId]: updated });
    return this.inspect(pluginId);
  }

  async forExecution(pluginId: string): Promise<Record<string, string | number | boolean>> {
    const info = await this.plugins.getPluginInfo({ id: pluginId });
    const schema = info.manifest?.kiki?.settings?.schema;
    const stored = await this.stored(pluginId);
    const own: Record<string, string | number | boolean> = {};
    for (const [key, property] of Object.entries(schema?.properties ?? {})) {
      if (property.secret && info.manifest?.kiki?.permissions?.secrets !== true) continue;
      const value = stored[property.secret ? secretKey(key) : key];
      if (value !== undefined && typeof value === property.type) own[key] = value;
    }
    return own;
  }

  async clear(pluginId: string): Promise<void> {
    const current = await this.all();
    if (!(pluginId in current)) return;
    const { [pluginId]: _removed, ...rest } = current;
    await this.configService.replace(PLUGIN_SETTINGS_SECTION, rest);
  }

  private async stored(id: string): Promise<Record<string, string | number | boolean>> {
    return (await this.all())[id] ?? {};
  }

  private async all(): Promise<Record<string, Record<string, string | number | boolean>>> {
    await this.configService.ready;
    return PluginSettingsSectionSchema.parse(this.configService.get(PLUGIN_SETTINGS_SECTION));
  }
}

function secretKey(key: string): string { return `plugin_${key}_secret`; }

registerScopedService(LifecycleScope.App, IPluginSettingsService, PluginSettingsService, ScopeActivation.OnScopeCreated, 'plugin');
