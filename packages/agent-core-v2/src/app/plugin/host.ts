import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolContributionSchema, type PluginTool } from './contributions';
import type { ExecutableToolResult, ToolUpdate } from '#/tool/toolContract';

export const PLUGIN_RPC_VERSION = 1;
const IDLE_MS = 90_000;
const HANDSHAKE_MS = 15_000;
const MAX_RPC_LINE_CHARS = 16 * 1024 * 1024;
const MAX_IMAGE_URL_CHARS = 12 * 1024 * 1024;

function validToolResult(result: unknown): result is ExecutableToolResult {
  if (typeof result !== 'object' || result === null || !('output' in result)) return false;
  const { output, isError } = result as { output: unknown; isError?: unknown };
  if (isError !== undefined && typeof isError !== 'boolean') return false;
  if (typeof output === 'string') return true;
  return Array.isArray(output) && output.every((part: unknown) => {
    if (typeof part !== 'object' || part === null || !('type' in part)) return false;
    const value = part as { type: unknown; text?: unknown; imageUrl?: { url?: unknown } };
    return (value.type === 'text' && typeof value.text === 'string') ||
      (value.type === 'image_url' && typeof value.imageUrl?.url === 'string' &&
        value.imageUrl.url.length <= MAX_IMAGE_URL_CHARS &&
        /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.imageUrl.url));
  });
}

interface Call {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly onProgress?: (update: ToolUpdate) => void;
}

export class PluginHost {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Call>();
  private readonly registered = new Set<string>();
  private nextId = 0;
  private ready?: Promise<void>;
  private idle?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    readonly id: string,
    private readonly entry: string,
    private readonly definitions: readonly PluginTool[],
  ) {}

  get running(): boolean { return this.child !== undefined; }

  async execute(name: string, args: unknown, signal: AbortSignal, onProgress?: (update: ToolUpdate) => void, settings: Record<string, unknown> = {}, scope: { readonly workspaceRoot?: string; readonly approvedPaths?: readonly string[]; readonly imageIn?: boolean } = {}): Promise<ExecutableToolResult> {
    if (this.stopped) throw new Error(`Plugin ${this.id} has been unloaded`);
    await this.start();
    if (!this.registered.has(name)) throw new Error(`Plugin ${this.id} did not register ${name}`);
    clearTimeout(this.idle);
    const requestId = ++this.nextId;
    return new Promise<ExecutableToolResult>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const cancel = () => this.send({ method: 'cancel', params: { id: requestId } });
      signal.addEventListener('abort', cancel, { once: true });
      this.pending.set(requestId, {
        resolve: (result) => {
          signal.removeEventListener('abort', cancel);
          if (!validToolResult(result)) {
            reject(new Error(`Plugin ${this.id} returned an invalid tool result`));
          } else resolve(result);
          this.scheduleIdle();
        },
        reject: (error) => { signal.removeEventListener('abort', cancel); reject(error); this.scheduleIdle(); },
        onProgress,
      });
      this.send({ id: requestId, method: 'execute', params: { name, args, settings, ...scope } });
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
          if (JSON.stringify(result)?.length > 64 * 1024) reject(new Error('Plugin panel response exceeds 64 KiB'));
          else resolve(result);
        },
        reject: (error) => { this.scheduleIdle(); reject(error); },
      });
      this.send({ id: requestId, method: 'panel-request', params: { action, args, settings } });
    });
  }

  stop(): void {
    this.stopped = true;
    this.terminate(new Error(`Plugin ${this.id} unloaded`));
  }

  private async start(): Promise<void> {
    if (this.ready !== undefined) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hostRunner.mjs');
      const native = !path.basename(process.execPath).toLowerCase().startsWith('node');
      const args = native && process.versions['electron'] === undefined
        ? ['__plugin_run_node', runner, this.entry]
        : [runner, this.entry];
      const child = spawn(process.execPath, args, {
        cwd: path.dirname(this.entry),
        env: {
          PATH: process.env['PATH'],
          Path: process.env['Path'],
          SystemRoot: process.env['SystemRoot'],
          TEMP: process.env['TEMP'],
          TMP: process.env['TMP'],
          ELECTRON_RUN_AS_NODE: process.versions['electron'] === undefined ? undefined : '1',
          KIKI_PLUGIN_ROOT: path.dirname(this.entry),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
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
          } else if (message.method === 'ready') {
            if (!handshake || this.registered.size !== this.definitions.length) throw new Error('Plugin registered an incomplete tool set');
            clearTimeout(startupTimeout);
            resolve();
            this.scheduleIdle();
          } else if (message.method === 'register-error') {
            throw new Error(message.params?.message ?? 'Plugin registration failed');
          } else if (message.method === 'progress') {
            this.pending.get(message.params?.id)?.onProgress?.(message.params.update);
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
    if (this.pending.size > 0 || this.stopped) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.terminate(new Error(`Plugin ${this.id} idle`)), IDLE_MS);
    this.idle.unref();
  }

  private terminate(reason: Error): void {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    this.registered.clear();
    for (const call of this.pending.values()) call.reject(reason);
    this.pending.clear();
    if (child !== undefined && !child.killed) child.kill();
    this.ready = undefined;
  }
}
