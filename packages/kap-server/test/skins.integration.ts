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
        headers: { ...request.headers, authorization: `Bearer ${r.authTokenService.getToken()}` },
      });
    },
  };
}

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
});
