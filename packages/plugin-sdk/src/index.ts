import type { SessionSourceDefinition, ImportProbe, ImportParsePage, ImportDiscoveryPage } from './session-import.js';
export * from './session-import.js';
export * from './media.js';
import type { MediaProviderDefinition, MediaProviderAdapter, PluginMediaApi } from './media.js';

export interface SessionSourceContext {
  readonly signal: AbortSignal;
  readonly settings: Readonly<Record<string, unknown>>;
}
export interface SessionSourceAdapter {
  discover(input: { home: string; cursor?: string }, context: SessionSourceContext): Promise<ImportDiscoveryPage>;
  probe(input: { home: string; externalId: string; mode?: 'native-session' }, context: SessionSourceContext): Promise<ImportProbe>;
  parse(input: { home: string; externalId: string; revision: string; cursor?: string; mode?: 'native-session' }, context: SessionSourceContext): Promise<ImportParsePage>;
}

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
  readonly mediaInputs?: boolean;
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
  readonly media: PluginMediaApi;
  progress(update: { kind: 'progress' | 'status' | 'stdout' | 'stderr'; text?: string; percent?: number }): void;
}

export interface PluginTool {
  readonly definition: PluginToolDefinition;
  readonly execute: (args: unknown, context: PluginExecutionContext) => Promise<{ output: string | readonly PluginContentPart[]; isError?: boolean }>;
}

export interface PluginRegistrationApi {
  registerTool(definition: PluginToolDefinition, execute: PluginTool['execute']): void;
  registerSessionSource(definition: SessionSourceDefinition, adapter: SessionSourceAdapter): void;
  registerMediaProvider(definition: MediaProviderDefinition, adapter: MediaProviderAdapter): void;
}

export function definePlugin(tools: readonly PluginTool[]) {
  return {
    tools,
    register(api: PluginRegistrationApi): void {
      for (const tool of tools) api.registerTool(tool.definition, tool.execute);
    },
  };
}
