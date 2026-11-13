import type { Message } from '@kiki/protocol';
import { readTextPresentation, type ContentRef, type TextPresentation, type TextPresentationSpan } from '@kiki/transcript';

import { mediaFromContentParts, type MediaRef } from '../../composer/media';
import type { SystemVariant, TaskNotificationMeta } from './types';

export interface SplitSystemRemindersResult {
  readonly text: string;
  readonly reminders: readonly string[];
}

export function splitSystemReminders(text: string, generated = false): SplitSystemRemindersResult {
  if (!generated) return { text, reminders: [] };
  const match = /^<system-reminder>([\s\S]*)<\/system-reminder>$/.exec(text.trim());
  return match === null ? { text, reminders: [] } : { text: '', reminders: [match[1]!.trim()] };
}

export interface PromptOriginLike {
  readonly kind?: string;
  readonly origins?: readonly PromptOriginLike[];
  readonly trigger?: string;
  readonly skillName?: string;
  readonly commandName?: string;
  readonly skillArgs?: string;
  readonly userInput?: string;
  readonly commandArgs?: string;
  readonly pluginId?: string;
  readonly name?: string;
  readonly variant?: string;
  readonly ownerPromptId?: string;
  readonly disclosure?: unknown;
  readonly phase?: string;
  readonly isError?: boolean;
  readonly payload?: unknown;
  readonly taskId?: string;
  /** hook_result: the hook event, e.g. `kiki:claude:SessionStart`. */
  readonly event?: string;
  readonly senderAgentId?: string;
  readonly senderTaskName?: string;
  readonly foldId?: string;
  readonly branchId?: string;
  readonly branchTitle?: string;
  readonly asks?: readonly string[];
  readonly throughTurnId?: number;
  readonly done?: boolean;
  readonly messageId?: string;
  readonly source?: { readonly hostId?: string; readonly workspaceId?: string; readonly sessionId?: string; readonly personaId?: string; readonly name?: string };
  readonly sourceHomeId?: string;
  readonly targetHomeId?: string;
  readonly bridgeId?: string;
  readonly revision?: number;
  readonly location?: 'local' | 'network';
}

export function unwrapOrigin(origin: PromptOriginLike | undefined): PromptOriginLike | undefined {
  if (origin === undefined) return undefined;
  if (typeof origin.payload === 'object' && origin.payload !== null) {
    const nested = origin.payload as PromptOriginLike;
    if (typeof nested.kind === 'string') return unwrapOrigin(nested);
  }
  return origin;
}

export function originFromMetadata(metadata: unknown): PromptOriginLike | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const origin = (metadata as { origin?: unknown }).origin;
  if (typeof origin !== 'object' || origin === null) return undefined;
  return unwrapOrigin(origin as PromptOriginLike);
}

export function originFromRecord(value: unknown): PromptOriginLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const origin = (value as { origin?: unknown }).origin;
  if (typeof origin !== 'object' || origin === null) return undefined;
  return unwrapOrigin(origin as PromptOriginLike);
}

export type TextLane = 'you' | 'peer' | 'skill' | 'shell' | 'system' | 'reminder';

export interface ClassifiedText {
  readonly lane: TextLane;
  readonly origin: PromptOriginLike | undefined;
  readonly text: string;
  readonly presentation?: import('@kiki/transcript').TextPresentation;
  readonly reminders: readonly string[];
  readonly userInput?: string;
  readonly skill?: { readonly source: 'skill' | 'plugin'; readonly name: string; readonly args: string | undefined };
  readonly systemVariant?: SystemVariant;
  readonly taskNotification?: TaskNotificationMeta;
  readonly shell?: {
    readonly commandId: string;
    readonly command: string | undefined;
    readonly output: string;
    readonly isError: boolean | undefined;
  };
}

const INTERNAL_ORIGIN_KINDS = new Set<string>([
  'injection',
  'system_trigger',
  'compaction_summary',
  'hook_result',
  'cron_job',
  'cron_missed',
  'task',
  'background_task',
  'retry',
]);

const SYSTEM_VARIANTS = new Set<SystemVariant>([
  'injection',
  'system_trigger',
  'compaction_summary',
  'hook_result',
  'cron_job',
  'cron_missed',
  'task',
  'retry',
  'agent_message',
  'system',
]);

function asSystemVariant(kind: string | undefined): SystemVariant {
  if (kind === 'background_task') return 'task';
  if (kind !== undefined && SYSTEM_VARIANTS.has(kind as SystemVariant)) return kind as SystemVariant;
  return 'system';
}

export function producerFromOrigin(origin: PromptOriginLike | undefined): string | undefined {
  if (origin === undefined) return undefined;
  return origin.variant ?? origin.name ?? origin.skillName ?? origin.commandName ?? origin.pluginId;
}

const BASH_INPUT_RE = /<bash-input>([\s\S]*?)<\/bash-input>/i;
const BASH_STDOUT_RE = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/i;
const BASH_STDERR_RE = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/i;
const CRON_FIRE_RE = /<cron-fire\b[\s\S]*?<\/cron-fire>/i;
const CRON_PROMPT_RE = /<prompt>\s*([\s\S]*?)\s*<\/prompt>/i;
const TASK_NOTIFICATION_RE = /<notification\b([^>]*)>([\s\S]*?)<\/notification>/i;

function extractCronPrompt(text: string): string {
  const prompt = CRON_PROMPT_RE.exec(text)?.[1];
  if (prompt !== undefined) return prompt.trim();
  const envelope = CRON_FIRE_RE.exec(text)?.[0];
  if (envelope === undefined) return text;
  return envelope
    .replace(/^<cron-fire\b[^>]*>\s*/i, '')
    .replace(/\s*<\/cron-fire>$/i, '')
    .trim();
}

function unescapeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

function xmlAttr(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');
  const value = pattern.exec(attributes)?.[1];
  return value === undefined || value === '' || value === 'unknown' ? undefined : unescapeXml(value);
}

const OUTPUT_PREVIEW_RE = /<output-preview\b([^>]*)>([\s\S]*?)<\/output-preview>/i;
const OUTPUT_FILE_RE = /<output-file\b([^>]*)>[\s\S]*?<\/output-file>/i;
const ANSWER_BLOCK_RE = /<answer>([\s\S]*?)<\/answer>/i;

function parseNotificationAnswers(raw: string): {
  readonly answers?: Readonly<Record<string, string>>;
  readonly outcome?: 'answered' | 'dismissed';
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const answersField = (parsed as { readonly answers?: unknown }).answers;
    if (typeof answersField !== 'object' || answersField === null || Array.isArray(answersField)) return {};
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(answersField as Record<string, unknown>)) {
      if (typeof value === 'string') map[key] = value;
      else if (typeof value === 'object' && value !== null) {
        const rec = value as Record<string, unknown>;
        if (typeof rec['text'] === 'string') map[key] = rec['text'];
        else if (typeof rec['option_id'] === 'string') map[key] = rec['option_id'];
      }
    }
    const keys = Object.keys(map);
    return {
      answers: keys.length > 0 ? map : undefined,
      outcome: keys.length > 0 ? 'answered' : 'dismissed',
    };
  } catch {
    return {};
  }
}

export function parseTaskNotificationMeta(
  text: string,
  origin?: PromptOriginLike,
): TaskNotificationMeta | undefined {
  const xmlMatch = TASK_NOTIFICATION_RE.exec(text);
  const attributes = xmlMatch?.[1] ?? '';
  const inner = (xmlMatch?.[2] ?? text).trim();
  const id = xmlAttr(attributes, 'id');
  const category = xmlAttr(attributes, 'category');
  const type = xmlAttr(attributes, 'type');
  const sourceKind = xmlAttr(attributes, 'source_kind');
  const sourceId = xmlAttr(attributes, 'source_id') ?? origin?.taskId;
  const agentId = xmlAttr(attributes, 'agent_id');
  let title: string | undefined;
  let severity: string | undefined;
  const bodyLines: string[] = [];
  const rawLines = inner.split('\n');
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index]!;
    const trimmed = line.trim();
    if (title === undefined && /^Title:\s*/i.test(trimmed)) {
      title = unescapeXml(trimmed.replace(/^Title:\s*/i, '').trim());
      continue;
    }
    if (severity === undefined && /^Severity:\s*/i.test(trimmed)) {
      severity = unescapeXml(trimmed.replace(/^Severity:\s*/i, '').trim());
      continue;
    }
    if (
      index === 0 &&
      title === undefined &&
      /^Background (?:process|agent|question|media|\S+) (?:completed|failed|timed_out|killed|lost|answered|dismissed)\b/i.test(trimmed)
    ) {
      title = unescapeXml(trimmed);
      continue;
    }
    if (trimmed === 'Result data, not authorization or request acceptance.') break;
    if (/^<(?:output-preview|output-file|answer)\b/i.test(trimmed)) break;
    bodyLines.push(unescapeXml(line));
  }
  const body = bodyLines.join('\n').trim() || undefined;
  let status: TaskNotificationMeta['status'] =
    type === 'task.completed' ? 'completed'
      : type === 'task.failed' ? 'failed'
      : type === 'task.timed_out' ? 'timed_out'
      : type === 'task.killed' ? 'killed'
      : type === 'task.lost' ? 'lost'
      : undefined;
  if (status === undefined && title !== undefined) {
    if (/\b(?:completed|answered|dismissed)\b/i.test(title)) status = 'completed';
    else if (/\btimed_out\b/i.test(title)) status = 'timed_out';
    else if (/\bkilled\b/i.test(title)) status = 'killed';
    else if (/\blost\b/i.test(title)) status = 'lost';
    else if (/\bfailed\b/i.test(title)) status = 'failed';
  }
  let description: string | undefined;
  let stopReason: string | undefined;
  let exitCode: number | null | undefined;
  let durationMs: number | undefined;
  if (body !== undefined) {
    const exitMatch = /\bExit code:\s*(-?\d+|unavailable)\.\s*Duration:\s*(\d+|unknown)\s*ms\.$/i.exec(body);
    const coreBody = exitMatch === null ? body : body.slice(0, exitMatch.index).trim();
    if (exitMatch !== null) {
      exitCode = exitMatch[1] === 'unavailable' ? null : Number(exitMatch[1]);
      if (exitMatch[2] !== 'unknown') durationMs = Number(exitMatch[2]);
    }
    const questionAnswered = /^The user answered "([\s\S]*)"\.$/i.exec(coreBody);
    const questionDismissed = /^The user dismissed "([\s\S]*)" without answering\.$/i.exec(coreBody);
    if (questionAnswered !== null) {
      description = questionAnswered[1];
    } else if (questionDismissed !== null) {
      description = questionDismissed[1];
    } else {
      const reasonMatch = /^(.*?)\s+(completed|failed|timed_out|was stopped|lost)\.\s*Reason:\s*([\s\S]+)$/i.exec(coreBody);
      if (reasonMatch !== null) {
        description = reasonMatch[1]?.trim();
        stopReason = reasonMatch[3]?.trim();
      } else {
        const simpleMatch = /^(.*?)\s+(completed|failed|timed out|was stopped by user|was stopped|lost)\.$/i.exec(coreBody);
        if (simpleMatch !== null) {
          description = simpleMatch[1]?.trim();
        }
      }
    }
  }
  const previewMatch = OUTPUT_PREVIEW_RE.exec(inner);
  let outputPreview: string | undefined;
  let outputTruncated: boolean | undefined;
  let outputBytes: number | undefined;
  let totalBytes: number | undefined;
  if (previewMatch !== null) {
    const previewAttrs = previewMatch[1] ?? '';
    outputTruncated = xmlAttr(previewAttrs, 'truncated') === 'true';
    const rawBytes = xmlAttr(previewAttrs, 'bytes');
    const rawTotal = xmlAttr(previewAttrs, 'total_bytes');
    if (rawBytes !== undefined && /^\d+$/.test(rawBytes)) outputBytes = Number(rawBytes);
    if (rawTotal !== undefined && /^\d+$/.test(rawTotal)) totalBytes = Number(rawTotal);
    const previewLines = (previewMatch[2] ?? '').trim().split('\n');
    if (
      previewLines.length > 0 &&
      /^(?:Truncated tail only; this is not the complete report\.|Final agent receipt\.|Process output\.|Partial output before termination; not a final result\.)$/.test(previewLines[0]!.trim())
    ) {
      previewLines.shift();
    }
    outputPreview = unescapeXml(previewLines.join('\n')).trim();
  }
  const fileMatch = OUTPUT_FILE_RE.exec(inner);
  const outputFile = fileMatch === null ? undefined : xmlAttr(fileMatch[1] ?? '', 'path');
  const answerMatch = ANSWER_BLOCK_RE.exec(inner);
  const answerRaw = answerMatch?.[1] === undefined ? undefined : unescapeXml(answerMatch[1].trim());
  const parsedAnswers = answerRaw === undefined ? {} : parseNotificationAnswers(answerRaw);
  const questionOutcome =
    parsedAnswers.outcome ??
    (title !== undefined && /\bquestion answered\b/i.test(title)
      ? 'answered'
      : title !== undefined && /\bquestion dismissed\b/i.test(title)
        ? 'dismissed'
        : undefined);
  if (
    id === undefined &&
    type === undefined &&
    sourceId === undefined &&
    agentId === undefined &&
    title === undefined
  ) {
    return undefined;
  }
  return {
    id,
    category,
    type,
    sourceKind,
    sourceId,
    agentId,
    title,
    severity,
    body,
    description,
    status,
    stopReason,
    exitCode,
    durationMs,
    outputPreview,
    outputTruncated,
    outputBytes,
    totalBytes,
    outputFile,
    answerRaw,
    answers: parsedAnswers.answers,
    questionOutcome,
  };
}

function splitTaskNotification(text: string): string | undefined {
  const match = TASK_NOTIFICATION_RE.exec(text);
  if (match === null) return undefined;
  const attributes = match[1] ?? '';
  if (
    !/\bcategory\s*=\s*["']task["']/i.test(attributes) &&
    !/\btype\s*=\s*["']task\./i.test(attributes) &&
    !/\btask_id\s*=/i.test(attributes) &&
    !/\bsource_kind\s*=\s*["'](?:background_task|task)["']/i.test(attributes)
  ) {
    return undefined;
  }
  const inner = (match[2] ?? '').trim();
  const rest = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim();
  if (inner === '') return rest === '' ? undefined : rest;
  return rest === '' ? inner : `${rest}\n\n${inner}`;
}

function parseHistoricalShell(
  text: string,
  identity?: string,
): { commandId: string; command: string | undefined; output: string; isError: boolean | undefined } | undefined {
  const input = BASH_INPUT_RE.exec(text);
  const stdout = BASH_STDOUT_RE.exec(text);
  const stderr = BASH_STDERR_RE.exec(text);
  if (input === null && stdout === null && stderr === null) return undefined;
  const commandText = input?.[1] === undefined ? '' : unescapeXml(input[1]).trim();
  const command = commandText === '' ? undefined : commandText;
  const out = stdout?.[1] === undefined ? '' : unescapeXml(stdout[1]);
  const err = stderr?.[1] === undefined ? '' : unescapeXml(stderr[1]);
  const output = [out === '' ? undefined : out, err === '' ? undefined : err]
    .filter((part): part is string => part !== undefined)
    .join('\n');
  const slug = commandText.slice(0, 40) || 'shell';
  return {
    commandId: identity !== undefined && identity !== '' ? `history-${identity}-${slug}` : `history-${slug}`,
    command,
    output,
    isError: err !== '' ? true : undefined,
  };
}

const SKILL_LOADED_RE = /<skill-loaded\b([^>]*)>([\s\S]*?)(?:<\/skill-loaded>|$)/i;

function envelopeAttribute(attributes: string, name: 'name' | 'args'): string | undefined {
  const pattern = name === 'name' ? /\bname\s*=\s*"([^"]*)"/i : /\bargs\s*=\s*"([^"]*)"/i;
  const value = pattern.exec(attributes)?.[1];
  return value === undefined || value === '' ? undefined : unescapeXml(value);
}

function skillFromEnvelope(text: string): ClassifiedText['skill'] | undefined {
  const match = SKILL_LOADED_RE.exec(text);
  if (match === null) return undefined;
  const name = envelopeAttribute(match[1] ?? '', 'name');
  return name === undefined ? undefined : { source: 'skill', name, args: envelopeAttribute(match[1] ?? '', 'args') };
}

/** The skill body without the engine's `Skill loaded…` line and XML envelope. */
function stripSkillEnvelope(text: string): string {
  const match = SKILL_LOADED_RE.exec(text);
  if (match === null) return text;
  return (match[2] ?? '').trim();
}

function skillFromOrigin(origin: PromptOriginLike | undefined): ClassifiedText['skill'] | undefined {
  if (origin?.kind === 'skill_activation') {
    return {
      source: 'skill',
      name: origin.skillName ?? 'skill',
      args: origin.skillArgs,
    };
  }
  if (origin?.kind === 'plugin_command') {
    return {
      source: 'plugin',
      name: origin.commandName ?? origin.pluginId ?? 'plugin',
      args: origin.commandArgs,
    };
  }
  return undefined;
}

export function classifyTranscriptText(input: {
  text: string;
  presentation?: import('@kiki/transcript').TextPresentation;
  role?: string;
  origin?: PromptOriginLike;
  id?: string;
  subagentPromptAsUser?: boolean;
}): ClassifiedText {
  const origin = unwrapOrigin(input.origin);
  const kind = origin?.kind;
  if (kind === 'unknown' || kind === 'external_thread' || (kind === 'system_trigger' && origin?.name === 'thread_create')) return { lane: 'peer', origin, text: input.text, presentation: input.presentation, reminders: [] };
  if (kind === 'merged') {
    const lanes = (origin?.origins ?? []).map((part) => classifyTranscriptText({ text: '', role: input.role, origin: part, subagentPromptAsUser: input.subagentPromptAsUser }).lane);
    const lane = lanes.length > 0 && lanes.every((value) => value === 'you') ? 'you' : lanes.some((value) => value === 'you' || value === 'peer' || value === 'skill') ? 'peer' : 'system';
    return { lane, origin, text: input.text, presentation: input.presentation, reminders: [], systemVariant: lane === 'system' ? 'system' : undefined };
  }
  const split = splitSystemReminders(input.text, kind === 'injection');
  const notification = kind === 'task' || kind === 'background_task' ? splitTaskNotification(split.text) : undefined;
  if (notification !== undefined) {
    return {
      lane: 'system',
      origin,
      text: notification,
      reminders: split.reminders,
      systemVariant: 'task',
      taskNotification: parseTaskNotificationMeta(split.text, origin),
    };
  }

  if (
    kind === 'user' ||
    (input.subagentPromptAsUser === true && kind === 'system_trigger' && origin?.name === 'subagent')
  ) {
    return { lane: 'you', origin, text: split.text, presentation: input.presentation, reminders: split.reminders };
  }
  if (kind === 'peer_thread' || kind === 'bridged_peer' || kind === 'agent_message' || kind === 'branch_fold') {
    return { lane: 'peer', origin, text: split.text, presentation: input.presentation, reminders: split.reminders };
  }
  if (kind === 'skill_activation' || kind === 'plugin_command') {
    return {
      lane: 'skill',
      origin,
      text: stripSkillEnvelope(split.text),
      reminders: split.reminders,
      userInput: kind === 'skill_activation' && origin?.trigger === 'user-slash' && typeof origin.userInput === 'string' ? origin.userInput : undefined,
      skill: origin?.skillName === undefined && origin?.commandName === undefined
        ? skillFromEnvelope(split.text) ?? skillFromOrigin(origin)
        : skillFromOrigin(origin),
    };
  }
  if (kind === 'shell_command') {
    const shell = parseHistoricalShell(input.text, input.id) ?? {
      commandId: `shell-${input.id ?? origin?.phase ?? 'cmd'}`,
      command: undefined,
      output: split.text,
      isError: origin?.isError === true ? true : undefined,
    };
    return { lane: 'shell', origin, text: split.text, reminders: split.reminders, shell };
  }
  if (kind !== undefined && INTERNAL_ORIGIN_KINDS.has(kind)) {
    const systemVariant = asSystemVariant(kind);
    return {
      lane: 'system',
      origin,
      text: kind === 'cron_job' ? extractCronPrompt(split.text) : split.text,
      reminders: split.reminders,
      systemVariant,
      taskNotification: systemVariant === 'task' ? parseTaskNotificationMeta(split.text, origin) : undefined,
    };
  }
  if (kind !== undefined) {
    return {
      lane: 'system',
      origin,
      text: split.text,
      reminders: split.reminders,
      systemVariant: 'system',
    };
  }

  if (input.role === 'system') {
    return {
      lane: 'system',
      origin,
      text: split.text,
      reminders: split.reminders,
      systemVariant: 'system',
    };
  }

  if (input.role === 'user' || input.role === undefined) {
    return { lane: 'you', origin, text: split.text, presentation: input.presentation, reminders: split.reminders };
  }
  return {
    lane: 'system',
    origin,
    text: split.text,
    reminders: split.reminders,
    systemVariant: 'system',
  };
}

export function mediaFromTextPresentation(presentation: TextPresentation | undefined): readonly MediaRef[] {
  return (presentation?.spans ?? []).flatMap((span) => {
    if (span.kind !== 'attachment' || span.attachment === undefined) return [];
    return [{ kind: 'file' as const, ...span.attachment }];
  });
}

function contentPartsTextPresentation(
  content: Message['content'],
  contentRefs?: readonly ContentRef[],
): TextPresentation | undefined {
  const spans: TextPresentationSpan[] = [];
  let offset = 0;
  let textCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    if (part === undefined || part.type !== 'text') continue;
    if (textCount++ > 0) offset += 1;
    const textRef = contentRefs?.find(
      (ref) => ref.kind === 'text' && ref.path.length === 3 && ref.path[0] === 'content' && ref.path[1] === index && ref.path[2] === 'text',
    );
    const totalLength = textRef !== undefined ? Math.max(part.text.length, textRef.total) : part.text.length;
    const presentation = readTextPresentation((part as { readonly presentation?: unknown }).presentation);
    for (const span of presentation?.spans ?? []) {
      const start = Math.max(0, span.start);
      const end = Math.min(part.text.length, totalLength, span.end);
      if (end > start) spans.push({ ...span, start: offset + start, end: offset + end });
    }
    offset += part.text.length;
  }
  return spans.length === 0 ? undefined : { spans };
}

export function projectMessageContent(
  content: Message['content'],
  contentRefs?: readonly ContentRef[],
): {
  text: string;
  presentation?: import('@kiki/transcript').TextPresentation;
  media: readonly MediaRef[];
} {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push(part.text);
  }
  const presentation = contentPartsTextPresentation(content, contentRefs);
  return { text: parts.join('\n'), presentation, media: [...mediaFromContentParts(content), ...mediaFromTextPresentation(presentation)] };
}
