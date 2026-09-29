import {
  Error2, ErrorCodes, IAgentRuntimeService, ISessionApprovalService, ISessionInteractionService, ISessionManager, ISessionStateService, ISshHostService,
  sessionSshHostsKey, sshHostFingerprint, type Scope,
} from '@kiki/agent-core-v2';
import { parseTransientSshTarget } from '@kiki/agent-core-v2/app/ssh/sshConfig';
import {
  ErrorCode, sshHostInputSchema, sshHostResponseSchema, sshHostsResponseSchema,
  sshHostStatusSchema, sshSessionHostsResponseSchema, sshApprovalSubmitSchema,
  copySharedSshCredentialsRequestSchema, copySharedSshCredentialsResponseSchema,
} from '@kiki/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { withSessionOperation } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import { parseActionSuffix } from './action-suffix';

type SshHandler = (
  req: { id: string; params: unknown; query: unknown; body: unknown },
  reply: { send(payload: unknown): unknown },
) => Promise<void> | void;

interface SshRouteHost {
  get(path: string, options: { schema?: Record<string, unknown> }, handler: SshHandler): unknown;
  put(path: string, options: { schema?: Record<string, unknown> }, handler: SshHandler): unknown;
  post(path: string, options: { schema?: Record<string, unknown> }, handler: SshHandler): unknown;
  delete(path: string, options: { schema?: Record<string, unknown> }, handler: SshHandler): unknown;
}

const hostId = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const params = z.object({ id: hostId });
const querystring = z.object({ workspace_id: z.string().min(1).optional() });

export function registerSshRoutes(app: SshRouteHost, core: Scope): void {
  const hosts = () => core.accessor.get(ISshHostService);
  const sessions = core.accessor.get(ISessionManager);
  sessions.onWillCloseSession?.((event) => {
    event.waitUntil(hosts().removeSessionTransients(event.sessionId));
  });
  sessions.onDidCloseSession?.(({ sessionId, reason }) => {
    if (reason === 'evict') void hosts().removeSessionTransients(sessionId).catch(() => undefined);
  });
  sessions.onDidDeleteSession?.(({ sessionId }) => {
    void hosts().removeSessionTransients(sessionId).catch(() => undefined);
  });
  const list = defineRoute({
    method: 'GET', path: '/ssh/hosts', querystring,
    success: { data: sshHostsResponseSchema }, tags: ['ssh'],
  }, async (req, reply) => {
    reply.send(okEnvelope({ hosts: await hosts().list(req.query.workspace_id) }, req.id));
  });
  app.get(list.path, list.options, list.handler as SshHandler);

  const discover = defineRoute({
    method: 'GET', path: '/ssh/hosts::discover',
    success: { data: sshHostsResponseSchema }, tags: ['ssh'],
  }, async (req, reply) => {
    reply.send(okEnvelope({ hosts: await hosts().discover() }, req.id));
  });
  app.get(discover.path, discover.options, discover.handler as SshHandler);

  const upsert = defineRoute({
    method: 'PUT', path: '/ssh/hosts/{id}', params, querystring,
    body: sshHostInputSchema,
    success: { data: sshHostResponseSchema }, tags: ['ssh'],
    errors: { [ErrorCode.VALIDATION_FAILED]: {} },
  }, async (req, reply) => {
    try {
      await hosts().upsert({ ...req.body, id: req.params.id }, req.query.workspace_id);
      const record = (await hosts().list(req.query.workspace_id)).find((entry) => entry.id === req.params.id);
      if (record === undefined) throw new Error('Host disappeared after update');
      reply.send(okEnvelope({ host: record }, req.id));
    } catch (error) {
      if (error instanceof Error && /^Invalid SSH|^SSH roots|^SSH host name/.test(error.message)) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
        return;
      }
      throw error;
    }
  });
  app.put(upsert.path, upsert.options, upsert.handler as SshHandler);

  const remove = defineRoute({
    method: 'DELETE', path: '/ssh/hosts/{id}', params, querystring,
    success: { data: z.object({ removed: z.literal(true) }) }, tags: ['ssh'],
  }, async (req, reply) => {
    await hosts().remove(req.params.id, req.query.workspace_id);
    reply.send(okEnvelope({ removed: true }, req.id));
  });
  app.delete(remove.path, remove.options, remove.handler as SshHandler);

  const sync = defineRoute({
    method: 'PUT', path: '/ssh/config-sync',
    body: z.object({ enabled: z.boolean() }),
    success: { data: z.object({ enabled: z.boolean() }) }, tags: ['ssh'],
  }, async (req, reply) => {
    await hosts().setSyncSshConfig(req.body.enabled);
    reply.send(okEnvelope({ enabled: req.body.enabled }, req.id));
  });
  app.put(sync.path, sync.options, sync.handler as SshHandler);

  const approvalStatus = defineRoute({
    method: 'GET', path: '/ssh/connection-approval',
    success: { data: z.object({ enabled: z.boolean() }) }, tags: ['ssh'],
  }, async (req, reply) => {
    reply.send(okEnvelope({ enabled: await hosts().connectionApprovalEnabled() }, req.id));
  });
  app.get(approvalStatus.path, approvalStatus.options, approvalStatus.handler as SshHandler);

  const approvalUpdate = defineRoute({
    method: 'PUT', path: '/ssh/connection-approval',
    body: z.object({ enabled: z.boolean() }),
    success: { data: z.object({ enabled: z.boolean() }) }, tags: ['ssh'],
  }, async (req, reply) => {
    await hosts().setConnectionApproval(req.body.enabled);
    reply.send(okEnvelope({ enabled: req.body.enabled }, req.id));
  });
  app.put(approvalUpdate.path, approvalUpdate.options, approvalUpdate.handler as SshHandler);

  const copyCredentials = defineRoute({
    method: 'POST', path: '/ssh/credentials:copy-to-isolated',
    body: copySharedSshCredentialsRequestSchema,
    success: { data: copySharedSshCredentialsResponseSchema }, tags: ['ssh'],
    errors: { [ErrorCode.VALIDATION_FAILED]: {} },
  }, async (req, reply) => {
    try {
      reply.send(okEnvelope({ hosts: await hosts().copySharedCredentialsToIsolated(req.body.hosts) }, req.id));
    } catch (error) {
      if (error instanceof Error && (/^SSH credential copying requires|^Unknown Kiki SSH host/.test(error.message))) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
        return;
      }
      throw error;
    }
  });
  app.post(copyCredentials.path, copyCredentials.options, copyCredentials.handler as SshHandler);

  const actionParams = z.object({ tail: z.string().min(1) });
  const status = defineRoute({
    method: 'GET', path: '/ssh/hosts/{tail}', params: actionParams, querystring,
    success: { data: sshHostStatusSchema }, tags: ['ssh'],
    errors: { [ErrorCode.SSH_HOST_NOT_FOUND]: {}, [ErrorCode.VALIDATION_FAILED]: {} },
  }, async (req, reply) => {
    const action = parseActionSuffix({ tail: req.params.tail, allowedActions: ['status'], resourceLabel: 'ssh host' });
    if (action.kind !== 'action' || !hostId.safeParse(action.id).success) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Unsupported SSH host action', req.id));
      return;
    }
    if (!(await hosts().list(req.query.workspace_id)).some((entry) => entry.id === action.id)) {
      reply.send(errEnvelope(ErrorCode.SSH_HOST_NOT_FOUND, 'Unknown SSH host', req.id));
      return;
    }
    reply.send(okEnvelope(hosts().status(action.id, req.query.workspace_id), req.id));
  });
  app.get(status.path, status.options, status.handler as SshHandler);

  const action = defineRoute({
    method: 'POST', path: '/ssh/hosts/{tail}', params: actionParams, querystring,
    success: { data: z.union([z.object({ written: z.literal(true) }), z.object({ disconnected: z.literal(true) })]) }, tags: ['ssh'],
    errors: { [ErrorCode.SSH_HOST_NOT_FOUND]: {}, [ErrorCode.VALIDATION_FAILED]: {} },
  }, async (req, reply) => {
    const parsed = parseActionSuffix({ tail: req.params.tail, allowedActions: ['write-back', 'disconnect'], resourceLabel: 'ssh host' });
    if (parsed.kind !== 'action' || !hostId.safeParse(parsed.id).success) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Unsupported SSH host action', req.id));
      return;
    }
    const record = (await hosts().list(req.query.workspace_id)).find((entry) => entry.id === parsed.id);
    if (record === undefined) {
      reply.send(errEnvelope(ErrorCode.SSH_HOST_NOT_FOUND, 'Unknown SSH host', req.id));
      return;
    }
    if (parsed.action === 'disconnect') {
      await hosts().disconnect(parsed.id, req.query.workspace_id);
      reply.send(okEnvelope({ disconnected: true }, req.id));
      return;
    }
    if (record.source !== 'kiki' || record.hostname === undefined || record.user === undefined) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Only Kiki hosts with explicit hostname and user can be written back', req.id));
      return;
    }
    try {
      await hosts().writeBack(parsed.id, req.query.workspace_id);
      reply.send(okEnvelope({ written: true }, req.id));
    } catch (error) {
      if (error instanceof Error && /already exists/.test(error.message)) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
      } else throw error;
    }
  });
  app.post(action.path, action.options, action.handler as SshHandler);

  const sessionParams = z.object({ session_id: z.string().min(1) });
  const sessionHostParams = sessionParams.extend({
    host_id: z.string().min(1).refine((value) => hostId.safeParse(value).success || parseTransientSshTarget(value) !== undefined),
  });
  const sessionList = defineRoute({
    method: 'GET', path: '/sessions/{session_id}/ssh/hosts', params: sessionParams,
    success: { data: sshSessionHostsResponseSchema }, tags: ['ssh'],
    errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
  }, async (req, reply) => {
    await withSessionSsh(core, req.params.session_id, async (state, workspaceId) => {
      const joined = state.get(sessionSshHostsKey);
      const configured = await hosts().list(workspaceId, req.params.session_id);
      reply.send(okEnvelope({ hosts: configured.filter((host) => joined[host.id] !== undefined)
        .map((host) => ({ host, status: hosts().status(host.id, workspaceId) })) }, req.id));
    });
  });
  app.get(sessionList.path, sessionList.options, sessionList.handler as SshHandler);

  const sessionAdd = defineRoute({
    method: 'PUT', path: '/sessions/{session_id}/ssh/hosts/{host_id}', params: sessionHostParams,
    success: { data: sshHostResponseSchema }, tags: ['ssh'],
    errors: { [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.SSH_HOST_NOT_FOUND]: {} },
  }, async (req, reply) => {
    await withSessionSsh(core, req.params.session_id, async (state, workspaceId) => {
      const host = (await hosts().list(workspaceId)).find((entry) => entry.id === req.params.host_id);
      if (host === undefined) {
        reply.send(errEnvelope(ErrorCode.SSH_HOST_NOT_FOUND, 'Unknown SSH host', req.id));
        return;
      }
      const fingerprint = sshHostFingerprint(host, await hosts().resolveTarget(host.id, workspaceId));
      const current = (await hosts().list(workspaceId)).find((entry) => entry.id === host.id);
      if (current === undefined || sshHostFingerprint(current, await hosts().resolveTarget(host.id, workspaceId)) !== fingerprint) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'SSH host changed while joining session', req.id));
        return;
      }
      state.set(sessionSshHostsKey, { ...state.get(sessionSshHostsKey), [host.id]: fingerprint });
      reply.send(okEnvelope({ host }, req.id));
    });
  });
  app.put(sessionAdd.path, sessionAdd.options, sessionAdd.handler as SshHandler);

  const sessionRemove = defineRoute({
    method: 'DELETE', path: '/sessions/{session_id}/ssh/hosts/{host_id}', params: sessionHostParams,
    success: { data: z.object({ removed: z.literal(true) }) }, tags: ['ssh'],
    errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
  }, async (req, reply) => {
    await withSessionSsh(core, req.params.session_id, async (state, workspaceId) => {
      await hosts().removeTransient(req.params.host_id, workspaceId, req.params.session_id);
      const joined = { ...state.get(sessionSshHostsKey) };
      delete joined[req.params.host_id];
      state.set(sessionSshHostsKey, joined);
      reply.send(okEnvelope({ removed: true }, req.id));
    });
  });
  app.delete(sessionRemove.path, sessionRemove.options, sessionRemove.handler as SshHandler);

  const submitApproval = defineRoute({
    method: 'POST', path: '/sessions/{session_id}/ssh/approvals/{approval_id}',
    params: z.object({ session_id: z.string().min(1), approval_id: z.string().min(1) }),
    body: sshApprovalSubmitSchema,
    success: { data: z.object({ resolved: z.literal(true) }) }, tags: ['ssh'],
    errors: { [ErrorCode.APPROVAL_NOT_FOUND]: {}, [ErrorCode.VALIDATION_FAILED]: {} },
  }, async (req, reply) => {
    await withSessionOperation(core, req.params.session_id, async (session) => {
      if (session === undefined) {
        reply.send(errEnvelope(ErrorCode.APPROVAL_NOT_FOUND, 'SSH approval not found', req.id));
        return;
      }
      const interaction = session.accessor.get(ISessionInteractionService)
        .listPending('approval').find((entry) => entry.id === req.params.approval_id);
      const detail = (interaction?.payload as { ssh?: { kind: string; prompts?: readonly unknown[] } } | undefined)?.ssh;
      if (detail === undefined) {
        reply.send(errEnvelope(ErrorCode.APPROVAL_NOT_FOUND, 'SSH approval not found', req.id));
        return;
      }
      if ((detail.kind === 'host_key' && req.body.credential !== undefined) ||
          (req.body.decision !== 'approved' && req.body.credential !== undefined) ||
          (req.body.credential?.answers !== undefined &&
            req.body.credential.answers.length !== (detail.prompts?.length ?? 0))) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Invalid SSH approval submission', req.id));
        return;
      }
      session.accessor.get(ISessionApprovalService).decideSsh(req.params.approval_id, { decision: req.body.decision }, req.body.credential);
      reply.send(okEnvelope({ resolved: true }, req.id));
    });
  });
  app.post(submitApproval.path, submitApproval.options, submitApproval.handler as SshHandler);
}

async function withSessionSsh<T>(
  core: Scope, sessionId: string,
  work: (state: ISessionStateService, workspaceId: string) => Promise<T>,
): Promise<T> {
  return withSessionOperation(core, sessionId, async (session) => {
    if (session === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    const agent = await ensureMainAgent(session);
    const workspaceId = agent.accessor.get(IAgentRuntimeService).inspect().identity.workspaceId;
    return work(session.accessor.get(ISessionStateService), workspaceId);
  });
}
