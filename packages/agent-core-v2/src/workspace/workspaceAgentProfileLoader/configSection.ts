import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

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

export const SKIP_BUILTIN_PROFILE_INSTALLATION_SECTION = 'skipBuiltinProfileInstallation';
export const SkipBuiltinProfileInstallationConfigSchema = z.array(z.string()).optional();
export type SkipBuiltinProfileInstallationConfig = z.infer<typeof SkipBuiltinProfileInstallationConfigSchema>;

registerConfigSection(SKIP_BUILTIN_PROFILE_INSTALLATION_SECTION, SkipBuiltinProfileInstallationConfigSchema);

registerConfigSection(DISABLED_BUILTIN_PROFILES_SECTION, DisabledBuiltinProfilesConfigSchema, {
  defaultValue: [],
  collectDiagnostics: (rawSection) => rawSection === undefined ? [] : [{
    domain: DISABLED_BUILTIN_PROFILES_SECTION,
    severity: 'warning',
    message: 'disabled_builtin_profiles is deprecated; rename it to skip_builtin_profile_installation. It only skips installation of unmanaged builtin copies, not runtime loading. The new key takes precedence. Use disabled_named_profiles to hide installed profiles.',
  }],
});

export const DISABLED_NAMED_PROFILES_SECTION = 'disabledNamedProfiles';
export const DisabledNamedProfilesConfigSchema = z.array(z.string()).optional();
export type DisabledNamedProfilesConfig = z.infer<
  typeof DisabledNamedProfilesConfigSchema
>;

registerConfigSection(DISABLED_NAMED_PROFILES_SECTION, DisabledNamedProfilesConfigSchema, {
  defaultValue: [],
});
