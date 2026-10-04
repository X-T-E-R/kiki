import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
}

interface AppLike {
  inject: (req: unknown) => Promise<InjectResponse>;
}

interface Envelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
}

function appOf(r: RunningServer): AppLike {
  const app = r.app as unknown as AppLike;
  return {
    inject(req: unknown): Promise<InjectResponse> {
      const request = req as { headers?: Record<string, string> };
      return app.inject({
        ...request,
        headers: {
          ...request.headers,
          authorization: `Bearer ${r.localOwnerToken}`,
        },
      });
    },
  };
}

function envelopeOf<T>(body: unknown): Envelope<T> {
  return body as Envelope<T>;
}

function getItem(api: AppLike, key: string) {
  return api.inject({ method: 'GET', url: `/api/gui/store/getItem?key=${key}` });
}

function setItem(api: AppLike, key: string, value: string) {
  return api.inject({
    method: 'POST',
    url: '/api/gui/store/setItem',
    payload: { key, value },
  });
}

describe('server-v2 gui store routes', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-gui-store-'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
  });

  it('getItem returns null when the file does not exist', async () => {
    const res = await getItem(appOf(server as RunningServer), 'theme');
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<{ value: string | null }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data?.value).toBeNull();
  });

  it('setItem then getItem round-trips and persists to gui.toml', async () => {
    const r = server as RunningServer;
    const api = appOf(r);
    const setRes = await setItem(api, 'theme', 'modern');
    expect(envelopeOf<null>(setRes.json()).code).toBe(0);

    const getEnv = envelopeOf<{ value: string | null }>((await getItem(api, 'theme')).json());
    expect(getEnv.data?.value).toBe('modern');

    const text = await readFile(join(home as string, 'gui.toml'), 'utf-8');
    expect(text).toContain('theme = "modern"');
  });

  it('setItem overwrites an existing value', async () => {
    const api = appOf(server as RunningServer);
    await setItem(api, 'theme', 'modern');
    await setItem(api, 'theme', 'terminal');

    const env = envelopeOf<{ value: string | null }>((await getItem(api, 'theme')).json());
    expect(env.data?.value).toBe('terminal');
  });

  it('removeItem deletes a key and leaves others intact', async () => {
    const api = appOf(server as RunningServer);
    await setItem(api, 'a', '1');
    await setItem(api, 'b', '2');
    const rmRes = await api.inject({
      method: 'POST',
      url: '/api/gui/store/removeItem',
      payload: { key: 'a' },
    });
    expect(envelopeOf<null>(rmRes.json()).code).toBe(0);

    expect(envelopeOf<{ value: string | null }>((await getItem(api, 'a')).json()).data?.value).toBeNull();
    expect(envelopeOf<{ value: string | null }>((await getItem(api, 'b')).json()).data?.value).toBe('2');
  });

  it('removeItem on a missing key is a no-op', async () => {
    const res = await appOf(server as RunningServer).inject({
      method: 'POST',
      url: '/api/gui/store/removeItem',
      payload: { key: 'nope' },
    });
    expect(envelopeOf<null>(res.json()).code).toBe(0);
  });

  it('length reports the count and clear empties the store', async () => {
    const api = appOf(server as RunningServer);
    await setItem(api, 'a', '1');
    await setItem(api, 'b', '2');

    const before = envelopeOf<{ length: number }>(
      (await api.inject({ method: 'GET', url: '/api/gui/store/length' })).json(),
    );
    expect(before.data?.length).toBe(2);

    const clearRes = await api.inject({ method: 'POST', url: '/api/gui/store/clear' });
    expect(envelopeOf<null>(clearRes.json()).code).toBe(0);

    const after = envelopeOf<{ length: number }>(
      (await api.inject({ method: 'GET', url: '/api/gui/store/length' })).json(),
    );
    expect(after.data?.length).toBe(0);
  });

  it('quotes dotted keys in the persisted TOML and reads them back', async () => {
    const api = appOf(server as RunningServer);
    await setItem(api, 'kimi-web.theme', 'modern');

    const text = await readFile(join(home as string, 'gui.toml'), 'utf-8');
    expect(text).toContain('"kimi-web.theme" = "modern"');

    const env = envelopeOf<{ value: string | null }>((await getItem(api, 'kimi-web.theme')).json());
    expect(env.data?.value).toBe('modern');
  });

  it('rejects an empty key', async () => {
    const res = await appOf(server as RunningServer).inject({
      method: 'POST',
      url: '/api/gui/store/setItem',
      payload: { key: '', value: 'x' },
    });
    expect(envelopeOf(res.json()).code).toBe(40001);
  });

  it('treats Object.prototype keys as ordinary keys', async () => {
    const api = appOf(server as RunningServer);
    expect(
      envelopeOf<{ value: string | null }>((await getItem(api, 'toString')).json()).data?.value,
    ).toBeNull();
    expect(
      envelopeOf<{ value: string | null }>((await getItem(api, 'constructor')).json()).data?.value,
    ).toBeNull();

    await setItem(api, 'hasOwnProperty', 'x');
    await setItem(api, '__proto__', 'y');
    expect(
      envelopeOf<{ value: string | null }>((await getItem(api, 'hasOwnProperty')).json()).data?.value,
    ).toBe('x');
    expect(
      envelopeOf<{ value: string | null }>((await getItem(api, '__proto__')).json()).data?.value,
    ).toBe('y');
  });

  it('persists shortcuts, rejects conflicts without mutation, and resets per action/platform', async () => {
    const api = appOf(server as RunningServer);
    const url = '/api/gui/shortcuts?platform=windows';
    const initial = envelopeOf<{ preferences: unknown; conflicts: unknown[] }>((await api.inject({ method: 'GET', url })).json());
    expect(initial.data?.preferences).toEqual({ version: 1, overrides: {} });
    expect(initial.data?.conflicts).toEqual([]);
    const preferences = { version: 1, overrides: { windows: { switcher: [{ key: 'j', modifier: 'mod', shift: false, alt: false }] }, macos: { switcher: [] } } };
    expect(envelopeOf((await api.inject({ method: 'PUT', url, payload: { preferences } })).json()).code).toBe(0);
    expect(await readFile(join(home as string, 'gui.toml'), 'utf-8')).toContain('shortcuts.v1');
    const read = () => api.inject({ method: 'GET', url });
    expect(envelopeOf<{ preferences: unknown }>((await read()).json()).data?.preferences).toEqual(preferences);
    const bad = { version: 1, overrides: { windows: { switcher: [{ key: 'f', modifier: 'ctrl' }] } } };
    const conflict = (await api.inject({ method: 'PUT', url, payload: { preferences: bad } })).json() as { code: number; details: { conflicts: unknown[] } };
    expect(conflict.code).toBe(40001);
    expect(conflict.details.conflicts).toHaveLength(1);
    expect(envelopeOf<{ preferences: unknown }>((await read()).json()).data?.preferences).toEqual(preferences);
    expect(envelopeOf((await api.inject({ method: 'PUT', url, payload: { preferences: { version: 2, overrides: {} } } })).json()).code).toBe(40001);
    const reset = envelopeOf<{ preferences: { overrides: unknown } }>((await api.inject({ method: 'POST', url: '/api/gui/shortcuts/reset?platform=windows', payload: { platform: 'windows', action: 'switcher' } })).json());
    expect(reset.data?.preferences.overrides).toEqual({ windows: {}, macos: { switcher: [] } });
    await api.inject({ method: 'POST', url: '/api/gui/shortcuts/reset?platform=windows', payload: {} });
    expect(envelopeOf<{ preferences: unknown }>((await read()).json()).data?.preferences).toEqual({ version: 1, overrides: {} });
    const moved = { version: 1, overrides: { windows: { switcher: [{ key: 'f', modifier: 'mod', shift: false, alt: false }], find: [] } } };
    expect(envelopeOf((await api.inject({ method: 'PUT', url, payload: { preferences: moved } })).json()).code).toBe(0);
    const conflictingReset = await api.inject({ method: 'POST', url: '/api/gui/shortcuts/reset?platform=windows', payload: { platform: 'windows', action: 'find' } });
    expect(envelopeOf(conflictingReset.json()).code).toBe(40001);
    expect(envelopeOf<{ preferences: unknown }>((await read()).json()).data?.preferences).toEqual(moved);
    await setItem(api, 'shortcuts.v1', 'not-json');
    expect(envelopeOf((await read()).json()).code).toBe(50001);
    expect(envelopeOf((await api.inject({ method: 'POST', url: '/api/gui/shortcuts/reset?platform=windows', payload: {} })).json()).code).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('writes gui.toml with 0600 permissions', async () => {
    await setItem(appOf(server as RunningServer), 'theme', 'modern');
    const mode = (await stat(join(home as string, 'gui.toml'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
