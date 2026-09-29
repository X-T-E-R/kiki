/**
 * models-page — Settings › Models & providers with three connections of the
 * three kinds: an OAuth account (GitHub Copilot, signed in), a hosted API
 * (DeepSeek, one failed fetch) and a local server (Ollama, no key). Models
 * carry a spread of capabilities and one global default, so the list, the
 * search, the detail (common vs Advanced) and the error row can be shown.
 */

const WSID = 'wd_fixture_000000000000';

export default {
  config: {
    default_provider: 'deepseek',
    default_model: 'deepseek/deepseek-chat',
    default_permission_mode: 'manual',
    providers: {
      deepseek: { type: 'openai', base_url: 'https://api.deepseek.com/v1', has_api_key: true },
      ollama: { type: 'openai', base_url: 'http://localhost:11434/v1', has_api_key: false },
      'managed:github-copilot': { type: 'openai', has_api_key: false },
      'managed:openai-codex': { type: 'openai_responses', has_api_key: false },
    },
    session_title: { model: 'ollama/qwen3-8b' },
    fast_model: 'ollama/qwen3-8b',
    subagent: { defaultModel: 'deepseek/deepseek-chat' },
    loop_control: { autoCompact: '85%' },
  },
  models: [
    { provider: 'deepseek', model: 'deepseek/deepseek-chat', display_name: 'DeepSeek V3.2', max_context_size: 128_000, capabilities: ['tool_use'], support_efforts: [] },
    { provider: 'deepseek', model: 'deepseek/deepseek-reasoner', display_name: 'DeepSeek Reasoner', max_context_size: 128_000, capabilities: ['thinking', 'tool_use'], support_efforts: ['low', 'high'], default_effort: 'high' },
    { provider: 'managed:github-copilot', model: 'managed:github-copilot/claude-sonnet-4.5', display_name: 'Claude Sonnet 4.5', max_context_size: 200_000, auto_compact: 160_000, capabilities: ['thinking', 'image_in', 'tool_use'], support_efforts: ['low', 'medium', 'high'] },
    { provider: 'managed:github-copilot', model: 'managed:github-copilot/gpt-5', display_name: 'GPT-5', max_context_size: 400_000, capabilities: ['thinking', 'image_in', 'tool_use'], support_efforts: ['low', 'medium', 'high'] },
    { provider: 'managed:github-copilot', model: 'managed:github-copilot/gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', max_context_size: 1_000_000, capabilities: ['thinking', 'image_in', 'tool_use', 'video_in', 'audio_in'] },
    { provider: 'ollama', model: 'ollama/qwen3-8b', display_name: 'Qwen3 8B', max_context_size: 32_768, capabilities: ['tool_use'] },
    { provider: 'ollama', model: 'ollama/llava-13b-vision-instruct-with-a-rather-long-local-tag', max_context_size: 8_192, capabilities: ['image_in'] },
    { provider: 'managed:openai-codex', model: 'managed:openai-codex/gpt-5-codex', display_name: 'GPT-5 Codex', max_context_size: 400_000, capabilities: ['thinking', 'tool_use'], support_efforts: ['low', 'medium', 'high'] },
    { provider: 'managed:kimi-code', model: 'managed:kimi-code/kimi-for-coding', display_name: 'Kimi for Coding', max_context_size: 262_144, capabilities: ['thinking', 'tool_use'] },
  ],
  providers: [
    { id: 'managed:github-copilot', type: 'openai', base_url: 'https://api.githubcopilot.com', has_api_key: false, status: 'connected', models: ['managed:github-copilot/claude-sonnet-4.5', 'managed:github-copilot/gpt-5', 'managed:github-copilot/gemini-2.5-pro'] },
    { id: 'managed:openai-codex', type: 'openai_responses', base_url: 'https://chatgpt.example.test/backend-api/codex', has_api_key: false, status: 'connected', models: ['managed:openai-codex/gpt-5-codex'] },
    { id: 'managed:kimi-code', type: 'kimi', base_url: 'https://api.kimi.example.test/coding/v1', has_api_key: false, status: 'connected', models: ['managed:kimi-code/kimi-for-coding'] },
    { id: 'deepseek', type: 'openai', base_url: 'https://api.deepseek.com/v1', has_api_key: true, status: 'error', default_model: 'deepseek/deepseek-chat', models: ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'] },
    { id: 'ollama', type: 'openai', base_url: 'http://localhost:11434/v1', has_api_key: false, status: 'connected', models: ['ollama/qwen3-8b', 'ollama/llava-13b-vision-instruct-with-a-rather-long-local-tag'] },
  ],
  oauthMethods: [
    { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: true,
      account: { state: 'known', id: 'dev@example.test' },
      quota: { state: 'known', label: 'Weekly limit', remaining: 38, unit: 'percent', reset_at: '2026-09-28T00:00:00Z' } },
    // Known account + absolute (count) quota.
    { id: 'github-copilot', label: 'GitHub Copilot', provider: 'managed:github-copilot', protocol: 'openai', signed_in: true,
      account: { state: 'known', id: 'octo-dev' },
      quota: { state: 'known', label: 'Premium interactions', remaining: 1240, unit: 'count', reset_at: '2026-10-01T00:00:00Z' } },
    // Known account, quota the server cannot read: no quota is shown (never 0).
    { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses', signed_in: true,
      account: { state: 'known', id: 'user-3f9c' }, quota: { state: 'unknown' } },
  ],
  // Last connection tests: Ollama passed, DeepSeek was refused. The Codex and
  // Copilot rows have none yet; a Copilot test succeeds, a DeepSeek test fails again.
  providerHealth: [
    { provider_id: 'ollama', model_id: 'ollama/qwen3-8b', ok: true, checked_at: Date.now() - 3 * 3_600_000, duration_ms: 186 },
    { provider_id: 'deepseek', model_id: 'deepseek/deepseek-chat', ok: false, checked_at: Date.now() - 120_000, duration_ms: 734,
      error_code: 'request_failed', http_status: 401, error: 'The test request failed (HTTP 401).' },
  ],
  providerTests: {
    deepseek: { model_id: 'deepseek/deepseek-chat', ok: false, duration_ms: 688, error_code: 'request_failed', http_status: 401, error: 'The test request failed (HTTP 401).' },
    'managed:github-copilot': { model_id: 'managed:github-copilot/claude-sonnet-4.5', ok: true, duration_ms: 1_240 },
  },
  providerTestDelayMs: 1_500,
  discoveredModels: [
    { provider_id: 'deepseek', fetched_at: null, attempted_at: Date.now() - 120_000, failure_reason: '401 Unauthorized — the API key was rejected.', models: [] },
  ],
  auth: { ready: true, providers_count: 4, default_model: 'deepseek/deepseek-chat', managed_provider: null },
  workspaces: [
    { id: WSID, root: 'C:/fixture/workshop', name: 'workshop', created_at: new Date(Date.now() - 7_200_000).toISOString(), last_opened_at: new Date().toISOString(), session_count: 0, pinned: false },
  ],
  sessions: [],
  snapshots: {},
};
