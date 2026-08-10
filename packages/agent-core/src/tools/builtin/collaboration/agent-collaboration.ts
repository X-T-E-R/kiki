import { z } from 'zod';

import { AgentBackgroundTask } from '../../../agent/background/agent-task';
import type { BackgroundManager } from '../../../agent/background';
import type { BuiltinTool } from '../../../agent/tool';
import type { SessionSubagentHost, SubagentHandle } from '../../../session/subagent-host';
import { resolveSubagentTimeoutMs } from '../../../session/subagent-host';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

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
export const WaitAgentInputSchema = z.object({
  timeout_ms: z.number().int().min(10_000).max(3_600_000).optional(),
}).strict();
export const FollowupTaskInputSchema = z.object({
  target: z.string().trim().min(1),
  message: z.string().regex(NONBLANK),
}).strict();
export const InterruptAgentInputSchema = z.object({
  target: z.string().trim().min(1),
}).strict();

export type SpawnAgentInput = z.infer<typeof SpawnAgentInputSchema>;
export type WaitAgentInput = z.infer<typeof WaitAgentInputSchema>;
export type FollowupTaskInput = z.infer<typeof FollowupTaskInputSchema>;
export type InterruptAgentInput = z.infer<typeof InterruptAgentInputSchema>;

export const SPAWN_AGENT_PARAMETERS = toInputJsonSchema(SpawnAgentInputSchema);
export const LIST_AGENTS_PARAMETERS = toInputJsonSchema(ListAgentsInputSchema);
export const WAIT_AGENT_PARAMETERS = toInputJsonSchema(WaitAgentInputSchema);
export const FOLLOWUP_TASK_PARAMETERS = toInputJsonSchema(FollowupTaskInputSchema);
export const INTERRUPT_AGENT_PARAMETERS = toInputJsonSchema(InterruptAgentInputSchema);

type NamedStatus = 'running' | 'completed' | 'interrupted' | 'errored';

interface NamedAgentView {
  readonly task_name: string;
  readonly agent_id: string;
  readonly agent_type: string;
  readonly task_id?: string;
  readonly status: NamedStatus;
}

export class AgentCollaborationController {
  private readonly pendingRuns = new Set<string>();

  constructor(
    private readonly host: SessionSubagentHost,
    private readonly background: BackgroundManager,
    private readonly timeoutMs = resolveSubagentTimeoutMs(),
  ) {}

  async spawn(args: SpawnAgentInput, context: ExecutableToolContext): Promise<ExecutableToolResult> {
    const taskName = canonicalTaskName(args.task_name);
    const message = nonblank(args.message, 'message');
    const profileName = nonblank(args.agent_type ?? 'coder', 'agent_type');
    const modelAlias = optionalNonblank(args.model, 'model');
    const thinkingEffort = optionalNonblank(args.reasoning_effort, 'reasoning_effort');
    if (args.fork_turns !== undefined && !FORK_NONE.test(args.fork_turns)) {
      return failure('fork_turns supports only "none" in this experiment.');
    }
    if (!this.host.reserveNamedAgent(taskName)) {
      return failure(`Named agent "${taskName}" already exists in this session.`);
    }

    let handle: SubagentHandle | undefined;
    let controller: AbortController | undefined;
    let taskId: string | undefined;
    try {
      this.background.assertCanRegisterBackground();
      taskId = this.background.allocateTaskId('agent');
      controller = new AbortController();
      handle = await this.host.spawn({
        parentToolCallId: context.toolCallId,
        prompt: message,
        description: taskName,
        profileName,
        modelAlias,
        thinkingEffort,
        collaborationTaskName: taskName,
        collaborationTaskId: taskId,
        deferCollaborationRun: true,
        runInBackground: true,
        signal: controller.signal,
      });
      await this.register(handle, taskName, profileName, controller, taskId, true);
      this.background.commitTaskRegistration(taskId);
      this.host.commitNamedAgent(taskName);
      handle.publishPrepared?.();
      return success({ task_name: taskName, agent_id: handle.agentId, task_id: taskId,
        agent_type: handle.profileName, status: 'running', fork_turns: 'none' });
    } catch (error) {
      handle?.cancelPrepared?.(error);
      controller?.abort(error);
      if (taskId !== undefined) await this.background.rollbackTaskRegistration(taskId, error);
      if (handle !== undefined) await this.host.discardNamedAgent(handle.agentId).catch(() => {});
      this.host.releaseNamedAgent(taskName);
      return failure(errorMessage(error));
    }
  }

  list(): ExecutableToolResult {
    return success({ agents: this.views() });
  }

  async followup(args: FollowupTaskInput, context: ExecutableToolContext): Promise<ExecutableToolResult> {
    const target = this.resolveTarget(nonblank(args.target, 'target'));
    if ('error' in target) return failure(target.error);
    const current = target.latestTaskId === undefined ? undefined : this.background.getTask(target.latestTaskId);
    if (current?.status === 'running' || this.pendingRuns.has(target.agentId)) {
      return failure(`Named agent "${target.taskName}" is already running; follow-up messages are not queued.`);
    }
    this.pendingRuns.add(target.agentId);
    try {
      this.background.assertCanRegisterBackground();
      const controller = new AbortController();
      const handle = await this.host.resume(target.agentId, {
        parentToolCallId: context.toolCallId,
        prompt: nonblank(args.message, 'message'),
        description: target.taskName,
        runInBackground: true,
        signal: controller.signal,
      });
      const taskId = this.background.allocateTaskId('agent');
      await this.register(handle, target.taskName, target.agentType, controller, taskId);
      await this.host.recordNamedTask(handle.agentId, taskId);
      return success({ task_name: target.taskName, agent_id: target.agentId, task_id: taskId,
        agent_type: target.agentType, status: 'running' });
    } catch (error) {
      return failure(errorMessage(error));
    } finally {
      this.pendingRuns.delete(target.agentId);
    }
  }

  async interrupt(args: InterruptAgentInput): Promise<ExecutableToolResult> {
    const raw = nonblank(args.target, 'target');
    if (raw === 'root' || raw === 'main') return failure('The root agent cannot be interrupted by this tool.');
    const target = this.resolveTarget(raw);
    if ('error' in target) return failure(target.error);
    if (target.agentId === this.host.currentAgentId()) return failure('An agent cannot interrupt itself with this tool.');
    if (target.latestTaskId === undefined || this.background.getTask(target.latestTaskId)?.status !== 'running') {
      return failure(`Named agent "${target.taskName}" is not currently running.`);
    }
    const info = await this.background.stop(target.latestTaskId, 'Interrupted by interrupt_agent');
    return success({ task_name: target.taskName, agent_id: target.agentId,
      agent_type: target.agentType, task_id: target.latestTaskId, status: statusOf(info?.status) });
  }

  async wait(args: WaitAgentInput): Promise<ExecutableToolResult> {
    const timeoutMs = args.timeout_ms ?? 30_000;
    const running = this.views().filter((agent) => agent.status === 'running' && agent.task_id !== undefined);
    if (running.length === 0) return success({ timed_out: false, agents: this.views() });
    await Promise.race(running.map((agent) => this.background.wait(agent.task_id!, timeoutMs)));
    const timedOut = running.every((agent) => this.background.getTask(agent.task_id!)?.status === 'running');
    return success({ timed_out: timedOut, agents: this.views() });
  }

  private async register(
    handle: SubagentHandle,
    taskName: string,
    agentType: string,
    controller: AbortController,
    taskId: string,
    deferVisibility = false,
  ): Promise<void> {
    this.background.registerTask(
      new AgentBackgroundTask(handle, taskName, this.host, controller, { taskName, agentType }),
      { detached: true, timeoutMs: this.timeoutMs, taskId, deferVisibility },
    );
  }

  private named() { return this.host.namedAgents(); }

  private views(): NamedAgentView[] {
    return this.named().map((agent) => ({
      task_name: agent.taskName,
      agent_id: agent.agentId,
      agent_type: agent.agentType,
      task_id: agent.latestTaskId,
      status: statusOf(agent.latestTaskId === undefined ? undefined : this.background.getTask(agent.latestTaskId)?.status),
    }));
  }

  private resolveTarget(target: string) {
    const matches = this.named().filter((agent) => agent.taskName === target || agent.agentId === target);
    if (matches.length === 1) return matches[0]!;
    return { error: `No named adapter agent matches "${target}". Use list_agents to find a task_name or agent_id; legacy anonymous children are not supported.` };
  }
}

abstract class CollaborationTool<T> implements BuiltinTool<T> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: Record<string, unknown>;
  constructor(protected readonly controller: AgentCollaborationController) {}
  abstract run(args: T, context: ExecutableToolContext): Promise<ExecutableToolResult> | ExecutableToolResult;
  resolveExecution(args: T): ToolExecution {
    return { description: this.description, accesses: ToolAccesses.none(), approvalRule: this.name,
      execute: async (context) => this.run(args, context) };
  }
}

export class SpawnAgentTool extends CollaborationTool<SpawnAgentInput> {
  readonly name = 'spawn_agent';
  readonly description = 'Start one named subagent asynchronously with fresh context.';
  readonly parameters = SPAWN_AGENT_PARAMETERS;
  run(args: SpawnAgentInput, context: ExecutableToolContext) { return this.controller.spawn(args, context); }
}
export class ListAgentsTool extends CollaborationTool<Record<string, never>> {
  readonly name = 'list_agents';
  readonly description = 'List named adapter agents in task-name order.';
  readonly parameters = LIST_AGENTS_PARAMETERS;
  run() { return this.controller.list(); }
}
export class WaitAgentTool extends CollaborationTool<WaitAgentInput> {
  readonly name = 'wait_agent';
  readonly description = 'Wait until a named running agent settles or the timeout expires.';
  readonly parameters = WAIT_AGENT_PARAMETERS;
  run(args: WaitAgentInput) { return this.controller.wait(args); }
}
export class FollowupTaskTool extends CollaborationTool<FollowupTaskInput> {
  readonly name = 'followup_task';
  readonly description = 'Start one new turn on an idle named adapter agent.';
  readonly parameters = FOLLOWUP_TASK_PARAMETERS;
  run(args: FollowupTaskInput, context: ExecutableToolContext) { return this.controller.followup(args, context); }
}
export class InterruptAgentTool extends CollaborationTool<InterruptAgentInput> {
  readonly name = 'interrupt_agent';
  readonly description = 'Interrupt the current turn of a named running adapter agent.';
  readonly parameters = INTERRUPT_AGENT_PARAMETERS;
  run(args: InterruptAgentInput) { return this.controller.interrupt(args); }
}

function canonicalTaskName(value: string): string {
  if (!TASK_NAME.test(value) || value === 'root') throw new Error('task_name must match ^[a-z0-9_]+$ and must not be "root".');
  return value;
}
function nonblank(value: string, field: string): string {
  if (value.trim().length === 0) throw new Error(`${field} must be nonblank.`);
  return value;
}
function optionalNonblank(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : nonblank(value, field).trim();
}
function statusOf(status: string | undefined): NamedStatus {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'killed' || status === 'timed_out') return 'interrupted';
  return 'errored';
}
function success(value: unknown): ExecutableToolResult { return { output: JSON.stringify(value) }; }
function failure(message: string): ExecutableToolResult { return { output: message, isError: true }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
