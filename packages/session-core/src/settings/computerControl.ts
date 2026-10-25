import { CUA_COMPUTER_CONNECTION, type ComputerUsagePreference, type ConfigResponse, type PatchConfigRequest } from '@kiki/protocol';
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

export function computerControlConnection(config: Pick<ConfigResponse, 'computer_control'>): string | undefined {
  const value = config.computer_control?.connection;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function computerControlConnectionPatch(connection: string | null): Pick<PatchConfigRequest, 'computer_control'> {
  return { computer_control: { connection } };
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

export function isComputerToolPolicyDenied(config: unknown, connection?: string | null): boolean {
  const disabled = extractDisabledToolNames(config);
  if (connection === undefined) {
    return disabled.some((name) => name === 'mcp__kiki-computer__*' || name === 'kiki-computer' || name === 'ComputerControl');
  }
  const server = connection === null || connection.trim() === '' ? CUA_COMPUTER_CONNECTION : connection.trim();
  return disabled.some((name) => name === 'ComputerControl' || name === server || name === `mcp__${server}__*`);
}

export function isComputerToolPolicyPartiallyDenied(config: unknown, connection?: string | null): boolean {
  if (isComputerToolPolicyDenied(config, connection)) return false;
  const disabled = extractDisabledToolNames(config);
  if (connection === undefined) {
    return disabled.some((name) => name.startsWith('mcp__kiki-computer__') || name.startsWith('ComputerControl__') || name === 'mcp__kiki-computer');
  }
  const server = connection === null || connection.trim() === '' ? CUA_COMPUTER_CONNECTION : connection.trim();
  const prefix = `mcp__${server}__`;
  return disabled.some((name) => name.startsWith(prefix) || name === `mcp__${server}`);
}
