import path from 'node:path';
import { BoardStorageConfigSchema, type BoardStorageConfig } from './configSection';
import type { BoardResult } from './taskBoard';

export interface BoardStorageRef {
  readonly root: string;
  readonly storageId: string;
  readonly kind: 'workspace' | 'embedded';
}

export interface BoardStorageInspection {
  readonly root: string;
  readonly kind: 'workspace' | 'embedded' | 'absent';
  readonly storageId?: string;
  readonly tasksDirectory?: string;
  readonly empty?: boolean;
}

export interface BoardStorageApi {
  inspectTaskStorage(root: string): Promise<BoardStorageInspection>;
  initializeEmbeddedTaskStorage(root: string): Promise<{ readonly id: string }>;
}

export interface BoardStorageContext {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly homeDir: string;
  readonly sessionsDir: string;
  authorizeStorage(root: string, operation: 'read' | 'write'): Promise<void>;
}

export interface BoardStoragePreview {
  readonly mode: BoardStorageConfig['mode'];
  readonly workspaceId: string;
  readonly root: string;
  readonly tasksDirectory: string;
  readonly existing: boolean;
  readonly kind: 'workspace' | 'embedded';
  readonly storageId?: string;
  readonly selectionOnly: true;
}

function invalid<T>(code: string, message: string): BoardResult<T> {
  return { ok: false, error: { code, message } };
}

async function inspect(api: BoardStorageApi, context: BoardStorageContext, root: string): Promise<BoardStorageInspection> {
  await context.authorizeStorage(root, 'read');
  return api.inspectTaskStorage(root);
}

function previewOf(context: BoardStorageContext, mode: BoardStorageConfig['mode'], storage: BoardStorageInspection): BoardResult<BoardStoragePreview> {
  if (storage.kind === 'absent' && storage.empty !== true) {
    return invalid('BOARD_STORAGE_NOT_EMPTY', 'The selected directory contains unrecognized content. Choose an empty directory or an existing compatible Own Work store.');
  }
  return { ok: true, value: {
    mode, workspaceId: context.workspaceId, root: storage.root,
    tasksDirectory: storage.tasksDirectory ?? path.join(storage.root, 'tasks'),
    existing: storage.kind !== 'absent', kind: storage.kind === 'workspace' ? 'workspace' : 'embedded',
    storageId: storage.storageId, selectionOnly: true,
  } };
}

export async function previewBoardStorage(
  api: BoardStorageApi,
  context: BoardStorageContext,
  config: BoardStorageConfig,
): Promise<BoardResult<BoardStoragePreview>> {
  const parsed = BoardStorageConfigSchema.safeParse(config);
  if (!parsed.success) return invalid('BOARD_STORAGE_CONFIG_INVALID', 'Invalid task board storage configuration.');
  const selected = parsed.data;
  if (!path.isAbsolute(context.workspaceRoot) || !path.isAbsolute(context.homeDir) || !path.isAbsolute(context.sessionsDir)
    || !context.workspaceId || /[/\\]/u.test(context.workspaceId) || context.workspaceId === '.' || context.workspaceId === '..') {
    return invalid('BOARD_WORKSPACE_INVALID', 'The host did not provide a valid workspace storage context.');
  }
  if (selected.mode === 'auto') {
    const existing = await inspect(api, context, context.workspaceRoot);
    if (existing.kind !== 'absent') return previewOf(context, selected.mode, existing);
  }
  const root = selected.mode === 'global'
    ? path.join(context.homeDir, 'boards')
    : selected.mode === 'fixed'
      ? path.resolve(context.workspaceRoot, selected.path ?? '')
      : path.join(context.sessionsDir, context.workspaceId, '.board');
  return previewOf(context, selected.mode, await inspect(api, context, root));
}

export async function prepareBoardStorage(
  api: BoardStorageApi,
  context: BoardStorageContext,
  preview: BoardStoragePreview,
): Promise<BoardResult<BoardStorageRef>> {
  await context.authorizeStorage(preview.root, 'write');
  let current = await api.inspectTaskStorage(preview.root);
  if (preview.existing && (current.kind === 'absent' || current.storageId !== preview.storageId)) {
    return invalid('BOARD_STORAGE_CHANGED', 'The selected store changed. Refresh before creating a card.');
  }
  if (current.kind === 'absent') {
    if (current.empty !== true) return invalid('BOARD_STORAGE_NOT_EMPTY', 'The selected directory is no longer empty. No store was initialized.');
    await api.initializeEmbeddedTaskStorage(preview.root);
    current = await api.inspectTaskStorage(preview.root);
  }
  if (current.kind === 'absent' || !current.storageId) return invalid('BOARD_STORAGE_INVALID', 'Own Work did not confirm a storage identity.');
  return { ok: true, value: { root: current.root, storageId: current.storageId, kind: current.kind } };
}

export async function openBoardStorage(
  api: BoardStorageApi,
  context: BoardStorageContext,
  reference: BoardStorageRef,
  operation: 'read' | 'write',
): Promise<BoardResult<BoardStorageRef>> {
  if (!path.isAbsolute(reference.root)) return invalid('BOARD_STORAGE_INVALID', 'A stored card address must have an absolute root.');
  await context.authorizeStorage(reference.root, operation);
  const current = await api.inspectTaskStorage(reference.root);
  if (current.kind !== reference.kind || current.storageId !== reference.storageId) {
    return invalid('BOARD_STORAGE_CHANGED', 'This card’s original store is missing or has a different identity. No replacement store was opened.');
  }
  return { ok: true, value: reference };
}
