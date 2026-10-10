import type { ContentBlock, SessionNotification } from '@agentclientprotocol/sdk';
import type {
  NormalizedExecutorContent,
  NormalizedExecutorEvent,
} from '@kiki/protocol';

import { AcpProtocolError } from '#/errors';

export type {
  NormalizedExecutorContent,
  NormalizedExecutorEvent,
} from '@kiki/protocol';

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

function number(value: unknown, name: string, optional = false): number | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new AcpProtocolError(`${name} must be a number`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AcpProtocolError(`${name} must be a finite number`);
  }
  return value;
}

function content(value: unknown): NormalizedExecutorContent {
  const block = object(value, 'update.content') as ContentBlock & Record<string, unknown>;
  const type = string(block['type'], 'update.content.type')!;
  if (type === 'text') return { type, text: string(block['text'], 'update.content.text')! };
  if (type === 'image') {
    return {
      type,
      mimeType: string(block['mimeType'], 'update.content.mimeType')!,
      data: string(block['data'], 'update.content.data')!,
      uri: string(block['uri'], 'update.content.uri', true),
    };
  }
  if (type === 'audio') {
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
      mimeType: string(block['mimeType'], 'update.content.mimeType', true),
      size: number(block['size'], 'update.content.size', true),
      description: string(block['description'], 'update.content.description', true),
      title: string(block['title'], 'update.content.title', true),
    };
  }
  if (type === 'resource') {
    const resource = object(block['resource'], 'update.content.resource');
    const uri = string(resource['uri'], 'update.content.resource.uri')!;
    const mimeType = string(resource['mimeType'], 'update.content.resource.mimeType', true);
    if (typeof resource['text'] === 'string') {
      return { type, resource: { type: 'text', uri, text: resource['text'], mimeType } };
    }
    if (typeof resource['blob'] === 'string') {
      return { type, resource: { type: 'blob', uri, blob: resource['blob'], mimeType } };
    }
    return { type: 'opaque', contentType: type, payload: boundedDiagnostic(block) };
  }
  return { type: 'opaque', contentType: type, payload: boundedDiagnostic(block) };
}

function boundedDiagnostic(value: unknown): unknown {
  const redact = (input: unknown): unknown => {
    if (typeof input === 'string') return input;
    if (Array.isArray(input)) return input.slice(0, 32).map(redact);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).slice(0, 64).map(([key, item]) => [
        key,
        /credential|private.?key|signature|token|secret/i.test(key) ? '[REDACTED]' : redact(item),
      ]));
    }
    return input;
  };
  try {
    const sanitized = redact(value);
    const json = JSON.stringify(sanitized);
    if (json === undefined) return undefined;
    if (Buffer.byteLength(json, 'utf8') <= 8192) return sanitized;
    return { truncated: true, preview: Buffer.from(json, 'utf8').subarray(0, 8192).toString('utf8') };
  } catch {
    return { unavailable: true };
  }
}

export function mapAcpSessionNotification(
  input: unknown,
): { readonly sessionId: string; readonly event: NormalizedExecutorEvent } {
  const notification = object(input, 'session/update params');
  const sessionId = string(notification['sessionId'], 'session/update.sessionId')!;
  const update = object(notification['update'], 'session/update.update');
  return { sessionId, event: update['sessionUpdate'] === 'auto_compact_completed'
    ? { type: 'context.compacted', threadId: sessionId }
    : mapAcpSessionUpdate(update) };
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
      name: typeof update['name'] === 'string' ? update['name'] : undefined,
      kind: string(update['kind'], 'update.kind', true),
      status: string(update['status'], 'update.status', true),
      rawInput: update['rawInput'],
      rawOutput: update['rawOutput'],
      content: array(update['content'], 'update.content', true),
      locations: array(update['locations'], 'update.locations', true),
    };
  }
  if (updateType === 'tool_call_update') {
    return {
      type: 'tool.update',
      toolCallId: string(update['toolCallId'], 'update.toolCallId')!,
      title: string(update['title'], 'update.title', true),
      name: typeof update['name'] === 'string' ? update['name'] : undefined,
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
  if (updateType === 'image_dropped') {
    return { type: 'session.info', meta: { imageDropped: {
      reason: typeof update['reason'] === 'string' ? update['reason'].slice(0, 1024) : undefined,
      notes: Array.isArray(update['notes']) ? update['notes'].filter((note) => typeof note === 'string').slice(0, 16) : [],
    } } };
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
