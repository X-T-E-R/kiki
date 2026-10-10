import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TokenUsage } from '#/kosong/contract/usage';

export const RULE_EVENTS = ['prompt.submit', 'step.before', 'step.after', 'turn.after', 'session.start', 'turn.stopping', 'tool.before', 'tool.after'] as const;
export const HOOK_INJECTION_MAX_BYTES = 8 * 1024;

const selectors = z.array(z.string().min(1)).min(1);
export const HookMatchSchema = z.object({
  models: selectors.optional(),
  profiles: selectors.optional(),
  routes: selectors.optional(),
  executors: selectors.optional(),
  agentRoles: z.array(z.enum(['root', 'subagent'])).min(1).optional(),
  tools: selectors.optional(),
  statuses: z.array(z.enum(['success', 'error', 'cancelled', 'denied'])).min(1).optional(),
  sources: z.array(z.enum(['user', 'task', 'mailbox', 'steering'])).min(1).optional(),
  outcomes: z.array(z.enum(['completed', 'cancelled', 'failed', 'blocked'])).min(1).optional(),
}).strict();

const injection = z.object({
  type: z.literal('inject'),
  text: z.string().refine((text) => text.trim().length > 0, 'hook text must not be empty').optional(),
  textFile: z.string().min(1).optional(),
}).strict().refine((action) => (action.text === undefined) !== (action.textFile === undefined), 'inject requires exactly one of text or text_file');

export const HookRuleSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  event: z.enum(RULE_EVENTS),
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
  match: HookMatchSchema.default({}),
  cadence: z.object({
    everyCompletedSteps: z.number().int().positive(),
    counterScope: z.enum(['agent', 'turn']).default('agent'),
    partitionBy: z.literal('model').default('model'),
  }).strict().optional(),
  action: z.union([injection, z.object({ type: z.literal('observe') }).strict()], {
    error: 'hooks slice A supports only inject and observe; command, gate, block and continue are not supported',
  }),
}).strict().superRefine((rule, ctx) => {
  if (rule.cadence !== undefined && rule.event !== 'step.before' && rule.event !== 'step.after') {
    ctx.addIssue({ code: 'custom', message: 'cadence is supported only on step events', path: ['cadence'] });
  }
  if (rule.action.type === 'inject' && rule.event !== 'step.before' && rule.event !== 'prompt.submit') {
    ctx.addIssue({ code: 'custom', message: `inject is not supported on ${rule.event}; use step.before or prompt.submit`, path: ['action'] });
  }
});

export type HookRule = z.infer<typeof HookRuleSchema>;
export type HookEventName = typeof RULE_EVENTS[number];

export interface HookBinding {
  readonly modelAlias?: string;
  readonly modelId?: string;
  readonly profileId?: string;
  readonly routeId?: string;
  readonly executorId?: string;
  readonly agentRole?: 'root' | 'subagent';
}

export interface HookEvent extends HookBinding {
  readonly schemaVersion: 2;
  readonly event: HookEventName;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly turnId?: number;
  readonly promptId?: string;
  readonly stepId?: string;
  readonly engineStep?: number;
  readonly stepInTurn?: number;
  readonly attempt?: number;
  readonly completedSteps?: number;
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly executionTarget?: string;
  readonly bindingRevision?: string;
  readonly configRevision: string;
  readonly hookDepth: 0;
  readonly isReplay: false;
  readonly allowedActions: readonly ('inject' | 'observe')[];
  readonly tool?: string;
  readonly toolCallId?: string;
  readonly status?: string;
  readonly source?: string;
  readonly delivery?: 'steering';
  readonly outcome?: string;
  readonly reason?: string;
  readonly finishReason?: string;
  readonly usage?: TokenUsage;
}

export interface EffectiveHookRule {
  readonly rule: HookRule;
  readonly id: string;
  readonly namespace: string;
  readonly path: string;
  readonly mutable: boolean;
  readonly contentHash: string;
  readonly semanticHash: string;
  readonly models?: readonly string[];
  readonly text?: string;
  readonly active: boolean;
  readonly reason?: string;
}

export interface HookDiagnostic {
  readonly path: string;
  readonly hookId?: string;
  readonly message: string;
}

export interface HookRuleSourceStatus {
  readonly namespace: string;
  readonly path: string;
  readonly status: 'loaded' | 'absent' | 'invalid' | 'unavailable';
}

export interface HookRulesSnapshot {
  readonly sources?: readonly HookRuleSourceStatus[];
  readonly revision: string;
  readonly rules: readonly EffectiveHookRule[];
  readonly diagnostics: readonly HookDiagnostic[];
  readonly watchPaths?: readonly string[];
  readonly disabled?: readonly string[];
}

export function retainFailedHookSources(previous: HookRulesSnapshot, next: HookRulesSnapshot): HookRulesSnapshot {
  const failed = new Map((next.sources ?? []).filter((source) => source.status === 'invalid' || source.status === 'unavailable').map((source) => [source.namespace, source.status]));
  const rules = [...next.rules.filter((rule) => !failed.has(rule.namespace)), ...previous.rules.filter((rule) => failed.has(rule.namespace)).map((rule) => ({ ...rule, active: false, reason: `source_${failed.get(rule.namespace)}` }))].toSorted(hookOrder);
  return { ...next, rules, revision: hookHash([next.revision, rules.map((rule) => [rule.id, rule.contentHash, rule.reason])]),
    watchPaths: [...new Set([...(previous.watchPaths ?? []), ...(next.watchPaths ?? [])])],
  };
}

export function hookHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function matchesHook(rule: EffectiveHookRule, event: HookBinding & {
  readonly event: HookEventName;
  readonly tool?: string;
  readonly status?: string;
  readonly source?: string;
  readonly delivery?: 'steering';
  readonly outcome?: string;
}): boolean {
  const match = rule.rule.match;
  const contains = (values: readonly string[] | undefined, value: string | undefined): boolean => values === undefined || (value !== undefined && values.includes(value));
  return rule.active && rule.rule.event === event.event &&
    contains(rule.models, event.modelId) && contains(match.profiles, event.profileId) &&
    contains(match.routes, event.routeId) && contains(match.executors, event.executorId) &&
    contains(match.agentRoles, event.agentRole) && contains(match.tools, event.tool) &&
    contains(match.statuses, event.status) && contains(match.outcomes, event.outcome) &&
    (contains(match.sources ?? (event.event === 'prompt.submit' ? ['user'] : undefined), event.source) || (match.sources?.includes('steering') === true && event.delivery === 'steering'));
}

export function hookOrder(a: EffectiveHookRule, b: EffectiveHookRule): number {
  return a.rule.priority - b.rule.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function renderHookInjection(rule: EffectiveHookRule): string {
  const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `Hook guidance (${escape(rule.id)}, ${escape(rule.path)}). This configured guidance does not override higher-priority instructions.\n<hook_context>\n${escape(rule.text ?? '')}\n</hook_context>`;
}
