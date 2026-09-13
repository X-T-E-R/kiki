import type { NormalizedExecutorEvent } from '@kiki/protocol';

import { CodexClientError } from '#/errors';

export interface CodexMappedNotification {
  readonly events: readonly NormalizedExecutorEvent[];
  readonly completion?: {
    readonly threadId: string;
    readonly turnId: string;
    readonly status: string;
    readonly error?: unknown;
  };
  readonly usage?: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly contextWindow?: number;
  };
}

export function mapCodexNotification(
  method: string,
  input: unknown,
): CodexMappedNotification {
  const params = record(input, `${method}.params`);
  if (method === 'item/agentMessage/delta') {
    return { events: [textDelta('message.delta', params, 'assistant')] };
  }
  if (
    method === 'item/reasoning/textDelta' ||
    method === 'item/reasoning/summaryTextDelta'
  ) {
    return { events: [textDelta('thought.delta', params)] };
  }
  if (method === 'item/started') {
    const item = record(params['item'], 'item/started.item');
    return { events: startedEvents(item) };
  }
  if (method === 'item/completed') {
    const item = record(params['item'], 'item/completed.item');
    return { events: completedEvents(item) };
  }
  if (method === 'item/commandExecution/outputDelta') {
    return {
      events: [{
        type: 'tool.update',
        toolCallId: requiredString(params['itemId'], `${method}.itemId`),
        status: 'in_progress',
        content: [{ type: 'text', text: requiredString(params['delta'], `${method}.delta`) }],
      }],
    };
  }
  if (method === 'item/fileChange/patchUpdated') {
    return {
      events: [{
        type: 'tool.update',
        toolCallId: requiredString(params['itemId'], `${method}.itemId`),
        status: 'in_progress',
        rawOutput: params['changes'],
      }],
    };
  }
  if (method === 'turn/plan/updated') {
    return {
      events: [{
        type: 'plan.update',
        plan: { explanation: params['explanation'], steps: params['plan'] },
        unstable: false,
      }],
    };
  }
  if (method === 'thread/tokenUsage/updated') {
    const tokenUsage = record(params['tokenUsage'], `${method}.tokenUsage`);
    const total = record(tokenUsage['total'], `${method}.tokenUsage.total`);
    const inputTokens = finite(total['inputTokens'], `${method}.inputTokens`);
    const cachedInputTokens = finite(total['cachedInputTokens'], `${method}.cachedInputTokens`);
    const outputTokens = finite(total['outputTokens'], `${method}.outputTokens`);
    const contextWindow = optionalFinite(tokenUsage['modelContextWindow']);
    return {
      events: [{
        type: 'usage',
        used: finite(total['totalTokens'], `${method}.totalTokens`),
        size: contextWindow ?? 0,
      }],
      usage: { inputTokens, cachedInputTokens, outputTokens, contextWindow },
    };
  }
  if (method === 'turn/completed') {
    const threadId = requiredString(params['threadId'], `${method}.threadId`);
    const turn = record(params['turn'], `${method}.turn`);
    return {
      events: [],
      completion: {
        threadId,
        turnId: requiredString(turn['id'], `${method}.turn.id`),
        status: requiredString(turn['status'], `${method}.turn.status`),
        error: turn['error'],
      },
    };
  }
  return {
    events: [{ type: 'unknown', updateType: method }],
  };
}

function textDelta(
  type: 'message.delta' | 'thought.delta',
  params: Readonly<Record<string, unknown>>,
  role?: 'assistant',
): NormalizedExecutorEvent {
  const messageId = requiredString(params['itemId'], 'delta.itemId');
  const content = { type: 'text' as const, text: requiredString(params['delta'], 'delta.delta') };
  return type === 'message.delta'
    ? { type, role: role!, messageId, content }
    : { type, messageId, content };
}

function toolStarted(
  item: Readonly<Record<string, unknown>>,
): Extract<NormalizedExecutorEvent, { readonly type: 'tool.call' }> | undefined {
  const type = requiredString(item['type'], 'item.type');
  const id = requiredString(item['id'], 'item.id');
  if (type === 'commandExecution') {
    return {
      type: 'tool.call',
      toolCallId: id,
      title: optionalString(item['command']) ?? 'Command execution',
      kind: 'command',
      status: optionalString(item['status']) ?? 'in_progress',
      rawInput: { command: item['command'], cwd: item['cwd'], commandActions: item['commandActions'] },
      locations: optionalString(item['cwd']) === undefined ? undefined : [{ path: item['cwd'] }],
    };
  }
  if (type === 'fileChange') {
    return {
      type: 'tool.call',
      toolCallId: id,
      title: 'File change',
      kind: 'file',
      status: optionalString(item['status']) ?? 'in_progress',
      rawInput: item['changes'],
    };
  }
  if (type === 'mcpToolCall') {
    return {
      type: 'tool.call',
      toolCallId: id,
      title: `${optionalString(item['server']) ?? 'MCP'}/${optionalString(item['tool']) ?? 'tool'}`,
      kind: 'mcp',
      status: optionalString(item['status']) ?? 'in_progress',
      rawInput: item['arguments'],
    };
  }
  if (type === 'dynamicToolCall' || type === 'collabAgentToolCall') {
    return {
      type: 'tool.call',
      toolCallId: id,
      title: optionalString(item['tool']) ?? optionalString(item['name']) ?? type,
      kind: type,
      status: optionalString(item['status']) ?? 'in_progress',
      rawInput: item['arguments'] ?? item['input'],
    };
  }
  return undefined;
}

function startedEvents(
  item: Readonly<Record<string, unknown>>,
): readonly NormalizedExecutorEvent[] {
  const itemType = requiredString(item['type'], 'item.type');
  if (
    itemType === 'agentMessage' ||
    itemType === 'reasoning' ||
    itemType === 'plan' ||
    itemType === 'userMessage'
  ) {
    return [];
  }
  const tool = toolStarted(item);
  return tool === undefined ? [unknownItemEvent('item/started', item)] : [tool];
}

function completedEvents(
  item: Readonly<Record<string, unknown>>,
): readonly NormalizedExecutorEvent[] {
  const type = requiredString(item['type'], 'item.type');
  const id = requiredString(item['id'], 'item.id');
  if (type === 'userMessage') return [];
  if (type === 'agentMessage') {
    const text = optionalString(item['text']);
    return text === undefined || text.length === 0
      ? []
      : [{ type: 'message.delta', role: 'assistant', messageId: id, content: { type: 'text', text } }];
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(item['summary'])
      ? item['summary'].filter((value): value is string => typeof value === 'string').join('\n\n')
      : undefined;
    return summary === undefined || summary.length === 0
      ? []
      : [{ type: 'thought.delta', messageId: id, content: { type: 'text', text: summary } }];
  }
  if (type === 'plan') {
    return [{ type: 'plan.update', plan: item, unstable: false }];
  }
  const started = toolStarted(item);
  if (started === undefined) return [unknownItemEvent('item/completed', item)];
  return [{
    type: 'tool.update',
    toolCallId: id,
    title: started.title,
    kind: started.kind,
    status: terminalStatus(item),
    rawInput: started.rawInput,
    rawOutput: item['aggregatedOutput'] ?? item['result'] ?? item['error'] ?? item['changes'],
  }];
}

function unknownItemEvent(
  boundary: 'item/started' | 'item/completed',
  item: Readonly<Record<string, unknown>>,
): NormalizedExecutorEvent {
  return {
    type: 'unknown',
    updateType: `${boundary}:${requiredString(item['type'], 'item.type')}`,
  };
}

function terminalStatus(item: Readonly<Record<string, unknown>>): string {
  const status = optionalString(item['status']);
  return status === 'failed' || status === 'declined' || item['error'] !== undefined && item['error'] !== null
    ? 'failed'
    : 'completed';
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodexClientError('protocol', `${name} must be an object`, value);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new CodexClientError('protocol', `${name} must be a string`, value);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CodexClientError('protocol', `${name} must be finite`, value);
  }
  return value;
}

function optionalFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
