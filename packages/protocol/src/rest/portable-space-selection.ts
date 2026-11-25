import {
  PORTABLE_SUBSCRIPTION_SCOPES,
  type PortableSpaceBindingChoices,
  type PortableSpaceBindingSlot,
  type PortableSpaceLocalModelOption,
  type PortableSpaceSubscribePreviewItem,
  type PortableSpaceSubscribePreviewManifest,
  type PortableSpaceSubscriptionSelection,
  type PortableSubscriptionScope,
} from './portable-space';

export type SubscriptionScopeCheckState = 'checked' | 'indeterminate' | 'unchecked';

export type BindingSlotResolutionState =
  | 'satisfied_pack'
  | 'satisfied_live'
  | 'bound_group'
  | 'bound_unit'
  | 'deferred'
  | 'unresolved'
  | 'invalid_target';

export interface EvaluatedBindingSlot {
  readonly slot: PortableSpaceBindingSlot;
  readonly state: BindingSlotResolutionState;
  readonly resolvedLocalModelId?: string;
  readonly invalidLocalModelId?: string;
}

export interface GroupedBindingSlot {
  readonly sourceModelId: string;
  readonly slots: readonly EvaluatedBindingSlot[];
  readonly consumerItemIds: readonly string[];
  readonly consumerLabels: readonly string[];
  readonly intersectionOptionIndices: readonly number[];
  readonly groupLocalModelId?: string;
  readonly allDeferred: boolean;
  readonly hasUnresolved: boolean;
  readonly hasInvalidTarget: boolean;
}

export interface ScopeSelectionSummary {
  readonly scope: PortableSubscriptionScope;
  readonly totalCount: number;
  readonly selectableCount: number;
  readonly selectedCount: number;
  readonly state: SubscriptionScopeCheckState;
}

export interface SubscriptionSelectionEvaluation {
  readonly selectedItemIds: ReadonlySet<string>;
  readonly blockedByItemId: ReadonlyMap<string, readonly string[]>;
  readonly scopeSummaries: readonly ScopeSelectionSummary[];
  readonly activeSlots: readonly EvaluatedBindingSlot[];
  readonly actionableSlots: readonly EvaluatedBindingSlot[];
  readonly groupedActionableSlots: readonly GroupedBindingSlot[];
  readonly unresolvedRequiredSlots: readonly EvaluatedBindingSlot[];
  readonly invalidTargetSlots: readonly EvaluatedBindingSlot[];
  readonly deferredSlots: readonly EvaluatedBindingSlot[];
  readonly coupledCredentialIds: readonly string[];
  readonly hasHardBlockers: boolean;
  readonly canConfirmInitial: boolean;
  readonly canConfirmEdit: boolean;
}

export interface NormalizedManifestIndex {
  readonly itemById: ReadonlyMap<string, PortableSpaceSubscribePreviewItem>;
  readonly itemScopeById: ReadonlyMap<string, PortableSubscriptionScope>;
  readonly selectableItemsByScope: ReadonlyMap<PortableSubscriptionScope, readonly PortableSpaceSubscribePreviewItem[]>;
  readonly itemsByScope: ReadonlyMap<PortableSubscriptionScope, readonly PortableSpaceSubscribePreviewItem[]>;
  readonly scopeItemIdSets: ReadonlyMap<PortableSubscriptionScope, ReadonlySet<string>>;
  readonly reverseHardConsumers: ReadonlyMap<string, readonly string[]>;
  readonly nonLiveHardTargetsByItemId: ReadonlyMap<string, readonly string[]>;
  readonly itemsWithHardDeps: readonly PortableSpaceSubscribePreviewItem[];
  readonly itemsWithCredentials: readonly PortableSpaceSubscribePreviewItem[];
  readonly optionIndexById: ReadonlyMap<string, number>;
  readonly eligibleSetByTupleKey: ReadonlyMap<string, ReadonlySet<number>>;
  readonly packModelUnitIdByAlias: ReadonlyMap<string, string>;
}

const SCOPE_ORDINAL: Readonly<Record<PortableSubscriptionScope, number>> = {
  models_providers: 0,
  extensions_search: 1,
  agents_recipes: 2,
  personas: 3,
  instructions: 4,
  settings: 5,
};

/** Encodes a physical config model unit ID matching treeProjection.ts putUnit('config', ['models', alias]). */
export function encodeConfigModelUnitId(alias: string): string {
  return `config:models.${alias.replaceAll('%', '%25').replaceAll('.', '%2E')}`;
}

/** Builds O(1) indexed structures from a frozen preview manifest for synchronous client/server evaluation. */
export function normalizePreviewManifest(
  manifest: Pick<PortableSpaceSubscribePreviewManifest, 'items' | 'localModelOptions'> & {
    readonly bindingSlots?: readonly PortableSpaceBindingSlot[];
  },
): NormalizedManifestIndex {
  const itemById = new Map<string, PortableSpaceSubscribePreviewItem>();
  const itemScopeById = new Map<string, PortableSubscriptionScope>();
  const itemsByScope = new Map<PortableSubscriptionScope, PortableSpaceSubscribePreviewItem[]>();
  const selectableItemsByScope = new Map<PortableSubscriptionScope, PortableSpaceSubscribePreviewItem[]>();
  const scopeItemIdSets = new Map<PortableSubscriptionScope, Set<string>>();
  const reverseHardConsumers = new Map<string, string[]>();
  const nonLiveHardTargetsByItemId = new Map<string, string[]>();
  const itemsWithHardDeps: PortableSpaceSubscribePreviewItem[] = [];
  const itemsWithCredentials: PortableSpaceSubscribePreviewItem[] = [];

  for (const scope of PORTABLE_SUBSCRIPTION_SCOPES) {
    itemsByScope.set(scope, []);
    selectableItemsByScope.set(scope, []);
    scopeItemIdSets.set(scope, new Set());
  }

  for (const item of manifest.items) {
    itemById.set(item.id, item);
    itemScopeById.set(item.id, item.scope);
    itemsByScope.get(item.scope)!.push(item);
    scopeItemIdSets.get(item.scope)!.add(item.id);
    if (item.selectable) selectableItemsByScope.get(item.scope)!.push(item);
    if (item.coupledCredentialIds.length > 0) itemsWithCredentials.push(item);

    let nonLiveHard: string[] | undefined;
    for (const edge of item.dependencyEdges) {
      if (edge.kind !== 'hard') continue;
      if (!edge.liveSatisfied) {
        if (nonLiveHard === undefined) nonLiveHard = [];
        nonLiveHard.push(edge.toId);
      }
      let list = reverseHardConsumers.get(edge.toId);
      if (list === undefined) {
        list = [];
        reverseHardConsumers.set(edge.toId, list);
      }
      if (!list.includes(item.id)) list.push(item.id);
    }
    if (nonLiveHard !== undefined) {
      nonLiveHardTargetsByItemId.set(item.id, nonLiveHard);
    }
    if (nonLiveHard !== undefined || item.blockedDependencyIds.length > 0) {
      itemsWithHardDeps.push(item);
    }
  }

  const optionIndexById = new Map<string, number>();
  manifest.localModelOptions.forEach((option: PortableSpaceLocalModelOption, index: number) => {
    optionIndexById.set(option.id, index);
  });

  const eligibleSetByTupleKey = new Map<string, ReadonlySet<number>>();
  const packModelUnitIdByAlias = new Map<string, string>();
  if (manifest.bindingSlots !== undefined) {
    for (const slot of manifest.bindingSlots) {
      eligibleSetByTupleKey.set(slot.tupleKey, new Set(slot.eligibleOptionIndices));
      if (!packModelUnitIdByAlias.has(slot.sourceModelId)) {
        packModelUnitIdByAlias.set(slot.sourceModelId, encodeConfigModelUnitId(slot.sourceModelId));
      }
    }
  }

  return {
    itemById,
    itemScopeById,
    selectableItemsByScope,
    itemsByScope,
    scopeItemIdSets,
    reverseHardConsumers,
    nonLiveHardTargetsByItemId,
    itemsWithHardDeps,
    itemsWithCredentials,
    optionIndexById,
    eligibleSetByTupleKey,
    packModelUnitIdByAlias,
  };
}

/** Evaluates whether one selectable item ID is checked under hybrid scope + exception semantics. */
export function isItemCheckedInSelection(
  itemId: string,
  scope: PortableSubscriptionScope,
  selection: PortableSpaceSubscriptionSelection,
): boolean {
  if (selection.excludedIds.includes(itemId)) return false;
  if (selection.includedIds.includes(itemId)) return true;
  return selection.enabledScopes.includes(scope);
}

/** Evaluates effective selection, hard dependency closure, credential coupling, and model-slot binding readiness. */
export function evaluateSubscriptionSelection(
  manifest: Pick<PortableSpaceSubscribePreviewManifest, 'items' | 'bindingSlots' | 'localModelOptions'>,
  selection: PortableSpaceSubscriptionSelection,
  bindings: PortableSpaceBindingChoices = {},
  index: NormalizedManifestIndex = normalizePreviewManifest(manifest),
): SubscriptionSelectionEvaluation {
  const enabledScopes = new Set(selection.enabledScopes);
  const excluded = selection.excludedIds.length > 0 ? new Set(selection.excludedIds) : undefined;
  const included = selection.includedIds.length > 0 ? new Set(selection.includedIds) : undefined;

  const selectedCountByScope = new Int32Array(PORTABLE_SUBSCRIPTION_SCOPES.length);

  const selectedItemIds = new Set<string>();
  const items = manifest.items;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    if (!item.selectable) continue;
    const checked = excluded !== undefined && excluded.has(item.id)
      ? false
      : included !== undefined && included.has(item.id)
        ? true
        : enabledScopes.has(item.scope);
    if (checked) {
      selectedItemIds.add(item.id);
      selectedCountByScope[SCOPE_ORDINAL[item.scope]]! += 1;
    }
  }

  const blockedByItemId = new Map<string, string[]>();
  const hardItems = index.itemsWithHardDeps;
  if (hardItems.length > 0) {
    for (let i = 0; i < hardItems.length; i += 1) {
      const item = hardItems[i]!;
      if (!selectedItemIds.has(item.id) || item.blockedDependencyIds.length === 0) continue;
      let unresolvedStatic: string[] | undefined;
      for (let j = 0; j < item.blockedDependencyIds.length; j += 1) {
        const depId = item.blockedDependencyIds[j]!;
        if (!selectedItemIds.has(depId)) {
          if (unresolvedStatic === undefined) unresolvedStatic = [];
          unresolvedStatic.push(depId);
        }
      }
      if (unresolvedStatic !== undefined) {
        blockedByItemId.set(item.id, unresolvedStatic);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < hardItems.length; i += 1) {
        const item = hardItems[i]!;
        if (!selectedItemIds.has(item.id)) continue;
        const targets = index.nonLiveHardTargetsByItemId.get(item.id);
        if (targets === undefined) continue;
        let existing = blockedByItemId.get(item.id);
        for (let j = 0; j < targets.length; j += 1) {
          const toId = targets[j]!;
          if (selectedItemIds.has(toId) && !blockedByItemId.has(toId)) continue;
          if (existing === undefined) {
            existing = [toId];
            blockedByItemId.set(item.id, existing);
            changed = true;
          } else if (!existing.includes(toId)) {
            existing.push(toId);
            changed = true;
          }
        }
      }
    }
  }

  const scopeSummaries: ScopeSelectionSummary[] = PORTABLE_SUBSCRIPTION_SCOPES.map((scope, idx) => {
    const totalCount = index.itemsByScope.get(scope)?.length ?? 0;
    const selectableCount = index.selectableItemsByScope.get(scope)?.length ?? 0;
    const selectedCount = selectedCountByScope[idx]!;
    const state: SubscriptionScopeCheckState =
      selectableCount === 0
        ? (enabledScopes.has(scope) ? 'checked' : 'unchecked')
        : selectedCount === 0
          ? 'unchecked'
          : selectedCount === selectableCount && enabledScopes.has(scope)
            ? 'checked'
            : 'indeterminate';
    return {
      scope,
      totalCount,
      selectableCount,
      selectedCount,
      state,
    };
  });

  const deferredSet = bindings.unmappedModelPolicy === 'defer' && bindings.deferredSlotIds !== undefined && bindings.deferredSlotIds.length > 0
    ? new Set(bindings.deferredSlotIds)
    : undefined;
  const unitBindings = bindings.unitModelBindings;
  const groupBindings = bindings.modelBindings;

  const activeSlots: EvaluatedBindingSlot[] = [];
  const actionableSlots: EvaluatedBindingSlot[] = [];
  const unresolvedRequiredSlots: EvaluatedBindingSlot[] = [];
  const invalidTargetSlots: EvaluatedBindingSlot[] = [];
  const deferredSlots: EvaluatedBindingSlot[] = [];

  const bindingSlots = manifest.bindingSlots;
  for (let i = 0; i < bindingSlots.length; i += 1) {
    const slot = bindingSlots[i]!;
    if (!selectedItemIds.has(slot.itemId)) continue;
    const eligibleSet = index.eligibleSetByTupleKey.get(slot.tupleKey) ?? new Set(slot.eligibleOptionIndices);
    const packModelUnitId = index.packModelUnitIdByAlias.get(slot.sourceModelId) ?? encodeConfigModelUnitId(slot.sourceModelId);
    const packModelSelected = selectedItemIds.has(packModelUnitId) && !blockedByItemId.has(packModelUnitId);
    const unitChoice = unitBindings?.[slot.tupleKey];
    const groupChoice = groupBindings?.[slot.sourceModelId];

    let evaluated: EvaluatedBindingSlot;
    if (unitChoice !== undefined) {
      const optIdx = index.optionIndexById.get(unitChoice);
      if (optIdx !== undefined && eligibleSet.has(optIdx)) {
        evaluated = { slot, state: 'bound_unit', resolvedLocalModelId: unitChoice };
      } else {
        evaluated = { slot, state: 'invalid_target', invalidLocalModelId: unitChoice };
      }
    } else if (deferredSet !== undefined && deferredSet.has(slot.tupleKey)) {
      evaluated = { slot, state: 'deferred' };
    } else if (groupChoice !== undefined) {
      const optIdx = index.optionIndexById.get(groupChoice);
      if (optIdx !== undefined && eligibleSet.has(optIdx)) {
        evaluated = { slot, state: 'bound_group', resolvedLocalModelId: groupChoice };
      } else {
        evaluated = { slot, state: 'invalid_target', invalidLocalModelId: groupChoice };
      }
    } else if (packModelSelected) {
      evaluated = { slot, state: 'satisfied_pack', resolvedLocalModelId: slot.sourceModelId };
    } else if (slot.currentLocalModelId !== undefined) {
      const optIdx = index.optionIndexById.get(slot.currentLocalModelId);
      if (optIdx !== undefined && eligibleSet.has(optIdx)) {
        evaluated = { slot, state: 'satisfied_live', resolvedLocalModelId: slot.currentLocalModelId };
      } else {
        evaluated = { slot, state: 'unresolved' };
      }
    } else {
      evaluated = { slot, state: 'unresolved' };
    }

    activeSlots.push(evaluated);
    if (
      evaluated.state === 'unresolved'
      || evaluated.state === 'invalid_target'
      || evaluated.state === 'deferred'
      || evaluated.state === 'bound_group'
      || evaluated.state === 'bound_unit'
    ) {
      actionableSlots.push(evaluated);
    }
    if (evaluated.state === 'unresolved' && slot.required) {
      unresolvedRequiredSlots.push(evaluated);
    }
    if (evaluated.state === 'invalid_target') {
      invalidTargetSlots.push(evaluated);
    }
    if (evaluated.state === 'deferred') {
      deferredSlots.push(evaluated);
    }
  }

  const groupedActionableSlots: GroupedBindingSlot[] = [];
  if (actionableSlots.length > 0) {
    const groupedMap = new Map<string, EvaluatedBindingSlot[]>();
    for (let i = 0; i < actionableSlots.length; i += 1) {
      const evaluated = actionableSlots[i]!;
      let list = groupedMap.get(evaluated.slot.sourceModelId);
      if (list === undefined) {
        list = [];
        groupedMap.set(evaluated.slot.sourceModelId, list);
      }
      list.push(evaluated);
    }

    for (const [sourceModelId, slots] of groupedMap) {
      let intersection: number[] | undefined;
      const consumerItemIds: string[] = [];
      const consumerLabels: string[] = [];
      let allDeferred = slots.length > 0;
      let hasUnresolved = false;
      let hasInvalidTarget = false;
      for (let i = 0; i < slots.length; i += 1) {
        const entry = slots[i]!;
        if (entry.state !== 'deferred') allDeferred = false;
        if (entry.state === 'unresolved' && entry.slot.required) hasUnresolved = true;
        if (entry.state === 'invalid_target') hasInvalidTarget = true;
        if (!consumerItemIds.includes(entry.slot.itemId)) {
          consumerItemIds.push(entry.slot.itemId);
          consumerLabels.push(entry.slot.itemLabel);
        }
        if (intersection === undefined) {
          intersection = [...entry.slot.eligibleOptionIndices];
        } else {
          const current = index.eligibleSetByTupleKey.get(entry.slot.tupleKey) ?? new Set(entry.slot.eligibleOptionIndices);
          intersection = intersection.filter((idx) => current.has(idx));
        }
      }
      groupedActionableSlots.push({
        sourceModelId,
        slots,
        consumerItemIds,
        consumerLabels,
        intersectionOptionIndices: intersection ?? [],
        groupLocalModelId: groupBindings?.[sourceModelId],
        allDeferred,
        hasUnresolved,
        hasInvalidTarget,
      });
    }
  }

  const credentialSet = new Set<string>();
  if (selection.includeCredentials) {
    const credItems = index.itemsWithCredentials;
    for (let i = 0; i < credItems.length; i += 1) {
      const item = credItems[i]!;
      if (!selectedItemIds.has(item.id) || blockedByItemId.has(item.id)) continue;
      for (let j = 0; j < item.coupledCredentialIds.length; j += 1) {
        credentialSet.add(item.coupledCredentialIds[j]!);
      }
    }
  }

  const hasHardBlockers = blockedByItemId.size > 0;
  const bindingsReady = unresolvedRequiredSlots.length === 0 && invalidTargetSlots.length === 0;
  return {
    selectedItemIds,
    blockedByItemId,
    scopeSummaries,
    activeSlots,
    actionableSlots,
    groupedActionableSlots,
    unresolvedRequiredSlots,
    invalidTargetSlots,
    deferredSlots,
    coupledCredentialIds: credentialSet.size > 0 ? [...credentialSet].sort() : [],
    hasHardBlockers,
    canConfirmInitial: selectedItemIds.size > 0 && !hasHardBlockers && bindingsReady,
    canConfirmEdit: !hasHardBlockers && bindingsReady,
  };
}

function canonicalScopes(scopes: Iterable<PortableSubscriptionScope>): PortableSubscriptionScope[] {
  const set = new Set(scopes);
  return PORTABLE_SUBSCRIPTION_SCOPES.filter((scope) => set.has(scope));
}

/** Toggles one semantic scope on/off, clearing only overrides belonging to that scope while preserving absent/other-scope overrides. */
export function toggleSubscriptionScope(
  manifest: Pick<PortableSpaceSubscribePreviewManifest, 'items' | 'localModelOptions'>,
  selection: PortableSpaceSubscriptionSelection,
  scope: PortableSubscriptionScope,
  checked: boolean,
  index: NormalizedManifestIndex = normalizePreviewManifest(manifest),
): PortableSpaceSubscriptionSelection {
  const scopeItemIds = index.scopeItemIdSets.get(scope);
  const enabledScopes = new Set(selection.enabledScopes);
  if (checked) enabledScopes.add(scope);
  else enabledScopes.delete(scope);

  const excludedIds = scopeItemIds === undefined || selection.excludedIds.length === 0
    ? selection.excludedIds
    : selection.excludedIds.filter((id) => !scopeItemIds.has(id));
  const includedIds = scopeItemIds === undefined || selection.includedIds.length === 0
    ? selection.includedIds
    : selection.includedIds.filter((id) => !scopeItemIds.has(id));
  return {
    version: 1,
    enabledScopes: canonicalScopes(enabledScopes),
    excludedIds,
    includedIds,
    includeCredentials: selection.includeCredentials,
  };
}

/** Toggles one item on/off with deterministic hard-provider cascade and soft-model suggestion handling. */
export function toggleSubscriptionItem(
  manifest: Pick<PortableSpaceSubscribePreviewManifest, 'items' | 'localModelOptions'>,
  selection: PortableSpaceSubscriptionSelection,
  itemId: string,
  checked: boolean,
  index: NormalizedManifestIndex = normalizePreviewManifest(manifest),
): PortableSpaceSubscriptionSelection {
  const item = index.itemById.get(itemId);
  if (item === undefined || !item.selectable) return selection;

  const enabledScopes = new Set(selection.enabledScopes);
  const excluded = new Set(selection.excludedIds);
  const included = new Set(selection.includedIds);

  const setLeaf = (id: string, nextChecked: boolean, explicitVeto: boolean) => {
    const target = index.itemById.get(id);
    if (target === undefined || !target.selectable) return;
    const scopeOn = enabledScopes.has(target.scope);
    if (nextChecked) {
      excluded.delete(id);
      if (scopeOn) included.delete(id);
      else included.add(id);
    } else {
      included.delete(id);
      if (scopeOn || explicitVeto) excluded.add(id);
      else excluded.delete(id);
    }
  };

  if (checked) {
    setLeaf(itemId, true, false);
    const queue: string[] = [itemId];
    const visited = new Set<string>([itemId]);
    let head = 0;
    while (head < queue.length) {
      const currentId = queue[head++]!;
      const current = index.itemById.get(currentId);
      if (current === undefined) continue;
      for (const edge of current.dependencyEdges) {
        if (edge.liveSatisfied) continue;
        const dep = index.itemById.get(edge.toId);
        if (dep === undefined || !dep.selectable) continue;
        if (edge.kind === 'hard') {
          if (!visited.has(dep.id)) {
            visited.add(dep.id);
            setLeaf(dep.id, true, false);
            queue.push(dep.id);
          }
        } else if (edge.kind === 'soft' && !excluded.has(dep.id)) {
          if (!visited.has(dep.id)) {
            visited.add(dep.id);
            setLeaf(dep.id, true, false);
            queue.push(dep.id);
          }
        }
      }
    }
  } else {
    const isModelUnit = item.domain === 'config' && item.id.startsWith('config:models.');
    setLeaf(itemId, false, isModelUnit);
    const queue: string[] = [itemId];
    const visited = new Set<string>([itemId]);
    let head = 0;
    while (head < queue.length) {
      const removedId = queue[head++]!;
      const consumers = index.reverseHardConsumers.get(removedId);
      if (consumers === undefined) continue;
      for (let i = 0; i < consumers.length; i += 1) {
        const consumerId = consumers[i]!;
        if (visited.has(consumerId)) continue;
        const consumer = index.itemById.get(consumerId);
        if (consumer === undefined || !consumer.selectable) continue;
        const nonLiveHard = index.nonLiveHardTargetsByItemId.get(consumerId);
        if (nonLiveHard === undefined || !nonLiveHard.includes(removedId)) continue;
        visited.add(consumerId);
        const consumerIsModel = consumer.domain === 'config' && consumer.id.startsWith('config:models.');
        setLeaf(consumerId, false, consumerIsModel);
        queue.push(consumerId);
      }
    }
  }

  return {
    version: 1,
    enabledScopes: canonicalScopes(enabledScopes),
    excludedIds: excluded.size > 0 ? [...excluded].sort() : [],
    includedIds: included.size > 0 ? [...included].sort() : [],
    includeCredentials: selection.includeCredentials,
  };
}
