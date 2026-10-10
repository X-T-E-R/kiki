import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { abortable } from '#/_base/utils/abort';

import type { MCPClient, MCPToolDefinition, MCPToolResult } from '#/mcpCore/types';
import type { Runtime } from '#/runtime/runtime';
import { StdioMcpClient } from '#/mcpCore/client-stdio';
import type { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import type { BrowserBackend } from './browserBackend';
import type { BrowserCaller, BrowserTab } from './browser';
import { BrowserError } from './errors';

export interface BrowserRequestContext {
  readonly caller: BrowserCaller;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly elicit: (request: ElicitRequest['params'], signal: AbortSignal) => Promise<ElicitResult>;
}

export interface CodexBrowserBackend {
  connect(context?: BrowserRequestContext, signal?: AbortSignal): Promise<void>;
  tabs(context?: BrowserRequestContext, signal?: AbortSignal): Promise<readonly BrowserTab[]>;
  invoke(tool: string, args: Readonly<Record<string, unknown>>, tab: string | undefined, context?: BrowserRequestContext, signal?: AbortSignal): Promise<MCPToolResult>;
  endTurn(caller: BrowserCaller, turnId?: number): Promise<void>;
}

export function codexTurnMetadata(context: BrowserRequestContext): Record<string, unknown> {
  return { 'x-codex-turn-metadata': JSON.stringify({
    session_id: `kiki:${context.caller.sessionId}:${context.caller.agentId}`,
    turn_id: `kiki:${context.turnId}`,
  }), 'kiki/caller': { ...context.caller, turnId: context.turnId, toolCallId: context.toolCallId } };
}

export function codexBrowserRuntimeResolver(resolver: IRuntimeResolver, env: Record<string, string>): IRuntimeResolver {
  return { _serviceBrand: undefined, inspect: (binding) => resolver.inspect(binding), acquire: (binding, required) => {
    const lease = resolver.acquire(binding, required);
    const processService = lease.runtime.process;
    if (processService === undefined) { lease.dispose(); throw new BrowserError('browser.execution_failed', 'The official browser runtime requires a local process service'); }
    const runtime: Runtime = Object.assign(Object.create(lease.runtime) as Runtime, { process: {
      ...processService, spawn: (command: string, args: readonly string[], options: Parameters<typeof processService.spawn>[2]) => {
        const inherited = options?.env ?? {};
        const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(NODE_REPL_|CUA_REPL_|BROWSER_USE_|ENABLE_BROWSER_SESSION_TAB_OWNERSHIP$)/i.test(key)));
        const envUnset = Object.keys(inherited).filter((key) => /^(NODE_REPL_|CUA_REPL_|BROWSER_USE_|ENABLE_BROWSER_SESSION_TAB_OWNERSHIP$)/i.test(key) && !(key in env));
        return processService.spawn(command, args, { ...options, env: { ...clean, ...env }, envUnset: [...options?.envUnset ?? [], ...envUnset] });
      },
    } });
    return { runtime, track: (resource) => lease.track(resource), dispose: () => lease.dispose() };
  } };
}

export async function openCodexBrowser(input: { runtimeRoot: string; browserId: string; cwd: string; runtime: Runtime; resolver: IRuntimeResolver }): Promise<BrowserBackend> {
  const { runtime } = input;
  if (runtime.fs === undefined) throw new BrowserError('browser.execution_failed', 'The official browser runtime requires the Kiki host filesystem');
  const root = runtime.path.resolve(input.runtimeRoot);
  const packageRoot = runtime.path.join(root, 'bin', 'node_modules', '@oai', 'cua-repl');
  let manifest: Record<string, unknown>;
  let pkg: Record<string, unknown>;
  try {
    manifest = JSON.parse(await runtime.fs.readText(runtime.path.join(root, 'manifest.json')));
    pkg = JSON.parse(await runtime.fs.readText(runtime.path.join(packageRoot, 'package.json')));
  } catch (cause) {
    throw new BrowserError('browser.requires_action', 'Select an installed Codex cua_node runtime containing @oai/cua-repl. Install or update Codex yourself; Kiki does not download or configure Chrome.', { cause });
  }
  if (runtime.environment.osKind !== 'Windows' || manifest['platform'] !== 'windows' || pkg['name'] !== '@oai/cua-repl' || pkg['version'] !== '0.1.0' || typeof manifest['runtime_archive_version'] !== 'string') {
    throw new BrowserError('browser.unsupported', 'This installed runtime does not match the supported Windows @oai/cua-repl 0.1.0 launch contract');
  }
  const env = { CUA_REPL_NODE_REPL_PATH: runtime.path.join(root, 'bin', 'node_repl.exe'), CUA_REPL_ENABLED_SURFACES: 'browser', CUA_REPL_BROWSER_ENV: 'codex-app' };
  const client = new StdioMcpClient({ transport: 'stdio', command: runtime.path.join(root, 'bin', 'node.exe'),
    args: [runtime.path.join(packageRoot, 'bin', 'cua-repl.mjs')], env, executor: 'local' }, {
    runtimeResolver: codexBrowserRuntimeResolver(input.resolver, env), workspaceId: runtime.identity.workspaceId,
    runtimeId: runtime.identity.runtimeId, defaultCwd: input.cwd, startupTimeoutMs: 30_000, toolCallTimeoutMs: 60_000,
    computerControl: true, computerDirect: true, elicitation: true,
  });
  try {
    await client.connect();
    const tools = await client.listTools();
    const adapter = new OfficialCodexBrowser(client, input.browserId, tools);
    return { client: adapter.client, official: adapter, runtime, session: `codex-browser-${randomUUID()}`, namespace: 'official-cua-repl',
      version: `@oai/cua-repl ${pkg['version']} (${manifest['runtime_archive_version']})`, close: async () => {
        try { await adapter.prepareClose(); } finally { await client.close(); }
      } };
  } catch (error) { await client.close(); throw error; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class OfficialCodexBrowser implements CodexBrowserBackend {
  readonly client: MCPClient;
  private readonly js: MCPToolDefinition;
  private readonly reset: MCPToolDefinition;
  private readonly turns = new Map<string, BrowserRequestContext>();
  private readonly ended = new Map<string, Promise<void>>();
  private readonly lifetime = new AbortController();
  private sentWork?: Promise<MCPToolResult>;
  private uncertain = false;
  private closing = false;
  private closeWork?: Promise<void>;
  private sequence = 0;
  constructor(private readonly transport: MCPClient, private readonly browserId: string, tools: readonly MCPToolDefinition[]) {
    const js = tools.find((tool) => tool.name === 'js');
    const reset = tools.find((tool) => tool.name === 'js_reset');
    if (js === undefined || reset === undefined || !tools.some((tool) => tool.name === 'turn_ended')) {
      throw new BrowserError('browser.unsupported', 'The official launcher did not expose js, js_reset and turn_ended');
    }
    this.js = js;
    this.reset = reset;
    this.client = { listTools: async () => [{ ...js, name: 'codex_browser_js' }, { ...reset, name: 'codex_browser_js_reset' }], ping: (signal) => transport.ping(signal),
      callTool: async () => { throw new BrowserError('browser.requires_action', 'Official browser calls need a Kiki caller and approval interaction'); } };
  }

  async endTurn(caller: BrowserCaller, turnId?: number): Promise<void> {
    const matching = [...this.turns.values()].filter((ctx) => ctx.caller.sessionId === caller.sessionId && ctx.caller.agentId === caller.agentId && (turnId === undefined || ctx.turnId === turnId));
    for (const ctx of matching) await this.finishTurn(ctx, turnId === undefined ? 'agent.closed' : 'turn.ended');
  }

  prepareClose(): Promise<void> {
    if (this.closeWork !== undefined) return this.closeWork;
    this.closing = true;
    this.lifetime.abort();
    this.closeWork = (async () => {
      try {
        await this.sentWork;
        await Promise.all(this.ended.values());
        for (const ctx of this.turns.values()) await this.finishTurn(ctx, 'browser.disconnected');
        if (!this.uncertain) await this.transport.callTool(this.reset.name, {});
      } catch {
        this.uncertain = true;
      }
    })();
    return this.closeWork;
  }

  private finishTurn(context: BrowserRequestContext, event: string): Promise<void> {
    const key = this.turnKey(context);
    const existing = this.ended.get(key);
    if (existing !== undefined) return existing;
    this.turns.delete(key);
    const work = (async () => {
      await this.sentWork;
      if (this.uncertain) throw new BrowserError('browser.execution_failed', 'Official runtime outcome is unknown; disconnect to confirm exit before cleanup or reset');
      const result = await this.transport.callTool('turn_ended', { hook_event_name: event,
        session_id: `kiki:${context.caller.sessionId}:${context.caller.agentId}`, turn_id: `kiki:${context.turnId}` }, undefined,
        { meta: codexTurnMetadata(context), elicit: async () => ({ action: 'cancel' }) });
      if (result.isError) throw new BrowserError('browser.execution_failed', 'The official runtime did not acknowledge turn cleanup');
    })().catch((error: unknown) => { this.uncertain = true; throw error; });
    this.ended.set(key, work);
    return work;
  }

  private turnKey(context: BrowserRequestContext): string {
    return JSON.stringify([context.caller.sessionId, context.caller.agentId, context.turnId]);
  }

  async connect(context?: BrowserRequestContext, signal?: AbortSignal): Promise<void> {
    const result = await this.query('await cua.listBrowsers({ emit: false })', context, signal);
    if (!Array.isArray(result)) throw new BrowserError('browser.execution_failed', 'The official browser service returned invalid browser inventory');
    const provider = result.map(object).find((item) => item?.['id'] === this.browserId);
    if (provider === undefined) {
      const available = result.map(object).filter((item) => item?.['type'] === 'extension').map((item) => ({ id: item!['id'], name: item!['name'], profileName: item!['profileName'] }));
      throw new BrowserError('browser.requires_action', `The configured extension browser is not available. Enable its ChatGPT extension and Codex connection yourself, then save an exact browserId. Available extension browsers: ${JSON.stringify(available)}`);
    }
    if (provider['type'] !== 'extension') throw new BrowserError('browser.unsupported', 'The selected official provider is not an extension connection; Kiki will not substitute CDP or an in-app browser');
  }

  async tabs(context?: BrowserRequestContext, signal?: AbortSignal): Promise<readonly BrowserTab[]> {
    const result = await this.query(`await cua.listTabs({ browser: ${JSON.stringify(this.browserId)}, emit: false })`, context, signal);
    if (!Array.isArray(result)) throw new BrowserError('browser.execution_failed', 'The official browser service returned invalid tab inventory');
    return result.map((value) => {
      const tab = object(value);
      if (typeof tab?.['id'] !== 'string' || tab['browserId'] !== this.browserId) throw new BrowserError('browser.target', 'The official tab inventory changed provider identity');
      return { tabId: tab['id'], targetId: tab['id'], title: typeof tab['title'] === 'string' ? tab['title'] : undefined,
        url: typeof tab['url'] === 'string' ? tab['url'] : undefined };
    });
  }

  async invoke(tool: string, args: Readonly<Record<string, unknown>>, tab: string | undefined, context?: BrowserRequestContext, signal?: AbortSignal): Promise<MCPToolResult> {
    if (tool === 'codex_browser_js') {
      if (typeof args['code'] !== 'string') throw new BrowserError('browser.invalid', 'Official js requires code');
      return this.send({ ...args, code: tab === undefined ? args['code'] : `var kikiTab = await cua.getTab(${JSON.stringify(tab)}, { browser: ${JSON.stringify(this.browserId)} });\n${args['code']}` }, context, signal);
    }
    if (tool === 'codex_browser_js_reset') return this.send({ ...args }, context, signal, this.reset.name);
    if (tool === 'agent_browser_tab_new') {
      if (args['url'] !== undefined && typeof args['url'] !== 'string') throw new BrowserError('browser.invalid', 'Expected a tab URL');
      const sessionName = typeof args['label'] === 'string' ? `🔎 ${args['label']}` : '🔎 Kiki';
      const created = await this.queryResult(`(await cua.createBrowserTab(${JSON.stringify(this.browserId)}, ${JSON.stringify(args['url']) ?? 'undefined'}, { sessionName: ${JSON.stringify(sessionName)} })).id`, context, signal);
      if (typeof created.value !== 'string') throw new BrowserError('browser.execution_failed', 'The official service returned an invalid new tab id');
      return this.response({ targetId: created.value, tabId: created.value }, created.result);
    }
    if (tool === 'agent_browser_tab_switch') {
      const target = args['tab'];
      if (typeof target !== 'string' || !(await this.tabs(context, signal)).some((item) => item.targetId === target)) throw new BrowserError('browser.target', 'Select an exact official tab id');
      return this.response({ selected: target });
    }
    if (tool === 'agent_browser_tab_close') {
      const target = args['tab'];
      if (typeof target !== 'string') throw new BrowserError('browser.target', 'An official tab id is required');
      const result = await this.send({ code: `var kikiTab = await cua.getTab(${JSON.stringify(target)}, { browser: ${JSON.stringify(this.browserId)} }); if (typeof kikiTab.close !== "function") throw new Error("This provider does not support tab close"); await kikiTab.close();` }, context, signal);
      return result.isError ? result : this.response({ closed: true }, result);
    }
    throw new BrowserError('browser.unsupported', 'This operation is not part of the official extension API. Use codex_browser_js and the documentation returned by the official runtime; Kiki does not emulate agent-browser frame or window APIs.');
  }

  private async query(expression: string, context?: BrowserRequestContext, signal?: AbortSignal): Promise<unknown> {
    return (await this.queryResult(expression, context, signal)).value;
  }

  private async queryResult(expression: string, context?: BrowserRequestContext, signal?: AbortSignal): Promise<{ value: unknown; result: MCPToolResult }> {
    const marker = `KIKI_BROWSER_RESULT_${++this.sequence}:`;
    const result = await this.send({ code: `nodeRepl.write(${JSON.stringify(marker)} + JSON.stringify(${expression}));` }, context, signal);
    if (result.isError) throw new BrowserError('browser.requires_action', 'The official browser service refused discovery. Check the official extension connection and the pending approval; no fallback provider was used.', { details: { result } });
    const text = result.content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
    const start = text.lastIndexOf(marker);
    if (start < 0) throw new BrowserError('browser.execution_failed', 'The official launcher did not return a machine-readable browser inventory');
    try { return { value: JSON.parse(text.slice(start + marker.length).split('\n')[0]!), result }; }
    catch (cause) { throw new BrowserError('browser.execution_failed', 'The official launcher returned malformed browser inventory', { cause }); }
  }

  private send(args: Record<string, unknown>, context?: BrowserRequestContext, signal?: AbortSignal, tool = this.js.name): Promise<MCPToolResult> {
    if (context === undefined) throw new BrowserError('browser.requires_action', 'Connect from BrowserConnections in a Kiki conversation so the official service can request your approval. This settings probe cannot approve browser access.');
    signal?.throwIfAborted();
    if (this.closing || this.uncertain) throw new BrowserError('browser.disconnected', 'The official runtime must finish disconnecting before another call');
    const key = this.turnKey(context);
    if (this.ended.has(key)) throw new BrowserError('browser.disconnected', 'This browser turn already ended');
    if (this.sentWork !== undefined) throw new BrowserError('browser.busy', 'The official runtime is draining a sent call; it was not replayed');
    this.turns.set(key, context);
    const cancellation = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal]);
    const work: Promise<MCPToolResult> = this.transport.callTool(tool, args, undefined, { meta: codexTurnMetadata(context),
      elicit: (request, requestSignal) => context.elicit(request, AbortSignal.any([requestSignal, cancellation])) })
      .catch((error: unknown) => { this.uncertain = true; throw error; })
      .finally(() => { if (this.sentWork === work) this.sentWork = undefined; });
    this.sentWork = work;
    return signal === undefined ? work : abortable(work, signal);
  }

  private response(data: Record<string, unknown>, result?: MCPToolResult): MCPToolResult {
    return { content: result?.content ?? [], isError: false, structuredContent: { response: { success: true, data }, officialResult: result?.structuredContent }, _meta: result?._meta };
  }
}
