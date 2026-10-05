import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { entryAcceptsEngine, readDefaultPluginCatalog } from '#/app/plugin/defaultCatalog';
import { parsePluginMarketplace, resolveMarketplaceLocation } from '#/app/plugin/marketplace';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const generator = join(repoRoot, 'packages/agent-core-v2/scripts/gen-official-plugin-metadata.mjs');
const createdDirs: string[] = [];

async function scratch(): Promise<string> {
  const root = join(repoRoot, '.tmp');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'default-catalog-test-'));
  createdDirs.push(dir);
  return dir;
}

async function generate(pluginsRoot: string, output: string): Promise<unknown> {
  await promisify(execFile)(process.execPath, [generator, pluginsRoot, output]);
  return JSON.parse(await readFile(output, 'utf8'));
}

afterEach(async () => {
  for (const dir of createdDirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const offline: typeof fetch = async () => {
  throw new Error('offline');
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('default plugin catalog', () => {
  it('lists every official package and the curated community entries, with no payload', async () => {
    const { marketplace, installable } = await readDefaultPluginCatalog({ fetchImpl: offline });
    const official = marketplace.plugins.filter((entry) => entry.tier === 'official');
    const curated = marketplace.plugins.filter((entry) => entry.tier === 'curated');

    expect(official.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'kiki-office', 'kiki-writing', 'kiki-extract', 'kiki-notion', 'kiki-media',
      'kimi-datasource', 'kimi-webbridge',
    ]));
    expect(official.length).toBeGreaterThanOrEqual(17);
    expect(curated.map((entry) => entry.id)).toEqual(['superpowers', 'vercel-plugin', 'modern-web-guidance']);
    expect(installable).toBe(official.length);
    for (const entry of official) {
      expect(entry.displayName, entry.id).not.toBe('');
      expect(entry.description, entry.id).toBeTruthy();
      expect(entry.author, entry.id).toBeTruthy();
      expect(entry.source, entry.id).toMatch(/^https?:\/\/.+\.zip$/);
      expect(entry.sha256, entry.id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('serves the published catalog, archive and digest included, when this build has no tree of its own', async () => {
    const digest = 'b'.repeat(64);
    const { marketplace, installable } = await readDefaultPluginCatalog({
      fetchImpl: async () => jsonResponse({
        version: '1',
        plugins: [{
          id: 'kiki-office',
          tier: 'official',
          displayName: 'Kiki Office Suite',
          version: '0.1.0',
          source: 'https://cdn.example.test/kiki/kiki-office-0.1.0.zip',
          sha256: digest,
          engines: { kiki: '^0.4.0' },
        }],
      }),
      url: 'https://cdn.example.test/kiki/marketplace.json',
    });
    const entry = marketplace.plugins.find((item) => item.id === 'kiki-office')!;
    expect(entry.source).toBe('https://cdn.example.test/kiki/kiki-office-0.1.0.zip');
    expect(entry.sha256).toBe(digest);
    expect(entry.version).toBe('0.1.0');
    expect(installable).toBe(1);
  });

  it('falls back to the bundled snapshot after an unavailable catalog request', async () => {
    let called = 0;
    const { marketplace, installable } = await readDefaultPluginCatalog({
      fetchImpl: async () => { called++; throw new Error('offline'); },
      url: 'https://offline.invalid/kiki/marketplace.json',
    });
    expect(called).toBe(1);
    expect(installable).toBe(marketplace.plugins.filter((entry) => entry.tier === 'official').length);
  });

  it('gives every official entry a published archive and the digest to verify it', async () => {
    const { marketplace, installable } = await readDefaultPluginCatalog({
      fetchImpl: async () => { throw new Error('offline'); },
    });
    const official = marketplace.plugins.filter((entry) => entry.tier === 'official');
    expect(installable).toBe(official.length);
    for (const entry of official) {
      expect(entry.source, entry.id).toMatch(/^https?:\/\/.+\.zip$/);
      expect(entry.sha256, entry.id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('falls back to the bundled snapshot when the published catalog is unreachable or unparseable', async () => {
    const offlineResult = await readDefaultPluginCatalog({ fetchImpl: offline });
    expect(offlineResult.marketplace.plugins.length).toBeGreaterThanOrEqual(20);
    const broken = await readDefaultPluginCatalog({
      fetchImpl: async () => jsonResponse({ version: '1', plugins: [{ id: 'x', source: 'https://a.test/x.zip', sha256: 'nope' }] }),
    });
    expect(broken.marketplace.plugins.length).toBeGreaterThanOrEqual(20);
    expect(broken.marketplace.plugins.every((entry) => entry.id !== 'x')).toBe(true);
  });

  it('carries no payload: a published archive URL and its digest, never bytes', async () => {
    const { marketplace } = await readDefaultPluginCatalog({ fetchImpl: offline });
    for (const entry of marketplace.plugins) {
      if (entry.source === '') continue;
      expect(entry.source, entry.id).toMatch(/^https?:\/\/|^[A-Za-z]:[\\/]|\.zip$/);
    }
  });

  it('keeps real author, license and engine facts and invents none', async () => {
    const { marketplace } = await readDefaultPluginCatalog({ fetchImpl: offline });
    const byId = new Map(marketplace.plugins.map((entry) => [entry.id, entry]));
    expect(byId.get('kimi-webbridge')?.author).toBe('Moonshot AI');
    expect(byId.get('kimi-webbridge')?.license).toBe('Proprietary');
    expect(byId.get('kiki-office')?.author).toBe('Kiki');
    expect(byId.get('kiki-office')?.license).toBe('MIT');
    expect(byId.get('superpowers')?.author).toBe('Jesse Vincent');
    expect(byId.get('superpowers')?.author).not.toBe('Kiki');
    expect(byId.get('kimi-datasource')?.license).toBe('License not declared by upstream');
    expect(byId.get('kiki-media-stepfun')?.license).toBe('MIT AND Apache-2.0');
    expect(byId.get('kiki-media')?.engines).toEqual({ kiki: '>=0.4.0' });
    expect(byId.get('kiki-notion')?.engines).toBeUndefined();
  });

  it('groups a package family by what the catalog declares', async () => {
    const { marketplace } = await readDefaultPluginCatalog({ fetchImpl: offline });
    const media = marketplace.plugins.filter((entry) => entry.group === 'media');
    expect(media.map((entry) => entry.id)).toContain('kiki-media');
    expect(media.length).toBeGreaterThanOrEqual(10);
  });

  it('accepts the engine ranges the packages actually declare', () => {
    expect(entryAcceptsEngine({ kiki: '^0.4.0' })).toBe(true);
    expect(entryAcceptsEngine({ kiki: '>=0.4.0' })).toBe(true);
    expect(entryAcceptsEngine({ kiki: '0.4.0' })).toBe(true);
    expect(entryAcceptsEngine({ kiki: '>=0.3.0' })).toBe(true);
    expect(entryAcceptsEngine({ kiki: '^0.5.0' })).toBe(false);
    expect(entryAcceptsEngine({ kiki: '<0.4.0' })).toBe(false);
    expect(entryAcceptsEngine({ kiki: '0.3.x' })).toBe(false);
    expect(entryAcceptsEngine(undefined)).toBe(true);
    expect(entryAcceptsEngine({})).toBe(true);
  });

  it.each([
    ['^0.3.0', false], ['^0.4.0', true], ['^0.0.4', false],
    ['~0.4.9', false], ['~0.4.0', true], ['0.4.x', true],
    ['0.3.0 - 0.4.0', true], ['^0.3.0 || ~0.4.0', true],
    ['>=0.4.0 <0.5.0', true], ['0.4.0-beta.1', false],
    ['not-a-range', false], ['^oops', false], ['*', true], ['', false], [' ', true],
  ])('uses installer-compatible semver for %s', async (range, accepted) => {
    const { parsePluginExtension } = await import('#/app/plugin/contributions');
    const diagnostics: import('#/app/plugin/types').PluginDiagnostic[] = [];
    await parsePluginExtension(repoRoot, { engines: { kiki: range } }, diagnostics);
    expect(entryAcceptsEngine({ kiki: range })).toBe(accepted);
    expect(diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(!accepted);
  });

  it('picks up a newly added package from catalog data alone without a payload directory', async () => {
    const dir = await scratch();
    const listed = {
      id: 'brand-new',
      tier: 'official',
      displayName: 'Brand New Package',
      version: '4.5.6',
      description: 'Described only in catalog data.',
      keywords: ['new', 'test'],
      author: 'Example Author',
      license: 'MIT',
      group: 'newcomer',
      source: './official/brand-new',
      publishedSource: 'https://cdn.example.test/brand-new-4.5.6.zip',
      sha256: 'a'.repeat(64),
      engines: { kiki: '^0.4.0' },
      localizations: { zh: { description: '目录中的新包。' }, 'fr-CA': { keywords: ['nouveau'] } },
    };
    await writeFile(join(dir, 'marketplace.json'), JSON.stringify({ version: '1', plugins: [listed] }));
    const after = await generate(dir, join(dir, 'after.json')) as { official: Record<string, unknown>[] };
    const { publishedSource, ...expected } = listed;
    expect(after.official).toEqual([{ ...expected, source: publishedSource }]);
    await expect(stat(join(dir, 'official'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('regenerates all 20 checked-in entries without any official directory and matches the shipped snapshot', async () => {
    const dir = await scratch();
    await cp(join(repoRoot, 'plugins/marketplace.json'), join(dir, 'marketplace.json'));
    const generated = await generate(dir, join(dir, 'metadata.json')) as {
      official: Record<string, unknown>[]; curated: Record<string, unknown>[];
    };
    expect(generated.official).toHaveLength(17);
    expect(generated.curated).toHaveLength(3);
    const catalog = JSON.parse(await readFile(join(dir, 'marketplace.json'), 'utf8')) as {
      plugins: Record<string, unknown>[];
    };
    const expected = parsePluginMarketplace(JSON.stringify(catalog), resolveMarketplaceLocation(join(dir, 'marketplace.json'), dir), true);
    expect([...generated.official, ...generated.curated].map((entry) => entry['id']).toSorted())
      .toEqual(expected.plugins.map((entry) => entry.id).toSorted());
    for (const entry of [...generated.official, ...generated.curated]) {
      const published = expected.plugins.find((item) => item.id === entry['id'])!;
      for (const field of ['source', 'sha256', 'version', 'icon', 'engines', 'license', 'author', 'localizations']) {
        expect(entry[field], `${String(entry['id'])}.${field}`).toEqual(published[field as keyof typeof published]);
      }
    }
    expect(generated).toEqual(JSON.parse(await readFile(join(repoRoot, 'packages/agent-core-v2/src/app/plugin/officialPlugins.metadata.json'), 'utf8')));
    await expect(stat(join(dir, 'official'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['missing-digest', 'malformed-digest', 'checkout-only', 'duplicate-id'])(
    'rejects an unusable release snapshot input: %s', async (failure) => {
      const dir = await scratch();
      const entry = { id: 'example', tier: 'official', version: '1.0.0', author: 'Example', source: 'https://cdn.example.test/example.zip', sha256: 'a'.repeat(64) };
      const broken = { ...entry, sha256: failure === 'missing-digest' ? undefined : failure === 'malformed-digest' ? 'bad' : entry.sha256,
        source: failure === 'checkout-only' ? './official/example' : entry.source };
      await writeFile(join(dir, 'marketplace.json'), JSON.stringify({ plugins: failure === 'duplicate-id' ? [entry, entry] : [broken] }));
      await expect(generate(dir, join(dir, 'metadata.json'))).rejects.toThrow();
      await expect(stat(join(dir, 'metadata.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['headers', 'body'])('falls back when the published catalog stalls at %s', async (phase) => {
    const nativeTimeout = AbortSignal.timeout;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => nativeTimeout(150));
    const server = createServer((_request, response) => {
      if (phase === 'body') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{');
      }
    });
    try {
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Missing loopback server address');
      const { marketplace, installable } = await readDefaultPluginCatalog({ url: `http://127.0.0.1:${address.port}/marketplace.json` });
      expect(timeout).toHaveBeenCalledWith(5_000);
      expect(marketplace.plugins).toHaveLength(20);
      expect(installable).toBe(17);
    } finally {
      timeout.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((done, fail) => server.close((error) => error === undefined ? done() : fail(error)));
    }
  });

  it('parses a published index entry with its digest, icon, author and group intact', () => {
    const digest = 'a'.repeat(64);
    const raw = JSON.stringify({
      version: '1',
      plugins: [{
        id: 'kiki-office',
        displayName: 'Kiki Office Suite',
        version: '0.1.0',
        source: './official/kiki-office/kiki-office-0.1.0.zip',
        sha256: digest,
        icon: 'https://cdn.example.test/kiki/official/kiki-office/icon-0.1.0.svg',
        engines: { kiki: '^0.4.0' },
        author: 'Kiki',
        license: 'MIT',
        group: 'media',
      }],
    });
    const location = resolveMarketplaceLocation('https://cdn.example.test/kiki/marketplace.json', process.cwd());
    const entry = parsePluginMarketplace(raw, location).plugins[0]!;

    expect(entry.source).toBe('https://cdn.example.test/kiki/official/kiki-office/kiki-office-0.1.0.zip');
    expect(entry.sha256).toBe(digest);
    expect(entry.icon).toBe('https://cdn.example.test/kiki/official/kiki-office/icon-0.1.0.svg');
    expect(entry.engines?.kiki).toBe('^0.4.0');
    expect(entry.author).toBe('Kiki');
    expect(entry.license).toBe('MIT');
    expect(entry.group).toBe('media');
  });

  it('keeps explicit checkout sources separate from published archive consumption', () => {
    const location = resolveMarketplaceLocation(join(repoRoot, 'plugins/marketplace.json'), repoRoot);
    const publishedSource = 'https://cdn.example.test/example-1.0.0.zip';
    const raw = JSON.stringify({ plugins: [{ id: 'example', source: '../../example-plugins/example', publishedSource, sha256: 'a'.repeat(64) }] });
    expect(parsePluginMarketplace(raw, location).plugins[0]?.source).toBe(resolve(repoRoot, '../example-plugins/example'));
    expect(parsePluginMarketplace(raw, location, true).plugins[0]).toMatchObject({ source: publishedSource, sha256: 'a'.repeat(64) });
  });

  it('rejects a malformed digest at the catalog, where the bad value can be pointed at', () => {
    const raw = JSON.stringify({
      version: '1',
      plugins: [{
        id: 'broken',
        displayName: 'Broken',
        source: 'https://cdn.example.test/broken.zip',
        sha256: 'not-a-digest',
      }],
    });
    const location = resolveMarketplaceLocation('https://cdn.example.test/kiki/marketplace.json', process.cwd());
    expect(() => parsePluginMarketplace(raw, location)).toThrow(/broken.*sha256/s);
  });

  it('carries catalog localization through the snapshot into the served entries', async () => {
    const { marketplace } = await readDefaultPluginCatalog({ fetchImpl: offline });
    const office = marketplace.plugins.find((entry) => entry.id === 'kiki-office')!;
    expect(office.localizations?.['zh']?.description).toBeTruthy();
    expect(office.localizations?.['zh']?.keywords).toContain('办公');
    expect(office.localizations?.['zh']?.displayName).toBeUndefined();
    for (const entry of marketplace.plugins) {
      expect(entry.localizations?.['zh']?.description, entry.id).toBeTruthy();
    }
  });

  it('parses a localized entry and rejects a malformed one', () => {
    const location = resolveMarketplaceLocation('https://cdn.example.test/kiki/marketplace.json', process.cwd());
    const raw = JSON.stringify({
      version: '1',
      plugins: [{
        id: 'kiki-office',
        displayName: 'Kiki Office Suite',
        source: 'https://cdn.example.test/o.zip',
        localizations: { zh: { description: '在本机创建 Word 文件。', keywords: ['办公'] } },
      }],
    });
    const entry = parsePluginMarketplace(raw, location).plugins[0]!;
    expect(entry.localizations?.['zh']?.description).toBe('在本机创建 Word 文件。');
    expect(entry.localizations?.['zh']?.keywords).toEqual(['办公']);

    const bad = JSON.stringify({
      version: '1',
      plugins: [{ id: 'kiki-office', displayName: 'X', source: 'https://a.test/x.zip', localizations: { zh: 'nope' } }],
    });
    expect(() => parsePluginMarketplace(bad, location)).toThrow(/kiki-office.*localizations/s);
  });
});
