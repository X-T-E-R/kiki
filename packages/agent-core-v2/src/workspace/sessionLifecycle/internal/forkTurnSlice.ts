import { Error2, ErrorCodes } from '#/errors';
import type { ContentPart } from '#/kosong/contract/message';
import {
  promptMetadataTextFromContentParts,
  promptMetadataTextFromText,
} from '#/agent/prompt/promptMetadataText';
import type { WireRecord } from '#/wire/record';
import { contextTranscriptMessageId, createContextTranscriptReducer } from '#/agent/contextMemory/contextTranscript';
import { isUndoAnchorOrigin } from '#/agent/contextMemory/conversationTime';
import type { ContextMessage } from '#/agent/contextMemory/types';

export interface MainTurnSlice {
  readonly records: readonly WireRecord[];
  readonly cutoffTime?: number;
  readonly lastPrompt?: string;
}

export function assertForkTurnIndex(turnIndex: number | undefined): void {
  if (turnIndex === undefined) return;
  if (Number.isSafeInteger(turnIndex) && turnIndex >= 0) return;
  throw new Error2(
    ErrorCodes.REQUEST_INVALID,
    'forkSession turnIndex must be a non-negative safe integer',
    { details: { turnIndex } },
  );
}

export function sliceMainRecordsAtTurn(
  records: readonly WireRecord[],
  sourceSessionId: string,
  turnIndex: number,
  throughUserMessage = false,
  throughMessageId?: string,
): MainTurnSlice {
  const reducer = createContextTranscriptReducer();
  for (let index = 0; index < records.length; index += 1) {
    reducer.add({ ...records[index]!, time: index });
  }
  const transcript = reducer.result();
  const turnStarts = transcript.entries.flatMap((message, index) =>
    isUserVisibleTurnRecord({ type: 'context.append_message', message }) ? [transcript.times[index]!] : []);

  const start = turnStarts[turnIndex];
  if (start === undefined) {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      `Turn ${String(turnIndex)} was not found in session "${sourceSessionId}"`,
      { details: { turnIndex, availableTurns: turnStarts.length } },
    );
  }

  const next = records.findIndex((record, index) => index > start && isUserVisibleTurnRecord(turnRecord(record)));
  let end = throughUserMessage ? start + 1 : next === -1 ? records.length : next;
  if (!throughUserMessage) {
    let lastOutput = start;
    for (let index = 0; index < transcript.entries.length; index += 1) {
      const source = transcript.times[index]!;
      const role = transcript.entries[index]!.role;
      if (source >= start && source < end && (role === 'assistant' || role === 'tool')) lastOutput = Math.max(lastOutput, source);
    }
    const reset = records.findIndex((record, index) => index > lastOutput && index < end && (
      record.type === 'context.clear' || record.type === 'context.apply_compaction' ||
      record.type === 'context.undo' || (record.type === 'agent.model_switch' && Array.isArray(record['context']))
    ));
    if (reset !== -1) end = reset;
  }
  if (throughMessageId !== undefined) {
    const index = transcript.entries.findLastIndex((message, index) =>
      contextTranscriptMessageId(sourceSessionId, index, message) === throughMessageId ||
      message.role === 'assistant' && message.source?.stepId === throughMessageId,
    );
    const ordinal = transcript.times[index];
    const message = transcript.entries[index];
    if (ordinal === undefined || message === undefined || (throughUserMessage
      ? ordinal !== start || message.role !== 'user'
      : ordinal < start || ordinal >= end || message.role !== 'assistant' || message.partial === true)) {
      throw new Error2(ErrorCodes.MESSAGE_ACTION_UNAVAILABLE, 'The selected fork boundary is unavailable', {
        details: { reason: 'unsupported_message_boundary', target_message_id: throughMessageId },
      });
    }
    if (!throughUserMessage) {
      const turnId = message.source?.turnId;
      if (turnId !== undefined) {
        const terminal = records.findIndex((record, index) => index >= ordinal && index < end &&
          record.type === 'turn.ended' && record['turnId'] === turnId);
        if (terminal !== -1) end = terminal + 1;
      } else if (records[ordinal]?.type === 'context.append_message') {
        end = ordinal + 1;
      }
    }
  }
  const retainedTurnInputs = retainedTurnInputIndices(records, end);
  const retained = records
    .slice(0, end)
    .filter(
      (record, index) => !isUserVisibleTurnInputRecord(record) || retainedTurnInputs.has(index),
    );
  const cutoffTimes = retained
    .map(recordTime)
    .filter((time): time is number => time !== undefined);
  const lastPrompt = promptMetadataFromTurnRecord(turnRecord(records[start]!));
  return {
    records: retained,
    cutoffTime: cutoffTimes.length === 0 ? undefined : Math.max(...cutoffTimes),
    lastPrompt,
  };
}

/** Counts visible user turns in canonical main wire records. */
export function countVisibleUserTurns(records: readonly WireRecord[]): number {
  const reducer = createContextTranscriptReducer();
  for (let index = 0; index < records.length; index += 1) {
    reducer.add({ ...records[index]!, time: index });
  }
  const transcript = reducer.result();
  let count = 0;
  for (const message of transcript.entries) {
    if (isUserVisibleTurnRecord({ type: 'context.append_message', message })) count += 1;
  }
  return count;
}

export function sliceSubagentRecordsAtTime(
  records: readonly WireRecord[],
  cutoffTime: number | undefined,
): readonly WireRecord[] {
  if (cutoffTime === undefined) return [];
  let end = records.length;
  for (let index = 0; index < records.length; index += 1) {
    const time = recordTime(records[index]!);
    if (time !== undefined && time > cutoffTime) {
      end = index;
      break;
    }
  }
  return records.slice(0, end);
}

function turnRecord(record: WireRecord): WireRecord {
  if (record.type !== 'context.undo') return record;
  const prompt = asRecord(record['replacementPrompt']);
  return { type: 'context.append_message', message: prompt?.['message'] };
}

function isUserVisibleTurnOrigin(origin: unknown): boolean {
  const record = asRecord(origin);
  if (record?.['kind'] === 'shell_command') return record['phase'] === 'input';
  return isUndoAnchorOrigin(record as ContextMessage['origin']);
}

function isUserVisibleTurnRecord(record: WireRecord): boolean {
  if (record.type !== 'context.append_message') return false;
  const message = asRecord(record['message']);
  if (message === undefined || message['role'] !== 'user' || message['inheritedSeed'] === true) return false;
  return isUserVisibleTurnOrigin(message['origin']);
}

function isUserVisibleTurnInputRecord(record: WireRecord): boolean {
  if (record.type !== 'turn.prompt' && record.type !== 'turn.steer') return false;
  const origin = asRecord(record['origin']);
  if (origin === undefined) return false;
  return isUserVisibleTurnOrigin(origin);
}

function retainedTurnInputIndices(
  records: readonly WireRecord[],
  end: number,
): ReadonlySet<number> {
  const pending: number[] = [];
  const retained = new Set<number>();
  const replacements = new Set<string>();
  for (let index = 0; index < end; index += 1) {
    const record = records[index]!;
    if (record.type === 'context.undo') {
      const promptId = asRecord(record['replacementPrompt'])?.['promptId'];
      if (typeof promptId === 'string') replacements.add(promptId);
    }
    if (isUserVisibleTurnInputRecord(record)) {
      const promptId = record['promptId'];
      if (typeof promptId === 'string' && replacements.has(promptId)) retained.add(index);
      else pending.push(index);
      continue;
    }
    if (!isUserVisibleTurnRecord(record)) continue;

    const matchAt = findMatchingTurnInput(records, pending, record);
    if (matchAt !== -1) retained.add(pending.splice(matchAt, 1)[0]!);
  }
  return retained;
}

function findMatchingTurnInput(
  records: readonly WireRecord[],
  pending: readonly number[],
  turnRecord: WireRecord,
): number {
  const exact = pending.findIndex((index) =>
    turnInputMatchesRecord(records[index]!, turnRecord, true),
  );
  if (exact !== -1) return exact;
  return pending.findIndex((index) => turnInputMatchesRecord(records[index]!, turnRecord, false));
}

function turnInputMatchesRecord(
  inputRecord: WireRecord,
  turnRecord: WireRecord,
  compareContent: boolean,
): boolean {
  if (inputRecord.type !== 'turn.prompt' && inputRecord.type !== 'turn.steer') return false;
  if (turnRecord.type !== 'context.append_message') return false;
  const message = asRecord(turnRecord['message']);
  if (message === undefined || message['role'] !== 'user') return false;
  const inputKind = asRecord(inputRecord['origin'])?.['kind'];
  if (typeof inputKind !== 'string') return false;
  const messageKind = asRecord(message['origin'])?.['kind'];
  if (messageKind !== undefined && typeof messageKind !== 'string') return false;
  if (!sameTurnOrigin(inputKind, messageKind)) return false;
  return (
    !compareContent ||
    JSON.stringify(inputRecord['input']) === JSON.stringify(message['content'])
  );
}

function sameTurnOrigin(inputKind: string, messageKind: string | undefined): boolean {
  if (inputKind === 'user') return messageKind === undefined || messageKind === 'user';
  return inputKind === messageKind;
}

function recordTime(record: WireRecord): number | undefined {
  if (typeof record.time === 'number' && Number.isFinite(record.time)) return record.time;
  if (record.type === 'metadata') {
    const createdAt = record['created_at'];
    if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return createdAt;
  }
  return undefined;
}

function promptMetadataFromTurnRecord(record: WireRecord): string | undefined {
  if (record.type !== 'context.append_message') return undefined;
  const message = asRecord(record['message']);
  if (message === undefined || message['role'] !== 'user') return undefined;
  const origin = asRecord(message['origin']);
  if (origin?.['kind'] === 'skill_activation') {
    const name = origin['skillName'];
    if (typeof name !== 'string') return undefined;
    return promptMetadataTextFromText(slashCommandText(`/${name}`, origin['skillArgs']));
  }
  if (origin?.['kind'] === 'plugin_command') {
    const pluginId = origin['pluginId'];
    const commandName = origin['commandName'];
    if (typeof pluginId !== 'string' || typeof commandName !== 'string') return undefined;
    return promptMetadataTextFromText(
      slashCommandText(`/${pluginId}:${commandName}`, origin['commandArgs']),
    );
  }
  const content = message['content'];
  if (!Array.isArray(content)) return undefined;
  const activations = origin?.['skillActivations'];
  const bundled = origin?.['kind'] === 'user' && Array.isArray(activations) ? activations.length : 0;
  return promptMetadataTextFromContentParts(
    (bundled === 0 ? content : content.slice(bundled)) as readonly ContentPart[],
  );
}

function slashCommandText(command: string, args: unknown): string {
  const trimmed = typeof args === 'string' ? args.trim() : undefined;
  return trimmed === undefined || trimmed.length === 0 ? command : `${command} ${trimmed}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
