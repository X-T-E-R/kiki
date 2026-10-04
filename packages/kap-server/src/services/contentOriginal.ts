import { z } from 'zod';
import { isPlainAgentId, type ContentRef } from '@kiki/transcript';
import type { SessionMediaFile } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';
import type { TranscriptService } from './transcript/transcriptService';
import { readSessionViewCanonicalEntity } from '../transport/klient/sessionViewReads';
import { ContentChangedError, contentRevision } from '../transport/klient/boundedContent';

const originalLocatorSchema = z.tuple([z.string(), z.enum(['frame', 'task']), z.string(), z.string(), z.string(), z.enum(['input', 'output', 'outputTail']), z.string()]);

export async function openContentOriginal(service: TranscriptService, sessionId: string, fileId: string): Promise<SessionMediaFile | undefined> {
  let parsed: ReturnType<typeof originalLocatorSchema.parse>;
  try { parsed = originalLocatorSchema.parse(JSON.parse(Buffer.from(fileId.slice(4), 'base64url').toString('utf8'))); }
  catch { return undefined; }
  const [agentId, kind, id, turnId, stepId, field, revision] = parsed;
  if (!isPlainAgentId(agentId) || !(kind === 'frame' && (field === 'input' || field === 'output') || kind === 'task' && field === 'outputTail')) return undefined;
  const source: ContentRef['source'] = { kind, id, ...(turnId === '' ? {} : { turnId }), ...(stepId === '' ? {} : { stepId }) };
  const entity = await readSessionViewCanonicalEntity(service, sessionId, { agentId, ref: { source } });
  if (entity === undefined || !Object.hasOwn(entity, field)) return undefined;
  if (kind === 'frame' && (entity as { kind?: string }).kind !== 'tool') return undefined;
  const value = (entity as Record<string, unknown>)[field];
  if (contentRevision(value) !== revision) throw new ContentChangedError();
  let size = 0;
  for (const chunk of originalChunks(value)) size += chunk.byteLength;
  return {
    name: `${field}.${typeof value === 'string' ? 'txt' : 'json'}`, size,
    mediaType: typeof value === 'string' ? 'text/plain;charset=utf-8' : 'application/json',
    stream: async function* (range) {
      let offset = 0;
      const start = range?.start ?? 0;
      const end = range?.end ?? size - 1;
      for (const chunk of originalChunks(value)) {
        const from = Math.max(0, start - offset);
        const through = Math.min(chunk.byteLength, end - offset + 1);
        if (from < through) yield chunk.subarray(from, through);
        offset += chunk.byteLength;
        if (offset > end) break;
      }
    },
  };
}

function* originalChunks(value: unknown): Generator<Buffer> {
  if (typeof value === 'string') {
    for (const chunk of stringChunks(value, false)) yield Buffer.from(chunk);
    return;
  }
  const pending: Array<{ value: unknown } | { literal: string }> = [{ value }];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if ('literal' in next) { yield Buffer.from(next.literal); continue; }
    const current = next.value;
    if (typeof current === 'string') {
      yield Buffer.from('"');
      for (const chunk of stringChunks(current, true)) yield Buffer.from(chunk);
      yield Buffer.from('"');
    } else if (Array.isArray(current)) {
      yield Buffer.from('[');
      pending.push({ literal: ']' });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current[index] ?? null });
        if (index > 0) pending.push({ literal: ',' });
      }
    } else if (current !== null && typeof current === 'object') {
      yield Buffer.from('{');
      pending.push({ literal: '}' });
      const entries = Object.entries(current).filter(([, child]) => child !== undefined);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index]!;
        pending.push({ value: child }, { literal: ':' }, { value: key });
        if (index > 0) pending.push({ literal: ',' });
      }
    } else yield Buffer.from(JSON.stringify(current) ?? 'null');
  }
}

function* stringChunks(value: string, escaped: boolean): Generator<string> {
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + 4096);
    if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
    const part = value.slice(offset, end);
    yield escaped ? JSON.stringify(part).slice(1, -1) : part;
    offset = end;
  }
}
