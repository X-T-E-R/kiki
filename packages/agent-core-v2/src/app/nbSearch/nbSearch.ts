import type {
  CapabilityEnvelope,
  FetchRunSyncEnvelope,
  OperationContext,
  SearchRunSyncEnvelope,
} from '@nb-corp/nb-search';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface NbSearchReadiness {
  readonly configured: boolean;
  readonly available: boolean;
  readonly selection?: string;
  readonly issues: readonly string[];
}

export interface NbSearchTestStatus {
  readonly revision: string;
  readonly search: NbSearchReadiness;
  readonly fetch: NbSearchReadiness;
}

export interface INbSearchService {
  readonly _serviceBrand: undefined;

  search(query: string, context?: OperationContext): Promise<SearchRunSyncEnvelope>;
  fetch(url: string, context?: OperationContext): Promise<FetchRunSyncEnvelope>;
  capabilities(context?: OperationContext): Promise<CapabilityEnvelope>;
  test(context?: OperationContext): Promise<NbSearchTestStatus>;
}

export const INbSearchService: ServiceIdentifier<INbSearchService> =
  createDecorator<INbSearchService>('nbSearchService');
