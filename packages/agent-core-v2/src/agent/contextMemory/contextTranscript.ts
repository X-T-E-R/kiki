import { type ContentPart, type ToolCall } from '#/kosong/contract/message';
import type { WireRecord } from '#/wire/record';

import { COMPACTION_ELISION_VARIANT } from './compactionHandoff';
import {
  applyContextCompactionRecord,
  computeUndoCut,
  isFullyUndoable,
  readContextCompactedCount,
} from './contextOps';
import { createLoopEventFold, type LoopRecordedEvent } from './loopEventFold';
import type { ContextMessage } from './types';

export interface ContextTranscript {
  readonly entries: readonly ContextMessage[];
  readonly times: readonly (number | undefined)[];
  readonly foldedLength: number;
}

export interface ContextTranscriptReducer {
  add(record: WireRecord): void;
  result(): ContextTranscript;
}

interface MutableMessage {
  id?: string;
  role: ContextMessage['role'];
  content: ContentPart[];
  toolCalls: ToolCall[];
  toolCallId?: string;
  isError?: boolean;
  note?: string;
  origin?: ContextMessage['origin'];
  partial?: boolean;
}

interface MutableEntry {
  message: MutableMessage;
  time?: number;
}

export function reduceContextTranscript(records: Iterable<WireRecord>): ContextTranscript {
  const reducer = createContextTranscriptReducer();
  for (const record of records) reducer.add(record);
  return reducer.result();
}

export function createContextTranscriptReducer(): ContextTranscriptReducer {
  const transcript: MutableEntry[] = [];
  let logical: MutableEntry[] = [];
  let openEntry: MutableEntry | undefined;

  const push = (...entries: MutableEntry[]): void => {
    transcript.push(...entries);
    logical.push(...entries);
  };

  const sink = {
    openAssistant: (time: number | undefined) => {
      openEntry = {
        message: { role: 'assistant', content: [], toolCalls: [], partial: true },
        time,
      };
      push(openEntry);
    },
    appendOpenContent: (part: ContentPart) => {
      openEntry?.message.content.push(part);
    },
    appendOpenToolCall: (call: ToolCall) => {
      openEntry?.message.toolCalls.push(call);
    },
    dropOpenAssistant: () => {
      const entry = openEntry;
      openEntry = undefined;
      if (entry === undefined) return;
      removeEntry(transcript, entry);
      removeEntry(logical, entry);
    },
    sealOpenAssistant: () => {
      if (openEntry !== undefined) openEntry.message.partial = undefined;
      openEntry = undefined;
    },
    pushToolMessage: (message: ContextMessage, time: number | undefined) => {
      push(toMutableEntry(message, time));
    },
    pushMessage: (message: ContextMessage, time: number | undefined) => {
      push(toMutableEntry(message, time));
    },
  };
  let fold = createLoopEventFold(sink);

  const resetOpenState = (): void => {
    openEntry = undefined;
    fold = createLoopEventFold(sink);
  };

  const applyUndo = (count: number): void => {
    const messages = logical.map((entry) => entry.message);
    const cut = computeUndoCut(messages, count);
    if (!isFullyUndoable(cut, count)) return;
    const removed = new Set(logical.slice(cut.cutIndex));
    logical = logical.slice(0, cut.cutIndex);
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (removed.has(transcript[i]!)) transcript.splice(i, 1);
    }
    resetOpenState();
  };

  const applyCompaction = (record: WireRecord): void => {
    const previous = logical;
    const entriesByMessage = new Map(previous.map((entry) => [entry.message, entry]));
    const nextMessages = applyContextCompactionRecord(
      previous.map((entry) => entry.message),
      record,
    );
    const compactedCount = readContextCompactedCount(record);
    for (const entry of previous.slice(compactedCount)) {
      if (entry.message.origin?.kind === 'injection') removeEntry(transcript, entry);
    }
    const summaryEntry: MutableEntry = {
      message: {
        role: 'user',
        content: [{ type: 'text', text: readCompactionSummaryText(record) }],
        toolCalls: [],
        origin: { kind: 'compaction_summary' },
      },
      time: record.time,
    };
    logical = nextMessages.map((message) => {
      const existing = entriesByMessage.get(message as MutableMessage);
      if (existing !== undefined) return existing;
      if (message.origin?.kind === 'compaction_summary') {
        transcript.push(summaryEntry);
        return summaryEntry;
      }
      const entry = toMutableEntry(message, record.time);
      if (
        message.origin?.kind === 'injection' &&
        message.origin.variant === COMPACTION_ELISION_VARIANT
      ) {
        transcript.push(entry);
      }
      return entry;
    });
    resetOpenState();
  };

  const add = (record: WireRecord): void => {
    switch (record.type) {
      case 'context.append_message':
        fold.appendMessage(record['message'] as ContextMessage, record.time);
        break;
      case 'context.append_loop_event':
        fold.loopEvent(record['event'] as LoopRecordedEvent, record.time);
        break;
      case 'context.apply_compaction':
        applyCompaction(record);
        break;
      case 'context.undo':
        applyUndo(record['count'] as number);
        break;
      case 'context.clear':
        logical = [];
        resetOpenState();
        break;
      default:
        break;
    }
  };

  return {
    add,
    result: () => ({
      entries: transcript.map((e) => e.message),
      times: transcript.map((e) => e.time),
      foldedLength: logical.length,
    }),
  };
}

function toMutableEntry(message: ContextMessage, time: number | undefined): MutableEntry {
  return {
    message: {
      ...(message.id !== undefined ? { id: message.id } : {}),
      role: message.role,
      content: [...message.content],
      toolCalls: [...message.toolCalls],
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.isError !== undefined ? { isError: message.isError } : {}),
      ...(message.note !== undefined ? { note: message.note } : {}),
      ...(message.origin !== undefined ? { origin: message.origin } : {}),
      ...(message.partial !== undefined ? { partial: message.partial } : {}),
    },
    time,
  };
}

function removeEntry(entries: MutableEntry[], entry: MutableEntry): void {
  const index = entries.indexOf(entry);
  if (index !== -1) entries.splice(index, 1);
}

function readCompactionSummaryText(record: WireRecord): string {
  const summary = record['summary'];
  if (typeof summary === 'string') return summary;
  const contextSummary = record['contextSummary'];
  if (typeof contextSummary === 'string') return contextSummary;
  if (isContextMessageLike(summary)) return textOfParts(summary.content);
  return '';
}

function isContextMessageLike(value: unknown): value is ContextMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === 'string' && Array.isArray(message.content);
}

function textOfParts(content: readonly ContentPart[]): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}
