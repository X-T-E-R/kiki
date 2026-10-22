import type { KikiConfigPatch } from '../transport';

export interface BrowserControlState {
  enabled: boolean;
  allowedBrowserIds: string[];
}

export function isBrowserControlEnabled(config: unknown): boolean {
  if (config === null || typeof config !== 'object') return true;
  const c = config as Record<string, unknown>;
  const bc = c['browser_control'] as { enabled?: boolean } | undefined;
  if (typeof bc?.enabled === 'boolean') {
    return bc.enabled;
  }
  const exp = c['experimental'] as Record<string, boolean> | undefined;
  if (typeof exp?.['native_browser'] === 'boolean') {
    return exp['native_browser'];
  }
  return true;
}

export function browserControlEnabledPatch(enabled: boolean | null): KikiConfigPatch {
  return {
    browser_control: { enabled },
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

export function isBrowserToolPolicyDenied(config: unknown): boolean {
  const disabled = extractDisabledToolNames(config);
  if (disabled.includes('browser') || disabled.includes('browser__*')) {
    return true;
  }
  return disabled.includes('BrowserConnections') && disabled.includes('BrowserTabs');
}

export function isBrowserToolPolicyPartiallyDenied(config: unknown): boolean {
  if (isBrowserToolPolicyDenied(config)) return false;
  const disabled = extractDisabledToolNames(config);
  return disabled.includes('BrowserConnections') || disabled.includes('BrowserTabs');
}

export type BrowserSourceId = 'kimi-webbridge' | 'independent-browser' | 'codex-browser' | 'ego-lite';

export function browserSourceOfConnectionType(type?: string, id?: string): BrowserSourceId | undefined {
  if (type === 'ego-lite') return 'ego-lite';
  if (type === 'codex-extension') return 'codex-browser';
  if (type === 'webbridge-command') return 'kimi-webbridge';
  if (type === 'agent-browser-profile' || type === 'agent-browser-cdp') return 'independent-browser';
  if (id === 'kimi-webbridge') return 'kimi-webbridge';
  return undefined;
}

export function isBrowserConnectionEffectiveAllowed(
  connection: { id: string; enabled?: boolean; type?: string },
  allowedBrowsersConfigured: boolean,
  allowedBrowsers: readonly string[] | undefined,
  disabledSources?: readonly string[],
): boolean {
  if (connection.enabled === false) return false;
  const source = browserSourceOfConnectionType(connection.type, connection.id);
  if (source !== undefined && disabledSources?.includes(source) === true) return false;
  if (!allowedBrowsersConfigured || allowedBrowsers === undefined) return true;
  return allowedBrowsers.includes(connection.id);
}

export function effectiveAllowedBrowserCount(
  connections: readonly { id: string; enabled?: boolean; type?: string }[],
  allowedBrowsersConfigured: boolean,
  allowedBrowsers: readonly string[] | undefined,
  disabledSources?: readonly string[],
): number {
  return connections.filter((c) => isBrowserConnectionEffectiveAllowed(c, allowedBrowsersConfigured, allowedBrowsers, disabledSources)).length;
}
