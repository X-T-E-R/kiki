/**
 * Worktree isolation: the GUI side of `klient.rest.worktrees` plus the
 * new-session availability probe. A worktree session is an ordinary session
 * whose cwd is a Kiki-managed checkout on its own branch; everything here is
 * read-mostly, and removal always inspects first so any loss is confirmed
 * against numbers the user has seen.
 */

import { useQuery } from '@tanstack/react-query';

import type { WorktreeInspection, WorktreeRecord, WorktreeRemovalOutcome } from '@kiki/protocol';

import type { KikiClient } from './client';

export type { WorktreeInspection, WorktreeRecord, WorktreeRemovalOutcome } from '@kiki/protocol';

export const worktreeKeys = {
  all: ['worktrees'] as const,
  list: () => ['worktrees', 'list'] as const,
  inspect: (id: string) => ['worktrees', 'inspect', id] as const,
  workspaceInspect: (root: string) => ['workspaces', 'inspect', root] as const,
};

export function workspaceGitState(root: string | undefined, workspaces: readonly { readonly root: string; readonly isGit: boolean }[]): boolean | undefined {
  if (root === undefined) return undefined;
  const pathKey = (path: string): string => {
    const windows = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(path);
    const normalized = windows ? path.replaceAll('\\', '/').toLowerCase() : path;
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  };
  return workspaces.find((workspace) => pathKey(workspace.root) === pathKey(root))?.isGit;
}

type WorktreeRest = NonNullable<KikiClient['klient']['rest']>['worktrees'];

export function worktreeApi(client: KikiClient): WorktreeRest {
  const rest = client.klient.rest;
  if (rest === undefined) throw new Error('Worktree management needs an HTTP connection to the server.');
  return rest.worktrees;
}

/** What a removal would discard, in the shape `:remove` confirms. */
export interface WorktreeLoss {
  readonly dirty: boolean;
  readonly ignored: boolean;
  readonly unpushed: boolean;
}

export function worktreeLoss(inspection: WorktreeInspection): WorktreeLoss {
  return {
    dirty: inspection.dirtyFiles > 0,
    ignored: inspection.ignoredNonDisposable.length > 0,
    unpushed: inspection.unpushedCommits > 0,
  };
}

export function hasLoss(loss: WorktreeLoss): boolean {
  return loss.dirty || loss.ignored || loss.unpushed;
}

/** Same loss the user confirmed: counts and ignored names all unchanged. */
export function sameInspection(a: WorktreeInspection, b: WorktreeInspection): boolean {
  return a.failed === b.failed
    && a.dirtyFiles === b.dirtyFiles
    && a.untrackedFiles === b.untrackedFiles
    && a.unpushedCommits === b.unpushedCommits
    && JSON.stringify(a.ignoredNonDisposable) === JSON.stringify(b.ignoredNonDisposable);
}

/** Records the list should show: everything not already gone. */
export function visibleWorktrees(records: readonly WorktreeRecord[]): readonly WorktreeRecord[] {
  return records
    .filter((record) => record.state !== 'removed')
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

/** A removal the server declined or could not finish leaves the checkout on disk. */
export function outcomeKeepsCheckout(outcome: WorktreeRemovalOutcome): boolean {
  return outcome !== 'removed';
}

/**
 * Whether /new can offer "run in a new worktree" for the current target.
 * `hidden`: no concrete folder yet (automatic workspace, still loading) — the
 * option is not shown at all. `not-git` / `remote`: shown disabled with the
 * reason. `ready`: the target folder is the root of a Git checkout.
 */
export type WorktreeAvailability =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'ready'; readonly root: string }
  | { readonly kind: 'not-git' }
  | { readonly kind: 'remote' };

/** Registered roots reuse list metadata; other paths are inspected without registration. */
export function useWorktreeAvailability(
  client: KikiClient,
  input: { readonly root: string | undefined; readonly remote: boolean; readonly isGit: boolean | undefined },
): WorktreeAvailability {
  const root = input.root;
  const inspection = useQuery({
    queryKey: worktreeKeys.workspaceInspect(root ?? ''),
    queryFn: () => {
      const rest = client.klient.rest;
      if (rest === undefined) throw new Error('Workspace inspection needs an HTTP connection to the server.');
      return rest.workspaces.inspect(root!);
    },
    enabled: root !== undefined && input.isGit === undefined && !input.remote,
    staleTime: 30_000,
    retry: false,
  });
  if (input.remote) return { kind: 'remote' };
  if (root === undefined) return { kind: 'hidden' };
  const isGit = input.isGit ?? (inspection.isError ? undefined : inspection.data?.isGit);
  if (isGit === undefined) return { kind: 'hidden' };
  return isGit ? { kind: 'ready', root } : { kind: 'not-git' };
}
