import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importProbeSchema, importParsePageSchema, type ImportJob, type ImportRecord } from '@kiki/protocol';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { registerScopedService, ScopeActivation, _clearScopedRegistryForTests } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { Event } from '#/_base/event';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IPluginService } from '#/app/plugin/plugin';
import { PluginService } from '#/app/plugin/pluginService';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { PluginUsageService } from '#/app/pluginUsage/pluginUsageService';
import { IOAuthService } from '#/app/auth/auth';
import { StubConfigService, stubOAuthService } from '../../kosong/stubs';
import { IPluginSettingsService, PluginSettingsService } from '#/app/plugin/pluginSettingsService';
import { IPluginHostService, PluginHostService } from '#/app/plugin/pluginHostService';
import { IRequestIdentityCatalog, RequestIdentityCatalog } from '#/app/requestIdentity/requestIdentityCatalog';
import { IPluginImportService } from '#/app/pluginImport/pluginImport';
import { PluginImportService } from '#/app/pluginImport/pluginImportService';
import { LifecycleScope } from '#/app/scopes';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { IProviderService } from '#/kosong/provider/provider';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubProviderService } from '../provider/stubs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '../../fixtures/plugin-import');
const echo = path.resolve(here, '../../fixtures/plugin-host');
const namespace = 'plugin-import-v1';
const hosts: ScopedTestHost[] = [];
const storages: FileStorageService[] = [];
let root: string;
let home: string;
function host(targetHome = home): ScopedTestHost {
  const storage = new FileStorageService(targetHome);
  storages.push(storage);
  const result = createScopedTestHost([
    stubPair(IBootstrapService, stubBootstrap(targetHome)),
    stubPair(IProviderService, stubProviderService()),
    stubPair(ISessionManager, { list: () => [], get: () => undefined, onDidCreateSession: Event.None, onDidCloseSession: Event.None } as unknown as ISessionManager),
    stubPair(IConfigService, new StubConfigService({ pluginSettings: {} })),
    stubPair(IOAuthService, stubOAuthService()),
    stubPair(IFlagService, { _serviceBrand: undefined, enabled: () => true } as unknown as IFlagService),
    stubPair(ISkillDiscovery, { _serviceBrand: undefined, discover: async () => ({ skills: [], skipped: [], scannedRoots: [], scannedDirectories: [] }) } satisfies ISkillDiscovery),
    stubPair(IFileSystemStorageService, storage),
  ]);
  hosts.push(result);
  return result;
}
async function install(target: ScopedTestHost, source: string) {
  const plugins = target.app.accessor.get(IPluginService);
  const plan = await plugins.previewPlugin({ source });
  expect(plan.consentRequired).toBe(true);
  await expect(plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent: false })).rejects.toThrow();
  const installed = await plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent: true });
  await plugins.setPluginEnabled({ id: installed.id, enabled: true });
  return installed;
}
async function complete(service: IPluginImportService, id: string): Promise<ImportJob> {
  await vi.waitFor(async () => {
    const job = await service.job(id);
    expect(['completed', 'failed', 'cancelled', 'interrupted']).toContain(job.status);
  }, { timeout: 60_000, interval: 20 });
  return service.job(id);
}
async function records(service: IPluginImportService, archiveId: string): Promise<ImportRecord[]> {
  const result: ImportRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await service.read({ archiveId, cursor });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024);
    result.push(...page.records);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return result;
}
async function importOne(service: IPluginImportService, pluginId: string, sourceId: string, sourceHome: string, externalId: string) {
  const preview = await service.preview({ pluginId, sourceId, home: sourceHome, externalId });
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(64 * 1024);
  const started = await service.start({ previewId: preview.id, acknowledge: true });
  const job = await complete(service, started.id);
  expect(job.status, job.error ?? '').toBe('completed');
  return { preview, job, history: await records(service, job.archiveId!) };
}
beforeEach(async () => {
  _clearScopedRegistryForTests();
  registerScopedService(LifecycleScope.App, IPluginUsageService, PluginUsageService, ScopeActivation.OnDemand, 'pluginUsage');
  registerScopedService(LifecycleScope.App, IPluginService, PluginService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginSettingsService, PluginSettingsService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginHostService, PluginHostService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginImportService, PluginImportService, ScopeActivation.OnDemand, 'pluginImport');
  registerScopedService(LifecycleScope.App, IAtomicDocumentStore, JsonAtomicDocumentStore, ScopeActivation.OnDemand, 'storage');
  registerScopedService(LifecycleScope.App, IRequestIdentityCatalog, RequestIdentityCatalog, ScopeActivation.OnDemand, 'requestIdentity');
  const scratch = path.resolve(here, '../../../../../.tmp');
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(path.join(scratch, 'kiki-import-fixture-'));
  home = path.join(root, 'empty-kiki-home');
  await mkdir(home);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const target of hosts.splice(0)) await target.dispose();
  for (const storage of storages.splice(0)) await storage.close();
  await rm(root, { recursive: true, force: true });
});
describe('native finite session-source import', () => {
  it('provides built-in history rules without installation and retains third party sources without executing history', async () => {
    const target = host();
    const builtins = await target.app.accessor.get(IPluginImportService).sources();
    expect(builtins).toHaveLength(6);
    expect(await target.app.accessor.get(IPluginService).listPlugins()).toEqual([]);
    await install(target, fixture);
    const service = target.app.accessor.get(IPluginImportService);
    expect((await service.sources()).map((item) => item.id).toSorted()).toEqual(['claude-code', 'codex', 'custom', 'example-export', 'grok', 'opencode', 'pi']);
    const input = path.join(root, 'chosen-source'); await mkdir(input);
    const claude = [
      { type: 'user', uuid: 'u1', message: { content: 'repeat' } },
      { type: 'assistant', uuid: 'a1', isSidechain: true, parentUuid: 'u1', message: { content: [{ type: 'tool_use', id: 'call1', name: 'never_execute', input: { command: 'do not run' } }], usage: { input_tokens: 500 } } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'result' }, { type: 'image', source: { type: 'base64', data: 'private-media' } }] } },
      { type: 'summary', summary: 'compression history' },
      { type: 'user', message: { content: 'repeat' } },
      { type: 'future-format', payload: 'unknown retained as metadata' },
    ].map((item) => JSON.stringify(item)).join('\n') + '\nbroken row\n';
    await writeFile(path.join(input, 'same.jsonl'), claude);
    const first = await importOne(service, 'kiki-history', 'claude-code', input, 'same.jsonl');
    expect(first.history.filter((item) => item.role === 'user' && item.text === 'repeat')).toHaveLength(2);
    expect(first.history).toContainEqual(expect.objectContaining({ role: 'tool_call', toolName: 'never_execute', toolCallId: 'call1' }));
    expect(first.history).toContainEqual(expect.objectContaining({ role: 'tool', text: 'result', toolCallId: 'call1' }));
    expect(first.job.losses.map((item) => item.code)).toEqual(expect.arrayContaining(['bad_jsonl', 'unknown_record', 'attachment_not_imported']));
    expect(first.job.losses.find((item) => item.code === 'bad_jsonl')?.count).toBe(1);
    expect(first.job.losses.find((item) => item.code === 'attachment_not_imported')?.count).toBe(1);
    expect(first.history.some((item) => item.text.includes('private-media'))).toBe(false);
    expect(await readFile(path.join(input, 'same.jsonl'), 'utf8')).toBe(claude);
    const codex = [
      { type: 'session_meta', payload: { id: 'same', forked_from_id: 'parent' } },
      { type: 'response_item', payload: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'historical system only' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'repeat' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'never_execute', call_id: 'c1', arguments: '{"x":1}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'done' } },
      { type: 'compacted', payload: { message: 'summary' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'file:///missing' }] } },
    ].map((item) => JSON.stringify(item)).join('\n');
    await writeFile(path.join(input, 'codex.jsonl'), codex);
    const second = await importOne(service, 'kiki-history', 'codex', input, 'codex.jsonl');
    expect(second.history).toContainEqual(expect.objectContaining({ role: 'system', text: 'historical system only' }));
    expect(second.job.losses.map((item) => item.code)).toContain('inherited_history_not_loaded');
    await writeFile(path.join(input, 'history.json'), JSON.stringify([{ id: 'third', part: 0, role: 'user', text: 'third-party-neutral-format' }]));
    const third = await importOne(service, 'example-session-source', 'example-export', input, 'history.json');
    expect(third.history[0]?.text).toBe('third-party-neutral-format');
    expect((await service.archives()).items).toHaveLength(3);
    expect(await target.app.accessor.get(IAtomicDocumentStore).list('sessions')).toEqual([]);
    await expect(readFile(path.join(home, 'config.toml'))).rejects.toThrow();
  });
  it('counts losses once across page boundaries and does not drop malformed rows after the first hundred', async () => {
    const target = host();

    const input = path.join(root, 'loss-pages'); await mkdir(input);
    const service = target.app.accessor.get(IPluginImportService);
    for (const [pluginId, sourceId] of [['kiki-history', 'claude-code'], ['kiki-history', 'codex']] as const) {
      const user = sourceId === 'codex'
        ? { type: 'event_msg', payload: { type: 'user_message', message: 'padding' } }
        : { type: 'user', message: { content: 'padding' } };
      const image = sourceId === 'codex'
        ? { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image' }] } }
        : { type: 'user', message: { content: [{ type: 'image' }] } };
      await writeFile(path.join(input, 'losses.jsonl'), [...Array.from({ length: 32 }, () => JSON.stringify(user)), JSON.stringify(image), ...Array.from({ length: 300 }, () => 'broken row')].join('\n'));
      const result = await importOne(service, pluginId, sourceId, input, 'losses.jsonl');
      expect(result.job.losses.filter((item) => item.code === 'bad_jsonl').reduce((sum, item) => sum + item.count, 0)).toBe(300);
      expect(result.job.losses.filter((item) => item.code === 'attachment_not_imported').reduce((sum, item) => sum + item.count, 0)).toBe(1);
    }
  });
  it('discovers every file across directory and locale ordering page boundaries', async () => {
    const target = host();

    const input = path.join(root, 'discovery'); await mkdir(input);
    const expected: string[] = [];
    for (const directory of ['a', 'A-first', 'z']) {
      await mkdir(path.join(input, directory));
      for (let index = 0; index < 55; index++) {
        const externalId = `${directory}/${index}.jsonl`;
        expected.push(externalId);
        await writeFile(path.join(input, externalId), '{}');
      }
    }
    const service = target.app.accessor.get(IPluginImportService);
    for (const [pluginId, sourceId] of [['kiki-history', 'claude-code'], ['kiki-history', 'codex']] as const) {
      const found: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.discover({ pluginId, sourceId, home: input, cursor });
        found.push(...page.entries.map((item) => item.externalId));
        cursor = page.cursor ?? undefined;
      } while (cursor);
      expect(found.toSorted()).toEqual(expected.toSorted());
      await expect(service.discover({ pluginId, sourceId, home: input, cursor: 'removed.jsonl' })).rejects.toThrow('cursor no longer exists');
    }
  });
  it('transports more than the old 16 MiB RPC limit in pages and preserves long Unicode text', async () => {
    const target = host();
    const input = path.join(root, 'large-source'); await mkdir(input);
    const long = '文🦊\\\n'.repeat(14_000);
    const lines = Array.from({ length: 180 }, (_, index) => JSON.stringify({ type: 'user', uuid: String(index), message: { content: long } })).join('\n');
    expect(lines.length).toBeGreaterThan(16 * 1024 * 1024);
    await writeFile(path.join(input, 'large.jsonl'), lines);
    const service = target.app.accessor.get(IPluginImportService);
    const result = await importOne(service, 'kiki-history', 'claude-code', input, 'large.jsonl');
    expect(result.preview.coverage).toBe('sample');
    expect(result.job.pages).toBeGreaterThan(100);
    expect(result.history.filter((item) => item.role === 'user').map((item) => item.text).join('')).toBe(long.repeat(180));
  }, 120_000);
  it('isolates source homes, commits each revision idempotently and rejects stale preview conflicts', async () => {
    const target = host(); await install(target, fixture);
    const input = path.join(root, 'source-a'); const other = path.join(root, 'source-b'); await mkdir(input); await mkdir(other);
    const value = JSON.stringify([{ id: 'x', part: 0, role: 'user', text: 'same content' }]);
    await writeFile(path.join(input, 'history.json'), value); await writeFile(path.join(other, 'history.json'), value);
    const service = target.app.accessor.get(IPluginImportService);
    const first = await importOne(service, 'example-session-source', 'example-export', input, 'history.json');
    const twin = await importOne(service, 'example-session-source', 'example-export', other, 'history.json');
    expect(twin.job.archiveId).not.toBe(first.job.archiveId);
    const repeated = await importOne(service, 'example-session-source', 'example-export', input, 'history.json');
    expect(repeated.job.archiveId).toBe(first.job.archiveId);
    expect(repeated.job.pages).toBe(0);
    const existing = (await service.archives()).items.find((item) => item.id === first.job.archiveId)!;
    expect(existing.jobId).toBe(first.job.id);
    const stale = await service.preview(first.preview.selection);
    await writeFile(path.join(input, 'history.json'), JSON.stringify([{ id: 'x', part: 0, role: 'user', text: 'new revision' }]));
    const started = await service.start({ previewId: stale.id, acknowledge: true });
    expect((await complete(service, started.id)).status).toBe('failed');
    const updated = await importOne(service, 'example-session-source', 'example-export', input, 'history.json');
    expect(updated.job.archiveId).toBe(first.job.archiveId);
    expect(updated.history[0]?.text).toBe('new revision');
    expect((await service.archives()).items.find((item) => item.id === first.job.archiveId)?.previousJobIds).toEqual([first.job.id]);
    const wrong = host(path.join(root, 'other-kiki-home')).app.accessor.get(IPluginImportService);
    await expect(wrong.start({ previewId: stale.id, acknowledge: true })).rejects.toThrow('not found');
  });
  it('cancels and resumes checkpoints after restart, and unloading B does not stop A', async () => {
    const target = host(); await install(target, fixture); await install(target, echo);
    const input = path.join(root, 'delayed-source'); await mkdir(input);
    await writeFile(path.join(input, 'history.json'), JSON.stringify(Array.from({ length: 4 }, (_, index) => ({ id: String(index), part: 0, role: 'user', text: `record-${index}` }))));
    await writeFile(path.join(input, 'delay'), '10000');
    const service = target.app.accessor.get(IPluginImportService);
    const preview = await service.preview({ pluginId: 'example-session-source', sourceId: 'example-export', home: input, externalId: 'history.json' });
    const starts = await Promise.all([service.start({ previewId: preview.id, acknowledge: true }), service.start({ previewId: preview.id, acknowledge: true })]);
    expect(starts[0]!.id).toBe(starts[1]!.id);
    const id = starts[0]!.id;
    await vi.waitFor(async () => expect((await service.job(id)).pages).toBe(1));
    await target.app.accessor.get(IPluginService).removePlugin({ id: 'fixture-tool' });
    expect((await service.job(id)).status).toBe('running');
    const cancelled = await service.cancel(id);
    expect(cancelled.status).toBe('cancelled'); expect(cancelled.pages).toBe(1);
    await rm(path.join(input, 'delay'));
    await service.resume(id);
    expect((await complete(service, id)).status).toBe('completed');
    expect((await records(service, (await service.job(id)).archiveId!)).map((item) => item.text)).toEqual(['record-0', 'record-1', 'record-2', 'record-3']);
    const docs = target.app.accessor.get(IAtomicDocumentStore);
    const current = await service.job(id);
    await docs.set(namespace, `jobs.${id}`, { ...current, status: 'running', archiveId: null });
    await target.dispose();
    const restarted = host().app.accessor.get(IPluginImportService);
    expect((await restarted.job(id)).status).toBe('completed');
    expect((await restarted.archives()).items).toHaveLength(1);
  });
  it('recovers a persisted parse checkpoint and interrupted own-plugin unload without duplicate records', async () => {
    const target = host(); await install(target, fixture);
    const input = path.join(root, 'interrupt-source'); await mkdir(input);
    await writeFile(path.join(input, 'history.json'), JSON.stringify([{ id: 'a', part: 0, role: 'user', text: 'first' }, { id: 'b', part: 0, role: 'tool_call', text: 'never replay' }]));
    await writeFile(path.join(input, 'delay'), '10000');
    const service = target.app.accessor.get(IPluginImportService);
    const preview = await service.preview({ pluginId: 'example-session-source', sourceId: 'example-export', home: input, externalId: 'history.json' });
    const started = await service.start({ previewId: preview.id, acknowledge: true });
    await vi.waitFor(async () => expect((await service.job(started.id)).pages).toBe(1));
    await target.app.accessor.get(IPluginService).setPluginEnabled({ id: 'example-session-source', enabled: false });
    expect((await service.job(started.id)).status).toBe('interrupted');
    expect((await service.archives()).items).toHaveLength(0);
    await target.app.accessor.get(IPluginService).setPluginEnabled({ id: 'example-session-source', enabled: true });
    await target.dispose();
    await rm(path.join(input, 'delay'));
    const next = host().app.accessor.get(IPluginImportService);
    await next.resume(started.id);
    const completed = await complete(next, started.id);
    expect(completed.status).toBe('completed');
    expect((await records(next, completed.archiveId!)).map((item) => item.text)).toEqual(['first', 'never replay']);
  });
  it('recovers staging, commit and ACK fault boundaries without publishing partial or duplicate archives', async () => {
    const target = host(); await install(target, fixture);
    const service = target.app.accessor.get(IPluginImportService);
    const docs = target.app.accessor.get(IAtomicDocumentStore);
    for (const boundary of ['staging', 'commit', 'ack']) {
      const input = path.join(root, boundary); await mkdir(input);
      await writeFile(path.join(input, 'history.json'), JSON.stringify([{ id: 'a', part: 0, role: 'user', text: boundary }, { id: 'b', part: 0, role: 'system', text: 'history only' }]));
      const preview = await service.preview({ pluginId: 'example-session-source', sourceId: 'example-export', home: input, externalId: 'history.json' });
      const original = docs.set.bind(docs);
      let injected = false;
      const injection = vi.spyOn(docs, 'set').mockImplementation(async (scope, key, value) => {
        const hit = boundary === 'staging' ? scope.startsWith(namespace + '/pages/') : boundary === 'commit' ? key.startsWith('archives.') : key.startsWith('jobs.') && (value as ImportJob).status === 'completed';
        if (hit && !injected) { injected = true; throw new Error(`fixture ${boundary} failure`); }
        await original(scope, key, value);
      });
      const started = await service.start({ previewId: preview.id, acknowledge: true });
      const stopped = await complete(service, started.id);
      injection.mockRestore(); expect(injected).toBe(true);
      if (boundary !== 'ack') {
        expect(stopped.status).toBe('failed');
        expect((await service.archives()).items.some((item) => item.sourceHome === input)).toBe(false);
        await service.resume(started.id);
      }
      const completed = await complete(service, started.id);
      expect(completed.status).toBe('completed');
      expect((await records(service, completed.archiveId!)).map((item) => item.text)).toEqual([boundary, 'history only']);
      expect((await service.archives()).items.filter((item) => item.id === completed.archiveId)).toHaveLength(1);
    }
  });
});

describe('native source conversation selection', () => {
  async function parseNative(target: ScopedTestHost, pluginId: string, sourceId: string, data: unknown[]) {
    const input = path.join(root, `${sourceId}-native`); await mkdir(input, { recursive: true });
    await writeFile(path.join(input, 'history.jsonl'), data.map((item) => JSON.stringify(item)).join('\n'));
    const selection = { home: input, externalId: 'history.jsonl', mode: 'native-session' as const };
    const host = target.app.accessor.get(IPluginHostService);
    const signal = AbortSignal.timeout(10_000);
    const probe = importProbeSchema.parse(await host.requestSource(pluginId, sourceId, 'probe', selection, signal));
    const result: ImportRecord[] = []; let cursor: string | undefined;
    do {
      const page = importParsePageSchema.parse(await host.requestSource(pluginId, sourceId, 'parse', { ...selection, revision: probe.revision, cursor }, signal));
      result.push(...page.records); cursor = page.cursor ?? undefined;
    } while (cursor);
    return { result, probe };
  }
  it('reconciles Codex duplicate channels by occurrence and reads canonical paginated items instead of synthetic provider context', async () => {
    const target = host();
    const response = (role: string, text: string) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'text', text }] } });
    const event = (type: string, message: string) => ({ type: 'event_msg', payload: { type, message } });
    const legacy = await parseNative(target, 'kiki-history', 'codex', [
      { type: 'session_meta', payload: { history_mode: 'legacy' } },
      event('user_message', 'repeat'), response('user', 'repeat'),
      event('user_message', 'repeat'), response('user', 'repeat'),
      event('user_message', 'UI-only retained'), response('assistant', 'done'), event('agent_message', 'done'),
    ]);
    expect(legacy.result.filter((item) => item.role === 'user').map((item) => item.text)).toEqual(['repeat', 'repeat', 'UI-only retained']);
    expect(legacy.result.filter((item) => item.role === 'assistant').map((item) => item.text)).toEqual(['done']);
    expect(legacy.probe.losses.find((item) => item.code === 'duplicate_message_projection')?.count).toBe(3);
    const paginated = await parseNative(target, 'kiki-history', 'codex', [
      { type: 'session_meta', payload: { history_mode: 'paginated', cli_version: '0.147.0' } },
      response('user', 'synthetic provider environment'),
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'canonical user' }] } } },
      response('assistant', 'provider duplicate'),
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'canonical assistant' }] } } },
    ].map((item, ordinal) => ({ ...item, ordinal })));
    expect(paginated.result.filter((item) => ['user', 'assistant'].includes(item.role)).map((item) => [item.role, item.text])).toEqual([['user', 'canonical user'], ['assistant', 'canonical assistant']]);
    await expect(parseNative(target, 'kiki-history', 'codex', [{ type: 'session_meta', payload: { history_mode: 'future-mode' } }])).rejects.toThrow('Unsupported Codex history mode');
    await expect(parseNative(target, 'kiki-history', 'codex', [{ type: 'session_meta', ordinal: 0, payload: { history_mode: 'paginated' } }, { ...response('user', 'gap'), ordinal: 2 }])).rejects.toThrow('contiguous');
  });
  it('uses the Claude active UUID graph with preserved compaction, rejects broken graph claims, and retains actual message roles', async () => {
    const target = host();
    const selected = await parseNative(target, 'kiki-history', 'claude-code', [
      { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', logicalParentUuid: 'tail', compactMetadata: { preservedSegment: { anchorUuid: 'summary', headUuid: 'head', tailUuid: 'tail' }, preservedMessages: { allUuids: ['head', 'tail'] } } },
      { type: 'user', uuid: 'summary', parentUuid: 'boundary', isCompactSummary: true, message: { content: 'historical summary' } },
      { type: 'assistant', uuid: 'tail', parentUuid: 'head', message: { content: [{ type: 'thinking', thinking: 'private internal reasoning' }, { type: 'text', text: 'tail reply' }] } },
      { type: 'assistant', uuid: 'head', parentUuid: 'summary', message: { role: 'user', content: 'actual user role' } },
      { type: 'assistant', uuid: 'side', isSidechain: true, message: { content: 'sidechain' } },
      { type: 'last-prompt', leafUuid: 'tail' },
    ]);
    expect(selected.result.filter((item) => ['user', 'assistant'].includes(item.role)).map((item) => [item.role, item.text])).toEqual([
      ['assistant', '[Imported historical compaction summary]\nhistorical summary'], ['user', 'actual user role'], ['assistant', 'tail reply'],
    ]);
    expect(selected.result.some((item) => item.text.includes('private internal reasoning'))).toBe(false);
    const record = { type: 'user', uuid: 'u', parentUuid: 'missing', message: { content: 'user' } };
    await expect(parseNative(target, 'kiki-history', 'claude-code', [record])).rejects.toThrow('missing parent');
    await expect(parseNative(target, 'kiki-history', 'claude-code', [{ ...record, parentUuid: 'u' }])).rejects.toThrow('ancestry cycle');
    await expect(parseNative(target, 'kiki-history', 'claude-code', [{ ...record, parentUuid: null }, { ...record, parentUuid: null }])).rejects.toThrow('duplicate record UUID');
  });
  it('projects Pi active branches, Grok ACP sessions and OpenCode exports with explicit losses in one installed rule pack', async () => {
    const target = host();
    const input = path.join(root, 'rules'); await mkdir(input);
    const runner = target.app.accessor.get(IPluginHostService);
    const signal = AbortSignal.timeout(10_000);
    async function readRule(sourceId: string, externalId: string) {
      const selection = { home: input, externalId, mode: 'native-session' as const };
      const probe = importProbeSchema.parse(await runner.requestSource('kiki-history', sourceId, 'probe', selection, signal));
      const page = importParsePageSchema.parse(await runner.requestSource('kiki-history', sourceId, 'parse', { ...selection, revision: probe.revision }, signal));
      expect(page.cursor).toBeNull();
      return { probe, records: page.records };
    }
    const pi = [
      { type: 'session', version: 3, id: 'pi-session', cwd: '/foreign', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Pi question' } },
      { type: 'message', id: 'inactive', parentId: 'u', message: { role: 'assistant', content: 'inactive branch' } },
      { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [{ type: 'text', text: 'Pi answer' }, { type: 'thinking', thinking: 'private' }, { type: 'toolCall', id: 'c', name: 'never_execute', arguments: { command: 'never run' } }] } },
      { type: 'message', id: 'r', parentId: 'a', message: { role: 'toolResult', toolCallId: 'c', toolName: 'never_execute', content: [{ type: 'text', text: 'Pi result' }, { type: 'image', data: 'not copied' }] } },
      { type: 'compaction', id: 's', parentId: 'r', summary: 'Pi summary', firstKeptEntryId: 'u' },
      { type: 'session_info', id: 'info', parentId: 's', name: 'Pi title' },
    ];
    await writeFile(path.join(input, 'pi.jsonl'), pi.map((row) => JSON.stringify(row)).join('\n'));
    const selectedPi = await readRule('pi', 'pi.jsonl');
    expect(selectedPi.records.map((record) => record.text).join('\n')).toContain('Pi summary');
    expect(selectedPi.records.some((record) => record.text.includes('inactive branch') || record.text.includes('private') || record.text.includes('not copied'))).toBe(false);
    expect(selectedPi.records).toContainEqual(expect.objectContaining({ role: 'tool_call', toolName: 'never_execute' }));
    expect(selectedPi.probe.losses).toContainEqual(expect.objectContaining({ code: 'inactive_pi_branch', count: 1 }));
    expect(selectedPi.probe.losses.map((loss) => loss.code)).toEqual(expect.arrayContaining(['thinking_not_imported', 'attachment_not_imported', 'compaction_state_not_imported']));
    await writeFile(path.join(input, 'pi.jsonl'), pi.map((row, index) => JSON.stringify(index === 1 ? { ...row, parentId: 'missing' } : row)).join('\n'));
    await expect(readRule('pi', 'pi.jsonl')).rejects.toThrow('missing parent');
    const id = '00000000-0000-4000-8000-000000000001';
    const updates = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Grok ' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'question' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Grok answer' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private thinking' } },
      { sessionUpdate: 'tool_call', toolCallId: 'g', title: 'never_execute', rawInput: { command: 'never run' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'g', status: 'running' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'g', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Grok result' } }] },
    ].map((update) => ({ method: 'session/update', timestamp: 1_767_225_600, params: { sessionId: id, update } }));
    await mkdir(path.join(input, 'grok'));
    await writeFile(path.join(input, 'grok/summary.json'), JSON.stringify({ info: { id, cwd: '/foreign' }, num_messages: updates.length, generated_title: 'Grok title' }));
    await writeFile(path.join(input, 'grok/updates.jsonl'), updates.map((row) => JSON.stringify(row)).join('\n'));
    const selectedGrok = await readRule('grok', 'grok/summary.json');
    expect(selectedGrok.records.map((record) => [record.role, record.text])).toEqual([
      ['user', 'Grok question'], ['assistant', 'Grok answer'], ['tool_call', '{"command":"never run"}'], ['tool', 'Grok result'],
    ]);
    expect(selectedGrok.probe.losses.map((loss) => loss.code)).toEqual(expect.arrayContaining(['stream_chunks_joined', 'thinking_not_imported', 'unfinished_tool_update_not_imported']));
    await writeFile(path.join(input, 'grok/updates.jsonl'), updates.map((row) => JSON.stringify({ ...row, params: { ...row.params, sessionId: 'other-session' } })).join('\n'));
    await expect(readRule('grok', 'grok/summary.json')).rejects.toThrow('linkage');
    const share = [
      { type: 'session', data: { id: 'oc', title: 'OpenCode title' } },
      { type: 'part', data: { messageID: 'u', type: 'text', text: 'OpenCode question' } },
      { type: 'message', data: { id: 'u', sessionID: 'oc', role: 'user' } },
      { type: 'message', data: { id: 'a', sessionID: 'oc', role: 'assistant' } },
      { type: 'part', data: { messageID: 'a', type: 'text', text: 'OpenCode answer' } },
      { type: 'part', data: { messageID: 'a', type: 'tool', tool: 'never_execute', callID: 'o', state: { status: 'completed', input: { command: 'never run' }, output: 'OpenCode result' } } },
      { type: 'part', data: { messageID: 'a', type: 'reasoning', text: 'private' } },
      { type: 'part', data: { messageID: 'u', type: 'text', synthetic: true, text: 'synthetic permission' } },
      { type: 'part', data: { messageID: 'u', type: 'file', url: 'not copied' } },
    ];
    await writeFile(path.join(input, 'opencode.json'), JSON.stringify(share));
    const selectedOpenCode = await readRule('opencode', 'opencode.json');
    expect(selectedOpenCode.records.filter((record) => record.role === 'user').map((record) => record.text)).toEqual(['OpenCode question']);
    expect(selectedOpenCode.records).toContainEqual(expect.objectContaining({ role: 'tool', text: 'OpenCode result' }));
    expect(selectedOpenCode.probe.losses.map((loss) => loss.code)).toEqual(expect.arrayContaining(['thinking_not_imported', 'synthetic_text_not_imported', 'attachment_not_imported']));
    await writeFile(path.join(input, 'opencode.json'), JSON.stringify([...share, { type: 'part', data: { messageID: 'missing', type: 'text', text: 'orphan' } }]));
    await expect(readRule('opencode', 'opencode.json')).rejects.toThrow('missing message');
  });
});
