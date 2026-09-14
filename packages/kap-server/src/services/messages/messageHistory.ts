import {
  AGENT_WIRE_RECORD_KEY,
  IAgentBlobService,
  IAgentContextMemoryService,
  IAgentScopeContext,
  IAppendLogStore,
  IFileSystemStorageService,
  ISessionIndex,
  IWireService,
  createContextTranscriptReducer,
  ensureMainAgent,
  resumeSessionById,
  type ContextMessage,
  type ContextTranscript,
  type IAgentScopeHandle,
  type Scope,
  type WireRecord,
} from '@kiki/agent-core-v2';

import type { Message, MessageRole } from '../../protocol/message';
import { toProtocolMessage } from './messageProjection';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MESSAGE_HISTORY_CACHE_CAPACITY = 128;

interface MessageHistoryCacheEntry {
  readonly messages: ContextMessage[];
  readonly createdAtMs: number[];
  readonly explicitIndexes: Map<string, number>;
  readonly observedContext: ContextMessage[];
  readonly scope: string;
  offset: number;
}

const messageHistoryCaches = new WeakMap<Scope, Map<string, MessageHistoryCacheEntry>>();
const messageHistoryRefreshes = new WeakMap<Scope, Map<string, Promise<MessageHistoryCacheEntry>>>();

/** Sentinel — the route maps it to 40401. */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

/** Sentinel — the route maps it to 40403. */
export class MessageNotFoundError extends Error {
  readonly sessionId: string;
  readonly messageId: string;
  constructor(sessionId: string, messageId: string) {
    super(`message ${messageId} does not exist in session ${sessionId}`);
    this.name = 'MessageNotFoundError';
    this.sessionId = sessionId;
    this.messageId = messageId;
  }
}

export interface MessageListQuery {
  readonly before_id?: string | undefined;
  readonly after_id?: string | undefined;
  readonly page_size?: number | undefined;
  readonly role?: MessageRole | undefined;
}

export interface PageResponse<T> {
  items: T[];
  has_more: boolean;
}

export interface MessageHistoryEntry {
  readonly index: number;
  readonly contextMessage: ContextMessage;
  readonly message: Message;
}

export async function listMessages(
  core: Scope,
  sessionId: string,
  query: MessageListQuery,
): Promise<PageResponse<Message>> {
  const history = await loadActiveMessageHistory(core, sessionId);
  const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
  const pivotId = query.before_id ?? query.after_id;
  const pivotIndex = pivotId === undefined
    ? undefined
    : resolveMessageIndex(sessionId, history.messages, history.explicitIndexes, pivotId);
  const high = query.before_id !== undefined && pivotIndex !== undefined
    ? pivotIndex - 1
    : history.messages.length - 1;
  const low = query.after_id !== undefined && pivotIndex !== undefined ? pivotIndex + 1 : 0;
  const selected: Array<{ readonly index: number; readonly message: ContextMessage }> = [];
  for (let index = high; index >= low && selected.length <= pageSize; index -= 1) {
    const message = history.messages[index];
    if (message !== undefined) selected.push({ index, message });
  }
  const hasMore = selected.length > pageSize;
  const page = selected.slice(0, pageSize);
  const hydrated = await rehydrate(history.agent, page.map((entry) => entry.message));
  const projected = hydrated.map((message, pageIndex) => {
    const index = page[pageIndex]!.index;
    return toProtocolMessage(sessionId, index, message, history.createdAt, history.createdAtMs[index]);
  });
  const filtered = query.role !== undefined
    ? projected.filter((message) => message.role === query.role)
    : projected;
  return { items: filtered, has_more: hasMore };
}

export async function getMessage(
  core: Scope,
  sessionId: string,
  messageId: string,
): Promise<Message> {
  const history = await loadActiveMessageHistory(core, sessionId);
  const index = resolveMessageIndex(
    sessionId,
    history.messages,
    history.explicitIndexes,
    messageId,
  );
  if (index === undefined) throw new MessageNotFoundError(sessionId, messageId);
  const contextMessage = history.messages[index];
  if (contextMessage === undefined) throw new MessageNotFoundError(sessionId, messageId);
  const [hydrated] = await rehydrate(history.agent, [contextMessage]);
  return toProtocolMessage(
    sessionId,
    index,
    hydrated!,
    history.createdAt,
    history.createdAtMs[index],
  );
}

export async function loadMessageHistoryEntries(
  core: Scope,
  sessionId: string,
): Promise<readonly MessageHistoryEntry[]> {
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) throw new SessionNotFoundError(sessionId);
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) return [];
  const agent = await ensureMainAgent(session);
  const transcript = await readTranscript(core, agent);
  const merged = mergeLiveTail(
    transcript,
    agent.accessor.get(IAgentContextMemoryService).get(),
  );
  let previousMs = Number.NEGATIVE_INFINITY;
  return merged.messages.map((contextMessage, index) => {
    const baseMs = merged.times[index] ?? summary.createdAt + index;
    const createdAtMs = Math.max(previousMs + 1, baseMs);
    previousMs = createdAtMs;
    return {
      index,
      contextMessage,
      message: toProtocolMessage(sessionId, index, contextMessage, summary.createdAt, createdAtMs),
    };
  });
}

async function loadActiveMessageHistory(
  core: Scope,
  sessionId: string,
): Promise<{
  readonly agent: IAgentScopeHandle;
  readonly createdAt: number;
  readonly messages: readonly ContextMessage[];
  readonly createdAtMs: readonly number[];
  readonly explicitIndexes: ReadonlyMap<string, number>;
}> {
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) throw new SessionNotFoundError(sessionId);
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) throw new SessionNotFoundError(sessionId);
  const agent = await ensureMainAgent(session);
  const entry = await refreshMessageHistoryCache(core, agent, sessionId, summary.createdAt);
  return {
    agent,
    createdAt: summary.createdAt,
    messages: entry.messages,
    createdAtMs: entry.createdAtMs,
    explicitIndexes: entry.explicitIndexes,
  };
}

async function refreshMessageHistoryCache(
  core: Scope,
  agent: IAgentScopeHandle,
  sessionId: string,
  sessionCreatedAtMs: number,
): Promise<MessageHistoryCacheEntry> {
  let refreshes = messageHistoryRefreshes.get(core);
  if (refreshes === undefined) {
    refreshes = new Map();
    messageHistoryRefreshes.set(core, refreshes);
  }
  const pending = refreshes.get(sessionId);
  if (pending !== undefined) return pending;
  const refresh = refreshMessageHistoryCacheNow(
    core,
    agent,
    sessionId,
    sessionCreatedAtMs,
  ).finally(() => {
    if (refreshes.get(sessionId) === refresh) refreshes.delete(sessionId);
  });
  refreshes.set(sessionId, refresh);
  return refresh;
}

async function refreshMessageHistoryCacheNow(
  core: Scope,
  agent: IAgentScopeHandle,
  sessionId: string,
  sessionCreatedAtMs: number,
): Promise<MessageHistoryCacheEntry> {
  let cache = messageHistoryCaches.get(core);
  if (cache === undefined) {
    cache = new Map();
    messageHistoryCaches.set(core, cache);
  }
  const contextMessages = agent.accessor.get(IAgentContextMemoryService).get();
  const existing = cache.get(sessionId);
  let entry: MessageHistoryCacheEntry;
  if (existing === undefined) {
    entry = await rebuildMessageHistoryCache(core, agent, contextMessages, sessionCreatedAtMs);
  } else {
    const tail = await readDurableWireTail(core, agent, existing);
    const additions = Math.max(0, contextMessages.length - existing.observedContext.length);
    const compatible =
      contextTailCompatible(existing.observedContext, contextMessages) &&
      tail.creationTimes.length >= additions;
    if (tail.rewritten || !compatible) {
      entry = await rebuildMessageHistoryCache(core, agent, contextMessages, sessionCreatedAtMs);
    } else {
      applyContextTail(existing, contextMessages, tail.creationTimes, sessionCreatedAtMs);
      existing.offset = tail.offset;
      entry = existing;
    }
  }
  cache.delete(sessionId);
  cache.set(sessionId, entry);
  while (cache.size > MESSAGE_HISTORY_CACHE_CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return entry;
}

async function rebuildMessageHistoryCache(
  core: Scope,
  agent: IAgentScopeHandle,
  contextMessages: readonly ContextMessage[],
  sessionCreatedAtMs: number,
): Promise<MessageHistoryCacheEntry> {
  await agent.accessor.get(IWireService).flush();
  const scope = agent.accessor.get(IAgentScopeContext).scope();
  const offset = await core.accessor
    .get(IFileSystemStorageService)
    .size(scope, AGENT_WIRE_RECORD_KEY) ?? 0;
  const transcript = await readTranscript(core, agent);
  const merged = mergeLiveTail(transcript, contextMessages);
  const messages = [...merged.messages];
  return {
    messages,
    createdAtMs: buildCreatedAtMs(merged.times, messages.length, sessionCreatedAtMs),
    explicitIndexes: buildExplicitIndexes(messages),
    observedContext: [...contextMessages],
    scope,
    offset,
  };
}

async function readDurableWireTail(
  core: Scope,
  agent: IAgentScopeHandle,
  entry: MessageHistoryCacheEntry,
): Promise<{ readonly offset: number; readonly creationTimes: number[]; readonly rewritten: boolean }> {
  await agent.accessor.get(IWireService).flush();
  const storage = core.accessor.get(IFileSystemStorageService);
  const size = await storage.size(entry.scope, AGENT_WIRE_RECORD_KEY) ?? 0;
  if (size < entry.offset) return { offset: size, creationTimes: [], rewritten: true };
  if (size === entry.offset) return { offset: size, creationTimes: [], rewritten: false };
  let pending = '';
  const records: WireRecord[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of storage.readStream(
    entry.scope,
    AGENT_WIRE_RECORD_KEY,
    { start: entry.offset, end: size - 1 },
  )) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (line.length > 0) records.push(JSON.parse(line) as WireRecord);
      newline = pending.indexOf('\n');
    }
  }
  pending += decoder.decode();
  if (pending.trim().length > 0) return { offset: entry.offset, creationTimes: [], rewritten: true };
  const creationTimes: number[] = [];
  let rewritten = false;
  for (const record of records) {
    if (
      record.type === 'context.undo' ||
      record.type === 'context.clear' ||
      record.type === 'context.apply_compaction'
    ) {
      rewritten = true;
    }
    if (record.type === 'context.append_message' && typeof record.time === 'number') {
      creationTimes.push(record.time);
    }
    if (record.type === 'context.append_loop_event') {
      const event = record['event'] as { readonly type?: string } | undefined;
      if (
        (event?.type === 'step.begin' || event?.type === 'tool.result') &&
        typeof record.time === 'number'
      ) {
        creationTimes.push(record.time);
      }
    }
  }
  return { offset: size, creationTimes, rewritten };
}

function contextTailCompatible(
  previous: readonly ContextMessage[],
  current: readonly ContextMessage[],
): boolean {
  if (current.length < previous.length) return false;
  const stableLength = Math.max(0, previous.length - 1);
  for (let index = 0; index < stableLength; index += 1) {
    if (previous[index] !== current[index]) return false;
  }
  if (previous.length === 0) return true;
  const oldTail = previous.at(-1)!;
  const currentAtTail = current[previous.length - 1];
  return oldTail === currentAtTail ||
    (currentAtTail !== undefined && sameMutableTailMessage(oldTail, currentAtTail));
}

function sameMutableTailMessage(left: ContextMessage, right: ContextMessage): boolean {
  return left.role === 'assistant' && right.role === 'assistant' && left.id === right.id;
}

function applyContextTail(
  entry: MessageHistoryCacheEntry,
  current: readonly ContextMessage[],
  creationTimes: readonly number[],
  sessionCreatedAtMs: number,
): void {
  const observedLength = entry.observedContext.length;
  if (observedLength > 0 && current[observedLength - 1] !== entry.observedContext.at(-1)) {
    const projectedIndex = entry.messages.length - 1;
    if (projectedIndex >= 0) entry.messages[projectedIndex] = current[observedLength - 1]!;
  }
  const additions = current.slice(observedLength);
  const relevantTimes = creationTimes.slice(-additions.length);
  for (let addition = 0; addition < additions.length; addition += 1) {
    const message = additions[addition]!;
    const index = entry.messages.length;
    entry.messages.push(message);
    const base = relevantTimes[addition]!;
    entry.createdAtMs.push(
      Math.max((entry.createdAtMs.at(-1) ?? Number.NEGATIVE_INFINITY) + 1, base, sessionCreatedAtMs + index),
    );
    if (message.id !== undefined && !entry.explicitIndexes.has(message.id)) {
      entry.explicitIndexes.set(message.id, index);
    }
  }
  entry.observedContext.splice(0, entry.observedContext.length, ...current);
}

function buildCreatedAtMs(
  times: readonly (number | undefined)[],
  length: number,
  sessionCreatedAtMs: number,
): number[] {
  const result: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < length; index += 1) {
    const value = Math.max(previous + 1, times[index] ?? sessionCreatedAtMs + index);
    result.push(value);
    previous = value;
  }
  return result;
}

function buildExplicitIndexes(messages: readonly ContextMessage[]): Map<string, number> {
  const indexes = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const id = messages[index]?.id;
    if (id !== undefined && !indexes.has(id)) indexes.set(id, index);
  }
  return indexes;
}

function resolveMessageIndex(
  sessionId: string,
  messages: readonly ContextMessage[],
  explicitIndexes: ReadonlyMap<string, number>,
  messageId: string,
): number | undefined {
  const generatedPrefix = `msg_${sessionId}_`;
  if (messageId.startsWith(generatedPrefix)) {
    const suffix = messageId.slice(generatedPrefix.length);
    if (/^\d+$/.test(suffix)) {
      const index = Number(suffix);
      if (
        messageId === `${generatedPrefix}${String(index).padStart(6, '0')}` &&
        messages[index]?.id === undefined
      ) {
        return index;
      }
    }
  }
  return explicitIndexes.get(messageId);
}

/**
 * One agent's full, ascending, projected message history: the persisted
 * journal (flushed first) folded by the transcript reducer, the unflushed
 * live tail merged in, blob references rehydrated, and timestamps clamped
 * strictly increasing. Shared by the `messages` routes and the `snapshot`
 * route so all history-serving surfaces agree.
 */
export interface CapturedContextMessageHistory {
  readonly messages: readonly ContextMessage[];
  readonly times: readonly (number | undefined)[];
}

export async function captureContextMessageHistory(
  core: Scope,
  agent: IAgentScopeHandle,
  contextMessages: readonly ContextMessage[],
): Promise<CapturedContextMessageHistory> {
  const transcript = await readTranscript(core, agent);
  return alignFrozenContextHistory(transcript, contextMessages);
}

export async function loadMessageHistory(
  core: Scope,
  agent: IAgentScopeHandle,
  sessionId: string,
  sessionCreatedAtMs: number,
): Promise<Message[]> {
  const transcript = await readTranscript(core, agent);
  const merged = mergeLiveTail(
    transcript,
    agent.accessor.get(IAgentContextMemoryService).get(),
  );
  return projectMessageHistory(
    agent,
    sessionId,
    sessionCreatedAtMs,
    merged.messages,
    merged.times,
  );
}

export async function loadCapturedMessageHistory(
  agent: IAgentScopeHandle,
  sessionId: string,
  sessionCreatedAtMs: number,
  contextMessages: readonly ContextMessage[],
  contextMessageTimes: readonly (number | undefined)[],
): Promise<Message[]> {
  return projectMessageHistory(
    agent,
    sessionId,
    sessionCreatedAtMs,
    contextMessages,
    contextMessageTimes,
  );
}

async function projectMessageHistory(
  agent: IAgentScopeHandle,
  sessionId: string,
  sessionCreatedAtMs: number,
  contextMessages: readonly ContextMessage[],
  contextMessageTimes: readonly (number | undefined)[],
): Promise<Message[]> {
  const entries = await rehydrate(agent, contextMessages);
  let previousMs = Number.NEGATIVE_INFINITY;
  return entries.map((message, index) => {
    const baseMs = contextMessageTimes[index] ?? sessionCreatedAtMs + index;
    const createdAtMs = Math.max(previousMs + 1, baseMs);
    previousMs = createdAtMs;
    return toProtocolMessage(sessionId, index, message, sessionCreatedAtMs, createdAtMs);
  });
}

async function rehydrate(
  agent: IAgentScopeHandle,
  messages: readonly ContextMessage[],
): Promise<readonly ContextMessage[]> {
  const blobs = agent.accessor.get(IAgentBlobService);
  let changed = false;
  const out: ContextMessage[] = [];
  for (const msg of messages) {
    const content = await blobs.loadParts(msg.content);
    if (content === msg.content) {
      out.push(msg);
      continue;
    }
    changed = true;
    out.push({ ...msg, content: [...content] });
  }
  return changed ? out : messages;
}

async function readTranscript(core: Scope, agent: IAgentScopeHandle): Promise<ContextTranscript> {
  await agent.accessor.get(IWireService).flush();
  const scope = agent.accessor.get(IAgentScopeContext).scope();
  const reducer = createContextTranscriptReducer();
  for await (const record of core.accessor
    .get(IAppendLogStore)
    .read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
    reducer.add(record);
  }
  return reducer.result();
}

function alignFrozenContextHistory(
  transcript: ContextTranscript,
  contextMessages: readonly ContextMessage[],
): CapturedContextMessageHistory {
  const candidates = new Map<
    string,
    { readonly time: number | undefined; unique: boolean }
  >();
  for (let index = 0; index < transcript.entries.length; index++) {
    const identity = contextMessageIdentity(transcript.entries[index]!);
    if (identity === undefined) continue;
    const existing = candidates.get(identity);
    if (existing === undefined) {
      candidates.set(identity, { time: transcript.times[index], unique: true });
    } else {
      existing.unique = false;
    }
  }
  const directPrefix =
    transcript.entries.length === transcript.foldedLength &&
    contextMessages.length <= transcript.foldedLength;
  const times = contextMessages.map((message, index) => {
    const identity = contextMessageIdentity(message);
    if (identity !== undefined) {
      const candidate = candidates.get(identity);
      return candidate?.unique === true ? candidate.time : undefined;
    }
    const transcriptMessage = transcript.entries[index];
    if (
      directPrefix &&
      transcriptMessage !== undefined &&
      contextMessageIdentity(transcriptMessage) === undefined &&
      transcriptMessage.role === message.role
    ) {
      return transcript.times[index];
    }
    return undefined;
  });
  return { messages: contextMessages, times };
}

function contextMessageIdentity(message: ContextMessage): string | undefined {
  if (message.id !== undefined) return `message:${message.id}`;
  if (message.role === 'tool' && message.toolCallId !== undefined) {
    return `tool:${message.toolCallId}`;
  }
  return undefined;
}

function mergeLiveTail(
  transcript: ContextTranscript,
  contextMessages: readonly ContextMessage[],
): {
  readonly messages: readonly ContextMessage[];
  readonly times: readonly (number | undefined)[];
} {
  if (contextMessages.length <= transcript.foldedLength) {
    return { messages: transcript.entries, times: transcript.times };
  }
  const tail = contextMessages.slice(transcript.foldedLength);
  return {
    messages: [...transcript.entries, ...tail],
    times: [...transcript.times, ...tail.map(() => undefined)],
  };
}
