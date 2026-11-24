import { createDecorator } from "#/_base/di/instantiation";

import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';

const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';
const SYSTEM_REMINDER_PREFIX = `${SYSTEM_REMINDER_OPEN}\n`;
const SYSTEM_REMINDER_SUFFIX = `\n${SYSTEM_REMINDER_CLOSE}`;
const SYSTEM_REMINDER_CLOSE_RE = /<\/system-reminder>/gi;
const ESCAPED_SYSTEM_REMINDER_CLOSE_RE = /<\\\/system-reminder>/gi;

function parseTopLevelSystemReminderBlocks(trimmed: string): string[] | undefined {
  if (!trimmed.startsWith(SYSTEM_REMINDER_OPEN) || !trimmed.endsWith(SYSTEM_REMINDER_CLOSE)) {
    return undefined;
  }
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < trimmed.length) {
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor]!)) cursor += 1;
    if (cursor >= trimmed.length) break;
    if (!trimmed.startsWith(SYSTEM_REMINDER_OPEN, cursor)) return undefined;
    const bodyStart = cursor + SYSTEM_REMINDER_OPEN.length;
    const closeIdx = trimmed.indexOf(SYSTEM_REMINDER_CLOSE, bodyStart);
    if (closeIdx === -1) return undefined;
    blocks.push(trimmed.slice(bodyStart, closeIdx).trim());
    cursor = closeIdx + SYSTEM_REMINDER_CLOSE.length;
  }
  return blocks.length > 0 ? blocks : undefined;
}

function escapeClosingSystemReminder(content: string): string {
  return content.replace(SYSTEM_REMINDER_CLOSE_RE, '<\\/system-reminder>');
}

export function unwrapSystemReminder(content: string): string {
  const trimmed = content.trim();
  const blocks = parseTopLevelSystemReminderBlocks(trimmed);
  const body = blocks === undefined ? trimmed : blocks.join('\n\n');
  return body.replace(ESCAPED_SYSTEM_REMINDER_CLOSE_RE, SYSTEM_REMINDER_CLOSE);
}

export function wrapSystemReminder(content: string): string {
  const trimmed = content.trim();
  const blocks = parseTopLevelSystemReminderBlocks(trimmed);
  if (blocks !== undefined) {
    return blocks
      .map((block) => `${SYSTEM_REMINDER_PREFIX}${escapeClosingSystemReminder(block)}${SYSTEM_REMINDER_SUFFIX}`)
      .join('\n\n');
  }
  return `${SYSTEM_REMINDER_PREFIX}${escapeClosingSystemReminder(trimmed)}${SYSTEM_REMINDER_SUFFIX}`;
}

export function systemReminderContent(message: ContextMessage): string | undefined {
  const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  if (!text.startsWith(SYSTEM_REMINDER_PREFIX) || !text.endsWith(SYSTEM_REMINDER_SUFFIX)) {
    return undefined;
  }
  return text.slice(SYSTEM_REMINDER_PREFIX.length, text.length - SYSTEM_REMINDER_SUFFIX.length);
}

export interface IAgentSystemReminderService {
  readonly _serviceBrand: undefined;

  appendSystemReminder(content: string, origin: PromptOrigin): ContextMessage;
}

export const IAgentSystemReminderService = createDecorator<IAgentSystemReminderService>('agentSystemReminderService');
