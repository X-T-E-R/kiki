import { z } from 'zod';

export const LEGACY_HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionResult',
  'UserPromptSubmit', 'UserPromptQueued', 'TurnStarted', 'Stop', 'StopFailure', 'Interrupt',
  'SessionStart', 'SessionEnd', 'SessionHeartbeat', 'SubagentStart', 'SubagentStop',
  'TaskStarted', 'PreCompact', 'PostCompact', 'Notification',
] as const;

export const DECLARATIVE_HOOK_EVENTS = [
  'prompt.submit', 'step.before', 'step.after', 'turn.after', 'session.start',
  'turn.stopping', 'tool.before', 'tool.after',
] as const;

export const legacyHookConfigSchema = z.object({
  event: z.enum(LEGACY_HOOK_EVENTS),
  matcher: z.string().refine((value) => {
    try { void new RegExp(value); return true; } catch { return false; }
  }, 'matcher must be a valid regular expression').optional(),
  command: z.string().min(1),
  timeout: z.number().int().min(1).max(600).optional(),
}).strict();
export type LegacyHookConfig = z.infer<typeof legacyHookConfigSchema>;

const selectors = z.array(z.string().min(1)).min(1);
const regexSchema = z.string().min(1).refine((value) => {
  try { void new RegExp(value); return true; } catch { return false; }
}, 'must be a valid regular expression');
const regexSelectors = z.array(regexSchema).min(1);
const toolArgMatchesSchema = z.record(
  z.string().min(1),
  z.union([regexSchema, regexSelectors]),
).refine((record) => Object.keys(record).length > 0, 'tool_arg_matches must not be empty');

export const hookMatchConfigSchema = z.object({
  models: selectors.optional(),
  profiles: selectors.optional(),
  routes: selectors.optional(),
  executors: selectors.optional(),
  agentRoles: z.array(z.enum(['root', 'subagent'])).min(1).optional(),
  tools: selectors.optional(),
  statuses: z.array(z.enum(['success', 'error', 'cancelled', 'denied'])).min(1).optional(),
  sources: z.array(z.enum(['user', 'task', 'mailbox', 'steering'])).min(1).optional(),
  outcomes: z.array(z.enum(['completed', 'cancelled', 'failed', 'blocked'])).min(1).optional(),
  channels: selectors.optional(),
  originKinds: selectors.optional(),
  promptRegex: regexSchema.optional(),
  promptMatches: regexSelectors.optional(),
  promptNotMatches: regexSelectors.optional(),
  toolInputRegex: regexSchema.optional(),
  toolInputMatches: regexSelectors.optional(),
  toolInputNotMatches: regexSelectors.optional(),
  toolArgMatches: toolArgMatchesSchema.optional(),
}).strict();

const injection = z.object({
  type: z.literal('inject'),
  text: z.string().refine((text) => text.trim().length > 0, 'hook text must not be empty').optional(),
  textFile: z.string().min(1).optional(),
}).strict().refine((action) => (action.text === undefined) !== (action.textFile === undefined), 'inject requires exactly one of text or text_file');

const compact = z.object({
  type: z.literal('compact'),
  strategy: z.enum(['summarize']).default('summarize'),
  counterScope: z.enum(['agent', 'turn']).default('turn'),
  minCompletedSteps: z.number().int().positive().optional(),
  minReadCalls: z.number().int().positive().optional(),
  minReadChars: z.number().int().positive().optional(),
  maxWriteCalls: z.number().int().nonnegative().default(0),
}).strict().refine(
  (action) => action.minCompletedSteps !== undefined || action.minReadCalls !== undefined || action.minReadChars !== undefined,
  'compact requires at least one threshold (min_completed_steps, min_read_calls, or min_read_chars)',
);

export const hookRuleConfigSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  event: z.enum(DECLARATIVE_HOOK_EVENTS),
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
  match: hookMatchConfigSchema.default({}),
  cadence: z.object({
    everyCompletedSteps: z.number().int().positive(),
    counterScope: z.enum(['agent', 'turn']).default('agent'),
    partitionBy: z.literal('model').default('model'),
  }).strict().optional(),
  action: z.union([injection, z.object({ type: z.literal('observe') }).strict(), compact], {
    error: 'hooks slice A supports only inject, observe and compact; command, gate, block and continue are not supported',
  }),
}).strict().superRefine((rule, ctx) => {
  if (rule.cadence !== undefined && rule.event !== 'step.before' && rule.event !== 'step.after') {
    ctx.addIssue({ code: 'custom', message: 'cadence is supported only on step events', path: ['cadence'] });
  }
  if (rule.action.type === 'inject' && rule.event !== 'step.before' && rule.event !== 'prompt.submit') {
    ctx.addIssue({ code: 'custom', message: `inject is not supported on ${rule.event}; use step.before or prompt.submit`, path: ['action'] });
  }
  if (rule.action.type === 'compact' && rule.event !== 'step.before' && rule.event !== 'step.after') {
    ctx.addIssue({ code: 'custom', message: `compact is not supported on ${rule.event}; use step.before or step.after`, path: ['action'] });
  }
  for (const field of ['promptRegex', 'promptMatches', 'promptNotMatches'] as const) {
    if (rule.match[field] !== undefined && rule.event !== 'prompt.submit') {
      ctx.addIssue({ code: 'custom', message: `${field} is supported only on prompt.submit`, path: ['match', field] });
    }
  }
  for (const field of ['toolInputRegex', 'toolInputMatches', 'toolInputNotMatches', 'toolArgMatches'] as const) {
    if (rule.match[field] !== undefined && rule.event !== 'tool.before' && rule.event !== 'tool.after') {
      ctx.addIssue({ code: 'custom', message: `${field} is supported only on tool.before and tool.after`, path: ['match', field] });
    }
  }
});
export type HookRuleConfig = z.infer<typeof hookRuleConfigSchema>;

/** Mirrors the engine's externalHooks section; nested keys stay camelCase on the config wire. */
export const hooksV2ConfigSchema = z.object({
  schemaVersion: z.literal(2),
  enabled: z.boolean().default(true),
  disabled: z.array(z.string()).default([]),
  files: z.array(z.string().min(1)).default([]),
  rules: z.array(hookRuleConfigSchema).default([]),
  legacy: z.array(legacyHookConfigSchema).default([]),
}).strict();
export type HooksV2Config = z.infer<typeof hooksV2ConfigSchema>;

export const hooksConfigSchema = z.union([z.array(legacyHookConfigSchema), hooksV2ConfigSchema]);
export type HooksConfig = z.infer<typeof hooksConfigSchema>;
