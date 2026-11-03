import { estimateTokens, estimateTokensForMessage, estimateTokensForMessages } from '#/kosong/contract/tokens';
import type { ContentPart } from '#/kosong/contract/message';
import { wrapSystemReminder } from '#/agent/systemReminder/systemReminder';
import summaryPrefixTemplate from './compaction-summary-prefix.md?raw';
import type { ContextMessage, PromptOrigin } from './types';

export const COMPACTION_SUMMARY_PREFIX = summaryPrefixTemplate.trimEnd();
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
export const COMPACT_USER_MESSAGE_HEAD_TOKENS = 2_000;
/** Shared budget for historical media in kept input, the handoff and the uncompacted tail. Pending user input is preserved. */
export const COMPACT_CARRIED_MEDIA_MAX_TOKENS = COMPACT_USER_MESSAGE_MAX_TOKENS;
export const COMPACTION_ELISION_VARIANT = 'compaction_elision';

type MessageLike = ContextMessage;

export interface TokenEstimate {
  readonly text: (text: string) => number;
  readonly message: (message: MessageLike) => number;
  readonly messages: (messages: readonly MessageLike[]) => number;
}

export const defaultTokenEstimate: TokenEstimate = {
  text: estimateTokens,
  message: estimateTokensForMessage,
  messages: estimateTokensForMessages,
};

export interface CompactionUserSelection<T> {
  readonly head: T[];
  readonly tail: T[];
  readonly elided: boolean;
  readonly omittedTokens: number;
}

export interface ContextCompactionShapeInput {
  readonly summary: string;
  readonly legacySummaryMessage?: ContextMessage;
  readonly contextSummary?: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter?: number;
  readonly summaryOutputTokens?: number;
  readonly requestOverheadTokens?: number;
  readonly keptUserMessageCount?: number;
  readonly keptHeadUserMessageCount?: number;
  readonly droppedCount?: number;
  readonly legacyTail?: boolean;
  readonly userBudget?: { readonly max: number; readonly head: number };
}

export interface ContextCompactionShape {
  readonly summary: string;
  readonly contextSummary: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly keptUserMessageCount: number;
  readonly keptHeadUserMessageCount?: number;
  readonly droppedCount?: number;
  readonly messages: readonly ContextMessage[];
}

/** Live compaction and replay keep media on its original messages and tool calls in history order, never on the text-only handoff. */
export function buildContextCompactionShape(
  history: readonly ContextMessage[],
  input: ContextCompactionShapeInput,
  estimate: TokenEstimate = defaultTokenEstimate,
): ContextCompactionShape {
  if (usesLegacyTailShape(input)) {
    const contextSummary = input.contextSummary ?? input.summary;
    const legacy = input.legacySummaryMessage;
    const summary = legacy?.content.some(isContinuableMediaPart)
      ? { ...legacy, content: legacy.content.filter(part => !isContinuableMediaPart(part)) }
      : legacy ?? createCompactionSummaryMessage(contextSummary);
    const messages = [summary, ...history.slice(input.compactedCount)];
    return {
      summary: input.summary,
      contextSummary,
      compactedCount: input.compactedCount,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter ?? estimate.messages(messages),
      keptUserMessageCount: 0,
      droppedCount: input.droppedCount,
      messages,
    };
  }

  const media = selectCompactionMedia(history, COMPACT_CARRIED_MEDIA_MAX_TOKENS, estimate);
  const compactedHistory = media.messages.slice(0, input.compactedCount);
  const tail = media.messages
    .slice(input.compactedCount)
    .filter((message) => message.origin?.kind !== 'injection');
  const indexedHistory = compactedHistory.map((message, compactionPosition) => ({ ...message, compactionPosition }));
  const selection = selectCompactionUserMessages(
    collectCompactableUserMessages(indexedHistory),
    input.userBudget?.max ?? COMPACT_USER_MESSAGE_MAX_TOKENS,
    input.userBudget?.head ?? COMPACT_USER_MESSAGE_HEAD_TOKENS,
    estimate.message,
  );
  const contextSummary = input.contextSummary ?? input.summary;
  const elisionMessage = selection.elided || media.omitted > 0
    ? createCompactionElisionMessage(selection.omittedTokens, media.omitted)
    : undefined;
  const keptMessages = retainCompactionSources(media.messages, input.compactedCount, selection, elisionMessage);
  const summaryMessage = createCompactionSummaryMessage(contextSummary);
  const messages = [...keptMessages, summaryMessage, ...tail];
  const tokensAfter =
    input.tokensAfter ??
    (input.requestOverheadTokens ?? 0) +
      (input.summaryOutputTokens ?? estimate.text(contextSummary)) +
      estimate.messages([...keptMessages, ...tail]);
  const keptUserMessageCount =
    input.keptUserMessageCount ?? selection.head.length + selection.tail.length;
  const keptHeadUserMessageCount =
    input.keptHeadUserMessageCount ?? (selection.elided ? selection.head.length : undefined);

  return {
    summary: input.summary,
    contextSummary,
    compactedCount: input.compactedCount,
    tokensBefore: input.tokensBefore,
    tokensAfter,
    keptUserMessageCount,
    keptHeadUserMessageCount,
    droppedCount: input.droppedCount,
    messages,
  };
}

export function buildCompactionSummaryText(summary: string): string {
  const suffix = summary.trim();
  return `${COMPACTION_SUMMARY_PREFIX}\n${suffix.length > 0 ? suffix : '(no summary available)'}`;
}

export function createCompactionSummaryMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

export function isContinuableMediaPart(part: ContentPart): boolean {
  const payload = part.type === 'image_url' ? part.imageUrl : part.type === 'audio_url' ? part.audioUrl : part.type === 'video_url' ? part.videoUrl : undefined;
  if (payload === undefined) return false;
  return (payload.url?.trim().length ?? 0) > 0 || (payload.id?.trim().length ?? 0) > 0 || (payload.attachment?.fileId?.trim().length ?? 0) > 0;
}

function retainCompactionSources(
  history: readonly ContextMessage[],
  compactedCount: number,
  selection: CompactionUserSelection<ContextMessage & { readonly compactionPosition: number }>,
  elision: ContextMessage | undefined,
): ContextMessage[] {
  const retained = new Map<number, { message: ContextMessage; startsTail: boolean }[]>();
  for (const group of [selection.head, selection.tail]) {
    for (const selected of group) {
      const { compactionPosition, ...message } = selected;
      const original = history[compactionPosition]!;
      const entries = retained.get(compactionPosition) ?? [];
      entries.push({
        message: message.content === original.content ? original : message,
        startsTail: group === selection.tail && selected === group[0],
      });
      retained.set(compactionPosition, entries);
    }
  }
  const callOwners = new Map<string, number>();
  const retainedCalls = new Map<number, Set<string>>();
  for (const [index, message] of history.entries()) {
    if (message.role === 'assistant') for (const call of message.toolCalls) callOwners.set(call.id, index);
    const media = message.content.filter(isContinuableMediaPart);
    if (media.length === 0 || message.origin?.kind === 'injection' || isCompactionSummaryMessage(message)) continue;
    if (index < compactedCount) {
      if (isRealUserInput(message)) {
        const entries = retained.get(index);
        const missing = media.filter(part => !entries?.some(entry => entry.message.content.includes(part)));
        const last = entries?.at(-1);
        if (last !== undefined && missing.length > 0) last.message = { ...last.message, content: [...last.message.content, ...missing] };
        else if (entries === undefined) retained.set(index, [{ message: { ...message, content: media }, startsTail: false }]);
      } else {
        retained.set(index, [{ message: message.role === 'assistant' ? { ...message, toolCalls: [] } : message, startsTail: false }]);
      }
    }
    if (message.role !== 'tool' || message.toolCallId === undefined) continue;
    const owner = callOwners.get(message.toolCallId);
    if (owner === undefined || owner >= compactedCount) continue;
    let calls = retainedCalls.get(owner);
    if (calls === undefined) { calls = new Set(); retainedCalls.set(owner, calls); }
    calls.add(message.toolCallId);
  }
  for (const [index, calls] of retainedCalls) {
    const assistant = history[index]!;
    const content = retained.get(index)?.[0]?.message.content ?? [];
    retained.set(index, [{ message: { ...assistant, content, toolCalls: assistant.toolCalls.filter(call => calls.has(call.id)) }, startsTail: false }]);
  }
  const completed = history.findLastIndex(message => message.role === 'assistant' && message.toolCalls.length === 0);
  if (completed >= 0 && completed < compactedCount && !retained.has(completed) && [...retained.values()].some(entries => entries.some(entry => entry.message.content.some(isContinuableMediaPart)))) {
    retained.set(completed, [{ message: { ...history[completed]!, content: [] }, startsTail: false }]);
  }
  const messages: ContextMessage[] = [];
  let elisionPending = elision;
  for (const [, entries] of [...retained].toSorted(([left], [right]) => left - right)) {
    for (const { message, startsTail } of entries) {
      if (elisionPending !== undefined && startsTail) {
        messages.push(elisionPending);
        elisionPending = undefined;
      }
      messages.push(message);
    }
  }
  if (elisionPending !== undefined) messages.push(elisionPending);
  return messages;
}

function selectCompactionMedia(
  history: readonly ContextMessage[], maxTokens: number, estimate: TokenEstimate,
): { messages: readonly ContextMessage[]; omitted: number } {
  const completed = history.findLastIndex(message => message.role === 'assistant' && message.toolCalls.length === 0);
  const callOwners = new Map<string, ContextMessage>();
  const envelopes = history.map(message => {
    if (message.role === 'assistant') for (const call of message.toolCalls) callOwners.set(call.id, message);
    if (!message.content.some(isContinuableMediaPart) || isRealUserInput(message)) return 0;
    if (message.origin?.kind === 'injection' || isCompactionSummaryMessage(message)) return undefined;
    const content = message.content.filter(part => !isContinuableMediaPart(part));
    if (message.role !== 'tool') return estimate.message({ ...message, content, toolCalls: [] });
    const owner = message.toolCallId === undefined ? undefined : callOwners.get(message.toolCallId);
    if (owner === undefined) return undefined;
    return estimate.message({ ...message, content }) + estimate.message({
      ...owner, content: [], toolCalls: owner.toolCalls.filter(call => call.id === message.toolCallId),
    });
  });
  const selected = new Map<number, Set<number>>();
  let remaining = maxTokens;
  let omitted = 0;
  for (const userInput of [true, false]) {
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index]!;
      if (isRealUserInput(message) !== userInput) continue;
      const currentInput = userInput && index > completed;
      for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
        const part = message.content[partIndex]!;
        if (!isContinuableMediaPart(part)) continue;
        const envelope = envelopes[index];
        if (envelope === undefined) { omitted++; continue; }
        const cost = mediaPartTokens(part, estimate) + (selected.has(index) ? 0 : envelope);
        if (!currentInput && cost > remaining) { omitted++; continue; }
        if (!currentInput) remaining -= cost;
        let parts = selected.get(index);
        if (parts === undefined) { parts = new Set(); selected.set(index, parts); }
        parts.add(partIndex);
      }
    }
  }
  if (omitted === 0) return { messages: history, omitted };
  return {
    messages: history.map((message, index) => {
      const content = message.content.filter((part, partIndex) => !isContinuableMediaPart(part) || selected.get(index)?.has(partIndex));
      if (content.length === message.content.length) return message;
      return { ...message, content: content.length > 0 ? content : [{ type: 'text', text: '[Earlier media is available in session history.]' }] };
    }),
    omitted,
  };
}

export function limitCarriedMedia(
  parts: readonly ContentPart[],
  maxTokens: number,
  estimate: TokenEstimate = defaultTokenEstimate,
): ContentPart[] {
  const kept: ContentPart[] = [];
  let used = 0;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!;
    const cost = mediaPartTokens(part, estimate);
    if (cost > maxTokens - used) {
      if (cost > maxTokens) continue;
      break;
    }
    kept.push(part);
    used += cost;
  }
  kept.reverse();
  return kept;
}

function mediaPartTokens(part: ContentPart, estimate: TokenEstimate): number {
  const empty = createCompactionSummaryMessage('');
  return Math.max(0, estimate.message({ ...empty, content: [...empty.content, part] }) - estimate.message(empty));
}

export function createCompactionElisionMessage(omittedTokens: number, mediaOmitted = 0): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: buildCompactionElisionText(omittedTokens, mediaOmitted) }],
    toolCalls: [],
    origin: { kind: 'injection', variant: COMPACTION_ELISION_VARIANT },
  };
}

export function buildCompactionElisionText(omittedTokens: number, mediaOmitted = 0): string {
  const notes: string[] = [];
  if (omittedTokens > 0 || mediaOmitted <= 0) {
    notes.push(
      'Some earlier user messages were omitted here during compaction. Messages above this note are the oldest retained input; messages below it are the most recent. Consult the handoff for carried context and use available history tools for any missing original wording that changes the next action. The summary is not a substitute for an omitted instruction\'s source.',
    );
  }
  if (mediaOmitted > 0) {
    notes.push(
      'Older media beyond the shared compaction limit was not reattached. Pending user input keeps its media; other user-provided media takes priority over tool media within that limit. Use history tools to retrieve other original media when needed; the files themselves are unchanged.',
    );
  }
  return wrapSystemReminder(notes.join(' '));
}

export function collectCompactableUserMessages<T extends MessageLike>(messages: readonly T[]): T[] {
  return messages.filter(
    (message) => isRealUserInput(message) && !isCompactionSummaryMessage(message),
  );
}

export function isCompactionSummaryMessage(message: MessageLike): boolean {
  return message.origin?.kind === 'compaction_summary';
}

export function isRealUserInput(message: MessageLike): boolean {
  return message.role === 'user' && compactionUserMessageDisposition(message.origin) === 'keep';
}

export function compactionUserMessageDisposition(
  origin: PromptOrigin | undefined,
): 'keep' | 'drop' {
  if (origin === undefined) return 'keep';
  switch (origin.kind) {
    case 'merged': return origin.origins.some((item) => compactionUserMessageDisposition(item) === 'keep') ? 'keep' : 'drop';
    case 'unknown':
    case 'external_thread':
    case 'user':
    case 'peer_thread':
    case 'bridged_peer':
    case 'agent_message':
      return 'keep';
    case 'system_trigger':
      return origin.name === 'thread_create' ? 'keep' : 'drop';
    case 'room_message':
      return origin.targeted ? 'keep' : 'drop';
    case 'skill_activation':
    case 'plugin_command':
      return origin.trigger === 'user-slash' ? 'keep' : 'drop';
    case 'persona_greeting':
    case 'injection':
    case 'shell_command':
    case 'compaction_summary':
    case 'task':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'external_client':
    case 'external_record':
    case 'retry':
      return 'drop';
    default: {
      const exhaustive: never = origin;
      void exhaustive;
      return 'drop';
    }
  }
}

export function selectRecentUserMessages<T extends MessageLike>(
  messages: readonly T[],
  maxTokens: number = COMPACT_USER_MESSAGE_MAX_TOKENS,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): T[] {
  const selected: T[] = [];
  let remaining = maxTokens;
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const message = messages[i]!;
    const tokens = estimateMessage(message);
    if (tokens <= remaining) {
      selected.push(message);
      remaining -= tokens;
    } else {
      selected.push(truncateUserMessage(message, remaining));
      break;
    }
  }
  selected.reverse();
  return selected;
}

export function selectCompactionUserMessages<T extends MessageLike>(
  messages: readonly T[],
  maxTokens: number = COMPACT_USER_MESSAGE_MAX_TOKENS,
  headTokens: number = COMPACT_USER_MESSAGE_HEAD_TOKENS,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): CompactionUserSelection<T> {
  let totalTokens = 0;
  for (const message of messages) {
    totalTokens += estimateMessage(message);
  }
  if (totalTokens <= maxTokens) {
    return { head: [], tail: [...messages], elided: false, omittedTokens: 0 };
  }

  const headBudget = Math.min(Math.max(headTokens, 0), maxTokens);
  const tailBudget = maxTokens - headBudget;
  const tail: T[] = [];
  let tailRemaining = tailBudget;
  let headEndExclusive = messages.length;
  let tailBoundaryDroppedPrefix: T | null = null;
  for (let i = messages.length - 1; i >= 0 && tailRemaining > 0; i--) {
    const message = messages[i]!;
    const tokens = estimateMessage(message);
    if (tokens <= tailRemaining) {
      tail.push(message);
      tailRemaining -= tokens;
      headEndExclusive = i;
      continue;
    }
    const fullText = extractText(message.content);
    const keptSuffix = truncateTextToTokensFromEnd(fullText, tailRemaining);
    tail.push(replaceMessageText(message, keptSuffix));
    headEndExclusive = i;
    const droppedPrefix = fullText.slice(0, fullText.length - keptSuffix.length);
    if (droppedPrefix.length > 0) {
      tailBoundaryDroppedPrefix = replaceMessageText(message, droppedPrefix);
    }
    break;
  }
  tail.reverse();

  const headCandidates = messages.slice(0, headEndExclusive);
  if (tailBoundaryDroppedPrefix !== null) {
    headCandidates.push(tailBoundaryDroppedPrefix);
  }
  const head: T[] = [];
  let headRemaining = headBudget;
  for (const message of headCandidates) {
    if (headRemaining <= 0) break;
    const tokens = estimateMessage(message);
    if (tokens <= headRemaining) {
      head.push(message);
      headRemaining -= tokens;
      continue;
    }
    head.push(truncateUserMessage(message, headRemaining));
    break;
  }

  let keptTokens = 0;
  for (const message of head) keptTokens += estimateMessage(message);
  for (const message of tail) keptTokens += estimateMessage(message);
  return { head, tail, elided: true, omittedTokens: Math.max(0, totalTokens - keptTokens) };
}

function usesLegacyTailShape(input: ContextCompactionShapeInput): boolean {
  return input.legacyTail === true;
}

function extractText(content: readonly ContentPart[]): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') {
      text += part.text;
    }
  }
  return text;
}

function truncateTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let asciiCount = 0;
  let nonAsciiCount = 0;
  let end = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
    if (Math.ceil(asciiCount / 4) + nonAsciiCount > maxTokens) break;
    end += char.length;
  }
  return text.slice(0, end);
}

function truncateTextToTokensFromEnd(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let asciiCount = 0;
  let nonAsciiCount = 0;
  let start = text.length;
  for (let i = text.length - 1; i >= 0; i--) {
    let isAscii = false;
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
      const high = text.charCodeAt(i - 1);
      if (high >= 0xd800 && high <= 0xdbff) {
        i--;
      }
    } else {
      isAscii = code <= 127;
    }
    if (isAscii) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
    if (Math.ceil(asciiCount / 4) + nonAsciiCount > maxTokens) break;
    start = i;
  }
  return text.slice(start);
}

function replaceMessageText<T extends MessageLike>(message: T, text: string): T {
  return {
    ...message,
    content: [{ type: 'text', text }],
    toolCalls: [],
  } as unknown as T;
}

function truncateUserMessage<T extends MessageLike>(message: T, maxTokens: number): T {
  return replaceMessageText(message, truncateTextToTokens(extractText(message.content), maxTokens));
}
