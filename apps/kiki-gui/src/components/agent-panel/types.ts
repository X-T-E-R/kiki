import type { AgentStatus } from '@kiki/session-core/session';

/**
 * Visual presentation props for an agent's identity.
 * Pure display props: no stateful connection or API client attached.
 */
export interface AgentIdentity {
  readonly id: string;
  readonly profile: string;
  readonly label: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly thinkingEffortSource?: 'forced' | 'adjusted';
  readonly routeDetached?: boolean;
  readonly profileSource?: 'registered' | 'profile-file';
  readonly status: AgentStatus;
  readonly summary?: string;
  readonly description?: string;
  /** Config content (e.g. SYSTEM.md or profile body preview), not dynamic live leaked prompt */
  readonly configContentPreview?: string;
  readonly source?: 'builtin' | 'workspace' | 'user' | 'custom' | string;
  readonly sourceFile?: string;
  readonly context: 'live' | 'draft';
  readonly roleParameters?: Record<string, string | number | boolean>;
  readonly isMain?: boolean;
  readonly rawProfile?: import('@kiki/protocol').AgentCapabilitiesResponse['profile'];
}

/**
 * Token and context accounting breakdown for a single agent.
 * Numbers are strictly number | null (null represents unknown / not reported).
 */
export interface AgentTokenUsage {
  readonly contextTokens: number | null;
  readonly contextLimit: number | null;
  readonly totalTokens: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly totalCostUsd: number | null;
  readonly compactionCount: number | null;
  readonly usagePartial?: boolean;
  readonly costPartial?: boolean;
  readonly usageSource?: 'live' | 'persisted';
}

/**
 * Session-wide / agent-tree aggregate metrics.
 * Displayed exclusively when selected agent is main.
 */
export interface AgentTreeMetrics {
  readonly totalTokens: number | null;
  readonly totalCostUsd: number | null;
  readonly activeSubagentsCount: number | null;
  readonly totalSubagentsCount: number | null;
  readonly cacheHitRate?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly usagePartial?: boolean;
  readonly costPartial?: boolean;
}

/**
 * Todo item representation for the agent panel.
 * Strictly pending / in_progress / done.
 */
export interface AgentPanelTodo {
  readonly id: string;
  readonly title: string;
  readonly status: 'pending' | 'in_progress' | 'done';
}

/**
 * Tool capability state.
 */
export type CapabilityState = 'enabled' | 'disabled' | 'approval-required' | 'disconnected' | 'unknown';

/**
 * Tool capability description.
 */
export interface AgentToolCapability {
  readonly name: string;
  readonly category: string;
  readonly description?: string;
  readonly state: CapabilityState;
  readonly unavailableReason?: string;
  readonly source?: string;
  readonly parametersSummary?: string;
  readonly parametersSchema?: string;
  readonly readOnly?: boolean;
}

/**
 * Skill capability description with workspace scope.
 */
export interface AgentSkillCapability {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly scope: 'workspace' | 'global';
  readonly state: CapabilityState;
  readonly unavailableReason?: string;
  readonly source?: string;
  readonly path?: string;
  readonly argumentHint?: string;
  readonly type?: string;
  readonly disableModelInvocation?: boolean;
  readonly promptCommand?: boolean;
}

/**
 * Subagent capability admitting targets.
 */
export interface AgentSubagentTarget {
  readonly profile: string;
  readonly route?: string;
  readonly executor: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly defaultsAvailable: boolean;
  readonly launchAllowed?: boolean;
  readonly launchUnavailableReason?: string;
  readonly executionRestriction?: 'research-readonly' | 'none';
}

/**
 * Active work reference item (active task or running child).
 */
export interface AgentActiveWorkItem {
  readonly id: string;
  readonly kind: 'todo' | 'subagent';
  readonly label: string;
  readonly status: string;
  readonly detail?: string;
  readonly elapsedMs?: number;
}

/**
 * Current board task summary pinned to the bottom.
 */
export interface AgentBoardSummary {
  readonly activeTaskId?: string;
  readonly activeTaskTitle?: string;
  readonly activeTaskStatus?: string;
  readonly activeTaskPriority?: 'urgent' | 'high' | 'medium' | 'low';
  readonly totalTasksCount: number;
  readonly inProgressCount: number;
}
