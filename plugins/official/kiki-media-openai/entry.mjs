import manifest from './kimi.plugin.json' with { type: 'json' };
import { adapters } from './adapters.mjs';

export function register(api) {
  for (const definition of manifest['x-kiki'].mediaProviders) {
    const adapter = adapters[definition.id];
    if (!adapter) throw new Error(`Missing media adapter: ${definition.id}`);
    const properties = manifest['x-kiki'].settings.schema.properties;
    const defaults = Object.fromEntries(Object.entries(properties).filter(([, value]) => value.default !== undefined).map(([key, value]) => [key, value.default]));
    const wrapped = {};
    for (const method of ['describe', 'submit', 'poll', 'cancel', 'voices']) {
      if (typeof adapter[method] !== 'function') continue;
      wrapped[method] = (input, context) => {
        const settings = { ...defaults, ...context.settings };
        if (method === 'submit') {
          const missing = (manifest['x-kiki'].settings.schema.required ?? []).find((key) => !settings[key] && !(settings.connectionId && ['apiKey', 'baseUrl'].includes(key)));
          if (missing) return Promise.resolve({ state: 'failed', artifacts: [], error: { code: 'needs_configuration', message: `Configure ${missing} in this provider plugin`, submission: 'not_sent' } });
        }
        return adapter[method](input, { ...context, settings });
      };
    }
    api.registerMediaProvider(definition, wrapped);
  }
}
