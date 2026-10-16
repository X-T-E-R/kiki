import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { abortable } from '#/_base/utils/abort';

import type { MCPClient, MCPToolDefinition, MCPToolResult } from '#/mcpCore/types';
import type { Runtime } from '#/runtime/runtime';
import { StdioMcpClient } from '#/mcpCore/client-stdio';
import type { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { CODEX_BRIDGE_FILE_SHA256 } from '#/app/capability/entries/browserResourceStore';
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
  if (runtime.environment.osKind !== 'Windows' || manifest['platform'] !== 'windows' || pkg['name'] !== '@oai/cua-repl' || typeof pkg['version'] !== 'string' || pkg['version'].length === 0 || typeof manifest['runtime_archive_version'] !== 'string') {
    throw new BrowserError('browser.unsupported', 'This installed runtime does not match the Windows @oai/cua-repl launch contract');
  }
  const bin = runtime.path.join(root, 'bin');
  const env: Record<string, string> = {
    CUA_REPL_NODE_REPL_PATH: runtime.path.join(bin, 'node_repl.exe'),
    CUA_REPL_ENABLED_SURFACES: 'browser',
    CUA_REPL_BROWSER_ENV: 'codex-app',
    NODE_REPL_NODE_MODULE_DIRS: bin,
    NODE_REPL_TRUSTED_CODE_PATHS: bin,
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: runtime.path.join(bin, 'node_modules', '@oai', 'browser-desktop', 'scripts', 'browser-service.mjs') }),
  };
  const cli = await resolveCodexBrowserCli(runtime, root);
  if (cli !== undefined) env['CODEX_CLI_PATH'] = cli;
  const client = new StdioMcpClient({ transport: 'stdio', command: runtime.path.join(root, 'bin', 'node.exe'),
    args: [runtime.path.join(packageRoot, 'bin', 'cua-repl.mjs')], env, executor: 'local' }, {
    runtimeResolver: codexBrowserRuntimeResolver(input.resolver, env), workspaceId: runtime.identity.workspaceId,
    runtimeId: runtime.identity.runtimeId, defaultCwd: input.cwd, startupTimeoutMs: 30_000, toolCallTimeoutMs: 60_000,
    computerControl: true, computerDirect: true, elicitation: true,
  });
  try {
    await client.connect();
    const tools = await client.listTools();
    const adapter = new OfficialCodexBrowser(client, input.browserId, tools, () => client.stderrSnapshot());
    return { client: adapter.client, official: adapter, runtime, session: `codex-browser-${randomUUID()}`, namespace: 'official-cua-repl',
      version: `@oai/cua-repl ${pkg['version']} (${manifest['runtime_archive_version']})`, close: async () => {
        try { await adapter.prepareClose(); } finally { await client.close(); }
      } };
  } catch (error) { await client.close(); throw error; }
}

export async function resolveCodexBrowserCli(runtime: Runtime, runtimeRoot: string): Promise<string | undefined> {
  const candidate = runtime.path.join(runtime.path.dirname(runtimeRoot), 'codex.exe');
  let stat;
  try { stat = await runtime.fs?.stat(candidate); }
  catch (cause) {
    const code = object(cause)?.['code'];
    if (code === 'os.fs.not_found' || code === 'ENOENT') return undefined;
    throw new BrowserError('browser.requires_action', 'Kiki could not inspect the Codex CLI beside the selected browser runtime. Check access to that installation.', { cause });
  }
  if (stat === undefined) throw new BrowserError('browser.execution_failed', 'The official browser runtime requires the Kiki host filesystem');
  if (!stat.isFile) throw new BrowserError('browser.unsupported', 'The Codex CLI beside the selected browser runtime is not a file');
  return candidate;
}

export const CODEX_BRIDGE_ADOPTION = {
  version: '1.11.1',
  revision: 'c692fb017d79d458927c6a8e350dc2d06224d46e',
  marker: 'kiki-no-resend-r1',
  license: 'MIT',
  repository: 'https://github.com/DeliciousBuding/codex-browser-bridge',
  directory: 'codex-browser-bridge-1.11.1-kiki-no-resend-r1',
  binary: 'codex-browser-bridge.exe',
  pinConsumer: 'packages/agent-core-v2/src/app/capability/entries/browserResourceStore.ts',
} as const;
export const CODEX_BRIDGE_PIN: Readonly<Record<string, string>> = CODEX_BRIDGE_FILE_SHA256;
const CODEX_BRIDGE_BINARY = /^(?:codex-browser-bridge)(?:\.exe)?$/i;
const CODEX_BRIDGE_PIPE = /^codex-browser-use(?:-|\\)[A-Za-z0-9][A-Za-z0-9-]{7,80}$/;
const CODEX_BRIDGE_RECOVERY = 'Choose an explicit endpoint from Browser setup. The codex-browser-use prefix is also used by desktop app tools; only a browser handshake verifies the connection. Kiki does not register a native host, restart the browser, dial an unselected pipe, or substitute another CDP browser.';
const CODEX_BRIDGE_FLOOR = ['codex_list_tabs', 'codex_create_tab', 'codex_close_tab', 'codex_navigate', 'codex_name_session', 'codex_finalize', 'codex_get_info'];

export function codexBridgePipeName(value: string): boolean {
  return CODEX_BRIDGE_PIPE.test(value);
}

export function codexBridgeResource(home: string, joinPath: (...parts: string[]) => string): { directory: string; binary: string } {
  const directory = joinPath(home, 'browser', 'resources', CODEX_BRIDGE_ADOPTION.directory);
  return { directory, binary: joinPath(directory, CODEX_BRIDGE_ADOPTION.binary) };
}

export function verifiedCodexBridge(pin: Readonly<Record<string, string>> | undefined, digests: Readonly<Record<string, string>>): boolean {
  if (pin?.[CODEX_BRIDGE_ADOPTION.binary] === undefined) return false;
  return Object.entries(pin).every(([name, sha]) => digests[name] === sha);
}

export function codexBridgeSelection(requested: string | undefined, pipes: readonly string[]): string | undefined {
  if (requested === undefined || !pipes.includes(requested) || !CODEX_BRIDGE_PIPE.test(requested)) return undefined;
  return requested;
}

export function catalogBackend(tools: readonly { name: string }[]): 'official-cua-repl' | 'codex-browser-bridge' | 'agent-browser' {
  if (tools.some((tool) => tool.name === 'codex_browser_js' || tool.name === 'codex_browser_js_reset')) return 'official-cua-repl';
  if (tools.some((tool) => tool.name.startsWith('codex_'))) return 'codex-browser-bridge';
  return 'agent-browser';
}

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
  const env: Record<string, string> = {};
  const client = new StdioMcpClient({ transport: 'stdio', command: binary, args: ['--mode', 'mcp', '--pipe', input.browserId], env, executor: 'local' }, {
    runtimeResolver: codexBrowserRuntimeResolver(input.resolver, env), workspaceId: runtime.identity.workspaceId,
    runtimeId: runtime.identity.runtimeId, defaultCwd: input.cwd, startupTimeoutMs: 20_000, toolCallTimeoutMs: 60_000, elicitation: true,
  });
  try {
    await client.connect();
    const tools = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    if (CODEX_BRIDGE_FLOOR.some((name) => !names.has(name))) throw new BrowserError('browser.unsupported', 'This codex-browser-bridge build does not expose the tab, navigation, session, and finalize tools this connection uses');
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

function bridgeSchema(schema: unknown, keepTabRequired: boolean): unknown {
  const source = object(schema) ?? { type: 'object' };
  const properties = { ...object(source['properties']) };
  const required = Array.isArray(source['required']) ? source['required'].filter((item) => keepTabRequired || item !== 'tab_id') : [];
  return { ...source, properties, required };
}

export class BridgeCodexBrowser implements CodexBrowserBackend {
  readonly client: MCPClient;
  private readonly byName: ReadonlyMap<string, MCPToolDefinition>;
  private readonly projected: MCPToolDefinition[];
  private readonly turns = new Map<string, BrowserRequestContext>();
  private sentAny = false;
  private readonly lifetime = new AbortController();
  private sentWork?: Promise<MCPToolResult>;
  private uncertain = false;
  private closing = false;
  private closeWork?: Promise<void>;
  constructor(private readonly transport: MCPClient, private readonly pipe: string, tools: readonly MCPToolDefinition[], private readonly discover: () => Promise<readonly string[]>) {
    if (!CODEX_BRIDGE_PIPE.test(pipe)) throw new BrowserError('browser.requires_action', `${CODEX_BRIDGE_RECOVERY} The saved browserId is not an explicit codex-browser-use-<id> pipe.`);
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
    this.projected = tools.map((tool) => ({ ...tool, inputSchema: bridgeSchema(tool.inputSchema, tool.name === 'codex_claim_tab') }));
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
        if (this.uncertain || !this.sentAny) return;
        const result = await this.transport.callTool('codex_finalize', {}, undefined, { elicit: async () => ({ action: 'cancel' }) });
        if (result.isError || bridgeOutcomeUnknown(result)) this.uncertain = true;
      } catch { this.uncertain = true; }
    })();
    return this.closeWork;
  }

  async connect(context?: BrowserRequestContext, signal?: AbortSignal): Promise<void> {
    if (context === undefined) throw new BrowserError('browser.requires_action', 'BridgeCodexBrowser.connect needs a Kiki caller. This settings probe has no permission consumer and will not forge an approval.');
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
    if (tool === 'agent_browser_window_new' || tool === 'agent_browser_frame_main' || tool === 'agent_browser_frame_switch') {
      throw new BrowserError('browser.unsupported', 'The bridge keeps one explicit extension pipe and tabs created for this session. Window and frame substitution is unsupported.');
    }
    if (tool === 'agent_browser_tab_new') return this.createTab(args, context, signal);
    if (tool === 'agent_browser_tab_switch') return this.selectTab(args, context, signal);
    if (tool === 'agent_browser_tab_close') return this.closeTab(args, context, signal);
    const definition = this.byName.get(tool);
    if (definition === undefined) throw new BrowserError('browser.unsupported', 'This operation is not in the connected codex-browser-bridge catalog');
    const bridged = this.bridgeArguments(definition, args, tab);
    const result = await this.send(tool, bridged, context, signal);
    if (tool === 'codex_screenshot') {
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

  private bridgeArguments(tool: MCPToolDefinition, args: Readonly<Record<string, unknown>>, tab: string | undefined): Record<string, unknown> {
    const properties = object(object(tool.inputSchema)?.['properties']) ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) if (key in properties) out[key] = value;
    if ('url' in properties && out['url'] !== undefined) out['url'] = bridgeNavigationUrl(out['url']);
    if (!('tab_id' in properties) || tool.name === 'codex_claim_tab') return out;
    if (tab === undefined) throw new BrowserError('browser.target', 'Select a tab created for this bridge session before operating');
    if ('tab_id' in out && out['tab_id'] !== tab) throw new BrowserError('browser.target', 'The bridge tab is the selected Kiki tab, not a different caller-supplied id');
    out['tab_id'] = tab;
    return out;
  }

  private send(tool: string, args: Record<string, unknown>, context?: BrowserRequestContext, signal?: AbortSignal): Promise<MCPToolResult> {
    if (context === undefined) throw new BrowserError('browser.requires_action', 'BridgeCodexBrowser.send delivers a real protocol elicitation to browserElicitation. This settings probe has no permission consumer and will not forge an approval.');
    signal?.throwIfAborted();
    if (this.closing || this.uncertain) throw new BrowserError('browser.disconnected', 'The bridge outcome is unknown or it is disconnecting. Kiki did not send the action again.');
    if (this.sentWork !== undefined) throw new BrowserError('browser.busy', 'The bridge is draining a sent call; it was not replayed');
    const key = JSON.stringify([context.caller.sessionId, context.caller.agentId, context.turnId]);
    this.turns.set(key, context);
    const cancellation = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal]);
    this.sentAny = true;
    const work: Promise<MCPToolResult> = this.transport.callTool(tool, args, undefined, { meta: codexTurnMetadata(context),
      elicit: (request, requestSignal) => context.elicit({ ...request, _meta: { ...request._meta, kiki_elicit_source: 'BridgeCodexBrowser.send' } }, AbortSignal.any([requestSignal, cancellation])) })
      .then((result) => {
        if (bridgeOutcomeUnknown(result)) {
          this.uncertain = true;
          throw new BrowserError('browser.execution_failed', `The bridge did not confirm ${tool}. Kiki did not send it again.`);
        }
        if (result.isError) {
          const code = /json-rpc error (-32600|-32601|-32602):/.exec(bridgeText(result))?.[1];
          if (code !== undefined) {
            const rpcClass = code === '-32600' ? 'invalid_request' : code === '-32601' ? 'method_not_found' : 'invalid_params';
            throw new BrowserError('browser.execution_failed', `The selected official pipe rejected ${tool} with JSON-RPC ${code}. Check compatibility between the official browser host and runtime. Kiki did not send the action again.`, { details: { reason: 'protocol_rejected', tool, method: tool === 'codex_get_info' ? 'getInfo' : undefined, failureStage: 'native_request', rpcCode: Number(code), rpcClass } });
          }
          throw new BrowserError('browser.execution_failed', 'The bridge rejected the action. Kiki did not send it again.', { details: { reason: 'bridge_rejected', tool, failureStage: 'tool_call', rpcClass: 'unknown' } });
        }
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

const OFFICIAL_BROKER_FAILURE = /app_server_request_failed|failed to start codex app-server|Codex app-server is unavailable/;

/** Empty discovery does not establish extension or authentication state. */
export function officialBrowserEmptyInventoryReason(stderr: string): 'broker-unavailable' | 'no-connection' {
  return OFFICIAL_BROKER_FAILURE.test(stderr) ? 'broker-unavailable' : 'no-connection';
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
  constructor(private readonly transport: MCPClient, private readonly browserId: string, tools: readonly MCPToolDefinition[], private readonly stderr: () => string = () => '') {
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
      if (available.length === 0 && officialBrowserEmptyInventoryReason(this.stderr()) === 'broker-unavailable') {
        throw new BrowserError('browser.requires_action', 'The official Codex app-server request failed. Check the selected installation and its broker status before reconnecting.', { details: { reason: 'broker_unavailable' } });
      }
      if (available.length === 0) {
        throw new BrowserError('browser.requires_action', 'The official runtime returned no selectable extension connection. Check the official browser host and runtime connection diagnostics before reconnecting.', { details: { reason: 'no_connection' } });
      }
      throw new BrowserError('browser.requires_action', `The configured browser id is not in the discovered extension set. Select an exact browserId. Available extension browsers: ${JSON.stringify(available)}`);
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
    if (context === undefined) throw new BrowserError('browser.requires_action', 'OfficialCodexBrowser.send delivers a real protocol elicitation to browserElicitation. This settings probe has no permission consumer and will not forge an approval.');
    signal?.throwIfAborted();
    if (this.closing || this.uncertain) throw new BrowserError('browser.disconnected', 'The official runtime must finish disconnecting before another call');
    const key = this.turnKey(context);
    if (this.ended.has(key)) throw new BrowserError('browser.disconnected', 'This browser turn already ended');
    if (this.sentWork !== undefined) throw new BrowserError('browser.busy', 'The official runtime is draining a sent call; it was not replayed');
    this.turns.set(key, context);
    const cancellation = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal]);
    const work: Promise<MCPToolResult> = this.transport.callTool(tool, args, undefined, { meta: codexTurnMetadata(context),
      elicit: (request, requestSignal) => context.elicit({ ...request, _meta: { ...request._meta, kiki_elicit_source: 'OfficialCodexBrowser.send' } }, AbortSignal.any([requestSignal, cancellation])) })
      .catch((error: unknown) => { this.uncertain = true; throw error; })
      .finally(() => { if (this.sentWork === work) this.sentWork = undefined; });
    this.sentWork = work;
    return signal === undefined ? work : abortable(work, signal);
  }

  private response(data: Record<string, unknown>, result?: MCPToolResult): MCPToolResult {
    return { content: result?.content ?? [], isError: false, structuredContent: { response: { success: true, data }, officialResult: result?.structuredContent }, _meta: result?._meta };
  }
}
