import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeChildEnv } from '#/_base/execEnv/childEnv';
import { kikiChildDefaults } from '#/app/bootstrap/childEnvironment';

import { PLUGIN_IM_COMPLETE_LIMITS, PLUGIN_IM_DIAGNOSTIC_LIMITS, pluginImDiagnosticReportSchema, sessionSourceDefinitionSchema, mediaProviderDefinitionSchema, pluginImAdapterDefinitionSchema, pluginImHistoryRequestSchema, pluginImHistoryPageSchema, type ImInboundDiagnostic, type PluginImAdapterDefinition, type PluginImEvent, type PluginMessagesApi, type MediaProviderDefinition, type PluginMediaApi, type SessionSourceDefinition } from '@kiki/protocol';
import { parsePluginImEvent, pluginImDeliverySchema, pluginImIdentitySchema, type PluginImConnection } from './imAdapter';
import { toolContributionSchema, type PluginTool } from './contributions';
import type { ExecutableToolResult, ToolUpdate } from '#/tool/toolContract';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { PluginToolOutput } from './toolOutput';
import {
  parsePluginImRequest, pluginImReceipt, sanitizePluginImCapabilities, sanitizePluginImReceipt, sanitizePluginImRoutes,
  type PluginImBridge,
} from './pluginImBridge';

export const PLUGIN_RPC_VERSION = 1;
const IDLE_MS = 90_000;
const HANDSHAKE_MS = 15_000;
const MAX_RPC_LINE_CHARS = 16 * 1024 * 1024;

function validToolResult(result: unknown, references: ReadonlySet<string>): result is ExecutableToolResult {
  if (typeof result !== 'object' || result === null || !('output' in result)) return false;
  const { output, isError } = result as { output: unknown; isError?: unknown };
  if (isError !== undefined && typeof isError !== 'boolean') return false;
  if (typeof output === 'string') return true;
  return Array.isArray(output) && output.every((part: unknown) => {
    if (typeof part !== 'object' || part === null || !('type' in part)) return false;
    const value = part as { type: unknown; text?: unknown; imageUrl?: { url?: unknown } };
    return (value.type === 'text' && typeof value.text === 'string') ||
      (value.type === 'image_url' && typeof value.imageUrl?.url === 'string' &&
        (references.has(value.imageUrl.url) || /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.imageUrl.url)));
  });
}

interface Call {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly onProgress?: (update: ToolUpdate) => void;
  readonly media?: PluginMediaApi;
  readonly messages?: PluginMessagesApi;
  readonly output?: PluginToolOutput;
  readonly connection?: () => Promise<unknown>;
}

export class PluginHost {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Call>();
  private readonly registered = new Set<string>();
  private readonly registeredSources = new Set<string>();
  private readonly registeredProviders = new Set<string>();
  private readonly registeredImAdapters = new Set<string>();
  private readonly imListeners = new Map<string, (event: PluginImEvent) => Promise<void>>();
  private readonly imAssemblies = new Map<string, { callId: number; characters: number; received: number; chunks: string[]; listener: (event: PluginImEvent) => Promise<void>; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private ready?: Promise<void>;
  private exited: Promise<void> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private activitySubscription?: { dispose(): void };
  private readonly imCalls = new Map<number, AbortController>();
  private nextImConnection = 0;
  private readonly imReportOwners = new Map<string, { id: number; accountId?: string; diagnostics: Map<string, ImInboundDiagnostic> }>();
  private readonly imDiagnostics = new Map<string, { accountId: string; diagnostics: Map<string, ImInboundDiagnostic> }>();

  constructor(
    readonly id: string,
    private readonly entry: string,
    private readonly definitions: readonly PluginTool[],
    private readonly sources: readonly SessionSourceDefinition[] = [],
    private readonly providers: readonly MediaProviderDefinition[] = [],
    private readonly lifecycle?: { readonly resident: boolean; readonly updateSettings: (values: Record<string, string | number | boolean | null>) => Promise<unknown>; readonly observeActivity?: (listener: (activity: readonly import('./pluginActivity').PluginActivity[]) => void) => { dispose(): void }; readonly focusSession?: (sessionId: string) => void; readonly im?: () => PluginImBridge | undefined },
    private readonly kikiHome?: string,
    private readonly imAdapters: readonly PluginImAdapterDefinition[] = [],
  ) {}

  async connectImAdapter(adapterId: string, settings: Record<string, unknown>, instanceId: string, listener: (event: PluginImEvent) => Promise<void>, offset?: number): Promise<PluginImConnection> {
    if (this.stopped) throw new Error(`Plugin ${this.id} has been unloaded`);
    await this.start();
    if (!this.registeredImAdapters.has(adapterId) || this.imListeners.has(adapterId)) throw new Error('IM adapter unavailable or already connected');
    this.imListeners.set(adapterId, listener);
    const owner = { id: ++this.nextImConnection, accountId: undefined as string | undefined, diagnostics: new Map<string, ImInboundDiagnostic>() };
    this.imReportOwners.set(adapterId, owner);
    try {
      const result = await this.lifecycleRequest('im-adapter-request', { adapterId, action: 'start', settings, instanceId, offset, connectionId: owner.id, messageLimits: PLUGIN_IM_COMPLETE_LIMITS }) as { accountId?: unknown; listenerAccountId?: unknown; targets?: unknown };
      if (typeof result?.accountId !== 'string' || result.accountId.length === 0 || result.accountId.length > 1024) throw new Error('IM adapter returned no account identity');
      owner.accountId = result.accountId;
      if (result.listenerAccountId !== undefined && (typeof result.listenerAccountId !== 'string' || result.listenerAccountId.length === 0 || result.listenerAccountId.length > 1024)) throw new Error('IM adapter returned an invalid listener account identity');
      const targets = result.targets === undefined ? undefined : pluginImIdentitySchema.array().max(1000).parse(result.targets);
      const retained = this.imDiagnostics.get(adapterId);
      if (retained?.accountId === owner.accountId) owner.diagnostics = retained.diagnostics;
      this.imDiagnostics.set(adapterId, { accountId: owner.accountId, diagnostics: owner.diagnostics });
      return { accountId: result.accountId, listenerAccountId: result.listenerAccountId, targets,
        inboundDiagnostics: () => [...owner.diagnostics.values()].map((entry) => ({ ...entry })),
        request: async (action, input) => {
          if (this.stopped || !this.imListeners.has(adapterId)) throw new Error('IM adapter was withdrawn');
          const result = await this.lifecycleRequest('im-adapter-request', { adapterId, action, input });
          return action === 'answerCallback' ? undefined : pluginImDeliverySchema.parse(result);
        },
        readHistory: async (raw) => {
          if (this.stopped || !this.imListeners.has(adapterId)) throw new Error('IM adapter was withdrawn');
          const definition = this.imAdapters.find((entry) => entry.id === adapterId);
          if (definition?.inbound !== true || definition.supportsHistory !== true) return { status: 'unsupported' };
          const input = pluginImHistoryRequestSchema.parse(raw);
          const page = pluginImHistoryPageSchema.parse(await this.lifecycleRequest('im-adapter-request', { adapterId, action: 'readHistory', input }));
          if (page.status === 'ok' && (page.messages.length > input.limit || page.messages.some((row) => row.identity.chatId !== input.chatId || row.identity.topicId !== input.topicId))) throw new Error('IM history returned messages outside the requested chat/topic or limit');
          return page;
        },
        stop: async () => {
          if (this.imReportOwners.get(adapterId) !== owner) return;
          this.imReportOwners.delete(adapterId);
          this.clearImAssembly(adapterId);
          this.imListeners.delete(adapterId);
          if (this.child !== undefined) await this.lifecycleRequest('im-adapter-request', { adapterId, action: 'stop' });
          this.scheduleIdle();
        },
      };
    } catch (error) {
      this.imReportOwners.delete(adapterId);
      this.imListeners.delete(adapterId);
      if (this.child !== undefined) await this.lifecycleRequest('im-adapter-request', { adapterId, action: 'stop' }).catch(() => undefined);
      throw error;
    }
  }

  async activate(settings: Record<string, unknown>, userHome: string, dataDir: string): Promise<void> {
    if (this.stopped) throw new Error(`Plugin ${this.id} has been unloaded`);
    await this.start();
    await this.lifecycleRequest('activate', { settings, userHome, dataDir });
    this.activitySubscription?.dispose();
    this.activitySubscription = this.lifecycle?.observeActivity?.((activity) => this.send({ method: 'app-activity', params: { activity } }));
  }

  private lifecycleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Plugin ${this.id} lifecycle timed out`));
      }, 15_000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.send({ id, method, params });
    });
  }

  async requestMediaProvider(providerId: string, action: 'describe' | 'submit' | 'poll' | 'cancel' | 'voices', input: unknown, signal: AbortSignal, settings: Record<string, unknown>, context: { jobId: string; stagingDir: string; connection?: () => Promise<unknown> }, onProgress?: (update: ToolUpdate) => void): Promise<unknown> {
    if (this.stopped) throw new Error(`Plugin ${this.id} has been unloaded`);
    signal.throwIfAborted();
    await this.start();
    if (!this.registeredProviders.has(providerId)) throw new Error(`Plugin ${this.id} did not register media provider ${providerId}`);
    signal.throwIfAborted();
    clearTimeout(this.idle);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        signal.removeEventListener('abort', cancel);
        this.pending.delete(id);
        if (error) reject(error); else resolve(value);
        this.scheduleIdle();
      };
      const cancel = () => {
        this.send({ method: 'cancel', params: { id } });
        finish(signal.reason instanceof Error ? signal.reason : new Error('Media reception stopped locally'));
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error), onProgress, connection: context.connection });
      this.send({ id, method: 'media-provider-request', params: { providerId, action, input, settings, jobId: context.jobId, stagingDir: context.stagingDir } });
    });
  }

  async requestSource(sourceId: string, action: 'discover' | 'probe' | 'parse', args: unknown, signal: AbortSignal, settings: Record<string, unknown>): Promise<unknown> {
    if (this.stopped) throw new Error(`Plugin ${this.id} has been unloaded`);
    signal.throwIfAborted();
    await this.start();
    if (!this.registeredSources.has(sourceId)) throw new Error(`Plugin ${this.id} did not register source ${sourceId}`);
    signal.throwIfAborted();
    clearTimeout(this.idle);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.send({ method: 'cancel', params: { id } });
        finish(new Error('Session source page timed out'));
      }, 300_000);
      timeout.unref();
      const cancel = () => {
        this.send({ method: 'cancel', params: { id } });
        finish(signal.reason instanceof Error ? signal.reason : new Error('Import cancelled'));
      };
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        this.pending.delete(id);
        if (error) reject(error); else resolve(value);
        this.scheduleIdle();
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.pending.set(id, { resolve: (value) => { finish(undefined, value); }, reject: (error) => { finish(error); } });
      this.send({ id, method: 'source-request', params: { sourceId, action, args, settings } });
    });
  }

  get running(): boolean { return this.child !== undefined; }

  async execute(name: string, args: unknown, signal: AbortSignal, onProgress?: (update: ToolUpdate) => void, settings: Record<string, unknown> = {}, scope: { readonly workspaceRoot?: string; readonly approvedPaths?: readonly string[]; readonly imageIn?: boolean; readonly workspaceId?: string; readonly media?: PluginMediaApi; readonly messages?: PluginMessagesApi; readonly attachmentStore?: ISessionMediaStore } = {}): Promise<ExecutableToolResult> {
    if (this.stopped) throw new Error(`Plugin ${this.id} has been unloaded`);
    signal.throwIfAborted();
    await this.start();
    if (!this.registered.has(name)) throw new Error(`Plugin ${this.id} did not register ${name}`);
    clearTimeout(this.idle);
    const requestId = ++this.nextId;
    return new Promise<ExecutableToolResult>((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Plugin tool cancelled')); return; }
      const output = new PluginToolOutput(scope.attachmentStore, signal);
      const cleanup = () => {
        signal.removeEventListener('abort', cancel);
        this.pending.delete(requestId);
        this.scheduleIdle();
        return output.dispose();
      };
      const cancel = () => {
        this.send({ method: 'cancel', params: { id: requestId } });
        void cleanup().then(() => { reject(new Error('Plugin tool cancelled')); });
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.pending.set(requestId, {
        resolve: (result) => {
          void cleanup().then(() => {
            if (!validToolResult(result, output.references)) reject(new Error(`Plugin ${this.id} returned an invalid tool result`));
            else resolve(result);
          });
        },
        reject: (error) => { void cleanup().then(() => { reject(error); }); },
        onProgress,
        media: scope.media,
        messages: scope.messages,
        output,
      });
      this.send({ id: requestId, method: 'execute', params: { name, args, settings, workspaceRoot: scope.workspaceRoot, approvedPaths: scope.approvedPaths, imageIn: scope.imageIn, workspaceId: scope.workspaceId, kikiHome: this.kikiHome } });
    });
  }

  async installPrerequisite(destination: string): Promise<string> {
    if (this.stopped) throw new Error(`Plugin ${this.id} has been unloaded`);
    await this.start();
    clearTimeout(this.idle);
    const requestId = ++this.nextId;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (result) => {
          this.scheduleIdle();
          if (result !== destination) reject(new Error(`Plugin ${this.id} installed the prerequisite at an unexpected path`));
          else resolve(result);
        },
        reject: (error) => { this.scheduleIdle(); reject(error); },
      });
      this.send({ id: requestId, method: 'install-prerequisite', params: { consent: true, destination } });
    });
  }

  async requestPanel(action: string, args: unknown, settings: Record<string, unknown>): Promise<unknown> {
    if (this.stopped) throw new Error(`Plugin ${this.id} has been unloaded`);
    await this.start();
    clearTimeout(this.idle);
    const requestId = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (result) => {
          this.scheduleIdle();
          if (JSON.stringify(result)?.length > MAX_RPC_LINE_CHARS - 1024) reject(new Error('Plugin panel response exceeds RPC limit'));
          else resolve(result);
        },
        reject: (error) => { this.scheduleIdle(); reject(error); },
      });
      this.send({ id: requestId, method: 'panel-request', params: { action, args, settings, kikiHome: this.kikiHome } });
    });
  }

  async stopAndWait(): Promise<void> {
    this.stopped = true;
    if (this.child !== undefined && this.lifecycle?.resident) {
      try { await this.lifecycleRequest('shutdown', {}); await this.exited; } catch {}
    }
    this.stop();
    await this.exited;
  }

  stop(): void {
    this.stopped = true;
    this.terminate(new Error(`Plugin ${this.id} unloaded`));
  }

  private clearImAssembly(adapterId: string): void {
    const assembly = this.imAssemblies.get(adapterId);
    if (assembly === undefined) return;
    clearTimeout(assembly.timer);
    this.imAssemblies.delete(adapterId);
    this.send({ method: 'im-adapter-event-result', params: { callId: assembly.callId, error: 'IM complete message was not admitted' } });
  }

  private receiveImChunk(params: { adapterId?: unknown; callId?: unknown; index?: unknown; characters?: unknown; data?: unknown }): void {
    const { adapterId, callId, index, characters, data } = params;
    try {
      if (typeof adapterId !== 'string' || typeof callId !== 'number' || !Number.isSafeInteger(callId) || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || typeof characters !== 'number' || !Number.isSafeInteger(characters) || characters < 1 || characters > PLUGIN_IM_COMPLETE_LIMITS.serializedChars || typeof data !== 'string' || data.length < 1 || data.length > PLUGIN_IM_COMPLETE_LIMITS.chunkChars) throw new Error('Invalid IM message frame');
      const listener = this.imListeners.get(adapterId);
      const definition = this.imAdapters.find((item) => item.id === adapterId);
      if (this.stopped || listener === undefined || definition?.inbound !== true) throw new Error('IM adapter is not receiving');
      let assembly = this.imAssemblies.get(adapterId);
      if (assembly === undefined) {
        if (index !== 0) throw new Error('Incomplete IM message');
        const timer = setTimeout(() => { this.clearImAssembly(adapterId); }, 30_000);
        timer.unref();
        assembly = { callId, characters, received: 0, chunks: [], listener, timer };
        this.imAssemblies.set(adapterId, assembly);
      }
      if (assembly.callId !== callId || assembly.listener !== listener || assembly.characters !== characters || assembly.chunks.length !== index || data.length !== Math.min(PLUGIN_IM_COMPLETE_LIMITS.chunkChars, characters - assembly.received)) throw new Error('Inconsistent IM message frame');
      assembly.chunks.push(data);
      assembly.received += data.length;
      if (assembly.received !== characters) return;
      clearTimeout(assembly.timer);
      this.imAssemblies.delete(adapterId);
      const event = parsePluginImEvent(JSON.parse(assembly.chunks.join('')), definition);
      if (event.kind !== 'message') throw new Error('IM framed input must be a complete message');
      void Promise.resolve().then(async () => {
        if (this.stopped || this.imListeners.get(adapterId) !== listener) throw new Error('IM adapter was withdrawn');
        await listener(event);
      }).then(() => this.send({ method: 'im-adapter-event-result', params: { callId, result: true } }),
        () => this.send({ method: 'im-adapter-event-result', params: { callId, error: 'IM complete message was not admitted' } }));
    } catch {
      if (typeof adapterId === 'string') this.clearImAssembly(adapterId);
      this.send({ method: 'im-adapter-event-result', params: { callId, error: 'IM complete message was not admitted' } });
    }
  }

  private async start(): Promise<void> {
    if (this.ready !== undefined) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const native = !path.basename(process.execPath).toLowerCase().startsWith('node');
      const runner = native && process.versions['electron'] === undefined
        ? process.env['KIKI_PLUGIN_HOST_RUNNER'] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'hostRunner.mjs')
        : path.join(path.dirname(fileURLToPath(import.meta.url)), 'hostRunner.mjs');
      const args = native && process.versions['electron'] === undefined
        ? ['__plugin_run_node', runner, this.entry]
        : [runner, this.entry];
      const child = spawn(process.execPath, args, {
        cwd: path.dirname(this.entry),
        env: {
          ...mergeChildEnv(process.env, kikiChildDefaults(this.kikiHome)),
          ELECTRON_RUN_AS_NODE: process.versions['electron'] === undefined ? undefined : '1',
          KIKI_CACHE_DIR: process.env['KIKI_CACHE_DIR'],
          KIKI_PLUGIN_ROOT: path.dirname(this.entry),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.exited = new Promise<void>((resolveExit) => {
        child.once('exit', () => resolveExit());
        child.once('error', () => resolveExit());
      });
      let handshake = false;
      const startupTimeout = setTimeout(() => {
        const error = new Error(`Plugin ${this.id} RPC handshake timed out`);
        reject(error);
        this.terminate(error);
      }, HANDSHAKE_MS);
      startupTimeout.unref();
      child.stderr.resume();
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          if (line.length > MAX_RPC_LINE_CHARS) throw new Error(`Plugin ${this.id} RPC response is too large`);
          const message = JSON.parse(line) as { id?: number; method?: string; params?: any; result?: any; error?: { message: string } };
          if (message.id === 0) {
            if (message.result?.version !== PLUGIN_RPC_VERSION) throw new Error(`Plugin ${this.id} RPC protocol mismatch`);
            handshake = true;
          } else if (message.method === 'register') {
            if (!handshake || message.params?.version !== PLUGIN_RPC_VERSION) throw new Error('Plugin registered before handshake');
            const tool = toolContributionSchema.parse(message.params?.tool);
            const expected = this.definitions.find((item) => item.name === tool.name);
            if (expected === undefined || JSON.stringify(tool) !== JSON.stringify(expected)) throw new Error(`Plugin ${this.id} registered a changed tool definition: ${tool.name}`);
            this.registered.add(tool.name);
          } else if (message.method === 'register-source') {
            if (!handshake || message.params?.version !== PLUGIN_RPC_VERSION) throw new Error('Plugin registered before handshake');
            const definition = sessionSourceDefinitionSchema.parse(message.params?.definition);
            const expected = this.sources.find((item) => item.id === definition.id);
            if (expected === undefined || JSON.stringify(expected) !== JSON.stringify(definition) || this.registeredSources.has(definition.id)) throw new Error('Plugin source definition mismatch');
            this.registeredSources.add(definition.id);
          } else if (message.method === 'register-media-provider') {
            if (!handshake || message.params?.version !== PLUGIN_RPC_VERSION) throw new Error('Plugin registered before handshake');
            const definition = mediaProviderDefinitionSchema.parse(message.params?.definition);
            const expected = this.providers.find((item) => item.id === definition.id);
            if (expected === undefined || JSON.stringify(expected) !== JSON.stringify(definition) || this.registeredProviders.has(definition.id)) throw new Error('Plugin media provider definition mismatch');
            this.registeredProviders.add(definition.id);
          } else if (message.method === 'register-im-adapter') {
            if (!handshake || message.params?.version !== PLUGIN_RPC_VERSION) throw new Error('Plugin registered before handshake');
            const definition = pluginImAdapterDefinitionSchema.parse(message.params?.definition);
            const expected = this.imAdapters.find((item) => item.id === definition.id);
            if (expected === undefined || JSON.stringify(expected) !== JSON.stringify(definition) || this.registeredImAdapters.has(definition.id)) throw new Error('Plugin IM adapter definition mismatch');
            this.registeredImAdapters.add(definition.id);
          } else if (message.method === 'im-adapter-report') {
            const { adapterId, connectionId, callId, diagnostic } = message.params ?? {};
            void Promise.resolve().then(() => {
              const owner = this.imReportOwners.get(adapterId);
              const definition = this.imAdapters.find((item) => item.id === adapterId);
              if (this.stopped || owner?.accountId === undefined || owner.id !== connectionId || definition?.inbound !== true) throw new Error('IM adapter is not receiving');
              if (Buffer.byteLength(JSON.stringify(diagnostic), 'utf8') > PLUGIN_IM_DIAGNOSTIC_LIMITS.reportBytes) throw new Error('Invalid IM diagnostic');
              const report = pluginImDiagnosticReportSchema.parse(diagnostic);
              const key = `${report.sourceId}:${report.code}`;
              if (report.status === 'recovered') owner.diagnostics.delete(key);
              else {
                owner.diagnostics.delete(key);
                if (owner.diagnostics.size >= PLUGIN_IM_DIAGNOSTIC_LIMITS.sources) owner.diagnostics.delete(owner.diagnostics.keys().next().value!);
                owner.diagnostics.set(key, { source_id: report.sourceId, code: report.code, account_id: owner.accountId, at: new Date().toISOString() });
              }
            }).then(() => this.send({ method: 'im-adapter-report-result', params: { callId, result: true } }),
              () => this.send({ method: 'im-adapter-report-result', params: { callId, error: 'IM diagnostic was not retained' } }));
          } else if (message.method === 'im-adapter-message-chunk') {
            this.receiveImChunk(message.params ?? {});
          } else if (message.method === 'im-adapter-event') {
            const { adapterId, callId, event } = message.params ?? {};
            void Promise.resolve().then(async () => {
              const definition = this.imAdapters.find((item) => item.id === adapterId);
              const listener = this.imListeners.get(adapterId);
              if (this.stopped || definition === undefined || listener === undefined) throw new Error('IM adapter is not receiving');
              await listener(parsePluginImEvent(event, definition));
            }).then(() => this.send({ method: 'im-adapter-event-result', params: { callId, result: true } }),
              () => this.send({ method: 'im-adapter-event-result', params: { callId, error: 'IM event was not admitted' } }));
          } else if (message.method === 'ready') {
            if (!handshake || this.registered.size !== this.definitions.length || this.registeredSources.size !== this.sources.length || this.registeredProviders.size !== this.providers.length || this.registeredImAdapters.size !== this.imAdapters.length) throw new Error('Plugin registered incomplete contributions');
            clearTimeout(startupTimeout);
            resolve();
            this.scheduleIdle();
          } else if (message.method === 'register-error') {
            throw new Error(message.params?.message ?? 'Plugin registration failed');
          } else if (message.method === 'progress') {
            this.pending.get(message.params?.id)?.onProgress?.(message.params.update);
          } else if (message.method === 'settings-update') {
            const { callId, values } = message.params ?? {};
            void Promise.resolve().then(() => {
              if (this.lifecycle?.resident !== true || this.stopped) throw new Error('Plugin settings bridge is unavailable');
              return this.lifecycle.updateSettings(values);
            }).then((result) => this.send({ method: 'settings-result', params: { callId, result } }),
              () => this.send({ method: 'settings-result', params: { callId, error: 'Plugin settings could not be saved' } }));
          } else if (this.acceptIm(message)) {
          } else if (message.method === 'app-focus-session') {
            const { callId, sessionId } = message.params ?? {};
            void Promise.resolve().then(() => {
              if (this.lifecycle?.resident !== true || this.stopped || typeof sessionId !== 'string' || sessionId.length > 128) throw new Error('Plugin navigation is unavailable');
              this.lifecycle.focusSession?.(sessionId);
            }).then(() => this.send({ method: 'app-focus-result', params: { callId, result: true } }),
              () => this.send({ method: 'app-focus-result', params: { callId, error: 'Session is no longer available' } }));
          } else if (message.method === 'output-request') {
            const { id, callId, action, input } = message.params ?? {};
            const call = this.pending.get(id);
            void Promise.resolve().then(() => {
              if (call?.output === undefined) throw new Error('Plugin output storage is unavailable');
              return call.output.request(action, input);
            }).then(
              (result) => { if (this.child === child) this.send({ method: 'output-result', params: { callId, result } }); },
              (error) => { if (this.child === child) this.send({ method: 'output-result', params: { callId, error: String(error) } }); },
            );
          } else if (message.method === 'media-call') {
            const { id, callId, action, input } = message.params ?? {};
            const call = this.pending.get(id);
            const bridge = call?.media;
            void Promise.resolve().then(() => {
              if (action === 'connection') {
                if (call === undefined) throw new Error('Provider connection request is no longer active');
                return call.connection?.();
              }
              if (action === 'message-send') {
                if (call?.messages === undefined) throw new Error('Message delivery is unavailable outside an admitted session tool call');
                return call.messages.send(input);
              }
              if (bridge === undefined) throw new Error('Media bridge is unavailable outside an admitted session tool call');
              if (action === 'generate') return bridge.generate(input);
              if (action === 'media') return bridge.media(input);
              throw new Error('Unsupported media bridge action');
            }).then(
              (result) => this.send({ method: 'media-result', params: { callId, result } }),
              (error) => this.send({ method: 'media-result', params: { callId, error: String(error) } }),
            );
          } else if (message.id !== undefined) {
            const call = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.error !== undefined) call?.reject(new Error(message.error.message));
            else call?.resolve(message.result);
          }
        } catch (error) {
          clearTimeout(startupTimeout);
          reject(error);
          this.terminate(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.once('error', (error) => { clearTimeout(startupTimeout); reject(error); this.terminate(error); });
      child.once('exit', (code) => {
        clearTimeout(startupTimeout);
        const failure = new Error(`Plugin ${this.id} host exited (${code ?? 'signal'})`);
        reject(failure);
        this.terminate(failure);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'handshake', params: { version: PLUGIN_RPC_VERSION } })}\n`);
    });
    try { await this.ready; }
    catch (error) { this.ready = undefined; throw error; }
  }

  private acceptIm(message: { method?: string; params?: { callId?: unknown; request?: unknown } }): boolean {
    const method = message.method;
    if (method !== 'im-capabilities' && method !== 'im-list-routes' && method !== 'im-send' && method !== 'im-cancel') return false;
    const callId = message.params?.callId;
    if (typeof callId !== 'number' || !Number.isSafeInteger(callId) || callId <= 0) return true;
    if (method === 'im-cancel') {
      this.imCalls.get(callId)?.abort();
      return true;
    }
    const controller = new AbortController();
    this.imCalls.set(callId, controller);
    void Promise.resolve().then(async () => {
      const bridge = this.lifecycle?.resident === true && !this.stopped ? this.lifecycle.im?.() : undefined;
      if (method === 'im-capabilities') return sanitizePluginImCapabilities(bridge === undefined ? undefined : await bridge.capabilities(controller.signal));
      if (method === 'im-list-routes') return sanitizePluginImRoutes(bridge === undefined ? undefined : await bridge.listRoutes(controller.signal));
      const parsed = parsePluginImRequest(message.params?.request);
      if (!parsed.ok) return parsed.receipt;
      if (controller.signal.aborted) return pluginImReceipt('cancelled', { diagnosticCode: 'cancelled' });
      if (bridge === undefined) return pluginImReceipt('failed', { diagnosticCode: 'im_unsupported', errorKind: 'dependency_missing', retryable: true });
      return sanitizePluginImReceipt(await bridge.send(parsed.request, controller.signal, { pluginId: this.id }));
    }).then(
      (result) => { this.imCalls.delete(callId); if (!this.stopped) this.send({ method: 'im-result', params: { callId, result } }); },
      () => {
        this.imCalls.delete(callId);
        if (this.stopped) return;
        const result = method === 'im-send'
          ? pluginImReceipt('unknown', { diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' })
          : method === 'im-list-routes' ? [] : { outbound: false, inbound: false };
        this.send({ method: 'im-result', params: { callId, result } });
      },
    );
    return true;
  }

  private send(message: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  private scheduleIdle(): void {
    if (this.pending.size > 0 || this.imListeners.size > 0 || this.stopped || this.lifecycle?.resident === true) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.terminate(new Error(`Plugin ${this.id} idle`)), IDLE_MS);
    this.idle.unref();
  }

  private terminate(reason: Error): void {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    this.activitySubscription?.dispose();
    this.activitySubscription = undefined;
    for (const controller of this.imCalls.values()) controller.abort();
    this.imCalls.clear();
    this.registered.clear();
    this.registeredSources.clear();
    this.registeredProviders.clear();
    this.registeredImAdapters.clear();
    for (const adapterId of this.imAssemblies.keys()) this.clearImAssembly(adapterId);
    this.imListeners.clear();
    this.imReportOwners.clear();
    this.imDiagnostics.clear();
    for (const call of this.pending.values()) call.reject(reason);
    this.pending.clear();
    if (child !== undefined && !child.killed) child.kill();
    this.ready = undefined;
  }
}
