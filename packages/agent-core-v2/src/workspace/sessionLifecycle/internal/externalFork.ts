import { createHash } from 'node:crypto';

import type { WireRecord } from '#/wire/record';
import { foldAppendMessage, foldLoopEvent, type LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import type { ContextMessage } from '#/agent/contextMemory/types';

export function externalAcpForkRecords(
  records: readonly WireRecord[],
  isAcp: (executorId: string) => boolean,
  throughUserMessage: boolean,
): readonly WireRecord[] {
  const updated = records.findLast((record) => record.type === 'executor.session.updated');
  if (updated === undefined || typeof updated['executorId'] !== 'string' || !isAcp(updated['executorId'])) return records;
  const envelope = object(updated['sessionRef']);
  const ref = object(envelope?.['ref']);
  if (envelope === undefined || typeof ref?.['sessionId'] !== 'string') return records;
  let context: readonly ContextMessage[] = [];
  let remoteId: unknown;
  for (const record of records) {
    if (record.type === 'executor.session.updated') {
      const id = object(object(record['sessionRef'])?.['ref'])?.['sessionId'];
      if (id !== remoteId) { context = []; remoteId = id; }
    }
    if (record.type === 'context.append_message') context = foldAppendMessage(context, record['message'] as ContextMessage);
    if (record.type === 'context.append_loop_event') context = foldLoopEvent(context, record['event'] as LoopRecordedEvent);
  }
  const messages = context.flatMap((message) => {
    if (message.role !== 'assistant') return [];
    const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
    return text.trim().length === 0 ? [] : [{ text, id: message.providerMessageId ?? message.id ?? message.source?.stepId }];
  });
  const last = messages.at(-1);
  const fingerprint = last === undefined ? undefined : hash(last.text);
  const exact = !throughUserMessage && last !== undefined && ['claude-acp', 'claude-agent-acp', 'codex-acp', 'deepseek-acp'].includes(updated['executorId']);
  const point = exact ? {
    version: 1, messageId: typeof last.id === 'string' ? last.id : `kiki-fork-${messages.length}`,
    messageFingerprint: fingerprint,
    messageOccurrence: messages.filter((message) => hash(message.text) === fingerprint).length,
  } : undefined;
  return [...records, { ...updated, time: Date.now(), sessionRef: {
    ...envelope, ref: { sessionId: ref['sessionId'], kikiFork: { point, handoff: !exact } },
  }, profileDeliveredSessionId: undefined, lastCumulativeUsage: undefined }];
}

function hash(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
