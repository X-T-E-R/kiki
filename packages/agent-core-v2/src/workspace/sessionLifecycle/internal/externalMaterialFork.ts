import type { WireRecord } from '#/wire/record';

export function externalMaterialForkRecords(records: readonly WireRecord[]): readonly WireRecord[] {
  return records.filter((record) => {
    if (record.type.startsWith('task.') || record.type.startsWith('subagent.') || record.type.startsWith('cron.')) return false;
    if (record.type !== 'context.append_message') return true;
    const message = objectOf(record['message']);
    const origin = objectOf(message?.['origin']);
    const kind = origin?.['kind'];
    return kind !== 'task' && kind !== 'background_task';
  });
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}
