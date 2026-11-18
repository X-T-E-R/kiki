import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const PLUGIN_SETTINGS_SECTION = 'pluginSettings';
export const PluginSettingsSectionSchema = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
);

export function readSanitizedPluginSettings(
  raw: unknown,
): Record<string, Record<string, string | number | boolean>> {
  const parsed = PluginSettingsSectionSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, string | number | boolean>> = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) continue;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const clean: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        clean[key] = value;
      }
    }
    out[id] = clean;
  }
  return out;
}

registerConfigSection(PLUGIN_SETTINGS_SECTION, PluginSettingsSectionSchema, {
  defaultValue: {},
  fromToml: (value) => value,
  toToml: (value) => value,
});
