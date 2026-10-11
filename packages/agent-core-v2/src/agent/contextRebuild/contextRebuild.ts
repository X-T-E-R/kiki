import { createDecorator } from '#/_base/di/instantiation';

export const CONTEXT_REBUILD_SURFACES = [
  'profile',
  'prompt_fields',
  'skills',
  'instructions',
  'plugins',
  'mcp',
  'injections',
] as const;

export type ContextRebuildSurface = (typeof CONTEXT_REBUILD_SURFACES)[number];

export interface ContextRebuildChanges {
  readonly profile: boolean;
  readonly promptFields: boolean;
  readonly skills: boolean;
  readonly instructions: boolean;
  readonly plugins: boolean;
  readonly mcp: boolean;
  readonly injections: boolean;
}

export interface ContextRebuildResult {
  readonly rebuilt: readonly ContextRebuildSurface[];
  readonly changed: boolean;
  readonly changes: ContextRebuildChanges;
  readonly readiness: {
    readonly mcp: readonly {
      readonly runtimeName: string;
      readonly connection: import('#/agent/mcp/mcp').McpSessionCapability['connection'];
      readonly error?: string;
    }[];
    readonly plugins: {
      readonly state: 'ready' | 'pending' | 'failed' | 'unavailable';
      readonly errors: readonly string[];
    };
  };
}

export interface IAgentContextRebuildService {
  readonly _serviceBrand: undefined;
  rebuild(): Promise<ContextRebuildResult>;
}

export const IAgentContextRebuildService =
  createDecorator<IAgentContextRebuildService>('agentContextRebuildService');
