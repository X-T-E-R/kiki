import type { ComputerUsagePreference, ConfigResponse, PatchConfigRequest } from '@kiki/protocol';

export const DEFAULT_COMPUTER_USAGE_PREFERENCE: ComputerUsagePreference = 'avoid';

export function computerControlPreference(config: Pick<ConfigResponse, 'computer_control'>): ComputerUsagePreference {
  return config.computer_control?.usagePreference ?? DEFAULT_COMPUTER_USAGE_PREFERENCE;
}

export function computerControlPreferencePatch(preference: ComputerUsagePreference | null): Pick<PatchConfigRequest, 'computer_control'> {
  return { computer_control: { usage_preference: preference } };
}
