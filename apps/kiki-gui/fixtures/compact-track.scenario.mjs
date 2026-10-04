/**
 * compact-track — the model editor's compaction-point track against the shapes
 * that decide its numbers: a declared input limit larger than the window, a
 * sibling whose display name matches, a window the reserve swallows, a model
 * override pinning the point, and a model context budget. Test fixture only.
 */

const WSID = 'wd_fixture_000000000000';

export default {
  config: {
    default_provider: 'axon-for-test',
    default_model: 'axon-for-test/gpt-6-astra',
    default_permission_mode: 'manual',
    providers: {
      'axon-for-test': { type: 'openai', base_url: 'https://api.example.test/v1', has_api_key: true },
      axon: { type: 'openai', base_url: 'https://api.example.test/v1', has_api_key: true },
    },
    loop_control: { autoCompact: '85%' },
  },
  models: [
    // 529.4k declared input under a 400k window: the engine clamps it to 400k.
    { provider: 'axon-for-test', model: 'axon-for-test/gpt-6-astra', display_name: 'GPT-6 Astra(for test)', max_context_size: 400_000, max_input_size: 529_400, capabilities: ['thinking', 'tool_use'], support_efforts: ['low', 'high'] },
    // Same display name, its own row and its own draft.
    { provider: 'axon', model: 'axon/gpt-6-astra', display_name: 'GPT-6 Astra', max_context_size: 400_000, capabilities: ['thinking', 'tool_use'] },
    // A window the reserve leaves nothing to move in.
    { provider: 'axon-for-test', model: 'axon-for-test/gpt-6-astra-small', display_name: 'GPT-6 Astra Small', max_context_size: 32_768, capabilities: ['chat'] },
    // A model override that pins the point itself.
    { provider: 'axon-for-test', model: 'axon-for-test/gpt-6-astra-pinned', display_name: 'GPT-6 Astra Pinned', max_context_size: 400_000, overrides: { auto_compact: 300_000 }, capabilities: ['chat'] },
    // A context budget below the window, with an input limit above both.
    { provider: 'axon-for-test', model: 'axon-for-test/gpt-6-astra-budget', display_name: 'GPT-6 Astra Budget', max_context_size: 400_000, max_input_size: 529_400, context_budget: 200_000, capabilities: ['chat'] },
  ],
  providers: [
    {
      id: 'axon-for-test', type: 'openai', base_url: 'https://api.example.test/v1', has_api_key: true, status: 'connected',
      default_model: 'axon-for-test/gpt-6-astra',
      models: ['axon-for-test/gpt-6-astra', 'axon-for-test/gpt-6-astra-small', 'axon-for-test/gpt-6-astra-pinned', 'axon-for-test/gpt-6-astra-budget'],
    },
    {
      id: 'axon', type: 'openai', base_url: 'https://api.example.test/v1', has_api_key: true, status: 'connected',
      models: ['axon/gpt-6-astra'],
    },
  ],
  auth: { ready: true, providers_count: 2, default_model: 'axon-for-test/gpt-6-astra', managed_provider: null },
  workspaces: [
    { id: WSID, root: 'C:/fixture/workshop', name: 'workshop', created_at: new Date(Date.now() - 7_200_000).toISOString(), last_opened_at: new Date().toISOString(), session_count: 0, pinned: false },
  ],
  sessions: [],
  snapshots: {},
};
