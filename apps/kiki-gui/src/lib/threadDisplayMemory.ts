import { spaceStorage } from './spaceStorage';

const KEY = 'kiki.sidebar.topLevelThreads';

type Stored = Record<string, string[]>;

function readAll(): Stored {
  try {
    const raw = spaceStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([scope, ids]) => [
      scope,
      Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id !== '') : [],
    ]));
  } catch {
    return {};
  }
}

export function readTopLevelThreads(scopeId: string): ReadonlySet<string> {
  const stored = readAll();
  return new Set(Object.hasOwn(stored, scopeId) ? stored[scopeId] : []);
}

export function writeTopLevelThreads(scopeId: string, ids: ReadonlySet<string>): void {
  const stored = readAll();
  const entries = Object.entries(stored).filter(([scope]) => scope !== scopeId);
  if (ids.size > 0) entries.push([scopeId, [...ids]]);
  try {
    spaceStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage unavailable: keep the current display for this visit.
  }
}
