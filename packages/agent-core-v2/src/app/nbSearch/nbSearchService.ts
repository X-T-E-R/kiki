import {
  createNbSearchRuntime,
  type CapabilityEnvelope,
  type FetchRunSyncEnvelope,
  type NbSearchRuntime,
  type OperationContext,
  type SearchRunSyncEnvelope,
} from '@nb-corp/nb-search';

import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';

import { NB_SEARCH_SECTION, type NbSearchConfig } from './configSection';
import { INbSearchService, type NbSearchReadiness, type NbSearchTestStatus } from './nbSearch';

export class NbSearchService extends Disposable implements INbSearchService {
  declare readonly _serviceBrand: undefined;

  private runtime: NbSearchRuntime;

  constructor(@IConfigService private readonly config: IConfigService) {
    super();
    this.runtime = this.createRuntime(config.get<NbSearchConfig | undefined>(NB_SEARCH_SECTION));
    this._register(
      config.onDidChangeConfiguration((event) => {
        if (event.domain === NB_SEARCH_SECTION) {
          this.runtime = this.createRuntime(event.value as NbSearchConfig | undefined);
        }
      }),
    );
  }

  search(query: string, context?: OperationContext): Promise<SearchRunSyncEnvelope> {
    return this.runtime.search({ action: 'run', query }, context) as Promise<SearchRunSyncEnvelope>;
  }

  fetch(url: string, context?: OperationContext): Promise<FetchRunSyncEnvelope> {
    return this.runtime.fetch({ url }, context) as Promise<FetchRunSyncEnvelope>;
  }

  capabilities(context?: OperationContext): Promise<CapabilityEnvelope> {
    return this.runtime.capabilities({}, context);
  }

  async test(context?: OperationContext): Promise<NbSearchTestStatus> {
    const capabilities = await this.capabilities(context);
    return {
      revision: capabilities.revision,
      search: searchReadiness(capabilities),
      fetch: fetchReadiness(capabilities),
    };
  }

  private createRuntime(config: NbSearchConfig | undefined): NbSearchRuntime {
    return createNbSearchRuntime({ env: process.env, config });
  }
}

function searchReadiness(capabilities: CapabilityEnvelope): NbSearchReadiness {
  const selection = capabilities.search.default_lane;
  if (selection === undefined) {
    return { configured: false, available: false, issues: ['DEFAULT_NOT_CONFIGURED'] };
  }
  const lane = capabilities.search.lanes.find((candidate) => candidate.id === selection);
  const issues = lane?.issues.map((issue) => issue.code) ?? ['LANE_NOT_REGISTERED'];
  return {
    configured: true,
    available: lane?.availability === 'ready' && lane.execution_modes.includes('sync'),
    selection,
    issues,
  };
}

function fetchReadiness(capabilities: CapabilityEnvelope): NbSearchReadiness {
  const chain = capabilities.fetch.chains.find(
    (candidate) => candidate.input_kind === 'url' && candidate.representation === 'markdown',
  );
  if (chain === undefined) {
    return { configured: false, available: false, issues: ['FETCH_DEFAULT_NOT_CONFIGURED'] };
  }
  const pipelines = chain.pipelines.map((id) =>
    capabilities.fetch.pipelines.find((candidate) => candidate.id === id),
  );
  const issues = pipelines.flatMap(
    (pipeline) => pipeline?.issues.map((issue) => issue.code) ?? ['LANE_NOT_REGISTERED'],
  );
  const available = pipelines.some(
    (pipeline) => pipeline?.availability === 'ready' && pipeline.execution_modes.includes('sync'),
  );
  return {
    configured: true,
    available,
    selection: chain.pipelines.join(' -> '),
    issues: available ? issues : [...issues, 'FETCH_CHAIN_UNAVAILABLE'],
  };
}

registerScopedService(
  LifecycleScope.App,
  INbSearchService,
  NbSearchService,
  ScopeActivation.OnScopeCreated,
  'nbSearch',
);
