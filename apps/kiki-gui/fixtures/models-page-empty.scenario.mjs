/** models-page-empty — a server with no connections and no models yet. */

export default {
  config: {
    default_permission_mode: 'manual',
    providers: {},
  },
  models: [],
  providers: [],
  auth: { ready: false, providers_count: 0, default_model: null, managed_provider: null },
  workspaces: [],
  sessions: [],
  snapshots: {},
};
