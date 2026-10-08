import { Readable, Transform, Writable } from 'node:stream';

import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentCapabilities,
  type ClientConnection,
  type InitializeRequest,
  type NewSessionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk';

import { AsyncQueue, type AsyncQueueReservation } from '#/async-queue';
import { AcpClientError, AcpClientErrorCode, AcpProtocolError } from '#/errors';
import {
  mapAcpSessionNotification,
  type NormalizedExecutorEvent,
} from '#/events';
import { parseExecutorSessionRefEnvelope } from '#/session-ref';
import { airSessionFailure } from '#/session-failure';
import { StderrRingBuffer } from '#/stderr-ring';
import type {
  AcpClientOptions,
  AcpClientState,
  AcpClientStatus,
  AcpConfigureSessionOptions,
  AcpOpenSessionOptions,
  AcpOpenSessionResult,
  AcpProcessDescriptor,
  AcpSessionConfigSelection,
  AcpSessionOpenMode,
  AcpTurnHandle,
  AcpTurnRequest,
  AcpTurnResult,
  ExecutorSessionRefEnvelope,
  HostProcessLike,
  HostProcessServiceLike,
} from '#/types';

const DEFAULT_STARTUP_TIMEOUT_MS = 70_000;
const DEFAULT_CANCEL_GRACE_MS = 3_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
const DEFAULT_STDERR_MAX_BYTES = 64 * 1024;
const MAX_EVENT_BACKLOG = 1024;
const SESSION_REF_VERSION = 1;
const UNKNOWN_UPDATE_METHOD = '_kiki/session_update_unknown';
const KNOWN_UPDATE_TYPES = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
]);

interface ActiveTurn {
  readonly queue: AsyncQueue<NormalizedExecutorEvent>;
  readonly requestController: AbortController;
  readonly signal: AbortSignal;
  readonly settled: Promise<void>;
  resolveSettled(): void;
  cancellation?: Promise<void>;
}

interface OpenResponse {
  readonly sessionId: string;
  readonly mode: Exclude<AcpSessionOpenMode, 'live'>;
  readonly configOptions: readonly SessionConfigOption[];
  readonly currentModeId?: string;
  readonly availableModes?: readonly string[];
}

class LineBuffer {
  readonly #pending: Uint8Array[] = [];

  push(chunk: Uint8Array): Uint8Array[] {
    const lines: Uint8Array[] = [];
    let start = 0;
    let newline = chunk.indexOf(0x0a, start);
    while (newline !== -1) {
      lines.push(this.#takeLine(chunk.subarray(start, newline)));
      start = newline + 1;
      newline = chunk.indexOf(0x0a, start);
    }
    if (start < chunk.byteLength) {
      this.#pending.push(start === 0 ? chunk : new Uint8Array(chunk.subarray(start)));
    }
    return lines;
  }

  flush(): Uint8Array | undefined {
    if (this.#pending.length === 0) return undefined;
    return this.#takeLine(new Uint8Array(0));
  }

  #takeLine(tail: Uint8Array): Uint8Array {
    if (this.#pending.length === 0) return tail;
    let total = tail.byteLength;
    for (const part of this.#pending) total += part.byteLength;
    const line = new Uint8Array(total);
    let offset = 0;
    for (const part of this.#pending) {
      line.set(part, offset);
      offset += part.byteLength;
    }
    line.set(tail, offset);
    this.#pending.length = 0;
    return line;
  }
}

class ValidatedNdjsonInput extends Transform {
  readonly #decoder = new TextDecoder();
  readonly #lines = new LineBuffer();
  readonly #onProtocolError: (error: AcpProtocolError) => void;
  readonly #beforeFrame: ((line: string) => Promise<void>) | undefined;
  #callback: ((error?: Error | null) => void) | undefined;

  constructor(
    onProtocolError: (error: AcpProtocolError) => void,
    beforeFrame?: (line: string) => Promise<void>,
  ) {
    super();
    this.#onProtocolError = onProtocolError;
    this.#beforeFrame = beforeFrame;
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#callback = callback;
    void this.#consume(typeof chunk === 'string' ? Buffer.from(chunk) : chunk).then(
      () => this.#finishTransform(),
      (error: unknown) => this.#failTransform(error, 'ACP stdout contained malformed NDJSON'),
    );
  }

  override _flush(callback: (error?: Error | null) => void): void {
    this.#callback = callback;
    void this.#finish().then(
      () => this.#finishTransform(),
      (error: unknown) => this.#failTransform(error, 'ACP stdout ended with malformed NDJSON'),
    );
  }

  async #finish(): Promise<void> {
    await this.#consume(new Uint8Array(0));
    const tail = this.#lines.flush();
    if (tail === undefined) return;
    await this.#emitLine(this.#decoder.decode(tail), false);
  }

  async #consume(value: Uint8Array): Promise<void> {
    for (const line of this.#lines.push(value)) {
      await this.#emitLine(this.#decoder.decode(line), true);
    }
  }

  async #emitLine(line: string, terminated: boolean): Promise<void> {
    const validated = this.#validatedLine(line);
    const output = terminated ? `${validated}\n` : validated;
    await this.#beforeFrame?.(output);
    this.push(output);
  }

  #finishTransform(): void {
    const callback = this.#callback;
    this.#callback = undefined;
    callback?.();
  }

  #failTransform(error: unknown, message: string): void {
    const protocolError =
      error instanceof AcpProtocolError
        ? error
        : new AcpProtocolError(message, { cause: error });
    this.#onProtocolError(protocolError);
    const callback = this.#callback;
    this.#callback = undefined;
    callback?.(protocolError);
  }

  #validatedLine(line: string): string {
    if (line.trim().length === 0) return line;
    const message = JSON.parse(line) as unknown;
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return line;
    }
    const record = message as Record<string, unknown>;
    if (record['method'] !== methods.client.session.update) return line;
    const params = record['params'];
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new AcpProtocolError('session/update params must be an object');
    }
    const update = (params as Record<string, unknown>)['update'];
    if (typeof update !== 'object' || update === null || Array.isArray(update)) {
      throw new AcpProtocolError('session/update update must be an object');
    }
    const updateType = (update as Record<string, unknown>)['sessionUpdate'];
    if (typeof updateType !== 'string') {
      throw new AcpProtocolError('session/update discriminator must be a string');
    }
    if (KNOWN_UPDATE_TYPES.has(updateType)) {
      mapAcpSessionNotification(params);
      return line;
    }
    return JSON.stringify({ ...record, method: UNKNOWN_UPDATE_METHOD });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Operation aborted');
}

function isFallbackSessionError(error: unknown): boolean {
  if (error instanceof RequestError) {
    return error.code === -32601 || error.code === -32002;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /method.?not.?found|unknown session|session.+not found/i.test(message);
}

function sessionIdFromEnvelope(
  envelope: ExecutorSessionRefEnvelope,
  executorId: string,
): string {
  const parsed = parseExecutorSessionRefEnvelope(envelope);
  if (parsed.executorId !== executorId || parsed.version !== SESSION_REF_VERSION) {
    throw new AcpClientError(
      AcpClientErrorCode.InvalidSessionRef,
      'Executor session ref does not match this ACP executor',
    );
  }
  const sessionId = parsed.ref['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new AcpClientError(
      AcpClientErrorCode.InvalidSessionRef,
      'Executor session ref is missing sessionId',
    );
  }
  return sessionId;
}

export class AcpProcessClient {
  readonly #processService: HostProcessServiceLike;
  readonly #descriptor: AcpProcessDescriptor;
  readonly #options: AcpClientOptions;
  readonly #stderr: StderrRingBuffer;
  readonly #platform: NodeJS.Platform;
  readonly #intentionalExit = new WeakSet<HostProcessLike>();

  #state: AcpClientState = 'cold';
  #openingMode: Exclude<AcpSessionOpenMode, 'live'> | undefined;
  #process: HostProcessLike | undefined;
  readonly #exitedProcesses = new Set<HostProcessLike>();
  #connection: ClientConnection | undefined;
  #capabilities: AgentCapabilities = {};
  #openResult: AcpOpenSessionResult | undefined;
  #observedModeId: string | undefined;
  #modeWaiter: ((mode: string) => void) | undefined;
  #activeTurn: ActiveTurn | undefined;
  #pendingEventReservations: Array<{
    readonly active: ActiveTurn;
    readonly reservation: AsyncQueueReservation<NormalizedExecutorEvent>;
  }> = [];
  #startupInFlight = false;
  #loadReplayCount = 0;
  #protocolFailure: AcpProtocolError | undefined;
  #steeringDetached = false;

  constructor(
    processService: HostProcessServiceLike,
    descriptor: AcpProcessDescriptor,
    options: AcpClientOptions = {},
  ) {
    this.#processService = processService;
    this.#descriptor = descriptor;
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
    this.#stderr = new StderrRingBuffer(
      descriptor.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES,
    );
  }

  status(): AcpClientStatus {
    return {
      state: this.#state,
      openingMode: this.#openingMode,
      pid: this.#process?.pid,
      sessionId: this.#openResult?.sessionId,
    };
  }

  stderrTail(): string {
    return this.#stderr.toString();
  }

  sessionRef(): ExecutorSessionRefEnvelope | undefined {
    return this.#openResult?.sessionRef;
  }

  async openSession(options: AcpOpenSessionOptions): Promise<AcpOpenSessionResult> {
    if (this.#state === 'closed' || this.#state === 'closing') {
      throw new AcpClientError(AcpClientErrorCode.Closed, 'ACP client is closed');
    }
    if (this.#state === 'prompting' || this.#startupInFlight) {
      throw new AcpClientError(AcpClientErrorCode.Busy, 'ACP client is busy');
    }
    if (
      this.#state === 'ready' &&
      this.#process !== undefined &&
      this.#process.exitCode === null &&
      this.#connection !== undefined &&
      !this.#connection.signal.aborted &&
      this.#openResult !== undefined
    ) {
      return { ...this.#openResult, mode: 'live' };
    }

    this.#startupInFlight = true;
    const deadline =
      Date.now() +
      (this.#descriptor.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    let lastError: unknown;
    const persistFork = options.onFork;
    const onFork = async (ref: ExecutorSessionRefEnvelope): Promise<void> => {
      try { await persistFork?.(ref); }
      catch (error) { throw new AcpClientError(AcpClientErrorCode.InvalidSessionRef, 'Cannot persist the forked ACP session reference', { cause: error }); }
      options = { ...options, sessionRef: ref };
    };
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (options.signal?.aborted === true) {
          throw new AcpClientError(
            AcpClientErrorCode.Cancelled,
            'ACP startup was cancelled',
            { cause: abortReason(options.signal) },
          );
        }
        try {
          return await this.#startOnce({ ...options, onFork }, deadline);
        } catch (error) {
          lastError = error;
          await this.#cleanupTransport(false);
          if (
            attempt === 1 ||
            error instanceof AcpClientError &&
              (error.code === AcpClientErrorCode.Cancelled ||
                error.code === AcpClientErrorCode.StartupTimeout ||
                error.code === AcpClientErrorCode.InvalidSessionRef)
          ) {
            break;
          }
          this.#setState('cold');
        }
      }
      this.#setState('broken');
      throw this.#decorateError(lastError, AcpClientErrorCode.SessionOpenFailed);
    } finally {
      this.#startupInFlight = false;
    }
  }

  async configureSession(
    options: AcpConfigureSessionOptions,
  ): Promise<AcpOpenSessionResult> {
    if (this.#state !== 'ready' || this.#connection === undefined || this.#openResult === undefined) {
      throw new AcpClientError(
        AcpClientErrorCode.SessionOpenFailed,
        'ACP session must be ready before it can be configured',
      );
    }
    const connection = this.#connection;
    const deadline =
      Date.now() + (this.#descriptor.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    this.#setState('configuring');
    try {
      let configOptions = [...this.#openResult.configOptions];
      for (const selection of options.configOptions ?? []) {
        configOptions = await this.#configureSelection(
          connection,
          this.#openResult.sessionId,
          configOptions,
          selection,
          deadline,
          options.signal,
        );
      }
      if (options.modeId !== undefined) {
        this.#observedModeId = undefined;
        const observed = new Promise<string>((resolve) => { this.#modeWaiter = resolve; });
        try {
          await this.#requestDuringStartup(
            connection.agent.request(methods.agent.session.setMode, {
              sessionId: this.#openResult.sessionId,
              modeId: options.modeId,
            }),
            deadline,
            options.signal,
          );
          if (this.#observedModeId === undefined) {
            await Promise.race([observed, new Promise<void>((resolve) => { setTimeout(resolve, 500); })]);
          }
        } finally {
          this.#modeWaiter = undefined;
        }
      }
      this.#openResult = { ...this.#openResult, configOptions, currentModeId: this.#observedModeId };
      this.#setState('ready');
      return this.#openResult;
    } catch (error) {
      if (this.#connection === connection && !connection.signal.aborted) {
        this.#setState('ready');
      } else {
        this.#setState('broken');
      }
      throw this.#decorateError(error, AcpClientErrorCode.SessionOpenFailed);
    }
  }

  async #configureSelection(
    connection: ClientConnection,
    sessionId: string,
    configOptions: readonly SessionConfigOption[],
    selection: AcpSessionConfigSelection,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<SessionConfigOption[]> {
    const option = configOptions.find((candidate) => candidate.id === selection.configId);
    const transport = option?._meta?.['kiki.transport'];
    if (transport === 'session/set_model') {
      const modelOption = configOptions.find((candidate) =>
        candidate.category === 'model' && candidate._meta?.['kiki.transport'] === transport);
      const modelId = selection.configId === modelOption?.id
        ? String(selection.value)
        : typeof modelOption?.currentValue === 'string'
          ? modelOption.currentValue
          : undefined;
      if (modelId === undefined) {
        throw new AcpProtocolError('Synthetic session/set_model transport has no selected model');
      }
      await this.#requestDuringStartup(
        connection.agent.request('session/set_model', {
          sessionId,
          modelId,
          _meta: option?.category === 'thought_level'
            ? { reasoningEffort: selection.value }
            : undefined,
        }),
        deadline,
        signal,
      );
      const updated = configOptions.map((candidate) =>
        candidate.id === selection.configId
          ? { ...candidate, currentValue: selection.value } as SessionConfigOption
          : candidate,
      );
      return option?.category === 'model' ? grokModelOptions(updated, modelOption?._meta?.['kiki.models']) : updated;
    }
    const configRequest: SetSessionConfigOptionRequest =
      typeof selection.value === 'boolean'
        ? {
            sessionId,
            configId: selection.configId,
            type: 'boolean',
            value: selection.value,
          }
        : {
            sessionId,
            configId: selection.configId,
            value: selection.value,
          };
    const response = await this.#requestDuringStartup(
      connection.agent.request(methods.agent.session.setConfigOption, configRequest),
      deadline,
      signal,
    );
    return response.configOptions;
  }

  async startTurn(
    request: AcpTurnRequest,
  ): Promise<AcpTurnHandle<NormalizedExecutorEvent>> {
    if (request.signal.aborted) {
      throw new AcpClientError(AcpClientErrorCode.Cancelled, 'ACP turn was cancelled', {
        cause: abortReason(request.signal),
      });
    }
    if (this.#activeTurn !== undefined || this.#state === 'prompting') {
      throw new AcpClientError(AcpClientErrorCode.Busy, 'An ACP prompt is already active');
    }

    const session = await this.openSession({
      ...request.session,
      signal: request.signal,
    });
    const connection = this.#connection;
    if (connection === undefined) {
      throw new AcpClientError(
        AcpClientErrorCode.Disconnected,
        'ACP connection closed before prompt',
      );
    }

    for (const attachment of request.attachments ?? []) {
      if (attachment.type === 'image' && session.capabilities.promptCapabilities?.image !== true && this.#descriptor.id !== 'grok-acp') {
        throw new AcpProtocolError('ACP harness does not support image attachments');
      }
      if (attachment.type === 'audio' && session.capabilities.promptCapabilities?.audio !== true) {
        throw new AcpProtocolError('ACP harness does not support audio attachments');
      }
    }
    const queue = new AsyncQueue<NormalizedExecutorEvent>(MAX_EVENT_BACKLOG);
    const requestController = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const active: ActiveTurn = {
      queue,
      requestController,
      signal: request.signal,
      settled,
      resolveSettled,
    };
    this.#activeTurn = active;
    this.#setState('prompting');

    const onAbort = (): void => {
      void this.cancel(abortReason(request.signal));
    };
    request.signal.addEventListener('abort', onAbort, { once: true });

    const completion = (async (): Promise<AcpTurnResult> => {
      try {
        const prompt = connection.agent.request(
          methods.agent.session.prompt,
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: request.prompt }, ...request.attachments ?? []],
          },
          { cancellationSignal: requestController.signal },
        );
        const response = await Promise.race([
          prompt,
          connection.closed.then(() => {
            throw this.#disconnectError('ACP connection closed during prompt');
          }),
        ]);
        const sessionFailure = airSessionFailure(response._meta);
        if (sessionFailure !== undefined) throw sessionFailure;
        queue.close();
        if (
          this.#state === 'prompting' &&
          this.#connection === connection &&
          !connection.signal.aborted
        ) {
          this.#setState('ready');
        }
        // stderr is a pipe independent of the ACP stdout stream, so there is no
        // ordering guarantee between an agent's stderr write and its prompt
        // response. This snapshot is a best-effort view of the stderr received
        // so far; `stderrTail()` retains the live tail.
        return { response, session, stderrTail: this.stderrTail() };
      } catch (error) {
        const failure =
          error instanceof AcpClientError
            ? error
            : connection.signal.aborted
              ? this.#disconnectError('ACP connection closed during prompt', error)
              : this.#decorateError(error, AcpClientErrorCode.ProtocolError);
        queue.fail(failure);
        this.#releasePendingEventReservations(active);
        if (this.#state === 'prompting') this.#setState('broken');
        throw failure;
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        active.resolveSettled();
        if (this.#activeTurn === active) this.#activeTurn = undefined;
      }
    })();

    void completion.catch(() => {});
    return {
      events: queue,
      completion,
      cancel: (reason?: unknown) => this.cancel(reason),
    };
  }

  async steer(prompt: readonly import('@agentclientprotocol/sdk').ContentBlock[]): Promise<boolean> {
    const active = this.#activeTurn;
    const connection = this.#connection;
    const session = this.#openResult;
    const steering = objectValue(session?.initialize._meta?.['steering']);
    if (active === undefined || active.signal.aborted || connection === undefined || session === undefined ||
        steering?.['supported'] !== true || this.#steeringDetached) return false;
    const response = await connection.agent.request('_session/steering', {
      sessionId: session.sessionId,
      prompt,
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    }, { cancellationSignal: active.signal });
    const outcome = objectValue(response)?.['outcome'];
    if (outcome === 'injected') return true;
    if (outcome === 'promptRequired') return false;
    if (outcome === 'startedNewTurn') {
      this.#steeringDetached = true;
      return true;
    }
    throw new AcpProtocolError('ACP steering returned an unknown consumption outcome');
  }

  async cancel(reason: unknown = new Error('ACP turn cancelled')): Promise<boolean> {
    const active = this.#activeTurn;
    const connection = this.#connection;
    const sessionId = this.#openResult?.sessionId;
    if (active === undefined || connection === undefined || sessionId === undefined) {
      return false;
    }
    if (active.cancellation !== undefined) {
      await active.cancellation;
      return true;
    }

    active.cancellation = (async () => {
      active.requestController.abort(reason);
      try {
        await connection.agent.notify(methods.agent.session.cancel, { sessionId });
      } catch (error) {
        this.#options.logger?.warn?.('Failed to send ACP session/cancel', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const grace = this.#descriptor.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
      const settled = await Promise.race([
        active.settled.then(() => true),
        delay(grace).then(() => false),
      ]);
      if (!settled && this.#activeTurn === active) {
        connection.close(reason);
        await this.#terminateCurrentProcess();
      }
    })();
    await active.cancellation;
    return true;
  }

  async shutdown(reason: unknown = new Error('ACP client closed')): Promise<void> {
    if (this.#state === 'closed') return;
    this.#setState('closing');
    try {
      if (this.#activeTurn !== undefined) await this.cancel(reason);
    } finally {
      try {
        this.#connection?.close(reason);
      } finally {
        try {
          await this.#terminateCurrentProcess();
        } finally {
          this.#connection = undefined;
          this.#process = undefined;
          this.#setState('closed');
        }
      }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  async #startOnce(
    options: AcpOpenSessionOptions,
    deadline: number,
  ): Promise<AcpOpenSessionResult> {
    this.#protocolFailure = undefined;
    this.#loadReplayCount = 0;
    this.#stderr.clear();
    this.#setState('spawning');

    const spawnPromise = this.#processService.spawn(
      this.#descriptor.command,
      this.#descriptor.args ?? [],
      {
        cwd: this.#descriptor.cwd,
        env: this.#descriptor.env,
        shell: false,
        windowsHide: true,
        mergeStderr: false,
      },
    );
    let child: HostProcessLike;
    try {
      child = await this.#withStartupDeadline(spawnPromise, deadline, options.signal);
    } catch (error) {
      void spawnPromise.then((lateChild) => this.#terminateProcess(lateChild)).catch(() => {});
      if (error instanceof AcpClientError) throw error;
      throw new AcpClientError(AcpClientErrorCode.SpawnFailed, 'Failed to spawn ACP agent', {
        cause: error,
      });
    }
    this.#process = child;
    this.#observeProcess(child);
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.#stderr.append(chunk);
      this.#options.logger?.debug?.('ACP agent stderr', {
        chunk: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk,
      });
    });

    const validatedInput = new ValidatedNdjsonInput(
      (error) => {
        this.#protocolFailure = error;
        this.#connection?.close(error);
      },
      (line) => this.#reserveEventFrame(line),
    );
    child.stdout.pipe(validatedInput);
    const app = client({ name: this.#descriptor.clientName ?? 'kiki-acp-client' });
    app.onNotification(methods.client.session.update, ({ params }) => {
      this.#handleSessionUpdate(params);
    });
    if (this.#descriptor.id === 'grok-acp') {
      for (const method of ['_x.ai/session_notification', '_x.ai/session/update']) {
        app.onNotification<unknown>(method, (params) => params, ({ params }) => { this.#handleSessionUpdate(params, method); });
      }
    }
    app.onNotification<unknown>(
      UNKNOWN_UPDATE_METHOD,
      (params) => params,
      ({ params }) => {
        this.#handleSessionUpdate(params);
      },
    );
    app.onRequest(methods.client.session.requestPermission, async (context) => {
      const handler = this.#options.permissionHandler;
      if (handler === undefined) {
        return { outcome: { outcome: 'cancelled' } };
      }
      const signal =
        this.#activeTurn === undefined
          ? context.signal
          : AbortSignal.any([context.signal, this.#activeTurn.signal]);
      try {
        const decision = await handler(context.params, {
          signal,
          options: context.params.options,
        });
        if (decision.outcome !== 'selected') {
          return { outcome: { outcome: 'cancelled' } };
        }
        const valid = context.params.options.some(
          (option) => option.optionId === decision.optionId,
        );
        if (!valid || decision.optionId === undefined) {
          return { outcome: { outcome: 'cancelled' } };
        }
        return {
          outcome: { outcome: 'selected', optionId: decision.optionId },
        } satisfies RequestPermissionResponse;
      } catch {
        return { outcome: { outcome: 'cancelled' } };
      }
    });

    app.onRequest(methods.client.elicitation.create, async (context) => {
      const handler = this.#options.elicitationHandler;
      if (handler === undefined || context.params.mode !== 'form') return { action: 'decline' };
      const signal = this.#activeTurn === undefined ? context.signal
        : AbortSignal.any([context.signal, this.#activeTurn.signal]);
      if (signal.aborted) return { action: 'cancel' };
      return handler(context.params, { signal });
    });

    app.onRequest('_x.ai/hooks/run', (input: unknown) => {
      const value = objectValue(input);
      if (value?.['hookCallbackId'] !== 'kiki-context' || value['hookEventName'] !== 'stop' || typeof value['sessionId'] !== 'string') {
        throw new AcpProtocolError('Invalid Kiki context hook callback');
      }
      return { sessionId: value['sessionId'] };
    }, async (context) => {
      const handler = this.#options.contextHookHandler;
      const signal = this.#activeTurn === undefined ? context.signal : AbortSignal.any([context.signal, this.#activeTurn.signal]);
      if (handler === undefined || signal.aborted || context.params.sessionId !== this.#openResult?.sessionId) return {};
      return handler('Stop', { signal });
    });

    app.onRequest('_x.ai/exit_plan_mode', (input: unknown) => {
      const value = objectValue(input);
      if (value === undefined || typeof value['sessionId'] !== 'string') throw new AcpProtocolError('Invalid Grok plan approval request');
      return { sessionId: value['sessionId'], toolCallId: typeof value['toolCallId'] === 'string' ? value['toolCallId'] : undefined,
        plan: typeof value['planContent'] === 'string' ? value['planContent'].slice(0, 262_144) : '' };
    }, async (context) => {
      const handler = this.#options.planApprovalHandler;
      const signal = this.#activeTurn === undefined ? context.signal : AbortSignal.any([context.signal, this.#activeTurn.signal]);
      if (handler === undefined || signal.aborted) return { outcome: 'keep_planning', feedback: '' };
      return handler(context.params, { signal });
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(validatedInput) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    this.#connection = connection;
    this.#observeConnection(connection);

    this.#setState('initializing');
    const initializeRequest: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        plan: {},
        session: { configOptions: { boolean: {} } },
        ...(this.#options.elicitationHandler === undefined ? {} : { elicitation: { form: {} } }),
        _meta: { jetbrains: { air: { version: 1, capabilities: ['sessionFailure'] } } },
      },
      clientInfo: {
        name: this.#descriptor.clientName ?? 'kiki-acp-client',
        version: '0.0.1',
      },
      _meta: { steering: { supported: true } },
    };
    const initialize = await this.#requestDuringStartup(
      connection.agent.request(methods.agent.initialize, initializeRequest),
      deadline,
      options.signal,
    );
    if (initialize.protocolVersion !== PROTOCOL_VERSION) {
      throw new AcpProtocolError(
        `ACP agent selected unsupported protocol version ${String(initialize.protocolVersion)}`,
      );
    }
    this.#capabilities = initialize.agentCapabilities ?? {};

    const opened = await this.#openRemoteSession(options, deadline);
    this.#setState('configuring');
    let configOptions = [...opened.configOptions];
    for (const selection of options.configOptions ?? []) {
      const configRequest: SetSessionConfigOptionRequest =
        typeof selection.value === 'boolean'
          ? {
              sessionId: opened.sessionId,
              configId: selection.configId,
              type: 'boolean',
              value: selection.value,
            }
          : {
              sessionId: opened.sessionId,
              configId: selection.configId,
              value: selection.value,
            };
      const response = await this.#requestDuringStartup(
        connection.agent.request(methods.agent.session.setConfigOption, configRequest),
        deadline,
        options.signal,
      );
      configOptions = response.configOptions;
    }
    if (options.modeId !== undefined) {
      await this.#requestDuringStartup(
        connection.agent.request(methods.agent.session.setMode, {
          sessionId: opened.sessionId,
          modeId: options.modeId,
        }),
        deadline,
        options.signal,
      );
    }

    const sessionRef = parseExecutorSessionRefEnvelope({
      executorId: this.#descriptor.id,
      version: SESSION_REF_VERSION,
      ref: { sessionId: opened.sessionId },
    });
    const result: AcpOpenSessionResult = {
      sessionId: opened.sessionId,
      mode: opened.mode,
      initialize,
      capabilities: this.#capabilities,
      configOptions,
      currentModeId: opened.currentModeId,
      availableModes: opened.availableModes,
      sessionRef,
      loadReplayObserved: this.#loadReplayCount > 0,
      quarantinedUpdateCount: this.#loadReplayCount,
    };
    this.#openResult = result;
    this.#openingMode = undefined;
    this.#setState('ready');
    return result;
  }

  async #openRemoteSession(
    options: AcpOpenSessionOptions,
    deadline: number,
  ): Promise<OpenResponse> {
    const connection = this.#connection!;
    const common: NewSessionRequest = {
      cwd: options.cwd,
      additionalDirectories: this.#additionalDirectoriesForSession(
        options.additionalDirectories,
      ),
      mcpServers: options.mcpServers === undefined ? [] : [...options.mcpServers],
      _meta: options.sessionMeta,
    };
    let priorSessionId =
      options.sessionRef === undefined
        ? undefined
        : sessionIdFromEnvelope(options.sessionRef, this.#descriptor.id);
    const pendingFork = objectValue(options.sessionRef?.ref['kikiFork']);
    if (pendingFork !== undefined && priorSessionId !== undefined) {
      if (pendingFork['handoff'] === true || this.#capabilities.sessionCapabilities?.fork === undefined || this.#capabilities.sessionCapabilities?.fork === null) {
        priorSessionId = undefined;
      } else {
        const point = objectValue(pendingFork['point']);
        if (point === undefined || typeof point['messageId'] !== 'string' || typeof point['messageFingerprint'] !== 'string') throw new AcpProtocolError('Invalid persisted ACP fork point');
        const canResume = this.#capabilities.sessionCapabilities?.resume !== undefined && this.#capabilities.sessionCapabilities?.resume !== null;
        const forked = await this.#requestDuringStartup(connection.agent.request(methods.agent.session.fork, {
          sessionId: priorSessionId, cwd: options.cwd,
          ...(canResume ? {} : { mcpServers: common.mcpServers }),
          _meta: { jetbrains: { air: { fork: point } } },
        }), deadline, options.signal);
        await options.onFork?.({ executorId: this.#descriptor.id, version: SESSION_REF_VERSION, ref: { sessionId: forked.sessionId } });
        const resumed = canResume
          ? await this.#requestDuringStartup(connection.agent.request(methods.agent.session.resume, {
            ...common, sessionId: forked.sessionId,
          }), deadline, options.signal) : forked;
        return {
          sessionId: forked.sessionId, mode: 'resume',
          configOptions: sessionConfigOptionsFromResponse(resumed),
          currentModeId: resumed.modes?.currentModeId,
          availableModes: resumed.modes?.availableModes.map((mode) => mode.id),
        };
      }
    }

    if (
      priorSessionId !== undefined &&
      this.#capabilities.sessionCapabilities?.resume !== null &&
      this.#capabilities.sessionCapabilities?.resume !== undefined
    ) {
      this.#setOpeningMode('resume');
      try {
        const response = await this.#requestDuringStartup(
          connection.agent.request(methods.agent.session.resume, {
            ...common,
            sessionId: priorSessionId,
          }),
          deadline,
          options.signal,
        );
        return {
          sessionId: priorSessionId,
          mode: 'resume',
          configOptions: sessionConfigOptionsFromResponse(response),
          currentModeId: response.modes?.currentModeId,
          availableModes: response.modes?.availableModes.map((mode) => mode.id),
        };
      } catch (error) {
        if (!isFallbackSessionError(error)) throw error;
      }
    }

    if (priorSessionId !== undefined && this.#capabilities.loadSession === true) {
      this.#setOpeningMode('load');
      try {
        const response = await this.#requestDuringStartup(
          connection.agent.request(methods.agent.session.load, {
            ...common,
            sessionId: priorSessionId,
          }),
          deadline,
          options.signal,
        );
        return {
          sessionId: priorSessionId,
          mode: 'load',
          configOptions: sessionConfigOptionsFromResponse(response),
          currentModeId: response.modes?.currentModeId,
          availableModes: response.modes?.availableModes.map((mode) => mode.id),
        };
      } catch (error) {
        if (!isFallbackSessionError(error)) throw error;
      }
    }

    if (options.requireResume === true) {
      throw new AcpClientError(AcpClientErrorCode.SessionOpenFailed, 'The requested external session cannot be resumed or loaded', {
        details: {
          resumeSupported: this.#capabilities.sessionCapabilities?.resume !== undefined && this.#capabilities.sessionCapabilities.resume !== null,
          loadSupported: this.#capabilities.loadSession === true,
        },
      });
    }
    this.#setOpeningMode('new');
    const newSessionRequest: NewSessionRequest = options.systemPromptOverride === undefined ? common : {
      ...common,
      _meta: { ...options.sessionMeta, systemPromptOverride: options.systemPromptOverride },
    };
    const response = await this.#requestDuringStartup(
      connection.agent.request(methods.agent.session.new, newSessionRequest),
      deadline,
      options.signal,
    );
    return {
      sessionId: response.sessionId,
      mode: 'new',
      configOptions: sessionConfigOptionsFromResponse(response),
      currentModeId: response.modes?.currentModeId,
      availableModes: response.modes?.availableModes.map((mode) => mode.id),
    };
  }

  #additionalDirectoriesForSession(
    additionalDirectories: readonly string[] | undefined,
  ): string[] | undefined {
    if (additionalDirectories === undefined || additionalDirectories.length === 0) {
      return undefined;
    }
    if (
      this.#capabilities.sessionCapabilities?.additionalDirectories !== null
      && this.#capabilities.sessionCapabilities?.additionalDirectories !== undefined
    ) {
      return [...additionalDirectories];
    }
    this.#options.logger?.debug?.(
      'ACP agent does not declare additionalDirectories support; omitting additional directories',
      { count: additionalDirectories.length },
    );
    return undefined;
  }

  async #reserveEventFrame(line: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      message = value as Record<string, unknown>;
    } catch {
      return;
    }
    const method = message['method'];
    if (typeof method !== 'string' || !this.#isEventMethod(method)) return;
    const active = this.#activeTurn;
    if (active === undefined || (this.#state === 'opening_session' && this.#openingMode === 'load')) return;
    const reservation = await active.queue.reserve();
    this.#pendingEventReservations.push({ active, reservation });
  }

  #isEventMethod(method: string): boolean {
    return method === methods.client.session.update ||
      method === UNKNOWN_UPDATE_METHOD ||
      this.#descriptor.id === 'grok-acp' &&
        (method === '_x.ai/session_notification' || method === '_x.ai/session/update');
  }

  #handleSessionUpdate(params: unknown, method = 'session/update'): void {
    const pending = this.#pendingEventReservations.shift();
    try {
      const mapped = mapAcpSessionNotification(params, method);
      if (mapped.event.type === 'mode.update' && mapped.sessionId === this.#openResult?.sessionId) {
        this.#observedModeId = mapped.event.currentModeId;
        this.#modeWaiter?.(mapped.event.currentModeId);
      }
      if (this.#state === 'opening_session' && this.#openingMode === 'load') {
        pending?.reservation.release();
        this.#loadReplayCount += 1;
        return;
      }
      const active = pending?.active ?? this.#activeTurn;
      if (
        active !== undefined &&
        (pending?.active === active || active === this.#activeTurn) &&
        mapped.sessionId === this.#openResult?.sessionId
      ) {
        if (pending?.active === active) pending.reservation.commit(mapped.event);
        else active.queue.push(mapped.event);
        return;
      }
      pending?.reservation.release();
    } catch (error) {
      pending?.reservation.release();
      const protocolError =
        error instanceof AcpProtocolError
          ? error
          : new AcpProtocolError('Invalid ACP session/update notification', {
              cause: error,
            });
      this.#protocolFailure = protocolError;
      this.#connection?.close(protocolError);
    }
  }

  #releasePendingEventReservations(active?: ActiveTurn): void {
    for (let index = this.#pendingEventReservations.length - 1; index >= 0; index -= 1) {
      const pending = this.#pendingEventReservations[index];
      if (active !== undefined && pending?.active !== active) continue;
      pending?.reservation.release();
      this.#pendingEventReservations.splice(index, 1);
    }
  }

  async #requestDuringStartup<T>(
    promise: Promise<T>,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await this.#withStartupDeadline(promise, deadline, signal);
    } catch (error) {
      if (this.#protocolFailure !== undefined) throw this.#protocolFailure;
      throw error;
    }
  }

  async #withStartupDeadline<T>(
    promise: Promise<T>,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AcpClientError(
        AcpClientErrorCode.StartupTimeout,
        'ACP startup timed out',
      );
    }
    let timer: NodeJS.Timeout | undefined;
    let removeAbort: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new AcpClientError(
            AcpClientErrorCode.StartupTimeout,
            'ACP startup timed out',
          ),
        );
      }, remaining);
    });
    const aborted =
      signal === undefined
        ? undefined
        : new Promise<never>((_, reject) => {
            const onAbort = (): void => {
              reject(
                new AcpClientError(
                  AcpClientErrorCode.Cancelled,
                  'ACP startup was cancelled',
                  { cause: abortReason(signal) },
                ),
              );
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
            removeAbort = () => {
              signal.removeEventListener('abort', onAbort);
            };
          });
    try {
      return await Promise.race(
        aborted === undefined ? [promise, timeout] : [promise, timeout, aborted],
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbort?.();
    }
  }

  #observeProcess(child: HostProcessLike): void {
    void child.wait().then(
      (exitCode) => {
        if (this.#process !== child) return;
        this.#process = undefined;
        if (this.#intentionalExit.has(child) || this.#state === 'closing') return;
        this.#exitedProcesses.add(child);
        if (exitCode === 0) return;
        this.#connection?.close(
          new AcpClientError(
            AcpClientErrorCode.Disconnected,
            `ACP agent exited with code ${String(exitCode)}`,
          ),
        );
        if (this.#state === 'ready' || this.#state === 'cold') this.#setState('cold');
        else if (this.#state !== 'closed') this.#setState('broken');
      },
      (error) => {
        if (this.#process !== child) return;
        this.#options.logger?.error?.('Failed while waiting for ACP process', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (this.#state !== 'closing' && this.#state !== 'closed') {
          this.#setState('broken');
        }
      },
    );
  }

  #observeConnection(connection: ClientConnection): void {
    void connection.closed.then(() => {
      void this.#disposeExitedProcesses();
      if (this.#connection !== connection) return;
      this.#connection = undefined;
      if (this.#state === 'closing' || this.#state === 'closed') return;
      if (this.#state === 'ready' || this.#state === 'cold') {
        this.#setState('cold');
      } else {
        this.#setState('broken');
      }
    });
  }

  async #disposeExitedProcesses(): Promise<void> {
    const processes = [...this.#exitedProcesses];
    this.#exitedProcesses.clear();
    for (const child of processes) {
      try {
        await child.dispose();
      } catch (error) {
        this.#options.logger?.warn?.('Failed to dispose exited ACP process', {
          pid: child.pid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async #cleanupTransport(closeState: boolean): Promise<void> {
    try {
      this.#connection?.close();
    } finally {
      try {
        await this.#terminateCurrentProcess();
      } finally {
        await this.#disposeExitedProcesses();
        this.#releasePendingEventReservations();
        this.#connection = undefined;
        this.#process = undefined;
        if (closeState) this.#setState('closed');
      }
    }
  }

  async #terminateCurrentProcess(): Promise<void> {
    const child = this.#process;
    if (child === undefined) return;
    try {
      await this.#terminateProcess(child);
    } finally {
      if (this.#process === child) this.#process = undefined;
    }
  }

  async #terminateProcess(child: HostProcessLike): Promise<void> {
    this.#intentionalExit.add(child);
    try {
      if (child.exitCode !== null) return;
      const grace = this.#descriptor.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
      await this.#sendTermination(child, false);
      const exited = await Promise.race([
        child.wait().then(() => true, () => true),
        delay(grace).then(() => false),
      ]);
      if (!exited) {
        await this.#sendTermination(child, true);
        await child.wait().catch(() => undefined);
      }
    } finally {
      await child.dispose();
    }
  }

  async #sendTermination(child: HostProcessLike, force: boolean): Promise<void> {
    try {
      if (this.#platform === 'win32') {
        const args = ['/PID', String(child.pid), '/T'];
        if (force) args.push('/F');
        const taskkill = await this.#processService.spawn('taskkill', args, {
          shell: false,
          windowsHide: true,
          mergeStderr: false,
        });
        await taskkill.wait();
        await taskkill.dispose();
      } else {
        await child.kill(force ? 'SIGKILL' : 'SIGTERM');
      }
    } catch (error) {
      this.#options.logger?.warn?.('Failed to terminate ACP process', {
        pid: child.pid,
        force,
        error: error instanceof Error ? error.message : String(error),
      });
      if (force) await child.kill('SIGKILL').catch(() => undefined);
    }
  }

  #disconnectError(message: string, cause?: unknown): AcpClientError {
    if (this.#protocolFailure !== undefined) return this.#protocolFailure;
    return new AcpClientError(AcpClientErrorCode.Disconnected, message, {
      cause,
      details: { stderrTail: this.stderrTail() },
    });
  }

  #decorateError(error: unknown, fallback: AcpClientErrorCode): AcpClientError {
    if (error instanceof AcpClientError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new AcpClientError(error instanceof RequestError && error.code === RequestError.authRequired().code
      ? AcpClientErrorCode.AuthenticationRequired : fallback, message, {
      cause: error,
      details: { stderrTail: this.stderrTail() },
    });
  }

  #setOpeningMode(mode: Exclude<AcpSessionOpenMode, 'live'>): void {
    this.#openingMode = mode;
    this.#setState('opening_session');
  }

  #setState(state: AcpClientState): void {
    this.#state = state;
    try {
      this.#options.onStateChange?.(this.status());
    } catch (error) {
      try {
        this.#options.logger?.error?.('ACP state observer failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {}
    }
  }
}

export function sessionConfigOptionsFromResponse(value: unknown): SessionConfigOption[] {
  const record = objectValue(value);
  const standard = record?.['configOptions'];
  if (Array.isArray(standard) && standard.length > 0) return standard as SessionConfigOption[];
  const meta = objectValue(record?.['_meta']);
  const sessionConfig = objectValue(meta?.['x.ai/sessionConfig']);
  const rawOptions = sessionConfig?.['options'];
  if (!Array.isArray(rawOptions)) return [];
  const options: SessionConfigOption[] = [];
  for (const raw of rawOptions) {
    const item = objectValue(raw);
    if (item === undefined) continue;
    const valueId = item['id'];
    const category = item['category'];
    // Keep unknown vendor categories visible instead of dropping them: the
    // ACP spec allows arbitrary category names, and descriptors can address
    // them through explicit config ids or custom config categories.
    if (typeof valueId !== 'string' || typeof category !== 'string') continue;
    const known = category === 'model' || category === 'mode';
    const optionId = known
      ? (category === 'model' ? 'model' : 'reasoning_effort')
      : category;
    const existing = options.find((candidate) => candidate.id === optionId);
    const choice = {
      value: valueId,
      name: typeof item['label'] === 'string' ? item['label'] : valueId,
      description: typeof item['description'] === 'string' ? item['description'] : undefined,
    };
    if (existing === undefined) {
      options.push({
        id: optionId,
        name: known ? (category === 'model' ? 'Model' : 'Reasoning effort') : category,
        category: known ? (category === 'model' ? 'model' : 'thought_level') : category,
        type: 'select',
        currentValue: item['selected'] === true ? valueId : '',
        options: [choice],
        ...(known ? { _meta: { 'kiki.transport': 'session/set_model' } } : {}),
      });
      continue;
    }
    if (existing.type !== 'select') continue;
    const directOptions = existing.options as Array<typeof choice>;
    directOptions.push(choice);
    if (item['selected'] === true) existing.currentValue = valueId;
  }
  for (const option of options) {
    if (option.type === 'select' && option.currentValue === '') {
      const first = option.options[0];
      if (first !== undefined && 'value' in first) option.currentValue = first.value;
    }
  }
  return grokModelOptions(options, objectValue(record?.['models'])?.['availableModels']);
}

export function grokModelOptions(options: readonly SessionConfigOption[], rawModels: unknown): SessionConfigOption[] {
  const model = options.find((option) => option.category === 'model' && option._meta?.['kiki.transport'] === 'session/set_model');
  if (model === undefined || model.type !== 'select' || !Array.isArray(rawModels)) return [...options];
  const models = rawModels.slice(0, 1024).map(objectValue).filter((value) => value !== undefined);
  const selected = models.find((value) => value['modelId'] === model.currentValue || value['id'] === model.currentValue);
  const meta = objectValue(selected?.['_meta']);
  const result = options.filter((option) => option.category !== 'thought_level').map((option) => option.id === model.id
    ? { ...option, _meta: { ...option._meta, 'kiki.models': rawModels } } : option);
  if (meta?.['supportsReasoningEffort'] === false) return result;
  const rawEfforts = meta?.['reasoningEfforts'];
  if (!Array.isArray(rawEfforts)) return [...result, ...options.filter((option) => option.category === 'thought_level')];
  const choices = rawEfforts.flatMap((value) => {
    const effort = objectValue(value);
    return typeof effort?.['id'] === 'string' ? [{ value: effort['id'], name: typeof effort['label'] === 'string' ? effort['label'] : effort['id'], description: typeof effort['description'] === 'string' ? effort['description'] : undefined }] : [];
  });
  const prior = options.find((option) => option.category === 'thought_level');
  const current = typeof meta?.['reasoningEffort'] === 'string' ? meta['reasoningEffort']
    : typeof prior?.currentValue === 'string' && choices.some((choice) => choice.value === prior.currentValue) ? prior.currentValue : choices[0]?.value;
  if (current === undefined) return result;
  if (!choices.some((choice) => choice.value === current)) choices.unshift({ value: current, name: current, description: undefined });
  return [...result, { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: current,
    options: choices, _meta: { 'kiki.transport': 'session/set_model' } }];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
