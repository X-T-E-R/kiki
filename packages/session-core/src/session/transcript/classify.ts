import type { Message } from '@moonshot-ai/protocol';

import { mediaFromContentParts, type MediaRef } from '../../composer/media';
import type { SystemVariant } from './types';

export interface SplitSystemRemindersResult {
  readonly text: string;
  readonly reminders: readonly string[];
}

export function splitSystemReminders(text: string): SplitSystemRemindersResult {
  const reminders: string[] = [];
  const visible = text.replaceAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/gi, (_match, body: string) => {
    const reminder = body.trim();
    if (reminder !== '') reminders.push(reminder);
    return '';
  });
  return {
    text: visible.replaceAll(/\n{3,}/g, '\n\n').trim(),
    reminders,
  };
}

export interface PromptOriginLike {
  readonly kind?: string;
  readonly trigger?: string;
  readonly skillName?: string;
  readonly commandName?: string;
  readonly skillArgs?: string;
  readonly commandArgs?: string;
  readonly pluginId?: string;
  readonly name?: string;
  readonly variant?: string;
  readonly phase?: string;
  readonly isError?: boolean;
  readonly payload?: unknown;
  readonly taskId?: string;
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
  readonly reminders: readonly string[];
  readonly skill?: { readonly source: 'skill' | 'plugin'; readonly name: string; readonly args: string | undefined };
  readonly systemVariant?: SystemVariant;
  readonly shell?: { readonly commandId: string; readonly output: string; readonly isError: boolean | undefined };
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
  'agent_message',
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
const TASK_NOTIFICATION_RE = /<notification\b([^>]*)>([\s\S]*?)<\/notification>/i;

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
): { commandId: string; output: string; isError: boolean | undefined } | undefined {
  const input = BASH_INPUT_RE.exec(text);
  const stdout = BASH_STDOUT_RE.exec(text);
  const stderr = BASH_STDERR_RE.exec(text);
  if (input === null && stdout === null && stderr === null) return undefined;
  const command = input?.[1] === undefined ? '' : unescapeXml(input[1]).trim();
  const out = stdout?.[1] === undefined ? '' : unescapeXml(stdout[1]);
  const err = stderr?.[1] === undefined ? '' : unescapeXml(stderr[1]);
  const combined = [command === '' ? undefined : `$ ${command}`, out === '' ? undefined : out, err === '' ? undefined : err]
    .filter((part): part is string => part !== undefined)
    .join('\n');
  const slug = command.slice(0, 40) || 'shell';
  return {
    commandId: identity !== undefined && identity !== '' ? `history-${identity}-${slug}` : `history-${slug}`,
    output: combined,
    isError: err !== '' ? true : undefined,
  };
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
  role?: string;
  origin?: PromptOriginLike;
  id?: string;
  subagentPromptAsUser?: boolean;
}): ClassifiedText {
  const origin = unwrapOrigin(input.origin);
  const split = splitSystemReminders(input.text);
  const kind = origin?.kind;
  const notification = splitTaskNotification(split.text);
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
    return { lane: 'you', origin, text: split.text, reminders: split.reminders };
  }
  if (kind === 'peer_thread') {
    return { lane: 'peer', origin, text: split.text, reminders: split.reminders };
  }
  if (kind === 'skill_activation' || kind === 'plugin_command') {
    if (origin?.trigger === 'user-slash') {
      return {
        lane: 'skill',
        origin,
        text: split.text,
        reminders: split.reminders,
        skill: skillFromOrigin(origin),
      };
    }
    return {
      lane: 'system',
      origin,
      text: split.text,
      reminders: split.reminders,
      systemVariant: 'system',
    };
  }
  if (kind === 'shell_command') {
    const shell = parseHistoricalShell(input.text, input.id) ?? {
      commandId: `shell-${input.id ?? origin?.phase ?? 'cmd'}`,
      output: split.text,
      isError: origin?.isError === true ? true : undefined,
    };
    return { lane: 'shell', origin, text: split.text, reminders: split.reminders, shell };
  }
  if (kind !== undefined && INTERNAL_ORIGIN_KINDS.has(kind)) {
    return {
      lane: 'system',
      origin,
      text: split.text,
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

  const shell = parseHistoricalShell(input.text, input.id);
  if (shell !== undefined) {
    return { lane: 'shell', origin, text: split.text, reminders: split.reminders, shell };
  }
  if (CRON_FIRE_RE.test(input.text)) {
    return {
      lane: 'system',
      origin,
      text: split.text,
      reminders: split.reminders,
      systemVariant: 'cron_job',
    };
  }
  if (split.text === '' && split.reminders.length > 0) {
    return { lane: 'reminder', origin, text: '', reminders: split.reminders };
  }
  if (input.role === 'user' || input.role === undefined) {
    return { lane: 'you', origin, text: split.text, reminders: split.reminders };
  }
  return {
    lane: 'system',
    origin,
    text: split.text,
    reminders: split.reminders,
    systemVariant: 'system',
  };
}

export function projectMessageContent(content: Message['content']): {
  text: string;
  media: readonly MediaRef[];
} {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push(part.text);
  }
  return { text: parts.join('\n'), media: mediaFromContentParts(content) };
}
