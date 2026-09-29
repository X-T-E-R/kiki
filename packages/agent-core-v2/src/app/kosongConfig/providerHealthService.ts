import { createHash } from 'node:crypto';

import type { ProviderConnectionTestResult } from '@kiki/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelCatalogMutationService } from './modelCatalogMutation';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

interface StoredHealth {
  readonly revision: string;
  readonly result: ProviderConnectionTestResult;
}

export interface IProviderHealthService {
  readonly _serviceBrand: undefined;
  latest(providerId: string): Promise<ProviderConnectionTestResult | undefined>;
  test(providerId: string): Promise<ProviderConnectionTestResult>;
}

export const IProviderHealthService: ServiceIdentifier<IProviderHealthService> =
  createDecorator<IProviderHealthService>('providerHealth');

export class ProviderHealthService implements IProviderHealthService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IModelCatalog private readonly catalog: IModelCatalog,
    @IModelCatalogMutationService private readonly mutations: IModelCatalogMutationService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
  ) {}

  private get scope(): string { return this.bootstrap.scope('store'); }

  private key(providerId: string): string {
    return `provider-health-${createHash('sha256').update(providerId).digest('hex')}`;
  }

  async latest(providerId: string): Promise<ProviderConnectionTestResult | undefined> {
    await this.config.ready;
    const provider = await this.mutations.readProvider(providerId);
    const saved = await this.docs.get<StoredHealth>(this.scope, this.key(providerId));
    return saved?.revision === provider.revision ? saved.result : undefined;
  }

  async test(providerId: string): Promise<ProviderConnectionTestResult> {
    await this.config.ready;
    const provider = await this.mutations.readProvider(providerId);
    const started = Date.now();
    const models = await this.catalog.listModels();
    const modelId = models.find((model) => model.provider_id === providerId)?.id;
    let result: ProviderConnectionTestResult;
    if (modelId === undefined) {
      result = {
        provider_id: providerId, ok: false, checked_at: started,
        duration_ms: Date.now() - started, error_code: 'model_not_configured',
        error: 'Add a model to this connection before testing it.',
      };
    } else {
      try {
        const ping = await this.catalog.ping(modelId);
        result = {
          provider_id: providerId, model_id: modelId, ok: ping.ok, checked_at: started,
          duration_ms: ping.durationMs,
          ...(ping.ok ? {} : {
            error_code: ping.errorCode ?? 'request_failed',
            ...(ping.httpStatus === undefined ? {} : { http_status: ping.httpStatus }),
            error: ping.httpStatus === undefined
              ? 'The test request failed.' : `The test request failed (HTTP ${ping.httpStatus}).`,
          }),
        };
      } catch {
        result = {
          provider_id: providerId, model_id: modelId, ok: false, checked_at: started,
          duration_ms: Date.now() - started, error_code: 'model_unavailable',
          error: 'The configured model could not be used for a test request.',
        };
      }
    }
    await this.docs.set(this.scope, this.key(providerId), { revision: provider.revision, result });
    return result;
  }
}

registerScopedService(
  LifecycleScope.App, IProviderHealthService, ProviderHealthService,
  ScopeActivation.OnDemand, 'kosongConfig',
);
