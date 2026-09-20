/**
 * Task Board types adapted for OwnWork / Kiki Workspace board.
 * Strictly presentation types; decoupled from host ledger or runner.
 */

import type { I18nKey } from '@kiki/session-core/i18n';

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
  readonly label?: string;
  readonly labelKey?: I18nKey;
  readonly description?: string;
}

export const DEFAULT_BOARD_COLUMNS: readonly BoardColumnDef[] = [
  { status: 'backlog', labelKey: 'taskBoard.column.backlog' },
  { status: 'todo', labelKey: 'taskBoard.column.todo' },
  { status: 'running', labelKey: 'taskBoard.column.running' },
  { status: 'done', labelKey: 'taskBoard.column.done' },
  { status: 'failed', labelKey: 'taskBoard.column.failed' },
];

export const OWN_WORK_BOARD_COLUMNS = [
  { status: 'active', labelKey: 'taskBoard.column.active' },
  { status: 'in_progress', labelKey: 'taskBoard.column.in_progress' },
  { status: 'paused', labelKey: 'taskBoard.column.paused' },
  { status: 'done', labelKey: 'taskBoard.column.done' },
  { status: 'cancelled', labelKey: 'taskBoard.column.cancelled' },
  { status: 'superseded', labelKey: 'taskBoard.column.superseded' },
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
