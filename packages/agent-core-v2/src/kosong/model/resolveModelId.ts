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

function isProviderPrefixConsistent(model: ModelRecord, prefix: string): boolean {
  const providerRef = nonEmpty(model.provider) ?? nonEmpty(model.providerId);
  if (providerRef === undefined) return true;
  return providerRef === prefix || providerRef.endsWith(`:${prefix}`);
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
  if (models[id] !== undefined) return id;

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
  const record = models[tail];
  if (record === undefined) return undefined;
  return isProviderPrefixConsistent(record, prefix) ? tail : undefined;
}
