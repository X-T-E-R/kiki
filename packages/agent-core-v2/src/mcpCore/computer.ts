import { CUA_COMPUTER_CONNECTION, WINDOWS_MCP_COMPUTER_CONNECTION } from '@kiki/protocol';

import type { McpServerConfig, McpServerStdioConfig } from './config-schema';

export { CUA_COMPUTER_CONNECTION, WINDOWS_MCP_COMPUTER_CONNECTION };
export const WINDOWS_MCP_VERSION = '0.8.8';
export const WINDOWS_MCP_COMMIT = 'b74c507d9e709223a0904cf08019edf55f2a75bb';
export const WINDOWS_MCP_WHEEL_SHA256 = '597ef720e1902ba76510a4d2b946949f8a48f281dd210c183de5ded60ea3b873';
export const WINDOWS_MCP_WHEEL_BYTES = 257_859;
export const WINDOWS_MCP_PYTHON = '>=3.14';
export const COMPUTER_ADMISSION_HELD = 'Computer executor admission is held';
export const WINDOWS_MCP_TOOL_NAMES = Object.freeze([
  'ControlStatus', 'DisplayInventory', 'Screenshot', 'Snapshot',
  'Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'Wait', 'WaitFor', 'App',
]);

const WINDOWS_MCP_TOOLS = new Set<string>(WINDOWS_MCP_TOOL_NAMES);
const CUA_INPUT_TOOLS = new Set(['click', 'clipboard_write', 'drag', 'hotkey', 'invoke_menu',
  'move_cursor', 'press_key', 'scroll', 'set_window_frame', 'type_text']);
const WINDOWS_MCP_INPUT_TOOLS = new Set(['click', 'type', 'scroll', 'move', 'shortcut', 'app']);

export type ComputerExecutorKind = 'cua' | 'windows-mcp';

export interface ComputerMcpStopResult {
  readonly state: 'idle' | 'stopped' | 'unconfirmed';
  readonly output: string;
}

export function isDirectComputerMcpConfig(config: McpServerConfig, platform: NodeJS.Platform = process.platform): boolean {
  return config.transport === 'stdio' && config.args?.includes('--socket') !== true &&
    (platform !== 'darwin' || config.args?.includes('--direct') === true);
}

export function computerToolDescription(name: string, description: string, preference: 'avoid' | 'prefer' = 'avoid'): string {
  const guidance = preference === 'prefer'
    ? 'Computer-use preference: prefer computer control for suitable interactive tasks. Follow the user’s current explicit instructions and rules; choose another available tool when it is more reliable or correct. This preference does not grant permissions or make unavailable tools available.'
    : 'Computer-use preference: generally avoid computer control unless the user or the user’s rules explicitly request it. Prefer existing CLI, API, MCP, short-script, and browser-specific capabilities; do not casually take desktop screenshots or click the desktop. Follow an explicit user request for computer control when available and permitted.';
  const recovery = isComputerInputTool(name) && !/unconfirmed|outcome.{0,20}unknown|(?:do not|never).{0,30}(?:retry|replay|repeat)/i.test(description ?? '')
    ? 'If the outcome is unconfirmed, observe again before another action; do not replay the same input.'
    : '';
  return [description, guidance, recovery].filter(Boolean).join('\n');
}

export function computerExecutorKind(config: McpServerConfig | undefined): ComputerExecutorKind | undefined {
  if (config?.transport !== 'stdio') return undefined;
  if (isCuaComputerCommand(config)) return 'cua';
  if (windowsMcpInvocation(config)) return 'windows-mcp';
  return undefined;
}

export function isComputerMcpConfig(config: McpServerConfig | undefined): boolean {
  return computerExecutorKind(config) !== undefined;
}

export function windowsMcpInvocation(config: McpServerConfig | undefined): boolean {
  if (config?.transport !== 'stdio') return false;
  const args = config.args ?? [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '-m' && args[index + 1] === 'windows_mcp') return true;
  }
  const base = commandBasename(config.command).toLowerCase();
  return (base === 'windows-mcp' || base === 'windows-mcp.exe') && args[0] === 'serve';
}

export function isWindowsMcpServeReady(config: McpServerConfig | undefined): boolean {
  if (config?.transport !== 'stdio' || !windowsMcpInvocation(config)) return false;
  if (config.executor === 'kaos') return false;
  const base = commandBasename(config.command).toLowerCase();
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
  if (tools === undefined || config.env?.['ANONYMIZED_TELEMETRY'] !== 'false') return false;
  const names = tools.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  if (names.length !== WINDOWS_MCP_TOOLS.size) return false;
  const seen = new Set(names);
  return seen.size === names.length && WINDOWS_MCP_TOOL_NAMES.every((name) => seen.has(name));
}

export function windowsMcpServeArgs(configPath: string): readonly string[] {
  return ['-m', 'windows_mcp', 'serve', '--transport', 'stdio', '--config', configPath, '--tools', WINDOWS_MCP_TOOL_NAMES.join(',')];
}

export function windowsMcpStdioConfig(pythonExecutable: string, configPath: string): McpServerStdioConfig {
  return {
    transport: 'stdio',
    command: pythonExecutable,
    args: [...windowsMcpServeArgs(configPath)],
    executor: 'local',
    env: { ANONYMIZED_TELEMETRY: 'false', WINDOWS_MCP_WATCHDOG: 'false' },
    enabledTools: [...WINDOWS_MCP_TOOL_NAMES],
  };
}

let selectedConnection: string | undefined;
const admissionListeners = new Set<() => void>();

export function computerConnectionSelection(): string | undefined {
  return selectedConnection;
}

export function setComputerConnectionSelection(connection: string | undefined): void {
  const next = connection === undefined || connection.trim() === '' ? undefined : connection.trim();
  if (next === selectedConnection) return;
  selectedConnection = next;
  notifyComputerAdmission();
}

export function notifyComputerAdmission(): void {
  for (const listener of admissionListeners) listener();
}

export function onComputerAdmissionChange(listener: () => void): () => void {
  admissionListeners.add(listener);
  return () => { admissionListeners.delete(listener); };
}

export function computerSelectionAdmits(
  name: string,
  config: McpServerConfig | undefined,
  connection: string | undefined = selectedConnection,
): boolean {
  const kind = computerExecutorKind(config);
  if (kind === undefined) return false;
  if (kind === 'windows-mcp' && !isWindowsMcpServeReady(config)) return false;
  if (connection === undefined) return kind === 'cua';
  return name === connection;
}

function isComputerInputTool(name: string): boolean {
  return CUA_INPUT_TOOLS.has(name) || WINDOWS_MCP_INPUT_TOOLS.has(name.toLowerCase());
}

function isCuaComputerCommand(config: McpServerConfig): boolean {
  return config.transport === 'stdio' &&
    /^cua-driver(?:\.exe)?$/i.test(commandBasename(config.command)) &&
    config.args?.includes('mcp') === true;
}

function commandBasename(command: string): string {
  return command.split(/[\\/]/).at(-1) ?? '';
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}
