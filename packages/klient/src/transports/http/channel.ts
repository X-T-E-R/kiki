import type {
  CallOptions,
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
  SessionViewChannel,
} from '../../core/channel.js';
import { HttpSessionViews } from './session-view.js';
import { degradeUnconfirmedTranscriptCatchUp, degradeUnconfirmedTranscriptPage } from './transcript-coverage.js';
import { HttpTerminals } from './terminal.js';
import { HTTP_REQUEST_BODY_LIMIT_BYTES } from './limits.js';
import { readBoundedJsonBody, SESSION_READ_BODY_BYTES } from './bounded-body.js';
import type { TerminalFacade } from '../../core/facade/terminal.js';
import type { HttpRestFacade } from '../../core/facade/http-rest.js';
import { createHttpRestFacade, type HttpRestJsonOptions } from './rest.js';
import { listTerminalsResponseSchema, getTerminalResponseSchema, closeTerminalResponseSchema, createTerminalRequestSchema, promptSubmitReceiptSchema, type PromptSubmission } from '@kiki/protocol';
import { confirmsTranscriptCoverage, TRANSCRIPT_COVERAGE_VERSION } from '@kiki/transcript';
import { sessionCommandContract, type SessionCommandChannel } from '../../contract/session/commands.js';
import { RPCError } from '../../core/errors.js';
import { isValid, ulid } from 'ulid';
import { trimTrailingUndefined } from '../args.js';
import {
  createProcedure,
  decodeJsonFrame,
  encodeJsonFrame,
  scopeKindOf,
  type KlientFrame,
  type KlientProcedure,
} from '../codec.js';
import type { KlientBatchLine } from '../../host.js';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_BATCH_SIZE = 24;
const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';
export const HTTP_TRANSPORT_TIMEOUT_REASON = 'transport.timeout';

/** Safe request context carried by HTTP deadline errors, without query or payload data. */
export interface HttpTimeoutDetails {
  readonly method: string;
  readonly path: string;
  readonly phase: 'headers' | 'body';
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly request_id: string;
}

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data?: T;
  readonly request_id?: string;
  readonly details?: unknown;
  readonly reason?: string;
}

export interface HttpChannelOptions {
  readonly endpoint: string;
  readonly eventsUrl?: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly WebSocket?: typeof WebSocket;
  /** Default deadline for HTTP calls and typed REST domains. */
  readonly timeoutMs?: number;
  /** Reading deadlines are sampled per request; zero means wait until completed or cancelled. */
  readonly readingTimeoutMs?: () => number;
  /** Observes the event socket's lifecycle, for connection diagnostics. */
  readonly onSocketDiagnostic?: (event: HttpSocketDiagnostic) => void;
  /** Coalesce concurrent `call()` requests in the same microtask into `POST /api/klient/batch`. Defaults to `true`. */
  readonly batch?: boolean;
  /** Maximum number of `call()` requests coalesced into one batch HTTP request. Defaults to `24`. */
  readonly maxBatchSize?: number;
  /** Coalescing window in milliseconds; `0` (default) flushes via `queueMicrotask`. */
  readonly batchWindowMs?: number;
}

/**
 * Why the event socket stopped: `server` is a close the client did not ask
 * for (server close, network drop, heartbeat kill); the rest are client
 * decisions.
 */
export type HttpSocketCloseCause = 'server' | 'establish_timeout' | 'fatal_frame' | 'view_restart' | 'stale_heartbeat' | 'connection_rebound';

export type HttpSocketDiagnostic =
  | { readonly kind: 'open'; readonly attempt: number }
  | {
    readonly kind: 'close';
    readonly cause: HttpSocketCloseCause;
    readonly code?: number;
    readonly reason?: string;
    readonly wasClean?: boolean;
    readonly openForMs?: number;
    readonly sinceInboundMs?: number;
    readonly heartbeatMs?: number;
  }
  | { readonly kind: 'retry'; readonly attempt: number; readonly delayMs: number };

interface ActiveCall {
  readonly controller: AbortController;
}

interface QueuedBatchCall {
  readonly id: string;
  readonly procedure: KlientProcedure;
  readonly params: unknown[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly connection: Pick<HttpChannelOptions, 'endpoint' | 'token'>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
  abortCleanup?: () => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

interface ActiveListen {
  readonly frame: KlientFrame;
  readonly handler: (data: unknown) => void;
  readonly onError?: (error: Error, terminal?: boolean) => void;
  readonly onReady?: () => void;
}

interface PendingStream {
  frame: KlientFrame;
  sent: boolean;
  push(chunk: unknown): void;
  end(): void;
  error(error: Error): void;
}

type SocketState = 'idle' | 'connecting' | 'open' | 'closed';

export class HttpChannel implements KlientChannel {
  private connection: Pick<HttpChannelOptions, 'endpoint' | 'token'>;
  private suspended = false;
  private readonly fixedEventsUrl: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly readingTimeoutMs: () => number;
  private readonly socket: HttpEventSocket;
  private readonly activeCalls = new Set<ActiveCall>();
  private readonly batchEnabled: boolean;
  private readonly maxBatchSize: number;
  private readonly batchWindowMs: number;
  private batchSupported = true;
  private batchCallSeq = 0;
  private readonly batchQueue: QueuedBatchCall[] = [];
  private batchFlushScheduled = false;
  private batchFlushTimer: ReturnType<typeof setTimeout> | undefined;
  readonly rest: HttpRestFacade;
  private closed = false;

  readonly terminal: TerminalFacade = {
    listTerminals: async (sessionId) => listTerminalsResponseSchema.parse(await this.viewRequest(this.terminalPath(sessionId), {})),
    createTerminal: async (sessionId, body = {}) => getTerminalResponseSchema.parse(await this.viewRequest(this.terminalPath(sessionId), {}, { method: 'POST', body: createTerminalRequestSchema.parse(body), okCodes: [0] })),
    getTerminal: async (sessionId, terminalId) => getTerminalResponseSchema.parse(await this.viewRequest(this.terminalPath(sessionId, terminalId), {})),
    closeTerminal: async (sessionId, terminalId) => closeTerminalResponseSchema.parse(await this.viewRequest(`${this.terminalPath(sessionId, terminalId)}:close`, {}, { method: 'POST', body: {}, okCodes: [0] })),
    terminalAttach: (sessionId, terminalId) => this.socket.terminals.terminalAttach(sessionId, terminalId),
    terminalDetach: (sessionId, terminalId) => this.socket.terminals.terminalDetach(sessionId, terminalId),
    terminalInput: (sessionId, terminalId, data) => this.socket.terminals.terminalInput(sessionId, terminalId, data),
    terminalResize: (sessionId, terminalId, cols, rows) => this.socket.terminals.terminalResize(sessionId, terminalId, cols, rows),
    onTerminalSignal: (listener) => this.socket.terminals.onTerminalSignal(listener),
    onStatus: (listener) => this.socket.terminals.onStatus(listener),
    nudge: () => this.socket.terminals.nudge(),
  };

  private terminalPath(sessionId: string, terminalId?: string): string {
    return `/api/sessions/${encodeURIComponent(sessionId)}/terminals${terminalId === undefined ? '' : `/${encodeURIComponent(terminalId)}`}`;
  }

  readonly sessionView: SessionViewChannel = {
    snapshot: (sessionId, options) => this.viewRequest(`/api/klient/session-view/${encodeURIComponent(sessionId)}/snapshot`, {}, { signal: options?.signal, timeoutMs: options?.timeoutMs }),
    transcriptPage: (sessionId, input, options) => this.transcriptRequest('page', `/api/klient/session-view/${encodeURIComponent(sessionId)}/transcript`, {
      agent_id: input.agentId, before_turn: input.beforeTurn, before_item: input.beforeItem, after_turn: input.afterTurn, after_item: input.afterItem, page_size: input.pageSize,
    }, options),
    transcriptCatchUp: (sessionId, input, options) => this.transcriptRequest('catchUp', `/api/klient/session-view/${encodeURIComponent(sessionId)}/transcript/catch-up`, {
      agent_id: input.agentId, epoch: input.since.epoch, since_seq: input.since.seq, grade: input.grade ?? 'delta',
    }, options),
    transcriptDetail: (sessionId, input, options) => this.viewRequest(
      `/api/sessions/${encodeURIComponent(sessionId)}/transcript/detail`,
      { agent_id: input.agentId, kind: input.kind, id: input.id, turn_id: input.turnId },
      { signal: options?.signal, timeoutMs: options?.timeoutMs },
    ),
    transcriptEntities: (sessionId, input, options) => this.viewRequest(
      `/api/sessions/${encodeURIComponent(sessionId)}/transcript/details`,
      { agent_id: input.agentId, kind: input.kind, cursor: input.cursor, limit: input.limit },
      { signal: options?.signal, timeoutMs: options?.timeoutMs },
    ),
    transcriptContent: (sessionId, input, options) => this.viewRequest(
      `/api/klient/session-view/${encodeURIComponent(sessionId)}/transcript/content`, {},
      { method: 'POST', body: input, signal: options?.signal, timeoutMs: options?.timeoutMs },
    ),
    userMessages: (sessionId, input, options) => this.viewRequest(
      `/api/sessions/${encodeURIComponent(sessionId)}/transcript/user-messages`,
      { agent_id: input.agentId, cursor: input.cursor },
      { signal: options?.signal, timeoutMs: options?.timeoutMs },
    ),
    plans: (sessionId, input, options) => this.viewRequest(
      `/api/sessions/${encodeURIComponent(sessionId)}/transcript/plan`,
      { agent_id: input.agentId, tool_call_id: input.toolCallId, cursor: input.cursor },
      { signal: options?.signal, timeoutMs: options?.timeoutMs },
    ),
    subagents: (sessionId, input, options) => this.viewRequest(
      `/api/sessions/${encodeURIComponent(sessionId)}/subagents`,
      { q: input.q, status: input.status, agent_id: input.agentId, limit: input.limit },
      { signal: options?.signal, timeoutMs: options?.timeoutMs },
    ),
    subscribe: (sessionId, input, handler) => {
      if (this.closed) throw new Error('http closed');
      return this.socket.sessionViews.subscribe(sessionId, input, handler);
    },
  };

  readonly sessionCommands: SessionCommandChannel = {
    execute: async (sessionId, command, input, options) => {
      const spec = sessionCommandContract[command];
      const value = input as {
        target?: string;
        body?: unknown;
        query?: { agent_id?: string; queued_only?: 'true' };
      };
      const suffix = spec.suffix.replace('{target}', encodeURIComponent(value.target ?? ''));
      const result = await this.viewRequest(
        `/api/sessions/${encodeURIComponent(sessionId)}${suffix}`,
        { ...value.query, agent_id: value.query?.agent_id, receipt: command === 'submit' ? 'true' : undefined },
        {
          method: spec.method,
          body: spec.method === 'GET' ? undefined : value.body ?? {},
          okCodes: spec.okCodes,
          timeoutMs: options?.timeoutMs ?? ('timeoutMs' in spec ? spec.timeoutMs : undefined),
          signal: options?.signal,
        },
      );
      if (command === 'submit' && result !== null && typeof result === 'object' && !('content' in result)) {
        const { resolved_media, resolved_parts, ...receipt } = promptSubmitReceiptSchema.parse(result);
        const submitted = (value.body as PromptSubmission).content;
        const replacements = new Map<number, PromptSubmission['content']>();
        const projections = resolved_parts ?? resolved_media?.map(({ index, content }) => ({ index, content: [content] })) ?? [];
        for (const projection of projections) {
          if (projection.index >= submitted.length || submitted[projection.index]?.type === 'text' || replacements.has(projection.index)) {
            throw new RPCError(50001, 'Invalid prompt receipt media projection');
          }
          replacements.set(projection.index, projection.content);
        }
        const content = submitted.flatMap((part, index) => replacements.get(index) ?? [part]);
        return { ...receipt, content };
      }
      return result;
    },
  };

  private viewRequest(
    path: string,
    query: Record<string, string | number | undefined>,
    options?: {
      readonly method?: 'GET' | 'POST';
      readonly body?: unknown;
      readonly okCodes?: readonly number[];
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<unknown> {
    return this.requestJson(path, { ...options, query });
  }

  private async transcriptRequest(kind: 'page' | 'catchUp', path: string, query: Record<string, string | number | undefined>, options?: CallOptions): Promise<unknown> {
    const data = await this.viewRequest(path, { ...query, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION }, { signal: options?.signal, timeoutMs: options?.timeoutMs });
    if (confirmsTranscriptCoverage(data)) return data;
    return kind === 'page' ? degradeUnconfirmedTranscriptPage(data) : degradeUnconfirmedTranscriptCatchUp(data);
  }

  private requestJson<T>(path: string, options: HttpRestJsonOptions = {}): Promise<T> {
    const reading = /\/klient\/session-view\//.test(path)
      || /\/transcript(?:\/(?:detail|details|ops|user-messages|plan))?$/.test(path)
      || /\/sessions\/[^/]+\/subagents$/.test(path);
    const callOptions = reading ? { ...options, timeoutMs: options.timeoutMs ?? this.readingTimeoutMs() } : options;
    return this.performFetch(path, callOptions, async (response, acceptRequestId, signal) => {
      if (response.status === 404 && options.allowMissingRoute === true) {
        await response.body?.cancel();
        return undefined as T;
      }
      const envelope = await this.readEnvelope(response, signal, reading ? SESSION_READ_BODY_BYTES : 4 * 1024 * 1024);
      acceptRequestId(envelope.request_id);
      const okCodes = options.okCodes ?? [0];
      if (response.ok === false || !okCodes.includes(envelope.code)) {
        throw new RPCError(
          okCodes.includes(envelope.code) ? response.status : envelope.code,
          envelope.msg,
          envelope.details,
          envelope.reason,
          envelope.request_id,
          envelope.data,
        );
      }
      return envelope.data as T;
    });
  }

  private requestRaw<T>(
    path: string,
    options: HttpRestJsonOptions | undefined,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const requestOptions = options ?? {};
    return this.performFetch(path, requestOptions, async (response, acceptRequestId, signal) => {
      const contentType = response.headers.get('content-type') ?? '';
      if ((response.ok || (response.status === 304 && requestOptions.headers?.['if-none-match'] !== undefined)) &&
          !(requestOptions.jsonErrorOnSuccess === true && contentType.includes('json'))) {
        return consume(response);
      }
      const envelope = await this.readEnvelope(response, signal);
      acceptRequestId(envelope.request_id);
      const okCodes = requestOptions.okCodes ?? [0];
      throw new RPCError(
        okCodes.includes(envelope.code) ? response.status : envelope.code,
        envelope.msg,
        envelope.details,
        envelope.reason,
        envelope.request_id,
        envelope.data,
      );
    });
  }

  private async performFetch<T>(
    path: string,
    options: HttpRestJsonOptions,
    consume: (response: Response, acceptRequestId: (value: string | undefined) => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error('http closed');
    if (this.suspended) throw new RPCError(-1, 'Connection blocked pending identity verification', undefined, 'transport.connection_blocked', undefined, undefined, 'transport');
    const connection = this.connection;
    const ensureCurrent = () => {
      if (connection !== this.connection) throw new RPCError(-1, 'Connection changed while the request was pending', undefined, 'transport.connection_changed', undefined, undefined, 'transport');
    };
    const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const bodySize = typeof body === 'string'
      ? new TextEncoder().encode(body).byteLength
      : body instanceof Uint8Array
        ? body.byteLength
        : undefined;
    if (bodySize !== undefined && bodySize > HTTP_REQUEST_BODY_LIMIT_BYTES) {
      throw new RPCError(40001, 'request body exceeds the allowed size limit');
    }
    const controller = new AbortController();
    const activeCall = { controller };
    this.activeCalls.add(activeCall);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const startedAt = performance.now();
    let phase: HttpTimeoutDetails['phase'] = 'headers';
    let timedOutPhase: HttpTimeoutDetails['phase'] | undefined;
    const timer = timeoutMs === 0
      ? undefined
      : setTimeout(() => {
          if (controller.signal.aborted) return;
          timedOutPhase = phase;
          controller.abort();
        }, timeoutMs);
    const sourceSignal = options.signal;
    const abort = (): void => {
      controller.abort(sourceSignal?.reason);
    };
    if (sourceSignal?.aborted === true) abort();
    else sourceSignal?.addEventListener('abort', abort, { once: true });
    try {
      const baseUrl = options.baseUrl ?? connection.endpoint;
      const root = baseUrl.replace(/\/+$/u, '');
      const route = path.startsWith('/api/') ? path : `/api${path}`;
      const locationOrigin = (globalThis as { readonly location?: { readonly origin?: string } }).location?.origin;
      const url = root === ''
        ? new URL(route, locationOrigin ?? 'http://localhost')
        : new URL(`${root}${route}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, item);
        } else if (value !== undefined) url.searchParams.set(key, String(value));
      }
      const headers = new Headers({
        accept: options.expectBinary === true ? 'application/octet-stream' : 'application/json',
        ...options.headers,
      });
      const suppliedRequestId = headers.get('x-request-id');
      let requestId = suppliedRequestId !== null && isValid(suppliedRequestId) ? suppliedRequestId : ulid();
      headers.set('x-request-id', requestId);
      if (connection.token !== undefined && options.skipAuth !== true) headers.set('authorization', `Bearer ${connection.token}`);
      if (options.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
      const acceptRequestId = (value: string | undefined | null): void => {
        if (typeof value === 'string' && isValid(value)) requestId = value;
      };
      const timeoutError = (): RPCError => this.transportTimeoutError({
        method: options.method ?? 'GET',
        path: url.pathname,
        phase: timedOutPhase ?? phase,
        timeoutMs,
        elapsedMs: Math.round(performance.now() - startedAt),
        request_id: requestId,
      });
      let response: Response;
      const method = options.method ?? 'GET';
      const input = path === '/api/klient/call' ? url.toString() : url;
      const sendOnce = () => this.fetchImpl(input, {
        method,
        body: body as never,
        headers: Object.fromEntries(headers),
        signal: controller.signal,
        redirect: 'error',
      });
      try {
        try {
          response = await sendOnce();
        } catch (firstError) {
          const canRetryGet =
            method === 'GET'
            && timedOutPhase === undefined
            && !this.closed
            && !this.suspended
            && connection === this.connection
            && sourceSignal?.aborted !== true
            && !controller.signal.aborted
            && !(firstError instanceof RPCError)
            && firstError instanceof Error
            && /(?:econnreset|epipe|socket hang up|fetch failed|premature close|und_err_socket|networkerror)/i.test(firstError.message);
          if (!canRetryGet) throw firstError;
          await abortableSleep(120 + Math.floor(Math.random() * 130), controller.signal);
          ensureCurrent();
          response = await sendOnce();
        }
      } catch (error) {
        ensureCurrent();
        if (timedOutPhase !== undefined) throw timeoutError();
        if (this.closed && controller.signal.aborted) throw new Error('http closed', { cause: error });
        if (error instanceof RPCError) throw error;
        throw new RPCError(-1, error instanceof Error ? error.message : 'Connection failed', undefined, 'transport.network', undefined, undefined, 'transport');
      }
      if (connection !== this.connection) {
        void response.body?.cancel();
        ensureCurrent();
      }
      acceptRequestId(response.headers.get('x-request-id'));
      phase = 'body';
      if (timedOutPhase !== undefined) throw timeoutError();
      try {
        const result = await consume(response, acceptRequestId, controller.signal);
        ensureCurrent();
        if (timedOutPhase !== undefined) throw timeoutError();
        return result;
      } catch (error) {
        ensureCurrent();
        if (timedOutPhase !== undefined) throw timeoutError();
        if (this.closed && controller.signal.aborted) throw new Error('http closed', { cause: error });
        if (error instanceof TypeError && !controller.signal.aborted) {
          throw new RPCError(-1, error.message, undefined, 'transport.network', undefined, undefined, 'transport');
        }
        throw error;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      sourceSignal?.removeEventListener('abort', abort);
      this.activeCalls.delete(activeCall);
    }
  }

  private transportTimeoutError(details: HttpTimeoutDetails): RPCError {
    return new RPCError(
      50001,
      `call timed out after ${details.timeoutMs}ms`,
      details,
      HTTP_TRANSPORT_TIMEOUT_REASON,
      details.request_id,
      undefined,
      'transport',
    );
  }

  private async readEnvelope(response: Response, signal?: AbortSignal, maxBytes = 4 * 1024 * 1024): Promise<Envelope<unknown>> {
    let envelope: Envelope<unknown> | null;
    try {
      envelope = await readBoundedJsonBody(response, maxBytes, signal) as Envelope<unknown> | null;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted === true || !(error instanceof SyntaxError)) throw error;
      throw new RPCError(response.status, `HTTP ${response.status} — non-JSON response`);
    }
    if (envelope === null || typeof envelope.code !== 'number' || typeof envelope.msg !== 'string') {
      throw new RPCError(response.status, `HTTP ${response.status} — non-JSON response`);
    }
    return envelope;
  }

  constructor(options: HttpChannelOptions) {
    const endpoint = options.endpoint.replace(/\/+$/u, '');
    this.connection = { endpoint, token: options.token };
    this.fixedEventsUrl = options.eventsUrl !== undefined;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (fetchImpl === undefined) {
      throw new Error('no fetch implementation available; pass fetch');
    }
    this.fetchImpl = options.fetch ?? fetchImpl.bind(globalThis);
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.readingTimeoutMs = options.readingTimeoutMs ?? (() => 0);
    this.batchEnabled = options.batch !== false;
    this.maxBatchSize = Math.max(1, Math.floor(options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE));
    this.batchWindowMs = Math.max(0, options.batchWindowMs ?? 0);
    this.socket = new HttpEventSocket({
      endpoint,
      eventsUrl: options.eventsUrl,
      token: options.token,
      WebSocket: options.WebSocket,
      onDiagnostic: options.onSocketDiagnostic,
    });
    this.rest = createHttpRestFacade({
      json: (path, restOptions) => this.requestJson(path, restOptions),
      raw: (path, restOptions, consume) => this.requestRaw(path, restOptions, consume),
    });
  }

  call(
    scope: ScopeRef,
    service: string,
    method: string,
    args: unknown[],
    options?: CallOptions,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('http closed'));
    if (this.suspended) {
      return Promise.reject(
        new RPCError(-1, 'Connection blocked pending identity verification', undefined, 'transport.connection_blocked', undefined, undefined, 'transport'),
      );
    }
    const procedure = createProcedure(scope, service, method);
    const params = trimTrailingUndefined(args);
    if (!this.batchEnabled || !this.batchSupported) {
      return this.dispatchSingleCall(procedure, params, options);
    }
    if (options?.signal?.aborted === true) {
      return Promise.reject(options.signal.reason ?? createAbortError());
    }
    const connection = this.connection;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const id = `b${++this.batchCallSeq}`;
    return new Promise<unknown>((resolve, reject) => {
      const item: QueuedBatchCall = {
        id,
        procedure,
        params,
        timeoutMs,
        signal: options?.signal,
        connection,
        resolve,
        reject,
        settled: false,
      };
      if (options?.signal !== undefined) {
        const onQueuedAbort = (): void => {
          if (item.settled) return;
          item.settled = true;
          item.abortCleanup = undefined;
          const idx = this.batchQueue.indexOf(item);
          if (idx !== -1) this.batchQueue.splice(idx, 1);
          reject(options.signal!.reason ?? createAbortError());
        };
        options.signal.addEventListener('abort', onQueuedAbort, { once: true });
        item.abortCleanup = () => { options.signal!.removeEventListener('abort', onQueuedAbort); };
      }
      this.batchQueue.push(item);
      if (this.batchQueue.length >= this.maxBatchSize) {
        this.cancelScheduledBatchFlush();
        this.flushBatchQueue();
        return;
      }
      this.scheduleBatchFlush();
    });
  }

  private dispatchSingleCall(
    procedure: KlientProcedure,
    params: unknown[],
    options?: CallOptions,
  ): Promise<unknown> {
    return this.requestJson('/api/klient/call', {
      method: 'POST',
      body: { procedure, params },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  private scheduleBatchFlush(): void {
    if (this.batchFlushScheduled) return;
    this.batchFlushScheduled = true;
    if (this.batchWindowMs === 0) {
      queueMicrotask(() => {
        if (!this.batchFlushScheduled) return;
        this.batchFlushScheduled = false;
        this.flushBatchQueue();
      });
      return;
    }
    this.batchFlushTimer = setTimeout(() => {
      this.batchFlushTimer = undefined;
      this.batchFlushScheduled = false;
      this.flushBatchQueue();
    }, this.batchWindowMs);
  }

  private cancelScheduledBatchFlush(): void {
    this.batchFlushScheduled = false;
    if (this.batchFlushTimer !== undefined) {
      clearTimeout(this.batchFlushTimer);
      this.batchFlushTimer = undefined;
    }
  }

  private drainQueuedBatch(errorFactory: () => Error): void {
    this.cancelScheduledBatchFlush();
    const drained = this.batchQueue.splice(0);
    for (const item of drained) {
      item.abortCleanup?.();
      item.abortCleanup = undefined;
      if (item.settled) continue;
      item.settled = true;
      item.reject(errorFactory());
    }
  }

  private flushBatchQueue(): void {
    if (this.batchQueue.length === 0) return;
    const rawItems = this.batchQueue.splice(0, this.maxBatchSize);
    if (this.batchQueue.length > 0) this.scheduleBatchFlush();

    const active: QueuedBatchCall[] = [];
    for (const item of rawItems) {
      item.abortCleanup?.();
      item.abortCleanup = undefined;
      if (item.settled) continue;
      if (this.closed) {
        item.settled = true;
        item.reject(new Error('http closed'));
        continue;
      }
      if (item.connection !== this.connection) {
        item.settled = true;
        item.reject(new RPCError(-1, 'Connection changed while the request was pending', undefined, 'transport.connection_changed', undefined, undefined, 'transport'));
        continue;
      }
      if (this.suspended) {
        item.settled = true;
        item.reject(new RPCError(-1, 'Connection blocked pending identity verification', undefined, 'transport.connection_blocked', undefined, undefined, 'transport'));
        continue;
      }
      if (item.signal?.aborted === true) {
        item.settled = true;
        item.reject(item.signal.reason ?? createAbortError());
        continue;
      }
      active.push(item);
    }

    if (active.length === 0) return;
    if (active.length === 1 || !this.batchSupported) {
      for (const item of active) this.forwardToSingleCall(item);
      return;
    }

    const body = JSON.stringify({
      calls: active.map((item) => ({
        id: item.id,
        procedure: item.procedure,
        params: item.params,
      })),
    });
    if (new TextEncoder().encode(body).byteLength > HTTP_REQUEST_BODY_LIMIT_BYTES) {
      for (const item of active) this.forwardToSingleCall(item);
      return;
    }
    void this.dispatchBatch(active, body, active[0]!.connection);
  }

  private forwardToSingleCall(item: QueuedBatchCall): void {
    this.dispatchSingleCall(item.procedure, item.params, {
      timeoutMs: item.timeoutMs,
      signal: item.signal,
    }).then(
      (value) => {
        if (item.settled) return;
        item.settled = true;
        item.resolve(value);
      },
      (error: unknown) => {
        if (item.settled) return;
        item.settled = true;
        item.reject(error);
      },
    );
  }

  private async dispatchBatch(
    items: readonly QueuedBatchCall[],
    body: string,
    connection: Pick<HttpChannelOptions, 'endpoint' | 'token'>,
  ): Promise<void> {
    const batchController = new AbortController();
    const activeCall: ActiveCall = { controller: batchController };
    this.activeCalls.add(activeCall);
    const pending = new Map<string, QueuedBatchCall>();
    const startedAt = performance.now();
    let phase: HttpTimeoutDetails['phase'] = 'headers';
    let requestId = ulid();

    const cleanupItem = (item: QueuedBatchCall): void => {
      if (item.timeoutHandle !== undefined) {
        clearTimeout(item.timeoutHandle);
        item.timeoutHandle = undefined;
      }
      item.abortCleanup?.();
      item.abortCleanup = undefined;
    };

    const maybeAbortBatch = (): void => {
      if (pending.size === 0 && !batchController.signal.aborted) {
        batchController.abort();
      }
    };

    const rejectRemaining = (factory: () => Error): void => {
      for (const item of pending.values()) {
        cleanupItem(item);
        if (item.settled) continue;
        item.settled = true;
        item.reject(factory());
      }
      pending.clear();
    };

    const fallbackToIndividual = (): void => {
      this.batchSupported = false;
      const remaining = [...pending.values()];
      pending.clear();
      for (const item of remaining) {
        cleanupItem(item);
        if (item.settled) continue;
        this.forwardToSingleCall(item);
      }
    };

    for (const item of items) {
      pending.set(item.id, item);
      if (item.signal !== undefined) {
        const onAbort = (): void => {
          if (item.settled) return;
          pending.delete(item.id);
          cleanupItem(item);
          item.settled = true;
          item.reject(item.signal!.reason ?? createAbortError());
          maybeAbortBatch();
        };
        if (item.signal.aborted) {
          onAbort();
          continue;
        }
        item.signal.addEventListener('abort', onAbort, { once: true });
        item.abortCleanup = () => { item.signal!.removeEventListener('abort', onAbort); };
      }
      if (item.timeoutMs > 0) {
        item.timeoutHandle = setTimeout(() => {
          if (item.settled) return;
          pending.delete(item.id);
          cleanupItem(item);
          item.settled = true;
          item.reject(this.transportTimeoutError({
            method: 'POST',
            path: '/api/klient/batch',
            phase,
            timeoutMs: item.timeoutMs,
            elapsedMs: Math.round(performance.now() - startedAt),
            request_id: requestId,
          }));
          maybeAbortBatch();
        }, item.timeoutMs);
      }
    }

    if (pending.size === 0) {
      this.activeCalls.delete(activeCall);
      return;
    }

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const root = connection.endpoint.replace(/\/+$/u, '');
      const locationOrigin = (globalThis as { readonly location?: { readonly origin?: string } }).location?.origin;
      const url = root === ''
        ? new URL('/api/klient/batch', locationOrigin ?? 'http://localhost')
        : new URL(`${root}/api/klient/batch`);
      const headers = new Headers({
        accept: 'application/x-ndjson, application/json',
        'content-type': 'application/json',
        'x-request-id': requestId,
      });
      if (connection.token !== undefined) headers.set('authorization', `Bearer ${connection.token}`);

      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: 'POST',
          body,
          headers: Object.fromEntries(headers),
          signal: batchController.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (
          error instanceof RPCError
          && error.code === 40301
          && connection === this.connection
          && !this.closed
          && !this.suspended
          && pending.size > 0
        ) {
          fallbackToIndividual();
          return;
        }
        if (connection !== this.connection) {
          rejectRemaining(() => new RPCError(-1, 'Connection changed while the request was pending', undefined, 'transport.connection_changed', undefined, undefined, 'transport'));
          return;
        }
        if (this.closed && batchController.signal.aborted) {
          rejectRemaining(() => new Error('http closed', { cause: error }));
          return;
        }
        if (pending.size === 0) return;
        rejectRemaining(() => error instanceof RPCError
          ? error
          : new RPCError(-1, error instanceof Error ? error.message : 'Connection failed', undefined, 'transport.network', undefined, undefined, 'transport'));
        return;
      }

      if (connection !== this.connection) {
        void response.body?.cancel().catch(() => {});
        rejectRemaining(() => new RPCError(-1, 'Connection changed while the request was pending', undefined, 'transport.connection_changed', undefined, undefined, 'transport'));
        return;
      }

      if (response.status === 404 || response.status === 405 || response.status === 501) {
        void response.body?.cancel().catch(() => {});
        fallbackToIndividual();
        return;
      }

      const headerRequestId = response.headers.get('x-request-id');
      if (typeof headerRequestId === 'string' && isValid(headerRequestId)) requestId = headerRequestId;
      phase = 'body';

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!response.ok || (contentType.includes('application/json') && !contentType.includes('ndjson'))) {
        try {
          const envelope = await this.readEnvelope(response, batchController.signal);
          rejectRemaining(() => new RPCError(
            envelope.code === 0 ? response.status : envelope.code,
            envelope.msg,
            envelope.details,
            envelope.reason,
            envelope.request_id ?? requestId,
            envelope.data,
          ));
        } catch (error) {
          if (pending.size === 0) return;
          rejectRemaining(() => error instanceof Error ? error : new RPCError(response.status, `HTTP ${response.status} — batch request failed`));
        }
        return;
      }

      if (response.body === null) {
        rejectRemaining(() => new RPCError(response.status, `HTTP ${response.status} — empty batch stream`));
        return;
      }

      const processLine = (rawLine: string): void => {
        const trimmed = rawLine.trim();
        if (trimmed.length === 0) return;
        let parsed: KlientBatchLine;
        try {
          parsed = JSON.parse(trimmed) as KlientBatchLine;
        } catch {
          return;
        }
        if (parsed === null || typeof parsed !== 'object' || typeof parsed.id !== 'string') return;
        const item = pending.get(parsed.id);
        if (item === undefined || item.settled) return;
        pending.delete(parsed.id);
        cleanupItem(item);
        item.settled = true;
        const envelope = parsed.envelope;
        if (envelope === null || typeof envelope !== 'object' || typeof envelope.code !== 'number' || typeof envelope.msg !== 'string') {
          item.reject(new RPCError(response.status, 'Invalid batch response envelope'));
          return;
        }
        if (envelope.code !== 0) {
          item.reject(new RPCError(
            envelope.code,
            envelope.msg,
            envelope.details,
            envelope.reason,
            envelope.request_id ?? requestId,
            envelope.data,
          ));
          return;
        }
        item.resolve(envelope.data);
      };

      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffered = '';
      for (;;) {
        const chunk = await reader.read();
        if (connection !== this.connection) {
          void reader.cancel().catch(() => {});
          rejectRemaining(() => new RPCError(-1, 'Connection changed while the request was pending', undefined, 'transport.connection_changed', undefined, undefined, 'transport'));
          return;
        }
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        let newlineIndex = buffered.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffered.slice(0, newlineIndex);
          buffered = buffered.slice(newlineIndex + 1);
          processLine(line);
          newlineIndex = buffered.indexOf('\n');
        }
      }
      buffered += decoder.decode();
      if (buffered.length > 0) processLine(buffered);

      if (pending.size > 0) {
        if (connection !== this.connection) {
          rejectRemaining(() => new RPCError(-1, 'Connection changed while the request was pending', undefined, 'transport.connection_changed', undefined, undefined, 'transport'));
        } else if (this.closed) {
          rejectRemaining(() => new Error('http closed'));
        } else {
          rejectRemaining(() => new RPCError(-1, 'Batch stream ended before call completed', undefined, 'transport.network', requestId, undefined, 'transport'));
        }
      }
    } catch (error) {
      if (connection !== this.connection) {
        rejectRemaining(() => new RPCError(-1, 'Connection changed while the request was pending', undefined, 'transport.connection_changed', undefined, undefined, 'transport'));
      } else if (this.closed && batchController.signal.aborted) {
        rejectRemaining(() => new Error('http closed', { cause: error }));
      } else if (pending.size > 0) {
        rejectRemaining(() => error instanceof RPCError
          ? error
          : new RPCError(-1, error instanceof Error ? error.message : 'Batch stream failed', undefined, 'transport.network', requestId, undefined, 'transport'));
      }
    } finally {
      reader?.releaseLock();
      for (const item of pending.values()) cleanupItem(item);
      this.activeCalls.delete(activeCall);
    }
  }

  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown> {
    if (this.closed) return failedStream(new Error('http closed'));
    if (this.suspended) return failedStream(new RPCError(-1, 'Connection blocked pending identity verification', undefined, 'transport.connection_blocked', undefined, undefined, 'transport'));
    return this.socket.stream(scope, service, method, args);
  }

  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error, terminal?: boolean) => void,
    onReady?: () => void,
  ): IDisposable {
    if (this.closed) throw new Error('http closed');
    return this.socket.listen(scope, source, handler, onError, onReady);
  }

  /** Capture before a compound action starts, then check before dispatch after every await. */
  captureOperation(): () => void {
    const connection = this.connection;
    return () => {
      if (connection !== this.connection) throw new RPCError(-1, 'Connection changed while the operation was pending', undefined, 'transport.connection_changed', undefined, undefined, 'transport');
      if (this.closed) throw new Error('http closed');
      if (this.suspended) throw new RPCError(-1, 'Connection blocked pending identity verification', undefined, 'transport.connection_blocked', undefined, undefined, 'transport');
    };
  }

  /** Park an identity-refused binding without discarding retained facade or view identities. */
  suspend(): void {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    this.connection = { ...this.connection };
    this.drainQueuedBatch(() => new RPCError(-1, 'Connection changed while the operation was pending', undefined, 'transport.connection_changed', undefined, undefined, 'transport'));
    for (const call of this.activeCalls) call.controller.abort();
    this.socket.suspend();
  }

  /** Rebind only after the owner verifies the destination's identity. Never replays HTTP calls. */
  rebind(connection: Pick<HttpChannelOptions, 'endpoint' | 'token'>): void {
    if (this.closed) throw new Error('http closed');
    if (this.fixedEventsUrl) throw new Error('A fixed event transport cannot be rebound');
    const endpoint = connection.endpoint.replace(/\/+$/u, '');
    const wsUrl = toWebSocketUrl(endpoint);
    this.connection = { endpoint, token: connection.token };
    this.suspended = false;
    this.batchSupported = true;
    this.drainQueuedBatch(() => new RPCError(-1, 'Connection changed while the request was pending', undefined, 'transport.connection_changed', undefined, undefined, 'transport'));
    for (const call of this.activeCalls) call.controller.abort();
    this.socket.rebind(wsUrl, connection.token);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.drainQueuedBatch(() => new Error('http closed'));
    for (const call of this.activeCalls) call.controller.abort();
    this.activeCalls.clear();
    this.socket.close();
    return Promise.resolve();
  }
}

class HttpEventSocket {
  private wsUrl: string;
  private token: string | undefined;
  private readonly WebSocketCtor: typeof WebSocket | undefined;
  private readonly listens = new Map<string, ActiveListen>();
  private readonly streams = new Map<string, PendingStream>();
  private ws: WebSocket | undefined;
  private socketGeneration = 0;
  private state: SocketState = 'idle';
  private closed = false;
  private suspended = false;
  private reconnectAttempt = 0;
  private fatalRetriesLeft: number | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private establishmentTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private probeSentAt = 0;
  private lastInboundAt = 0;
  private openedAt = 0;
  private connectStartedAt = 0;
  private heartbeatMs: number | undefined;
  private seq = 0;
  private readonly onDiagnostic: ((event: HttpSocketDiagnostic) => void) | undefined;
  readonly terminals = new HttpTerminals({
    nextId: () => this.nextId(),
    connect: () => { this.requireWebSocket(); this.ensureConnected(); },
    isOpen: () => this.state === 'open',
    send: (frame) => this.send(frame),
    nudge: () => this.nudge(),
  });
  private readonly idPrefix = `h${Date.now().toString(36)}`;
  readonly sessionViews = new HttpSessionViews({
    nextId: () => this.nextId(),
    connect: () => { this.requireWebSocket(); this.ensureConnected(); },
    isOpen: () => this.state === 'open',
    send: (frame) => { this.send(frame); },
    restart: () => { this.restart('view_restart'); },
    nudge: () => { this.nudge(); },
  });

  rebind(wsUrl: string, token: string | undefined): void {
    this.wsUrl = wsUrl;
    this.token = token;
    this.fatalRetriesLeft = undefined;
    this.reconnectAttempt = 0;
    this.suspended = false;
    this.restart('connection_rebound');
  }

  suspend(): void {
    this.suspended = true;
    this.restart();
  }

  private clearLivenessTimers(): void {
    if (this.watchdogTimer !== undefined) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    if (this.probeTimer !== undefined) {
      clearTimeout(this.probeTimer);
      this.probeTimer = undefined;
    }
    this.probeSentAt = 0;
  }

  private armWatchdog(): void {
    if (this.watchdogTimer !== undefined) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    if (this.closed || this.state !== 'open' || this.heartbeatMs === undefined) return;
    const generation = this.socketGeneration;
    const silenceBudgetMs = Math.max(15_000, Math.round(this.heartbeatMs * 1.5));
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = undefined;
      if (this.closed || this.state !== 'open' || generation !== this.socketGeneration) return;
      this.sendLivenessProbe(4_000);
    }, silenceBudgetMs);
  }

  private sendLivenessProbe(ackDeadlineMs: number): void {
    if (this.closed || this.state !== 'open' || this.ws === undefined) return;
    if (this.probeTimer !== undefined) return;
    const generation = this.socketGeneration;
    const sentAt = Date.now();
    this.probeSentAt = sentAt;
    this.send({ type: 'ping', data: { nonce: `c_${sentAt}` } });
    this.probeTimer = setTimeout(() => {
      this.probeTimer = undefined;
      if (this.closed || this.state !== 'open' || generation !== this.socketGeneration) return;
      if (this.lastInboundAt >= sentAt) {
        this.probeSentAt = 0;
        this.armWatchdog();
        return;
      }
      this.probeSentAt = 0;
      this.restart('stale_heartbeat');
    }, ackDeadlineMs);
  }

  private restart(cause: HttpSocketCloseCause = 'view_restart'): void {
    if (this.closed) return;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearLivenessTimers();
    this.socketGeneration += 1;
    const ws = this.ws;
    this.ws = undefined;
    this.state = 'idle';
    if (ws !== undefined) this.reportClose(cause);
    ws?.close(4000, 'session view restart');
    const error = new Error('http event socket restarted');
    for (const stream of this.streams.values()) stream.error(error);
    this.streams.clear();
    this.notifyDisconnect(error);
    this.sessionViews.connecting();
    this.ensureConnected();
  }

  private nudge(): void {
    if (this.closed) return;
    if (this.state === 'open') {
      this.sendLivenessProbe(5_000);
      return;
    }
    if (this.ws !== undefined) {
      if (this.connectStartedAt > 0 && Date.now() - this.connectStartedAt >= 1_000) {
        this.socketGeneration += 1;
        const ws = this.ws;
        this.ws = undefined;
        clearTimeout(this.establishmentTimer);
        this.reportClose('establish_timeout');
        ws.close(4000, 'WebSocket establishment nudged');
      } else {
        return;
      }
    }
    this.fatalRetriesLeft = undefined;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.state = 'idle';
    this.sessionViews.connecting();
    this.terminals.connecting();
    this.ensureConnected();
  }

  constructor(options: {
    endpoint: string;
    eventsUrl?: string;
    token?: string;
    WebSocket?: typeof WebSocket;
    onDiagnostic?: (event: HttpSocketDiagnostic) => void;
  }) {
    this.wsUrl = options.eventsUrl ?? toWebSocketUrl(options.endpoint);
    this.token = options.token;
    this.WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
    this.onDiagnostic = options.onDiagnostic;
  }

  private diagnose(event: HttpSocketDiagnostic): void {
    if (this.onDiagnostic === undefined) return;
    try {
      this.onDiagnostic(event);
    } catch {
    }
  }

  private reportClose(cause: HttpSocketCloseCause, event?: { code?: number; reason?: string; wasClean?: boolean }): void {
    const now = Date.now();
    this.diagnose({
      kind: 'close',
      cause,
      code: event?.code,
      reason: event?.reason === '' ? undefined : event?.reason,
      wasClean: event?.wasClean,
      openForMs: this.openedAt > 0 ? now - this.openedAt : undefined,
      sinceInboundMs: this.lastInboundAt > 0 ? now - this.lastInboundAt : undefined,
      heartbeatMs: this.heartbeatMs,
    });
    this.openedAt = 0;
  }

  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error, terminal?: boolean) => void,
    onReady?: () => void,
  ): IDisposable {
    this.requireWebSocket();
    const id = this.nextId();
    const base = {
      type: 'subscribe',
      id,
      scope: scopeKindOf(scope),
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      agentId: scope.agentId,
    };
    const frame: KlientFrame =
      source.kind === 'stream'
        ? { ...base, event: source.name }
        : { ...base, service: source.service, event: source.event };
    this.listens.set(id, { frame, handler, onError, onReady });
    this.ensureConnected();
    if (this.state === 'open') this.send(frame);
    return {
      dispose: () => {
        if (!this.listens.delete(id)) return;
        if (this.state === 'open') this.send({ type: 'unsubscribe', id });
      },
    };
  }

  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]: () => {
        const buffer: Array<IteratorResult<unknown> | Error> = [];
        const waiters: Array<{
          resolve: (result: IteratorResult<unknown>) => void;
          reject: (error: Error) => void;
        }> = [];
        let done = false;
        let id: string | undefined;

        const pending: PendingStream = {
          frame: {
            type: 'stream',
            scope: scopeKindOf(scope),
            service,
            method,
            arg: trimTrailingUndefined(args),
            workspaceId: scope.workspaceId,
            sessionId: scope.sessionId,
            agentId: scope.agentId,
          },
          sent: false,
          push(chunk) {
            if (done) return;
            const result: IteratorResult<unknown> = { done: false, value: chunk };
            const waiter = waiters.shift();
            if (waiter === undefined) buffer.push(result);
            else waiter.resolve(result);
          },
          end: () => {
            if (done) return;
            done = true;
            if (id !== undefined) this.streams.delete(id);
            const terminal: IteratorResult<unknown> = { done: true, value: undefined };
            const waiter = waiters.shift();
            if (waiter === undefined) buffer.push(terminal);
            else waiter.resolve(terminal);
            for (const pendingWaiter of waiters) {
              pendingWaiter.resolve({ done: true, value: undefined });
            }
            waiters.length = 0;
          },
          error: (error) => {
            if (done) return;
            done = true;
            if (id !== undefined) this.streams.delete(id);
            const waiter = waiters.shift();
            if (waiter === undefined) buffer.push(error);
            else waiter.reject(error);
            for (const pendingWaiter of waiters) pendingWaiter.reject(error);
            waiters.length = 0;
          },
        };

        let started = false;
        const ensureStarted = (): void => {
          if (started) return;
          started = true;
          try {
            this.requireWebSocket();
          } catch (error) {
            pending.error(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          id = this.nextId();
          pending.frame = { ...pending.frame, id };
          this.streams.set(id, pending);
          this.ensureConnected();
          if (this.state === 'open') this.sendStream(pending);
        };

        return {
          next: (): Promise<IteratorResult<unknown>> => {
            ensureStarted();
            const next = buffer.shift();
            if (next instanceof Error) return Promise.reject(next);
            if (next !== undefined) return Promise.resolve(next);
            if (done) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve, reject) => {
              waiters.push({ resolve, reject });
            });
          },
          return: (): Promise<IteratorResult<unknown>> => {
            if (!done) {
              done = true;
              if (id !== undefined) {
                const stream = this.streams.get(id);
                this.streams.delete(id);
                if (stream?.sent === true && this.state === 'open') {
                  this.send({ type: 'stream_cancel', id });
                }
              }
              for (const waiter of waiters) {
                waiter.resolve({ done: true, value: undefined });
              }
              waiters.length = 0;
            }
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socketGeneration += 1;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearLivenessTimers();
    this.state = 'closed';
    this.ws?.close(1000, 'klient closed');
    this.ws = undefined;
    const error = new Error('http event socket closed');
    this.notifyDisconnect(error);
    for (const stream of this.streams.values()) stream.error(error);
    this.streams.clear();
    this.listens.clear();
    this.sessionViews.close();
    this.terminals.close();
  }

  private requireWebSocket(): typeof WebSocket {
    const WebSocketCtor = this.WebSocketCtor;
    if (WebSocketCtor === undefined) {
      throw new Error('no WebSocket implementation available; pass WebSocket');
    }
    return WebSocketCtor;
  }

  private ensureConnected(): void {
    if (!this.hasDemand() || this.closed || this.suspended || this.state === 'open' || this.state === 'connecting') {
      return;
    }
    this.connect();
  }

  private connect(): void {
    const WebSocketCtor = this.requireWebSocket();
    const generation = ++this.socketGeneration;
    let closeHandled = false;
    const handleGenerationDrop = () => {
      if (closeHandled || generation !== this.socketGeneration) return;
      closeHandled = true;
      this.clearLivenessTimers();
      this.onClose();
    };
    this.state = 'connecting';
    const protocols =
      this.token !== undefined && this.token.length > 0
        ? [`${WS_BEARER_PROTOCOL_PREFIX}${this.token}`]
        : undefined;
    let ws: WebSocket;
    try {
      ws = new WebSocketCtor(this.wsUrl, protocols);
    } catch (error) {
      this.notifyDisconnect(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connectStartedAt = Date.now();
    this.heartbeatMs = undefined;
    this.lastInboundAt = 0;
    this.openedAt = 0;
    this.clearLivenessTimers();
    clearTimeout(this.establishmentTimer);
    this.establishmentTimer = setTimeout(() => {
      if (generation !== this.socketGeneration || this.ws !== ws || this.closed) return;
      this.ws = undefined;
      this.reportClose('establish_timeout');
      ws.close(4000, 'WebSocket establishment timed out');
      handleGenerationDrop();
    }, 12_000);
    ws.addEventListener('open', () => {
      if (generation !== this.socketGeneration || this.ws !== ws || this.closed) return;
      clearTimeout(this.establishmentTimer);
      this.connectStartedAt = 0;
      this.diagnose({ kind: 'open', attempt: this.reconnectAttempt });
      const now = Date.now();
      this.openedAt = now;
      this.lastInboundAt = now;
      this.reconnectAttempt = 0;
      this.state = 'open';
      for (const listen of this.listens.values()) this.send(listen.frame);
      for (const stream of this.streams.values()) this.sendStream(stream);
      this.sessionViews.opened();
      this.terminals.opened();
    });
    ws.addEventListener('message', (event) => {
      if (generation !== this.socketGeneration || this.ws !== ws || typeof event.data !== 'string') return;
      this.lastInboundAt = Date.now();
      if (this.probeTimer !== undefined) {
        clearTimeout(this.probeTimer);
        this.probeTimer = undefined;
        this.probeSentAt = 0;
      }
      this.onFrame(decodeJsonFrame(event.data));
      if (generation === this.socketGeneration && this.state === 'open') {
        this.armWatchdog();
      }
    });
    ws.addEventListener('close', (event) => {
      if (generation !== this.socketGeneration || this.ws !== ws) return;
      this.ws = undefined;
      if (!this.closed) this.reportClose('server', event as { code?: number; reason?: string; wasClean?: boolean });
      if ([4001, 1008].includes(event.code)) this.fatalRetriesLeft = 0;
      handleGenerationDrop();
    });
    ws.addEventListener('error', () => {
    });
  }

  private onFrame(frame: KlientFrame | undefined): void {
    if (frame === undefined) return;
    if (frame.type === 'error' && (frame.data as { fatal?: unknown } | undefined)?.fatal === true) {
      this.fatalRetriesLeft ??= 4;
      this.socketGeneration += 1;
      this.clearLivenessTimers();
      const ws = this.ws;
      this.ws = undefined;
      this.state = 'closed';
      this.reportClose('fatal_frame', { reason: frame.msg });
      ws?.close(4000, 'fatal protocol error');
      this.onClose();
      return;
    }
    if (frame.type !== 'error') this.fatalRetriesLeft = undefined;
    if (this.sessionViews.receive(frame) || this.terminals.receive(frame)) return;
    if (frame.type === 'pong') {
      return;
    }
    if (frame.type === 'ping') {
      const data = frame.data as { nonce?: unknown; heartbeatMs?: unknown } | undefined;
      if (typeof data?.heartbeatMs === 'number' && data.heartbeatMs > 0) this.heartbeatMs = data.heartbeatMs;
      this.send({ type: 'pong', data: { nonce: data?.nonce } });
      return;
    }
    const id = typeof frame.id === 'string' ? frame.id : '';
    switch (frame.type) {
      case 'subscribed':
        this.listens.get(id)?.onReady?.();
        return;
      case 'event':
        this.listens.get(id)?.handler(frame.data);
        return;
      case 'error': {
        const listen = this.listens.get(id);
        if (listen === undefined) return;
        this.listens.delete(id);
        listen.onError?.(frameError(frame), true);
        return;
      }
      case 'stream_data':
        this.streams.get(id)?.push(frame.data);
        return;
      case 'stream_end':
        this.streams.get(id)?.end();
        return;
      case 'stream_error':
        this.streams.get(id)?.error(frameError(frame));
        return;
      default:
        return;
    }
  }

  private onClose(): void {
    if (this.closed) return;
    const error = new Error('http event socket disconnected');
    for (const stream of this.streams.values()) stream.error(error);
    this.streams.clear();
    this.notifyDisconnect(error);
    if (!this.hasDemand()) {
      this.state = 'idle';
      return;
    }
    this.scheduleReconnect();
  }

  private notifyDisconnect(error: Error): void {
    clearTimeout(this.establishmentTimer);
    for (const listen of this.listens.values()) listen.onError?.(error, false);
    this.sessionViews.disconnected(error);
    this.terminals.disconnected(error);
  }

  private hasDemand(): boolean {
    return this.listens.size > 0 || this.streams.size > 0 || this.sessionViews.hasDemand || this.terminals.hasDemand;
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.hasDemand()) {
      this.state = this.closed ? 'closed' : 'idle';
      return;
    }
    const offline = isNavigatorOffline();
    if (!offline && this.fatalRetriesLeft !== undefined) {
      if (this.fatalRetriesLeft <= 0) { this.state = 'closed'; return; }
      this.fatalRetriesLeft -= 1;
    }
    if (!offline) {
      this.reconnectAttempt += 1;
    }
    this.state = 'connecting';
    this.sessionViews.connecting();
    this.terminals.connecting();
    const attempt = Math.max(1, this.reconnectAttempt);
    const baseDelay = offline
      ? 2_000
      : Math.min(DEFAULT_RECONNECT_DELAY_MS * 2 ** (attempt - 1), 10_000);
    const delay = offline || attempt === 1
      ? baseDelay
      : Math.round(baseDelay * (0.7 + Math.random() * 0.3));
    this.diagnose({ kind: 'retry', attempt: this.reconnectAttempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.state = 'idle';
      this.ensureConnected();
    }, delay);
  }

  private sendStream(stream: PendingStream): void {
    if (stream.sent) return;
    stream.sent = true;
    this.send(stream.frame);
  }

  private send(frame: KlientFrame): void {
    const ws = this.ws;
    if (ws === undefined || this.WebSocketCtor === undefined) return;
    if (ws.readyState !== this.WebSocketCtor.OPEN) return;
    try {
      ws.send(encodeJsonFrame(frame));
    } catch {
    }
  }

  private nextId(): string {
    this.seq += 1;
    return `${this.idPrefix}_${this.seq}`;
  }
}

function isNavigatorOffline(): boolean {
  const nav = (globalThis as { readonly navigator?: { readonly onLine?: boolean } }).navigator;
  return nav?.onLine === false;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function frameError(frame: KlientFrame): RPCError {
  return new RPCError(
    typeof frame.code === 'number' ? frame.code : 50001,
    frame.msg ?? 'error',
    frame.details,
    frame.reason,
  );
}

function toWebSocketUrl(endpoint: string): string {
  // Same-origin endpoint ('' — the Vite dev proxy / hash-token deep link):
  // resolve against the page origin the way the REST facade does, so
  // `new URL('')` cannot throw inside the client constructor.
  const base = endpoint === ''
    ? ((globalThis as { readonly location?: { readonly origin?: string } }).location?.origin ?? 'http://localhost')
    : endpoint;
  const url = new URL(base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported URL scheme for http transport: ${endpoint}`);
  }
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/api/klient/events`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function failedStream(error: Error): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          throw error;
        },
      };
    },
  };
}
