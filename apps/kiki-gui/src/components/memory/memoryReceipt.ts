/**
 * Memory receipts as the UI needs to read them — one tolerant layer over the
 * old flat payload and the `outcome`-carrying one.
 *
 * The runtime is free to answer a `MemoryWrite` with the pre-`outcome` shape
 * (`{id, title, scope, status, revision, operation_id}`) or the current one,
 * and a session keeps whichever blocks it recorded. Rather than teach every
 * surface both shapes, each reader hands its raw JSON here and gets back the
 * one thing it renders from. Nothing is invented: a field the payload does
 * not carry stays absent, and the reader says so with its own wording.
 *
 * `target` is the contract's copy-and-write field group, so a persona-owned
 * entry is located by its real owning scope instead of being guessed into the
 * session's workspace.
 */

import type { MemoryScopeKind, MemoryType, MemoryStatus, MemoryWriter } from '../../lib/client';

export const MEMORY_SCOPE_KINDS: readonly MemoryScopeKind[] = ['global', 'workspace', 'persona', 'persona_workspace'];

/** What happened to the entry. A pre-`outcome` receipt reads as `applied`. */
export type MemoryWriteOutcome = 'applied' | 'pending' | 'unchanged';

/** Why the content is recorded as it is. `unknown` means unestablished, not false. */
export type MemoryBasisKind = 'human' | 'observed' | 'derived' | 'unknown';

/** Whether the stored content can still be relied on without a fresh check. */
export type MemoryApplicability = 'recheck' | 'expired' | 'unrecorded';

export interface MemoryBasis {
  readonly kind: MemoryBasisKind;
  readonly note: string;
  readonly refs: readonly string[];
}

/** What must be verified before relying on a changing fact, and how long the answer holds. */
export interface MemoryValidity {
  readonly check: string;
  readonly until?: string;
}

export interface MemoryCoveredBy {
  readonly id: string;
  readonly revision: string;
}

/** The copyable field group a write needs for an existing target. */
export interface MemoryTargetRef {
  readonly scope: MemoryScopeKind;
  readonly id: string;
  readonly expected_revision: string;
}

/** The namespace a memory actually lives in, including persona identity. */
export interface MemoryOwnerScope {
  readonly scope: MemoryScopeKind;
  readonly workspaceId?: string;
  readonly personaId?: string;
}

export interface MemoryEntryView {
  readonly id: string;
  readonly type: MemoryType;
  readonly title: string;
  readonly body: string;
  readonly status: MemoryStatus;
  readonly pinned: boolean;
  readonly created: string;
  readonly updated: string;
  readonly source: { readonly writer: MemoryWriter; readonly session?: string; readonly turn?: number | string; readonly step?: string };
  readonly reason: string;
  readonly revision: string;
  readonly superseded_by?: string;
  readonly supersedes?: string;
  readonly supersedes_revision?: string;
  readonly pending_action?: 'update' | 'archive';
  readonly basis?: MemoryBasis;
  readonly validity?: MemoryValidity;
  readonly covered_by?: MemoryCoveredBy;
}

export interface MemoryWriteReceipt {
  readonly outcome: MemoryWriteOutcome;
  readonly id: string;
  readonly title: string;
  /** The scope string the receipt carries, for a copy that lacks `owner_scope`. */
  readonly scope: MemoryScopeKind;
  /** The full namespace, which a persona-scoped receipt resolves through. */
  readonly owner_scope: MemoryOwnerScope;
  readonly target: MemoryTargetRef;
  readonly status: MemoryStatus;
  readonly revision: string;
  /** Absent/empty operation IDs and no-ops have nothing new to undo. */
  readonly operation_id: string | null;
  readonly entry?: MemoryEntryView;
  /** The entry a pending proposal would change; absent on a `create` proposal. */
  readonly proposed_target?: MemoryTargetRef;
  readonly covered_by?: MemoryCoveredBy;
  readonly warnings: readonly string[];
}

export interface MemoryReadItem {
  readonly entry: MemoryEntryView;
  readonly owner_scope: MemoryOwnerScope;
  readonly target: MemoryTargetRef;
  readonly applicability: MemoryApplicability;
}

/** `true` for a target whose `until` has passed, so it is a lead, not a premise. */
export function isExpired(validity: MemoryValidity | undefined, now: number = Date.now()): boolean {
  if (validity?.until === undefined) return false;
  const until = Date.parse(validity.until);
  return Number.isNaN(until) ? false : until <= now;
}

/**
 * What a stored entry's `validity` means right now. Absent metadata reads as
 * `unrecorded`, which is not a claim of permanence.
 */
export function memoryApplicability(validity: MemoryValidity | undefined, now: number = Date.now()): MemoryApplicability {
  if (validity === undefined) return 'unrecorded';
  return isExpired(validity, now) ? 'expired' : 'recheck';
}

function receiptValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const asScope = (value: unknown): MemoryScopeKind | undefined =>
  typeof value === 'string' && (MEMORY_SCOPE_KINDS as readonly string[]).includes(value)
    ? value as MemoryScopeKind
    : undefined;

const asBasisKind = (value: unknown): MemoryBasisKind | undefined =>
  value === 'human' || value === 'observed' || value === 'derived' || value === 'unknown' ? value : undefined;

/** An entry with a usable identity and body; anything less cannot be rendered. */
export function parseMemoryEntry(value: unknown): MemoryEntryView | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const id = asString(record['id']);
  const title = asString(record['title']);
  const body = asString(record['body']);
  if (id === undefined || title === undefined || body === undefined) return undefined;
  const source = asRecord(record['source']);
  const writer = asString(source?.['writer']);
  return {
    id, title, body,
    type: asString(record['type']) as MemoryType ?? 'project',
    status: asString(record['status']) as MemoryStatus ?? 'active',
    pinned: record['pinned'] === true,
    created: asString(record['created']) ?? '',
    updated: asString(record['updated']) ?? '',
    revision: asString(record['revision']) ?? '',
    reason: asString(record['reason']) ?? '',
    source: {
      writer: (writer === 'user' || writer === 'agent' || writer === 'consolidator' || writer === 'import'
        ? writer
        : 'import') as MemoryWriter,
      session: asString(source?.['session']),
      turn: typeof source?.['turn'] === 'number' || typeof source?.['turn'] === 'string' ? source['turn'] : undefined,
      step: asString(source?.['step']),
    },
    superseded_by: asString(record['superseded_by']),
    supersedes: asString(record['supersedes']),
    supersedes_revision: asString(record['supersedes_revision']),
    pending_action: record['pending_action'] === 'archive' ? 'archive' : record['pending_action'] === 'update' ? 'update' : undefined,
    basis: parseMemoryBasis(record['basis']),
    validity: parseMemoryValidity(record['validity']),
    covered_by: parseMemoryCoveredBy(record['covered_by']),
  };
}

/** An absent basis stays absent: an old entry has no recorded basis, and none is invented. */
export function parseMemoryBasis(value: unknown): MemoryBasis | undefined {
  const record = asRecord(value);
  const kind = asBasisKind(record?.['kind']);
  if (record === undefined || kind === undefined) return undefined;
  return { kind, note: asString(record['note']) ?? '', refs: asStrings(record['refs']) };
}

export function parseMemoryValidity(value: unknown): MemoryValidity | undefined {
  const record = asRecord(value);
  const check = asString(record?.['check']);
  if (record === undefined || check === undefined || check === '') return undefined;
  return { check, until: asString(record['until']) };
}

export function parseMemoryCoveredBy(value: unknown): MemoryCoveredBy | undefined {
  const record = asRecord(value);
  const id = asString(record?.['id']);
  if (record === undefined || id === undefined) return undefined;
  return { id, revision: asString(record['revision']) ?? asString(record['expected_revision']) ?? '' };
}

/**
 * The namespace a payload names. The current contract sends a discriminated
 * `{kind, workspaceId?, personaId?}` under `owner_scope`, and a read item
 * carries the same object directly as `scope`; an older receipt carries only
 * the scope string, which is still enough to place a global or bare-workspace
 * entry. A namespace that cannot be read is `undefined`, never a guess.
 */
function parseOwnerScope(record: Record<string, unknown>): MemoryOwnerScope | undefined {
  const named = asRecord(record['owner_scope']);
  // `scope` is the scope string on a write receipt and the namespace object on
  // a read item, so both readings are tried before giving up on it.
  const inline = asRecord(record['scope']);
  const owner = named ?? inline;
  const scope = asScope(named?.['kind']) ?? asScope(inline?.['kind']) ?? asScope(record['scope']);
  if (scope === undefined) return undefined;
  const source = owner ?? record;
  const workspaceId = asString(source['workspaceId']) ?? asString(source['workspace_id']);
  const personaId = asString(source['personaId']) ?? asString(source['persona_id']);
  return {
    scope,
    workspaceId: scope === 'workspace' || scope === 'persona_workspace' ? workspaceId : undefined,
    personaId: scope === 'persona' || scope === 'persona_workspace' ? personaId : undefined,
  };
}

function parseTarget(record: Record<string, unknown>, owner: MemoryOwnerScope, id: string, revision: string): MemoryTargetRef {
  const target = asRecord(record['target']);
  return {
    scope: asScope(target?.['scope']) ?? owner.scope,
    id: asString(target?.['id']) ?? id,
    expected_revision: asString(target?.['expected_revision']) ?? revision,
  };
}

const asOutcome = (value: unknown): MemoryWriteOutcome | undefined =>
  value === 'applied' || value === 'pending' || value === 'unchanged' ? value : undefined;

/**
 * A `MemoryWrite` result, old or new. `unchanged` is never given a fake
 * operation id, so the row has no Undo to offer.
 */
export function parseMemoryWriteResult(output: unknown): MemoryWriteReceipt | undefined {
  const parsed = receiptValue(output);
  const record = asRecord(parsed);
  const id = asString(record?.['id']);
  const title = asString(record?.['title']);
  if (record === undefined || id === undefined || title === undefined) return undefined;
  const owner = parseOwnerScope(record);
  if (owner === undefined) return undefined;
  const status = (asString(record['status']) ?? 'active') as MemoryStatus;
  const revision = asString(record['revision']) ?? '';
  const outcome = asOutcome(record['outcome']) ?? (status === 'pending' ? 'pending' : 'applied');
  const operation = asString(record['operation_id']);
  const proposed = asRecord(record['proposed_target']);
  const proposedScope = asScope(proposed?.['scope']);
  return {
    outcome,
    id,
    title,
    scope: owner.scope,
    owner_scope: owner,
    target: parseTarget(record, owner, id, revision),
    status,
    revision,
    // Duplicate pending proposals also have no new journal operation.
    operation_id: outcome === 'unchanged' || operation === undefined || operation.trim() === '' ? null : operation,
    entry: parseMemoryEntry(record['entry']),
    proposed_target: proposed !== undefined && proposedScope !== undefined ? {
      scope: proposedScope,
      id: asString(proposed['id']) ?? '',
      expected_revision: asString(proposed['expected_revision']) ?? '',
    } : undefined,
    covered_by: parseMemoryCoveredBy(record['covered_by']),
    warnings: asStrings(record['warnings']),
  };
}

export interface MemorySearchSummary {
  readonly count: number;
  /** More pages remain for this exact query. */
  readonly hasMore: boolean;
  /** The query or listing was cut short, so a short result is not an absence. */
  readonly partial: boolean;
  readonly warnings: readonly string[];
}

/**
 * A `MemorySearch` result, new envelope or old array. The old payload says
 * nothing about coverage, so it reads as one complete page.
 */
export function parseMemorySearchSummary(output: unknown): MemorySearchSummary | undefined {
  const parsed = receiptValue(output);
  if (Array.isArray(parsed)) return { count: parsed.length, hasMore: false, partial: false, warnings: [] };
  const record = asRecord(parsed);
  const items = record?.['items'];
  if (record === undefined || !Array.isArray(items)) return undefined;
  const coverage = asRecord(record['coverage']);
  const warnings = asStrings(coverage?.['warnings']);
  const complete = coverage?.['complete'] !== false;
  return {
    count: items.length,
    hasMore: (typeof record['next_cursor'] === 'string' && record['next_cursor'] !== '') || coverage?.['exhausted'] === false,
    partial: complete === false || warnings.length > 0,
    warnings,
  };
}

export interface MemoryReadResult {
  readonly items: readonly MemoryReadItem[];
  /** Ids the read could not resolve, each with the reason it did not. */
  readonly missing: readonly { readonly id: string; readonly reason?: string }[];
  /** A result the transport could not carry in full, so it is not a full read. */
  readonly complete: boolean;
}

/**
 * A `MemoryRead` result. The current payload is one flat array whose items
 * carry `scope`, `target` and `applicability` beside the entry fields; an
 * older payload is a plain array of entries.
 */
export function parseMemoryReadResult(output: unknown): MemoryReadResult | undefined {
  const parsed = receiptValue(output);
  const envelope = asRecord(parsed);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(envelope?.['items']) ? envelope['items'] as unknown[] : undefined;
  if (list === undefined) return undefined;
  const items: MemoryReadItem[] = [];
  const missing: { id: string; reason?: string }[] = [];
  let complete = envelope?.['complete'] !== false;
  for (const item of list) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const id = asString(record['id']);
    if (record['missing'] === true) {
      if (id !== undefined) {
        // A lookup that hit several visible scopes reports candidates instead
        // of choosing one, so "ambiguous" is a real outcome, not an error.
        const ambiguous = Array.isArray(record['visible_targets']) && record['visible_targets'].length > 0;
        missing.push({ id, reason: asString(record['reason']) ?? (ambiguous ? 'ambiguous_target' : undefined) });
      }
      continue;
    }
    const entry = parseMemoryEntry(record);
    if (entry === undefined) continue;
    const owner = parseOwnerScope(record) ?? { scope: 'global' as MemoryScopeKind };
    if (record['complete'] === false) complete = false;
    items.push({
      entry,
      owner_scope: owner,
      target: parseTarget(record, owner, entry.id, entry.revision),
      applicability: (asString(record['applicability']) as MemoryApplicability | undefined)
        ?? memoryApplicability(entry.validity),
    });
  }
  return { items, missing, complete };
}
