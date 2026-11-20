import type { ModelRecord } from './model';
import { nonEmpty } from './modelAuth';

function matchesBareModelId(value: string | undefined, id: string): boolean {
  return value === id || value?.endsWith(`/${id}`) === true;
}

export interface AmbiguousModelIdResolution {
  readonly id: string;
  readonly candidates: readonly string[];
  readonly resolved: string;
}

export interface ModelIdLookupIndex {
  readonly byAlias: ReadonlyMap<string, readonly string[]>;
  readonly byBareId: ReadonlyMap<string, readonly string[]>;
}

function addBareCandidate(
  byBareId: Map<string, string[]>,
  value: string | undefined,
  candidateId: string,
  seenKeys: Set<string>,
): void {
  if (value === undefined || value.length === 0) return;
  const slash = value.lastIndexOf('/');
  const bare = slash >= 0 ? value.slice(slash + 1) : value;
  if (bare.length === 0 || bare.includes('/') || seenKeys.has(bare)) return;
  seenKeys.add(bare);
  let list = byBareId.get(bare);
  if (list === undefined) {
    list = [];
    byBareId.set(bare, list);
  }
  list.push(candidateId);
}

/** Builds an O(N) lookup index for alias and bare model-id resolution. */
export function buildModelIdLookupIndex(
  models: Readonly<Record<string, ModelRecord>>,
): ModelIdLookupIndex {
  const byAlias = new Map<string, string[]>();
  const byBareId = new Map<string, string[]>();
  const seenBare = new Set<string>();
  const seenAliases = new Set<string>();
  for (const [candidateId, model] of Object.entries(models)) {
    const aliases = model.aliases;
    if (aliases !== undefined && aliases.length > 0) {
      seenAliases.clear();
      for (const alias of aliases) {
        if (seenAliases.has(alias)) continue;
        seenAliases.add(alias);
        let list = byAlias.get(alias);
        if (list === undefined) {
          list = [];
          byAlias.set(alias, list);
        }
        list.push(candidateId);
      }
    }
    seenBare.clear();
    addBareCandidate(byBareId, candidateId, candidateId, seenBare);
    addBareCandidate(byBareId, model.model, candidateId, seenBare);
  }
  return { byAlias, byBareId };
}

function isProviderPrefixConsistent(model: ModelRecord, prefix: string): boolean {
  const providerRef = nonEmpty(model.provider) ?? nonEmpty(model.providerId);
  if (providerRef === undefined) return true;
  return providerRef === prefix || providerRef.endsWith(`:${prefix}`);
}

/**
 * Resolves a configured model id or alias to its canonical key using a
 * precomputed index in O(1) time.
 */
export function resolveModelIdWithIndex(
  models: Readonly<Record<string, ModelRecord>>,
  index: ModelIdLookupIndex,
  id: string,
  onAmbiguous?: (resolution: AmbiguousModelIdResolution) => void,
): string | undefined {
  if (Object.hasOwn(models, id) && models[id] !== undefined) return id;

  const firstOf = (candidates: readonly string[]): string => {
    const resolved = candidates[0]!;
    onAmbiguous?.({ id, candidates, resolved });
    return resolved;
  };

  const aliasCandidates = index.byAlias.get(id);
  if (aliasCandidates !== undefined && aliasCandidates.length > 0) {
    return aliasCandidates.length === 1 ? aliasCandidates[0] : firstOf(aliasCandidates);
  }

  if (!id.includes('/')) {
    const candidates = index.byBareId.get(id);
    if (candidates === undefined || candidates.length === 0) return undefined;
    return candidates.length === 1 ? candidates[0] : firstOf(candidates);
  }

  const slash = id.lastIndexOf('/');
  const prefix = id.slice(0, slash);
  const tail = id.slice(slash + 1);
  if (tail.length === 0) return undefined;
  const record = Object.hasOwn(models, tail) ? models[tail] : undefined;
  if (record === undefined) return undefined;
  return isProviderPrefixConsistent(record, prefix) ? tail : undefined;
}

/**
 * Resolves a configured model id or alias to its canonical key. An ambiguous
 * alias (one name pointing at several configured models) is not an error: the
 * first candidate in catalog order wins deterministically and `onAmbiguous`
 * observes the pick so callers can surface it.
 */
export function resolveModelId(
  models: Readonly<Record<string, ModelRecord>>,
  id: string,
  onAmbiguous?: (resolution: AmbiguousModelIdResolution) => void,
): string | undefined {
  if (Object.hasOwn(models, id) && models[id] !== undefined) return id;

  const firstOf = (candidates: readonly string[]): string => {
    const resolved = candidates[0]!;
    onAmbiguous?.({ id, candidates, resolved });
    return resolved;
  };

  const aliasCandidates = Object.entries(models)
    .filter(([, model]) => (model.aliases ?? []).includes(id))
    .map(([candidateId]) => candidateId);
  if (aliasCandidates.length === 1) return aliasCandidates[0];
  if (aliasCandidates.length > 1) return firstOf(aliasCandidates);

  if (!id.includes('/')) {
    const candidates = Object.entries(models)
      .filter(
        ([candidateId, model]) =>
          matchesBareModelId(candidateId, id) || matchesBareModelId(model.model, id),
      )
      .map(([candidateId]) => candidateId);
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    return firstOf(candidates);
  }

  const slash = id.lastIndexOf('/');
  const prefix = id.slice(0, slash);
  const tail = id.slice(slash + 1);
  if (tail.length === 0) return undefined;
  const record = Object.hasOwn(models, tail) ? models[tail] : undefined;
  if (record === undefined) return undefined;
  return isProviderPrefixConsistent(record, prefix) ? tail : undefined;
}
