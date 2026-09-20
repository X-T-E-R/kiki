import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const EXTRA_AGENT_DIRS_SECTION = 'extraAgentDirs';
export const ExtraAgentDirsConfigSchema = z.array(z.string()).optional();
export type ExtraAgentDirsConfig = z.infer<typeof ExtraAgentDirsConfigSchema>;

registerConfigSection(EXTRA_AGENT_DIRS_SECTION, ExtraAgentDirsConfigSchema, {
  defaultValue: [],
});

export const SKIP_BUILTIN_PROFILE_INSTALLATION_SECTION = 'skipBuiltinProfileInstallation';
export const SkipBuiltinProfileInstallationConfigSchema = z.array(z.string()).optional();
export type SkipBuiltinProfileInstallationConfig = z.infer<typeof SkipBuiltinProfileInstallationConfigSchema>;

registerConfigSection(SKIP_BUILTIN_PROFILE_INSTALLATION_SECTION, SkipBuiltinProfileInstallationConfigSchema);

export const DISABLED_NAMED_PROFILES_SECTION = 'disabledNamedProfiles';
export const DisabledNamedProfilesConfigSchema = z.array(z.string()).optional();
export type DisabledNamedProfilesConfig = z.infer<
  typeof DisabledNamedProfilesConfigSchema
>;

registerConfigSection(DISABLED_NAMED_PROFILES_SECTION, DisabledNamedProfilesConfigSchema, {
  defaultValue: [],
});
