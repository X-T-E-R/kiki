import { hostname } from 'node:os';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { MCPToolDefinition, MCPToolResult } from '#/mcpCore/types';

import { IBrowserControlService, type BrowserCaller, type BrowserInvocation, type BrowserInvocationResult, type BrowserStatus, type BrowserTab } from './browser';
import { IBrowserBackendFactory, type BrowserBackend } from './browserBackend';
import { IBrowserConnectionStore } from './browserConnectionStore';
import { browserOperationAllowed, browserSourceOfConnection, type BrowserConnectionInput, type BrowserResolvedConnection } from './browserConfig';
import { BrowserError } from './errors';
import { IFlagService } from '#/app/flag/flag';
import { NATIVE_BROWSER_FLAG_ID } from './flag';
import type { BrowserRequestContext } from './codexBrowser';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { EgoBrowserRuntime, egoTabBody, egoUserOutput } from './ego/runtime';
import { EGO_LITE_CONNECTION_ID, type EgoCliResolution } from './ego/resolveCli';
import { cdpPublicError, commandSnapshotData, commandTabsFromData, readWebbridgeStatus, sendWebbridgeCommand, webbridgeCommandCatalog, webbridgeCommandForTool, webbridgeCommandSession, WebbridgeCommandError } from './browserWebbridge';

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

function textArg(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function sameBrowserTarget(left: BrowserResolvedConnection, right: BrowserResolvedConnection): boolean {
  const { name: _leftName, enabled: _leftEnabled, ...leftTarget } = left;
  const { name: _rightName, enabled: _rightEnabled, ...rightTarget } = right;
  return JSON.stringify(leftTarget) === JSON.stringify(rightTarget);
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
export function browserManagedLifecycle(name: string): boolean {
  return /^agent_browser_(?:connect|close|tab_|frame_|window_)/.test(name) || /^(?:codex_list_tabs|codex_create_tab|codex_close_tab|codex_finalize)$/.test(name);
}
export function isBrowserOperation(name: string): boolean {
  if (name === 'codex_browser_js' || name === 'codex_browser_js_reset') return true;
  if (name.startsWith('codex_')) return !browserManagedLifecycle(name);
  return name.startsWith('agent_browser_') && !/^agent_browser_(?:tools_profiles|connect|close|tab_|frame_|window_|session(?:_|$)|profiles(?:_|$)|skills(?:_|$)|install$|upgrade$|doctor$|dashboard_|plugin(?:_|$)|plugins(?:_|$)|chat$|batch$|confirm$|deny$|auth(?:_|$)|state_(?:list|show|rename|clear|clean))/.test(name);
}
export async function admitEgoAfterAllow(
  control: IBrowserControlService,
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): Promise<void> {
  if (before === undefined || after === undefined) return;
  const prior = new Set(before);
  for (const id of after) {
    if (prior.has(id) || id !== EGO_LITE_CONNECTION_ID) continue;
    try {
      await control.connect(id);
    } catch (error) {
      const reason = error instanceof BrowserError ? error.details?.['reason'] : undefined;
      if (error instanceof BrowserError && error.code === 'browser.disabled' && (reason === 'feature_disabled' || reason === 'connection_disabled')) continue;
      throw error;
    }
  }
}

const UNCONFIRMED_RECHECK_MS = 10_000;

export function browserToolGroup(name: string): string {
  if (/network|har|headers|credentials|offline/.test(name)) return 'network';
  if (/cookies|storage|state_/.test(name)) return 'state';
  if (/react|vitals|pushstate/.test(name)) return 'react';
  if (/console|errors|trace|profiler|record|diff|a11y|inspect|highlight/.test(name)) return 'debug';
  if (/mouse|touch|swipe|viewport|device|geo|media|cua_/.test(name)) return 'input';
  return 'page';
}

export class BrowserControlService implements IBrowserControlService {
  declare readonly _serviceBrand: undefined;
  private readonly connections = new Map<string, LiveBrowser>();
  private readonly ego: EgoBrowserRuntime;
  private egoFound: Promise<EgoCliResolution> | undefined;
  private egoFoundAt = 0;
  constructor(
    @IBrowserConnectionStore private readonly store: IBrowserConnectionStore,
    @IBrowserBackendFactory private readonly factory: IBrowserBackendFactory,
    @IFlagService private readonly flags: IFlagService,
    @IHostProcessService processes: IHostProcessService,
    @IHostFileSystem files: IHostFileSystem,
  ) {
    this.ego = new EgoBrowserRuntime(processes, files);
  }

  async list() {
    const configured = await this.store.list();
    return { connections: await Promise.all(configured.connections.map(async (entry) => ({ ...entry, status: await this.status(entry.id) }))),
      defaultBrowser: configured.defaultBrowser,
      ...(configured.allowedBrowsers !== undefined ? { allowedBrowsers: configured.allowedBrowsers } : {}),
      ...(configured.disabledSources !== undefined ? { disabledSources: configured.disabledSources } : {}) };
  }

  async discover() {
    const listed = await this.store.list();
    if (listed.disabledSources?.includes('ego-lite') === true) return [];
    if (listed.connections.some((item) => item.id === EGO_LITE_CONNECTION_ID || item.type === 'ego-lite')) return [];
    const resolution = await this.egoResolution();
    if (resolution.kind !== 'found') return [];
    const status: BrowserStatus = { browser: EGO_LITE_CONNECTION_ID, state: 'idle', executionHost: hostname(), generation: 0, ownership: 'external-browser' };
    return [{ id: EGO_LITE_CONNECTION_ID, type: 'ego-lite' as const, name: 'Ego Lite', enabled: true, cliPath: resolution.path, status }];
  }

  async probeDiscovered(connect: boolean, signal?: AbortSignal): Promise<BrowserStatus> {
    const listed = await this.store.list();
    if (listed.disabledSources?.includes('ego-lite') === true) {
      throw new BrowserError('browser.disabled', 'This browser source is disabled', { details: { reason: 'connection_disabled' } });
    }
    if (!this.flags.enabled(NATIVE_BROWSER_FLAG_ID)) {
      throw new BrowserError('browser.disabled', 'Browser control is disabled', { details: { reason: 'feature_disabled' } });
    }
    const saved = listed.connections.find((item) => item.id === EGO_LITE_CONNECTION_ID && item.type === 'ego-lite');
    if (saved !== undefined) return connect ? this.connect(EGO_LITE_CONNECTION_ID, signal) : this.check(EGO_LITE_CONNECTION_ID, signal);
    signal?.throwIfAborted();
    await this.assertAllowed(EGO_LITE_CONNECTION_ID);
    const resolution = await this.egoResolution(true);
    const checkedAt = new Date().toISOString();
    if (resolution.kind !== 'found') {
      return { browser: EGO_LITE_CONNECTION_ID, state: 'requires_action', executionHost: hostname(), generation: 0, ownership: 'external-browser', checkedAt,
        failure: { code: 'browser.requires_action' }, error: resolution.kind === 'choose' ? 'Choose one Ego Lite CLI path' : 'Ego Lite is not installed' };
    }
    const draft = { id: EGO_LITE_CONNECTION_ID, type: 'ego-lite' as const, name: 'Ego Lite', enabled: true, cliPath: resolution.path };
    const probed = await this.ego.probe(draft, signal);
    if (probed.kind !== 'ready') {
      const onboarding = probed.kind === 'onboarding';
      return { browser: EGO_LITE_CONNECTION_ID, state: 'requires_action', executionHost: hostname(), generation: 0, ownership: 'external-browser', checkedAt: new Date().toISOString(),
        failure: { code: 'browser.requires_action' }, error: onboarding ? 'Please complete the onboarding process first' : 'Ego Lite is not ready' };
    }
    if (!connect) {
      return { browser: EGO_LITE_CONNECTION_ID, state: 'idle', executionHost: hostname(), generation: 0, ownership: 'external-browser', checkedAt: new Date().toISOString() };
    }
    await this.upsert(EGO_LITE_CONNECTION_ID, { type: 'ego-lite', name: 'Ego Lite', enabled: true, cliPath: resolution.path });
    this.egoFound = undefined;
    return this.egoProbe(EGO_LITE_CONNECTION_ID, signal, true);
  }

  private egoResolution(refresh = false): Promise<EgoCliResolution> {
    if (refresh || this.egoFound === undefined || Date.now() - this.egoFoundAt > 30_000) {
      this.egoFoundAt = Date.now();
      this.egoFound = this.ego.resolve(undefined).then((value) => value, () => ({ kind: 'missing' as const }));
    }
    return this.egoFound;
  }

  async upsert(id: string, input: BrowserConnectionInput) {
    if (this.connections.has(id)) {
      const status = await this.disconnect(id);
      if (status.state === 'unconfirmed') throw new BrowserError('browser.busy', 'The old browser execution session has not ended; configuration was not changed');
    }
    const record = await this.store.upsert(id, input);
    return record;
  }

  async remove(id: string): Promise<void> {
    if (this.connections.has(id) && (await this.disconnect(id)).state === 'unconfirmed') {
      throw new BrowserError('browser.busy', 'Browser execution is not confirmed stopped; the connection and profile were retained');
    }
    await this.store.remove(id);
  }

  async status(id: string): Promise<BrowserStatus> {
    const connection = await this.store.resolve(id);
    const live = this.connections.get(id);
    return live === undefined ? { browser: id, state: 'idle', executionHost: hostname(), generation: 0,
      ownership: connection.type === 'agent-browser-profile' ? 'managed-profile' : 'external-browser' } : { ...live.status };
  }

  async check(id: string, signal?: AbortSignal, context?: BrowserRequestContext): Promise<BrowserStatus> {
    const type = (await this.store.resolve(id)).type;
    if (type === 'ego-lite') return this.egoProbe(id, signal, false);
    if (type === 'webbridge-command') return this.commandCheck(id, signal);
    const live = await this.live(id);
    return this.enqueue(live, async () => {
      if (live.status.state === 'unconfirmed') return this.recheckUnconfirmed(live, signal);
      await this.assertAdmission(live);
      try {
        const backend = await this.backend(live);
        await this.assertAdmission(live);
        signal?.throwIfAborted();
        if (backend.official !== undefined) {
          await backend.official.connect(context, signal);
          live.status = { ...live.status, state: live.admitting ? 'ready' : 'idle', checkedAt: new Date().toISOString(), error: undefined, failure: undefined };
          return { ...live.status };
        }
        const result = await this.call(live, 'agent_browser_session_info', {});
        this.assertSuccess(result);
        const info = browserResponse(result);
        live.oldPid = typeof info.data?.['pid'] === 'number' ? info.data['pid'] : undefined;
        if (info.data?.['active'] === false && live.status.state === 'ready') {
          live.admitting = false;
          live.status = { ...live.status, state: 'disconnected', generation: live.status.generation + 1 };
        }
        if (live.status.state === 'ready') await this.readTabs(live);
        live.status = { ...live.status, state: live.status.state === 'failed' ? 'idle' : live.status.state,
          checkedAt: new Date().toISOString(), driverVersion: backend.version, error: undefined, failure: undefined };
      } catch (error) {
        if (signal?.aborted && error === signal.reason) throw error;
        this.fail(live, error, false);
      }
      return { ...live.status };
    }, signal);
  }

  async catalog(id: string, signal?: AbortSignal): Promise<readonly MCPToolDefinition[]> {
    const type = (await this.store.resolve(id)).type;
    if (type === 'ego-lite') return [];
    if (type === 'webbridge-command') return webbridgeCommandCatalog();
    const live = await this.live(id);
    return this.enqueue(live, async () => {
      if (live.tools !== undefined) return live.tools;
      const backend = await this.backend(live);
      signal?.throwIfAborted();
      live.tools = await backend.client.listTools();
      return live.tools;
    }, signal);
  }

  async connect(id: string, signal?: AbortSignal, context?: BrowserRequestContext): Promise<BrowserStatus> {
    const type = (await this.store.resolve(id)).type;
    if (type === 'ego-lite') return this.egoProbe(id, signal, true);
    if (type === 'webbridge-command') return this.commandConnect(id, signal);
    const live = await this.live(id);
    await this.assertAdmission(live);
    return this.enqueue(live, async () => {
      await this.assertAdmission(live);
      if (live.status.state === 'unconfirmed' || live.status.state === 'stopping') {
        throw new BrowserError('browser.busy', 'The old daemon has not been confirmed stopped; check or disconnect it before reconnecting');
      }
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
        const backend = await this.backend(live);
        await this.assertAdmission(live);
        if (backend.official !== undefined) {
          await backend.official.connect(context, signal);
          await backend.official.tabs(context, signal);
        } else {
          const result = live.connection.type === 'agent-browser-cdp'
            ? await this.call(live, 'agent_browser_connect', { target: live.connection.endpointSecret, pinTab: true }, signal)
            : await this.call(live, 'agent_browser_open', {}, signal);
          this.assertSuccess(result);
          await this.readTabs(live);
          const info = browserResponse(await this.call(live, 'agent_browser_session_info', {}));
          live.oldPid = typeof info.data?.['pid'] === 'number' ? info.data['pid'] : undefined;
        }
        live.admitting = true;
        live.status = { ...live.status, state: 'ready', generation: live.status.generation + 1,
          checkedAt: new Date().toISOString(), error: undefined, failure: undefined };
      } catch (error) {
        if (signal?.aborted && error === signal.reason) {
          if (live.backend?.official !== undefined) this.fail(live, error, true);
          else live.status = { ...live.status, state: previous.state };
          throw error;
        }
        this.fail(live, error, true);
      }
      return { ...live.status };
    }, signal);
  }

  async disconnect(id: string, signal?: AbortSignal): Promise<BrowserStatus> {
    const resolved = await this.store.resolve(id);
    if (resolved.type === 'webbridge-command') return this.commandDisconnect(id, signal);
    if (resolved.type === 'ego-lite') {
      signal?.throwIfAborted();
      const live = await this.live(id);
      live.admitting = false;
      live.status = { ...live.status, state: 'disconnected', generation: live.status.generation + 1, currentCall: undefined, checkedAt: new Date().toISOString(), error: undefined, failure: undefined };
      this.ego.abort(id);
      return { ...live.status };
    }
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
        if (live.backend.official !== undefined) return await this.closeOfficial(live);
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

  private async assertAdmission(live: LiveBrowser): Promise<void> {
    const current = await this.store.resolve(live.connection.id);
    if (!this.flags.enabled(NATIVE_BROWSER_FLAG_ID)) throw new BrowserError('browser.disabled', 'Browser control is disabled', { details: { reason: 'feature_disabled' } });
    if (!current.enabled) throw new BrowserError('browser.disabled', 'This browser connection is disabled', { details: { reason: 'connection_disabled' } });
    const listed = await this.store.list();
    if (listed.disabledSources?.includes(browserSourceOfConnection(current)) === true) {
      throw new BrowserError('browser.disabled', 'This browser source is disabled', { details: { reason: 'connection_disabled' } });
    }
    if (!sameBrowserTarget(current, live.connection)) throw new BrowserError('browser.busy', 'Browser configuration changed; disconnect the old session before using the new endpoint');
    live.connection = current;
    await this.assertAllowed(current.id);
  }

  private async assertAllowed(id: string): Promise<void> {
    const listed = await this.store.list();
    if (browserOperationAllowed(listed.allowedBrowsers, id)) return;
    const visible = listed.connections.map((connection) => ({ id: connection.id, type: connection.type, enabled: connection.enabled, allowed: browserOperationAllowed(listed.allowedBrowsers, connection.id) }));
    throw new BrowserError('browser.disabled', `Browser "${id}" is not in the allowed set. List and discover stay available. Connections: ${JSON.stringify(visible)}`, { details: { reason: 'not_allowed' } });
  }

  async tabs(id: string, signal?: AbortSignal, context?: BrowserRequestContext): Promise<readonly BrowserTab[]> {
    const type = (await this.store.resolve(id)).type;
    if (type === 'ego-lite') return this.egoTabs(id, signal, context);
    if (type === 'webbridge-command') return this.commandListTabs(id, signal);
    const live = await this.live(id);
    return this.enqueue(live, async () => {
      await this.assertAdmission(live);
      this.assertReady(live);
      return live.backend?.official?.tabs(context, signal) ?? this.readTabs(live, signal);
    }, signal);
  }

  async invoke(input: BrowserInvocation, signal?: AbortSignal): Promise<BrowserInvocationResult> {
    const type = (await this.store.resolve(input.browser)).type;
    if (type === 'ego-lite') return this.egoInvoke(input, signal);
    if (type === 'webbridge-command') return this.commandInvoke(input, signal);
    const live = await this.live(input.browser);
    await this.assertAdmission(live);
    return this.enqueue(live, async () => {
      await this.assertAdmission(live);
      input.assertToolAllowed?.();
      this.assertReady(live);
      if (input.generation !== undefined && input.generation !== live.status.generation) {
        throw new BrowserError('browser.target', 'Browser connection was reconnected; select a tab and observe it again');
      }
      if (live.backend?.official !== undefined) {
        if (input.frame !== undefined && input.frame !== 'main') throw new BrowserError('browser.unsupported', 'Use the official runtime documentation for frame operations');
        if (input.tool !== 'codex_browser_js_reset' && input.tab !== undefined && !(await live.backend.official.tabs(input.requestContext, signal)).some((tab) => tab.targetId === input.tab)) throw new BrowserError('browser.target', 'The selected official tab is no longer available');
        await this.assertAdmission(live);
        input.assertToolAllowed?.();
        signal?.throwIfAborted();
        live.status = { ...live.status, state: 'running', currentCall: { ...input.caller, tool: input.tool, tab: input.tab } };
        try {
          const result = await live.backend.official.invoke(input.tool, input.args, input.tab, input.requestContext, signal);
          live.status = { ...live.status, state: live.admitting ? 'ready' : 'stopping', currentCall: undefined, checkedAt: new Date().toISOString() };
          const target = browserResponse(result).data?.['targetId'];
          return { browser: input.browser, generation: live.status.generation, executionHost: live.status.executionHost,
            runtimeSession: live.backend.session, tab: typeof target === 'string' ? target : input.tab, frame: input.frame, result };
        } catch (error) { this.fail(live, error, true); throw error; }
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
        await this.assertAdmission(live);
        input.assertToolAllowed?.();
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
      await this.assertAdmission(live);
      input.assertToolAllowed?.();
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
    if (live !== undefined) {
      if (!sameBrowserTarget(live.connection, connection)) {
        live.admitting = false;
        if (live.backend !== undefined || !['idle', 'disconnected', 'failed'].includes(live.status.state)) {
          throw new BrowserError('browser.busy', 'Browser configuration changed outside this control service; disconnect the old session before using the new endpoint');
        }
        live.status = { browser: id, state: 'idle', executionHost: hostname(), generation: live.status.generation,
          ownership: connection.type === 'agent-browser-profile' ? 'managed-profile' : 'external-browser' };
      }
      live.connection = connection;
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
    } else if (live.connection.type === 'agent-browser-cdp') extraArgs.push('--cdp', live.connection.endpointSecret);
    else throw new BrowserError('browser.unsupported', 'The official extension does not use agent-browser commands');
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
    const recovery = error instanceof BrowserError && error.code === 'browser.requires_action' ? 'requires_action'
      : error instanceof BrowserError && error.code === 'browser.unsupported' ? 'unsupported' : undefined;
    live.status = { ...live.status, state: recovery ?? (unconfirmed && live.backend !== undefined ? 'unconfirmed' : 'failed'), currentCall: undefined,
      failure: { code: error instanceof BrowserError ? error.code : 'browser.execution_failed', reason: recovery === undefined && unconfirmed && live.backend !== undefined ? 'outcome_unknown' : undefined },
      error: endpoint === undefined || (error instanceof BrowserError && error.code === 'browser.version') ? message : cdpPublicError(endpoint, 'The CDP operation failed; endpoint details are withheld. Check the driver and explicitly reveal/edit the endpoint in settings.'), checkedAt: new Date().toISOString() };
  }

  private async closeOfficial(live: LiveBrowser): Promise<BrowserStatus> {
    await live.backend!.close();
    live.backend = undefined;
    live.tools = undefined;
    live.observation = undefined;
    live.target = undefined;
    live.status = { ...live.status, state: 'disconnected', generation: live.status.generation + 1, error: undefined, failure: undefined, checkedAt: new Date().toISOString() };
    return { ...live.status };
  }

  private daemonStopped(info: { readonly success?: boolean; readonly data?: Record<string, unknown> }, oldPid: number | undefined): boolean {
    const data = info.data;
    let oldPidAlive = oldPid !== undefined;
    if (oldPid !== undefined) {
      try { process.kill(oldPid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') oldPidAlive = false; }
    }
    return info.success === true && data?.['active'] === false && data['pid'] === null && data['runtime'] === null && !oldPidAlive;
  }

  private async confirmStopped(live: LiveBrowser): Promise<BrowserStatus> {
    const backend = live.backend;
    if (backend === undefined) return { ...live.status };
    if (backend.official !== undefined) return this.closeOfficial(live);
    const generation = live.status.generation;
    const info = browserResponse(await this.call(live, 'agent_browser_session_info', {}));
    if (this.daemonStopped(info, live.oldPid)) await this.markDaemonStopped(live, backend, generation);
    return { ...live.status };
  }

  private async markDaemonStopped(
    live: LiveBrowser,
    backend: BrowserBackend,
    generation: number,
    gate?: { readonly open: boolean },
  ): Promise<void> {
    await backend.close();
    if (gate?.open === false || live.backend !== backend || live.status.generation !== generation) return;
    live.backend = undefined;
    live.tools = undefined;
    live.captures = undefined;
    live.target = undefined;
    live.observation = undefined;
    live.status = { ...live.status, state: 'disconnected', generation: generation + 1, error: undefined, failure: undefined, checkedAt: new Date().toISOString() };
  }

  private limit<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | 'timeout'> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => finish(() => reject(signal?.reason ?? new Error('The browser check was cancelled')));
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        settle();
      };
      timer = setTimeout(() => finish(() => resolve('timeout')), ms);
      timer.unref?.();
      if (signal?.aborted === true) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      work.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
    });
  }

  private async executionVerdict(live: LiveBrowser, signal: AbortSignal | undefined, gate: { open: boolean }): Promise<'stopped' | 'alive'> {
    const backend = live.backend;
    const generation = live.status.generation;
    if (backend === undefined) {
      if (gate.open) live.status = { ...live.status, state: 'disconnected', generation: generation + 1, error: undefined, failure: undefined, checkedAt: new Date().toISOString() };
      return 'stopped';
    }
    if (backend.official !== undefined) {
      await backend.official.tabs(undefined, signal);
      return 'alive';
    }
    const info = browserResponse(await this.call(live, 'agent_browser_session_info', {}, signal));
    if (this.daemonStopped(info, live.oldPid)) {
      await this.markDaemonStopped(live, backend, generation, gate);
      return 'stopped';
    }
    if (info.success === true && info.data?.['active'] === true) return 'alive';
    throw new BrowserError('browser.execution_failed', 'Browser check did not confirm the execution state');
  }

  private async recheckUnconfirmed(live: LiveBrowser, signal?: AbortSignal): Promise<BrowserStatus> {
    signal?.throwIfAborted();
    const gate = { open: true };
    try {
      const verdict = await this.limit(this.executionVerdict(live, signal, gate), UNCONFIRMED_RECHECK_MS, signal);
      gate.open = false;
      if (verdict === 'timeout') {
        live.status = { ...live.status, state: 'unconfirmed', currentCall: undefined, checkedAt: new Date().toISOString(),
          failure: { code: 'browser.execution_failed', reason: 'outcome_unknown' },
          error: 'The browser check timed out. The previous command was not replayed and the browser was left running.' };
        return { ...live.status };
      }
      if (verdict === 'stopped') return { ...live.status };
      live.observation = undefined;
      live.target = undefined;
      live.admitting = false;
      live.status = { ...live.status, state: 'idle', generation: live.status.generation + 1, currentCall: undefined, checkedAt: new Date().toISOString(),
        failure: { code: 'browser.execution_failed', reason: 'outcome_unknown' },
        error: 'The browser is still running. The timed-out command was not replayed. Connect again and select the tab before the next action.' };
      return { ...live.status };
    } catch (error) {
      gate.open = false;
      if (signal?.aborted === true) throw error;
      live.status = { ...live.status, state: 'unconfirmed', currentCall: undefined, checkedAt: new Date().toISOString(),
        failure: { code: 'browser.execution_failed', reason: 'outcome_unknown' },
        error: 'The browser check did not confirm the execution state. The previous command was not replayed and the browser was left running.' };
      return { ...live.status };
    }
  }

  private async egoProbe(id: string, signal: AbortSignal | undefined, connect: boolean): Promise<BrowserStatus> {
    const live = await this.live(id);
    await this.assertAdmission(live);
    signal?.throwIfAborted();
    try {
      const probed = await this.ego.probe(live.connection, signal);
      const checkedAt = new Date().toISOString();
      if (probed.kind === 'ready') {
        if (connect) {
          live.admitting = true;
          this.ego.arm(id);
        }
        live.status = { ...live.status, state: connect || live.admitting ? 'ready' : live.status.state === 'failed' ? 'idle' : live.status.state,
          checkedAt, error: undefined, failure: undefined, ...(connect ? { generation: live.status.generation + 1 } : {}) };
        return { ...live.status };
      }
      live.admitting = false;
      const onboarding = probed.kind === 'onboarding';
      const choose = probed.kind === 'choose' || probed.kind === 'missing';
      live.status = { ...live.status, state: onboarding || choose ? 'requires_action' : 'failed', checkedAt,
        failure: { code: onboarding || choose ? 'browser.requires_action' : 'browser.execution_failed' },
        error: onboarding ? 'Please complete the onboarding process first' : choose ? probed.kind === 'missing' ? 'Ego Lite is not installed' : 'Choose one Ego Lite CLI path' : 'Ego Lite is not ready' };
      return { ...live.status };
    } catch (error) {
      if (signal?.aborted && error === signal.reason) throw error;
      this.fail(live, error, false);
      return { ...live.status };
    }
  }

  private async egoTabs(id: string, signal: AbortSignal | undefined, context?: BrowserRequestContext): Promise<readonly BrowserTab[]> {
    const live = await this.live(id);
    await this.assertAdmission(live);
    this.assertReady(live);
    if (context?.sessionDir === undefined) throw new BrowserError('browser.invalid', 'Ego Lite tabs need the agent session directory');
    const ran = await this.ego.runAgent({ connection: live.connection, sessionDir: context.sessionDir, sessionId: context.caller.sessionId, agentId: context.caller.agentId, body: egoTabBody('list'), signal });
    if (ran.tabs === undefined) throw new BrowserError('browser.execution_failed', 'Ego Lite did not return tabs');
    return ran.tabs;
  }

  private async egoInvoke(input: BrowserInvocation, signal?: AbortSignal): Promise<BrowserInvocationResult> {
    const live = await this.live(input.browser);
    await this.assertAdmission(live);
    input.assertToolAllowed?.();
    signal?.throwIfAborted();
    if (input.tool === 'agent_browser_window_new' || /^agent_browser_(?:window_|frame_)/.test(input.tool)) {
      throw new BrowserError('browser.unsupported', 'The Ego Lite Page API has no window or frame method');
    }
    this.assertReady(live);
    const sessionDir = input.requestContext?.sessionDir;
    if (sessionDir === undefined) throw new BrowserError('browser.invalid', 'Ego Lite scripts need the session directory');
    const action = input.tool === 'agent_browser_tab_new' ? 'open' : input.tool === 'agent_browser_tab_switch' ? 'select' : input.tool === 'agent_browser_tab_close' ? 'close' : input.tool === 'browser__ego_run' ? 'script' : undefined;
    if (action === undefined) throw new BrowserError('browser.unsupported', `Ego Lite does not run ${input.tool}`);
    const label = action === 'open' || action === 'script' ? input.tab : textArg(input.args, 'tab') ?? input.tab;
    const body = action === 'script' ? textArg(input.args, 'script') : egoTabBody(action);
    if (body === undefined || body === '') throw new BrowserError('browser.invalid', 'Ego Lite script is required');
    const startedGeneration = live.status.generation;
    live.status = { ...live.status, state: 'running', currentCall: { ...input.caller, tool: input.tool, tab: label } };
    try {
      const ran = await this.ego.runAgent({
        connection: live.connection, sessionDir, sessionId: input.caller.sessionId, agentId: input.caller.agentId,
        ...(action !== 'open' && label !== undefined ? { label } : {}),
        ...(action === 'open' && textArg(input.args, 'url') !== undefined ? { url: textArg(input.args, 'url') } : {}),
        body, signal,
      });
      if (live.status.generation !== startedGeneration) throw new BrowserError('browser.disconnected', 'Ego Lite connection was disconnected');
      if (ran.refused) throw new BrowserError('browser.target', 'Only an agent-opened labeled Ego Lite tab can be closed');
      if (ran.result.code !== 0) throw new BrowserError('browser.execution_failed', ran.result.stderr.trim() || ran.result.stdout.trim() || 'Ego Lite script failed');
      live.status = { ...live.status, state: live.admitting ? 'ready' : 'stopping', currentCall: undefined, checkedAt: new Date().toISOString() };
      return { browser: input.browser, generation: live.status.generation, executionHost: live.status.executionHost, runtimeSession: ran.binding.spaceId ?? ran.binding.name,
        tab: ran.pageLabel ?? label, result: { isError: false, content: [{ type: 'text', text: egoUserOutput(ran.result) }], structuredContent: { response: { success: true, data: { label: ran.pageLabel, spaceId: ran.binding.spaceId, shots: ran.shots } } } } };
    } catch (error) {
      if (live.status.generation !== startedGeneration) throw error;
      if (signal?.aborted && error === signal.reason) {
        live.status = { ...live.status, state: live.admitting ? 'ready' : live.status.state, currentCall: undefined };
        throw error;
      }
      if (error instanceof BrowserError && error.code !== 'browser.disabled') {
        live.status = { ...live.status, state: live.admitting ? 'ready' : 'failed', currentCall: undefined, error: error.message, failure: { code: error.code } };
        throw error;
      }
      this.fail(live, error, false);
      throw error;
    }
  }

  private async commandCheck(id: string, signal?: AbortSignal): Promise<BrowserStatus> {
    const live = await this.live(id);
    return this.enqueue(live, async () => {
      await this.assertAdmission(live);
      signal?.throwIfAborted();
      if (live.status.state === 'unconfirmed') return this.commandRecheck(live);
      const bridge = await readWebbridgeStatus();
      const usable = bridge?.running === true && bridge.extensionConnected === true;
      const checkedAt = new Date().toISOString();
      if (live.admitting && live.status.state === 'ready' && !usable) {
        live.admitting = false;
        live.observation = undefined;
        live.target = undefined;
        live.status = { ...live.status, state: 'disconnected', generation: live.status.generation + 1, checkedAt, currentCall: undefined,
          error: 'WebBridge is not ready. No page command was sent.', failure: undefined };
        return { ...live.status };
      }
      if (usable && (live.status.state === 'ready' || live.status.state === 'failed')) {
        live.status = { ...live.status, state: live.status.state === 'failed' ? 'idle' : live.status.state, checkedAt, currentCall: undefined,
          error: undefined, failure: undefined, driverVersion: bridge?.version };
        return { ...live.status };
      }
      live.status = { ...live.status, checkedAt, ...(bridge?.version !== undefined ? { driverVersion: bridge.version } : {}) };
      return { ...live.status };
    }, signal);
  }

  private async commandRecheck(live: LiveBrowser): Promise<BrowserStatus> {
    const bridge = await readWebbridgeStatus();
    const checkedAt = new Date().toISOString();
    live.observation = undefined;
    live.target = undefined;
    live.admitting = false;
    if (bridge?.running !== true) {
      live.status = { ...live.status, state: 'disconnected', generation: live.status.generation + 1, checkedAt, currentCall: undefined,
        failure: undefined, error: 'The previous command was not replayed.' };
      return { ...live.status };
    }
    live.status = { ...live.status, state: 'idle', generation: live.status.generation + 1, checkedAt, currentCall: undefined,
      failure: { code: 'browser.execution_failed', reason: 'outcome_unknown' },
      error: 'The previous command was not replayed. Connect again before the next action.' };
    return { ...live.status };
  }

  private async commandConnect(id: string, signal?: AbortSignal): Promise<BrowserStatus> {
    const live = await this.live(id);
    await this.assertAdmission(live);
    return this.enqueue(live, async () => {
      await this.assertAdmission(live);
      if (live.status.state === 'unconfirmed' || live.status.state === 'stopping') {
        throw new BrowserError('browser.busy', 'The old daemon has not been confirmed stopped; check or disconnect it before reconnecting');
      }
      if (live.status.state === 'ready') return { ...live.status };
      live.status = { ...live.status, state: 'connecting' };
      try {
        signal?.throwIfAborted();
        const session = webbridgeCommandSession(id);
        const data = await sendWebbridgeCommand({ action: 'list_tabs', args: {}, session, signal });
        commandTabsFromData(data);
        live.admitting = true;
        live.tools = webbridgeCommandCatalog();
        live.status = { ...live.status, state: 'ready', generation: live.status.generation + 1, runtimeSession: session,
          checkedAt: new Date().toISOString(), error: undefined, failure: undefined };
      } catch (error) {
        if (signal?.aborted === true && !(error instanceof WebbridgeCommandError)) {
          live.status = { ...live.status, state: 'idle', currentCall: undefined };
          throw error;
        }
        this.commandFail(live, error);
      }
      return { ...live.status };
    }, signal);
  }

  private async commandDisconnect(id: string, signal?: AbortSignal): Promise<BrowserStatus> {
    const live = await this.live(id);
    signal?.throwIfAborted();
    live.admitting = false;
    live.tools = undefined;
    live.observation = undefined;
    live.target = undefined;
    live.status = { ...live.status, state: 'disconnected', generation: live.status.generation + 1, currentCall: undefined,
      checkedAt: new Date().toISOString(), error: undefined, failure: undefined };
    return { ...live.status };
  }

  private async commandListTabs(id: string, signal?: AbortSignal): Promise<readonly BrowserTab[]> {
    const live = await this.live(id);
    return this.enqueue(live, async () => {
      await this.assertAdmission(live);
      this.assertReady(live);
      try {
        const data = await sendWebbridgeCommand({ action: 'list_tabs', args: {}, session: webbridgeCommandSession(id), signal });
        return commandTabsFromData(data);
      } catch (error) {
        this.commandFail(live, error);
        throw this.commandError(error);
      }
    }, signal);
  }

  private commandResult(live: LiveBrowser, session: string, input: BrowserInvocation, data: Record<string, unknown>, tab: string | undefined): BrowserInvocationResult {
    return { browser: input.browser, generation: live.status.generation, executionHost: live.status.executionHost,
      runtimeSession: session, tab, frame: input.frame,
      result: { isError: false, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { response: { success: true, data } } } };
  }

  private async commandInvoke(input: BrowserInvocation, signal?: AbortSignal): Promise<BrowserInvocationResult> {
    const live = await this.live(input.browser);
    await this.assertAdmission(live);
    input.assertToolAllowed?.();
    return this.enqueue(live, async () => {
      await this.assertAdmission(live);
      input.assertToolAllowed?.();
      this.assertReady(live);
      if (input.generation !== undefined && input.generation !== live.status.generation) {
        throw new BrowserError('browser.target', 'Browser connection was reconnected; select a tab and observe it again');
      }
      if (input.tool === 'agent_browser_window_new' || /^agent_browser_(?:window_|frame_)/.test(input.tool)) {
        throw new BrowserError('browser.unsupported', 'The WebBridge command connection has no window or frame method');
      }
      const binding = JSON.stringify([input.caller.sessionId, input.caller.agentId, input.tab, input.frame ?? 'main', live.status.generation]);
      const refs = elementRefs(input.args);
      if (refs.length > 0 && (live.observation?.binding !== binding || refs.some((ref) => !live.observation?.refs.has(ref)))) {
        throw new BrowserError('browser.target', 'Element references no longer belong to this agent/tab/frame observation; take a fresh snapshot');
      }
      const session = webbridgeCommandSession(live.connection.id);
      live.status = { ...live.status, state: 'running', currentCall: { ...input.caller, tool: input.tool, tab: input.tab } };
      try {
        signal?.throwIfAborted();
        let data: Record<string, unknown>;
        let target = input.tab;
        if (input.tool === 'agent_browser_tab_switch' || input.tool === 'agent_browser_tab_close') {
          let page = textArg(input.args, 'url');
          if (page === undefined) {
            const tabs = commandTabsFromData(await sendWebbridgeCommand({ action: 'list_tabs', args: {}, session, signal }));
            page = tabs.find((tab) => tab.targetId === (textArg(input.args, 'tab') ?? input.tab))?.url;
          }
          if (page === undefined || page === '') throw new BrowserError('browser.target', 'Use a current targetId from BrowserTabs list, not a positional tab number or label');
          data = await sendWebbridgeCommand({ action: 'find_tab', args: { url: page }, session, signal });
          if (input.tool === 'agent_browser_tab_close') data = await sendWebbridgeCommand({ action: 'close_tab', args: {}, session, signal });
          live.observation = undefined;
          live.target = undefined;
        } else {
          const mapped = webbridgeCommandForTool(input.tool, input.args);
          if (mapped.kind === 'unsupported') throw new BrowserError('browser.unsupported', `WebBridge command does not run ${input.tool}`);
          if (mapped.kind === 'invalid') throw new BrowserError('browser.invalid', mapped.message);
          data = await sendWebbridgeCommand({ action: mapped.action, args: mapped.args, session, signal });
          if (mapped.action === 'snapshot') data = commandSnapshotData(data);
          if (mapped.action === 'navigate' || mapped.action === 'close_session') {
            live.observation = undefined;
            const opened = data['tabId'];
            if (typeof opened === 'number' || typeof opened === 'string') target = String(opened);
          }
        }
        if (input.tool === 'agent_browser_snapshot') {
          const returned = data['refs'];
          live.observation = { binding, refs: new Set(returned !== null && typeof returned === 'object' ? Object.keys(returned).map((ref) => ref.replace(/^@/, '')) : []) };
        } else if (refs.length > 0) live.observation = undefined;
        live.status = { ...live.status, state: live.admitting ? 'ready' : 'stopping', currentCall: undefined, checkedAt: new Date().toISOString() };
        return this.commandResult(live, session, input, data, target);
      } catch (error) {
        if (signal?.aborted === true && !(error instanceof WebbridgeCommandError) && !(error instanceof BrowserError)) {
          live.status = { ...live.status, state: live.admitting ? 'ready' : live.status.state, currentCall: undefined };
          throw error;
        }
        if (error instanceof BrowserError && (error.code === 'browser.unsupported' || error.code === 'browser.target' || error.code === 'browser.invalid')) {
          live.status = { ...live.status, state: live.admitting ? 'ready' : live.status.state, currentCall: undefined };
          throw error;
        }
        this.commandFail(live, error);
        throw this.commandError(error);
      }
    }, signal);
  }

  private commandError(error: unknown): BrowserError {
    if (error instanceof BrowserError) return error;
    const lost = error instanceof WebbridgeCommandError && error.kind === 'lost';
    return new BrowserError('browser.execution_failed', error instanceof Error ? error.message : String(error), lost ? { details: { reason: 'outcome_unknown' } } : undefined);
  }

  private commandFail(live: LiveBrowser, error: unknown): void {
    live.admitting = false;
    live.observation = undefined;
    live.target = undefined;
    const lost = error instanceof WebbridgeCommandError && error.kind === 'lost';
    live.status = { ...live.status, state: lost ? 'unconfirmed' : 'failed', currentCall: undefined,
      failure: { code: error instanceof BrowserError ? error.code : 'browser.execution_failed', reason: lost ? 'outcome_unknown' : undefined },
      error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
  }

  async endTurn(caller: BrowserCaller, turnId?: number): Promise<void> {
    for (const live of this.connections.values()) {
      await this.enqueue(live, async () => {
        if (live.backend?.official === undefined) return;
        try { await live.backend.official.endTurn(caller, turnId); }
        catch (error) { this.fail(live, error, true); }
      });
    }
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
