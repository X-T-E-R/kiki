/**
 * Task Board types adapted for OwnWork / Kiki Workspace board.
 * Strictly presentation types; decoupled from host ledger or runner.
 */

export type BoardTaskStatus = 'active' | 'in_progress' | 'paused' | 'done' | 'cancelled' | 'superseded' | 'backlog' | 'todo' | 'running' | 'failed';

export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface TaskExecution {
  readonly id: string;
  readonly sessionId?: string;
  readonly sessionTitle?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly result?: 'succeeded' | 'failed' | 'cancelled';
  readonly error?: string;
  readonly initiatedBy?: string;
}

export interface BoardTask {
  readonly id: string;
  readonly recordId?: string;
  readonly category?: string;
  readonly detailLoaded?: boolean;
  readonly linkedExecutionIds?: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly prompt?: string;
  readonly status: BoardTaskStatus;
  readonly priority?: TaskPriority;
  readonly revision?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Workspace association */
  readonly workspaceId?: string;
  readonly workspaceTitle?: string;
  /** Associated sessions */
  readonly associatedSessionIds?: readonly string[];
  readonly executions: readonly TaskExecution[];
  /** Pinned model selection */
  readonly model?: string;
  /** Frozen snapshot or handover bundle summary */
  readonly freezeGoal?: string;
  readonly archivedAt?: number;
}

export interface BoardWorkspaceOption {
  readonly id: string;
  readonly title: string;
}

export interface BoardSessionOption {
  readonly id: string;
  readonly title: string;
}

export interface BoardColumnDef {
  readonly status: BoardTaskStatus;
  readonly label: string;
  readonly description?: string;
}

export const DEFAULT_BOARD_COLUMNS: readonly BoardColumnDef[] = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'todo', label: 'Todo' },
  { status: 'running', label: 'Running' },
  { status: 'done', label: 'Done' },
  { status: 'failed', label: 'Failed' },
];

export const OWN_WORK_BOARD_COLUMNS = [
  { status: 'active', label: 'Active' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'paused', label: 'Paused' },
  { status: 'done', label: 'Done' },
  { status: 'cancelled', label: 'Cancelled' },
  { status: 'superseded', label: 'Superseded' },
] as const satisfies readonly BoardColumnDef[];

export interface NewTaskFormData {
  requestKey?: string;
  category?: string;
  title: string;
  description: string;
  prompt: string;
  priority: TaskPriority;
  workspaceId?: string;
  associatedSessionId?: string;
}
