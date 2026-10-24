import type { SettingsTransferCategory, SettingsTransferMode, SettingsTransferNotice } from '@kiki/protocol';
import { isPlainObject, deepEqual } from '#/app/config/configPure';
import { splitConfigCredentials } from '#/app/config/credentials';

export const TRANSFER_DOMAINS: Readonly<Record<SettingsTransferCategory, readonly string[]>> = {
  models: ['providers', 'models', 'defaultModel', 'defaultProvider', 'thinking', 'fastModel', 'modelSwitch', 'requestIdentity', 'requestCompression', 'responsesWebSocket', 'requestGovernance', 'image', 'tokenCounting'],
  agents: ['agents', 'subagent', 'prompt', 'disabledNamedProfiles', 'skipBuiltinProfileInstallation', 'agentExecutors', 'agentExecutorOverrides', 'agentExecutorDisplay', 'builtinProductSkills', 'mergeAllAvailableSkills', 'memory', 'bot', 'recipes'],
  permissions: ['permission', 'defaultPermissionMode', 'defaultPlanMode', 'plan', 'loopControl', 'retry', 'interaction', 'task', 'background', 'sessionTitle', 'sessionResidency', 'threadCommunication', 'worktree', 'hooks', 'workspaceInstance', 'taskBoard', 'experimental'],
  tools: ['tools', 'mcp', 'plugins', 'pluginSettings', 'nbSearch', 'nbSearchSource', 'optionalCapabilities'],
  browser: ['browserControl', 'computerControl'],
  notifications: ['notifications'],
  appearance: ['spaceUi', 'identity'],
};

export function categoryForDomain(domain: string): SettingsTransferCategory | undefined {
  return (Object.keys(TRANSFER_DOMAINS) as SettingsTransferCategory[]).find((category) => TRANSFER_DOMAINS[category].includes(domain));
}

export function categoryForUnit(path: readonly string[]): SettingsTransferCategory | undefined {
  if (path[0] !== 'experimental') return categoryForDomain(path[0]!);
  const flag = path[1];
  if (flag === 'native_browser') return 'browser';
  if (flag === 'image_format_conversion') return 'models';
  if (['agent-profile-routes', 'subagent_release_idle', 'local_session_resume', 'external_delegation_mcp'].includes(flag ?? '')) return 'agents';
  if (['tool-select', 'task_wait', 'plugin_app_lifecycle', 'plugin_workspace_usage', 'native_ssh'].includes(flag ?? '')) return 'tools';
  return 'permissions';
}

export interface TransferUnit {
  readonly path: readonly string[];
  readonly value: unknown;
}

const entityPaths = new Set(['providers', 'models', 'browserControl/connections', 'notifications/provider_instances', 'notifications/channels', 'notifications/credential_slots', 'notifications/credential_values']);

export function configUnits(domain: string, value: unknown): TransferUnit[] {
  const units: TransferUnit[] = [];
  const walk = (entry: unknown, path: readonly string[]): void => {
    if (isPlainObject(entry) && Object.keys(entry).length > 0) {
      for (const [key, child] of Object.entries(entry)) {
        const nextPath = [...path, key];
        if (entityPaths.has(path.join('/'))) units.push({ path: nextPath, value: child });
        else walk(child, nextPath);
      }
    } else {
      units.push({ path, value: entry });
    }
  };
  walk(value, [domain]);
  return units;
}

export function atPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const key of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

export function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = root;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[path.at(-1)!] = structuredClone(value);
}

export function mergeSelected(current: unknown, incoming: unknown, mode: SettingsTransferMode): unknown {
  if (!isPlainObject(incoming) || !isPlainObject(current)) return mode === 'append' && current !== undefined ? current : incoming;
  const next = { ...current };
  for (const [key, value] of Object.entries(incoming)) next[key] = mergeSelected(current[key], value, mode);
  return next;
}

export function classifyUnit(current: unknown, incoming: unknown): 'added' | 'conflicts' | 'unchanged' {
  return current === undefined ? 'added' : deepEqual(current, incoming) ? 'unchanged' : 'conflicts';
}

export function portableValue(value: unknown, credentials: boolean): unknown {
  const publicPart = splitConfigCredentials({ value }).config['value'];
  const walk = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(walk);
    if (!isPlainObject(entry)) return entry;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(entry)) {
      if (key === 'oauth' || key === 'source') continue;
      if (!credentials && (['env', 'headers', 'customHeaders', 'credential_values'].includes(key) || unsafeUrl(child))) continue;
      out[key] = walk(child);
    }
    return out;
  };
  return walk(credentials ? value : publicPart);
}

export function projectConfig(domain: string, value: unknown, credentials: boolean, notices: Set<SettingsTransferNotice>): unknown {
  let result = portableValue(value, credentials);
  if (!isPlainObject(result)) return result;
  result = structuredClone(result);
  const record = result as Record<string, unknown>;
  if (domain === 'browserControl' && isPlainObject(record['connections'])) {
    const connections = record['connections'];
    for (const [id, entry] of Object.entries(connections)) {
      if (!isPlainObject(entry)) continue;
      if (entry['type'] === 'codex-extension' || (!credentials && entry['type'] === 'agent-browser-cdp')) {
        delete connections[id];
        notices.add('omittedBrowserConnections');
        continue;
      }
      for (const key of ['driverPath', 'profilePath', 'executablePath', 'runtimeRoot', 'cliPath']) delete entry[key];
    }
    if (typeof record['defaultBrowser'] === 'string' && !Object.hasOwn(connections, record['defaultBrowser'])) delete record['defaultBrowser'];
    if (Array.isArray(record['allowedBrowsers'])) record['allowedBrowsers'] = record['allowedBrowsers'].filter((id) => typeof id === 'string' && Object.hasOwn(connections, id));
  }
  if (domain === 'notifications') record['credential_values'] ??= {};
  if (domain === 'providers') {
    for (const entry of Object.values(record)) {
      if (isPlainObject(entry) && entry['oauth'] !== undefined) {
        delete entry['oauth'];
        notices.add('externalLogins');
      }
    }
  }
  return record;
}

export function unsafeUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0;
  } catch { return false; }
}

export function assertSafeKeys(value: unknown, depth = 0): void {
  if (depth > 48) throw new Error('depth');
  if (Array.isArray(value)) { for (const item of value) assertSafeKeys(item, depth + 1); return; }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('key');
    assertSafeKeys(child, depth + 1);
  }
}
