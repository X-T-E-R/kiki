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

export type ContextRebuildOutcome = 'applied' | 'partial' | 'failed';

export type ContextRebuildTrigger =
  | 'manual'
  | 'compaction'
  | 'fresh_start'
  | 'summary'
  | 'restore'
  | 'model_switch_fresh'
  | 'model_switch_compact'
  | 'context_clear';

export type ContextRebuildUnsupportedSurface = ContextRebuildSurface | 'executor_session';

export interface ContextRebuildUnsupported {
  readonly surface: ContextRebuildUnsupportedSurface;
  readonly reason: string;
}

export interface ContextRebuildResult {
  readonly rebuilt: readonly ContextRebuildSurface[];
  readonly changed: boolean;
  /** Absent when a finished stage could not be compared. That is not a report of no change. */
  readonly changes?: ContextRebuildChanges;
  readonly outcome: ContextRebuildOutcome;
  readonly unsupported: readonly ContextRebuildUnsupported[];
  /** The reported binding is what the next model request reads. A failed refresh does not replace it. */
  readonly appliesOn: 'next_request';
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

export interface ContextRebuildControl {
  readonly enabled: boolean;
  readonly outcome?: ContextRebuildOutcome;
  readonly trigger?: ContextRebuildTrigger;
  readonly at?: string;
  readonly error?: string;
  readonly changes?: ContextRebuildChanges;
  readonly rebuilt: readonly ContextRebuildSurface[];
  readonly unsupported: readonly ContextRebuildUnsupported[];
}

export interface IAgentContextRebuildService {
  readonly _serviceBrand: undefined;
  /** Re-reads this main agent's frozen sources while the loop is idle. */
  rebuild(): Promise<ContextRebuildResult>;
  /** This agent's switch and the latest rebuild report. Other agents keep their own. */
  control(): ContextRebuildControl;
  /**
   * Persists this agent's switch. Enabling does not rebuild immediately and does not
   * walk child agents. The default is off.
   */
  setEnabled(enabled: boolean): Promise<void>;
}

export const IAgentContextRebuildService =
  createDecorator<IAgentContextRebuildService>('agentContextRebuildService');
