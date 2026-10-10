import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { prepareToolRuntime } from '#/agent/tools/os/sshToolTarget';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { IBrowserControlService, type BrowserInvocationResult } from '#/app/browser/browser';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { BrowserIdSchema } from '#/app/browser/browserConfig';
import { BROWSER_OWNED_FIELDS, browserResponse, browserToolGroup, isBrowserOperation } from '#/app/browser/browserControlService';
import { BrowserError } from '#/app/browser/errors';
import { LifecycleScope } from '#/app/scopes';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IEventBus } from '#/app/event/eventBus';
import { TurnEnded } from '#/agent/loop/turnOps';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import type { BrowserRequestContext } from '#/app/browser/codexBrowser';
import { browserElicitation } from './browserElicitation';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { buildDaemonFileUrl } from '#/agent/media/mediaRef';
import { mcpResultToExecutableOutput } from '#/agent/mcp/output';
import { assertMcpInputSchema, type MCPToolDefinition } from '#/mcpCore/types';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IFlagService } from '#/app/flag/flag';
import { NATIVE_BROWSER_FLAG_ID } from '#/app/browser/flag';
import { resolveRealPathAccess, resolveRealPathAccessPath, type WorkspaceConfig } from '#/tool/path-access';
import { ToolAccesses, type AgentTool, type ExecutableToolContext, type ExecutableToolResult, type ToolExecution, type ToolFileAccess } from '#/tool/toolContract';

export const BrowserConnectionsInputSchema = z.object({ action: z.enum(['list', 'select', 'status', 'check', 'connect', 'disconnect', 'tools']).default('list'),
  browser: BrowserIdSchema.optional(), groups: z.array(z.enum(['page', 'network', 'state', 'debug', 'input', 'react'])).optional(),
  tools: z.array(z.string().regex(/^(?:agent_browser_[a-z0-9_]+|codex_browser_js(?:_reset)?)$/)).optional(),
  unload: z.array(z.string().regex(/^(?:agent_browser_[a-z0-9_]+|codex_browser_js(?:_reset)?)$/)).optional() }).strict();
export type BrowserConnectionsInput = z.infer<typeof BrowserConnectionsInputSchema>;
export const BrowserTabsInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), browser: BrowserIdSchema.optional() }).strict(),
  z.object({ action: z.literal('open'), browser: BrowserIdSchema.optional(), url: z.string().optional(), label: z.string().optional() }).strict(),
  z.object({ action: z.literal('window'), browser: BrowserIdSchema.optional() }).strict(),
  z.object({ action: z.literal('select'), browser: BrowserIdSchema.optional(), target: z.string().min(1) }).strict(),
  z.object({ action: z.literal('close'), browser: BrowserIdSchema.optional(), target: z.string().min(1) }).strict(),
  z.object({ action: z.literal('frame'), browser: BrowserIdSchema.optional(), frame: z.string().min(1) }).strict(),
]);
export type BrowserTabsInput = z.infer<typeof BrowserTabsInputSchema>;

interface Selection { tab: string; generation: number; frame?: string; observed?: boolean; owned?: boolean }
interface ISessionBrowserDefault { readonly _serviceBrand: undefined; readonly ready: Promise<string | undefined> }
const ISessionBrowserDefault = createDecorator<ISessionBrowserDefault>('sessionBrowserDefault');
class SessionBrowserDefault implements ISessionBrowserDefault {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<string | undefined>;
  constructor(@IBrowserConnectionStore store: IBrowserConnectionStore) { this.ready = store.list().then((result) => result.defaultBrowser); }
}
registerScopedService(LifecycleScope.Session, ISessionBrowserDefault, SessionBrowserDefault, ScopeActivation.OnScopeCreated, 'browser');

export interface IAgentBrowserService {
  readonly _serviceBrand: undefined;
  connections(input: BrowserConnectionsInput, signal?: AbortSignal, context?: ExecutableToolContext): Promise<ExecutableToolResult>;
  tabs(input: BrowserTabsInput, signal?: AbortSignal, context?: ExecutableToolContext): Promise<ExecutableToolResult>;
}
export const IAgentBrowserService = createDecorator<IAgentBrowserService>('agentBrowserService');

export function projectBrowserToolSchema(tool: MCPToolDefinition): Record<string, unknown> {
  const original = assertMcpInputSchema(tool.name, tool.inputSchema);
  const properties = original['properties'] as Record<string, unknown> | undefined;
  if (properties === undefined || 'browser' in properties || 'browserTab' in properties) {
    throw new BrowserError('browser.invalid', `Cannot compose browser identity with donor schema for ${tool.name}`);
  }
  const ownedRequired = (original['required'] as string[] | undefined)?.filter((field) => BROWSER_OWNED_FIELDS.has(field));
  if (ownedRequired?.length) throw new BrowserError('browser.invalid', `Donor changed required identity fields in ${tool.name}`);
  const projected = Object.fromEntries(Object.entries(properties).filter(([field]) => !BROWSER_OWNED_FIELDS.has(field)));
  return { ...original, additionalProperties: false, properties: { ...projected,
    browser: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$', description: 'Saved browser connection id. Omit only to use this agent\'s selected connection; never guessed by display name.' },
    browserTab: { type: 'string', minLength: 1, description: 'Exact tab identity returned by BrowserTabs in this connection (CDP targetId or official extension tab id). Omit only for this agent\'s selected tab; it does not follow the user\'s foreground tab.' } } };
}

export function validateBrowserValues(args: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(args)) if (BROWSER_OWNED_FIELDS.has(key)) throw new BrowserError('browser.invalid', `Browser identity field "${key}" is managed by Kiki`);
  const inspect = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('--')) throw new BrowserError('browser.invalid', 'This donor does not escape positional values beginning with --; use an explicit eval script for that page content');
    if (Array.isArray(value)) value.forEach(inspect);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(inspect);
  };
  for (const [key, value] of Object.entries(args)) if (key !== 'script') inspect(value);
}

export class AgentBrowserService extends Disposable implements IAgentBrowserService {
  declare readonly _serviceBrand: undefined;
  private selected?: string;
  private initialized = false;
  private readonly selections = new Map<string, Selection>();
  private readonly registrations = new Map<string, { dispose(): void }>();
  private readonly recordings = new Map<string, string>();
  constructor(
    @IBrowserControlService private readonly control: IBrowserControlService,
    @IBrowserConnectionStore private readonly store: IBrowserConnectionStore,
    @ISessionBrowserDefault private readonly defaults: ISessionBrowserDefault,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @ISessionMediaStore private readonly media: ISessionMediaStore,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ISessionInteractionService private readonly approvals: ISessionInteractionService,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
    const caller = { sessionId: this.session.sessionId, agentId: this.agent.agentId };
    this._store.ledger.register(() => this.control.endTurn(caller), 'official-browser-turn-cleanup');
    this._register(eventBus.subscribe(TurnEnded, (event) => {
      void this.control.endTurn(caller, event.turnId).catch(onUnexpectedError);
    }));
  }

  private requestContext(ctx?: ExecutableToolContext): BrowserRequestContext | undefined {
    if (ctx === undefined) return undefined;
    const caller = { sessionId: this.session.sessionId, agentId: this.agent.agentId };
    return { caller, turnId: ctx.turnId, toolCallId: ctx.toolCallId,
      elicit: (request, signal) => browserElicitation(this.approvals, caller, ctx.turnId, ctx.toolCallId, request, AbortSignal.any([ctx.signal, signal])) };
  }

  async connections(input: BrowserConnectionsInput, signal?: AbortSignal, ctx?: ExecutableToolContext): Promise<ExecutableToolResult> {
    try {
      signal?.throwIfAborted();
      if (input.action === 'list') return this.json({ ...(await this.control.list()), selectedBrowser: this.selected });
      const browser = await this.choose(input.browser);
      signal?.throwIfAborted();
      if (input.action === 'select') return this.json({ selectedBrowser: browser, status: await this.control.status(browser), selectedTab: this.selections.get(browser) });
      if (input.action === 'tools') {
        for (const tool of input.unload ?? []) {
          const name = this.modelName(tool); this.registrations.get(name)?.dispose(); this.registrations.delete(name);
        }
        const tools = await this.control.catalog(browser, signal);
        const operations = tools.filter((tool) => isBrowserOperation(tool.name));
        const requested = operations.filter((tool) => input.groups?.includes(browserToolGroup(tool.name) as 'page') || input.tools?.includes(tool.name));
        for (const tool of requested) this.register(tool);
        const official = (await this.store.resolve(browser)).type === 'codex-extension';
        return this.json({ browser, backend: official ? 'official-cua-repl' : 'agent-browser', backendToolCount: tools.length,
          contextIsolation: official ? 'Official extension browser/tab ids are preserved. Use codex_browser_js and its runtime documentation; window/frame emulation is unsupported.' : 'BrowserTabs window creates an opaque donor browser context and a targetId-bound tab. Named context list/switch/dispose APIs are unavailable; no synthetic context ids are exposed.',
          operations: operations.map((tool) => ({ name: tool.name, modelTool: this.modelName(tool.name), group: browserToolGroup(tool.name) })),
          managedLifecycle: tools.filter((tool) => /^agent_browser_(?:connect|close|tab_|frame_|window_)/.test(tool.name)).map((tool) => ({ name: tool.name, surface: /connect|close$/.test(tool.name) && !/tab_close/.test(tool.name) ? 'BrowserConnections' : 'BrowserTabs' })),
          administrativeCapabilities: tools.filter((tool) => !isBrowserOperation(tool.name) && !/^agent_browser_(?:connect|close|tab_|frame_|window_)/.test(tool.name)).map((tool) => ({ name: tool.name, availableAsPageTool: false,
            reason: 'Donor-wide installation, plugins, credential or cross-session administration is outside a selected page execution lease.' })),
          loaded: [...this.registrations.keys()], note: 'Use groups or tools to load only the typed operations needed for this task. Tab/frame lifecycle uses BrowserTabs. Browser installation and cross-session management are not page operations.' });
      }
      if (input.action === 'connect') return this.json(await this.control.connect(browser, signal, this.requestContext(ctx)));
      if (input.action === 'disconnect') { const status = await this.control.disconnect(browser, signal); this.selections.delete(browser); return this.json(status); }
      return this.json(await (input.action === 'check' ? this.control.check(browser, signal, this.requestContext(ctx)) : this.control.status(browser)));
    } catch (error) { return this.error(error); }
  }

  async tabs(input: BrowserTabsInput, signal?: AbortSignal, ctx?: ExecutableToolContext): Promise<ExecutableToolResult> {
    try {
      signal?.throwIfAborted();
      const browser = await this.choose(input.browser);
      const requestContext = this.requestContext(ctx);
      if (input.action === 'list') return this.json({ browser, status: await this.control.status(browser), selected: this.selections.get(browser), tabs: await this.control.tabs(browser, signal, requestContext) });
      const current = this.selections.get(browser);
      const caller = { sessionId: this.session.sessionId, agentId: this.agent.agentId };
      if (input.action === 'select' || input.action === 'close') {
        const tabs = await this.control.tabs(browser, signal, requestContext);
        if (!tabs.some((tab) => tab.targetId === input.target)) throw new BrowserError('browser.target', 'Use a current targetId from BrowserTabs list, not a positional tab number or label');
        const result = await this.control.invoke({ browser, caller, requestContext, tool: input.action === 'select' ? 'agent_browser_tab_switch' : 'agent_browser_tab_close', args: { tab: input.target } }, signal);
        const data = browserResponse(result.result);
        if (data.success === true) {
          if (input.action === 'select') this.selections.set(browser, { tab: input.target, generation: result.generation });
          else if (current?.tab === input.target) this.selections.delete(browser);
        }
        return await this.output(result);
      }
      if (input.action === 'open' || input.action === 'window') {
        const args = input.action === 'open' ? { url: input.url, label: input.label } : {};
        validateBrowserValues(args);
        const result = await this.control.invoke({ browser, caller, requestContext, tool: input.action === 'open' ? 'agent_browser_tab_new' : 'agent_browser_window_new', args }, signal);
        const response = browserResponse(result.result);
        if (response.success === true && result.tab !== undefined) {
          this.selections.set(browser, { tab: result.tab, generation: result.generation, owned: true });
        }
        return await this.output(result);
      }
      if (current === undefined) throw new BrowserError('browser.target', 'Select or open a tab before choosing a frame');
      validateBrowserValues({ frame: input.frame });
      const result = await this.control.invoke({ browser, caller, requestContext, tab: current.tab, generation: current.generation,
        tool: input.frame === 'main' ? 'agent_browser_frame_main' : 'agent_browser_frame_switch', args: input.frame === 'main' ? {} : { frame: input.frame } }, signal);
      if (browserResponse(result.result).success === true) this.selections.set(browser, { ...current, frame: input.frame, observed: false });
      return await this.output(result);
    } catch (error) { return this.error(error); }
  }

  private async choose(explicit?: string): Promise<string> {
    if (!this.initialized) { this.selected = await this.defaults.ready; this.initialized = true; }
    const browser = explicit ?? this.selected;
    if (browser === undefined) throw new BrowserError('browser.not_found', `No browser selected. Available connections: ${JSON.stringify((await this.store.list()).connections)}`);
    const connection = await this.store.resolve(browser);
    if (!connection.enabled) throw new BrowserError('browser.disabled', `Browser "${browser}" is disabled; select another configured connection explicitly`);
    if (explicit !== undefined) this.selected = explicit;
    return browser;
  }

  private modelName(name: string): string { return `browser__${name}`; }

  private register(tool: MCPToolDefinition): void {
    const name = this.modelName(tool.name);
    if (this.registrations.has(name)) return;
    if (this.registry.resolve(name) !== undefined) throw new BrowserError('browser.invalid', `Browser tool name collision: ${name}`);
    const registration = this.registry.register({ name,
      description: `${tool.description}\nIn Kiki, browser and browserTab use this agent's explicit connection and tab selection.${tool.name === 'codex_browser_js' ? ' With a selected tab, kikiTab is bound through the official cua.getTab API. Use that binding and the official documentation; this is not a JavaScript sandbox or an agent-browser command.' : ''} A timeout does not confirm the action; check the execution state before continuing.`,
      parameters: projectBrowserToolSchema(tool),
      resolveExecution: async (raw: unknown): Promise<ToolExecution> => {
        try {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new BrowserError('browser.invalid', 'Expected typed browser tool arguments');
          const input = raw as Record<string, unknown>;
          const { browser: requested, browserTab: requestedTab, ...args } = input;
          if (tool.name !== 'codex_browser_js') validateBrowserValues(args);
          const browser = await this.choose(typeof requested === 'string' ? requested : undefined);
          const official = (await this.store.resolve(browser)).type === 'codex-extension';
          if (official !== /^codex_browser_js(?:_reset)?$/.test(tool.name)) throw new BrowserError('browser.unsupported', 'Load the typed tools for the selected browser provider; agent-browser and the official extension are not interchangeable');
          const selection = this.selections.get(browser);
          const tab = tool.name === 'codex_browser_js_reset' ? undefined : typeof requestedTab === 'string' ? requestedTab : selection?.tab;
          if (official) {
            const status = await this.control.status(browser);
            return { approvalRule: name, accesses: ToolAccesses.all(), execute: async (ctx) => {
              try {
                const result = await this.control.invoke({ browser, caller: { sessionId: this.session.sessionId, agentId: this.agent.agentId },
                  requestContext: this.requestContext(ctx), tool: tool.name, args, tab, generation: selection?.generation ?? status.generation }, ctx.signal);
                return await this.output(result, ctx);
              } catch (error) { return this.error(error); }
            } };
          }
          if (tab === undefined) throw new BrowserError('browser.target', 'Select or open a tab with BrowserTabs before reading or operating');
          const status = await this.control.status(browser);
          const bound = selection?.tab === tab ? selection : { tab, generation: status.generation };
          if (containsElementRef(args) && !bound.observed) throw new BrowserError('browser.target', 'Read a snapshot in this browser/tab/frame before using its element references');
          const prepared = await this.prepareFiles(tool.name, args);
          return { approvalRule: name, accesses: prepared.accesses, execute: async (ctx) => {
            try {
              ctx.signal.throwIfAborted();
              await prepared.verify();
              const result = await this.control.invoke({ browser, caller: { sessionId: this.session.sessionId, agentId: this.agent.agentId },
                requestContext: this.requestContext(ctx), tool: tool.name, args: prepared.args, tab, frame: bound.frame, generation: bound.generation }, ctx.signal);
              const ok = browserResponse(result.result).success === true;
              this.selections.set(browser, { ...bound, observed: ok && tool.name === 'agent_browser_snapshot' ? true : bound.observed });
              const captureKey = JSON.stringify([browser, tab, bound.frame, bound.generation]);
              if (ok && /^agent_browser_record_(?:start|restart)$/.test(tool.name) && prepared.outputPath !== undefined) this.recordings.set(captureKey, prepared.outputPath);
              const expectedPath = tool.name === 'agent_browser_record_stop' ? this.recordings.get(captureKey) : prepared.outputPath;
              const output = await this.output(result, ctx, expectedPath);
              if (ok && tool.name === 'agent_browser_record_stop') this.recordings.delete(captureKey);
              return output;
            } catch (error) { return this.error(error); }
          } };
        } catch (error) { return { isError: true, output: error instanceof Error ? error.message : String(error) }; }
      } }, { source: 'builtin' });
    this.registrations.set(name, this._register(registration));
  }

  private async prepareFiles(tool: string, original: Record<string, unknown>) {
    const args = { ...original };
    const artifactExtension = tool === 'agent_browser_screenshot' ? (args['format'] === 'jpeg' ? '.jpg' : '.png')
      : /agent_browser_(?:network_har|trace|profiler)_stop$/.test(tool) ? '.json' : undefined;
    if (artifactExtension !== undefined && args['path'] === undefined) {
      const runtime = await prepareToolRuntime(this.runtime, 'local');
      args['path'] = runtime.path.join(this.session.sessionDir, `${tool}-${randomUUID()}${artifactExtension}`);
    }
    const paths: { key: string; value: string; operation: 'read' | 'write'; index?: number }[] = [];
    if (tool === 'agent_browser_upload' && Array.isArray(args['files'])) {
      args['files'] = [...args['files']];
      for (const [index, value] of (args['files'] as unknown[]).entries()) if (typeof value === 'string') paths.push({ key: 'files', value, operation: 'read', index });
    }
    for (const key of ['path', 'baseline', 'output']) {
      const value = args[key];
      if (typeof value === 'string') paths.push({ key, value, operation: key === 'baseline' || /state_load/.test(tool) ? 'read' : 'write' });
    }
    if (paths.length === 0) return { args, accesses: ToolAccesses.all(), outputPath: undefined, verify: async () => undefined };
    const runtime = await prepareToolRuntime(this.runtime, 'local');
    if (runtime.fs === undefined) throw new BrowserError('browser.invalid', 'Browser files require the Kiki service host filesystem');
    const view = new RuntimeWorkspaceView(runtime, { workDir: this.workspace.workDir, additionalDirs: this.workspace.additionalDirs });
    const workspace: WorkspaceConfig = { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
    const env = { _serviceBrand: undefined, ...runtime.environment, ready: Promise.resolve() };
    const accesses: ToolFileAccess[] = [];
    const admitted: { original: string; path: string; operation: 'read' | 'write' }[] = [];
    for (const path of paths) {
      if (!runtime.path.isAbsolute(path.value)) throw new BrowserError('browser.invalid', 'Browser file paths must be absolute paths on the Kiki service host, not GUI/SSH paths');
      const result = await resolveRealPathAccess(path.value, { env, workspace, operation: path.operation }, runtime.fs);
      admitted.push({ original: path.value, path: result.path, operation: path.operation });
      accesses.push({ kind: 'file', operation: path.operation, path: result.path, implicitExternal: result.implicitExternal });
      if (path.index !== undefined) (args[path.key] as string[])[path.index] = result.path;
      else args[path.key] = result.path;
    }
    return { args, accesses: [...ToolAccesses.all(), ...accesses], outputPath: typeof args['path'] === 'string' && paths.some((item) => item.key === 'path' && item.operation === 'write') ? args['path'] : undefined,
      verify: async () => {
        const current = await prepareToolRuntime(this.runtime, 'local');
        if (current.identity.generation !== runtime.identity.generation || current.fs === undefined) throw new BrowserError('browser.invalid', 'File runtime changed before browser execution');
        for (const path of admitted) if (await resolveRealPathAccessPath(path.original, { env, workspace, operation: path.operation }, current.fs) !== path.path) throw new BrowserError('browser.invalid', 'File path changed after permission evaluation');
      } };
  }

  private async output(result: BrowserInvocationResult, ctx?: ExecutableToolContext, expectedPath?: string): Promise<ExecutableToolResult> {
    const converted = await mcpResultToExecutableOutput(result.result, 'Browser', { attachmentStore: this.media, preserveStructuredContent: true });
    const provenance = JSON.stringify({ browser: result.browser, executionHost: result.executionHost, runtimeSession: result.runtimeSession,
      generation: result.generation, targetId: result.tab, frame: result.frame });
    const parts = typeof converted.output === 'string' ? [{ type: 'text' as const, text: converted.output }] : [...converted.output];
    parts.unshift({ type: 'text', text: `Browser provenance: ${provenance}` });
    const path = browserResponse(result.result).data?.['path'];
    if (ctx !== undefined && expectedPath !== undefined && typeof path === 'string' && path === expectedPath && !converted.isError) {
      const runtime = await prepareToolRuntime(this.runtime, 'local');
      const stat = await runtime.fs!.stat(path);
      if (stat.isFile && stat.size <= 20 * 1024 * 1024) {
        const bytes = await runtime.fs!.readBytes(path);
        const fileId = `browser-${createHash('sha256').update(`${provenance}:${ctx.toolCallId}:${path}`).digest('hex')}`;
        await this.media.materialize({ fileId, size: bytes.byteLength, name: runtime.path.basename(path), mimeType: 'application/octet-stream', stream: () => Readable.from([bytes]) });
        parts.push({ type: 'text', text: `Browser file (${provenance}): [${runtime.path.basename(path)}](${buildDaemonFileUrl(fileId)})` });
      } else parts.push({ type: 'text', text: 'File remains on the indicated execution host; automatic attachment is limited to 20 MiB. Use the existing file channel to retrieve it.' });
    }
    return { ...converted, output: parts };
  }

  private json(value: unknown): ExecutableToolResult { return { output: JSON.stringify(value, null, 2) }; }
  private error(error: unknown): ExecutableToolResult { return { isError: true, output: error instanceof Error ? error.message : String(error) }; }
}

function containsElementRef(args: Readonly<Record<string, unknown>>): boolean {
  const contains = (value: unknown): boolean => typeof value === 'string' ? /^@?e\d+$/.test(value)
    : value !== null && typeof value === 'object' ? Object.values(value).some(contains) : false;
  return contains(args);
}
registerScopedService(LifecycleScope.Agent, IAgentBrowserService, AgentBrowserService, ScopeActivation.OnDemand, 'browser');

export interface IBrowserConnectionsTool extends AgentTool<BrowserConnectionsInput> { readonly _serviceBrand: undefined }
export const IBrowserConnectionsTool = createDecorator<IBrowserConnectionsTool>('browserConnectionsTool');
export class BrowserConnectionsTool implements IBrowserConnectionsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'BrowserConnections';
  readonly description = 'Discover saved browser connections, explicitly select/connect one, inspect its real execution state, or disconnect it. Loading groups/tools exposes the donor\'s typed deep-control operations on demand, without loading the entire catalog. Omitted browser uses only this agent\'s selected connection or the new-session default; never a guessed ready browser.';
  readonly parameters = toInputJsonSchema(BrowserConnectionsInputSchema);
  constructor(@IAgentBrowserService private readonly browser: IAgentBrowserService) {}
  resolveExecution(input: BrowserConnectionsInput): ToolExecution {
    const args = BrowserConnectionsInputSchema.parse(input);
    return { approvalRule: this.name, accesses: ['list', 'status', 'tools', 'select'].includes(args.action) ? ToolAccesses.none() : ToolAccesses.all(), execute: (ctx) => this.browser.connections(args, ctx.signal, ctx) };
  }
}
export interface IBrowserTabsTool extends AgentTool<BrowserTabsInput> { readonly _serviceBrand: undefined }
export const IBrowserTabsTool = createDecorator<IBrowserTabsTool>('browserTabsTool');
export class BrowserTabsTool implements IBrowserTabsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'BrowserTabs';
  readonly description = 'List, open, explicitly select or close tabs in a selected browser connection. Targets are exact identities returned by this provider (CDP targetIds or official extension tab ids), not tab indexes. Window and frame operations require provider support. It never follows the user\'s foreground tab. Read a fresh snapshot after changing tab/frame or reconnecting.';
  readonly parameters = toInputJsonSchema(BrowserTabsInputSchema);
  constructor(@IAgentBrowserService private readonly browser: IAgentBrowserService) {}
  resolveExecution(input: BrowserTabsInput): ToolExecution {
    const args = BrowserTabsInputSchema.parse(input);
    return { approvalRule: this.name, accesses: args.action === 'list' ? ToolAccesses.none() : ToolAccesses.all(), execute: (ctx) => this.browser.tabs(args, ctx.signal, ctx) };
  }
}
registerAgentToolService(IBrowserConnectionsTool, BrowserConnectionsTool, { name: 'BrowserConnections', source: 'builtin', domain: 'browser', when: (accessor) => accessor.get(IFlagService).enabled(NATIVE_BROWSER_FLAG_ID) });
registerAgentToolService(IBrowserTabsTool, BrowserTabsTool, { name: 'BrowserTabs', source: 'builtin', domain: 'browser', when: (accessor) => accessor.get(IFlagService).enabled(NATIVE_BROWSER_FLAG_ID) });
