/**
 * Fixture routes for the GUI entry contracts: shortcut preferences
 * (`/gui/shortcuts`), the models.dev directory (`/catalog/providers`,
 * `/providers:import_catalog`), and managed-account quota (`/oauth/usage`).
 * Validation and conflict rules are the production ones from
 * `@kiki/protocol`; scenario data may seed `catalogProviders` and
 * `oauthUsage` (keyed by provider id, or `default`).
 */

import { tsImport } from 'tsx/esm/api';

const shortcuts = await tsImport('../../../packages/protocol/src/shortcuts.ts', import.meta.url);

const DEFAULT_CATALOG = [
  { id: 'openrouter', name: 'OpenRouter', wire_type: 'openai', guessed: false, needs_base_url: false, rejected: false, reject_reason: null, env_key: 'OPENROUTER_API_KEY',
    models: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', max_context_size: 200000, reasoning: true }, { id: 'openai/gpt-5', name: 'GPT-5', max_context_size: 400000, reasoning: true }] },
  { id: 'groq', name: 'Groq', wire_type: 'openai', guessed: false, needs_base_url: false, rejected: false, reject_reason: null, env_key: 'GROQ_API_KEY',
    models: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', max_context_size: 131072, reasoning: false }] },
  { id: 'azure', name: 'Azure OpenAI', wire_type: 'openai', guessed: true, needs_base_url: true, rejected: false, reject_reason: null, env_key: 'AZURE_API_KEY',
    models: [{ id: 'gpt-4.1', name: 'GPT-4.1', max_context_size: 1047576, reasoning: false }] },
  { id: 'anthropic', name: 'Anthropic', wire_type: 'anthropic', guessed: false, needs_base_url: false, rejected: false, reject_reason: null, env_key: 'ANTHROPIC_API_KEY',
    models: [{ id: 'claude-opus-4-1', name: 'Claude Opus 4.1', max_context_size: 200000, reasoning: true }, { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', max_context_size: 200000, reasoning: true }, { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', max_context_size: 200000, reasoning: false }] },
  { id: 'amazon-bedrock', name: 'Amazon Bedrock', wire_type: null, guessed: false, needs_base_url: false, rejected: true, reject_reason: 'Uses AWS request signing, which this version cannot send.', env_key: null,
    models: [{ id: 'anthropic.claude-sonnet-4', max_context_size: 200000, reasoning: true }] },
  { id: 'google-vertex', name: 'Vertex AI', wire_type: 'vertexai', guessed: false, needs_base_url: true, rejected: false, reject_reason: null, env_key: 'GOOGLE_APPLICATION_CREDENTIALS',
    models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', max_context_size: 1048576, reasoning: true }] },
];

function catalogFor(server) {
  return structuredClone(server.scenario?.data.catalogProviders ?? DEFAULT_CATALOG);
}

/** Returns true when the route was handled. */
export function handleGuiEntries(server, res, path, query, body, method) {
  if (path === '/gui/shortcuts' || path === '/gui/shortcuts/reset') {
    const platform = shortcuts.shortcutPlatformSchema.safeParse(query.get('platform'));
    if (!platform.success) { server.envelope(res, null, 40001, 'platform is required'); return true; }
    server.shortcutPreferences ??= shortcuts.shortcutPreferencesSchema.parse(server.scenario?.data.shortcutPreferences ?? shortcuts.DEFAULT_SHORTCUT_PREFERENCES);
    const answer = (preferences) => ({
      preferences,
      bindings: shortcuts.resolveShortcutBindings(preferences, platform.data),
      conflicts: shortcuts.detectShortcutConflicts(preferences, platform.data),
    });
    const conflictsOf = (preferences) => shortcuts.shortcutPlatformSchema.options.flatMap((each) => shortcuts.detectShortcutConflicts(preferences, each));
    if (path === '/gui/shortcuts' && method === 'GET') { server.envelope(res, answer(server.shortcutPreferences)); return true; }
    if (path === '/gui/shortcuts' && method === 'PUT') {
      const parsed = shortcuts.shortcutWriteSchema.safeParse(body);
      if (!parsed.success) { server.envelope(res, null, 40001, 'Invalid shortcut preferences'); return true; }
      if (conflictsOf(parsed.data.preferences).length > 0) { server.envelope(res, null, 40001, 'Shortcut bindings conflict'); return true; }
      server.shortcutPreferences = parsed.data.preferences;
      server.envelope(res, answer(server.shortcutPreferences));
      return true;
    }
    if (path === '/gui/shortcuts/reset' && method === 'POST') {
      const target = shortcuts.shortcutResetSchema.parse(body ?? {});
      const next = target.platform === undefined && target.action === undefined
        ? shortcuts.shortcutPreferencesSchema.parse(shortcuts.DEFAULT_SHORTCUT_PREFERENCES)
        : shortcuts.resetShortcutPreferences(server.shortcutPreferences, target.platform, target.action);
      if (conflictsOf(next).length > 0) { server.envelope(res, null, 40001, 'Shortcut reset would conflict'); return true; }
      server.shortcutPreferences = next;
      server.envelope(res, answer(next));
      return true;
    }
  }
  if (path === '/catalog/providers' && method === 'GET') {
    if (server.scenario?.data.catalogError !== undefined) { server.envelope(res, null, 50301, server.scenario.data.catalogError); return true; }
    server.envelope(res, { items: catalogFor(server) });
    return true;
  }
  const catalogMatch = /^\/catalog\/providers\/([^/]+)$/.exec(path);
  if (catalogMatch !== null && method === 'GET') {
    const item = catalogFor(server).find((entry) => entry.id === decodeURIComponent(catalogMatch[1]));
    if (item === undefined) server.envelope(res, null, 40404, 'catalog provider not found');
    else server.envelope(res, item);
    return true;
  }
  if (path === '/providers:import_catalog' && method === 'POST') {
    const item = catalogFor(server).find((entry) => entry.id === body?.catalog_id);
    if (item === undefined) { server.envelope(res, null, 40404, 'catalog provider not found'); return true; }
    if (item.rejected) { server.envelope(res, null, 40001, item.reject_reason ?? 'This provider cannot be imported'); return true; }
    if (item.needs_base_url && (typeof body.base_url !== 'string' || body.base_url.trim() === '')) {
      server.envelope(res, null, 40001, 'base_url is required for this provider');
      return true;
    }
    const id = body.id ?? item.id;
    const provider = {
      id, type: item.wire_type ?? 'openai', base_url: body.base_url ?? `https://api.${item.id}.example.test/v1`,
      has_api_key: typeof body.api_key === 'string' && body.api_key !== '', status: 'connected',
      models: item.models.map((model) => `${id}/${model.id}`),
    };
    server.providers = [...server.providers.filter((entry) => entry.id !== id), provider];
    server.models = [...server.models.filter((entry) => entry.provider_id !== id), ...item.models.map((model) => ({
      id: `${id}/${model.id}`, provider_id: id, remote_id: model.id, display_name: model.name ?? model.id, max_context_size: model.max_context_size,
    }))];
    server.envelope(res, { provider, models_imported: item.models.length });
    return true;
  }
  if (path === '/oauth/usage' && method === 'GET') {
    const usage = server.scenario?.data.oauthUsage ?? {};
    const provider = query.get('provider') ?? 'default';
    const result = usage[provider] ?? usage.default ?? { kind: 'error', message: 'Not signed in to a managed account.' };
    server.envelope(res, result);
    return true;
  }
  return false;
}
