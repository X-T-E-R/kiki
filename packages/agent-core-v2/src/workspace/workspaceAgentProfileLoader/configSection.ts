import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

/** `workspaceAgentProfileLoader` domain — agent-file config sections. Registers the top-level
 *  `extraAgentDirs` (additional directories scanned for agent Markdown files),
 *  `disabledBuiltinProfiles` (builtin profile names omitted from session catalogs), and
 *  `disabledNamedProfiles` (file-backed profile names omitted from session catalogs) domains; values
 *  stay camelCase in memory while TOML uses snake_case keys. */
export const EXTRA_AGENT_DIRS_SECTION = 'extraAgentDirs';
export const ExtraAgentDirsConfigSchema = z.array(z.string()).optional();
export type ExtraAgentDirsConfig = z.infer<typeof ExtraAgentDirsConfigSchema>;

registerConfigSection(EXTRA_AGENT_DIRS_SECTION, ExtraAgentDirsConfigSchema, {
  defaultValue: [],
});

export const DISABLED_BUILTIN_PROFILES_SECTION = 'disabledBuiltinProfiles';
export const DisabledBuiltinProfilesConfigSchema = z.array(z.string()).optional();
export type DisabledBuiltinProfilesConfig = z.infer<
  typeof DisabledBuiltinProfilesConfigSchema
>;

registerConfigSection(DISABLED_BUILTIN_PROFILES_SECTION, DisabledBuiltinProfilesConfigSchema, {
  defaultValue: [],
});

export const DISABLED_NAMED_PROFILES_SECTION = 'disabledNamedProfiles';
export const DisabledNamedProfilesConfigSchema = z.array(z.string()).optional();
export type DisabledNamedProfilesConfig = z.infer<
  typeof DisabledNamedProfilesConfigSchema
>;

registerConfigSection(DISABLED_NAMED_PROFILES_SECTION, DisabledNamedProfilesConfigSchema, {
  defaultValue: [],
});
