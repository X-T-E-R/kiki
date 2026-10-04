import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const PLUGIN_SETTINGS_SECTION = 'pluginSettings';
export const PluginSettingsSectionSchema = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
);

registerConfigSection(PLUGIN_SETTINGS_SECTION, PluginSettingsSectionSchema, {
  defaultValue: {},
  fromToml: (value) => value,
  toToml: (value) => value,
});
