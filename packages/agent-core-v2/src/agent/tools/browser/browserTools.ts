import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';

import { createDecorator, type ServiceIdentifier, type ServicesAccessor } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentRuntimeService, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { prepareToolRuntime, toolApprovalRule } from '#/agent/tools/os/sshToolTarget';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { IBrowserControlService, type BrowserInvocationResult } from '#/app/browser/browser';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { BROWSER_CONFIG_SECTION, BrowserIdSchema, browserOperationAllowed, browserSourceOfConnection, type BrowserConfig } from '#/app/browser/browserConfig';
import { BROWSER_OWNED_FIELDS, browserManagedLifecycle, browserResponse, browserToolGroup, isBrowserOperation } from '#/app/browser/browserControlService';
import { BrowserError } from '#/app/browser/errors';
import { LifecycleScope } from '#/app/scopes';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IEventBus } from '#/app/event/eventBus';
import { TurnEnded } from '#/agent/loop/turnOps';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { catalogBackend, type BrowserRequestContext } from '#/app/browser/codexBrowser';
import { browserElicitation } from './browserElicitation';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { buildDaemonFileUrl } from '#/agent/media/mediaRef';
import { mcpResultToExecutableOutput } from '#/agent/mcp/output';
import { assertMcpInputSchema, type MCPToolDefinition } from '#/mcpCore/types';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IFlagService } from '#/app/flag/flag';
import { IInstantiationService } from '#/_base/di/instantiation';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IConfigService } from '#/app/config/config';
import { NATIVE_BROWSER_FLAG_ID } from '#/app/browser/flag';
import { EGO_LITE_CONNECTION_ID } from '#/app/browser/ego/resolveCli';
import { resolveRealPathAccess, resolveRealPathAccessPath, type WorkspaceConfig } from '#/tool/path-access';
import { ToolAccesses, type AgentTool, type ExecutableToolContext, type ExecutableToolResult, type ToolExecution, type ToolFileAccess } from '#/tool/toolContract';
import type { Runtime } from '#/runtime/runtime';

export const BrowserConnectionsInputSchema = z.object({ action: z.enum(['list', 'select', 'status', 'check', 'connect', 'disconnect', 'tools']).default('list'),
  browser: BrowserIdSchema.optional(), groups: z.array(z.enum(['page', 'network', 'state', 'debug', 'input', 'react'])).optional(),
  tools: z.array(z.string().regex(/^(?:agent_browser_[a-z0-9_]+|codex_[a-z0-9_]+)$/)).optional(),
  unload: z.array(z.string().regex(/^(?:agent_browser_[a-z0-9_]+|codex_[a-z0-9_]+)$/)).optional() }).strict();
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
export const BrowserEgoRunInputSchema = z.object({ browser: BrowserIdSchema.optional(), script: z.string().min(1) }).strict();
export type BrowserEgoRunInput = z.infer<typeof BrowserEgoRunInputSchema>;

export function egoRunExecution(script: string, runtime: Runtime, execute: (ctx: ExecutableToolContext) => Promise<ExecutableToolResult>): ToolExecution {
  return { display: { kind: 'command', command: script, language: 'bash' }, approvalRule: toolApprovalRule('browser__ego_run', script, runtime), execute };
}

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
  egoExecution(input: BrowserEgoRunInput): Promise<ToolExecution>;
  egoRun(input: BrowserEgoRunInput, signal?: AbortSignal, context?: ExecutableToolContext): Promise<ExecutableToolResult>;
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
  private readonly loadedCatalog = new Map<string, { backend: ReturnType<typeof catalogBackend>; tools: MCPToolDefinition[] }>();
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
    @IFlagService private readonly flags: IFlagService,
    @IConfigService private readonly config: IConfigService,
    @IAgentToolPolicyService private readonly policy: IAgentToolPolicyService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    const caller = { sessionId: this.session.sessionId, agentId: this.agent.agentId };
    this._store.ledger.register(() => this.control.endTurn(caller), 'official-browser-turn-cleanup');
    this._register(eventBus.subscribe(TurnEnded, (event) => {
      void this.control.endTurn(caller, event.turnId).catch(onUnexpectedError);
    }));
    if (config.onDidSectionChange !== undefined) {
      this._register(config.onDidSectionChange(() => this.refreshLoaded()));
    }
    const capability = this.optionalCapabilityPolicy();
    if (capability !== undefined) this._register(capability.onDidChange(() => { this.refreshLoaded(); }));
  }

  private optionalCapabilityPolicy(): IOptionalCapabilityPolicy | undefined {
    try {
      return this.instantiation.invokeFunction((accessor) => accessor.get(IOptionalCapabilityPolicy)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private refreshLoaded(): void {
    const config = this.config.get<BrowserConfig>(BROWSER_CONFIG_SECTION);
    const wanted = new Map<string, MCPToolDefinition>();
    if (this.flags.enabled(NATIVE_BROWSER_FLAG_ID)) {
      for (const [browser, entry] of this.loadedCatalog) {
        if (!browserOperationAllowed(config?.allowedBrowsers, browser)) continue;
        const conn = config?.connections?.[browser];
        if (conn?.enabled !== true) continue;
        if (config?.disabledSources?.includes(browserSourceOfConnection(conn)) === true) continue;
        for (const tool of entry.tools) {
          const name = this.modelName(tool.name);
          if (this.policy.isToolActiveForDisclosure(name, 'builtin')) wanted.set(name, tool);
        }
      }
    }
    for (const [name, registration] of this.registrations) {
      if (wanted.has(name)) continue;
      registration.dispose();
      this.registrations.delete(name);
    }
    for (const tool of wanted.values()) this.register(tool);
  }

  private loadedTool(browser: string, name: string): { backend: ReturnType<typeof catalogBackend>; tool: MCPToolDefinition } {
    if (this._store.isDisposed || !this.flags.enabled(NATIVE_BROWSER_FLAG_ID) || !this.policy.isToolActiveForDisclosure(this.modelName(name), 'builtin')) {
      throw new BrowserError('browser.disabled', 'This browser tool is disabled by the current control settings or tool policy');
    }
    const entry = this.loadedCatalog.get(browser);
    const tool = entry?.tools.find((item) => item.name === name);
    if (entry === undefined || tool === undefined) throw new BrowserError('browser.unsupported', `Load ${name} for browser "${browser}" through BrowserConnections before using it`);
    return { backend: entry.backend, tool };
  }

  private requestContext(ctx?: ExecutableToolContext): BrowserRequestContext | undefined {
    if (ctx === undefined) return undefined;
    const caller = { sessionId: this.session.sessionId, agentId: this.agent.agentId };
    return { caller, turnId: ctx.turnId, toolCallId: ctx.toolCallId, sessionDir: this.session.sessionDir,
      elicit: (request, signal) => browserElicitation(this.approvals, caller, ctx.turnId, ctx.toolCallId, request, AbortSignal.any([ctx.signal, signal])) };
  }

  async connections(input: BrowserConnectionsInput, signal?: AbortSignal, ctx?: ExecutableToolContext): Promise<ExecutableToolResult> {
    try {
      signal?.throwIfAborted();
      if (input.action === 'list') {
        const listed = await this.control.list();
        const discovered = await this.control.discover();
        const seen = new Set(listed.connections.map((item) => item.id));
        return this.json({ ...listed, connections: [...listed.connections, ...discovered.filter((item) => !seen.has(item.id))], selectedBrowser: this.selected });
      }
      if (input.browser === EGO_LITE_CONNECTION_ID && (input.action === 'check' || input.action === 'connect' || input.action === 'select' || input.action === 'status')) {
        const discovered = await this.unsavedEgo(input.action, signal);
        if (discovered !== undefined) return discovered;
      }
      const browser = await this.choose(input.browser, input.action === 'status' || input.action === 'disconnect' || input.action === 'tools' ? 'read' : 'operate');
      signal?.throwIfAborted();
      if (input.action === 'select') return this.json({ selectedBrowser: browser, status: await this.control.status(browser), selectedTab: this.selections.get(browser) });
      if (input.action === 'tools') {
        const tools = await this.control.catalog(browser, signal);
        const listed = await this.store.list();
        signal?.throwIfAborted();
        if (this._store.isDisposed) throw new BrowserError('browser.disconnected', 'This agent browser scope has closed');
        const backend = catalogBackend(tools);
        const retained = new Map((this.loadedCatalog.get(browser)?.tools ?? []).map((tool) => [tool.name, tool]));
        for (const name of input.unload ?? []) retained.delete(name);
        const operations = tools.filter((tool) => isBrowserOperation(tool.name));
        const requested = operations.filter((tool) => input.groups?.includes(browserToolGroup(tool.name) as 'page') || input.tools?.includes(tool.name));
        const conn = listed.connections.find((entry) => entry.id === browser);
        const sourceEnabled = conn !== undefined && listed.disabledSources?.includes(browserSourceOfConnection(conn)) !== true;
        const allowed = sourceEnabled && browserOperationAllowed(listed.allowedBrowsers, browser);
        if (allowed) for (const tool of requested) retained.set(tool.name, tool);
        if (retained.size === 0) this.loadedCatalog.delete(browser);
        else this.loadedCatalog.set(browser, { backend, tools: [...retained.values()] });
        this.refreshLoaded();
        return this.json({ browser, backend, namespace: backend, backendToolCount: tools.length,
          contextIsolation: backend === 'official-cua-repl'
            ? 'Official extension browser/tab ids are preserved. Use codex_browser_js and its runtime documentation; window/frame emulation is unsupported.'
            : backend === 'codex-browser-bridge'
              ? 'Tools that declare tab_id use this agent\'s selected tab. codex_claim_tab keeps the user-tab id returned by codex_user_tabs. The bridge writes its own session id on the pipe frame; Kiki caller metadata stays on the MCP request and is not copied onto that frame. Approval remains the existing elicitation.'
              : 'BrowserTabs window creates an opaque donor browser context and a targetId-bound tab. Named context list/switch/dispose APIs are unavailable; no synthetic context ids are exposed.',
          operations: operations.map((tool) => ({ name: tool.name, modelTool: this.modelName(tool.name), group: browserToolGroup(tool.name) })),
          managedLifecycle: tools.filter((tool) => browserManagedLifecycle(tool.name)).map((tool) => ({ name: tool.name, surface: /connect|close$|finalize$/.test(tool.name) && !/tab_close/.test(tool.name) ? 'BrowserConnections' : 'BrowserTabs' })),
          administrativeCapabilities: tools.filter((tool) => !isBrowserOperation(tool.name) && !browserManagedLifecycle(tool.name)).map((tool) => ({ name: tool.name, availableAsPageTool: false,
            reason: 'Donor-wide installation, plugins, credential or cross-session administration is outside a selected page execution lease.' })),
          loaded: allowed && listed.connections.some((entry) => entry.id === browser && entry.enabled)
            ? [...retained.keys()].map((name) => this.modelName(name)).filter((name) => this.registrations.has(name)) : [], allowed, status: await this.control.status(browser),
          note: allowed
            ? 'Use groups or tools to load only the typed operations needed for this task. Tab/frame lifecycle uses BrowserTabs. Browser installation and cross-session management are not page operations.'
            : 'This connection is visible but not in the allowed set, so its operation tools were not registered. List and discover stay available.' });
      }
      if (input.action === 'connect') return this.json(await this.control.connect(browser, signal, this.requestContext(ctx)));
      if (input.action === 'disconnect') { const status = await this.control.disconnect(browser, signal); this.selections.delete(browser); return this.json(status); }
      return this.json(await (input.action === 'check' ? this.control.check(browser, signal, this.requestContext(ctx)) : this.control.status(browser)));
    } catch (error) { return this.error(error); }
  }

  async tabs(input: BrowserTabsInput, signal?: AbortSignal, ctx?: ExecutableToolContext): Promise<ExecutableToolResult> {
    try {
      signal?.throwIfAborted();
      const browser = await this.choose(input.browser, input.action === 'list' ? 'read' : 'operate');
      const connection = await this.store.resolve(browser);
      if (connection.type === 'ego-lite' && (input.action === 'window' || input.action === 'frame')) {
        throw new BrowserError('browser.unsupported', 'The Ego Lite Page API has no window or frame method');
      }
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

  async egoExecution(input: BrowserEgoRunInput): Promise<ToolExecution> {
    const args = BrowserEgoRunInputSchema.parse(input);
    const inspected = this.runtime.inspect();
    if (inspected.identity.runtimeId.startsWith('ssh:')) {
      return { isError: true, output: 'Ego Lite runs on the computer where Kiki is running, not through an SSH workspace.' };
    }
    return egoRunExecution(args.script, inspected, (ctx) => this.egoRun(args, ctx.signal, ctx));
  }

  async egoRun(input: BrowserEgoRunInput, signal?: AbortSignal, ctx?: ExecutableToolContext): Promise<ExecutableToolResult> {
    try {
      signal?.throwIfAborted();
      const browser = await this.choose(input.browser, 'operate');
      const connection = await this.store.resolve(browser);
      if (connection.type !== 'ego-lite') throw new BrowserError('browser.unsupported', 'browser__ego_run runs on an Ego Lite connection');
      const caller = { sessionId: this.session.sessionId, agentId: this.agent.agentId };
      const result = await this.control.invoke({
        browser, caller, requestContext: this.requestContext(ctx), tool: 'browser__ego_run', args: { script: input.script },
        tab: this.selections.get(browser)?.tab,
      }, signal);
      return await this.output(result, ctx);
    } catch (error) { return this.error(error); }
  }

  private async unsavedEgo(action: BrowserConnectionsInput['action'], signal?: AbortSignal): Promise<ExecutableToolResult | undefined> {
    try {
      await this.store.resolve(EGO_LITE_CONNECTION_ID);
      return undefined;
    } catch (error) {
      if (!(error instanceof BrowserError) || error.code !== 'browser.not_found') throw error;
    }
    if (action === 'status') {
      const found = await this.control.discover();
      const row = found.find((item) => item.id === EGO_LITE_CONNECTION_ID);
      if (row === undefined) throw new BrowserError('browser.not_found', `Unknown browser connection "${EGO_LITE_CONNECTION_ID}"`);
      return this.json({ ...row.status, selectedBrowser: this.selected });
    }
    if (action === 'check') return this.json(await this.control.probeDiscovered(false, signal));
    const status = await this.control.probeDiscovered(true, signal);
    if (status.state === 'ready') this.selected = EGO_LITE_CONNECTION_ID;
    return this.json({ ...status, selectedBrowser: this.selected });
  }

  private async choose(explicit: string | undefined, intent: 'read' | 'operate'): Promise<string> {
    if (!this.initialized) { this.selected = await this.defaults.ready; this.initialized = true; }
    const listed = await this.store.list();
    const fallback = this.selected !== undefined && browserOperationAllowed(listed.allowedBrowsers, this.selected) ? this.selected : undefined;
    const browser = explicit ?? (intent === 'operate' ? fallback : this.selected);
    if (browser === undefined) throw new BrowserError('browser.not_found', `No browser selected. List and discover stay available. Connections: ${JSON.stringify(listed.connections.map((connection) => ({ id: connection.id, type: connection.type, enabled: connection.enabled, allowed: browserOperationAllowed(listed.allowedBrowsers, connection.id) })))}`);
    const connection = await this.store.resolve(browser);
    if (intent === 'read') {
      if (explicit !== undefined) this.selected = explicit;
      return browser;
    }
    const sourceDisabled = listed.disabledSources?.includes(browserSourceOfConnection(connection)) === true;
    if (!connection.enabled || sourceDisabled) throw new BrowserError('browser.disabled', `Browser "${browser}" is disabled; select another configured connection explicitly`, { details: { reason: 'connection_disabled' } });
    if (!browserOperationAllowed(listed.allowedBrowsers, browser)) throw new BrowserError('browser.disabled', `Browser "${browser}" is not in the allowed set. List and discover stay available.`, { details: { reason: 'not_allowed' } });
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
          const browser = await this.choose(typeof requested === 'string' ? requested : undefined, 'operate');
          const loaded = this.loadedTool(browser, tool.name);
          const provider = loaded.backend;
          const jsTool = /^codex_browser_js(?:_reset)?$/.test(tool.name);
          if (provider === 'agent-browser' && tool.name.startsWith('codex_') || provider === 'official-cua-repl' && !jsTool || provider === 'codex-browser-bridge' && (!tool.name.startsWith('codex_') || jsTool)) {
            throw new BrowserError('browser.unsupported', 'Load the typed tools for the selected browser provider; agent-browser, the official runtime, and codex-browser-bridge are not interchangeable');
          }
          if (provider === 'agent-browser') validateBrowserValues(args);
          else if (tool.name !== 'codex_browser_js') {
            for (const key of Object.keys(args)) if (BROWSER_OWNED_FIELDS.has(key)) throw new BrowserError('browser.invalid', `Browser identity field "${key}" is managed by Kiki`);
          }
          const selection = this.selections.get(browser);
          const properties = schemaProperties(loaded.tool.inputSchema);
          const claim = tool.name === 'codex_claim_tab';
          const tabScoped = provider === 'codex-browser-bridge' && !claim && properties !== undefined && 'tab_id' in properties;
          const tab = tool.name === 'codex_browser_js_reset' || claim ? undefined : typeof requestedTab === 'string' ? requestedTab : selection?.tab;
          if (tabScoped && tab === undefined) throw new BrowserError('browser.target', 'Select or open a tab with BrowserTabs before reading or operating');
          if (tabScoped && 'tab_id' in args && args['tab_id'] !== undefined && args['tab_id'] !== tab) throw new BrowserError('browser.target', 'The bridge tab is the selected Kiki tab, not a different caller-supplied id');
          const forwarded = tabScoped ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'tab_id')) : args;
          if (provider === 'official-cua-repl' || provider === 'codex-browser-bridge') {
            const status = await this.control.status(browser);
            return { approvalRule: name, accesses: ToolAccesses.all(), execute: async (ctx) => {
              try {
                ctx.signal.throwIfAborted();
                this.loadedTool(browser, tool.name);
                const result = await this.control.invoke({ browser, caller: { sessionId: this.session.sessionId, agentId: this.agent.agentId },
                  requestContext: this.requestContext(ctx), assertToolAllowed: () => { this.loadedTool(browser, tool.name); }, tool: tool.name, args: forwarded, tab, generation: selection?.generation ?? status.generation }, ctx.signal);
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
              this.loadedTool(browser, tool.name);
              const result = await this.control.invoke({ browser, caller: { sessionId: this.session.sessionId, agentId: this.agent.agentId },
                requestContext: this.requestContext(ctx), assertToolAllowed: () => { this.loadedTool(browser, tool.name); }, tool: tool.name, args: prepared.args, tab, frame: bound.frame, generation: bound.generation }, ctx.signal);
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
    const view = new RuntimeWorkspaceView(runtime, inspectAgentWorkspaceRoots(this.runtime, this.workspace));
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
    const shots = browserResponse(result.result).data?.['shots'];
    if (ctx !== undefined && Array.isArray(shots) && !converted.isError) {
      const runtime = await prepareToolRuntime(this.runtime, 'local');
      if (runtime.fs !== undefined) {
        for (const shot of shots) {
          if (typeof shot !== 'string' || shot === '') continue;
          const stat = await runtime.fs.stat(shot).catch(() => undefined);
          if (stat === undefined || !stat.isFile) continue;
          if (stat.size > 20 * 1024 * 1024) {
            parts.push({ type: 'text', text: 'File remains on the indicated execution host; automatic attachment is limited to 20 MiB. Use the existing file channel to retrieve it.' });
            continue;
          }
          const bytes = await runtime.fs.readBytes(shot);
          const fileId = `browser-${createHash('sha256').update(`${provenance}:${ctx.toolCallId}:${shot}`).digest('hex')}`;
          await this.media.materialize({ fileId, size: bytes.byteLength, name: runtime.path.basename(shot), mimeType: 'application/octet-stream', stream: () => Readable.from([bytes]) });
          parts.push({ type: 'text', text: `Browser file (${provenance}): [${runtime.path.basename(shot)}](${buildDaemonFileUrl(fileId)})` });
        }
      }
    }
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

function schemaProperties(schema: unknown): Record<string, unknown> | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const properties = (schema as Record<string, unknown>)['properties'];
  return properties !== null && typeof properties === 'object' && !Array.isArray(properties) ? properties as Record<string, unknown> : undefined;
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
  readonly description = 'Discover saved browser connections and an installed Ego Lite CLI. Check, select, or connect one explicitly, inspect its real execution state, or disconnect it. A check does not replay a timed-out command or stop the browser. Loading groups/tools exposes the donor\'s typed deep-control operations on demand, without loading the entire catalog. Omitted browser uses only this agent\'s selected connection or the new-session default; never a guessed ready browser.';
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
export interface IBrowserEgoRunTool extends AgentTool<BrowserEgoRunInput> { readonly _serviceBrand: undefined }
export const IBrowserEgoRunTool = createDecorator<IBrowserEgoRunTool>('browserEgoRunTool');
export class BrowserEgoRunTool implements IBrowserEgoRunTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'browser__ego_run';
  readonly description = 'Run one script in this agent\'s Ego Lite space. `task` is already bound to that space. `shotDir` is an absolute directory for this call; write a file such as `page.screenshot({ path: shotDir + \'/shot.png\' })`. A screenshot counts only when the script writes a png or jpeg there. Omitting `path` leaves the file in the system temp directory, and that file is not attached. Print `page.snapshot()` when the next step needs refs. Kiki does not install Ego Lite and does not import Chrome data.';
  readonly parameters = toInputJsonSchema(BrowserEgoRunInputSchema);
  constructor(@IAgentBrowserService private readonly browser: IAgentBrowserService) {}
  resolveExecution(input: BrowserEgoRunInput): Promise<ToolExecution> {
    return this.browser.egoExecution(BrowserEgoRunInputSchema.parse(input));
  }
}
registerAgentToolService(IBrowserConnectionsTool, BrowserConnectionsTool, { name: 'BrowserConnections', source: 'builtin', domain: 'browser', when: browserCapabilityWhen });
registerAgentToolService(IBrowserTabsTool, BrowserTabsTool, { name: 'BrowserTabs', source: 'builtin', domain: 'browser', when: browserCapabilityWhen });
registerAgentToolService(IBrowserEgoRunTool, BrowserEgoRunTool, { name: 'browser__ego_run', source: 'builtin', domain: 'browser', when: browserEgoCapabilityWhen });

function browserEgoCapabilityWhen(accessor: ServicesAccessor): boolean {
  if (!browserCapabilityWhen(accessor)) return false;
  const config = present(accessor, IConfigService)?.get<BrowserConfig>(BROWSER_CONFIG_SECTION);
  const connection = config?.connections?.[EGO_LITE_CONNECTION_ID];
  return connection?.type === 'ego-lite' && connection.enabled && config?.disabledSources?.includes('ego-lite') !== true;
}

function browserCapabilityWhen(accessor: ServicesAccessor): boolean {
  if (!accessor.get(IFlagService).enabled(NATIVE_BROWSER_FLAG_ID)) return false;
  const policy = present(accessor, IOptionalCapabilityPolicy);
  if (policy === undefined) return true;
  const session = present(accessor, ISessionContext);
  if (session === undefined) return true;
  const agent = present(accessor, IAgentScopeContext);
  return policy.admit('browser', { sessionId: session.sessionId, workspaceId: session.workspaceId, agentId: agent?.agentId }).admitted;
}

function present<T>(accessor: ServicesAccessor, id: ServiceIdentifier<T>): T | undefined {
  const probed = accessor as ServicesAccessor & { has?: (service: ServiceIdentifier<unknown>) => boolean };
  if (typeof probed.has === 'function' && !probed.has(id)) return undefined;
  try {
    return accessor.get(id) ?? undefined;
  } catch {
    return undefined;
  }
}
