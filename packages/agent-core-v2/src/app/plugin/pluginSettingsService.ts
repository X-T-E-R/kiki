import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';

import { IPluginService } from './plugin';
import { currentPluginId } from './renamedPlugins';
import { scriptSources, scriptEnvironmentKey } from './mediaSourceSettings';
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
    const extension = id === builtinHistory.id ? { settings: builtinHistory.settings } : (await this.plugins.getPluginInfo({ id })).manifest?.kiki;
    if (extension?.settings === undefined) return extension;
    if (extension.mediaSources === undefined && extension.mediaProviders === undefined && extension.mediaScriptProvider === undefined) {
      return extension;
    }
    const properties = enrichMediaProperties(extension, extension.settings.schema.properties);
    if (extension.mediaScriptProvider !== undefined) {
      const stored = await this.stored(id);
      const sources = scriptSources(stored);
      for (const source of sources) {
        properties[scriptEnvironmentKey(source.id)] = {
          type: 'string',
          secret: true,
          title: 'Script environment',
          localizations: { zh: { title: '脚本环境变量' } },
        };
      }
    }
    return { ...extension, settings: { ...extension.settings, schema: { ...extension.settings.schema, properties } } };
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
    if (extension?.mediaScriptProvider !== undefined) scriptSources(updated);
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

type PropertyMap = PluginSettings['schema']['properties'];
type Property = PropertyMap[string];

const MEDIA_GROUP_ZH: Readonly<Record<string, string>> = {
  openai: 'OpenAI 媒体',
  google: 'Google 媒体',
  ark: 'Ark 媒体',
  xai: 'xAI 媒体',
  minimax: 'MiniMax 媒体',
  stepfun: '阶跃星辰语音',
  novita: 'Novita 兼容视频',
  agnes: 'Agnes 视频',
  newapi: 'NewAPI 兼容视频',
  comfyui: 'ComfyUI 工作流',
};

const MEDIA_TITLE_ZH: Readonly<Record<string, string>> = {
  'Default image provider': '默认图像来源',
  'Default video provider': '默认视频来源',
  'Default speech provider': '默认语音来源',
  'Default TTS provider': '默认语音来源',
  'Connection ID': 'Kiki 连接（可选）',
  'Kiki connection (optional)': 'Kiki 连接（可选）',
  'Kiki Google connection (optional)': 'Kiki Google 连接（可选）',
  'Kiki Ark connection (optional)': 'Kiki Ark 连接（可选）',
  'Kiki xAI API connection (optional)': 'Kiki xAI API 连接（可选）',
  'Kiki MiniMax connection (optional)': 'Kiki MiniMax 连接（可选）',
  'Kiki StepFun connection (optional)': 'Kiki StepFun 连接（可选）',
  'Kiki compatible endpoint connection (optional)': 'Kiki 兼容端点连接（可选）',
  'Kiki Agnes endpoint connection (optional)': 'Kiki Agnes 端点连接（可选）',
  'Kiki gateway connection (optional)': 'Kiki 网关连接（可选）',
  'Kiki ComfyUI endpoint connection (optional)': 'Kiki ComfyUI 端点连接（可选）',
  'API key': 'API 密钥',
  'Endpoint API key': '端点 API 密钥',
  'Gateway API key': '网关 API 密钥',
  'Optional endpoint API key': '可选端点 API 密钥',
  'API base URL': 'API 基础地址',
  'Ark API base URL': 'Ark API 基础地址',
  'API base URL (no /v1 or /v2 suffix)': 'API 基础地址（不带 /v1 或 /v2 后缀）',
  'Compatible API base URL': '兼容 API 基础地址',
  'Your ComfyUI endpoint': '你的 ComfyUI 端点',
  'Default image model': '默认图像模型',
  'Default video model': '默认视频模型',
  'Default speech model': '默认语音模型',
  'Default Veo model': '默认 Veo 模型',
  'Default Seedream model': '默认 Seedream 模型',
  'Seedance 2.0 model or endpoint ID': 'Seedance 2.0 模型或端点 ID',
  'Actual endpoint model': '实际端点模型',
  'Actual gateway model': '实际网关模型',
  'Custom media scripts': '自定义媒体脚本',
  'Custom script sources (JSON)': '自定义媒体脚本',
};

function mergeZhLocalization(
  existing: Property['localizations'],
  fallback: { title?: string; groupTitle?: string },
): Property['localizations'] {
  const currentZh = existing?.['zh'];
  const nextTitle = currentZh?.title ?? fallback.title;
  const nextGroup = currentZh?.groupTitle ?? fallback.groupTitle;
  const nextDesc = currentZh?.description;
  if (nextTitle === undefined && nextGroup === undefined && nextDesc === undefined) return existing;
  return {
    ...existing,
    zh: {
      title: nextTitle,
      description: nextDesc,
      groupTitle: nextGroup,
    },
  };
}

function enrichMediaProperties(extension: PluginExtension, raw: PropertyMap): Record<string, Property> {
  const properties: Record<string, Property> = { ...raw };
  if (extension.mediaProviders !== undefined) {
    const defaults: ReadonlyArray<readonly [string, 'image' | 'video' | 'tts', string]> = [
      ['defaultImageProvider', 'image', '默认图像来源'],
      ['defaultVideoProvider', 'video', '默认视频来源'],
      ['defaultTtsProvider', 'tts', '默认语音来源'],
    ];
    for (const [key, kind, zhTitle] of defaults) {
      const prop = properties[key];
      if (prop?.type !== 'string') continue;
      const choices = extension.mediaProviders
        .filter((item) => (Array.isArray(item.kinds) && item.kinds.includes(kind)) || (item as { kind?: string }).kind === kind)
        .map((item) => item.id);
      properties[key] = {
        ...prop,
        enum: prop.enum ?? (choices.length > 0 ? choices : undefined),
        localizations: mergeZhLocalization(prop.localizations, { title: zhTitle }),
      };
    }
  }
  for (const group of extension.mediaSources ?? []) {
    const zhGroup = MEDIA_GROUP_ZH[group.id];
    for (const [key, prop] of Object.entries(properties)) {
      if (!key.startsWith(group.settingsPrefix)) continue;
      const suffix = key.slice(group.settingsPrefix.length);
      const isHiddenLifecycle = suffix === 'removed' || suffix === 'cleared';
      const defaultTitle = suffix === 'enabled' ? 'Enabled' : suffix === 'removed' ? 'Removed' : prop.title;
      const zhTitle = suffix === 'enabled'
        ? '启用'
        : suffix === 'removed'
          ? '已移除'
          : (defaultTitle === undefined ? undefined : MEDIA_TITLE_ZH[defaultTitle]);
      properties[key] = {
        ...prop,
        title: prop.title ?? defaultTitle,
        hidden: prop.hidden ?? (isHiddenLifecycle ? true : undefined),
        group: prop.group ?? group.id,
        groupTitle: prop.groupTitle ?? group.label,
        localizations: mergeZhLocalization(prop.localizations, { title: zhTitle, groupTitle: zhGroup }),
      };
    }
  }
  if (properties['scriptSources'] !== undefined) {
    const prop = properties['scriptSources'];
    properties['scriptSources'] = {
      ...prop,
      multiline: prop.multiline ?? true,
      advanced: prop.advanced ?? true,
      localizations: mergeZhLocalization(prop.localizations, {
        title: prop.title === undefined ? undefined : MEDIA_TITLE_ZH[prop.title],
      }),
    };
  }
  return properties;
}

registerScopedService(LifecycleScope.App, IPluginSettingsService, PluginSettingsService, ScopeActivation.OnScopeCreated, 'plugin');
