import { join } from 'node:path';

import {
  AgentTaskPersistence,
  IAtomicDocumentStore,
  IFileSystemStorageService,
  IBootstrapService,
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
  IAgentLifecycleService,
  IAgentTaskService,
  ISessionIndex,
  MAIN_AGENT_ID,
  getLiveSessionById,
  type AgentTaskInfo,
  type Scope,
} from '@kiki/agent-core-v2';
import { listAgentTasksQuerySchema, listAgentTasksResponseSchema } from '@kiki/protocol';
import { AgentTasksPageTokenError, readSessionAgentTasks } from '../services/sessionAgentTasks';
import { ErrorCode } from '../protocol/error-codes';
import {
  cancelTaskQuerySchema,
  cancelTaskResultSchema,
  getTaskQuerySchema,
  getTaskResponseSchema,
  listTasksQuerySchema,
  listTasksResponseSchema,
} from '../protocol/rest-task';
import type { Task, TaskKind, TaskStatus } from '../protocol/task';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import { parseActionSuffix } from './action-suffix';

const DEFAULT_TASK_OUTPUT_PREVIEW_BYTES = 32 * 1024;

interface TasksRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionAndTaskIdParamSchema = z.object({
  session_id: z.string().min(1),
  task_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerTasksRoutes(app: TasksRouteHost, core: Scope): void {
  const agentTasksRoute = defineRoute({
    method: 'GET', path: '/sessions/{session_id}/agent-tasks',
    params: sessionIdParamSchema, querystring: listAgentTasksQuerySchema,
    success: { data: listAgentTasksResponseSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: { detailsSchema }, [ErrorCode.SESSION_NOT_FOUND]: {} },
    description: 'Read task metadata across live and persisted session owners without opening agents',
    tags: ['tasks'],
  }, async (req, reply) => {
    const summary = await core.accessor.get(ISessionIndex).get(req.params.session_id);
    if (summary === undefined) { reply.send(sessionNotFound(req.params.session_id, req.id)); return; }
    try {
      reply.send(okEnvelope(await readSessionAgentTasks(core, summary, req.query), req.id));
    } catch (error) {
      if (!(error instanceof AgentTasksPageTokenError)) throw error;
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
    }
  });
  app.get(agentTasksRoute.path, agentTasksRoute.options, agentTasksRoute.handler as Parameters<TasksRouteHost['get']>[2]);

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/tasks',
      params: sessionIdParamSchema,
      querystring: listTasksQuerySchema,
      success: { data: listTasksResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List tasks for a session',
      tags: ['tasks'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const resolved = await resolveSessionTasks(core, session_id);
      if (resolved.kind === 'session_not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }
      if (resolved.kind === 'agent_not_found') {
        reply.send(agentNotFound(session_id, resolved.agentId, req.id));
        return;
      }

      const query = req.query as { status?: TaskStatus; page_size?: number; offset?: number };
      const pageSize = query.page_size ?? 100;
      const offset = query.offset ?? 0;
      if (resolved.persisted !== undefined) {
        const page = await resolved.persisted.list(pageSize, offset);
        reply.send(okEnvelope({
          items: page.items.map((info) => toWireTask(session_id, info)).filter((task) => query.status === undefined || task.status === query.status),
          has_more: page.hasMore,
          next_offset: page.hasMore ? page.nextOffset : undefined,
        }, req.id));
        return;
      }
      const all = resolved.tasks?.list(false, query.status === undefined ? offset + pageSize + 1 : undefined) ?? [];
      const matching = query.status === undefined ? all : all.filter((task) => task.status === query.status);
      const page = matching.slice(offset, offset + pageSize);
      const has_more = matching.length > offset + pageSize;
      const fresh = await Promise.all(page.map(async (info) =>
        (await resolved.tasks?.getTaskSnapshot(info.taskId)) ?? info));
      reply.send(okEnvelope({
        items: fresh.map((info) => toWireTask(session_id, info)),
        has_more,
        next_offset: has_more ? offset + pageSize : undefined,
      }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<TasksRouteHost['get']>[2]);

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/tasks/{task_id}',
      params: sessionAndTaskIdParamSchema,
      querystring: getTaskQuerySchema,
      success: { data: getTaskResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TASK_NOT_FOUND]: {},
      },
      description: 'Get a task by ID',
      tags: ['tasks'],
    },
    async (req, reply) => {
      const { session_id, task_id } = req.params;
      const query = req.query as {
        with_output?: boolean;
        output_bytes?: number;
        agent_id?: string;
      };
      const resolved = await resolveSessionTasks(core, session_id, query.agent_id);
      if (resolved.kind === 'session_not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }
      if (resolved.kind === 'agent_not_found') {
        reply.send(agentNotFound(session_id, resolved.agentId, req.id));
        return;
      }

      const found = resolved.persisted === undefined ? await resolved.tasks?.getTaskSnapshot(task_id)
        : await resolved.persisted.read(task_id);
      if (found === undefined) {
        reply.send(taskNotFound(session_id, task_id, req.id));
        return;
      }

      let output: { preview: string; bytes: number } | undefined;
      if (query.with_output === true && found.receiptVerification !== 'invalid') {
        const tailBytes = query.output_bytes ?? DEFAULT_TASK_OUTPUT_PREVIEW_BYTES;
        try {
          const preview = resolved.persisted === undefined ? await resolved.tasks!.readOutput(task_id, tailBytes)
            : (await resolved.persisted.persistence.readTaskOutputSnapshot(task_id, tailBytes))?.preview ?? '';
          if (preview.length > 0) {
            output = { preview, bytes: Buffer.byteLength(preview, 'utf-8') };
          }
        } catch {
        }
      }

      reply.send(okEnvelope(toWireTask(session_id, found, output), req.id));
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<TasksRouteHost['get']>[2]);

  const cancelRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/tasks/{tail}',
      querystring: cancelTaskQuerySchema,
      success: { data: cancelTaskResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TASK_NOT_FOUND]: {},
        [ErrorCode.TASK_ALREADY_FINISHED]: {
          dataSchema: z.object({ cancelled: z.literal(false) }),
          detailsSchema: z.object({ current_status: z.string() }),
        },
      },
      description: 'Cancel a task',
      tags: ['tasks'],
      operationId: 'cancelTask',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params as {
        session_id: string;
        tail: string;
      };
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['cancel'] as const,
        resourceLabel: 'task',
      });
      if (parsed.kind === 'invalid') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id));
        return;
      }
      if (parsed.kind === 'bare') {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, req.id),
        );
        return;
      }
      const task_id = parsed.id;
      if (!session_id || !task_id) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'invalid path params', req.id));
        return;
      }

      const query = req.query as { agent_id?: string };
      const resolved = await resolveSessionTasks(core, session_id, query.agent_id);
      if (resolved.kind === 'session_not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }
      if (resolved.kind === 'agent_not_found') {
        reply.send(agentNotFound(session_id, resolved.agentId, req.id));
        return;
      }

      const found = resolved.tasks?.getTask(task_id);
      if (found === undefined) {
        reply.send(taskNotFound(session_id, task_id, req.id));
        return;
      }
      const wireStatus = toWireTask(session_id, found).status;
      if (isTerminalStatus(wireStatus)) {
        reply.send(taskAlreadyFinished(session_id, task_id, wireStatus, req.id));
        return;
      }

      await resolved.tasks?.stopByUser(task_id);
      requestLog(req)?.info({ session_id, task_id }, 'task cancelled');
      reply.send(okEnvelope({ cancelled: true as const }, req.id));
    },
  );
  app.post(cancelRoute.path, cancelRoute.options, cancelRoute.handler as Parameters<TasksRouteHost['post']>[2]);
}

const VALID_TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;

class PersistedTasksReader {
  constructor(
    readonly persistence: AgentTaskPersistence,
    private readonly docs: IAtomicDocumentStore,
    private readonly scopes: readonly string[],
    private readonly ownerId: string,
  ) {}

  async read(taskId: string): Promise<AgentTaskInfo | undefined> {
    if (!VALID_TASK_ID.test(taskId)) return undefined;
    const task = await this.persistence.readTask(taskId);
    return task?.ownerAgentId !== undefined && task.ownerAgentId !== this.ownerId ? undefined : task;
  }

  async list(limit: number, offset: number): Promise<{ readonly items: readonly AgentTaskInfo[]; readonly hasMore: boolean; readonly nextOffset: number }> {
    const ids = new Set<string>();
    for (const scope of this.scopes) {
      for (const key of await this.docs.list(`${scope}/tasks`)) {
        if (key.endsWith('.json') && VALID_TASK_ID.test(key.slice(0, -5))) ids.add(key.slice(0, -5));
      }
    }
    const ordered = [...ids].toSorted();
    const end = Math.min(ordered.length, offset + limit);
    const items: AgentTaskInfo[] = [];
    for (const id of ordered.slice(offset, end)) {
      try {
        const task = await this.read(id);
        if (task !== undefined) items.push(task);
      } catch {}
    }
    return { items, hasMore: end < ordered.length, nextOffset: end };
  }
}

type ResolvedTasks =
  | { readonly kind: 'session_not_found' }
  | { readonly kind: 'agent_not_found'; readonly agentId: string }
  | { readonly kind: 'resolved'; readonly tasks: IAgentTaskService | undefined; readonly persisted?: PersistedTasksReader };

async function resolveSessionTasks(
  core: Scope,
  sid: string,
  agentId?: string,
): Promise<ResolvedTasks> {
  const summary = await core.accessor.get(ISessionIndex).get(sid);
  if (summary === undefined) return { kind: 'session_not_found' };

  const session = getLiveSessionById(core.accessor, sid);
  if (session === undefined) {
    const ownerId = agentId ?? MAIN_AGENT_ID;
    if (ownerId === '.' || ownerId === '..' || /[/\\\0]/.test(ownerId) || ownerId.length === 0) {
      return { kind: 'agent_not_found', agentId: ownerId };
    }
    const bootstrap = core.accessor.get(IBootstrapService);
    const scope = sessionScopeOf(workspacePersistenceScope(bootstrap.scope('sessions'), summary.workspaceId), sid);
    const ownerScope = agentScopeOf(scope, ownerId);
    const docs = core.accessor.get(IAtomicDocumentStore);
    const fallback = ownerId === MAIN_AGENT_ID ? { dir: join(bootstrap.homeDir, scope), scope } : undefined;
    const persistence = new AgentTaskPersistence(join(bootstrap.homeDir, ownerScope), ownerScope, docs,
      core.accessor.get(IFileSystemStorageService), fallback);
    const persisted = new PersistedTasksReader(persistence, docs, fallback === undefined ? [ownerScope] : [ownerScope, scope], ownerId);
    return { kind: 'resolved', tasks: undefined, persisted };
  }
  if (agentId !== undefined && agentId !== MAIN_AGENT_ID) {
    const agent = session.accessor.get(IAgentLifecycleService).get(agentId);
    if (agent === undefined) return { kind: 'agent_not_found', agentId };
    return { kind: 'resolved', tasks: agent.accessor.get(IAgentTaskService) };
  }
  const agent = await ensureMainAgent(session);
  const tasks = agent.accessor.get(IAgentTaskService);
  return { kind: 'resolved', tasks };
}

function mapKind(k: AgentTaskInfo['kind']): TaskKind {
  switch (k) {
    case 'process':
      return 'bash';
    case 'agent':
      return 'subagent';
    case 'question':
    case 'media':
      return 'tool';
  }
}

function mapStatus(s: AgentTaskInfo['status']): TaskStatus {
  switch (s) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'failed';
    case 'killed':
      return 'cancelled';
    case 'lost':
      return 'failed';
  }
}

const TERMINAL_WIRE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_WIRE_STATUSES.has(status);
}

function toWireTask(
  sessionId: string,
  info: AgentTaskInfo,
  output?: { preview: string; bytes: number },
): Task {
  const status = mapStatus(info.status);
  const createdIso = new Date(info.startedAt).toISOString();
  const base: Task = {
    id: info.taskId,
    session_id: sessionId,
    kind: mapKind(info.kind),
    description: info.description,
    status,
    created_at: createdIso,
    started_at: createdIso,
    run_in_background: info.detached ?? true,
    receipt: info.receipt,
    receipt_verification: info.receiptVerification,
    total_bytes: info.receipt?.bytes,
  };
  if (info.endedAt !== null && info.endedAt !== undefined) {
    base.completed_at = new Date(info.endedAt).toISOString();
  }
  if (info.kind === 'process' && 'command' in info && typeof info.command === 'string') {
    base.command = info.command;
  }
  if (info.kind === 'process') {
    base.exit_code = info.exitCode;
  }
  if (info.stopReason !== undefined) {
    base.stop_reason = info.stopReason;
  }
  if (info.kind === 'agent' && info.model !== undefined) {
    base.model = info.model;
  }
  if (info.kind === 'agent' && info.thinkingEffort !== undefined) {
    base.thinking_effort = info.thinkingEffort;
  }
  if (info.kind === 'agent' && info.agentId !== undefined) {
    base.agent_id = info.agentId;
  }
  if (info.kind === 'agent' && info.profile !== undefined) {
    base.profile = info.profile;
  }
  if (info.kind === 'agent' && info.parentToolCallId !== undefined) {
    base.parent_tool_call_id = info.parentToolCallId;
  }
  if (output !== undefined) {
    base.output_preview = output.preview;
    base.output_bytes = output.bytes;
  }
  return base;
}

function sessionNotFound(sid: string, requestId: string): unknown {
  return errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${sid} does not exist`, requestId);
}

function agentNotFound(sid: string, agentId: string, requestId: string): unknown {
  return errEnvelope(
    ErrorCode.SESSION_NOT_FOUND,
    `agent ${agentId} does not exist in session ${sid}`,
    requestId,
  );
}

function taskNotFound(sid: string, tid: string, requestId: string): unknown {
  return errEnvelope(
    ErrorCode.TASK_NOT_FOUND,
    `task ${tid} does not exist in session ${sid}`,
    requestId,
  );
}

function taskAlreadyFinished(
  sid: string,
  tid: string,
  currentStatus: TaskStatus,
  requestId: string,
): unknown {
  return {
    code: ErrorCode.TASK_ALREADY_FINISHED,
    msg: `task ${tid} already finished (status: ${currentStatus})`,
    data: { cancelled: false },
    request_id: requestId,
    details: { current_status: currentStatus },
  };
}
