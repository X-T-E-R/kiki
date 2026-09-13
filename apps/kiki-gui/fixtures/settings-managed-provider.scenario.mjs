/**
 * settings-managed-provider — the settings demo extended with the real-world
 * OAuth-managed colon-id provider (`managed:kimi-code`, see packages/oauth).
 * The kap-server replace route validates `new_id` only on an actual rename,
 * so this provider stays editable under its unchanged id; this scenario lets
 * screenshots prove the provider editor and the model-catalog row editor both
 * save it.
 */

import base from './settings.scenario.mjs';

export default {
  ...base,
  config: {
    ...base.config,
    providers: {
      ...base.config.providers,
      'managed:kimi-code': {
        type: 'kimi',
        has_api_key: false,
      },
    },
  },
  models: [
    ...base.models,
    {
      provider: 'managed:kimi-code',
      model: 'managed:kimi-code/kimi-k2',
      display_name: 'Kimi K2',
      max_context_size: 262144,
      capabilities: ['chat', 'reasoning'],
      support_efforts: ['low', 'high'],
    },
  ],
  providers: [
    ...base.providers,
    {
      id: 'managed:kimi-code',
      type: 'kimi',
      base_url: 'https://api.managed.example.test/v1',
      has_api_key: false,
      status: 'connected',
      default_model: 'managed:kimi-code/kimi-k2',
      models: ['managed:kimi-code/kimi-k2'],
    },
  ],
  auth: {
    ...base.auth,
    providers_count: 3,
    managed_provider: { name: 'managed:kimi-code', status: 'authenticated' },
  },
};
