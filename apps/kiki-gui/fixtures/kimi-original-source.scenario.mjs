/**
 * kimi-original-source — reusing the sign-in Kimi Code already has on this
 * machine, from the add-connection flow.
 *
 * Kimi Code keeps a credential slot, not an account identity: the machine's
 * answer is "a sign-in is there", without an account id to name. The check
 * says exactly that, the attach goes without an expected account id, and the
 * row reads back where the connection's sign-in now comes from.
 *
 * Everything here is the fixture's own seed answered by the OAuth RPC mock;
 * no real machine, home directory or token is involved.
 */

import base from './settings.scenario.mjs';

const KIMI_MODELS = [
  { provider: 'managed:kimi-code', model: 'kimi-code/kimi-k2', display_name: 'Kimi K2', max_context_size: 262144, capabilities: ['chat', 'reasoning'] },
];

export default {
  ...base,
  models: [...base.models, ...KIMI_MODELS],
  // No connection for Kimi Code yet: the add flow is where one is made, so
  // the provider exists in config but not in the page's list.
  oauthMethods: [
    {
      id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai',
      signed_in: false, connection_state: 'signed_out', account: { state: 'unknown' },
    },
  ],
  // What this machine holds for Kimi Code: a usable sign-in in its default
  // directory, in a plain file, with no account id to name.
  oauthOriginal: {
    'kimi-code': {
      provider: 'kimi-code', home_dir: '/home/dev/.kimi-code', storage_backend: 'file',
      state: 'ready', account: { state: 'unknown' }, can_connect: true,
    },
  },
  config: {
    ...base.config,
    providers: {
      ...base.config.providers,
      'managed:kimi-code': { type: 'kimi', has_api_key: false },
    },
  },
  auth: { ready: true, providers_count: 2, default_model: 'fixture/kiki-pro', managed_provider: null },
};
