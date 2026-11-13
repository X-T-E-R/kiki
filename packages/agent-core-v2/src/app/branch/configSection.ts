import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

/** The `[branch]` configuration section owned by the `branch` domain. */
export const BRANCH_CONFIG_SECTION = 'branch';

export const BranchUsagePreferenceSchema = z.enum(['conservative', 'balanced', 'proactive']);
export type BranchUsagePreference = z.infer<typeof BranchUsagePreferenceSchema>;
export const DEFAULT_BRANCH_USAGE_PREFERENCE: BranchUsagePreference = 'balanced';

export const BRANCH_ENABLED_ENV = 'KIKI_BRANCH_ENABLED';

export const BranchConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    usagePreference: BranchUsagePreferenceSchema.default(DEFAULT_BRANCH_USAGE_PREFERENCE),
  })
  .strict();

export type BranchConfig = z.infer<typeof BranchConfigSchema>;

export const branchEnvBindings: EnvBindings<BranchConfig> = envBindings(BranchConfigSchema, {
  enabled: {
    env: BRANCH_ENABLED_ENV,
    parse: parseBooleanEnv,
  },
});

export const stripBranchEnv = stripEnvBoundFields(branchEnvBindings);

registerConfigSection(BRANCH_CONFIG_SECTION, BranchConfigSchema, {
  defaultValue: {
    enabled: true,
    usagePreference: DEFAULT_BRANCH_USAGE_PREFERENCE,
  },
  env: branchEnvBindings,
  stripEnv: stripBranchEnv,
});
