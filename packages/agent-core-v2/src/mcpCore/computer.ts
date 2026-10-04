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

export function computerToolDescription(name: string, description: string): string {
  if (!INPUT_TOOLS.has(name) || /unconfirmed|outcome.{0,20}unknown|(?:do not|never).{0,30}(?:retry|replay|repeat)/i.test(description ?? '')) return description;
  return `${description ?? ''}\nIf the outcome is unconfirmed, observe again before another action; do not replay the same input.`.trim();
}

export function isComputerMcpConfig(config: McpServerConfig | undefined): boolean {
  return config?.transport === 'stdio' &&
    /^cua-driver(?:\.exe)?$/i.test(config.command.split(/[\\/]/).at(-1) ?? '') &&
    config.args?.includes('mcp') === true;
}
