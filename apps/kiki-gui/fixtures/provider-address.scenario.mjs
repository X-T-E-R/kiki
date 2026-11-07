/**
 * provider-address — no connections yet, and a directory entry whose model
 * display name shares no token with the provider id or the model id. The
 * request address is the catalog's resolved endpoint, not a host built from
 * the id.
 */

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
  catalogProviders: [
    {
      id: 'acme',
      name: 'Acme',
      wire_type: 'openai',
      guessed: false,
      needs_base_url: false,
      base_url: 'https://api.openai.com/v1',
      rejected: false,
      reject_reason: null,
      env_key: 'OPENAI_API_KEY',
      models: [{ id: 'zz-remote', name: 'Northwind Writer', max_context_size: 128000, reasoning: false }],
    },
    {
      id: 'azure',
      name: 'Azure OpenAI',
      wire_type: 'openai',
      guessed: true,
      needs_base_url: true,
      rejected: false,
      reject_reason: null,
      env_key: 'AZURE_API_KEY',
      models: [{ id: 'gpt-4.1', name: 'GPT-4.1', max_context_size: 1047576, reasoning: false }],
    },
    {
      id: 'gemini',
      name: 'Google Gemini',
      wire_type: 'google-genai',
      guessed: false,
      needs_base_url: false,
      rejected: false,
      reject_reason: null,
      env_key: 'GEMINI_API_KEY',
      models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', max_context_size: 1048576, reasoning: true }],
    },
  ],
};
