import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';

import { toErrorPayload, type ErrorPayload } from '#/_base/errors/serialize';

import { createFrameDecoder, encodeFrame, type FrameDecoder } from './codec';
import { HomeRuntimeError } from './errors';
import {
  RUNTIME_ELECTION_TIMEOUT_MS,
  RUNTIME_HANDSHAKE_TIMEOUT_MS,
  RUNTIME_MAX_CALL_TIMEOUT_MS,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_MAX_IN_FLIGHT,
  RUNTIME_PROTOCOL_NAME,
  RUNTIME_PROTOCOL_VERSION,
  positiveInt,
  type RuntimeCallCancel,
  type RuntimeCallRequest,
  type RuntimeFrame,
  type RuntimeLimits,
  type RuntimeMethodContext,
  type RuntimeOutboundFrame,
} from './messages';

export interface RuntimeHandler {
  (payload: unknown, ctx: RuntimeMethodContext): unknown;
}

export interface FenceToken {
  readonly hostId: string;
  readonly method: string;
  readonly requestId: string;
  readonly identity: symbol;
}

export type FenceClaim =
  | { readonly kind: 'claimed'; readonly token: FenceToken }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'full' };

export class FenceTable {
  private readonly entries = new Map<string, FenceToken>();

  constructor(private readonly limit: number) {}

  claim(hostId: string, method: string, requestId: string): FenceClaim {
    const key = `${method}\u0000${requestId}`;
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      return { kind: existing.hostId === hostId ? 'duplicate' : 'conflict' };
    }
    if (this.entries.size >= this.limit) return { kind: 'full' };
    const token = { hostId, method, requestId, identity: Symbol(requestId) };
    this.entries.set(key, token);
    return { kind: 'claimed', token };
  }

  release(token: FenceToken): void {
    const key = `${token.method}\u0000${token.requestId}`;
    if (this.entries.get(key) === token) this.entries.delete(key);
  }

  reset(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

interface ServerConnection {
  readonly socket: Socket;
  readonly decoder: FrameDecoder;
  hostId: string;
  readonly outstanding: Map<string, RuntimeOutstanding>;
  handshaken: boolean;
  recognized: boolean;
  handshakeTimer?: ReturnType<typeof setTimeout>;
  dead: boolean;
}

interface RuntimeOutstanding {
  readonly requestId: string;
  readonly method: string;
  readonly payload: unknown;
  readonly timeoutMs: number;
  readonly fenceToken: FenceToken;
  readonly abortController: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  completed: boolean;
}

export interface OwnershipCommitContext {
  readonly signal: AbortSignal;
  readonly commitToken: string;
}

export interface ServerCallbacks {
  readonly canonicalHomeDir: string;
  readonly localHostId: string;
  readonly token: string;
  getCurrentEpoch(): number;
  resolveHandler(method: string): RuntimeHandler | undefined;
  listLocalMethods(): readonly string[];
  persistOwnershipAfterBind(server: Server, context: OwnershipCommitContext): Promise<void>;
  onOwnerLost(error: Error): void;
}

export interface RuntimeServer {
  readonly endpointPath: string;
  readonly listening: boolean;
  readonly connectionCount: number;
  readonly outstandingCount: number;
  listen(): Promise<void>;
  detach(): Promise<void>;
  broadcastReady(): void;
}

interface ListenGeneration {
  readonly server: Server;
  readonly controller: AbortController;
  readonly commitToken: string;
  readonly flight: Promise<void>;
  readonly reject: (error: unknown) => void;
  settled: boolean;
  commitTimer?: ReturnType<typeof setTimeout>;
}

export function createRuntimeServer(
  endpointPath: string,
  callbacks: ServerCallbacks,
  limits: RuntimeLimits,
  fence: FenceTable,
): RuntimeServer {
  const frameLimit = positiveInt(limits.maxFrameBytes, RUNTIME_MAX_FRAME_BYTES);
  const handshakeTimeout = positiveInt(limits.handshakeTimeoutMs, RUNTIME_HANDSHAKE_TIMEOUT_MS);
  const commitTimeout = positiveInt(limits.electionTimeoutMs, RUNTIME_ELECTION_TIMEOUT_MS);
  let server: Server | undefined;
  let listening = false;
  let generation: ListenGeneration | undefined;
  let detachFlight: Promise<void> | undefined;
  let closeFlight: Promise<void> | undefined;
  const connections = new Set<ServerConnection>();
  const sockets = new Set<Socket>();

  const outstandingCount = (): number => {
    let total = 0;
    for (const connection of connections) total += connection.outstanding.size;
    return total;
  };

  const write = (socket: Socket, frame: RuntimeOutboundFrame): boolean => {
    if (!socket.writable || socket.destroyed) return false;
    socket.write(encodeFrame(frame));
    return true;
  };

  const runtimeErrorPayload = (code: string, message: string): ErrorPayload => ({
    code: code as ErrorPayload['code'],
    message,
    retryable: false,
  });

  const rejectSocket = (socket: Socket, payload: ErrorPayload): void => {
    write(socket, { type: 'reject', reject: { code: payload.code, message: payload.message } });
    socket.end();
    socket.destroy();
  };

  const callError = (socket: Socket, requestId: string, epoch: number, payload: ErrorPayload): void => {
    write(socket, { type: 'error', error: { requestId, epoch, error: payload } });
  };

  const findConnection = (socket: Socket): ServerConnection | undefined =>
    [...connections].find((connection) => connection.socket === socket);

  const complete = (connection: ServerConnection, outstanding: RuntimeOutstanding): void => {
    if (outstanding.completed) return;
    outstanding.completed = true;
    if (outstanding.timer !== undefined) clearTimeout(outstanding.timer);
    connection.outstanding.delete(outstanding.requestId);
    fence.release(outstanding.fenceToken);
  };

  const teardown = (socket: Socket, reason = new HomeRuntimeError('runtime.detached', 'runtime connection detached')): void => {
    sockets.delete(socket);
    const connection = findConnection(socket);
    if (connection !== undefined && !connection.dead) {
      connection.dead = true;
      if (connection.handshakeTimer !== undefined) clearTimeout(connection.handshakeTimer);
      for (const outstanding of connection.outstanding.values()) {
        if (outstanding.timer !== undefined) clearTimeout(outstanding.timer);
        outstanding.abortController.abort(reason);
      }
      connections.delete(connection);
    }
    if (!socket.destroyed) socket.destroy();
  };

  const execute = async (connection: ServerConnection, outstanding: RuntimeOutstanding): Promise<void> => {
    const handler = callbacks.resolveHandler(outstanding.method);
    if (handler === undefined) {
      callError(
        connection.socket,
        outstanding.requestId,
        callbacks.getCurrentEpoch(),
        runtimeErrorPayload('runtime.not_registered', `runtime method not registered: ${outstanding.method}`),
      );
      complete(connection, outstanding);
      return;
    }
    const ctx: RuntimeMethodContext = {
      requestId: outstanding.requestId,
      epoch: callbacks.getCurrentEpoch(),
      callerHostId: connection.hostId,
      signal: outstanding.abortController.signal,
    };
    try {
      const value = await handler(outstanding.payload, ctx);
      if (!connection.dead && !outstanding.abortController.signal.aborted) {
        write(connection.socket, {
          type: 'result',
          result: { requestId: outstanding.requestId, epoch: callbacks.getCurrentEpoch(), value },
        });
      }
    } catch (error) {
      if (!connection.dead && !outstanding.abortController.signal.aborted) {
        callError(connection.socket, outstanding.requestId, callbacks.getCurrentEpoch(), toErrorPayload(error));
      }
    } finally {
      complete(connection, outstanding);
    }
  };

  const onCall = (connection: ServerConnection, call: RuntimeCallRequest): void => {
    if (!connection.handshaken) {
      rejectSocket(connection.socket, runtimeErrorPayload('runtime.protocol_mismatch', 'call received before handshake'));
      teardown(connection.socket);
      return;
    }
    const epoch = callbacks.getCurrentEpoch();
    if (call.epoch !== epoch) {
      callError(
        connection.socket,
        call.requestId,
        epoch,
        runtimeErrorPayload(
          call.epoch < epoch ? 'runtime.epoch_stale' : 'runtime.epoch_future',
          'call epoch does not match the current owner epoch',
        ),
      );
      return;
    }
    if (call.timeoutMs < 1 || call.timeoutMs > RUNTIME_MAX_CALL_TIMEOUT_MS) {
      callError(connection.socket, call.requestId, epoch, runtimeErrorPayload('runtime.invalid_request', 'call timeout is out of range'));
      return;
    }
    const claim = fence.claim(connection.hostId, call.method, call.requestId);
    if (claim.kind === 'duplicate') {
      callError(connection.socket, call.requestId, epoch, runtimeErrorPayload('runtime.duplicate_request', 'request id is already claimed'));
      return;
    }
    if (claim.kind === 'conflict') {
      callError(connection.socket, call.requestId, epoch, runtimeErrorPayload('runtime.invalid_request', 'request id is claimed by another host'));
      return;
    }
    if (claim.kind === 'full') {
      callError(connection.socket, call.requestId, epoch, runtimeErrorPayload('runtime.outstanding_overflow', 'runtime in-flight limit reached'));
      return;
    }
    const outstanding: RuntimeOutstanding = {
      requestId: call.requestId,
      method: call.method,
      payload: call.payload,
      timeoutMs: call.timeoutMs,
      fenceToken: claim.token,
      abortController: new AbortController(),
      completed: false,
    };
    outstanding.timer = setTimeout(() => {
      outstanding.timer = undefined;
      outstanding.abortController.abort(new HomeRuntimeError('runtime.timeout', `runtime call timed out after ${call.timeoutMs}ms`));
      callError(connection.socket, call.requestId, callbacks.getCurrentEpoch(), runtimeErrorPayload('runtime.timeout', `runtime call timed out after ${call.timeoutMs}ms`));
    }, call.timeoutMs);
    outstanding.timer.unref?.();
    connection.outstanding.set(call.requestId, outstanding);
    void execute(connection, outstanding);
  };

  const onCancel = (connection: ServerConnection, cancel: RuntimeCallCancel): void => {
    if (!connection.handshaken || cancel.epoch !== callbacks.getCurrentEpoch()) return;
    const outstanding = connection.outstanding.get(cancel.requestId);
    if (outstanding === undefined || outstanding.completed) return;
    if (outstanding.timer !== undefined) clearTimeout(outstanding.timer);
    outstanding.timer = undefined;
    outstanding.abortController.abort(new HomeRuntimeError('runtime.aborted', 'runtime call cancelled'));
  };

  const onFrame = (connection: ServerConnection, frame: RuntimeFrame): void => {
    if (frame.type === 'hello') {
      connection.hostId = frame.hello.hostId;
      if (frame.hello.canonicalHomeDir !== callbacks.canonicalHomeDir) {
        rejectSocket(connection.socket, runtimeErrorPayload('runtime.identity_mismatch', 'home directory identity mismatch'));
        teardown(connection.socket);
        return;
      }
      connection.recognized = true;
      return;
    }
    if (frame.type === 'token') {
      if (!connection.recognized) {
        rejectSocket(connection.socket, runtimeErrorPayload('runtime.protocol_mismatch', 'token received before hello'));
        teardown(connection.socket);
        return;
      }
      if (!frame.token.tokens.includes(callbacks.token)) {
        rejectSocket(connection.socket, runtimeErrorPayload('runtime.token_mismatch', 'runtime token mismatch'));
        teardown(connection.socket);
        return;
      }
      connection.handshaken = true;
      if (connection.handshakeTimer !== undefined) clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = undefined;
      const epoch = callbacks.getCurrentEpoch();
      write(connection.socket, {
        type: 'ack',
        ack: {
          v: RUNTIME_PROTOCOL_VERSION,
          protocol: RUNTIME_PROTOCOL_NAME,
          epoch,
          hostId: callbacks.localHostId,
          canonicalHomeDir: callbacks.canonicalHomeDir,
        },
      });
      write(connection.socket, {
        type: 'ready',
        ready: {
          epoch,
          hostId: callbacks.localHostId,
          canonicalHomeDir: callbacks.canonicalHomeDir,
          methods: callbacks.listLocalMethods(),
        },
      });
      return;
    }
    if (frame.type === 'call') {
      onCall(connection, frame.call);
      return;
    }
    if (frame.type === 'cancel') {
      onCancel(connection, frame.cancel);
      return;
    }
    rejectSocket(connection.socket, runtimeErrorPayload('runtime.protocol_mismatch', `unexpected frame from client: ${frame.type}`));
    teardown(connection.socket);
  };

  const activateConnection = (socket: Socket): void => {
    const connection: ServerConnection = {
      socket,
      decoder: createFrameDecoder(frameLimit),
      hostId: '',
      outstanding: new Map(),
      handshaken: false,
      recognized: false,
      dead: false,
    };
    connection.handshakeTimer = setTimeout(() => {
      if (!connection.handshaken && !connection.dead) {
        rejectSocket(socket, runtimeErrorPayload('runtime.timeout', 'runtime handshake timed out'));
        teardown(socket);
      }
    }, handshakeTimeout);
    connection.handshakeTimer.unref?.();
    connections.add(connection);
    socket.on('data', (chunk: Buffer) => {
      for (const event of connection.decoder.push(chunk)) {
        if (event.kind === 'overflow') {
          rejectSocket(socket, runtimeErrorPayload('runtime.frame_overflow', event.error.message));
          teardown(socket);
          return;
        }
        if (event.kind === 'invalid') {
          rejectSocket(socket, runtimeErrorPayload('runtime.protocol_mismatch', event.error.message));
          teardown(socket);
          return;
        }
        onFrame(connection, event.frame);
        if (connection.dead) return;
      }
    });
  };

  const onConnection = (socket: Socket): void => {
    if (!listening) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('error', () => teardown(socket));
    socket.on('close', () => teardown(socket));
    activateConnection(socket);
  };

  const closeServer = (current: Server): Promise<void> => {
    closeFlight ??= new Promise<void>((resolve) => {
      try {
        current.close(() => resolve());
      } catch {
        resolve();
      }
    });
    return closeFlight;
  };

  const failGeneration = (current: ListenGeneration, error: unknown): void => {
    if (current.settled) return;
    current.settled = true;
    if (current.commitTimer !== undefined) clearTimeout(current.commitTimer);
    const failure = error instanceof Error ? error : new HomeRuntimeError('runtime.connection_failed', String(error));
    current.controller.abort(failure);
    listening = false;
    if (server === current.server) server = undefined;
    if (generation === current) generation = undefined;
    for (const socket of sockets) teardown(socket, new HomeRuntimeError('runtime.detached', 'runtime owner commit failed'));
    void closeServer(current.server);
    current.reject(failure);
  };

  return {
    endpointPath,

    get listening(): boolean {
      return listening;
    },

    get connectionCount(): number {
      return connections.size;
    },

    get outstandingCount(): number {
      return outstandingCount();
    },

    broadcastReady(): void {
      if (!listening) return;
      const epoch = callbacks.getCurrentEpoch();
      for (const connection of connections) {
        if (!connection.handshaken || connection.dead) continue;
        write(connection.socket, {
          type: 'ready',
          ready: {
            epoch,
            hostId: callbacks.localHostId,
            canonicalHomeDir: callbacks.canonicalHomeDir,
            methods: callbacks.listLocalMethods(),
          },
        });
      }
    },

    listen(): Promise<void> {
      if (listening) return Promise.resolve();
      if (generation !== undefined) return generation.flight;
      if (detachFlight !== undefined || closeFlight !== undefined) {
        return Promise.reject(new HomeRuntimeError('runtime.detached', 'runtime server is detached'));
      }
      const created = createServer(onConnection);
      const controller = new AbortController();
      const commitToken = randomUUID();
      let resolveFlight!: () => void;
      let rejectFlight!: (error: unknown) => void;
      const flight = new Promise<void>((resolve, reject) => {
        resolveFlight = resolve;
        rejectFlight = reject;
      });
      const current: ListenGeneration = {
        server: created,
        controller,
        commitToken,
        flight,
        reject: rejectFlight,
        settled: false,
      };
      generation = current;
      server = created;
      created.on('error', (error: Error) => {
        if (!listening) {
          failGeneration(current, error);
          return;
        }
        listening = false;
        callbacks.onOwnerLost(new HomeRuntimeError('runtime.connection_fatal', error.message, { cause: error }));
      });
      created.listen(endpointPath, () => {
        if (current.settled || generation !== current || server !== created) return;
        current.commitTimer = setTimeout(() => {
          failGeneration(current, new HomeRuntimeError('runtime.timeout', 'runtime ownership commit timed out'));
        }, commitTimeout);
        current.commitTimer.unref?.();
        void callbacks.persistOwnershipAfterBind(created, { signal: controller.signal, commitToken }).then(
          () => {
            if (current.settled || generation !== current || server !== created || controller.signal.aborted) return;
            if (current.commitTimer !== undefined) clearTimeout(current.commitTimer);
            current.commitTimer = undefined;
            current.settled = true;
            listening = true;
            resolveFlight();
          },
          (error: unknown) => failGeneration(current, error),
        );
      });
      return flight;
    },

    detach(): Promise<void> {
      detachFlight ??= (async () => {
        listening = false;
        const current = server;
        const pending = generation;
        if (pending !== undefined && !pending.settled) {
          failGeneration(pending, new HomeRuntimeError('runtime.detached', 'runtime server detached before ownership commit'));
        }
        server = undefined;
        generation = undefined;
        for (const socket of sockets) {
          teardown(socket, new HomeRuntimeError('runtime.owner_gone', 'runtime owner detached'));
        }
        if (current !== undefined) await closeServer(current);
      })();
      return detachFlight;
    },
  };
}

export function createFenceTable(limits: RuntimeLimits = {}): FenceTable {
  return new FenceTable(positiveInt(limits.maxInFlight, RUNTIME_MAX_IN_FLIGHT));
}
