import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  agentScopeOf, getLiveSessionById, IAgentExecutionService, IAgentLifecycleService, IAgentTaskService,
  IAppendLogStore, IEventDispatcher, IFileService, IFileSystemStorageService, IHomeRuntimeService,
  IMcpOAuthService, IPluginHostService, IRetainedUsageService, ISessionContext, ISessionIndex,
  ISessionIndexMirror, ISessionManager, ISessionMetadata, ITelemetryService, IThreadCommunicationService,
  IThreadMailboxStore, IUsageFactStore, IUsageReadModel, IWorktreeService, type ServiceIdentifier,
} from '@kiki/agent-core-v2';
import { InstantiationService } from '@kiki/agent-core-v2/_base/di/instantiationService';
import { CompactionCancelled, CompactionCompleted, CompactionStarted } from '@kiki/agent-core-v2/agent/fullCompaction/compactionOps';
import { GoalCreate, GoalUpdate } from '@kiki/agent-core-v2/agent/goal/goalOps';
import { AgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycleService';
import { SessionLifecycleService } from '@kiki/agent-core-v2/workspace/sessionLifecycle/sessionLifecycleService';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { KikiClient } from '../../../apps/kiki-gui/src/lib/client';
import { SessionController } from '../../session-core/src/session/sessionController';
import { applyTranscriptShell, projectAgentTranscriptView } from '../../session-core/src/session/transcript/project';
import { ExternalClientHost } from '../src/externalClients/host';
import { NativeExternalClientListenerManager } from '../src/externalClients/listenerManager';
import { IGlobalSearchService } from '../src/search/searchService';
import { SqliteSearchHost } from '../src/search/sqlite/host';
import { ImSessionBridge } from '../src/services/imSession/bridge';
import { NotificationService } from '../src/services/notifications/notificationService';
import { WebAccess } from '../src/services/webAccess';
import { type RunningServer, startServer } from '../src/start';
import { usageRuntime } from '../src/usage/usageRuntime';
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
  startedAfterMs: number;
  error?: string;
}

function closePhaseText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' || typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') return `${error}`;
  try { return JSON.stringify(error) ?? 'close failed'; } catch { return 'close failed'; }
}

class ClosePhaseWatch {
  private readonly started = Date.now();
  private readonly entries: Array<ClosePhase & { started: number; ended?: number }> = [];
  private readonly stack: Array<{ phase: string }> = [];
  private readonly restores: Array<() => void> = [];
  private readonly progress = new Set<() => void>();

  onProgress(listener: () => void): () => void {
    this.progress.add(listener);
    return () => { this.progress.delete(listener); };
  }

  track<T>(phase: string, run: () => T): T {
    const started = Date.now(), token = { phase };
    const entry: (typeof this.entries)[number] = { phase, state: 'pending', elapsedMs: 0, startedAfterMs: started - this.started, started };
    this.entries.push(entry);
    this.stack.push(token);
    for (const listener of this.progress) listener();
    const finish = (state: 'done' | 'failed', error?: unknown): void => {
      entry.state = state;
      entry.ended = Date.now();
      entry.elapsedMs = entry.ended - started;
      if (error !== undefined) entry.error = closePhaseText(error).slice(0, 180);
      const index = this.stack.lastIndexOf(token);
      if (index >= 0) this.stack.splice(index, 1);
      for (const listener of this.progress) listener();
    };
    try {
      const result = run();
      const settled: unknown = result;
      if (settled instanceof Promise || (settled !== null && typeof settled === 'object' && typeof (settled as { then?: unknown }).then === 'function')) {
        return (settled as Promise<unknown>).then(
          (v: unknown) => { finish('done'); return v; },
          (e: unknown) => { finish('failed', e); throw e; },
        ) as T;
      }
      finish('done');
      return result;
    } catch (error) { finish('failed', error); throw error; }
  }

  watch(target: object, method: string, phase: string): void {
    const record = target as Record<string, unknown>, original = record[method];
    if (typeof original !== 'function') return;
    const own = Object.prototype.hasOwnProperty.call(target, method);
    const descriptor = own ? Object.getOwnPropertyDescriptor(target, method) : undefined;
    const track = (run: () => unknown) => this.track(phase, run);
    try { record[method] = function (this: unknown, ...args: unknown[]) { return track(() => original.apply(this, args)); }; } catch { return; }
    this.restores.push(() => {
      if (!own) { delete record[method]; return; }
      if (descriptor) Object.defineProperty(target, method, descriptor); else record[method] = original;
    });
  }

  snapshot(): { elapsedMs: number; pending: string | null; after: string | null; phases: ClosePhase[] } {
    const now = Date.now();
    const phases = this.entries.map((e) => ({
      phase: e.phase, state: e.state, elapsedMs: (e.ended ?? now) - e.started, startedAfterMs: e.startedAfterMs,
      ...(e.error !== undefined ? { error: e.error } : {}),
    }));
    const pending = this.stack.at(-1)?.phase ?? null;
    return { elapsedMs: now - this.started, pending, after: pending === null ? phases.at(-1)?.phase ?? 'before:app.close' : null, phases };
  }

  undo(restore: () => void): void { this.restores.push(restore); }
  restore(): void { for (const restore of this.restores.splice(0).toReversed()) restore(); }
}

interface CloseWatchTarget {
  app: object;
  core: { dispose(): unknown; accessor: { get<T>(id: ServiceIdentifier<T>): T }; instantiation: object };
}

function watchHostClose(host: CloseWatchTarget): ClosePhaseWatch {
  const watch = new ClosePhaseWatch(), armed = new Set<object>();
  const arm = (instance: object, method: string, phase: string): void => {
    if (armed.has(instance) || typeof (instance as Record<string, unknown>)[method] !== 'function') return;
    armed.add(instance);
    watch.watch(instance, method, phase);
  };
  const specs: Array<{ id: object; method: string; phase: string }> = [];
  const trackService = <T>(id: ServiceIdentifier<T>, method: string, phase: string): void => {
    specs.push({ id, method, phase });
    const container = host.core.instantiation;
    const existing = container instanceof InstantiationService ? container.fiberHost.materializedInstance(id) : undefined;
    if (existing !== null && typeof existing === 'object') arm(existing, method, phase);
  };
  try {
    for (const [id, method, phase] of [
      [IThreadCommunicationService, 'shutdown', 'threadComm.shutdown'], [ISessionManager, 'close', 'session.close'],
      [IWorktreeService, 'remove', 'worktree.remove'], [IThreadMailboxStore, 'close', 'mailbox.close'],
      [IHomeRuntimeService, 'close', 'homeRuntime.close'], [ISessionIndexMirror, 'drain', 'sessionIndexMirror.drain'],
      [IMcpOAuthService, 'shutdown', 'mcpOAuth.shutdown'], [IPluginHostService, 'stopAll', 'pluginHost.stopAll'],
      [IAppendLogStore, 'drainRetirements', 'appendLog.drainRetirements'], [IGlobalSearchService, 'dispose', 'globalSearch.dispose'],
    ] as const) trackService(id as ServiceIdentifier<unknown>, method, phase);
    const accessor = host.core.accessor, originalGet = accessor.get;
    accessor.get = function <T>(id: ServiceIdentifier<T>): T {
      const instance = originalGet(id);
      const spec = specs.find((item) => item.id === id);
      if (spec && instance !== null && typeof instance === 'object') arm(instance, spec.method, spec.phase);
      return instance;
    };
    watch.undo(() => { accessor.get = originalGet; });
    for (const [target, method, phase] of [
      [host.app, 'close', 'app.close'], [host.core, 'dispose', 'core.dispose'],
      [SqliteSearchHost.prototype, 'close', 'sqliteHost.close'], [NotificationService.prototype, 'close', 'notifications.close'],
      [ImSessionBridge.prototype, 'close', 'imSession.close'], [WebAccess.prototype, 'close', 'webAccess.close'],
      [ExternalClientHost.prototype, 'close', 'externalClient.close'], [NativeExternalClientListenerManager.prototype, 'close', 'externalListener.close'],
      [SessionLifecycleService.prototype, 'close', 'sessionLifecycle.close'], [SessionLifecycleService.prototype, 'saveReplayCheckpoints', 'session.checkpoints'],
      [SessionLifecycleService.prototype, 'drainAgents', 'session.drainAgents'], [SessionLifecycleService.prototype, 'persistUsage', 'session.persistUsage'],
      [AgentLifecycleService.prototype, 'remove', 'agent.remove'],
    ] as const) watch.watch(target, method, phase);
    return watch;
  } catch (error) {
    watch.restore();
    throw error instanceof Error ? error : new Error(closePhaseText(error), { cause: error });
  }
}

class NaturalCloseTimeout extends Error {
  constructor(readonly cleanup: Promise<void>, reason: 'stalled' | 'deadline', detail: unknown) {
    super(`Host did not close naturally (${reason}): ${JSON.stringify(detail)}`);
  }
}

async function awaitNaturalClose(input: {
  close: () => Promise<unknown>;
  install: () => ClosePhaseWatch;
  restoreSpy: () => void;
  detail: (phases: ClosePhaseWatch) => unknown;
}): Promise<void> {
  let phases: ClosePhaseWatch | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const installed = input.install();
    phases = installed;
    const closing = Promise.resolve().then(input.close).then(() => undefined);
    void closing.catch(() => undefined);
    const expired = new Promise<never>((_resolve, reject) => {
      const fail = (reason: 'stalled' | 'deadline') => reject(new NaturalCloseTimeout(closing, reason, input.detail(installed)));
      const progress = () => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => fail('stalled'), 2000);
      };
      unsubscribe = installed.onProgress(progress);
      progress();
      deadline = setTimeout(() => fail('deadline'), 10_000);
    });
    await Promise.race([closing, expired]);
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (deadline !== undefined) clearTimeout(deadline);
    unsubscribe?.();
    phases?.restore();
    input.restoreSpy();
  }
}

function buildClientFlowToml(port: number): string {
  return [
    'default_model = "unavailable"',
    '[search]', 'enabled = false',
    '[cron]', 'manualTick = true',
    '[providers.local]', 'type = "openai"', `base_url = "http://127.0.0.1:${port}/v1"`, 'api_key = "test-only"',
    '[providers."managed:kimi-code"]', 'type = "kimi"', '[providers."managed:kimi-code".oauth]', 'storage = "file"', 'key = "oauth/kimi-code"',
    '[models.unavailable]', 'provider = "managed:kimi-code"', 'model = "unavailable"', 'max_context_size = 100000',
    ...['first', 'second'].flatMap((m) => [
      `[models.${m}]`, 'provider = "local"', `model = "${m}"`,
      'max_context_size = 100000', 'capabilities = ["image_in", "thinking"]', 'support_efforts = ["low", "high"]', 'default_effort = "high"',
    ]),
    '',
  ].join('\n');
}

async function bootClientFlowHost(home: string): Promise<RunningServer> {
  return startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    homeDir: home,
    instancesDir: join(home, 'instances'),
    userSkillDir: join(home, 'isolated-skills'),
    userAgentProfileHomeDir: join(home, 'isolated-agents'),
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
  });
}

function createProviderHarness(getWorkspace: () => string) {
  let hold = false;
  let readTool = false;
  const held = new Set<ServerResponse>();
  const requests: ModelRequest[] = [];
  const server: Server = createServer((request, response) => {
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
      const tool = readTool && requests.length === 1;
      const delta = tool
        ? { tool_calls: [{ index: 0, id: 'private-read', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: join(getWorkspace(), 'example.txt') }) } }] }
        : { content: 'local model completed' };
      response.end(`data: ${JSON.stringify({ id: 'local-response', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`);
    })();
  });
  return {
    server, held, requests,
    get hold() { return hold; }, set hold(v: boolean) { hold = v; },
    get readTool() { return readTool; }, set readTool(v: boolean) { readTool = v; },
    reset() {
      for (const r of held) r.destroy();
      held.clear();
      requests.length = 0;
      hold = false;
      readTool = false;
    },
  };
}

describe('close phase watch', () => {
  it('names the unfinished close phase, runs following cleanup, and records rejections', async () => {
    const seen: string[] = [], values: unknown[] = [];
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), enteredGate = new Promise<void>((r) => { entered = r; });
    const steps = {
      marker: 'host',
      shutdown() { seen.push('shutdown'); return Promise.resolve(this.marker); },
      close(arg: string) { seen.push(`close:${arg}`); entered(); return gate.then(() => 'close-result'); },
      dispose() { seen.push('dispose'); return Promise.resolve('disposed'); },
    };
    const originalClose = steps.close, watch = new ClosePhaseWatch();
    watch.watch(steps, 'shutdown', 'threadComm.shutdown');
    watch.watch(steps, 'close', 'mailbox.close');
    watch.watch(steps, 'dispose', 'core.dispose');
    const running = (async () => { values.push(await steps.shutdown(), await steps.close('keep'), await steps.dispose()); })();
    await enteredGate;
    expect(watch.snapshot()).toMatchObject({ pending: 'mailbox.close', after: null, phases: [{ phase: 'threadComm.shutdown', state: 'done' }, { phase: 'mailbox.close', state: 'pending' }] });
    release();
    await running;
    expect(values).toEqual(['host', 'close-result', 'disposed']);
    expect(seen).toEqual(['shutdown', 'close:keep', 'dispose']);
    expect(watch.snapshot().phases.map((p) => `${p.phase}:${p.state}`)).toEqual(['threadComm.shutdown:done', 'mailbox.close:done', 'core.dispose:done']);
    watch.restore();
    expect(steps.close).toBe(originalClose);

    const broken = { close: () => Promise.reject(new Error('close failed')) }, failure = new ClosePhaseWatch();
    failure.watch(broken, 'close', 'mailbox.close');
    await expect(broken.close()).rejects.toThrow('close failed');
    expect(failure.snapshot().phases[0]).toMatchObject({ phase: 'mailbox.close', state: 'failed', error: 'close failed' });
    failure.restore();
  });

  it('restores prototype wrappers when close rejects', async () => {
    const origSqlite = SqliteSearchHost.prototype.close;
    let gets = 0, wrappedDuringClose = false;
    const srv = { close() {}, closeAllConnections: vi.fn() }, origSrvClose = srv.close, spy = vi.spyOn(srv, 'close');
    const host: CloseWatchTarget = {
      app: { close: () => undefined, server: srv },
      core: { dispose: () => undefined, accessor: { get: () => { gets += 1; throw new Error('accessor.get'); } }, instantiation: {} },
    };
    const reason = new Error('close failed');
    try {
      await expect(awaitNaturalClose({
        close: () => { wrappedDuringClose = SqliteSearchHost.prototype.close !== origSqlite; return Promise.reject(reason); },
        install: () => watchHostClose(host), restoreSpy: () => spy.mockRestore(), detail: () => ({}),
      })).rejects.toBe(reason);
      expect(wrappedDuringClose).toBe(true);
      expect(gets).toBe(0);
      expect(SqliteSearchHost.prototype.close).toBe(origSqlite);
      expect(srv.close).toBe(origSrvClose);
      expect(srv.closeAllConnections).not.toHaveBeenCalled();
    } finally {
      SqliteSearchHost.prototype.close = origSqlite;
      spy.mockRestore();
    }
  });

  it('allows continuing natural cleanup phases and enforces stalled vs absolute deadlines', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const watch = new ClosePhaseWatch();
      const steps = { web: () => new Promise<void>((r) => setTimeout(r, 1200)), checkpoint: () => new Promise<void>((r) => setTimeout(r, 1200)) };
      watch.watch(steps, 'web', 'webAccess.close');
      watch.watch(steps, 'checkpoint', 'session.checkpoints');
      const okOutcome = awaitNaturalClose({ close: async () => { await steps.web(); await steps.checkpoint(); }, install: () => watch, restoreSpy: () => {}, detail: () => watch.snapshot() }).then(() => undefined, (e) => e as unknown);
      await vi.advanceTimersByTimeAsync(2400);
      expect(await okOutcome).toBeUndefined();
      watch.restore();

      for (const settlement of ['resolve', 'reject'] as const) {
        let release!: () => void, cleaned = false;
        const gate = new Promise<void>((r) => { release = r; }), reason = new Error('late close failure');
        const s = { checkpoint: async () => { await gate; if (settlement === 'reject') throw reason; } }, w = new ClosePhaseWatch(), restored = vi.fn();
        w.watch(s, 'checkpoint', 'session.checkpoints');
        const out = awaitNaturalClose({ close: async () => { await s.checkpoint(); cleaned = true; }, install: () => w, restoreSpy: restored, detail: () => w.snapshot() }).then(() => undefined, (e) => e as unknown);
        await vi.advanceTimersByTimeAsync(2000);
        const err = await out;
        expect(err).toBeInstanceOf(NaturalCloseTimeout);
        expect((err as Error).message).toContain('(stalled)');
        expect(cleaned).toBe(false);
        expect(restored).toHaveBeenCalledOnce();
        release();
        if (settlement === 'reject') await expect((err as NaturalCloseTimeout).cleanup).rejects.toBe(reason);
        else await (err as NaturalCloseTimeout).cleanup;
        w.restore();
      }

      const dw = new ClosePhaseWatch(), dRestored = vi.fn();
      const dOut = awaitNaturalClose({
        close: async () => { for (let i = 0; i < 12; i++) await dw.track(`cp-${i}`, () => new Promise<void>((r) => setTimeout(r, 1000))); },
        install: () => dw, restoreSpy: dRestored, detail: () => dw.snapshot(),
      }).then(() => undefined, (e) => e as unknown);
      await vi.advanceTimersByTimeAsync(10_000);
      const dErr = await dOut;
      expect(dErr).toBeInstanceOf(NaturalCloseTimeout);
      expect((dErr as Error).message).toContain('(deadline)');
      await vi.advanceTimersByTimeAsync(2000);
      await (dErr as NaturalCloseTimeout).cleanup;
      dw.restore();
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });
});

describe('GUI shared client against an isolated KAP host (shared server partition)', () => {
  let host!: RunningServer;
  let client!: KikiClient;
  let home!: string;
  let endpoint!: string;
  let caseSeq = 0;
  const prov = createProviderHarness(() => join(home, 'workspace'));

  beforeAll(async () => {
    prov.server.listen(0, '127.0.0.1');
    await once(prov.server, 'listening');
    const port = (prov.server.address() as { port: number }).port;
    home = await mkdtemp(join(tmpdir(), 'kiki-client-flow-shared-'));
    await mkdir(join(home, 'workspace'), { recursive: true });
    await writeFile(join(home, 'config.toml'), buildClientFlowToml(port));
    host = await bootClientFlowHost(home);
    endpoint = `http://127.0.0.1:${host.port}`;
    client = new KikiClient({ baseUrl: endpoint, token: host.localOwnerToken });
  }, 45_000);

  beforeEach(() => {
    prov.reset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    prov.reset();
    const manager = host.core.accessor.get(ISessionManager);
    for (const live of manager.list()) {
      await manager.close(live.id).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await client?.klient.close();
    prov.server.closeAllConnections();
    const serverClose = vi.spyOn(host.app.server, 'close');
    try {
      await awaitNaturalClose({
        close: () => host.close(),
        install: () => watchHostClose(host),
        restoreSpy: () => serverClose.mockRestore(),
        detail: (p) => p.snapshot(),
      });
    } finally {
      await new Promise<void>((r) => prov.server.close(() => r()));
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 30_000);

  async function nextWorkspace(): Promise<string> {
    caseSeq += 1;
    const ws = join(home, `ws-${caseSeq}`);
    await mkdir(ws, { recursive: true });
    return ws;
  }

  async function session(): Promise<string> {
    return (await client.createSession({ metadata: { cwd: await nextWorkspace() }, agent_config: { permission_mode: 'manual' } })).id;
  }

  async function settled(id: string, count: number): Promise<void> {
    await vi.waitFor(() => expect(prov.requests).toHaveLength(count), { timeout: 10_000 });
    await vi.waitFor(async () => expect(await client.klient.session(id).status()).toBe('idle'), { timeout: 10_000 });
  }

  it.each(['auto-compact', 'context-strategy', 'ssh-hosts', 'model-switches', 'mcp-capabilities', 'goal', 'plan', 'context-rebuild'] as const)(
    'keeps main absent after empty session %s reads',
    async (read) => {
      if (read === 'mcp-capabilities') {
        await client.klient.global.mcp.add({ server: { name: 'disabled-example', transport: 'stdio', command: 'must-not-start', enabled: false } }).catch(() => undefined);
      }
      const id = (await client.createSession({ metadata: { cwd: await nextWorkspace() } })).id;
      const lifecycle = getLiveSessionById(host.core.accessor, id)!.accessor.get(IAgentLifecycleService);
      const view = client.sessionView(id);
      let ready = false;
      const subscription = view.bootstrap!({ transcriptGrades: { main: 'delta' } }, (s) => { if (s.type === 'ready') ready = true; });
      try {
        await vi.waitFor(() => expect(ready).toBe(true), { timeout: 10_000 });
        expect(lifecycle.get('main')).toBeUndefined();
        const agent = client.klient.session(id).agent('main');
        if (read === 'auto-compact') await expect(client.getAutoCompact(id, 'main')).rejects.toThrow('Model not set');
        if (read === 'context-strategy') {
          expect(await client.getContextStrategy(id, 'main')).toEqual({ strategy: 'summarize', source: 'default', shadow: false });
          await client.patchConfig({ loop_control: { context_strategy: 'fresh', relay_shadow: true } });
          try {
            expect(await client.getContextStrategy(id, 'main')).toEqual({ strategy: 'fresh', source: 'global', shadow: true });
          } finally {
            await client.patchConfig({ loop_control: { context_strategy: 'summarize', relay_shadow: false }, replace_domains: ['loop_control'] }).catch(async () => {
              await client.patchConfig({ replace_domains: ['loop_control'] });
            });
          }
        }
        if (read === 'ssh-hosts') {
          const response = await fetch(`${endpoint}/api/sessions/${id}/ssh/hosts`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
          expect(await response.json()).toMatchObject({ code: 0, data: { hosts: [] } });
        }
        if (read === 'model-switches') expect(await agent.listModelSwitches()).toEqual([]);
        if (read === 'mcp-capabilities') {
          expect(await agent.listMcpSessionCapabilities()).toContainEqual(expect.objectContaining({
            runtimeName: 'disabled-example', locator: { source: 'global', name: 'disabled-example' }, connection: 'disabled', override: 'inherit',
          }));
        }
        if (read === 'goal') {
          const response = await fetch(`${endpoint}/api/sessions/${id}/goal`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ code: 0, data: null });
        }
        if (read === 'plan') expect(await agent.getPlan()).toBeNull();
        if (read === 'context-rebuild') await agent.contextRebuildControl();
        expect(lifecycle.get('main')).toBeUndefined();
      } finally { subscription.close(); }
    },
  );

  it('keeps saved cold read-only entry points off the restore path', async () => {
    const id = (await client.createSession({ metadata: { cwd: await nextWorkspace() } })).id;
    const manager = host.core.accessor.get(ISessionManager);
    await manager.close(id);
    expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
    const err = new Error('cold restore attempted');
    const acquire = vi.spyOn(manager, 'acquire').mockRejectedValue(err);
    const resume = vi.spyOn(manager, 'resume').mockRejectedValue(err);
    const reads = [
      ['auto-compact', `/api/sessions/${id}/agents/main/auto-compact?observe=true`, 40001],
      ['context-strategy', `/api/sessions/${id}/agents/main/context-strategy?observe=true`, 0],
      ['optional-capabilities', `/api/sessions/${id}/optional-capabilities`, 0],
      ['ssh-hosts', `/api/sessions/${id}/ssh/hosts`, 0],
      ['hooks', `/api/sessions/${id}/agents/main/hooks`, 0],
      ['goal', `/api/sessions/${id}/goal`, 0],
    ] as const;
    try {
      for (const [name, path, expectedCode] of reads) {
        const res = await fetch(`${endpoint}${path}`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
        expect(res.status, name).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body['code'], name).toBe(expectedCode);
      }
      expect(await client.klient.session(id).agent('main').listModelSwitches()).toEqual([]);
      expect(Array.isArray(await client.klient.session(id).agent('main').listMcpSessionCapabilities())).toBe(true);
      expect(acquire).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
      expect(prov.requests).toHaveLength(0);
    } finally { acquire.mockRestore(); resume.mockRestore(); }
  });

  it('returns an active persisted goal from a cold session without restoring it', async () => {
    const id = await session();
    const manager = host.core.accessor.get(ISessionManager);
    const live = getLiveSessionById(host.core.accessor, id)!;
    const main = await live.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    const dispatcher = main.accessor.get(IEventDispatcher);
    const goalId = 'goal-persisted-http';
    await dispatcher.dispatch(new GoalCreate({
      goalId, objective: 'Read a goal after closing the session', completionCriterion: 'The saved goal response preserves its controls and budget',
      status: 'active', followUpTiming: 'tasks_done', controlRevision: 3, wallClockResumedAt: Date.now(),
    }));
    await dispatcher.dispatch(new GoalUpdate({
      goalId, controlRevision: 8, tokensUsed: 125, turnsUsed: 2, wallClockMs: 3_000,
      budgetLimits: { tokenBudget: 1_000, turnBudget: 6, wallClockBudgetMs: 60_000 },
    }));
    await manager.close(id);
    const err = new Error('cold restore attempted');
    const acquire = vi.spyOn(manager, 'acquire').mockRejectedValue(err);
    const resume = vi.spyOn(manager, 'resume').mockRejectedValue(err);
    try {
      const res = await fetch(`${endpoint}/api/sessions/${id}/goal`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { code: number; data: { wallClockMs: number; budget: { remainingWallClockMs: number } } };
      expect(body).toMatchObject({
        code: 0,
        data: {
          goalId, status: 'active', controlRevision: 8, tokensUsed: 125, turnsUsed: 2,
          budget: { tokenBudget: 1_000, turnBudget: 6, wallClockBudgetMs: 60_000, remainingTokens: 875, remainingTurns: 4, overBudget: false },
        },
      });
      expect(body.data.budget.remainingWallClockMs + body.data.wallClockMs).toBe(60_000);
      expect(acquire).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
    } finally { acquire.mockRestore(); resume.mockRestore(); }
  });

  it('resolves cold auto-compact and context-strategy without restoring while returning lock-free SESSION_BUSY for >8MiB hooks', async () => {
    const id = (await client.createSession({ metadata: { cwd: await nextWorkspace() }, agent_config: { model: 'first' } })).id;
    const manager = host.core.accessor.get(ISessionManager);
    const live = getLiveSessionById(host.core.accessor, id)!;
    const lifecycle = live.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({ delegator: { kind: 'agent', agentId: 'main' }, binding: { profile: 'agent', model: 'first' } });
    await lifecycle.remove(child.id);

    const acquire = vi.spyOn(manager, 'acquire').mockRejectedValue(new Error('observe must not acquire'));
    const resume = vi.spyOn(manager, 'resume').mockRejectedValue(new Error('observe must not resume'));
    const size = vi.spyOn(host.core.accessor.get(IFileSystemStorageService), 'size').mockResolvedValue(9 * 1024 * 1024);
    const read = vi.spyOn(host.core.accessor.get(IAppendLogStore), 'read');
    try {
      const childRes = await fetch(`${endpoint}/api/sessions/${id}/agents/${child.id}/hooks?observe=true`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
      expect(await childRes.json()).toMatchObject({ code: 40901 });
      const childCompact = await fetch(`${endpoint}/api/sessions/${id}/agents/${child.id}/auto-compact?observe=true`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
      expect(await childCompact.json()).toMatchObject({ code: 0, data: { source: expect.any(String), effectiveMaxContextTokens: expect.any(Number) } });
      const childStrategy = await fetch(`${endpoint}/api/sessions/${id}/agents/${child.id}/context-strategy?observe=true`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
      expect(await childStrategy.json()).toMatchObject({ code: 0, data: { strategy: expect.any(String), source: expect.any(String) } });
      expect(acquire).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();

      acquire.mockRestore();
      await manager.close(id);
      vi.spyOn(manager, 'acquire').mockRejectedValue(new Error('cold observe must not acquire'));
      const started = performance.now();
      const compactRes = await fetch(`${endpoint}/api/sessions/${id}/agents/main/auto-compact?observe=true`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
      expect(await compactRes.json()).toMatchObject({ code: 0, data: { source: expect.any(String), effectiveMaxContextTokens: expect.any(Number) } });
      const strategyRes = await fetch(`${endpoint}/api/sessions/${id}/agents/main/context-strategy?observe=true`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
      expect(await strategyRes.json()).toMatchObject({ code: 0, data: { strategy: expect.any(String), source: expect.any(String) } });
      const hooksRes = await fetch(`${endpoint}/api/sessions/${id}/agents/main/hooks?observe=true`, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
      expect(await hooksRes.json()).toMatchObject({ code: 40901 });
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(resume).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
    } finally { vi.restoreAllMocks(); }
  });

  it('pages saved turns after an oversized last record leaves the cold first screen empty', async () => {
    const id = await session();
    const manager = host.core.accessor.get(ISessionManager);
    await manager.close(id);
    const indexed = (await host.core.accessor.get(ISessionIndex).get(id))!;
    const logs = host.core.accessor.get(IAppendLogStore);
    const scope = `sessions/${indexed.workspaceId}/${id}/agents/main`;
    logs.append(scope, 'wire.jsonl', { type: 'turn.prompt', turnId: 0, promptId: 'saved', input: [{ type: 'text', text: 'Earlier saved prompt' }], origin: { kind: 'user' }, time: 1 });
    logs.append(scope, 'wire.jsonl', { type: 'turn.ended', turnId: 0, reason: 'completed', time: 2 });
    logs.append(scope, 'wire.jsonl', { type: 'unrelated', payload: 'x'.repeat(12 << 20) });
    await logs.flush(scope, 'wire.jsonl');
    const controller = new SessionController(client.sessions, client.sessionView(id), id);
    const acquire = vi.spyOn(manager, 'acquire');
    const resume = vi.spyOn(manager, 'resume');
    try {
      await controller.open();
      await vi.waitFor(() => {
        controller.flushFrames();
        expect(controller.getState()).toMatchObject({ loaded: true, transcriptReady: true, hasMoreHistory: true, blocks: [] });
      }, { timeout: 5_000 });
      expect(await controller.loadOlderHistory('main')).toMatchObject({ changed: true });
      expect(JSON.stringify(controller.getState().blocks)).toContain('Earlier saved prompt');
      expect(acquire).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(manager.get(id)).toBeUndefined();
    } finally { controller.close(); acquire.mockRestore(); resume.mockRestore(); }
  }, 15_000);

  it.each([false, true])('preserves complete model-switch reads and explicit observe=%s over GUI HTTP after >8MiB', async (observe) => {
    const id = (await client.createSession({ metadata: { cwd: await nextWorkspace() } })).id;
    const manager = host.core.accessor.get(ISessionManager);
    await manager.close(id);
    const summary = await host.core.accessor.get(ISessionIndex).get(id);
    const logs = host.core.accessor.get(IAppendLogStore);
    const scope = `sessions/${summary!.workspaceId}/${id}/agents/main`;
    logs.append(scope, 'wire.jsonl', { type: 'unrelated', payload: 'x'.repeat(9 * 1024 * 1024) });
    logs.append(scope, 'wire.jsonl', {
      type: 'prompt.model_switch_queued', time: 1, queueIndex: 0,
      entry: {
        input: { operationId: 'cold-switch', model: 'first', mode: 'direct' }, revision: 0,
        originalBinding: { model: 'second', thinking: '' },
        receipt: { operationId: 'cold-switch', agentId: 'main', state: 'pending', mode: 'direct', fromModel: 'second', toModel: 'first' },
      },
    });
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
      await expect(observe ? client.listAgentModelSwitches(id, 'main', undefined, true) : client.listAgentModelSwitches(id, 'main')).resolves.toMatchObject([
        { input: { operationId: 'cold-switch' }, queueIndex: 0 },
      ]);
      expect(acquire).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(getLiveSessionById(host.core.accessor, id)).toBeUndefined();
    } finally { acquire.mockRestore(); resume.mockRestore(); }
  });

  it.each(['compaction.started', 'compaction.completed', 'compaction.cancelled'] as const)(
    'watches absent main %s over WS without creating it and attaches on real creation',
    async (type) => {
      const id = (await client.createSession({ metadata: { cwd: await nextWorkspace() } })).id;
      const lifecycle = getLiveSessionById(host.core.accessor, id)!.accessor.get(IAgentLifecycleService);
      const received = vi.fn(), removed = vi.fn();
      const events = client.klient.session(id).agent('main').events;
      const active = events.on(type, received), disposed = events.on(type, removed);
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
    },
  );

  it('bootstraps a new empty main with verified complete history', async () => {
    const id = (await client.createSession({ metadata: { cwd: await nextWorkspace() } })).id;
    expect(getLiveSessionById(host.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
    await Promise.all([
      client.getAutoCompact(id, 'main').catch((e: Error) => expect(e.message).toContain('Model not set')),
      client.getContextStrategy(id, 'main'),
      client.klient.session(id).agent('main').listMcpSessionCapabilities(),
      client.klient.session(id).agent('main').listModelSwitches(),
    ]);
    expect(getLiveSessionById(host.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
    const view = client.sessionView(id);
    const signals: Parameters<Parameters<typeof view.subscribe>[1]>[0][] = [];
    const subscription = view.bootstrap!({ transcriptGrades: { main: 'delta' } }, (s) => signals.push(s));
    try {
      await vi.waitFor(() => expect(signals.some((s) => s.type === 'ready')).toBe(true), { timeout: 10_000 });
      const resets = signals.filter((s) => s.type === 'transcript' && s.event.type === 'transcript.reset');
      expect(resets).toHaveLength(1);
      expect(resets[0]).toMatchObject({
        event: {
          coverage: { kind: 'full', hasMoreOlder: false }, read: { readiness: 'ready' },
          snapshot: { items: [], toolCallCount: 0, toolCallCountKnown: true, hasMoreOlder: false },
        },
      });
      expect(await client.klient.session(id).view.snapshot()).toMatchObject({ session: { message_count: 0 }, messages: { items: [], has_more: false } });
      expect(getLiveSessionById(host.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
    } finally { subscription.close(); }
  });

  it('automatically generates a configured title after the first real reply and exposes it to clients', async () => {
    await client.patchConfig({ session_title: { model: 'second' }, replace_domains: ['session_title'] });
    const id = await session();
    const other = new KikiClient({ baseUrl: endpoint, token: host.localOwnerToken });
    const controllers = [client, other].map((c) => new SessionController(c.sessions, c.sessionView(id), id));
    const updates = [vi.fn(), vi.fn()];
    const subs = [client, other].map((c, idx) => c.klient.events.on('session.metaUpdated', updates[idx]!));
    try {
      await Promise.all(controllers.map((c) => c.open()));
      await Promise.all(subs.map((s) => s.ready));
      await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'Plan a small garden' }] });
      await vi.waitFor(() => {
        for (const c of controllers) { c.flushFrames(); expect(c.getState().session?.title).toBe('local model completed'); }
      }, { timeout: 10_000 });
      expect((await client.klient.session(id).get()).title).toBe('local model completed');
      expect(prov.requests.map((r) => r.model)).toEqual(['first', 'second']);
      for (const u of updates) expect(u.mock.calls.filter(([e]) => e.patch.title === 'local model completed')).toHaveLength(1);
      await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'Add a pond' }] });
      await settled(id, 3);
      expect(prov.requests.filter((r) => r.model === 'second')).toHaveLength(1);
    } finally {
      for (const c of controllers) c.close();
      for (const s of subs) s.dispose();
      await other.klient.close();
      await client.patchConfig({ session_title: { model: null, triggers: [] }, replace_domains: ['session_title'] }).catch(() => undefined);
    }
  });

  it('sends, switches model, rejects unauthenticated override without rebinding, cancels, and rejects >12MiB drafts', async () => {
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'first turn' }] });
    await settled(id, 1);
    expect(prov.requests[0]?.model).toBe('first');
    await client.submitPrompt(id, { model: 'second', content: [{ type: 'text', text: 'switch model' }] });
    await settled(id, 2);
    expect(prov.requests[1]?.model).toBe('second');
    await expect(client.submitPrompt(id, { model: 'unavailable', content: [{ type: 'text', text: 'must reject' }] })).rejects.toMatchObject({ code: 40111 });

    const hugeDraft = { model: 'first', content: [{ type: 'text' as const, text: 'x'.repeat(12 * 1024 * 1024) }] };
    await expect(client.submitPrompt(id, hugeDraft)).rejects.toMatchObject({ code: 40001, message: expect.stringContaining('size limit') });

    await client.submitPrompt(id, { content: [{ type: 'text', text: 'keep the bound model' }] });
    await settled(id, 3);
    expect(prov.requests[2]?.model).toBe('second');
    expect(JSON.stringify(prov.requests[2])).not.toContain('must reject');

    prov.hold = true;
    const pending = await client.submitPrompt(id, { content: [{ type: 'text', text: 'cancel this turn' }] });
    await vi.waitFor(() => expect(prov.requests).toHaveLength(4), { timeout: 10_000 });
    await client.abortPrompt(id, pending.prompt_id);
    await vi.waitFor(async () => expect(await client.klient.session(id).status()).toBe('idle'), { timeout: 10_000 });
    for (const path of ['/api/v1/healthz', '/api/v2/sessions', '/api/v1/sessions']) {
      const response = await fetch(endpoint + path, { headers: { authorization: `Bearer ${host.localOwnerToken}` } });
      expect(response.status, path).toBe(404);
      await response.arrayBuffer();
    }
  }, 40_000);

  it('recovers ordered transcript delivery after the actual event socket is severed', async () => {
    const id = await session();
    await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'before disconnect' }] });
    await settled(id, 1);
    const isolatedClient = new KikiClient({ baseUrl: endpoint, token: host.localOwnerToken });
    const sockets = new Set<import('node:stream').Duplex>();
    const onUpgrade = (_req: unknown, socket: import('node:stream').Duplex) => sockets.add(socket);
    host.app.server.on('upgrade', onUpgrade);
    const signals: import('@kiki/klient').SessionViewSignal[] = [];
    const view = isolatedClient.klient.session(id).view.subscribe({ sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' } }, (s) => signals.push(s));
    try {
      await vi.waitFor(() => expect(signals.some((s) => s.type === 'ready')).toBe(true), { timeout: 10_000 });
      const initialGen = signals.find((s) => s.type === 'ready')!.generation;
      expect(sockets.size).toBe(1);
      for (const s of sockets) s.destroy();
      await vi.waitFor(() => expect(signals.some((s) => s.type === 'status' && s.status === 'closed')).toBe(true));
      await client.submitPrompt(id, { content: [{ type: 'text', text: 'sent while the view reconnects' }] });
      await settled(id, 2);
      await vi.waitFor(() => expect(signals.some((s) => s.type === 'ready' && s.reconnected && s.generation > initialGen)).toBe(true), { timeout: 10_000 });
      await vi.waitFor(() => expect(JSON.stringify(signals.filter((s) => s.type === 'transcript' && s.generation > initialGen))).toContain('sent while the view reconnects'), { timeout: 10_000 });
      expect(signals.filter((s) => s.type === 'protocolError')).toEqual([]);
      expect(sockets.size).toBe(2);
    } finally {
      host.app.server.off('upgrade', onUpgrade);
      view.close();
      await isolatedClient.klient.close();
      for (const s of sockets) s.destroy();
    }
  }, 40_000);

  it('accepts three uploaded and three inline images through the GUI adapter and downloads session media', async () => {
    const id = await session();
    const image = paddedPng(600 * 1024, 1);
    const uploaded = await Promise.all([0, 1, 2].map((i) => client.uploadFile(new File([new Uint8Array(image)], `image-${i}.png`, { type: 'image/png' }))));
    const submission = { model: 'first', content: uploaded.map((f) => ({ type: 'image' as const, source: { kind: 'file' as const, file_id: f.id } })) };
    expect(Buffer.byteLength(JSON.stringify(submission))).toBeLessThan(1024);
    await client.submitPrompt(id, submission);
    await settled(id, 1);
    const user = prov.requests[0]?.messages.findLast((m) => m.role === 'user' && JSON.stringify(m.content).includes('data:image/png;base64,'));
    expect(JSON.stringify(user).match(/data:image\/png;base64,/g)).toHaveLength(3);
    for (const file of uploaded) {
      const downloaded = await client.readSessionMediaBytes(id, file.id);
      expect(downloaded.mime).toBe('image/png');
      expect(Buffer.from(downloaded.bytes)).toEqual(image);
    }
    const inline = { content: [0, 1, 2].map(() => ({ type: 'image' as const, source: { kind: 'base64' as const, media_type: 'image/png', data: image.toString('base64') } })) };
    expect(Buffer.byteLength(JSON.stringify(inline))).toBeGreaterThan(2 * 1024 * 1024);
    await client.submitPrompt(id, inline);
    await settled(id, 2);
    expect(prov.requests[1]?.model).toBe('first');
    vi.spyOn(host.core.accessor.get(IFileService), 'get').mockRejectedValueOnce(new Error('synthetic media storage failure'));
    await expect(client.readSessionMediaBytes(id, 'missing-file')).rejects.toMatchObject({ code: 50001 });
  }, 40_000);
});

describe('GUI dedicated lifecycle, privacy, and restart proofs', () => {
  async function withIsolatedHost<T>(fn: (ctx: {
    home: string;
    prov: ReturnType<typeof createProviderHarness>;
    host: RunningServer;
    client: KikiClient;
    endpoint: string;
    restart: () => Promise<{ host: RunningServer; client: KikiClient; endpoint: string }>;
  }) => Promise<T>): Promise<T> {
    let home = '';
    const prov = createProviderHarness(() => join(home, 'workspace'));
    prov.server.listen(0, '127.0.0.1');
    await once(prov.server, 'listening');
    const port = (prov.server.address() as { port: number }).port;
    home = await mkdtemp(join(tmpdir(), 'kiki-client-flow-iso-'));
    await mkdir(join(home, 'workspace'), { recursive: true });
    await writeFile(join(home, 'config.toml'), buildClientFlowToml(port));
    let host: RunningServer | undefined = await bootClientFlowHost(home);
    let endpoint = `http://127.0.0.1:${host.port}`;
    let client = new KikiClient({ baseUrl: endpoint, token: host.localOwnerToken });
    const ctx = {
      home, prov,
      get host() { return host!; },
      get client() { return client; },
      get endpoint() { return endpoint; },
      restart: async () => {
        await client.klient.close();
        await host!.close();
        host = await bootClientFlowHost(home);
        endpoint = `http://127.0.0.1:${host.port}`;
        client = new KikiClient({ baseUrl: endpoint, token: host.localOwnerToken });
        return { host, client, endpoint };
      },
    };
    try {
      return await fn(ctx);
    } finally {
      await client.klient.close().catch(() => undefined);
      prov.reset();
      prov.server.closeAllConnections();
      if (host !== undefined && host.app.server.listening) {
        const serverClose = vi.spyOn(host.app.server, 'close');
        await awaitNaturalClose({
          close: () => host!.close(),
          install: () => watchHostClose(host!),
          restoreSpy: () => serverClose.mockRestore(),
          detail: (p) => p.snapshot(),
        });
      }
      await new Promise<void>((r) => prov.server.close(() => r()));
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }

  it('requires an explicit title model and keeps empty triggers manual-only with actionable REST failures', async () => {
    await withIsolatedHost(async ({ home, prov, host, client, endpoint }) => {
      await client.patchConfig({ fast_model: 'second' });
      const id = (await client.createSession({ metadata: { cwd: join(home, 'workspace') }, agent_config: { permission_mode: 'manual' } })).id;
      await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'Keep my garden plan' }] });
      await vi.waitFor(() => expect(prov.requests).toHaveLength(1), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await client.klient.session(id).status()).toBe('idle'), { timeout: 10_000 });
      const generate = async () => (await fetch(`${endpoint}/api/sessions/${id}/title/generate`, {
        method: 'POST', headers: { authorization: `Bearer ${host.localOwnerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      })).json() as Promise<{ code: number; msg: string; data: { title?: string } }>;
      expect((await generate()).code).toBe(40923);
      await client.patchConfig({ session_title: { model: 'second', triggers: [] }, replace_domains: ['session_title'] });
      await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'Include a pond' }] });
      await vi.waitFor(() => expect(prov.requests).toHaveLength(2), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await client.klient.session(id).status()).toBe('idle'), { timeout: 10_000 });
      expect(await generate()).toMatchObject({ code: 0, data: { title: 'local model completed' } });
      await client.patchConfig({ session_title: { model: 'missing-title-model', triggers: [] }, replace_domains: ['session_title'] });
      const failed = await generate();
      expect(failed.code).toBe(40923);
      expect(failed.msg).toContain('missing-title-model');
      expect((await client.klient.session(id).get()).title).toBe('local model completed');
      expect(prov.requests).toHaveLength(3);
    });
  }, 30_000);

  it('keeps private turns out of telemetry, usage, export and retained ledgers', async () => {
    await withIsolatedHost(async ({ home, prov, host, client }) => {
      const events: string[] = [];
      const sub = host.core.accessor.get(ITelemetryService).addAppender({ track: (name) => { events.push(name); } });
      try {
        prov.readTool = true;
        await writeFile(join(home, 'workspace', 'example.txt'), 'Private fixture text');
        const id = (await client.createSession({ private: true, metadata: { cwd: join(home, 'workspace') }, agent_config: { permission_mode: 'auto' } })).id;
        await client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'Private turn' }] });
        await vi.waitFor(() => expect(prov.requests).toHaveLength(2), { timeout: 10_000 });
        await vi.waitFor(async () => expect(await client.klient.session(id).status()).toBe('idle'), { timeout: 10_000 });
        const handle = getLiveSessionById(host.core.accessor, id)!;
        const context = handle.accessor.get(ISessionContext);
        handle.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(ITelemetryService).track('private_probe');
        for (const e of ['private_probe', 'session_started', 'llm_request', 'turn_completed', 'prompt_submitted', 'tool_call']) expect(events).not.toContain(e);
        expect(handle.accessor.get(ISessionMetadata).snapshot().usage).toBeUndefined();
        const facts = host.core.accessor.get(IUsageFactStore);
        const scope = agentScopeOf(context.scope(), 'main');
        expect(await facts.journalSize(scope)).toBe(0);
        const usage = usageRuntime(host.core).service;
        expect((await usage.query({})).summary).toMatchObject({ session_count: 0, tokens: { input_other: 0, output: 0 } });
        const manager = host.core.accessor.get(ISessionManager);
        expect((await manager.fork({ sourceSessionId: id })).accessor.get(ISessionMetadata).snapshot().private).toBe(true);
        expect((await manager.createChild({ sourceSessionId: id })).accessor.get(ISessionMetadata).snapshot().private).toBe(true);
        expect((await manager.fork({ sourceSessionId: id, private: false })).accessor.get(ISessionMetadata).snapshot().private).toBe(false);
        await facts.setSessionPrivacy((await host.core.accessor.get(ISessionIndex).get(id))!);
        await manager.close(id);
        const indexed = (await host.core.accessor.get(ISessionIndex).get(id))!;
        const stale = vi.spyOn(host.core.accessor.get(ISessionIndex), 'get').mockResolvedValue({ ...indexed, private: false });
        const resumed = await manager.resume(id);
        stale.mockRestore();
        expect(resumed?.accessor.get(ISessionContext).isPrivate?.()).toBe(true);
        expect(await host.core.accessor.get(IUsageReadModel).isPrivateSession(indexed.workspaceId, id)).toBe(true);
        await manager.archive(id);
        await manager.delete(id);
        expect((await host.core.accessor.get(IRetainedUsageService).listDeletedSessions({ deadlineAt: Date.now() + 5_000, recordLimit: 100 })).items).toEqual([]);
        expect((await usage.query({})).summary.session_count).toBe(0);
      } finally { sub.dispose(); }
    });
  }, 40_000);

  it.each(['EOF', 'remaining bytes'] as const)('waits for media %s then naturally releases its newly idle connection during close', async (waitFor) => {
    await withIsolatedHost(async ({ home, host, client }) => {
      const id = (await client.createSession({ metadata: { cwd: join(home, 'workspace') }, agent_config: { permission_mode: 'manual' } })).id;
      const bytes = new Uint8Array([65, 66, 67]);
      const uploaded = await client.uploadFile(new File([bytes], 'delayed.bin'), id);
      const files = host.core.accessor.get(IFileService);
      const stored = await files.get(uploaded.id);
      let releaseEof!: () => void, notifyStarted!: () => void, released = false, naturallyClosed = false;
      const eof = new Promise<void>((r) => { releaseEof = r; }), started = new Promise<void>((r) => { notifyStarted = r; });
      const read = vi.spyOn(files, 'get').mockResolvedValueOnce({
        ...stored,
        stream: () => Readable.from((async function* () {
          try {
            yield waitFor === 'EOF' ? bytes : bytes.slice(0, 1);
            notifyStarted();
            await eof;
            if (waitFor === 'remaining bytes') yield bytes.slice(1);
          } finally { released = true; }
        })()),
      });
      const downloading = client.readSessionMediaBytes(id, uploaded.id);
      let closing: Promise<void> | undefined;
      try {
        await started;
        if (waitFor === 'EOF') expect((await downloading).bytes).toEqual(bytes);
        expect(released).toBe(false);
        closing = host.close().then(() => { naturallyClosed = true; });
        await new Promise<void>((r) => setTimeout(r, 50));
        expect(naturallyClosed).toBe(false);
        releaseEof();
        expect((await downloading).bytes).toEqual(bytes);
        await closing;
        expect(released).toBe(true);
        expect(naturallyClosed).toBe(true);
      } finally {
        releaseEof();
        if (closing !== undefined && !naturallyClosed) host.app.server.closeAllConnections();
        await closing;
        read.mockRestore();
      }
    });
  }, 30_000);

  it('keeps the composer binding after reopening and restarting a bound session with a credentialless server default', async () => {
    await withIsolatedHost(async (ctx) => {
      const id = (await ctx.client.createSession({ metadata: { cwd: join(ctx.home, 'workspace') }, agent_config: { permission_mode: 'manual' } })).id;
      await ctx.client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'persist this binding' }] });
      await vi.waitFor(() => expect(ctx.prov.requests).toHaveLength(1), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await ctx.client.klient.session(id).status()).toBe('idle'), { timeout: 10_000 });
      await ctx.restart();
      for (const reopen of [0, 1]) {
        const actual = ctx.client.klient.session(id).view;
        const shell = await actual.snapshot();
        expect(shell.session.agent_config.model).toBe('first');
        let ready = false, projected = applyTranscriptShell(id, shell), resets = 0;
        const sub = actual.subscribe({ sessionCursor: { seq: shell.as_of_seq, epoch: shell.epoch }, transcriptGrades: { main: 'delta' } }, (s) => {
          if (s.type === 'transcript' && s.event.type === 'transcript.reset' && s.event.agent_id === 'main') {
            projected = projectAgentTranscriptView(projected, 'main', s.event.snapshot);
            resets += 1;
          }
          if (s.type === 'ready') ready = true;
        });
        try {
          await vi.waitFor(() => expect(ready).toBe(true), { timeout: 10_000 });
          expect(resets).toBeGreaterThan(0);
          expect(projected.model).toBe('first');
          await ctx.client.submitPrompt(id, { content: [{ type: 'text', text: `GUI continuation ${reopen}` }], model: projected.model ?? 'unavailable' });
          await vi.waitFor(() => expect(ctx.prov.requests).toHaveLength(reopen + 2), { timeout: 10_000 });
          await vi.waitFor(async () => expect(await ctx.client.klient.session(id).status()).toBe('idle'), { timeout: 10_000 });
          expect(ctx.prov.requests[reopen + 1]?.model).toBe('first');
        } finally { sub.close(); }
      }
    });
  }, 40_000);

  it.each(['live', 'cold'] as const)('publishes child prompt restarts and terminal states through the %s GUI view', async (mode) => {
    await withIsolatedHost(async (ctx) => {
      const id = (await ctx.client.createSession({ metadata: { cwd: join(ctx.home, 'workspace') }, agent_config: { permission_mode: 'manual' } })).id;
      await ctx.client.submitPrompt(id, { model: 'first', content: [{ type: 'text', text: 'establish parent' }] });
      await vi.waitFor(() => expect(ctx.prov.requests).toHaveLength(1), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await ctx.client.klient.session(id).status()).toBe('idle'), { timeout: 10_000 });
      const live = getLiveSessionById(ctx.host.core.accessor, id)!;
      const child = await live.accessor.get(IAgentLifecycleService).create({ delegator: { kind: 'agent', agentId: 'main' }, binding: { profile: 'agent', model: 'first' } });
      await ctx.client.sendAgentMessage(id, child.id, 'initial child prompt', undefined, 'initial-child-prompt');
      await child.accessor.get(IAgentExecutionService).settled();
      if (mode === 'cold') {
        await ctx.restart();
        expect(getLiveSessionById(ctx.host.core.accessor, id)).toBeUndefined();
        const coldRes = await fetch(`${ctx.endpoint}/api/sessions/${id}/transcript?agent_id=main&transcript_coverage_version=2`, { headers: { authorization: `Bearer ${ctx.host.localOwnerToken}` } });
        const cold = (await coldRes.json()) as { code: number; data: { tasks: { agentId?: string; state: string }[] } };
        expect(cold.data.tasks.find((t) => t.agentId === child.id)?.state).toBe('completed');
        expect(getLiveSessionById(ctx.host.core.accessor, id)).toBeUndefined();
      }
      const view = ctx.client.sessionView(id);
      let ready = false, liveChildBaselineEpoch: string | undefined;
      const subscribe = view.subscribe.bind(view), bootstrap = view.bootstrap!.bind(view);
      const observe = (cb: Parameters<typeof view.subscribe>[1]) => (s: Parameters<typeof cb>[0]) => {
        if (s.type === 'ready') ready = true;
        if (s.type === 'transcript' && s.event.type === 'transcript.reset' && s.event.agent_id === child.id && s.event.cursor.epoch && !s.event.cursor.epoch.startsWith('cold:')) {
          liveChildBaselineEpoch = s.event.cursor.epoch;
        }
        cb(s);
      };
      const subSpy = vi.spyOn(view, 'subscribe').mockImplementation((o, cb) => subscribe(o, observe(cb)));
      const bootSpy = vi.spyOn(view, 'bootstrap').mockImplementation((o, cb) => bootstrap(o, observe(cb)));
      const controller = new SessionController(ctx.client.sessions, view, id);
      const mainChanges = vi.fn(), childChanges = vi.fn();
      const offMain = controller.subscribe(mainChanges), offChild = controller.subscribeAgent(child.id, childChanges);
      controller.retainAgentView('test-child', child.id, 'turn');
      try {
        await controller.open();
        await vi.waitFor(() => expect(ready).toBe(true), { timeout: 10_000 });
        await vi.waitFor(() => { controller.flushFrames(); expect(controller.getForest()?.byId[child.id]?.status).toBe('completed'); });
        if (mode === 'cold') {
          expect(getLiveSessionById(ctx.host.core.accessor, id)).toBeUndefined();
          expect(controller.getAgentTranscriptCursor(child.id)?.epoch).toMatch(/^cold:/);
        }
        for (const ending of ['completed', 'failed', 'cancelled'] as const) {
          ctx.prov.hold = true;
          const beforeReq = ctx.prov.requests.length, beforeEpoch = controller.getAgentTranscriptCursor(child.id)?.epoch;
          await ctx.client.sendAgentMessage(id, child.id, `follow-up ${ending}`, undefined, `follow-up-${ending}`);
          await vi.waitFor(() => expect(ctx.prov.requests).toHaveLength(beforeReq + 1), { timeout: 10_000 });
          await vi.waitFor(() => {
            controller.flushFrames();
            expect(liveChildBaselineEpoch).toBeDefined();
            expect(controller.getAgentTranscriptCursor(child.id)?.epoch).toBe(liveChildBaselineEpoch);
            if (beforeEpoch?.startsWith('cold:')) expect(liveChildBaselineEpoch).not.toBe(beforeEpoch);
            expect(controller.getForest()?.byId[child.id]?.status).toBe('background');
          }, { timeout: 10_000 });
          if (ending === 'cancelled') {
            const tasks = getLiveSessionById(ctx.host.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentTaskService);
            const task = tasks.list(true).find((t) => t.kind === 'agent' && t.agentId === child.id)!;
            await ctx.client.klient.session(id).agent('main').stopTask({ taskId: task.taskId });
          } else {
            for (const response of ctx.prov.held) {
              if (ending === 'failed') {
                response.writeHead(400, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: { message: 'Synthetic provider failure', type: 'invalid_request_error' } }));
              } else {
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'follow-up complete' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
              }
            }
            ctx.prov.held.clear();
          }
          await vi.waitFor(() => {
            controller.flushFrames();
            expect(controller.getForest()?.byId[child.id]?.status).toBe(ending);
            expect(controller.getAgentState(child.id).busy).toBe(false);
          }, { timeout: 10_000 });
        }
      } finally {
        offMain(); offChild(); subSpy.mockRestore(); bootSpy.mockRestore(); controller.close();
      }
    });
  }, 40_000);
});
