import type { ThinkPart } from '#/kosong/contract/message';

import { KNOWN_REASONING_KEYS, type ReasoningKeyDialect } from './reasoning-key';

export function readReasoningParts(source: unknown, dialect: ReasoningKeyDialect): ThinkPart[] {
  if (typeof source !== 'object' || source === null) return [];
  const record = source as Record<string, unknown>;
  dialect.observe(source);
  const keys = dialect.explicitKey === undefined ? KNOWN_REASONING_KEYS : [dialect.explicitKey];
  const parts: ThinkPart[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      parts.push({ type: 'think', think: value, reasoningKey: key, hidden: parts.some((part) => part.think.length > 0) || undefined });
    }
  }
  const details = record['reasoning_details'];
  if (Array.isArray(details) && (dialect.explicitKey === undefined || dialect.explicitKey === 'reasoning_details')) {
    const hasText = parts.some((part) => part.think.length > 0);
    for (const detail of details) {
      if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) continue;
      const raw = detail as Record<string, unknown>;
      const text = raw['type'] === 'reasoning.summary' ? raw['summary']
        : raw['type'] === 'reasoning.text' ? raw['text'] : undefined;
      parts.push({
        type: 'think',
        think: typeof text === 'string' ? text : '',
        reasoningDetails: [structuredClone(raw)],
        hidden: hasText || typeof text !== 'string',
      });
    }
  }
  return parts;
}

export function writeReasoningParts(parts: readonly ThinkPart[], fallbackKey: string): Record<string, unknown> {
  const strings = new Map<string, string>();
  const details: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (part.reasoningDetails !== undefined) {
      for (const detail of part.reasoningDetails) appendDetail(details, detail);
    } else {
      const key = part.reasoningKey ?? fallbackKey;
      strings.set(key, (strings.get(key) ?? '') + part.think);
    }
  }
  const result: Record<string, unknown> = Object.fromEntries(strings);
  if (details.length > 0) result['reasoning_details'] = details;
  return result;
}

function appendDetail(details: Record<string, unknown>[], fragment: Record<string, unknown>): void {
  const type = fragment['type'];
  const index = fragment['index'];
  const id = fragment['id'];
  const target = (type === 'reasoning.summary' || type === 'reasoning.text' || type === 'reasoning.encrypted') &&
    (typeof index === 'number' || typeof id === 'string')
    ? details.find((detail) => detail['type'] === type &&
      (typeof index === 'number' ? detail['index'] === index : detail['id'] === id) &&
      (id === undefined || detail['id'] === undefined || detail['id'] === id))
    : undefined;
  if (target === undefined) {
    details.push(structuredClone(fragment));
    return;
  }
  for (const [key, value] of Object.entries(fragment)) {
    const previous = target[key];
    if ((key === 'text' || key === 'summary' || key === 'data') && typeof previous === 'string' && typeof value === 'string') {
      target[key] = previous + value;
    } else {
      target[key] = structuredClone(value);
    }
  }
}
