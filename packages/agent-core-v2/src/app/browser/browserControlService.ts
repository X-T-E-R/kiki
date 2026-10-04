import { hostname } from 'node:os';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { MCPToolDefinition, MCPToolResult } from '#/mcpCore/types';

import { IBrowserControlService, type BrowserInvocation, type BrowserInvocationResult, type BrowserStatus, type BrowserTab } from './browser';
import { IBrowserBackendFactory, type BrowserBackend } from './browserBackend';
import { IBrowserConnectionStore } from './browserConnectionStore';
import type { BrowserConnectionInput, BrowserResolvedConnection } from './browserConfig';
import { BrowserError } from './errors';
import { IFlagService } from '#/app/flag/flag';
import { NATIVE_BROWSER_FLAG_ID } from './flag';

interface LiveBrowser {
  connection: BrowserResolvedConnection;
  status: BrowserStatus;
  backend?: BrowserBackend;
  tools?: readonly MCPToolDefinition[];
  tail: Promise<unknown>;
  admitting: boolean;
  oldPid?: number;
  observation?: { binding: string; refs: Set<string> };
  target?: { tab: string; frame: string };
  captures?: Map<string, string>;
}

function elementRefs(value: unknown): string[] {
  if (typeof value === 'string') return /^@?e\d+$/.test(value) ? [value.replace(/^@/, '')] : [];
  if (Array.isArray(value)) return value.flatMap(elementRefs);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(elementRefs);
  return [];
}

export function browserResponse(result: MCPToolResult): { success?: boolean; data?: Record<string, unknown>; code?: string; error?: string } {
  const structured = result.structuredContent;
  if (typeof structured !== 'object' || structured === null) return {};
  const response = (structured as Record<string, unknown>)['response'];
  return typeof response === 'object' && response !== null && !Array.isArray(response)
    ? response as { success?: boolean; data?: Record<string, unknown>; code?: string; error?: string } : {};
}

export const BROWSER_OWNED_FIELDS = new Set(['session', 'namespace', 'extraArgs', 'restore', 'restoreSave', 'restoreCheckUrl',
  'restoreCheckText', 'restoreCheckFn', 'profile', 'cdp', 'pinTab', 'allowedDomains', 'caCert', 'clearCaCert', 'idleTimeout', 'timeoutMs', 'screenshotDir']);
export function isBrowserOperation(name: string): boolean {
  return name.startsWith('agent_browser_') && !/^agent_browser_(?:tools_profiles|connect|close|tab_|frame_|window_|session(?:_|$)|profiles(?:_|$)|skills(?:_|$)|install$|upgrade$|doctor$|dashboard_|plugin(?:_|$)|plugins(?:_|$)|chat$|batch$|confirm$|deny$|auth(?:_|$)|state_(?:list|show|rename|clear|clean))/.test(name);
}
export function browserToolGroup(name: string): string {
  if (/network|har|headers|credentials|offline/.test(name)) return 'network';
  if (/cookies|storage|state_/.test(name)) return 'state';
  if (/react|vitals|pushstate/.test(name)) return 'react';
  if (/console|errors|trace|profiler|record|diff|a11y|inspect|highlight/.test(name)) return 'debug';
  if (/mouse|touch|swipe|viewport|device|geo|media/.test(name)) return 'input';
  return 'page';
}

export class BrowserControlService implements IBrowserControlService {
  declare readonly _serviceBrand: undefined;
  private readonly connections = new Map<string, LiveBrowser>();
  constructor(
    @IBrowserConnectionStore private readonly store: IBrowserConnectionStore,
    @IBrowserBackendFactory private readonly factory: IBrowserBackendFactory,
    @IFlagService private readonly flags: IFlagService,
  ) {}

  async list() {
    const configured = await this.store.list();
    return { connections: await Promise.all(configured.connections.map(async (entry) => ({ ...entry, status: await this.status(entry.id) }))),
      defaultBrowser: configured.defaultBrowser };
  }

  async upsert(id: string, input: BrowserConnectionInput) {
    if (this.connections.has(id)) {
      const status = await this.disconnect(id);
      if (status.state === 'unconfirmed') throw new BrowserError('browser.busy', 'The old browser execution session has not ended; configuration was not changed');
    }
    const record = await this.store.upsert(id, input);
    this.connections.delete(id);
    return record;
  }

  async remove(id: string): Promise<void> {
    if (this.connections.has(id) && (await this.disconnect(id)).state === 'unconfirmed') {
      throw new BrowserError('browser.busy', 'Browser execution is not confirmed stopped; the connection and profile were retained');
    }
    await this.store.remove(id);
    this.connections.delete(id);
  }

  async status(id: string): Promise<BrowserStatus> {
    const connection = await this.store.resolve(id);
    const live = this.connections.get(id);
    return live === undefined ? { browser: id, state: 'idle', executionHost: hostname(), generation: 0,
      ownership: connection.type === 'agent-browser-profile' ? 'managed-profile' : 'external-browser' } : { ...live.status };
  }

  async check(id: string, signal?: AbortSignal): Promise<BrowserStatus> {
    const live = await this.live(id);
    return this.enqueue(live, async () => {
      if (live.status.state === 'unconfirmed') return this.confirmStopped(live);
      try {
        const backend = await this.backend(live);
        signal?.throwIfAborted();
        const info = browserResponse(await this.call(live, 'agent_browser_session_info', {}));
        live.oldPid = typeof info.data?.['pid'] === 'number' ? info.data['pid'] : undefined;
        if (info.data?.['active'] === false && live.status.state === 'ready') {
          live.admitting = false;
          live.status = { ...live.status, state: 'disconnected', generation: live.status.generation + 1 };
        }
        if (live.status.state === 'ready') await this.readTabs(live);
        live.status = { ...live.status, checkedAt: new Date().toISOString(), driverVersion: backend.version };
      } catch (error) {
        if (signal?.aborted && error === signal.reason) throw error;
        this.fail(live, error, false);
      }
      return { ...live.status };
    }, signal);
  }

  async catalog(id: string, signal?: AbortSignal): Promise<readonly MCPToolDefinition[]> {
    const live = await this.live(id);
    return this.enqueue(live, async () => {
      if (live.tools !== undefined) return live.tools;
      const backend = await this.backend(live);
      signal?.throwIfAborted();
      live.tools = await backend.client.listTools();
      return live.tools;
    }, signal);
  }

  async connect(id: string, signal?: AbortSignal): Promise<BrowserStatus> {
    if (!this.flags.enabled(NATIVE_BROWSER_FLAG_ID)) throw new BrowserError('browser.disabled', 'Native browser execution is experimental; enable native_browser in the existing experimental settings', { details: { reason: 'feature_disabled' } });
    const live = await this.live(id);
    if (!live.connection.enabled) throw new BrowserError('browser.disabled', `Browser connection "${id}" is disabled`, { details: { reason: 'connection_disabled' } });
    if (live.status.state === 'unconfirmed' || live.status.state === 'stopping') {
      throw new BrowserError('browser.busy', 'The old daemon has not been confirmed stopped; check or disconnect it before reconnecting');
    }
    return this.enqueue(live, async () => {
      if (live.status.state === 'ready') return { ...live.status };
      const previous = live.status;
      live.status = { ...live.status, state: 'connecting' };
      try {
        for (const other of this.connections.values()) {
          if (other === live || other.backend?.profilePath === undefined || other.status.state === 'disconnected') continue;
          const requested = live.connection.type === 'agent-browser-profile' ? live.connection.profilePath : undefined;
          if (requested !== undefined && requested === other.backend.profilePath) {
            throw new BrowserError('browser.busy', `Profile is already held by browser connection "${other.connection.id}"`);
          }
        }
        await this.backend(live);
        const result = live.connection.type === 'agent-browser-cdp'
          ? await this.call(live, 'agent_browser_connect', { target: live.connection.endpointSecret, pinTab: true }, signal)
          : await this.call(live, 'agent_browser_open', {}, signal);
        this.assertSuccess(result);
        await this.readTabs(live);
        const info = browserResponse(await this.call(live, 'agent_browser_session_info', {}));
        live.oldPid = typeof info.data?.['pid'] === 'number' ? info.data['pid'] : undefined;
        live.admitting = true;
        live.status = { ...live.status, state: 'ready', generation: live.status.generation + 1,
          checkedAt: new Date().toISOString(), error: undefined, failure: undefined };
      } catch (error) {
        if (signal?.aborted && error === signal.reason) { live.status = { ...live.status, state: previous.state }; throw error; }
        this.fail(live, error, true);
      }
      return { ...live.status };
    }, signal);
  }

  async disconnect(id: string, signal?: AbortSignal): Promise<BrowserStatus> {
    const live = this.connections.get(id) ?? await this.live(id);
    signal?.throwIfAborted();
    if (signal === undefined) {
      live.admitting = false;
      live.status = { ...live.status, state: 'stopping' };
    }
    return this.enqueue(live, async () => {
      const previous = live.status;
      const admitting = live.admitting;
      live.admitting = false;
      live.status = { ...live.status, state: 'stopping' };
      if (live.backend === undefined) {
        live.tools = undefined;
        live.status = { ...live.status, state: 'disconnected', generation: live.status.generation + 1 };
        return { ...live.status };
      }
      try {
        const info = browserResponse(await this.call(live, 'agent_browser_session_info', {}));
        live.oldPid = typeof info.data?.['pid'] === 'number' ? info.data['pid'] : live.oldPid;
        if (info.success === true && info.data?.['active'] === false && (await this.confirmStopped(live)).state === 'disconnected') return { ...live.status };
        const response = browserResponse(await this.call(live, 'agent_browser_close', { all: false }, signal));
        if (response.success !== true || response.data?.['closed'] !== true) throw new BrowserError('browser.execution_failed', 'Browser close was not acknowledged');
        for (let attempt = 0; attempt < 10; attempt++) {
          if ((await this.confirmStopped(live)).state === 'disconnected') return { ...live.status };
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        live.status = { ...live.status, state: 'unconfirmed', failure: { code: 'browser.execution_failed', reason: 'outcome_unknown' }, error: 'Close acknowledged, but daemon termination is not confirmed. Check again before reconnecting.' };
      } catch (error) {
        if (signal?.aborted && error === signal.reason) { live.admitting = admitting; live.status = previous; throw error; }
        this.fail(live, error, true);
      }
      return { ...live.status };
    }, signal);
  }

  async tabs(id: string, signal?: AbortSignal): Promise<readonly BrowserTab[]> {
    const live = await this.live(id);
    return this.enqueue(live, () => { this.assertReady(live); return this.readTabs(live, signal); }, signal);
  }

  async invoke(input: BrowserInvocation, signal?: AbortSignal): Promise<BrowserInvocationResult> {
    if (!this.flags.enabled(NATIVE_BROWSER_FLAG_ID)) throw new BrowserError('browser.disabled', 'Native browser execution is experimental and is currently disabled', { details: { reason: 'feature_disabled' } });
    const live = await this.live(input.browser);
    return this.enqueue(live, async () => {
      this.assertReady(live);
      if (input.generation !== undefined && input.generation !== live.status.generation) {
        throw new BrowserError('browser.target', 'Browser connection was reconnected; select a tab and observe it again');
      }
      const binding = JSON.stringify([input.caller.sessionId, input.caller.agentId, input.tab, input.frame ?? 'main', live.status.generation]);
      const capture = /^agent_browser_(network_har|trace|profiler|record)_(start|stop|restart)$/.exec(input.tool);
      if (capture !== null) {
        const owner = live.captures?.get(capture[1]!);
        if (owner !== undefined && owner !== binding) throw new BrowserError('browser.busy', 'This capture belongs to another agent/tab/frame; its owner must finish it or disconnect the connection');
      }
      const refs = elementRefs(input.args);
      if (refs.length > 0 && (live.observation?.binding !== binding || refs.some((ref) => !live.observation?.refs.has(ref)))) {
        throw new BrowserError('browser.target', 'Element references no longer belong to this agent/tab/frame observation; take a fresh snapshot');
      }
      if (live.observation?.binding !== binding) live.observation = undefined;
      if (input.tab !== undefined) {
        const tabs = await this.readTabs(live, signal);
        signal?.throwIfAborted();
        const selected = tabs.find((tab) => tab.targetId === input.tab);
        if (selected === undefined) throw new BrowserError('browser.target', `Browser tab "${input.tab}" is gone; select a current targetId`);
        const frame = input.frame ?? 'main';
        if (live.target?.tab !== input.tab || selected.active === false || live.target.frame !== frame) {
          live.observation = undefined;
          if (refs.length > 0) throw new BrowserError('browser.target', 'The donor target/frame changed; take a fresh snapshot before using references');
          try {
            this.assertSuccess(await this.call(live, 'agent_browser_tab_switch', { tab: input.tab }, signal));
            this.assertSuccess(await this.call(live, 'agent_browser_frame_main', {}, signal));
            if (frame !== 'main') this.assertSuccess(await this.call(live, 'agent_browser_frame_switch', { frame }, signal));
            live.target = { tab: input.tab, frame };
          } catch (error) {
            if (signal?.aborted && error === signal.reason) { live.target = undefined; throw error; }
            this.fail(live, error, true); throw error;
          }
        }
      }
      signal?.throwIfAborted();
      live.status = { ...live.status, state: 'running', currentCall: { ...input.caller, tool: input.tool, tab: input.tab } };
      try {
        const result = await this.call(live, input.tool, input.args);
        const structured = result.structuredContent as { exitCode?: number | null; stderr?: string } | undefined;
        if (structured?.exitCode === null || /timed out/i.test(structured?.stderr ?? '') || /outcome_unknown/.test(browserResponse(result).error ?? '')) {
          throw new BrowserError('browser.execution_failed', 'The browser command timed out; its outcome is unknown and it was not replayed by Kiki');
        }
        const response = browserResponse(result);
        if (capture !== null && response.success === true) {
          live.captures ??= new Map();
          if (capture[2] === 'stop') live.captures.delete(capture[1]!);
          else live.captures.set(capture[1]!, binding);
        }
        if (input.tool === 'agent_browser_snapshot' && response.success === true) {
          const returnedRefs = response.data?.['refs'];
          live.observation = { binding, refs: new Set(returnedRefs !== null && typeof returnedRefs === 'object' ? Object.keys(returnedRefs).map((ref) => ref.replace(/^@/, '')) : []) };
        } else if (refs.length > 0 || /agent_browser_(?:open|reload|back|forward|eval|tab_|frame_|window_)/.test(input.tool)) live.observation = undefined;
        let target = input.tab;
        if (response.success === true && /agent_browser_(?:tab_new|window_new)$/.test(input.tool)) {
          const tabs = await this.readTabs(live);
          target = tabs.find((tab) => tab.tabId === response.data?.['tabId'] || tab.targetId === response.data?.['targetId'])?.targetId;
        }
        if (/agent_browser_(?:tab_|frame_|window_)/.test(input.tool)) live.target = undefined;
        live.status = { ...live.status, state: live.admitting ? 'ready' : 'stopping', currentCall: undefined, checkedAt: new Date().toISOString() };
        const backend = live.backend!;
        return { browser: input.browser, generation: live.status.generation, executionHost: live.status.executionHost,
          runtimeSession: backend.session, tab: target, frame: input.frame, result };
      } catch (error) { this.fail(live, error, true); throw error; }
    }, signal);
  }

  private async live(id: string): Promise<LiveBrowser> {
    const connection = await this.store.resolve(id);
    let live = this.connections.get(id);
    if (live !== undefined && JSON.stringify(live.connection) !== JSON.stringify(connection)) {
      live.admitting = false;
      throw new BrowserError('browser.busy', 'Browser configuration changed outside this control service; disconnect the old session before using the new endpoint');
    }
    if (live === undefined) {
      live = { connection, status: { browser: id, state: 'idle', executionHost: hostname(), generation: 0,
        ownership: connection.type === 'agent-browser-profile' ? 'managed-profile' : 'external-browser' }, tail: Promise.resolve(), admitting: false };
      this.connections.set(id, live);
    }
    return live;
  }

  private enqueue<T>(live: LiveBrowser, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const work = live.tail.then(() => { signal?.throwIfAborted(); return operation(); });
    live.tail = work.catch(() => undefined);
    return work;
  }

  private async backend(live: LiveBrowser): Promise<BrowserBackend> {
    if (live.backend === undefined) {
      live.backend = await this.factory.open(live.connection);
      live.status = { ...live.status, runtimeSession: live.backend.session, driverVersion: live.backend.version, profilePath: live.backend.profilePath };
    }
    return live.backend;
  }

  private call(live: LiveBrowser, tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<MCPToolResult> {
    const backend = live.backend;
    if (backend === undefined) throw new BrowserError('browser.disconnected', 'Browser backend is not connected');
    const extraArgs = ['--pin-tab'];
    if (live.connection.type === 'agent-browser-profile') {
      extraArgs.push('--profile', backend.profilePath!);
      if (live.connection.executablePath !== undefined) extraArgs.push('--executable-path', live.connection.executablePath);
    } else extraArgs.push('--cdp', live.connection.endpointSecret);
    signal?.throwIfAborted();
    return backend.client.callTool(tool, { ...args, session: backend.session, namespace: backend.namespace, extraArgs, timeoutMs: 120_000 });
  }

  private async readTabs(live: LiveBrowser, signal?: AbortSignal): Promise<readonly BrowserTab[]> {
    const result = await this.call(live, 'agent_browser_tab_list', {}, signal);
    this.assertSuccess(result);
    const tabs = browserResponse(result).data?.['tabs'];
    if (!Array.isArray(tabs) || tabs.some((tab) => typeof tab?.targetId !== 'string' || typeof tab?.tabId !== 'string')) {
      throw new BrowserError('browser.execution_failed', 'Browser driver returned invalid tab identities');
    }
    return tabs.map((tab) => ({ tabId: tab.tabId, targetId: tab.targetId,
      title: typeof tab.title === 'string' ? tab.title : undefined, url: typeof tab.url === 'string' ? tab.url : undefined,
      active: typeof tab.active === 'boolean' ? tab.active : undefined, label: typeof tab.label === 'string' ? tab.label : undefined }));
  }

  private assertReady(live: LiveBrowser): void {
    if (!live.connection.enabled) throw new BrowserError('browser.disabled', 'This browser connection is disabled', { details: { reason: 'connection_disabled' } });
    if (!live.admitting || live.status.state !== 'ready') throw new BrowserError('browser.disconnected', `Browser connection is ${live.status.state}; explicitly connect it before operating`);
  }

  private assertSuccess(result: MCPToolResult): void {
    const response = browserResponse(result);
    if (result.isError || response.success !== true) throw new BrowserError('browser.execution_failed', response.error ?? 'Browser driver did not confirm the operation');
  }

  private fail(live: LiveBrowser, error: unknown, unconfirmed: boolean): void {
    live.admitting = false;
    const message = error instanceof Error ? error.message : String(error);
    const endpoint = live.connection.type === 'agent-browser-cdp' ? live.connection.endpointSecret : undefined;
    live.observation = undefined;
    live.target = undefined;
    live.status = { ...live.status, state: unconfirmed && live.backend !== undefined ? 'unconfirmed' : 'failed', currentCall: undefined,
      failure: { code: error instanceof BrowserError ? error.code : 'browser.execution_failed', reason: unconfirmed && live.backend !== undefined ? 'outcome_unknown' : undefined },
      error: endpoint === undefined || (error instanceof BrowserError && error.code === 'browser.version') ? message : 'The CDP operation failed; endpoint details are withheld. Check the driver and explicitly reveal/edit the endpoint in settings.', checkedAt: new Date().toISOString() };
  }

  private async confirmStopped(live: LiveBrowser): Promise<BrowserStatus> {
    if (live.backend === undefined) return { ...live.status };
    const info = browserResponse(await this.call(live, 'agent_browser_session_info', {}));
    const data = info.data;
    let oldPidAlive = live.oldPid !== undefined;
    if (live.oldPid !== undefined) {
      try { process.kill(live.oldPid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') oldPidAlive = false; }
    }
    if (info.success === true && data?.['active'] === false && data['pid'] === null && data['runtime'] === null && !oldPidAlive) {
      await live.backend.close();
      live.backend = undefined;
      live.tools = undefined;
      live.captures = undefined;
      live.target = undefined;
      live.observation = undefined;
      live.status = { ...live.status, state: 'disconnected', generation: live.status.generation + 1, error: undefined, failure: undefined, checkedAt: new Date().toISOString() };
    }
    return { ...live.status };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.connections].map(async ([id, live]) => {
      live.admitting = false;
      try { await this.disconnect(id); }
      finally { await live.backend?.close(); }
    }));
  }
}

registerScopedService(LifecycleScope.App, IBrowserControlService, BrowserControlService, ScopeActivation.OnDemand, 'browser');
