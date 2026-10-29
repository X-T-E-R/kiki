/**
 * The service-card model behind the search tab.
 *
 * A "service" is what a person configures: Exa with its key, Jina Reader for
 * fetching. The engine splits that fact across three records — provider
 * instance, credential slot, and the lane or pipeline the tool calls — and the
 * page folds them back into one card. This module owns that fold and every
 * write the card makes into the draft; the server contract (defaults,
 * lanes, fetch chains, provider instances) stays exactly as before.
 */

import type { NbSearchCapabilities } from '@kiki/protocol';
import {
  nbSearchCompatiblePipelines,
  setNbSearchFetchChain,
  setNbSearchLane,
  type NbSearchDraft,
  type NbSearchInputKind,
  type NbSearchRepresentation,
} from '@kiki/session-core/settings';
import type { NbSearchLaneConfig } from './advancedSupport';

import type { NbSearchLaneProfile } from './types';

type LanesMap = Readonly<Record<string, NbSearchLaneProfile | undefined>>;
type LaneConfigMap = Readonly<Record<string, NbSearchLaneConfig | undefined>>;

function ownLanes(draft: NbSearchDraft): LaneConfigMap {
  return draft.advanced?.lanes as LaneConfigMap | undefined ?? {};
}

/** Every lane the engine reports, mapped through the same layers the catalog does. */
export function engineLaneProfiles(capabilities: NbSearchCapabilities): LanesMap {
  const merged: Record<string, NbSearchLaneProfile | undefined> = {};
  const configurations = [capabilities.inherited_configuration?.lanes, capabilities.configuration?.lanes];
  for (const lanes of configurations) {
    for (const [id, lane] of Object.entries(lanes ?? {})) {
      if (lane === undefined || lane === null) continue;
      const providerId = providerOfInstanceId(capabilities, lane.provider_instance_id) ?? lane.provider_instance_id;
      merged[id] = { provider_id: providerId, operation_id: lane.operation_id };
    }
  }
  return merged;
}

function providerOfInstanceId(capabilities: NbSearchCapabilities, instanceId: string): string | undefined {
  return capabilities.providers.instances.find((instance) => instance.id === instanceId)?.provider_id;
}

/**
 * Every lane / pipeline the page can describe: Kiki's own declarations first,
 * then the layer below (configuration, inherited). Names point at their
 * provider and operation so cards can say "Exa 搜索" instead of `exa.search`.
 */
export function laneProfiles(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
): LanesMap {
  const merged: Record<string, NbSearchLaneProfile | undefined> = {};
  const put = (map: LaneConfigMap | undefined) => {
    for (const [id, lane] of Object.entries(map ?? {})) {
      if (lane === undefined) continue;
      const providerId = instanceProviderId(capabilities, draft, lane.provider_instance_id);
      merged[id] = { provider_id: providerId ?? lane.provider_instance_id, operation_id: lane.operation_id };
    }
  };
  put(capabilities.inherited_configuration?.lanes);
  put(capabilities.configuration?.lanes);
  put(ownLanes(draft));
  return merged;
}

function instanceProviderId(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
  instanceId: string,
): string | undefined {
  return draft.providers[instanceId]?.providerId
    ?? capabilities.providers.instances.find((instance) => instance.id === instanceId)?.provider_id;
}

function providerOf(
  profiles: LanesMap,
  capabilities: NbSearchCapabilities,
  kind: 'lane' | 'pipeline',
  id: string,
): string | undefined {
  const profile = profiles[id];
  if (profile !== undefined) return profile.provider_id;
  if (kind === 'pipeline') return capabilities.fetch.pipelines.find((pipeline) => pipeline.id === id)?.stages[0]?.id;
  return undefined;
}

/** What the card needs to know about the provider behind it. */
export interface CardProviderInfo {
  readonly providerId: string;
  /** The instance the lane or chain points at, when one exists. */
  readonly instanceId?: string;
  readonly enabled: boolean;
  readonly credentialRequirement: 'none' | 'optional' | 'required';
  readonly needsEndpoint: boolean;
  readonly hasOptions: boolean;
}

/**
 * The provider facts a card shows, found by id without inventing an instance:
 * an instance the lane or chain names when there is one, else the provider's
 * own descriptor. Requirement questions ("does this service take a key") come
 * from the descriptor so a keyless provider never asks for one.
 */
export function cardProviderInfo(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
  profiles: LanesMap,
  kind: 'lane' | 'pipeline',
  id: string,
): CardProviderInfo | null {
  const providerId = providerOf(profiles, capabilities, kind, id);
  if (providerId === undefined) return null;
  const descriptor = capabilities.providers.descriptors.find((candidate) => candidate.provider_id === providerId);
  const config = kind === 'lane'
    ? laneConfig(capabilities, draft, id)
    : undefined;
  // The lane names its instance; without a name, the provider's instances are
  // all candidates — prefer one that really exists over guessing `.default`.
  const namedInstance = config?.provider_instance_id;
  const candidates = capabilities.providers.instances.filter((candidate) => candidate.provider_id === providerId);
  const instance = candidates.find((candidate) => candidate.id === namedInstance) ?? candidates[0];
  const draftProvider = instance === undefined ? undefined : draft.providers[instance.id];
  const enabled = draftProvider?.enabled ?? instance?.enabled ?? true;
  const credentialRequirement = descriptor?.activation.credential ?? instance?.credential.requirement ?? 'required';
  const endpointRequirement = descriptor?.activation.endpoint ?? instance?.endpoint.requirement ?? 'none';
  return {
    providerId,
    instanceId: instance?.id ?? namedInstance,
    enabled,
    credentialRequirement: credentialRequirement as CardProviderInfo['credentialRequirement'],
    needsEndpoint: endpointRequirement === 'required' || endpointRequirement === 'optional',
    hasOptions: (descriptor?.option_keys.length ?? 0) > 0,
  };
}

/** The profile in force for one lane id, from the draft down to the layer below. */
export function laneConfig(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
  laneId: string,
): NbSearchLaneConfig | undefined {
  return ownLanes(draft)[laneId]
    ?? capabilities.configuration?.lanes[laneId]
    ?? capabilities.inherited_configuration?.lanes[laneId]
    ?? undefined;
}

/** All `input × output` fetch-chain pairs, default pair first. */
export const DEFAULT_FETCH_PAIR: { readonly inputKind: NbSearchInputKind; readonly representation: NbSearchRepresentation } = {
  inputKind: 'url',
  representation: 'markdown',
};

/** The pipelines one chain runs, in order, from the draft or the layer below. */
export function chainPipelines(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
  inputKind: NbSearchInputKind,
  representation: NbSearchRepresentation,
): { readonly pipelines: readonly string[]; readonly inherited: boolean } {
  const pair = draft.advanced?.fetchChains.find(
    (chain) => chain.inputKind === inputKind && chain.representation === representation,
  );
  if (pair !== undefined) return { pipelines: pair.pipelines, inherited: pair.inherited };
  const source = (capabilities.inherited_configuration?.fetch_chains ?? capabilities.fetch.chains).find(
    (chain) => chain.input_kind === inputKind && chain.representation === representation,
  );
  return { pipelines: source?.pipelines ?? [], inherited: true };
}

/** Which fetch pair a pipeline sits on; a pipeline can serve several pairs. */
export function pipelinePairs(
  draft: NbSearchDraft,
  capabilities: NbSearchCapabilities,
  pipelineId: string,
): { inputKind: NbSearchInputKind; representation: NbSearchRepresentation }[] {
  const pairs: { inputKind: NbSearchInputKind; representation: NbSearchRepresentation }[] = [];
  for (const chain of draft.advanced?.fetchChains ?? []) {
    if (chain.pipelines.includes(pipelineId)) pairs.push({ inputKind: chain.inputKind, representation: chain.representation });
  }
  if (pairs.length > 0) return pairs;
  for (const input of capabilities.fetch.inputs) {
    for (const representation of ['markdown', 'text'] as const) {
      if (nbSearchCompatiblePipelines(capabilities, input.kind, representation).some((pipeline) => pipeline.id === pipelineId)) {
        pairs.push({ inputKind: input.kind, representation });
      }
    }
  }
  return pairs;
}

// ---- Instance-level service state (keys, enable, address). ----

/** The instance a card's key fields write to: the one the lane/chain names, or the provider's single reported instance. */
export function cardInstance(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
  profiles: LanesMap,
  kind: 'lane' | 'pipeline',
  id: string,
): NbSearchCapabilities['providers']['instances'][number] | undefined {
  const providerId = providerOf(profiles, capabilities, kind, id);
  if (providerId === undefined) return undefined;
  const namedInstance = kind === 'lane' ? laneConfig(capabilities, draft, id)?.provider_instance_id : undefined;
  const instances = capabilities.providers.instances.filter((instance) => instance.provider_id === providerId);
  return instances.find((instance) => instance.id === namedInstance) ?? instances[0];
}

/** 启用/停用服务: write the enable flag on the provider instance override. */
export function setServiceEnabled(
  draft: NbSearchDraft,
  instanceId: string,
  providerId: string,
  enabled: boolean,
): NbSearchDraft {
  const current = draft.providers[instanceId];
  return {
    ...draft,
    providers: {
      ...draft.providers,
      [instanceId]: {
        providerId,
        enabled,
        baseUrl: current?.baseUrl ?? '',
        credentialSlotId: current?.credentialSlotId ?? instanceId,
        credentialSlotExplicit: current?.credentialSlotExplicit ?? false,
        optionsJson: current?.optionsJson ?? '',
        isNew: current?.isNew ?? false,
        isDeleted: false,
      },
    },
  };
}

// ---- Card writes: one action per user verb, all onto the same draft. ----

/** 设为默认: this lane becomes the default search method. */
export function makeDefaultLane(draft: NbSearchDraft, laneId: string): NbSearchDraft {
  return { ...draft, defaultSearchLane: laneId };
}

/** 跟随来源默认: no Kiki default; whatever the layer below provides wins. */
export function clearDefaultLane(draft: NbSearchDraft): NbSearchDraft {
  return { ...draft, defaultSearchLane: '' };
}

/** 添加: register a service the engine ships so its card joins the list. */
export function addLaneService(draft: NbSearchDraft, laneId: string): NbSearchDraft {
  const advanced = draft.advanced;
  if (advanced === undefined) return draft;
  // `undefined` is the "engine-provided, registered here" marker the draft
  // format itself uses; the config type spells it `null`, so write through the
  // same shape `setNbSearchLane` produces.
  const lanes = { ...advanced.lanes, [laneId]: undefined } as typeof advanced.lanes;
  return { ...draft, advanced: { ...advanced, lanes } };
}

export function addPipelineService(
  draft: NbSearchDraft,
  capabilities: NbSearchCapabilities,
  pipelineId: string,
  pairs: readonly { inputKind: NbSearchInputKind; representation: NbSearchRepresentation }[],
): NbSearchDraft {
  let next = draft;
  const targets = pairs.length > 0 ? pairs : [DEFAULT_FETCH_PAIR];
  for (const pair of targets) {
    const current = next.advanced?.fetchChains.find(
      (chain) => chain.inputKind === pair.inputKind && chain.representation === pair.representation,
    );
    const source = chainPipelines(capabilities, next, pair.inputKind, pair.representation);
    const base = current?.pipelines ?? source.pipelines;
    if (base.includes(pipelineId)) {
      next = setNbSearchFetchChain(next, pair.inputKind, pair.representation, base, false);
    } else {
      next = setNbSearchFetchChain(next, pair.inputKind, pair.representation, [...base, pipelineId], false);
    }
  }
  return next;
}

/** 移除: take the card away, restoring whatever the layer below declares. */
export function removeService(
  draft: NbSearchDraft,
  capabilities: NbSearchCapabilities,
  kind: 'lane' | 'pipeline',
  id: string,
  pairs: readonly { inputKind: NbSearchInputKind; representation: NbSearchRepresentation }[],
): NbSearchDraft {
  if (kind === 'lane') {
    let next = setNbSearchLane(draft, id, undefined);
    // The service leaves Kiki's list, so the saved instance override behind it
    // (key slot, address, enable) leaves with it — that is what the patch must
    // drop. A lane the layer below declared stays inherited.
    const instanceId = cardInstance(capabilities, draft, laneProfiles(capabilities, draft), 'lane', id)?.id;
    if (instanceId !== undefined && draft.providers[instanceId] !== undefined) {
      next = {
        ...next,
        providers: {
          ...next.providers,
          [instanceId]: { ...next.providers[instanceId]!, isDeleted: true, isNew: false },
        },
      };
    }
    return next;
  }
  let next = draft;
  for (const pair of pairs) {
    const source = chainPipelines(capabilities, next, pair.inputKind, pair.representation);
    if (!source.pipelines.includes(id)) continue;
    const remaining = source.pipelines.filter((pipelineId) => pipelineId !== id);
    next = remaining.length === 0
      ? setNbSearchFetchChain(next, pair.inputKind, pair.representation, source.pipelines, true)
      : setNbSearchFetchChain(next, pair.inputKind, pair.representation, remaining, false);
  }
  return next;
}

export function moveInChain(
  draft: NbSearchDraft,
  capabilities: NbSearchCapabilities,
  inputKind: NbSearchInputKind,
  representation: NbSearchRepresentation,
  pipelineId: string,
  delta: -1 | 1,
): NbSearchDraft {
  const { pipelines } = chainPipelines(capabilities, draft, inputKind, representation);
  const index = pipelines.indexOf(pipelineId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= pipelines.length) return draft;
  const next = [...pipelines];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return setNbSearchFetchChain(draft, inputKind, representation, next, false);
}

export function removeFromChain(
  draft: NbSearchDraft,
  capabilities: NbSearchCapabilities,
  inputKind: NbSearchInputKind,
  representation: NbSearchRepresentation,
  pipelineId: string,
): NbSearchDraft {
  const { pipelines } = chainPipelines(capabilities, draft, inputKind, representation);
  const remaining = pipelines.filter((id) => id !== pipelineId);
  return remaining.length === pipelines.length
    ? draft
    : setNbSearchFetchChain(draft, inputKind, representation, remaining, false);
}

/** The first compatible pipeline not already on the chain, for 添加服务. */
export function appendablePipeline(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
  inputKind: NbSearchInputKind,
  representation: NbSearchRepresentation,
): string | undefined {
  const { pipelines } = chainPipelines(capabilities, draft, inputKind, representation);
  return nbSearchCompatiblePipelines(capabilities, inputKind, representation).find(
    (pipeline) => !pipelines.includes(pipeline.id),
  )?.id;
}


