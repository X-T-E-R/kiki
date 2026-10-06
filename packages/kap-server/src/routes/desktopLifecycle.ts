import { z } from 'zod';
import { IBootstrapService, ISessionManager, ISessionActivityView, IAgentLifecycleService, IAgentLoopService, IAgentPromptService, IAgentExecutionService, IAgentTaskService, type Scope } from '@kiki/agent-core-v2';
import { desktopLifecycleRequestSchema, desktopLifecycleStateSchema, type DesktopLifecycleState } from '@kiki/protocol';
import { defineRoute } from '../middleware/defineRoute';
import { errEnvelope, okEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';

export function desktopPendingWork(core: Scope): string[] {
  const sessions = core.accessor.get(ISessionManager);
  return [...new Set([...sessions.list(), ...sessions.listEphemeral()])].filter(session => {
    const activity = session.accessor.get(ISessionActivityView).state();
    if (activity.busy || activity.pendingInteraction !== 'none') return true;
    for (const agent of session.accessor.get(IAgentLifecycleService).list()) {
      const loop = agent.accessor.get(IAgentLoopService).status();
      const prompt = agent.accessor.get(IAgentPromptService);
      const queue = prompt.list();
      const execution = agent.accessor.get(IAgentExecutionService).status();
      if (execution.state === 'starting' || execution.state === 'running' || execution.state === 'cancelling' ||
        loop.state === 'running' || loop.finalizing || loop.persistenceFailure || loop.hasPendingRequests || loop.pendingTurnIds.length > 0 ||
        prompt.hasReadyPending() || queue.active !== undefined || queue.launching !== undefined || queue.pending.length > 0 ||
        agent.accessor.get(IAgentTaskService).hasUnfinishedWork()) return true;
    }
    return false;
  }).map(session => session.id);
}

export function registerDesktopLifecycleRoutes(app: {
  get: (path: string, options: object, handler: (...args: never[]) => unknown) => unknown;
  post: (path: string, options: object, handler: (...args: never[]) => unknown) => unknown;
  addHook: (name: 'onRequest', handler: (...args: never[]) => unknown) => unknown;
}, core: Scope, opts: { serverId: string; onShutdown: () => void }): void {
  const bootstrap = core.accessor.get(IBootstrapService);
  let draining = false;
  const state = (): DesktopLifecycleState => ({ server_id: opts.serverId, home_id: bootstrap.spaceId ?? 'main', managed: bootstrap.getEnv('KIKI_DESKTOP_BUNDLED') === '1', draining, work_pending: desktopPendingWork(core), impact: 'all-windows-in-this-space' });
  app.addHook('onRequest', ((req: { id: string; method: string }, reply: { send: (value: unknown) => unknown }, done: () => void) => {
    if (draining && req.method !== 'GET') { reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'This space is draining for a desktop restart or update; reconnect when it is ready', req.id)); return; }
    done();
  }) as never);
  const read = defineRoute({ method: 'GET', path: '/desktop-lifecycle', success: { data: desktopLifecycleStateSchema }, description: 'Read desktop service ownership and the scope of an explicit restart or update', tags: ['meta'] }, (req, reply) => { reply.send(okEnvelope(state(), req.id)); });
  app.get(read.path, read.options, read.handler as never);
  const mutate = defineRoute({ method: 'POST', path: '/desktop-lifecycle', body: desktopLifecycleRequestSchema, success: { data: z.object({ ok: z.literal(true) }) }, errors: { [ErrorCode.CAPABILITY_UNSUPPORTED]: {}, [ErrorCode.VALIDATION_FAILED]: {} }, description: 'Consent to drain and stop exactly this desktop-managed service', tags: ['meta'] }, (req, reply) => {
    const current = state();
    if (!current.managed) { reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'This service is externally managed; stop it through its owner before updating', req.id)); return; }
    if (req.body.server_id !== opts.serverId) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'The service changed; review the affected space again', req.id)); return; }
    if (current.work_pending.length > 0 && !req.body.interrupt_work) { reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'Unfinished work will be cancelled and drained; confirm this impact before continuing', req.id)); return; }
    draining = true;
    reply.send(okEnvelope({ ok: true }, req.id));
    setImmediate(opts.onShutdown);
  });
  app.post(mutate.path, mutate.options, mutate.handler as never);
}
