import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GetSkinResponse, ListSkinsResponse } from '@kiki/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
}

interface AppLike {
  inject: (req: unknown) => Promise<InjectResponse>;
}

function appOf(r: RunningServer): AppLike {
  const app = r.app as unknown as AppLike;
  return {
    inject(req: unknown): Promise<InjectResponse> {
      const request = req as { headers?: Record<string, string> };
      return app.inject({
        ...request,
        headers: { ...request.headers, authorization: `Bearer ${r.localOwnerToken}` },
      });
    },
  };
}

const PLUGIN_THEME_SKIN = {
  kind: 'kiki-skin',
  version: 1,
  name: 'Fixture Sea Glass',
  description: 'A theme contributed by a plugin',
  author: 'tests',
  variants: {
    light: { colors: { paper: '#f2fbfa', accent: '#0f766e' } },
    dark: { colors: { paper: '#08211f', accent: '#5eead4' } },
  },
};

const VALID_SKIN = {
  kind: 'kiki-skin',
  version: 1,
  name: 'Fixture Ocean',
  description: 'A test skin',
  author: 'tests',
  variants: {
    light: { colors: { paper: '#eef6ff', accent: '#0066cc' } },
    dark: { colors: { paper: '#0b1420', accent: '#66bbff' } },
  },
};

describe('server-v2 skin routes', () => {
  let home: string | undefined;
  let themesDir = '';
  let server: RunningServer | undefined;
  const pluginDirs: string[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-server-skins-'));
    themesDir = join(home, 'themes');
    await mkdir(themesDir, { recursive: true });
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    for (const dir of pluginDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      home = undefined;
    }
  });

  async function list(): Promise<ListSkinsResponse> {
    const res = await appOf(server as RunningServer).inject({ method: 'GET', url: '/api/skins' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { code: number; data: ListSkinsResponse };
    expect(body.code).toBe(0);
    return body.data;
  }

  async function get(skinId: string): Promise<{ statusCode: number; code: number; data?: GetSkinResponse }> {
    const res = await appOf(server as RunningServer).inject({
      method: 'GET',
      url: `/api/skins/${skinId}`,
    });
    const body = res.json() as { code: number; data: GetSkinResponse };
    return { statusCode: res.statusCode, code: body.code, data: body.data };
  }

  async function post(path: string, payload: unknown = {}): Promise<{ code: number; data: unknown }> {
    const res = await appOf(server as RunningServer).inject({
      method: 'POST',
      url: `/api${path}`,
      payload,
    });
    const body = res.json() as { code: number; data: unknown };
    return { code: body.code, data: body.data };
  }

  async function writeThemePlugin(enabled: boolean): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kiki-server-skin-plugin-'));
    pluginDirs.push(dir);
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'skin-plugin',
        version: '2.1.0',
        description: 'A plugin that ships one GUI theme',
        'x-kiki': {
          engines: { kiki: '^0.4.0' },
          themes: [
            {
              schemaVersion: 1,
              id: 'sea-glass',
              label: 'Sea Glass',
              base: 'light',
              path: './sea-glass.json',
            },
          ],
        },
      }),
      'utf-8',
    );
    await writeFile(join(dir, 'sea-glass.json'), JSON.stringify(PLUGIN_THEME_SKIN), 'utf-8');
    const preview = await post('/plugins:preview', { source: dir });
    expect(preview.code).toBe(0);
    const fingerprint = (preview.data as { fingerprint: string }).fingerprint;
    const installed = await post('/plugins', { source: dir, fingerprint, consent: true });
    expect(installed.code).toBe(0);
    if (enabled) {
      expect((await post('/plugins/skin-plugin:enable')).code).toBe(0);
    }
    return dir;
  }

  it('lists a valid skin file with its declared variants', async () => {
    await writeFile(join(themesDir, 'ocean.json'), JSON.stringify(VALID_SKIN), 'utf-8');
    const data = await list();
    expect(data.directory).toBe(themesDir);
    expect(data.items).toEqual([
      {
        id: 'ocean',
        name: 'Fixture Ocean',
        description: 'A test skin',
        author: 'tests',
        variants: ['light', 'dark'],
      },
    ]);
    expect(data.skipped).toEqual([]);
  });

  it('returns an empty list when the themes directory does not exist', async () => {
    await rm(themesDir, { recursive: true, force: true });
    const data = await list();
    expect(data.items).toEqual([]);
    expect(data.skipped).toEqual([]);
  });

  it('skips a TUI color theme in the same directory and explains why', async () => {
    await writeFile(
      join(themesDir, 'ember.json'),
      JSON.stringify({ name: 'ember', colors: { primary: '#83A598' } }),
      'utf-8',
    );
    await writeFile(join(themesDir, 'ocean.json'), JSON.stringify(VALID_SKIN), 'utf-8');
    const data = await list();
    expect(data.items.map((item) => item.id)).toEqual(['ocean']);
    expect(data.skipped).toEqual([
      { file: 'ember.json', reason: 'not a kiki-skin file (missing kind)' },
    ]);
  });

  it('skips malformed JSON without failing the listing', async () => {
    await writeFile(join(themesDir, 'broken.json'), '{ not json', 'utf-8');
    await writeFile(join(themesDir, 'ocean.json'), JSON.stringify(VALID_SKIN), 'utf-8');
    const data = await list();
    expect(data.items.map((item) => item.id)).toEqual(['ocean']);
    expect(data.skipped).toHaveLength(1);
    expect(data.skipped[0]?.file).toBe('broken.json');
  });

  it('skips a filename that is not a usable skin id', async () => {
    await writeFile(join(themesDir, 'Not A Skin.json'), JSON.stringify(VALID_SKIN), 'utf-8');
    const data = await list();
    expect(data.items).toEqual([]);
    expect(data.skipped).toEqual([
      { file: 'Not A Skin.json', reason: 'filename is not a valid skin id' },
    ]);
  });

  it('reads one skin and reports the tokens it dropped', async () => {
    await writeFile(
      join(themesDir, 'ocean.json'),
      JSON.stringify({
        ...VALID_SKIN,
        variants: {
          light: { colors: { paper: '#eef6ff', accent: 'not-a-color', mystery: '#ffffff' } },
        },
      }),
      'utf-8',
    );
    const res = await appOf(server as RunningServer).inject({
      method: 'GET',
      url: '/api/skins/ocean',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { code: number; data: GetSkinResponse };
    expect(body.code).toBe(0);
    expect(body.data.skin.variants.light?.colors).toEqual({ paper: '#eef6ff' });
    expect(body.data.warnings).toEqual([
      'variants.light.colors.accent: invalid value',
      'variants.light.colors.mystery: unknown token',
    ]);
  });

  it('round-trips the optional accentInk color slot', async () => {
    await writeFile(
      join(themesDir, 'ocean.json'),
      JSON.stringify({
        ...VALID_SKIN,
        variants: {
          light: { colors: { accent: '#0066cc', accentInk: '#003f80' } },
        },
      }),
      'utf-8',
    );
    const data = await list();
    expect(data.items.map((item) => item.id)).toEqual(['ocean']);
    expect(data.skipped).toEqual([]);

    const res = await appOf(server as RunningServer).inject({
      method: 'GET',
      url: '/api/skins/ocean',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { code: number; data: GetSkinResponse };
    expect(body.data.skin.variants.light?.colors).toEqual({
      accent: '#0066cc',
      accentInk: '#003f80',
    });
    expect(body.data.warnings).toEqual([]);
  });

  it('reports an unusable accentInk value as a dropped token', async () => {
    await writeFile(
      join(themesDir, 'ocean.json'),
      JSON.stringify({
        ...VALID_SKIN,
        variants: {
          light: { colors: { accent: '#0066cc', accentInk: 'inherit' } },
        },
      }),
      'utf-8',
    );
    const res = await appOf(server as RunningServer).inject({
      method: 'GET',
      url: '/api/skins/ocean',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { code: number; data: GetSkinResponse };
    expect(body.code).toBe(0);
    expect(body.data.skin.variants.light?.colors).toEqual({ accent: '#0066cc' });
    expect(body.data.warnings).toEqual(['variants.light.colors.accentInk: invalid value']);
  });

  it('404s an unknown skin', async () => {
    const res = await appOf(server as RunningServer).inject({
      method: 'GET',
      url: '/api/skins/nope',
    });
    const body = res.json() as { code: number };
    expect(body.code).toBe(40409);
  });

  it('rejects a traversal attempt in the skin id', async () => {
    await writeFile(join(home as string, 'secret.json'), JSON.stringify(VALID_SKIN), 'utf-8');
    for (const id of ['..%2Fsecret', '%2E%2E%2Fsecret', '..', 'sub%2Focean']) {
      const res = await appOf(server as RunningServer).inject({
        method: 'GET',
        url: `/api/skins/${id}`,
      });
      const body = res.json() as { code: number };
      expect(body.code, id).not.toBe(0);
    }
  });

  it('refuses a skin file that carries raw CSS alongside the tokens', async () => {
    await writeFile(
      join(themesDir, 'sneaky.json'),
      JSON.stringify({ ...VALID_SKIN, css: 'body { display: none }' }),
      'utf-8',
    );
    const data = await list();
    expect(data.items).toEqual([]);
    expect(data.skipped).toHaveLength(1);
  });

  it('merges an enabled plugin theme into the list and reads it back', async () => {
    await writeThemePlugin(true);
    await writeFile(join(themesDir, 'ocean.json'), JSON.stringify(VALID_SKIN), 'utf-8');

    const data = await list();
    expect(data.items.map((item) => item.id)).toEqual(['ocean', 'skin-plugin:sea-glass']);
    expect(data.items[1]).toEqual({
      id: 'skin-plugin:sea-glass',
      name: 'Fixture Sea Glass',
      description: 'A theme contributed by a plugin',
      author: 'tests',
      variants: ['light', 'dark'],
      plugin: { id: 'skin-plugin', version: '2.1.0' },
    });
    expect(data.directory).toBe(themesDir);
    expect(data.skipped).toEqual([]);

    const detail = await get('skin-plugin:sea-glass');
    expect(detail.code).toBe(0);
    expect(detail.data?.plugin).toEqual({ id: 'skin-plugin', version: '2.1.0' });
    expect(detail.data?.skin.id).toBe('skin-plugin:sea-glass');
    expect(detail.data?.skin.name).toBe('Fixture Sea Glass');
    expect(detail.data?.skin.variants.dark?.colors?.accent).toBe('#5eead4');
    expect(detail.data?.warnings).toEqual([]);
  });

  it('hides the themes of a plugin that is installed but disabled', async () => {
    await writeThemePlugin(false);
    const data = await list();
    expect(data.items).toEqual([]);
    expect((await get('skin-plugin:sea-glass')).code).toBe(40409);
  });

  it('404s a plugin skin whose plugin or theme does not exist', async () => {
    await writeThemePlugin(true);
    expect((await get('skin-plugin:nope')).code).toBe(40409);
    expect((await get('nope:sea-glass')).code).toBe(40409);
  });

  it('keeps plugin skins off the filesystem and rejects a traversal through the plugin id', async () => {
    await writeFile(join(home as string, 'secret.json'), JSON.stringify(VALID_SKIN), 'utf-8');
    const data = await list();
    expect(data.items).toEqual([]);
    for (const id of ['..%2Fsecret:sea-glass', 'skin-plugin:..%2Fsecret', 'skin-plugin%3Asea-glass%3Aextra']) {
      expect((await get(id)).code, id).not.toBe(0);
    }
  });
});
