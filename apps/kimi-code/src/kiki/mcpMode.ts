export interface McpModeOptions {
  readonly workspace?: string;
  readonly attached?: boolean;
  readonly client?: string;
  readonly tools?: boolean;
}

export function mcpModeError(options: McpModeOptions): string | undefined {
  if (options.client !== undefined) {
    if (options.tools !== true) return '--tools is required with --client.';
    if (options.attached === true || options.workspace !== undefined) {
      return '--client cannot be combined with --attached or --workspace.';
    }
    return undefined;
  }
  if (options.attached === true) return undefined;
  if (options.workspace === undefined) return '--workspace is required for delegation MCP mode.';
  return undefined;
}
