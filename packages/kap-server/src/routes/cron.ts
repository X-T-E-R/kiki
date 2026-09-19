import {
  CRON_SESSION_TAG,
  CRON_SECTION,
  IConfigService,
  ICronTaskPersistence,
  ISessionContext,
  ISessionCronService,
  ISessionManager,
  computeNextCronRun,
  cronToHuman,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
  parseCronExpression,
  resolveClockSources,
  resumeSessionById,
  SYSTEM_CLOCKS,
  type CronConfig,
  type CronTask,
  type Scope,
} from '@kiki/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  cronTaskActionQuerySchema,
  cronTaskActionResponseSchema,
  deleteCronTaskResponseSchema,
  listCronTasksQuerySchema,
  listCronTasksResponseSchema,
  runCronTaskResponseSchema,
} from '../protocol/rest-cron';
import { parseActionSuffix } from './action-suffix';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_THRESHOLD_MS = 7 * MS_PER_DAY;
const PROMPT_PREVIEW_BYTES = 200;

interface CronRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown; query: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown; query: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

interface LocatedCronTask {
  readonly workspaceId: string;
  readonly sessionId: string | undefined;
  readonly task: CronTask;
  readonly liveCron: ISessionCronService | undefined;
}

interface CronPresentationContext {
  readonly now: number;
  readonly noJitter: boolean;
  readonly noStale: boolean;
}

interface CronTaskWire {
  readonly id: string;
  readonly session_id: string | null;
  readonly workspace_id: string;
  readonly cron: string;
  readonly human_schedule: string;
  readonly prompt_preview: string;
  readonly next_fire_at: string | null;
  readonly recurring: boolean;
  readonly paused: boolean;
  readonly age_days: number;
  readonly stale: boolean;
  readonly created_at: string;
  readonly last_fired_at: string | null;
}

const actionParamsSchema = z.object({ tail: z.string().min(1) });
const taskParamsSchema = z.object({ task_id: z.string().min(1) });
const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerCronRoutes(app: CronRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/cron',
      querystring: listCronTasksQuerySchema,
      success: { data: listCronTasksResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
      },
      description: 'List scheduled cron tasks across sessions',
      tags: ['cron'],
    },
    async (req, reply) => {
      const context = await presentationContext(core);
      const query = req.query as { session_id?: string };
      const located = await collectCronTasks(core);
      const items = located
        .filter((entry) => query.session_id === undefined || entry.sessionId === query.session_id)
        .map((entry) => toWireTask(entry, context))
        .toSorted(compareCronTasks);
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<CronRouteHost['get']>[2]);

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/cron/{tail}',
      params: actionParamsSchema,
      querystring: cronTaskActionQuerySchema,
      success: { data: cronTaskActionResponseSchema.or(runCronTaskResponseSchema) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TASK_NOT_FOUND]: {},
      },
      description: 'Pause, resume, or immediately trigger a cron task',
      tags: ['cron'],
    },
    async (req, reply) => {
      const parsed = parseActionSuffix({
        tail: req.params.tail,
        allowedActions: ['pause', 'resume', 'run'] as const,
        resourceLabel: 'task',
      });
      if (parsed.kind !== 'action') {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${req.params.tail}`,
            req.id,
          ),
        );
        return;
      }

      const query = req.query as { session_id?: string };
      const resolved = await locateCronTask(core, parsed.id, query.session_id);
      if (resolved.kind === 'ambiguous') {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `cron task ${parsed.id} exists in multiple sessions; pass session_id`,
            req.id,
          ),
        );
        return;
      }
      if (resolved.kind === 'not_found') {
        reply.send(taskNotFound(parsed.id, req.id));
        return;
      }

      if (parsed.action === 'run') {
        if (resolved.task.sessionId === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.SESSION_NOT_FOUND,
              `cron task ${parsed.id} is not associated with a session`,
              req.id,
            ),
          );
          return;
        }
        const handle = await resumeSessionById(core.accessor, resolved.task.sessionId);
        if (handle === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.SESSION_NOT_FOUND,
              `session ${resolved.task.sessionId} does not exist`,
              req.id,
            ),
          );
          return;
        }
        const cron = handle.accessor.get(ISessionCronService);
        if (cron.getTask(parsed.id) === undefined) {
          reply.send(taskNotFound(parsed.id, req.id));
          return;
        }
        if (!(await cron.fireTaskNow(parsed.id))) {
          throw new Error(`cron task ${parsed.id} could not be triggered`);
        }
        requestLog(req)?.info(
          { task_id: parsed.id, session_id: resolved.task.sessionId },
          'cron task triggered',
        );
        reply.send(okEnvelope({ triggered: true as const }, req.id));
        return;
      }

      const paused = parsed.action === 'pause';
      const updated = await setCronTaskPaused(core, resolved.task, paused);
      if (updated === undefined) {
        reply.send(taskNotFound(parsed.id, req.id));
        return;
      }
      requestLog(req)?.info(
        { task_id: parsed.id, session_id: updated.sessionId, paused },
        paused ? 'cron task paused' : 'cron task resumed',
      );
      const context = await presentationContext(core);
      reply.send(okEnvelope({ task: toWireTask(updated, context) }, req.id));
    },
  );
  app.post(
    actionRoute.path,
    actionRoute.options,
    actionRoute.handler as Parameters<CronRouteHost['post']>[2],
  );

  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/cron/{task_id}',
      params: taskParamsSchema,
      querystring: cronTaskActionQuerySchema,
      success: { data: deleteCronTaskResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.TASK_NOT_FOUND]: {},
      },
      description: 'Delete a cron task',
      tags: ['cron'],
    },
    async (req, reply) => {
      const query = req.query as { session_id?: string };
      const resolved = await locateCronTask(core, req.params.task_id, query.session_id);
      if (resolved.kind === 'ambiguous') {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `cron task ${req.params.task_id} exists in multiple sessions; pass session_id`,
            req.id,
          ),
        );
        return;
      }
      if (resolved.kind === 'not_found') {
        reply.send(taskNotFound(req.params.task_id, req.id));
        return;
      }
      if (!(await deleteCronTask(core, resolved.task))) {
        reply.send(taskNotFound(req.params.task_id, req.id));
        return;
      }
      requestLog(req)?.info(
        { task_id: req.params.task_id, session_id: resolved.task.sessionId },
        'cron task deleted',
      );
      reply.send(okEnvelope({ deleted: true as const }, req.id));
    },
  );
  app.delete(
    deleteRoute.path,
    deleteRoute.options,
    deleteRoute.handler as Parameters<CronRouteHost['delete']>[2],
  );
}

async function collectCronTasks(core: Scope): Promise<LocatedCronTask[]> {
  const store = core.accessor.get(ICronTaskPersistence);
  const manager = core.accessor.get(ISessionManager);
  const workspaceIds = new Set(await store.listWorkspaceIds());
  for (const handle of manager.list()) {
    workspaceIds.add(handle.accessor.get(ISessionContext).workspaceId);
  }

  const tasks = new Map<string, LocatedCronTask>();
  for (const workspaceId of workspaceIds) {
    for (const task of await store.list({ workspaceId })) {
      tasks.set(taskKey(workspaceId, task.id), {
        workspaceId,
        sessionId: task.tags?.[CRON_SESSION_TAG],
        task,
        liveCron: undefined,
      });
    }
  }

  for (const handle of manager.list()) {
    const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
    const cron = handle.accessor.get(ISessionCronService);
    for (const task of cron.list()) {
      tasks.set(taskKey(workspaceId, task.id), {
        workspaceId,
        sessionId: task.tags?.[CRON_SESSION_TAG] ?? handle.id,
        task,
        liveCron: cron,
      });
    }
  }
  return [...tasks.values()];
}

async function locateCronTask(
  core: Scope,
  taskId: string,
  sessionId?: string,
): Promise<
  | { readonly kind: 'found'; readonly task: LocatedCronTask }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'ambiguous' }
> {
  const matches = (await collectCronTasks(core)).filter(
    (entry) => entry.task.id === taskId && (sessionId === undefined || entry.sessionId === sessionId),
  );
  if (matches.length === 0) return { kind: 'not_found' };
  if (matches.length > 1) return { kind: 'ambiguous' };
  return { kind: 'found', task: matches[0] as LocatedCronTask };
}

async function setCronTaskPaused(
  core: Scope,
  located: LocatedCronTask,
  paused: boolean,
): Promise<LocatedCronTask | undefined> {
  const manager = core.accessor.get(ISessionManager);
  const store = core.accessor.get(ICronTaskPersistence);
  const apply = async (): Promise<LocatedCronTask | undefined> => {
    const live = located.sessionId === undefined ? undefined : manager.get(located.sessionId);
    if (live !== undefined) {
      const cron = live.accessor.get(ISessionCronService);
      const updated = await cron.setTaskPaused(located.task.id, paused);
      if (updated === undefined) return undefined;
      return { ...located, task: updated, liveCron: cron };
    }
    const current = await store.get(located.workspaceId, located.task.id);
    if (current === undefined || current.tags?.[CRON_SESSION_TAG] !== located.sessionId) {
      return undefined;
    }
    const updated: CronTask = { ...current, paused };
    await store.save(located.workspaceId, updated);
    return { ...located, task: updated, liveCron: undefined };
  };

  if (located.sessionId === undefined) return apply();
  return manager.withLifecycleSerialization(located.sessionId, async () => {
    await manager.whenResumeSettled(located.sessionId as string).catch(() => undefined);
    return apply();
  });
}

async function deleteCronTask(core: Scope, located: LocatedCronTask): Promise<boolean> {
  const manager = core.accessor.get(ISessionManager);
  const store = core.accessor.get(ICronTaskPersistence);
  const apply = async (): Promise<boolean> => {
    const live = located.sessionId === undefined ? undefined : manager.get(located.sessionId);
    if (live !== undefined) {
      const cron = live.accessor.get(ISessionCronService);
      if (cron.removeTasks([located.task.id]).length === 0) return false;
      await cron.flushPersist();
      return true;
    }
    const current = await store.get(located.workspaceId, located.task.id);
    if (current === undefined || current.tags?.[CRON_SESSION_TAG] !== located.sessionId) return false;
    await store.delete(located.workspaceId, located.task.id);
    return true;
  };

  if (located.sessionId === undefined) return apply();
  return manager.withLifecycleSerialization(located.sessionId, async () => {
    await manager.whenResumeSettled(located.sessionId as string).catch(() => undefined);
    return apply();
  });
}

async function presentationContext(core: Scope): Promise<CronPresentationContext> {
  const config = core.accessor.get(IConfigService);
  await config.ready;
  const cronConfig = config.get<CronConfig>(CRON_SECTION);
  const clocks = resolveClockSources(cronConfig.clock, cronConfig.debug) ?? SYSTEM_CLOCKS;
  return {
    now: clocks.wallNow(),
    noJitter: cronConfig.noJitter,
    noStale: cronConfig.noStale,
  };
}

function toWireTask(located: LocatedCronTask, context: CronPresentationContext): CronTaskWire {
  const task = located.task;
  let humanSchedule = task.cron;
  let nextFireAt: number | null = null;
  try {
    const parsed = parseCronExpression(task.cron);
    humanSchedule = cronToHuman(parsed);
    nextFireAt = located.liveCron?.getNextFireForTask(task.id) ?? nextFireForColdTask(task, parsed, context);
  } catch {
  }
  const recurring = task.recurring !== false;
  const ageMs = context.now - task.createdAt;
  const ageDays = Number.isFinite(ageMs) ? ageMs / MS_PER_DAY : 0;
  const stale = !context.noStale && recurring && Number.isFinite(ageMs) && ageMs >= STALE_THRESHOLD_MS;
  return {
    id: task.id,
    session_id: located.sessionId ?? null,
    workspace_id: located.workspaceId,
    cron: task.cron,
    human_schedule: humanSchedule,
    prompt_preview: previewPrompt(task.prompt),
    next_fire_at: nextFireAt === null ? null : new Date(nextFireAt).toISOString(),
    recurring,
    paused: task.paused === true,
    age_days: ageDays,
    stale,
    created_at: new Date(task.createdAt).toISOString(),
    last_fired_at: task.lastFiredAt === undefined ? null : new Date(task.lastFiredAt).toISOString(),
  };
}

function nextFireForColdTask(
  task: CronTask,
  parsed: ReturnType<typeof parseCronExpression>,
  context: CronPresentationContext,
): number | null {
  if (task.paused === true) return null;
  const cursor =
    task.lastFiredAt !== undefined && Number.isFinite(task.lastFiredAt) && task.lastFiredAt <= context.now
      ? task.lastFiredAt
      : undefined;
  const base = cursor !== undefined && cursor > task.createdAt ? cursor : task.createdAt;
  const ideal = computeNextCronRun(parsed, base);
  if (ideal === null) return null;
  return task.recurring === false
    ? oneShotJitteredNextCronRunMs(task, ideal, undefined, context.noJitter)
    : jitteredNextCronRunMs(task, parsed, ideal, undefined, context.noJitter);
}

function previewPrompt(prompt: string): string {
  const bytes = Buffer.from(prompt, 'utf8');
  if (bytes.byteLength <= PROMPT_PREVIEW_BYTES) return prompt;
  let end = PROMPT_PREVIEW_BYTES;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return `${bytes.subarray(0, end).toString('utf8')}…(truncated)`;
}

function compareCronTasks(a: CronTaskWire, b: CronTaskWire): number {
  if (a.next_fire_at === null && b.next_fire_at !== null) return 1;
  if (a.next_fire_at !== null && b.next_fire_at === null) return -1;
  if (a.next_fire_at !== null && b.next_fire_at !== null) {
    const byNext = a.next_fire_at.localeCompare(b.next_fire_at);
    if (byNext !== 0) return byNext;
  }
  const byCreated = b.created_at.localeCompare(a.created_at);
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
}

function taskKey(workspaceId: string, taskId: string): string {
  return `${workspaceId}\u0000${taskId}`;
}

function taskNotFound(taskId: string, requestId: string): unknown {
  return errEnvelope(ErrorCode.TASK_NOT_FOUND, `cron task ${taskId} does not exist`, requestId);
}
