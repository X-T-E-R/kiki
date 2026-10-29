export type Receipt = Record<string, unknown>;

export function record(value: unknown): Receipt {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Receipt : {};
}

export function rows(value: unknown): Receipt[] {
  return Array.isArray(value) ? value.map(record) : [];
}

export function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

export function call(name: string, args: Receipt): string {
  return `${name} ${JSON.stringify(args)}`;
}

export function nextCall(value: unknown): string {
  const next = record(value);
  return typeof next['tool'] === 'string' ? call(next['tool'], record(next['arguments'])) : '';
}

export function localTime(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return text(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function join(parts: readonly (string | undefined | false)[], separator = '\n'): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(separator);
}

export function details(values: Receipt): string {
  return Object.entries(values).filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(' · ');
}

export function coverage(value: unknown, incomplete?: unknown): string {
  const source = record(value);
  const gaps = Array.isArray(source['gaps']) ? source['gaps'].map(text).filter(Boolean) : [];
  if (incomplete !== undefined && !gaps.includes(text(incomplete))) gaps.push(text(incomplete));
  const labels: Record<string, string> = {
    navigation_building: 'history navigation is still preparing',
    tool_tail_not_indexed: 'recent tool output may not be indexed',
    subagents_may_be_unindexed: 'some child agents may not be indexed',
    active_turn_or_step: 'the current turn or step is unfinished',
    source_pending: 'the saved source is still being written',
    history_preparing: 'history is still preparing',
  };
  if (source['complete'] === false || gaps.length > 0) {
    return `Partial coverage${gaps.length ? `: ${gaps.map((gap) => labels[gap] ?? gap).join('; ')}` : ''}.`;
  }
  return '';
}

export function errorReceipt(value: Receipt): string | undefined {
  const error = value['error'] === undefined ? value : record(value['error']);
  if (error['code'] === undefined || error['message'] === undefined) return undefined;
  return join([
    `${text(error['message'])} (${text(error['code'])})`,
    text(error['recovery']),
    nextCall(error['next_call']),
    rows(error['visible_targets']).map((target) => details(target)).join('\n'),
  ]);
}
