import { z } from 'zod';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

import { KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV } from './marketplace';

export const PLUGINS_SECTION = 'plugins';

export const PluginsSectionSchema = z.object({
  marketplaceUrl: z.string().trim().optional(),
});

export type PluginsSection = z.infer<typeof PluginsSectionSchema>;

export const pluginsEnvBindings: EnvBindings<PluginsSection> = envBindings(PluginsSectionSchema, {
  marketplaceUrl: KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV,
});

export const stripPluginsEnv = stripEnvBoundFields(pluginsEnvBindings);

registerConfigSection(PLUGINS_SECTION, PluginsSectionSchema, {
  defaultValue: {},
  env: pluginsEnvBindings,
  stripEnv: stripPluginsEnv,
});
