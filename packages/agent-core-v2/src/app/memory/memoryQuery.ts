import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { tokenize } from '@kiki/minidb';
import { MemoryDomainError } from './memoryMetadata';
import type { MemoryScope } from './memoryScopes';
import type { MemoryEntry, MemoryQuery, MemoryQueryPage, MemoryType } from './memoryStore';

const querySchema = z.object({
  mode: z.enum(['search', 'list']).optional(), query: z.string().min(1).max(200).optional(),
  scope: z.enum(['global', 'workspace', 'persona', 'persona_workspace']).optional(),
  type: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
  statuses: z.array(z.enum(['active', 'pending', 'superseded', 'archived'])).min(1).max(4).optional(),
  page_size: z.number().int().min(1).max(20).optional(),
}).strict();
const positionSchema = z.object({
  sourceOffset: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
  validationOffset: z.number().int().nonnegative(), validationHash: z.string(),
  namesFingerprint: z.string().optional(), fingerprint: z.string().optional(),
  skipped: z.number().int().nonnegative(), chunkHash: z.string().optional(),
});
const cursorSchema = positionSchema.extend({ version: z.literal(2), request: querySchema, scopeHash: z.string() }).strict();
export type MemoryQueryPosition = z.infer<typeof positionSchema>;
export function memoryQueryCursor(scopes: readonly MemoryScope[], request: z.infer<typeof querySchema>, position: MemoryQueryPosition, salt: string): string {
  const payload = Buffer.from(JSON.stringify({ ...position, version: 2, request, scopeHash: createHash('sha256').update(JSON.stringify(scopes)).digest('hex') })).toString('base64url');
  return `${payload}.${createHmac('sha256', salt).update(payload).digest('hex')}`;
}
export function memoryQueryTerms(query: string): { normalized: string; terms: string[] } {
  const normalized = query.toLowerCase().trim();
  const terms = [...new Set(tokenize(normalized))];
  if (!normalized || query.length > 200 || normalized.split(/\s+/).length > 10 || (terms.length === 0 && !/[\p{L}\p{N}\p{S}]/u.test(normalized))) throw new MemoryDomainError('invalid_query', 'Query must contain retrievable text, at most 200 characters and 10 words', 'Use a shorter subject, title, or alias query; use list mode for an inventory.');
  return { normalized, terms };
}
export function rankMemoryEntries(entries: readonly (MemoryEntry & { scope: MemoryScope })[], query: string, type?: MemoryType): (MemoryEntry & { scope: MemoryScope; score: number })[] {
  const { normalized, terms } = memoryQueryTerms(query);
  return entries.filter((entry) => type === undefined || entry.type === type).map((entry) => {
    const title = entry.title.toLowerCase();
    const body = entry.body.toLowerCase();
    const titleHits = terms.filter((term) => title.includes(term)).length;
    const allHits = terms.filter((term) => title.includes(term) || body.includes(term)).length;
    const exact = title.includes(normalized);
    return { ...entry, score: (exact ? 1_000_000 : 0) + titleHits * 1_000 + allHits };
  }).filter((entry) => entry.score > 0).toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id) || JSON.stringify(a.scope).localeCompare(JSON.stringify(b.scope)));
}
export function memoryQueryRequest(scopes: readonly MemoryScope[], input: MemoryQuery, salt: string): { request: z.infer<typeof querySchema>; position: MemoryQueryPosition } {
  try {
    if (input.cursor !== undefined) {
      if (Object.keys(input).some((key) => key !== 'cursor' && input[key as keyof MemoryQuery] !== undefined) || input.cursor.length > 8_192) throw new Error('Cursor must be used alone');
      const [payload, signature, extra] = input.cursor.split('.');
      if (!payload || !signature || extra !== undefined || createHmac('sha256', salt).update(payload).digest('hex') !== signature) throw new Error('Invalid cursor');
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
      if (cursor.scopeHash !== createHash('sha256').update(JSON.stringify(scopes)).digest('hex')) throw new Error('Visible scopes changed');
      return { request: cursor.request, position: positionSchema.parse(cursor) };
    }
    const request = querySchema.parse(input);
    const mode = request.mode ?? 'search';
    if (mode === 'search') memoryQueryTerms(request.query ?? '');
    else if (request.query !== undefined) throw new MemoryDomainError('invalid_query', 'List mode does not accept query', 'Remove query to list the inventory.');
    return { request: { ...request, mode, page_size: request.page_size ?? (mode === 'search' ? 8 : 20), statuses: request.statuses ?? ['active'] }, position: { sourceOffset: 0, offset: 0, validationOffset: 0, validationHash: '', skipped: 0 } };
  } catch (error) {
    if (error instanceof MemoryDomainError) throw error;
    if (input.cursor !== undefined) throw new MemoryDomainError('cursor_invalidated', 'Memory cursor is invalid or its visible scopes changed', 'Restart the original query and reconcile scope plus ID across pages.');
    throw new MemoryDomainError('invalid_query', 'Invalid memory query or filters', 'Use search with a short query or list without query, with page_size 1–20.');
  }
}
export function memoryQueryPage(scopes: readonly MemoryScope[], parsed: ReturnType<typeof memoryQueryRequest>, entries: readonly (MemoryEntry & { scope: MemoryScope })[], nextSourceOffset: number, sourceLength: number, skipped: number, salt: string, wholeChunk = false): MemoryQueryPage {
  const { request, position } = parsed;
  const mode = request.mode ?? 'search';
  const statuses = request.statuses ?? ['active'];
  const filtered = entries.filter((entry) => statuses.includes(entry.status) && (request.type === undefined || entry.type === request.type));
  const ordered = mode === 'search' ? rankMemoryEntries(filtered, request.query!, request.type) : filtered.toSorted((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id) || JSON.stringify(a.scope).localeCompare(JSON.stringify(b.scope)));
  const pageSize = wholeChunk ? Math.max(1, ordered.length) : request.page_size ?? 20;
  const items = ordered.slice(position.offset, position.offset + pageSize);
  const chunkExhausted = position.offset + pageSize >= ordered.length;
  const exhausted = chunkExhausted && nextSourceOffset >= sourceLength;
  const totalSkipped = position.skipped + skipped;
  const warnings = totalSkipped === 0 ? [] : [`${totalSkipped} memory records were skipped (unavailable, invalid, or oversized).`];
  const next = { ...position, validationOffset: 0, validationHash: '', sourceOffset: chunkExhausted ? nextSourceOffset : position.sourceOffset, offset: chunkExhausted ? 0 : position.offset + pageSize, skipped: chunkExhausted ? totalSkipped : position.skipped, chunkHash: chunkExhausted ? undefined : position.chunkHash };
  return { items, mode, next_cursor: exhausted ? null : memoryQueryCursor(scopes, request, next, salt), coverage: { scopes: scopes.filter((scope) => request.scope === undefined || scope.kind === request.scope), statuses, exhausted, complete: totalSkipped === 0, warnings } };
}
