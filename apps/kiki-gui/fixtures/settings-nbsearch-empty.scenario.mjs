/**
 * settings-nbsearch-empty — the Search & retrieval leaf with no nb_search
 * config at all: WebSearch is fail-closed (no default lane) while FetchURL
 * stays ready on the built-in chain. The fixture server's module-level
 * NB_SEARCH_EMPTY_* fallback seeds the capabilities/test routes.
 */

import base from './settings.scenario.mjs';

const { nb_search: _drop, ...config } = base.config;

export default {
  ...base,
  config,
  nbSearchCapabilities: undefined,
  nbSearchTest: undefined,
};
