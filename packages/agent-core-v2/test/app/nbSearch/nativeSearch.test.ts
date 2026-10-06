import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalConfigPatch } from '@nb-corp/nb-search';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IConfigService } from '#/app/config/config';
import { NB_SEARCH_SECTION } from '#/app/nbSearch/configSection';
import { INbSearchService } from '#/app/nbSearch/nbSearch';
import { NbSearchService } from '#/app/nbSearch/nbSearchService';
import { INbSearchSourceStore, NbSearchSourceStore } from '#/app/nbSearch/sourceStore';
import { IWebSearchTool, type WebSearchInput } from '#/agent/tools/web-search/web-search';
import { WebSearchTool } from '#/agent/tools/web-search/webSearchTool';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';

let root: string;
let disposables: DisposableStore;
let ix: TestInstantiationService;
let config: CanonicalConfigPatch | undefined;
const live = process.env['NB_SEARCH_LIVE_TEST'] === '1';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kiki-native-search-'));
  for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('NB_SEARCH_')) vi.stubEnv(key, undefined);
  vi.stubEnv('KIKI_HOME', join(root, 'kiki'));
  vi.stubEnv('NB_SEARCH_HOME', join(root, 'nb-search'));
  config = undefined;
  disposables = new DisposableStore();
  ix = createServices(disposables, { additionalServices: (reg) => {
    reg.definePartialInstance(IConfigService, {
      ready: Promise.resolve(),
      onDidChangeConfiguration: Event.None as IConfigService['onDidChangeConfiguration'],
      get: ((domain: string) => domain === NB_SEARCH_SECTION ? config : undefined) as IConfigService['get'],
    });
    reg.defineInstance(IHostFileSystem, new HostFileSystem());
    reg.defineInstance(IFileSystemStorageService, new FileStorageService(join(root, 'kiki')));
    reg.define(INbSearchSourceStore, NbSearchSourceStore);
    reg.define(INbSearchService, NbSearchService);
    reg.define(IWebSearchTool, WebSearchTool);
  } });
});

afterEach(async () => {
  await disposables.dispose();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function execute(input: WebSearchInput) {
  const execution = await ix.get(IWebSearchTool).resolveExecution(input);
  if (execution.isError) return execution;
  return execution.execute({ turnId: 0, toolCallId: 'native-search', signal: new AbortController().signal });
}

function mockPage(body: string, status = 200) {
  const fetch = vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'text/html' } }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const page = '<div class="result"><a class="result__a" href="https://example.com/astronomy">Astronomy guide</a><a class="result__snippet">Explore the universe.</a></div>';

describe('native WebSearch zero-configuration contract', () => {
  it('uses the shipped general-web default through real source capture and runtime', async () => {
    const fetch = mockPage(page);
    const service = ix.get(INbSearchService);
    const capabilities = await service.capabilities();
    expect(capabilities.config_source).toMatchObject({ local_config: 'missing', local_credentials: 'missing', availability: 'ready' });
    expect(capabilities.search.default_lane).toBe('duckduckgo.search');
    expect(capabilities.providers.instances.find((entry) => entry.id === 'duckduckgo.default')?.credential.configured).toBe(false);
    expect(await execute({ query: 'astronomy' })).toMatchObject({ isError: false, output: expect.stringContaining('Title: Astronomy guide\nURL: https://example.com/astronomy\nSnippet: Explore the universe.') });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('https://html.duckduckgo.com/html/?q=astronomy', expect.any(Object));
  });

  it('does not parse a challenge or unsupported page as success or no results', async () => {
    for (const body of ['<form id="challenge-form">captcha</form><div class="no-results">No results found</div>', '<html>No results found</html>']) {
      const fetch = mockPage(body);
      expect(await execute({ query: 'astronomy' })).toMatchObject({ isError: true, output: expect.stringContaining('PROVIDER_UNAVAILABLE') });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it('keeps rate-limit recovery metadata in the minimal native response', async () => {
    config = { execution: { retry_count: 0 } };
    const fetch = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '7' } }));
    vi.stubGlobal('fetch', fetch);
    expect(await execute({ query: 'astronomy' })).toMatchObject({ isError: true, output: expect.stringContaining('Retry after 7 seconds') });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('preserves explicit disabled, removed and credentialed defaults without sending a request', async () => {
    const fetch = mockPage(page);
    for (const patch of [{ defaults: { search_lane: null } }, { defaults: { search_lane: 'exa.search' } }, { provider_instances: { 'duckduckgo.default': { enabled: false } } }]) {
      config = patch;
      expect(await execute({ query: 'astronomy' })).toMatchObject({ isError: true });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.runIf(live).each(['NASA James Webb telescope', '中国 大熊猫 国家公园'])('live empty-home minimal WebSearch: %s', async (query) => {
    const service = ix.get(INbSearchService);
    const capabilities = await service.capabilities();
    expect(capabilities.config_source).toMatchObject({ local_config: 'missing', local_credentials: 'missing' });
    expect(capabilities.search.default_lane).toBe('duckduckgo.search');
    const search = vi.spyOn(service, 'search');
    const result = await execute({ query });
    const envelope = await search.mock.results[0]!.value;
    console.log(JSON.stringify({ query, config_source: capabilities.config_source, envelope, native_output: result }, null, 2));
    expect(result.isError).toBe(false);
    expect(envelope).toMatchObject({ status: 'succeeded', selection: { source: 'default', lanes: ['duckduckgo.search'] }, output: { channel: 'results', results: expect.arrayContaining([expect.objectContaining({ title: expect.any(String), url: expect.stringMatching(/^https?:\/\/(?!github\.com)/), snippet: expect.any(String) })]) } });
    expect(result.output).toMatch(/Title: .+\n(?:.*\n)*URL: https?:\/\//);
  }, 35_000);
});
