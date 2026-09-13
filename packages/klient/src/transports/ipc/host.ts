/**
 * IPC host — serves one engine scope over a local socket or Windows named
 * pipe. Incoming frames are bridged to the shared in-process dispatcher (the
 * same code the memory transport uses), so ipc and in-memory behavior are identical by
 * construction; only serialization separates them.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';

import { ErrorCode } from '@kiki/protocol';

import type { IDisposable } from '../../core/channel.js';
import { RPCError } from '../../core/errors.js';
import {
  eventSourceFromTarget,
  scopeRefFromTarget,
} from '../codec.js';
import { createMemoryDispatcher, type ScopeLike } from '../memory/dispatcher.js';
import {
  encodeFrame,
  NdjsonDecoder,
  normalizeIpcSocketPath,
  type IpcFrame,
} from './codec.js';

const REQUEST_INVALID = ErrorCode.VALIDATION_FAILED;
const UNAUTHORIZED = ErrorCode.AUTH_INVALID_TOKEN;

export interface ServeKlientIpcOptions {
  /** A bootstrapped engine app scope (same value `createKlient({ scope })` takes). */
  readonly scope: ScopeLike;
  /** Local endpoint path. On Windows it is deterministically mapped to a named pipe. */
  readonly socketPath: string;
  /** Optional token; when set, the client's `hello` must carry the same token. */
  readonly token?: string;
}

export interface KlientIpcHost {
  readonly socketPath: string;
  close(): Promise<void>;
}

export async function serveKlientIpc(options: ServeKlientIpcOptions): Promise<KlientIpcHost> {
  const dispatcher = createMemoryDispatcher(options.scope);
  const listenPath = normalizeIpcSocketPath(options.socketPath);

  // Best-effort cleanup of a stale socket file; ignore everything but a real
  // leftover (ENOENT = nothing to remove).
  if (process.platform !== 'win32') {
    try {
      await unlink(listenPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const connections = new Set<Socket>();

  const server: Server = createServer((socket) => {
    connections.add(socket);
    const decoder = new NdjsonDecoder();
    const listens = new Map<string, IDisposable>();
    const activeStreams = new Map<string, AbortController>();
    const activeCalls = new Map<string, AbortController>();
    let helloDone = false;

    const send = (frame: IpcFrame): void => {
      if (!socket.destroyed) socket.write(encodeFrame(frame));
    };
    const sendError = (id: string, error: unknown): void => {
      if (error instanceof RPCError) {
        send({
          type: 'error',
          id,
          code: error.code,
          msg: error.message,
          details: error.details,
          reason: error.reason,
        });
      } else {
        send({
          type: 'error',
          id,
          code: 50001,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const sendStreamError = (id: string, error: unknown): void => {
      if (error instanceof RPCError) {
        send({
          type: 'stream_error',
          id,
          code: error.code,
          msg: error.message,
          details: error.details,
          reason: error.reason,
        });
      } else {
        send({
          type: 'stream_error',
          id,
          code: 50001,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const handleFrame = (frame: IpcFrame): void => {
      const id = typeof frame.id === 'string' ? frame.id : '';
      switch (frame.type) {
        case 'hello': {
          if (options.token !== undefined && frame.token !== options.token) {
            send({ type: 'error', id: 'hello', code: UNAUTHORIZED, msg: 'unauthorized' });
            socket.end();
            return;
          }
          helloDone = true;
          return;
        }
        case 'call': {
          if (!helloDone) {
            sendError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          if (activeCalls.has(id)) {
            sendError(id, new RPCError(REQUEST_INVALID, 'call id already in use'));
            return;
          }
          const controller = new AbortController();
          activeCalls.set(id, controller);
          const args = Array.isArray(frame.arg) ? frame.arg : frame.arg === undefined ? [] : [frame.arg];
          dispatcher
            .call(scopeRefFromTarget(frame), String(frame.service), String(frame.method), args, { signal: controller.signal })
            .then((data) => {
              if (!controller.signal.aborted) send({ type: 'result', id, data });
            })
            .catch((error: unknown) => {
              if (!controller.signal.aborted) sendError(id, error);
            })
            .finally(() => { activeCalls.delete(id); });
          return;
        }
        case 'call_cancel': {
          activeCalls.get(id)?.abort();
          return;
        }
        case 'listen': {
          if (!helloDone) {
            sendError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          try {
            const source = eventSourceFromTarget(frame);
            const sub = dispatcher.listen(
              scopeRefFromTarget(frame),
              source,
              (data) => {
                send({ type: 'event', id, data });
              },
              (error) => {
                if (listens.get(id) !== sub) return;
                listens.delete(id);
                sub.dispose();
                sendError(id, error);
              },
              () => {
                if (listens.get(id) === sub) send({ type: 'listen_result', id });
              },
            );
            listens.set(id, sub);
          } catch (error) {
            sendError(id, error);
          }
          return;
        }
        case 'unlisten': {
          listens.get(id)?.dispose();
          listens.delete(id);
          return;
        }
        case 'stream': {
          if (!helloDone) {
            sendStreamError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          const args = Array.isArray(frame.arg) ? frame.arg : frame.arg === undefined ? [] : [frame.arg];
          const ac = new AbortController();
          activeStreams.set(id, ac);
          const iterable = dispatcher.stream(
            scopeRefFromTarget(frame),
            String(frame.service),
            String(frame.method),
            args,
          );
          void (async () => {
            try {
              for await (const chunk of iterable) {
                if (ac.signal.aborted || socket.destroyed) break;
                send({ type: 'stream_data', id, data: chunk });
              }
              if (!ac.signal.aborted && !socket.destroyed) {
                send({ type: 'stream_end', id });
              }
            } catch (error) {
              if (!ac.signal.aborted && !socket.destroyed) {
                sendStreamError(id, error);
              }
            } finally {
              activeStreams.delete(id);
            }
          })();
          return;
        }
        case 'stream_cancel': {
          const ac = activeStreams.get(id);
          if (ac !== undefined) {
            ac.abort();
            activeStreams.delete(id);
          }
          return;
        }
        default:
          return;
      }
    };

    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk.toString('utf8'))) {
        handleFrame(frame);
      }
    });
    const teardown = (): void => {
      for (const sub of listens.values()) sub.dispose();
      listens.clear();
      for (const ac of activeStreams.values()) ac.abort();
      activeStreams.clear();
      for (const controller of activeCalls.values()) controller.abort();
      activeCalls.clear();
      connections.delete(socket);
    };
    socket.on('close', teardown);
    socket.on('error', teardown);

    send({ type: 'ready' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPath, resolve);
  });

  return {
    socketPath: options.socketPath,
    close: () => {
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      return new Promise<void>((resolve) => {
        server.close(() => {
          const cleanup = process.platform === 'win32' ? Promise.resolve() : unlink(listenPath);
          void cleanup.then(
            () => {
              resolve();
            },
            () => {
              resolve();
            },
          );
        });
      });
    },
  };
}
