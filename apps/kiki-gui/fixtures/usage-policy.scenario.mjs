/**
 * usage-policy — Settings › Models with the model-identity usage layer on.
 *
 * One model carries a shared set of values and a main-agent branch that
 * differs on two of them, plus the resolved projection the server reports, so
 * the editor can be read as it will actually behave: shared first, then the
 * main agent's differences against what it inherits.
 */

const WSID = 'wd_fixture_usage_0001';

export default {
  config: {
    default_provider: 'deepseek',
    default_model: 'deepseek/deepseek-chat',
    default_permission_mode: 'manual',
    providers: {
      deepseek: { type: 'openai', base_url: 'https://api.deepseek.com/v1', has_api_key: true },
      'managed:github-copilot': { type: 'openai', has_api_key: false },
    },
    subagent: { defaultModel: 'deepseek/deepseek-chat' },
    loop_control: { autoCompact: '85%' },
  },
  models: [
    {
      provider: 'managed:github-copilot',
      model: 'managed:github-copilot/claude-sonnet-4.5',
      display_name: 'Claude Sonnet 4.5',
      max_context_size: 200_000,
      auto_compact: 160_000,
      context_budget: 180_000,
      capabilities: ['thinking', 'image_in', 'tool_use'],
      support_efforts: ['low', 'medium', 'high'],
      effective_parameters: { thinking_effort: 'medium', service_tier: 'auto', max_completion_tokens: 8192 },
      parameter_sources: {
        thinking_effort: '[models.*.parameters]',
        service_tier: '[providers.*.defaults]',
        max_completion_tokens: '[models.*.parameters]',
      },
      // The main agent runs heavier than everything else that uses this model:
      // two differences, and the server resolves them for us.
      usage: {
        main: { thinking_effort: 'high', auto_compact: 120_000, context_budget: 160_000 },
        independent: { thinking_effort: 'off' },
      },
      usage_effective: {
        main: { thinking_effort: 'high', service_tier: 'auto', auto_compact: 120_000, context_budget: 160_000, max_completion_tokens: 8192 },
        sub: { thinking_effort: 'medium', service_tier: 'auto', auto_compact: 160_000, context_budget: 180_000, max_completion_tokens: 8192 },
        independent: { thinking_effort: 'off', service_tier: 'auto', auto_compact: 160_000, context_budget: 180_000, max_completion_tokens: 8192 },
      },
      usage_sources: {
        main: {
          thinking_effort: '[models.*.usage.main]',
          service_tier: '[providers.*.defaults]',
          auto_compact: '[models.*.usage.main]',
          context_budget: '[models.*.context_budget]',
          max_completion_tokens: '[models.*.parameters]',
        },
        sub: { thinking_effort: '[models.*.parameters]', auto_compact: '[models.*.auto_compact]' },
        independent: { thinking_effort: '[models.*.usage.independent]', auto_compact: '[models.*.auto_compact]' },
      },
    },
    { provider: 'deepseek', model: 'deepseek/deepseek-chat', display_name: 'DeepSeek V3.2', max_context_size: 128_000, capabilities: ['tool_use'], support_efforts: [] },
  ],
  providers: [
    { id: 'managed:github-copilot', type: 'openai', base_url: 'https://api.githubcopilot.com', has_api_key: false, status: 'connected', models: ['managed:github-copilot/claude-sonnet-4.5'] },
    { id: 'deepseek', type: 'openai', base_url: 'https://api.deepseek.com/v1', has_api_key: true, status: 'connected', default_model: 'deepseek/deepseek-chat', models: ['deepseek/deepseek-chat'] },
  ],
  auth: { ready: true, providers_count: 2, default_model: 'deepseek/deepseek-chat', managed_provider: null },
  workspaces: [
    { id: WSID, root: 'C:/fixture/workshop', name: 'workshop', created_at: new Date(Date.now() - 7_200_000).toISOString(), last_opened_at: new Date().toISOString(), session_count: 0, pinned: false },
  ],
  sessions: [],
  snapshots: {},
};
