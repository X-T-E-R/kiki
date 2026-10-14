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

export function isBrowserConnectionEffectiveAllowed(
  connection: { id: string; enabled?: boolean },
  allowedBrowsersConfigured: boolean,
  allowedBrowsers: readonly string[] | undefined,
): boolean {
  if (connection.enabled === false) return false;
  if (!allowedBrowsersConfigured || allowedBrowsers === undefined) return true;
  return allowedBrowsers.includes(connection.id);
}

export function effectiveAllowedBrowserCount(
  connections: readonly { id: string; enabled?: boolean }[],
  allowedBrowsersConfigured: boolean,
  allowedBrowsers: readonly string[] | undefined,
): number {
  return connections.filter((c) => isBrowserConnectionEffectiveAllowed(c, allowedBrowsersConfigured, allowedBrowsers)).length;
}
