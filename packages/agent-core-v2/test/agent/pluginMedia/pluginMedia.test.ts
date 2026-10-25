import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MediaJob } from '@kiki/protocol';
import { createControlledPromise } from '@antfu/utils';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAgentPluginMediaService } from '#/agent/pluginMedia/pluginMedia';
import { IPluginMediaService } from '#/app/pluginMedia/pluginMedia';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { TaskNotificationStepRequest } from '#/agent/task/taskService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IPluginService } from '#/app/plugin/plugin';
import { IConfigService } from '#/app/config/config';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { createTestAgent, homeDirServices, taskServices, type TestAgentContext } from '../../harness';

let root: string;
let ctx: TestAgentContext;

async function readyFixture(context: TestAgentContext): Promise<void> {
  await Promise.all([
    context.ready,
    context.get(ISessionMetadata).ready,
    context.get(ISessionDeliveryService).ready,
  ]);
}

beforeEach(async () => {
  const scratch = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../.tmp');
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(path.join(scratch, 'agent-media-'));
  ctx = createTestAgent(homeDirServices(root), taskServices());
  await readyFixture(ctx);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
it.each([false, true])('owns the initial metadata write before the media fixture becomes ready (failure: %s)', async (fail) => {
  const directory = path.join(root, 'gated-metadata');
  const started = createControlledPromise<void>();
  const release = createControlledPromise<void>();
  const failure = new Error('metadata write failed fixture');
  const write = FileStorageService.prototype.write;
  let target: string | undefined;
  vi.spyOn(FileStorageService.prototype, 'write').mockImplementation(async function (this: FileStorageService, scope, key, data, options) {
    if (path.resolve(this.pathFor(scope, key)) === target) {
      started.resolve();
      await release;
      if (fail) throw failure;
    }
    await write.call(this, scope, key, data, options);
  });
  const fresh = createTestAgent(homeDirServices(directory), taskServices());
  target = path.resolve(directory, fresh.get(ISessionContext).metaScope, 'state.json');
  const metadata = fresh.get(ISessionMetadata);
  const observed = metadata.ready.then(() => undefined, (error: unknown) => error);
  let finished = false;
  const initializing = readyFixture(fresh).then(
    () => { finished = true; return undefined; },
    (error: unknown) => { finished = true; return error; },
  );
  const cleanup = async (): Promise<void> => {
    release.resolve();
    await observed;
    try {
      await fresh.dispose();
    } catch (error) {
      if (!fail || error !== failure) throw error;
    }
  };
  let bodyError: unknown;
  let bodyFailed = false;
  try {
    await started;
    await fresh.ready;
    await Promise.resolve();
    expect(finished).toBe(false);
    release.resolve();
    expect(await initializing).toBe(fail ? failure : undefined);
    expect(await observed).toBe(fail ? failure : undefined);
    if (!fail) {
      const persisted = JSON.parse(await readFile(target, 'utf8')) as { id: string; agents: Record<string, unknown> };
      expect(persisted).toMatchObject({ id: fresh.get(ISessionContext).sessionId, agents: {} });
      expect(await metadata.read()).toMatchObject({ id: persisted.id, agents: persisted.agents });
    }
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }
  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (bodyFailed && cleanupFailed) {
    throw new AggregateError([bodyError, cleanupError], 'Plugin media fixture cleanup failed');
  }
  if (bodyFailed) throw bodyError;
  if (cleanupFailed) throw cleanupError;
});

it('snapshots session file_id and admitted runtime paths to host staging while retaining URL references', async () => {
  const files = ctx.get(ISessionMediaStore);
  const data = Buffer.from('session-original-bytes');
  await files.materialize({ fileId: 'f_input_fixture', name: 'input.png', mimeType: 'image/png', size: data.length, stream: () => Readable.from([data]) });
  const bridge = ctx.get(IAgentPluginMediaService);
  const fs = new HostFileSystem();
  const signal = new AbortController().signal;
  const cached = await bridge.snapshotInput({ file_id: 'f_input_fixture' }, 'cached', fs, signal);
  expect(cached).not.toHaveProperty('file_id');
  expect(await readFile((cached as { path: string }).path, 'utf8')).toBe('session-original-bytes');
  const input = path.join(root, 'runtime-input.png'); await writeFile(input, 'runtime-original-bytes');
  const copied = await bridge.snapshotInput({ path: input }, 'path', fs, signal);
  expect((copied as { path: string }).path).not.toBe(input);
  expect(await readFile((copied as { path: string }).path, 'utf8')).toBe('runtime-original-bytes');
  const url = { url: 'https://fixture.invalid/image.png' };
  expect(await bridge.snapshotInput(url, 'url', fs, signal)).toBe(url);
});
it('passes the current session scope to media discovery actions', async () => {
  const media = ctx.get(IPluginMediaService);
  const capabilities = vi.spyOn(media, 'capabilities').mockResolvedValue({ models: [] } as never);
  const voices = vi.spyOn(media, 'voices').mockResolvedValue({ voices: [] } as never);
  const bridge = ctx.get(IAgentPluginMediaService);
  const api = bridge.api('scope-fixture', { kind: 'image', prompt: 'scope' });
  await api.media({ action: 'capabilities' });
  await api.media({ action: 'voices', provider: 'fixture/synthetic' });
  const scope = { workspaceId: ctx.get(ISessionContext).workspaceId, sessionId: ctx.get(ISessionContext).sessionId };
  expect(capabilities).toHaveBeenCalledWith({}, scope);
  expect(voices).toHaveBeenCalledWith({ provider: 'fixture/synthetic' }, scope);
});
it('enforces job session/agent ownership and passes only admitted generation parameters', async () => {
  const media = ctx.get(IPluginMediaService);
  const bridge = ctx.get(IAgentPluginMediaService);
  const own = { sessionId: ctx.get(ISessionContext).sessionId, agentId: ctx.get(IAgentScopeContext).agentId };
  const stored = vi.spyOn(media, 'stored').mockResolvedValue({ owner: { ...own, agentId: 'other-agent' } } as Awaited<ReturnType<IPluginMediaService['stored']>>);
  const cancel = vi.spyOn(media, 'cancel').mockResolvedValue({ state: 'stopped' } as MediaJob);
  const resume = vi.spyOn(media, 'resume').mockResolvedValue({ state: 'succeeded' } as MediaJob);
  const job = vi.spyOn(media, 'job').mockResolvedValue({ state: 'succeeded' } as MediaJob);
  await expect(bridge.cancel('media-fixture')).rejects.toThrow('another session or agent');
  await expect(bridge.resume('media-fixture')).rejects.toThrow('another session or agent');
  expect(cancel).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  stored.mockResolvedValue({ owner: { ...own, sessionId: 'other-session' } } as Awaited<ReturnType<IPluginMediaService['stored']>>);
  await expect(bridge.cancel('media-fixture')).rejects.toThrow('another session or agent');
  stored.mockResolvedValue({ owner: own } as Awaited<ReturnType<IPluginMediaService['stored']>>);
  expect(await bridge.cancel('media-fixture')).toMatchObject({ state: 'stopped' });
  expect(await bridge.resume('media-fixture')).toMatchObject({ state: 'succeeded' });
  expect(cancel).toHaveBeenCalledWith('media-fixture'); expect(resume).toHaveBeenCalledWith('media-fixture'); expect(job).toHaveBeenCalledWith('media-fixture');
  const request = { kind: 'image' as const, prompt: 'admitted' };
  const start = vi.spyOn(media, 'start');
  await expect(bridge.api('tool-fixture', request).generate({ request: { ...request, prompt: 'changed' } })).rejects.toThrow('changed after tool/path admission');
  expect(start).not.toHaveBeenCalled();
});
it('allows a normal admitted plugin tool to compose pure TTS while keeping declared requests exact', async () => {
  const media = ctx.get(IPluginMediaService);
  const bridge = ctx.get(IAgentPluginMediaService);
  const request = { kind: 'tts' as const, text: 'Speak this whole line.', voice: 'fixture' };
  const job = { state: 'succeeded' } as MediaJob;
  const start = vi.spyOn(media, 'start').mockResolvedValue(job);
  expect(await bridge.api('flat-speak').generate({ provider: 'fixture/speech', request })).toBe(job);
  expect(start).toHaveBeenCalledWith({ provider: 'fixture/speech', execution: 'auto', request_id: 'flat-speak', request }, expect.objectContaining({ sessionId: ctx.get(ISessionContext).sessionId, agentId: ctx.get(IAgentScopeContext).agentId }));
  expect(await bridge.api('declared-speech', request).generate({ request })).toBe(job);
  await expect(bridge.api('declared-speech', request).generate({ request: { ...request, text: 'Changed after admission' } })).rejects.toThrow('changed after tool/path admission');
  await expect(bridge.api('declared-image', { kind: 'image', prompt: 'admitted' }).generate({ request })).rejects.toThrow('changed after tool/path admission');
  expect(start).toHaveBeenCalledTimes(2);
});
it('does not let ordinary TTS orchestration introduce image/video inputs or session file IDs without admission', async () => {
  const bridge = ctx.get(IAgentPluginMediaService);
  const start = vi.spyOn(ctx.get(IPluginMediaService), 'start');
  const api = bridge.api('flat-tool');
  await expect(api.generate({ request: { kind: 'image', prompt: 'unadmitted', images: [{ path: path.join(root, 'outside.png') }] } })).rejects.toThrow('changed after tool/path admission');
  await expect(api.generate({ request: { kind: 'image', prompt: 'unadmitted', images: [{ file_id: 'f_session_input' }] } })).rejects.toThrow('changed after tool/path admission');
  await expect(api.generate({ request: { kind: 'video', prompt: 'unadmitted', inputs: [{ ref: { url: 'https://example.test/frame.png' }, role: 'first_frame' }] } })).rejects.toThrow('changed after tool/path admission');
  const raw = { kind: 'tts' as const, text: 'line', voice: 'fixture', images: [{ path: path.join(root, 'outside.png') }] };
  await expect(api.generate({ request: raw })).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
});
it('settles automatic foreground generation through the existing Task release and suppresses duplicate terminal notification', async () => {
  const media = ctx.get(IPluginMediaService);
  const job: MediaJob = { schemaVersion: 1, job_id: 'media-0123456789abcdef0123456789abcdef', request_id: 'foreground-fixture', owner_session_id: ctx.get(ISessionContext).sessionId, owner_agent_id: ctx.get(IAgentScopeContext).agentId, provider: 'fixture/synthetic', state: 'running', phase: 'submit', can_resume: false, artifacts: [], created_at: 1, updated_at: 1 };
  vi.spyOn(media, 'start').mockResolvedValue(job);
  vi.spyOn(media, 'run').mockImplementation(async () => { job.state = 'succeeded'; return job; });
  vi.spyOn(media, 'job').mockImplementation(async () => job);
  vi.spyOn(media, 'bindTask').mockImplementation(async (_id, taskId) => { job.task_id = taskId; return job; });
  const request = { kind: 'image' as const, prompt: 'admitted' };
  expect(await ctx.get(IAgentPluginMediaService).api('foreground-fixture', request).generate({ request })).toMatchObject({ state: 'succeeded', task_id: expect.stringMatching(/^media-/) });
  await vi.waitFor(() => expect(ctx.get(IAgentTaskService).getTask(job.task_id!)).toMatchObject({ kind: 'media', jobId: job.job_id, status: 'completed', terminalNotificationSuppressed: true }));
});

it.skipIf(!process.env['KIKI_MEDIA_SINGLE_PLUGIN_ROOT'])('carries an independent speech script through the unified plugin, real background Task and completion notification', async () => {
  await ctx.get(IConfigService).replace('pluginSettings', {});
  const plugins = ctx.get(IPluginService);
  const source = process.env['KIKI_MEDIA_SINGLE_PLUGIN_ROOT']!;
  const plan = await plugins.previewPlugin({ source });
  await plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent: true });
  await plugins.setPluginEnabled({ id: 'kiki-media', enabled: true });
  const script = path.join(root, 'speech-fixture.mjs');
  await writeFile(script, `import {writeFile} from 'node:fs/promises';await writeFile(process.argv[2], 'speech-fixture');`);
  const media = ctx.get(IPluginMediaService);
  await media.addScriptSource({ id: 'task-speech', label: 'Task speech', kinds: ['tts'], command: process.execPath, args: [script, '{output}'] });
  const request = { kind: 'tts' as const, text: 'hello', voice: 'local' };
  const enqueue = vi.spyOn(ctx.get(IAgentLoopService), 'enqueue');
  const api = ctx.get(IAgentPluginMediaService).api('task-speech', request);
  const receipt = await api.generate({ provider: 'kiki-media/script-task-speech', execution: 'background', request });
  expect(receipt.task_id).toMatch(/^media-/);
  const tasks = ctx.get(IAgentTaskService);
  await tasks.wait(receipt.task_id!, 5000);
  expect(tasks.getTask(receipt.task_id!)).toMatchObject({ kind: 'media', jobId: receipt.job_id, status: 'completed' });
  const result = await media.job(receipt.job_id);
  expect(result).toMatchObject({ state: 'succeeded', artifacts: [{ kind: 'audio', complete: true }] });
  expect(JSON.parse(await tasks.readOutput(receipt.task_id!))).toMatchObject({ type: 'media_generation', job: result });
  await vi.waitFor(() => expect(enqueue).toHaveBeenCalledWith(expect.any(TaskNotificationStepRequest)));
  const notification = enqueue.mock.calls.find(([item]) => item instanceof TaskNotificationStepRequest)![0];
  expect(notification.resolveContextMessages()[0]?.origin).toMatchObject({ kind: 'task', taskId: receipt.task_id });
  const stored = await media.stored(result.job_id);
  expect(stored.owner).toMatchObject({ sessionId: ctx.get(ISessionContext).sessionId, agentId: ctx.get(IAgentScopeContext).agentId });
  const file = await ctx.get(ISessionMediaStore).open(result.artifacts[0]!.file_id);
  const chunks = []; for await (const chunk of file!.stream()) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('speech-fixture');
  const repeated = await api.generate({ provider: 'kiki-media/script-task-speech', execution: 'background', request });
  expect(repeated.job_id).toBe(result.job_id);
  expect(tasks.list(false)).toHaveLength(1);
});
