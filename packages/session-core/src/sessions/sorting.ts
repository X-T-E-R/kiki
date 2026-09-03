/**
 * Shared list-ordering helpers for picker surfaces — pure functions so the
 * /new draft, the settings page, and the right rail all agree on ordering
 * and stay unit-testable without a DOM.
 */

import type { Task, Workspace } from '@moonshot-ai/protocol';

/**
 * Most-recently-opened first; workspaces without a usable timestamp sink to
 * the bottom, and ties fall back to a deterministic code-unit name compare
 * (not localeCompare, so the order cannot drift with the runtime locale).
 */
export function compareWorkspacesByRecency(a: Workspace, b: Workspace): number {
  const aTime = Date.parse(a.last_opened_at);
  const bTime = Date.parse(b.last_opened_at);
  const aHas = Number.isFinite(aTime);
  const bHas = Number.isFinite(bTime);
  if (aHas && bHas && aTime !== bTime) return bTime - aTime;
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortWorkspacesByRecency(workspaces: readonly Workspace[]): Workspace[] {
  return [...workspaces].sort(compareWorkspacesByRecency);
}

/**
 * Pinned workspaces first, then the rest, each block ordered by recency. Every
 * picker that lists workspaces reads this so a pin means the same thing in the
 * sidebar, the /new draft, and the settings list.
 */
export function sortWorkspacesByPinnedThenRecency(
  workspaces: readonly Workspace[],
): Workspace[] {
  return [...workspaces].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return compareWorkspacesByRecency(a, b);
  });
}

/**
 * Case-insensitive substring filter over name and root — the settings
 * workspace list narrows on either, since the root is what disambiguates
 * same-named checkouts.
 */
export function filterWorkspaces(
  workspaces: readonly Workspace[],
  query: string,
): Workspace[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...workspaces];
  return workspaces.filter(
    (workspace) =>
      workspace.name.toLowerCase().includes(needle) ||
      workspace.root.toLowerCase().includes(needle),
  );
}

/** Running work first, then newest-created first within each status tier. */
export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if ((a.status === 'running') !== (b.status === 'running')) {
      return a.status === 'running' ? -1 : 1;
    }
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

/** Substring match for searchable-select options, over label, hint, and keywords. */
export function filterSelectOptions<T extends { readonly label: string; readonly hint?: string; readonly keywords?: string }>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...options];
  return options.filter((option) =>
    [option.label, option.hint, option.keywords].some(
      (text) => text !== undefined && text.toLowerCase().includes(needle),
    ),
  );
}
