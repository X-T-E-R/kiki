import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface WorktreeIsolation {
  readonly kind: 'worktree';
  readonly branch?: string;
  readonly base?: 'head' | 'fresh' | { readonly ref: string };
}

export interface SessionWorktree {
  readonly worktreeId: string;
  readonly branch: string;
  readonly sourceRoot: string;
  readonly baseRef: string;
}

export interface WorktreeInspection {
  readonly inspectedAt: number;
  readonly failed: boolean;
  readonly dirtyFiles: number;
  readonly untrackedFiles: number;
  readonly aheadOfBase: number;
  readonly unpushedCommits: number;
  readonly ignoredNonDisposable: readonly string[];
  readonly foreignLock?: string;
}

export type WorktreeRemovalOutcome = 'removed' | 'retained_dirty' | 'retained_unpushed' |
  'retained_ignored' | 'retained_foreign_lock' | 'retained_unowned' | 'retained_in_use' |
  'failed_busy' | 'failed';

export interface WorktreeRecord {
  readonly id: string;
  readonly version: 1;
  readonly repo: { readonly fingerprint: string; readonly commonDir: string; readonly sourceRoot: string; readonly workspaceId: string };
  readonly path: string;
  readonly branch: string;
  readonly branchCreated: boolean;
  readonly base: { readonly mode: 'head' | 'fresh' | 'ref'; readonly ref: string; readonly commit: string };
  readonly owner: { readonly kind: 'session'; readonly sessionId: string };
  readonly state: 'creating' | 'ready' | 'removing' | 'remove_failed' | 'removed' | 'orphaned';
  readonly lastInspection?: WorktreeInspection;
  readonly removal?: { readonly requestedAt: number; readonly trigger: 'user' | 'gc'; readonly outcome: WorktreeRemovalOutcome };
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorktreeRemovalRequest {
  readonly confirmLoss?: { readonly dirty: boolean; readonly ignored: boolean; readonly unpushed: boolean };
  readonly deleteBranch?: boolean;
}

export interface IWorktreeService {
  readonly _serviceBrand: undefined;
  create(input: { readonly sessionId: string; readonly workspaceId: string; readonly sourceRoot: string; readonly title?: string; readonly isolation: WorktreeIsolation }): Promise<WorktreeRecord>;
  list(query?: { readonly workspaceId?: string; readonly state?: WorktreeRecord['state'] }): Promise<readonly WorktreeRecord[]>;
  get(id: string): Promise<WorktreeRecord | undefined>;
  forPath(path: string): Promise<WorktreeRecord | undefined>;
  inspect(id: string): Promise<WorktreeInspection>;
  remove(id: string, request?: WorktreeRemovalRequest, trigger?: 'user' | 'gc'): Promise<{ readonly outcome: WorktreeRemovalOutcome }>;
  gc(dryRun: boolean): Promise<readonly { readonly id: string; readonly outcome: WorktreeRemovalOutcome }[]>;
}

export const IWorktreeService: ServiceIdentifier<IWorktreeService> = createDecorator<IWorktreeService>('worktreeService');
