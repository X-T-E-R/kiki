import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IAgentExecutionService, IAgentLifecycleService, IAgentTaskService, IAppendLogStore, IEventDispatcher, IFileService, IFileSystemStorageService,
  IHomeRuntimeService, IMcpOAuthService, IPluginHostService, ISessionIndex, ISessionIndexMirror, ISessionManager,
  IThreadCommunicationService, IThreadMailboxStore, IWorktreeService, getLiveSessionById,
  type ServiceIdentifier,
} from '@kiki/agent-core-v2';
import { InstantiationService } from '@kiki/agent-core-v2/_base/di/instantiationService';
import { CompactionCancelled, CompactionCompleted, CompactionStarted } from '@kiki/agent-core-v2/agent/fullCompaction/compactionOps';
import { IGlobalSearchService } from '../src/search/searchService';
import { SqliteSearchHost } from '../src/search/sqlite/host';
import { SessionController } from '../../session-core/src/session/sessionController';
import { applyTranscriptShell, projectAgentTranscriptView } from '../../session-core/src/session/transcript/project';
import { KikiClient } from '../../../apps/kiki-gui/src/lib/client';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { paddedPng } from './helpers/png';

interface ModelRequest {
  model: string;
  messages: { role: string; content: unknown }[];
}

interface ClosePhase {
  phase: string;
  state: 'pending' | 'done' | 'failed';
  elapsedMs: number;
  error?: string;
}

function closePhaseText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' || typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') return `${error}`;
  try {
    const text = JSON.stringify(error);
    return typeof text === 'string' ? text : 'close failed';
  } catch {
    return 'close failed';
  }
}

class ClosePhaseWatch {
  private readonly entries: Array<ClosePhase & { started: number; ended?: number }> = [];
  private readonly stack: Array<{ phase: string }> = [];
  private readonly restores: Array<() => void> = [];

  track<T>(phase: string, run: () => T): T {
    const started = Date.now();
    const token = { phase };
    const entry: (typeof this.entries)[number] = { phase, state: 'pending', elapsedMs: 0, started };
    this.entries.push(entry);
    this.stack.push(token);
    const finish = (state: 'done' | 'failed', error?: unknown): void => {
      entry.state = state;
      entry.ended = Date.now();
      entry.elapsedMs = entry.ended - started;
      if (error !== undefined) entry.error = closePhaseText(error).slice(0, 180);
      const index = this.stack.lastIndexOf(token);
      if (index >= 0) this.stack.splice(index, 1);
    };
    try {
      const result = run();
      const settled: unknown = result;
      if (settled instanceof Promise || (settled !== null && typeof settled === 'object' &&
        typeof (settled as { then?: unknown }).then === 'function')) {
        const thenable = settled as Promise<unknown>;
        return thenable.then(
          (value: unknown) => { finish('done'); return value; },
          (error: unknown) => { finish('failed', error); throw error; },
        ) as T;
      }
      finish('done');
      return result;
    } catch (error) {
      finish('failed', error);
      throw error;
    }
  }

  watch(target: object, method: string, phase: string): void {
    const record = target as Record<string, unknown>;
    const original = record[method];
    if (typeof original !== 'function') return;
    const own = Object.prototype.hasOwnProperty.call(target, method);
    const descriptor = own ? Object.getOwnPropertyDescriptor(target, method) : undefined;
    const track = (run: () => unknown) => this.track(phase, run);
    const wrapped = function (this: unknown, ...args: unknown[]) {
      return track(() => original.apply(this, args));
    };
    try { record[method] = wrapped; } catch { return; }
    this.restores.push(() => {
      if (!own) { delete record[method]; return; }
      if (descriptor) Object.defineProperty(target, method, descriptor);
      else record[method] = original;
    });
  }

  snapshot(): { pending: string | null; after: string | null; phases: ClosePhase[] } {
    const now = Date.now();
    const phases = this.entries.map((entry) => {
      const phase: ClosePhase = {
        phase: entry.phase,
        state: entry.state,
        elapsedMs: (entry.ended ?? now) - entry.started,
      };
      if (entry.error !== undefined) phase.error = entry.error;
      return phase;
    });
    const pending = this.stack.at(-1)?.phase ?? null;
    const after = pending === null ? phases.at(-1)?.phase ?? 'before:app.close' : null;
    return { pending, after, phases };
  }

  undo(restore: () => void): void {
    this.restores.push(restore);
  }

  restore(): void {
    for (const restore of this.restores.splice(0).toReversed()) restore();
  }
}

interface CloseWatchTarget {
  app: object;
  core: {
    dispose(): unknown;
    accessor: { get<T>(id: ServiceIdentifier<T>): T };
    instantiation: object;
  };
}

function alreadyMaterialized<T>(host: CloseWatchTarget, id: ServiceIdentifier<T>): T | undefined {
  const container = host.core.instantiation;
  if (!(container instanceof InstantiationService)) return undefined;
  return container.fiberHost.materializedInstance(id);
}

function watchHostClose(host: CloseWatchTarget): ClosePhaseWatch {
  const watch = new ClosePhaseWatch();
  const armed = new Set<object>();
  const arm = (instance: object, method: string, phase: string): void => {
    if (armed.has(instance)) return;
    const current = (instance as Record<string, unknown>)[method];
    if (typeof current !== 'function') return;
    armed.add(instance);
    watch.watch(instance, method, phase);
  };
  const specs: Array<{ id: object; method: string; phase: string }> = [];
  const trackService = <T>(id: ServiceIdentifier<T>, method: string, phase: string): void => {
    specs.push({ id, method, phase });
    const existing = alreadyMaterialized(host, id);
    if (existing !== null && typeof existing === 'object') arm(existing, method, phase);
  };
  try {
    trackService(IThreadCommunicationService, 'shutdown', 'threadComm.shutdown');
    trackService(ISessionManager, 'close', 'session.close');
    trackService(IWorktreeService, 'remove', 'worktree.remove');
    trackService(IThreadMailboxStore, 'close', 'mailbox.close');
    trackService(IHomeRuntimeService, 'close', 'homeRuntime.close');
    trackService(ISessionIndexMirror, 'drain', 'sessionIndexMirror.drain');
    trackService(IMcpOAuthService, 'shutdown', 'mcpOAuth.shutdown');
    trackService(IPluginHostService, 'stopAll', 'pluginHost.stopAll');
    trackService(IAppendLogStore, 'drainRetirements', 'appendLog.drainRetirements');
    trackService(IGlobalSearchService, 'dispose', 'globalSearch.dispose');
    const accessor = host.core.accessor;
    const originalGet = accessor.get;
    const wrappedGet = function <T>(id: ServiceIdentifier<T>): T {
      const instance = originalGet(id);
      const spec = specs.find((item) => item.id === id);
      if (spec && instance !== null && typeof instance === 'object') arm(instance, spec.method, spec.phase);
      return instance;
    };
    accessor.get = wrappedGet;
    watch.undo(() => { accessor.get = originalGet; });
    watch.watch(host.app, 'close', 'app.close');
    watch.watch(host.core, 'dispose', 'core.dispose');
    watch.watch(SqliteSearchHost.prototype, 'close', 'sqliteHost.close');
    return watch;
  } catch (error) {
    watch.restore();
    if (error instanceof Error) throw error;
    throw new Error(closePhaseText(error), { cause: error });
  }
}

async function awaitNaturalClose(input: {
  close: () => Promise<unknown>;
  install: () => ClosePhaseWatch;
  restoreSpy: () => void;
  onTimeout: () => void;
  detail: (phases: ClosePhaseWatch) => unknown;
}): Promise<void> {
  let phases: ClosePhaseWatch | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let closing: Promise<boolean> | undefined;
  try {
    const installed = input.install();
    phases = installed;
    let closeError: unknown;
    closing = new Promise<boolean>((resolve) => {
      try {
        void Promise.resolve(input.close()).then(
          () => { resolve(true); },
          (error: unknown) => { closeError = error; resolve(false); },
        );
      } catch (error) {
        closeError = error;
        resolve(false);
      }
    });
    const naturallyClosed = await Promise.race([
      closing,
      new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false); }, 2000); }),
    ]);
    if (closeError instanceof Error) throw closeError;
    if (closeError !== undefined) throw new Error('close failed', { cause: closeError });
    if (!naturallyClosed) {
      timedOut = true;
      throw new Error(`Host did not close naturally within 2000ms: ${JSON.stringify(input.detail(installed))}`);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) input.onTimeout();
    try {
      await closing;
    } finally {
      phases?.restore();
      input.restoreSpy();
    }
  }
}

describe('close phase watch', () => {
  it('names the unfinished close phase and still runs the following cleanup', async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
    const steps = {
      marker: 'host',
      shutdown() { seen.push('shutdown'); return Promise.resolve(this.marker); },
      close(arg: string) { seen.push(`close:${arg}`); entered(); return gate.then(() => 'close-result'); },
      dispose() { seen.push('dispose'); return Promise.resolve('disposed'); },
    };
    const originalClose = steps.close;
    const watch = new ClosePhaseWatch();
    watch.watch(steps, 'shutdown', 'threadComm.shutdown');
    watch.watch(steps, 'close', 'mailbox.close');
    watch.watch(steps, 'dispose', 'core.dispose');
    const values: unknown[] = [];
    const running = (async () => {
      values.push(await steps.shutdown());
      values.push(await steps.close('keep'));
      values.push(await steps.dispose());
    })();
    await enteredGate;
    expect(watch.snapshot()).toMatchObject({
      pending: 'mailbox.close',
      after: null,
      phases: [
        { phase: 'threadComm.shutdown', state: 'done' },
        { phase: 'mailbox.close', state: 'pending' },
      ],
    });
    release();
    await running;
    expect(values).toEqual(['host', 'close-result', 'disposed']);
    expect(seen).toEqual(['shutdown', 'close:keep', 'dispose']);
    expect(watch.snapshot().pending).toBeNull();
    expect(watch.snapshot().phases.map((phase) => `${phase.phase}:${phase.state}`)).toEqual([
      'threadComm.shutdown:done', 'mailbox.close:done', 'core.dispose:done',
    ]);
    watch.restore();
    expect(steps.close).toBe(originalClose);

    const broken = { close: () => Promise.reject(new Error('close failed')) };
    const failure = new ClosePhaseWatch();
    failure.watch(broken, 'close', 'mailbox.close');
    await expect(broken.close()).rejects.toThrow('close failed');
    expect(failure.snapshot().phases[0]).toMatchObject({ phase: 'mailbox.close', state: 'failed', error: 'close failed' });
    failure.restore();
  });

  it('restores prototype wrappers when close rejects', async () => {
    const originals = {
      sqlite: SqliteSearchHost.prototype.close,
    };
    let gets = 0;
    const get = <T,>(_id: ServiceIdentifier<T>): T => {
      gets += 1;
      throw new Error('accessor.get');
    };
    const server = { close() {}, closeAllConnections: vi.fn() };
    const originalServerClose = server.close;
    const spy = vi.spyOn(server, 'close');
    let wrappedDuringClose = false;
    const host: CloseWatchTarget = {
      app: { close() { return undefined; }, server },
      core: { dispose() { return undefined; }, accessor: { get }, instantiation: {} },
    };
    try {
      await expect(awaitNaturalClose({
        close: () => {
          wrappedDuringClose = SqliteSearchHost.prototype.close !== originals.sqlite;
          return Promise.reject(new Error('close failed'));
        },
        install: () => watchHostClose(host),
        restoreSpy: () => { spy.mockRestore(); },
        onTimeout: () => server.closeAllConnections(),
        detail: () => ({}),
      })).rejects.toThrow('close failed');
      expect(wrappedDuringClose).toBe(true);
      expect(gets).toBe(0);
      expect(SqliteSearchHost.prototype.close).toBe(originals.sqlite);
      expect(server.close).toBe(originalServerClose);
      expect(server.closeAllConnections).not.toHaveBeenCalled();
    } finally {
      if (SqliteSearchHost.prototype.close !== originals.sqlite) SqliteSearchHost.prototype.close = originals.sqlite;
      if (server.close !== originalServerClose) spy.mockRestore();
    }
  });
});

describe('GUI shared client against an isolated KAP host', () => {
  let host: RunningServer;
  let client: KikiClient;
  let home: string;
  let endpoint: string;
  let hold = false;
  const held = new Set<ServerResponse>();
  const requests: ModelRequest[] = [];
  const responseFacts: (() => unknown)[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelRequest);
      if (hold) {
        held.add(response);
        response.once('close', () => held.delete(response));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({
        id: 'local-response',
        choices: [{ index: 0, delta: { content: 'local model completed' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
      })}\n\ndata: [DONE]\n\n`);
    })();
  });

  beforeEach(async () => {
    requests.length = 0;
    hold = false;
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('missing provider address');
    home = await mkdtemp(join(tmpdir(), 'kiki-client-flow-'));
    await mkdir(join(home, 'workspace'));
    await writeFile(join(home, 'config.toml'), [
      'default_model = "unavailable"',
      '[providers.local]', 'type = "openai"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`, 'api_key = "test-only"',
      '[providers."managed:kimi-code"]', 'type = "kimi"',
      '[providers."managed:kimi-code".oauth]', 'storage = "file"', 'key = "oauth/kimi-code"',
      '[models.unavailable]', 'provider = "managed:kimi-code"', 'model = "unavailable"', 'max_context_size = 100000',
      ...['first', 'second'].flatMap((model) => [
        `[models.${model}]`, 'provider = "local"', `model = "${model}"`,
        'max_context_size = 100000', 'capabilities = ["image_in", "thinking"]',
        'support_efforts = ["low", "high"]', 'default_effort = "high"',
      ]),
      '',
    ].join('\n'));
    host = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, instancesDir: join(home, 'instances'), host: '127.0.0.1', port: 0, logLevel: 'silent' });
    responseFacts.length = 0;
    host.app.server.on('request', (request, response) => {
      const socket = request.socket;
      responseFacts.push(() => ({
        url: request.url, method: request.method, complete: request.complete,
        ended: response.writableEnded, finished: response.writableFinished,
        responseDestroyed: response.destroyed, socketDestroyed: socket.destroyed,
        localPort: socket.localPort, remotePort: socket.remotePort,
      }));
    });
    endpoint = `http://127.0.0.1:${host.port}`;
    client = new KikiClient({ baseUrl: endpoint, token: host.localOwnerToken });
  });

  afterEach(async () => {
    await client?.klient.close();
    for (const response of held) response.destroy();
    held.clear();
    provider.closeAllConnections();
    const initialResponses = responseFacts.map((read) => read());
    const serverClose = vi.spyOn(host.app.server, 'close');
    try {
      await awaitNaturalClose({
        close: () => host.close(),
        install: () => watchHostClose(host),
        restoreSpy: () => { serverClose.mockRestore(); },
        onTimeout: () => { host.app.server.closeAllConnections(); },
        detail: (phases) => ({
          initialResponses, serverCloseCalled: serverClose.mock.calls.length,
          responses: responseFacts.map((read) => read()), ...phases.snapshot(),
        }),
      });
    } finally {
      await new Promise<void>((resolve, reject) => provider.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
      if (home) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  async function session(): Promise<string> {
    return (await client.createSession({
      metadata: { cwd: join(home, 'workspace') },
      agent_config: { permission_mode: 'manual' },
    })).id;
  }

  async function settled(id: string, count: number): Promise<void> {
    await vi.waitFor(() => expect(requests).toHaveLength(count), { timeout: 10000 });
    await vi.waitFor(async () => expect(await client.klient.session(id).status()).toBe('idle'), { timeout: 10000 });
  }

  it.each(['auto-compact', 'context-strategy', 'ssh-hosts', 'model-switches', 'mcp-capabilities'] as const)('keeps main absent after empty session %s reads', async (read) => {
    if (read === 'mcp-capabilities') {
      await client.klient.global.mcp.add({ server: { name: 'disabled-example', transport: 'stdio', command: 'must-not-start', enabled: false } });
    }
    const id = (await client.createSession({ metadata: { cwd: join(home, 'workspace') } })).id;
    const lifecycle = getLiveSessionById(host.core.accessor, id)!.accessor.get(IAgentLifecycleService);
    const view = client.sessionView(id);
    let ready = false;
    const subscription = view.bootstrap!({ transcriptGrades: { main: 'delta' } }, signal => { if (signal.type === 'ready') ready = true; });
    try {
      await vi.waitFor(() => expect(ready).toBe(true), { timeout: 10000 });
      expect(lifecycle.get('main')).toBeUndefined();
      const agent = client.klient.session(id).agent('main');
      if (read === 'auto-compact') await expect(client.getAutoCompact(id, 'main')).rejects.toThrow('Model not set');
      if (read === 'context-strategy') {
        expect(await client.getContextStrategy(id, 'main')).toEqual({ strategy: 'auto', source: 'default', shadow: false });
        await client.patchConfig({ loop_control: { context_strategy: 'fresh', relay_shadow: true } });
        expect(await client.getContextStrategy(id, 'main')).toEqual({ strategy: 'fresh', source: 'global', shadow: true });
      }
      if (read === 'ssh-hosts') {
        const response = await fetch(`${endpoint}/api/sessions/${id}/ssh/hosts`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
        expect(await response.json()).toMatchObject({ code: 0, data: { hosts: [] } });
      }
      if (read === 'model-switches') expect(await agent.listModelSwitches()).toEqual([]);
      if (read === 'mcp-capabilities') expect(await agent.listMcpSessionCapabilities()).toContainEqual(expect.objectContaining({
        runtimeName: 'disabled-example', locator: { source: 'global', name: 'disabled-example' }, connection: 'disabled', override: 'inherit',
      }));
      expect(lifecycle.get('main')).toBeUndefined();
    } finally { subscription.close(); }
  });

  it('keeps saved cold read-only entry points off the restore path', async () => {
    const id = (await client.createSession({ metadata: { cwd: join(home, 'workspace') } })).id;
    const manager = host.core.accessor.get(ISessionManager);
    if (manager.acquire === undefined) throw new Error('session operation leases are unavailable');
    await manager.close(id);
    expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
    expect(requests).toHaveLength(0);
    const expectedRestoreError = new Error('cold restore attempted');
    const acquire = vi.spyOn(manager, 'acquire').mockRejectedValue(expectedRestoreError);
    const resume = vi.spyOn(manager, 'resume').mockRejectedValue(expectedRestoreError);
    const reads = [
      { name: 'auto-compact', path: `/api/sessions/${id}/agents/main/auto-compact?observe=true` },
      { name: 'context-strategy', path: `/api/sessions/${id}/agents/main/context-strategy?observe=true` },
      { name: 'optional-capabilities', path: `/api/sessions/${id}/optional-capabilities` },
      { name: 'ssh-hosts', path: `/api/sessions/${id}/ssh/hosts` },
      { name: 'hooks', path: `/api/sessions/${id}/agents/main/hooks` },
    ] as const;
    const results: Array<{ name: string; status: number; body: Record<string, unknown> }> = [];
    try {
      for (const read of reads) {
        const response = await fetch(`${endpoint}${read.path}`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
        const text = await response.text();
        let body: Record<string, unknown>;
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
        results.push({ name: read.name, status: response.status, body });
      }
      try {
        const data = await client.klient.session(id).agent('main').listModelSwitches();
        results.push({ name: 'model-switches', status: 200, body: { code: 0, data } });
      } catch (error) {
        const code = error !== null && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code ?? 50001 : 50001;
        results.push({ name: 'model-switches', status: 200, body: { code } });
      }
      expect({
        responses: results.map(({ name, status, body }) => ({ name, status, code: body['code'] })),
        acquireCalls: acquire.mock.calls.length,
        resumeCalls: resume.mock.calls.length,
        live: getLiveSessionById(host.core.accessor, id) !== undefined,
        modelRequests: requests.length,
      }).toEqual({
        responses: [
          { name: 'auto-compact', status: 200, code: 40001 },
          { name: 'context-strategy', status: 200, code: 0 },
          { name: 'optional-capabilities', status: 200, code: 0 },
          { name: 'ssh-hosts', status: 200, code: 0 },
          { name: 'hooks', status: 200, code: 0 },
          { name: 'model-switches', status: 200, code: 0 },
        ],
        acquireCalls: 0,
        resumeCalls: 0,
        live: false,
        modelRequests: 0,
      });
      expect(results[0]?.body).toMatchObject({ msg: 'Model not set' });
      expect(results[1]?.body).toMatchObject({ data: { strategy: 'auto', source: 'default', shadow: false } });
      expect(results[2]?.body).toMatchObject({ data: { rows: expect.any(Array) } });
      expect(results[3]?.body).toMatchObject({ data: { hosts: [] } });
      expect(results[4]?.body).toMatchObject({ data: { binding: expect.any(Object), rules: expect.any(Array), sources: expect.any(Array) } });
      expect(results[5]?.body).toMatchObject({ data: [] });
    } finally {
      acquire.mockRestore();
      resume.mockRestore();
    }
  });

  it('returns fast SESSION_BUSY for observed reads of a cold bound main without restoring it', async () => {
    const id = (await client.createSession({
      metadata: { cwd: join(home, 'workspace') },
      agent_config: { model: 'first' },
    })).id;
    const manager = host.core.accessor.get(ISessionManager);
    if (manager.acquire === undefined) throw new Error('session operation leases are unavailable');
    await manager.close(id);
    expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
    const expectedRestoreError = new Error('cold restore attempted');
    const acquire = vi.spyOn(manager, 'acquire').mockRejectedValue(expectedRestoreError);
    const resume = vi.spyOn(manager, 'resume').mockRejectedValue(expectedRestoreError);
    const wireSize = vi.spyOn(host.core.accessor.get(IFileSystemStorageService), 'size').mockResolvedValue(9 * 1024 * 1024);
    const wireRead = vi.spyOn(host.core.accessor.get(IAppendLogStore), 'read');
    const paths = [
      `/api/sessions/${id}/agents/main/auto-compact?observe=true`,
      `/api/sessions/${id}/agents/main/context-strategy?observe=true`,
      `/api/sessions/${id}/agents/main/hooks?observe=true`,
    ];
    const started = performance.now();
    const results: Array<{ status: number; body: Record<string, unknown> }> = [];
    try {
      for (const path of paths) {
        const response = await fetch(`${endpoint}${path}`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
        results.push({ status: response.status, body: await response.json() as Record<string, unknown> });
      }
      expect(results.map(({ status, body }) => ({ status, code: body['code'] }))).toEqual([
        { status: 200, code: 40901 },
        { status: 200, code: 40901 },
        { status: 200, code: 40901 },
      ]);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(acquire).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(wireSize).toHaveBeenCalled();
      expect(wireRead).not.toHaveBeenCalled();
      expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
      expect(requests).toHaveLength(0);
    } finally {
      acquire.mockRestore();
      resume.mockRestore();
      wireSize.mockRestore();
      wireRead.mockRestore();
    }
  });

  it.each([false, true])('preserves complete model-switch reads and explicit observe=%s over GUI HTTP after >8MiB', async (observe) => {
    const id = (await client.createSession({ metadata: { cwd: join(home, 'workspace') } })).id;
    const manager = host.core.accessor.get(ISessionManager);
    await manager.close(id);
    const summary = await host.core.accessor.get(ISessionIndex).get(id);
    const logs = host.core.accessor.get(IAppendLogStore);
    const scope = `sessions/${summary!.workspaceId}/${id}/agents/main`;
    logs.append(scope, 'wire.jsonl', { type: 'unrelated', payload: 'x'.repeat(9 * 1024 * 1024) });
    logs.append(scope, 'wire.jsonl', { type: 'prompt.model_switch_queued', time: 1, queueIndex: 0,
      entry: { input: { operationId: 'cold-switch', model: 'first', mode: 'direct' }, revision: 0,
        originalBinding: { model: 'second', thinking: '' },
        receipt: { operationId: 'cold-switch', agentId: 'main', state: 'pending', mode: 'direct', fromModel: 'second', toModel: 'first' } } });
    await logs.flush(scope, 'wire.jsonl');
    const acquire = vi.spyOn(manager, 'acquire');
    const resume = vi.spyOn(manager, 'resume');
    try {
      const controller = new AbortController();
      controller.abort(new Error('cancelled GUI queue read'));
      await expect(client.listAgentModelSwitches(id, 'main', controller.signal, observe)).rejects.toThrow('cancelled GUI queue read');
      if (observe) {
        await expect(client.listAgentModelSwitches(id, 'main', undefined, true)).rejects.toMatchObject({
          code: 40001, message: 'model_switch_queue_preparing (code 40001)', details: { reason: 'model_switch_queue_preparing' },
        });
      }
      const queue = observe ? client.listAgentModelSwitches(id, 'main', undefined, true) : client.listAgentModelSwitches(id, 'main');
      await expect(queue).resolves.toMatchObject([{ input: { operationId: 'cold-switch' }, queueIndex: 0 }]);
      expect(acquire).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
      expect(requests).toHaveLength(0);
    } finally { acquire.mockRestore(); resume.mockRestore(); }
  });

  it.each(['compaction.started', 'compaction.completed', 'compaction.cancelled'] as const)('watches absent main %s over WS without creating it and attaches on real creation', async (type) => {
    const id = (await client.createSession({ metadata: { cwd: join(home, 'workspace') } })).id;
    const lifecycle = getLiveSessionById(host.core.accessor, id)!.accessor.get(IAgentLifecycleService);
    const received = vi.fn();
    const removed = vi.fn();
    const events = client.klient.session(id).agent('main').events;
    const active = events.on(type, received);
    const disposed = events.on(type, removed);
    try {
      await Promise.all([active.ready, disposed.ready]);
      expect(lifecycle.get('main')).toBeUndefined();
      disposed.dispose();
      const main = await lifecycle.create({ agentId: 'main' });
      const event = type === 'compaction.started' ? new CompactionStarted({ trigger: 'manual', phase: 'running' })
        : type === 'compaction.cancelled' ? new CompactionCancelled({ trigger: 'manual' })
        : new CompactionCompleted({ trigger: 'manual', result: { summary: '', compactedCount: 0, tokensBefore: 0, tokensAfter: 0 } });
      await main.accessor.get(IEventDispatcher).dispatch(event);
      await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
      expect(received.mock.calls[0]![0]).toMatchObject({ type, trigger: 'manual' });
      expect(removed).not.toHaveBeenCalled();
    } finally { active.dispose(); disposed.dispose(); }
  });

  it('bootstraps a new empty main with verified complete history', async () => {
    const id = (await client.createSession({ metadata: { cwd: join(home, 'workspace') } })).id;
    expect(getLiveSessionById(host.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
    await Promise.all([
      client.getAutoCompact(id, 'main').catch(error => { expect(error.message).toContain('Model not set'); }),
      client.getContextStrategy(id, 'main'),
      client.klient.session(id).agent('main').listMcpSessionCapabilities(),
      client.klient.session(id).agent('main').listModelSwitches(),
    ]);
    expect(getLiveSessionById(host.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
    const view = client.sessionView(id);
    const signals: Parameters<Parameters<typeof view.subscribe>[1]>[0][] = [];
    const subscription = view.bootstrap!({ transcriptGrades: { main: 'delta' } }, signal => signals.push(signal));
    try {
      await vi.waitFor(() => expect(signals.some(signal => signal.type === 'ready')).toBe(true), { timeout: 10000 });
      const resets = signals.filter(signal => signal.type === 'transcript' && signal.event.type === 'transcript.reset');
      expect(resets).toHaveLength(1);
      expect(resets[0]).toMatchObject({ event: {
        coverage: { kind: 'full', hasMoreOlder: false }, read: { readiness: 'ready' },
        snapshot: { items: [], toolCallCount: 0, toolCallCountKnown: true, hasMoreOlder: false },
      } });
      expect(await client.klient.session(id).view.snapshot()).toMatchObject({ session: { message_count: 0 }, messages: { items: [], has_more: false } });
      expect(getLiveSessionById(host.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
    } finally { subscription.close(); }
  });

  it('automatically generates a configured title after the first real reply and exposes it to clients', async () => {
    await client.patchConfig({ session_title: { model: 'second' }, replace_domains: ['session_title'] });
    const id = await session();
    const other = new KikiClient({ baseUrl: endpoint, token: host.localOwnerToken });
    const controllers = [client, other].map((connection) => new SessionController(connection.sessions, connection.sessionView(id), id));
    const updates = [vi.fn(), vi.fn()];
    const subscriptions = [client, other].map((connection, index) => connection.klient.events.on('session.metaUpdated', updates[index]!));
    try {
      await Promise.all(controllers.map((controller) => controller.open()));
      await Promise.all(subscriptions.map((subscription) => subscription.ready));
      await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'Plan a small garden' }] });
      await vi.waitFor(() => {
        for (const controller of controllers) {
          controller.flushFrames();
          expect(controller.getState().session?.title).toBe('local model completed');
        }
      }, { timeout: 10000 });
      expect((await client.klient.session(id).get()).title).toBe('local model completed');
      expect(requests.map((request) => request.model)).toEqual(['first', 'second']);
      expect(JSON.stringify(requests[1]!.messages)).toContain('assistant: local model completed');
      for (const update of updates) expect(update.mock.calls.filter(([event]) => event.patch.title === 'local model completed')).toHaveLength(1);
      await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'Add a pond' }] });
      await settled(id, 3);
      expect(requests.filter((request) => request.model === 'second')).toHaveLength(1);
    } finally {
      for (const controller of controllers) controller.close();
      for (const subscription of subscriptions) subscription.dispose();
      await other.klient.close();
    }
  });

  it('requires an explicit title model and keeps empty moments manual-only with actionable REST failures', async () => {
    await client.patchConfig({ fast_model: 'second' });
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'Keep my garden plan' }] });
    await settled(id, 1);
    async function generate(): Promise<{ code: number; msg: string; data: { title?: string } }> {
      return (await fetch(`${endpoint}/api/sessions/${id}/title/generate`, {
        method: 'POST', headers: { authorization: `Bearer ${host.localOwnerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      })).json();
    }
    expect((await generate()).code).toBe(40923);
    expect(requests).toHaveLength(1);
    await client.patchConfig({ session_title: { model: 'second', triggers: [] }, replace_domains: ['session_title'] });
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'Include a pond' }] });
    await settled(id, 2);
    expect(await generate()).toMatchObject({ code: 0, data: { title: 'local model completed' } });
    expect(requests.map((request) => request.model)).toEqual(['first', 'first', 'second']);
    await client.patchConfig({ session_title: { model: 'missing-title-model', triggers: [] }, replace_domains: ['session_title'] });
    const failed = await generate();
    expect(failed.code).toBe(40923); expect(failed.msg).toContain('missing-title-model');
    expect((await client.klient.session(id).get()).title).toBe('local model completed');
    expect(requests).toHaveLength(3);
  });

  it.each(['EOF', 'remaining bytes'] as const)('waits for media %s then naturally releases its newly idle connection during close', async (waitFor) => {
    const id = await session();
    const bytes = new Uint8Array([65, 66, 67]);
    const uploaded = await client.uploadFile(new File([bytes], 'delayed.bin'));
    const files = host.core.accessor.get(IFileService);
    const stored = await files.get(uploaded.id);
    let releaseEof!: () => void;
    const eof = new Promise<void>((resolve) => { releaseEof = resolve; });
    let released = false;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const read = vi.spyOn(files, 'get').mockResolvedValueOnce({
      ...stored,
      stream: () => Readable.from((async function* () {
        try {
          yield waitFor === 'EOF' ? bytes : bytes.slice(0, 1);
          notifyStarted();
          await eof;
          if (waitFor === 'remaining bytes') yield bytes.slice(1);
        } finally {
          released = true;
        }
      })()),
    });
    let closing: Promise<void> | undefined;
    let naturallyClosed = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const downloading = client.readSessionMediaBytes(id, uploaded.id);
    try {
      await started;
      if (waitFor === 'EOF') expect((await downloading).bytes).toEqual(bytes);
      expect(released).toBe(false);
      closing = host.close().then(() => { naturallyClosed = true; });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(naturallyClosed).toBe(false);
      releaseEof();
      expect((await downloading).bytes).toEqual(bytes);
      await Promise.race([
        closing,
        new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, 2000); }),
      ]);
      expect(released).toBe(true);
      expect(naturallyClosed).toBe(true);
    } finally {
      releaseEof();
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      if (closing !== undefined && !naturallyClosed) host.app.server.closeAllConnections();
      await closing;
      read.mockRestore();
    }
  });

  it('naturally closes immediately after three completed media downloads', async () => {
    const id = await session();
    const bytes = new Uint8Array(600 * 1024).fill(65);
    const uploaded = await Promise.all([0, 1, 2].map((index) => client.uploadFile(new File([bytes], `attachment-${index}.bin`))));
    for (const file of uploaded) {
      const downloaded = await client.readSessionMediaBytes(id, file.id);
      expect(downloaded.bytes).toEqual(bytes);
    }
  });

  it('keeps the composer binding after reopening and restarting a bound session with a credentialless server default', async () => {
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'persist this binding' }] });
    await settled(id, 1);
    await client.klient.close();
    await host.close();
    host = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, instancesDir: join(home, 'instances'), host: '127.0.0.1', port: 0, logLevel: 'silent' });
    endpoint = `http://127.0.0.1:${host.port}`;
    client = new KikiClient({ baseUrl: endpoint, token: host.localOwnerToken });
    for (const reopen of [0, 1]) {
      const actual = client.klient.session(id).view;
      const shell = await actual.snapshot();
      expect(shell.session.agent_config.model).toBe('first');
      let ready = false;
      let projected = applyTranscriptShell(id, shell);
      let resets = 0;
      const subscription = actual.subscribe({ sessionCursor: { seq: shell.as_of_seq, epoch: shell.epoch }, transcriptGrades: { main: 'delta' } }, (signal) => {
        if (signal.type === 'transcript' && signal.event.type === 'transcript.reset' && signal.event.agent_id === 'main') {
          projected = projectAgentTranscriptView(projected, 'main', signal.event.snapshot);
          resets += 1;
        }
        if (signal.type === 'ready') ready = true;
      });
      try {
        await vi.waitFor(() => expect(ready).toBe(true), { timeout: 10000 });
        expect(resets).toBeGreaterThan(0);
        expect(projected.model, `reopen ${reopen}`).toBe('first');
        await client.submitPrompt(id, { content: [{ type: 'text', text: `GUI continuation ${reopen}` }], model: projected.model ?? 'unavailable' });
        await settled(id, reopen + 2);
        expect(requests[reopen + 1]?.model).toBe('first');
      } finally {
        subscription.close();
      }
    }
  }, 40000);

  it.each(['live', 'cold'] as const)('publishes child prompt restarts and terminal states through the %s GUI view', async (mode) => {
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'establish parent' }] });
    await settled(id, 1);
    const live = getLiveSessionById(host.core.accessor, id)!;
    const child = await live.accessor.get(IAgentLifecycleService).create({
      delegator: { kind: 'agent', agentId: 'main' },
      binding: { profile: 'agent', model: 'first' },
    });
    await client.sendAgentMessage(id, child.id, 'initial child prompt', undefined, 'initial-child-prompt');
    await child.accessor.get(IAgentExecutionService).settled();
    if (mode === 'cold') {
      await client.klient.close();
      await host.close();
      host = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, instancesDir: join(home, 'instances'), host: '127.0.0.1', port: 0, logLevel: 'silent' });
      endpoint = `http://127.0.0.1:${host.port}`;
      client = new KikiClient({ baseUrl: endpoint, token: host.localOwnerToken });
      expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
      const response = await fetch(`${endpoint}/api/sessions/${id}/transcript?agent_id=main&transcript_coverage_version=2`, {
        headers: { authorization: `Bearer ${host.localOwnerToken}` },
      });
      const cold = await response.json() as { code: number; data: { tasks: { agentId?: string; state: string }[] } };
      expect(cold.code).toBe(0);
      expect(cold.data.tasks.find((task) => task.agentId === child.id)?.state).toBe('completed');
      expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
    }
    const view = client.sessionView(id);
    let ready = false;
    let liveChildBaselineEpoch: string | undefined;
    const subscribe = view.subscribe.bind(view);
    const bootstrap = view.bootstrap!.bind(view);
    const observe = (callback: Parameters<typeof view.subscribe>[1]) => (signal: Parameters<typeof callback>[0]) => {
      if (signal.type === 'ready') ready = true;
      if (signal.type === 'transcript' && signal.event.type === 'transcript.reset' &&
        signal.event.agent_id === child.id && signal.event.cursor.epoch !== undefined &&
        !signal.event.cursor.epoch.startsWith('cold:')) liveChildBaselineEpoch = signal.event.cursor.epoch;
      callback(signal);
    };
    const subscriptionSpy = vi.spyOn(view, 'subscribe').mockImplementation((options, callback) => subscribe(options, observe(callback)));
    const bootstrapSpy = vi.spyOn(view, 'bootstrap').mockImplementation((options, callback) => bootstrap(options, observe(callback)));
    const controller = new SessionController(client.sessions, view, id);
    const mainChanges = vi.fn();
    const childChanges = vi.fn();
    const offMain = controller.subscribe(mainChanges);
    const offChild = controller.subscribeAgent(child.id, childChanges);
    try {
      await controller.open();
      await vi.waitFor(() => expect(ready).toBe(true), { timeout: 10000 });
      controller.flushFrames();
      await vi.waitFor(() => {
        controller.flushFrames();
        expect(controller.getForest()?.byId[child.id]?.status).toBe('completed');
      });
      if (mode === 'cold') {
        expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
        expect(controller.getAgentTranscriptCursor(child.id)?.epoch).toMatch(/^cold:/);
        expect(controller.getAgentState(child.id).busy).toBe(false);
      }
      for (const ending of ['completed', 'failed', 'cancelled'] as const) {
        hold = true;
        mainChanges.mockClear();
        childChanges.mockClear();
        const beforeRequests = requests.length;
        const beforeEpoch = controller.getAgentTranscriptCursor(child.id)?.epoch;
        await client.sendAgentMessage(id, child.id, `follow-up ${ending}`, undefined, `follow-up-${ending}`);
        await vi.waitFor(() => expect(requests).toHaveLength(beforeRequests + 1), { timeout: 10000 });
        await vi.waitFor(() => {
          controller.flushFrames();
          expect(liveChildBaselineEpoch).toBeDefined();
          expect(controller.getAgentTranscriptCursor(child.id)?.epoch).toBe(liveChildBaselineEpoch);
          expect(controller.getAgentState(child.id).transcriptReady).toBe(true);
          if (beforeEpoch?.startsWith('cold:')) expect(liveChildBaselineEpoch).not.toBe(beforeEpoch);
        }, { timeout: 10000 });
        await vi.waitFor(() => {
          controller.flushFrames();
          expect(controller.getForest()?.byId[child.id]?.status).toBe('background');
          expect(controller.getState().tasks.some((task) => task.agent_id === child.id && task.status === 'running')).toBe(true);
          expect(controller.getAgentState(child.id).busy).toBe(true);
        });
        expect(mainChanges).toHaveBeenCalled();
        expect(childChanges).toHaveBeenCalled();
        if (ending === 'cancelled') {
          const current = getLiveSessionById(host.core.accessor, id)!;
          const tasks = current.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentTaskService);
          const task = tasks.list(true).find((task) => task.kind === 'agent' && task.agentId === child.id)!;
          expect(task.taskId).not.toBe(child.id);
          await client.klient.session(id).agent('main').stopTask({ taskId: task.taskId });
        } else {
          for (const response of held) {
            if (ending === 'failed') {
              response.writeHead(400, { 'content-type': 'application/json' });
              response.end(JSON.stringify({ error: { message: 'Synthetic provider failure', type: 'invalid_request_error' } }));
            } else {
              response.writeHead(200, { 'content-type': 'text/event-stream' });
              response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'follow-up complete' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
            }
          }
          held.clear();
        }
        await vi.waitFor(() => {
          controller.flushFrames();
          expect(controller.getForest()?.byId[child.id]?.status).toBe(ending);
          expect(controller.getAgentState(child.id).busy).toBe(false);
        }, { timeout: 10000 });
      }
      const current = getLiveSessionById(host.core.accessor, id)!;
      const tasks = current.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentTaskService);
      await vi.waitFor(() => {
        const childTasks = tasks.list(false).filter((task) => task.kind === 'agent' && task.agentId === child.id);
        expect(childTasks).toHaveLength(4);
        expect(childTasks.map((task) => task.status).toSorted()).toEqual(['completed', 'completed', 'failed', 'killed']);
      });
      expect(requests).toHaveLength(5);
    } finally {
      offMain();
      offChild();
      subscriptionSpy.mockRestore();
      bootstrapSpy.mockRestore();
      controller.close();
    }
  }, 40000);

  it('sends, switches model, rejects an unauthenticated override without rebinding, and cancels', async () => {
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'first turn' }] });
    await settled(id, 1);
    expect(requests[0]?.model).toBe('first');
    await client.submitPrompt(id, { model: 'second', content: [{ type: 'text', text: 'switch model' }] });
    await settled(id, 2);
    expect(requests[1]?.model).toBe('second');
    await expect(client.submitPrompt(id, { model: 'unavailable', content: [{ type: 'text', text: 'must reject' }] })).rejects.toMatchObject({ code: 40111 });
    await client.submitPrompt(id, { content: [{ type: 'text', text: 'keep the bound model' }] });
    await settled(id, 3);
    expect(requests[2]?.model).toBe('second');
    expect(JSON.stringify(requests[2])).not.toContain('must reject');
    hold = true;
    const pending = await client.submitPrompt(id, { content: [{ type: 'text', text: 'cancel this turn' }] });
    await vi.waitFor(() => expect(requests).toHaveLength(4), { timeout: 10000 });
    await client.abortPrompt(id, pending.prompt_id);
    await vi.waitFor(async () => expect(await client.klient.session(id).status()).toBe('idle'), { timeout: 10000 });
    for (const path of ['/api/v1/healthz', '/api/v2/sessions', '/api/v1/sessions']) {
      const response = await fetch(endpoint + path, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
      expect(response.status, path).toBe(404);
      await response.arrayBuffer();
    }
  }, 40000);

  it('recovers ordered transcript delivery after the actual event socket is severed', async () => {
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'before disconnect' }] });
    await settled(id, 1);
    const sockets = new Set<import('node:stream').Duplex>();
    host.app.server.on('upgrade', (_request, socket) => sockets.add(socket));
    const signals: import('@kiki/klient').SessionViewSignal[] = [];
    const view = client.klient.session(id).view.subscribe({ sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' } }, (signal) => signals.push(signal));
    try {
      await vi.waitFor(() => expect(signals.some((signal) => signal.type === 'ready')).toBe(true), { timeout: 10000 });
      const initialGeneration = signals.find((signal) => signal.type === 'ready')!.generation;
      expect(sockets.size).toBe(1);
      for (const socket of sockets) socket.destroy();
      await vi.waitFor(() => expect(signals.some((signal) => signal.type === 'status' && signal.status === 'closed')).toBe(true));
      await client.submitPrompt(id, { content: [{ type: 'text', text: 'sent while the view reconnects' }] });
      await settled(id, 2);
      await vi.waitFor(() => expect(signals.some((signal) => signal.type === 'ready' && signal.reconnected && signal.generation > initialGeneration)).toBe(true), { timeout: 10000 });
      await vi.waitFor(() => expect(JSON.stringify(signals.filter((signal) => signal.type === 'transcript' && signal.generation > initialGeneration))).toContain('sent while the view reconnects'), { timeout: 10000 });
      expect(signals.filter((signal) => signal.type === 'protocolError')).toEqual([]);
      expect(sockets.size).toBe(2);
    } finally {
      view.close();
      for (const socket of sockets) socket.destroy();
    }
  }, 40000);

  it('accepts three uploaded and three inline images through the GUI adapter and downloads session media', async () => {
    const id = await session();
    const image = paddedPng(600 * 1024, 1);
    const uploaded = await Promise.all([0, 1, 2].map((index) => client.uploadFile(new File([new Uint8Array(image)], `image-${index}.png`, { type: 'image/png' }))));
    const submission = {
      model: 'first',
      content: uploaded.map((file) => ({ type: 'image' as const, source: { kind: 'file' as const, file_id: file.id } })),
    };
    expect(Buffer.byteLength(JSON.stringify(submission))).toBeLessThan(1024);
    await client.submitPrompt(id, submission);
    await settled(id, 1);
    const user = requests[0]?.messages.findLast((message) => message.role === 'user' && JSON.stringify(message.content).includes('data:image/png;base64,'));
    expect(JSON.stringify(user).match(/data:image\/png;base64,/g)).toHaveLength(3);
    for (const file of uploaded) {
      const downloaded = await client.readSessionMediaBytes(id, file.id);
      expect(downloaded.mime, new TextDecoder().decode(downloaded.bytes.slice(0, 200))).toBe('image/png');
      expect(Buffer.from(downloaded.bytes)).toEqual(image);
    }
    const inline = {
      content: [0, 1, 2].map(() => ({
        type: 'image' as const,
        source: { kind: 'base64' as const, media_type: 'image/png', data: image.toString('base64') },
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(inline))).toBeGreaterThan(2 * 1024 * 1024);
    await client.submitPrompt(id, inline);
    await settled(id, 2);
    const inlineUser = requests[1]?.messages.findLast((message) => message.role === 'user' && JSON.stringify(message.content).includes('data:image/png;base64,'));
    expect(JSON.stringify(inlineUser).match(/data:image\/png;base64,/g)).toHaveLength(3);
    expect(requests[1]?.model).toBe('first');
    const failedStorage = vi.spyOn(host.core.accessor.get(IFileService), 'get')
      .mockRejectedValueOnce(new Error('synthetic media storage failure'));
    try {
      await expect(client.readSessionMediaBytes(id, 'missing-file')).rejects.toMatchObject({ code: 50001 });
    } finally {
      failedStorage.mockRestore();
    }
  }, 40000);

  it('rejects a request above the HTTP budget without enqueueing it or changing the selected model', async () => {
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'establish model' }] });
    await settled(id, 1);
    const draft = { model: 'second', content: [{ type: 'text' as const, text: 'x'.repeat(12 * 1024 * 1024) }] };
    await expect(client.submitPrompt(id, draft)).rejects.toMatchObject({ code: 40001, message: expect.stringContaining('size limit') });
    expect(draft.content[0]?.text.length).toBe(12 * 1024 * 1024);
    expect(draft.model).toBe('second');
    await client.submitPrompt(id, { content: [{ type: 'text', text: 'retry with a small draft' }] });
    await settled(id, 2);
    expect(requests[1]?.model).toBe('first');
    expect(JSON.stringify(requests[1]).length).toBeLessThan(1024 * 1024);
  }, 40000);
});
