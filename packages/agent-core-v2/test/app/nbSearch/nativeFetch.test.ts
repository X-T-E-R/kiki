import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IConfigService } from '#/app/config/config';
import { INbSearchService } from '#/app/nbSearch/nbSearch';
import { NbSearchService } from '#/app/nbSearch/nbSearchService';
import { INbSearchSourceStore } from '#/app/nbSearch/sourceStore';
import { NB_SEARCH_SECTION } from '#/app/nbSearch/configSection';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IFetchURLTool, type FetchURLInput } from '#/agent/tools/fetch-url/fetch-url';
import { FetchURLTool } from '#/agent/tools/fetch-url/fetchUrlTool';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { Runtime } from '#/runtime/runtime';
import type { FetchEnvelope } from '@nb-corp/nb-search';
import { nbSearchConfigRevision, resolveNbSearchConfig } from '#/app/nbSearch/donorConfig';

let fixture: string;
let disposables: DisposableStore;
let ix: TestInstantiationService;
let runtime: Runtime;

beforeEach(async () => {
  await mkdir(path.resolve('.tmp'), { recursive: true });
  fixture = await mkdtemp(path.resolve('.tmp/native-fetch-'));
  await writeFile(path.join(fixture, 'config.json'), '{}');
  const fs = new HostFileSystem();
  runtime = {
    identity: { workspaceId: 'fixture', runtimeId: 'local', generation: 'one' },
    capabilities: new Set(['fs']), status: 'ready', onDidChangeStatus: Event.None as Runtime['onDidChangeStatus'], dispose() {},
    environment: { osKind: 'Linux', osArch: 'x64', osVersion: 'fixture', pathClass: process.platform === 'win32' ? 'win32' : 'posix', homeDir: fixture, shellName: 'bash', shellPath: '/bin/bash' },
    path: { ...path, separator: path.sep, delimiter: path.delimiter },
    workspace: { supportsExternalPaths: true, mapRoots: (roots) => roots }, fs,
  };
  disposables = new DisposableStore();
  ix = createServices(disposables, { additionalServices: (reg) => {
    const config = { home: fixture, jobs_root: path.join(fixture, 'jobs'), fetch: { file_scopes: [{ id: 'fixture', root: fixture }] } };
    reg.definePartialInstance(IConfigService, { ready: Promise.resolve(), onDidChangeConfiguration: Event.None as IConfigService['onDidChangeConfiguration'], get: ((domain: string) => domain === NB_SEARCH_SECTION ? config : undefined) as IConfigService['get'] });
    reg.defineInstance(INbSearchSourceStore, { _serviceBrand: undefined, withSource: async (_reuse, _config, use) => use({ env: { NB_SEARCH_CONFIG: path.join(fixture, 'config.json'), NB_SEARCH_HOME: fixture, NB_SEARCH_JINA_API_KEY: 'fixture-key' }, config, status: { reuse_local_config: false, layers: ['defaults', 'kiki'], local_config: 'ignored', availability: 'ready', issues: [] } }) });
    reg.define(INbSearchService, NbSearchService);
    reg.definePartialInstance(IAgentRuntimeService, { inspect: () => runtime, acquire: () => ({ runtime, track: (value) => value, dispose() {} }) });
    reg.definePartialInstance(ISessionWorkspaceContext, { workDir: fixture, additionalDirs: [] });
    reg.define(IFetchURLTool, FetchURLTool);
  } });
});

afterEach(async () => {
  disposables?.dispose();
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function execute(input: FetchURLInput) {
  const execution = await ix.get(IFetchURLTool).resolveExecution(input);
  if (execution.isError) return execution;
  return execution.execute({ turnId: 0, toolCallId: 'fixture', signal: new AbortController().signal });
}

function envelope(result: Awaited<ReturnType<typeof execute>>): FetchEnvelope {
  expect(typeof result.output).toBe('string');
  return JSON.parse(result.output as string) as FetchEnvelope;
}

describe('native FetchURL donor boundaries', () => {
  it('does not recapture the approved file identity after an atomic replacement', async () => {
    const target = path.join(fixture, 'document.txt');
    await writeFile(target, 'APPROVED');
    const capture = vi.spyOn(ix.get(INbSearchService), 'captureFetchFileIdentity');
    const execution = await ix.get(IFetchURLTool).resolveExecution({ action: 'run', source: { kind: 'file', scope: 'fixture', path: 'document.txt' }, pipeline: 'direct.local' });
    if (execution.isError) throw new Error(String(execution.output));
    const { rename } = await import('node:fs/promises');
    await writeFile(`${target}.replacement`, 'PRIVATE REPLACEMENT');
    await rename(`${target}.replacement`, target);
    const result = await execution.execute({ turnId: 0, toolCallId: 'fixture', signal: new AbortController().signal });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('FETCH_FILE_BLOCKED');
    expect(result.output).not.toContain('PRIVATE REPLACEMENT');
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it('validates the source revision before deriving the per-file admission revision', async () => {
    await writeFile(path.join(fixture, 'document.txt'), 'Revision-bound content.');
    const store = ix.get(INbSearchSourceStore);
    const withSource = store.withSource.bind(store);
    vi.spyOn(store, 'withSource').mockImplementation((reuse, config, use) => withSource(reuse, config, (source) => use({ ...source, expectedRevision: nbSearchConfigRevision(resolveNbSearchConfig(source.env, source.config, config)) })));
    const result = await execute({ action: 'run', source: { kind: 'file', scope: 'fixture', path: 'document.txt' }, pipeline: 'direct.local' });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Revision-bound content.');
  });
  it('admits a scoped local file as a Kiki read and retains donor local extraction', async () => {
    await writeFile(path.join(fixture, 'document.txt'), 'Local fixture content.');
    const execution = await ix.get(IFetchURLTool).resolveExecution({ action: 'run', source: { kind: 'file', scope: 'fixture', path: 'document.txt' }, pipeline: 'direct.local', representation: 'text' });
    expect(execution).toMatchObject({ accesses: [{ kind: 'file', operation: 'read', path: path.join(fixture, 'document.txt') }] });
    if (execution.isError) throw new Error(JSON.stringify(execution.output));
    const result = await execution.execute({ turnId: 0, toolCallId: 'fixture', signal: new AbortController().signal });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Local fixture content.');
  });

  it('rejects sensitive paths, scope escapes and isolated runtimes before donor execution', async () => {
    const fetch = vi.spyOn(ix.get(INbSearchService), 'fetch');
    for (const candidate of ['.env', '../outside.txt', path.resolve(fixture, 'absolute.txt')]) {
      const result = await execute({ action: 'run', source: { kind: 'file', scope: 'fixture', path: candidate } });
      expect(result.isError).toBe(true);
    }
    runtime = { ...runtime, workspace: { supportsExternalPaths: false, mapRoots: (roots) => roots } };
    expect((await execute({ action: 'run', source: { kind: 'file', scope: 'fixture', path: 'document.txt' } })).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not let a configured donor scope grant access outside the Kiki workspace', async () => {
    const fetch = vi.spyOn(ix.get(INbSearchService), 'fetch');
    runtime = { ...runtime, workspace: { supportsExternalPaths: true, mapRoots: () => ({ workDir: path.join(fixture, 'confined-workspace'), additionalDirs: [] }) } };
    const result = await execute({ action: 'run', source: { kind: 'file', scope: 'fixture', path: 'document.txt' } });
    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a sensitive canonical target and binds the admitted file to the runtime configuration', async () => {
    const realpath = vi.spyOn(runtime.fs!, 'realpath').mockResolvedValue(path.join(fixture, '.env'));
    const fetch = vi.spyOn(ix.get(INbSearchService), 'fetch');
    expect((await execute({ action: 'run', source: { kind: 'file', scope: 'fixture', path: 'document.txt' } })).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    realpath.mockRestore();
    await expect(ix.get(INbSearchService).fetch({ action: 'run', source: { kind: 'file', scope: 'fixture', path: 'document.txt' } }, undefined, path.join(fixture, 'another.txt'))).rejects.toThrow('configured scope changed after file admission');
  });

  it('rejects scope changes after admission without reading the replacement target', async () => {
    await writeFile(path.join(fixture, 'document.txt'), 'Authorized content.');
    const execution = await ix.get(IFetchURLTool).resolveExecution({ action: 'run', source: { kind: 'file', scope: 'fixture', path: 'document.txt' } });
    expect(execution.isError).not.toBe(true);
    if (execution.isError) throw new Error(JSON.stringify(execution.output));
    vi.spyOn(ix.get(INbSearchService), 'resolveFetchFile').mockResolvedValue(path.join(fixture, 'other.txt'));
    const fetch = vi.spyOn(ix.get(INbSearchService), 'fetch');
    const result = await execution.execute({ turnId: 0, toolCallId: 'fixture', signal: new AbortController().signal });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('changed after admission');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps donor egress rejection for inline content and respects representation and content budget', async () => {
    const rejected = await execute({ action: 'run', source: { kind: 'inline_text', media_type: 'text/plain', content: 'Private inline fixture.' }, pipeline: 'jina.reader' });
    expect(rejected.isError).toBe(true);
    expect(rejected.output).toContain('FETCH_EGRESS_DENIED');
    const result = await execute({ action: 'run', source: { kind: 'inline_text', media_type: 'text/html', content: '<h1>Title</h1><p>Local text.</p>' }, pipeline: 'direct.local', representation: 'text', max_content_chars: 100 });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Local text.');
    expect(result.output).not.toContain('<h1>');
  });

  it('runs a real donor local async job and uses native get/read/cancel across runtime reconstruction', async () => {
    const queued = envelope(await execute({ action: 'run', source: { kind: 'inline_text', content: 'Async local fixture.', media_type: 'text/plain' }, pipeline: 'direct.local', execution: 'async', idempotency_key: 'fixture-local-job' }));
    expect(queued).toMatchObject({ action: 'run', execution: 'async', status: 'queued' });
    if (queued.action !== 'run' || queued.execution !== 'async' || queued.job === undefined) throw new Error(JSON.stringify(queued));
    const job_id = queued.job.job_id;
    let status = envelope(await execute({ action: 'get', job_id }));
    for (let attempt = 0; attempt < 15 && status.action === 'get' && ['queued', 'running'].includes(status.state); attempt++) {
      const delay = status.action === 'get' ? status.poll_after_ms ?? 1000 : 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      status = envelope(await execute({ action: 'get', job_id }));
    }
    expect(status).toMatchObject({ action: 'get', state: 'succeeded' });
    const read = envelope(await execute({ action: 'read', job_id, page_size: 1 }));
    expect(read).toMatchObject({ action: 'read', job_id });
    if (read.action !== 'read') throw new Error(JSON.stringify(read));
    expect(Buffer.concat(read.chunks.map((chunk) => Buffer.from(chunk.data_base64, 'base64'))).toString('utf8')).toContain('Async local fixture.');
    expect(envelope(await execute({ action: 'cancel', job_id }))).toMatchObject({ action: 'cancel', job_id, state: 'succeeded', cancel_requested: false });
  }, 30_000);
});
