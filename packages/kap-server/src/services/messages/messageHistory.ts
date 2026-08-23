import {
  AGENT_WIRE_RECORD_KEY,
  IAgentBlobService,
  IAgentContextMemoryService,
  IAgentScopeContext,
  IAppendLogStore,
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
} from '@moonshot-ai/agent-core-v2';

import type { Message, MessageRole } from '../../protocol/message';
import { toProtocolMessage } from './messageProjection';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

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
  const all = await loadMessages(core, sessionId);
  const desc = [...all].reverse();

  let pivotIndex = -1;
  if (query.before_id !== undefined) {
    pivotIndex = desc.findIndex((m) => m.id === query.before_id);
  } else if (query.after_id !== undefined) {
    pivotIndex = desc.findIndex((m) => m.id === query.after_id);
  }

  let slice: Message[];
  if (query.before_id !== undefined && pivotIndex >= 0) {
    slice = desc.slice(pivotIndex + 1);
  } else if (query.after_id !== undefined && pivotIndex >= 0) {
    slice = desc.slice(0, pivotIndex);
  } else {
    slice = desc;
  }

  const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
  const page = slice.slice(0, pageSize);
  const hasMore = slice.length > pageSize;

  const filtered = query.role !== undefined ? page.filter((m) => m.role === query.role) : page;

  return { items: filtered, has_more: hasMore };
}

export async function getMessage(
  core: Scope,
  sessionId: string,
  messageId: string,
): Promise<Message> {
  const all = await loadMessages(core, sessionId);
  const entry = all.find((m) => m.id === messageId);
  if (entry === undefined) {
    throw new MessageNotFoundError(sessionId, messageId);
  }
  return entry;
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

async function loadMessages(core: Scope, sessionId: string): Promise<Message[]> {
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) {
    throw new SessionNotFoundError(sessionId);
  }

  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) return [];
  const agent = await ensureMainAgent(session);

  return loadMessageHistory(core, agent, sessionId, summary.createdAt);
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
