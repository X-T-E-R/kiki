import type { ContentBlock, SessionNotification } from '@agentclientprotocol/sdk';

import { AcpProtocolError } from '#/errors';

export type NormalizedExecutorContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name?: string }
  | { readonly type: 'opaque'; readonly contentType: string };

export type NormalizedExecutorEvent =
  | {
      readonly type: 'message.delta';
      readonly role: 'user' | 'assistant';
      readonly messageId?: string;
      readonly content: NormalizedExecutorContent;
    }
  | {
      readonly type: 'thought.delta';
      readonly messageId?: string;
      readonly content: NormalizedExecutorContent;
    }
  | {
      readonly type: 'tool.call';
      readonly toolCallId: string;
      readonly title: string;
      readonly kind?: string;
      readonly status?: string;
      readonly rawInput?: unknown;
      readonly content?: readonly unknown[];
      readonly locations?: readonly unknown[];
    }
  | {
      readonly type: 'tool.update';
      readonly toolCallId: string;
      readonly title?: string;
      readonly kind?: string;
      readonly status?: string;
      readonly rawInput?: unknown;
      readonly rawOutput?: unknown;
      readonly content?: readonly unknown[];
      readonly locations?: readonly unknown[];
    }
  | { readonly type: 'plan.update'; readonly plan: unknown; readonly unstable: boolean }
  | { readonly type: 'plan.remove'; readonly planId?: string; readonly unstable: true }
  | { readonly type: 'commands.update'; readonly commands: readonly unknown[] }
  | { readonly type: 'mode.update'; readonly currentModeId: string }
  | { readonly type: 'config.update'; readonly configOptions: readonly unknown[] }
  | { readonly type: 'session.info'; readonly title?: string; readonly meta?: unknown }
  | {
      readonly type: 'usage';
      readonly used: number;
      readonly size: number;
      readonly cost?: unknown;
    }
  | { readonly type: 'unknown'; readonly updateType: string };

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AcpProtocolError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, optional = false): string | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new AcpProtocolError(`${name} must be a string`);
  }
  if (typeof value !== 'string') throw new AcpProtocolError(`${name} must be a string`);
  return value;
}

function array(value: unknown, name: string, optional = false): readonly unknown[] | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new AcpProtocolError(`${name} must be an array`);
  }
  if (!Array.isArray(value)) throw new AcpProtocolError(`${name} must be an array`);
  return value;
}

function content(value: unknown): NormalizedExecutorContent {
  const block = object(value, 'update.content') as ContentBlock & Record<string, unknown>;
  const type = string(block['type'], 'update.content.type');
  if (type === 'text') return { type, text: string(block['text'], 'update.content.text')! };
  if (type === 'image') {
    return {
      type,
      mimeType: string(block['mimeType'], 'update.content.mimeType')!,
      data: string(block['data'], 'update.content.data')!,
    };
  }
  if (type === 'resource_link') {
    return {
      type,
      uri: string(block['uri'], 'update.content.uri')!,
      name: string(block['name'], 'update.content.name', true),
    };
  }
  return { type: 'opaque', contentType: type! };
}

export function mapAcpSessionNotification(
  input: unknown,
): { readonly sessionId: string; readonly event: NormalizedExecutorEvent } {
  const notification = object(input, 'session/update params');
  const sessionId = string(notification['sessionId'], 'session/update.sessionId')!;
  return { sessionId, event: mapAcpSessionUpdate(notification['update']) };
}

export function mapAcpSessionUpdate(input: unknown): NormalizedExecutorEvent {
  const update = object(input, 'session/update.update');
  const updateType = string(update['sessionUpdate'], 'session/update.update.sessionUpdate')!;
  const messageId = string(update['messageId'], 'update.messageId', true);

  if (updateType === 'user_message_chunk' || updateType === 'agent_message_chunk') {
    return {
      type: 'message.delta',
      role: updateType === 'user_message_chunk' ? 'user' : 'assistant',
      messageId,
      content: content(update['content']),
    };
  }
  if (updateType === 'agent_thought_chunk') {
    return { type: 'thought.delta', messageId, content: content(update['content']) };
  }
  if (updateType === 'tool_call') {
    return {
      type: 'tool.call',
      toolCallId: string(update['toolCallId'], 'update.toolCallId')!,
      title: string(update['title'], 'update.title')!,
      kind: string(update['kind'], 'update.kind', true),
      status: string(update['status'], 'update.status', true),
      rawInput: update['rawInput'],
      content: array(update['content'], 'update.content', true),
      locations: array(update['locations'], 'update.locations', true),
    };
  }
  if (updateType === 'tool_call_update') {
    return {
      type: 'tool.update',
      toolCallId: string(update['toolCallId'], 'update.toolCallId')!,
      title: string(update['title'], 'update.title', true),
      kind: string(update['kind'], 'update.kind', true),
      status: string(update['status'], 'update.status', true),
      rawInput: update['rawInput'],
      rawOutput: update['rawOutput'],
      content: array(update['content'], 'update.content', true),
      locations: array(update['locations'], 'update.locations', true),
    };
  }
  if (updateType === 'plan') return { type: 'plan.update', plan: update, unstable: false };
  if (updateType === 'plan_update') {
    return { type: 'plan.update', plan: update, unstable: true };
  }
  if (updateType === 'plan_removed') {
    return {
      type: 'plan.remove',
      planId: string(update['planId'], 'update.planId', true),
      unstable: true,
    };
  }
  if (updateType === 'available_commands_update') {
    return {
      type: 'commands.update',
      commands: array(update['availableCommands'], 'update.availableCommands')!,
    };
  }
  if (updateType === 'current_mode_update') {
    return {
      type: 'mode.update',
      currentModeId: string(update['currentModeId'], 'update.currentModeId')!,
    };
  }
  if (updateType === 'config_option_update') {
    return {
      type: 'config.update',
      configOptions: array(update['configOptions'], 'update.configOptions')!,
    };
  }
  if (updateType === 'session_info_update') {
    return {
      type: 'session.info',
      title: string(update['title'], 'update.title', true),
      meta: update['_meta'],
    };
  }
  if (updateType === 'usage_update') {
    const used = update['used'];
    const size = update['size'];
    if (typeof used !== 'number' || !Number.isFinite(used)) {
      throw new AcpProtocolError('update.used must be a finite number');
    }
    if (typeof size !== 'number' || !Number.isFinite(size)) {
      throw new AcpProtocolError('update.size must be a finite number');
    }
    return { type: 'usage', used, size, cost: update['cost'] };
  }
  return { type: 'unknown', updateType };
}

export function isSessionNotification(value: unknown): value is SessionNotification {
  try {
    mapAcpSessionNotification(value);
    return true;
  } catch {
    return false;
  }
}
