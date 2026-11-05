import { z } from 'zod';
import { sliceUtf16 } from '#/_base/text/utf16';
import type { ToolCall } from '#/kosong/contract/message';
import type { ContextMessage, ContextMessageSource } from './types';

const sourceSchema = z.object({ stepId: z.string().optional(), turnId: z.number().int().nonnegative().optional(),
  step: z.number().int().nonnegative().optional(), ref: z.string().optional() });
const rangeSchema = z.tuple([z.number().int().positive(), z.number().int().positive()]);
export const fileReadLedgerSchema = z.object({
  entries: z.array(z.object({
    path: z.string(), host: z.string().optional(), ranges: z.array(rangeSchema), staleRanges: z.array(rangeSchema),
    totalLines: z.number().int().nonnegative().optional(), minimumTotalLines: z.number().int().nonnegative().optional(),
    chars: z.number().int().nonnegative(), source: sourceSchema.optional(),
    edited: z.object({ source: sourceSchema.optional(), readSource: sourceSchema.optional() }).optional(),
  })),
  omitted: z.number().int().nonnegative(),
});
export type FileReadLedger = z.infer<typeof fileReadLedgerSchema>;
type FileReadEntry = FileReadLedger['entries'][number];
type LineRange = [number, number];

export function fileReadLedgerBudget(threshold: number): number {
  return Math.max(1_000, Math.min(3_000, Math.round(threshold * 0.01)));
}

function textOf(message: ContextMessage): string {
  return message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
}

function argumentsOf(call: ToolCall): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(call.arguments ?? 'null');
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function targetOf(call: ToolCall): { path: string; host?: string } | undefined {
  const args = argumentsOf(call);
  return typeof args?.['path'] === 'string' && args['path'].trim() ? {
    path: args['path'], host: typeof args['host'] === 'string' && args['host'] !== 'local' ? args['host'] : undefined,
  } : undefined;
}

function keyOf(target: { path: string; host?: string }): string {
  let path = target.path.replaceAll('\\', '/');
  if (/^[a-z]:\//i.test(path)) path = path.toLowerCase();
  return JSON.stringify([target.host ?? 'local', path]);
}

function sourceOf(message: ContextMessage, call: ToolCall, result: ContextMessage): ContextMessageSource | undefined {
  const source = result.toolCallSources?.[call.id] ?? result.source ?? message.toolCallSources?.[call.id] ?? message.source;
  return source === undefined ? undefined : { stepId: source.stepId, turnId: source.turnId, step: source.step, ref: source.ref };
}

function successful(result: ContextMessage | undefined): result is ContextMessage {
  return result !== undefined && !result.isError && !textOf(result).startsWith('<system>ERROR:');
}

function readEntry(call: ToolCall, result: ContextMessage, source?: ContextMessageSource): FileReadEntry | undefined {
  const target = targetOf(call);
  if (target === undefined) return undefined;
  const text = textOf(result);
  const note = /\n?<system>((?:\d+ lines? read starting at line \d+\.|No lines read\.)[^\r\n]*)<\/system>\s*$/.exec(text);
  const body = note === null ? text : text.slice(0, note.index);
  const count = note === null ? undefined : /^(\d+) lines? read starting at line (\d+)\./.exec(note[1]!);
  const lines = body.length === 0 ? [] : body.split('\n');
  const start = count === null || count === undefined ? undefined : Number(count[2]);
  const length = count === null || count === undefined ? 0 : Number(count[1]);
  const ranges: LineRange[] = start !== undefined && Number.isSafeInteger(start) && start > 0 &&
    Number.isSafeInteger(length) && length > 0 && lines.length === length &&
    lines.every((line, index) => line.startsWith(`${start + index}\t`)) ? [[start, start + length - 1]] : [];
  const total = note === null ? undefined : /Total lines in file: (at least )?(\d+)\./.exec(note[1]!);
  const totalLines = total ? Number(total[2]) : undefined;
  return { ...target, ranges, staleRanges: [],
    totalLines: total?.[1] === undefined && Number.isSafeInteger(totalLines) ? totalLines : undefined,
    minimumTotalLines: total?.[1] !== undefined && Number.isSafeInteger(totalLines) ? totalLines : undefined,
    chars: body.length, source, edited: undefined };
}

function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const merged: LineRange[] = [];
  for (const [start, end] of ranges.toSorted((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function collectFileReads(history: readonly ContextMessage[], compactCount = history.length): FileReadLedger {
  const files = new Map<string, FileReadEntry>();
  const calls = new Map<string, { call: ToolCall; message: ContextMessage }>();
  let omitted = 0;
  for (const [index, message] of history.entries()) {
    if (index < compactCount && message.origin?.kind === 'compaction_summary' && message.origin.fileReads !== undefined) {
      omitted = Math.max(omitted, message.origin.fileReads.omitted);
      for (const entry of message.origin.fileReads.entries.toReversed()) {
        const key = keyOf(entry);
        files.delete(key);
        files.set(key, entry);
      }
    }
    if (message.role === 'assistant') for (const call of message.toolCalls) calls.set(call.id, { call, message });
    const owner = message.role === 'tool' && message.toolCallId !== undefined ? calls.get(message.toolCallId) : undefined;
    if (owner === undefined || !successful(message)) continue;
    const { call } = owner;
    const source = sourceOf(owner.message, call, message);
    const target = targetOf(call);
    if (target === undefined) continue;
    const key = keyOf(target);
    const previous = files.get(key);
    if (call.name === 'Read' && index < compactCount) {
      const entry = readEntry(call, message, source)!;
      files.delete(key);
      files.set(key, { ...entry, ranges: mergeRanges([...(previous?.ranges ?? []), ...entry.ranges]),
        staleRanges: previous?.staleRanges ?? [], edited: previous?.edited,
        totalLines: entry.totalLines ?? previous?.totalLines,
        minimumTotalLines: entry.minimumTotalLines ?? previous?.minimumTotalLines });
    } else if ((call.name === 'Edit' || call.name === 'Write') && previous !== undefined) {
      files.delete(key);
      files.set(key, { ...previous, ranges: [], staleRanges: mergeRanges([...previous.staleRanges, ...previous.ranges]),
        totalLines: undefined, minimumTotalLines: undefined,
        edited: { source, readSource: previous.ranges.length > 0 ? previous.source : previous.edited?.readSource } });
    }
  }
  return { entries: [...files.values()].toReversed(), omitted };
}

function pointer(source: ContextMessageSource | undefined): string {
  const stepId = source?.stepId !== undefined && /^t\d+\.\d+$/.test(source.stepId) ? source.stepId
    : source?.turnId !== undefined && source.step !== undefined ? `t${source.turnId}.${source.step}` : undefined;
  if (stepId !== undefined) return `HistoryRead {step_id:${JSON.stringify(stepId)}}`;
  if (source?.ref) return `HistoryRead {ref:${JSON.stringify(source.ref)}}`;
  return source?.turnId === undefined ? 'source unavailable' : `HistoryRead {turn:${source.turnId}}`;
}

function rangesText(ranges: readonly LineRange[]): string {
  return ranges.map(([start, end]) => start === end ? `L${start}` : `L${start}–${end}`).join(',');
}

export function fileReadEvidence(call: ToolCall, result: ContextMessage, source?: ContextMessageSource): string | undefined {
  if (!successful(result)) {
    const target = targetOf(call);
    const text = textOf(result);
    return target === undefined ? undefined : `${JSON.stringify(target.path)} Read failed (${text.length} chars returned): ${sliceUtf16(text, 0, 240)}`;
  }
  const entry = readEntry(call, result, source);
  return entry === undefined ? undefined : entryText(entry, false);
}

function entryText(entry: FileReadEntry, includeSource = true): string {
  const total = entry.totalLines === undefined ? entry.minimumTotalLines === undefined ? '?' : `>=${entry.minimumTotalLines}` : String(entry.totalLines);
  const range = entry.ranges.length > 0 ? `${rangesText(entry.ranges)}/${total}` : `range unknown/${total}`;
  const stale = entry.staleRanges.length > 0 ? `; before edit: ${rangesText(entry.staleRanges)} (stale) · ${pointer(entry.edited?.readSource)}` : '';
  const edited = entry.edited === undefined ? '' : `; edited ${pointer(entry.edited.source)}; re-read before Edit`;
  return `${JSON.stringify(entry.path)}${entry.host === undefined ? '' : ` on ${JSON.stringify(entry.host)}`} ${range} (${entry.chars} chars returned by last Read)${stale}${edited}${includeSource ? ` · ${pointer(entry.source)}` : ''}`;
}

export function renderFileReads(ledger: FileReadLedger): string {
  if (ledger.entries.length === 0 && ledger.omitted === 0) return '';
  return ['## Files read (content not carried)',
    'Historical Read observations, not current file contents. Ranges may contain truncated lines. Re-Read only what the next action needs; re-read edited files before Edit.',
    ...ledger.entries.map(entry => `- ${entryText(entry)}`),
    ledger.omitted > 0 ? `+${ledger.omitted} older file records omitted by the ledger budget; use session history for them.` : '',
  ].filter(Boolean).join('\n');
}

export function budgetFileReads(ledger: FileReadLedger, maxTokens: number, estimateText: (text: string) => number): FileReadLedger {
  const entries: FileReadEntry[] = [];
  let omitted = ledger.omitted + ledger.entries.length;
  for (const entry of ledger.entries) {
    const candidate = { entries: [...entries, entry], omitted: omitted - 1 };
    if (estimateText(renderFileReads(candidate)) > maxTokens) continue;
    entries.push(entry);
    omitted--;
  }
  return { entries, omitted };
}

export function withoutFileReadLedgerText(summary: string): string {
  return summary.replaceAll(/^## Files read \(content not carried\)[ \t]*\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/gm, '').trim();
}

export function fileReadHandoffMessages(history: readonly ContextMessage[]): readonly ContextMessage[] {
  return history.map(message => message.origin?.kind === 'compaction_summary' ? { ...message,
    content: message.content.map(part => part.type === 'text' ? { ...part, text: withoutFileReadLedgerText(part.text) } : part),
  } : message);
}
