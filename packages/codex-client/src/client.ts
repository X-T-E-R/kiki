import type { NormalizedExecutorEvent } from '@moonshot-ai/protocol';

import { AsyncQueue } from '#/asyncQueue';
import { CodexClientError, CodexRemoteError } from '#/errors';
import { mapCodexNotification } from '#/events';
import { StderrRing } from '#/stderrRing';
import type {
  CodexClientOptions,
  CodexClientStatus,
  CodexModelListResult,
  CodexNotification,
  CodexProcessDescriptor,
  CodexRequestId,
  CodexServerRequest,
  CodexServerRequestResponder,
  CodexThreadResult,
  CodexTurnCompletion,
  CodexTurnHandle,
  CodexWireFrame,
  HostProcessLike,
  HostProcessServiceLike,
} from '#/types';

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface ActiveTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly events: AsyncQueue<NormalizedExecutorEvent>;
  readonly completion: Promise<CodexTurnCompletion>;
  readonly resolve: (value: CodexTurnCompletion) => void;
  readonly reject: (error: unknown) => void;
  readonly seenMessageDeltas: Set<string>;
  readonly seenReasoningSummaryDeltas: Set<string>;
  usage?: CodexTurnCompletion['usage'];
}

export class CodexAppServerClient {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #responders = new Set<CodexRequestId>();
  readonly #stderr: StderrRing;
  #process: HostProcessLike | undefined;
  #state: CodexClientStatus['state'] = 'cold';
  #stdoutBuffer = '';
  #requestSequence = 0;
  #frameSequence = 0;
  #terminalError: unknown;
  #activeTurn: ActiveTurn | undefined;
  #startingTurnThreadId: string | undefined;
  #turnSignal: AbortSignal | undefined;
  readonly #earlyNotifications: CodexNotification[] = [];

  constructor(
    private readonly processService: HostProcessServiceLike,
    private readonly descriptor: CodexProcessDescriptor,
    private readonly options: CodexClientOptions = {},
  ) {
    this.#stderr = new StderrRing(descriptor.stderrMaxBytes ?? 64 * 1024);
    assertHostOwnedArgs(descriptor.args ?? []);
  }

  status(): CodexClientStatus {
    return {
      state: this.#state,
      pid: this.#process?.pid,
      threadId: this.#activeTurn?.threadId,
      turnId: this.#activeTurn?.turnId,
    };
  }

  stderrTail(): string {
    return this.#stderr.value();
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#state === 'ready' || this.#state === 'turning') return;
    if (this.#state !== 'cold') throw asError(this.#terminalError, closedError(this.#state));
    signal?.throwIfAborted();
    this.#setState('spawning');
    try {
      this.#process = await this.processService.spawn(
        this.descriptor.command,
        [
          ...(this.descriptor.commandArgsPrefix ?? []),
          'app-server',
          '--listen',
          'stdio://',
          ...(this.descriptor.args ?? []),
        ],
        {
          cwd: this.descriptor.cwd,
          env: this.descriptor.env,
          shell: false,
          windowsHide: true,
          mergeStderr: false,
        },
      );
      this.#attachProcess(this.#process);
      this.#setState('initializing');
      await this.#requestCore('initialize', {
        clientInfo: {
          name: this.descriptor.clientName ?? 'kiki-agent-core-v2',
          title: 'Kiki',
          version: this.descriptor.clientVersion ?? '0.1.0',
        },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }, this.descriptor.startupTimeoutMs, signal);
      await this.#write({ method: 'initialized' });
      this.#setState('ready');
    } catch (error) {
      await this.#break(error);
      throw error;
    }
  }

  async listModels(signal?: AbortSignal): Promise<CodexModelListResult> {
    const models: CodexModelListResult['data'][number][] = [];
    let cursor: string | null | undefined;
    do {
      const value = object(await this.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: true,
      }, signal), 'model/list result');
      if (!Array.isArray(value['data'])) {
        throw new CodexClientError('protocol', 'model/list result.data must be an array', value);
      }
      for (const raw of value['data']) {
        const model = object(raw, 'model/list model');
        if (typeof model['id'] !== 'string') {
          throw new CodexClientError('protocol', 'model/list model.id must be a string', model);
        }
        models.push({
          id: model['id'],
          model: optionalString(model['model']),
          displayName: optionalString(model['displayName']),
          hidden: typeof model['hidden'] === 'boolean' ? model['hidden'] : undefined,
          supportedReasoningEfforts: Array.isArray(model['supportedReasoningEfforts'])
            ? model['supportedReasoningEfforts'] as CodexModelListResult['data'][number]['supportedReasoningEfforts']
            : undefined,
        });
      }
      cursor = value['nextCursor'] === null || typeof value['nextCursor'] === 'string'
        ? value['nextCursor']
        : undefined;
    } while (cursor !== undefined && cursor !== null);
    return { data: models, nextCursor: null };
  }

  async startThread(params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<CodexThreadResult> {
    return threadResult(await this.request('thread/start', params, signal), 'thread/start');
  }

  async resumeThread(params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<CodexThreadResult> {
    return threadResult(await this.request('thread/resume', params, signal), 'thread/resume');
  }

  async startTurn(params: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<CodexTurnHandle> {
    if (this.#activeTurn !== undefined || this.#startingTurnThreadId !== undefined) {
      throw new CodexClientError('protocol', 'Codex client already has an active turn');
    }
    const threadId = requiredString(params['threadId'], 'turn/start params.threadId');
    this.#startingTurnThreadId = threadId;
    this.#turnSignal = signal;
    let resultValue: unknown;
    try {
      resultValue = await this.request('turn/start', params, signal);
    } catch (error) {
      this.#startingTurnThreadId = undefined;
      this.#turnSignal = undefined;
      this.#earlyNotifications.length = 0;
      throw error;
    }
    const result = object(resultValue, 'turn/start result');
    const turn = object(result['turn'], 'turn/start result.turn');
    const turnId = requiredString(turn['id'], 'turn/start result.turn.id');
    let resolve!: (value: CodexTurnCompletion) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<CodexTurnCompletion>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    const active: ActiveTurn = {
      threadId,
      turnId,
      events: new AsyncQueue<NormalizedExecutorEvent>(),
      completion,
      resolve,
      reject,
      seenMessageDeltas: new Set(),
      seenReasoningSummaryDeltas: new Set(),
    };
    this.#activeTurn = active;
    this.#startingTurnThreadId = undefined;
    this.#setState('turning');
    for (const notification of this.#earlyNotifications.splice(0)) {
      this.#handleNotification(notification);
    }
    const onAbort = (): void => {
      void this.#interrupt(active).catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void completion.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
    if (signal.aborted) onAbort();
    return {
      events: active.events,
      completion,
      cancel: async () => this.#interrupt(active),
    };
  }

  async request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#state !== 'ready' && this.#state !== 'turning') throw closedError(this.#state);
    return this.#requestCore(method, params, this.descriptor.requestTimeoutMs, signal);
  }

  async shutdown(reason?: unknown): Promise<void> {
    if (this.#state === 'closed') return;
    if (this.#state === 'closing') {
      await this.#process?.wait().catch(() => undefined);
      return;
    }
    this.#setState('closing');
    const active = this.#activeTurn;
    if (active !== undefined) await this.#interrupt(active).catch(() => undefined);
    this.#rejectPending(reason ?? new CodexClientError('closed', 'Codex client shut down'));
    const process = this.#process;
    if (process === undefined) {
      this.#setState('closed');
      return;
    }
    process.stdin.end();
    const grace = this.descriptor.shutdownGraceMs ?? 3_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        process.wait(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, grace);
        }),
      ]);
      if (process.exitCode === null) {
        await process.kill('SIGTERM').catch(() => undefined);
        await Promise.race([
          process.wait(),
          new Promise<void>((resolve) => setTimeout(resolve, Math.max(250, grace))),
        ]);
      }
      if (process.exitCode === null) await process.kill('SIGKILL').catch(() => undefined);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await process.dispose();
      this.#setState('closed');
    }
  }

  async #interrupt(active: ActiveTurn): Promise<boolean> {
    if (this.#activeTurn !== active) return false;
    try {
      await this.request('turn/interrupt', {
        threadId: active.threadId,
        turnId: active.turnId,
      });
      return true;
    } catch (error) {
      if (this.#state !== 'broken' && this.#state !== 'closed') throw error;
      return false;
    }
  }

  async #requestCore(
    method: string,
    params: unknown,
    timeoutOverride?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw aborted(method, signal.reason);
    const id = `kiki-${++this.#requestSequence}`;
    const timeoutMs = timeoutOverride ?? 30_000;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexClientError('timeout', `${method} timed out after ${timeoutMs}ms`));
        void this.#break(new CodexClientError('timeout', `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const abortSignal = signal;
      const onAbort = abortSignal === undefined
        ? undefined
        : () => {
            const pending = this.#takePending(id);
            pending?.reject(aborted(method, abortSignal.reason));
          };
      this.#pending.set(id, { resolve, reject, timer, signal: abortSignal, onAbort });
      if (onAbort !== undefined) abortSignal!.addEventListener('abort', onAbort, { once: true });
    });
    void response.catch(() => undefined);
    try {
      await this.#write({ id, method, params });
    } catch (error) {
      this.#takePending(id)?.reject(error);
      throw error;
    }
    return response;
  }

  #attachProcess(process: HostProcessLike): void {
    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');
    process.stdout.on('data', (chunk: string) => this.#consume(chunk));
    process.stdout.on('end', () => {
      if (this.#stdoutBuffer.length > 0) {
        const tail = this.#stdoutBuffer.replace(/\r$/, '');
        this.#stdoutBuffer = '';
        this.#consumeLine(tail);
      }
      if (this.#state !== 'closing' && this.#state !== 'closed' && this.#state !== 'broken') {
        void this.#break(new CodexClientError('closed', 'Unexpected Codex app-server stdout EOF'));
      }
    });
    process.stderr.on('data', (chunk: string) => this.#stderr.append(chunk));
    process.stdin.on('error', (error) => {
      void this.#break(new CodexClientError('stdio', 'Codex app-server stdin failed', error));
    });
    void process.wait().then((code) => {
      if (this.#state !== 'closing' && this.#state !== 'closed' && this.#state !== 'broken') {
        void this.#break(new CodexClientError('closed', `Codex app-server exited with code ${code}`));
      }
    }, (error) => void this.#break(error));
  }

  #consume(chunk: string): void {
    if (this.#state === 'broken' || this.#state === 'closed') return;
    this.#stdoutBuffer += chunk;
    for (;;) {
      const index = this.#stdoutBuffer.indexOf('\n');
      if (index < 0) return;
      const raw = this.#stdoutBuffer.slice(0, index).replace(/\r$/, '');
      this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1);
      this.#consumeLine(raw);
      if (this.#terminalError !== undefined) return;
    }
  }

  #consumeLine(raw: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      this.#observe('server-to-client', 'malformed', raw);
      void this.#break(new CodexClientError('protocol', 'Malformed Codex app-server JSONL', error));
      return;
    }
    if (!isObject(payload) || Object.hasOwn(payload, 'jsonrpc')) {
      this.#observe('server-to-client', 'malformed', raw, payload);
      void this.#break(new CodexClientError('protocol', 'Invalid Codex app-server wire envelope', payload));
      return;
    }
    if (Object.hasOwn(payload, 'method')) {
      if (typeof payload['method'] !== 'string') {
        void this.#break(new CodexClientError('protocol', 'Wire method must be a string', payload));
        return;
      }
      if (Object.hasOwn(payload, 'id')) {
        this.#observe('server-to-client', 'request', raw, payload);
        this.#handleServerRequest(payload);
      } else {
        this.#observe('server-to-client', 'notification', raw, payload);
        this.#handleNotification({ method: payload['method'], params: payload['params'] });
      }
      return;
    }
    this.#observe('server-to-client', 'response', raw, payload);
    this.#handleResponse(payload);
  }

  #handleResponse(payload: JsonObject): void {
    if (typeof payload['id'] !== 'string') {
      void this.#break(new CodexClientError('protocol', 'Response id must be a string', payload));
      return;
    }
    const pending = this.#takePending(payload['id']);
    if (pending === undefined) {
      void this.#break(new CodexClientError('protocol', `Unexpected response id ${payload['id']}`, payload));
      return;
    }
    const hasResult = Object.hasOwn(payload, 'result');
    const hasError = Object.hasOwn(payload, 'error');
    if (hasResult === hasError) {
      pending.reject(new CodexClientError('protocol', 'Response must have exactly one result or error', payload));
      return;
    }
    if (hasResult) {
      pending.resolve(payload['result']);
      return;
    }
    const error = isObject(payload['error']) ? payload['error'] : undefined;
    if (error === undefined || typeof error['code'] !== 'number' || typeof error['message'] !== 'string') {
      pending.reject(new CodexClientError('protocol', 'Malformed remote error response', payload));
      return;
    }
    pending.reject(new CodexRemoteError(
      payload['id'],
      error['code'],
      error['message'],
      error['data'],
    ));
  }

  #handleNotification(notification: CodexNotification): void {
    try {
      void Promise.resolve(this.options.onNotification?.(notification)).catch(() => undefined);
    } catch {}
    const active = this.#activeTurn;
    if (active === undefined) {
      if (this.#startingTurnThreadId !== undefined) this.#earlyNotifications.push(notification);
      return;
    }
    let mapped;
    try {
      mapped = mapCodexNotification(notification.method, notification.params);
    } catch (error) {
      void this.#break(error);
      return;
    }
    for (const event of mapped.events) {
      if (event.type === 'message.delta' && event.messageId !== undefined) {
        if (notification.method === 'item/completed' && active.seenMessageDeltas.has(event.messageId)) continue;
        active.seenMessageDeltas.add(event.messageId);
      }
      if (event.type === 'thought.delta' && event.messageId !== undefined) {
        if (
          notification.method === 'item/completed' &&
          active.seenReasoningSummaryDeltas.has(event.messageId)
        ) {
          continue;
        }
        if (notification.method === 'item/reasoning/summaryTextDelta') {
          active.seenReasoningSummaryDeltas.add(event.messageId);
        }
      }
      active.events.push(event);
    }
    if (mapped.usage !== undefined) active.usage = mapped.usage;
    if (
      mapped.completion !== undefined &&
      mapped.completion.threadId === active.threadId &&
      mapped.completion.turnId === active.turnId
    ) {
      active.events.end();
      active.resolve({ ...mapped.completion, stderrTail: this.stderrTail(), usage: active.usage });
      this.#activeTurn = undefined;
      this.#turnSignal = undefined;
      if (this.#state === 'turning') this.#setState('ready');
    }
  }

  #handleServerRequest(payload: JsonObject): void {
    const id = payload['id'];
    const method = payload['method'];
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      typeof method !== 'string' ||
      !isObject(payload['params'])
    ) {
      void this.#write({
        id: typeof id === 'string' || typeof id === 'number' ? id : null,
        error: { code: -32602, message: 'Invalid server request' },
      }).catch(() => undefined);
      return;
    }
    if (this.#responders.has(id)) {
      void this.#break(new CodexClientError('protocol', `Duplicate server request id ${String(id)}`));
      return;
    }
    this.#responders.add(id);
    const responder: CodexServerRequestResponder = {
      respond: async (result) => {
        this.#takeResponder(id);
        await this.#write({ id, result });
      },
      respondError: async (code, message, data) => {
        this.#takeResponder(id);
        await this.#write({
          id,
          error: data === undefined ? { code, message } : { code, message, data },
        });
      },
    };
    const request: CodexServerRequest = { id, method, params: payload['params'] };
    const handler = this.options.onServerRequest;
    if (handler === undefined) {
      void responder.respondError(-32601, `Unsupported server request: ${method}`);
      return;
    }
    const signal = this.#turnSignal ?? AbortSignal.abort(new Error('No active Codex turn'));
    try {
      void Promise.resolve(handler(request, responder, signal)).catch((error: unknown) => {
        if (this.#responders.has(id)) {
          void responder.respondError(-32000, 'Server request handler failed', errorMessage(error));
        }
      });
    } catch (error) {
      void responder.respondError(-32000, 'Server request handler failed', errorMessage(error));
    }
  }

  #takeResponder(id: CodexRequestId): void {
    if (!this.#responders.delete(id)) {
      throw new CodexClientError('protocol', `Server request ${String(id)} is not pending`);
    }
  }

  async #write(payload: JsonObject): Promise<void> {
    const process = this.#process;
    if (process === undefined || this.#state === 'broken' || this.#state === 'closed') {
      throw asError(this.#terminalError, closedError(this.#state));
    }
    const raw = JSON.stringify(payload);
    const boundary: CodexWireFrame['boundary'] = Object.hasOwn(payload, 'method')
      ? Object.hasOwn(payload, 'id') ? 'request' : 'notification'
      : 'response';
    this.#observe('client-to-server', boundary, raw, payload);
    await new Promise<void>((resolve, reject) => {
      process.stdin.write(`${raw}\n`, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(new CodexClientError('stdio', 'Failed to write Codex app-server stdin', error));
      });
    });
  }

  #observe(
    direction: CodexWireFrame['direction'],
    boundary: CodexWireFrame['boundary'],
    raw: string,
    payload?: unknown,
  ): void {
    try {
      this.options.onFrame?.({
        sequence: ++this.#frameSequence,
        direction,
        boundary,
        raw,
        payload,
      });
    } catch {}
  }

  #takePending(id: string): PendingRequest | undefined {
    const pending = this.#pending.get(id);
    if (pending === undefined) return undefined;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    return pending;
  }

  #rejectPending(error: unknown): void {
    for (const id of this.#pending.keys()) this.#takePending(id)?.reject(error);
    this.#responders.clear();
  }

  async #break(error: unknown): Promise<void> {
    if (this.#state === 'broken' || this.#state === 'closed') return;
    this.#terminalError = error;
    this.#setState('broken');
    this.#rejectPending(error);
    const active = this.#activeTurn;
    if (active !== undefined) {
      active.events.fail(error);
      active.reject(error);
      this.#activeTurn = undefined;
    }
    const process = this.#process;
    if (process !== undefined) {
      process.stdin.end();
      await process.kill('SIGTERM').catch(() => undefined);
    }
  }

  #setState(state: CodexClientStatus['state']): void {
    this.#state = state;
    this.options.onStateChange?.(this.status());
  }
}

function threadResult(value: unknown, method: string): CodexThreadResult {
  const result = object(value, `${method} result`);
  const thread = object(result['thread'], `${method} result.thread`);
  const id = requiredString(thread['id'], `${method} result.thread.id`);
  return {
    thread: { ...thread, id },
    model: optionalString(result['model']),
    modelProvider: optionalString(result['modelProvider']),
    cwd: optionalString(result['cwd']),
  };
}

function assertHostOwnedArgs(args: readonly string[]): void {
  if (args.some((arg) => arg === '--listen' || arg.startsWith('--listen='))) {
    throw new CodexClientError('protocol', 'Codex descriptor args cannot override host-owned --listen');
  }
}

function object(value: unknown, name: string): JsonObject {
  if (!isObject(value)) throw new CodexClientError('protocol', `${name} must be an object`, value);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new CodexClientError('protocol', `${name} must be a string`, value);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function closedError(state: string): CodexClientError {
  return new CodexClientError('closed', `Codex client is not ready (${state})`);
}

function aborted(method: string, reason: unknown): CodexClientError {
  return new CodexClientError('aborted', `${method} was aborted`, reason);
}

function asError(value: unknown, fallback: Error): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  return fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}
