import type { ComputerUsagePreference, ConfigResponse, PatchConfigRequest } from '@kiki/protocol';
import type { KikiConfigPatch } from '../transport';

export const DEFAULT_COMPUTER_USAGE_PREFERENCE: ComputerUsagePreference = 'avoid';

export function computerControlPreference(config: Pick<ConfigResponse, 'computer_control'>): ComputerUsagePreference {
  return config.computer_control?.usagePreference ?? DEFAULT_COMPUTER_USAGE_PREFERENCE;
}

export function computerControlPreferencePatch(preference: ComputerUsagePreference | null): Pick<PatchConfigRequest, 'computer_control'> {
  return { computer_control: { usage_preference: preference } };
}

export function isComputerControlEnabled(config: unknown): boolean {
  if (config === null || typeof config !== 'object') return true;
  const c = config as Record<string, unknown>;
  const cc = c['computer_control'] as { enabled?: boolean } | undefined;
  if (typeof cc?.enabled === 'boolean') {
    return cc.enabled;
  }
  return true;
}

export function computerControlEnabledPatch(enabled: boolean | null): KikiConfigPatch {
  return {
    computer_control: { enabled },
  };
}

function extractDisabledToolNames(config: unknown): string[] {
  if (config === null || typeof config !== 'object') return [];
  const c = config as Record<string, unknown>;
  const tools = c['tools'] as { disabled?: unknown; disallowed_tools?: unknown } | undefined;
  const names = new Set<string>();
  if (Array.isArray(tools?.disabled)) {
    for (const item of tools.disabled) {
      if (typeof item === 'string') names.add(item);
    }
  }
  if (Array.isArray(tools?.disallowed_tools)) {
    for (const item of tools.disallowed_tools) {
      if (typeof item === 'string') names.add(item);
    }
  }
  return [...names];
}

export function isComputerToolPolicyDenied(config: unknown): boolean {
  const disabled = extractDisabledToolNames(config);
  return disabled.some((name) => name === 'mcp__kiki-computer__*' || name === 'kiki-computer' || name === 'ComputerControl');
}

export function isComputerToolPolicyPartiallyDenied(config: unknown): boolean {
  if (isComputerToolPolicyDenied(config)) return false;
  const disabled = extractDisabledToolNames(config);
  return disabled.some((name) => name.startsWith('mcp__kiki-computer__') || name.startsWith('ComputerControl__') || name === 'mcp__kiki-computer');
}
