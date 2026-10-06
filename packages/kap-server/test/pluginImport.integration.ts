import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createKlient, createConnectionKlient } from '@kiki/klient/http';
import { IAtomicDocumentStore, IPluginHostService, ISessionManager, IAppendLogStore, IFileSystemStorageService, IConfigService } from '@kiki/agent-core-v2';
import type { ImportJob, ImportPreviewInput } from '@kiki/protocol';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { isPeerProcedureAllowed, isPeerFrameAllowed } from '../src/services/connections/audience';

const servers: RunningServer[] = [];
const directories: string[] = [];
const clients: ReturnType<typeof createKlient>[] = [];
const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, '../../../.tmp');
async function boot(existingHome?: string) {
  await mkdir(scratch, { recursive: true });
  const home = existingHome ?? await mkdtemp(path.join(scratch, 'native-import-'));
  if (!directories.includes(home)) directories.push(home);
  const server = await startServer({ homeDir: home, modelAccountHomeDir: home, userAgentProfileHomeDir: home, userSkillDir: path.join(home, 'skills'), port: 0, hostIdentity: TEST_HOST_IDENTITY, logLevel: 'silent' });
  servers.push(server);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const client = createKlient({ endpoint, token: server.localOwnerToken }); clients.push(client);
  return { server, home, endpoint, client };
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0).toReversed()) await server.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});
it('imports through the actual no-model HTTP facade and exposes bounded peer reads but not remote execution', async () => {
  vi.stubEnv('KIKI_EXPERIMENTAL_PLUGIN_IMPORT', 'true');
  vi.stubEnv('KIKI_SEARCH_BACKEND', 'minidb');
  const target = await boot(); const source = await boot();
  expect(await target.client.global.plugins.list()).toEqual([]);
  expect((await target.client.global.imports.sources())[0]?.id).toBe('claude-code');
  const input = path.join(target.home, 'chosen-export'); await mkdir(input);
  const text = 'Native archive Unicode 文🦊'.repeat(10_000);
  const history = JSON.stringify({ type: 'user', message: { content: text } });
  await writeFile(path.join(input, 'history.jsonl'), history);
  const preview = await target.client.global.imports.preview({ pluginId: 'kiki-history', sourceId: 'claude-code', home: input, externalId: 'history.jsonl' });
  const job = await target.client.global.imports.start({ previewId: preview.id, acknowledge: true });
  await vi.waitFor(async () => expect((await target.client.global.imports.job(job.id)).status).toBe('completed'), { timeout: 15_000 });
  const completed = await target.client.global.imports.job(job.id);
  const docs = target.server.core.accessor.get(IAtomicDocumentStore);
  expect(await docs.list('sessions')).toEqual([]);
  expect(await readFile(path.join(input, 'history.jsonl'), 'utf8')).toBe(history);
  await target.client.rest!.connections.setInbound(true);
  const invitation = await target.client.rest!.connections.invite({ source: source.server.admission.identity, label: 'Fixture source' });
  const record = await source.client.rest!.connections.add({ label: 'Fixture target', endpoint: target.endpoint, target: target.server.admission.identity,
    ownerToken: target.server.authTokenService.getToken(), invitation: invitation.invitation, backgroundSummary: false });
  const peer = createConnectionKlient({ endpoint: source.endpoint, token: source.server.localOwnerToken, connectionId: record.id }); clients.push(peer);
  const execution = vi.spyOn(target.server.core.accessor.get(IPluginHostService), 'requestSource');
  execution.mockClear();
  expect((await peer.global.imports.sources())[0]?.id).toBe('claude-code');
  expect((await peer.global.imports.jobs()).items[0]?.id).toBe(job.id);
  expect((await peer.global.imports.job(job.id)).targetHome).toBe(target.home);
  expect((await peer.global.imports.archives({ query: 'history' })).items[0]?.id).toBe(completed.archiveId);
  const pieces: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await peer.global.imports.read({ archiveId: completed.archiveId!, cursor });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
    pieces.push(...page.records.map((item) => item.text)); cursor = page.cursor ?? undefined;
  } while (cursor);
  expect(pieces.join('')).toBe(text);
  expect(execution).not.toHaveBeenCalled();
  await expect(peer.global.imports.preview(preview.selection)).rejects.toThrow('local_owner_required');
  await expect(peer.global.imports.discover({ pluginId: 'kiki-history', sourceId: 'claude-code', home: input })).rejects.toThrow('local_owner_required');
  await expect(peer.global.imports.start({ previewId: preview.id, acknowledge: true })).rejects.toThrow('local_owner_required');
  await expect(peer.global.imports.cancel(job.id)).rejects.toThrow('local_owner_required');
  await expect(peer.global.imports.resume(job.id)).rejects.toThrow('local_owner_required');
  expect(execution).not.toHaveBeenCalled();
}, 30_000);
it('accepts read limit 100 while preserving the 64-record output contract and complete continuation', async () => {
  vi.stubEnv('KIKI_EXPERIMENTAL_PLUGIN_IMPORT', 'true');
  vi.stubEnv('KIKI_SEARCH_BACKEND', 'minidb');
  const target = await boot();

  const input = path.join(target.home, 'short-export'); await mkdir(input);
  const expected = Array.from({ length: 130 }, (_, index) => `record-${index}`);
  await writeFile(path.join(input, 'history.jsonl'), expected.map((text) => JSON.stringify({ type: 'user', message: { content: text } })).join('\n'));
  const preview = await target.client.global.imports.preview({ pluginId: 'kiki-history', sourceId: 'claude-code', home: input, externalId: 'history.jsonl' });
  const job = await target.client.global.imports.start({ previewId: preview.id, acknowledge: true });
  await vi.waitFor(async () => { expect((await target.client.global.imports.job(job.id)).status).toBe('completed'); }, { timeout: 15_000 });
  const completed = await target.client.global.imports.job(job.id);
  const found: string[] = [];
  const sizes: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await target.client.global.imports.read({ archiveId: completed.archiveId!, cursor, limit: 100 });
    expect(page.records.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
    found.push(...page.records.map((item) => item.text)); sizes.push(page.records.length);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  expect(sizes).toEqual([64, 64, 2]);
  expect(found).toEqual(expected);
}, 30_000);
it('keeps media management peer reads bounded and exposes only owner-scoped agent cancel/resume', () => {
  for (const method of ['sources', 'catalog', 'providers', 'capabilities', 'voices', 'jobs', 'job']) expect(isPeerProcedureAllowed({ service: 'pluginMediaService', method })).toBe(true);
  for (const method of ['setSources', 'start', 'run', 'cancel', 'resume', 'stored', 'stageInput', 'dispose', 'anythingElse']) expect(isPeerProcedureAllowed({ service: 'pluginMediaService', method })).toBe(false);
  for (const method of ['cancel', 'resume']) expect(isPeerProcedureAllowed({ service: 'agentPluginMediaService', method })).toBe(true);
  for (const method of ['generate', 'api', 'resolveInput', 'snapshotInput', 'dispose', 'anythingElse']) expect(isPeerProcedureAllowed({ service: 'agentPluginMediaService', method })).toBe(false);
  expect(isPeerFrameAllowed({ type: 'subscribe', id: 'fixture', service: 'pluginMediaService', event: 'changed', scope: 'app' })).toBe(false);
});
it('keeps the peer import allowlist read-only and does not admit a service-wide subscription', () => {
  for (const method of ['sources', 'jobs', 'job', 'archives', 'read']) expect(isPeerProcedureAllowed({ service: 'pluginImportService', method })).toBe(true);
  for (const method of ['discover', 'preview', 'start', 'cancel', 'resume', 'dispose', 'anythingElse']) expect(isPeerProcedureAllowed({ service: 'pluginImportService', method })).toBe(false);
  expect(isPeerFrameAllowed({ type: 'subscribe', id: 'fixture', service: 'pluginImportService', event: 'changed', scope: 'app' })).toBe(false);
});

async function importNative(target: Awaited<ReturnType<typeof boot>>, input: ImportPreviewInput) {
  const preview = await target.client.global.imports.preview(input);
  expect(preview.destination?.kind).toBe('native-session');
  expect(preview.losses.map((item) => item.code)).toContain('native_internal_state_not_imported');
  const start = await target.client.global.imports.start({ previewId: preview.id, acknowledge: true });
  expect((await target.client.global.imports.start({ previewId: preview.id, acknowledge: true })).id).toBe(start.id);
  let result: ImportJob = start;
  await vi.waitFor(async () => {
    result = await target.client.global.imports.job(start.id);
    expect(['completed', 'failed', 'interrupted']).toContain(result.status);
  }, { timeout: 20_000, interval: 25 });
  expect(result.status, result.error ?? '').toBe('completed');
  expect(result.archiveId).toBeNull();
  expect(result.sessionId).toBeTruthy();
  expect(result.sessionPath).toContain('sessions');
  expect(JSON.parse(await readFile(path.join(result.sessionPath!, 'state.json'), 'utf8'))).toMatchObject({ id: result.sessionId });
  return result;
}
async function nativeTranscript(target: Awaited<ReturnType<typeof boot>>, id: string) {
  const response = await fetch(`${target.endpoint}/api/sessions/${id}/transcript?agent_id=main&transcript_coverage_version=2`, { headers: { authorization: `Bearer ${target.server.localOwnerToken}` } });
  const payload = await response.json() as { code: number; data: unknown };
  expect(payload.code).toBe(0);
  return JSON.stringify(payload.data);
}
it('migrates both sources to canonical sessions, preserves context and continues through the engine after a full reopen', async () => {
  vi.stubEnv('KIKI_EXPERIMENTAL_PLUGIN_IMPORT', 'true');
  vi.stubEnv('KIKI_SEARCH_BACKEND', 'minidb');
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const provider = createHttpServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: 'fixture-continuation', choices: [{ index: 0, delta: { content: 'native continuation reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Fake provider did not bind');
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(path.join(scratch, 'native-continuation-')); directories.push(home);
  await writeFile(path.join(home, 'config.toml'), `default_model = "fixture"\n[providers.fixture]\ntype = "openai"\nbase_url = "http://127.0.0.1:${address.port}/v1"\napi_key = "fixture-not-a-secret"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture"\nmax_context_size = 100000\n`);
  let target = await boot(home);
  try {
    const source = path.join(home, 'chosen-export'); const workDir = path.join(home, 'local-workspace');
    await mkdir(source); await mkdir(workDir);
    const longBody = 'migrated user Unicode 文🦊 ' + 'x'.repeat(55_000);
    const claude = [
      { type: 'user', uuid: 'u', parentUuid: null, message: { role: 'user', content: longBody } },
      { type: 'assistant', uuid: 'inactive', parentUuid: 'u', message: { content: 'inactive branch excluded' } },
      { type: 'assistant', uuid: 'child', parentUuid: 'tool', message: { content: 'migrated assistant body', usage: { input_tokens: 500, output_tokens: 300 } } },
      { type: 'assistant', uuid: 'tool', parentUuid: 'u', message: { content: [{ type: 'tool_use', id: 'historical-call', name: 'never_execute', input: { command: 'never run history' } }] } },
      { type: 'assistant', uuid: 'side', isSidechain: true, message: { content: 'sidechain excluded' } },
      { type: 'last-prompt', leafUuid: 'child' },
      { type: 'system', content: 'external system permission excluded' },
    ];
    const codex = [
      { type: 'session_meta', payload: { id: 'fixture', cwd: '/foreign/ignored' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'migrated user body' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'migrated user body' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'never_execute', call_id: 'historical-call', arguments: '{"command":"never run history"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'historical-call', output: 'historical result' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'migrated assistant body' }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'migrated assistant body' } },
      { type: 'response_item', payload: { type: 'message', role: 'system', content: 'external system permission excluded' } },
    ];
    const jobs: ImportJob[] = [];
    for (const [pluginId, sourceId, data] of [['kiki-history', 'claude-code', claude], ['kiki-history', 'codex', codex]] as const) {
      await writeFile(path.join(source, `${sourceId}.jsonl`), data.map((row) => JSON.stringify(row)).join('\n'));
      const input: ImportPreviewInput = { pluginId, sourceId, home: source, externalId: `${sourceId}.jsonl`, destination: { kind: 'native-session', workDir } };
      const job = await importNative(target, input); jobs.push(job);
      const id = job.sessionId!;
      expect((await target.client.global.sessions.list({})).items.map((item) => item.id)).toContain(id);
      expect((await target.client.global.sessions.get(id))?.cwd?.toLowerCase()).toBe(workDir.toLowerCase());
      const transcript = await nativeTranscript(target, id);
      expect(transcript).toContain('migrated assistant body');
      expect(transcript).toContain('never_execute');
      expect(transcript).not.toContain('inactive branch excluded');
      expect(transcript).not.toContain('sidechain excluded');
      expect(transcript).not.toContain('external system permission excluded');
      expect(await target.client.session(id).resume()).toBe(true);
      const agent = target.client.session(id).agent('main');
      const context = await agent.getContext();
      const conversation = context.history.filter((message) => message.origin?.kind !== 'injection');
      expect(conversation.every((message) => message.toolCalls.length === 0)).toBe(true);
      expect(conversation.filter((message) => message.role === 'user')).toHaveLength(1);
      if (sourceId === 'claude-code') expect(conversation[0]?.content).toEqual([{ type: 'text', text: longBody }]);
      expect((await agent.getUsage()).total).toBeUndefined();
      expect(await agent.getTasks()).toEqual([]);
      expect(await target.client.session(id).approvals.list()).toEqual([]);
      expect(requests).toHaveLength(jobs.length - 1);
      const result = await agent.prompt({ input: [{ type: 'text', text: 'continue imported conversation' }], execution: { model: 'fixture' } }, { waitFor: 'terminal' });
      expect(result.state).toBe('completed');
      const sent = requests.at(-1)!;
      expect(JSON.stringify(sent.messages)).toContain('migrated assistant body');
      expect(JSON.stringify(sent.messages)).toContain(sourceId === 'claude-code' ? longBody : 'migrated user body');
      expect(JSON.stringify(sent.messages)).not.toContain('external system permission excluded');
      expect(sent.messages.some((message) => message.role === 'tool')).toBe(false);
      const duplicate = await importNative(target, input);
      expect(duplicate.sessionId).toBe(id);
      expect((await agent.getContext()).history.some((message) => JSON.stringify(message.content).includes('native continuation reply'))).toBe(true);
    }
    expect((await target.client.global.imports.archives()).items).toHaveLength(0);
    await target.client.close(); clients.splice(clients.indexOf(target.client), 1);
    await target.server.close(); servers.splice(servers.indexOf(target.server), 1);
    target = await boot(home);
    for (const job of jobs) {
      const id = job.sessionId!;
      expect(await nativeTranscript(target, id)).toContain('migrated assistant body');
      expect(await target.client.session(id).resume()).toBe(true);
      const agent = target.client.session(id).agent('main');
      expect((await agent.getContext()).history.some((message) => JSON.stringify(message.content).includes('native continuation reply'))).toBe(true);
      expect((await agent.prompt({ input: [{ type: 'text', text: 'continue after reopen' }], execution: { model: 'fixture' } }, { waitFor: 'terminal' })).state).toBe('completed');
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('migrated assistant body');
    }
  } finally {
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
}, 60_000);

async function prepareNativeFixture() {
  vi.stubEnv('KIKI_EXPERIMENTAL_PLUGIN_IMPORT', 'true');
  vi.stubEnv('KIKI_SEARCH_BACKEND', 'minidb');
  const target = await boot();

  const source = path.join(target.home, 'export'); const workDir = path.join(target.home, 'workspace');
  await mkdir(source); await mkdir(workDir);
  await writeFile(path.join(source, 'history.jsonl'), JSON.stringify({ type: 'user', message: { content: 'original portable body' } }));
  const input: ImportPreviewInput = { pluginId: 'kiki-history', sourceId: 'claude-code', home: source, externalId: 'history.jsonl', destination: { kind: 'native-session', workDir } };
  return { target, input, source, workDir };
}
it('rolls back pre-publication failures, preserves old archives, isolates changed revisions/workspaces, and recovers a lost completion ACK', async () => {
  const fixture = await prepareNativeFixture(); let target = fixture.target;
  const { destination: _destination, ...selection } = fixture.input;
  const archivePreview = await target.client.global.imports.preview(selection);
  const archiveJob = await target.client.global.imports.start({ previewId: archivePreview.id, acknowledge: true });
  await vi.waitFor(async () => expect((await target.client.global.imports.job(archiveJob.id)).status).toBe('completed'));
  const archiveId = (await target.client.global.imports.job(archiveJob.id)).archiveId!;
  const beforeArchive = await target.client.global.imports.read({ archiveId });
  const manager = target.server.core.accessor.get(ISessionManager);
  const publish = vi.spyOn(target.server.core.accessor.get(IFileSystemStorageService), 'moveDirectory').mockRejectedValueOnce(new Error('fixture before publication'));
  const preview = await target.client.global.imports.preview(fixture.input);
  const started = await target.client.global.imports.start({ previewId: preview.id, acknowledge: true });
  await vi.waitFor(async () => expect((await target.client.global.imports.job(started.id)).status).toBe('failed'));
  expect((await target.client.global.sessions.list({})).items).toHaveLength(0);
  expect(manager.listEphemeral()).toHaveLength(0);
  publish.mockRestore();
  await target.client.global.imports.resume(started.id);
  await vi.waitFor(async () => expect((await target.client.global.imports.job(started.id)).status).toBe('completed'));
  const original = await target.client.global.imports.job(started.id);
  expect(await nativeTranscript(target, original.sessionId!)).toContain('original portable body');
  expect(await target.client.global.imports.read({ archiveId })).toEqual(beforeArchive);
  const secondWorkDir = path.join(target.home, 'other-workspace'); await mkdir(secondWorkDir);
  const anotherWorkspace = await importNative(target, { ...fixture.input, destination: { kind: 'native-session', workDir: secondWorkDir } });
  expect(anotherWorkspace.sessionId).not.toBe(original.sessionId);
  const stale = await target.client.global.imports.preview(fixture.input);
  await writeFile(path.join(fixture.source, 'history.jsonl'), JSON.stringify({ type: 'user', message: { content: 'updated portable body' } }));
  const staleJob = await target.client.global.imports.start({ previewId: stale.id, acknowledge: true });
  await vi.waitFor(async () => expect((await target.client.global.imports.job(staleJob.id)).status).toBe('failed'));
  expect((await target.client.global.sessions.list({})).items).toHaveLength(2);
  const updated = await importNative(target, fixture.input);
  expect(updated.sessionId).not.toBe(original.sessionId);
  expect(await nativeTranscript(target, original.sessionId!)).toContain('original portable body');
  expect(await nativeTranscript(target, updated.sessionId!)).toContain('updated portable body');
  expect(await target.client.global.imports.read({ archiveId })).toEqual(beforeArchive);
  const docs = target.server.core.accessor.get(IAtomicDocumentStore);
  await docs.set('plugin-import-v1', `jobs.${updated.id}`, { ...updated, status: 'running', error: 'fixture lost ACK' });
  await target.client.close(); clients.splice(clients.indexOf(target.client), 1);
  await target.server.close(); servers.splice(servers.indexOf(target.server), 1);
  target = await boot(target.home);
  expect(await target.client.global.imports.job(updated.id)).toMatchObject({ status: 'completed', sessionId: updated.sessionId });
  expect((await target.client.global.sessions.list({})).items).toHaveLength(3);
  expect(await nativeTranscript(target, updated.sessionId!)).toContain('updated portable body');
}, 45_000);
it('keeps a published native session non-ephemeral when the ancillary session index append fails after the move', async () => {
  const { target, input } = await prepareNativeFixture();
  const storage = target.server.core.accessor.get(IFileSystemStorageService);
  const logs = target.server.core.accessor.get(IAppendLogStore);
  const move = storage.moveDirectory.bind(storage); const flush = logs.flush.bind(logs);
  let moved = false;
  const manager = target.server.core.accessor.get(ISessionManager);
  const save = manager.saveEphemeral.bind(manager);
  const failure = new Error('fixture index append failure after publication');
  let observed: unknown;
  vi.spyOn(manager, 'saveEphemeral').mockImplementation(async (id) => {
    try { await save(id); } catch (error) { observed = error; throw error; }
  });
  vi.spyOn(storage, 'moveDirectory').mockImplementation(async (...args) => { await move(...args); moved = true; });
  vi.spyOn(logs, 'flush').mockImplementation(async () => {
    if (moved) { moved = false; throw failure; }
    await flush();
  });
  const job = await importNative(target, input);
  expect(observed).toBe(failure);
  expect(manager.isEphemeral(job.sessionId!)).toBe(false);
  expect(await target.client.session(job.sessionId!).resume()).toBe(true);
  await target.client.session(job.sessionId!).close();
  expect(await nativeTranscript(target, job.sessionId!)).toContain('original portable body');
}, 30_000);

it('retains temporary ownership and the original error when native publication never moved', async () => {
  const { target, workDir } = await prepareNativeFixture();
  const created = await target.client.global.sessions.create({ workDir, ephemeral: true });
  const storage = target.server.core.accessor.get(IFileSystemStorageService);
  const manager = target.server.core.accessor.get(ISessionManager);
  const failure = new Error('fixture move never happened');
  const injection = vi.spyOn(storage, 'moveDirectory').mockRejectedValueOnce(failure);
  await expect(manager.saveEphemeral(created.id)).rejects.toBe(failure);
  expect(manager.isEphemeral(created.id)).toBe(true);
  expect(await target.client.global.sessions.get(created.id)).toBeUndefined();
  injection.mockRestore();
  await manager.delete(created.id);
  expect(manager.isEphemeral(created.id)).toBe(false);
}, 30_000);


it('offers native rules in a clean home, runs a selected custom script and continues the imported conversation without plugin installation', async () => {
  vi.stubEnv('KIKI_SEARCH_BACKEND', 'minidb');
  const requests: { messages: unknown[] }[] = [];
  const provider = createHttpServer((request, response) => {
    let body = ''; request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: 'native rule continuation' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Fixture provider did not bind');
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(path.join(scratch, 'native-rules-')); directories.push(home);
  await writeFile(path.join(home, 'config.toml'), `default_model = "fixture"\n[providers.fixture]\ntype = "openai"\nbase_url = "http://127.0.0.1:${address.port}/v1"\napi_key = "fixture-not-a-secret"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture"\nmax_context_size = 100000\n`);
  const target = await boot(home);
  try {
    expect((await target.client.global.imports.sources()).map((item) => item.id)).toEqual(['claude-code', 'codex', 'pi', 'grok', 'opencode', 'custom']);
    expect(await target.client.global.plugins.list()).toEqual([]);
    const source = path.join(home, 'export'); const workDir = path.join(home, 'workspace'); await mkdir(source); await mkdir(workDir);
    const input = { pluginId: 'kiki-history', sourceId: 'custom', home: source, externalId: 'history.json' };
    await writeFile(path.join(source, 'history.json'), JSON.stringify({ title: 'Custom history', messages: [
      { role: 'user', text: 'imported custom question' }, { role: 'assistant', text: 'imported custom answer' },
      { role: 'tool_call', text: '{"command":"never run history"}' }, { role: 'system', text: 'foreign permission' },
      { role: 'future', text: 'unknown role' },
    ] }));
    const script = path.join(home, 'my-format.mjs');
    const example = await readFile(path.resolve(here, '../../agent-core-v2/src/app/pluginImport/builtin/examples/custom-json.mjs'), 'utf8');
    await writeFile(script, example);
    expect((await target.client.rest!.plugins.settings('kiki-history')).schema).toMatchObject({ schema: { properties: { customScript: { type: 'string' } } } });
    await target.client.rest!.plugins.setSettings('kiki-history', { values: { customScript: script } });
    expect((await target.client.rest!.plugins.settings('kiki-history')).values['customScript']).toBe(script);
    expect((await target.client.global.imports.discover({ pluginId: input.pluginId, sourceId: input.sourceId, home: source })).entries).toEqual([{ externalId: 'history.json', title: 'history.json' }]);
    const preview = await target.client.global.imports.preview({ ...input, destination: { kind: 'native-session', workDir } });
    expect(preview.losses).toContainEqual(expect.objectContaining({ code: 'custom_message_not_imported', count: 1 }));
    await writeFile(script, example + '\nexport const customRuleRevision = 2;\n');
    const stale = await target.client.global.imports.start({ previewId: preview.id, acknowledge: true });
    await vi.waitFor(async () => expect((await target.client.global.imports.job(stale.id)).status).toBe('failed'));
    const job = await importNative(target, { ...input, destination: { kind: 'native-session', workDir } });
    expect(await nativeTranscript(target, job.sessionId!)).toContain('imported custom answer');
    expect(requests).toHaveLength(0);
    expect(await target.client.session(job.sessionId!).resume()).toBe(true);
    const agent = target.client.session(job.sessionId!).agent('main');
    const context = await agent.getContext();
    expect(context.history.every((message) => message.toolCalls.length === 0)).toBe(true);
    expect(JSON.stringify(context.history)).not.toContain('foreign permission');
    expect((await agent.prompt({ input: [{ type: 'text', text: 'continue' }], execution: { model: 'fixture' } }, { waitFor: 'terminal' })).state).toBe('completed');
    expect(JSON.stringify(requests[0]?.messages)).toContain('imported custom question');
    expect(JSON.stringify(requests[0]?.messages)).toContain('imported custom answer');
    const archivePreview = await target.client.global.imports.preview(input);
    const archiveStart = await target.client.global.imports.start({ previewId: archivePreview.id, acknowledge: true });
    await vi.waitFor(async () => expect((await target.client.global.imports.job(archiveStart.id)).status).toBe('completed'));
    expect((await target.client.global.imports.job(archiveStart.id)).archiveId).toBeTruthy();
    expect(await target.client.global.plugins.list()).toEqual([]);
    const settingsHome = await mkdtemp(path.join(scratch, 'native-rule-settings-'));
    const fixtureSettings = { 'kiki-history': { customScript: script }, example_plugin: { some_key: 'kept', plugin_token_secret: 'fixture-not-a-secret' } };
    await writeFile(path.join(settingsHome, 'config.toml'), `[plugin_settings.kiki-history]\ncustomScript = ${JSON.stringify(script)}\n[plugin_settings.example_plugin]\nsome_key = "kept"\nplugin_token_secret = "fixture-not-a-secret"\n`);
    const disabled = await boot(settingsHome);
    expect((await disabled.client.rest!.plugins.settings('kiki-history')).values['customScript']).toBe(script);
    expect(disabled.server.core.accessor.get(IConfigService).get('pluginSettings')).toEqual(fixtureSettings);
    await disabled.client.rest!.plugins.setSettings('kiki-history', { values: { customScript: script } });
    const savedSettings = await readFile(path.join(settingsHome, 'config.toml'), 'utf8');
    expect(savedSettings).toContain('[plugin_settings.example_plugin]');
    expect(savedSettings).not.toContain('fixture-not-a-secret');
    expect(savedSettings).toContain('some_key = "kept"');
    const savedFixtureCredentials = await readFile(path.join(settingsHome, 'credentials/credentials.toml'), 'utf8');
    expect(savedFixtureCredentials).toContain('[plugin_settings.example_plugin]');
    expect(savedFixtureCredentials).toContain('plugin_token_secret = "fixture-not-a-secret"');
    expect((await disabled.client.global.imports.sources()).map((item) => item.id)).toEqual(['claude-code', 'codex', 'pi', 'grok', 'opencode', 'custom']);
  } finally {
    await new Promise<void>((resolve, reject) => provider.close((error) => { if (error) reject(error); else resolve(); }));
  }
}, 45_000);
