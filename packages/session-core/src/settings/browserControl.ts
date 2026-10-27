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

/**
 * The source whose switch governs a saved connection, in the server's own order
 * (`agent-core-v2/src/app/browser/browserConfig.ts` `browserSourceOfConnection`):
 * Ego Lite and Codex are routes of their own, the Kimi bridge owns the public
 * `kimi-webbridge` type and the legacy preset id, and every other profile or CDP
 * connection belongs to the independent browser.
 *
 * The order is the point. A record still stored as `agent-browser-cdp` under
 * that exact id runs over the bridge, so classifying it by type first would let
 * this page count it allowed while the server refuses it. A type this page
 * cannot name stays unattributed instead of being folded into another source.
 */
export function browserSourceOfConnectionType(type?: string, id?: string): BrowserSourceId | undefined {
  if (type === 'ego-lite') return 'ego-lite';
  if (type === 'codex-extension') return 'codex-browser';
  if (type === 'kimi-webbridge' || type === 'webbridge-command' || id === 'kimi-webbridge') return 'kimi-webbridge';
  if (type === 'agent-browser-profile' || type === 'agent-browser-cdp') return 'independent-browser';
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

/** How a settings verdict reads at a glance; `unknown` is never drawn as success. */
export type ControlVerdictTone = 'ok' | 'attention' | 'off' | 'unknown';

export type BrowserControlVerdictKind =
  | 'unresolved'
  | 'host_locked'
  | 'off'
  | 'tool_denied'
  | 'unknown'
  | 'no_connections'
  | 'none_allowed'
  | 'default_not_allowed'
  | 'allowed';

export interface BrowserControlVerdictInput {
  readonly enabled: boolean;
  readonly hostLocked?: boolean;
  readonly unresolved?: boolean;
  readonly toolPolicyDenied: boolean;
  /** `undefined` while the connection list has not been read (loading or failed). */
  readonly connections: readonly { id: string; enabled?: boolean; type?: string }[] | undefined;
  readonly allowedBrowsersConfigured: boolean;
  readonly allowedBrowsers?: readonly string[];
  readonly disabledSources?: readonly string[];
  readonly defaultBrowser?: string;
}

export interface BrowserControlVerdict {
  readonly kind: BrowserControlVerdictKind;
  readonly tone: ControlVerdictTone;
  /** Connections the configuration allows. Allowed is not connected, and not a successful call. */
  readonly allowedCount: number;
  /** The default connection id when one is set. */
  readonly defaultBrowser?: string;
}

const BROWSER_VERDICT_TONE: Readonly<Record<BrowserControlVerdictKind, ControlVerdictTone>> = {
  unresolved: 'unknown',
  host_locked: 'off',
  off: 'off',
  tool_denied: 'attention',
  unknown: 'unknown',
  no_connections: 'attention',
  none_allowed: 'attention',
  default_not_allowed: 'attention',
  allowed: 'ok',
};

/**
 * The one sentence the browser settings page leads with: whether the
 * configuration lets the Agent reach any browser at all, and the first gate to
 * fix when it does not. It speaks about configuration only — a connection's own
 * runtime state (failed, not connected, unconfirmed) stays on that connection's
 * row, so one broken browser never marks the others unusable.
 */
export function browserControlVerdict(input: BrowserControlVerdictInput): BrowserControlVerdict {
  const connections = input.connections ?? [];
  const allowedCount = effectiveAllowedBrowserCount(connections, input.allowedBrowsersConfigured, input.allowedBrowsers, input.disabledSources);
  const defaultBrowser = input.defaultBrowser === undefined || input.defaultBrowser === '' ? undefined : input.defaultBrowser;
  const kind = ((): BrowserControlVerdictKind => {
    if (input.unresolved === true) return 'unresolved';
    if (!input.enabled) return input.hostLocked === true ? 'host_locked' : 'off';
    if (input.toolPolicyDenied) return 'tool_denied';
    if (input.connections === undefined) return 'unknown';
    if (connections.length === 0) return 'no_connections';
    if (allowedCount === 0) return 'none_allowed';
    if (defaultBrowser !== undefined) {
      const row = connections.find((connection) => connection.id === defaultBrowser);
      if (row === undefined || !isBrowserConnectionEffectiveAllowed(row, input.allowedBrowsersConfigured, input.allowedBrowsers, input.disabledSources)) {
        return 'default_not_allowed';
      }
    }
    return 'allowed';
  })();
  return { kind, tone: BROWSER_VERDICT_TONE[kind], allowedCount, defaultBrowser };
}
