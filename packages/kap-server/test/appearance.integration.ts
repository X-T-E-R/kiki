import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { InstallAppearancePackResponse, ListAppearancePacksResponse } from '@kiki/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildStoredZip } from '../src/lib/storedZip';
import { readZipEntries } from '../src/lib/zipReader';
import { fetchRemoteMedia } from '../src/routes/appearance';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | undefined>;
  rawPayload: Buffer;
  json: () => unknown;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64, 2)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(64, 3)]);

const MANIFEST = {
  kind: 'kiki-appearance-pack',
  version: 1,
  id: 'fixture-dusk',
  name: 'Fixture Dusk',
  preview: 'preview.png',
  variants: {
    light: { colors: { accent: '#b4532a' }, background: { media: ['day.webp'], opacity: 0.9 } },
    dark: { background: { media: ['night.mp4'], poster: 'preview.png' } },
  },
};

function packZip(manifest: unknown = MANIFEST, extra: { name: string; data: Buffer }[] = []): Buffer {
  return buildStoredZip([
    { name: 'kiki-pack.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: 'preview.png', data: PNG },
    { name: 'day.webp', data: WEBP },
    { name: 'night.mp4', data: MP4 },
    ...extra,
  ]);
}

describe('server-v2 appearance pack routes', () => {
  let home = '';
  let themesDir = '';
  let server: RunningServer | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-server-appearance-'));
    themesDir = join(home, 'themes');
    await mkdir(themesDir, { recursive: true });
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function inject(req: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }): Promise<InjectResponse> {
    const running = server as RunningServer;
    const app = running.app as unknown as { inject: (value: unknown) => Promise<InjectResponse> };
    return app.inject({ ...req, headers: { ...req.headers, authorization: `Bearer ${running.authTokenService.getToken()}` } });
  }

  const install = async (zip: Buffer, replace = false) => {
    const res = await inject({
      method: 'POST',
      url: `/api/appearance/packs${replace ? '?replace=true' : ''}`,
      payload: zip,
      headers: { 'content-type': 'application/zip' },
    });
    return res.json() as { code: number; msg: string; data: InstallAppearancePackResponse };
  };

  it('installs, lists, serves declared files, exports and deletes a pack', async () => {
    const installed = await install(packZip());
    expect(installed.code).toBe(0);
    expect(installed.data.pack).toMatchObject({ id: 'fixture-dusk', hasSkin: true, hasVideo: true, variants: ['light', 'dark'] });

    const listed = (await inject({ method: 'GET', url: '/api/appearance/packs' })).json() as { data: ListAppearancePacksResponse };
    expect(listed.data.items.map((item) => item.id)).toEqual(['fixture-dusk']);
    expect(listed.data.directory).toBe(themesDir);

    const file = await inject({ method: 'GET', url: '/api/appearance/packs/fixture-dusk/files/day.webp' });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/webp');
    expect(file.rawPayload.equals(WEBP)).toBe(true);

    const ranged = await inject({ method: 'GET', url: '/api/appearance/packs/fixture-dusk/files/night.mp4', headers: { range: 'bytes=0-11' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.byteLength).toBe(12);

    const exported = await inject({ method: 'GET', url: '/api/appearance/packs/fixture-dusk/export' });
    expect(exported.headers['content-type']).toBe('application/zip');
    const names = readZipEntries(exported.rawPayload, { maxEntries: 10, maxTotalBytes: 1e6, maxEntryBytes: () => 1e6 }).map((e) => e.name);
    expect(names).toEqual(['kiki-pack.json', 'preview.png', 'day.webp', 'night.mp4']);

    const removed = (await inject({ method: 'DELETE', url: '/api/appearance/packs/fixture-dusk' })).json() as { code: number };
    expect(removed.code).toBe(0);
    expect(await readdir(themesDir)).toEqual([]);
  });

  it('refuses a second install of the same id unless replace is asked for', async () => {
    expect((await install(packZip())).code).toBe(0);
    expect((await install(packZip())).code).toBe(40919);
    const replaced = await install(packZip(), true);
    expect(replaced.code).toBe(0);
    expect(replaced.data.replaced).toBe(true);
  });

  it('refuses scripts, stylesheets, undeclared files, lying extensions and traversal', async () => {
    const cases: Buffer[] = [
      packZip(MANIFEST, [{ name: 'evil.js', data: Buffer.from('alert(1)') }]),
      packZip(MANIFEST, [{ name: 'theme.css', data: Buffer.from('body{}') }]),
      packZip(MANIFEST, [{ name: 'extra.png', data: PNG }]),
      packZip(MANIFEST, [{ name: '../escape.png', data: PNG }]),
      buildStoredZip([
        { name: 'kiki-pack.json', data: Buffer.from(JSON.stringify(MANIFEST)) },
        { name: 'preview.png', data: Buffer.from('<html><script>alert(1)</script></html>') },
        { name: 'day.webp', data: WEBP },
        { name: 'night.mp4', data: MP4 },
      ]),
      packZip({ ...MANIFEST, css: 'body{display:none}' }),
      packZip({ ...MANIFEST, variants: { light: { background: { media: ['missing.webp'] } } } }),
      Buffer.from('not a zip at all'),
    ];
    for (const zip of cases) {
      const result = await install(zip);
      expect(result.code, result.msg).not.toBe(0);
    }
    expect(await readdir(themesDir)).toEqual([]);
  });

  it('never serves a file the manifest does not declare, even if it is on disk', async () => {
    expect((await install(packZip())).code).toBe(0);
    await writeFile(join(themesDir, 'fixture-dusk', 'secret.png'), PNG);
    const res = await inject({ method: 'GET', url: '/api/appearance/packs/fixture-dusk/files/secret.png' });
    expect(res.statusCode).toBe(404);
  });

  it('streams a large pack video and serves a Range slice without reading the whole file', async () => {
    expect((await install(packZip())).code).toBe(0);
    const big = Buffer.alloc(24 * 1024 * 1024, 7);
    MP4.copy(big, 0);
    big.writeUInt32BE(0xdeadbeef, big.length - 4);
    await writeFile(join(themesDir, 'fixture-dusk', 'night.mp4'), big);

    const heapBefore = process.memoryUsage().arrayBuffers;
    const tail = await inject({ method: 'GET', url: '/api/appearance/packs/fixture-dusk/files/night.mp4', headers: { range: 'bytes=-4' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.headers['content-range']).toBe(`bytes ${big.length - 4}-${big.length - 1}/${big.length}`);
    expect(String(tail.headers['content-length'])).toBe('4');
    expect(tail.rawPayload.readUInt32BE(0)).toBe(0xdeadbeef);
    expect(process.memoryUsage().arrayBuffers - heapBefore).toBeLessThan(big.length / 2);

    const whole = await inject({ method: 'GET', url: '/api/appearance/packs/fixture-dusk/files/night.mp4' });
    expect(whole.statusCode).toBe(200);
    expect(String(whole.headers['content-length'])).toBe(String(big.length));
    expect(whole.rawPayload.equals(big)).toBe(true);

    const etag = whole.headers['etag']!;
    const cached = await inject({ method: 'GET', url: '/api/appearance/packs/fixture-dusk/files/night.mp4', headers: { 'if-none-match': etag } });
    expect(cached.statusCode).toBe(304);
  });

  it('installs the shipped example pack from docs/examples unchanged', async () => {
    const dir = join(__dirname, '..', '..', '..', 'docs', 'examples', 'appearance-packs', 'dusk-harbor');
    const names = (await readdir(dir)).sort();
    const zip = buildStoredZip(await Promise.all(names.map(async (name) => ({ name, data: await readFile(join(dir, name)) }))));
    const result = await install(zip);
    expect(result.code, result.msg).toBe(0);
    expect(result.data.pack).toMatchObject({ id: 'dusk-harbor', hasSkin: true, hasVideo: true, variants: ['light', 'dark'] });
  });

  it('skips a folder whose manifest id does not match its name and ignores plain skin files', async () => {
    await writeFile(join(themesDir, 'ocean.json'), JSON.stringify({ kind: 'kiki-skin', version: 1, name: 'Ocean', variants: { light: {} } }));
    await mkdir(join(themesDir, 'renamed'));
    await writeFile(join(themesDir, 'renamed', 'kiki-pack.json'), JSON.stringify({ ...MANIFEST, preview: undefined, variants: { light: { colors: { accent: '#123456' } } } }));
    const listed = (await inject({ method: 'GET', url: '/api/appearance/packs' })).json() as { data: ListAppearancePacksResponse };
    expect(listed.data.items).toEqual([]);
    expect(listed.data.skipped[0]?.file).toBe('renamed/');
    expect((await stat(join(themesDir, 'ocean.json'))).isFile()).toBe(true);
  });
});

describe('remote background import policy', () => {
  const ok = (body: Buffer, type = 'image/png') => async () => new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': type } });

  it('imports a public https image and sniffs its type', async () => {
    const result = await fetchRemoteMedia('https://example.com/a/pic.png', async () => ['93.184.216.34'], ok(PNG) as unknown as typeof fetch);
    expect(result.mime).toBe('image/png');
    expect(result.name).toBe('pic.png');
  });

  it('refuses http, credentials, private and loopback targets, and redirects into them', async () => {
    const fetchImpl = ok(PNG) as unknown as typeof fetch;
    await expect(fetchRemoteMedia('http://example.com/a.png', async () => ['93.184.216.34'], fetchImpl)).rejects.toThrow(/https/);
    await expect(fetchRemoteMedia('https://u:p@example.com/a.png', async () => ['93.184.216.34'], fetchImpl)).rejects.toThrow(/credentials/);
    for (const address of ['127.0.0.1', '10.0.0.8', '192.168.1.2', '169.254.169.254', '::1', 'fd00::1', '100.64.0.1']) {
      await expect(fetchRemoteMedia('https://example.com/a.png', async () => [address], fetchImpl), address).rejects.toThrow(/public/);
    }
    const redirect = (async () => new Response(null, { status: 302, headers: { location: 'https://internal.example/a.png' } })) as unknown as typeof fetch;
    const resolve = async (host: string) => (host === 'internal.example' ? ['10.1.2.3'] : ['93.184.216.34']);
    await expect(fetchRemoteMedia('https://example.com/a.png', resolve, redirect)).rejects.toThrow(/public/);
  });

  it('refuses a page that is not media, whatever its content type claims', async () => {
    const html = ok(Buffer.from('<html></html>'), 'image/png') as unknown as typeof fetch;
    await expect(fetchRemoteMedia('https://example.com/a.png', async () => ['93.184.216.34'], html)).rejects.toThrow(/supported/);
  });
});

describe('appearance pack space inheritance', () => {
  it('reads base-home packs and keeps installs and deletes in the space', async () => {
    const baseHome = await mkdtemp(join(tmpdir(), 'kiki-appearance-base-'));
    const spaceHome = await mkdtemp(join(tmpdir(), 'kiki-appearance-space-'));
    const baseThemes = join(baseHome, 'themes');
    const spaceThemes = join(spaceHome, 'themes');
    await mkdir(join(baseThemes, 'fixture-dusk'), { recursive: true });
    await mkdir(spaceThemes, { recursive: true });
    await writeFile(join(baseThemes, 'fixture-dusk', 'kiki-pack.json'), JSON.stringify(MANIFEST));
    await writeFile(join(baseThemes, 'fixture-dusk', 'preview.png'), PNG);
    await writeFile(join(baseThemes, 'fixture-dusk', 'day.webp'), WEBP);
    await writeFile(join(baseThemes, 'fixture-dusk', 'night.mp4'), MP4);
    await writeFile(
      join(spaceHome, 'home.toml'),
      [
        'schema = 1',
        'id = "h-appearance"',
        'name = "Appearance Space"',
        `base = "${baseHome.replaceAll('\\', '/')}"`,
        '',
      ].join('\n'),
    );

    const space = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: spaceHome, logLevel: 'silent' });
    try {
      const app = space.app as unknown as { inject: (value: unknown) => Promise<InjectResponse> };
      const call = (req: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }): Promise<InjectResponse> =>
        app.inject({ ...req, headers: { ...req.headers, authorization: `Bearer ${space.authTokenService.getToken()}` } });

      const listed = (await call({ method: 'GET', url: '/api/appearance/packs' })).json() as { data: ListAppearancePacksResponse };
      expect(listed.data.items.map((item) => item.id)).toEqual(['fixture-dusk']);
      expect(listed.data.directory).toBe(spaceThemes);

      const manifest = (await call({ method: 'GET', url: '/api/appearance/packs/fixture-dusk' })).json() as { code: number };
      expect(manifest.code).toBe(0);

      const file = await call({ method: 'GET', url: '/api/appearance/packs/fixture-dusk/files/day.webp' });
      expect(file.statusCode).toBe(200);
      expect(file.rawPayload.equals(WEBP)).toBe(true);

      const installed = (await call({
        method: 'POST',
        url: '/api/appearance/packs?replace=true',
        payload: packZip({ ...MANIFEST, name: 'Space Dusk' }),
        headers: { 'content-type': 'application/zip' },
      })).json() as { code: number; data: InstallAppearancePackResponse };
      expect(installed.code).toBe(0);

      const afterInstall = (await call({ method: 'GET', url: '/api/appearance/packs' })).json() as { data: ListAppearancePacksResponse };
      expect(afterInstall.data.items).toHaveLength(1);
      expect(afterInstall.data.items[0]?.name).toBe('Space Dusk');
      expect(await readdir(baseThemes)).toEqual(['fixture-dusk']);

      const removed = (await call({ method: 'DELETE', url: '/api/appearance/packs/fixture-dusk' })).json() as { code: number };
      expect(removed.code).toBe(0);
      const afterwards = (await call({ method: 'GET', url: '/api/appearance/packs' })).json() as { data: ListAppearancePacksResponse };
      expect(afterwards.data.items.map((item) => item.id)).toEqual(['fixture-dusk']);
      expect(afterwards.data.items[0]?.name).toBe('Fixture Dusk');
      expect(await readdir(spaceThemes)).toEqual([]);
    } finally {
      await space.close();
      await rm(baseHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(spaceHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
