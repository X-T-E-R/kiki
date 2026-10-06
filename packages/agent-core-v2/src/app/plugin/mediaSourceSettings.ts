import { mediaScriptSourcesSchema, type MediaScriptSource, type MediaProviderDefinition } from '@kiki/protocol';
import type { PluginExtension, PluginMediaSourceGroup, PluginSettings } from './contributions';

export type MediaSettingValues = Record<string, string | number | boolean>;
const lifecycle = new Set(['enabled', 'removed', 'cleared']);
export function scriptSources(settings: MediaSettingValues): MediaScriptSource[] {
  return mediaScriptSourcesSchema.parse(JSON.parse(String(settings['scriptSources'] ?? '[]')));
}
export function scriptEnvironmentKey(id: string): string { return `script_${id}__environment`; }
export function sourceSchema(extension: PluginExtension, group: PluginMediaSourceGroup): PluginSettings {
  return { schemaVersion: 1, schema: { type: 'object', properties: Object.fromEntries(Object.entries(extension.settings?.schema.properties ?? {}).filter(([key]) => key.startsWith(group.settingsPrefix) && !lifecycle.has(key.slice(group.settingsPrefix.length))).map(([key, value]) => [key.slice(group.settingsPrefix.length), value])), required: group.required } };
}
export function sourceValues(settings: MediaSettingValues, group: PluginMediaSourceGroup, legacy: MediaSettingValues = {}): MediaSettingValues {
  const cleared = new Set<string>(JSON.parse(String(settings[group.settingsPrefix + 'cleared'] ?? '[]')));
  const values = { ...legacy };
  for (const key of cleared) delete values[key];
  for (const [key, value] of Object.entries(settings)) if (key.startsWith(group.settingsPrefix) && !lifecycle.has(key.slice(group.settingsPrefix.length))) values[key.slice(group.settingsPrefix.length)] = value;
  return values;
}
export function sourceActive(settings: MediaSettingValues, group: PluginMediaSourceGroup): boolean {
  return settings[group.settingsPrefix + 'enabled'] !== false && settings[group.settingsPrefix + 'removed'] !== true;
}
export function sourceDefaults(schema: PluginSettings, values: MediaSettingValues): MediaSettingValues {
  return { ...Object.fromEntries(Object.entries(schema.schema.properties).filter(([, property]) => property.default !== undefined).map(([key, property]) => [key, property.default!])), ...values };
}
export function scriptDefinition(source: MediaScriptSource, resumeVersion: number): MediaProviderDefinition {
  return { schemaVersion: 1, id: `script-${source.id}`, label: source.label, kinds: source.kinds, resumeVersion };
}
export const scriptSettingsSchema: PluginSettings = { schemaVersion: 1, schema: { type: 'object', properties: { environment: { type: 'string', title: 'Environment variables (JSON)', secret: true } } } };
