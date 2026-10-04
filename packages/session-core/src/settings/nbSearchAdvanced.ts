import type { NbSearchCapabilities, NbSearchConfigPatch } from '@kiki/protocol';
import type { NbSearchDraft } from './nbSearch';

type LaneConfig = NonNullable<NonNullable<NbSearchConfigPatch['lanes']>[string]>;
type PresetConfig = NonNullable<NonNullable<NbSearchConfigPatch['presets']>[string]>;
export type NbSearchFileScopeDraft = NonNullable<NonNullable<NbSearchConfigPatch['fetch']>['file_scopes']>[number];
export type NbSearchInputKind = NbSearchCapabilities['fetch']['inputs'][number]['kind'];
export type NbSearchRepresentation = 'markdown' | 'text';
export interface NbSearchFetchChainDraft {
  readonly inputKind: NbSearchInputKind;
  readonly representation: NbSearchRepresentation;
  readonly pipelines: readonly string[];
  readonly inherited: boolean;
  readonly inheritedPipelines?: readonly string[];
}
export interface NbSearchAdvancedDraft {
  readonly lanes: Readonly<Record<string, LaneConfig | null>>;
  readonly presets: Readonly<Record<string, PresetConfig | null>>;
  /** Undefined restores the source/default scopes; [] explicitly replaces them with none. */
  readonly fileScopes?: readonly NbSearchFileScopeDraft[];
  /** Undefined restores inheritance; null clears inherited routing configuration. */
  readonly routing?: NonNullable<NbSearchConfigPatch['fetch']>['routing'];
  readonly fetchChains: readonly NbSearchFetchChainDraft[];
  readonly qualityMinContentChars: string;
  /** Undefined inherits; [] explicitly removes all blocked markers. */
  readonly qualityBlockedMarkers?: readonly string[];
}
export interface NbSearchReferenceIssue {
  readonly code: 'instance' | 'operation' | 'lane' | 'preset-results' | 'pipeline' | 'pipeline-incompatible';
  readonly path: string;
  readonly target: string;
}

export class NbSearchReferenceError extends Error {
  constructor(readonly issues: readonly NbSearchReferenceIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.code} (${issue.target})`).join('; '));
    this.name = 'NbSearchReferenceError';
  }
}

export function nbSearchExecutionKind(modes: readonly string[]): 'sync' | 'async-only' | 'none' {
  return modes.includes('sync') ? 'sync' : modes.includes('async') ? 'async-only' : 'none';
}

export function nbSearchCompatiblePipelines(
  capabilities: NbSearchCapabilities, inputKind: NbSearchInputKind, representation: NbSearchRepresentation,
): NbSearchCapabilities['fetch']['pipelines'] {
  return capabilities.fetch.pipelines.filter((pipeline) =>
    pipeline.input_kinds.includes(inputKind) && pipeline.representations.includes(representation));
}

export function nbSearchAdvancedDraftFromConfig(
  config: NbSearchConfigPatch | undefined, capabilities: NbSearchCapabilities,
): NbSearchAdvancedDraft {
  const chains = config?.defaults?.fetch_chain ?? [];
  const quality = config?.execution?.fetch?.quality;
  return {
    lanes: structuredClone(config?.lanes ?? {}),
    presets: structuredClone(config?.presets ?? {}),
    fileScopes: config?.fetch?.file_scopes === undefined || config.fetch.file_scopes === null ? undefined : structuredClone(config.fetch.file_scopes),
    routing: config?.fetch?.routing === undefined ? undefined : structuredClone(config.fetch.routing),
    fetchChains: (['url', 'inline_text', 'inline_bytes', 'file'] as const).flatMap((inputKind) =>
      (['markdown', 'text'] as const).map((representation) => {
        const own = chains.find((chain) => chain.input_kind === inputKind && (chain.representation ?? 'markdown') === representation);
        const effective = capabilities.fetch.chains.find((chain) => chain.input_kind === inputKind && (chain.representation ?? 'markdown') === representation);
        const inheritedChain = capabilities.inherited_configuration?.fetch_chains.find((chain) => chain.input_kind === inputKind && (chain.representation ?? 'markdown') === representation);
        const inheritedPipelines = capabilities.inherited_configuration === undefined ? undefined : [...(inheritedChain?.pipelines ?? [])];
        return { inputKind, representation, pipelines: [...(own?.pipelines ?? inheritedPipelines ?? effective?.pipelines ?? [])], inherited: own === undefined, inheritedPipelines };
      })),
    qualityMinContentChars: quality?.min_content_chars === undefined ? '' : String(quality.min_content_chars),
    qualityBlockedMarkers: quality?.blocked_markers === undefined ? undefined : [...quality.blocked_markers],
  };
}

export function setNbSearchFetchChain(
  draft: NbSearchDraft, inputKind: NbSearchInputKind, representation: NbSearchRepresentation,
  pipelines: readonly string[], inherited = false,
): NbSearchDraft {
  if (draft.advanced === undefined) throw new Error('Advanced draft is not initialized.');
  const fetchChains = draft.advanced.fetchChains.map((chain) => chain.inputKind === inputKind && chain.representation === representation
    ? { ...chain, pipelines: [...(inherited ? chain.inheritedPipelines ?? pipelines : pipelines)], inherited } : chain);
  return {
    ...draft,
    fetchChain: inputKind === 'url' && representation === 'markdown' ? [...fetchChains.find((chain) => chain.inputKind === inputKind && chain.representation === representation)!.pipelines] : draft.fetchChain,
    fetchChainInherited: inputKind === 'url' && representation === 'markdown' ? inherited : draft.fetchChainInherited,
    advanced: { ...draft.advanced, fetchChains },
  };
}

export function setNbSearchLane(draft: NbSearchDraft, id: string, lane: LaneConfig | undefined): NbSearchDraft {
  if (draft.advanced === undefined) throw new Error('Advanced draft is not initialized.');
  const lanes = { ...draft.advanced.lanes };
  if (lane === undefined) delete lanes[id];
  else lanes[id] = structuredClone({ ...lanes[id], ...lane, evidence_groups: lane.evidence_groups });
  return { ...draft, advanced: { ...draft.advanced, lanes } };
}

export function setNbSearchPreset(draft: NbSearchDraft, id: string, preset: PresetConfig | undefined): NbSearchDraft {
  if (draft.advanced === undefined) throw new Error('Advanced draft is not initialized.');
  const presets = { ...draft.advanced.presets };
  if (preset === undefined) delete presets[id];
  else presets[id] = structuredClone({ ...presets[id], ...preset });
  return { ...draft, advanced: { ...draft.advanced, presets } };
}

/** Reports references before deletion; removing a local override restores inheritance, not a global disable. */
export function nbSearchLaneReferences(draft: NbSearchDraft, laneId: string, capabilities?: NbSearchCapabilities): string[] {
  const defaultLane = draft.defaultSearchLane === ''
    ? capabilities?.inherited_configuration === undefined ? capabilities?.search.default_lane : capabilities.inherited_configuration.default_search_lane
    : draft.defaultSearchLane;
  return [
    ...(defaultLane === laneId ? ['defaults.search_lane'] : []),
    ...Object.entries({ ...capabilities?.inherited_configuration?.presets, ...draft.advanced?.presets }).filter(([, preset]) => preset?.lanes.includes(laneId)).map(([id]) => `presets.${id}`),
    ...(draft.advanced?.fetchChains ?? []).filter((chain) => chain.pipelines.includes(laneId)).map((chain) => `defaults.fetch_chain.${chain.inputKind}.${chain.representation}`),
    ...(draft.advanced?.routing === null ? [] : draft.advanced?.routing?.rules ?? capabilities?.inherited_configuration?.routing?.rules ?? []).filter((rule) => 'pipelines' in rule.action && rule.action.pipelines.includes(laneId)).map((rule) => `fetch.routing.rules.${rule.id}`),
  ];
}

export function nbSearchProviderReferences(draft: NbSearchDraft, instanceId: string, capabilities?: NbSearchCapabilities): string[] {
  return Object.entries({ ...capabilities?.inherited_configuration?.lanes, ...draft.advanced?.lanes }).filter(([, lane]) => lane?.provider_instance_id === instanceId).map(([id]) => `lanes.${id}`);
}

/** IDs are caller-owned stable identities. No provider.default inference or shared credential slot. */
export function createNbSearchProviderInstance(
  draft: NbSearchDraft, capabilities: NbSearchCapabilities, providerId: string, instanceId: string, credentialEnv?: string,
): NbSearchDraft {
  if (!capabilities.providers.descriptors.some((descriptor) => descriptor.provider_id === providerId)) throw new Error(`Unknown provider: ${providerId}`);
  if (instanceId.trim() !== instanceId || instanceId.length === 0 || instanceId.length > 256 || draft.providers[instanceId] !== undefined) throw new Error(`Duplicate or invalid instance ID: ${instanceId}`);
  const requiresKey = capabilities.providers.descriptors.find((descriptor) => descriptor.provider_id === providerId)!.activation.credential === 'required';
  if (requiresKey && (!credentialEnv || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnv))) throw new Error('A new credentialed instance requires its own environment binding.');
  if (credentialEnv && Object.values(draft.credentialSlots ?? {}).some((slot) => slot?.env === credentialEnv)) throw new Error('Credential environment binding is already used.');
  if (draft.credentialSlots?.[instanceId] !== undefined) throw new Error('Credential slot ID is already used.');
  return {
    ...draft,
    providers: { ...draft.providers, [instanceId]: { providerId, enabled: true, baseUrl: '', credentialSlotId: instanceId, credentialSlotExplicit: requiresKey, optionsJson: '', isNew: true } },
    credentialSlots: credentialEnv ? { ...draft.credentialSlots, [instanceId]: { provider_id: providerId, env: credentialEnv } } : draft.credentialSlots,
  };
}

/** Gate new/changed references and dependents of deleted/rebound objects, not unrelated persisted catalog gaps. */
export function validateNbSearchReferences(
  config: NbSearchConfigPatch | undefined, draft: NbSearchDraft, capabilities: NbSearchCapabilities,
): NbSearchReferenceIssue[] {
  const advanced = draft.advanced;
  if (advanced === undefined) return [];
  const issues: NbSearchReferenceIssue[] = [];
  const add = (code: NbSearchReferenceIssue['code'], path: string, target: string) => issues.push({ code, path, target });
  const baseline = nbSearchAdvancedDraftFromConfig(config, capabilities);
  const inheritedLanes = capabilities.inherited_configuration?.lanes ?? {};
  const baselineLanes = { ...capabilities.configuration?.lanes, ...inheritedLanes, ...baseline.lanes };
  const removedLanes = new Set(Object.keys(config?.lanes ?? {}).filter((id) => (advanced.lanes[id] === undefined || advanced.lanes[id] === null) && inheritedLanes[id] === undefined));
  const searchLanes = new Map(capabilities.search.lanes.filter((lane) => !removedLanes.has(lane.id)).map((lane) => [lane.id, lane.output.channel]));
  const pipelines = new Map<string, { input_kinds: readonly string[]; representations: readonly string[] }>(capabilities.fetch.pipelines.filter((pipeline) => !removedLanes.has(pipeline.id)).map((pipeline) => [pipeline.id, pipeline]));
  const effectiveLanes = { ...capabilities.configuration?.lanes, ...inheritedLanes, ...advanced.lanes };
  const affectedLanes = new Set(removedLanes);
  for (const id of Object.keys(config?.lanes ?? {})) {
    if (advanced.lanes[id] === undefined && inheritedLanes[id] === undefined) delete effectiveLanes[id];
  }
  for (const [id, lane] of Object.entries(effectiveLanes)) {
    if (lane === null) continue;
    const previous = baselineLanes[id];
    const bindingChanged = previous?.provider_instance_id !== lane.provider_instance_id || previous.operation_id !== lane.operation_id;
    const instance = draft.providers[lane.provider_instance_id];
    const providerId = instance?.providerId ?? capabilities.providers.instances.find((candidate) => candidate.id === lane.provider_instance_id)?.provider_id;
    const deleted = instance?.isDeleted && !capabilities.inherited_configuration?.provider_instance_ids.includes(lane.provider_instance_id);
    if (bindingChanged || deleted) affectedLanes.add(id);
    if (deleted || providerId === undefined) {
      if (affectedLanes.has(id)) {
        add('instance', `lanes.${id}`, lane.provider_instance_id);
        searchLanes.delete(id);
        pipelines.delete(id);
      }
      continue;
    }
    const descriptor = capabilities.providers.descriptors.find((candidate) => candidate.provider_id === providerId);
    if (descriptor === undefined && !affectedLanes.has(id)) continue;
    const query = descriptor?.query_operations.find((operation) => operation.operation_id === lane.operation_id);
    const fetch = descriptor?.fetch_operations.find((operation) => operation.operation_id === lane.operation_id);
    searchLanes.delete(id);
    pipelines.delete(id);
    if (query !== undefined) searchLanes.set(id, query.output.channel);
    else if (fetch !== undefined) {
      const existing = capabilities.fetch.pipelines.find((pipeline) => pipeline.id === id);
      const inputKinds = fetch['input_kinds'];
      const representations = fetch['representations'];
      if (Array.isArray(inputKinds) && Array.isArray(representations)) pipelines.set(id, { input_kinds: inputKinds.filter((kind): kind is string => typeof kind === 'string'), representations: representations.filter((kind): kind is string => typeof kind === 'string') });
      else if (existing !== undefined && !bindingChanged) pipelines.set(id, existing);
    } else if (affectedLanes.has(id)) add('operation', `lanes.${id}`, lane.operation_id);
  }
  const defaultLane = draft.defaultSearchLane || capabilities.inherited_configuration?.default_search_lane;
  const previousDefault = config?.defaults?.search_lane ?? capabilities.inherited_configuration?.default_search_lane;
  if (defaultLane && (defaultLane !== previousDefault || affectedLanes.has(defaultLane)) && !searchLanes.has(defaultLane)) add('lane', 'defaults.search_lane', defaultLane);
  const previousPresets = { ...capabilities.inherited_configuration?.presets, ...baseline.presets };
  for (const [id, preset] of Object.entries({ ...capabilities.inherited_configuration?.presets, ...advanced.presets })) {
    for (const laneId of preset?.lanes ?? []) {
      if (previousPresets[id]?.lanes.includes(laneId) && !affectedLanes.has(laneId)) continue;
      if (!searchLanes.has(laneId)) add('lane', `presets.${id}`, laneId);
      else if (searchLanes.get(laneId) !== 'results') add('preset-results', `presets.${id}`, laneId);
    }
  }
  for (const chain of advanced.fetchChains) {
    const previous = baseline.fetchChains.find((candidate) => candidate.inputKind === chain.inputKind && candidate.representation === chain.representation);
    for (const id of chain.pipelines) {
      if (previous?.pipelines.includes(id) && !affectedLanes.has(id)) continue;
      const pipeline = pipelines.get(id);
      const path = `defaults.fetch_chain.${chain.inputKind}.${chain.representation}`;
      if (pipeline === undefined) add('pipeline', path, id);
      else if (!pipeline.input_kinds.includes(chain.inputKind) || !pipeline.representations.includes(chain.representation)) add('pipeline-incompatible', path, id);
    }
  }
  const inheritedRouting = capabilities.inherited_configuration?.routing;
  const routing = advanced.routing === null ? {} : { ...inheritedRouting, ...advanced.routing };
  const previousRules = baseline.routing === null ? [] : baseline.routing?.rules ?? inheritedRouting?.rules ?? [];
  for (const rule of routing.rules ?? []) {
    if (!('pipelines' in rule.action)) continue;
    const previous = previousRules.find((candidate) => candidate.id === rule.id);
    for (const id of rule.action.pipelines) {
      if (JSON.stringify(rule) === JSON.stringify(previous) && !affectedLanes.has(id)) continue;
      const pipeline = pipelines.get(id);
      const path = `fetch.routing.rules.${rule.id}`;
      if (pipeline === undefined) add('pipeline', path, id);
      else if (!pipeline.input_kinds.includes('url') || (rule.match.representation !== undefined && !pipeline.representations.includes(rule.match.representation))) add('pipeline-incompatible', path, id);
    }
  }
  return issues;
}
