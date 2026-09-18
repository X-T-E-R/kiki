import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type {
  CreateModelRequest,
  CreateProviderRequest,
  ModelEntity,
  PatchModelRequest,
  PatchProviderRequest,
  ProviderCatalogItem,
} from '@kiki/protocol';

/**
 * Stable, machine-readable configuration problems a single model entity can
 * report. The client localizes them; the engine never reports a problem only
 * as prose. `error` means the model cannot currently be built into a
 * requester, `warning` means it is usable but incomplete.
 */
export const ModelIssueCodes = {
  REMOTE_ID_MISSING: 'model.remote_id_missing',
  PROVIDER_MISSING: 'model.provider_missing',
  ENDPOINT_MISSING: 'model.endpoint_missing',
  CONTEXT_MISSING: 'model.max_context_size_missing',
  PROTOCOL_UNRESOLVED: 'model.protocol_unresolved',
  REQUEST_IDENTITY_INVALID: 'model.request_identity_invalid',
} as const;

/** A provider projection plus the compare-and-swap token of its stored entity. */
export interface ProviderEntity extends ProviderCatalogItem {
  readonly revision: string;
}

/**
 * The single write path for the `[providers]` / `[models]` config tables.
 * REST, the klient facade, the CLI and the GUI all mutate through it, so an
 * edit always writes exactly one entity and can never rebuild a sibling.
 *
 * Payloads are the public wire shapes (`@kiki/protocol`); the config records
 * stay camelCase internally. Every write is serialized, checks the caller's
 * `base_revision` (a content hash of the stored entity) against the stored
 * entity, and lands in one config transaction, so a concurrent edit is
 * reported as a conflict instead of silently overwriting the other writer.
 *
 * A patch omits what it does not change: an absent field keeps its stored
 * value (including values this engine version does not know), while an
 * explicit `null` clears it — the config writer copies the resulting own
 * `undefined` marker into the TOML layer, which is what removes the key.
 */
export interface IModelCatalogMutationService {
  readonly _serviceBrand: undefined;

  readModel(id: string): Promise<ModelEntity>;
  createModel(input: CreateModelRequest): Promise<ModelEntity>;
  updateModel(id: string, patch: PatchModelRequest): Promise<ModelEntity>;
  deleteModel(id: string, options?: { readonly baseRevision?: string }): Promise<void>;

  readProvider(id: string): Promise<ProviderEntity>;
  createProvider(input: CreateProviderRequest): Promise<ProviderEntity>;
  updateProvider(id: string, patch: PatchProviderRequest): Promise<ProviderEntity>;
  deleteProvider(id: string): Promise<void>;
}

export const IModelCatalogMutationService: ServiceIdentifier<IModelCatalogMutationService> =
  createDecorator<IModelCatalogMutationService>('modelCatalogMutation');
