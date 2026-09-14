import { createDecorator } from '#/_base/di/instantiation';

export const CONTEXT_REBUILD_SURFACES = [
  'profile',
  'prompt_fields',
  'skills',
  'instructions',
  'plugins',
  'injections',
] as const;

export type ContextRebuildSurface = (typeof CONTEXT_REBUILD_SURFACES)[number];

export interface ContextRebuildChanges {
  readonly profile: boolean;
  readonly promptFields: boolean;
  readonly skills: boolean;
  readonly instructions: boolean;
  readonly plugins: boolean;
  readonly injections: boolean;
}

export interface ContextRebuildResult {
  readonly rebuilt: readonly ContextRebuildSurface[];
  readonly changed: boolean;
  readonly changes: ContextRebuildChanges;
}

export interface IAgentContextRebuildService {
  readonly _serviceBrand: undefined;
  rebuild(): Promise<ContextRebuildResult>;
}

export const IAgentContextRebuildService =
  createDecorator<IAgentContextRebuildService>('agentContextRebuildService');
