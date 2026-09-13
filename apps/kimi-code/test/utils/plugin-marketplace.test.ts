import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { KIKI_PLUGIN_MARKETPLACE_URL_ENV } from '#/constant/app';
import {
  BUILT_IN_PLUGIN_MARKETPLACE_SOURCE,
  LOCAL_DEV_PLUGIN_MARKETPLACE_SOURCE,
  computeUpdateStatus,
  loadPluginMarketplace,
  pluginMarketplaceConfigSource,
} from '#/utils/plugin-marketplace';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

describe('computeUpdateStatus', () => {
  it('reports not-installed when the plugin is absent', () => {
    expect(computeUpdateStatus('1.0.0', undefined, false)).toEqual({ kind: 'not-installed' });
  });

  it('reports an update when the marketplace version is newer', () => {
    expect(computeUpdateStatus('5.1.0', '5.0.0', true)).toEqual({
      kind: 'update',
      local: '5.0.0',
      latest: '5.1.0',
    });
  });

  it('reports up-to-date when versions match', () => {
    expect(computeUpdateStatus('5.1.0', '5.1.0', true)).toEqual({
      kind: 'up-to-date',
      version: '5.1.0',
    });
  });

  it('does not offer a downgrade when the local version is ahead', () => {
    expect(computeUpdateStatus('3.1.1', '3.2.0', true)).toEqual({
      kind: 'up-to-date',
      version: '3.2.0',
    });
  });

  it('never reports an update for non-semver versions', () => {
    expect(computeUpdateStatus('latest', '5.0.0', true).kind).toBe('up-to-date');
    expect(computeUpdateStatus('5.1.0', 'dev', true).kind).toBe('up-to-date');
  });

  it('shows the local version even when the marketplace omits one', () => {
    expect(computeUpdateStatus(undefined, '5.0.0', true)).toEqual({
      kind: 'up-to-date',
      version: '5.0.0',
    });
  });

  it('does not claim the marketplace version as installed when the local version is unknown', () => {
    // No spurious `installed · v<latest>`, and no permanent suppression of updates.
    expect(computeUpdateStatus('5.1.0', undefined, true)).toEqual({
      kind: 'up-to-date',
      version: undefined,
    });
  });
});

describe('loadPluginMarketplace', () => {
  it('uses a stable non-remote identity for the built-in-only catalog', () => {
    expect(BUILT_IN_PLUGIN_MARKETPLACE_SOURCE).toBe('builtin:kimi-code-capabilities');
    expect(BUILT_IN_PLUGIN_MARKETPLACE_SOURCE).not.toMatch(/^https?:/);
  });

  it('reads the marketplace source from the raw plugins config section', () => {
    expect(
      pluginMarketplaceConfigSource({
        raw: { plugins: { marketplace_url: ' https://config.test/marketplace.json ' } },
      }),
    ).toBe(' https://config.test/marketplace.json ');
    expect(pluginMarketplaceConfigSource({ raw: { plugins: {} } })).toBeUndefined();
  });

  it('loads a local marketplace file and resolves relative plugin sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({
        version: '1',
        plugins: [
          {
            id: 'kimi-datasource',
            tier: 'official',
            displayName: 'Kimi Datasource',
            version: '1.0.0',
            description: 'Datasource tools',
            source: './kimi-datasource',
            keywords: ['data'],
          },
          {
            id: 'superpowers',
            tier: 'curated',
            displayName: 'Superpowers',
            version: '5.1.0',
            description: 'Workflow skills',
            homepage: 'https://github.com/obra/superpowers',
            source: './curated/superpowers',
            keywords: ['skills', 'workflow'],
          },
        ],
      }),
      'utf8',
    );

    const marketplace = await loadPluginMarketplace({
      workDir: '/tmp/work',
      source: file,
    });

    expect(marketplace.source).toBe(file);
    expect(marketplace.version).toBe('1');
    expect(marketplace.plugins.slice(0, 2)).toEqual([
      {
        id: 'kimi-datasource',
        displayName: 'Kimi Datasource',
        tier: 'official',
        version: '1.0.0',
        description: 'Datasource tools',
        source: join(dir, 'kimi-datasource'),
        keywords: ['data'],
        homepage: undefined,
      },
      {
        id: 'superpowers',
        displayName: 'Superpowers',
        tier: 'curated',
        version: '5.1.0',
        description: 'Workflow skills',
        source: join(dir, 'curated', 'superpowers'),
        keywords: ['skills', 'workflow'],
        homepage: 'https://github.com/obra/superpowers',
      },
    ]);
  });

  const builtInEntries = [
    {
      id: 'kimi-cu',
      displayName: 'Kimi Computer Use',
      description: 'fake cu',
      tier: 'official' as const,
      source: 'capability:kimi-cu',
    },
    {
      id: 'kimi-webbridge',
      displayName: 'Kimi WebBridge',
      description: 'fake wb',
      tier: 'official' as const,
      source: 'capability:kimi-webbridge',
    },
  ];

  it('appends the caller-supplied built-in entries the catalog does not carry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(file, JSON.stringify({ version: '1', plugins: [] }), 'utf8');

    const marketplace = await loadPluginMarketplace({
      workDir: '/tmp/work',
      source: file,
      builtInEntries,
    });

    // The util owns no product knowledge: entries come from the caller (the
    // engine's capability registry), and no version is invented.
    expect(marketplace.plugins).toEqual(builtInEntries);
    expect(marketplace.plugins.map((entry) => entry.version)).toEqual([undefined, undefined]);
  });

  it('masks same-id catalog rows with the built-in entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({
        plugins: [
          {
            id: 'kimi-webbridge',
            tier: 'official',
            displayName: 'Kimi WebBridge',
            version: '1.12.0',
            source: './kimi-webbridge',
          },
        ],
      }),
      'utf8',
    );

    const marketplace = await loadPluginMarketplace({
      workDir: '/tmp/work',
      source: file,
      builtInEntries,
    });

    // What the built-in ids mean stays decided by the client release: the
    // catalog's row contributes the version, but not its source or copy.
    const webbridge = marketplace.plugins.filter((entry) => entry.id === 'kimi-webbridge');
    expect(webbridge).toHaveLength(1);
    expect(webbridge[0]?.source).toBe('capability:kimi-webbridge');
    expect(webbridge[0]?.version).toBe('1.12.0');
    expect(marketplace.plugins.some((entry) => entry.id === 'kimi-cu')).toBe(true);
  });

  it('includes Superpowers in the repository marketplace fixture', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://github.com/obra/superpowers/releases/tag/v6.0.3',
          }),
        } as Response;
      }
      return { status: 404, headers: new Headers() } as Response;
    }) as unknown as typeof fetch;
    const marketplace = await loadPluginMarketplace({
      workDir: REPO_ROOT,
      source: join(REPO_ROOT, 'plugins/marketplace.json'),
      fetchImpl,
    });

    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        id: 'superpowers',
        displayName: 'Superpowers',
        tier: 'curated',
        source: 'https://github.com/obra/superpowers',
        version: '6.0.3',
      }),
    );
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        id: 'kimi-datasource',
        tier: 'official',
        source: join(REPO_ROOT, 'plugins/official/kimi-datasource'),
      }),
    );
  });

  it('loads the source-checkout catalog without any network fetch when no source is configured', async () => {
    const previous = process.env[KIKI_PLUGIN_MARKETPLACE_URL_ENV];
    delete process.env[KIKI_PLUGIN_MARKETPLACE_URL_ENV];
    const fetchImpl = vi.fn(async () => {
      throw new Error('network fetch is forbidden');
    }) as unknown as typeof fetch;

    try {
      const marketplace = await loadPluginMarketplace({
        workDir: '/tmp/work',
        fetchImpl,
        builtInEntries,
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(marketplace.source).toBe(LOCAL_DEV_PLUGIN_MARKETPLACE_SOURCE);
      expect(marketplace.plugins.map((entry) => entry.id)).toEqual(
        expect.arrayContaining(['superpowers', 'kimi-datasource', 'kimi-cu', 'kimi-webbridge']),
      );
    } finally {
      if (previous === undefined) {
        delete process.env[KIKI_PLUGIN_MARKETPLACE_URL_ENV];
      } else {
        process.env[KIKI_PLUGIN_MARKETPLACE_URL_ENV] = previous;
      }
    }
  });

  it('resolves explicit option, env, and config sources in precedence order', async () => {
    const previous = process.env[KIKI_PLUGIN_MARKETPLACE_URL_ENV];
    const optionSource = 'https://option.test/marketplace.json';
    const envSource = 'https://env.test/marketplace.json';
    const configSource = 'https://config.test/marketplace.json';
    const fetchMock = vi.fn(async (input: string | URL) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          plugins: [
            {
              id: new URL(String(input)).hostname,
              version: '1.0.0',
              source: './plugin.zip',
            },
          ],
        }),
    }));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    process.env[KIKI_PLUGIN_MARKETPLACE_URL_ENV] = envSource;

    try {
      const fromOption = await loadPluginMarketplace({
        workDir: '/tmp/work',
        source: optionSource,
        configSource,
        fetchImpl,
      });
      expect(fromOption.source).toBe(optionSource);
      expect(fromOption.plugins[0]?.id).toBe('option.test');

      const fromEnv = await loadPluginMarketplace({
        workDir: '/tmp/work',
        configSource,
        fetchImpl,
      });
      expect(fromEnv.source).toBe(envSource);
      expect(fromEnv.plugins[0]?.id).toBe('env.test');

      delete process.env[KIKI_PLUGIN_MARKETPLACE_URL_ENV];
      const fromConfig = await loadPluginMarketplace({
        workDir: '/tmp/work',
        configSource,
        fetchImpl,
      });
      expect(fromConfig.source).toBe(configSource);
      expect(fromConfig.plugins[0]?.id).toBe('config.test');
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
        optionSource,
        envSource,
        configSource,
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env[KIKI_PLUGIN_MARKETPLACE_URL_ENV];
      } else {
        process.env[KIKI_PLUGIN_MARKETPLACE_URL_ENV] = previous;
      }
    }
  });

  it('does not use the source-checkout catalog for an explicit marketplace source', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;

    await expect(
      loadPluginMarketplace({
        workDir: '/tmp/work',
        source: 'https://example.test/marketplace.json',
        fetchImpl,
      }),
    ).rejects.toThrow(/fetch failed/);
  });

  it('keeps the built-in entries when the catalog is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;

    // Explicit source (no checkout fallback) + unreachable: the built-ins do
    // not come from the catalog, so they must survive the outage.
    const marketplace = await loadPluginMarketplace({
      workDir: '/tmp/work',
      source: 'https://example.test/marketplace.json',
      fetchImpl,
      builtInEntries,
    });

    expect(marketplace.plugins.map((entry) => entry.id)).toEqual(['kimi-cu', 'kimi-webbridge']);
  });

  describe('version derivation from a GitHub source', () => {
    async function loadEntry(source: string, version?: string) {
      const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
      const file = join(dir, 'marketplace.json');
      await writeFile(
        file,
        JSON.stringify({
          plugins: [
            {
              id: 'demo',
              displayName: 'Demo',
              source,
              version,
            },
          ],
        }),
        'utf8',
      );
      const marketplace = await loadPluginMarketplace({ workDir: dir, source: file });
      return marketplace.plugins[0]!;
    }

    it('derives a version from a /releases/tag/ source', async () => {
      const entry = await loadEntry('https://github.com/obra/superpowers/releases/tag/v6.0.3');
      expect(entry.version).toBe('6.0.3');
    });

    it('derives a version from a /tree/ source', async () => {
      const entry = await loadEntry('https://github.com/obra/superpowers/tree/v6.0.3');
      expect(entry.version).toBe('6.0.3');
    });

    it('accepts a tag without a leading v', async () => {
      const entry = await loadEntry('https://github.com/obra/superpowers/releases/tag/6.0.3');
      expect(entry.version).toBe('6.0.3');
    });

    it('does not derive a version from a commit SHA', async () => {
      const entry = await loadEntry('https://github.com/obra/superpowers/commit/abc1234');
      expect(entry.version).toBeUndefined();
    });

    it('does not derive a version from a non-GitHub URL', async () => {
      const entry = await loadEntry('https://example.test/plugins/curated/superpowers.zip');
      expect(entry.version).toBeUndefined();
    });

    it('lets an explicit version override the derived one', async () => {
      const entry = await loadEntry(
        'https://github.com/obra/superpowers/releases/tag/v6.0.3',
        '9.9.9',
      );
      expect(entry.version).toBe('9.9.9');
    });
  });

  describe('latest release resolution for bare GitHub sources', () => {
    async function loadWithLatest(source: string, fetchImpl: typeof fetch) {
      const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
      const file = join(dir, 'marketplace.json');
      await writeFile(
        file,
        JSON.stringify({ plugins: [{ id: 'demo', displayName: 'Demo', source }] }),
        'utf8',
      );
      const marketplace = await loadPluginMarketplace({ workDir: dir, source: file, fetchImpl });
      return marketplace.plugins[0]!;
    }

    function redirectFetch(location: string): typeof fetch {
      return vi.fn(async () => ({
        status: 302,
        headers: new Headers({ location }),
      })) as unknown as typeof fetch;
    }

    it('fills the version from /releases/latest for a bare repo URL', async () => {
      const entry = await loadWithLatest(
        'https://github.com/owner/repo',
        redirectFetch('https://github.com/owner/repo/releases/tag/v6.0.3'),
      );
      expect(entry.version).toBe('6.0.3');
    });

    it('strips a leading v from the resolved latest tag', async () => {
      const entry = await loadWithLatest(
        'https://github.com/owner/repo',
        redirectFetch('https://github.com/owner/repo/releases/tag/6.0.3'),
      );
      expect(entry.version).toBe('6.0.3');
    });

    it('leaves version undefined when the repo has no release', async () => {
      const fetchImpl = vi.fn(async () => ({
        status: 404,
        headers: new Headers(),
      })) as unknown as typeof fetch;
      const entry = await loadWithLatest('https://github.com/owner/repo', fetchImpl);
      expect(entry.version).toBeUndefined();
    });

    it('degrades gracefully when the latest lookup throws', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch;
      const entry = await loadWithLatest('https://github.com/owner/repo', fetchImpl);
      expect(entry.version).toBeUndefined();
    });

    it('does not query latest when the source already pins a ref', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('should not be called');
      }) as unknown as typeof fetch;
      const entry = await loadWithLatest(
        'https://github.com/owner/repo/releases/tag/v6.0.3',
        fetchImpl,
      );
      expect(entry.version).toBe('6.0.3');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('keeps an explicit version without querying latest', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('should not be called');
      }) as unknown as typeof fetch;
      const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
      const file = join(dir, 'marketplace.json');
      await writeFile(
        file,
        JSON.stringify({
          plugins: [
            {
              id: 'demo',
              displayName: 'Demo',
              version: '9.9.9',
              source: 'https://github.com/owner/repo',
            },
          ],
        }),
        'utf8',
      );
      const marketplace = await loadPluginMarketplace({ workDir: dir, source: file, fetchImpl });
      expect(marketplace.plugins[0]?.version).toBe('9.9.9');
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it('accepts legacy marketplace type aliases as normal plugins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({
        plugins: [
          {
            id: 'kimi-webbridge',
            type: 'guide',
            displayName: 'Kimi WebBridge',
            source: './kimi-webbridge',
            installSkill: 'install',
            removeSkill: 'remove',
          },
          {
            id: 'demo-managed',
            type: 'managed',
            source: './demo-managed',
          },
        ],
      }),
      'utf8',
    );

    const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', source: file });

    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        id: 'kimi-webbridge',
        source: join(dir, 'kimi-webbridge'),
      }),
    );
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        id: 'demo-managed',
        source: join(dir, 'demo-managed'),
      }),
    );
  });

  it('rejects an entry without a source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({ plugins: [{ id: 'broken', displayName: 'Broken' }] }),
      'utf8',
    );

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /must define "source"/,
    );
  });

  it('loads an explicit remote marketplace with injectable fetch', async () => {
    const source = 'https://example.com/plugins/marketplace.json';
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          plugins: [{ id: 'superpowers', name: 'Superpowers', url: 'superpowers.zip' }],
        }),
    })) as unknown as typeof fetch;

    const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', source, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(source);
    expect(marketplace.plugins[0]).toEqual(
      expect.objectContaining({
        id: 'superpowers',
        displayName: 'Superpowers',
        source: new URL('superpowers.zip', source).toString(),
      }),
    );
  });

  it('rejects malformed marketplace entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(file, JSON.stringify({ plugins: [{ displayName: 'Missing id' }] }), 'utf8');

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /must define "id"/,
    );
  });

  it('rejects unknown marketplace tier values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({
        plugins: [{ id: 'demo', tier: 'community', source: './demo' }],
      }),
      'utf8',
    );

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /"tier" must be one of/,
    );
  });

  it('rejects unknown marketplace entry types', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({
        plugins: [{ id: 'demo', type: 'integration', source: './demo' }],
      }),
      'utf8',
    );

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /Legacy aliases "managed" and "guide" are also accepted/,
    );
  });

});
