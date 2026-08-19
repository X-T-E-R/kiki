import { Error2 } from '#/_base/errors/errors';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';

import type { ModelRecord } from './model';
import { nonEmpty } from './modelAuth';

function matchesBareModelId(value: string | undefined, id: string): boolean {
  return value === id || value?.endsWith(`/${id}`) === true;
}

function throwAmbiguousModelId(id: string, candidates: readonly string[]): never {
  const quotedCandidates = candidates.map((candidate) => `"${candidate}"`).join(', ');
  throw new Error2(
    CONFIG_INVALID_ERROR_CODE,
    `Model "${id}" matches multiple configured models: ${quotedCandidates}. Use a full model id to disambiguate.`,
    { details: { model: id, candidates } },
  );
}

function isProviderPrefixConsistent(model: ModelRecord, prefix: string): boolean {
  const providerRef = nonEmpty(model.provider) ?? nonEmpty(model.providerId);
  if (providerRef === undefined) return true;
  return providerRef === prefix || providerRef.endsWith(`:${prefix}`);
}

export function resolveModelId(
  models: Readonly<Record<string, ModelRecord>>,
  id: string,
): string | undefined {
  if (models[id] !== undefined) return id;

  const aliasCandidates = Object.entries(models)
    .filter(([, model]) => (model.aliases ?? []).includes(id))
    .map(([candidateId]) => candidateId)
    .toSorted();
  if (aliasCandidates.length === 1) return aliasCandidates[0];
  if (aliasCandidates.length > 1) throwAmbiguousModelId(id, aliasCandidates);

  if (!id.includes('/')) {
    const candidates = Object.entries(models)
      .filter(
        ([candidateId, model]) =>
          matchesBareModelId(candidateId, id) || matchesBareModelId(model.model, id),
      )
      .map(([candidateId]) => candidateId)
      .toSorted();
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    throwAmbiguousModelId(id, candidates);
  }

  const slash = id.lastIndexOf('/');
  const prefix = id.slice(0, slash);
  const tail = id.slice(slash + 1);
  if (tail.length === 0) return undefined;
  const record = models[tail];
  if (record === undefined) return undefined;
  return isProviderPrefixConsistent(record, prefix) ? tail : undefined;
}
