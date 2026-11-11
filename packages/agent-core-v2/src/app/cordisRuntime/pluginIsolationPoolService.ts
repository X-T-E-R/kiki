import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';

import { RESOURCE_DEFAULTS } from '#/_base/node/resourceDefaults';
import type {
  IPluginIsolationPoolService, IsolatedPluginInvocation, IsolatedPluginResult, PluginIsolationBudget,
} from './cordisRuntime';
import { matchesInvocation, type IsolationMessage, type IsolationRequest, type IsolationWorkerData } from './isolationProtocol';

export class PluginIsolationError extends Error {
  constructor(readonly code: 'queue_full' | 'payload_too_large' | 'timeout' | 'worker_exit' | 'revoked' | 'stale_result' | 'plugin_error', message: string) {
    super(message);
    this.name = 'PluginIsolationError';
  }
}

interface Registration {
  readonly pluginId: string;
  readonly generation: number;
  readonly entryUrl: string;
  readonly settings: Readonly<Record<string, unknown>>;
}

interface Pending {
  readonly id: number;
  readonly registration: Registration;
  readonly request: IsolationRequest;
  readonly bytes: Uint8Array;
  readonly resolve: (value: IsolatedPluginResult) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  readonly cancel: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface Slot {
  registration?: Registration;
  worker?: Worker;
  active?: Pending;
  retiring?: Promise<void>;
}

let workerAsset: URL | undefined;

/** Select the extracted worker asset before constructing the pool in a packaged host. */
export function configurePluginIsolationWorkerRuntime(entryPath: string): void {
  workerAsset = pathToFileURL(entryPath);
}

export class PluginIsolationPoolService implements IPluginIsolationPoolService {
  declare readonly _serviceBrand: undefined;
  readonly budget: PluginIsolationBudget;
  private readonly registrations = new Map<string, Registration>();
  private readonly generations = new Map<string, number>();
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private queuedBytes = 0;
  private nextId = 0;
  private closing?: Promise<void>;

  constructor(budget: Partial<PluginIsolationBudget> = {}, private readonly entry = workerAsset ?? new URL(
    import.meta.url.endsWith('.ts') ? './isolationWorkerEntry.ts' : './plugin-isolation-worker.mjs', import.meta.url,
  )) {
    const maxWorkers = Math.max(1, Math.min(availableParallelism() - 1, budget.maxWorkers ?? RESOURCE_DEFAULTS.cpuWorkers));
    this.budget = Object.freeze({
      maxWorkers,
      maxActiveRequests: budget.maxActiveRequests ?? maxWorkers,
      maxQueuedRequests: budget.maxQueuedRequests ?? RESOURCE_DEFAULTS.cpuQueue,
      maxQueuedBytes: budget.maxQueuedBytes ?? RESOURCE_DEFAULTS.cpuQueuedBytes,
      maxPayloadBytes: budget.maxPayloadBytes ?? RESOURCE_DEFAULTS.cpuQueuedBytes,
      callTimeoutMs: budget.callTimeoutMs ?? 30_000,
      oldSpaceMb: budget.oldSpaceMb ?? RESOURCE_DEFAULTS.workerHeapMb,
    });
    for (const [key, value] of Object.entries(this.budget)) {
      if (!Number.isSafeInteger(value) || value < (key.startsWith('maxQueued') ? 0 : 1)) throw new RangeError(`Invalid plugin isolation budget ${key}`);
    }
  }

  async registerWorkerPlugin(input: { readonly pluginId: string; readonly entryPath: string; readonly settings: Readonly<Record<string, unknown>> }): Promise<{ readonly generation: number; dispose(): Promise<void> }> {
    if (this.closing) throw new PluginIsolationError('revoked', 'Plugin pool is closed');
    const generation = (this.generations.get(input.pluginId) ?? 0) + 1;
    const registration: Registration = {
      pluginId: input.pluginId, generation, entryUrl: pathToFileURL(input.entryPath).href, settings: structuredClone(input.settings),
    };
    const previous = this.terminatePlugin(input.pluginId, 'Plugin was replaced');
    this.generations.set(input.pluginId, generation);
    this.registrations.set(input.pluginId, registration);
    await previous;
    if (this.registrations.get(input.pluginId) !== registration) throw new PluginIsolationError('revoked', 'Plugin registration was superseded');
    return { generation, dispose: async () => {
      if (this.registrations.get(input.pluginId) === registration) await this.terminatePlugin(input.pluginId, 'Plugin was unloaded');
    } };
  }

  invoke<TPayload, TResult>(invocation: IsolatedPluginInvocation<TPayload>): Promise<IsolatedPluginResult<TResult>> {
    if (this.closing) return Promise.reject(new PluginIsolationError('revoked', 'Plugin pool is closed'));
    if (invocation.signal?.aborted) return Promise.reject(invocation.signal.reason);
    const registration = this.registrations.get(invocation.pluginId);
    if (!registration || registration.generation !== invocation.generation) return Promise.reject(new PluginIsolationError('revoked', 'Plugin generation is no longer registered'));
    const { signal, timeoutMs = this.budget.callTimeoutMs, ...request } = invocation;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) return Promise.reject(new RangeError('Invalid plugin invocation timeout'));
    let bytes: Uint8Array;
    try { bytes = serialize(request); } catch (error) { return Promise.reject(error); }
    if (bytes.byteLength > this.budget.maxPayloadBytes) return Promise.reject(new PluginIsolationError('payload_too_large', 'Plugin invocation exceeds the byte limit'));
    const canStart = this.canStart(registration);
    if (!canStart && (this.queue.length >= this.budget.maxQueuedRequests || this.queuedBytes + bytes.byteLength > this.budget.maxQueuedBytes)) {
      return Promise.reject(new PluginIsolationError('queue_full', 'Plugin isolate queue is full'));
    }
    return new Promise<IsolatedPluginResult<TResult>>((resolve, reject) => {
      const pending: Pending = {
        id: ++this.nextId, registration, request, bytes, signal,
        resolve: (value) => resolve(value as IsolatedPluginResult<TResult>), reject,
        cancel: () => this.cancel(pending, signal!.reason),
      };
      pending.timer = setTimeout(() => this.cancel(pending, new PluginIsolationError('timeout', 'Plugin isolate timed out; its side effects were not replayed')), timeoutMs);
      signal?.addEventListener('abort', pending.cancel, { once: true });
      this.queue.push(pending);
      this.queuedBytes += bytes.byteLength;
      this.pump();
    });
  }

  private canStart(registration: Registration, allowEviction = false): boolean {
    if (this.slots.filter((slot) => slot.active).length >= this.budget.maxActiveRequests) return false;
    if (this.slots.some((slot) => slot.registration?.pluginId === registration.pluginId && (slot.active || slot.retiring))) return false;
    return this.slots.length < this.budget.maxWorkers || this.slots.some((slot) =>
      !slot.active && !slot.retiring && (allowEviction || !slot.worker || slot.registration === registration));
  }

  private pump(): void {
    if (this.closing) return;
    for (let index = 0; index < this.queue.length;) {
      const pending = this.queue[index]!;
      if (!this.canStart(pending.registration, true)) { index += 1; continue; }
      let slot = this.slots.find((candidate) => candidate.registration === pending.registration && !candidate.active && !candidate.retiring);
      slot ??= this.slots.find((candidate) => !candidate.worker && !candidate.active && !candidate.retiring);
      if (!slot && this.slots.length < this.budget.maxWorkers) { slot = {}; this.slots.push(slot); }
      if (!slot) {
        const idle = this.slots.find(candidate => !candidate.active && !candidate.retiring)!;
        this.retire(idle);
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      this.queuedBytes -= pending.bytes.byteLength;
      slot.registration = pending.registration;
      slot.active = pending;
      try {
        const worker = slot.worker ?? this.spawn(slot, pending.registration);
        worker.ref();
        worker.postMessage({ id: pending.id, bytes: pending.bytes } satisfies IsolationMessage);
      } catch (error) {
        slot.active = undefined;
        this.settle(pending, error);
        this.retire(slot);
      }
    }
  }

  private spawn(slot: Slot, registration: Registration): Worker {
    const worker = new Worker(this.entry, {
      name: `kiki-plugin:${registration.pluginId}`, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: this.budget.oldSpaceMb },
      workerData: { entryUrl: registration.entryUrl, settings: registration.settings, maxPayloadBytes: this.budget.maxPayloadBytes, oldSpaceMb: this.budget.oldSpaceMb } satisfies IsolationWorkerData,
    });
    slot.worker = worker;
    worker.on('message', (message: IsolationMessage) => {
      const pending = slot.active;
      if (slot.worker !== worker || slot.retiring || !pending || message?.id !== pending.id) return;
      let response: unknown;
      try {
        if (!(message.bytes instanceof Uint8Array) || message.bytes.byteLength > this.budget.maxPayloadBytes) throw new PluginIsolationError('payload_too_large', 'Plugin response exceeds the byte limit');
        response = deserialize(message.bytes);
      } catch (error) {
        slot.active = undefined;
        this.settle(pending, error);
        this.retire(slot);
        return;
      }
      slot.active = undefined;
      if (this.registrations.get(registration.pluginId) !== registration || !matchesInvocation(response, pending.request)) {
        this.settle(pending, new PluginIsolationError('stale_result', 'Plugin returned an obsolete or invalid invocation identity'));
        this.retire(slot);
        return;
      }
      if (response.ok) this.settle(pending, undefined, { ...response, value: response.value });
      else this.settle(pending, new PluginIsolationError('plugin_error', response.message));
      worker.unref();
      this.pump();
    });
    const fail = (error: unknown) => {
      if (slot.worker !== worker || slot.retiring) return;
      if (slot.active) this.settle(slot.active, error);
      slot.active = undefined;
      this.retire(slot);
    };
    worker.on('error', (error) => fail(error));
    worker.on('exit', (code) => fail(new PluginIsolationError('worker_exit', `Plugin worker exited (${code}); outcome is unknown`)));
    return worker;
  }

  private cancel(pending: Pending, reason: unknown): void {
    const index = this.queue.indexOf(pending);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.queuedBytes -= pending.bytes.byteLength;
      this.settle(pending, reason);
      return;
    }
    const slot = this.slots.find((candidate) => candidate.active === pending);
    if (!slot) return;
    slot.active = undefined;
    this.settle(pending, reason);
    this.retire(slot);
  }

  private settle(pending: Pending, error?: unknown, result?: IsolatedPluginResult): void {
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.cancel);
    if (error !== undefined) pending.reject(error);
    else pending.resolve(result!);
  }

  private retire(slot: Slot): Promise<void> {
    if (slot.retiring) return slot.retiring;
    const worker = slot.worker;
    slot.worker = undefined;
    slot.retiring = (async () => { await worker?.terminate(); })().finally(() => {
      slot.registration = undefined;
      slot.retiring = undefined;
      this.pump();
    });
    return slot.retiring;
  }

  async terminatePlugin(pluginId: string, reason: string): Promise<void> {
    const registration = this.registrations.get(pluginId);
    this.registrations.delete(pluginId);
    const error = new PluginIsolationError('revoked', reason);
    for (const pending of [...this.queue]) if (pending.registration === registration) this.cancel(pending, error);
    for (const slot of this.slots) {
      if (slot.registration !== registration || !registration) continue;
      if (slot.active) this.settle(slot.active, error);
      slot.active = undefined;
      await this.retire(slot);
    }
    this.pump();
  }

  dispose(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      for (const pluginId of [...this.registrations.keys()]) await this.terminatePlugin(pluginId, 'Plugin pool is closed');
      for (const slot of this.slots) await this.retire(slot);
    });
  }
}
