import type { HostFs } from './hostFs';

export interface AgentProfilePorts {
  readonly fs: HostFs;
  isModelAliasResolvable(alias: string): boolean;
  isExecutorKnown(id: string): boolean;
}

export type IsModelAliasResolvable = AgentProfilePorts['isModelAliasResolvable'];
export type IsExecutorKnown = AgentProfilePorts['isExecutorKnown'];
