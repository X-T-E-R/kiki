import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';

import { IPluginService } from './plugin';
import { currentPluginId } from './renamedPlugins';
import { PLUGIN_SETTINGS_SECTION, PluginSettingsSectionSchema } from './settingsConfigSection';
import type { PluginSettings, PluginExtension } from './contributions';
import { builtinHistory } from '#/app/pluginImport/builtinHistory';

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

  private async extension(pluginId: string): Promise<PluginExtension | undefined> {
    const id = currentPluginId(pluginId);
    return id === builtinHistory.id ? { settings: builtinHistory.settings } : (await this.plugins.getPluginInfo({ id })).manifest?.kiki;
  }

  async inspect(pluginId: string): Promise<SettingsView> {
    const schema = (await this.extension(pluginId))?.settings;
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
    const { values } = input;
    const pluginId = currentPluginId(input.pluginId);
    const extension = await this.extension(pluginId);
    const schema = extension?.settings;
    if (schema === undefined) throw new Error(`Plugin ${pluginId} declares no settings`);
    const current = await this.all();
    const updated = { ...current[pluginId] };
    for (const [key, value] of Object.entries(values)) {
      const property = schema.schema.properties[key];
      if (property === undefined) throw new Error(`Unknown setting ${key} for plugin ${pluginId}`);
      if (property.secret && (extension?.permissions?.secrets !== true || property.type !== 'string')) {
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
    const extension = await this.extension(pluginId);
    const schema = extension?.settings?.schema;
    const stored = await this.stored(pluginId);
    const own: Record<string, string | number | boolean> = {};
    for (const [key, property] of Object.entries(schema?.properties ?? {})) {
      if (property.secret && extension?.permissions?.secrets !== true) continue;
      const value = stored[property.secret ? secretKey(key) : key];
      if (value !== undefined && typeof value === property.type) own[key] = value;
    }
    return own;
  }

  async clear(pluginId: string): Promise<void> {
    const key = currentPluginId(pluginId);
    const current = await this.all();
    if (!(key in current)) return;
    const { [key]: _removed, ...rest } = current;
    await this.configService.replace(PLUGIN_SETTINGS_SECTION, rest);
  }

  private async stored(id: string): Promise<Record<string, string | number | boolean>> {
    return (await this.all())[currentPluginId(id)] ?? {};
  }

  private async all(): Promise<Record<string, Record<string, string | number | boolean>>> {
    await this.configService.ready;
    const stored = PluginSettingsSectionSchema.parse(this.configService.get(PLUGIN_SETTINGS_SECTION));
    const out: Record<string, Record<string, string | number | boolean>> = {};
    for (const [id, values] of Object.entries(stored)) {
      const current = currentPluginId(id);
      out[current] = current === id ? { ...out[current], ...values } : { ...values, ...out[current] };
    }
    return out;
  }
}

function secretKey(key: string): string { return `plugin_${key}_secret`; }

registerScopedService(LifecycleScope.App, IPluginSettingsService, PluginSettingsService, ScopeActivation.OnScopeCreated, 'plugin');
