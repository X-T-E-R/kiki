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
  gitProbe: (root: string) => ['worktrees', 'git-probe', root] as const,
};

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

/**
 * The server rejects a source that is not a Git root, and exposes no
 * "is this a repository" field on workspaces, so the probe lists the folder
 * through the host folder browser and looks for a `.git` directory. A failed
 * listing counts as unknown and hides the option: it is advisory, and the
 * create call still validates.
 */
export function useWorktreeAvailability(
  client: KikiClient,
  input: { readonly root: string | undefined; readonly remote: boolean },
): WorktreeAvailability {
  const root = input.root;
  const probe = useQuery({
    queryKey: worktreeKeys.gitProbe(root ?? ''),
    queryFn: async () => {
      const listing = await client.klient.global.hostFs.browse(root);
      return listing.entries.some((entry) => entry.name === '.git');
    },
    enabled: root !== undefined && !input.remote,
    staleTime: 60_000,
    retry: false,
  });
  if (input.remote) return { kind: 'remote' };
  if (root === undefined) return { kind: 'hidden' };
  // Unknown (pending, or the listing failed) shows nothing rather than guess.
  if (probe.isPending || probe.isError) return { kind: 'hidden' };
  return probe.data === true ? { kind: 'ready', root } : { kind: 'not-git' };
}
