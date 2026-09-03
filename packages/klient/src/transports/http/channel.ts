import type {
  CallOptions,
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from '../../core/channel.js';
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
}

interface ActiveCall {
  readonly controller: AbortController;
}

interface ActiveListen {
  readonly frame: KlientFrame;
  readonly handler: (data: unknown) => void;
  readonly onError?: (error: Error) => void;
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
  private readonly callUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly socket: HttpEventSocket;
  private readonly activeCalls = new Set<ActiveCall>();
  private closed = false;

  constructor(options: HttpChannelOptions) {
    const endpoint = options.endpoint.replace(/\/$/u, '');
    this.callUrl = `${endpoint}/api/klient/call`;
    this.token = options.token;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (fetchImpl === undefined) {
      throw new Error('no fetch implementation available; pass fetch');
    }
    this.fetchImpl = options.fetch ?? fetchImpl.bind(globalThis);
    this.socket = new HttpEventSocket({
      endpoint,
      token: options.token,
      WebSocket: options.WebSocket,
    });
  }

  async call(
    scope: ScopeRef,
    service: string,
    method: string,
    args: unknown[],
    options?: CallOptions,
  ): Promise<unknown> {
    if (this.closed) throw new Error('http closed');
    const controller = new AbortController();
    const activeCall = { controller };
    this.activeCalls.add(activeCall);
    const deadlineMs = options?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    let timedOut = false;
    const timer =
      deadlineMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, deadlineMs)
        : undefined;
    const sourceSignal = options?.signal;
    const abort = (): void => {
      controller.abort(sourceSignal?.reason);
    };
    if (sourceSignal?.aborted === true) {
      abort();
    } else {
      sourceSignal?.addEventListener('abort', abort, { once: true });
    }
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.token !== undefined) headers['authorization'] = `Bearer ${this.token}`;
      const response = await this.fetchImpl(this.callUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          procedure: createProcedure(scope, service, method),
          params: trimTrailingUndefined(args),
        }),
        signal: controller.signal,
      });
      const envelope = (await response.json()) as Envelope<unknown>;
      if (envelope.code !== 0) {
        throw new RPCError(envelope.code, envelope.msg, envelope.details, envelope.reason);
      }
      return envelope.data;
    } catch (error) {
      if (timedOut) {
        throw new RPCError(50001, `call timed out after ${deadlineMs}ms`);
      }
      if (this.closed && controller.signal.aborted) {
        throw new Error('http closed', { cause: error });
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      sourceSignal?.removeEventListener('abort', abort);
      this.activeCalls.delete(activeCall);
    }
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
  ): IDisposable {
    if (this.closed) throw new Error('http closed');
    return this.socket.listen(scope, source, handler, onError);
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
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private readonly idPrefix = `h${Date.now().toString(36)}`;

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
    this.listens.set(id, { frame, handler, onError });
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
    for (const stream of this.streams.values()) stream.error(error);
    this.streams.clear();
    this.listens.clear();
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
    ws.addEventListener('open', () => {
      if (this.ws !== ws || this.closed) return;
      this.reconnectAttempt = 0;
      this.state = 'open';
      for (const listen of this.listens.values()) this.send(listen.frame);
      for (const stream of this.streams.values()) this.sendStream(stream);
    });
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
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
    const id = typeof frame.id === 'string' ? frame.id : '';
    switch (frame.type) {
      case 'subscribed':
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
    if (this.listens.size === 0) {
      this.state = 'idle';
      return;
    }
    this.scheduleReconnect();
  }

  private notifyDisconnect(error: Error): void {
    for (const listen of this.listens.values()) listen.onError?.(error);
  }

  private hasDemand(): boolean {
    return this.listens.size > 0 || this.streams.size > 0;
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.hasDemand()) {
      this.state = this.closed ? 'closed' : 'idle';
      return;
    }
    this.reconnectAttempt += 1;
    this.state = 'connecting';
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
  const url = new URL(endpoint);
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
