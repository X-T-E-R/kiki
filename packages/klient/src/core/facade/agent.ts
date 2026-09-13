/**
 * The agent facade — one `session.agent(id)` handle over the agent-scope
 * services the wire exposes. Turn-driving calls (prompt / steer / cancel),
 * skill activation, permission mode, and commands go straight to their domain
 * services, as do shell commands, model, usage, plan, and task calls;
 * `getContext` merges two reads client-side. Prompt streaming is
 * NOT on this interface: it flows through the agent's `events` hub
 * (`turn.*`, `assistant.delta`, `tool.call.*`, `prompt.completed`, …).
 */

import type { IAgentLoopService } from '@kiki/agent-core-v2/agent/loop/loop';
import type { IAgentCommandService } from '@kiki/agent-core-v2/agent/command/agentCommand';
import type { IAgentContextMemoryService } from '@kiki/agent-core-v2/agent/contextMemory/contextMemory';
import type { IAgentContextInjectorService } from '@kiki/agent-core-v2/agent/contextInjector/contextInjector';
import type { IAgentConversationUndoService } from '@kiki/agent-core-v2/agent/undo/undo';
import type { IAgentMcpService } from '@kiki/agent-core-v2/agent/mcp/mcp';
import type { IAgentPluginCommandService } from '@kiki/agent-core-v2/agent/pluginCommand/pluginCommand';
import type { IAgentPluginService } from '@kiki/agent-core-v2/agent/plugin/agentPlugin';
import type { IAgentRuntimeBindingService } from '@kiki/agent-core-v2/agent/runtimeBinding/runtimeBinding';
import type { IAgentPromptService } from '@kiki/agent-core-v2/agent/prompt/prompt';
import type { IAgentTokenCountingService } from '@kiki/agent-core-v2/agent/tokenCounting/tokenCounting';
import type { IAgentPlanService } from '@kiki/agent-core-v2/features/plan/plan';
import type { IAgentProfileService } from '@kiki/agent-core-v2/agent/profile/profile';
import type { IAgentShellCommandService } from '@kiki/agent-core-v2/agent/shellCommand/shellCommand';
import type { IAgentSkillService } from '@kiki/agent-core-v2/agent/skill/skill';
import type { IAgentSwarmService } from '@kiki/agent-core-v2/features/swarm/agent/swarm';
import type { IAgentUsageService } from '@kiki/agent-core-v2/agent/usage/usage';
import type { ContextMessage } from '@kiki/agent-core-v2/agent/contextMemory/types';
import type { ContentPart } from '@kiki/agent-core-v2/kosong/contract/message';
import type { ModelCapability } from '@kiki/agent-core-v2/kosong/contract/capability';
import type { PermissionMode } from '@kiki/agent-core-v2/agent/permissionPolicy/types';

import type { McpServerConfig } from '../../contract/mcp.js';
import type { AgentTaskInfo } from '../../contract/agent/schemas.js';
import type { ScopeRef } from '../channel.js';
import type { ScopedCaller } from './session.js';

export type PromptLaunchResult = Awaited<ReturnType<IAgentPromptService['submit']>>;
export type PromptWithSkillsInput = Parameters<IAgentSkillService['promptWithSkills']>[0];
export type PromptWithSkillsResult = Awaited<ReturnType<IAgentSkillService['promptWithSkills']>>;
export type ShellCommandResult = Awaited<ReturnType<IAgentShellCommandService['run']>>;
export type SetModelResult = Awaited<ReturnType<IAgentProfileService['setModel']>>;
export type ThinkingLevel = ReturnType<IAgentProfileService['getEffectiveThinkingLevel']>;
export type AgentLoopStatus = ReturnType<IAgentLoopService['status']>;
export type UsageStatus = Awaited<ReturnType<IAgentUsageService['status']>>;
export type AgentContextData = {
  history: ReturnType<IAgentContextMemoryService['get']>;
  tokenCount: ReturnType<IAgentTokenCountingService['statusSize']>;
};
export type AgentCommandInfo = Awaited<ReturnType<IAgentCommandService['list']>>[number];
export type RuntimeBinding = ReturnType<IAgentRuntimeBindingService['get']>;
export type PlanData = Awaited<ReturnType<IAgentPlanService['status']>>;
export type { AgentTaskInfo } from '../../contract/agent/schemas.js';
export type McpServerEntry = ReturnType<IAgentMcpService['list']>[number];

export interface AgentFacade {
  prompt(input: Parameters<IAgentPromptService['submit']>[0]): Promise<PromptLaunchResult>;
  /** Wait for this prompt's terminal receipt, not ordinary turn events. Aborting stops only the wait. */
  prompt(
    input: Parameters<IAgentPromptService['submit']>[0],
    options: { waitFor: 'terminal'; signal?: AbortSignal },
  ): Promise<Awaited<ReturnType<IAgentPromptService['submitAndWait']>>>;
  /**
   * Submit one prompt with one or more skill activations bundled into the
   * same user message: the skills are validated up front (an unknown name or
   * an empty list rejects the whole submission), rendered ahead of the
   * caller's parts in the same turn, and the bundle undoes as a single
   * anchor. Resolves with the submitted bundle's queue identity (`prompt_id`
   * / `created_at` / `state`), plus `turn_id` once launched — `state` is
   * `queued` when the submission queued behind a running turn.
   */
  promptWithSkills(input: PromptWithSkillsInput): Promise<PromptWithSkillsResult>;
  steer(input: { input: readonly ContentPart[] }): Promise<PromptLaunchResult>;
  /**
   * Activate a skill as a user-slash activation: the engine renders the skill
   * prompt and drives it as a normal turn (same settlement/event flow as
   * `prompt`). Resolves with the launched turn id; rejects when the skill is
   * unknown or the agent is busy.
   */
  activateSkill(input: { name: string; args?: string }): Promise<PromptLaunchResult>;
  activatePluginCommand(
    input: Parameters<IAgentPluginCommandService['activate']>[0],
  ): Promise<void>;
  refreshPluginSessionStart(): ReturnType<IAgentPluginService['refreshSessionStart']>;
  cancel(input?: { turnId?: number }): Promise<void>;
  getLoopStatus(): Promise<AgentLoopStatus>;
  runShellCommand(input: { command: string; commandId?: string }): Promise<ShellCommandResult>;
  cancelShellCommand(input: { commandId: string }): Promise<void>;
  getModel(): Promise<string>;
  setModel(model: string): Promise<SetModelResult>;
  getThinking(): Promise<ThinkingLevel>;
  setThinking(level: string): Promise<void>;
  getModelCapabilities(): Promise<ModelCapability>;
  getAgentsMdWarning(): Promise<string | undefined>;
  getPermission(): Promise<PermissionMode>;
  /** Defaults to broadcasting to live agents; false changes only this agent's mode. */
  setPermission(mode: PermissionMode, options?: { broadcast?: boolean }): Promise<void>;
  getGoal(): Promise<import('@kiki/agent-core-v2/agent/goal/types').GoalToolResult>;
  createGoal(input: import('@kiki/agent-core-v2/agent/goal/types').CreateGoalInput): Promise<import('@kiki/agent-core-v2/agent/goal/types').GoalSnapshot>;
  pauseGoal(): Promise<import('@kiki/agent-core-v2/agent/goal/types').GoalSnapshot>;
  resumeGoal(): Promise<import('@kiki/agent-core-v2/agent/goal/types').GoalSnapshot>;
  cancelGoal(): Promise<import('@kiki/agent-core-v2/agent/goal/types').GoalSnapshot>;
  getUsage(): Promise<UsageStatus>;
  getContext(): Promise<AgentContextData>;
  appendContext(message: ContextMessage): Promise<void>;
  appendImportedContext(message: ContextMessage): Promise<void>;
  clearContext(): Promise<void>;
  undo(count: Parameters<IAgentConversationUndoService['undo']>[0]): Promise<number>;
  listCommands(): Promise<readonly AgentCommandInfo[]>;
  runCommand(input: { name: string; args?: string }): Promise<void>;
  getRuntime(): Promise<RuntimeBinding>;
  switchRuntime(runtimeId: string): Promise<RuntimeBinding>;
  getPlan(): Promise<PlanData>;
  enterPlan(): Promise<void>;
  clearPlan(): Promise<void>;
  cancelPlan(input?: { id?: string }): Promise<void>;
  enterSwarm(trigger: Parameters<IAgentSwarmService['enter']>[0]): Promise<void>;
  exitSwarm(): Promise<void>;
  getSwarmMode(): Promise<boolean>;
  reconcileContextWhenIdle(
    name: Parameters<IAgentContextInjectorService['reconcileWhenIdle']>[0],
  ): Promise<void>;
  getTasks(input?: { activeOnly?: boolean; limit?: number }): Promise<readonly AgentTaskInfo[]>;
  stopTask(input: { taskId: string; reason?: string }): Promise<void>;
  stopTaskWithReason(input: { taskId: string; reason?: string }): Promise<void>;
  detachTask(taskId: string): Promise<AgentTaskInfo | undefined>;
  getTaskOutput(input: { taskId: string; tail?: number }): Promise<string>;
  /**
   * Session-merged MCP server entries (workspace set + ephemeral session
   * overlay). This is a live snapshot, so entries may still be pending while
   * the initial connection attempt runs.
   */
  getMcpServers(): Promise<readonly McpServerEntry[]>;
  waitForMcpInitialLoad(): Promise<void>;
  getMcpStartupDuration(): Promise<number>;
  reconnectMcpServer(name: string): Promise<void>;
  connectMcpServer(input: { name: string; config: McpServerConfig }): Promise<void>;
  /**
   * Trigger a manual full compaction. Async: `true` means the compaction was
   * started (it runs in the background); `false` means one is already running.
   * Throws when there is nothing to compact or a turn is active.
   */
  compact(input?: { instruction?: string }): Promise<boolean>;
  cancelCompaction(): Promise<void>;
  isCompacting(): Promise<boolean>;
}

export function createAgentFacade(call: ScopedCaller, scope: ScopeRef): AgentFacade {
  function prompt(input: Parameters<IAgentPromptService['submit']>[0]): Promise<PromptLaunchResult>;
  function prompt(input: Parameters<IAgentPromptService['submit']>[0], options: { waitFor: 'terminal'; signal?: AbortSignal }): ReturnType<IAgentPromptService['submitAndWait']>;
  function prompt(input: Parameters<IAgentPromptService['submit']>[0], options?: { waitFor: 'terminal'; signal?: AbortSignal }) {
    return call(scope, 'agentPromptService', options?.waitFor === 'terminal' ? 'submitAndWait' : 'submit', [input],
      options === undefined ? undefined : { timeoutMs: 0, signal: options.signal },
    ) as Promise<PromptLaunchResult | Awaited<ReturnType<IAgentPromptService['submitAndWait']>>>;
  }
  return {
    prompt,
    promptWithSkills: (input) =>
      call(scope, 'agentSkillService', 'promptWithSkills', [input]) as Promise<PromptWithSkillsResult>,
    steer: (input) =>
      call(scope, 'agentPromptService', 'submitSteer', [input]) as Promise<PromptLaunchResult>,
    activateSkill: (input) =>
      call(scope, 'agentSkillService', 'activate', [input]) as Promise<PromptLaunchResult>,
    activatePluginCommand: (input) =>
      call(scope, 'agentPluginCommandService', 'activate', [input]) as Promise<void>,
    refreshPluginSessionStart: () =>
      call(scope, 'agentPluginService', 'refreshSessionStart', []) as Promise<void>,
    cancel: (input) =>
      // No turnId sends an empty arg list: `[undefined]` would cross the wire
      // as `[null]`, and `cancelFromUser(null)` would not match the active turn.
      call(scope, 'agentLoopService', 'cancelFromUser', input?.turnId === undefined ? [] : [input.turnId]) as Promise<void>,
    getLoopStatus: () =>
      call(scope, 'agentLoopService', 'status', []) as Promise<AgentLoopStatus>,
    runShellCommand: (input) =>
      call(scope, 'agentShellCommandService', 'run', [input]) as Promise<ShellCommandResult>,
    cancelShellCommand: (input) =>
      call(scope, 'agentShellCommandService', 'cancel', [input.commandId]) as Promise<void>,
    getModel: () => call(scope, 'agentProfileService', 'getModel', []) as Promise<string>,
    setModel: (model) =>
      call(scope, 'agentProfileService', 'setModel', [model]) as Promise<SetModelResult>,
    getThinking: () =>
      call(scope, 'agentProfileService', 'getEffectiveThinkingLevel', []) as Promise<ThinkingLevel>,
    setThinking: (level) =>
      call(scope, 'agentProfileService', 'setThinking', [level]) as Promise<void>,
    getModelCapabilities: () =>
      call(scope, 'agentProfileService', 'getModelCapabilities', []) as Promise<ModelCapability>,
    getAgentsMdWarning: () =>
      call(scope, 'agentProfileService', 'getAgentsMdWarning', []) as Promise<string | undefined>,
    getPermission: () => call(scope, 'agentPermissionModeService', 'mode', []) as Promise<PermissionMode>,
    setPermission: (mode, options) =>
      call(scope, 'agentPermissionModeService', options?.broadcast === false ? 'setMode' : 'setModeAndBroadcast', [mode]) as Promise<void>,
    getGoal: () => call(scope, 'agentGoalService', 'getGoal', []) as ReturnType<AgentFacade['getGoal']>,
    createGoal: (input) => call(scope, 'agentGoalService', 'createGoal', [input]) as ReturnType<AgentFacade['createGoal']>,
    pauseGoal: () => call(scope, 'agentGoalService', 'pauseGoal', []) as ReturnType<AgentFacade['pauseGoal']>,
    resumeGoal: () => call(scope, 'agentGoalService', 'resumeGoal', []) as ReturnType<AgentFacade['resumeGoal']>,
    cancelGoal: () => call(scope, 'agentGoalService', 'cancelGoal', []) as ReturnType<AgentFacade['cancelGoal']>,
    getUsage: () => call(scope, 'agentUsageService', 'status', []) as Promise<UsageStatus>,
    getContext: async () => {
      const [history, tokenCount] = await Promise.all([
        call(scope, 'agentContextMemoryService', 'get', []),
        call(scope, 'agentTokenCountingService', 'statusSize', []),
      ]);
      return { history, tokenCount } as AgentContextData;
    },
    appendContext: (message) =>
      call(scope, 'agentContextMemoryService', 'append', [message]) as Promise<void>,
    appendImportedContext: (message) =>
      call(scope, 'agentContextMutationService', 'appendImported', [message]) as Promise<void>,
    clearContext: () =>
      call(scope, 'agentContextMemoryService', 'clear', []) as Promise<void>,
    undo: (count) =>
      call(scope, 'agentConversationUndoService', 'undo', [count]) as Promise<number>,
    listCommands: () =>
      call(scope, 'agentCommandService', 'list', []) as Promise<readonly AgentCommandInfo[]>,
    runCommand: (input) =>
      // Same `[undefined]` → `[null]` wire hazard as `cancel`: the engine's
      // `args = ''` default only applies to a missing arg.
      call(
        scope,
        'agentCommandService',
        'run',
        input.args === undefined ? [input.name] : [input.name, input.args],
      ) as Promise<void>,
    getRuntime: () =>
      call(scope, 'agentRuntimeBindingService', 'get', []) as Promise<RuntimeBinding>,
    switchRuntime: (runtimeId) =>
      call(scope, 'agentRuntimeBindingService', 'switch', [runtimeId]) as Promise<RuntimeBinding>,
    getPlan: () => call(scope, 'agentPlanService', 'status', []) as Promise<PlanData>,
    enterPlan: () => call(scope, 'agentPlanService', 'enter', []) as Promise<void>,
    clearPlan: () => call(scope, 'agentPlanService', 'clear', []) as Promise<void>,
    cancelPlan: (input) =>
      call(scope, 'agentPlanService', 'cancel', [input?.id]) as Promise<void>,
    enterSwarm: (trigger) =>
      call(scope, 'agentSwarmService', 'enter', [trigger]) as Promise<void>,
    exitSwarm: () => call(scope, 'agentSwarmService', 'exit', []) as Promise<void>,
    getSwarmMode: () =>
      call(scope, 'agentSwarmService', 'isActive', []) as Promise<boolean>,
    reconcileContextWhenIdle: (name) =>
      call(scope, 'agentContextInjectorService', 'reconcileWhenIdle', [name]) as Promise<void>,
    getTasks: (input) =>
      call(scope, 'agentTaskService', 'list', [
        input?.activeOnly ?? false,
        input?.limit,
      ]) as Promise<readonly AgentTaskInfo[]>,
    stopTask: async (input) => {
      if (input.reason === undefined) {
        await call(scope, 'agentTaskService', 'stopByUser', [input.taskId]);
        return;
      }
      await call(scope, 'agentTaskService', 'stop', [input.taskId, input.reason]);
    },
    stopTaskWithReason: (input) =>
      call(
        scope,
        'agentTaskService',
        'stop',
        input.reason === undefined ? [input.taskId] : [input.taskId, input.reason],
      ).then(() => undefined),
    detachTask: (taskId) =>
      call(scope, 'agentTaskService', 'detach', [taskId]) as Promise<AgentTaskInfo | undefined>,
    getTaskOutput: (input) =>
      call(scope, 'agentTaskService', 'readOutput', [input.taskId, input.tail]) as Promise<string>,
    getMcpServers: () =>
      call(scope, 'agentMcpService', 'list', []) as Promise<readonly McpServerEntry[]>,
    waitForMcpInitialLoad: () =>
      call(scope, 'agentMcpService', 'waitForInitialLoad', []) as Promise<void>,
    getMcpStartupDuration: () =>
      call(scope, 'agentMcpService', 'initialLoadDurationMs', []) as Promise<number>,
    reconnectMcpServer: (name) =>
      call(scope, 'agentMcpService', 'reconnect', [name]) as Promise<void>,
    connectMcpServer: (input) =>
      call(scope, 'agentMcpService', 'connect', [input.name, input.config]) as Promise<void>,
    compact: (input) =>
      call(scope, 'agentFullCompactionService', 'begin', [
        { source: 'manual', instruction: input?.instruction },
      ]) as Promise<boolean>,
    cancelCompaction: () =>
      call(scope, 'agentFullCompactionService', 'cancel', []) as Promise<void>,
    isCompacting: () =>
      call(scope, 'agentFullCompactionService', 'isCompacting', []) as Promise<boolean>,
  };
}
