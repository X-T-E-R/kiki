import type { WireRecord } from '#/wire/record';

export function parseThreadTurnRecord(text: string): WireRecord | undefined {
  if (text.trim().length === 0) return undefined;
  const record = JSON.parse(text) as WireRecord;
  if (record.type === 'turn.prompt' || record.type === 'turn.ended' || record.type === 'turn.cancel') return record;
  if (record.type !== 'context.append_loop_event') return { type: record.type };
  const event = record['event'] as { readonly type: string; readonly turnId?: string; readonly part?: { readonly type: string } } | undefined;
  return { type: record.type, event: event?.type === 'content.part' && event.part?.type === 'text'
    ? event : { type: event?.type, turnId: event?.type === 'tool.result' ? undefined : event?.turnId } };
}
