/**
 * What the workspace-grouped session list remembers between visits: which
 * workspace groups are folded, which show every row instead of the preview,
 * and where the list was scrolled.
 *
 * Space-scoped (`spaceStorage`): workspace ids belong to one space's server,
 * so a fold in one space never leaks into another. Inside a space the record
 * is keyed by connection scope, because two servers can be reached from the
 * same space.
 */

import { spaceStorage } from './spaceStorage';

const KEY = 'kiki.sidebar.workspaceGroups';
/** Connection scopes kept; the least recently written one drops first. */
const MAX_SCOPES = 12;
/** Group ids kept per list; a workspace removed long ago stops being carried. */
const MAX_GROUPS = 400;

export interface WorkspaceGroupMemory {
  readonly collapsed: readonly string[];
  readonly expanded: readonly string[];
  readonly scrollTop: number;
}

const EMPTY: WorkspaceGroupMemory = { collapsed: [], expanded: [], scrollTop: 0 };

type Stored = Record<string, WorkspaceGroupMemory & { readonly at: number }>;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(-MAX_GROUPS) : [];
}

function readAll(): Stored {
  try {
    const raw = spaceStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Stored = {};
    for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const record = value as Record<string, unknown>;
      const scrollTop = typeof record['scrollTop'] === 'number' && Number.isFinite(record['scrollTop']) ? Math.max(0, record['scrollTop']) : 0;
      result[scope] = {
        collapsed: stringList(record['collapsed']),
        expanded: stringList(record['expanded']),
        scrollTop,
        at: typeof record['at'] === 'number' ? record['at'] : 0,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function readWorkspaceGroupMemory(scopeId: string): WorkspaceGroupMemory {
  const entry = readAll()[scopeId];
  return entry === undefined ? EMPTY : { collapsed: entry.collapsed, expanded: entry.expanded, scrollTop: entry.scrollTop };
}

export function writeWorkspaceGroupMemory(scopeId: string, patch: Partial<WorkspaceGroupMemory>): void {
  const all = readAll();
  const current = all[scopeId] ?? { ...EMPTY, at: 0 };
  all[scopeId] = {
    collapsed: (patch.collapsed ?? current.collapsed).slice(-MAX_GROUPS),
    expanded: (patch.expanded ?? current.expanded).slice(-MAX_GROUPS),
    scrollTop: Math.max(0, Math.round(patch.scrollTop ?? current.scrollTop)),
    at: Date.now(),
  };
  const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SCOPES);
  try {
    spaceStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage full or unavailable: the list simply forgets.
  }
}
