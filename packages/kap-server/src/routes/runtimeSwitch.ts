import { Error2, ErrorCodes, IWorkAdmissionService, type Scope } from '@kiki/agent-core-v2';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { desktopPendingWork } from './desktopLifecycle';
import { managedWriterSchema, type ManagedWriter } from '../runtime/runtimeStore';

export interface RuntimeSwitchOwner {
  state(): ManagedWriter;
  update(patch: Partial<Pick<ManagedWriter, 'phase' | 'operationId' | 'port'>>): void;
}

export function createUnmanagedRuntimeSwitchOwner(identity: {
  readonly serverId: string;
  readonly homeId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly host: string;
  readonly port: number;
  readonly serverVersion: string;
  readonly buildId?: string;
  readonly buildChannel?: string;
}): RuntimeSwitchOwner {
  let current: ManagedWriter = {
    serverId: identity.serverId,
    homeId: identity.homeId,
    pid: identity.pid,
    generation: 1,
    ownerId: identity.serverId,
    startedAt: identity.startedAt,
    host: identity.host,
    port: identity.port,
    serverVersion: identity.serverVersion,
    buildId: identity.buildId,
    buildChannel: identity.buildChannel,
    phase: 'ready',
    updatedAt: Date.now(),
    warnings: [],
  };
  return {
    state: () => current,
    update: (patch) => {
      current = { ...current, ...patch, updatedAt: Date.now() };
      return current;
    },
  };
}

interface RuntimeRouteHost {
  get(path: string, options: object, handler: (...args: never[]) => unknown): unknown;
  post(path: string, options: object, handler: (...args: never[]) => unknown): unknown;
  log: { error(data: object, message: string): unknown };
}

export function registerRuntimeSwitchRoutes(app: RuntimeRouteHost, core: Scope, owner: RuntimeSwitchOwner, shutdown: () => void, signal: AbortSignal): void {
  const admission = core.accessor.get(IWorkAdmissionService);
  let autoShutdown = true;
  const snapshot = () => ({ writer: owner.state(), admission: admission.state(), workPending: desktopPendingWork(core) });
  const response = z.object({ writer: managedWriterSchema, admission: z.object({ operationId: z.string().optional(),
    pending: z.array(z.object({ kind: z.string(), startedAt: z.number() })) }), workPending: z.array(z.string()) });
  const read = defineRoute({ method: 'GET', path: '/api/runtime-switch', success: { data: response } }, (req, reply) => {
    reply.send(okEnvelope(snapshot(), req.id));
  });
  app.get(read.path, read.options, read.handler as never);

  async function drain(operationId: string): Promise<void> {
    while (!signal.aborted && owner.state().operationId === operationId && owner.state().phase === 'draining') {
      if (admission.state().pending.length === 0 && desktopPendingWork(core).length === 0) {
        if (!autoShutdown) return;
        owner.update({ phase: 'stopping' });
        shutdown();
        return;
      }
      await delay(200, undefined, { signal });
    }
  }

  const mutate = defineRoute({ method: 'POST', path: '/api/runtime-switch',
    body: z.object({ operationId: z.string().min(1).max(256), serverId: z.string().min(1), action: z.enum(['prepare', 'fence', 'cancel']) }),
    success: { data: response },
  }, (req, reply) => {
    const current = owner.state();
    if (req.body.serverId !== current.serverId) throw new Error2(ErrorCodes.REQUEST_INVALID, 'The managed server identity changed. Reconnect before switching.');
    if (req.body.action === 'cancel') {
      if (current.operationId !== req.body.operationId || current.phase !== 'draining') throw new Error2(ErrorCodes.REQUEST_INVALID, 'This switch is no longer waiting.');
      autoShutdown = true;
      owner.update({ phase: 'ready', operationId: undefined });
      admission.reopen(req.body.operationId);
    } else if (current.operationId !== req.body.operationId) {
      if (current.phase !== 'ready' || current.operationId !== undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Another switch already owns this managed server.');
      autoShutdown = req.body.action === 'prepare';
      admission.fence(req.body.operationId);
      try { owner.update({ phase: 'draining', operationId: req.body.operationId }); }
      catch (error) { admission.reopen(req.body.operationId); throw error; }
      if (autoShutdown) {
        setImmediate(() => { void drain(req.body.operationId).catch(error => {
          if (signal.aborted) return;
          app.log.error({ error, operationId: req.body.operationId }, 'managed server natural drain failed; admission remains fenced');
        }); });
      }
    } else if (req.body.action === 'prepare' && !autoShutdown) {
      autoShutdown = true;
      setImmediate(() => { void drain(req.body.operationId).catch(error => {
        if (signal.aborted) return;
        app.log.error({ error, operationId: req.body.operationId }, 'managed server natural drain failed; admission remains fenced');
      }); });
    }
    reply.send(okEnvelope(snapshot(), req.id));
  });
  app.post(mutate.path, mutate.options, mutate.handler as never);
}
