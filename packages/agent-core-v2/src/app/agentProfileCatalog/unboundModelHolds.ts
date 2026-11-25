import { createHash } from 'node:crypto';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

export type UnboundModelHoldTargetKind = 'profile' | 'persona' | 'recipe';

export interface UnboundModelHoldEntry {
  readonly tupleKey: string;
  readonly itemId: string;
  readonly targetKind: UnboundModelHoldTargetKind;
  readonly targetName: string;
  readonly sourceModelId: string;
  readonly location: string;
  readonly required: boolean;
  readonly sourceId?: string;
  readonly recordedAt: string;
}

export interface UnboundModelHoldDocument {
  readonly version: 1;
  readonly revision: string;
  readonly holds: Readonly<Record<string, UnboundModelHoldEntry>>;
}

export const UNBOUND_MODEL_HOLDS_KEY = 'unbound-model-holds.json';

function computeRevision(holds: Readonly<Record<string, UnboundModelHoldEntry>>): string {
  const keys = Object.keys(holds).sort();
  const ordered = Object.fromEntries(keys.map((key) => [key, holds[key]]));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export function emptyUnboundModelHoldDocument(): UnboundModelHoldDocument {
  const holds: Record<string, UnboundModelHoldEntry> = {};
  return { version: 1, revision: computeRevision(holds), holds };
}

function normalizeHoldDocument(raw: unknown): UnboundModelHoldDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return emptyUnboundModelHoldDocument();
  }
  const obj = raw as Record<string, unknown>;
  const rawHolds = obj['holds'];
  if (typeof rawHolds !== 'object' || rawHolds === null || Array.isArray(rawHolds)) {
    return emptyUnboundModelHoldDocument();
  }
  const holds: Record<string, UnboundModelHoldEntry> = {};
  for (const [key, value] of Object.entries(rawHolds as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const targetKind = entry['targetKind'];
    if (targetKind !== 'profile' && targetKind !== 'persona' && targetKind !== 'recipe') continue;
    if (
      typeof entry['tupleKey'] !== 'string'
      || typeof entry['itemId'] !== 'string'
      || typeof entry['targetName'] !== 'string'
      || typeof entry['sourceModelId'] !== 'string'
      || typeof entry['location'] !== 'string'
      || typeof entry['required'] !== 'boolean'
      || typeof entry['recordedAt'] !== 'string'
    ) {
      continue;
    }
    holds[key] = {
      tupleKey: entry['tupleKey'],
      itemId: entry['itemId'],
      targetKind,
      targetName: entry['targetName'],
      sourceModelId: entry['sourceModelId'],
      location: entry['location'],
      required: entry['required'],
      ...(typeof entry['sourceId'] === 'string' ? { sourceId: entry['sourceId'] } : {}),
      recordedAt: entry['recordedAt'],
    };
  }
  return {
    version: 1,
    revision: typeof obj['revision'] === 'string' && obj['revision'].length > 0 ? obj['revision'] : computeRevision(holds),
    holds,
  };
}

/** Reads the per-home persisted unbound model holds ledger without mutating disk. */
export async function readUnboundModelHolds(
  documents: Pick<IAtomicDocumentStore, 'get'>,
  bootstrap: Pick<IBootstrapService, 'scope'>,
): Promise<UnboundModelHoldDocument> {
  try {
    const raw = await documents.get<unknown>(bootstrap.scope('store'), UNBOUND_MODEL_HOLDS_KEY);
    return normalizeHoldDocument(raw);
  } catch {
    return emptyUnboundModelHoldDocument();
  }
}

/** Atomically updates the per-home unbound model holds ledger and recomputes its revision digest. */
export async function updateUnboundModelHolds(
  documents: Pick<IAtomicDocumentStore, 'update'>,
  bootstrap: Pick<IBootstrapService, 'scope'>,
  mutate: (holds: Record<string, UnboundModelHoldEntry>) => void,
): Promise<UnboundModelHoldDocument> {
  const result = await documents.update<UnboundModelHoldDocument>(
    bootstrap.scope('store'),
    UNBOUND_MODEL_HOLDS_KEY,
    (current) => {
      const normalized = normalizeHoldDocument(current);
      const nextHolds: Record<string, UnboundModelHoldEntry> = { ...normalized.holds };
      mutate(nextHolds);
      return {
        version: 1,
        revision: computeRevision(nextHolds),
        holds: nextHolds,
      };
    },
  );
  return normalizeHoldDocument(result);
}

/** Upserts unbound model hold entries for deferred import slots. */
export async function upsertUnboundModelHolds(
  documents: Pick<IAtomicDocumentStore, 'update'>,
  bootstrap: Pick<IBootstrapService, 'scope'>,
  entries: readonly UnboundModelHoldEntry[],
): Promise<UnboundModelHoldDocument> {
  return updateUnboundModelHolds(documents, bootstrap, (holds) => {
    for (const entry of entries) {
      holds[entry.tupleKey] = entry;
    }
  });
}

/** Clears unbound model holds for a repaired profile, persona, or recipe target. */
export async function clearUnboundModelHoldsForTarget(
  documents: Pick<IAtomicDocumentStore, 'update'>,
  bootstrap: Pick<IBootstrapService, 'scope'>,
  targetKind: UnboundModelHoldTargetKind,
  targetName: string,
  sourceModelId?: string,
): Promise<UnboundModelHoldDocument> {
  return updateUnboundModelHolds(documents, bootstrap, (holds) => {
    for (const [key, entry] of Object.entries(holds)) {
      if (entry.targetKind !== targetKind || entry.targetName !== targetName) continue;
      if (sourceModelId !== undefined && entry.sourceModelId !== sourceModelId) continue;
      delete holds[key];
    }
  });
}

/** Finds a blocking required unbound model hold for a profile or persona binding attempt. */
export function findBlockingUnboundModelHold(
  doc: UnboundModelHoldDocument,
  targetKind: UnboundModelHoldTargetKind,
  targetName: string,
  configuredAlias: string | undefined,
  explicitOverrideAlias?: string,
): UnboundModelHoldEntry | undefined {
  const override = explicitOverrideAlias?.trim();
  const normalizedAlias = configuredAlias?.trim();
  for (const entry of Object.values(doc.holds)) {
    if (!entry.required) continue;
    if (entry.targetKind !== targetKind || entry.targetName !== targetName) continue;
    if (override !== undefined && override.length > 0 && override !== entry.sourceModelId) {
      continue;
    }
    if (normalizedAlias === undefined || normalizedAlias.length === 0 || normalizedAlias === entry.sourceModelId) {
      return entry;
    }
  }
  return undefined;
}

/** Formats an actionable unbound model hold error message for main binding or subagent dispatch. */
export function formatUnboundModelHoldMessage(entry: UnboundModelHoldEntry): string {
  const kindLabel = entry.targetKind === 'persona' ? 'Persona' : entry.targetKind === 'recipe' ? 'Recipe' : 'Profile';
  return `${kindLabel} "${entry.targetName}" 尚未绑定模型 (deferred upstream model "${entry.sourceModelId}" at ${entry.location}). Configure a local model in settings or pass an explicit model alias.`;
}
