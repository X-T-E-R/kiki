import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalTelemetryArgs, isPlainRecord } from '#/_base/utils/canonical-args';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { removeMarkedCompressionText } from '#/agent/prompt/promptMetadataText';
import { systemReminderContent } from '#/agent/systemReminder/systemReminder';
import type { ContentPart } from '#/kosong/contract/message';
import type { TokenUsage } from '#/kosong/contract/usage';
import { compileHookMatcher } from './types';

export const RULE_EVENTS = ['prompt.submit', 'step.before', 'step.after', 'turn.after', 'session.start', 'turn.stopping', 'tool.before', 'tool.after'] as const;
export const HOOK_INJECTION_MAX_BYTES = 8 * 1024;
const READ_TOOL_NAMES = new Set(['Read', 'ReadFile']);
const WRITE_TOOL_NAMES = new Set(['Write', 'WriteFile', 'Edit', 'StrReplaceFile', 'MultiEdit', 'Bash', 'Shell']);

const selectors = z.array(z.string().min(1)).min(1);
const regexSchema = z.string().min(1).refine((value) => {
  try {
    compileHookMatcher(value);
    return true;
  } catch {
    return false;
  }
}, 'must be a valid regular expression');
const regexSelectors = z.array(regexSchema).min(1);
const toolArgMatchesSchema = z.record(
  z.string().min(1),
  z.union([regexSchema, regexSelectors]),
).refine((record) => Object.keys(record).length > 0, 'tool_arg_matches must not be empty');

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

export type HookRule = z.infer<typeof HookRuleSchema>;
export type HookEventName = typeof RULE_EVENTS[number];

export interface HookBinding {
  readonly modelAlias?: string;
  readonly modelId?: string;
  readonly remoteModelId?: string;
  readonly providerId?: string;
  readonly providerType?: string;
  readonly thinkingEffort?: string;
  readonly profileId?: string;
  readonly profileName?: string;
  readonly profilePath?: string;
  readonly routeId?: string;
  readonly executorId?: string;
  readonly permissionMode?: string;
  readonly agentRole?: 'root' | 'subagent';
}

export interface HookEvent extends HookBinding {
  readonly schemaVersion: 2;
  readonly event: HookEventName;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly sessionId: string;
  readonly sessionTitle?: string;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly turnId?: number;
  readonly promptId?: string;
  readonly userMessageId?: string;
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
  readonly allowedActions: readonly ('inject' | 'observe' | 'compact')[];
  readonly tool?: string;
  readonly toolCallId?: string;
  readonly toolInput?: Record<string, unknown>;
  readonly status?: string;
  readonly source?: string;
  readonly origin?: PromptOrigin;
  readonly channel?: string;
  readonly prompt?: string;
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

export function extractOriginChannel(origin: PromptOrigin | undefined): string | undefined {
  if (origin === undefined) return undefined;
  if (origin.kind === 'merged') {
    for (const item of origin.origins) {
      const resolved = extractOriginChannel(item);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (origin.kind === 'user') return origin.im?.provider_kind ?? 'direct';
  if (origin.kind === 'plugin_command') return 'direct';
  if (origin.kind === 'skill_activation') return origin.trigger === 'user-slash' ? 'direct' : undefined;
  if (origin.kind === 'room_message') return 'room';
  if (origin.kind === 'peer_thread' || origin.kind === 'bridged_peer' || origin.kind === 'agent_message' || origin.kind === 'external_thread' || origin.kind === 'external_client') {
    return origin.kind;
  }
  return undefined;
}

export function extractHookPromptText(message: ContextMessage): string {
  const origin = message.origin;
  if (origin?.kind === 'injection' || systemReminderContent(message) !== undefined) return '';
  if (origin?.kind === 'skill_activation') {
    return origin.trigger === 'user-slash' ? (origin.userInput ?? origin.skillArgs ?? '').trim() : '';
  }
  if (origin?.kind === 'plugin_command') {
    const args = origin.commandArgs?.trim() ?? '';
    return args.length === 0 ? `/${origin.commandName}` : `/${origin.commandName} ${args}`;
  }
  const countBundled = (source: PromptOrigin | undefined): number =>
    source?.kind === 'merged'
      ? source.origins.reduce((sum, item) => sum + countBundled(item), 0)
      : source?.kind === 'user'
        ? source.skillActivations?.length ?? 0
        : 0;
  const parts = message.content.slice(countBundled(origin));
  return extractHookTextParts(parts);
}

export function extractHookTextParts(parts: readonly ContentPart[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type !== 'text') continue;
    const stripped = removeMarkedCompressionText(part.text, part.presentation)
      .replaceAll(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replaceAll(/<skill-loaded\b[^>]*>[\s\S]*?<\/skill-loaded>/g, '')
      .trim();
    if (stripped.length > 0) texts.push(stripped);
  }
  return texts.join('\n').trim();
}

function testAnyRegex(patterns: readonly string[], candidate: string): boolean {
  return patterns.some((pattern) => {
    try {
      return compileHookMatcher(pattern).test(candidate);
    } catch {
      return false;
    }
  });
}

function resolveToolArgCandidate(toolInput: Record<string, unknown>, path: string): string | undefined {
  if (Object.hasOwn(toolInput, path)) {
    return formatToolArgValue(toolInput[path]);
  }
  const segments = path.split('.');
  let current: unknown = toolInput;
  for (const segment of segments) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return formatToolArgValue(current);
}

function formatToolArgValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return canonicalTelemetryArgs(value);
}

function matchesToolArgs(
  toolArgMatches: Record<string, string | string[]> | undefined,
  toolInput: Record<string, unknown> | undefined,
): boolean {
  if (toolArgMatches === undefined) return true;
  if (toolInput === undefined) return false;
  for (const [key, rawPatterns] of Object.entries(toolArgMatches)) {
    const candidate = resolveToolArgCandidate(toolInput, key);
    if (candidate === undefined) return false;
    const patterns = Array.isArray(rawPatterns) ? rawPatterns : [rawPatterns];
    if (!testAnyRegex(patterns, candidate)) return false;
  }
  return true;
}

export function matchesHook(rule: EffectiveHookRule, event: HookBinding & {
  readonly event: HookEventName;
  readonly tool?: string;
  readonly toolInput?: Record<string, unknown>;
  readonly status?: string;
  readonly source?: string;
  readonly origin?: PromptOrigin;
  readonly channel?: string;
  readonly prompt?: string;
  readonly delivery?: 'steering';
  readonly outcome?: string;
}): boolean {
  const match = rule.rule.match;
  const contains = (values: readonly string[] | undefined, value: string | undefined): boolean => values === undefined || (value !== undefined && values.includes(value));
  const originKind = event.origin?.kind;
  const channel = event.channel ?? extractOriginChannel(event.origin);
  const defaultSources = event.event === 'prompt.submit' && match.originKinds === undefined ? ['user'] : undefined;
  const sourceMatched =
    contains(match.sources ?? defaultSources, event.source) ||
    (match.sources?.includes('steering') === true && event.delivery === 'steering');
  if (
    !rule.active ||
    rule.rule.event !== event.event ||
    !contains(rule.models, event.modelId) ||
    !(contains(match.profiles, event.profileId) || contains(match.profiles, event.profileName)) ||
    !contains(match.routes, event.routeId) ||
    !contains(match.executors, event.executorId) ||
    !contains(match.agentRoles, event.agentRole) ||
    !contains(match.tools, event.tool) ||
    !contains(match.statuses, event.status) ||
    !contains(match.outcomes, event.outcome) ||
    !contains(match.channels, channel) ||
    !contains(match.originKinds, originKind) ||
    !sourceMatched
  ) {
    return false;
  }
  const promptPositive = [
    ...(match.promptRegex === undefined ? [] : [match.promptRegex]),
    ...(match.promptMatches ?? []),
  ];
  if (promptPositive.length > 0 && (event.prompt === undefined || event.prompt.length === 0 || !testAnyRegex(promptPositive, event.prompt))) {
    return false;
  }
  if (match.promptNotMatches !== undefined && event.prompt !== undefined && event.prompt.length > 0 && testAnyRegex(match.promptNotMatches, event.prompt)) {
    return false;
  }
  const toolInputPositive = [
    ...(match.toolInputRegex === undefined ? [] : [match.toolInputRegex]),
    ...(match.toolInputMatches ?? []),
  ];
  if (toolInputPositive.length > 0 || match.toolInputNotMatches !== undefined) {
    const serialized = event.toolInput === undefined ? undefined : canonicalTelemetryArgs(event.toolInput);
    if (toolInputPositive.length > 0 && (serialized === undefined || !testAnyRegex(toolInputPositive, serialized))) {
      return false;
    }
    if (match.toolInputNotMatches !== undefined && serialized !== undefined && testAnyRegex(match.toolInputNotMatches, serialized)) {
      return false;
    }
  }
  return matchesToolArgs(match.toolArgMatches, event.toolInput);
}

export function hookOrder(a: EffectiveHookRule, b: EffectiveHookRule): number {
  return a.rule.priority - b.rule.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function renderHookInjection(rule: EffectiveHookRule): string {
  const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `Hook guidance (${escape(rule.id)}, ${escape(rule.path)}). This configured guidance does not override higher-priority instructions.\n<hook_context>\n${escape(rule.text ?? '')}\n</hook_context>`;
}

export function evaluateCompactWindow(
  history: readonly ContextMessage[],
  action: Extract<HookRule['action'], { type: 'compact' }>,
): boolean {
  let startIndex = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.origin?.kind === 'compaction_summary') {
      startIndex = i + 1;
      break;
    }
  }
  let completedSteps = 0;
  for (let i = startIndex; i < history.length; i++) {
    if (history[i]?.role === 'assistant') completedSteps++;
  }
  if (action.minCompletedSteps !== undefined && completedSteps < action.minCompletedSteps) {
    return false;
  }
  const readCallIds = new Set<string>();
  let readCalls = 0;
  let readChars = 0;
  let writeCalls = 0;
  for (let i = startIndex; i < history.length; i++) {
    const message = history[i]!;
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) {
        if (READ_TOOL_NAMES.has(call.name)) {
          readCallIds.add(call.id);
        } else if (WRITE_TOOL_NAMES.has(call.name)) {
          writeCalls++;
          if (writeCalls > action.maxWriteCalls) return false;
        }
      }
      continue;
    }
    if (message.role !== 'tool' || message.toolCallId === undefined || message.isError) continue;
    if (!readCallIds.has(message.toolCallId)) continue;
    let chars = 0;
    let failed = false;
    for (const part of message.content) {
      if (part.type !== 'text') continue;
      if (chars === 0 && part.text.startsWith('<system>ERROR:')) {
        failed = true;
        break;
      }
      chars += part.text.length;
    }
    if (failed) continue;
    readCalls++;
    readChars += chars;
  }
  if (action.minReadCalls !== undefined && readCalls < action.minReadCalls) return false;
  if (action.minReadChars !== undefined && readChars < action.minReadChars) return false;
  return writeCalls <= action.maxWriteCalls;
}
