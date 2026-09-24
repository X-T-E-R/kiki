import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKlient } from '@kiki/klient/http';
import { IHostFileSystem } from '@kiki/agent-core-v2';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface BrowseEntryWire {
  name: string;
  path: string;
  is_dir: true;
}

interface BrowseWire {
  path: string;
  parent: string | null;
  entries: BrowseEntryWire[];
}

interface HomeWire {
  home: string;
  recent_roots: string[];
}

describe('server-v2 /api fs folder picker', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let instancesDir: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-instances-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      instancesDir,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
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
    if (instancesDir !== undefined) {
      await rm(instancesDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      instancesDir = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('defaults browse to $HOME when path is omitted', async () => {
    const { status, body } = await getJson<BrowseWire>('/api/fs:browse');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(await realpath(homedir()));
    expect(typeof body.data.parent === 'string' || body.data.parent === null).toBe(true);
    expect(Array.isArray(body.data.entries)).toBe(true);
  });

  it('does not serve the double-colon URL (v1 parity: only /fs:browse is valid)', async () => {
    const res = await fetch(`${base}/api/fs::browse`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(404);
  });

  it('lists only directories and filters files', async () => {
    const root = join(home as string, 'browse');
    await mkdir(root);
    await mkdir(join(root, 'alpha'));
    await mkdir(join(root, 'beta'));
    await writeFile(join(root, 'README.md'), 'hi');

    const { body } = await getJson<BrowseWire>(
      `/api/fs:browse?path=${encodeURIComponent(root)}`,
    );
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(await realpath(root));
    const names = body.data.entries.map((e) => e.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
    for (const entry of body.data.entries) {
      expect(entry.is_dir).toBe(true);
      expect(entry.path).toBe(join(await realpath(root), entry.name));
    }
  });

  it('sorts dot-directories after regular ones', async () => {
    const root = join(home as string, 'sorted-browse');
    await mkdir(root);
    await mkdir(join(root, '.zeta'));
    await mkdir(join(root, 'alpha'));

    const { body } = await getJson<BrowseWire>(
      `/api/fs:browse?path=${encodeURIComponent(root)}`,
    );
    expect(body.code).toBe(0);
    expect(body.data.entries.map((e) => e.name)).toEqual(['alpha', '.zeta']);
  });

  it('returns parent=null for the filesystem root', async () => {
    const root = parse(await realpath(homedir())).root;
    const { body } = await getJson<BrowseWire>(
      `/api/fs:browse?path=${encodeURIComponent(root)}`,
    );
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(await realpath(root));
    expect(body.data.parent).toBeNull();
  });

  it('rejects a relative path (40001)', async () => {
    const { body } = await getJson<null>(
      `/api/fs:browse?path=${encodeURIComponent('relative/path')}`,
    );
    expect(body.code).toBe(40001);
  });

  it('rejects a nonexistent path (40409)', async () => {
    const missing = join(home as string, 'does-not-exist');
    const { body } = await getJson<null>(`/api/fs:browse?path=${encodeURIComponent(missing)}`);
    expect(body.code).toBe(40409);
  });

  it('returns an empty recent_roots when no workspaces are registered', async () => {
    const { status, body } = await getJson<HomeWire>('/api/fs:home');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.home).toBe(homedir());
    expect(body.data.recent_roots).toEqual([]);
  });

  it('reflects registered workspace roots in recent_roots', async () => {
    const root = home as string;
    const created = await postJson<{ id: string }>('/api/workspaces', { root });
    expect(created.body.code).toBe(0);

    const { body } = await getJson<HomeWire>('/api/fs:home');
    expect(body.code).toBe(0);
    expect(body.data.recent_roots).toContain(root);
  });
});

describe('server-v2 /api fs:mkdir', () => {
  let server: RunningServer | undefined;
  let dir: string | undefined;
  let instancesDir: string | undefined;
  let base: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fsmkdir-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fsmkdir-instances-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: dir,
      instancesDir,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      dir = undefined;
    }
    if (instancesDir !== undefined) {
      await rm(instancesDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      instancesDir = undefined;
    }
  });

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('creates a directory that fs:browse then lists', async () => {
    const target = join(dir as string, 'fresh-folder');

    const { status, body } = await postJson<{ path: string }>('/api/fs:mkdir', {
      path: target,
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(target);

    const browse = await fetch(
      `${base}/api/fs:browse?path=${encodeURIComponent(dir as string)}`,
      { headers: authHeaders(server as RunningServer) } as never,
    );
    const browseBody = (await browse.json()) as Envelope<BrowseWire>;
    expect(browseBody.data.entries.map((e) => e.name)).toContain('fresh-folder');
  });

  it('rejects a relative path (40001)', async () => {
    const { body } = await postJson<null>('/api/fs:mkdir', { path: 'relative/folder' });
    expect(body.code).toBe(40001);
  });

  it('rejects an existing directory (40919)', async () => {
    const target = join(dir as string, 'already-here');
    await mkdir(target);

    const { body } = await postJson<null>('/api/fs:mkdir', { path: target });
    expect(body.code).toBe(40919);
  });

  it('rejects an existing file (40919)', async () => {
    const target = join(dir as string, 'file.txt');
    await writeFile(target, 'hi');

    const { body } = await postJson<null>('/api/fs:mkdir', { path: target });
    expect(body.code).toBe(40919);
  });

  it('rejects a missing parent (40409)', async () => {
    const target = join(dir as string, 'no-such-parent', 'child');
    const { body } = await postJson<null>('/api/fs:mkdir', { path: target });
    expect(body.code).toBe(40409);
  });

  it('does not serve the double-colon URL', async () => {
    const res = await fetch(`${base}/api/fs::mkdir`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ path: join(dir as string, 'x') }),
    } as never);
    expect(res.status).toBe(404);
  });
});

describe('server-v2 /api fs:content', () => {
  let server: RunningServer | undefined;
  let dir: string | undefined;
  let instancesDir: string | undefined;
  let base: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fscontent-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fscontent-instances-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: dir,
      instancesDir,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      dir = undefined;
    }
    if (instancesDir !== undefined) {
      await rm(instancesDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      instancesDir = undefined;
    }
  });

  function contentUrl(path: string): string {
    return `${base}/api/fs:content?path=${encodeURIComponent(path)}`;
  }

  async function getContent(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(contentUrl(path), {
      headers: { connection: 'close', ...authHeaders(server as RunningServer), ...headers },
    } as never);
  }

  it('serves a text file raw with mime, etag, and length headers', async () => {
    const file = join(dir as string, 'hello.md');
    await writeFile(file, '# hi\n');

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-length')).toBe('5');
    expect(typeof res.headers.get('etag')).toBe('string');
    expect(typeof res.headers.get('last-modified')).toBe('string');
    expect(await res.text()).toBe('# hi\n');
  });

  it('serves an unknown-extension text file as text/plain', async () => {
    const file = join(dir as string, 'notes.weird');
    await writeFile(file, 'just text');

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('serves a UTF-8 Chinese .log file as text/plain', async () => {
    const file = join(dir as string, 'server.log');
    const log = '2026-08-16 INFO 启动完成 ✅\n'.repeat(100);
    await writeFile(file, log);

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(log);
  });

  it('serves binary files byte-for-byte with an octet-stream fallback mime', async () => {
    const file = join(dir as string, 'blob.bin');
    const original = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10, 0x80]);
    await writeFile(file, original);

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/octet-stream');
    expect(Buffer.from(await res.arrayBuffer()).equals(original)).toBe(true);
  });

  it.each([
    ['pic.png', 'image/png'],
    ['pic.webp', 'image/webp'],
    ['clip.mp4', 'video/mp4'],
    ['clip.webm', 'video/webm'],
  ])('serves %s with a browser-playable media type', async (name, mime) => {
    const file = join(dir as string, name);
    await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(mime);
  });

  it('answers If-None-Match with 304 when the etag matches', async () => {
    const file = join(dir as string, 'cached.txt');
    await writeFile(file, 'cache me');

    const first = await getContent(file);
    const etag = first.headers.get('etag') as string;

    const res = await getContent(file, { 'if-none-match': etag });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(etag);
    expect(await res.text()).toBe('');
  });

  it('honors single-range requests with 206', async () => {
    const file = join(dir as string, 'long.txt');
    await writeFile(file, '0123456789');

    const res = await getContent(file, { range: 'bytes=2-5' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('2345');
  });

  it('shared facade distinguishes file documents from download error envelopes', async () => {
    const client = createKlient({ endpoint: base, token: server!.authTokenService.getToken() });
    try {
      const document = '{"code":40409,"msg":"this is a document","data":null}\n';
      const file = join(dir as string, 'document.json');
      await writeFile(file, document);
      expect(await client.rest!.filesystem.readHostFile(file)).toBe(document);
      expect(new TextDecoder().decode((await client.rest!.filesystem.readHostFileBytes(file)).bytes)).toBe(document);
      for (const [path, code] of [
        [join(dir as string, 'missing.json'), 40409],
        [dir as string, 40906],
        ['relative.json', 40001],
        ['', 40001],
      ] as const) {
        const response = await getContent(path);
        expect(response.ok, path).toBe(false);
        expect((await response.json() as Envelope<null>).code).toBe(code);
        await expect(client.rest!.filesystem.readHostFileBytes(path)).rejects.toMatchObject({ code });
        await expect(client.rest!.filesystem.readHostFile(path)).rejects.toMatchObject({ code });
      }
      const failingRead = vi.spyOn(server!.core.accessor.get(IHostFileSystem), 'realpath')
        .mockRejectedValueOnce(new Error('synthetic filesystem failure'));
      try {
        await expect(client.rest!.filesystem.readHostFileBytes(file)).rejects.toMatchObject({ code: 50001 });
      } finally {
        failingRead.mockRestore();
      }
    } finally {
      await client.close();
    }
  });

  it('rejects a relative path (40001)', async () => {
    const res = await getContent('relative/path.txt');
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40001);
  });

  it('rejects a nonexistent path (40409)', async () => {
    const res = await getContent(join(dir as string, 'does-not-exist.txt'));
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40409);
  });

  it('rejects a directory path (40906)', async () => {
    const res = await getContent(dir as string);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40906);
  });

  it.skipIf(process.platform === 'win32')('rejects non-regular files (40001)', async () => {
    const res = await getContent('/dev/null');
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40001);
  });

  it('does not serve the double-colon URL', async () => {
    const res = await fetch(`${base}/api/fs::content?path=%2Ftmp`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(404);
  });
});
