import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('./kimi.plugin.json', import.meta.url), 'utf8'));

export function register(api) {
  const call = async (action, input, { settings, signal }) => {
    const response = await fetch(`${settings.controlPlane}/${action}`, { method: 'POST', body: JSON.stringify(input), signal });
    if (!response.ok) throw Error('Selected fixture account is unavailable');
    return response.json();
  };
  api.registerHarnessAccountSource(manifest['x-kiki'].harnessAccountSources[0], {
    list: (input, context) => call('list', input, context),
    prepare: (input, context) => call('prepare', input, context),
    release: async (input, context) => { await call('release', input, context); },
  });
}
