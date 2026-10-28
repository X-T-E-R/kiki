import { load } from 'js-yaml';
import { z } from 'zod';
import { MemoryDomainError, normalizeMemoryBasis, normalizeMemoryValidity, type MemoryBasis, type MemoryValidity } from './memoryMetadata';
import { MEMORY_PERSONA_ID_PATTERN, MEMORY_WORKSPACE_ID_PATTERN, type MemoryScope } from './memoryScopes';
import type { MemoryEntry, MemorySource, MemoryType } from './memoryStore';
import { redactMemorySecrets } from './memorySafety';

const workspaceId = z.string().regex(MEMORY_WORKSPACE_ID_PATTERN);
const personaId = z.string().regex(MEMORY_PERSONA_ID_PATTERN);
const entryId = z.string().regex(/^m_[a-zA-Z0-9_]+$/);
const revision = z.string().min(1).max(300);
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('workspace'), workspaceId }).strict(),
  z.object({ kind: z.literal('persona'), personaId }).strict(),
  z.object({ kind: z.literal('persona_workspace'), workspaceId, personaId }).strict(),
]);
const metadataSchema = z.object({
  format: z.literal('kiki-memory-v1'), scope: scopeSchema,
  id: z.union([z.literal('new'), entryId]), revision: revision.nullable(),
  origin: z.object({ id: entryId, revision }).strict().nullable().default(null),
  source: z.object({ writer: z.enum(['user', 'agent', 'consolidator', 'import']), session: z.string().min(1).max(1_000).optional(), turn: z.number().int().nonnegative().optional(), step: z.string().max(1_000).optional() }).strict().default({ writer: 'import' }),
  type: z.enum(['user', 'feedback', 'project', 'reference']), title: z.string().trim().min(1).max(200),
  status: z.enum(['active', 'pending', 'superseded', 'archived']), pinned: z.boolean(),
  basis: z.unknown().optional(), validity: z.unknown().optional(),
}).strict().refine((value) => value.id === 'new' ? value.revision === null && value.status === 'active' : value.revision !== null && value.origin !== null, 'Existing Memory imports require their exported revision and origin; new entries require revision: null and status: active');

export interface MemoryMarkdownDocument {
  readonly format: 'kiki-memory-v1';
  readonly scope: MemoryScope;
  readonly id: string;
  readonly revision: string | null;
  readonly origin: { readonly id: string; readonly revision: string } | null;
  readonly source: MemorySource;
  readonly type: MemoryType;
  readonly title: string;
  readonly body: string;
  readonly status: MemoryEntry['status'];
  readonly pinned: boolean;
  readonly basis?: MemoryBasis;
  readonly validity: MemoryValidity | null;
}
export function parseMemoryMarkdown(markdown: string): MemoryMarkdownDocument {
  if (markdown.length > 64 * 1024) throw new MemoryDomainError('invalid_input', 'Memory Markdown exceeds the import limit', 'Import one complete entry of at most 65,536 UTF-16 units at a time.');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (match === null) throw new MemoryDomainError('invalid_input', 'Memory Markdown frontmatter is missing', 'Export an entry before editing its Markdown; keep its scope, ID, revision and origin.');
  const metadata = metadataSchema.parse(load(match[1]!));
  const body = redactMemorySecrets(match[2]!.trim());
  const title = redactMemorySecrets(metadata.title);
  if (body.length === 0 || body.length > 1_500 || title.length > 200) throw new MemoryDomainError('invalid_input', 'Memory Markdown body is empty or oversized', 'Keep the complete entry body within 1,500 characters and the title within 200.');
  return { ...metadata, title, body, basis: normalizeMemoryBasis(metadata.basis), validity: normalizeMemoryValidity(metadata.validity) ?? null };
}
export function serializeMemoryMarkdown(scope: MemoryScope, entry: MemoryEntry): string {
  const metadata = { format: 'kiki-memory-v1', scope, id: entry.id, revision: entry.revision, origin: { id: entry.id, revision: entry.revision }, source: entry.source, type: entry.type, title: entry.title, status: entry.status, pinned: entry.pinned, basis: entry.basis, validity: entry.validity ?? null };
  return `---\n${JSON.stringify(metadata, null, 2)}\n---\n${entry.body}\n`;
}
