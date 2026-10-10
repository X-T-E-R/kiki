import type { Message } from '@kiki/protocol';
import { contentTextPresentation, type TextPresentation } from '@kiki/transcript';

import { mediaFromContentParts, type MediaRef } from '../../composer/media';
import type { SystemVariant } from './types';

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
  readonly disclosure?: unknown;
  readonly phase?: string;
  readonly isError?: boolean;
  readonly payload?: unknown;
  readonly taskId?: string;
  /** hook_result: the hook event, e.g. `kiki:claude:SessionStart`. */
  readonly event?: string;
  readonly senderAgentId?: string;
  readonly senderTaskName?: string;
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
    };
  }

  if (
    kind === 'user' ||
    (input.subagentPromptAsUser === true && kind === 'system_trigger' && origin?.name === 'subagent')
  ) {
    return { lane: 'you', origin, text: split.text, presentation: input.presentation, reminders: split.reminders };
  }
  if (kind === 'peer_thread' || kind === 'bridged_peer' || kind === 'agent_message') {
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
    return {
      lane: 'system',
      origin,
      text: kind === 'cron_job' ? extractCronPrompt(split.text) : split.text,
      reminders: split.reminders,
      systemVariant: asSystemVariant(kind),
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

export function projectMessageContent(content: Message['content']): {
  text: string;
  presentation?: import('@kiki/transcript').TextPresentation;
  media: readonly MediaRef[];
} {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push(part.text);
  }
  const presentation = contentTextPresentation(content, '\n');
  return { text: parts.join('\n'), presentation, media: [...mediaFromContentParts(content), ...mediaFromTextPresentation(presentation)] };
}
