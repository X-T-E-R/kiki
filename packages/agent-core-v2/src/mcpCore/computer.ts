import type { McpServerConfig } from './config-schema';

export interface ComputerMcpStopResult {
  readonly state: 'idle' | 'stopped' | 'unconfirmed';
  readonly output: string;
}

export function isDirectComputerMcpConfig(config: McpServerConfig, platform: NodeJS.Platform = process.platform): boolean {
  return config.transport === 'stdio' && config.args?.includes('--socket') !== true &&
    (platform !== 'darwin' || config.args?.includes('--direct') === true);
}

const INPUT_TOOLS = new Set(['click', 'clipboard_write', 'drag', 'hotkey', 'invoke_menu',
  'move_cursor', 'press_key', 'scroll', 'set_window_frame', 'type_text']);

export function computerToolDescription(name: string, description: string, preference: 'avoid' | 'prefer' = 'avoid'): string {
  const guidance = preference === 'prefer'
    ? 'Computer-use preference: prefer computer control for suitable interactive tasks. Follow the user’s current explicit instructions and rules; choose another available tool when it is more reliable or correct. This preference does not grant permissions or make unavailable tools available.'
    : 'Computer-use preference: generally avoid computer control unless the user or the user’s rules explicitly request it. Prefer existing CLI, API, MCP, short-script, and browser-specific capabilities; do not casually take desktop screenshots or click the desktop. Follow an explicit user request for computer control when available and permitted.';
  const recovery = INPUT_TOOLS.has(name) && !/unconfirmed|outcome.{0,20}unknown|(?:do not|never).{0,30}(?:retry|replay|repeat)/i.test(description ?? '')
    ? 'If the outcome is unconfirmed, observe again before another action; do not replay the same input.'
    : '';
  return [description, guidance, recovery].filter(Boolean).join('\n');
}

export function isComputerMcpConfig(config: McpServerConfig | undefined): boolean {
  return config?.transport === 'stdio' &&
    /^cua-driver(?:\.exe)?$/i.test(config.command.split(/[\\/]/).at(-1) ?? '') &&
    config.args?.includes('mcp') === true;
}
