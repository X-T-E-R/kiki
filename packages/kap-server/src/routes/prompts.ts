import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  DEFAULT_AGENT_PROFILE_NAME,
  IBootstrapService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentTaskService,
  IAgentProfileService,
  IAgentToolPolicyService,
  IAgentPromptService,
  IAgentSkillService,
  IEventBus,
  IEventDispatcher,
  IEventService,
  IFileService,
  ISessionMediaStore,
  ISessionMetadata,
  ISessionAgentProfileCatalog,
  ISessionDispatchService,
  ISessionSkillCatalog,
  isUserActivatableSkillType,
  promptMetadataTextFromContentParts,
  ProfileError,
  SubagentCompleted,
  SubagentFailed,
  SubagentStarted,
  SubagentTask,
  emitAgentRunSpawned,
  ILogService,
  ISessionSubagentService,
  submitReservedSkillPrompt,
  type PromptCompletion,
  type PromptExecutionBinding,
  type PromptHandle,
  type PromptQueueSnapshot,
  type PromptReservation,
  type PromptWithSkillsResult,
  reservePrompt,
  promptRetryFor,
  bundledSkillActivations,
  ISessionContext,
  ISessionManager,
  ITelemetryService,
  applyPromptMetadataUpdate,
  isError2,
  Error2,
  ErrorCodes,
  sessionMediaOriginalsDir,
  type ISessionScopeHandle,
  type Scope,
} from '@kiki/agent-core-v2';
import { turnAbortResponseSchema } from '@kiki/protocol';
import { toErrorMessage } from '@kiki/agent-core-v2/_base/errors/errorMessage';
import { abortable } from '@kiki/agent-core-v2/_base/utils/abort';
import { validatePromptRuntimeControls } from '@kiki/agent-core-v2/agent/prompt/runtimeControls';
import { promptLaunchFailure } from '@kiki/agent-core-v2/agent/prompt/promptFailure';
import { PromptAborted } from '@kiki/agent-core-v2/agent/prompt/promptService';
import { delegatorRef } from '@kiki/agent-core-v2/session/agentLifecycle/subagentMetadata';
import { ErrorCode } from '../protocol/error-codes';
import { ensurePromptAuthReady } from '../lib/promptAuth';
import { projectPromptContentParts } from '../services/messages/messageProjection';
import {
  promptAbortResponseSchema,
  promptListResponseSchema,
  promptMoveRequestSchema,
  promptMoveResultSchema,
  promptReplaceRequestSchema,
  promptReplaceResultSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  promptSubmitReceiptSchema,
  promptTimingRequestSchema,
  promptTimingResultSchema,
  promptHoldRequestSchema,
  promptHoldResultSchema,
  type PromptSkillActivation,
} from '../protocol/rest-prompt';
import { z } from 'zod';
import { modelSwitchInputSchema, modelSwitchReceiptSchema, queuedModelSwitchSchema, modelSwitchActionSchema } from '../protocol/rest-model-switch';

import { errEnvelope, okEnvelope } from '../envelope';
import {
  assertPromptFileRefs,
  contentToCoreParts,
  resolvePromptMediaFiles,
  resolvePromptSessionMediaRefs,
  type PromptMediaPreparation,
} from '../lib/promptMedia';
import { requestLog } from '../lib/requestLog';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import { publishedInlineMediaReader } from '../services/publishedMedia';
import type { TranscriptService } from '../services/transcript/transcriptService';
import { acquireSessionOperation, withSessionOperation, type SessionOperationLease } from '../lib/sessionOperationLease';
import { timeRestorePhase } from '@kiki/agent-core-v2/session/agentLifecycle/restoreTiming';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';
import { readPersistedAgentProfileSnapshot } from './agentProfileSnapshot';
import { parseActionSuffix } from './action-suffix';
import { KLIENT_CALL_BODY_LIMIT_BYTES } from '../transport/klient/registerKlientHttp';
import { PromptIngress, type PromptIngressExecution, type PromptIngressResult } from '../services/promptIngress';

export const PROMPT_BODY_LIMIT_BYTES = KLIENT_CALL_BODY_LIMIT_BYTES;

interface PromptRouteHost {
  addHook?(name: 'preClose', hook: () => Promise<void>): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown>; bodyLimit?: number },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const promptActionQuerySchema = z.object({
  agent_id: z.string().min(1).optional(),
  admission: z.literal('durable').optional(),
  queued_only: z.literal('true').optional(),
});

const validationDetailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));
const authProviderDetailsSchema = z.object({ provider_id: z.string() });
const authModelDetailsSchema = z.object({ model_id: z.string(), provider_id: z.string() }).partial();

function promptPayloadFingerprint(payload: z.infer<typeof promptSubmissionSchema>): string {
  const canonical = JSON.stringify(payload, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      : value,
  );
  return createHash('sha256').update(canonical).digest('hex');
}

function projectPromptRetryReceipt(id: string, receipt: import('@kiki/agent-core-v2').PromptRetryReceipt, fallbackContent: z.infer<typeof promptSubmissionSchema>['content']) {
  return promptSubmitResultSchema.parse({
    prompt_id: id, user_message_id: receipt.userMessageId ?? id, status: receipt.status,
    origin: receipt.message?.origin,
    content: receipt.message === undefined ? fallbackContent : projectPromptContentParts(
      receipt.message.content.slice(bundledSkillActivations(receipt.message.origin).length)),
    created_at: receipt.createdAt, append_timing: receipt.appendTiming, revision: receipt.revision,
  });
}

function requireSession(session: ISessionScopeHandle | undefined, sessionId: string): ISessionScopeHandle {
  if (session === undefined) {
    throw new Error2('session.not_found', `session ${sessionId} does not exist`);
  }
  return session;
}

async function resolvePromptFromSession(
  core: Scope,
  session: ISessionScopeHandle,
  agentId?: string,
) {
  const lifecycle = session.accessor.get(IAgentLifecycleService);
  let agent = agentId === undefined || agentId === MAIN_AGENT_ID
    ? await ensureMainAgent(session)
    : lifecycle.get(agentId);
  if (agent === undefined && agentId !== undefined) {
    const metadata = session.accessor.get(ISessionMetadata);
    const meta = (await metadata.read()).agents?.[agentId];
    if (meta === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
    }
    const context = session.accessor.get(ISessionContext);
    const snapshot = await readPersistedAgentProfileSnapshot(
      core,
      context.workspaceId,
      context.sessionId,
      agentId,
      meta,
    );
    if (snapshot === undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Persisted binding metadata for agent "${agentId}" is unavailable`,
        { details: { agentId } },
      );
    }
    agent = await lifecycle.create({
      agentId,
      restoreBinding: {
        profileName: snapshot.profileName,
        routeId: snapshot.routeId,
        modelAlias: snapshot.modelAlias,
        thinkingEffort: snapshot.thinkingLevel,
        thinkingEffortExplicit: snapshot.thinkingEffortExplicit,
        executorId: snapshot.executorId,
        executorProtocol: snapshot.executorProtocol,
      },
    });
  }
  if (agent === undefined) {
    throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
  }
  return {
    agent,
    agentId: agent.id,
    accessor: agent.accessor,
    prompt: agent.accessor.get(IAgentPromptService),
    skill: agent.accessor.get(IAgentSkillService),
    events: agent.accessor.get(IEventBus),
    profile: agent.accessor.get(IAgentProfileService),
    toolPolicy: agent.accessor.get(IAgentToolPolicyService),
  };
}

type ResolvedPromptAgent = Awaited<ReturnType<typeof resolvePromptFromSession>>;

interface PromptRunAdmission {
  readonly reservation: PromptReservation;
  fail(error: unknown): void;
}

async function admitPromptRun(
  core: Scope,
  session: ISessionScopeHandle,
  resolved: ResolvedPromptAgent,
  reservation: PromptReservation,
): Promise<PromptRunAdmission> {
  if (resolved.agentId === MAIN_AGENT_ID) return { reservation, fail: () => {} };
  const meta = (await session.accessor.get(ISessionMetadata).read()).agents?.[resolved.agentId];
  const parentRef = delegatorRef(meta);
  const parentId = parentRef?.kind === 'agent' ? parentRef.agentId : MAIN_AGENT_ID;
  if (parentId === resolved.agentId) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, `Agent "${resolved.agentId}" cannot own its own prompt task`);
  }
  const parent = await resolvePromptFromSession(core, session, parentId);
  const binding = resolved.profile.data();
  const profileName = binding.profileName ?? binding.routeId ?? meta?.displayName ?? resolved.agentId;
  const controller = new AbortController();
  let resolve!: (value: PromptCompletion | PromiseLike<PromptCompletion>) => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<PromptCompletion>((res, rej) => { resolve = res; reject = rej; });
  const taskCompletion = completion.then((settlement) => {
    if (settlement.state === 'completed' || settlement.state === 'blocked') {
      return { result: `Prompt ${settlement.state}` };
    }
    if (settlement.state === 'cancelled') {
      throw controller.signal.reason ?? new Error('terminated');
    }
    const error = settlement.result?.type === 'failed' ? settlement.result.error : undefined;
    throw error instanceof Error ? error : new Error(error === undefined ? 'Prompt failed' : toErrorMessage(error));
  });
  void taskCompletion.catch(() => {});
  const tasks = parent.accessor.get(IAgentTaskService);
  const dispatcher = parent.accessor.get(IEventDispatcher);
  const log = core.accessor.get(ILogService);
  const fail = (error: unknown): void => {
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    reject(reason);
    controller.abort(reason);
  };
  let taskId: string | undefined;
  try {
    const signal = session.accessor.get(ISessionSubagentService).trackPromptRun(
      resolved.agentId, completion, controller.signal,
    );
    taskId = tasks.registerTask(
      new SubagentTask(
        {
          agentId: resolved.agentId,
          profileName,
          model: binding.modelAlias,
          thinkingEffort: binding.effectiveThinkingLevel ?? binding.thinkingLevel,
          completion: taskCompletion,
        },
        meta?.userLabel ?? profileName,
        controller,
      ),
      { detached: true },
    );
    await tasks.suppressTerminalNotification(taskId);
    await session.accessor.get(ISessionDispatchService).recordRun(resolved.agentId, taskId);
    signal.throwIfAborted();
    emitAgentRunSpawned(parent.agent, resolved.agentId, {
      profileName,
      description: meta?.userLabel,
      runInBackground: true,
      model: binding.modelAlias,
      taskId,
    });
    await dispatcher.dispatch(new SubagentStarted({ subagentId: resolved.agentId, taskId }));
    const admittedTaskId = taskId;
    void completion.then(
      (settlement) => {
        if (settlement.state === 'completed' || settlement.state === 'blocked') {
          return dispatcher.dispatch(new SubagentCompleted({
            subagentId: resolved.agentId,
            taskId: admittedTaskId,
            resultSummary: `Prompt ${settlement.state}`,
          }));
        }
        const error = settlement.state === 'cancelled'
          ? 'terminated'
          : settlement.result?.type === 'failed'
            ? toErrorMessage(settlement.result.error)
            : 'Prompt failed';
        return dispatcher.dispatch(new SubagentFailed({ subagentId: resolved.agentId, taskId: admittedTaskId, error }));
      },
      (error) => dispatcher.dispatch(new SubagentFailed({
        subagentId: resolved.agentId,
        taskId: admittedTaskId,
        error: error instanceof Error ? error.message : toErrorMessage(error),
      })),
    ).catch((error) => log.warn('prompt task lifecycle publication failed', { agentId: resolved.agentId, error: toErrorMessage(error) }));
    return {
      reservation: {
        id: reservation.id,
        dispose: () => reservation.dispose(),
        submit: async (message, execution, disabledTools, timing) => {
          try {
            signal.throwIfAborted();
            const handle = await reservation.submit(message, execution, disabledTools, timing, signal);
            resolve(handle.completion);
            return handle;
          } catch (error) {
            fail(error);
            throw error;
          }
        },
      },
      fail,
    };
  } catch (error) {
    fail(error);
    if (taskId !== undefined) await tasks.stop(taskId, 'Prompt admission failed');
    throw error;
  }
}

async function assertActivatableSkills(
  catalog: ISessionSkillCatalog,
  skills: readonly PromptSkillActivation[],
): Promise<void> {
  await catalog.ready;
  for (const skill of skills) {
    const definition = catalog.catalog.getSkill(skill.name);
    if (definition === undefined) {
      throw new Error2(ErrorCodes.SKILL_NOT_FOUND, `Skill "${skill.name}" was not found`);
    }
    if (!isUserActivatableSkillType(definition.metadata.type)) {
      throw new Error2(
        ErrorCodes.SKILL_TYPE_UNSUPPORTED,
        `Skill "${definition.name}" cannot be activated by the user`,
      );
    }
  }
}

async function validateProfileSelection(
  session: ISessionScopeHandle,
  profile: IAgentProfileService,
  profileName: string,
): Promise<void> {
  const current = profile.data();
  if (current.profileName === profileName) return;
  if (current.routeId !== undefined) {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      `agent route is already bound to "${current.routeId}"; cannot switch profile in this session`,
    );
  }
  const catalog = session.accessor.get(ISessionAgentProfileCatalog);
  await catalog.ready;
  const selected = profileName === DEFAULT_AGENT_PROFILE_NAME
    ? catalog.getDefault()
    : catalog.get(profileName);
  if (selected !== undefined) return;
  const available = catalog.list().map((item) => item.name).join(', ');
  throw new Error2(
    ErrorCodes.REQUEST_INVALID,
    `Unknown agent profile: "${profileName}". Available profiles: ${available}`,
  );
}

export function registerPromptsRoutes(app: PromptRouteHost, core: Scope, transcriptService?: TranscriptService): void {
  const ingress = new PromptIngress(core, {
    submit: async (sessionId, execution) => {
      let result: PromptIngressResult | undefined;
      await executeSubmit({ id: execution.body.prompt_id!, params: { session_id: sessionId }, body: execution.body, query: {} },
        { send: payload => {
          const data = (payload as { data: PromptIngressResult }).data;
          result = { ...promptSubmitResultSchema.parse(data), resolved_parts: data.resolved_parts };
        } }, execution);
      if (result === undefined) throw new Error2(ErrorCodes.INTERNAL, 'Prompt admission returned no receipt.');
      return result;
    },
    cancel: async (sessionId, agentId, promptId, signal) => {
      const lease = await acquireSessionOperation(core, sessionId, 'prompt-ingress-cancel', signal);
      try {
        const resolved = await abortable(resolvePromptFromSession(core, requireSession(lease.handle, sessionId), agentId), signal);
        signal.throwIfAborted();
        if (resolved.prompt.lookup(promptId) === undefined) return;
        resolved.prompt.abort(promptId);
      } catch (error) {
        if (!isError2(error) || error.code !== ErrorCodes.PROMPT_ALREADY_COMPLETED) throw error;
      } finally { await lease.dispose(); }
    },
  });
  app.addHook?.('preClose', () => ingress.close());
  const switchParams = z.object({ session_id: z.string().min(1), agent_id: z.string().min(1) });
  const operationParams = switchParams.extend({ operation_id: z.string().min(1) });
  const switchPath = '/sessions/{session_id}/agents/{agent_id}/model-switches';
  const switchList = defineRoute({ method: 'GET', path: switchPath, params: switchParams,
    success: { data: z.array(queuedModelSwitchSchema) }, errors: { [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Read model switch queue and operation states', tags: ['prompts'], operationId: 'listModelSwitches' }, async (req, reply) => {
    try {
      await withSessionOperation(core, req.params.session_id, async (handle) => {
        const resolved = await resolvePromptFromSession(core, requireSession(handle, req.params.session_id), req.params.agent_id);
        reply.send(okEnvelope(resolved.prompt.listModelSwitches(), req.id));
      });
    } catch (error) { sendMappedError(reply, req, error); }
  });
  app.get(switchList.path, switchList.options, switchList.handler as Parameters<PromptRouteHost['get']>[2]);
  const switchSubmit = defineRoute({ method: 'POST', path: switchPath, params: switchParams, body: modelSwitchInputSchema,
    success: { data: modelSwitchReceiptSchema }, errors: { [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Queue a native model and context switch before the next model request', tags: ['prompts'], operationId: 'switchModel' }, async (req, reply) => {
    try {
      await withSessionOperation(core, req.params.session_id, async (handle) => {
        const resolved = await resolvePromptFromSession(core, requireSession(handle, req.params.session_id), req.params.agent_id);
        reply.send(okEnvelope(await resolved.prompt.switchModel(req.body), req.id));
      });
    } catch (error) { sendMappedError(reply, req, error); }
  });
  app.post(switchSubmit.path, switchSubmit.options, switchSubmit.handler as Parameters<PromptRouteHost['post']>[2]);
  const switchRead = defineRoute({ method: 'GET', path: `${switchPath}/{operation_id}`, params: operationParams,
    success: { data: modelSwitchReceiptSchema.nullable() }, errors: { [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Read a model switch by its idempotent operation ID', tags: ['prompts'], operationId: 'getModelSwitch' }, async (req, reply) => {
    try {
      await withSessionOperation(core, req.params.session_id, async (handle) => {
        const resolved = await resolvePromptFromSession(core, requireSession(handle, req.params.session_id), req.params.agent_id);
        reply.send(okEnvelope(resolved.prompt.getModelSwitch(req.params.operation_id) ?? null, req.id));
      });
    } catch (error) { sendMappedError(reply, req, error); }
  });
  app.get(switchRead.path, switchRead.options, switchRead.handler as Parameters<PromptRouteHost['get']>[2]);
  const switchAction = defineRoute({ method: 'POST', path: `${switchPath}/{operation_id}`, params: operationParams, body: modelSwitchActionSchema,
    success: { data: modelSwitchReceiptSchema }, errors: { [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Edit, cancel, reorder, hold or recover a model switch operation', tags: ['prompts'], operationId: 'recoverModelSwitch' }, async (req, reply) => {
    try {
      await withSessionOperation(core, req.params.session_id, async (handle) => {
        const resolved = await resolvePromptFromSession(core, requireSession(handle, req.params.session_id), req.params.agent_id);
        const id = req.params.operation_id;
        const action = req.body;
        let receipt;
        if (action.action === 'update') receipt = await resolved.prompt.updateModelSwitch({ ...action.input, operationId: id }, action.expectedRevision);
        else if (action.action === 'cancel') receipt = await resolved.prompt.cancelModelSwitch(id);
        else if (action.action === 'move' || action.action === 'hold') {
          if (action.action === 'move') resolved.prompt.move(id, action.targetIndex);
          else resolved.prompt.setEditHold(id, action.held);
          receipt = resolved.prompt.getModelSwitch(id);
        } else receipt = await resolved.prompt.recoverModelSwitch(id, action.action, action.mode);
        if (receipt === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Unknown model switch ${id}`);
        reply.send(okEnvelope(receipt, req.id));
      });
    } catch (error) { sendMappedError(reply, req, error); }
  });
  app.post(switchAction.path, switchAction.options, switchAction.handler as Parameters<PromptRouteHost['post']>[2]);
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/prompts',
      params: sessionIdParamSchema,
      querystring: z.object({ admission: z.literal('durable').optional(), agent_id: z.string().min(1).optional(), cursor: z.string().optional() }),
      success: { data: promptListResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'List the active prompt and queued prompts for a session',
      tags: ['prompts'],
      operationId: 'listPrompts',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        if (req.query.admission === 'durable') {
          const page = await ingress.list(session_id, req.query.agent_id ?? MAIN_AGENT_ID, req.query.cursor);
          reply.send(okEnvelope({ active: null, queued: [], ingress: page.items, ingress_next_cursor: page.nextCursor }, req.id));
          return;
        }
        await withSessionOperation(core, session_id, async (handle) => {
          const session = requireSession(handle, session_id);
          const result = projectPromptList((await resolvePromptFromSession(core, session)).prompt.list());
          reply.send(okEnvelope(result, req.id));
        });
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<PromptRouteHost['get']>[2]);
  const ingressRead = defineRoute({ method: 'GET', path: '/sessions/{session_id}/prompts/{prompt_id}',
    params: sessionIdParamSchema.extend({ prompt_id: z.string().min(1).max(256) }),
    querystring: z.object({ admission: z.literal('durable'), agent_id: z.string().min(1).optional() }),
    success: { data: promptSubmitResultSchema }, errors: { [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.PROMPT_NOT_FOUND]: {} },
    description: 'Read a saved durable request without restoring its agent', tags: ['prompts'], operationId: 'getDurablePrompt' }, async (req, reply) => {
    try {
      const item = await ingress.lookup(req.params.session_id, req.query.agent_id ?? MAIN_AGENT_ID, req.params.prompt_id);
      if (item === undefined) throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'Saved request not found.');
      reply.send(okEnvelope(promptSubmitResultSchema.parse(item), req.id));
    }
    catch (error) { sendMappedError(reply, req, error); }
  });
  app.get(ingressRead.path, ingressRead.options, ingressRead.handler as Parameters<PromptRouteHost['get']>[2]);

  const submitRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts',
      body: promptSubmissionSchema,
      params: sessionIdParamSchema,
      querystring: z.object({ receipt: z.literal('true').optional() }),
      success: { data: z.union([promptSubmitResultSchema, promptSubmitReceiptSchema]) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema: validationDetailsSchema },
        [ErrorCode.SKILL_NOT_FOUND]: {},
        [ErrorCode.SKILL_NOT_ACTIVATABLE]: {},
        [ErrorCode.AUTH_PROVISIONING_REQUIRED]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: { detailsSchema: authProviderDetailsSchema },
        [ErrorCode.AUTH_TOKEN_UNAUTHORIZED]: { detailsSchema: authProviderDetailsSchema },
        [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: { detailsSchema: authModelDetailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ID_CONFLICT]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Submit a prompt; requests with a client prompt_id replay an accepted matching receipt',
      tags: ['prompts'],
      operationId: 'submitPrompt',
    },
    (req, reply) => withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], signal => executeSubmit(req, reply, undefined, signal)),
  );
  async function executeSubmit(
    req: { id: string; params: { session_id: string }; body: z.infer<typeof promptSubmissionSchema>; query: { receipt?: 'true' } },
    reply: { send(payload: unknown): unknown },
    ingressExecution?: PromptIngressExecution,
    requestSignal?: AbortSignal,
  ): Promise<void> {
      const signal = ingressExecution?.signal ?? requestSignal;
      const { session_id } = req.params;
      const live = core.accessor.get(ISessionManager).get(session_id);
      const liveAgent = req.body.delivery_mode === 'steer'
        ? live?.accessor.get(IAgentLifecycleService).get(req.body.agent_id ?? MAIN_AGENT_ID) : undefined;
      const steerTarget = ingressExecution === undefined
        ? { turnId: liveAgent?.accessor.get(IAgentLoopService).status().activeTurnId,
          promptId: liveAgent?.accessor.get(IAgentPromptService).list().active?.id }
        : ingressExecution.steerTarget;
      let preparedMedia: PromptMediaPreparation | undefined;
      let reservation: PromptReservation | undefined;
      let lease: SessionOperationLease | undefined;
      let enqueued = false;
      let retryContentRanges: readonly import('@kiki/agent-core-v2').PromptContentRange[] | undefined;
      const phase = <T>(name: string, action: () => Promise<T>) => timeRestorePhase(core.accessor.get(ILogService), { sessionId: session_id, agentId: req.body.agent_id ?? 'main', promptId: req.body.prompt_id, requestId: req.id }, name, action);
      const sendResult = (result: z.input<typeof promptSubmitResultSchema> & Pick<PromptIngressResult, 'resolved_parts'>) => {
        const resolved_parts = result.resolved_parts ?? (retryContentRanges ?? preparedMedia?.sourceRanges)?.map(({ index, start, end }) => ({ index, content: result.content.slice(start, end) }));
        const data = req.query.receipt === 'true' ? promptSubmitReceiptSchema.parse({ ...result, resolved_parts })
          : ingressExecution === undefined ? result : { ...result, resolved_parts };
        return reply.send(okEnvelope(data, req.id));
      };
      try {
        if (req.body.admission === 'durable' && ingressExecution === undefined) {
          const body = { ...req.body, admission: undefined };
          sendResult(await ingress.submit(session_id, body, promptPayloadFingerprint(body), steerTarget));
          return;
        }
        lease = await phase('prompt_acquire', () => acquireSessionOperation(core, session_id, 'operation', signal));
        const session = requireSession(lease.handle, session_id);
        if (req.body.prompt_id === undefined && req.body.skills !== undefined) {
          await assertActivatableSkills(session.accessor.get(ISessionSkillCatalog), req.body.skills);
        }
        if (req.body.prompt_id === undefined) {
          await assertPromptFileRefs(req.body.content, ingressExecution?.files ?? core.accessor.get(IFileService));
        }
        const restoring = resolvePromptFromSession(core, session, req.body.agent_id);
        const resolved = await phase('prompt_ensure_main', () => signal === undefined ? restoring : abortable(restoring, signal));
        const retryPromptId = req.body.prompt_id;
        signal?.throwIfAborted();
        const retryFingerprint = retryPromptId === undefined ? undefined : ingressExecution?.fingerprint ?? promptPayloadFingerprint(req.body);
        let replayedSubmission = false;
        const submit = async () => {
        if (retryPromptId !== undefined && retryFingerprint !== undefined) {
          const receipt = await promptRetryFor(resolved.prompt).lookup(retryPromptId, retryFingerprint);
          if (receipt !== undefined) {
            replayedSubmission = true;
            retryContentRanges = receipt.contentRanges;
            return projectPromptRetryReceipt(retryPromptId, receipt, req.body.content);
          }
        }
        if (req.body.skills !== undefined) await assertActivatableSkills(session.accessor.get(ISessionSkillCatalog), req.body.skills);
        const files = ingressExecution?.files ?? core.accessor.get(IFileService);
        await assertPromptFileRefs(req.body.content, files);
        const resolveContent = (signal: AbortSignal) => resolvePromptSessionMediaRefs(req.body.content,
          session.accessor.get(ISessionMediaStore),
          transcriptService === undefined ? undefined : publishedInlineMediaReader(transcriptService, session_id, signal));
        const submittedContent = ingressExecution === undefined
          ? await withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], resolveContent)
          : await resolveContent(ingressExecution.signal);
        await ensurePromptAuthReady(session, resolved.accessor, req.body);

        const telemetry = core.accessor.get(ITelemetryService).withContext({ sessionId: session_id });
        preparedMedia = await resolvePromptMediaFiles(
          submittedContent,
          files,
          core.accessor.get(IBootstrapService).cacheDir,
          {
            telemetry,
            providerType: resolved.profile.getModelProviderType(req.body.model),
            resolveOriginalsDir: async () =>
              sessionMediaOriginalsDir(session.accessor.get(ISessionContext).sessionDir),
            resolveAttachmentsDir: async () =>
              join(session.accessor.get(ISessionContext).sessionDir, 'attachments'),
          },
        );
        const resolvedContent = preparedMedia.content;
        reservation = reservePrompt(resolved.prompt, req.body.prompt_id, retryPromptId !== undefined || req.query.receipt === 'true', retryFingerprint, {
          waitForLaunch: req.query.receipt === 'true' || ingressExecution !== undefined ? false : undefined,
          contentRanges: preparedMedia.sourceRanges,
        });

        if (req.body.profile !== undefined) {
          await validateProfileSelection(session, resolved.profile, req.body.profile);
        }
        const execution: PromptExecutionBinding | undefined =
          req.body.execution === undefined && req.body.profile === undefined &&
            req.body.model === undefined &&
            req.body.model_switch_mode === undefined &&
            req.body.thinking === undefined &&
            req.body.permission_mode === undefined &&
            req.body.plan_gate === undefined &&
            req.body.plan_mode === undefined &&
            req.body.goal_objective === undefined &&
            req.body.goal_follow_up_timing === undefined &&
            req.body.goal_initial_status === undefined &&
            req.body.goal_control === undefined &&
            req.body.persona_greeting_reply === undefined &&
            req.body.after_model_switch === undefined
            ? undefined
            : {
                execution: req.body.execution,
                afterModelSwitch: req.body.after_model_switch,
                modelSwitchMode: req.body.model_switch_mode,
                profile: req.body.profile,
                model: req.body.model,
                thinking: req.body.thinking,
                permissionMode: req.body.permission_mode,
                planGate: req.body.plan_gate,
                planMode: req.body.plan_mode,
                goalObjective: req.body.goal_objective,
                goalFollowUpTiming: req.body.goal_follow_up_timing,
                goalInitialStatus: req.body.goal_initial_status,
                goalControl: req.body.goal_control,
                personaGreetingReply: req.body.persona_greeting_reply,
              };
        validatePromptRuntimeControls(resolved.accessor, execution);
        let deferredDisabledTools: readonly string[] | undefined;
        if (req.body.disabled_tools !== undefined) {
          if (execution !== undefined && !resolved.profile.isRunnable()) {
            deferredDisabledTools = req.body.disabled_tools;
          } else {
            try {
              await resolved.toolPolicy.setSessionDisabledTools(req.body.disabled_tools);
            } catch (error) {
              if (error instanceof ProfileError) {
                throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
              }
              throw error;
            }
          }
        }
        const parts = contentToCoreParts(resolvedContent);
        await ingressExecution?.beforeSubmit();
        const admission = await admitPromptRun(core, session, resolved, reservation);
        try {
          await applyPromptMetadataUpdate({
            metadata: session.accessor.get(ISessionMetadata),
            eventService: core.accessor.get(IEventService),
            sessionId: session_id,
          }, promptMetadataTextFromContentParts(parts));
          if (req.body.skills !== undefined) {
            const settlement = watchPromptSettlements(resolved.events);
            let result: PromptWithSkillsResult;
            try {
              result = await submitReservedSkillPrompt(resolved.skill, {
                input: parts,
                skills: req.body.skills,
                execution,
                appendTiming: req.body.append_timing,
                deferredDisabledTools,
              }, admission.reservation);
            } catch (error) {
              await settlement.dispose();
              throw error;
            }
            enqueued = true;
            settlement.settle(result.prompt_id, () => preparedMedia?.discard());
            if (retryFingerprint !== undefined) {
              const receipt = await promptRetryFor(resolved.prompt).lookup(result.prompt_id, retryFingerprint);
              if (receipt === undefined) throw new Error2(ErrorCodes.INTERNAL, 'Prompt receipt is missing.');
              return projectPromptRetryReceipt(result.prompt_id, receipt, req.body.content);
            }
            return {
              prompt_id: result.prompt_id,
              user_message_id: result.prompt_id,
              status: result.state,
              content: projectPromptContentParts(parts),
              created_at: result.created_at,
              append_timing: result.append_timing,
              revision: result.revision,
            };
          }
          const handle = await admission.reservation.submit({
            role: 'user',
            content: parts,
            toolCalls: [],
            origin: { kind: 'user' },
          }, execution, deferredDisabledTools, req.body.append_timing);
          enqueued = true;
          const staging = preparedMedia;
          void Promise.race([handle.launched, handle.completion]).then(
            () => staging?.discard(),
            () => staging?.discard(),
          );
          if (retryFingerprint !== undefined) {
            const receipt = await promptRetryFor(resolved.prompt).lookup(handle.id, retryFingerprint);
            if (receipt === undefined) throw new Error2(ErrorCodes.INTERNAL, 'Prompt receipt is missing.');
            return projectPromptRetryReceipt(handle.id, receipt, req.body.content);
          }
          return promptSubmitResultSchema.parse(projectPromptHandle(handle));
        } catch (error) {
          if (!enqueued) admission.fail(error);
          throw error;
        }
        };
        const submitAndDeliver = async () => {
          const result = await phase('prompt_admission', submit);
          if (req.body.delivery_mode !== 'steer') return result;
          if (!resolved.prompt.list().pending.some(item => item.id === result.prompt_id)) {
            return { ...result, delivery_reason: 'prompt_no_longer_pending' as const };
          }
          if (replayedSubmission && (resolved.profile.data().executorId ?? 'native') !== 'native') {
            if (resolved.prompt.list().hold?.reason === 'recovery') {
              throw new Error2(ErrorCodes.REQUEST_INVALID, 'The external delivery result is unknown. Check the executor result before explicitly releasing the held prompt queue.');
            }
            return { ...result, delivery_state: 'queued' as const, delivery_reason: 'external_retry' as const };
          }
          signal?.throwIfAborted();
          const activeTurnId = resolved.accessor.get(IAgentLoopService).status().activeTurnId;
          const queue = resolved.prompt.list();
          const activePromptId = queue.active?.id ?? queue.launching?.id;
          if ((activeTurnId !== undefined && activeTurnId !== steerTarget?.turnId) ||
              (activePromptId !== undefined && activePromptId !== steerTarget?.promptId)) {
            return { ...result, delivery_state: 'queued' as const, delivery_reason: 'target_changed' as const };
          }
          try {
            const [handle] = await resolved.prompt.steer([result.prompt_id]);
            return { ...result,
              status: handle?.state === 'blocked' ? 'blocked' as const : handle?.state === 'running' ? 'running' as const : result.status,
              delivery_state: wasSteeredIntoTurn(resolved.prompt, handle, activeTurnId) ? 'steered' as const : handle?.state === 'pending' ? 'queued' as const : undefined,
              delivery_reason: handle?.deliveryReason };
          } catch (error) {
            if (!isError2(error) || (error.code !== ErrorCodes.PROMPT_NOT_FOUND && error.code !== ErrorCodes.REQUEST_INVALID)) throw error;
            return { ...result, delivery_state: resolved.prompt.list().pending.some(item => item.id === result.prompt_id) ? 'queued' as const : undefined,
              delivery_reason: error.code === ErrorCodes.REQUEST_INVALID ? 'steer_rejected' as const : 'prompt_no_longer_pending' as const };
          }
        };
        const result = retryPromptId === undefined || retryFingerprint === undefined ? await submitAndDeliver()
          : await promptRetryFor(resolved.prompt).run(retryPromptId, retryFingerprint, submitAndDeliver);
        sendResult(result);
      } catch (error) {
        if (!enqueued) await preparedMedia?.discard();
        if (ingressExecution !== undefined) throw error;
        sendMappedError(reply, req, error);
      } finally {
        await reservation?.dispose();
        await lease?.dispose();
      }
  }
  app.post(
    submitRoute.path,
    { ...submitRoute.options, bodyLimit: PROMPT_BODY_LIMIT_BYTES },
    submitRoute.handler as Parameters<PromptRouteHost['post']>[2],
  );

  const steerManyRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts::steer',
      body: promptSteerRequestSchema,
      params: sessionIdParamSchema,
      success: { data: promptSteerResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
      },
      description: 'Steer queued prompts into the active turn',
      tags: ['prompts'],
      operationId: 'steerPrompts',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        await withSessionOperation(core, session_id, async (handle) => {
          const resolved = await resolvePromptFromSession(core, requireSession(handle, session_id));
          reply.send(okEnvelope(await steerPendingPrompts(resolved.prompt, req.body.prompt_ids, resolved.accessor.get(IAgentLoopService).status().activeTurnId), req.id));
        });
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(steerManyRoute.path, steerManyRoute.options, steerManyRoute.handler as Parameters<PromptRouteHost['post']>[2]);

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts/{tail}',
      querystring: promptActionQuerySchema,
      body: z.union([
        z.undefined(),
        z.object({}).strict(),
        promptMoveRequestSchema,
        promptReplaceRequestSchema,
        promptTimingRequestSchema,
        promptHoldRequestSchema,
      ]),
      success: {
        data: z.union([
          promptAbortResponseSchema,
          promptMoveResultSchema,
          promptReplaceResultSchema,
          promptTimingResultSchema,
          promptHoldResultSchema,
          promptSteerResultSchema,
        ]),
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Abort, move, replace, retime, hold for editing, or steer a prompt',
      tags: ['prompts'],
      operationId: 'promptAction',
    },
    async (req, reply) => {
      let preparedMedia: PromptMediaPreparation | undefined;
      let lease: SessionOperationLease | undefined;
      let replaced = false;
      try {
        const { session_id, tail } = req.params as { session_id: string; tail: string };
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['abort', 'move', 'replace', 'timing', 'hold', 'steer', 'resume'] as const,
          resourceLabel: 'prompt',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        if (parsed.action === 'resume') {
          if (req.query.admission !== 'durable') throw new Error2(ErrorCodes.REQUEST_INVALID, 'Durable admission is required to resume a saved request.');
          const item = await ingress.resume(session_id, req.query.agent_id ?? MAIN_AGENT_ID, parsed.id);
          if (item === undefined) throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'Saved request not found.');
          reply.send(okEnvelope(item, req.id));
          return;
        }
        if (parsed.action === 'abort') {
          const aborted = await ingress.abort(session_id, req.query.agent_id ?? MAIN_AGENT_ID, parsed.id);
          if (aborted !== undefined) { reply.send(okEnvelope({ aborted }, req.id)); return; }
        }
        if (req.query.admission === 'durable' && parsed.action !== 'abort') {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'Cancel the saved request and send a new request to edit it.');
        }
        if (parsed.action === 'replace') {
          const replacement = promptReplaceRequestSchema.safeParse(req.body);
          if (!replacement.success) {
            throw new Error2(ErrorCodes.REQUEST_INVALID, 'replacement content is required');
          }
          await assertPromptFileRefs(replacement.data.content, core.accessor.get(IFileService));
          lease = await acquireSessionOperation(core, session_id, 'operation');
          const session = requireSession(lease.handle, session_id);
          const replacementContent = await withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], (signal) => resolvePromptSessionMediaRefs(
            replacement.data.content,
            session.accessor.get(ISessionMediaStore),
            transcriptService === undefined ? undefined : publishedInlineMediaReader(transcriptService, session_id, signal),
          ));
          const resolved = await resolvePromptFromSession(core, session);
          preparedMedia = await resolvePromptMediaFiles(
            replacementContent,
            core.accessor.get(IFileService),
            core.accessor.get(IBootstrapService).cacheDir,
            {
              telemetry: core.accessor.get(ITelemetryService).withContext({ sessionId: session_id }),
              providerType: resolved.profile.getModelProviderType(),
              resolveOriginalsDir: async () =>
                sessionMediaOriginalsDir(session.accessor.get(ISessionContext).sessionDir),
              resolveAttachmentsDir: async () =>
                join(session.accessor.get(ISessionContext).sessionDir, 'attachments'),
            },
          );
          const handle = resolved.prompt.replace(
            parsed.id,
            contentToCoreParts(preparedMedia.content),
            replacement.data.replace_attachments,
          );
          replaced = true;
          const staging = preparedMedia;
          void Promise.race([handle.launched, handle.completion]).then(
            () => staging?.discard(),
            () => staging?.discard(),
          );
          reply.send(okEnvelope(projectPromptHandle(handle), req.id));
          return;
        }
        lease = await acquireSessionOperation(core, session_id, 'operation');
        const agentId = (req as { query?: { agent_id?: string } }).query?.agent_id;
        if (agentId !== undefined && agentId !== MAIN_AGENT_ID && parsed.action !== 'steer' && parsed.action !== 'abort') {
          throw new Error2(ErrorCodes.REQUEST_INVALID, `prompt ${parsed.action} is main-agent only`);
        }
        const resolved = await resolvePromptFromSession(core, requireSession(lease.handle, session_id), agentId);
        if (parsed.action === 'move') {
          const move = promptMoveRequestSchema.safeParse(req.body);
          if (!move.success) {
            throw new Error2(ErrorCodes.REQUEST_INVALID, 'target_index is required');
          }
          resolved.prompt.move(parsed.id, move.data.target_index);
          reply.send(okEnvelope({
            moved: true,
            prompt_id: parsed.id,
            target_index: move.data.target_index,
            queued_prompt_ids: resolved.prompt.list().pending.map((prompt) => prompt.id),
          }, req.id));
        } else if (parsed.action === 'timing') {
          const timing = promptTimingRequestSchema.safeParse(req.body);
          if (!timing.success) {
            throw new Error2(ErrorCodes.REQUEST_INVALID, 'append_timing is required');
          }
          const handle = resolved.prompt.changeTiming(
            parsed.id,
            timing.data.append_timing,
            timing.data.expected_revision,
          );
          reply.send(okEnvelope(projectPromptHandle(handle), req.id));
        } else if (parsed.action === 'hold') {
          const hold = promptHoldRequestSchema.safeParse(req.body);
          if (!hold.success) {
            throw new Error2(ErrorCodes.REQUEST_INVALID, 'held is required');
          }
          resolved.prompt.setEditHold(parsed.id, hold.data.held);
          reply.send(okEnvelope({ prompt_id: parsed.id, held: hold.data.held }, req.id));
        } else if (parsed.action === 'abort') {
          if (req.query.queued_only === 'true') {
            let aborted = await resolved.prompt.abortQueued(parsed.id);
            if (!aborted && resolved.prompt.lookup(parsed.id) === undefined && transcriptService !== undefined) {
              const snapshot = await transcriptService.readColdSnapshot(session_id, agentId ?? MAIN_AGENT_ID);
              const stale = snapshot?.prompts.find((item) => item.promptId === parsed.id && item.status === 'queued');
              if (stale !== undefined && resolved.prompt.lookup(parsed.id) === undefined) {
                await resolved.accessor.get(IEventDispatcher).dispatch(new PromptAborted({ promptId: parsed.id, abortedAt: new Date().toISOString(), beforeStart: true }));
                aborted = true;
              }
            }
            await resolved.accessor.get(IEventDispatcher).flush();
            reply.send(okEnvelope({ aborted }, req.id));
            return;
          }
          const aborted = resolved.prompt.abort(parsed.id);
          if (!aborted) throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${parsed.id} already settled`);
          await resolved.accessor.get(IEventDispatcher).flush();
          requestLog(req)?.info({ session_id, prompt_id: parsed.id }, 'prompt aborted');
          reply.send(okEnvelope({ aborted }, req.id));
        } else {
          reply.send(okEnvelope(await steerPendingPrompts(resolved.prompt, [parsed.id], resolved.accessor.get(IAgentLoopService).status().activeTurnId), req.id));
        }
      } catch (error) {
        if (!replaced) await preparedMedia?.discard();
        sendMappedError(reply, req, error);
      } finally {
        await lease?.dispose();
      }
    },
  );
  app.post(
    actionRoute.path,
    { ...actionRoute.options, bodyLimit: PROMPT_BODY_LIMIT_BYTES },
    actionRoute.handler as Parameters<PromptRouteHost['post']>[2],
  );

  const abortTurnRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/turns/{tail}',
      params: sessionIdParamSchema.extend({ tail: z.string().min(1) }),
      success: { data: turnAbortResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Abort the active main-agent turn by its turn ID',
      tags: ['prompts'],
      operationId: 'abortTurn',
    },
    async (req, reply) => {
      try {
        const { session_id, tail } = req.params;
        const parsed = parseActionSuffix({ tail, allowedActions: ['abort'] as const, resourceLabel: 'turn' });
        if (parsed.kind !== 'action' || !/^(0|[1-9]\d*)$/.test(parsed.id) || !Number.isSafeInteger(Number(parsed.id))) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `invalid turn action: ${tail}`, req.id));
          return;
        }
        const turnId = Number(parsed.id);
        await withSessionOperation(core, session_id, async (handle) => {
          const resolved = await resolvePromptFromSession(core, requireSession(handle, session_id));
          const loop = resolved.accessor.get(IAgentLoopService);
          const aborted = loop.status().activeTurnId === turnId && loop.cancel(turnId);
          reply.send(okEnvelope({ aborted }, req.id));
        });
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(abortTurnRoute.path, abortTurnRoute.options, abortTurnRoute.handler as Parameters<PromptRouteHost['post']>[2]);
}

function projectPromptList(snapshot: PromptQueueSnapshot) {
  return {
    active: snapshot.active === undefined ? null : projectPromptSnapshot(snapshot.active),
    queued: snapshot.pending.map(projectPromptSnapshot),
    recovery_hold: snapshot.hold,
  };
}

async function steerPendingPrompts(prompt: IAgentPromptService, promptIds: readonly string[], activeTurnId?: number): Promise<z.infer<typeof promptSteerResultSchema>> {
  const pending = () => new Set(prompt.list().pending.map((item) => item.id));
  const available = pending();
  if (promptIds.some((id) => !available.has(id))) {
    if (promptIds.every((id) => prompt.lookup(id) !== undefined)) return { steered: false, prompt_ids: [...promptIds], delivery_reason: 'prompt_no_longer_pending' };
    throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts were not found');
  }
  try {
    return projectSteerResult(prompt, await prompt.steer(promptIds), promptIds, activeTurnId);
  } catch (error) {
    if (isError2(error) && error.code === ErrorCodes.PROMPT_NOT_FOUND && promptIds.every((id) => prompt.lookup(id) !== undefined)) {
      return { steered: false, prompt_ids: [...promptIds], delivery_state: promptIds.every((id) => pending().has(id)) ? 'queued' : undefined,
        delivery_reason: 'prompt_no_longer_pending' };
    }
    throw error;
  }
}

function wasSteeredIntoTurn(prompt: IAgentPromptService, handle: PromptHandle | undefined, turnId?: number): boolean {
  return handle !== undefined && (handle.state === 'steered' || (turnId !== undefined && prompt.lookup(handle.id)?.turnId === turnId));
}

function projectSteerResult(prompt: IAgentPromptService, handles: readonly PromptHandle[], promptIds: readonly string[], turnId?: number): z.infer<typeof promptSteerResultSchema> {
  const single = handles.length === 1 ? handles[0] : undefined;
  return {
    steered: handles.every((handle) => wasSteeredIntoTurn(prompt, handle, turnId)),
    prompt_ids: [...promptIds],
    delivery_state: wasSteeredIntoTurn(prompt, single, turnId) ? 'steered' : single?.state === 'pending' ? 'queued' : undefined,
    delivery_reason: single?.deliveryReason,
  };
}

export function projectPromptHandle(handle: PromptHandle) {
  return projectPromptSnapshot(handle);
}

export function projectPromptSnapshot(prompt: PromptQueueSnapshot['pending'][number]) {
  if (prompt.state === 'failed' || prompt.state === 'cancelled') {
    throw promptLaunchFailure(prompt);
  }
  const status = prompt.state === 'running' || prompt.state === 'steered'
    ? 'running'
    : prompt.state === 'blocked' ? 'blocked' : 'queued';
  const origin = prompt.message.origin;
  const bundled = bundledSkillActivations(origin).length;
  const content = bundled === 0 ? prompt.message.content : prompt.message.content.slice(bundled);
  return {
    prompt_id: prompt.id,
    user_message_id: prompt.userMessageId,
    status,
    origin,
    content: projectPromptContentParts(content),
    runtime_controls: prompt.execution === undefined ? undefined : {
      execution: prompt.execution.execution,
      profile: prompt.execution.profile,
      model: prompt.execution.model,
      modelSwitchMode: prompt.execution.modelSwitchMode,
      thinking: prompt.execution.thinking,
      permissionMode: prompt.execution.permissionMode,
      planGate: prompt.execution.planGate,
      planMode: prompt.execution.planMode,
    },
    created_at: prompt.createdAt,
    append_timing: prompt.appendTiming ?? 'agent_idle',
    revision: prompt.revision ?? 0,
    model: prompt.execution?.model,
    thinking: prompt.execution?.thinking,
    after_model_switch: prompt.execution?.afterModelSwitch,
    queue_index: prompt.queueIndex,
  };
}

export function watchPromptSettlements(events: IEventBus): {
  settle(promptId: string, discard: () => void | Promise<void>): void;
  dispose(): Promise<void>;
} {
  const settledIds = new Set<string>();
  const parentOf = new Map<string, string>();
  let armed: { id: string; discard: () => void | Promise<void> } | undefined;
  let pending = Promise.resolve();
  const schedule = (task: () => void | Promise<void>): void => {
    pending = pending.then(task);
  };
  const stop = (): void => {
    schedule(() => subscription.dispose());
  };
  const subscription = events.subscribe((event) => {
    if (event.type === 'prompt.steered') {
      const steered = event as {
        readonly promptIds?: unknown;
        readonly activePromptId?: unknown;
      };
      if (Array.isArray(steered.promptIds) && typeof steered.activePromptId === 'string') {
        for (const childId of steered.promptIds) {
          if (typeof childId === 'string') parentOf.set(childId, steered.activePromptId);
        }
        if (armed !== undefined && steered.promptIds.includes(armed.id)) {
          armed = { id: steered.activePromptId, discard: armed.discard };
        }
      }
      return;
    }
    if (event.type !== 'prompt.completed' && event.type !== 'prompt.aborted') return;
    const id = (event as { readonly promptId?: unknown }).promptId;
    if (typeof id !== 'string') return;
    settledIds.add(id);
    if (armed !== undefined && armed.id === id) {
      const { discard } = armed;
      armed = undefined;
      stop();
      schedule(discard);
    }
  });
  return {
    settle(promptId: string, discard: () => void | Promise<void>): void {
      if (settledIds.has(promptId) || settledIds.has(parentOf.get(promptId) ?? '')) {
        stop();
        schedule(discard);
        return;
      }
      armed = { id: promptId, discard };
    },
    async dispose(): Promise<void> {
      armed = undefined;
      stop();
      await pending;
    },
  };
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  err: unknown,
): void {
  const requestId = req.id;
  const log = requestLog(req);
  if (isError2(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'file.not_found':
        reply.send(errEnvelope(ErrorCode.FILE_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'prompt.not_found':
        reply.send(errEnvelope(ErrorCode.PROMPT_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'prompt.id_conflict':
        reply.send(errEnvelope(ErrorCode.PROMPT_ID_CONFLICT, err.message, requestId, err.stack));
        return;
      case 'session.busy':
        reply.send(errEnvelope(ErrorCode.SESSION_BUSY, err.message, requestId, err.stack));
        return;
      case 'prompt.already_completed':
        reply.send({
          code: ErrorCode.PROMPT_ALREADY_COMPLETED,
          msg: err.message,
          data: { aborted: false },
          request_id: requestId,
          stack: err.stack,
        });
        return;
      case 'request.invalid':
      case 'validation.failed':
      case 'config.invalid':
        reply.send({ ...errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack), details: err.details });
        return;
      case 'skill.not_found':
        reply.send(errEnvelope(ErrorCode.SKILL_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'skill.type_unsupported':
        reply.send(errEnvelope(ErrorCode.SKILL_NOT_ACTIVATABLE, err.message, requestId, err.stack));
        return;
      case 'auth.provisioning_required':
        reply.send({
          code: ErrorCode.AUTH_PROVISIONING_REQUIRED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details: null,
        });
        return;
      case 'auth.token_missing': {
        const details = authProviderDetails(err);
        if (details === undefined) {
          log?.error({ err }, 'prompt request failed');
          reply.send(
            errEnvelope(
              ErrorCode.INTERNAL_ERROR,
              `auth error ${err.code} missing provider_id`,
              requestId,
            ),
          );
          return;
        }
        reply.send({
          code: ErrorCode.AUTH_TOKEN_MISSING,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details,
        });
        return;
      }
      case 'auth.token_unauthorized': {
        const details = authProviderDetails(err);
        if (details === undefined) {
          log?.error({ err }, 'prompt request failed');
          reply.send(
            errEnvelope(
              ErrorCode.INTERNAL_ERROR,
              `auth error ${err.code} missing provider_id`,
              requestId,
            ),
          );
          return;
        }
        reply.send({
          code: ErrorCode.AUTH_TOKEN_UNAUTHORIZED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details,
        });
        return;
      }
      case 'auth.model_not_resolved':
        reply.send({
          code: ErrorCode.AUTH_MODEL_NOT_RESOLVED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details: authModelDetails(err),
        });
        return;
    }
  }
  log?.error({ err }, 'prompt request failed');
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}

function authProviderDetails(err: Error2): { provider_id: string } | undefined {
  const providerId = err.details?.['provider_id'];
  if (typeof providerId !== 'string') return undefined;
  return { provider_id: providerId };
}

function authModelDetails(err: Error2): { model_id?: string; provider_id?: string } | null {
  const details: { model_id?: string; provider_id?: string } = {};
  const modelId = err.details?.['model_id'];
  const providerId = err.details?.['provider_id'];
  if (typeof modelId === 'string') details.model_id = modelId;
  if (typeof providerId === 'string') details.provider_id = providerId;
  return Object.keys(details).length === 0 ? null : details;
}
