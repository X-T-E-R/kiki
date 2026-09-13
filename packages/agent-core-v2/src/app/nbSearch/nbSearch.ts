import type {
  CapabilityEnvelope,
  FetchRunSyncEnvelope,
  OperationContext,
  SearchRunSyncEnvelope,
} from '@nb-corp/nb-search';

import type { NbSearchConfigSourceStatus } from '@kiki/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { NbSearchConfig } from './configSection';

export type NbSearchCapabilities = CapabilityEnvelope & { config_source?: NbSearchConfigSourceStatus };

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

export interface FetchFileIdentity { readonly dev: string; readonly ino: string }

export interface INbSearchService {
  captureFetchFileIdentity(path: string): Promise<FetchFileIdentity>;
  readonly _serviceBrand: undefined;

  search(query: string, context?: OperationContext, lane?: string): Promise<SearchRunSyncEnvelope>;
  search(input: import('@nb-corp/nb-search').SearchInput, context?: OperationContext): Promise<import('@nb-corp/nb-search').SearchEnvelope>;
  fetch(url: string, context?: OperationContext): Promise<FetchRunSyncEnvelope>;
  fetch(input: import('@nb-corp/nb-search').FetchInput, context?: OperationContext, admittedFile?: string, identity?: FetchFileIdentity): Promise<import('@nb-corp/nb-search').FetchEnvelope>;
  resolveFetchFile(input: import('@nb-corp/nb-search').FetchRunInput): Promise<string | undefined>;
  prepareToolDescriptions(): Promise<void>;
  toolDescription(tool: 'WebSearch' | 'FetchURL'): string;
  capabilities(context?: OperationContext): Promise<NbSearchCapabilities>;
  test(context?: OperationContext): Promise<NbSearchTestStatus>;
  validateConfiguration(config: NbSearchConfig, reuseLocalConfig: boolean): Promise<void>;
}

export const INbSearchService: ServiceIdentifier<INbSearchService> =
  createDecorator<INbSearchService>('nbSearchService');
