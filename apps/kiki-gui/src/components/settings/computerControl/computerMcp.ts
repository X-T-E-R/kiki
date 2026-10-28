/**
 * Computer-control MCP model: which managed MCP entry counts as a
 * computer-control connection, the editable draft over one entry, and the
 * draft → write shape. Pure — no React, no client calls — so a page and its
 * tests agree on one rule and the rules stay readable on their own.
 *
 * The predicate mirrors agent-core-v2 `mcpCore/computer.ts`
 * `isComputerMcpConfig`; the defaults offered for a new entry mirror
 * `computerMcpConfig` in the capability entry (name, per-platform args,
 * `local` executor), so the page never invents a shape the installer would not
 * have written.
 */

import { WINDOWS_MCP_COMPUTER_CONNECTION } from '@kiki/protocol';
import { mcpConfigFromDraft } from '@kiki/session-core/settings';
import type { GlobalMcpServerConfig } from '@kiki/klient';
import type { McpManagedServer, McpManagedServerConfig } from '@kiki/session-core/transport';

import { mcpSecretRows, type McpSecretRow } from '../McpSecretRows';

/** The global entry name the managed install registers; also the name this page creates. */
export const COMPUTER_MCP_NAME = 'kiki-computer';
export { WINDOWS_MCP_COMPUTER_CONNECTION };

const WINDOWS_MCP_TOOL_NAMES = [
  'ControlStatus', 'DisplayInventory', 'Screenshot', 'Snapshot',
  'Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'Wait', 'WaitFor', 'App',
] as const;
const WINDOWS_MCP_TOOLS = new Set<string>(WINDOWS_MCP_TOOL_NAMES);

export type ComputerExecutorKind = 'cua' | 'windows-mcp';

/**
 * List key for this page's MCP management read. The connection already owns a
 * query client per scope, so the scope id is belt-and-braces: it keeps a
 * screenshot, a test, or a future shared cache from showing one server's
 * connections for another.
 */
export function computerMcpQueryKey(scopeId: string): readonly [string, string] {
  return ['computer-control-mcp', scopeId];
}

export type ComputerExecutor = 'local' | 'kaos';

/** One editable computer-control connection. Timeouts stay text until save. */
export interface ComputerDraft {
  /** Absent while the entry has not been written yet (a new connection). */
  readonly original?: McpManagedServer;
  readonly name: string;
  readonly command: string;
  readonly args: string;
  readonly enabled: boolean;
  readonly executor: ComputerExecutor;
  readonly startupTimeoutMs: string;
  readonly toolTimeoutMs: string;
  readonly envRows: readonly McpSecretRow[];
}

function commandBaseName(command: string): string {
  return command.split(/[\\/]/).at(-1) ?? '';
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

export function isCuaComputerConfig(config: McpManagedServerConfig | undefined): boolean {
  if (config === undefined || config.transport !== 'stdio') return false;
  if (!/^cua-driver(?:\.exe)?$/i.test(commandBaseName(config.command))) return false;
  return config.args?.includes('mcp') === true;
}

export function windowsMcpInvocation(config: McpManagedServerConfig | undefined): boolean {
  if (config === undefined || config.transport !== 'stdio') return false;
  const args = config.args ?? [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '-m' && args[index + 1] === 'windows_mcp') return true;
  }
  const base = commandBaseName(config.command).toLowerCase();
  return (base === 'windows-mcp' || base === 'windows-mcp.exe') && args[0] === 'serve';
}

export function computerExecutorKind(config: McpManagedServerConfig | undefined): ComputerExecutorKind | undefined {
  if (config === undefined || config.transport !== 'stdio') return undefined;
  if (isCuaComputerConfig(config)) return 'cua';
  if (windowsMcpInvocation(config)) return 'windows-mcp';
  return undefined;
}

export function isComputerMcpConfig(config: McpManagedServerConfig | undefined): boolean {
  return computerExecutorKind(config) !== undefined;
}

export type WindowsMcpServeReadiness = 'ready' | 'not_ready' | 'unverified';

function hasWindowsMcpServeShape(config: McpManagedServerConfig | undefined): boolean {
  if (config === undefined || config.transport !== 'stdio' || !windowsMcpInvocation(config)) return false;
  if (config.executor === 'kaos') return false;
  const base = commandBaseName(config.command).toLowerCase();
  if (base === 'uv' || base === 'uv.exe' || base === 'uvx' || base === 'uvx.exe') return false;
  const args = config.args ?? [];
  if (args.includes('install') || args.includes('auth')) return false;
  const serveAt = args.indexOf('serve');
  if (serveAt < 0) return false;
  const script = base === 'windows-mcp' || base === 'windows-mcp.exe';
  if (!script && args[serveAt - 1] !== 'windows_mcp') return false;
  if (flagValue(args, '--transport') !== 'stdio') return false;
  const configPath = flagValue(args, '--config');
  if (configPath === undefined || configPath.startsWith('-')) return false;
  const tools = flagValue(args, '--tools');
  if (tools === undefined) return false;
  const names = tools.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  if (names.length !== WINDOWS_MCP_TOOLS.size) return false;
  const seen = new Set(names);
  return seen.size === names.length && WINDOWS_MCP_TOOL_NAMES.every((name) => seen.has(name));
}

export function windowsMcpServeReadiness(config: McpManagedServerConfig | undefined): WindowsMcpServeReadiness {
  if (!hasWindowsMcpServeShape(config) || config === undefined || config.transport !== 'stdio') return 'not_ready';
  const serveReady = (config as unknown as Record<string, unknown>)['computerServeReady'];
  if (typeof serveReady === 'boolean') return serveReady ? 'ready' : 'not_ready';
  const env = secretValues(config, 'env');
  if (env !== undefined) return env['ANONYMIZED_TELEMETRY'] === 'false' ? 'ready' : 'not_ready';
  const envKeys = secretKeys(config, 'envKeys');
  if (envKeys !== undefined && !envKeys.includes('ANONYMIZED_TELEMETRY')) return 'not_ready';
  return 'unverified';
}

export function isWindowsMcpServeReady(config: McpManagedServerConfig | undefined): boolean {
  return windowsMcpServeReadiness(config) === 'ready';
}

export function isBundledCuaCommand(command: string, planDestination: string | undefined): boolean {
  const norm = (value: string) => value.replace(/\\/g, '/').toLowerCase();
  const cmd = norm(command.trim());
  if (planDestination !== undefined && planDestination.trim() !== '') {
    return cmd === norm(planDestination.trim());
  }
  return cmd.includes('/capabilities/kiki-computer/');
}

export function isComputerConnection(entry: Pick<McpManagedServer, 'name' | 'config'>): boolean {
  return isComputerMcpConfig(entry.config) ||
    (entry.config.transport === 'stdio' && (entry.name === COMPUTER_MCP_NAME || entry.name === WINDOWS_MCP_COMPUTER_CONNECTION));
}

/** macOS needs `--direct`; Windows and Linux take the plain stdio mode. */
export function platformComputerArgs(platform: string | undefined): readonly string[] {
  return platform === 'darwin' ? ['mcp', '--direct'] : ['mcp'];
}

/** `envKeys` on a redacted listing, `env` on a server that still sends values. */
function secretKeys(config: McpManagedServerConfig, field: 'envKeys'): readonly string[] | undefined {
  const value = (config as unknown as Record<string, unknown>)[field];
  return Array.isArray(value) ? value as readonly string[] : undefined;
}

function secretValues(config: McpManagedServerConfig, field: 'env'): Readonly<Record<string, string>> | undefined {
  if (!(field in config)) return undefined;
  return (config as unknown as Record<string, unknown>)[field] as Readonly<Record<string, string>> | undefined;
}

export function draftForEntry(entry: McpManagedServer): ComputerDraft {
  const stdio = entry.config.transport === 'stdio' ? entry.config : undefined;
  return {
    original: entry,
    name: entry.name,
    command: stdio?.command ?? '',
    args: (stdio?.args ?? []).join('\n'),
    // A missing flag means the entry is on: only an explicit false turns it off.
    enabled: stdio?.enabled !== false,
    executor: stdio?.executor ?? 'local',
    startupTimeoutMs: stdio?.startupTimeoutMs === undefined ? '' : String(stdio.startupTimeoutMs),
    toolTimeoutMs: stdio?.toolTimeoutMs === undefined ? '' : String(stdio.toolTimeoutMs),
    envRows: entry.mutable && stdio !== undefined
      ? mcpSecretRows(secretKeys(stdio, 'envKeys'), secretValues(stdio, 'env'))
      : [],
  };
}

/**
 * Defaults for a connection this page creates: the installer's name, the
 * platform's args, the pinned binary from the install plan (empty until the
 * executor is installed, so the field asks for a real path instead of a guess).
 */
export function newComputerDraft(platform: string | undefined, binary: string | undefined): ComputerDraft {
  return {
    name: COMPUTER_MCP_NAME,
    command: binary ?? '',
    args: platformComputerArgs(platform).join('\n'),
    enabled: true,
    executor: 'local',
    startupTimeoutMs: '',
    toolTimeoutMs: '',
    envRows: [],
  };
}

export function isNewDraft(draft: ComputerDraft): boolean {
  return draft.original === undefined;
}

export function isDirtyDraft(draft: ComputerDraft): boolean {
  return draft.original === undefined ||
    JSON.stringify(draft) !== JSON.stringify(draftForEntry(draft.original));
}

/** `mcpConfigFromDraft` owns the field rules; a bad timeout is the page's own error. */
export function timeoutMsFromText(text: string, invalidKey: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(invalidKey);
  return value;
}

/**
 * The write shape. Environment values arrive as `KEY=value` lines because
 * listings are redacted and the values are revealed one row at a time.
 */
export function computerServerConfig(draft: ComputerDraft, envLines: string, invalidTimeoutKey: string): GlobalMcpServerConfig {
  const name = draft.name.trim();
  const base = mcpConfigFromDraft({
    original: draft.original,
    name,
    transport: 'stdio',
    command: draft.command,
    args: draft.args,
    env: envLines,
    url: '',
    headers: '',
    bearerTokenEnvVar: '',
  });
  // The page only ever builds a stdio entry; anything else is a bug worth
  // saying out loud rather than writing a remote config under this name.
  if (base.transport !== 'stdio') throw new Error('st.computer.notStdio');
  const originalConfig = draft.original?.config;
  return {
    ...base,
    name,
    // The session-core draft keeps these readonly; the write shape is mutable.
    args: base.args === undefined ? undefined : [...base.args],
    enabledTools: base.enabledTools === undefined ? undefined : [...base.enabledTools],
    disabledTools: base.disabledTools === undefined ? undefined : [...base.disabledTools],
    enabled: draft.enabled,
    executor: draft.executor,
    // A runtime is addressable only under the sandbox executor; leaving a
    // stale id on a local entry would point the launcher at a dead runtime.
    runtime_id: draft.executor === 'kaos' && originalConfig?.transport === 'stdio'
      ? originalConfig.runtime_id
      : undefined,
    startupTimeoutMs: timeoutMsFromText(draft.startupTimeoutMs, invalidTimeoutKey),
    toolTimeoutMs: timeoutMsFromText(draft.toolTimeoutMs, invalidTimeoutKey),
  };
}

/** `win32` → `Windows`; an unknown platform is shown as the server reported it. */
export function platformDisplay(platform: string | undefined): string | undefined {
  if (platform === undefined || platform === '') return undefined;
  return platform === 'win32' ? 'Windows'
    : platform === 'darwin' ? 'macOS'
      : platform === 'linux' ? 'Linux'
        : platform;
}

/** One line of a row's subtitle: `cua-driver.exe mcp` or the bare command. */
export function commandSummary(config: McpManagedServerConfig): string {
  if (config.transport !== 'stdio') return config.url;
  return [commandBaseName(config.command), ...(config.args ?? [])].join(' ').trim();
}

/** Where a read-only entry is actually edited; plugin entries link to their plugin. */
export function pluginLink(entry: McpManagedServer): string | undefined {
  return entry.plugin === undefined
    ? undefined
    : `/capabilities?tab=plugins&plugin=${encodeURIComponent(entry.plugin.id)}`;
}
