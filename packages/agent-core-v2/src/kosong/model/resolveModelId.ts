/**
 * `kosong/model` domain — pure model-id resolution against a `[models]` table.
 *
 * Shared by `ModelService.resolveId` and `kimi doctor` so runtime lookup and
 * config validation cannot drift. Operates on a plain record; no service
 * graph. Ambiguous ids throw `Error2` with `config.invalid`.
 *
 * Precedence: exact table key → exact `aliases` entry → bare-name tail match
 * (key or wire `model`) → provider-qualified tail match.
 */

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

/**
 * A provider-qualified prefix is consistent with a record when it equals the
 * provider identity, or when that identity is a namespaced value ending in
 * `:<prefix>` (e.g. `managed:kimi-code` vs prefix `kimi-code`).
 *
 * Identity is `provider`, falling back to `providerId` only when `provider` is
 * unset — the same two fields `CatalogService.resolveProviderContext` reads,
 * ordered so the legacy `provider` spelling (where `managed:` prefixes live)
 * wins when both are present. A missing identity accepts any prefix; a present
 * identity that matches neither rule rejects rather than ignoring the provider.
 */
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
