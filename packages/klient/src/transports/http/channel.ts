import type {
  CallOptions,
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
  SessionViewChannel,
} from '../../core/channel.js';
import { HttpSessionViews } from './session-view.js';
import { HttpTerminals } from './terminal.js';
import { HTTP_REQUEST_BODY_LIMIT_BYTES } from './limits.js';
import type { TerminalFacade } from '../../core/facade/terminal.js';
import type { HttpRestFacade } from '../../core/facade/http-rest.js';
import { createHttpRestFacade, type HttpRestJsonOptions } from './rest.js';
import { listTerminalsResponseSchema, getTerminalResponseSchema, closeTerminalResponseSchema, createTerminalRequestSchema } from '@kiki/protocol';
import { sessionCommandContract, type SessionCommandChannel } from '../../contract/session/commands.js';
import { RPCError } from '../../core/errors.js';
import { trimTrailingUndefined } from '../args.js';
import {
  createProcedure,
  decodeJsonFrame,
  encodeJsonFrame,
  scopeKindOf,
  type KlientFrame,
} from '../codec.js';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_DELAY_MS = 500;
const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';
export const HTTP_TRANSPORT_TIMEOUT_REASON = 'transport.timeout';

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
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly WebSocket?: typeof WebSocket;
  /** Default deadline for HTTP calls and typed REST domains. */
  readonly timeoutMs?: number;
}

interface ActiveCall {
  readonly controller: AbortController;
}

interface ActiveListen {
  readonly frame: KlientFrame;
  readonly handler: (data: unknown) => void;
  readonly onError?: (error: Error) => void;
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
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly socket: HttpEventSocket;
  private readonly activeCalls = new Set<ActiveCall>();
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
    transcriptPage: (sessionId, input) => this.viewRequest(`/api/klient/session-view/${encodeURIComponent(sessionId)}/transcript`, {
      agent_id: input.agentId, before_turn: input.beforeTurn, after_turn: input.afterTurn, page_size: input.pageSize,
    }),
    transcriptCatchUp: (sessionId, input) => this.viewRequest(`/api/klient/session-view/${encodeURIComponent(sessionId)}/transcript/catch-up`, {
      agent_id: input.agentId, epoch: input.since.epoch, since_seq: input.since.seq, grade: input.grade ?? 'delta',
    }),
    subscribe: (sessionId, input, handler) => {
      if (this.closed) throw new Error('http closed');
      return this.socket.sessionViews.subscribe(sessionId, input, handler);
    },
  };

  readonly sessionCommands: SessionCommandChannel = {
    execute: (sessionId, command, input) => {
      const spec = sessionCommandContract[command];
      const value = input as {
        target?: string;
        body?: unknown;
        query?: { agent_id?: string };
      };
      const suffix = spec.suffix.replace('{target}', encodeURIComponent(value.target ?? ''));
      return this.viewRequest(
        `/api/sessions/${encodeURIComponent(sessionId)}${suffix}`,
        { agent_id: value.query?.agent_id },
        {
          method: spec.method,
          body: spec.method === 'GET' ? undefined : value.body ?? {},
          okCodes: spec.okCodes,
          timeoutMs: 'timeoutMs' in spec ? spec.timeoutMs : undefined,
        },
      );
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

  private requestJson<T>(path: string, options: HttpRestJsonOptions = {}): Promise<T> {
    return this.performFetch(path, options, async (response) => {
      if (response.status === 404 && options.allowMissingRoute === true) {
        await response.body?.cancel();
        return undefined as T;
      }
      const envelope = await this.readEnvelope(response, options.signal);
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
    return this.performFetch(path, requestOptions, async (response) => {
      const contentType = response.headers.get('content-type') ?? '';
      if ((response.ok || (response.status === 304 && requestOptions.headers?.['if-none-match'] !== undefined)) &&
          !(requestOptions.jsonErrorOnSuccess === true && contentType.includes('json'))) {
        return consume(response);
      }
      const envelope = await this.readEnvelope(response, requestOptions.signal);
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
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error('http closed');
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined && new TextEncoder().encode(body).byteLength > HTTP_REQUEST_BODY_LIMIT_BYTES) {
      throw new RPCError(40001, 'request body exceeds the allowed size limit');
    }
    const controller = new AbortController();
    const activeCall = { controller };
    this.activeCalls.add(activeCall);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    let timedOut = false;
    const timer = timeoutMs === 0
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
    const sourceSignal = options.signal;
    const abort = (): void => {
      controller.abort(sourceSignal?.reason);
    };
    if (sourceSignal?.aborted === true) abort();
    else sourceSignal?.addEventListener('abort', abort, { once: true });
    try {
      const baseUrl = options.baseUrl ?? this.endpoint;
      const root = baseUrl.replace(/\/+$/u, '');
      const route = path.startsWith('/api/') ? path : `/api${path}`;
      const locationOrigin = (globalThis as { readonly location?: { readonly origin?: string } }).location?.origin;
      const url = root === ''
        ? new URL(route, locationOrigin ?? 'http://localhost')
        : new URL(`${root}${route}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      const headers: Record<string, string> = {
        accept: options.expectBinary === true ? 'application/octet-stream' : 'application/json',
        ...options.headers,
      };
      if (this.token !== undefined && options.skipAuth !== true) headers['authorization'] = `Bearer ${this.token}`;
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      let response: Response;
      try {
        const input = path === '/api/klient/call' ? url.toString() : url;
        response = await this.fetchImpl(input, {
          method: options.method ?? 'GET',
          body,
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) throw this.transportTimeoutError(timeoutMs);
        if (this.closed && controller.signal.aborted) throw new Error('http closed', { cause: error });
        throw new RPCError(-1, error instanceof Error ? error.message : 'Connection failed');
      }
      if (timedOut) throw this.transportTimeoutError(timeoutMs);
      try {
        const result = await consume(response);
        if (timedOut) throw this.transportTimeoutError(timeoutMs);
        return result;
      } catch (error) {
        if (timedOut) throw this.transportTimeoutError(timeoutMs);
        if (this.closed && controller.signal.aborted) throw new Error('http closed', { cause: error });
        if (error instanceof TypeError && !controller.signal.aborted) {
          throw new RPCError(-1, error.message);
        }
        throw error;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      sourceSignal?.removeEventListener('abort', abort);
      this.activeCalls.delete(activeCall);
    }
  }

  private transportTimeoutError(timeoutMs: number): RPCError {
    return new RPCError(
      50001,
      `call timed out after ${timeoutMs}ms`,
      undefined,
      HTTP_TRANSPORT_TIMEOUT_REASON,
    );
  }

  private async readEnvelope(response: Response, signal?: AbortSignal): Promise<Envelope<unknown>> {
    let envelope: Envelope<unknown> | null;
    try {
      envelope = (await response.json()) as Envelope<unknown> | null;
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
    const endpoint = options.endpoint.replace(/\/$/u, '');
    this.endpoint = endpoint;
    this.token = options.token;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (fetchImpl === undefined) {
      throw new Error('no fetch implementation available; pass fetch');
    }
    this.fetchImpl = options.fetch ?? fetchImpl.bind(globalThis);
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.socket = new HttpEventSocket({
      endpoint,
      token: options.token,
      WebSocket: options.WebSocket,
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
    return this.requestJson('/api/klient/call', {
      method: 'POST',
      body: {
        procedure: createProcedure(scope, service, method),
        params: trimTrailingUndefined(args),
      },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown> {
    if (this.closed) return failedStream(new Error('http closed'));
    return this.socket.stream(scope, service, method, args);
  }

  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
    onReady?: () => void,
  ): IDisposable {
    if (this.closed) throw new Error('http closed');
    return this.socket.listen(scope, source, handler, onError, onReady);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const call of this.activeCalls) call.controller.abort();
    this.activeCalls.clear();
    this.socket.close();
    return Promise.resolve();
  }
}

class HttpEventSocket {
  private readonly wsUrl: string;
  private readonly token?: string;
  private readonly WebSocketCtor: typeof WebSocket | undefined;
  private readonly listens = new Map<string, ActiveListen>();
  private readonly streams = new Map<string, PendingStream>();
  private ws: WebSocket | undefined;
  private state: SocketState = 'idle';
  private closed = false;
  private reconnectAttempt = 0;
  private fatalRetriesLeft: number | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private establishmentTimer: ReturnType<typeof setTimeout> | undefined;
  private lastInboundAt = 0;
  private heartbeatMs: number | undefined;
  private seq = 0;
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
    restart: () => { this.restart(); },
    nudge: () => { this.nudge(); },
  });

  private restart(): void {
    if (this.closed) return;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    this.state = 'idle';
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
      if (this.heartbeatMs !== undefined && Date.now() - this.lastInboundAt > Math.max(45_000, this.heartbeatMs * 3)) this.restart();
      return;
    }
    if (this.ws !== undefined) return;
    this.fatalRetriesLeft = undefined;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.state = 'idle';
    this.ensureConnected();
  }

  constructor(options: {
    endpoint: string;
    token?: string;
    WebSocket?: typeof WebSocket;
  }) {
    this.wsUrl = toWebSocketUrl(options.endpoint);
    this.token = options.token;
    this.WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
  }

  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
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
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
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
    if (!this.hasDemand() || this.closed || this.state === 'open' || this.state === 'connecting') {
      return;
    }
    this.connect();
  }

  private connect(): void {
    const WebSocketCtor = this.requireWebSocket();
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
    this.heartbeatMs = undefined;
    this.lastInboundAt = 0;
    clearTimeout(this.establishmentTimer);
    this.establishmentTimer = setTimeout(() => {
      if (this.ws !== ws || this.closed) return;
      this.ws = undefined;
      ws.close(4000, 'WebSocket establishment timed out');
      this.onClose();
    }, 12_000);
    ws.addEventListener('open', () => {
      if (this.ws !== ws || this.closed) return;
      clearTimeout(this.establishmentTimer);
      this.reconnectAttempt = 0;
      this.state = 'open';
      for (const listen of this.listens.values()) this.send(listen.frame);
      for (const stream of this.streams.values()) this.sendStream(stream);
      this.sessionViews.opened();
      this.terminals.opened();
    });
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
      this.lastInboundAt = Date.now();
      this.onFrame(decodeJsonFrame(event.data));
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.onClose();
    });
    ws.addEventListener('error', () => {
    });
  }

  private onFrame(frame: KlientFrame | undefined): void {
    if (frame === undefined) return;
    if (frame.type === 'error' && (frame.data as { fatal?: unknown } | undefined)?.fatal === true) {
      this.fatalRetriesLeft ??= 4;
      const ws = this.ws;
      this.ws = undefined;
      this.state = 'closed';
      ws?.close(4000, 'fatal protocol error');
      this.onClose();
      return;
    }
    if (frame.type !== 'error') this.fatalRetriesLeft = undefined;
    if (this.sessionViews.receive(frame) || this.terminals.receive(frame)) return;
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
        listen.onError?.(frameError(frame));
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
    for (const listen of this.listens.values()) listen.onError?.(error);
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
    if (this.fatalRetriesLeft !== undefined) {
      if (this.fatalRetriesLeft <= 0) { this.state = 'closed'; return; }
      this.fatalRetriesLeft -= 1;
    }
    this.reconnectAttempt += 1;
    this.state = 'connecting';
    this.sessionViews.connecting();
    this.terminals.connecting();
    const delay = Math.min(
      DEFAULT_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
      10_000,
    );
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
