import type { Scope } from '@kiki/agent-core-v2';
import { HTTP_REQUEST_BODY_LIMIT_BYTES } from '@kiki/klient/http';
import {
  createKlientDispatcher,
  decodeJsonFrame,
  encodeJsonFrame,
  eventSourceFromTarget,
  isTransportScope,
  parseKlientCallRequest,
  RPCError,
  scopeRefFromProcedure,
  type IDisposable,
  type KlientDispatcher,
  type KlientFrame,
  type ScopeRef,
} from '@kiki/klient/host';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { TerminalHttpConnection } from './terminalHttp';
import { okEnvelope } from '../../protocol/envelope';
import { selectWsBearerProtocol } from '../ws/bearerProtocol';
import { registerSessionViewHttp, SessionViewHttpConnection, type SessionViewHttpOptions } from './sessionViewHttp';

export const KLIENT_CALL_PATH = '/api/klient/call';
export const KLIENT_EVENTS_PATH = '/api/klient/events';
export const KLIENT_HTTP_MAX_PAYLOAD_BYTES = 8 << 20;
export const KLIENT_CALL_BODY_LIMIT_BYTES = HTTP_REQUEST_BODY_LIMIT_BYTES;

export interface RegisterKlientHttpOptions extends SessionViewHttpOptions {
  readonly maxPayloadBytes?: number;
  readonly enableTerminals?: boolean;
}

interface ActiveStream {
  readonly iterator: AsyncIterator<unknown>;
  readonly signal: AbortSignal;
  cancel(): void;
}

export function registerKlientHttp(
  app: FastifyInstance,
  scope: Scope,
  opts: RegisterKlientHttpOptions = {},
): WebSocketServer {
  const dispatcher = createKlientDispatcher(scope);
  registerSessionViewHttp(app, scope, opts);

  app.post(KLIENT_CALL_PATH, { bodyLimit: KLIENT_CALL_BODY_LIMIT_BYTES }, async (req, reply) => {
    const controller = new AbortController();
    const abort = (): void => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once('close', abort);
    try {
      const { procedure, params } = parseKlientCallRequest(req.body);
      const data = await dispatcher.call(
        scopeRefFromProcedure(procedure),
        procedure.service,
        procedure.method,
        params,
        { signal: controller.signal },
      );
      return await reply.send(okEnvelope(data, req.id));
    } catch (error) {
      if (!(error instanceof RPCError)) {
        req.log.error({ err: error }, 'klient http call failed');
      }
      return reply.send(errorEnvelope(error, req.id));
    } finally {
      reply.raw.off('close', abort);
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: selectWsBearerProtocol,
    maxPayload: opts.maxPayloadBytes ?? KLIENT_HTTP_MAX_PAYLOAD_BYTES,
  });
  const connections = new Set<KlientHttpConnection>();
  wss.on('connection', (socket) => {
    const connection = new KlientHttpConnection(socket, dispatcher, app, opts, scope);
    connections.add(connection);
    const dispose = (): void => {
      connection.dispose();
      connections.delete(connection);
    };
    socket.on('close', dispose);
    socket.on('error', dispose);
  });
  app.addHook('preClose', () => {
    for (const connection of connections) connection.dispose();
    connections.clear();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
  });
  return wss;
}

class KlientHttpConnection {
  private readonly subscriptions = new Map<string, IDisposable>();
  private readonly streams = new Map<string, ActiveStream>();
  private readonly sessionViews: SessionViewHttpConnection;
  private readonly terminals: TerminalHttpConnection;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private lastInboundAt = Date.now();
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly dispatcher: KlientDispatcher,
    private readonly app: Pick<FastifyInstance, 'log'>,
    opts: RegisterKlientHttpOptions,
    scope: Scope,
  ) {
    this.terminals = new TerminalHttpConnection(scope, opts.enableTerminals === true, (frame) => this.send(frame));
    this.sessionViews = new SessionViewHttpConnection(opts.sessionViewBroadcaster,
      (frame) => this.send(frame), (id, error) => this.sendError('view_error', id, error));
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastInboundAt > 30_000) { socket.terminate(); this.dispose(); return; }
      this.send({ type: 'ping', data: { nonce: String(Date.now()), heartbeatMs: 10_000 } });
    }, 10_000);
    socket.on('message', (data) => {
      this.onMessage(data);
    });
  }

  private onMessage(data: RawData): void {
    if (this.closed) return;
    this.lastInboundAt = Date.now();
    const frame = decodeJsonFrame(rawDataToString(data));
    if (frame === undefined || this.sessionViews.receive(frame) || this.terminals.receive(frame)) return;
    const id = typeof frame.id === 'string' ? frame.id : '';
    switch (frame.type) {
      case 'subscribe':
        this.subscribe(id, frame);
        return;
      case 'unsubscribe':
        this.unsubscribe(id);
        return;
      case 'stream':
        this.stream(id, frame);
        return;
      case 'stream_cancel':
        this.cancelStream(id);
        return;
      default:
        return;
    }
  }

  private subscribe(id: string, frame: KlientFrame): void {
    if (id.length === 0) return;
    if (this.subscriptions.has(id) || this.streams.has(id)) {
      this.sendError('error', id, new RPCError(40001, `id already in use: ${id}`));
      return;
    }
    try {
      const scope = scopeFromFrame(frame);
      const source = eventSourceFromTarget(frame);
      let subscription: IDisposable;
      subscription = this.dispatcher.listen(
        scope,
        source,
        (data) => {
          this.send({ type: 'event', id, data });
        },
        (error) => {
          if (this.subscriptions.get(id) !== subscription) return;
          this.subscriptions.delete(id);
          subscription.dispose();
          this.sendError('error', id, error);
        },
        () => {
          if (this.subscriptions.get(id) === subscription) this.send({ type: 'subscribed', id });
        },
      );
      this.subscriptions.set(id, subscription);
    } catch (error) {
      this.sendError('error', id, error);
    }
  }

  private unsubscribe(id: string): void {
    const subscription = this.subscriptions.get(id);
    if (subscription === undefined) return;
    this.subscriptions.delete(id);
    subscription.dispose();
  }

  private stream(id: string, frame: KlientFrame): void {
    if (id.length === 0) return;
    if (this.subscriptions.has(id) || this.streams.has(id)) {
      this.sendError('stream_error', id, new RPCError(40001, `id already in use: ${id}`));
      return;
    }
    if (typeof frame.service !== 'string' || typeof frame.method !== 'string') {
      this.sendError('stream_error', id, new RPCError(40001, 'invalid stream procedure'));
      return;
    }
    let scope: ScopeRef;
    let iterator: AsyncIterator<unknown>;
    try {
      scope = scopeFromFrame(frame);
      const args = Array.isArray(frame.arg) ? frame.arg : frame.arg === undefined ? [] : [frame.arg];
      const iterable = this.dispatcher.stream(scope, frame.service, frame.method, args);
      iterator = iterable[Symbol.asyncIterator]();
    } catch (error) {
      this.sendError('stream_error', id, error);
      return;
    }
    const controller = new AbortController();
    const active: ActiveStream = {
      iterator,
      signal: controller.signal,
      cancel: () => {
        if (controller.signal.aborted) return;
        controller.abort();
        try {
          const returned = iterator.return?.();
          if (returned !== undefined) {
            void Promise.resolve(returned).catch((error: unknown) => {
              this.app.log.warn({ err: error }, 'klient stream cancellation failed');
            });
          }
        } catch (error) {
          this.app.log.warn({ err: error }, 'klient stream cancellation failed');
        }
      },
    };
    this.streams.set(id, active);
    void (async () => {
      try {
        while (!active.signal.aborted && !this.closed) {
          const result = await iterator.next();
          if (active.signal.aborted || this.closed) return;
          if (result.done) {
            this.send({ type: 'stream_end', id });
            return;
          }
          this.send({ type: 'stream_data', id, data: result.value });
        }
      } catch (error) {
        if (!active.signal.aborted && !this.closed) {
          this.sendError('stream_error', id, error);
        }
      } finally {
        if (this.streams.get(id) === active) this.streams.delete(id);
      }
    })();
  }

  private cancelStream(id: string): void {
    const active = this.streams.get(id);
    if (active === undefined) return;
    this.streams.delete(id);
    active.cancel();
  }

  private sendError(type: 'error' | 'stream_error' | 'view_error', id: string, error: unknown): void {
    if (!(error instanceof RPCError)) {
      this.app.log.error({ err: error }, 'klient websocket operation failed');
    }
    const payload = errorPayload(error);
    this.send({ type, id, ...payload });
  }

  private send(frame: KlientFrame): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    try {
      this.socket.send(encodeJsonFrame(frame));
    } catch {
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    this.subscriptions.clear();
    for (const active of this.streams.values()) active.cancel();
    this.streams.clear();
    this.sessionViews.dispose();
    this.terminals.dispose();
    clearInterval(this.heartbeat);
  }
}

function scopeFromFrame(frame: KlientFrame): ScopeRef {
  if (!isTransportScope(frame.scope)) {
    throw new RPCError(40001, 'invalid klient scope');
  }
  if (frame.scope === 'workspace') {
    if (typeof frame.workspaceId !== 'string' || frame.workspaceId.length === 0) {
      throw new RPCError(40001, 'workspace scope requires workspaceId');
    }
    return { workspaceId: frame.workspaceId };
  }
  if (frame.scope === 'session') {
    if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) {
      throw new RPCError(40001, 'session scope requires sessionId');
    }
    return { sessionId: frame.sessionId };
  }
  if (frame.scope === 'agent') {
    if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) {
      throw new RPCError(40001, 'agent scope requires sessionId');
    }
    if (typeof frame.agentId !== 'string' || frame.agentId.length === 0) {
      throw new RPCError(40001, 'agent scope requires agentId');
    }
    return { sessionId: frame.sessionId, agentId: frame.agentId };
  }
  return {};
}

function errorEnvelope(error: unknown, requestId: string): Record<string, unknown> {
  return { ...errorPayload(error), data: null, request_id: requestId };
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof RPCError) {
    return {
      code: error.code,
      msg: error.message,
      details: error.details,
      reason: error.reason,
    };
  }
  return {
    code: 50001,
    msg: error instanceof Error ? error.message : String(error),
  };
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
