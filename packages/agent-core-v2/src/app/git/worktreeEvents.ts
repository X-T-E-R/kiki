import { Event2 } from '#/app/event/event2';
import type { WorktreeRecord, WorktreeInspection } from './worktreeModel';

export interface WorktreeChangedPayload {
  readonly sessionId: string;
  readonly worktreeId: string;
  readonly state: WorktreeRecord['state'];
  readonly inspection?: WorktreeInspection;
}

export class WorktreeChanged extends Event2<{ readonly payload: WorktreeChangedPayload }> {
  static override readonly type = 'session.worktree.changed';
}

export interface WorktreeChanged {
  readonly payload: WorktreeChangedPayload;
}
