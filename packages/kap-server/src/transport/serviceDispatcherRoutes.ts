import type { Scope } from '@kiki/agent-core-v2';

import { requestLog } from '../lib/requestLog';
import { okEnvelope } from '../protocol/envelope';
import { ErrorCode } from '../protocol/error-codes';
import type { ScopeKind } from './channel';
import {
  type ChannelDescriptor,
  describeAllChannels,
  resolveAnyScopedServiceId,
} from './channelRegistry';
import { type ChannelLookup, dispatch } from './dispatcher';
import { TimeoutError, mapError, validationEnvelope } from './errors';

interface RpcRequest {
  readonly id: string;
  readonly method: string;
  readonly body: unknown;
  readonly query: unknown;
  readonly params: unknown;
  readonly headers: Record<string, unknown>;
}

interface RpcReply {
  readonly raw: {
    readonly writableFinished: boolean;
    readonly destroyed: boolean;
    once(event: 'close', listener: () => void): unknown;
    off(event: 'close', listener: () => void): unknown;
  };
  status(code: number): { send(payload: unknown): unknown };
  send(payload: unknown): unknown;
}

export interface RouteHost {
  get(path: string, handler: (req: RpcRequest, reply: RpcReply) => Promise<unknown>): unknown;
  post(path: string, handler: (req: RpcRequest, reply: RpcReply) => Promise<unknown>): unknown;
}

export interface ServiceDispatcherRouteOptions {
  /** Per-call deadline in ms. Default 30s. */
  readonly callTimeoutMs?: number;
  /** Channel name → identifier resolution. Default: the full scoped DI registry. */
  readonly lookup?: ChannelLookup;
  /** Descriptor source for `GET {basePath}/channels`. Default: every scoped Service. */
  readonly describe?: () => readonly ChannelDescriptor[];
}

/**
 * Mount the reflection dispatcher under `basePath` (e.g. `/debug` inside the
 * prefixed `/api` plugin): the three scope routes plus
 * `GET {basePath}/channels` for introspection. `channels` is a single segment,
 * so it cannot collide with `:service/:method`.
 */
export function registerServiceDispatcherRoutes(
  app: RouteHost,
  core: Scope,
  basePath: string,
  opts: ServiceDispatcherRouteOptions = {},
): void {
  const lookup = opts.lookup ?? ((name) => resolveAnyScopedServiceId(core, name));
  const scopeRoutes: { path: string; scopeKind: ScopeKind }[] = [
    { path: `${basePath}/:service/:method`, scopeKind: 'core' },
    { path: `${basePath}/session/:session_id/:service/:method`, scopeKind: 'session' },
    {
      path: `${basePath}/session/:session_id/agent/:agent_id/:service/:method`,
      scopeKind: 'agent',
    },
  ];
  for (const { path, scopeKind } of scopeRoutes) {
    const handler = makeHandler(core, scopeKind, opts, lookup);
    app.get(path, handler);
    app.post(path, handler);
  }

  const describe = opts.describe ?? describeAllChannels;
  app.get(`${basePath}/channels`, async (req, reply) =>
    reply.send(okEnvelope(describe(), req.id)),
  );
}

function makeHandler(
  core: Scope,
  scopeKind: ScopeKind,
  opts: ServiceDispatcherRouteOptions,
  lookup: ChannelLookup,
): (req: RpcRequest, reply: RpcReply) => Promise<unknown> {
  return async (req, reply) => {
    const requestId = req.id;

    const { service, method } = req.params as { service: string; method: string };

    let arg: unknown;
    try {
      arg = req.method.toUpperCase() === 'GET' ? parseArgFromQuery(req.query) : req.body;
    } catch {
      return reply.send(
        validationEnvelope([{ path: 'arg', message: 'invalid JSON in ?arg=' }], requestId),
      );
    }

    const timeoutMs = opts.callTimeoutMs ?? 30_000;
    const controller = new AbortController();
    let deadlineElapsed = false;
    const deadline = {
      at: timeoutMs > 0 ? performance.now() + timeoutMs : undefined,
      timeoutMs,
      signal: controller.signal,
      elapsed: () => deadlineElapsed,
    };
    let onClose!: () => void;
    const disconnected = new Promise<never>((_resolve, reject) => {
      onClose = () => {
        if (reply.raw.writableFinished) return;
        controller.abort();
        reject(new Error('debug request disconnected'));
      };
      reply.raw.once('close', onClose);
    });
    if (reply.raw.destroyed && !reply.raw.writableFinished) onClose();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      if (timeoutMs <= 0) return;
      timer = setTimeout(() => {
        deadlineElapsed = true;
        reject(new TimeoutError(timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      const result = await Promise.race([
        dispatch(
          core,
          scopeKind,
          req.params as Record<string, string>,
          service,
          method,
          arg,
          lookup,
          deadline,
        ),
        timeout,
        disconnected,
      ]);
      if (controller.signal.aborted) return;
      return reply.send(okEnvelope(result, requestId));
    } catch (error) {
      if (controller.signal.aborted) return;
      const envelope = mapError(error, requestId);
      const log = requestLog(req);
      if (envelope.code === ErrorCode.INTERNAL_ERROR) {
        log?.error({ err: error, service, method }, 'rpc dispatch failed');
      } else {
        log?.warn({ err: error, service, method }, 'rpc dispatch failed');
      }
      return reply.send(error instanceof TimeoutError
        ? { ...envelope, msg: `${envelope.msg}; outcome unknown; the operation may still be running` }
        : envelope);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      reply.raw.off('close', onClose);
    }
  };
}

function parseArgFromQuery(query: unknown): unknown {
  const q = query as Record<string, unknown> | undefined;
  const raw = q?.['arg'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return undefined;
  return JSON.parse(raw) as unknown;
}
