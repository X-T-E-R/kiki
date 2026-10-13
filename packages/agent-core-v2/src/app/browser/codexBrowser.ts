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
        const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(NODE_REPL_|CUA_REPL_|BROWSER_USE_|CODEX_BRIDGE_|ENABLE_BROWSER_SESSION_TAB_OWNERSHIP$)/i.test(key)));
        const envUnset = Object.keys(inherited).filter((key) => /^(NODE_REPL_|CUA_REPL_|BROWSER_USE_|CODEX_BRIDGE_|ENABLE_BROWSER_SESSION_TAB_OWNERSHIP$)/i.test(key) && !(key in env));
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
  const bridgeBinary = await resolveCodexBridgeBinary(runtime, root);
  if (bridgeBinary !== undefined) return openCodexBridge(input, bridgeBinary);
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
  const bin = runtime.path.join(root, 'bin');
  const env = {
    CUA_REPL_NODE_REPL_PATH: runtime.path.join(bin, 'node_repl.exe'),
    CUA_REPL_ENABLED_SURFACES: 'browser',
    CUA_REPL_BROWSER_ENV: 'codex-app',
    NODE_REPL_NODE_MODULE_DIRS: bin,
    NODE_REPL_TRUSTED_CODE_PATHS: bin,
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: runtime.path.join(bin, 'node_modules', '@oai', 'browser-desktop', 'scripts', 'browser-service.mjs') }),
  };
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

const CODEX_BRIDGE_BINARY = /^(?:codex-browser-bridge)(?:\.exe)?$/i;
const CODEX_BRIDGE_PIPE = /^codex-browser-use(?:-|\\)[A-Za-z0-9][A-Za-z0-9-]{7,80}$/;
const CODEX_BRIDGE_RECOVERY = 'Start Codex or ChatGPT desktop and connect its Chrome or Edge extension until a codex-browser-use-<id> pipe is listed. The desktop app is the extension approval surface. Kiki does not approve the extension, register a native host, restart the browser, or choose a pipe. Save that exact discover name, including a single backslash when the bridge prints one, as browserId, then connect again from BrowserConnections.';
const CODEX_BRIDGE_DONOR: Readonly<Record<string, string>> = {
  codex_browser_navigate: 'codex_navigate', codex_browser_dom_snapshot: 'codex_dom_snapshot', codex_browser_dom_visible: 'codex_dom_get_visible',
  codex_browser_fill: 'codex_fill', codex_browser_click: 'codex_click', codex_browser_screenshot: 'codex_screenshot',
  codex_browser_get_url: 'codex_get_url', codex_browser_get_title: 'codex_get_title', codex_browser_wait_for_load: 'codex_wait_for_load',
};
export const CODEX_BRIDGE_PAGE_TOOLS = Object.keys(CODEX_BRIDGE_DONOR);
const CODEX_BRIDGE_REQUIRED = ['codex_list_tabs', 'codex_create_tab', 'codex_close_tab', 'codex_navigate', 'codex_dom_snapshot', 'codex_dom_get_visible', 'codex_fill', 'codex_click', 'codex_screenshot', 'codex_get_url', 'codex_get_title', 'codex_wait_for_load', 'codex_name_session', 'codex_finalize', 'codex_get_info'];

async function resolveCodexBridgeBinary(runtime: Runtime, root: string): Promise<string | undefined> {
  const fs = runtime.fs;
  if (fs === undefined) return undefined;
  let current: { isFile: boolean; isDirectory: boolean };
  try { current = await fs.stat(root); } catch { return undefined; }
  if (current.isFile) return CODEX_BRIDGE_BINARY.test(runtime.path.basename(root)) ? root : undefined;
  if (!current.isDirectory) return undefined;
  for (const name of ['codex-browser-bridge.exe', 'codex-browser-bridge']) {
    const candidate = runtime.path.join(root, name);
    try { if ((await fs.stat(candidate)).isFile) return candidate; } catch { continue; }
  }
  return undefined;
}

async function captureCommand(runtime: Runtime, command: string, args: readonly string[], timeout: number): Promise<{ exit: number; stdout: string }> {
  if (runtime.process === undefined) throw new BrowserError('browser.execution_failed', 'The bridge requires a local process service');
  const child = await runtime.process.spawn(command, args, { shell: false, windowsHide: true, timeout });
  let stdout = '';
  child.stdout.on('data', (chunk: Uint8Array) => { if (stdout.length < 16_384) stdout += Buffer.from(chunk).toString('utf8'); });
  child.stderr.resume();
  try { return { exit: await child.wait(), stdout }; }
  finally { await child.dispose(); }
}

async function discoverCodexBridgePipes(runtime: Runtime, binary: string): Promise<readonly string[]> {
  const discovered = await captureCommand(runtime, binary, ['--mode', 'discover'], 20_000);
  if (discovered.exit !== 0 || discovered.stdout.trim() === '') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(discovered.stdout); }
  catch { throw new BrowserError('browser.execution_failed', 'The bridge discovery command did not return pipe names'); }
  if (!Array.isArray(parsed)) throw new BrowserError('browser.execution_failed', 'The bridge discovery command did not return pipe names');
  return parsed.flatMap((item) => {
    const name = object(item)?.['name'];
    return typeof name === 'string' ? [name] : [];
  });
}

async function openCodexBridge(input: { runtimeRoot: string; browserId: string; cwd: string; runtime: Runtime; resolver: IRuntimeResolver }, binary: string): Promise<BrowserBackend> {
  const { runtime } = input;
  if (runtime.environment.osKind !== 'Windows') throw new BrowserError('browser.unsupported', 'codex-browser-bridge speaks to the Windows Codex extension pipe');
  if (!CODEX_BRIDGE_PIPE.test(input.browserId)) throw new BrowserError('browser.requires_action', `${CODEX_BRIDGE_RECOVERY} The saved browserId is not an explicit codex-browser-use-<id> pipe.`);
  const identified = await captureCommand(runtime, binary, ['--version'], 15_000);
  const version = /^codex-browser-bridge (\d+\.\d+\.\d+)\b/.exec(identified.stdout.trim());
  if (identified.exit !== 0 || version === null) throw new BrowserError('browser.unsupported', 'The selected executable did not identify itself as codex-browser-bridge');
  const env = { CODEX_BRIDGE_PROFILE: 'basic' };
  const client = new StdioMcpClient({ transport: 'stdio', command: binary, args: ['--mode', 'mcp', '--profile', 'basic', '--pipe', input.browserId], env, executor: 'local' }, {
    runtimeResolver: codexBrowserRuntimeResolver(input.resolver, env), workspaceId: runtime.identity.workspaceId,
    runtimeId: runtime.identity.runtimeId, defaultCwd: input.cwd, startupTimeoutMs: 20_000, toolCallTimeoutMs: 60_000, elicitation: true,
  });
  try {
    await client.connect();
    const tools = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    if (CODEX_BRIDGE_REQUIRED.some((name) => !names.has(name))) throw new BrowserError('browser.unsupported', 'This codex-browser-bridge build does not expose the basic tab, navigation, DOM, fill, click, screenshot and finalize tools');
    const adapter = new BridgeCodexBrowser(client, input.browserId, tools, () => discoverCodexBridgePipes(runtime, binary));
    return { client: adapter.client, official: adapter, runtime, session: `codex-bridge-${randomUUID()}`, namespace: 'codex-browser-bridge',
      version: `codex-browser-bridge ${version[1]} MIT`, close: async () => {
        try { await adapter.prepareClose(); } finally { await client.close(); }
      } };
  } catch (error) { await client.close(); throw error; }
}

function bridgeOutcomeUnknown(result: MCPToolResult): boolean {
  const text = result.content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
  return /response channel closed|timed out|timeout|broken pipe|connection (?:dropped|reset|closed|refused)|writer is none|no codex-browser-use pipes|all pipes failed/i.test(text);
}

function bridgeNavigationUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw new BrowserError('browser.invalid', 'Navigation requires an http(s) URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new BrowserError('browser.invalid', 'Navigation requires an http(s) URL'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    throw new BrowserError('browser.invalid', 'Navigation accepts only http(s) URLs and does not carry credentials');
  }
  return url.href;
}

function bridgeTabId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function bridgeText(result: MCPToolResult): string {
  return result.content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
}

function bridgeImage(result: MCPToolResult): { mimeType: string; byteLength: number } {
  const block = result.content.find((item) => item.type === 'image' && typeof item.data === 'string' && item.data.length > 0);
  if (block?.data === undefined) throw new BrowserError('browser.execution_failed', 'The bridge screenshot did not include an image. A text summary was not treated as a captured page.');
  const bytes = Buffer.from(block.data, 'base64');
  const mimeType = typeof block.mimeType === 'string' ? block.mimeType : 'image/png';
  const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  const matches = (mimeType === 'image/png' && png) || (mimeType === 'image/jpeg' && jpeg) || (mimeType === 'image/webp' && webp);
  if (!matches) throw new BrowserError('browser.execution_failed', 'The bridge screenshot bytes are not a PNG, JPEG, or WebP image');
  return { mimeType, byteLength: bytes.byteLength };
}

function bridgeSchema(schema: unknown): unknown {
  const source = object(schema) ?? { type: 'object' };
  const properties = { ...object(source['properties']) };
  delete properties['tab_id'];
  const required = Array.isArray(source['required']) ? source['required'].filter((item) => item !== 'tab_id') : [];
  return { ...source, properties, required };
}

export class BridgeCodexBrowser implements CodexBrowserBackend {
  readonly client: MCPClient;
  private readonly projected: MCPToolDefinition[];
  private readonly turns = new Map<string, BrowserRequestContext>();
  private readonly lifetime = new AbortController();
  private sentWork?: Promise<MCPToolResult>;
  private uncertain = false;
  private closing = false;
  private closeWork?: Promise<void>;
  constructor(private readonly transport: MCPClient, private readonly pipe: string, tools: readonly MCPToolDefinition[], private readonly discover: () => Promise<readonly string[]>) {
    if (!CODEX_BRIDGE_PIPE.test(pipe)) throw new BrowserError('browser.requires_action', `${CODEX_BRIDGE_RECOVERY} The saved browserId is not an explicit codex-browser-use-<id> pipe.`);
    this.projected = tools.flatMap((tool) => {
      const name = Object.entries(CODEX_BRIDGE_DONOR).find(([, donor]) => donor === tool.name)?.[0];
      return name === undefined ? [] : [{ ...tool, name, inputSchema: bridgeSchema(tool.inputSchema) }];
    });
    this.client = { listTools: async () => this.projected.map((tool) => ({ ...tool })), ping: (signal) => transport.ping(signal),
      callTool: async () => { throw new BrowserError('browser.requires_action', 'Bridge calls need a Kiki caller and the selected tab'); } };
  }

  async endTurn(caller: BrowserCaller, turnId?: number): Promise<void> {
    for (const [key, ctx] of this.turns) {
      if (ctx.caller.sessionId === caller.sessionId && ctx.caller.agentId === caller.agentId && (turnId === undefined || ctx.turnId === turnId)) this.turns.delete(key);
    }
  }

  prepareClose(): Promise<void> {
    if (this.closeWork !== undefined) return this.closeWork;
    this.closing = true;
    this.lifetime.abort();
    this.closeWork = (async () => {
      try {
        await this.sentWork;
        if (this.uncertain) return;
        const result = await this.transport.callTool('codex_finalize', {}, undefined, { elicit: async () => ({ action: 'cancel' }) });
        if (result.isError || bridgeOutcomeUnknown(result)) this.uncertain = true;
      } catch { this.uncertain = true; }
    })();
    return this.closeWork;
  }

  async connect(context?: BrowserRequestContext, signal?: AbortSignal): Promise<void> {
    if (context === undefined) throw new BrowserError('browser.requires_action', 'Connect from BrowserConnections in a Kiki conversation. This settings probe cannot approve the extension.');
    const names = await this.discover();
    signal?.throwIfAborted();
    if (!names.includes(this.pipe)) {
      const visible = names.filter((name) => name.length > 0 && name.length <= 180 && !/[\r\n\0]/.test(name)).slice(0, 20);
      throw new BrowserError('browser.requires_action', `${CODEX_BRIDGE_RECOVERY} Configured pipe: ${this.pipe}. Discovered pipes: ${JSON.stringify(visible)}`);
    }
    await this.send('codex_get_info', {}, context, signal);
    const name = `kiki:${context.caller.sessionId}:${context.caller.agentId}`.replace(/[\r\n]/g, '').slice(0, 80);
    try { await this.send('codex_name_session', { name }, context, signal); }
    catch (error) { if (this.uncertain) throw error; }
  }

  async tabs(context?: BrowserRequestContext, signal?: AbortSignal): Promise<readonly BrowserTab[]> {
    const result = await this.send('codex_list_tabs', {}, context, signal);
    let parsed: unknown;
    try { parsed = JSON.parse(bridgeText(result)); }
    catch (cause) { throw new BrowserError('browser.execution_failed', 'The bridge returned malformed tab inventory', { cause }); }
    if (!Array.isArray(parsed)) throw new BrowserError('browser.execution_failed', 'The bridge returned malformed tab inventory');
    return parsed.map((value) => {
      const tab = object(value);
      const id = bridgeTabId(tab?.['id']);
      if (id === undefined) throw new BrowserError('browser.target', 'The bridge tab inventory omitted an id');
      return { tabId: id, targetId: id, title: typeof tab?.['title'] === 'string' ? tab['title'] : undefined, url: typeof tab?.['url'] === 'string' ? tab['url'] : undefined };
    });
  }

  async invoke(tool: string, args: Readonly<Record<string, unknown>>, tab: string | undefined, context?: BrowserRequestContext, signal?: AbortSignal): Promise<MCPToolResult> {
    if (/claim|user_tabs|cookie|execute_cdp|file_input|cua_/.test(tool)) throw new BrowserError('browser.unsupported', 'Kiki does not claim existing tabs, read private tabs, or send coordinate clicks through this bridge');
    if (tool === 'agent_browser_window_new' || tool === 'agent_browser_frame_main' || tool === 'agent_browser_frame_switch') {
      throw new BrowserError('browser.unsupported', 'The bridge keeps one explicit extension pipe and tabs created for this session. Window and frame substitution is unsupported.');
    }
    if (tool === 'agent_browser_tab_new') return this.createTab(args, context, signal);
    if (tool === 'agent_browser_tab_switch') return this.selectTab(args, context, signal);
    if (tool === 'agent_browser_tab_close') return this.closeTab(args, context, signal);
    const donor = CODEX_BRIDGE_DONOR[tool];
    if (donor === undefined) throw new BrowserError('browser.unsupported', 'This operation is not part of the Codex extension bridge surface');
    if (tab === undefined) throw new BrowserError('browser.target', 'Select a tab created for this bridge session before operating');
    if ('tab_id' in args && args['tab_id'] !== tab) throw new BrowserError('browser.target', 'The bridge tab is the selected Kiki tab, not a caller-supplied id');
    const bridged = this.bridgeArguments(donor, args, tab);
    const result = await this.send(donor, bridged, context, signal);
    if (donor === 'codex_screenshot') {
      const image = bridgeImage(result);
      return this.response({ mimeType: image.mimeType, byteLength: image.byteLength }, result);
    }
    return result;
  }

  private async createTab(args: Readonly<Record<string, unknown>>, context?: BrowserRequestContext, signal?: AbortSignal): Promise<MCPToolResult> {
    if (args['url'] !== undefined && typeof args['url'] !== 'string') throw new BrowserError('browser.invalid', 'Expected a tab URL');
    const created = await this.send('codex_create_tab', {}, context, signal);
    const createdId = /Created tab: (\S+)/.exec(bridgeText(created))?.[1];
    if (createdId === undefined) throw new BrowserError('browser.execution_failed', 'The bridge did not return a new tab id');
    if (args['url'] === undefined) return this.response({ targetId: createdId, tabId: createdId }, created);
    const navigated = await this.send('codex_navigate', { tab_id: createdId, url: bridgeNavigationUrl(args['url']) }, context, signal);
    return this.response({ targetId: createdId, tabId: createdId, url: bridgeNavigationUrl(args['url']) }, navigated);
  }

  private async selectTab(args: Readonly<Record<string, unknown>>, context?: BrowserRequestContext, signal?: AbortSignal): Promise<MCPToolResult> {
    const target = args['tab'];
    if (typeof target !== 'string' || !(await this.tabs(context, signal)).some((item) => item.targetId === target)) throw new BrowserError('browser.target', 'Select a tab id returned by this bridge session');
    return this.response({ selected: target });
  }

  private async closeTab(args: Readonly<Record<string, unknown>>, context?: BrowserRequestContext, signal?: AbortSignal): Promise<MCPToolResult> {
    const target = args['tab'];
    if (typeof target !== 'string' || !(await this.tabs(context, signal)).some((item) => item.targetId === target)) throw new BrowserError('browser.target', 'Close only a tab id returned by this bridge session');
    const result = await this.send('codex_close_tab', { tab_id: target }, context, signal);
    return this.response({ closed: true }, result);
  }

  private bridgeArguments(donor: string, args: Readonly<Record<string, unknown>>, tab: string): Record<string, unknown> {
    if (donor === 'codex_navigate') return { tab_id: tab, url: bridgeNavigationUrl(args['url']) };
    if (donor === 'codex_fill') {
      const value = typeof args['value'] === 'string' ? args['value'] : args['text'];
      if (typeof args['selector'] !== 'string' || args['selector'].trim() === '' || typeof value !== 'string') throw new BrowserError('browser.invalid', 'Fill requires a selector and a value');
      return { tab_id: tab, selector: args['selector'], value };
    }
    if (donor === 'codex_click') {
      if (typeof args['selector'] !== 'string' || args['selector'].trim() === '' || 'x' in args || 'y' in args) throw new BrowserError('browser.invalid', 'Click requires a CSS selector in the selected tab');
      return { tab_id: tab, selector: args['selector'] };
    }
    if (donor === 'codex_screenshot') {
      const out: Record<string, unknown> = { tab_id: tab };
      if (args['format'] === 'png' || args['format'] === 'jpeg' || args['format'] === 'webp') out['format'] = args['format'];
      if (typeof args['quality'] === 'number' && Number.isInteger(args['quality']) && args['quality'] >= 0 && args['quality'] <= 100) out['quality'] = args['quality'];
      return out;
    }
    if (donor === 'codex_wait_for_load' && args['timeout_ms'] !== undefined) {
      if (typeof args['timeout_ms'] !== 'number' || !Number.isInteger(args['timeout_ms']) || args['timeout_ms'] < 0 || args['timeout_ms'] > 60_000) throw new BrowserError('browser.invalid', 'Wait timeout must be an integer from 0 through 60000');
      return { tab_id: tab, timeout_ms: args['timeout_ms'] };
    }
    return { tab_id: tab };
  }

  private send(tool: string, args: Record<string, unknown>, context?: BrowserRequestContext, signal?: AbortSignal): Promise<MCPToolResult> {
    if (context === undefined) throw new BrowserError('browser.requires_action', 'Connect from BrowserConnections in a Kiki conversation so the extension can request your approval. This settings probe cannot approve browser access.');
    signal?.throwIfAborted();
    if (this.closing || this.uncertain) throw new BrowserError('browser.disconnected', 'The bridge outcome is unknown or it is disconnecting. Kiki did not send the action again.');
    if (this.sentWork !== undefined) throw new BrowserError('browser.busy', 'The bridge is draining a sent call; it was not replayed');
    const key = JSON.stringify([context.caller.sessionId, context.caller.agentId, context.turnId]);
    this.turns.set(key, context);
    const cancellation = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal]);
    const work: Promise<MCPToolResult> = this.transport.callTool(tool, args, undefined, { meta: codexTurnMetadata(context),
      elicit: (request, requestSignal) => context.elicit(request, AbortSignal.any([requestSignal, cancellation])) })
      .then((result) => {
        if (bridgeOutcomeUnknown(result)) {
          this.uncertain = true;
          throw new BrowserError('browser.execution_failed', `The bridge did not confirm ${tool}. Kiki did not send it again.`);
        }
        if (result.isError) throw new BrowserError('browser.execution_failed', 'The bridge rejected the action. Kiki did not send it again.');
        return result;
      }, (error: unknown) => { this.uncertain = true; throw error; })
      .finally(() => { if (this.sentWork === work) this.sentWork = undefined; });
    this.sentWork = work;
    return signal === undefined ? work : abortable(work, signal);
  }

  private response(data: Record<string, unknown>, result?: MCPToolResult): MCPToolResult {
    return { content: result?.content ?? [], isError: false, structuredContent: { response: { success: true, data }, bridgeResult: result?.structuredContent }, _meta: result?._meta };
  }
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
