import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { SyncDescriptor } from '#/_base/di/descriptors';

import {
  fetchInputSchema,
  searchInputSchema,
  type CapabilityEnvelope,
  type FetchCancelEnvelope,
  type FetchEnvelope,
  type FetchGetEnvelope,
  type FetchReadEnvelope,
  type FetchRunAsyncEnvelope,
  type FetchRunSyncEnvelope,
  type HttpRequest,
  type NbSearchRuntime,
  type SearchCancelEnvelope,
  type SearchEnvelope,
  type SearchGetEnvelope,
  type SearchInput,
  type SearchReadEnvelope,
  type SearchRunAsyncEnvelope,
  type SearchRunSyncEnvelope,
} from '@nb-corp/nb-search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { FetchURLTool } from '#/agent/tools/fetch-url/fetchUrlTool';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IFetchURLTool } from '#/agent/tools/fetch-url/fetch-url';
import { IWebSearchTool } from '#/agent/tools/web-search/web-search';
import { WebSearchTool } from '#/agent/tools/web-search/webSearchTool';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IConfigService, type ConfigChangedEvent } from '#/app/config/config';
import { NB_SEARCH_SECTION } from '#/app/nbSearch/configSection';
import { INbSearchService, type NbSearchTestStatus } from '#/app/nbSearch/nbSearch';
import { parseNativeFetchInput, parseNativeSearchInput, type NativeFetchInput, type NativeSearchInput } from '#/app/nbSearch/nativeInput';
import { NbSearchService } from '#/app/nbSearch/nbSearchService';
import { INbSearchSourceStore, NbSearchSourceStore } from '#/app/nbSearch/sourceStore';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { applyLocalCredentials } from '#/app/nbSearch/localCredentials';
import { NbSearchCredentialFileStore } from '#/app/nbSearch/credentialFileStore';
import { resolveNbSearchConfig, nbSearchConfigRevision } from '#/app/nbSearch/donorConfig';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
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
    prepareToolDescriptions: vi.fn().mockResolvedValue(undefined),
    resolveFetchFile: vi.fn().mockResolvedValue(undefined),
    captureFetchFileIdentity: vi.fn().mockResolvedValue({ dev: '1', ino: '1' }),
    toolDescription: () => 'Fixture capability snapshot',
    test: vi.fn().mockResolvedValue(testStatus()),
    validateConfiguration: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function execute(execution: ToolExecution | Promise<ToolExecution>, signal: AbortSignal): Promise<ExecutableToolResult> {
  const resolved = await execution;
  if (resolved.isError === true) return resolved;
  const context: ExecutableToolContext = { turnId: 0, toolCallId: 'call_test', signal };
  return resolved.execute(context);
}

const toolSchemaAjv = new Ajv({ strict: false, allErrors: true });
addFormats(toolSchemaAjv);

function expectToolParametersToAccept(parameters: Record<string, unknown>, input: unknown): void {
  const validate = toolSchemaAjv.compile(parameters);
  expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
}

const SEARCH_JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const FETCH_JOB_ID = '223e4567-e89b-42d3-a456-426614174000';
const JOB_CREATED_AT = '2026-09-04T00:00:00.000Z';
const JOB_UPDATED_AT = '2026-09-04T00:00:01.000Z';

const SEARCH_INPUT_CASES = [
  { name: 'minimal run', input: { query: 'example query' } },
  {
    name: 'array query with lanes and limits',
    input: {
      action: 'run',
      query: ['first query', 'second query'],
      lanes: ['exa.search', 'context7.docs'],
      freshness: 'pd',
      timeout_ms: 1_000,
      max_results: 25,
    },
  },
  { name: 'preset run', input: { action: 'run', query: 'preset query', preset: 'research' } },
  {
    name: 'async run with idempotency',
    input: { action: 'run', query: 'async query', execution: 'async', idempotency_key: 'search-async-1' },
  },
  { name: 'get job', input: { action: 'get', job_id: SEARCH_JOB_ID } },
  { name: 'read job', input: { action: 'read', job_id: SEARCH_JOB_ID, cursor: 'cursor-1', page_size: 20 } },
  { name: 'cancel job', input: { action: 'cancel', job_id: SEARCH_JOB_ID } },
] as const satisfies readonly { name: string; input: NativeSearchInput }[];

const FETCH_INPUT_CASES = [
  { name: 'minimal url shorthand', input: { url: 'https://example.com' } },
  {
    name: 'url shorthand with execution controls',
    input: {
      url: 'https://example.com/article',
      pipeline: 'direct.fetch',
      representation: 'text',
      execution: 'async',
      idempotency_key: 'fetch-url-1',
      timeout_ms: 1_000,
      max_content_chars: 5_000,
    },
  },
  {
    name: 'inline text source',
    input: {
      action: 'run',
      source: {
        kind: 'inline_text',
        content: '<p>Inline body</p>',
        media_type: 'text/html',
        base_url: 'https://example.com/base',
      },
      pipeline: 'direct.fetch',
      representation: 'markdown',
      execution: 'sync',
      timeout_ms: 1_000,
      max_content_chars: 5_000,
    },
  },
  {
    name: 'inline bytes source',
    input: {
      action: 'run',
      source: {
        kind: 'inline_bytes',
        content_base64: 'SGVsbG8=',
        media_type: 'text/plain',
        filename: 'example.txt',
      },
      pipeline: 'direct.fetch',
      representation: 'text',
      execution: 'async',
      idempotency_key: 'fetch-bytes-1',
      timeout_ms: 1_000,
      max_content_chars: 5_000,
    },
  },
  { name: 'get job', input: { action: 'get', job_id: FETCH_JOB_ID } },
  { name: 'read job', input: { action: 'read', job_id: FETCH_JOB_ID, cursor: 'cursor-1', page_size: 20 } },
  { name: 'cancel job', input: { action: 'cancel', job_id: FETCH_JOB_ID } },
] as const satisfies readonly { name: string; input: NativeFetchInput }[];

function searchEnvelopeForInput(input: SearchInput): SearchEnvelope {
  if (input.action === 'run' && input.execution === 'async') {
    const envelope: SearchRunAsyncEnvelope = {
      schema_version: '3.0',
      action: 'run',
      execution: 'async',
      status: 'queued',
      job: { job_id: SEARCH_JOB_ID, state: 'queued', created_at: JOB_CREATED_AT },
      poll_after_ms: 250,
      hints: [],
    };
    return envelope;
  }
  if (input.action === 'run') return searchEnvelope('succeeded');
  if (input.action === 'get') {
    const envelope: SearchGetEnvelope = {
      schema_version: '3.0',
      action: 'get',
      job_id: SEARCH_JOB_ID,
      state: 'running',
      cancel_requested: false,
      created_at: JOB_CREATED_AT,
      updated_at: JOB_UPDATED_AT,
      poll_after_ms: 250,
    };
    return envelope;
  }
  if (input.action === 'read') {
    const envelope: SearchReadEnvelope = {
      schema_version: '3.0',
      action: 'read',
      job_id: SEARCH_JOB_ID,
      state: 'succeeded',
      chunks: [{ index: 0, offset: 0, byte_length: 3, data_base64: 'YWJj' }],
      next_cursor: 'cursor-next',
    };
    return envelope;
  }
  const envelope: SearchCancelEnvelope = {
    schema_version: '3.0',
    action: 'cancel',
    job_id: SEARCH_JOB_ID,
    state: 'cancelled',
    cancel_requested: true,
  };
  return envelope;
}

function fetchEnvelopeForInput(input: { action: 'run' | 'get' | 'read' | 'cancel'; execution?: 'sync' | 'async' }): FetchEnvelope {
  if (input.action === 'run' && input.execution === 'async') {
    const envelope: FetchRunAsyncEnvelope = {
      schema_version: '3.0',
      mode: 'fetch',
      action: 'run',
      execution: 'async',
      status: 'queued',
      schema_id: 'nb-search.fetch@1',
      job: { job_id: FETCH_JOB_ID, state: 'queued', created_at: JOB_CREATED_AT },
      poll_after_ms: 250,
      hints: [],
    };
    return envelope;
  }
  if (input.action === 'run') return fetchEnvelope('succeeded', 'INLINE BODY');
  if (input.action === 'get') {
    const envelope: FetchGetEnvelope = {
      schema_version: '3.0',
      mode: 'fetch',
      action: 'get',
      job_id: FETCH_JOB_ID,
      state: 'running',
      cancel_requested: false,
      created_at: JOB_CREATED_AT,
      updated_at: JOB_UPDATED_AT,
      poll_after_ms: 250,
    };
    return envelope;
  }
  if (input.action === 'read') {
    const envelope: FetchReadEnvelope = {
      schema_version: '3.0',
      mode: 'fetch',
      action: 'read',
      job_id: FETCH_JOB_ID,
      state: 'succeeded',
      chunks: [{ index: 0, offset: 0, byte_length: 3, data_base64: 'YWJj' }],
      next_cursor: 'cursor-next',
    };
    return envelope;
  }
  const envelope: FetchCancelEnvelope = {
    schema_version: '3.0',
    mode: 'fetch',
    action: 'cancel',
    job_id: FETCH_JOB_ID,
    state: 'cancelled',
    cancel_requested: true,
  };
  return envelope;
}

describe('local CLI credential bindings', () => {
  const env = { NB_SEARCH_HOME: '/fixture/nb-search' };
  const binding = { instance: 'exa.default', provider: 'exa', slot: 'exa.default', env: 'NB_SEARCH_EXA_API_KEY', base_url: null };
  const secrets = { schema_version: '1' as const, values: { NB_SEARCH_EXA_API_KEY: 'fixture-cli-key' }, bindings: { NB_SEARCH_EXA_API_KEY: [binding] } };

  it('imports only canonical credential names and leaves the source env untouched', () => {
    const result = applyLocalCredentials(env, { ...secrets, values: { ...secrets.values, NB_SEARCH_CONFIG: '/fixture/injected.json', UNRELATED: 'fixture-extra' } }, {}, { execution: { max_concurrency: 3 } });
    expect(result.env['NB_SEARCH_EXA_API_KEY']).toBe('fixture-cli-key');
    expect(result.env['NB_SEARCH_CONFIG']).toBeUndefined();
    expect(result.env['UNRELATED']).toBeUndefined();
    expect(Object.hasOwn(env, 'NB_SEARCH_EXA_API_KEY')).toBe(false);
    expect(result.usedLocalCredentials).toBe(true);
  });

  it.each(['fixture-daemon-key', ''])('keeps explicit daemon env precedence including an empty value (%s)', (value) => {
    const result = applyLocalCredentials({ ...env, NB_SEARCH_EXA_API_KEY: value }, secrets, {}, {});
    expect(result.env['NB_SEARCH_EXA_API_KEY']).toBe(value);
    expect(result.usedLocalCredentials).toBe(false);
  });

  it.each([true, false])('rejects Kiki endpoint changes with binding metadata=%s', (withBindings) => {
    expect(() => applyLocalCredentials(env, withBindings ? secrets : { schema_version: '1', values: secrets.values }, {}, {
      provider_instances: { 'exa.default': { base_url: 'https://example.test/redirect' } },
    })).toThrow('LOCAL_CREDENTIAL_BINDING_MISMATCH');
  });

  it('rejects moving a credential to a different slot or adding a consuming instance', () => {
    expect(() => applyLocalCredentials(env, secrets, {}, {
      credential_slots: { team: { provider_id: 'exa', env: 'NB_SEARCH_EXA_API_KEY' } },
      provider_instances: { 'exa.default': { credential_slot_id: 'team' } },
    })).toThrow('LOCAL_CREDENTIAL_BINDING_MISMATCH');
    expect(() => applyLocalCredentials(env, secrets, {}, {
      provider_instances: { team: { provider_id: 'exa', credential_slot_id: 'exa.default', enabled: true, options: {} } },
    })).toThrow('LOCAL_CREDENTIAL_BINDING_MISMATCH');
  });

  it('rejects mismatched imported metadata and non-home canonical paths', () => {
    expect(() => applyLocalCredentials(env, { ...secrets, bindings: { NB_SEARCH_EXA_API_KEY: [{ ...binding, provider: 'tavily' }] } }, {}, {})).toThrow('LOCAL_CREDENTIAL_BINDING_MISMATCH');
    expect(() => applyLocalCredentials({ ...env, NB_SEARCH_CONFIG: '/fixture/custom.json' }, secrets, {}, {})).toThrow('LOCAL_CREDENTIAL_BINDING_MISMATCH');
  });

  it('rejects secret values that alter canonical options or routing paths', () => {
    expect(() => applyLocalCredentials(env, { schema_version: '1', values: { NB_SEARCH_LOG_LEVEL: 'debug' } }, {
      credential_slots: { 'exa.default': { provider_id: 'exa', env: 'NB_SEARCH_LOG_LEVEL' } },
    }, {})).toThrow('LOCAL_CREDENTIAL_CONFIG_OVERRIDE');
    expect(() => applyLocalCredentials(env, { schema_version: '1', values: { NB_SEARCH_CONFIG: '/fixture/other.json' } }, {
      credential_slots: { 'exa.default': { provider_id: 'exa', env: 'NB_SEARCH_CONFIG' } },
    }, {})).toThrow('LOCAL_CREDENTIAL_CONFIG_OVERRIDE');
  });

  it('does not change the configuration revision when importing credential-only values', () => {
    const initial = resolveNbSearchConfig(env, {}, { defaults: { search_lane: 'exa.search' } });
    const result = applyLocalCredentials(env, secrets, {}, { defaults: { search_lane: 'exa.search' } });
    expect(nbSearchConfigRevision(result.config)).toBe(nbSearchConfigRevision(initial));
  });
});

describe('NbSearchSourceStore', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  const stat = vi.fn();
  const write = vi.fn();

  beforeEach(() => {
    disposables = new DisposableStore();
    stat.mockReset();
    write.mockReset();
    for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('NB_SEARCH_')) vi.stubEnv(key, undefined);
    vi.stubEnv('NB_SEARCH_HOME', '/fixture/nb-search');
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IHostFileSystem, { stat });
        reg.definePartialInstance(IFileSystemStorageService, { pathFor: () => undefined, write });
        reg.define(INbSearchSourceStore, NbSearchSourceStore);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
    vi.unstubAllEnvs();
  });

  it('fails closed when storage cannot provide a real isolated configuration path', async () => {
    const source = await ix.get(INbSearchSourceStore).withSource(false, undefined, (value) => value);
    expect(source.status).toMatchObject({ reuse_local_config: false, local_config: 'ignored', availability: 'unavailable', issues: ['ISOLATED_STORAGE_UNAVAILABLE'] });
    expect(write).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it('never reads local config or credentials when reuse is disabled', async () => {
    ix.get(IFileSystemStorageService).pathFor = (_scope, key) => `/fixture/cache/nb-search/${key}`;
    write.mockResolvedValue(undefined);
    const fs = ix.get(IHostFileSystem);
    fs.lstat = vi.fn();
    fs.readBytes = vi.fn();
    const source = await ix.get(INbSearchSourceStore).withSource(false, undefined, (value) => value);
    expect(source.status).toMatchObject({ availability: 'ready', local_config: 'ignored', local_credentials: 'ignored', credential_source: 'environment' });
    expect(stat).not.toHaveBeenCalled();
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(fs.readBytes).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe('cache/nb-search');
    expect(write.mock.calls[0]?.[1]).toMatch(/^isolated-config\.\d+\.\d+\.json$/);
    expect(write.mock.calls[0]?.[2]).toEqual(new TextEncoder().encode('{}'));
    expect(write.mock.calls[0]?.[3]).toEqual({ atomic: true });
    expect(source.env['NB_SEARCH_CONFIG']).toBe(`/fixture/cache/nb-search/${String(write.mock.calls[0]?.[1])}`);
  });

  it('keeps concurrent source stores on the same filesystem isolated', async () => {
    const root = resolve('.tmp');
    await mkdir(root, { recursive: true });
    const fixture = await mkdtemp(join(root, 'nb-search-source-concurrency-'));
    const firstStorage = new FileStorageService(fixture);
    const secondStorage = new FileStorageService(fixture);
    const first = new NbSearchSourceStore(firstStorage, {} as IHostFileSystem);
    const second = new NbSearchSourceStore(secondStorage, {} as IHostFileSystem);
    try {
      const sources = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? first : second)
        .withSource(false, undefined, (value) => value)));
      expect(sources.every((source) => source.status.availability === 'ready')).toBe(true);
      expect(new Set(sources.map((source) => source.env['NB_SEARCH_CONFIG'])).size).toBe(2);
      expect(new Set(sources.map((source) => source.env['NB_SEARCH_HOME'])).size).toBe(1);
      expect(new Set(sources.map((source) => source.env['NB_SEARCH_JOBS_ROOT'])).size).toBe(1);
    } finally {
      await Promise.all([firstStorage.close(), secondStorage.close()]);
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('does not expose credential-bearing readers to JSON reflection calls', async () => {
    const service = ix.get(INbSearchSourceStore);
    expect(Reflect.get(service, 'resolve')).toBeUndefined();
    expect(Reflect.get(service, 'withLocalCredentials')).toBeUndefined();
    await expect(Reflect.apply(service.withSource, service, [true, undefined, null])).rejects.toMatchObject({ code: 'request.invalid' });
    expect(stat).not.toHaveBeenCalled();
  });

  it('ignores an incompatible local configuration without retaining values', async () => {
    stat.mockResolvedValue({ isFile: true, isDirectory: false, size: 2 });
    ix.get(IFileSystemStorageService).pathFor = (_scope, key) => `/fixture/cache/nb-search/${key}`;
    write.mockResolvedValue(undefined);
    const lock = vi.spyOn(NbSearchCredentialFileStore.prototype, 'assertUnlocked').mockResolvedValue();
    const read = vi.spyOn(NbSearchCredentialFileStore.prototype, 'read').mockImplementation(async (path) => path.endsWith('secrets.json')
      ? JSON.stringify({ schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'fixture-local-key' } })
      : JSON.stringify({ defaults: { search_lane: 42 } }));
    try {
      const source = await ix.get(INbSearchSourceStore).withSource(true, undefined, (value) => value);
      expect(source.status).toMatchObject({
        local_config: 'invalid',
        local_credentials: 'ignored',
        credential_source: 'environment',
        availability: 'ready',
        issues: ['LOCAL_CONFIG_INVALID_IGNORED', 'CONFIGURATION_ERROR:defaults.search_lane'],
      });
      expect(source.env['NB_SEARCH_EXA_API_KEY']).toBeUndefined();
      expect(source.env['NB_SEARCH_CONFIG']).toMatch(/isolated-config\.\d+\.\d+\.json$/);
      expect(JSON.stringify(source)).not.toContain('42');
      expect(JSON.stringify(source)).not.toContain('fixture-local-key');
    } finally {
      read.mockRestore();
      lock.mockRestore();
    }
  });

  it('uses the captured local configuration instead of letting the donor reread it', async () => {
    stat.mockResolvedValue({ isFile: true, isDirectory: false, size: 2 });
    ix.get(IFileSystemStorageService).pathFor = (_scope, key) => `/fixture/cache/nb-search/${key}`;
    write.mockResolvedValue(undefined);
    const lock = vi.spyOn(NbSearchCredentialFileStore.prototype, 'assertUnlocked').mockResolvedValue();
    const read = vi.spyOn(NbSearchCredentialFileStore.prototype, 'read').mockImplementation(async (path) => path.endsWith('secrets.json')
      ? undefined
      : JSON.stringify({ defaults: { search_lane: 'exa.search' } }));
    try {
      const source = await ix.get(INbSearchSourceStore).withSource(true, undefined, (value) => value);
      expect(source.status).toMatchObject({ availability: 'ready', local_config: 'present', local_credentials: 'missing', issues: [] });
      expect(source.config?.defaults?.search_lane).toBe('exa.search');
      expect(source.env['NB_SEARCH_CONFIG']).toMatch(/isolated-config\.\d+\.\d+\.json$/);
      expect(source.env['NB_SEARCH_CONFIG']).not.toBe('/fixture/nb-search/config.json');
    } finally {
      read.mockRestore();
      lock.mockRestore();
    }
  });

  it('rejects configuration-pair changes during credential resolution', async () => {
    stat.mockResolvedValue({ isFile: true, isDirectory: false, size: 2 });
    let reads = 0;
    const lock = vi.spyOn(NbSearchCredentialFileStore.prototype, 'assertUnlocked').mockResolvedValue();
    const read = vi.spyOn(NbSearchCredentialFileStore.prototype, 'read').mockImplementation(async (path) => {
      if (!path.endsWith('secrets.json')) return '{}';
      reads += 1;
      return JSON.stringify({ schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: reads === 1 ? 'fixture-first-key' : 'fixture-changed-key' } });
    });
    try {
      const status = await ix.get(INbSearchSourceStore).withSource(true, undefined, (value) => value.status);
      expect(status).toMatchObject({ availability: 'unavailable', issues: ['LOCAL_CONFIG_CHANGED'] });
      expect(write).not.toHaveBeenCalled();
      expect(JSON.stringify(status)).not.toContain('fixture-first-key');
      expect(JSON.stringify(status)).not.toContain('fixture-changed-key');
    } finally {
      read.mockRestore();
      lock.mockRestore();
    }
  });

  it('reads symlinked credential files without ACL or link inspection', async () => {
    stat.mockResolvedValue({ isFile: true, isDirectory: false, size: 2 });
    const fs = ix.get(IHostFileSystem);
    fs.lstat = vi.fn(async (path) => {
      if (path.endsWith('.config-access.lock')) throw Object.assign(new Error('Fixture path missing.'), { code: 'os.fs.not_found' });
      return { isFile: true, isDirectory: false, isSymbolicLink: true, size: 2 };
    });
    fs.readBytes = vi.fn();
    const status = await ix.get(INbSearchSourceStore).withSource(true, undefined, (value) => value.status);
    expect(status.issues ?? []).not.toContain('LOCAL_CREDENTIALS_UNSAFE');
    expect(fs.readBytes).toHaveBeenCalled();
  });

  it('does not treat a permission-denied local base as a missing optional file', async () => {
    stat.mockRejectedValue({ code: 'os.fs.permission_denied' });
    const source = await ix.get(INbSearchSourceStore).withSource(true, undefined, (value) => value);
    expect(source.status).toMatchObject({ local_config: 'unreadable', availability: 'unavailable', issues: ['LOCAL_CONFIG_UNREADABLE'] });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('NbSearchCredentialFileStore', () => {
  it('reads files without ACL or symlink inspection', async () => {
    const entry = { isFile: true, isDirectory: false, isSymbolicLink: true, size: 2, ino: 1, mtimeMs: 1 };
    const fs = {
      lstat: vi.fn(async () => entry),
      readBytes: vi.fn(async () => new TextEncoder().encode('{}')),
    } as unknown as IHostFileSystem;
    const store = new NbSearchCredentialFileStore(fs);
    await expect(store.read('C:\\fixture\\secrets.json')).resolves.toBe('{}');
    expect(fs.readBytes).toHaveBeenCalled();
  });
});

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
        reg.defineInstance(INbSearchSourceStore, {
          _serviceBrand: undefined,
          withSource: async (reuse, _config, use) => use({
            env: {},
            status: { reuse_local_config: reuse, layers: ['defaults', 'local', 'environment', 'kiki'], local_config: 'missing', availability: 'ready', issues: [] },
          }),
        });
        reg.define(INbSearchService, NbSearchService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it.each(['exa.search', null])('executes the native GMA lane through the real donor SSE transport with default=%s', async (defaultLane) => {
    const donor = await vi.importActual<typeof import('@nb-corp/nb-search')>('@nb-corp/nb-search');
    const root = resolve('.tmp');
    await mkdir(root, { recursive: true });
    const fixture = await mkdtemp(join(root, 'nb-search-sse-'));
    const path = join(fixture, 'config.json');
    await writeFile(path, '{}');
    const requests: HttpRequest[] = [];
    const answer = { answer: 'Synthetic grounded answer.', results: [{ title: 'Primary source', url: 'https://example.com/evidence' }], claims: [{ text: 'Synthetic fact.', confidence: 'high', evidence_strength: 'direct', evidence_urls: ['https://example.com/evidence'] }] };
    createRuntimeMock.mockImplementation((options) => donor.createNbSearchRuntime({
      ...options,
      env: { NB_SEARCH_CONFIG: path, NB_SEARCH_HOME: fixture, NB_SEARCH_GROK_API_KEY: 'fixture-search-key', NB_SEARCH_GROK_MULTI_AGENT_BASE_URL: 'https://relay.example.test/v1' },
      http_transport: { send: async (request) => {
        requests.push(request);
        return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` };
      } },
    }));
    ix.get(IConfigService).get = ((domain: string) => domain === NB_SEARCH_SECTION ? { defaults: { search_lane: defaultLane }, execution: { retry_count: 0 } } : undefined) as IConfigService['get'];
    ix.set(IWebSearchTool, new SyncDescriptor(WebSearchTool));
    try {
      const service = ix.get(INbSearchService);
      await service.prepareToolDescriptions();
      expect(service.toolDescription('WebSearch')).toContain('gma.research');
      const result = await execute(ix.get(IWebSearchTool).resolveExecution({ query: 'Synthetic research', lane: 'gma.research' }), new AbortController().signal);
      expect(result.isError, JSON.stringify(result.output)).toBe(false);
      expect(result.output).toContain('Content:\nSynthetic grounded answer.');
      expect(result.output).toContain('Primary source: https://example.com/evidence');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ headers: { Accept: 'text/event-stream' }, body: { stream: true } });
      expect(requests[0]?.url).toBe('https://relay.example.test/v1/chat/completions');
      const invalid = await execute(ix.get(IWebSearchTool).resolveExecution({ query: 'Synthetic research', lane: 'not.registered' }), new AbortController().signal);
      expect(invalid.isError).toBe(true);
      expect(requests).toHaveLength(1);
      const asyncUnsupported = await execute(ix.get(IWebSearchTool).resolveExecution({ query: 'Synthetic research', lane: 'gma.research', execution: 'async', idempotency_key: 'fixture-sse-async' }), new AbortController().signal);
      expect(asyncUnsupported.isError).toBe(true);
      expect(asyncUnsupported.output).toContain('LANE_EXECUTION_UNSUPPORTED');
      expect(requests).toHaveLength(1);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
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

  it('shares a bounded description snapshot and invalidates it on configuration changes', async () => {
    const capabilities = structuredClone(CAPABILITIES);
    capabilities.search.default_lane = undefined;
    capabilities.search.lanes.push({ id: 'gma.research', output: { channel: 'typed', schema_id: 'nb-search.multi-agent-research@1' }, execution_modes: ['sync'], availability: 'ready', issues: [], latency: 'slow', cost: 'expensive' });
    const runtime = { search: vi.fn().mockResolvedValue(searchEnvelope('succeeded')), fetch: vi.fn(), capabilities: vi.fn().mockResolvedValue(capabilities) };
    createRuntimeMock.mockReturnValue(runtime);
    const service = ix.get(INbSearchService);
    expect(service.toolDescription('WebSearch')).toContain('not prepared');
    await Promise.all([service.prepareToolDescriptions(), service.prepareToolDescriptions()]);
    await service.prepareToolDescriptions();
    expect(runtime.capabilities).toHaveBeenCalledTimes(1);
    expect(service.toolDescription('WebSearch')).toContain('Default search lane: not configured');
    expect(service.toolDescription('WebSearch')).toContain('gma.research');
    expect(service.toolDescription('WebSearch')).toContain('typed');
    expect(service.toolDescription('FetchURL')).toContain('direct.fetch -> jina.reader');
    await service.search('explicit without default', undefined, 'gma.research');
    expect(runtime.search).toHaveBeenCalledWith({ action: 'run', query: 'explicit without default', lane: 'gma.research' }, undefined);
    capabilities.search.default_lane = 'gma.research';
    configChanges.fire({ domain: NB_SEARCH_SECTION, source: 'set', previousValue: {}, value: {} });
    expect(service.toolDescription('WebSearch')).toContain('not prepared');
    await service.prepareToolDescriptions();
    expect(service.toolDescription('WebSearch')).toContain('Configured default search lane: gma.research');
    expect(runtime.capabilities).toHaveBeenCalledTimes(2);
    const stableSearch = service.toolDescription('WebSearch');
    const stableFetch = service.toolDescription('FetchURL');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try {
      expect(service.toolDescription('WebSearch')).toBe(stableSearch);
      expect(service.toolDescription('FetchURL')).toBe(stableFetch);
      await service.prepareToolDescriptions();
      expect(runtime.capabilities).toHaveBeenCalledTimes(3);
      expect(service.toolDescription('WebSearch')).toBe(stableSearch);
      expect(service.toolDescription('FetchURL')).toBe(stableFetch);
    } finally {
      clock.mockRestore();
    }
  });

  it('forwards explicit lane failures without retrying another provider', async () => {
    const runtime = { search: vi.fn().mockRejectedValue(new Error('LANE_UNAVAILABLE')), fetch: vi.fn(), capabilities: vi.fn() };
    createRuntimeMock.mockReturnValue(runtime);
    await expect(ix.get(INbSearchService).search('example', undefined, 'gma.research')).rejects.toThrow('LANE_UNAVAILABLE');
    expect(runtime.search).toHaveBeenCalledTimes(1);
    expect(runtime.search).toHaveBeenCalledWith({ action: 'run', query: 'example', lane: 'gma.research' }, undefined);
  });

  it('rebuilds the runtime when nb_search changes', async () => {
    const first = stubService() as unknown as NbSearchRuntime;
    const second = stubService() as unknown as NbSearchRuntime;
    createRuntimeMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const service = ix.get(INbSearchService);

    await service.search('first');
    ix.get(IConfigService).get = (() => ({ defaults: { search_lane: 'tavily.search' } })) as IConfigService['get'];
    configChanges.fire({
      domain: NB_SEARCH_SECTION,
      source: 'set',
      previousValue: {},
      value: { defaults: { search_lane: 'tavily.search' } },
    });
    await service.search('query');

    expect(createRuntimeMock).toHaveBeenLastCalledWith({
      env: {},
      config: { defaults: { search_lane: 'tavily.search' } },
    });
    expect(second.search).toHaveBeenCalled();
  });

  it('fails closed on invalid configuration without leaking donor errors or using a stale runtime', async () => {
    const previous = stubService() as unknown as NbSearchRuntime;
    createRuntimeMock.mockReturnValueOnce(previous);
    const service = ix.get(INbSearchService);
    await service.capabilities();
    createRuntimeMock.mockImplementation(() => {
      throw Object.assign(new Error('resolved configuration is invalid: defaults.search_lane: Invalid input'), {
        code: 'CONFIGURATION_ERROR',
      });
    });
    const capabilities = await service.capabilities();
    expect(capabilities.config_source).toMatchObject({
      availability: 'unavailable',
      issues: ['EFFECTIVE_CONFIG_INVALID', 'CONFIGURATION_ERROR:defaults.search_lane'],
    });
    expect(capabilities.search.lanes).toEqual([]);
    expect(JSON.stringify(capabilities)).not.toContain('fixture-private-key');
    await expect(service.search('query')).rejects.toMatchObject({ code: 'config.invalid' });
    await expect(service.fetch('https://example.test')).rejects.not.toThrow('fixture-private-key');
    expect(previous.search).not.toHaveBeenCalled();
    expect(previous.fetch).not.toHaveBeenCalled();
    createRuntimeMock.mockReturnValue(previous);
    expect((await service.capabilities()).config_source?.availability).toBe('ready');
  });

  it('rejects a donor revision mismatch before any credential-bearing operation', async () => {
    const runtime = stubService() as unknown as NbSearchRuntime;
    createRuntimeMock.mockReturnValue(runtime);
    ix.get(INbSearchSourceStore).withSource = async (reuse, _config, use) => use({
      env: {}, expectedRevision: 'different-resolver-revision',
      status: { reuse_local_config: reuse, layers: ['defaults', 'local', 'environment', 'kiki'], local_config: 'present', availability: 'ready', issues: [] },
    });
    const service = ix.get(INbSearchService);
    expect(Reflect.get(service, 'createRuntime')).toBeUndefined();
    expect(Reflect.get(service, 'currentRuntime')).toBeUndefined();
    expect(Reflect.get(service, 'requireRuntime')).toBeUndefined();
    expect((await service.capabilities()).config_source?.issues).toEqual(['LOCAL_CONFIG_RESOLVER_MISMATCH']);
    await expect(service.search('query')).rejects.toMatchObject({ code: 'config.invalid' });
    expect(runtime.search).not.toHaveBeenCalled();
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
        reg.definePartialInstance(IAgentRuntimeService, {});
        reg.definePartialInstance(ISessionWorkspaceContext, { workDir: '/workspace', additionalDirs: [] });
        reg.define(IWebSearchTool, WebSearchTool);
        reg.define(IFetchURLTool, FetchURLTool);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('exposes an optional lane and forwards an explicit GMA selection', async () => {
    const tool = ix.get(IWebSearchTool);
    expect(tool.parameters).toMatchObject({ type: 'object', properties: { lane: { type: 'string' }, action: { enum: ['run', 'get', 'read', 'cancel'] } } });
    expect(tool.parameters).not.toHaveProperty('anyOf');
    expect(tool.parameters).not.toHaveProperty('oneOf');
    const controller = new AbortController();
    const input = { query: 'example', lane: 'gma.research' } satisfies NativeSearchInput;
    await execute(tool.resolveExecution(input), controller.signal);
    expect(service.search).toHaveBeenCalledWith(
      { action: 'run', query: 'example', lane: 'gma.research' },
      { requestId: 'call_test', signal: controller.signal },
    );
  });

  it('renders GMA answer and results without duplicating its full JSON', async () => {
    const envelope = typedSearchEnvelope();
    if (envelope.output?.channel !== 'typed') throw new Error('expected typed output');
    envelope.output.data = { answer: 'Grounded answer.', results: [{ title: 'Evidence', url: 'https://example.com/evidence' }] };
    service.search = vi.fn().mockResolvedValue(envelope);
    const result = await execute(ix.get(IWebSearchTool).resolveExecution({ query: 'example' }), new AbortController().signal);
    expect(result.output).toContain('Content:\nGrounded answer.');
    expect(result.output).toContain('Evidence: https://example.com/evidence');
    expect(result.output).not.toContain('Data:');
    expect(result.output).toContain('not independently verified');
  });

  it.each(SEARCH_INPUT_CASES)('validates and forwards the complete search contract: $name', async ({ input }) => {
    const tool = ix.get(IWebSearchTool);
    expectToolParametersToAccept(tool.parameters, input);
    const expected = searchInputSchema.parse({ ...input, action: 'action' in input ? input.action : 'run' });
    expect(parseNativeSearchInput(input)).toStrictEqual(expected);
    const signal = new AbortController().signal;
    service.search = vi.fn().mockImplementation(async (received: unknown) => searchEnvelopeForInput(received as SearchInput));

    const execution = await tool.resolveExecution(input);
    const result = await execute(execution, signal);
    expect(result.isError).toBe(expected.action === 'cancel');
    expect(service.search).toHaveBeenCalledTimes(1);
    expect(service.search).toHaveBeenCalledWith(expected, { requestId: 'call_test', signal });
    if (typeof result.output !== 'string') throw new Error('expected text output');
    const output = result.output;
    if ((expected.action === 'run' && expected.execution === 'async') || expected.action === 'get') {
      expect(output).toContain(`"job_id": "${SEARCH_JOB_ID}"`);
      expect(output).toContain('"poll_after_ms": 250');
    }
    if (expected.action === 'read') {
      expect(output).toContain('"data_base64": "YWJj"');
      expect(output).toContain('"next_cursor": "cursor-next"');
    }
    if (expected.action === 'cancel') {
      expect(output).toContain(`"job_id": "${SEARCH_JOB_ID}"`);
      expect(output).toContain('"state": "cancelled"');
    }
  });

  it.each(FETCH_INPUT_CASES)('validates and forwards the complete fetch contract: $name', async ({ input }) => {
    const tool = ix.get(IFetchURLTool);
    expectToolParametersToAccept(tool.parameters, input);
    const expected = fetchInputSchema.parse(input);
    expect(parseNativeFetchInput(input)).toStrictEqual(expected);
    const signal = new AbortController().signal;
    service.fetch = vi.fn().mockImplementation(async (received: unknown) => fetchEnvelopeForInput(received as {
      action: 'run' | 'get' | 'read' | 'cancel';
      execution?: 'sync' | 'async';
    }));

    const execution = await tool.resolveExecution(input);
    const result = await execute(execution, signal);
    expect(result.isError).toBe(expected.action === 'cancel');
    expect(service.fetch).toHaveBeenCalledTimes(1);
    expect(service.fetch).toHaveBeenCalledWith(expected, { requestId: 'call_test', signal });
    if (typeof result.output !== 'string') throw new Error('expected text output');
    const output = result.output;
    if ((expected.action === 'run' && expected.execution === 'async') || expected.action === 'get') {
      expect(output).toContain(`"job_id": "${FETCH_JOB_ID}"`);
      expect(output).toContain('"poll_after_ms": 250');
    }
    if (expected.action === 'read') {
      expect(output).toContain('"data_base64": "YWJj"');
      expect(output).toContain('"next_cursor": "cursor-next"');
    }
    if (expected.action === 'cancel') {
      expect(output).toContain(`"job_id": "${FETCH_JOB_ID}"`);
      expect(output).toContain('"state": "cancelled"');
    }
  });

  it.each([
    ['mixed lane and lanes', { action: 'run', query: 'example', lane: 'exa.search', lanes: ['context7.docs'] }],
    ['async without idempotency', { action: 'run', query: 'example', execution: 'async' }],
    ['unknown field', { action: 'run', query: 'example', unexpected: true }],
  ])('rejects donor-invalid search input %s before calling the service', async (_name, input) => {
    const tool = ix.get(IWebSearchTool);
    const candidate = input as NativeSearchInput;
    expect(() => parseNativeSearchInput(candidate)).toThrow();
    const execution = await tool.resolveExecution(candidate);
    expect(execution).toMatchObject({ isError: true });
    expect(service.search).not.toHaveBeenCalled();
  });

  it('leaves an unregistered lane rejection to the runtime', async () => {
    const tool = ix.get(IWebSearchTool);
    const input = { action: 'run', query: 'example', lane: 'not.registered' } satisfies NativeSearchInput;
    expectToolParametersToAccept(tool.parameters, input);
    const expected = parseNativeSearchInput(input);
    const signal = new AbortController().signal;
    service.search = vi.fn().mockRejectedValue(new Error('LANE_NOT_REGISTERED'));

    const result = await execute(tool.resolveExecution(input), signal);
    expect(result.isError).toBe(true);
    expect(service.search).toHaveBeenCalledWith(expected, { requestId: 'call_test', signal });
  });

  it.each([
    ['sync idempotency key', { url: 'https://example.com', execution: 'sync', idempotency_key: 'sync-key' }],
    ['unknown field', { url: 'https://example.com', unexpected: true }],
  ])('rejects donor-invalid fetch input %s before calling the service', async (_name, input) => {
    const tool = ix.get(IFetchURLTool);
    const candidate = input as NativeFetchInput;
    expect(() => parseNativeFetchInput(candidate)).toThrow();
    const execution = await tool.resolveExecution(candidate);
    expect(execution).toMatchObject({ isError: true });
    expect(service.fetch).not.toHaveBeenCalled();
  });

  it('keeps the WebSearch schema and display while forwarding cancellation', async () => {
    const controller = new AbortController();
    const tool = ix.get(IWebSearchTool);
    const execution = tool.resolveExecution({ query: 'example query' });
    const result = await execute(execution, controller.signal);

    expect(result.isError).toBe(false);
    expect(execution).toMatchObject({ display: { kind: 'search', query: 'example query' } });
    expect(service.search).toHaveBeenCalledWith({ action: 'run', query: 'example query' }, {
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
    expect(result.output).toContain('Metadata:');
    expect(result.output).toContain('Example Library');
    expect(result.output).not.toContain('Data:');
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
    const execution = await tool.resolveExecution({ url: 'https://example.com' });
    const result = await execute(execution, controller.signal);

    expect(result.isError).toBe(false);
    expect(execution).toMatchObject({ display: { kind: 'url_fetch', url: 'https://example.com' } });
    expect(service.fetch).toHaveBeenCalledWith({ action: 'run', source: { kind: 'url', url: 'https://example.com' } }, {
      requestId: 'call_test',
      signal: controller.signal,
    });
    expect(result.output).toBe(
      'The returned content is the main text extracted from the page. ' +
        'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).\n\nBODY',
    );
  });

  it('reports successful truncation and deduplicates donor warnings without claiming a full body', async () => {
    const response = fetchEnvelope('succeeded', 'TRUNCATED BODY');
    const warning = { code: 'FETCH_CONTENT_CHARS_LIMIT', message: 'Content limit reached.', data: { max_content_chars: 14 } };
    response.documents[0] = { ...response.documents[0]!, content_type: 'text/plain', truncated: true, warnings: [warning] };
    response.hints = [warning, { code: 'FETCH_BYTES_LIMIT', message: 'Byte limit reached.', data: { max_bytes: 20 } }];
    service.fetch = vi.fn().mockResolvedValue(response);
    const result = await execute(ix.get(IFetchURLTool).resolveExecution({ url: 'https://example.com' }), new AbortController().signal);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('truncated');
    expect(result.output).toContain('incomplete');
    expect(result.output).not.toContain('full response body');
    expect(String(result.output).split('FETCH_CONTENT_CHARS_LIMIT')).toHaveLength(2);
    expect(result.output).toContain('FETCH_BYTES_LIMIT');
    expect(result.output).toContain('max_content_chars');
    expect(String(result.output).split('TRUNCATED BODY')).toHaveLength(2);
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
