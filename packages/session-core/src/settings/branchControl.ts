import type { BranchUsagePreference, ConfigResponse } from '@kiki/protocol';
import type { KikiConfigPatch } from '../transport';

export const DEFAULT_BRANCH_USAGE_PREFERENCE: BranchUsagePreference = 'balanced';

export function branchUsagePreference(config: Pick<ConfigResponse, 'branch'> | undefined): BranchUsagePreference {
  return config?.branch?.usagePreference ?? DEFAULT_BRANCH_USAGE_PREFERENCE;
}

export function branchUsagePreferencePatch(preference: BranchUsagePreference | null): KikiConfigPatch {
  return { branch: { usage_preference: preference } };
}

export function isBranchEnabled(config: Pick<ConfigResponse, 'branch'> | undefined): boolean {
  return config?.branch?.enabled ?? true;
}

export function branchAllowPatch(enabled: boolean | null): KikiConfigPatch {
  return { branch: { enabled } };
}
