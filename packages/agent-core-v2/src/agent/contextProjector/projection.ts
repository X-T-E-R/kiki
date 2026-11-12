import { ErrorCodes, Error2 } from '#/errors';
import { renderImSourceMetadata } from '@kiki-dsh/im-bridge-core/metadata';
import { renderToolResultForModel } from '#/agent/contextMemory/toolResultRender';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import type { ContentPart, Message, ToolCall } from '#/kosong/contract/message';
import { renderModelReceipt } from './modelReceipt';

export type ProjectionAnomaly =
  | { readonly kind: 'tool_result_reordered'; readonly toolCallId: string }
  | { readonly kind: 'tool_result_synthesized'; readonly toolCallId: string; readonly trailing: boolean }
  | { readonly kind: 'orphan_tool_result_dropped'; readonly toolCallId: string }
  | { readonly kind: 'duplicate_tool_call_dropped'; readonly toolCallId: string }
  | { readonly kind: 'duplicate_tool_result_dropped'; readonly toolCallId: string }
  | { readonly kind: 'leading_non_user_dropped'; readonly role: string }
  | { readonly kind: 'consecutive_assistants_merged' }
  | { readonly kind: 'whitespace_text_dropped'; readonly role: string }
  | { readonly kind: 'vacuous_message_dropped'; readonly role: string };

export type OnAnomaly = (anomaly: ProjectionAnomaly) => void;

export interface ProjectionRepairSummary {
  readonly reordered: number;
  readonly synthesized: number;
  readonly droppedOrphan: number;
  readonly duplicateCallsDropped: number;
  readonly duplicateResultsDropped: number;
  readonly leadingDropped: number;
  readonly assistantsMerged: number;
  readonly whitespaceDropped: number;
  readonly vacuousDropped: number;
}

export function summarizeProjectionRepairs(
  anomalies: readonly ProjectionAnomaly[],
): ProjectionRepairSummary {
  const summary = {
    reordered: 0,
    synthesized: 0,
    droppedOrphan: 0,
    duplicateCallsDropped: 0,
    duplicateResultsDropped: 0,
    leadingDropped: 0,
    assistantsMerged: 0,
    whitespaceDropped: 0,
    vacuousDropped: 0,
  };
  for (const anomaly of anomalies) {
    if (anomaly.kind === 'tool_result_reordered') summary.reordered += 1;
    else if (anomaly.kind === 'tool_result_synthesized') summary.synthesized += 1;
    else if (anomaly.kind === 'orphan_tool_result_dropped') summary.droppedOrphan += 1;
    else if (anomaly.kind === 'duplicate_tool_call_dropped') summary.duplicateCallsDropped += 1;
    else if (anomaly.kind === 'duplicate_tool_result_dropped') summary.duplicateResultsDropped += 1;
    else if (anomaly.kind === 'leading_non_user_dropped') summary.leadingDropped += 1;
    else if (anomaly.kind === 'consecutive_assistants_merged') summary.assistantsMerged += 1;
    else if (anomaly.kind === 'vacuous_message_dropped') summary.vacuousDropped += 1;
    else summary.whitespaceDropped += 1;
  }
  return summary;
}

export interface ProjectOptions {
  readonly toolResultAppendix?: 'host_auto_injections' | 'trailing_user_text';
  readonly appendixHistory?: {
    readonly canonical: readonly ContextMessage[];
    readonly sourceIndexes: readonly number[];
  };
  readonly onToolResultAppendix?: (stats: {
    readonly projectedBatches: number;
    readonly projectedMessages: number;
  }) => void;
}

export function project(
  history: readonly ContextMessage[],
  onAnomaly?: OnAnomaly,
  options?: ProjectOptions,
): Message[] {
  const layout = sliceLayout(history);
  const blocks = applyToolResultAppendix(history, pairBlocks(history, layout, onAnomaly), options);
  return flattenBlocks(anchorCompactedToolHistory(blocks), layout, onAnomaly);
}

export function projectStrict(
  history: readonly ContextMessage[],
  onAnomaly?: OnAnomaly,
  options?: ProjectOptions,
): Message[] {
  const projected = project(history, onAnomaly, options);
  return dropLeadingNonUserMessages(
    mergeConsecutiveAssistantMessages(dedupeDuplicateToolCalls(projected, onAnomaly), onAnomaly),
    onAnomaly,
  );
}

interface SliceLayout {
  readonly sizing: boolean;
  readonly lastNonToolIndex: number;
}

function sliceLayout(history: readonly ContextMessage[]): SliceLayout {
  let sizing = true;
  let lastNonToolIndex = -1;
  for (const [index, message] of history.entries()) {
    if (message.partial === true || message.role === 'tool') continue;
    lastNonToolIndex = index;
    if (message.role === 'assistant') sizing = false;
  }
  return { sizing, lastNonToolIndex };
}

interface AttachedResult {
  readonly source: ContextMessage;
  readonly content: ContentPart[];
}

const INTERRUPTED_RESULT = Symbol('interruptedResult');

interface PendingCall {
  readonly callId: string;
  result: AttachedResult | typeof INTERRUPTED_RESULT | undefined;
  foreignBetween: boolean;
}

interface Exchange {
  readonly source: ContextMessage;
  readonly content: ContentPart[];
  readonly ownerIndex: number;
  readonly pending: PendingCall[];
}

type Block =
  | {
      readonly kind: 'message';
      readonly source: ContextMessage;
      readonly content: ContentPart[];
      readonly ownerIndex: number;
    }
  | { readonly kind: 'exchange'; readonly exchange: Exchange }
  | { readonly kind: 'boundary' };

function anchorCompactedToolHistory(blocks: readonly Block[]): readonly Block[] {
  let hasLeadingExchange = false;
  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'exchange' && block.exchange.source.role === 'assistant') {
      hasLeadingExchange = true;
    } else if (block.kind === 'message' && block.source.role === 'user') {
      if (!hasLeadingExchange) return blocks;
      if (block.source.origin?.kind === 'compaction_summary') {
        return [block, ...blocks.slice(0, index), ...blocks.slice(index + 1)];
      }
    }
  }
  return blocks;
}

function pairBlocks(
  history: readonly ContextMessage[],
  layout: SliceLayout,
  onAnomaly?: OnAnomaly,
): Block[] {
  const blocks: Block[] = [];
  const openCalls = new Map<string, { exchange: Exchange; pending: PendingCall }>();

  const markForeignBetween = (): void => {
    for (const { pending } of openCalls.values()) pending.foreignBetween = true;
  };

  for (const [index, message] of history.entries()) {
    if (message.partial === true) {
      blocks.push({ kind: 'boundary' });
      continue;
    }
    if (message.role === 'tool' && !layout.sizing) {
      if (message.toolCallId === undefined) {
        blocks.push({ kind: 'boundary' });
        continue;
      }
      const open = openCalls.get(message.toolCallId);
      if (open === undefined) {
        markForeignBetween();
        blocks.push({ kind: 'boundary' });
        onAnomaly?.({ kind: 'orphan_tool_result_dropped', toolCallId: message.toolCallId });
        continue;
      }
      openCalls.delete(message.toolCallId);
      const call = open.exchange.source.toolCalls.find((candidate) => candidate.id === message.toolCallId);
      open.pending.result = { source: message, content: projectedContent(message, onAnomaly, call) };
      if (open.pending.foreignBetween) {
        onAnomaly?.({ kind: 'tool_result_reordered', toolCallId: message.toolCallId });
      }
      continue;
    }

    const content = projectedContent(message, onAnomaly);
    if (message.toolCalls.length === 0 && !hasDeclaredTools(message)) {
      if (content.length === 0) {
        blocks.push({ kind: 'boundary' });
        continue;
      }
      if (content.every(isVacuousContentPart)) {
        blocks.push({ kind: 'boundary' });
        onAnomaly?.({ kind: 'vacuous_message_dropped', role: message.role });
        continue;
      }
    }
    markForeignBetween();
    if (message.toolCalls.length === 0) {
      blocks.push({ kind: 'message', source: message, content, ownerIndex: index });
      continue;
    }

    const exchange: Exchange = { source: message, content, ownerIndex: index, pending: [] };
    blocks.push({ kind: 'exchange', exchange });
    for (const call of message.toolCalls) {
      const superseded = openCalls.get(call.id);
      if (superseded !== undefined) {
        superseded.pending.result = INTERRUPTED_RESULT;
        onAnomaly?.({
          kind: 'tool_result_synthesized',
          toolCallId: call.id,
          trailing: superseded.exchange.ownerIndex >= layout.lastNonToolIndex,
        });
      }
      const pending: PendingCall = { callId: call.id, result: undefined, foreignBetween: false };
      exchange.pending.push(pending);
      openCalls.set(call.id, { exchange, pending });
    }
  }
  return blocks;
}

interface UserMergeAnchor {
  readonly turnId: number;
  readonly stepId: string;
}

interface MergeState {
  readonly anchor: UserMergeAnchor;
  readonly messages: Array<{ readonly source: ContextMessage; readonly content: ContentPart[] }>;
}

function flattenBlocks(
  blocks: readonly Block[],
  layout: SliceLayout,
  onAnomaly?: OnAnomaly,
): Message[] {
  const out: Message[] = [];
  let merge: MergeState | undefined;

  const flushMerge = (): void => {
    if (merge === undefined) return;
    if (merge.messages.length === 1) {
      const single = merge.messages[0]!;
      out.push(toWireMessage(single.source, single.content));
    } else {
      out.push({
        role: 'user',
        name: undefined,
        content: mergeUserContent(merge.messages),
        toolCalls: [],
        toolCallId: undefined,
        partial: undefined,
      });
    }
    merge = undefined;
  };

  for (const block of blocks) {
    if (block.kind === 'boundary') {
      flushMerge();
      continue;
    }
    if (block.kind === 'message') {
      const anchor = userMergeAnchor(block.source);
      if (anchor !== undefined) {
        if (merge === undefined || !sameUserMergeAnchor(merge.anchor, anchor)) {
          flushMerge();
          merge = { anchor, messages: [block] };
        } else {
          merge.messages.push(block);
        }
        continue;
      }
      flushMerge();
      out.push(toWireMessage(block.source, block.content));
      continue;
    }

    flushMerge();
    const { exchange } = block;
    out.push(toWireMessage(exchange.source, exchange.content));
    for (const pending of exchange.pending) {
      if (pending.result === undefined) {
        out.push(createInterruptedToolResult(pending.callId));
        onAnomaly?.({
          kind: 'tool_result_synthesized',
          toolCallId: pending.callId,
          trailing: exchange.ownerIndex >= layout.lastNonToolIndex,
        });
      } else if (pending.result === INTERRUPTED_RESULT) {
        out.push(createInterruptedToolResult(pending.callId));
      } else {
        out.push(toWireMessage(pending.result.source, pending.result.content));
      }
    }
  }
  flushMerge();
  return out;
}

function dedupeDuplicateToolCalls(messages: readonly Message[], onAnomaly?: OnAnomaly): Message[] {
  const seenToolCallIds = new Set<string>();
  const keptToolResultIndexes = new Map<string, number>();
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      const kept = message.toolCalls.filter((toolCall) => {
        if (seenToolCallIds.has(toolCall.id)) {
          onAnomaly?.({ kind: 'duplicate_tool_call_dropped', toolCallId: toolCall.id });
          return false;
        }
        seenToolCallIds.add(toolCall.id);
        return true;
      });
      if (kept.length === message.toolCalls.length) {
        out.push(message);
      } else if (kept.length > 0 || !message.content.every(isVacuousContentPart)) {
        out.push({ ...message, toolCalls: kept });
      } else if (message.content.length > 0) {
        onAnomaly?.({ kind: 'vacuous_message_dropped', role: message.role });
      }
      continue;
    }
    if (message.role === 'tool' && message.toolCallId !== undefined) {
      const previousIndex = keptToolResultIndexes.get(message.toolCallId);
      if (previousIndex !== undefined) {
        if (isInterruptedToolResult(out[previousIndex]) && !isInterruptedToolResult(message)) {
          out[previousIndex] = message;
        } else {
          onAnomaly?.({ kind: 'duplicate_tool_result_dropped', toolCallId: message.toolCallId });
        }
        continue;
      }
      keptToolResultIndexes.set(message.toolCallId, out.length);
    }
    out.push(message);
  }
  return out;
}

function mergeConsecutiveAssistantMessages(
  messages: readonly Message[],
  onAnomaly?: OnAnomaly,
): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const previous = out.at(-1);
    if (previous !== undefined && previous.role === 'assistant' && message.role === 'assistant') {
      out[out.length - 1] = {
        ...previous,
        content: [...previous.content, ...message.content],
        toolCalls: [...previous.toolCalls, ...message.toolCalls],
      };
      onAnomaly?.({ kind: 'consecutive_assistants_merged' });
      continue;
    }
    out.push(message);
  }
  return out;
}

function dropLeadingNonUserMessages(messages: readonly Message[], onAnomaly?: OnAnomaly): Message[] {
  let start = 0;
  while (start < messages.length && messages[start]?.role !== 'user') {
    onAnomaly?.({ kind: 'leading_non_user_dropped', role: messages[start]!.role });
    start += 1;
  }
  return start === 0 ? [...messages] : messages.slice(start);
}

function mergeUserContent(
  messages: readonly { readonly source: ContextMessage; readonly content: ContentPart[] }[],
): ContentPart[] {
  const prefixes: ContentPart[] = [];
  const body: ContentPart[] = [];
  let previousBodyHadText = false;
  let hasPreviousBody = false;

  for (const message of messages) {
    const prefixCount = skillPrefixCount(message.source);
    const split = prefixCount > 0 && message.content.slice(0, prefixCount).every((part) => part.type === 'text')
      ? prefixCount
      : 0;
    prefixes.push(...message.content.slice(0, split));
    const current = message.content.slice(split);
    if (current.length === 0) continue;

    const currentHasText = current.some((part) => part.type === 'text');
    if (hasPreviousBody && previousBodyHadText && currentHasText) {
      const firstTextIndex = current.findIndex((part) => part.type === 'text');
      const firstText = current[firstTextIndex];
      if (firstText?.type === 'text') {
        const previous = body.at(-1);
        if (firstTextIndex === 0 && canCombineTextParts(previous, firstText)) {
          body[body.length - 1] = {
            ...previous,
            text: `${previous.text}\n\n${firstText.text}`,
          };
          current.splice(firstTextIndex, 1);
        } else {
          current[firstTextIndex] = { ...firstText, text: `\n\n${firstText.text}` };
        }
      }
    }
    body.push(...current);
    hasPreviousBody = true;
    previousBodyHadText = currentHasText;
  }

  return [...prefixes, ...body];
}

function canCombineTextParts(
  previous: ContentPart | undefined,
  current: ContentPart,
): previous is Extract<ContentPart, { type: 'text' }> {
  return previous?.type === 'text' && current.type === 'text' &&
    previous.presentation === undefined && previous.attachment === undefined && previous.resourceLink === undefined &&
    current.presentation === undefined && current.attachment === undefined && current.resourceLink === undefined;
}

function skillPrefixCount(message: ContextMessage): number {
  const count = (origin: ContextMessage['origin']): number => {
    if (origin?.kind === 'merged') return origin.origins.reduce((total, item) => total + count(item), 0);
    if (origin?.kind === 'user') return origin.skillActivations?.length ?? 0;
    if (origin?.kind === 'skill_activation') return 1;
    return 0;
  };
  return count(message.origin);
}

function projectedContent(source: ContextMessage, onAnomaly?: OnAnomaly, call?: ToolCall): ContentPart[] {
  const output = source.role === 'tool' ? outputFromToolContent(source.content) : source.content;
  const content =
    source.role === 'tool'
      ? renderToolResultForModel({
          output: typeof output === 'string' ? renderModelReceipt(call?.name, output, call?.arguments) : output,
          isError: source.isError,
          note: source.note,
          toolName: call?.name,
        })
      : source.content;
  const projected = cleanContent(source, source.origin?.kind === 'compaction_summary' ? content.filter(part => part.type === 'text') : content, onAnomaly);
  const im = source.role === 'user' && source.origin?.kind === 'user' ? source.origin.im : undefined;
  if (im !== undefined) {
    projected.splice(skillPrefixCount(source), 0, {
      type: 'text',
      text: renderImSourceMetadata(im),
    });
  }
  return projected;
}

function cleanContent(
  source: ContextMessage,
  rawContent: readonly ContentPart[],
  onAnomaly?: OnAnomaly,
): ContentPart[] {
  const hasBlank = rawContent.some(isBlankText);
  let content: readonly ContentPart[] = rawContent;
  if (hasBlank) {
    const filtered: ContentPart[] = [];
    for (const part of rawContent) {
      if (isBlankText(part)) {
        if (part.type === 'text' && part.text.length > 0) {
          onAnomaly?.({ kind: 'whitespace_text_dropped', role: source.role });
        }
      } else {
        filtered.push(part);
      }
    }
    content = filtered;
  }
  if (source.role === 'tool' && content.length === 0) {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      'Tool result message content cannot be empty after removing empty text blocks.',
      { details: { toolCallId: source.toolCallId } },
    );
  }
  return [...content];
}

function outputFromToolContent(content: readonly ContentPart[]): string | readonly ContentPart[] {
  const only = content[0];
  return content.length === 1 && only?.type === 'text' ? only.text : content;
}

const TOOL_INTERRUPTED_TEXT =
  'Tool result is not available in the current context. Do not assume the tool completed successfully.';

function createInterruptedToolResult(toolCallId: string): Message {
  return {
    role: 'tool',
    name: undefined,
    content: [{ type: 'text', text: TOOL_INTERRUPTED_TEXT }],
    toolCalls: [],
    toolCallId,
    partial: undefined,
  };
}

function isInterruptedToolResult(message: Message | undefined): boolean {
  if (message?.role !== 'tool') return false;
  const [part] = message.content;
  return part?.type === 'text' && part.text === TOOL_INTERRUPTED_TEXT;
}

function isBlankText(part: ContentPart): boolean {
  return part.type === 'text' && part.text.trim().length === 0;
}

function userMergeAnchor(message: ContextMessage): UserMergeAnchor | undefined {
  if (message.role !== 'user') return undefined;
  const source = message.source;
  if (source?.turnId === undefined || source.stepId === undefined || source.stepId.trim().length === 0) return undefined;
  return { turnId: source.turnId, stepId: source.stepId };
}

function sameUserMergeAnchor(a: UserMergeAnchor, b: UserMergeAnchor): boolean {
  return a.turnId === b.turnId && a.stepId === b.stepId;
}

function hasDeclaredTools(message: ContextMessage): boolean {
  return message.tools !== undefined && message.tools.length > 0;
}

function toWireMessage(message: ContextMessage, content: ContentPart[]): Message {
  return {
    role: message.role,
    name: message.name,
    content,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    partial: message.partial,
    tools: message.tools,
  };
}

const HOST_AUTO_INJECTION_VARIANTS = new Set<string>([
  'runtime_snapshot',
  'memory_authority',
  'agents_md',
  'capability_delta',
  'loadable-tools',
  'capabilities_rebuilt',
  'profile_capabilities_changed',
  'agent_profile_changes',
  'plugin_change',
  'plugin_session_start',
  'plan_mode',
  'goal',
  'goal_cancelled',
  'goal_budget_stop',
  'goal_fork_cleared',
  'model_steering',
  'subagent_parent_steering',
  'background_task_status',
  'permission_mode',
  'todo_list_reminder',
  'date_change',
  'interruption',
  'message_delivery',
  'init',
  'btw',
  'room_left',
  'room_joined',
  'compaction_elision',
]);

function isHostAutoInjectionVariant(variant: string | undefined): boolean {
  if (variant === undefined) return false;
  if (HOST_AUTO_INJECTION_VARIANTS.has(variant)) return true;
  return variant.startsWith('hook_rule/');
}

function isHostAutoInjectionOrigin(origin: PromptOrigin | undefined): boolean {
  if (origin === undefined) return false;
  switch (origin.kind) {
    case 'injection':
      return origin.ownerPromptId === undefined && isHostAutoInjectionVariant(origin.variant);
    case 'skill_activation':
      return origin.trigger === 'model-tool' || origin.trigger === 'nested-skill';
    case 'task':
    case 'cron_missed':
      return true;
    case 'merged':
      return origin.origins.length > 0 && origin.origins.every(isHostAutoInjectionOrigin);
    default:
      return false;
  }
}

export function isHostAutoInjectedMessage(message: ContextMessage): boolean {
  if (message.role !== 'user' || message.partial === true) return false;
  if (message.toolCalls.length > 0 || hasDeclaredTools(message)) return false;
  return isHostAutoInjectionOrigin(message.origin);
}

function collectGloballyUniqueToolCallIds(history: readonly ContextMessage[]): ReadonlySet<string> {
  const callCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  for (const message of history) {
    if (message.partial === true) continue;
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) {
        if (call.id.length === 0) continue;
        callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
      }
      continue;
    }
    if (message.role === 'tool' && message.toolCallId !== undefined && message.toolCallId.length > 0) {
      resultCounts.set(message.toolCallId, (resultCounts.get(message.toolCallId) ?? 0) + 1);
    }
  }
  const unique = new Set<string>();
  for (const [callId, count] of callCounts) {
    if (count === 1 && resultCounts.get(callId) === 1) {
      unique.add(callId);
    }
  }
  return unique;
}

function isCompleteCanonicalToolBatch(
  history: readonly ContextMessage[],
  exchange: Exchange,
  canonicalOwnerIndex: number,
  uniqueCallIds: ReadonlySet<string>,
): boolean {
  const count = exchange.pending.length;
  if (count === 0) return false;
  if (exchange.source.partial === true) return false;
  const expectedIds = new Set<string>();
  for (const pending of exchange.pending) {
    if (!uniqueCallIds.has(pending.callId)) return false;
    if (pending.foreignBetween || pending.result === undefined || pending.result === INTERRUPTED_RESULT) {
      return false;
    }
    expectedIds.add(pending.callId);
  }
  if (expectedIds.size !== count) return false;
  const seenIds = new Set<string>();
  for (let offset = 1; offset <= count; offset += 1) {
    const candidate = history[canonicalOwnerIndex + offset];
    if (
      candidate === undefined ||
      candidate.partial === true ||
      candidate.role !== 'tool' ||
      candidate.toolCallId === undefined ||
      !expectedIds.has(candidate.toolCallId) ||
      seenIds.has(candidate.toolCallId)
    ) {
      return false;
    }
    seenIds.add(candidate.toolCallId);
  }
  return seenIds.size === count;
}

export const TOOL_RESULT_APPENDIX_OPEN = '<tool-result-appendix>';
export const TOOL_RESULT_APPENDIX_CLOSE = '</tool-result-appendix>';

function formatToolResultAppendixPart(
  messages: readonly { readonly source: ContextMessage; readonly content: ContentPart[] }[],
): ContentPart | undefined {
  const texts: string[] = [];
  for (const message of messages) {
    const parts: string[] = [];
    for (const part of message.content) {
      if (part.type !== 'text') return undefined;
      if (part.text.trim().length > 0) {
        parts.push(part.text);
      }
    }
    if (parts.length > 0) {
      texts.push(parts.join('\n\n'));
    }
  }
  if (texts.length === 0) return undefined;
  return {
    type: 'text',
    text: `${TOOL_RESULT_APPENDIX_OPEN}\n${texts.join('\n\n')}\n${TOOL_RESULT_APPENDIX_CLOSE}`,
  };
}

function isPlainTextUserMessage(message: ContextMessage): boolean {
  return message.role === 'user' && message.partial !== true &&
    message.toolCalls.length === 0 && !hasDeclaredTools(message) &&
    message.origin?.kind !== 'compaction_summary' && message.content.every(isPlainTextPart);
}

function isPlainTextPart(part: ContentPart): boolean {
  return part.type === 'text' && part.attachment === undefined && part.resourceLink === undefined;
}

function formatToolResultTail(messages: readonly AttachedResult[]): ContentPart[] {
  const parts: ContentPart[] = [];
  let hostMessages: AttachedResult[] = [];
  const flushHost = (): void => {
    const appendix = formatToolResultAppendixPart(hostMessages);
    if (appendix !== undefined) parts.push(appendix);
    hostMessages = [];
  };
  for (const message of messages) {
    if (isHostAutoInjectedMessage(message.source)) {
      hostMessages.push(message);
    } else {
      flushHost();
      const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n\n');
      parts.push({
        type: 'text',
        text: `<tool-result-followup role="user" origin="${message.source.origin?.kind ?? 'unknown'}">\nNew conversational input received after the tool completed (not tool output):\n${text}\n</tool-result-followup>`,
      });
    }
  }
  flushHost();
  return parts;
}

function applyToolResultAppendix(
  history: readonly ContextMessage[],
  blocks: readonly Block[],
  options: ProjectOptions | undefined,
): readonly Block[] {
  if (options?.toolResultAppendix === undefined) {
    options?.onToolResultAppendix?.({ projectedBatches: 0, projectedMessages: 0 });
    return blocks;
  }
  const canonical = options.appendixHistory?.canonical ?? history;
  const sourceIndexes = options.appendixHistory?.sourceIndexes;
  const canonicalIndex = (index: number): number => sourceIndexes === undefined ? index : sourceIndexes[index]!;
  const uniqueCallIds = collectGloballyUniqueToolCallIds(canonical);
  const out: Block[] = [];
  let projectedBatches = 0;
  let projectedMessages = 0;
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index]!;
    if (
      block.kind !== 'exchange' ||
      !isCompleteCanonicalToolBatch(canonical, block.exchange, canonicalIndex(block.exchange.ownerIndex), uniqueCallIds)
    ) {
      out.push(block);
      index += 1;
      continue;
    }

    let cursor = index + 1;
    const tail: AttachedResult[] = [];
    const expectedHistoryStart = canonicalIndex(block.exchange.ownerIndex) + block.exchange.pending.length + 1;
    const hostOnly = options.toolResultAppendix === 'host_auto_injections';
    while (cursor < blocks.length) {
      const next = blocks[cursor]!;
      const candidateIndex = expectedHistoryStart + tail.length;
      const candidate = canonical[candidateIndex];
      if (
        next.kind !== 'message' || candidate === undefined ||
        canonicalIndex(next.ownerIndex) !== candidateIndex ||
        !isPlainTextUserMessage(candidate) ||
        !next.content.every(isPlainTextPart) ||
        (hostOnly && !isHostAutoInjectedMessage(next.source))
      ) {
        break;
      }
      tail.push(next);
      cursor += 1;
    }

    const appendixParts = formatToolResultTail(tail);
    if (appendixParts.length === 0) {
      out.push(block);
      index += 1;
      continue;
    }

    const lastPendingIndex = block.exchange.pending.length - 1;
    const nextPending = block.exchange.pending.map((pending, pendingIndex) => {
      if (
        pendingIndex !== lastPendingIndex ||
        pending.result === undefined ||
        pending.result === INTERRUPTED_RESULT
      ) {
        return pending;
      }
      return {
        ...pending,
        result: {
          source: pending.result.source,
          content: [...pending.result.content, ...appendixParts],
        },
      };
    });
    out.push({
      kind: 'exchange',
      exchange: {
        ...block.exchange,
        pending: nextPending,
      },
    });
    projectedBatches += 1;
    projectedMessages += tail.length;
    index = cursor;
  }

  options.onToolResultAppendix?.({ projectedBatches, projectedMessages });
  return out;
}
