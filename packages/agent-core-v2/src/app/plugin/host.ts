import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionSourceDefinitionSchema, mediaProviderDefinitionSchema, type MediaProviderDefinition, type PluginMediaApi, type SessionSourceDefinition } from '@kiki/protocol';
import { toolContributionSchema, type PluginTool } from './contributions';
import type { ExecutableToolResult, ToolUpdate } from '#/tool/toolContract';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { PluginToolOutput } from './toolOutput';

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
  readonly output?: PluginToolOutput;
  readonly connection?: () => Promise<unknown>;
}

export class PluginHost {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Call>();
  private readonly registered = new Set<string>();
  private readonly registeredSources = new Set<string>();
  private readonly registeredProviders = new Set<string>();
  private nextId = 0;
  private ready?: Promise<void>;
  private exited: Promise<void> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private activitySubscription?: { dispose(): void };

  constructor(
    readonly id: string,
    private readonly entry: string,
    private readonly definitions: readonly PluginTool[],
    private readonly sources: readonly SessionSourceDefinition[] = [],
    private readonly providers: readonly MediaProviderDefinition[] = [],
    private readonly lifecycle?: { readonly resident: boolean; readonly updateSettings: (values: Record<string, string | number | boolean | null>) => Promise<unknown>; readonly observeActivity?: (listener: (activity: readonly import('./pluginActivity').PluginActivity[]) => void) => { dispose(): void }; readonly focusSession?: (sessionId: string) => void },
  ) {}

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

  async execute(name: string, args: unknown, signal: AbortSignal, onProgress?: (update: ToolUpdate) => void, settings: Record<string, unknown> = {}, scope: { readonly workspaceRoot?: string; readonly approvedPaths?: readonly string[]; readonly imageIn?: boolean; readonly media?: PluginMediaApi; readonly attachmentStore?: ISessionMediaStore } = {}): Promise<ExecutableToolResult> {
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
        output,
      });
      this.send({ id: requestId, method: 'execute', params: { name, args, settings, workspaceRoot: scope.workspaceRoot, approvedPaths: scope.approvedPaths, imageIn: scope.imageIn } });
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
      this.send({ id: requestId, method: 'panel-request', params: { action, args, settings } });
    });
  }

  async stopAndWait(): Promise<void> {
    this.stopped = true;
    if (this.child !== undefined) {
      try { await this.lifecycleRequest('shutdown', {}); await this.exited; } catch {}
    }
    this.stop();
    await this.exited;
  }

  stop(): void {
    this.stopped = true;
    this.terminate(new Error(`Plugin ${this.id} unloaded`));
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
          ...process.env,
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
          } else if (message.method === 'ready') {
            if (!handshake || this.registered.size !== this.definitions.length || this.registeredSources.size !== this.sources.length || this.registeredProviders.size !== this.providers.length) throw new Error('Plugin registered incomplete contributions');
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

  private send(message: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  private scheduleIdle(): void {
    if (this.pending.size > 0 || this.stopped || this.lifecycle?.resident === true) return;
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
    this.registered.clear();
    this.registeredSources.clear();
    this.registeredProviders.clear();
    for (const call of this.pending.values()) call.reject(reason);
    this.pending.clear();
    if (child !== undefined && !child.killed) child.kill();
    this.ready = undefined;
  }
}
