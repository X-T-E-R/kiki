/**
 * Agent-scope domain service contracts. These mirror the signatures of the
 * engine's domain Services (prompt / skill / loop / permissionMode / command /
 * contextMemory / tokenCounting / shellCommand / profile / usage / plan /
 * task) that the agent facade calls directly; payload and result schemas are
 * shared in `agent/schemas.ts` (they mirror the same wire shapes).
 */

import { z } from 'zod';
import { goalBudgetPatchSchema } from '@kiki/protocol';

import { maybe, noResult } from '../helpers.js';
import { mcpServerConfigSchema } from '../mcp.js';
import {
  mcpServerAuthStateSchema,
  mcpServerConfigDataSchema,
  mcpServerLocatorSchema,
} from '../global/mcpManagement.js';
import type { ServiceContract } from '../types.js';
import { goalSnapshotSchema } from './events.js';
import { modelSwitchInputSchema, modelSwitchModeSchema, modelSwitchReceiptSchema, queuedModelSwitchSchema } from './modelSwitch.js';
import {
  promptTerminalResultSchema,
  activateSkillPayloadSchema,
  agentCommandInfoSchema,
  agentLoopStatusSchema,
  contextRebuildControlSchema,
  contextRebuildResultSchema,
  contextStrategySchema,
  contextStrategyStatusSchema,
  agentTaskInfoSchema,
  modelCapabilitySchema,
  permissionModeSchema,
  planDataSchema,
  promptLaunchResultSchema,
  promptPayloadSchema,
  promptWithSkillsPayloadSchema,
  promptWithSkillsResultSchema,
  runShellCommandPayloadSchema,
  runtimeBindingSchema,
  setEffortResultSchema,
  setModelResultSchema,
  shellCommandResultSchema,
  steerPayloadSchema,
  usageStatusSchema,
} from './schemas.js';
import { lazyContract } from '../lazyContract.js';

export const agentGoalContract = {
  getGoal: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.object({ goal: goalSnapshotSchema.nullable() }) }), 'input', 'output'),
  createGoal: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.object({
      objective: z.string(),
      completionCriterion: z.string().optional(),
      followUpTiming: z.enum(['subagents_done', 'tasks_done']).optional(),
      initialStatus: z.enum(['active', 'paused']).optional(),
      replace: z.boolean().optional(),
    })]),
    output: goalSnapshotSchema,
  }), 'input', 'output'),
  updateGoal: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.object({
      goalId: z.string(),
      expectedRevision: z.number().int().nonnegative().optional(),
      objective: z.string().optional(),
      completionCriterion: z.string().nullable().optional(),
      followUpTiming: z.enum(['subagents_done', 'tasks_done']).optional(),
      budgetLimits: goalBudgetPatchSchema.optional(),
    })]),
    output: goalSnapshotSchema,
  }), 'input', 'output'),
  pauseGoal: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: goalSnapshotSchema }), 'input', 'output'),
  resumeGoal: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.object({
      reason: z.string().optional(),
      continueIfPaused: z.boolean().optional(),
      continueIfBlocked: z.boolean().optional(),
    }).optional()]),
    output: goalSnapshotSchema,
  }), 'input', 'output'),
  cancelGoal: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: goalSnapshotSchema }), 'input', 'output'),
} satisfies ServiceContract;

export const agentPromptContract = {
  switchModel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([modelSwitchInputSchema]), output: modelSwitchReceiptSchema }), 'input', 'output'),
  getModelSwitch: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: /* @__PURE__ */ maybe(modelSwitchReceiptSchema) }), 'input', 'output'),
  listModelSwitches: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.object({ observe: z.literal(true) }).strict().optional()]), output: /* @__PURE__ */ z.array(queuedModelSwitchSchema) }), 'input', 'output'),
  updateModelSwitch: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([modelSwitchInputSchema, z.number().int().nonnegative().optional()]), output: modelSwitchReceiptSchema }), 'input', 'output'),
  cancelModelSwitch: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: modelSwitchReceiptSchema }), 'input', 'output'),
  recoverModelSwitch: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.union([
      z.tuple([z.string(), z.literal('retry'), modelSwitchModeSchema.optional()]),
      z.tuple([z.string(), z.literal('keep_original')]),
    ]),
    output: modelSwitchReceiptSchema,
  }), 'input', 'output'),
  submit: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([promptPayloadSchema]),
    output: /* @__PURE__ */ maybe(promptLaunchResultSchema),
  }), 'input', 'output'),
  submitAndWait: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([promptPayloadSchema]),
    output: promptTerminalResultSchema,
  }), 'input', 'output'),
  submitSteer: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([steerPayloadSchema]),
    output: /* @__PURE__ */ maybe(promptLaunchResultSchema),
  }), 'input', 'output'),
  resumeRecoveredQueue: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

export const agentSkillContract = {
  activate: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([activateSkillPayloadSchema]), output: /* @__PURE__ */ z.union([promptWithSkillsResultSchema, promptLaunchResultSchema]) }), 'input', 'output'),
  promptWithSkills: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([promptWithSkillsPayloadSchema]),
    output: promptWithSkillsResultSchema,
  }), 'input', 'output'),
} satisfies ServiceContract;

export const agentContextInjectorContract = {
  reconcileWhenIdle: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

export const agentContextRebuildContract = {
  rebuild: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: contextRebuildResultSchema }), 'input', 'output'),
  control: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: contextRebuildControlSchema }), 'input', 'output'),
  setEnabled: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.boolean()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

export const agentConversationUndoContract = {
  undo: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]),
    output: /* @__PURE__ */ z.number(),
  }), 'input', 'output'),
} satisfies ServiceContract;

export const agentPluginCommandContract = {
  activate: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.object({
      pluginId: z.string(),
      commandName: z.string(),
      args: z.string().optional(),
    })]),
    output: noResult,
  }), 'input', 'output'),
} satisfies ServiceContract;

export const agentPluginContract = {
  refreshSessionStart: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

export const agentExecutionContract = {
  cancel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string().optional()]), output: /* @__PURE__ */ z.boolean() }), 'input', 'output'),
  shutdown: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string().optional()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

export const agentLoopContract = {
  cancelFromUser: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.number().optional()]), output: noResult }), 'input', 'output'),
  status: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: agentLoopStatusSchema }), 'input', 'output'),
} satisfies ServiceContract;

export const agentPermissionModeContract = {
  mode: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: permissionModeSchema }), 'input', 'output'),
  setMode: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([permissionModeSchema]), output: noResult }), 'input', 'output'),
  setModeAndBroadcast: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([permissionModeSchema]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

export const agentCommandContract = {
  list: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(agentCommandInfoSchema) }), 'input', 'output'),
  run: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string(), z.string().optional()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

export const agentRuntimeBindingContract = {
  get: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: runtimeBindingSchema }), 'input', 'output'),
  set: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([runtimeBindingSchema]), output: runtimeBindingSchema }), 'input', 'output'),
  switch: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: runtimeBindingSchema }), 'input', 'output'),
} satisfies ServiceContract;

/** `history` items are full `ContextMessage`s, mirrored as `unknown`. */
export const agentContextMemoryContract = {
  get: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(z.unknown()) }), 'input', 'output'),
  append: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.unknown()]), output: noResult }), 'input', 'output'),
  clear: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

export const agentContextMutationContract = {
  appendImported: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.unknown()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

export const agentTokenCountingContract = {
  statusSize: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.number() }), 'input', 'output'),
} satisfies ServiceContract;

export const agentShellCommandContract = {
  run: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([runShellCommandPayloadSchema]),
    output: shellCommandResultSchema,
  }), 'input', 'output'),
  cancel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

export const profileToolPolicyStatusSchema = /* @__PURE__ */ z.object({
  definitionId: z.string().optional(),
  source: z.enum(['declared', 'inherited-default', 'builtin-default']).optional(),
  activeTools: z.array(z.string()).readonly().optional(),
  currentTools: z.array(z.string()).readonly().optional(),
  revision: z.string().optional(),
  canRefresh: z.boolean(),
  reason: z.enum(['main_only', 'binding_restricted', 'source_changed', 'source_unavailable']).optional(),
});

export const agentToolPolicyContract = {
  isToolActive: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string(), z.enum(['builtin', 'user', 'mcp', 'plugin']).optional()]), output: /* @__PURE__ */ z.boolean() }), 'input', 'output'),
} satisfies ServiceContract;

export const agentProfileContract = {
  inspectToolPolicy: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: profileToolPolicyStatusSchema }), 'input', 'output'),
  refreshToolPolicy: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string().min(1)]), output: profileToolPolicyStatusSchema }), 'input', 'output'),
  getModel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.string() }), 'input', 'output'),
  setModel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: setModelResultSchema }), 'input', 'output'),
  setEffort: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: setEffortResultSchema }), 'input', 'output'),
  setThinking: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
  getEffectiveThinkingLevel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.string() }), 'input', 'output'),
  getModelCapabilities: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: modelCapabilitySchema }), 'input', 'output'),
  getAgentsMdWarning: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ maybe(z.string()) }), 'input', 'output'),
} satisfies ServiceContract;

export const agentUsageContract = {
  status: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: usageStatusSchema }), 'input', 'output'),
} satisfies ServiceContract;

export const agentPlanContract = {
  status: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: planDataSchema }), 'input', 'output'),
  enter: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: noResult }), 'input', 'output'),
  exit: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: noResult }), 'input', 'output'),
  clear: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: noResult }), 'input', 'output'),
  cancel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string().optional()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

/** `McpServerEntry` from the engine's `mcpCore/connection-manager`. */
export const mcpServerEntrySchema = /* @__PURE__ */ z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http', 'sse']),
  status: z.enum(['pending', 'connected', 'failed', 'disabled', 'needs-auth', 'removed']),
  toolCount: z.number(),
  error: z.string().optional(),
});

export const mcpSessionOverrideSchema = /* @__PURE__ */ z.object({
  locator: mcpServerLocatorSchema,
  override: z.enum(['on', 'off', 'inherit']),
});

export const mcpSessionCapabilitySchema = /* @__PURE__ */ z.object({
  locator: mcpServerLocatorSchema,
  runtimeName: z.string(),
  origin: z.enum(['global', 'plugin', 'caller']),
  config: z.discriminatedUnion('transport', [
    mcpServerConfigDataSchema.options[0].omit({ env: true }),
    mcpServerConfigDataSchema.options[1].omit({ headers: true }),
    mcpServerConfigDataSchema.options[2].omit({ headers: true }),
  ]),
  authStatus: mcpServerAuthStateSchema,
  connection: z.enum(['enabled', 'disabled', 'connecting', 'connected', 'failed', 'unavailable']),
  override: z.enum(['on', 'off', 'inherit']),
  error: z.string().optional(),
  errorCode: z.literal('tool_catalog_refresh_failed').optional(),
});

export const agentMcpContract = {
  list: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(mcpServerEntrySchema) }), 'input', 'output'),
  waitForInitialLoad: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: noResult }), 'input', 'output'),
  initialLoadDurationMs: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.number() }), 'input', 'output'),
  reconnect: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
  connect: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string(), mcpServerConfigSchema]),
    output: noResult,
  }), 'input', 'output'),
  listMcpSessionCapabilities: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(mcpSessionCapabilitySchema) }), 'input', 'output'),
  setMcpSessionOverride: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([mcpSessionOverrideSchema]),
    output: mcpSessionCapabilitySchema,
  }), 'input', 'output'),
} satisfies ServiceContract;

/** `FullCompactionInput` from the engine's `agent/fullCompaction`. */
export const fullCompactionInputSchema = /* @__PURE__ */ z.object({
  source: z.enum(['manual', 'auto']),
  instruction: z.string().optional(),
});

export const agentFullCompactionContract = {
  begin: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([fullCompactionInputSchema]), output: /* @__PURE__ */ z.boolean() }), 'input', 'output'),
  cancel: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: noResult }), 'input', 'output'),
  isCompacting: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.boolean() }), 'input', 'output'),
  getAutoCompact: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.object({
    tokens: z.number(), source: z.enum(['session', 'profile', 'model', 'global', 'legacy']),
    effectiveMaxContextTokens: z.number(), reservedContextTokens: z.number(),
  }) }), 'input', 'output'),
  getDefaultAutoCompact: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.object({
    tokens: z.number(), source: z.enum(['session', 'profile', 'model', 'global', 'legacy']),
    effectiveMaxContextTokens: z.number(), reservedContextTokens: z.number(),
  }) }), 'input', 'output'),
  setAutoCompactOverride: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.number().int().positive().safe().nullable()]), output: noResult }), 'input', 'output'),
  getContextStrategy: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: contextStrategyStatusSchema }), 'input', 'output'),
  setContextStrategyOverride: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([contextStrategySchema.nullable()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

export const agentTaskContract = {
  list: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.boolean().optional(), z.number().optional()]),
    output: /* @__PURE__ */ z.array(agentTaskInfoSchema),
  }), 'input', 'output'),
  stopByUser: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: /* @__PURE__ */ maybe(agentTaskInfoSchema) }), 'input', 'output'),
  stop: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string(), z.string().optional()]),
    output: /* @__PURE__ */ maybe(agentTaskInfoSchema),
  }), 'input', 'output'),
  detach: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: /* @__PURE__ */ maybe(agentTaskInfoSchema) }), 'input', 'output'),
  readOutput: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string(), z.number().optional()]),
    output: /* @__PURE__ */ z.string(),
  }), 'input', 'output'),
} satisfies ServiceContract;
