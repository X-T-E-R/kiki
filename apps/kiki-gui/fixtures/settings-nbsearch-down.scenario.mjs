/**
 * settings-nbsearch-down — the readiness check fails (invalid saved config on
 * a real server; a static error envelope here) while capabilities still load,
 * so the diagnostics card's error state renders next to a working page.
 */

import base from './settings.scenario.mjs';

export default {
  ...base,
  nbSearchTest: { __error: 'fixture: nb-search runtime rejected the saved nb_search configuration' },
};
