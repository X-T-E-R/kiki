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
  readonly reverseHardConsumers: ReadonlyMap<string, readonly string[]>;
  readonly optionIndexById: ReadonlyMap<string, number>;
}

/** Encodes a physical config model unit ID matching treeProjection.ts putUnit('config', ['models', alias]). */
export function encodeConfigModelUnitId(alias: string): string {
  return `config:models.${alias.replaceAll('%', '%25').replaceAll('.', '%2E')}`;
}

/** Builds O(1) indexed structures from a frozen preview manifest for synchronous client/server evaluation. */
export function normalizePreviewManifest(
  manifest: Pick<PortableSpaceSubscribePreviewManifest, 'items' | 'localModelOptions'>,
): NormalizedManifestIndex {
  const itemById = new Map<string, PortableSpaceSubscribePreviewItem>();
  const itemScopeById = new Map<string, PortableSubscriptionScope>();
  const itemsByScope = new Map<PortableSubscriptionScope, PortableSpaceSubscribePreviewItem[]>();
  const selectableItemsByScope = new Map<PortableSubscriptionScope, PortableSpaceSubscribePreviewItem[]>();
  const reverseHardConsumers = new Map<string, string[]>();
  for (const scope of PORTABLE_SUBSCRIPTION_SCOPES) {
    itemsByScope.set(scope, []);
    selectableItemsByScope.set(scope, []);
  }
  for (const item of manifest.items) {
    itemById.set(item.id, item);
    itemScopeById.set(item.id, item.scope);
    itemsByScope.get(item.scope)!.push(item);
    if (item.selectable) selectableItemsByScope.get(item.scope)!.push(item);
    for (const edge of item.dependencyEdges) {
      if (edge.kind !== 'hard') continue;
      let list = reverseHardConsumers.get(edge.toId);
      if (list === undefined) {
        list = [];
        reverseHardConsumers.set(edge.toId, list);
      }
      if (!list.includes(item.id)) list.push(item.id);
    }
  }
  const optionIndexById = new Map<string, number>();
  manifest.localModelOptions.forEach((option: PortableSpaceLocalModelOption, index: number) => {
    optionIndexById.set(option.id, index);
  });
  return {
    itemById,
    itemScopeById,
    selectableItemsByScope,
    itemsByScope,
    reverseHardConsumers,
    optionIndexById,
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
  const excluded = new Set(selection.excludedIds);
  const included = new Set(selection.includedIds);

  const selectedItemIds = new Set<string>();
  for (const item of manifest.items) {
    if (!item.selectable) continue;
    const checked = excluded.has(item.id)
      ? false
      : included.has(item.id)
        ? true
        : enabledScopes.has(item.scope);
    if (checked) selectedItemIds.add(item.id);
  }

  const blockedByItemId = new Map<string, string[]>();
  for (const itemId of selectedItemIds) {
    const item = index.itemById.get(itemId);
    if (item === undefined) continue;
    if (item.blockedDependencyIds.length > 0) {
      const unresolvedStatic = item.blockedDependencyIds.filter((depId) => !selectedItemIds.has(depId));
      if (unresolvedStatic.length > 0) {
        blockedByItemId.set(itemId, [...unresolvedStatic]);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const itemId of selectedItemIds) {
      const item = index.itemById.get(itemId);
      if (item === undefined) continue;
      const missingHard: string[] = [];
      for (const edge of item.dependencyEdges) {
        if (edge.kind !== 'hard') continue;
        const satisfiedByPack = selectedItemIds.has(edge.toId) && !blockedByItemId.has(edge.toId);
        if (!edge.liveSatisfied && !satisfiedByPack) {
          missingHard.push(edge.toId);
        }
      }
      if (missingHard.length > 0) {
        const existing = blockedByItemId.get(itemId);
        if (existing === undefined) {
          blockedByItemId.set(itemId, missingHard);
          changed = true;
        } else {
          for (const dep of missingHard) {
            if (!existing.includes(dep)) {
              existing.push(dep);
              changed = true;
            }
          }
        }
      }
    }
  }

  const scopeSummaries: ScopeSelectionSummary[] = PORTABLE_SUBSCRIPTION_SCOPES.map((scope) => {
    const allItems = index.itemsByScope.get(scope) ?? [];
    const selectable = index.selectableItemsByScope.get(scope) ?? [];
    let selectedCount = 0;
    for (const item of selectable) {
      if (selectedItemIds.has(item.id)) selectedCount += 1;
    }
    const state: SubscriptionScopeCheckState =
      selectable.length === 0
        ? (enabledScopes.has(scope) ? 'checked' : 'unchecked')
        : selectedCount === 0
          ? 'unchecked'
          : selectedCount === selectable.length && enabledScopes.has(scope)
            ? 'checked'
            : selectedCount === selectable.length && selectable.length > 0 && !enabledScopes.has(scope)
              ? 'indeterminate'
              : 'indeterminate';
    return {
      scope,
      totalCount: allItems.length,
      selectableCount: selectable.length,
      selectedCount,
      state,
    };
  });

  const deferredSet = new Set(
    bindings.unmappedModelPolicy === 'defer' ? (bindings.deferredSlotIds ?? []) : [],
  );
  const unitBindings = bindings.unitModelBindings ?? {};
  const groupBindings = bindings.modelBindings ?? {};

  const activeSlots: EvaluatedBindingSlot[] = [];
  const actionableSlots: EvaluatedBindingSlot[] = [];
  const unresolvedRequiredSlots: EvaluatedBindingSlot[] = [];
  const invalidTargetSlots: EvaluatedBindingSlot[] = [];
  const deferredSlots: EvaluatedBindingSlot[] = [];

  for (const slot of manifest.bindingSlots) {
    if (!selectedItemIds.has(slot.itemId)) continue;
    const eligibleSet = new Set(slot.eligibleOptionIndices);
    const packModelUnitId = encodeConfigModelUnitId(slot.sourceModelId);
    const packModelSelected = selectedItemIds.has(packModelUnitId) && !blockedByItemId.has(packModelUnitId);
    const unitChoice = unitBindings[slot.tupleKey];
    const groupChoice = groupBindings[slot.sourceModelId];

    let evaluated: EvaluatedBindingSlot;
    if (unitChoice !== undefined) {
      const optIdx = index.optionIndexById.get(unitChoice);
      if (optIdx !== undefined && eligibleSet.has(optIdx)) {
        evaluated = { slot, state: 'bound_unit', resolvedLocalModelId: unitChoice };
      } else {
        evaluated = { slot, state: 'invalid_target', invalidLocalModelId: unitChoice };
      }
    } else if (deferredSet.has(slot.tupleKey)) {
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

  const groupedMap = new Map<string, EvaluatedBindingSlot[]>();
  for (const evaluated of actionableSlots) {
    let list = groupedMap.get(evaluated.slot.sourceModelId);
    if (list === undefined) {
      list = [];
      groupedMap.set(evaluated.slot.sourceModelId, list);
    }
    list.push(evaluated);
  }

  const groupedActionableSlots: GroupedBindingSlot[] = [];
  for (const [sourceModelId, slots] of groupedMap) {
    let intersection: number[] | undefined;
    const consumerItemIds: string[] = [];
    const consumerLabels: string[] = [];
    for (const entry of slots) {
      if (!consumerItemIds.includes(entry.slot.itemId)) {
        consumerItemIds.push(entry.slot.itemId);
        consumerLabels.push(entry.slot.itemLabel);
      }
      if (intersection === undefined) {
        intersection = [...entry.slot.eligibleOptionIndices];
      } else {
        const current = new Set(entry.slot.eligibleOptionIndices);
        intersection = intersection.filter((idx) => current.has(idx));
      }
    }
    groupedActionableSlots.push({
      sourceModelId,
      slots,
      consumerItemIds,
      consumerLabels,
      intersectionOptionIndices: intersection ?? [],
      groupLocalModelId: groupBindings[sourceModelId],
      allDeferred: slots.length > 0 && slots.every((entry) => entry.state === 'deferred'),
      hasUnresolved: slots.some((entry) => entry.state === 'unresolved' && entry.slot.required),
      hasInvalidTarget: slots.some((entry) => entry.state === 'invalid_target'),
    });
  }

  const credentialSet = new Set<string>();
  if (selection.includeCredentials) {
    for (const itemId of selectedItemIds) {
      if (blockedByItemId.has(itemId)) continue;
      const item = index.itemById.get(itemId);
      if (item === undefined) continue;
      for (const credId of item.coupledCredentialIds) {
        credentialSet.add(credId);
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
    coupledCredentialIds: [...credentialSet].sort(),
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
  const scopeItemIds = new Set((index.itemsByScope.get(scope) ?? []).map((item) => item.id));
  const enabledScopes = new Set(selection.enabledScopes);
  if (checked) enabledScopes.add(scope);
  else enabledScopes.delete(scope);

  const excludedIds = selection.excludedIds.filter((id) => !scopeItemIds.has(id));
  const includedIds = selection.includedIds.filter((id) => !scopeItemIds.has(id));
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
    while (queue.length > 0) {
      const currentId = queue.shift()!;
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
    while (queue.length > 0) {
      const removedId = queue.shift()!;
      const consumers = index.reverseHardConsumers.get(removedId) ?? [];
      for (const consumerId of consumers) {
        if (visited.has(consumerId)) continue;
        const consumer = index.itemById.get(consumerId);
        if (consumer === undefined || !consumer.selectable) continue;
        const hardEdge = consumer.dependencyEdges.find((edge) => edge.kind === 'hard' && edge.toId === removedId);
        if (hardEdge === undefined || hardEdge.liveSatisfied) continue;
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
    excludedIds: [...excluded].sort(),
    includedIds: [...included].sort(),
    includeCredentials: selection.includeCredentials,
  };
}
