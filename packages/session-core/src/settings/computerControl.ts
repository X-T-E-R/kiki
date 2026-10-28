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

export type ComputerControlVerdictKind =
  | 'unresolved'
  | 'host_locked'
  | 'off'
  | 'tool_denied'
  | 'checking'
  | 'unknown'
  | 'unsupported'
  | 'installing'
  | 'not_installed'
  | 'partial'
  | 'no_connection'
  | 'connection_not_ready'
  | 'ready';

export type ComputerControlVerdictExecutor =
  | 'checking'
  | 'unknown'
  | 'external'
  | { readonly state: 'not_installed' | 'partial' | 'ready' | 'unsupported'; readonly installing: boolean };

export interface ComputerControlVerdictInput {
  readonly enabled: boolean;
  readonly hostLocked?: boolean;
  readonly unresolved?: boolean;
  readonly toolPolicyDenied: boolean;
  /** The executor capability as last read; `checking` before the first answer, `unknown` when the read failed, `external` when the active connection uses an external executor (such as Windows-MCP) rather than the bundled CUA capability. */
  readonly executor: ComputerControlVerdictExecutor;
  /** Whether a computer connection would be used: an explicit choice, or a configured default CUA entry. */
  readonly hasConnection: boolean;
  /** False when the active connection is missing, disabled, not a computer MCP config, or not startable (e.g. Windows-MCP not serve-ready). */
  readonly activeConnectionReady: boolean;
}

export interface ComputerControlVerdict {
  readonly kind: ComputerControlVerdictKind;
  readonly tone: 'ok' | 'attention' | 'off' | 'unknown';
}

const COMPUTER_VERDICT_TONE: Readonly<Record<ComputerControlVerdictKind, ComputerControlVerdict['tone']>> = {
  unresolved: 'unknown',
  host_locked: 'off',
  off: 'off',
  tool_denied: 'attention',
  checking: 'unknown',
  unknown: 'unknown',
  unsupported: 'attention',
  installing: 'unknown',
  not_installed: 'attention',
  partial: 'attention',
  no_connection: 'attention',
  connection_not_ready: 'attention',
  ready: 'ok',
};

/**
 * The lead sentence of the computer settings page. "Ready" means the switch is
 * on, a startable connection is selected, and its required executor is ready —
 * it is not a claim that the desktop is reachable or being controlled.
 */
export function computerControlVerdict(input: ComputerControlVerdictInput): ComputerControlVerdict {
  const kind = ((): ComputerControlVerdictKind => {
    if (input.unresolved === true) return 'unresolved';
    if (!input.enabled) return input.hostLocked === true ? 'host_locked' : 'off';
    if (input.toolPolicyDenied) return 'tool_denied';
    if (input.executor === 'checking' || input.executor === 'unknown') return input.executor;
    if (input.executor !== 'external') {
      if (input.executor.installing) return 'installing';
      if (input.executor.state === 'unsupported') return 'unsupported';
      if (input.executor.state === 'not_installed') return 'not_installed';
      if (input.executor.state === 'partial') return 'partial';
    }
    if (!input.hasConnection) return 'no_connection';
    if (!input.activeConnectionReady) return 'connection_not_ready';
    return 'ready';
  })();
  return { kind, tone: COMPUTER_VERDICT_TONE[kind] };
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
