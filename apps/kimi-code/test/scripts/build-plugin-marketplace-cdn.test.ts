import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pluginMarketplaceEnvironment } from '../../scripts/plugin-marketplace-environment.mjs';

const appRoot = resolve(import.meta.dirname, '../..');

describe('independent plugin marketplace development', () => {
  it('delegates packaging and serving to the plugin repository, not the old publisher', async () => {
    const manifest = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf8'));
    expect(manifest.scripts['build:plugin-marketplace']).toBe('npm --prefix ../../../kiki-plugins run build');
    expect(manifest.scripts['dev:plugin-marketplace']).toBe('npm --prefix ../../../kiki-plugins run dev');
    const dev = await readFile(resolve(appRoot, 'scripts/dev.mjs'), 'utf8');
    expect(dev).not.toContain('dev-plugin-marketplace-server');
    expect(dev).not.toContain('startPluginMarketplaceServer');
  });

  it('lets the Host choose its published default without starting a local source publisher', () => {
    expect(pluginMarketplaceEnvironment({ EXAMPLE_SETTING: 'preserved' })).toEqual({ EXAMPLE_SETTING: 'preserved' });
  });

  it('preserves an inherited catalog override and removes the retired automatic-server marker', () => {
    const original = { KIKI_PLUGIN_MARKETPLACE_URL: 'http://127.0.0.1:12345/marketplace.json', KIKI_PLUGIN_MARKETPLACE_FROM_DEV_SERVER: '1' };
    expect(pluginMarketplaceEnvironment(original)).toEqual({ KIKI_PLUGIN_MARKETPLACE_URL: original.KIKI_PLUGIN_MARKETPLACE_URL });
    expect(original.KIKI_PLUGIN_MARKETPLACE_FROM_DEV_SERVER).toBe('1');
  });

  it('uses an explicit development catalog first, while a blank override preserves the inherited choice', () => {
    const original = { KIKI_PLUGIN_MARKETPLACE_URL: 'https://example.test/catalog.json', KIKI_DEV_MARKETPLACE_URL: ' http://127.0.0.1:12345/marketplace.json ' };
    expect(pluginMarketplaceEnvironment(original).KIKI_PLUGIN_MARKETPLACE_URL).toBe('http://127.0.0.1:12345/marketplace.json');
    expect(pluginMarketplaceEnvironment({ ...original, KIKI_DEV_MARKETPLACE_URL: ' ' }).KIKI_PLUGIN_MARKETPLACE_URL).toBe(original.KIKI_PLUGIN_MARKETPLACE_URL);
  });
});
