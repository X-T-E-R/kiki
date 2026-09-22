import { StringDecoder } from 'node:string_decoder';
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

import { AsyncQueue } from '#/async-queue';
import { AcpClientError, AcpClientErrorCode, AcpProtocolError } from '#/errors';
import {
  mapAcpSessionNotification,
  type NormalizedExecutorEvent,
} from '#/events';
import { parseExecutorSessionRefEnvelope } from '#/session-ref';
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
const MAX_NDJSON_FRAME_BYTES = 1024 * 1024;
const MAX_STDOUT_BUFFER_BYTES = 1024 * 1024;
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
}

class ValidatedNdjsonInput extends Transform {
  readonly #decoder = new StringDecoder('utf8');
  readonly #onProtocolError: (error: AcpProtocolError) => void;
  #buffer = '';

  constructor(onProtocolError: (error: AcpProtocolError) => void) {
    super();
    this.#onProtocolError = onProtocolError;
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      this.#consume(typeof chunk === 'string' ? chunk : this.#decoder.write(chunk));
      callback();
    } catch (error) {
      const protocolError =
        error instanceof AcpProtocolError
          ? error
          : new AcpProtocolError('ACP stdout contained malformed NDJSON', {
              cause: error,
            });
      this.#onProtocolError(protocolError);
      callback(protocolError);
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      this.#consume(this.#decoder.end());
      if (this.#buffer.trim().length > 0) {
        this.#assertFrameSize(this.#buffer);
        this.push(this.#validatedLine(this.#buffer));
      }
      this.#buffer = '';
      callback();
    } catch (error) {
      const protocolError =
        error instanceof AcpProtocolError
          ? error
          : new AcpProtocolError('ACP stdout ended with malformed NDJSON', {
              cause: error,
            });
      this.#onProtocolError(protocolError);
      callback(protocolError);
    }
  }

  #consume(value: string): void {
    let offset = 0;
    let newline = value.indexOf('\n', offset);
    while (newline >= 0) {
      this.#append(value.slice(offset, newline));
      const line = this.#buffer;
      this.#buffer = '';
      this.#assertFrameSize(line);
      this.push(`${this.#validatedLine(line)}\n`);
      offset = newline + 1;
      newline = value.indexOf('\n', offset);
    }
    this.#append(value.slice(offset));
  }

  #append(value: string): void {
    if (
      Buffer.byteLength(this.#buffer, 'utf8') + Buffer.byteLength(value, 'utf8') >
      MAX_STDOUT_BUFFER_BYTES
    ) {
      throw new AcpProtocolError('ACP stdout pending buffer exceeded the protocol limit');
    }
    this.#buffer += value;
  }

  #assertFrameSize(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_NDJSON_FRAME_BYTES) {
      throw new AcpProtocolError('ACP NDJSON frame exceeded the protocol limit');
    }
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
  #connection: ClientConnection | undefined;
  #capabilities: AgentCapabilities = {};
  #openResult: AcpOpenSessionResult | undefined;
  #activeTurn: ActiveTurn | undefined;
  #startupInFlight = false;
  #loadReplayCount = 0;
  #protocolFailure: AcpProtocolError | undefined;

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
          return await this.#startOnce(options, deadline);
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
        await this.#requestDuringStartup(
          connection.agent.request(methods.agent.session.setMode, {
            sessionId: this.#openResult.sessionId,
            modeId: options.modeId,
          }),
          deadline,
          options.signal,
        );
      }
      this.#openResult = { ...this.#openResult, configOptions };
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
      return configOptions.map((candidate) =>
        candidate.id === selection.configId
          ? { ...candidate, currentValue: selection.value } as SessionConfigOption
          : candidate,
      );
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
            prompt: [{ type: 'text', text: request.prompt }],
          },
          { cancellationSignal: requestController.signal },
        );
        const response = await Promise.race([
          prompt,
          connection.closed.then(() => {
            throw this.#disconnectError('ACP connection closed during prompt');
          }),
        ]);
        queue.close();
        if (
          this.#state === 'prompting' &&
          this.#connection === connection &&
          !connection.signal.aborted
        ) {
          this.#setState('ready');
        }
        return { response, session, stderrTail: this.stderrTail() };
      } catch (error) {
        const failure =
          error instanceof AcpClientError
            ? error
            : connection.signal.aborted
              ? this.#disconnectError('ACP connection closed during prompt', error)
              : this.#decorateError(error, AcpClientErrorCode.ProtocolError);
        queue.fail(failure);
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

    const validatedInput = new ValidatedNdjsonInput((error) => {
      this.#protocolFailure = error;
      this.#connection?.close(error);
    });
    child.stdout.pipe(validatedInput);
    const app = client({ name: this.#descriptor.clientName ?? 'kiki-acp-client' });
    app.onNotification(methods.client.session.update, ({ params }) => {
      this.#handleSessionUpdate(params);
    });
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

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(validatedInput),
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
      },
      clientInfo: {
        name: this.#descriptor.clientName ?? 'kiki-acp-client',
        version: '0.0.1',
      },
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
    };
    const priorSessionId =
      options.sessionRef === undefined
        ? undefined
        : sessionIdFromEnvelope(options.sessionRef, this.#descriptor.id);

    if (
      priorSessionId !== undefined &&
      this.#capabilities.sessionCapabilities?.resume != null
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
        };
      } catch (error) {
        if (!isFallbackSessionError(error)) throw error;
      }
    }

    this.#setOpeningMode('new');
    const response = await this.#requestDuringStartup(
      connection.agent.request(methods.agent.session.new, common),
      deadline,
      options.signal,
    );
    return {
      sessionId: response.sessionId,
      mode: 'new',
      configOptions: sessionConfigOptionsFromResponse(response),
    };
  }

  #additionalDirectoriesForSession(
    additionalDirectories: readonly string[] | undefined,
  ): string[] | undefined {
    if (additionalDirectories === undefined || additionalDirectories.length === 0) {
      return undefined;
    }
    if (this.#capabilities.sessionCapabilities?.additionalDirectories != null) {
      return [...additionalDirectories];
    }
    this.#options.logger?.debug?.(
      'ACP agent does not declare additionalDirectories support; omitting additional directories',
      { count: additionalDirectories.length },
    );
    return undefined;
  }

  #handleSessionUpdate(params: unknown): void {
    try {
      const mapped = mapAcpSessionNotification(params);
      if (this.#state === 'opening_session' && this.#openingMode === 'load') {
        this.#loadReplayCount += 1;
        return;
      }
      const active = this.#activeTurn;
      if (
        active !== undefined &&
        mapped.sessionId === this.#openResult?.sessionId
      ) {
        active.queue.push(mapped.event);
      }
    } catch (error) {
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

  async #cleanupTransport(closeState: boolean): Promise<void> {
    try {
      this.#connection?.close();
    } finally {
      try {
        await this.#terminateCurrentProcess();
      } finally {
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
    return new AcpClientError(fallback, message, {
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
  if (Array.isArray(standard)) return standard as SessionConfigOption[];
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
  return options;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
