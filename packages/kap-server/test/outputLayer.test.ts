import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestInstantiationService } from '@kiki/agent-core-v2/_base/di/test';
import { SyncDescriptor } from '@kiki/agent-core-v2/_base/di/descriptors';
import { IOutputLayerService, OutputLayerService, IPluginService, IPluginHostService, IPluginSettingsService, IModelCatalog, IModelService, IPluginUsageService, ISessionIndex, IWorkspaceService, IConfigService, type Scope } from '@kiki/agent-core-v2';
import type { Model } from '@kiki/agent-core-v2/kosong/model/catalog';
import type { ModelRequestInput, ModelRequestEvent } from '@kiki/agent-core-v2/kosong/model/modelRequester';
import { HttpChannel } from '@kiki/klient/transports/http/channel';
import { OUTPUT_LAYER_DEFAULT_PRESETS, OUTPUT_LAYER_DEFAULT_SETTINGS, type OutputLayerRequest } from '@kiki/protocol';
import { registerOutputLayerRoutes } from '../src/routes/outputLayer';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).toReversed()) await dispose(); });

async function fixture() {
  const ix = new TestInstantiationService(); cleanup.push(() => ix.dispose());
  let fail = false, wait = false;
  let cancelled: () => void = () => {};
  const cancelledPromise = new Promise<void>((resolve) => { cancelled = resolve; });
  const calls: ModelRequestInput[] = [];
  const requester = { model: { maxContextSize: 32768 } as Model,
    async *request(input: ModelRequestInput, signal: AbortSignal | undefined): AsyncIterable<ModelRequestEvent> {
      calls.push(input);
      yield { type: 'part', part: { type: 'text', text: '流式' } };
      if (wait) await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true });
      });
      signal?.throwIfAborted();
      if (fail) throw new Error('fixture provider unavailable');
      yield { type: 'part', part: { type: 'text', text: '译文😀' } };
    },
  };
  let values = { enabled: true, presets: [...OUTPUT_LAYER_DEFAULT_PRESETS], settings: OUTPUT_LAYER_DEFAULT_SETTINGS };
  ix.stub(IPluginService, { listPlugins: async () => [{ id: 'kiki-output-layer', displayName: 'Output Layer', enabled: true, globalEnabled: true, state: 'ok',
    skillCount: 0, mcpServerCount: 0, enabledMcpServerCount: 0, hookCount: 0, commandCount: 0, hasErrors: false, source: 'local-path' }] });
  ix.stub(IPluginHostService, { requestPanel: async () => values });
  ix.stub(IPluginSettingsService, { update: async (input) => {
    values = { enabled: true, presets: JSON.parse(input.values['presets'] as string), settings: {
      groupChars: input.values['groupChars'] as number, historyTokens: input.values['historyTokens'] as number,
      preloadBefore: input.values['preloadBefore'] as number, preloadAfter: input.values['preloadAfter'] as number,
    } }; return { values: {}, secretsConfigured: [] };
  } });
  ix.stub(IModelCatalog, { getRequester: () => requester, getConnectionRequester: () => requester });
  ix.stub(IConfigService, { get: <T>(): T => undefined as T });
  ix.stub(IModelService, { getDefaultModel: () => 'fixture-model' });
  const allows = vi.fn(async (_workspaceId: string | undefined, _pluginId: string, sessionId?: string) => sessionId !== 'disabled-session');
  ix.stub(IPluginUsageService, { allows });
  ix.stub(ISessionIndex, { get: async (id) => ['example-session', 'disabled-session'].includes(id) ? { id, workspaceId: 'workspace-example', createdAt: 1, updatedAt: 1, archived: false } : undefined });
  ix.stub(IWorkspaceService, { get: async (id) => ({ id, root: '/example', name: 'Example', createdAt: 1, lastOpenedAt: 1, pinned: false }) });
  ix.set(IOutputLayerService, new SyncDescriptor(OutputLayerService));
  const scope = { accessor: { get: ix.get.bind(ix) } } as unknown as Scope;
  const app = Fastify(); cleanup.push(() => app.close());
  app.addHook('preHandler', async (req, reply) => { if (req.headers.authorization !== 'Bearer fixture-token') await reply.code(401).send({ error: 'unauthorized' }); });
  await app.register(async (routes) => registerOutputLayerRoutes(routes as unknown as Parameters<typeof registerOutputLayerRoutes>[0], scope), { prefix: '/api' });
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const channel = new HttpChannel({ endpoint, token: 'fixture-token' }); cleanup.push(() => channel.close());
  return { api: channel.rest.outputLayer, app, calls, allows, endpoint, fail: () => { fail = true; }, wait: () => { wait = true; }, cancelledPromise };
}

const input: OutputLayerRequest = { sessionId: 'example-session', sourceId: 'frame:0', sourceRevision: '1', text: 'Visible Assistant text',
  preset: { ...OUTPUT_LAYER_DEFAULT_PRESETS[0]!, modelId: 'fixture-model' }, history: [], historyTokens: 16384, cycleId: 'cycle-example' };

describe('output layer HTTP vertical path (mock provider)', () => {
  it('passes the indexed session scope to configuration and generation and rejects unknown sessions', async () => {
    const f = await fixture();
    expect((await f.api.configuration({ sessionId: 'example-session' })).enabled).toBe(true);
    expect(f.allows).toHaveBeenLastCalledWith('workspace-example', 'kiki-output-layer', 'example-session');
    expect((await f.api.configuration({ sessionId: 'disabled-session' })).enabled).toBe(false);
    const events: unknown[] = [];
    await f.api.stream({ ...input, sessionId: 'disabled-session' }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: 'failed' });
    expect(f.calls).toHaveLength(0);
    await f.api.stream({ ...input, sessionId: 'unknown-session' }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: 'failed', message: 'Session was not found' });
    expect(f.calls).toHaveLength(0);
  });

  it('reads and updates plugin settings then streams native output without a session or agent operation', async () => {
    const f = await fixture();
    expect((await f.api.configuration()).enabled).toBe(true);
    expect((await f.api.configure({ presets: [{ ...input.preset, instruction: 'Changed prompt' }], settings: { ...OUTPUT_LAYER_DEFAULT_SETTINGS, groupChars: 800 } })).settings.groupChars).toBe(800);
    const events: unknown[] = [];
    await f.api.stream(input, (event) => events.push(event));
    expect(events).toContainEqual({ type: 'delta', text: '流式' });
    expect(events.at(-1)).toEqual({ type: 'completed', text: '流式译文😀' });
    expect(f.calls[0]!.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: input.text }], toolCalls: [] }]);
    const unauthorized = await fetch(`${f.endpoint}/api/output-layer/configuration`);
    expect(unauthorized.status).toBe(401);
    const invalid = await f.app.inject({ method: 'POST', url: '/api/output-layer/stream', headers: { authorization: 'Bearer fixture-token' }, payload: { ...input, text: '', userMessages: ['private user text'] } });
    expect(invalid.headers['content-type'], invalid.body).not.toContain('application/x-ndjson');
    expect(invalid.json().code).not.toBe(0);
    expect(f.calls).toHaveLength(1);
  });

  it('returns provider failures as terminal output-layer state without removing earlier text', async () => {
    const f = await fixture(); f.fail();
    const events: unknown[] = [];
    await f.api.stream(input, (event) => events.push(event));
    expect(events).toContainEqual({ type: 'delta', text: '流式' });
    expect(events.at(-1)).toMatchObject({ type: 'failed', message: 'fixture provider unavailable' });
  });

  it('aborts the native requester when the reading stream disconnects', async () => {
    const f = await fixture(); f.wait();
    const controller = new AbortController();
    const read = f.api.stream(input, (event) => { if (event.type === 'delta') controller.abort(); }, { signal: controller.signal });
    await expect(read).rejects.toThrow();
    await f.cancelledPromise;
    expect(f.calls).toHaveLength(1);
  });
});
