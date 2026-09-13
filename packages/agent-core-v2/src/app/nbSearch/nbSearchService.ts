import {
  type CapabilityEnvelope,
  type FetchRunSyncEnvelope,
  type NbSearchRuntime,
  type OperationContext,
  type SearchRunSyncEnvelope,
} from '@nb-corp/nb-search';

import { createHostedNbSearchRuntime as createNbSearchRuntime } from './runtimeLauncher';
import type { NbSearchConfigSourceStatus } from '@kiki/protocol';

import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';

import { NB_SEARCH_SECTION, NB_SEARCH_SOURCE_SECTION, type NbSearchConfig, type NbSearchSourceConfig } from './configSection';
import { nbSearchConfigIssues, nbSearchConfigRevision, resolveNbSearchConfig, pinnedNbSearchConfig } from './donorConfig';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { INbSearchService, type NbSearchCapabilities, type NbSearchReadiness, type NbSearchTestStatus } from './nbSearch';
import { INbSearchSourceStore } from './sourceStore';
import { describeCapabilities } from './toolDescriptions';

export class NbSearchService implements INbSearchService {
  declare readonly _serviceBrand: undefined;
  readonly #configListener;
  #generation = 0;
  #descriptionSnapshot: { expiresAt: number; search: string; fetch: string } | undefined;
  #preparing: Promise<void> | undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @INbSearchSourceStore private readonly sources: INbSearchSourceStore,
  ) {
    this.#configListener = config.onDidChangeConfiguration((event) => {
      if (event.domain !== NB_SEARCH_SECTION && event.domain !== NB_SEARCH_SOURCE_SECTION) return;
      this.#generation++;
      this.#descriptionSnapshot = undefined;
      this.#preparing = undefined;
    });
  }

  dispose(): void {
    this.#configListener.dispose();
  }

  toolDescription(tool: 'WebSearch' | 'FetchURL'): string {
    const snapshot = this.#descriptionSnapshot;
    if (snapshot === undefined) return 'nb-search capability snapshot not prepared; availability and defaults are unknown. No search skill or CLI is required for this native tool.';
    return tool === 'WebSearch' ? snapshot.search : snapshot.fetch;
  }

  async prepareToolDescriptions(): Promise<void> {
    if (this.#descriptionSnapshot !== undefined && this.#descriptionSnapshot.expiresAt > Date.now()) return;
    if (this.#preparing !== undefined) return this.#preparing;
    const generation = this.#generation;
    const preparing = this.capabilities().then((capabilities) => {
      if (generation !== this.#generation) return;
      this.#descriptionSnapshot = describeCapabilities(capabilities);
    }).catch(() => {
      if (generation !== this.#generation) return;
      const unavailable = 'nb-search capability snapshot unavailable. Do not assume a configured default or usable lane. Native tool execution will report configuration errors; no skill or CLI is required.';
      this.#descriptionSnapshot = { expiresAt: Date.now() + 60_000, search: unavailable, fetch: unavailable };
    }).finally(() => {
      if (this.#preparing === preparing) this.#preparing = undefined;
    });
    this.#preparing = preparing;
    await preparing;
    if (generation !== this.#generation) await this.prepareToolDescriptions();
  }

  search(query: string, context?: OperationContext, lane?: string): Promise<SearchRunSyncEnvelope>;
  search(input: import('@nb-corp/nb-search').SearchInput, context?: OperationContext): Promise<import('@nb-corp/nb-search').SearchEnvelope>;
  async search(input: string | import('@nb-corp/nb-search').SearchInput, context?: OperationContext, lane?: string): Promise<import('@nb-corp/nb-search').SearchEnvelope> {
    const runtime = await this.#requireRuntime();
    return runtime.search(typeof input === 'string' ? { action: 'run', query: input, lane } : input, context);
  }

  async captureFetchFileIdentity(path: string): Promise<import('./nbSearch').FetchFileIdentity> {
    const donor = await import('@nb-corp/nb-search');
    const capture = Reflect.get(donor, 'captureFetchFileIdentity') as ((path: string) => Promise<import('./nbSearch').FetchFileIdentity>) | undefined;
    if (typeof capture !== 'function') throw new Error2(ErrorCodes.REQUEST_INVALID, 'FETCH_FILE_BLOCKED: this donor build cannot capture approved file identity.');
    return capture(path);
  }

  fetch(url: string, context?: OperationContext): Promise<FetchRunSyncEnvelope>;
  fetch(input: import('@nb-corp/nb-search').FetchInput, context?: OperationContext, admittedFile?: string, identity?: import('./nbSearch').FetchFileIdentity): Promise<import('@nb-corp/nb-search').FetchEnvelope>;
  async fetch(input: string | import('@nb-corp/nb-search').FetchInput, context?: OperationContext, admittedFile?: string, identity?: import('./nbSearch').FetchFileIdentity): Promise<import('@nb-corp/nb-search').FetchEnvelope> {
    const admission = typeof input !== 'string' && 'source' in input && input.source.kind === 'file' && admittedFile !== undefined ? { source: input.source, path: admittedFile, identity } : undefined;
    const runtime = await this.#requireRuntime(admission);
    return runtime.fetch(typeof input === 'string' ? { url: input } : input, context);
  }

  async resolveFetchFile(input: import('@nb-corp/nb-search').FetchRunInput): Promise<string | undefined> {
    if (input.source.kind !== 'file') return undefined;
    const source = input.source;
    await this.config.ready;
    const config = this.config.get<NbSearchConfig | undefined>(NB_SEARCH_SECTION);
    return this.sources.withSource(this.config.get<NbSearchSourceConfig | undefined>(NB_SEARCH_SOURCE_SECTION)?.reuse_local_config ?? true, config, (resolved) => {
      if (resolved.status.availability === 'unavailable') throw configurationError(resolved.status);
      return fetchFilePath(resolveNbSearchConfig(resolved.env, resolved.config, config), source);
    });
  }

  async capabilities(context?: OperationContext): Promise<NbSearchCapabilities> {
    const { runtime, status } = await this.#currentRuntime();
    if (runtime === undefined) return unavailableCapabilities(status);
    const capabilities = await runtime.capabilities({}, context);
    return { ...capabilities, config_source: status };
  }

  async test(context?: OperationContext): Promise<NbSearchTestStatus> {
    const capabilities = await this.capabilities(context);
    const unavailable = capabilities.config_source?.availability === 'unavailable';
    const failure: NbSearchReadiness = {
      configured: false, available: false, issues: capabilities.config_source?.issues ?? [],
    };
    return {
      revision: capabilities.revision,
      search: unavailable ? failure : searchReadiness(capabilities),
      fetch: unavailable ? failure : fetchReadiness(capabilities),
    };
  }

  async validateConfiguration(config: NbSearchConfig, reuseLocalConfig: boolean): Promise<void> {
    const { runtime, status } = await this.#createRuntime(config, reuseLocalConfig);
    if (runtime === undefined) throw configurationError(status);
  }

  async #requireRuntime(admission?: FetchFileAdmission): Promise<NbSearchRuntime> {
    const { runtime, status } = await this.#currentRuntime(admission);
    if (runtime === undefined) throw configurationError(status);
    return runtime;
  }

  async #currentRuntime(admission?: FetchFileAdmission) {
    await this.config.ready;
    return this.#createRuntime(
      this.config.get<NbSearchConfig | undefined>(NB_SEARCH_SECTION),
      this.config.get<NbSearchSourceConfig | undefined>(NB_SEARCH_SOURCE_SECTION)?.reuse_local_config ?? true,
      admission,
    );
  }

  async #createRuntime(config: NbSearchConfig | undefined, reuseLocalConfig: boolean, admission?: FetchFileAdmission): Promise<{
    runtime?: NbSearchRuntime;
    status: NbSearchConfigSourceStatus;
  }> {
    return this.sources.withSource(reuseLocalConfig, config, async (source) => {
      const { env, status } = source;
      if (status.availability === 'unavailable') return { status };
      try {
        const mismatch = () => ({ status: { ...status, availability: 'unavailable' as const, local_credentials: 'rejected' as const, issues: ['LOCAL_CONFIG_RESOLVER_MISMATCH'] } });
        const effective = admission === undefined ? undefined : resolveNbSearchConfig(env, source.config, config);
        if (admission !== undefined && effective !== undefined && fetchFilePath(effective, admission.source) !== admission.path) throw new Error2(ErrorCodes.REQUEST_INVALID, 'FETCH_FILE_BLOCKED: configured scope changed after file admission.');
        const baseline = createNbSearchRuntime({ env, config: effective === undefined ? source.config ?? config : pinnedNbSearchConfig(effective) });
        if (source.expectedRevision !== undefined && (await baseline.capabilities({})).revision !== source.expectedRevision) return mismatch();
        if (admission === undefined || effective === undefined) return { runtime: baseline, status };
        const scoped = { ...effective, fetch: { ...effective.fetch, file_scopes: effective.fetch.file_scopes.map((scope) => {
          if (scope.id !== admission.source.scope) return scope;
          if ('canonical_target' in scope && scope.canonical_target !== undefined && scope.canonical_target !== admission.path) throw new Error2(ErrorCodes.REQUEST_INVALID, 'FETCH_FILE_BLOCKED: configured canonical target does not match admission.');
          if (admission.identity === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'FETCH_FILE_BLOCKED: approved file identity is missing. Retry file admission.');
          if ('approved_identity' in scope && scope.approved_identity !== undefined && JSON.stringify(scope.approved_identity) !== JSON.stringify(admission.identity)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'FETCH_FILE_BLOCKED: configured file identity does not match admission.');
          return { ...scope, canonical_target: admission.path, approved_identity: admission.identity };
        }) } };
        const runtime = createNbSearchRuntime({ env, config: pinnedNbSearchConfig(scoped) });
        if ((await runtime.capabilities({})).revision !== nbSearchConfigRevision(scoped)) return mismatch();
        return { runtime, status };
      } catch (error) {
        if (error instanceof Error2 && error.code === ErrorCodes.REQUEST_INVALID) throw error;
        return {
          status: {
            ...status,
            availability: 'unavailable',
            issues: nbSearchConfigIssues(error, source.config ?? config),
          },
        };
      }
    });
  }
}

interface FetchFileAdmission {
  readonly source: Extract<import('@nb-corp/nb-search').FetchRunInput['source'], { kind: 'file' }>;
  readonly path: string;
  readonly identity?: import('./nbSearch').FetchFileIdentity;
}

function fetchFilePath(config: import('@nb-corp/nb-search').CanonicalConfig, source: FetchFileAdmission['source']): string {
  const scope = config.fetch.file_scopes.find((candidate) => candidate.id === source.scope);
  if (scope === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'FETCH_SCOPE_NOT_FOUND: the selected file scope is not configured.');
  const root = resolve(scope.root);
  const path = resolve(root, source.path);
  const inside = relative(root, path);
  if (isAbsolute(source.path) || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'FETCH_FILE_BLOCKED: file path must remain relative to its configured scope.');
  return path;
}

function configurationError(status: NbSearchConfigSourceStatus): Error2 {
  return new Error2(ErrorCodes.CONFIG_INVALID, `nb-search configuration unavailable (${status.issues.join(', ')}). Check the selected configuration source and retry.`);
}

function unavailableCapabilities(status: NbSearchConfigSourceStatus): NbSearchCapabilities {
  return {
    config_source: status,
    schema_version: '3.0',
    revision: 'unavailable',
    providers: { descriptors: [], instances: [] },
    search: { lanes: [], presets: [], limits: { max_queries: 0, max_results: 0, max_timeout_ms: 0, max_inline_bytes: 0 } },
    fetch: {
      default_representation: 'markdown', inputs: [], chains: [], pipelines: [],
      limits: { max_source_bytes: 0, max_response_bytes: 0, max_content_chars: 0, max_redirects: 0, max_timeout_ms: 0, max_inline_bytes: 0 },
    },
    jobs: { result_ttl_seconds: 0, cancel_supported: true },
  };
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
