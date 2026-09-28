export const RPC_PROTOCOL_VERSION = 1 as const;

export interface ToolAccess {
  readonly kind: 'all' | 'file';
  readonly operation?: 'read' | 'write' | 'readwrite' | 'search';
  readonly path?: string;
  readonly recursive?: boolean;
}

export interface PluginToolDefinition {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
  readonly accesses?: readonly ToolAccess[];
  readonly display?: Record<string, unknown>;
  readonly approvalRule?: string;
  readonly disclosure?: 'inline' | 'deferred';
}

export type PluginContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly imageUrl: { readonly url: string } };

export interface PluginExecutionContext {
  readonly signal: AbortSignal;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly workspaceRoot?: string;
  readonly approvedPaths: readonly string[];
  readonly imageIn: boolean;
  progress(update: { kind: 'progress' | 'status' | 'stdout' | 'stderr'; text?: string; percent?: number }): void;
}

export interface PluginTool {
  readonly definition: PluginToolDefinition;
  readonly execute: (args: unknown, context: PluginExecutionContext) => Promise<{ output: string | readonly PluginContentPart[]; isError?: boolean }>;
}

export interface PluginRegistrationApi {
  registerTool(definition: PluginToolDefinition, execute: PluginTool['execute']): void;
}

export function definePlugin(tools: readonly PluginTool[]) {
  return {
    tools,
    register(api: PluginRegistrationApi): void {
      for (const tool of tools) api.registerTool(tool.definition, tool.execute);
    },
  };
}
