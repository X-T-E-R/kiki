import { z } from 'zod';

import { createDecorator, type ServicesAccessor } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import type { AgentTool } from '#/tool/toolContract';
import { ToolAccesses, type ExecutableToolContext, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { labelsFromAgentMeta, subagentLabels, subagentParentAgentId } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import { subagentAllowlistFor, subagentTypeNotAllowedMessage } from '#/app/agentProfileCatalog/profile-shared';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import { modelSupportsThinkingEffort, requiresStrictThinkingValidation } from '#/kosong/model/thinking';
import { AGENTS_SECTION, type AgentsConfig } from '#/session/agentCollaboration/configSection';
import { AGENT_COLLABORATION_FLAG_ID } from '#/session/agentCollaboration/flag';
import { resolveAgentCollaborationBinding, resolveSubagentTimeoutMs } from '#/session/subagent/configSection';
import { SubagentTask, type SubagentHandle } from '#/agent/tools/agent/subagent-task';
import { resolveAgentTaskConfig } from '#/agent/task/configSection';
import {
  COLLABORATION_AGENT_TYPE_LABEL,
  COLLABORATION_LATEST_TASK_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
  IAgentCollaborationRegistry,
} from '#/session/agentCollaboration/registry';
import { IAgentCollaborationMessagingService } from '#/session/agentCollaboration/messageMailbox';

const TASK_NAME = /^(?!root$)[a-z0-9_]+$/;
const NONBLANK = /\S/;
const FORK_NONE = /^[Nn][Oo][Nn][Ee]$/;

export const SpawnAgentInputSchema = z.object({
  task_name: z.string().regex(TASK_NAME),
  message: z.string().regex(NONBLANK),
  agent_type: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  reasoning_effort: z.string().trim().min(1).optional(),
  fork_turns: z.string().regex(FORK_NONE).optional(),
}).strict();
export const ListAgentsInputSchema = z.object({}).strict();
export const WaitAgentInputSchema = z.object({ timeout_ms: z.number().int().min(10_000).max(3_600_000).optional() }).strict();
export const FollowupTaskInputSchema = z.object({ target: z.string().trim().min(1), message: z.string().regex(NONBLANK) }).strict();
export const InterruptAgentInputSchema = z.object({ target: z.string().trim().min(1) }).strict();
export const SendMessageInputSchema = z.object({ target: z.string().trim().min(1), message: z.string().regex(NONBLANK) }).strict();

type SpawnAgentInput = z.infer<typeof SpawnAgentInputSchema>;
type WaitAgentInput = z.infer<typeof WaitAgentInputSchema>;
type FollowupTaskInput = z.infer<typeof FollowupTaskInputSchema>;
type InterruptAgentInput = z.infer<typeof InterruptAgentInputSchema>;
type SendMessageInput = z.infer<typeof SendMessageInputSchema>;
export const SPAWN_AGENT_PARAMETERS = toInputJsonSchema(SpawnAgentInputSchema);
export const LIST_AGENTS_PARAMETERS = toInputJsonSchema(ListAgentsInputSchema);
export const WAIT_AGENT_PARAMETERS = toInputJsonSchema(WaitAgentInputSchema);
export const FOLLOWUP_TASK_PARAMETERS = toInputJsonSchema(FollowupTaskInputSchema);
export const INTERRUPT_AGENT_PARAMETERS = toInputJsonSchema(InterruptAgentInputSchema);
export const SEND_MESSAGE_PARAMETERS = toInputJsonSchema(SendMessageInputSchema);
type NamedStatus = 'running' | 'completed' | 'interrupted' | 'errored';

interface NamedRecord {
  readonly taskName: string;
  readonly agentId: string;
  readonly agentType: string;
  readonly latestTaskId?: string;
  readonly meta: AgentMeta;
}

interface DeferredRunBridge {
  readonly handle: SubagentHandle;
  start(toolCallId: string): Promise<{ publish: () => void }>;
  cancel(reason?: unknown): void;
}

const pendingRunsByTaskService = new WeakMap<object, Set<string>>();

abstract class AgentCollaborationToolBase<T> implements AgentTool<T> {
  declare readonly _serviceBrand: undefined;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: Record<string, unknown>;
  protected readonly callerAgentId: string;

  constructor(
    @IAgentLifecycleService protected readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService protected readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog protected readonly catalog: ISessionAgentProfileCatalog,
    @IAgentScopeContext scope: IAgentScopeContext,
    @IAgentTaskService protected readonly tasks: IAgentTaskService,
    @IAgentProfileService protected readonly profile: IAgentProfileService,
    @IAgentPermissionModeService protected readonly permissionMode: IAgentPermissionModeService,
    @IAgentUserToolService protected readonly userTools: IAgentUserToolService,
    @ISessionMetadata protected readonly metadata: ISessionMetadata,
    @ISessionWorkspaceContext protected readonly workspace: ISessionWorkspaceContext,
    @ISessionProcessRunner protected readonly processRunner: ISessionProcessRunner,
    @ILogService protected readonly log: ILogService,
    @IConfigService protected readonly config: IConfigService,
    @IFlagService protected readonly flags: IFlagService,
    @IModelCatalog protected readonly modelCatalog: IModelCatalog,
    @IProtocolAdapterRegistry protected readonly protocolAdapters: IProtocolAdapterRegistry,
    @IAgentCollaborationRegistry protected readonly collaborationRegistry: IAgentCollaborationRegistry,
    @IAgentCollaborationMessagingService protected readonly messaging: IAgentCollaborationMessagingService,
  ) { this.callerAgentId = scope.agentId; }

  abstract run(args: T, context: ExecutableToolContext): Promise<ExecutableToolResult> | ExecutableToolResult;
  resolveExecution(args: T): ToolExecution {
    return { description: this.description, accesses: ToolAccesses.none(), approvalRule: this.name,
      execute: async (context) => this.run(args, context) };
  }

  protected async named(): Promise<NamedRecord[]> {
    const meta = await this.metadata.read();
    return Object.entries(meta.agents ?? {}).flatMap(([agentId, entry]) => {
      const taskName = entry.labels?.[COLLABORATION_TASK_NAME_LABEL];
      const agentType = entry.labels?.[COLLABORATION_AGENT_TYPE_LABEL];
      if (taskName === undefined || agentType === undefined || subagentParentAgentId(entry) !== this.callerAgentId) return [];
      return [{ taskName, agentId, agentType, latestTaskId: entry.labels?.[COLLABORATION_LATEST_TASK_LABEL], meta: entry }];
    }).sort((a, b) => a.taskName.localeCompare(b.taskName));
  }

  protected async views() {
    return Promise.all((await this.named()).map(async (agent) => ({
      task_name: agent.taskName, agent_id: agent.agentId, agent_type: agent.agentType,
      task_id: agent.latestTaskId,
      status: statusOf(agent.latestTaskId === undefined ? undefined : this.tasks.getTask(agent.latestTaskId)?.status),
    })));
  }

  protected async target(raw: string): Promise<NamedRecord | { error: string }> {
    const matches = (await this.named()).filter((agent) => agent.taskName === raw || agent.agentId === raw);
    return matches.length === 1 ? matches[0]! : {
      error: `No named adapter agent matches "${raw}". Use list_agents to find a task_name or agent_id; legacy anonymous children are not supported.`,
    };
  }

  protected async callerTaskName(): Promise<string> {
    const meta = await this.metadata.read();
    return meta.agents?.[this.callerAgentId]?.labels?.[COLLABORATION_TASK_NAME_LABEL] ??
      (this.callerAgentId === 'main' ? 'root' : this.callerAgentId);
  }

  protected async materialize(record: NamedRecord): Promise<IAgentScopeHandle> {
    return this.lifecycle.get(record.agentId) ?? this.lifecycle.create({
      agentId: record.agentId,
      labels: labelsFromAgentMeta(record.meta),
    });
  }

  protected createDeferredRunBridge(record: { agentId: string; profileName: string; prompt: string; displayModel?: string }, controller: AbortController): DeferredRunBridge {
    const target = this.lifecycle.get(record.agentId)!;
    let resolveCompletion!: (value: { result: string; usage?: TokenUsage }) => void;
    let rejectCompletion!: (reason: unknown) => void;
    const completion = new Promise<{ result: string; usage?: TokenUsage }>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => {});
    const handle: SubagentHandle = { agentId: record.agentId, profileName: record.profileName, model: record.displayModel,
      thinkingEffort: target.accessor.get(IAgentProfileService).getEffectiveThinkingLevel(),
      completion };
    let settled = false;
    return { handle, cancel: (reason) => {
      if (settled) return;
      settled = true;
      controller.abort(reason);
      rejectCompletion(reason ?? new Error('Prepared collaboration run cancelled'));
    }, start: async (toolCallId) => {
      if (settled) throw new Error('Prepared collaboration run is no longer available.');
      const requester = this.lifecycle.get(this.callerAgentId);
      if (requester === undefined) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Caller agent "${this.callerAgentId}" does not exist`);
      const run = await this.subagents.run(record.agentId, { kind: 'prompt', prompt: record.prompt }, { signal: controller.signal });
      void run.completion.catch(() => {});
      let published = false;
      return { publish: () => {
        if (published || settled) return;
        published = true;
        settled = true;
        this.emitSpawned(requester, record, toolCallId);
        const mirrored = mirrorAgentRun(requester, run, { profileName: record.profileName, prompt: record.prompt,
          signal: controller.signal, cancel: (reason) => controller.abort(reason) });
        void mirrored.then((result) => resolveCompletion({ result: result.summary, usage: result.usage }), rejectCompletion);
      } };
    } };
  }

  protected emitSpawned(requester: IAgentScopeHandle, record: { agentId: string; profileName: string; displayModel?: string }, toolCallId: string): void {
    emitAgentRunSpawned(requester, record.agentId, { profileName: record.profileName, parentToolCallId: toolCallId,
      description: record.profileName, runInBackground: true, model: record.displayModel });
  }

  protected assertCanRegisterBackground(): void {
    const max = resolveAgentTaskConfig(this.config)?.maxRunningTasks;
    if (max !== undefined && this.tasks.list(true).length >= max) {
      throw new Error2(ErrorCodes.TASK_LIMIT_EXCEEDED, 'Too many background tasks are already running.');
    }
  }
}

export interface ISpawnAgentTool extends AgentTool<SpawnAgentInput> { readonly _serviceBrand: undefined; }
export const ISpawnAgentTool = createDecorator<ISpawnAgentTool>('spawnAgentTool');
export class SpawnAgentTool extends AgentCollaborationToolBase<SpawnAgentInput> implements ISpawnAgentTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'spawn_agent';
  readonly description = 'Start one named subagent asynchronously with fresh context.';
  readonly parameters = SPAWN_AGENT_PARAMETERS;
  async run(args: SpawnAgentInput, context: ExecutableToolContext): Promise<ExecutableToolResult> {
    let taskName: string | undefined;
    let created: IAgentScopeHandle | undefined;
    let controller: AbortController | undefined;
    let taskId: string | undefined;
    let bridge: DeferredRunBridge | undefined;
    try {
      taskName = canonicalTaskName(args.task_name);
      const message = nonblank(args.message, 'message');
      if (args.fork_turns !== undefined && !FORK_NONE.test(args.fork_turns)) throw new Error('fork_turns supports only "none" in this experiment.');
      this.assertCanRegisterBackground();
      await this.catalog.ready;
      const profileName = optionalNonblank(args.agent_type, 'agent_type') ?? 'coder';
      const own = this.profile.data();
      const allowlist = subagentAllowlistFor(this.catalog, own);
      if (allowlist !== undefined && !allowlist.includes(profileName)) throw new Error2(ErrorCodes.AGENT_TYPE_NOT_ALLOWED, subagentTypeNotAllowedMessage(profileName, allowlist));
      const selectedProfile = this.catalog.get(profileName);
      if (selectedProfile === undefined) throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${profileName}"`);
      if (own.modelAlias === undefined) throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound');
      const binding = resolveAgentCollaborationBinding(this.config, this.flags,
        { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
        { modelAlias: optionalNonblank(args.model, 'model'), thinkingEffort: optionalNonblank(args.reasoning_effort, 'reasoning_effort') },
        { modelPreference: selectedProfile.modelPreference, modelAlias: selectedProfile.modelAlias, thinkingEffort: selectedProfile.thinkingEffort });
      const model = this.modelCatalog.get(binding.model);
      const strictEffort = requiresStrictThinkingValidation(this.protocolAdapters, model.protocol, model.providerType) ||
        (model.supportEfforts?.length ?? 0) > 0;
      if (binding.thinking !== undefined && !modelSupportsThinkingEffort(binding.thinking, model, strictEffort)) {
        throw new Error(`Thinking effort "${binding.thinking}" is not supported by model "${binding.model}".`);
      }
      const prompt = await applyProfilePromptPrefix(selectedProfile, message, { cwd: this.workspace.workDir, runner: this.processRunner, log: this.log });
      const delegator = { kind: 'agent' as const, agentId: this.callerAgentId };
      if (!(await this.collaborationRegistry.reserve(taskName, delegator))) return failure(`Named agent "${taskName}" already exists in this session.`);

      taskId = this.tasks.allocateTaskId?.('agent');
      if (taskId === undefined) throw new Error('Agent task service cannot allocate a transactional task id.');
      created = await this.lifecycle.create({ binding: { profile: selectedProfile.name, model: binding.model,
        thinking: binding.thinking, strictThinking: binding.thinking !== undefined }, deferCreateEvent: true,
        delegator: { kind: 'agent', agentId: this.callerAgentId },
        labels: { ...subagentLabels(this.callerAgentId), [COLLABORATION_TASK_NAME_LABEL]: taskName,
          [COLLABORATION_AGENT_TYPE_LABEL]: selectedProfile.name, [COLLABORATION_LATEST_TASK_LABEL]: taskId } });
      created.accessor.get(IAgentPermissionModeService).setMode(this.permissionMode.mode);
      created.accessor.get(IAgentUserToolService).inheritUserTools(this.userTools);
      controller = new AbortController();
      const record = { agentId: created.id, profileName: selectedProfile.name, prompt, displayModel: binding.displayModel };
      bridge = this.createDeferredRunBridge(record, controller);
      this.tasks.registerTask(
        new SubagentTask(bridge.handle, taskName, controller, { taskName, agentType: selectedProfile.name }),
        { detached: true, timeoutMs: resolveSubagentTimeoutMs(this.config), taskId, deferVisibility: true },
      );
      const publication = await bridge.start(context.toolCallId);
      this.tasks.commitTaskRegistration?.(taskId);
      this.lifecycle.commitCreate?.(created.id);
      this.collaborationRegistry.commit(taskName, delegator);
      publication.publish();
      return success({ task_name: taskName, agent_id: created.id, task_id: taskId, agent_type: selectedProfile.name, status: 'running', fork_turns: 'none' });
    } catch (error) {
      bridge?.cancel(error);
      controller?.abort(error);
      if (taskId !== undefined) await this.tasks.rollbackTaskRegistration?.(taskId, error);
      if (created !== undefined) await this.lifecycle.discard?.(created.id).catch(() => {});
      if (taskName !== undefined) this.collaborationRegistry.release(taskName, { kind: 'agent', agentId: this.callerAgentId });
      return failure(errorMessage(error));
    }
  }
}

export interface IListAgentsTool extends AgentTool<Record<string, never>> { readonly _serviceBrand: undefined; }
export const IListAgentsTool = createDecorator<IListAgentsTool>('listAgentsTool');
export class ListAgentsTool extends AgentCollaborationToolBase<Record<string, never>> implements IListAgentsTool {
  declare readonly _serviceBrand: undefined; readonly name = 'list_agents'; readonly description = 'List named adapter agents in task-name order.';
  readonly parameters = LIST_AGENTS_PARAMETERS;
  async run() { return success({ agents: await this.views() }); }
}

export interface IWaitAgentTool extends AgentTool<WaitAgentInput> { readonly _serviceBrand: undefined; }
export const IWaitAgentTool = createDecorator<IWaitAgentTool>('waitAgentTool');
export class WaitAgentTool extends AgentCollaborationToolBase<WaitAgentInput> implements IWaitAgentTool {
  declare readonly _serviceBrand: undefined; readonly name = 'wait_agent'; readonly description = 'Wait until a named running agent settles or the timeout expires.';
  readonly parameters = WAIT_AGENT_PARAMETERS;
  async run(args: WaitAgentInput) {
    const timeoutMs = args.timeout_ms ?? 30_000;
    const running = (await this.views()).filter((agent) => agent.status === 'running' && agent.task_id !== undefined);
    if (running.length === 0) return success({ timed_out: false, agents: await this.views() });
    await Promise.race(running.map((agent) => this.tasks.wait(agent.task_id!, timeoutMs)));
    const timedOut = running.every((agent) => this.tasks.getTask(agent.task_id!)?.status === 'running');
    return success({ timed_out: timedOut, agents: await this.views() });
  }
}

export interface IFollowupTaskTool extends AgentTool<FollowupTaskInput> { readonly _serviceBrand: undefined; }
export const IFollowupTaskTool = createDecorator<IFollowupTaskTool>('followupTaskTool');
export class FollowupTaskTool extends AgentCollaborationToolBase<FollowupTaskInput> implements IFollowupTaskTool {
  declare readonly _serviceBrand: undefined; readonly name = 'followup_task'; readonly description = 'Start one new turn on an idle named adapter agent.';
  readonly parameters = FOLLOWUP_TASK_PARAMETERS;
  async run(args: FollowupTaskInput, context: ExecutableToolContext) {
    try {
      const target = await this.target(nonblank(args.target, 'target')); if ('error' in target) return failure(target.error);
      const pending = pendingRunsByTaskService.get(this.tasks) ?? new Set<string>();
      pendingRunsByTaskService.set(this.tasks, pending);
      if ((target.latestTaskId !== undefined && this.tasks.getTask(target.latestTaskId)?.status === 'running') || pending.has(target.agentId)) return failure(`Named agent "${target.taskName}" is already running; follow-up messages are not queued.`);
      pending.add(target.agentId);
      let controller: AbortController | undefined;
      let bridge: DeferredRunBridge | undefined;
      let taskId: string | undefined;
      try {
        this.assertCanRegisterBackground();
        const handle = await this.materialize(target);
        if (handle.accessor.get(IAgentLoopService).status().state === 'running') return failure(`Named agent "${target.taskName}" is already running; follow-up messages are not queued.`);
        controller = new AbortController();
        taskId = this.tasks.allocateTaskId?.('agent');
        if (taskId === undefined) throw new Error('Agent task service cannot allocate a transactional task id.');
        await this.metadata.registerAgent(target.agentId, {
          ...target.meta,
          labels: { ...target.meta.labels, [COLLABORATION_LATEST_TASK_LABEL]: taskId },
        });
        bridge = this.createDeferredRunBridge({ agentId: target.agentId, profileName: target.agentType,
          prompt: nonblank(args.message, 'message') }, controller);
        this.tasks.registerTask(
          new SubagentTask(bridge.handle, target.taskName, controller, { taskName: target.taskName, agentType: target.agentType }),
          { detached: true, timeoutMs: resolveSubagentTimeoutMs(this.config), taskId, deferVisibility: true },
        );
        const publication = await bridge.start(context.toolCallId);
        this.tasks.commitTaskRegistration?.(taskId);
        publication.publish();
        return success({ task_name: target.taskName, agent_id: target.agentId, task_id: taskId, agent_type: target.agentType, status: 'running' });
      } catch (error) {
        bridge?.cancel(error);
        controller?.abort(error);
        if (taskId !== undefined) await this.tasks.rollbackTaskRegistration?.(taskId, error);
        await this.metadata.registerAgent(target.agentId, target.meta).catch(() => {});
        return failure(errorMessage(error));
      } finally { pending.delete(target.agentId); }
    } catch (error) { return failure(errorMessage(error)); }
  }
}

export interface IInterruptAgentTool extends AgentTool<InterruptAgentInput> { readonly _serviceBrand: undefined; }
export const IInterruptAgentTool = createDecorator<IInterruptAgentTool>('interruptAgentTool');
export class InterruptAgentTool extends AgentCollaborationToolBase<InterruptAgentInput> implements IInterruptAgentTool {
  declare readonly _serviceBrand: undefined; readonly name = 'interrupt_agent'; readonly description = 'Interrupt the current turn of a named running adapter agent.';
  readonly parameters = INTERRUPT_AGENT_PARAMETERS;
  async run(args: InterruptAgentInput) {
    const raw = nonblank(args.target, 'target'); if (raw === 'root' || raw === 'main') return failure('The root agent cannot be interrupted by this tool.');
    const target = await this.target(raw); if ('error' in target) return failure(target.error);
    if (target.agentId === this.callerAgentId) return failure('An agent cannot interrupt itself with this tool.');
    if (target.latestTaskId === undefined || this.tasks.getTask(target.latestTaskId)?.status !== 'running') return failure(`Named agent "${target.taskName}" is not currently running.`);
    const info = await this.tasks.stop(target.latestTaskId, 'Interrupted by interrupt_agent');
    return success({ task_name: target.taskName, agent_id: target.agentId, task_id: target.latestTaskId, agent_type: target.agentType, status: statusOf(info?.status) });
  }
}

export interface ISendMessageTool extends AgentTool<SendMessageInput> { readonly _serviceBrand: undefined; }
export const ISendMessageTool = createDecorator<ISendMessageTool>('sendMessageTool');
export class SendMessageTool extends AgentCollaborationToolBase<SendMessageInput> implements ISendMessageTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'send_message';
  readonly description = 'Queue a message for a named adapter agent without starting or interrupting its turn.';
  readonly parameters = SEND_MESSAGE_PARAMETERS;

  async run(args: SendMessageInput, context: ExecutableToolContext): Promise<ExecutableToolResult> {
    try {
      const target = await this.target(nonblank(args.target, 'target'));
      if ('error' in target) return failure(target.error);
      if (target.agentId === this.callerAgentId) return failure('An agent cannot send a message to itself with this tool.');
      const acceptance = await this.messaging.send({
        sourceAgentId: this.callerAgentId,
        sourceTaskName: await this.callerTaskName(),
        targetAgentId: target.agentId,
        targetTaskName: target.taskName,
        content: nonblank(args.message, 'message'),
        idempotencyKey: context.toolCallId,
      });
      if (acceptance.payloadConflict) {
        return failure(`Message identity "${acceptance.message.messageId}" was already used with different content.`);
      }
      return success({
        message_id: acceptance.message.messageId,
        status: acceptance.delivery,
        deduplicated: acceptance.deduplicated,
        target: { task_name: target.taskName, agent_id: target.agentId },
      });
    } catch (error) {
      return failure(errorMessage(error));
    }
  }
}

function collaborationEnabled(accessor: ServicesAccessor): boolean {
  return accessor.get(IFlagService).enabled(AGENT_COLLABORATION_FLAG_ID) && accessor.get(IConfigService).get<AgentsConfig | undefined>(AGENTS_SECTION)?.enabled !== false;
}
registerAgentToolService(ISpawnAgentTool, SpawnAgentTool, { name: 'spawn_agent', domain: 'agentCollaboration', when: collaborationEnabled });
registerAgentToolService(IListAgentsTool, ListAgentsTool, { name: 'list_agents', domain: 'agentCollaboration', when: collaborationEnabled });
registerAgentToolService(IWaitAgentTool, WaitAgentTool, { name: 'wait_agent', domain: 'agentCollaboration', when: collaborationEnabled });
registerAgentToolService(IFollowupTaskTool, FollowupTaskTool, { name: 'followup_task', domain: 'agentCollaboration', when: collaborationEnabled });
registerAgentToolService(IInterruptAgentTool, InterruptAgentTool, { name: 'interrupt_agent', domain: 'agentCollaboration', when: collaborationEnabled });
registerAgentToolService(ISendMessageTool, SendMessageTool, { name: 'send_message', domain: 'agentCollaboration', when: collaborationEnabled });

function canonicalTaskName(value: string): string { if (!TASK_NAME.test(value) || value === 'root') throw new Error('task_name must match ^[a-z0-9_]+$ and must not be "root".'); return value; }
function nonblank(value: string, field: string): string { if (value.trim().length === 0) throw new Error(`${field} must be nonblank.`); return value; }
function optionalNonblank(value: string | undefined, field: string): string | undefined { return value === undefined ? undefined : nonblank(value, field).trim(); }
function statusOf(status: string | undefined): NamedStatus { if (status === 'running') return 'running'; if (status === 'completed') return 'completed'; if (status === 'killed' || status === 'timed_out') return 'interrupted'; return 'errored'; }
function success(value: unknown): ExecutableToolResult { return { output: JSON.stringify(value) }; }
function failure(message: string): ExecutableToolResult { return { output: message, isError: true }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
