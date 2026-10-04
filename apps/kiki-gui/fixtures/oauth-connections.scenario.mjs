/**
 * oauth-connections — the connections page as one managed object: an account
 * sign-in, a hosted API and a local server, each a row that says how it is
 * reached and whether it works. The states are the ones a person actually
 * meets, in the server's own words — a working account, one whose credential
 * the provider will no longer accept, and a key connection beside them so the
 * two kinds of connection stay distinguishable.
 *
 * The device flow is served by the fixture's OAuth RPC mock: `oauthStart`
 * hands back a pending flow with a code, and the proof walker drives it
 * through the GUI — open the page, add a connection, sign in, read the code —
 * so the screenshots show the real pending card rather than a mock of it. No
 * network, no credentials, no real provider.
 */

import base from './settings.scenario.mjs';

const KIMI_MODELS = [
  { provider: 'managed:kimi-code', model: 'kimi-code/kimi-k2', display_name: 'Kimi K2', max_context_size: 262144, capabilities: ['chat', 'reasoning'] },
  { provider: 'managed:kimi-code', model: 'kimi-code/kimi-k2-turbo', display_name: 'Kimi K2 Turbo', max_context_size: 262144, capabilities: ['chat'] },
];
const GROK_MODELS = [
  { provider: 'managed:grok-build', model: 'grok-build/grok-code', display_name: 'Grok Code', max_context_size: 256000, capabilities: ['chat', 'reasoning'] },
];

export default {
  ...base,
  models: [...base.models, ...KIMI_MODELS, ...GROK_MODELS],
  providers: [
    ...base.providers,
    {
      id: 'managed:kimi-code', type: 'kimi', base_url: 'https://api.kimi.example.test/coding/v1',
      has_api_key: false, status: 'connected', default_model: 'kimi-code/kimi-k2',
      models: ['kimi-code/kimi-k2', 'kimi-code/kimi-k2-turbo'],
    },
    {
      // Signed in, but the provider will not accept this credential again: the
      // same connection, recovered in place rather than added as a new one.
      id: 'managed:grok-build', type: 'openai', base_url: 'https://cli-chat-proxy.grok.example.test/v1',
      has_api_key: false, status: 'unconfigured', models: [],
    },
  ],
  oauthMethods: [
    { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: true, connection_state: 'ready', account: { state: 'known', id: 'dev@example.test' } },
    { id: 'grok-build', label: 'Grok Build', provider: 'managed:grok-build', protocol: 'openai', signed_in: true, connection_state: 'reconnect_required', account: { state: 'known', id: 'team@example.test' } },
    { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses', signed_in: false, account: { state: 'unknown' }, quota: { state: 'unknown' } },
  ],
  // needing a base URL, and one this version cannot reach.
  config: {
    ...base.config,
    providers: {
      ...base.config.providers,
      'managed:kimi-code': { type: 'kimi', has_api_key: false },
      'managed:grok-build': { type: 'openai', has_api_key: false },
    },
  },
  // The device flow the walker drives: a code, a verification page, and a
  // window long enough that the countdown is not the thing under test.
  oauthStart: {
    flow_id: 'oauth_fixture_codex',
    provider: 'managed:openai-codex',
    status: 'pending',
    verification_uri: 'https://auth.example.test/device',
    verification_uri_complete: 'https://auth.example.test/device?user_code=WXYZ-1234',
    user_code: 'WXYZ-1234',
    expires_in: 900,
    expires_at: new Date(Date.now() + 900_000).toISOString(),
    interval: 5,
  },
  auth: { ready: true, providers_count: 3, default_model: 'kimi-code/kimi-k2', managed_provider: null },
};
