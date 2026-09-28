/**
 * Global search result shaping for the sidebar.
 *
 * `POST /search` returns a flat, score-ordered hit list; the sidebar groups
 * hits by session so one busy session cannot crowd out the rest. Hits carry
 * no message id (session_id + turn/step_id only), so navigation targets the
 * session — message-level jumps are not feasible on this wire.
 */

import type { SearchMessageHit } from '../transport';

export interface SearchSessionGroup {
  sessionId: string;
  /** Best snippet/title evidence for the session, in hit order. */
  title: string;
  hits: SearchMessageHit[];
  /** Highest score in the group (groups sort by it, desc). */
  score: number;
  /** Most recent hit time in the group. */
  latest: number;
}

/** Group a flat hit list by session, preserving the server's relevance order. */
export function groupSearchHits(
  hits: readonly SearchMessageHit[],
  options: { maxPerGroup?: number; maxGroups?: number } = {},
): SearchSessionGroup[] {
  const maxPerGroup = options.maxPerGroup ?? 3;
  const maxGroups = options.maxGroups ?? 12;
  const bySession = new Map<string, SearchSessionGroup>();
  for (const hit of hits) {
    let group = bySession.get(hit.session_id);
    if (group === undefined) {
      group = {
        sessionId: hit.session_id,
        title: hit.session_title,
        hits: [],
        score: hit.score,
        latest: hit.time,
      };
      bySession.set(hit.session_id, group);
    }
    if (group.title.trim() === '' && hit.session_title.trim() !== '') {
      group.title = hit.session_title;
    }
    if (group.hits.length < maxPerGroup) group.hits.push(hit);
    group.score = Math.max(group.score, hit.score);
    group.latest = Math.max(group.latest, hit.time);
  }
  return [...bySession.values()]
    .toSorted((a, b) => b.score - a.score || b.latest - a.latest)
    .slice(0, maxGroups);
}

/** Sidebar debounce: short queries are not worth a round-trip. */
export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_DEBOUNCE_MS = 300;

export function isSearchable(query: string): boolean {
  return query.trim().length >= SEARCH_MIN_QUERY_LENGTH;
}

/* ------------------------------------------------------------------------ *
 * Two-layer sidebar / quick-switcher search engine (pure half).
 *
 * Layer 1 is instant and local: every keystroke fuzzy-matches the loaded
 * session titles, workspace names + roots, and cwd — no network. Layer 2 is
 * the debounced server content search (`POST /search`); its request shape is
 * built here so the sidebar and the Ctrl+K switcher send the same body.
 * ------------------------------------------------------------------------ */

/** Content-layer debounce (the local layer never waits). */
export const CONTENT_SEARCH_DEBOUNCE_MS = 250;
export const CONTENT_SEARCH_PAGE_SIZE = 20;

/** Half-open [start, end) code-unit ranges to highlight inside a string. */
export type MatchRange = readonly [number, number];

export interface ParsedSearchQuery {
  /** Free text after prefixes are removed (what the matchers see). */
  readonly text: string;
  /** `in:<workspace>` term, matched against workspace names/roots. */
  readonly workspaceTerm?: string;
  /** `role:user|assistant` — narrows the content layer only. */
  readonly role?: 'user' | 'assistant';
}

/** Split `in:` / `role:` prefixes out of the raw query; unknown tokens stay text. */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  let workspaceTerm: string | undefined;
  let role: 'user' | 'assistant' | undefined;
  const rest: string[] = [];
  for (const token of raw.split(/\s+/)) {
    if (token === '') continue;
    const lower = token.toLowerCase();
    if (lower.startsWith('in:') && token.length > 3) {
      workspaceTerm = token.slice(3);
      continue;
    }
    if (lower === 'role:user' || lower === 'role:assistant') {
      role = lower === 'role:user' ? 'user' : 'assistant';
      continue;
    }
    rest.push(token);
  }
  return {
    text: rest.join(' '),
    ...(workspaceTerm === undefined ? {} : { workspaceTerm }),
    ...(role === undefined ? {} : { role }),
  };
}

/**
 * Fuzzy score of `query` inside `target` (case-insensitive), or null when not
 * every character appears in order. Contiguous substring hits win outright
 * (earlier + word-start better); scattered subsequences score by compactness.
 */
export function fuzzyMatch(target: string, query: string): { score: number; ranges: MatchRange[] } | null {
  const needle = query.trim().toLowerCase();
  if (needle === '') return null;
  const hay = target.toLowerCase();
  const at = hay.indexOf(needle);
  if (at !== -1) {
    const wordStart = at === 0 || /[\s/\._\-:]/.test(hay[at - 1] ?? '');
    return { score: 1000 - Math.min(at, 200) + (wordStart ? 100 : 0), ranges: [[at, at + needle.length]] };
  }
  // Multi-word queries: every word must appear as a substring.
  const words = needle.split(/\s+/).filter((word) => word !== '');
  if (words.length > 1) {
    const ranges: MatchRange[] = [];
    for (const word of words) {
      const index = hay.indexOf(word);
      if (index === -1) return null;
      ranges.push([index, index + word.length]);
    }
    return { score: 600 - Math.min(ranges[0]![0], 200), ranges: mergeRanges(ranges) };
  }
  // Subsequence (≥3 chars, so two-letter noise stays out).
  if (needle.length < 3) return null;
  const ranges: [number, number][] = [];
  let from = 0;
  for (const char of needle) {
    const index = hay.indexOf(char, from);
    if (index === -1) return null;
    const last = ranges.at(-1);
    if (last !== undefined && last[1] === index) last[1] = index + 1;
    else ranges.push([index, index + 1]);
    from = index + 1;
  }
  const span = ranges.at(-1)![1] - ranges[0]![0];
  if (span > needle.length * 4) return null;
  return { score: 300 - span - ranges.length * 10, ranges };
}

function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** Ranges of every query term inside a server snippet, for highlighting. */
export function highlightTerms(text: string, query: string): MatchRange[] {
  const hay = text.toLowerCase();
  const ranges: MatchRange[] = [];
  for (const term of query.toLowerCase().split(/\s+/)) {
    if (term.length === 0) continue;
    let from = 0;
    for (;;) {
      const index = hay.indexOf(term, from);
      if (index === -1) break;
      ranges.push([index, index + term.length]);
      from = index + term.length;
    }
  }
  return mergeRanges(ranges);
}

/** Split text into plain / highlighted segments for rendering. */
export function splitByRanges(text: string, ranges: readonly MatchRange[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false });
    if (end > start) out.push({ text: text.slice(Math.max(start, cursor), end), hit: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}

export interface LocalSearchWorkspace {
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

export interface LocalSearchSession {
  readonly id: string;
  readonly title: string;
  readonly workspace_id: string;
  readonly updated_at: string;
  readonly cwd: string;
}

export interface LocalWorkspaceMatch<W extends LocalSearchWorkspace = LocalSearchWorkspace> {
  readonly workspace: W;
  readonly score: number;
  readonly nameRanges: readonly MatchRange[];
}

export interface LocalSessionMatch<S extends LocalSearchSession = LocalSearchSession> {
  readonly session: S;
  readonly score: number;
  readonly titleRanges: readonly MatchRange[];
  /** Set when only the cwd / workspace matched (the title did not). */
  readonly matchedOn: 'title' | 'cwd' | 'workspace';
}

export const LOCAL_WORKSPACE_LIMIT = 4;
export const LOCAL_SESSION_LIMIT = 8;

/** Instant local layer: workspaces + sessions ranked by fuzzy score, then recency. */
export function searchLocal<S extends LocalSearchSession, W extends LocalSearchWorkspace>(input: {
  readonly text: string;
  readonly sessions: readonly S[];
  readonly workspaces: readonly W[];
  readonly workspaceLimit?: number;
  readonly sessionLimit?: number;
}): { workspaces: LocalWorkspaceMatch<W>[]; sessions: LocalSessionMatch<S>[] } {
  const text = input.text.trim();
  if (text === '') return { workspaces: [], sessions: [] };
  const workspaceNames = new Map(input.workspaces.map((workspace) => [workspace.id, workspace.name]));
  const workspaces = input.workspaces
    .flatMap((workspace) => {
      const name = fuzzyMatch(workspace.name, text);
      const root = name === null ? fuzzyMatch(workspace.root, text) : null;
      if (name === null && root === null) return [];
      return [{ workspace, score: name?.score ?? (root!.score - 50), nameRanges: name?.ranges ?? [] }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, input.workspaceLimit ?? LOCAL_WORKSPACE_LIMIT);
  const sessions = input.sessions
    .flatMap((session): LocalSessionMatch<S>[] => {
      const title = fuzzyMatch(session.title, text);
      if (title !== null) return [{ session, score: title.score, titleRanges: title.ranges, matchedOn: 'title' }];
      const cwd = fuzzyMatch(session.cwd, text);
      if (cwd !== null) return [{ session, score: cwd.score - 200, titleRanges: [], matchedOn: 'cwd' }];
      const workspaceName = workspaceNames.get(session.workspace_id);
      const workspace = workspaceName === undefined ? null : fuzzyMatch(workspaceName, text);
      if (workspace !== null) return [{ session, score: workspace.score - 400, titleRanges: [], matchedOn: 'workspace' }];
      return [];
    })
    .sort((a, b) => b.score - a.score || b.session.updated_at.localeCompare(a.session.updated_at))
    .slice(0, input.sessionLimit ?? LOCAL_SESSION_LIMIT);
  return { workspaces, sessions };
}

/** Resolve an `in:` term to one workspace id (best fuzzy name/root match). */
export function resolveWorkspaceTerm<W extends LocalSearchWorkspace>(
  term: string | undefined,
  workspaces: readonly W[],
): W | undefined {
  if (term === undefined || term.trim() === '') return undefined;
  return searchLocal({ text: term, sessions: [], workspaces, workspaceLimit: 1 }).workspaces[0]?.workspace;
}

/**
 * The content-layer request body both surfaces send. `workspace_id` rides
 * only when exactly one workspace scopes the search (the server filters one
 * id; several are narrowed client-side by `scopeContentHits`).
 */
export function buildContentSearchBody(input: {
  readonly text: string;
  readonly role?: 'user' | 'assistant';
  readonly workspaceIds: readonly string[];
  readonly pageSize?: number;
  readonly pageToken?: string;
}): {
  query: string;
  sort: 'score';
  page_size: number;
  role?: 'user' | 'assistant';
  workspace_id?: string;
  page_token?: string;
} {
  return {
    query: input.text.trim(),
    sort: 'score',
    page_size: input.pageSize ?? CONTENT_SEARCH_PAGE_SIZE,
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.workspaceIds.length === 1 ? { workspace_id: input.workspaceIds[0] } : {}),
    ...(input.pageToken === undefined ? {} : { page_token: input.pageToken }),
  };
}

/** Client-side scope for content hits: the workspace set (when several) and,
 * when given, the session ids that pass the status/archived filters. */
export function scopeContentHits<H extends { readonly session_id: string; readonly workspace_id: string }>(
  hits: readonly H[],
  scope: { readonly workspaceIds: readonly string[]; readonly allowedSessionIds?: ReadonlySet<string> },
): H[] {
  const workspaces = new Set(scope.workspaceIds);
  return hits.filter((hit) =>
    (workspaces.size === 0 || workspaces.has(hit.workspace_id)) &&
    (scope.allowedSessionIds === undefined || scope.allowedSessionIds.has(hit.session_id)));
}
