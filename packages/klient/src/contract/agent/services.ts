/**
 * Agent-scope domain service contracts. These mirror the signatures of the
 * engine's domain Services (prompt / skill / loop / permissionMode / command /
 * contextMemory / tokenCounting / shellCommand / profile / usage / plan /
 * task) that the agent facade calls directly; payload and result schemas are
 * shared in `agent/schemas.ts` (they mirror the same wire shapes).
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import { mcpServerConfigSchema } from '../mcp.js';
import type { ServiceContract } from '../types.js';
import { goalSnapshotSchema } from './events.js';
import {
  promptTerminalResultSchema,
  activateSkillPayloadSchema,
  agentCommandInfoSchema,
  agentLoopStatusSchema,
  contextRebuildResultSchema,
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
  setModelResultSchema,
  shellCommandResultSchema,
  steerPayloadSchema,
  usageStatusSchema,
} from './schemas.js';

export const agentGoalContract = {
  getGoal: { input: z.tuple([]), output: z.object({ goal: goalSnapshotSchema.nullable() }) },
  createGoal: {
    input: z.tuple([z.object({ objective: z.string(), completionCriterion: z.string().optional(), replace: z.boolean().optional() })]),
    output: goalSnapshotSchema,
  },
  pauseGoal: { input: z.tuple([]), output: goalSnapshotSchema },
  resumeGoal: { input: z.tuple([]), output: goalSnapshotSchema },
  cancelGoal: { input: z.tuple([]), output: goalSnapshotSchema },
} satisfies ServiceContract;

export const agentPromptContract = {
  submit: {
    input: z.tuple([promptPayloadSchema]),
    output: maybe(promptLaunchResultSchema),
  },
  submitAndWait: {
    input: z.tuple([promptPayloadSchema]),
    output: promptTerminalResultSchema,
  },
  submitSteer: {
    input: z.tuple([steerPayloadSchema]),
    output: maybe(promptLaunchResultSchema),
  },
} satisfies ServiceContract;

export const agentSkillContract = {
  activate: { input: z.tuple([activateSkillPayloadSchema]), output: promptLaunchResultSchema },
  promptWithSkills: {
    input: z.tuple([promptWithSkillsPayloadSchema]),
    output: promptWithSkillsResultSchema,
  },
} satisfies ServiceContract;

export const agentContextInjectorContract = {
  reconcileWhenIdle: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;

export const agentContextRebuildContract = {
  rebuild: { input: z.tuple([]), output: contextRebuildResultSchema },
} satisfies ServiceContract;

export const agentConversationUndoContract = {
  undo: {
    input: z.tuple([z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]),
    output: z.number(),
  },
} satisfies ServiceContract;

export const agentPluginCommandContract = {
  activate: {
    input: z.tuple([z.object({
      pluginId: z.string(),
      commandName: z.string(),
      args: z.string().optional(),
    })]),
    output: noResult,
  },
} satisfies ServiceContract;

export const agentPluginContract = {
  refreshSessionStart: { input: z.tuple([]), output: noResult },
} satisfies ServiceContract;

export const agentSwarmContract = {
  enter: { input: z.tuple([z.enum(['manual', 'task', 'tool'])]), output: noResult },
  exit: { input: z.tuple([]), output: noResult },
  isActive: { input: z.tuple([]), output: z.boolean() },
} satisfies ServiceContract;

export const agentLoopContract = {
  cancelFromUser: { input: z.tuple([z.number().optional()]), output: noResult },
  status: { input: z.tuple([]), output: agentLoopStatusSchema },
} satisfies ServiceContract;

export const agentPermissionModeContract = {
  mode: { input: z.tuple([]), output: permissionModeSchema },
  setMode: { input: z.tuple([permissionModeSchema]), output: noResult },
  setModeAndBroadcast: { input: z.tuple([permissionModeSchema]), output: noResult },
} satisfies ServiceContract;

export const agentCommandContract = {
  list: { input: z.tuple([]), output: z.array(agentCommandInfoSchema) },
  run: { input: z.tuple([z.string(), z.string().optional()]), output: noResult },
} satisfies ServiceContract;

export const agentRuntimeBindingContract = {
  get: { input: z.tuple([]), output: runtimeBindingSchema },
  set: { input: z.tuple([runtimeBindingSchema]), output: runtimeBindingSchema },
  switch: { input: z.tuple([z.string()]), output: runtimeBindingSchema },
} satisfies ServiceContract;

/** `history` items are full `ContextMessage`s, mirrored as `unknown`. */
export const agentContextMemoryContract = {
  get: { input: z.tuple([]), output: z.array(z.unknown()) },
  append: { input: z.tuple([z.unknown()]), output: noResult },
  clear: { input: z.tuple([]), output: noResult },
} satisfies ServiceContract;

export const agentContextMutationContract = {
  appendImported: { input: z.tuple([z.unknown()]), output: noResult },
} satisfies ServiceContract;

export const agentTokenCountingContract = {
  statusSize: { input: z.tuple([]), output: z.number() },
} satisfies ServiceContract;

export const agentShellCommandContract = {
  run: {
    input: z.tuple([runShellCommandPayloadSchema]),
    output: shellCommandResultSchema,
  },
  cancel: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;

export const agentProfileContract = {
  getModel: { input: z.tuple([]), output: z.string() },
  setModel: { input: z.tuple([z.string()]), output: setModelResultSchema },
  setThinking: { input: z.tuple([z.string()]), output: noResult },
  getEffectiveThinkingLevel: { input: z.tuple([]), output: z.string() },
  getModelCapabilities: { input: z.tuple([]), output: modelCapabilitySchema },
  getAgentsMdWarning: { input: z.tuple([]), output: maybe(z.string()) },
} satisfies ServiceContract;

export const agentUsageContract = {
  status: { input: z.tuple([]), output: usageStatusSchema },
} satisfies ServiceContract;

export const agentPlanContract = {
  status: { input: z.tuple([]), output: planDataSchema },
  enter: { input: z.tuple([]), output: noResult },
  clear: { input: z.tuple([]), output: noResult },
  cancel: { input: z.tuple([z.string().optional()]), output: noResult },
} satisfies ServiceContract;

/** `McpServerEntry` from the engine's `mcpCore/connection-manager`. */
export const mcpServerEntrySchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http', 'sse']),
  status: z.enum(['pending', 'connected', 'failed', 'disabled', 'needs-auth', 'removed']),
  toolCount: z.number(),
  error: z.string().optional(),
});

export const agentMcpContract = {
  list: { input: z.tuple([]), output: z.array(mcpServerEntrySchema) },
  waitForInitialLoad: { input: z.tuple([]), output: noResult },
  initialLoadDurationMs: { input: z.tuple([]), output: z.number() },
  reconnect: { input: z.tuple([z.string()]), output: noResult },
  connect: {
    input: z.tuple([z.string(), mcpServerConfigSchema]),
    output: noResult,
  },
} satisfies ServiceContract;

/** `FullCompactionInput` from the engine's `agent/fullCompaction`. */
export const fullCompactionInputSchema = z.object({
  source: z.enum(['manual', 'auto']),
  instruction: z.string().optional(),
});

export const agentFullCompactionContract = {
  begin: { input: z.tuple([fullCompactionInputSchema]), output: z.boolean() },
  cancel: { input: z.tuple([]), output: noResult },
  isCompacting: { input: z.tuple([]), output: z.boolean() },
} satisfies ServiceContract;

export const agentTaskContract = {
  list: {
    input: z.tuple([z.boolean().optional(), z.number().optional()]),
    output: z.array(agentTaskInfoSchema),
  },
  stopByUser: { input: z.tuple([z.string()]), output: maybe(agentTaskInfoSchema) },
  stop: {
    input: z.tuple([z.string(), z.string().optional()]),
    output: maybe(agentTaskInfoSchema),
  },
  detach: { input: z.tuple([z.string()]), output: maybe(agentTaskInfoSchema) },
  readOutput: {
    input: z.tuple([z.string(), z.number().optional()]),
    output: z.string(),
  },
} satisfies ServiceContract;
