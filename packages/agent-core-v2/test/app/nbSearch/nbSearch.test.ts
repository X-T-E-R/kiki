import type {
  CapabilityEnvelope,
  FetchRunSyncEnvelope,
  NbSearchRuntime,
  SearchRunSyncEnvelope,
} from '@nb-corp/nb-search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { FetchURLTool } from '#/agent/tools/fetch-url/fetchUrlTool';
import { IFetchURLTool } from '#/agent/tools/fetch-url/fetch-url';
import { IWebSearchTool } from '#/agent/tools/web-search/web-search';
import { WebSearchTool } from '#/agent/tools/web-search/webSearchTool';
import { IConfigService, type ConfigChangedEvent } from '#/app/config/config';
import { NB_SEARCH_SECTION } from '#/app/nbSearch/configSection';
import { INbSearchService, type NbSearchTestStatus } from '#/app/nbSearch/nbSearch';
import { NbSearchService } from '#/app/nbSearch/nbSearchService';
import {
  DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

const { createRuntimeMock } = vi.hoisted(() => ({ createRuntimeMock: vi.fn() }));

vi.mock('@nb-corp/nb-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nb-corp/nb-search')>()),
  createNbSearchRuntime: createRuntimeMock,
}));

const CAPABILITIES: CapabilityEnvelope = {
  schema_version: '3.0',
  revision: 'config-test',
  providers: { descriptors: [], instances: [] },
  search: {
    default_lane: 'exa.search',
    lanes: [
      {
        id: 'exa.search',
        output: { channel: 'results', schema_id: 'nb-search.results@1' },
        execution_modes: ['sync'],
        availability: 'ready',
        issues: [],
        latency: 'fast',
        cost: 'cheap',
      },
    ],
    presets: [],
    limits: { max_queries: 64, max_results: 100, max_timeout_ms: 3_600_000, max_inline_bytes: 65_536 },
  },
  fetch: {
    default_representation: 'markdown',
    inputs: [{ kind: 'url', enabled: true, max_bytes: 2_097_152 }],
    chains: [
      { input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] },
    ],
    pipelines: [
      {
        id: 'direct.fetch',
        input_kinds: ['url'],
        media_types: ['text/html', 'text/plain'],
        representations: ['markdown', 'text'],
        execution_modes: ['sync', 'async'],
        egress: 'url',
        stages: [{ id: 'direct-http', role: 'acquire' }],
        availability: 'ready',
        issues: [],
        latency: 'fast',
        cost: 'free',
      },
      {
        id: 'jina.reader',
        input_kinds: ['url'],
        media_types: ['text/html'],
        representations: ['markdown', 'text'],
        execution_modes: ['sync', 'async'],
        egress: 'url',
        stages: [{ id: 'jina-reader', role: 'reader' }],
        availability: 'unavailable',
        issues: [{ code: 'LANE_NOT_CONFIGURED' }],
        latency: 'medium',
        cost: 'free',
      },
    ],
    limits: {
      max_source_bytes: 2_097_152,
      max_response_bytes: 2_097_152,
      max_content_chars: 200_000,
      max_redirects: 5,
      max_timeout_ms: 60_000,
      max_inline_bytes: 65_536,
    },
  },
  jobs: { result_ttl_seconds: 259_200, cancel_supported: true },
};

function searchEnvelope(status: SearchRunSyncEnvelope['status']): SearchRunSyncEnvelope {
  const results = status === 'empty' || status === 'failed' ? [] : [
    {
      title: 'Example',
      url: 'https://example.com/result',
      snippet: 'Example snippet',
      site_name: 'Example Site',
      published_at: '2026-09-04',
      evidence_groups: ['exa'],
      provenance: [
        {
          lane: 'exa.search',
          provider_instance_id: 'exa.default',
          query_index: 0,
          rank: 1,
          original_url: 'https://example.com/result',
          evidence_groups: ['exa'],
        },
      ],
    },
  ];
  return {
    schema_version: '3.0',
    action: 'run',
    execution: 'sync',
    selection: { source: 'default', lanes: ['exa.search'] },
    status,
    output: {
      channel: 'results',
      schema_id: 'nb-search.results@1',
      status,
      lanes: ['exa.search'],
      results,
      lane_outcomes: [],
      merge_summary: {
        input_rows: results.length,
        canonical_dedup: results.length,
        independent_evidence_groups: results.length,
        result_count: results.length,
      },
      hints: [],
    },
    hints: [],
  };
}

function typedSearchEnvelope(
  status: SearchRunSyncEnvelope['status'] = 'succeeded',
): SearchRunSyncEnvelope {
  return {
    schema_version: '3.0',
    action: 'run',
    execution: 'sync',
    selection: { source: 'default', lanes: ['context7.docs'] },
    status,
    output: {
      channel: 'typed',
      lane: 'context7.docs',
      schema_id: 'nb-search.docs-context@1',
      status,
      data: {
        library: { id: '/example/library', title: 'Example Library' },
        content: '### Example\n\nTyped documentation content.',
        sources: [{ url: 'https://example.com/docs', title: 'Example docs' }],
      },
      lane_outcomes: [],
      hints: [],
    },
    hints: [],
  };
}

function fetchEnvelope(status: FetchRunSyncEnvelope['status'], content = 'BODY'): FetchRunSyncEnvelope {
  return {
    schema_version: '3.0',
    mode: 'fetch',
    action: 'run',
    execution: 'sync',
    selection: { source: 'default' },
    status,
    lane_outcomes: [],
    documents: content.length === 0 ? [] : [
      {
        url: 'https://example.com',
        final_url: 'https://example.com',
        content,
        content_type: 'text/html',
        media_type: 'text/html',
        representation: 'markdown',
        format: 'text',
        byte_length: content.length,
        truncated: status === 'partial',
        warnings: [],
        source_lane: 'direct.fetch',
      },
    ],
    hints: [],
  };
}

function testStatus(): NbSearchTestStatus {
  return {
    revision: 'config-test',
    search: { configured: true, available: true, selection: 'exa.search', issues: [] },
    fetch: {
      configured: true,
      available: true,
      selection: 'direct.fetch -> jina.reader',
      issues: ['LANE_NOT_CONFIGURED'],
    },
  };
}

function stubService(overrides: Partial<INbSearchService> = {}): INbSearchService {
  return {
    _serviceBrand: undefined,
    search: vi.fn().mockResolvedValue(searchEnvelope('succeeded')),
    fetch: vi.fn().mockResolvedValue(fetchEnvelope('succeeded')),
    capabilities: vi.fn().mockResolvedValue(CAPABILITIES),
    test: vi.fn().mockResolvedValue(testStatus()),
    ...overrides,
  };
}

async function execute(execution: ToolExecution | Promise<ToolExecution>, signal: AbortSignal): Promise<ExecutableToolResult> {
  const resolved = await execution;
  if (resolved.isError === true) return resolved;
  const context: ExecutableToolContext = { turnId: 0, toolCallId: 'call_test', signal };
  return resolved.execute(context);
}

describe('NbSearchService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let configChanges: Emitter<ConfigChangedEvent>;

  beforeEach(() => {
    createRuntimeMock.mockReset();
    configChanges = new Emitter<ConfigChangedEvent>();
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IConfigService, {
          get: (() => ({ defaults: { search_lane: 'exa.search' } })) as IConfigService['get'],
          onDidChangeConfiguration: configChanges.event,
        });
        reg.define(INbSearchService, NbSearchService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('uses runtime.search and runtime.fetch without a provider fallback', async () => {
    const runtime = {
      search: vi.fn().mockResolvedValue(searchEnvelope('succeeded')),
      fetch: vi.fn().mockResolvedValue(fetchEnvelope('succeeded')),
      capabilities: vi.fn().mockResolvedValue(CAPABILITIES),
    } satisfies NbSearchRuntime;
    createRuntimeMock.mockReturnValue(runtime);
    const service = ix.get(INbSearchService);
    const controller = new AbortController();

    await service.search('query', { requestId: 'call_search', signal: controller.signal });
    await service.fetch('https://example.com', { requestId: 'call_fetch', signal: controller.signal });

    expect(runtime.search).toHaveBeenCalledWith(
      { action: 'run', query: 'query' },
      { requestId: 'call_search', signal: controller.signal },
    );
    expect(runtime.fetch).toHaveBeenCalledWith(
      { url: 'https://example.com' },
      { requestId: 'call_fetch', signal: controller.signal },
    );
  });

  it('rebuilds the runtime when nb_search changes', async () => {
    const first = stubService() as unknown as NbSearchRuntime;
    const second = stubService() as unknown as NbSearchRuntime;
    createRuntimeMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const service = ix.get(INbSearchService);

    configChanges.fire({
      domain: NB_SEARCH_SECTION,
      source: 'set',
      previousValue: {},
      value: { defaults: { search_lane: 'tavily.search' } },
    });
    await service.search('query');

    expect(createRuntimeMock).toHaveBeenLastCalledWith({
      env: process.env,
      config: { defaults: { search_lane: 'tavily.search' } },
    });
    expect(second.search).toHaveBeenCalled();
  });

  it('reports fallback issues while the fetch chain remains available', async () => {
    createRuntimeMock.mockReturnValue({
      search: vi.fn(),
      fetch: vi.fn(),
      capabilities: vi.fn().mockResolvedValue(CAPABILITIES),
    } satisfies NbSearchRuntime);
    const status = await ix.get(INbSearchService).test();

    expect(status.search).toEqual({
      configured: true,
      available: true,
      selection: 'exa.search',
      issues: [],
    });
    expect(status.fetch).toEqual({
      configured: true,
      available: true,
      selection: 'direct.fetch -> jina.reader',
      issues: ['LANE_NOT_CONFIGURED'],
    });
  });

  it('reports a ready typed default lane as available', async () => {
    const capabilities = structuredClone(CAPABILITIES);
    capabilities.search.default_lane = 'context7.docs';
    capabilities.search.lanes = [{
      id: 'context7.docs',
      output: { channel: 'typed', schema_id: 'nb-search.docs-context@1' },
      execution_modes: ['sync'],
      availability: 'ready',
      issues: [],
      latency: 'medium',
      cost: 'cheap',
    }];
    createRuntimeMock.mockReturnValue({
      search: vi.fn(),
      fetch: vi.fn(),
      capabilities: vi.fn().mockResolvedValue(capabilities),
    } satisfies NbSearchRuntime);

    await expect(ix.get(INbSearchService).test()).resolves.toMatchObject({
      search: {
        configured: true,
        available: true,
        selection: 'context7.docs',
        issues: [],
      },
    });
  });

  it('reports the fetch chain unavailable when no pipeline can run', async () => {
    const capabilities = structuredClone(CAPABILITIES);
    for (const pipeline of capabilities.fetch.pipelines) {
      pipeline.availability = 'unavailable';
      pipeline.execution_modes = [];
    }
    createRuntimeMock.mockReturnValue({
      search: vi.fn(),
      fetch: vi.fn(),
      capabilities: vi.fn().mockResolvedValue(capabilities),
    } satisfies NbSearchRuntime);

    await expect(ix.get(INbSearchService).test()).resolves.toMatchObject({
      fetch: {
        configured: true,
        available: false,
        issues: ['LANE_NOT_CONFIGURED', 'FETCH_CHAIN_UNAVAILABLE'],
      },
    });
  });
});

describe('nb-search tool adapters', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let service: INbSearchService;

  beforeEach(() => {
    disposables = new DisposableStore();
    service = stubService();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(INbSearchService, service);
        reg.define(IWebSearchTool, WebSearchTool);
        reg.define(IFetchURLTool, FetchURLTool);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('keeps the WebSearch schema and display while forwarding cancellation', async () => {
    const controller = new AbortController();
    const tool = ix.get(IWebSearchTool);
    const execution = tool.resolveExecution({ query: 'example query' });
    const result = await execute(execution, controller.signal);

    expect(result.isError).toBe(false);
    expect(execution).toMatchObject({ display: { kind: 'search', query: 'example query' } });
    expect(service.search).toHaveBeenCalledWith('example query', {
      requestId: 'call_test',
      signal: controller.signal,
    });
    expect(result.output).toContain('Title: Example');
    expect(result.output).toContain('URL: https://example.com/result');
  });

  it.each(['failed', 'timed_out', 'cancelled'] as const)(
    'does not report %s search output as success',
    async (status) => {
      service.search = vi.fn().mockResolvedValue(searchEnvelope(status));
      const result = await execute(
        ix.get(IWebSearchTool).resolveExecution({ query: 'example query' }),
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
    },
  );

  it('reports an empty results response as a normal successful search', async () => {
    service.search = vi.fn().mockResolvedValue(searchEnvelope('empty'));
    const result = await execute(
      ix.get(IWebSearchTool).resolveExecution({ query: 'example query' }),
      new AbortController().signal,
    );

    expect(result).toMatchObject({ isError: false, output: 'No search results found.' });
  });

  it('keeps partial results and marks them incomplete', async () => {
    service.search = vi.fn().mockResolvedValue(searchEnvelope('partial'));
    const result = await execute(
      ix.get(IWebSearchTool).resolveExecution({ query: 'example query' }),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Title: Example');
    expect(result.output).toContain('Search completed partially');
  });

  it('renders a succeeded typed lane with schema, sources, content, and JSON', async () => {
    service.search = vi.fn().mockResolvedValue(typedSearchEnvelope());
    const result = await execute(
      ix.get(IWebSearchTool).resolveExecution({ query: 'example library' }),
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Schema: nb-search.docs-context@1');
    expect(result.output).toContain('Source lane: context7.docs');
    expect(result.output).toContain('Example docs: https://example.com/docs');
    expect(result.output).toContain('Typed documentation content.');
    expect(result.output).toContain('Data:');
  });

  it('bounds large typed output through the tool accumulator', async () => {
    const envelope = typedSearchEnvelope();
    if (envelope.output?.channel !== 'typed') throw new Error('expected typed output');
    envelope.output.data = {
      content: 'x'.repeat(DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS + 1),
      sources: [],
    };
    service.search = vi.fn().mockResolvedValue(envelope);
    const result = await execute(
      ix.get(IWebSearchTool).resolveExecution({ query: 'example library' }),
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    if (typeof result.output !== 'string') throw new Error('expected text output');
    expect(result.output.length).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS);
    expect(result.spill).toBeDefined();
  });

  it('keeps typed partial data and marks it incomplete', async () => {
    service.search = vi.fn().mockResolvedValue(typedSearchEnvelope('partial'));
    const result = await execute(
      ix.get(IWebSearchTool).resolveExecution({ query: 'example library' }),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Schema: nb-search.docs-context@1');
    expect(result.output).toContain('Search completed partially');
  });

  it('uses the default fetch chain and preserves extracted output wording', async () => {
    const controller = new AbortController();
    const tool = ix.get(IFetchURLTool);
    const execution = tool.resolveExecution({ url: 'https://example.com' });
    const result = await execute(execution, controller.signal);

    expect(result.isError).toBe(false);
    expect(execution).toMatchObject({ display: { kind: 'url_fetch', url: 'https://example.com' } });
    expect(service.fetch).toHaveBeenCalledWith('https://example.com', {
      requestId: 'call_test',
      signal: controller.signal,
    });
    expect(result.output).toBe(
      'The returned content is the main text extracted from the page. ' +
        'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).\n\nBODY',
    );
  });

  it.each(['partial', 'empty', 'failed', 'timed_out', 'cancelled'] as const)(
    'does not report %s fetch output as success',
    async (status) => {
      service.fetch = vi.fn().mockResolvedValue(fetchEnvelope(status, status === 'empty' ? '' : 'BODY'));
      const result = await execute(
        ix.get(IFetchURLTool).resolveExecution({ url: 'https://example.com' }),
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
    },
  );

  it('throws when the caller aborts during the runtime operation', async () => {
    const controller = new AbortController();
    service.fetch = vi.fn().mockImplementation(async () => {
      controller.abort(new Error('Aborted by the user'));
      return fetchEnvelope('cancelled', '');
    });

    await expect(
      execute(ix.get(IFetchURLTool).resolveExecution({ url: 'https://example.com' }), controller.signal),
    ).rejects.toThrow('Aborted by the user');
  });
});
