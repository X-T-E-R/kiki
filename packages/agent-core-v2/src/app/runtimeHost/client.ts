import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { createConnection } from 'node:net';

import { createFrameDecoder, encodeCall, encodeCancel, encodeHello, encodeTokens } from './codec';
import { HomeRuntimeError, fromErrorPayloadCode } from './errors';
import {
  RUNTIME_CONNECT_TIMEOUT_MS,
  RUNTIME_HANDSHAKE_TIMEOUT_MS,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_MAX_IN_FLIGHT,
  RUNTIME_MAX_REQUEST_ID_LENGTH,
  RUNTIME_PROTOCOL_NAME,
  RUNTIME_PROTOCOL_VERSION,
  callTimeoutMs,
  positiveInt,
  type RuntimeCallOptions,
  type RuntimeFrame,
  type RuntimeLimits,
} from './messages';

export interface ClientPeerInfo {
  readonly hostId: string;
  readonly canonicalHomeDir: string;
  readonly epoch: number;
  readonly methods: readonly string[];
}

export interface ClientCallbacks {
  readonly hostId: string;
  readonly canonicalHomeDir: string;
  readonly tokens: readonly string[];
  onConnected(peer: ClientPeerInfo): void;
  onDisconnected(reason: string): void;
}

export interface RuntimeClient {
  readonly connected: boolean;
  connect(endpointPath: string): Promise<void>;
  disconnect(reason?: string): void;
  call(method: string, payload: unknown, options?: RuntimeCallOptions): Promise<unknown>;
}

interface PendingCall {
  readonly requestId: string;
  timer?: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

type ClientPhase = 'detached' | 'connecting' | 'handshaking' | 'ready';

export function createRuntimeClient(
  callbacks: ClientCallbacks,
  limits: RuntimeLimits = {},
): RuntimeClient {
  const pendingLimit = positiveInt(limits.maxInFlight, RUNTIME_MAX_IN_FLIGHT);
  const connectTimeout = positiveInt(limits.connectTimeoutMs, RUNTIME_CONNECT_TIMEOUT_MS);
  const handshakeTimeout = positiveInt(limits.handshakeTimeoutMs, RUNTIME_HANDSHAKE_TIMEOUT_MS);
  const frameLimit = positiveInt(limits.maxFrameBytes, RUNTIME_MAX_FRAME_BYTES);
  const pending = new Map<string, PendingCall>();
  let socket: Socket | undefined;
  let decoder: ReturnType<typeof createFrameDecoder> | undefined;
  let phase: ClientPhase = 'detached';
  let peerEpoch = 0;
  let handshakeResolve: (() => void) | undefined;
  let handshakeReject: ((error: Error) => void) | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

  const clearHandshake = (): void => {
    if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
    handshakeTimer = undefined;
    handshakeResolve = undefined;
    handshakeReject = undefined;
  };

  const finishHandshake = (error?: Error): void => {
    const resolve = handshakeResolve;
    const reject = handshakeReject;
    clearHandshake();
    if (error === undefined) resolve?.();
    else reject?.(error);
  };

  const failAll = (error: Error): void => {
    for (const call of pending.values()) call.reject(error);
  };

  const teardown = (error: HomeRuntimeError): void => {
    const previous = phase;
    if (previous === 'detached') return;
    const current = socket;
    socket = undefined;
    decoder = undefined;
    phase = 'detached';
    current?.destroy();
    finishHandshake(error);
    failAll(error);
    if (previous === 'ready') callbacks.onDisconnected(error.message);
  };

  const sendCancel = (requestId: string): void => {
    if (socket !== undefined && !socket.destroyed && phase === 'ready') {
      socket.write(encodeCancel({ requestId, epoch: peerEpoch }));
    }
  };

  const onFrame = (frame: RuntimeFrame): void => {
    if (frame.type === 'ack') {
      if (phase !== 'handshaking') {
        teardown(new HomeRuntimeError('runtime.protocol_mismatch', 'unexpected ack frame'));
        return;
      }
      if (frame.ack.canonicalHomeDir !== callbacks.canonicalHomeDir) {
        teardown(new HomeRuntimeError('runtime.identity_mismatch', 'runtime server home directory mismatch'));
        return;
      }
      peerEpoch = frame.ack.epoch;
      return;
    }
    if (frame.type === 'ready') {
      if (frame.ready.canonicalHomeDir !== callbacks.canonicalHomeDir) {
        teardown(new HomeRuntimeError('runtime.identity_mismatch', 'runtime ready identity mismatch'));
        return;
      }
      peerEpoch = frame.ready.epoch;
      if (phase === 'handshaking') {
        phase = 'ready';
        callbacks.onConnected({
          hostId: frame.ready.hostId,
          canonicalHomeDir: frame.ready.canonicalHomeDir,
          epoch: frame.ready.epoch,
          methods: frame.ready.methods,
        });
        finishHandshake();
      }
      return;
    }
    if (frame.type === 'result') {
      const call = pending.get(frame.result.requestId);
      if (call !== undefined && frame.result.epoch === peerEpoch) call.resolve(frame.result.value);
      return;
    }
    if (frame.type === 'error') {
      const call = pending.get(frame.error.requestId);
      if (call !== undefined && frame.error.epoch === peerEpoch) {
        call.reject(new HomeRuntimeError(fromErrorPayloadCode(frame.error.error.code), frame.error.error.message));
      }
      return;
    }
    if (frame.type === 'reject') {
      teardown(new HomeRuntimeError(fromErrorPayloadCode(frame.reject.code), frame.reject.message));
    }
  };

  const onData = (chunk: Buffer): void => {
    if (decoder === undefined) return;
    for (const event of decoder.push(chunk)) {
      if (event.kind === 'overflow') {
        teardown(new HomeRuntimeError('runtime.frame_overflow', event.error.message));
        return;
      }
      if (event.kind === 'invalid') {
        teardown(new HomeRuntimeError('runtime.protocol_mismatch', event.error.message));
        return;
      }
      onFrame(event.frame);
      if (phase === 'detached') return;
    }
  };

  const beginHandshake = (): Promise<void> => {
    if (socket === undefined) return Promise.reject(new HomeRuntimeError('runtime.connection_failed', 'runtime socket is missing'));
    phase = 'handshaking';
    decoder = createFrameDecoder(frameLimit);
    socket.on('data', onData);
    socket.on('error', (error: Error) => {
      teardown(new HomeRuntimeError('runtime.connection_failed', error.message, { cause: error }));
    });
    socket.on('close', () => {
      teardown(new HomeRuntimeError('runtime.owner_gone', 'runtime owner connection closed'));
    });
    socket.setNoDelay(true);
    socket.write(encodeHello({
      v: RUNTIME_PROTOCOL_VERSION,
      protocol: RUNTIME_PROTOCOL_NAME,
      hostId: callbacks.hostId,
      canonicalHomeDir: callbacks.canonicalHomeDir,
    }));
    socket.write(encodeTokens(callbacks.tokens));
    return new Promise<void>((resolve, reject) => {
      handshakeResolve = resolve;
      handshakeReject = reject;
      handshakeTimer = setTimeout(() => {
        teardown(new HomeRuntimeError('runtime.timeout', 'runtime handshake timed out'));
      }, handshakeTimeout);
      handshakeTimer.unref?.();
    });
  };

  return {
    get connected(): boolean {
      return phase === 'ready' && socket !== undefined && !socket.destroyed;
    },

    connect(endpointPath: string): Promise<void> {
      if (phase === 'ready') return Promise.resolve();
      if (phase !== 'detached') {
        return Promise.reject(new HomeRuntimeError('runtime.connection_failed', 'runtime connection is already in progress'));
      }
      phase = 'connecting';
      return new Promise<void>((resolve, reject) => {
        const created = createConnection(endpointPath);
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          created.setTimeout(0);
          created.removeAllListeners('connect');
          created.removeAllListeners('error');
          if (error !== undefined) {
            phase = 'detached';
            created.destroy();
            reject(error);
            return;
          }
          socket = created;
          resolve();
        };
        created.once('connect', () => finish());
        created.once('error', (error: Error) => {
          finish(new HomeRuntimeError('runtime.connection_failed', error.message, { cause: error }));
        });
        created.setTimeout(connectTimeout, () => {
          finish(new HomeRuntimeError('runtime.timeout', 'runtime connect timed out'));
        });
      }).then(beginHandshake);
    },

    disconnect(reason = 'runtime client disconnected'): void {
      teardown(new HomeRuntimeError('runtime.detached', reason));
    },

    call(method: string, payload: unknown, options: RuntimeCallOptions = {}): Promise<unknown> {
      if (phase !== 'ready' || socket === undefined || socket.destroyed) {
        return Promise.reject(new HomeRuntimeError('runtime.connection_failed', 'runtime client is not connected'));
      }
      if (pending.size >= pendingLimit) {
        return Promise.reject(new HomeRuntimeError('runtime.pending_overflow', `runtime client pending call limit reached (${pendingLimit})`));
      }
      const requestId = options.requestId ?? randomUUID();
      if (requestId.length === 0 || requestId.length > RUNTIME_MAX_REQUEST_ID_LENGTH) {
        return Promise.reject(new HomeRuntimeError('runtime.invalid_request', 'requestId must be a non-empty string of at most 128 characters'));
      }
      if (pending.has(requestId)) {
        return Promise.reject(new HomeRuntimeError('runtime.duplicate_request', `request id is already pending: ${requestId}`));
      }
      if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
      const timeoutMs = callTimeoutMs(options.timeoutMs, limits.callTimeoutMs);
      return new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const abortFromCaller = (): void => {
          sendCancel(requestId);
          finish(abortReason(options.signal!));
        };
        const cleanup = (): void => {
          if (call.timer !== undefined) clearTimeout(call.timer);
          options.signal?.removeEventListener('abort', abortFromCaller);
          pending.delete(requestId);
        };
        const finish = (error?: Error, value?: unknown): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error === undefined) resolve(value);
          else reject(error);
        };
        const call: PendingCall = {
          requestId,
          resolve: (value) => finish(undefined, value),
          reject: (error) => finish(error),
        };
        options.signal?.addEventListener('abort', abortFromCaller, { once: true });
        call.timer = setTimeout(() => {
          sendCancel(requestId);
          finish(new HomeRuntimeError('runtime.timeout', `runtime call timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        call.timer.unref?.();
        pending.set(requestId, call);
        const written = socket!.write(encodeCall({
          requestId,
          method,
          epoch: peerEpoch,
          payload,
          timeoutMs,
        }));
        if (!written && socket!.destroyed) finish(new HomeRuntimeError('runtime.connection_failed', 'runtime connection closed'));
      });
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && !(signal.reason instanceof DOMException)) return signal.reason;
  return new HomeRuntimeError('runtime.aborted', 'runtime call aborted');
}
