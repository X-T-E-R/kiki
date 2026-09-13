/**
 * settings-nbsearch — Search & retrieval settings scenario with active
 * nb_search configuration, secret-free capabilities, and daemon config source status.
 */

import base from './settings.scenario.mjs';

export default {
  ...base,
  config: {
    ...base.config,
    nb_search_source: { reuse_local_config: true },
  },
  nbSearchCapabilities: {
    ...base.nbSearchCapabilities,
    config_source: {
      reuse_local_config: true,
      layers: ['defaults', 'local', 'environment', 'kiki'],
      local_config: 'present',
      availability: 'ready',
      issues: [],
    },
  },
};
