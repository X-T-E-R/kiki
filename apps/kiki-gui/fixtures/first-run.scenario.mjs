/**
 * first-run — a freshly installed kiki: no workspaces, no providers, no
 * models. The /new hero must say the next step (connect a model) instead of
 * letting the first send fail deep in the turn, and the workspace popover must
 * explain what a workspace is for.
 */

export default {
  sessions: [],
  snapshots: {},
  workspaces: [],
  providers: [],
  models: [],
  auth: {
    ready: false,
    providers_count: 0,
    default_model: null,
    managed_provider: null,
  },
  config: {
    default_model: '',
    default_permission_mode: 'manual',
    providers: {},
  },
};
