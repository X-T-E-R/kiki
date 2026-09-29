/**
 * search-oom — the search scenario with the full-text indexer down after
 * repeated out-of-memory exits: `/search` answers `unavailable` with reason
 * `memory_budget` (what kap-server reports after three memory-budget exits),
 * title search still matches, and `POST /search/retry` brings the index back.
 */

import search from './search.scenario.mjs';

export default {
  ...search,
  searchOutage: { reason: 'memory_budget', indexedSessions: 1, recoverOnRetry: true },
};
