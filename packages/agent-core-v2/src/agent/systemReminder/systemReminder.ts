import { createDecorator } from "#/_base/di/instantiation";

import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';

const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';
const SYSTEM_REMINDER_PREFIX = `${SYSTEM_REMINDER_OPEN}\n`;
const SYSTEM_REMINDER_SUFFIX = `\n${SYSTEM_REMINDER_CLOSE}`;

function unwrapSingleSystemReminder(trimmed: string): string | undefined {
  if (!trimmed.startsWith(SYSTEM_REMINDER_OPEN) || !trimmed.endsWith(SYSTEM_REMINDER_CLOSE)) {
    return undefined;
  }
  const firstClose = trimmed.indexOf(SYSTEM_REMINDER_CLOSE);
  if (firstClose !== trimmed.length - SYSTEM_REMINDER_CLOSE.length) {
    return undefined;
  }
  return trimmed
    .slice(SYSTEM_REMINDER_OPEN.length, trimmed.length - SYSTEM_REMINDER_CLOSE.length)
    .trim();
}

export function wrapSystemReminder(content: string): string {
  const trimmed = content.trim();
  const inner = unwrapSingleSystemReminder(trimmed);
  return `${SYSTEM_REMINDER_PREFIX}${inner ?? trimmed}${SYSTEM_REMINDER_SUFFIX}`;
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
