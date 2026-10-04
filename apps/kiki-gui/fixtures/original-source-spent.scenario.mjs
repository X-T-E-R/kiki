/**
 * original-source-spent — a connection that is attached to a credential this
 * machine no longer backs.
 *
 * The machine's copy of the sign-in belongs to a different account than the one
 * the connection was made with, so the credential the connection points at is
 * spent: the server reports it as a sign-in that must be replaced, and the row
 * says so. The panel beside it has two jobs that this scenario exists to catch:
 *
 *   - it must not go on describing the credential as working, or promising the
 *     renewal it can no longer perform
 *   - it must keep the way back, because a spent credential is replaced by
 *     checking the machine, not by a new card or a new connection
 *
 * Answered entirely by the fixture's OAuth RPC mock. No real machine, home
 * directory or token is involved.
 */

import base from './settings.scenario.mjs';

const CODEX_MODELS = [
  { provider: 'managed:openai-codex', model: 'openai-codex/gpt-5-codex', display_name: 'GPT-5 Codex', max_context_size: 400000, capabilities: ['chat', 'reasoning'] },
];

export default {
  ...base,
  models: [...base.models, ...CODEX_MODELS],
  providers: [
    ...base.providers,
    {
      id: 'managed:openai-codex', type: 'openai', base_url: 'https://chatgpt.example.test/backend-api/codex',
      has_api_key: false, status: 'unconfigured', models: ['openai-codex/gpt-5-codex'],
    },
  ],
  oauthMethods: [
    {
      // Attached to the machine's copy, which has been replaced since.
      id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses',
      signed_in: true, connection_state: 'reconnect_required',
      account: { state: 'known', id: 'dev@example.test' },
      auth_source: {
        kind: 'local_original', home_dir: '/home/dev/.codex', storage_backend: 'file', source_state: 'account_changed',
      },
    },
  ],
  oauthOriginal: {
    'openai-codex': {
      provider: 'openai-codex', home_dir: '/home/dev/.codex', storage_backend: 'file',
      state: 'account_changed', account: { state: 'known', id: 'other@example.test' },
      can_connect: false, reason: 'credential on disk belongs to another account',
    },
  },
  config: {
    ...base.config,
    providers: {
      ...base.config.providers,
      'managed:openai-codex': { type: 'openai', has_api_key: false },
    },
  },
  auth: { ready: true, providers_count: 1, default_model: null, managed_provider: null },
};
