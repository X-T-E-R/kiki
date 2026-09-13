export type BoardStatus = 'active' | 'in_progress' | 'paused' | 'done' | 'cancelled' | 'superseded';
export interface BoardStorageRef { root: string; storageId: string; kind: 'workspace' | 'embedded' }
export interface BoardCreateTarget { root: string; storageId?: string; kind: 'workspace' | 'embedded' }
export interface BoardPatch {
  title?: string; description?: string; priority?: 'P0' | 'P1' | 'P2' | 'P3'; category?: string;
  sessionIds?: string[]; executionIds?: string[]; status?: BoardStatus;
}
export type BoardReadInput =
  | { action: 'preview'; workspaceId?: string; configuration?: { mode: 'auto' | 'global' | 'fixed'; path?: string } }
  | { action: 'list'; workspaceId?: string; storage?: BoardStorageRef; sessionId?: string; status?: BoardStatus; archived?: boolean; cursor?: string; limit?: number }
  | { action: 'show'; workspaceId: string; storage: BoardStorageRef; id: string }
  | { action: 'overview'; workspaceIds: string[]; status?: BoardStatus; limit?: number };
export type BoardWriteInput =
  | { action: 'create'; workspaceId?: string; requestKey: string; target?: BoardCreateTarget; title: string; description?: string; priority?: 'P0' | 'P1' | 'P2' | 'P3'; category?: string; sessionIds?: string[]; executionIds?: string[] }
  | { action: 'update'; workspaceId: string; storage: BoardStorageRef; id: string; expectedRevision: number; patch: BoardPatch };
export interface BoardSummary {
  readonly id: string; readonly workspaceId: string; readonly storage: BoardStorageRef;
  readonly title: string; readonly priority: string; readonly status: BoardStatus; readonly revision: number;
  readonly createdAt: string; readonly updatedAt: string; readonly completedAt: string | null; readonly archived: boolean;
  readonly category: string; readonly sessionIds: readonly string[]; readonly executionIds: readonly string[];
}
export interface BoardCard extends BoardSummary { readonly description: string; readonly prd: string; readonly handoff?: string }
export interface BoardIssue { readonly code: string; readonly message: string }
export type BoardResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BoardIssue };
export interface BoardPage { readonly workspaceId: string; readonly storage?: BoardStorageRef; readonly cards: readonly BoardSummary[]; readonly issues: readonly BoardIssue[]; readonly nextCursor?: string }
export interface BoardStoragePreview {
  readonly mode: 'auto' | 'global' | 'fixed'; readonly workspaceId: string; readonly root: string; readonly tasksDirectory: string;
  readonly existing: boolean; readonly kind: 'workspace' | 'embedded'; readonly storageId?: string; readonly selectionOnly: true;
}
export interface BoardOverviewEntry { readonly workspaceId: string; readonly result: BoardResult<BoardPage> }
export type BoardReadValue = BoardCard | BoardPage | BoardStoragePreview | readonly BoardOverviewEntry[];
export interface BoardClient {
  read(input: BoardReadInput): Promise<BoardResult<BoardReadValue>>;
  write(input: BoardWriteInput): Promise<BoardResult<BoardCard>>;
}
export interface BoardOverviewClient extends BoardClient {
  overview(): Promise<BoardResult<readonly BoardOverviewEntry[]>>;
}
