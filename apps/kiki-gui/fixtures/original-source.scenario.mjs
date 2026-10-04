/**
 * original-source — the connections page showing where a connection's sign-in
 * comes from, and what happens when the machine's own sign-in is not in the
 * state we hoped.
 *
 * Three situations a person actually meets, all answered by the fixture's OAuth
 * RPC mock so no real machine, home directory or token is involved:
 *
 *   - ChatGPT is already attached to the sign-in on this machine, stored as a
 *     plain file. The row says so and offers to let go, in terms that do not
 *     claim Codex was signed out.
 *   - Grok Build's machine sign-in has been replaced with a different account.
 *     That is not the same as "unreadable", and the two need opposite responses,
 *     so the seeded answers cover both.
 *   - Kimi Code has no machine counterpart at all, and the page must not offer
 *     one — the reuse path exists only for Codex and Grok.
 *
 * The account ids are the fixture's own. The connect path refuses an account
 * that no longer matches, which is the behaviour worth photographing: the page
 * cannot adopt a credential nobody was shown.
 */

import base from './settings.scenario.mjs';

const KIMI_MODELS = [
  { provider: 'managed:kimi-code', model: 'kimi-code/kimi-k2', display_name: 'Kimi K2', max_context_size: 262144, capabilities: ['chat', 'reasoning'] },
];
const CODEX_MODELS = [
  { provider: 'managed:openai-codex', model: 'openai-codex/gpt-5-codex', display_name: 'GPT-5 Codex', max_context_size: 400000, capabilities: ['chat', 'reasoning'] },
];
const GROK_MODELS = [
  { provider: 'managed:grok-build', model: 'grok-build/grok-code', display_name: 'Grok Code', max_context_size: 256000, capabilities: ['chat'] },
];

export default {
  ...base,
  models: [...base.models, ...KIMI_MODELS, ...CODEX_MODELS, ...GROK_MODELS],
  providers: [
    ...base.providers,
    {
      id: 'managed:kimi-code', type: 'kimi', base_url: 'https://api.kimi.example.test/coding/v1',
      has_api_key: false, status: 'connected', default_model: 'kimi-code/kimi-k2',
      models: ['kimi-code/kimi-k2'],
    },
    {
      // Attached to the sign-in this machine already holds for Codex.
      id: 'managed:openai-codex', type: 'openai', base_url: 'https://chatgpt.example.test/backend-api/codex',
      has_api_key: false, status: 'connected', models: ['openai-codex/gpt-5-codex'],
    },
  ],
  oauthMethods: [
    {
      id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai',
      signed_in: true, connection_state: 'ready', account: { state: 'known', id: 'dev@example.test' },
    },
    {
      id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses',
      signed_in: true, connection_state: 'ready', account: { state: 'known', id: 'dev@example.test' },
      auth_source: {
        kind: 'local_original', home_dir: '/home/dev/.codex', storage_backend: 'keyring', source_state: 'refresh_required',
      },
    },
    {
      // Not a connection yet: this is the one the add flow offers, so the page
      // can show a machine credential before anything depends on it.
      id: 'grok-build', label: 'Grok Build', provider: 'managed:grok-build', protocol: 'openai',
      signed_in: false, connection_state: 'signed_out', account: { state: 'unknown' },
    },
  ],
  // What this machine holds. Codex is attached and in the system keyring, due
  // for renewal. Grok's default directory holds a usable credential nobody is
  // attached to; a second directory on the same machine holds one belonging to
  // a different account, which is the refusal worth photographing.
  oauthOriginal: {
    'openai-codex': {
      provider: 'openai-codex', home_dir: '/home/dev/.codex', storage_backend: 'keyring',
      state: 'refresh_required', account: { state: 'known', id: 'dev@example.test' }, can_connect: true,
    },
    'grok-build': {
      provider: 'grok-build', home_dir: '/home/dev/.grok', storage_backend: 'encrypted',
      state: 'ready', account: { state: 'known', id: 'team@example.test' }, can_connect: true,
    },
    'grok-build@/srv/agent-home/.grok': {
      provider: 'grok-build', home_dir: '/srv/agent-home/.grok', storage_backend: 'file',
      state: 'account_changed', account: { state: 'known', id: 'other@example.test' },
      can_connect: false, reason: 'credential on disk belongs to another account',
    },
  },
  config: {
    ...base.config,
    providers: {
      ...base.config.providers,
      'managed:kimi-code': { type: 'kimi', has_api_key: false },
      'managed:openai-codex': { type: 'openai', has_api_key: false },
      'managed:grok-build': { type: 'openai', has_api_key: false },
    },
  },
  auth: { ready: true, providers_count: 3, default_model: 'kimi-code/kimi-k2', managed_provider: null },
};
