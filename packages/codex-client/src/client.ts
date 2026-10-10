import type { NormalizedExecutorEvent } from '@kiki/protocol';

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
}

interface ActiveTurn {
  readonly threadId: string;
  turnId?: string;
  observedTurnId?: string;
  terminal?: CodexTurnCompletion;
  readonly onEvent: (event: NormalizedExecutorEvent) => void | Promise<void>;
  readonly completion: Promise<CodexTurnCompletion>;
  readonly resolve: (value: CodexTurnCompletion) => void;
  readonly reject: (error: unknown) => void;
  readonly seenMessageDeltas: Set<string>;
  readonly seenReasoningSummaryDeltas: Set<string>;
  usage?: CodexTurnCompletion['usage'];
  usageBaseline?: CodexTurnCompletion['usage'];
  terminalError?: unknown;
  interruption?: Promise<boolean>;
  interruptTimer?: NodeJS.Timeout;
}

export class CodexAppServerClient {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #responders = new Set<CodexRequestId>();
  readonly #stderr: StderrRing;
  #process: HostProcessLike | undefined;
  #state: CodexClientStatus['state'] = 'cold';
  #agentVersion: string | undefined;
  #requestSequence = 0;
  #frameSequence = 0;
  #terminalError: unknown;
  #shutdownPromise: Promise<void> | undefined;
  #transportCleanup: Promise<void> | undefined;
  #exitDrainTimer: NodeJS.Timeout | undefined;
  #activeTurn: ActiveTurn | undefined;
  #turnSignal: AbortSignal | undefined;
  readonly #transportEnded = new AbortController();

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
      agentVersion: this.#agentVersion,
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
      const initialized = await this.#requestCore('initialize', {
        clientInfo: {
          name: this.descriptor.clientName ?? 'kiki-agent-core-v2',
          title: 'Kiki',
          version: this.descriptor.clientVersion ?? '0.1.0',
        },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }, this.descriptor.startupTimeoutMs ?? 30_000, signal);
      const userAgent = initialized !== null && typeof initialized === 'object'
        ? (initialized as Record<string, unknown>)['userAgent'] : undefined;
      this.#agentVersion = typeof userAgent === 'string' ? /^\S+\/([^\s]+)/.exec(userAgent)?.[1] : undefined;
      await this.#write({ method: 'initialized' });
      this.#setState('ready');
    } catch (error) {
      await this.#break(error);
      throw error;
    }
  }

  async listModels(signal?: AbortSignal): Promise<CodexModelListResult> {
    const models: CodexModelListResult['data'][number][] = [];
    const cursors = new Set<string>();
    let cursor: string | null | undefined;
    do {
      signal?.throwIfAborted();
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
      if (typeof cursor === 'string') {
        if (cursors.has(cursor)) {
          const error = new CodexClientError('protocol', 'model/list repeated a cursor');
          await this.#break(error);
          throw error;
        }
        cursors.add(cursor);
      }
    } while (cursor !== undefined && cursor !== null);
    return { data: models, nextCursor: null };
  }

  async startThread(params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<CodexThreadResult> {
    return threadResult(await this.request('thread/start', params, signal), 'thread/start');
  }

  async resumeThread(params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<CodexThreadResult> {
    return threadResult(await this.request('thread/resume', params, signal), 'thread/resume');
  }

  /**
   * Attaches the ordered event consumer before requesting the turn. The consumer
   * may run before the start ACK and is awaited to backpressure stdout; it must
   * not wait for another RPC on this connection. Resolves only after the ACK.
   */
  async startTurn(
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    onEvent: (event: NormalizedExecutorEvent) => void | Promise<void>,
  ): Promise<CodexTurnHandle> {
    signal.throwIfAborted();
    if (this.#state !== 'ready') throw closedError(this.#state);
    if (this.#activeTurn !== undefined) {
      throw new CodexClientError('protocol', 'Codex client already has an active turn');
    }
    let resolve!: (value: CodexTurnCompletion) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<CodexTurnCompletion>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    void completion.catch(() => undefined);
    const active: ActiveTurn = {
      threadId: requiredString(params['threadId'], 'turn/start params.threadId'),
      onEvent, completion, resolve, reject,
      seenMessageDeltas: new Set(),
      seenReasoningSummaryDeltas: new Set(),
    };
    this.#activeTurn = active;
    this.#turnSignal = signal;
    const onAbort = (): void => { void this.#interrupt(active).catch(() => undefined); };
    signal.addEventListener('abort', onAbort, { once: true });
    void completion.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
    const started = (async (): Promise<CodexTurnHandle> => {
      try {
        const result = object(await this.#requestCore('turn/start', params), 'turn/start result');
        const turn = object(result['turn'], 'turn/start result.turn');
        const turnId = requiredString(turn['id'], 'turn/start result.turn.id');
        if (this.#activeTurn !== active || this.#state !== 'ready') throw asError(this.#terminalError, closedError(this.#state));
        if (active.observedTurnId !== undefined && active.observedTurnId !== turnId) {
          const error = new CodexClientError('protocol', 'turn/start response does not match the observed turn');
          await this.#break(error);
          throw error;
        }
        active.turnId = turnId;
        if (active.interruptTimer !== undefined) clearTimeout(active.interruptTimer);
        this.#setState('turning');
        if (active.terminal !== undefined) this.#finishActiveTurn(active.terminal);
        else if (signal.aborted) void this.#interrupt(active).catch(() => undefined);
        return { completion, cancel: async () => this.#interrupt(active) };
      } catch (error) {
        this.#finishActiveTurn(undefined, error);
        throw error;
      }
    })();
    return waitForResponse(started, 'turn/start', this.descriptor.requestTimeoutMs, signal);
  }

  async request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#state !== 'ready' && this.#state !== 'turning') throw closedError(this.#state);
    return this.#requestCore(method, params, this.descriptor.requestTimeoutMs, signal);
  }

  shutdown(reason?: unknown): Promise<void> {
    return this.#shutdownPromise ??= this.#shutdown(reason);
  }

  async #shutdown(reason?: unknown): Promise<void> {
    if (this.#state === 'closed') return;
    const error = reason ?? new CodexClientError('closed', 'Codex client shut down');
    if (this.#state !== 'broken') {
      this.#setState('closing');
      const active = this.#activeTurn;
      if (active !== undefined) await this.#interrupt(active).catch(() => undefined);
    }
    this.#rejectPending(error);
    this.#clearStartingTurn();
    try {
      await this.#closeTransport(false);
    } finally {
      this.#finishActiveTurn(undefined, this.#terminalError ?? error);
      this.#setState('closed');
    }
  }

  #interrupt(active: ActiveTurn): Promise<boolean> {
    if (this.#activeTurn !== active || this.#state === 'broken' || this.#state === 'closed') {
      return Promise.resolve(false);
    }
    if (active.turnId === undefined) {
      active.interruptTimer ??= setTimeout(() => {
        void this.#break(new CodexClientError('timeout', 'Codex cancelled turn/start did not acknowledge within the shutdown grace'));
      }, this.descriptor.shutdownGraceMs ?? 3_000);
      return Promise.resolve(true);
    }
    return active.interruption ??= this.#sendInterrupt(active);
  }

  async #sendInterrupt(active: ActiveTurn): Promise<boolean> {
    const grace = this.descriptor.shutdownGraceMs ?? 3_000;
    try {
      await this.#requestCore('turn/interrupt', {
        threadId: active.threadId,
        turnId: active.turnId,
      }, grace);
      if (this.#activeTurn === active && this.#state === 'turning') {
        active.interruptTimer = setTimeout(() => {
          void this.#break(new CodexClientError('timeout', 'Codex interrupted turn did not complete within the shutdown grace'));
        }, grace);
      }
      return true;
    } catch (error) {
      await this.#break(error);
      return false;
    }
  }

  #closeTransport(force: boolean): Promise<void> {
    if (this.#exitDrainTimer !== undefined) clearTimeout(this.#exitDrainTimer);
    this.#exitDrainTimer = undefined;
    this.#transportEnded.abort(this.#terminalError ?? new CodexClientError('closed', 'Codex transport closed'));
    return this.#transportCleanup ??= this.#disposeTransport(force);
  }

  async #disposeTransport(force: boolean): Promise<void> {
    const process = this.#process;
    if (process === undefined) return;
    const grace = this.descriptor.shutdownGraceMs ?? 3_000;
    try {
      process.stdin.end();
      if (!force) await waitWithinGrace(process, grace);
      if (process.exitCode === null) {
        await process.kill('SIGTERM').catch(() => undefined);
        await waitWithinGrace(process, Math.max(250, grace));
      }
      if (process.exitCode === null) await process.kill('SIGKILL').catch(() => undefined);
      await process.wait();
    } finally {
      try {
        await process.dispose();
      } finally {
        if (this.#process === process) this.#process = undefined;
      }
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
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    void response.catch(() => undefined);
    try {
      await this.#write({ id, method, params });
    } catch (error) {
      this.#takePending(id)?.reject(error);
      throw error;
    }
    return waitForResponse(response, method, timeoutOverride, signal);
  }

  #attachProcess(process: HostProcessLike): void {
    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');
    void this.#readStdout(process).catch((error: unknown) => {
      if (!this.#transportEnded.signal.aborted) return this.#break(error);
    });
    process.stderr.on('data', (chunk: string) => this.#stderr.append(chunk));
    process.stdin.on('error', (error) => {
      void this.#break(new CodexClientError('stdio', 'Codex app-server stdin failed', error));
    });
    void process.wait().then((exitCode) => {
      if (this.#process !== process || this.#transportEnded.signal.aborted) return;
      this.#exitDrainTimer = setTimeout(() => {
        void this.#break(new CodexClientError('closed', `Codex app-server exited with code ${exitCode} before stdout drained`));
      }, this.descriptor.shutdownGraceMs ?? 3_000);
    }, (error: unknown) => this.#break(error));
  }

  async #readStdout(process: HostProcessLike): Promise<void> {
    const fragments: string[] = [];
    for await (const chunk of process.stdout) {
      if (this.#transportEnded.signal.aborted) return;
      const text = String(chunk);
      let start = 0;
      for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', start)) {
        fragments.push(text.slice(start, index));
        const raw = fragments.join('').replace(/\r$/, '');
        fragments.length = 0;
        await this.#consumeLine(raw);
        if (this.#transportEnded.signal.aborted) return;
        start = index + 1;
      }
      if (start < text.length) fragments.push(text.slice(start));
    }
    if (fragments.length > 0) await this.#consumeLine(fragments.join('').replace(/\r$/, ''));
    if (this.#state !== 'closing' && this.#state !== 'closed' && this.#state !== 'broken') {
      await this.#break(new CodexClientError('closed', process.exitCode === null
        ? 'Unexpected Codex app-server stdout EOF' : `Codex app-server exited with code ${process.exitCode}`));
    }
  }

  async #consumeLine(raw: string): Promise<void> {
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
        await this.#handleNotification({ method: payload['method'], params: payload['params'] });
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

  async #handleNotification(notification: CodexNotification): Promise<void> {
    try {
      void Promise.resolve(this.options.onNotification?.(notification)).catch(() => undefined);
    } catch {}
    if (this.#transportEnded.signal.aborted) return;
    const active = this.#activeTurn;
    if (active === undefined) return;
    const threadId = notificationThreadId(notification.params);
    if (threadId !== undefined && threadId !== active.threadId) return;
    const params = isObject(notification.params) ? notification.params : undefined;
    const turnId = optionalString(params?.['turnId']) ??
      (isObject(params?.['turn']) ? optionalString(params['turn']['id']) : undefined);
    if (turnId !== undefined) {
      if (active.turnId !== undefined && turnId !== active.turnId) return;
      if (active.observedTurnId !== undefined && turnId !== active.observedTurnId) return;
      active.observedTurnId = turnId;
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
      await waitForResponse(Promise.resolve(active.onEvent(event)), 'event consumer', undefined, this.#transportEnded.signal);
    }
    if (mapped.usage !== undefined && mapped.cumulativeUsage !== undefined) {
      active.usageBaseline ??= subtractUsage(mapped.cumulativeUsage, mapped.usage);
      active.usage = active.usageBaseline === undefined
        ? undefined : subtractUsage(mapped.cumulativeUsage, active.usageBaseline);
    }
    if (mapped.terminalError !== undefined) active.terminalError = mapped.terminalError;
    if (
      mapped.completion !== undefined &&
      mapped.completion.threadId === active.threadId &&
      (active.turnId === undefined || mapped.completion.turnId === active.turnId)
    ) {
      active.terminal = {
        ...mapped.completion,
        status: active.terminalError === undefined ? mapped.completion.status : 'failed',
        error: active.terminalError ?? mapped.completion.error,
        stderrTail: this.stderrTail(),
        usage: active.usage,
      };
      if (active.turnId !== undefined) this.#finishActiveTurn(active.terminal);
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
    return pending;
  }

  #rejectPending(error: unknown): void {
    for (const id of this.#pending.keys()) this.#takePending(id)?.reject(error);
    this.#responders.clear();
  }

  #clearStartingTurn(): void {
    this.#turnSignal = undefined;
  }

  #finishActiveTurn(completed?: CodexTurnCompletion, error?: unknown): void {
    const active = this.#activeTurn;
    if (active === undefined) return;
    this.#activeTurn = undefined;
    this.#clearStartingTurn();
    if (active.interruptTimer !== undefined) clearTimeout(active.interruptTimer);
    if (completed !== undefined) active.resolve(completed);
    else active.reject(error);
    if (this.#state === 'turning') this.#setState('ready');
  }

  async #break(error: unknown): Promise<void> {
    if (this.#state === 'closed') return;
    if (this.#state !== 'broken') {
      this.#terminalError = error;
      this.#setState('broken');
      this.#rejectPending(error);
      this.#clearStartingTurn();
    }
    try {
      await this.#closeTransport(true);
    } finally {
      this.#finishActiveTurn(undefined, this.#terminalError);
    }
  }

  #setState(state: CodexClientStatus['state']): void {
    this.#state = state;
    try {
      this.options.onStateChange?.(this.status());
    } catch (error) {
      try {
        this.options.logger?.error?.('Codex state observer failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {}
    }
  }
}

function waitForResponse<T>(response: Promise<T>, method: string, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown): void => { cleanup(); reject(error); };
    const onAbort = (): void => fail(aborted(method, signal?.reason));
    response.then((value) => { cleanup(); resolve(value); }, fail);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => fail(new CodexClientError('timeout', `Waiting for ${method} response timed out after ${timeoutMs}ms`)), timeoutMs);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function waitWithinGrace(process: HostProcessLike, grace: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      process.wait(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, grace); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function threadResult(value: unknown, method: string): CodexThreadResult {
  const result = object(value, `${method} result`);
  const thread = object(result['thread'], `${method} result.thread`);
  const id = requiredString(thread['id'], `${method} result.thread.id`);
  return {
    thread: { ...thread, id },
    approvalPolicy: typeof result['approvalPolicy'] === 'string' ? result['approvalPolicy']
      : typeof result['approvalPolicy'] === 'object' && result['approvalPolicy'] !== null && !Array.isArray(result['approvalPolicy'])
        ? result['approvalPolicy'] as Readonly<Record<string, unknown>> : undefined,
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

function subtractUsage(
  total: NonNullable<CodexTurnCompletion['usage']>,
  baseline: NonNullable<CodexTurnCompletion['usage']>,
): CodexTurnCompletion['usage'] {
  const inputTokens = total.inputTokens - baseline.inputTokens;
  const cachedInputTokens = total.cachedInputTokens - baseline.cachedInputTokens;
  const outputTokens = total.outputTokens - baseline.outputTokens;
  return inputTokens >= 0 && cachedInputTokens >= 0 && outputTokens >= 0
    ? { inputTokens, cachedInputTokens, outputTokens, contextWindow: total.contextWindow }
    : undefined;
}

function notificationThreadId(value: unknown): string | undefined {
  return isObject(value) && typeof value['threadId'] === 'string' ? value['threadId'] : undefined;
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
