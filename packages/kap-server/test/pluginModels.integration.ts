import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { IAgentToolRegistryService, IPluginService, ISessionManager, ensureMainAgent } from '@kiki/agent-core-v2';
import { IRequestGovernance } from '@kiki/agent-core-v2/app/requestGovernance/requestGovernance';
import { IWireService } from '@kiki/agent-core-v2/wire/wire';
import { IEventDispatcher } from '@kiki/agent-core-v2/state/eventDispatcher';
import { ISessionMetadata } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ExternalText } from '@kiki/agent-core-v2/agent/execution/externalClientEvents';
import { SessionSubagentService } from '@kiki/agent-core-v2/session/subagent/subagentService';
import { ISessionContext } from '@kiki/agent-core-v2/session/sessionContext/sessionContext';
import { IAgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { IFileSystemStorageService } from '@kiki/agent-core-v2/persistence/interface/storage';
import { SESSION_LOCK_SCOPE, sessionLockKey } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileLock';
import { usageRuntime } from '../src/usage/usageRuntime';
import { FileTokenStorage } from '@kiki/oauth';
import { createKlient } from '@kiki/klient/http';
import { OUTPUT_LAYER_DEFAULT_PRESETS, type OutputLayerEvent, type OutputLayerRequest } from '@kiki/protocol';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

it('executes third-party and Output Layer requests with host identity, credentials, governance and durable usage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-plugin-models-'));
  const records: { body: Record<string, unknown>; headers: IncomingHttpHeaders; path?: string }[] = [];
  const refreshes: URLSearchParams[] = [];
  const disconnections: string[] = [];
  const provider = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/oauth/token') {
        refreshes.push(new URLSearchParams(raw));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          access_token: 'fixture-rotated-access', refresh_token: 'fixture-rotated-refresh', expires_in: 3600, token_type: 'Bearer', scope: '',
        }));
        return;
      }
      if (req.method !== 'POST' || !['/catalog/chat/completions', '/selected/chat/completions'].includes(req.url ?? '')) { res.writeHead(404).end(); return; }
      const body = JSON.parse(raw) as Record<string, unknown>;
      records.push({ body, headers: req.headers, path: req.url });
      if (req.headers.authorization === 'Bearer fixture-old-access') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Expired fixture access' } }));
        return;
      }
      if (body['model'] === 'reject-model') {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Fixture remote error includes fixture-rotated-access' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta: Record<string, unknown>, finish_reason: string | null, usage?: unknown) =>
        res.write(`data: ${JSON.stringify({ id: 'fixture-response', model: body['model'], choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`);
      if (typeof body['model'] === 'string' && body['model'].startsWith('wait-')) {
        const model = body['model'];
        res.once('close', () => disconnections.push(model));
        emit({ content: 'partial' }, null);
        return;
      }
      emit({ content: 'first ' }, null);
      emit({ content: 'second' }, 'stop', { prompt_tokens: 19, completion_tokens: 4, total_tokens: 23 });
      res.end('data: [DONE]\n\n');
    });
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture model address');
  const base = `http://127.0.0.1:${address.port}`;
  const origFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url: string | URL | Request, options?: RequestInit) => {
    const target = new URL(url instanceof Request ? url.url : url);
    if (target.hostname !== '127.0.0.1') throw new Error('Unexpected non-loopback request');
    return origFetch(url, options);
  });
  vi.stubEnv('OPENAI_API_KEY', '');
  let server: RunningServer | undefined;
  let client: ReturnType<typeof createKlient> | undefined;
  try {
    await new FileTokenStorage(join(home, 'credentials')).save('plugin-model-fixture', {
      accessToken: 'fixture-old-access', refreshToken: 'fixture-old-refresh', tokenType: 'Bearer', scope: '', expiresAt: Math.floor(Date.now() / 1000) + 3600, expiresIn: 3600,
    });
    await writeFile(join(home, 'config.toml'), `default_model = "fixture-model"\n[search]\nenabled = false\n[providers.catalog]\ntype = "openai"\nbase_url = "${base}/catalog"\napi_key = "fixture-catalog-key"\n[providers.catalog.request_identity]\npreset = "opencode_compatible"\n[providers.selected]\ntype = "openai"\nbase_url = "${base}/selected"\n[providers.selected.oauth]\nstorage = "file"\nkey = "oauth/plugin-model-fixture"\noauth_host = "${base}"\n[providers.selected.request_identity]\npreset = "opencode_compatible"\n[models.fixture-model]\nprovider = "catalog"\nmodel = "catalog-model"\nmax_context_size = 32768\n`);
    const source = join(home, 'third-party');
    await cp(join(import.meta.dirname, '../../agent-core-v2/test/fixtures/plugin-model-client'), source, { recursive: true });
    await writeFile(join(source, 'settings.html'), '<!doctype html><title>Fixture settings</title>');
    const layer = join(home, 'output-layer');
    await mkdir(layer);
    await writeFile(join(layer, 'settings.html'), '<!doctype html><title>Fixture reading settings</title>');
    await writeFile(join(layer, 'entry.mjs'), 'export function register() {}\nexport function handlePanelRequest() { return { enabled: true, presets: [], settings: {} }; }');
    await writeFile(join(layer, 'kimi.plugin.json'), JSON.stringify({ name: 'kiki-output-layer', version: '1.0.0', 'x-kiki': {
      engines: { kiki: '^0.4.0' }, entry: './entry.mjs', permissions: { uiPanel: true },
      panels: [{ schemaVersion: 1, id: 'settings', slot: 'settings', label: 'Settings', path: './settings.html' }],
    } }));
    server = await startServer({ homeDir: home, port: 0, hostIdentity: TEST_HOST_IDENTITY, logLevel: 'silent' });
    client = createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken });
    const rest = client.rest!;
    const plugins = server.core.accessor.get(IPluginService);
    for (const path of [source, layer]) {
      const plan = await plugins.previewPlugin({ source: path });
      await plugins.installPlugin({ source: path, fingerprint: plan.fingerprint, consent: true, defaultEnabled: true });
    }
    const pluginId = 'fixture-model-client';
    const panel = (action: string, args: unknown = {}) => rest.plugins.panelBridge(pluginId, 'settings', { method: 'plugin.call', action, args });
    await expect(rest.plugins.setSettings(pluginId, { values: { credential: 'fixture-plugin-secret', model: 'fixture-model', connection: 'selected' } })).resolves.toMatchObject({
      values: { model: 'fixture-model', connection: 'selected' }, secretsConfigured: ['credential'],
    });
    const catalog = await rest.plugins.models();
    expect(catalog.connections).toContainEqual(expect.objectContaining({ id: 'selected', service: 'chat', authentication: 'oauth', status: 'connected' }));
    expect(await rest.plugins.panelBridge(pluginId, 'settings', { method: 'plugin.models.list' })).toEqual({ result: catalog });
    expect(await panel('status')).toMatchObject({ result: { catalog, credential: { configured: true, reference: { kind: 'plugin-setting', setting: 'credential' } } } });
    expect(JSON.stringify([catalog, await panel('status'), await rest.plugins.settings(pluginId)])).not.toMatch(/fixture-(catalog-key|old-access|plugin-secret)/);
    expect(await readFile(join(home, 'config.toml'), 'utf8')).not.toContain('fixture-plugin-secret');
    expect(await readFile(join(home, 'credentials', 'credentials.toml'), 'utf8')).toContain('fixture-plugin-secret');
    await expect(panel('credential', { value: 'fixture-plugin-replacement' })).resolves.toMatchObject({ result: { configured: true } });
    expect(await readFile(join(home, 'credentials', 'credentials.toml'), 'utf8')).toContain('fixture-plugin-replacement');
    await expect(panel('credential', { value: null })).resolves.toMatchObject({ result: { configured: false } });
    expect((await rest.plugins.settings(pluginId)).secretsConfigured).toEqual([]);

    const session = await server.core.accessor.get(ISessionManager).create({ workDir: home, mainAgentBinding: { profile: 'agent', model: 'fixture-model' } });
    const agent = await ensureMainAgent(session);
    const registry = agent.accessor.get(IAgentToolRegistryService);
    await registry.prepare();
    const tool = registry.resolve('plugin__fixture_model_client__ModelCall');
    if (tool === undefined) throw new Error('Third-party model tool was not registered');
    const invoke = async (args: unknown, options?: { signal?: AbortSignal; onDelta?: () => void }) => {
      const execution = await tool.resolveExecution(args);
      if (!('execute' in execution)) throw new Error(JSON.stringify(execution.output));
      const result = await execution.execute({ signal: options?.signal ?? AbortSignal.timeout(10_000), toolCallId: crypto.randomUUID(), turnId: 1, onUpdate: (update) => {
        if (update.text === 'fixture model delta') options?.onDelta?.();
      } });
      return JSON.parse(result.output as string);
    };
    expect(await invoke({ action: 'catalog' })).toMatchObject({ pid: expect.any(Number), catalog });
    expect((await invoke({ action: 'catalog' })).pid).not.toBe(process.pid);
    const request = { messages: [{ role: 'user', text: 'Synthetic model input' }] };
    const catalogResult = await invoke({ request: { ...request, target: { modelId: 'fixture-model' } } });
    expect(catalogResult.events).toEqual([
      { type: 'started', modelId: 'fixture-model', connectionId: 'catalog', modelName: 'catalog-model' },
      { type: 'delta', text: 'first ' }, { type: 'delta', text: 'second' },
      { type: 'usage', usage: { inputOther: 19, output: 4, inputCacheRead: 0, inputCacheCreation: 0 } },
      { type: 'completed', text: 'first second', finishReason: 'completed' },
    ]);
    const requestConnection = (modelName: string) => ({ ...request, target: { connectionId: 'selected', modelName }, maxOutputTokens: 120 });
    const selected = await invoke({ request: requestConnection('direct-model') });
    expect(selected.events.some((event: { type: string }) => event.type === 'reset')).toBe(true);
    expect(selected.events.at(-1)).toMatchObject({ type: 'completed', text: 'first second' });
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.get('refresh_token')).toBe('fixture-old-refresh');
    expect(records.map((row) => [row.path, row.body['model'], row.headers.authorization])).toEqual([
      ['/catalog/chat/completions', 'catalog-model', 'Bearer fixture-catalog-key'],
      ['/selected/chat/completions', 'direct-model', 'Bearer fixture-old-access'],
      ['/selected/chat/completions', 'direct-model', 'Bearer fixture-rotated-access'],
    ]);
    const identity = records[0]!.headers['x-opencode-session'];
    expect(identity).toMatch(/^[0-9a-f-]{36}$/);
    expect(records.map((row) => row.headers['x-opencode-session'])).toEqual([identity, identity, identity]);
    expect(records[0]!.headers['x-opencode-request']).not.toBe(records[1]!.headers['x-opencode-request']);
    expect(records[1]!.headers['x-opencode-request']).toBe(records[2]!.headers['x-opencode-request']);
    expect(records[2]!.body['max_tokens']).toBe(120);

    const governance = server.core.accessor.get(IRequestGovernance);
    let activeDimensions: ReturnType<typeof governance.snapshot>['dimensions'] | undefined;
    const cancelled = await invoke({ request: requestConnection('wait-local'), cancel: true }, { onDelta: () => {
      activeDimensions = governance.snapshot().dimensions;
    } });
    expect(activeDimensions).toContainEqual(expect.objectContaining({ dimension: 'session', id: session.id, active: 1 }));
    expect(cancelled).toMatchObject({ error: { code: 'request.cancelled' }, events: [expect.objectContaining({ type: 'started' }), { type: 'delta', text: 'partial' }] });
    expect((await invoke({ request: requestConnection('wait-break'), stop: true })).events).toHaveLength(2);
    const toolAbort = new AbortController();
    await expect(invoke({ request: requestConnection('wait-owner') }, { signal: toolAbort.signal, onDelta: () => toolAbort.abort() })).rejects.toThrow('Plugin tool cancelled');
    await vi.waitFor(() => expect(disconnections).toEqual(['wait-local', 'wait-break', 'wait-owner']));
    expect(governance.snapshot().active).toBe(0);
    const rejected = await invoke({ request: requestConnection('reject-model') });
    expect(rejected.error).toMatchObject({ code: 'provider.api_error' });
    expect(JSON.stringify(rejected)).not.toContain('fixture-rotated-access');
    const beforeBlank = records.length;
    expect((await invoke({ request: { ...request, target: { modelId: ' ' } } })).error).toBeDefined();
    expect(records).toHaveLength(beforeBlank);

    const outputInput: OutputLayerRequest = { sessionId: session.id, sourceId: 'visible-block', sourceRevision: '1', text: 'Visible Assistant text',
      preset: { ...OUTPUT_LAYER_DEFAULT_PRESETS[0]! }, history: [], historyTokens: 16384, cycleId: 'read-cycle' };
    const output = async (preset: OutputLayerRequest['preset'], sessionId = session.id) => {
      const events: OutputLayerEvent[] = [];
      await rest.outputLayer.stream({ ...outputInput, sessionId, preset }, (event) => events.push(event));
      return events;
    };
    const manager = server.core.accessor.get(ISessionManager);
    const storage = server.core.accessor.get(IFileSystemStorageService);
    const sessionContext = session.accessor.get(ISessionContext);
    const accounting = usageRuntime(server.core).service;
    const workspaceId = sessionContext.workspaceId;
    const wireScope = sessionContext.scope('agents/main');
    const completeAccounting = (sessionId: string) => vi.waitFor(async () => {
      const snapshot = await accounting.readSessionAccounting(workspaceId, sessionId);
      expect(snapshot).toMatchObject({ complete: true, freshness: 'current' });
      return snapshot;
    }, { timeout: 5000 });
    await agent.accessor.get(IEventDispatcher).flush();
    const liveWire = await storage.read(wireScope, 'wire.jsonl');
    const beforeLiveReading = await completeAccounting(session.id);
    expect((await output(outputInput.preset)).at(-1)).toMatchObject({ type: 'failed' });
    expect(records).toHaveLength(beforeBlank);
    expect((await output({ ...outputInput.preset, modelId: 'fixture-model' })).at(-1)).toMatchObject({ type: 'completed', text: 'first second' });
    expect(records.at(-1)!.headers['x-opencode-session']).toBe(identity);
    expect(records.at(-1)!.body).not.toHaveProperty('max_tokens');
    expect((await output({ ...outputInput.preset, modelId: 'fixture-model', connectionId: 'selected', customModelId: 'read-model', maxOutputTokens: 256 })).at(-1)).toMatchObject({ type: 'completed' });
    expect(records.at(-1)!.body).toMatchObject({ model: 'read-model', max_tokens: 256 });

    await agent.accessor.get(IEventDispatcher).flush();
    const usages = [];
    for await (const entry of agent.accessor.get(IWireService).readJournal()) if (entry.type === 'usage.record' && entry['usageKnown'] === true) usages.push(entry);
    expect(usages).toEqual([
      expect.objectContaining({ agentId: 'main', model: 'catalog-model', modelAlias: 'fixture-model', provider: 'catalog', requestKind: 'plugin:fixture-model-client', usage: expect.objectContaining({ inputOther: 19, output: 4 }) }),
      expect.objectContaining({ agentId: 'main', model: 'direct-model', provider: 'selected', requestKind: 'plugin:fixture-model-client' }),
    ]);
    expect(await storage.read(wireScope, 'wire.jsonl')).toEqual(liveWire);
    expect(await completeAccounting(session.id)).toMatchObject({ complete: true, tokens: { input_other: beforeLiveReading.tokens.input_other + 38, output: beforeLiveReading.tokens.output + 8 } });

    expect(await client.session(session.id).agent('main').prompt({ input: [{ type: 'text', text: 'Create a saved Assistant body.' }] }, { waitFor: 'terminal' })).toMatchObject({ state: 'completed' });
    const recovered = vi.spyOn(SessionSubagentService.prototype, 'recoverReceipts');
    const created: string[] = [];
    const creation = manager.onWillCreateSession?.((event) => { created.push(event.sessionId); });
    const probes: unknown[] = [];
    const probe = async (kind: string, sessionId: string) => {
      const restores = created.length;
      const receipts = recovered.mock.calls.length;
      const requests = records.length;
      const events = await output({ ...outputInput.preset, modelId: 'fixture-model' }, sessionId);
      probes.push({ kind, terminal: events.at(-1), materialized: created.length - restores, recovered: recovered.mock.calls.length - receipts,
        requests: records.length - requests, live: manager.get(sessionId) !== undefined });
    };
    try {
      await manager.close(session.id);
      const originalWire = await storage.read(wireScope, 'wire.jsonl');
      const originalReceipt = await storage.read(wireScope, 'wire.transcript-receipt.json');
      const beforeCold = await completeAccounting(session.id);
      const blank = await output(outputInput.preset);
      expect(blank.at(-1)).toMatchObject({ type: 'failed' });
      expect(manager.get(session.id)).toBeUndefined();
      const writer = await storage.acquireLock(SESSION_LOCK_SCOPE, sessionLockKey(sessionContext.scope()), { owner: { kind: 'fixture-other-execution-owner' } });
      try { await probe('ordinary-cold-with-body', session.id); }
      finally { await writer.release(); }
      expect(records.at(-1)!.headers['x-opencode-session']).toBe(identity);
      expect(records.at(-1)!.body).not.toHaveProperty('max_tokens');
      await manager.archive(session.id);
      await probe('archived-with-body', session.id);
      expect(await storage.read(wireScope, 'wire.jsonl')).toEqual(originalWire);
      expect(await storage.read(wireScope, 'wire.transcript-receipt.json')).toEqual(originalReceipt);
      expect(await completeAccounting(session.id)).toMatchObject({ complete: true, tokens: { input_other: beforeCold.tokens.input_other + 38, output: beforeCold.tokens.output + 8 } });
      const external = await manager.create({ workDir: home });
      const externalAgent = await ensureMainAgent(external);
      const source = { connectionId: 'fixture-external', clientName: 'Fixture external client', sessionRef: 'fixture-history', driver: 'external' as const };
      await external.accessor.get(ISessionMetadata).update({ custom: { externalClient: source } });
      await externalAgent.accessor.get(IEventDispatcher).dispatchDurably(new ExternalText({ recordId: 'external-visible', turnId: 1, text: 'Visible external Assistant body', kind: 'assistant_excerpt', source }));
      await manager.close(external.id);
      await probe('external-visible-cold', external.id);
      const withoutMain = await manager.create({ workDir: home });
      await probe('live-without-main', withoutMain.id);
      expect(withoutMain.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
      const unknown = await output({ ...outputInput.preset, connectionId: 'selected', customModelId: 'reject-model' }, withoutMain.id);
      expect(unknown.at(-1)).toMatchObject({ type: 'failed', code: 'provider.api_error' });
      expect(await completeAccounting(withoutMain.id)).toMatchObject({ complete: true, tokens: { input_other: 19, output: 4 }, tokens_unknown: true });
      expect(probes).toEqual([
        expect.objectContaining({ kind: 'ordinary-cold-with-body', materialized: 0, recovered: 0, live: false, terminal: { type: 'completed', text: 'first second' } }),
        expect.objectContaining({ kind: 'archived-with-body', materialized: 0, recovered: 0, live: false, terminal: { type: 'completed', text: 'first second' } }),
        expect.objectContaining({ kind: 'external-visible-cold', materialized: 0, recovered: 0, live: false, terminal: { type: 'completed', text: 'first second' } }),
        expect.objectContaining({ kind: 'live-without-main', materialized: 0, recovered: 0, live: true, terminal: { type: 'completed', text: 'first second' } }),
      ]);
      expect(probes.every((row) => (row as { requests: number }).requests === 1)).toBe(true);
      const exportedOperations: { key: string; workspaceId: string; known?: boolean }[] = [];
      expect(await accounting.readExportSources(async (source) => {
        if (source.key.startsWith('operation\0')) for (const record of source.records) exportedOperations.push({ key: source.key, workspaceId: source.workspaceId, known: record.usageKnown });
      })).toMatchObject({ complete: true });
      expect(new Set(exportedOperations.map((row) => row.key)).size).toBe(7);
      expect(exportedOperations.filter((row) => row.known === true)).toHaveLength(6);
      expect(exportedOperations.filter((row) => row.known === false)).toHaveLength(1);
      expect(exportedOperations.every((row) => row.workspaceId === workspaceId)).toBe(true);
      await client.close();
      client = undefined;
      await server.close();
      server = undefined;
      server = await startServer({ homeDir: home, port: 0, hostIdentity: TEST_HOST_IDENTITY, logLevel: 'silent' });
      client = createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken });
      const history = () => client!.rest!.usage({ range: 'all', dimension: 'agent', granularity: 'session', include_archived: 'true', 'agent.id': 'main', 'workspace.id': workspaceId });
      await vi.waitFor(async () => {
        const usage = await history();
        expect(usage.reliability.complete).toBe(true);
        expect(usage.sessions.items).toContainEqual(expect.objectContaining({ id: withoutMain.id, workspace_id: workspaceId, usage: expect.objectContaining({ tokens: { input_other: 19, output: 4, input_cache_read: 0, input_cache_creation: 0 }, tokens_unknown: true }) }));
        expect(usage.sessions.items).toContainEqual(expect.objectContaining({ id: session.id, archived: true, usage: expect.objectContaining({ tokens: expect.objectContaining({ input_other: beforeCold.tokens.input_other + 38, output: beforeCold.tokens.output + 8 }) }) }));
      }, { timeout: 7000 });
      expect(server.core.accessor.get(ISessionManager).list()).toHaveLength(0);
    } finally { creation?.dispose(); recovered.mockRestore(); }
  } finally {
    await client?.close();
    await server?.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close((error) => error === undefined ? resolve() : reject(error)));
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 60_000);
