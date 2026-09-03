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
