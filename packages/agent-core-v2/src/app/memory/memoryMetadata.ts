import { z } from 'zod';
import { redactMemorySecrets } from './memorySafety';

export const memoryBasisSchema = z.object({
  kind: z.enum(['human', 'observed', 'derived', 'unknown']),
  note: z.string().trim().min(1).max(500),
  refs: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
}).strict();
export const memoryValiditySchema = z.object({
  check: z.string().trim().min(1).max(300),
  until: z.string().datetime({ offset: true }).optional(),
}).strict();
export const memoryCoveredBySchema = z.object({ id: z.string().regex(/^m_[a-zA-Z0-9_]+$/), expected_revision: z.string().min(1) }).strict();
export type MemoryBasis = z.infer<typeof memoryBasisSchema>;
export type MemoryValidity = z.infer<typeof memoryValiditySchema>;
export type MemoryApplicability = 'expired' | 'recheck' | 'unrecorded';

export function memoryApplicability(entry: { readonly validity?: MemoryValidity }, now = Date.now()): MemoryApplicability {
  if (entry.validity?.until !== undefined && Date.parse(entry.validity.until) <= now) return 'expired';
  return entry.validity === undefined ? 'unrecorded' : 'recheck';
}
export function normalizeMemoryBasis(value: unknown): MemoryBasis | undefined {
  if (value === undefined) return undefined;
  const basis = memoryBasisSchema.parse(value);
  const safe = memoryBasisSchema.safeParse({ kind: basis.kind, note: redactMemorySecrets(basis.note), refs: basis.refs?.map(redactMemorySecrets) });
  if (!safe.success) throw new MemoryDomainError('invalid_input', 'Redacted memory basis exceeds its field limits', 'Remove credentials and shorten the evidence locator or note without losing its meaning.');
  return safe.data;
}
export function normalizeMemoryValidity(value: unknown): MemoryValidity | undefined {
  if (value === undefined || value === null) return undefined;
  const validity = memoryValiditySchema.parse(value);
  const safe = memoryValiditySchema.safeParse({ check: redactMemorySecrets(validity.check), until: validity.until });
  if (!safe.success) throw new MemoryDomainError('invalid_input', 'Redacted memory validity exceeds its field limits', 'Remove credentials and shorten the check without losing its conditions.');
  return safe.data;
}
export type MemoryFailureCode = 'invalid_query' | 'missing_revision' | 'not_found' | 'ambiguous_target' | 'scope_mismatch' | 'revision_conflict' | 'inactive_target' | 'covered_target_changed' | 'cursor_invalidated' | 'storage_unavailable' | 'invalid_input' | 'duplicate_title';
export class MemoryDomainError extends Error {
  constructor(readonly code: MemoryFailureCode, message: string, readonly recovery: string) { super(message); }
}
