/**
 * settings-ia: the settings IA v2 walker. Reuses the workspaces fixture so
 * the Workspaces page and the task-card storage picker have rows to show,
 * and reports the experimental flags each feature page hosts so their
 * Experimental rows and the Labs index have entries.
 */

import workspaces from './settings-workspaces.scenario.mjs';

export default {
  ...workspaces,
  experimentalFlags: {
    'agent-profile-routes': false,
    subagent_release_idle: true,
    external_delegation_mcp: true,
    task_board: true,
    persistence_minidb_readmodel: true,
    session_idle_eviction: false,
  },
};
