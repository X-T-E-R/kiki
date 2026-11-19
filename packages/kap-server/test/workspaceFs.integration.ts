import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';

import { Error2, ErrorCodes, IHostFileSystem, IWorkspaceService } from '@kiki/agent-core-v2';
import { WorkspaceFsService } from '@kiki/agent-core-v2/workspace/workspaceFs/fsService';
import { createKlient } from '@kiki/klient/http';
import { fsSearchResponseSchema, type FsSearchResponse } from '@kiki/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import * as mediaPreview from '../src/services/mediaPreview';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface BrowseWire {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; is_dir: true }[];
}

interface HomeWire {
  home: string;
  recent_roots: string[];
}

describe('server-v2 /api workspaceFs surfaces', () => {
  let server!: RunningServer;
  let home!: string;
  let instancesDir!: string;
  let scratchRoot!: string;
  let base!: string;
  let client!: ReturnType<typeof createKlient>;
  let caseSeq = 0;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-instances-'));
    scratchRoot = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-cases-'));
    await writeFile(join(home, 'config.toml'), '[search]\nenabled = false\n[cron]\nmanualTick = true\n');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      instancesDir,
      userSkillDir: join(home, 'isolated-skills'),
      userAgentProfileHomeDir: join(home, 'isolated-agents'),
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    client = createKlient({ endpoint: base, token: server.localOwnerToken });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
    await Promise.all([
      rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
      rm(instancesDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
      rm(scratchRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
    ]);
  });

  async function nextDir(prefix = 'case'): Promise<string> {
    caseSeq += 1;
    const dir = join(scratchRoot, `${prefix}-${caseSeq}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, { headers: authHeaders(server) } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(path: string, body?: unknown): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server, hasBody ? { 'content-type': 'application/json' } : {}),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  function contentUrl(path: string): string {
    return `${base}/api/fs:content?path=${encodeURIComponent(path)}`;
  }

  async function getContent(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(contentUrl(path), {
      headers: { connection: 'close', ...authHeaders(server), ...headers },
    } as never);
  }

  describe('folder picker & fs:home', () => {
    it('defaults browse to $HOME and returns parent=null for filesystem root', async () => {
      const homeRes = await getJson<BrowseWire>('/api/fs:browse');
      expect(homeRes.status).toBe(200);
      expect(homeRes.body.code).toBe(0);
      expect(homeRes.body.data.path).toBe(await realpath(homedir()));
      expect(typeof homeRes.body.data.parent === 'string' || homeRes.body.data.parent === null).toBe(true);
      expect(Array.isArray(homeRes.body.data.entries)).toBe(true);

      const fsRoot = parse(await realpath(homedir())).root;
      const rootRes = await getJson<BrowseWire>(`/api/fs:browse?path=${encodeURIComponent(fsRoot)}`);
      expect(rootRes.body.code).toBe(0);
      expect(rootRes.body.data.path).toBe(await realpath(fsRoot));
      expect(rootRes.body.data.parent).toBeNull();
    });

    it('lists only directories and sorts dot-directories after regular ones', async () => {
      const root = await nextDir('browse');
      await Promise.all([
        mkdir(join(root, '.zeta')),
        mkdir(join(root, 'alpha')),
        mkdir(join(root, 'beta')),
        writeFile(join(root, 'README.md'), 'hi'),
      ]);
      const resolved = await realpath(root);
      const { body } = await getJson<BrowseWire>(`/api/fs:browse?path=${encodeURIComponent(root)}`);
      expect(body.code).toBe(0);
      expect(body.data.path).toBe(resolved);
      expect(body.data.entries.map((e) => e.name)).toEqual(['alpha', 'beta', '.zeta']);
      for (const entry of body.data.entries) {
        expect(entry.is_dir).toBe(true);
        expect(entry.path).toBe(join(resolved, entry.name));
      }
    });

    it.each([
      ['relative/path', 40001],
      ['__missing__', 40409],
    ] as const)('rejects invalid browse path %s (%i)', async (raw, code) => {
      const target = raw === '__missing__' ? join(scratchRoot, 'does-not-exist-browse') : raw;
      const { body } = await getJson<null>(`/api/fs:browse?path=${encodeURIComponent(target)}`);
      expect(body.code).toBe(code);
    });

    it('tracks registered workspace roots in fs:home recent_roots and cleans up on delete', async () => {
      const wsService = server.core.accessor.get(IWorkspaceService);
      for (const ws of await wsService.list()) await wsService.delete(ws.id);
      const empty = await getJson<HomeWire>('/api/fs:home');
      expect(empty.status).toBe(200);
      expect(empty.body.data).toEqual({ home: homedir(), recent_roots: [] });

      const wsRoot = await nextDir('recent-ws');
      const created = await postJson<{ id: string }>('/api/workspaces', { root: wsRoot });
      expect(created.body.code).toBe(0);
      try {
        const populated = await getJson<HomeWire>('/api/fs:home');
        expect(populated.body.data.recent_roots).toContain(wsRoot);
      } finally {
        await wsService.delete(created.body.data.id);
      }
    });
  });

  describe('fs:mkdir & double-colon route rejections', () => {
    it('creates a directory that fs:browse lists and rejects invalid mkdir targets', async () => {
      const dir = await nextDir('mkdir');
      const fresh = join(dir, 'fresh-folder');
      const created = await postJson<{ path: string }>('/api/fs:mkdir', { path: fresh });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ code: 0, data: { path: fresh } });

      const browse = await getJson<BrowseWire>(`/api/fs:browse?path=${encodeURIComponent(dir)}`);
      expect(browse.body.data.entries.map((e) => e.name)).toContain('fresh-folder');

      const existingFile = join(dir, 'file.txt');
      await writeFile(existingFile, 'hi');
      for (const [target, code] of [
        ['relative/folder', 40001],
        [fresh, 40919],
        [existingFile, 40919],
        [join(dir, 'no-such-parent', 'child'), 40409],
      ] as const) {
        expect((await postJson<null>('/api/fs:mkdir', { path: target })).body.code).toBe(code);
      }
    });

    it.each([
      ['GET', '/api/fs::browse', undefined],
      ['POST', '/api/fs::mkdir', { path: '/tmp/x' }],
      ['GET', '/api/fs::content?path=%2Ftmp', undefined],
    ] as const)('does not serve double-colon URL %s %s', async (method, urlPath, payload) => {
      const res = await fetch(`${base}${urlPath}`, {
        method,
        headers: authHeaders(server, payload === undefined ? {} : { 'content-type': 'application/json' }),
        body: payload === undefined ? undefined : JSON.stringify(payload),
      } as never);
      expect(res.status).toBe(404);
    });
  });

  describe('fs:content & media previews', () => {
    it('serves text, UTF-8 logs, binary octet-stream, range 206, and media mimes accurately', async () => {
      const dir = await nextDir('content');
      const md = join(dir, 'hello.md');
      await writeFile(md, '# hi\n');
      const mdRes = await getContent(md);
      expect(mdRes.status).toBe(200);
      expect(mdRes.headers.get('content-type')).toContain('text/markdown');
      expect(mdRes.headers.get('content-length')).toBe('5');
      expect(typeof mdRes.headers.get('etag')).toBe('string');
      expect(typeof mdRes.headers.get('last-modified')).toBe('string');
      expect(await mdRes.text()).toBe('# hi\n');

      const weird = join(dir, 'notes.weird');
      await writeFile(weird, 'just text');
      expect((await getContent(weird)).headers.get('content-type')).toContain('text/plain');

      const logPath = join(dir, 'server.log');
      const logBody = '2026-08-16 INFO 启动完成\n'.repeat(100);
      await writeFile(logPath, logBody);
      const logRes = await getContent(logPath);
      expect(logRes.headers.get('content-type')).toContain('text/plain');
      expect(await logRes.text()).toBe(logBody);

      const bin = join(dir, 'blob.bin');
      const rawBin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10, 0x80]);
      await writeFile(bin, rawBin);
      const binRes = await getContent(bin);
      expect(binRes.headers.get('content-type')).toContain('application/octet-stream');
      expect(Buffer.from(await binRes.arrayBuffer()).equals(rawBin)).toBe(true);

      const ranged = join(dir, 'long.txt');
      await writeFile(ranged, '0123456789');
      const rangeRes = await getContent(ranged, { range: 'bytes=2-5' });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(rangeRes.headers.get('content-length')).toBe('4');
      expect(await rangeRes.text()).toBe('2345');

      for (const [name, mime] of [['pic.png', 'image/png'], ['pic.webp', 'image/webp'], ['clip.mp4', 'video/mp4'], ['clip.webm', 'video/webm']] as const) {
        const p = join(dir, name);
        await writeFile(p, Buffer.from([0x00, 0x01, 0x02, 0xff]));
        expect((await getContent(p)).headers.get('content-type')).toContain(mime);
      }
    });

    it('answers If-None-Match with 304 before reading a classification sample and enforces revoked read permissions', async () => {
      const dir = await nextDir('etag');
      const file = join(dir, 'cached.txt');
      await writeFile(file, 'cache me');
      const hostFs = server.core.accessor.get(IHostFileSystem);
      const readBytes = vi.spyOn(hostFs, 'readBytes');
      const first = await getContent(file);
      const etag = first.headers.get('etag') as string;
      expect(await first.text()).toBe('cache me');
      expect(readBytes).toHaveBeenCalledTimes(1);

      readBytes.mockClear();
      const hit = await getContent(file, { 'if-none-match': etag });
      expect(hit.status).toBe(304);
      expect(hit.headers.get('etag')).toBe(etag);
      expect(await hit.text()).toBe('');
      expect(readBytes.mock.calls).toEqual([[file, 0]]);

      readBytes.mockClear();
      readBytes.mockRejectedValue(new Error2(ErrorCodes.OS_FS_PERMISSION_DENIED, 'read access denied'));
      const denied304 = await getContent(file, { 'if-none-match': etag });
      expect(denied304.status).toBe(403);
      expect(denied304.headers.get('etag')).toBeNull();
      expect(((await denied304.json()) as Envelope<null>).code).toBe(40411);
      expect((await getContent(file)).status).toBe(403);
    });

    it('shared facade distinguishes file documents from download error envelopes', async () => {
      const dir = await nextDir('facade');
      const document = '{"code":40409,"msg":"this is a document","data":null}\n';
      const file = join(dir, 'document.json');
      await writeFile(file, document);
      expect(await client.rest!.filesystem.readHostFile(file)).toBe(document);
      expect(new TextDecoder().decode((await client.rest!.filesystem.readHostFileBytes(file)).bytes)).toBe(document);
      for (const [target, code] of [[join(dir, 'missing.json'), 40409], [dir, 40906], ['relative.json', 40001], ['', 40001]] as const) {
        const response = await getContent(target);
        expect(response.ok, target).toBe(false);
        expect(((await response.json()) as Envelope<null>).code).toBe(code);
        await expect(client.rest!.filesystem.readHostFileBytes(target)).rejects.toMatchObject({ code });
        await expect(client.rest!.filesystem.readHostFile(target)).rejects.toMatchObject({ code });
      }
      vi.spyOn(server.core.accessor.get(IHostFileSystem), 'realpath').mockRejectedValueOnce(new Error('synthetic filesystem failure'));
      await expect(client.rest!.filesystem.readHostFileBytes(file)).rejects.toMatchObject({ code: 50001 });
    });

    it.skipIf(process.platform === 'win32')('rejects non-regular files (40001)', async () => {
      expect(((await (await getContent('/dev/null')).json()) as Envelope<null>).code).toBe(40001);
    });

    it('ends only the cancelled preview request and closes its source iterator', async () => {
      const dir = await nextDir('cancel-preview');
      const file = join(dir, 'cancelled.png');
      await writeFile(file, Buffer.alloc(1024));
      let started!: () => void;
      const reading = new Promise<void>((r) => { started = r; });
      let sourceClosed!: () => void;
      const closed = new Promise<void>((r) => { sourceClosed = r; });
      const createPreview = mediaPreview.createMediaPreview;
      vi.spyOn(mediaPreview, 'createMediaPreview').mockImplementationOnce((source, mime, signal) => createPreview({
        ...source,
        stream: async function* () {
          try {
            yield new Uint8Array(512);
            started();
            await new Promise<void>((r) => { if (signal.aborted) r(); else signal.addEventListener('abort', () => r(), { once: true }); });
            signal.throwIfAborted();
          } finally { sourceClosed(); }
        },
      }, mime, signal));
      const request = get(`${contentUrl(file)}&preview=media`, { headers: authHeaders(server) });
      request.on('error', () => {});
      try {
        await reading;
        request.destroy();
        await closed;
        const normal = await getContent(file);
        expect(normal.status).toBe(200);
        expect(new Uint8Array(await normal.arrayBuffer())).toEqual(new Uint8Array(1024));
        expect(server.app.server.listening).toBe(true);
      } finally {
        request.destroy();
      }
    });

    it('does not start source reads when the client closes before preview setup', async () => {
      const dir = await nextDir('early-close');
      const file = join(dir, 'early-close.png');
      await writeFile(file, Buffer.alloc(1024));
      let entered!: () => void, proceed!: () => void, finished!: () => void;
      const resolving = new Promise<void>((r) => { entered = r; });
      const gate = new Promise<void>((r) => { proceed = r; });
      const handled = new Promise<void>((r) => { finished = r; });
      const hostFs = server.core.accessor.get(IHostFileSystem);
      const resolvePath = hostFs.realpath.bind(hostFs);
      vi.spyOn(hostFs, 'realpath').mockImplementationOnce(async (v) => { entered(); await gate; return resolvePath(v); });
      let wasAborted = false;
      const preview = vi.spyOn(mediaPreview, 'createMediaPreview').mockImplementationOnce(async (_s, _m, signal) => {
        wasAborted = signal.aborted;
        try { signal.throwIfAborted(); throw new Error('disconnected preview was not aborted'); }
        finally { finished(); }
      });
      const closed = new Promise<void>((r) => { server.app.server.once('request', (_req, res) => { res.once('close', r); }); });
      const request = get(`${contentUrl(file)}&preview=media`, { headers: authHeaders(server) });
      request.on('error', () => {});
      try {
        await resolving;
        request.destroy();
        await closed;
        proceed();
        await handled;
        expect(wasAborted).toBe(true);
        const normal = await getContent(file);
        expect(normal.status).toBe(200);
        await normal.arrayBuffer();
        expect(preview).toHaveBeenCalledTimes(1);
      } finally {
        proceed();
        request.destroy();
      }
    });

    it.each([
      [new mediaPreview.MediaPreviewUnavailableError('preview unavailable'), 415, 40001],
      [new Error('source read failed'), 500, 50001],
    ])('serializes a rejected preview as JSON without losing the next request', async (error, status, code) => {
      const dir = await nextDir('rej-preview');
      const file = join(dir, 'rejected.png');
      await writeFile(file, Buffer.alloc(1024));
      vi.spyOn(mediaPreview, 'createMediaPreview').mockRejectedValueOnce(error);
      const response = await fetch(`${contentUrl(file)}&preview=media`, { headers: authHeaders(server) });
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ code, msg: error.message, data: null });
      const normal = await getContent(file, { range: 'bytes=2-5' });
      expect(normal.status).toBe(206);
      expect((await normal.arrayBuffer()).byteLength).toBe(4);
    });

    it('generates a bounded source media preview under host-file authorization and preserves original bytes', async () => {
      const dir = await nextDir('bmp-preview');
      const path = join(dir, 'preview.bmp');
      const width = 800, height = 600;
      const bytes = Buffer.alloc(54 + width * 3 * height);
      bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10);
      bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(width, 18); bytes.writeInt32LE(height, 22);
      bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
      await writeFile(path, bytes);
      const preview = await client.rest!.filesystem.readHostMediaPreview(path);
      expect(preview.mime).toBe('image/jpeg');
      expect(preview.bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(preview.bytes.byteLength).toBeGreaterThan(0);
      expect((await client.rest!.filesystem.readHostMediaPreview(path, { ifNoneMatch: preview.etag })).notModified).toBe(true);
      const raw = await fetch(`${base}/api/fs:content?path=${encodeURIComponent(path)}&preview=media`, { headers: authHeaders(server, { range: 'bytes=0-15' }) });
      expect(raw.status).toBe(206);
      expect(raw.headers.get('content-range')).toBe(`bytes 0-15/${preview.bytes.byteLength}`);
      expect(new Uint8Array(await raw.arrayBuffer())).toEqual(preview.bytes.subarray(0, 16));
      expect((await client.rest!.filesystem.readHostFileBytes(path)).bytes).toEqual(new Uint8Array(bytes));
    });
  });

  describe('bounded file search', () => {
    it.each(['workspace', 'session'] as const)('drains %s route pages through the HTTP facade with exact contracts', async (mode) => {
      const root = await nextDir(`search-drain-${mode}`);
      await Promise.all(Array.from({ length: 72 }, async (_, i) => {
        const d = join(root, `d${String(i).padStart(3, '0')}`);
        await mkdir(d);
        await writeFile(join(d, 'needle.ts'), '');
      }));
      await writeFile(join(root, '.gitignore'), 'd071/\n');
      const sessionId = mode === 'session' ? (await client.global.sessions.create({ workDir: root })).id : undefined;
      try {
        const body = { query: 'needle', limit: 30, follow_gitignore: true, include_globs: ['**/*.ts'] };
        const search = (cursor?: string): Promise<FsSearchResponse> => mode === 'workspace'
          ? client.rest!.filesystem.workspaceFsSearch(root, { ...body, cursor })
          : client.rest!.sessions.fsSearch(sessionId!, { ...body, cursor });
        let page = await search();
        expect(page.items).toHaveLength(30);
        expect(page.next_cursor).toBeDefined();
        expect(fsSearchResponseSchema.parse(page)).toEqual(page);
        const all = [...page.items];
        const cursor = page.next_cursor;
        while (page.next_cursor !== undefined) {
          page = await search(page.next_cursor);
          expect(page.sort_scope).toBe('page');
          all.push(...page.items);
        }
        expect(all).toHaveLength(71);
        expect(new Set(all.map((hit) => hit.path)).size).toBe(71);
        expect(all.map((hit) => hit.path)).not.toContain('d071/needle.ts');
        expect(page.truncated).toBe(false);
        await expect(client.rest!.filesystem.workspaceFsSearch(root, { ...body, query: 'changed', cursor })).rejects.toMatchObject({ code: 40001 });
      } finally {
        if (sessionId !== undefined) await client.session(sessionId).close();
      }
    });

    it.each(['workspace', 'session'] as const)('stops the %s route walk after HTTP disconnect, then serves a fresh request', async (mode) => {
      const root = await nextDir(`search-abort-${mode}`);
      await Promise.all([mkdir(join(root, 'a')), mkdir(join(root, 'b'))]);
      await Promise.all([writeFile(join(root, 'a', 'needle.ts'), ''), writeFile(join(root, 'b', 'needle.ts'), '')]);
      const sessionId = mode === 'session' ? (await client.global.sessions.create({ workDir: root })).id : undefined;
      const search = WorkspaceFsService.prototype.search;
      const reads: string[] = [];
      let entered!: () => void, sawAbort!: () => void, finished!: () => void;
      const reading = new Promise<void>((r) => { entered = r; });
      const aborted = new Promise<void>((r) => { sawAbort = r; });
      const handled = new Promise<void>((r) => { finished = r; });
      const spy = vi.spyOn(WorkspaceFsService.prototype, 'search').mockImplementationOnce(async function (this: WorkspaceFsService, request, signal) {
        const hostFs = (this as unknown as { hostFs: IHostFileSystem }).hostFs;
        const readdir = hostFs.readdir.bind(hostFs);
        const observe = vi.spyOn(hostFs, 'readdir').mockImplementation(async (p) => {
          reads.push(p); entered();
          await new Promise<void>((r) => { if (signal!.aborted) { sawAbort(); r(); } else signal!.addEventListener('abort', () => { sawAbort(); r(); }, { once: true }); });
          return readdir(p);
        });
        try { return await search.call(this, request, signal); }
        finally { observe.mockRestore(); finished(); }
      });
      const controller = new AbortController();
      const body = { query: 'needle', limit: 30, follow_gitignore: false };
      const pending = mode === 'workspace'
        ? client.rest!.filesystem.workspaceFsSearch(root, body, { signal: controller.signal })
        : client.rest!.sessions.fsSearch(sessionId!, body, { signal: controller.signal });
      const rejected = expect(pending).rejects.toBeDefined();
      try {
        await reading;
        const start = performance.now();
        controller.abort();
        await aborted;
        const abortMs = performance.now() - start;
        await handled;
        await rejected;
        expect(abortMs).toBeLessThan(1000);
        expect(reads).toEqual([root]);
        spy.mockRestore();
        const normal = mode === 'workspace'
          ? await client.rest!.filesystem.workspaceFsSearch(root, body)
          : await client.rest!.sessions.fsSearch(sessionId!, body);
        expect(normal.items.map((hit) => hit.path)).toEqual(['a/needle.ts', 'b/needle.ts']);
      } finally {
        spy.mockRestore();
        if (sessionId !== undefined) await client.session(sessionId).close();
      }
    });
  });
});
