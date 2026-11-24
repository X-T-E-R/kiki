import { createHash } from 'node:crypto';
import type { UnboundModelHoldEntry } from '@kiki/agent-core-v2';
import {
  evaluateSubscriptionSelection,
  PORTABLE_SUBSCRIPTION_SCOPES,
  type PortableSpaceBindingChoices,
  type PortableSpaceImpact,
  type PortableSpaceSubscriptionSelection,
  type PortableSubscriptionScope,
} from '@kiki/protocol';
import { modelDependencies, sameUnit, unitHash, type VerifiedBase } from './mergeEngine';
import {
  buildSubscriptionDependencyGraph,
  projectModelBindingsForSelection,
  type SubscriptionDependencyGraph,
} from './subscriptionGraph';
import { encodeUnitId, encodeUnitSegment, scopeForUnit } from './subscriptionScopes';
import { object, type Data, type SpaceUnit, type Units } from './treeProjection';
import {
  assertNoRemoteExecutableMcp,
  assertSafeRemoteCredentialBindings,
  reconcileSubscriptionUnits,
} from './urlSubscription';

export interface PendingTransferRecord {
  readonly unitIds: readonly string[];
  readonly beforeDigests: Readonly<Record<string, string>>;
  readonly priorBindingFingerprints: Readonly<Record<string, string>>;
  readonly desiredGeneration: number;
  readonly reason: string;
  readonly recordedAt: string;
}

export interface SubscriptionSourcePlanState {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly syncPolicy: 'auto' | 'manual';
  readonly selection?: PortableSpaceSubscriptionSelection;
  readonly bindingChoices: PortableSpaceBindingChoices;
  readonly managedIds: readonly string[];
  readonly appliedExpectedHashes: Readonly<Record<string, string>>;
  readonly declaredUnitIds: readonly string[];
  readonly base?: VerifiedBase;
  readonly rawBaseUnits?: Units;
  readonly baseGeneration: number;
  readonly pendingTransfers: readonly PendingTransferRecord[];
  readonly preservedLocalIds: readonly string[];
}

export interface WinnerIndex {
  readonly winnerByUnitId: ReadonlyMap<string, string>;
  readonly candidatesByUnitId: ReadonlyMap<string, readonly string[]>;
  readonly currentOwnerByUnitId: ReadonlyMap<string, string>;
}

export interface RelinquishmentPlan {
  readonly nextUnits: Units;
  readonly impact: PortableSpaceImpact;
  readonly remainingManagedBySource: Map<string, Set<string>>;
  readonly updatedExpectedHashesBySource: Map<string, Record<string, string>>;
  readonly pendingTransfersToRecord: Map<string, PendingTransferRecord[]>;
  readonly newlyPreservedLocalIds: Set<string>;
}

export interface SubscriptionApplyPlan {
  readonly nextUnits: Units;
  readonly nextRawBaseUnits: Units;
  readonly nextManagedIds: string[];
  readonly nextAppliedExpectedHashes: Record<string, string>;
  readonly nextDeclaredUnitIds: string[];
  readonly appliedIds: string[];
  readonly deletedIds: string[];
  readonly skippedIds: string[];
  readonly impact: PortableSpaceImpact;
  readonly holdsToUpsert: UnboundModelHoldEntry[];
  readonly clearedHoldTargets: { readonly targetKind: 'profile' | 'persona' | 'recipe'; readonly targetName: string; readonly sourceModelId: string }[];
  readonly peerManagedUpdates: Map<string, Set<string>>;
  readonly peerExpectedHashUpdates: Map<string, Record<string, string>>;
  readonly pendingTransfersToRecord: Map<string, PendingTransferRecord[]>;
  readonly newlyPreservedLocalIds: Set<string>;
}

const USER_KEEP_IDS = new Set([
  'config:default_model',
  'config:default_provider',
  'config:default_permission_mode',
  'config:default_plan_mode',
  'config:thinking',
  'config:fast_model',
  'config:session_title',
  'config:disabled_skills',
  'config:disabled_named_profiles',
]);

/** Computes an O(S + U) indexed winner and current-owner map across all ordered URL subscriptions for one space. */
export function computeWinnerIndex(sources: readonly SubscriptionSourcePlanState[]): WinnerIndex {
  const ordered = [...sources].sort((a, b) => a.priority - b.priority);
  const winnerByUnitId = new Map<string, string>();
  const candidatesByUnitId = new Map<string, string[]>();
  const currentOwnerByUnitId = new Map<string, string>();

  for (const source of ordered) {
    for (const managedId of source.managedIds) {
      if (!currentOwnerByUnitId.has(managedId)) {
        currentOwnerByUnitId.set(managedId, source.id);
      }
    }
    if (!source.enabled) continue;
    for (const unitId of source.declaredUnitIds) {
      let list = candidatesByUnitId.get(unitId);
      if (list === undefined) {
        list = [];
        candidatesByUnitId.set(unitId, list);
      }
      list.push(source.id);
      if (!winnerByUnitId.has(unitId)) {
        winnerByUnitId.set(unitId, source.id);
      }
    }
  }

  return { winnerByUnitId, candidatesByUnitId, currentOwnerByUnitId };
}

/** Builds an empty sorted PortableSpaceImpact object for a given prior managed count. */
export function emptyImpact(managedCount: number): PortableSpaceImpact {
  return {
    managedCount,
    deletedIds: [],
    handedOffIds: [],
    preservedLocalIds: [],
    preservedDependencyIds: [],
    pendingReconcileIds: [],
    addedIds: [],
    updatedIds: [],
  };
}

/** Computes a deterministic impact digest bound to selection, bindings, cleanup flag, revisions, and impact buckets. */
export function computeImpactDigest(input: {
  readonly targetSpaceId: string;
  readonly sourceId: string;
  readonly selection?: PortableSpaceSubscriptionSelection;
  readonly bindingChoices?: PortableSpaceBindingChoices;
  readonly cleanupDeselected?: boolean;
  readonly purgeManaged?: boolean;
  readonly catalogRevision: string;
  readonly targetRevision: string;
  readonly impact: PortableSpaceImpact;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** Expands a UI selection into the admitted physical unit subset (including coupled credentials when includeCredentials is true). */
export function selectPhysicalUnitsForSelection(
  packUnits: Units,
  graph: SubscriptionDependencyGraph,
  selection: PortableSpaceSubscriptionSelection,
  bindings: PortableSpaceBindingChoices,
): {
  readonly selectedEntityIds: ReadonlySet<string>;
  readonly selectedUnits: Units;
  readonly declaredUnitIds: string[];
  readonly selectedCredentialIds: Set<string>;
} {
  const manifestLike = {
    items: graph.entities.map((entity) => {
      const meta = graph.metadataByEntityId.get(entity.id)!;
      return {
        id: entity.id,
        scope: entity.scope,
        domain: entity.domain,
        label: entity.label,
        path: entity.path,
        memberUnitIds: [...entity.memberUnitIds],
        dependsOnIds: [...new Set([...meta.hardDependsOnIds, ...meta.softDependsOnIds])].sort(),
        softDependsOnIds: meta.softDependsOnIds,
        referencedByIds: [...(graph.referencedByIds.get(entity.id) ?? [])],
        dependencyEdges: meta.dependencyEdges,
        coupledCredentialIds: meta.coupledCredentialIds,
        liveSatisfiedIds: meta.dependencyEdges.filter((edge) => edge.liveSatisfied).map((edge) => edge.toId),
        blockedDependencyIds: meta.blockedDependencyIds,
        status: meta.blockedReason !== undefined ? 'blocked' as const : 'will_write' as const,
        selectable: meta.blockedReason === undefined,
        selected: false,
      };
    }),
    bindingSlots: [...graph.bindingSlots],
    localModelOptions: [...graph.localModelOptions],
  };

  const evaluation = evaluateSubscriptionSelection(manifestLike, selection, bindings);
  const selectedUnits: Units = new Map();
  const selectedCredentialIds = new Set<string>();

  for (const entityId of evaluation.selectedItemIds) {
    if (evaluation.blockedByItemId.has(entityId)) continue;
    const entity = graph.entityById.get(entityId);
    if (entity === undefined) continue;
    for (const memberId of entity.memberUnitIds) {
      const unit = packUnits.get(memberId);
      if (unit !== undefined) selectedUnits.set(memberId, unit);
    }
    if (selection.includeCredentials) {
      const meta = graph.metadataByEntityId.get(entityId);
      for (const credId of meta?.coupledCredentialIds ?? []) {
        const credUnit = packUnits.get(credId);
        if (credUnit !== undefined) {
          selectedUnits.set(credId, credUnit);
          selectedCredentialIds.add(credId);
        }
      }
    }
  }

  return {
    selectedEntityIds: evaluation.selectedItemIds,
    selectedUnits,
    declaredUnitIds: [...selectedUnits.keys()].sort(),
    selectedCredentialIds,
  };
}

function bindingFingerprintForUnit(unit: SpaceUnit | undefined): string {
  if (unit === undefined) return '';
  if (unit.domain === 'config' && unit.key[0] === 'providers') {
    const rec = object(unit.value);
    return JSON.stringify({ type: rec['type'], base_url: rec['base_url'], credential_id: rec['credential_id'] });
  }
  if (unit.domain === 'mcp') {
    const rec = object(unit.value);
    return JSON.stringify({ url: rec['url'], command: rec['command'], args: rec['args'] });
  }
  return '';
}

function connectedGroupForUnit(
  unitId: string,
  allUnits: Units,
): string[] {
  const group = new Set<string>([unitId]);
  const unit = allUnits.get(unitId);
  if (unit === undefined) return [unitId];
  if (unit.domain === 'config' && unit.key[0] === 'providers' && unit.key[1] !== undefined) {
    const providerId = unit.key[1];
    const credId = encodeUnitId('credentials', ['providers', providerId]);
    if (allUnits.has(credId)) group.add(credId);
    const explicitCred = object(unit.value)['credential_id'];
    const poolIds = new Set<string>([providerId, ...(typeof explicitCred === 'string' && explicitCred.trim() ? [explicitCred.trim()] : [])]);
    for (const poolKey of poolIds) {
      const poolUnitId = encodeUnitId('credentials', ['pool', poolKey]);
      if (allUnits.has(poolUnitId)) group.add(poolUnitId);
    }
  } else if (unit.domain === 'credentials' && unit.key[0] === 'providers' && unit.key[1] !== undefined) {
    const providerUnitId = encodeUnitId('config', ['providers', unit.key[1]]);
    if (allUnits.has(providerUnitId)) group.add(providerUnitId);
  } else if (unit.domain === 'mcp' && unit.key[0] !== undefined) {
    const credId = encodeUnitId('credentials', ['mcp', unit.key[0]]);
    if (allUnits.has(credId)) group.add(credId);
  } else if (unit.domain === 'credentials' && unit.key[0] === 'mcp' && unit.key[1] !== undefined) {
    const mcpUnitId = encodeUnitId('mcp', [unit.key[1]]);
    if (allUnits.has(mcpUnitId)) group.add(mcpUnitId);
  }
  return [...group].sort();
}

function isRequiredBySurvivingUnits(
  candidateId: string,
  candidateSet: ReadonlySet<string>,
  survivingUnits: Units,
): boolean {
  const unit = survivingUnits.get(candidateId);
  if (unit === undefined) return false;
  if (unit.domain === 'config' && unit.key[0] === 'providers' && unit.key[1] !== undefined) {
    const providerId = unit.key[1];
    for (const [otherId, other] of survivingUnits) {
      if (candidateSet.has(otherId)) continue;
      if (other.domain === 'config' && other.key[0] === 'models') {
        const rec = object(other.value);
        if (rec['provider'] === providerId || rec['provider_id'] === providerId) return true;
      }
    }
  }
  if (unit.domain === 'credentials' && unit.key[0] === 'pool' && unit.key[1] !== undefined) {
    const poolKey = unit.key[1];
    for (const [otherId, other] of survivingUnits) {
      if (candidateSet.has(otherId)) continue;
      if (other.domain === 'config' && (other.key[0] === 'providers' || other.key[0] === 'models')) {
        const rec = object(other.value);
        if (rec['credential_id'] === poolKey || (other.key[0] === 'providers' && other.key[1] === poolKey)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Plans pure side-effect-free relinquishment (delete / handoff / preserve-local / preserve-dependency / pending-reconcile) per Frame Audit §2. */
export function planRelinquishment(input: {
  readonly source: SubscriptionSourcePlanState;
  readonly relinquishUnitIds: readonly string[];
  readonly targetUnits: Units;
  readonly peers: readonly SubscriptionSourcePlanState[];
  readonly hashKey: string;
  readonly deleteUnmodified: boolean;
}): RelinquishmentPlan {
  const { source, relinquishUnitIds, targetUnits, peers, hashKey, deleteUnmodified } = input;
  const nextUnits: Units = new Map(targetUnits);
  const remainingManagedBySource = new Map<string, Set<string>>();
  const updatedExpectedHashesBySource = new Map<string, Record<string, string>>();
  const pendingTransfersToRecord = new Map<string, PendingTransferRecord[]>();
  const newlyPreservedLocalIds = new Set<string>();

  remainingManagedBySource.set(source.id, new Set(source.managedIds));
  updatedExpectedHashesBySource.set(source.id, { ...source.appliedExpectedHashes });
  for (const peer of peers) {
    remainingManagedBySource.set(peer.id, new Set(peer.managedIds));
    updatedExpectedHashesBySource.set(peer.id, { ...peer.appliedExpectedHashes });
  }

  const deleted = new Set<string>();
  const handedOff = new Set<string>();
  const preservedLocal = new Set<string>();
  const preservedDependency = new Set<string>();
  const pendingReconcile = new Set<string>();

  const enabledPeers = [...peers]
    .filter((peer) => peer.enabled && peer.id !== source.id)
    .sort((a, b) => a.priority - b.priority);

  const relinquishSet = new Set(relinquishUnitIds.filter((id) => source.managedIds.includes(id)));

  if (!deleteUnmodified) {
    for (const id of relinquishSet) {
      remainingManagedBySource.get(source.id)!.delete(id);
      delete updatedExpectedHashesBySource.get(source.id)![id];
      if (targetUnits.has(id)) {
        preservedLocal.add(id);
        newlyPreservedLocalIds.add(id);
      }
    }
    return {
      nextUnits,
      impact: {
        managedCount: source.managedIds.length,
        deletedIds: [],
        handedOffIds: [],
        preservedLocalIds: [...preservedLocal].sort(),
        preservedDependencyIds: [],
        pendingReconcileIds: [],
        addedIds: [],
        updatedIds: [],
      },
      remainingManagedBySource,
      updatedExpectedHashesBySource,
      pendingTransfersToRecord,
      newlyPreservedLocalIds,
    };
  }

  const processed = new Set<string>();
  const sortedRelinquish = [...relinquishSet].sort();

  for (const seedId of sortedRelinquish) {
    if (processed.has(seedId)) continue;
    const rawGroup = connectedGroupForUnit(seedId, targetUnits);
    const groupIds = rawGroup.filter((id) => relinquishSet.has(id) && !processed.has(id));
    if (groupIds.length === 0) continue;
    for (const id of groupIds) processed.add(id);

    const sourceManaged = remainingManagedBySource.get(source.id)!;
    const sourceExpected = updatedExpectedHashesBySource.get(source.id)!;
    for (const id of groupIds) {
      sourceManaged.delete(id);
      delete sourceExpected[id];
    }

    const anyKeepOrModified = groupIds.some((id) => {
      if (USER_KEEP_IDS.has(id)) return true;
      const liveUnit = targetUnits.get(id);
      if (liveUnit === undefined) return true;
      if (id === 'config:error_telemetry' && object(liveUnit.value)['enabled'] === false) return true;
      const expectedDigest = source.appliedExpectedHashes[id] ?? source.base?.hashes[id];
      if (expectedDigest === undefined) return true;
      return unitHash(liveUnit, hashKey) !== expectedDigest;
    });

    if (anyKeepOrModified) {
      for (const id of groupIds) {
        if (targetUnits.has(id)) {
          preservedLocal.add(id);
          newlyPreservedLocalIds.add(id);
        }
      }
      continue;
    }

    const winningPeer = enabledPeers.find((peer) => groupIds.some((id) => peer.declaredUnitIds.includes(id)));
    if (winningPeer !== undefined) {
      const peerManaged = remainingManagedBySource.get(winningPeer.id)!;
      const peerExpected = updatedExpectedHashesBySource.get(winningPeer.id)!;
      const peerHasAllPublic = groupIds.every((id) => {
        const liveUnit = targetUnits.get(id);
        if (liveUnit === undefined) return false;
        if (liveUnit.domain === 'credentials') return true;
        return winningPeer.base?.units.has(id) === true;
      });
      const peerSecretsSafe = groupIds.every((id) => {
        const liveUnit = targetUnits.get(id);
        if (liveUnit === undefined || liveUnit.domain !== 'credentials') return true;
        const peerHash = winningPeer.base?.hashes[id];
        if (peerHash === undefined) return false;
        return unitHash(liveUnit, hashKey) === peerHash;
      });

      let handoffSucceeded = false;
      if (peerHasAllPublic && peerSecretsSafe && winningPeer.base !== undefined) {
        const candidateNext: Units = new Map(nextUnits);
        let allValid = true;
        for (const id of groupIds) {
          const liveUnit = targetUnits.get(id)!;
          if (liveUnit.domain === 'credentials') {
            candidateNext.set(id, liveUnit);
          } else {
            const peerUnit = winningPeer.base.units.get(id);
            if (peerUnit === undefined) {
              allValid = false;
              break;
            }
            candidateNext.set(id, peerUnit);
          }
        }
        if (allValid) {
          try {
            let projectedCandidate = candidateNext;
            if (winningPeer.rawBaseUnits !== undefined) {
              const peerGraph = buildSubscriptionDependencyGraph(winningPeer.rawBaseUnits, candidateNext);
              const peerSelectedIds = new Set<string>();
              for (const id of groupIds) {
                const entityId = peerGraph.entityIdByMemberUnitId.get(id);
                if (entityId !== undefined) peerSelectedIds.add(entityId);
              }
              if (peerSelectedIds.size > 0) {
                const projected = projectModelBindingsForSelection({
                  rawUnits: winningPeer.rawBaseUnits,
                  selectedEntityIds: peerSelectedIds,
                  graph: peerGraph,
                  choices: winningPeer.bindingChoices,
                  sourceId: winningPeer.id,
                  strict: true,
                });
                for (const id of groupIds) {
                  const mapped = projected.projectedUnits.get(id);
                  if (mapped !== undefined) projectedCandidate.set(id, mapped);
                }
              }
            }
            const peerOriginCheckUnits = new Map<string, SpaceUnit>();
            for (const id of groupIds) {
              const unit = projectedCandidate.get(id);
              if (unit !== undefined) peerOriginCheckUnits.set(id, unit);
            }
            assertNoRemoteExecutableMcp(projectedCandidate, targetUnits, groupIds);
            assertSafeRemoteCredentialBindings(projectedCandidate, targetUnits, peerOriginCheckUnits, winningPeer.managedIds);
            const depErrors = modelDependencies(projectedCandidate);
            if (depErrors.length === 0) {
              for (const id of groupIds) {
                const liveUnit = targetUnits.get(id);
                const nextUnit = projectedCandidate.get(id)!;
                if (liveUnit !== undefined && liveUnit.domain === 'config' && liveUnit.key[0] === 'providers') {
                  const credUnitId = encodeUnitId('credentials', ['providers', liveUnit.key[1]!]);
                  if (groupIds.includes(credUnitId) && bindingFingerprintForUnit(liveUnit) !== bindingFingerprintForUnit(nextUnit)) {
                    throw new Error('Cannot retarget retained credential across different provider origin during offline handoff');
                  }
                }
              }
              for (const id of groupIds) {
                const unit = projectedCandidate.get(id)!;
                nextUnits.set(id, unit);
                peerManaged.add(id);
                peerExpected[id] = unitHash(unit, hashKey);
                handedOff.add(id);
              }
              handoffSucceeded = true;
            }
          } catch {
            handoffSucceeded = false;
          }
        }
      }

      if (!handoffSucceeded) {
        const beforeDigests: Record<string, string> = {};
        const priorBindingFingerprints: Record<string, string> = {};
        for (const id of groupIds) {
          const liveUnit = targetUnits.get(id);
          if (liveUnit !== undefined) {
            beforeDigests[id] = unitHash(liveUnit, hashKey);
            const fp = bindingFingerprintForUnit(liveUnit);
            if (fp.length > 0) priorBindingFingerprints[id] = fp;
          }
          pendingReconcile.add(id);
        }
        const existingPending = pendingTransfersToRecord.get(winningPeer.id) ?? [];
        existingPending.push({
          unitIds: groupIds,
          beforeDigests,
          priorBindingFingerprints,
          desiredGeneration: winningPeer.baseGeneration + 1,
          reason: 'Deferred peer handoff requires fresh upstream fetch or rebinding',
          recordedAt: new Date().toISOString(),
        });
        pendingTransfersToRecord.set(winningPeer.id, existingPending);
      }
      continue;
    }

    const groupSet = new Set(groupIds);
    const anyDepRequired = groupIds.some((id) => isRequiredBySurvivingUnits(id, groupSet, nextUnits));
    if (anyDepRequired) {
      for (const id of groupIds) {
        preservedDependency.add(id);
      }
      continue;
    }

    for (const id of groupIds) {
      nextUnits.delete(id);
      deleted.add(id);
    }
  }

  return {
    nextUnits,
    impact: {
      managedCount: source.managedIds.length,
      deletedIds: [...deleted].sort(),
      handedOffIds: [...handedOff].sort(),
      preservedLocalIds: [...preservedLocal].sort(),
      preservedDependencyIds: [...preservedDependency].sort(),
      pendingReconcileIds: [...pendingReconcile].sort(),
      addedIds: [],
      updatedIds: [],
    },
    remainingManagedBySource,
    updatedExpectedHashesBySource,
    pendingTransfersToRecord,
    newlyPreservedLocalIds,
  };
}

/** Plans one authorized subscription apply (new subscribe, edit selection, or sync) through the pure multi-source planner. */
export function planSubscriptionApply(input: {
  readonly source: SubscriptionSourcePlanState;
  readonly upstreamUnits: Units;
  readonly targetUnits: Units;
  readonly peers: readonly SubscriptionSourcePlanState[];
  readonly hashKey: string;
  readonly selection?: PortableSpaceSubscriptionSelection;
  readonly bindingChoices: PortableSpaceBindingChoices;
  readonly isFirstSubscribe: boolean;
  readonly cleanupDeselected: boolean;
  readonly strictBindings?: boolean;
}): SubscriptionApplyPlan {
  const {
    source,
    upstreamUnits,
    targetUnits,
    peers,
    hashKey,
    selection,
    bindingChoices,
    isFirstSubscribe,
    cleanupDeselected,
    strictBindings = true,
  } = input;

  const graph = buildSubscriptionDependencyGraph(upstreamUnits, targetUnits);

  let selectedRawUnits: Units;
  let selectedEntityIds: ReadonlySet<string>;
  if (selection !== undefined) {
    const selected = selectPhysicalUnitsForSelection(upstreamUnits, graph, selection, bindingChoices);
    selectedRawUnits = selected.selectedUnits;
    selectedEntityIds = selected.selectedEntityIds;
  } else {
    selectedRawUnits = new Map(upstreamUnits);
    selectedEntityIds = new Set(
      graph.entities
        .filter((entity) => graph.metadataByEntityId.get(entity.id)?.blockedReason === undefined)
        .map((entity) => entity.id),
    );
  }

  const projection = projectModelBindingsForSelection({
    rawUnits: selectedRawUnits,
    selectedEntityIds,
    graph,
    choices: bindingChoices,
    sourceId: source.id,
    strict: strictBindings,
  });

  const allSourcesForWinner: SubscriptionSourcePlanState[] = [
    ...peers.filter((peer) => peer.id !== source.id),
    {
      ...source,
      declaredUnitIds: [...selectedRawUnits.keys()].sort(),
    },
  ];
  const winnerIndex = computeWinnerIndex(allSourcesForWinner);

  const peerManagedIds = new Set<string>();
  const higherPriorityWinnerIds = new Set<string>();
  const lowerPriorityPeerByUnitId = new Map<string, SubscriptionSourcePlanState>();
  for (const peer of peers) {
    if (peer.id === source.id) continue;
    for (const id of peer.managedIds) peerManagedIds.add(id);
    if (peer.priority > source.priority) {
      for (const id of peer.managedIds) lowerPriorityPeerByUnitId.set(id, peer);
    }
  }
  for (const [unitId, winnerId] of winnerIndex.winnerByUnitId) {
    if (winnerId !== source.id) higherPriorityWinnerIds.add(unitId);
  }

  const winningIncomingUnits: Units = new Map();
  const skippedByPriority: string[] = [];
  for (const [id, unit] of projection.projectedUnits) {
    if (higherPriorityWinnerIds.has(id)) {
      skippedByPriority.push(id);
      continue;
    }
    winningIncomingUnits.set(id, unit);
  }

  const verifiedTransferIds = new Set<string>();
  const blockedTransferIds = new Set<string>();
  for (const pending of source.pendingTransfers) {
    const allIncoming = pending.unitIds.every((id) => winningIncomingUnits.has(id));
    let anyLocallyModified = false;
    let allMatchExpected = pending.unitIds.length > 0;
    for (const id of pending.unitIds) {
      const liveUnit = targetUnits.get(id);
      const expected = pending.beforeDigests[id];
      if (liveUnit === undefined || expected === undefined) {
        allMatchExpected = false;
        continue;
      }
      if (unitHash(liveUnit, hashKey) !== expected) {
        anyLocallyModified = true;
        allMatchExpected = false;
      }
    }
    if (allIncoming && allMatchExpected && !anyLocallyModified) {
      for (const id of pending.unitIds) verifiedTransferIds.add(id);
    } else if (anyLocallyModified) {
      for (const id of pending.unitIds) {
        blockedTransferIds.add(id);
        winningIncomingUnits.delete(id);
      }
    }
  }

  const effectiveTarget: Units = new Map(targetUnits);
  const relinquishedFromSelection = source.managedIds.filter((id) => !winningIncomingUnits.has(id));
  const relinqPlan = planRelinquishment({
    source,
    relinquishUnitIds: relinquishedFromSelection,
    targetUnits: effectiveTarget,
    peers,
    hashKey,
    deleteUnmodified: cleanupDeselected,
  });

  const afterRelinquishUnits = relinqPlan.nextUnits;
  const remainingManagedForSource = [
    ...new Set([
      ...(relinqPlan.remainingManagedBySource.get(source.id) ?? new Set<string>()),
      ...verifiedTransferIds,
    ]),
  ];
  const priorBaseForReconcile: VerifiedBase | undefined = source.base === undefined
    ? undefined
    : {
        hashes: { ...source.base.hashes, ...source.appliedExpectedHashes },
        units: source.base.units,
      };

  const merged = reconcileSubscriptionUnits(
    winningIncomingUnits,
    afterRelinquishUnits,
    remainingManagedForSource,
    priorBaseForReconcile,
    isFirstSubscribe,
  );

  const nextUnits = new Map(merged.nextUnits);
  const nextManagedSet = new Set(merged.nextManagedIds);
  const appliedSet = new Set(merged.appliedIds);
  const deletedSet = new Set(merged.deletedIds);
  const skippedSet = new Set(merged.skippedIds);
  const preservedFromCreds = new Set<string>(blockedTransferIds);
  for (const id of blockedTransferIds) skippedSet.add(id);

  for (const id of verifiedTransferIds) {
    const incoming = winningIncomingUnits.get(id);
    if (incoming === undefined) continue;
    nextUnits.set(id, incoming);
    nextManagedSet.add(id);
    appliedSet.add(id);
    skippedSet.delete(id);
    deletedSet.delete(id);
  }

  for (const [id, incoming] of winningIncomingUnits) {
    if (incoming.domain !== 'credentials') continue;
    if (verifiedTransferIds.has(id) || blockedTransferIds.has(id)) continue;
    const liveCurrent = afterRelinquishUnits.get(id);
    if (liveCurrent === undefined) {
      if (selection === undefined || selection.includeCredentials) {
        nextUnits.set(id, incoming);
        nextManagedSet.add(id);
        appliedSet.add(id);
        skippedSet.delete(id);
      }
      continue;
    }
    if (appliedSet.has(id)) {
      nextManagedSet.add(id);
      continue;
    }
    if (source.managedIds.includes(id)) {
      const expected = source.appliedExpectedHashes[id];
      if (expected !== undefined && unitHash(liveCurrent, hashKey) === expected) {
        nextManagedSet.add(id);
      } else if (expected !== undefined) {
        nextManagedSet.delete(id);
        preservedFromCreds.add(id);
      }
    }
  }

  const nextManagedIds = [...nextManagedSet].sort();
  const finalAppliedIds = [...appliedSet].sort();
  const finalDeletedIds = [...deletedSet].sort();
  const finalSkippedIds = [...skippedSet].sort();

  const peerManagedUpdates = new Map<string, Set<string>>(relinqPlan.remainingManagedBySource);
  const peerExpectedHashUpdates = new Map<string, Record<string, string>>(relinqPlan.updatedExpectedHashesBySource);
  for (const id of nextManagedIds) {
    const lowerOwner = lowerPriorityPeerByUnitId.get(id);
    if (lowerOwner !== undefined) {
      peerManagedUpdates.get(lowerOwner.id)?.delete(id);
      const hashes = peerExpectedHashUpdates.get(lowerOwner.id);
      if (hashes !== undefined) delete hashes[id];
    }
  }

  assertNoRemoteExecutableMcp(nextUnits, targetUnits, [...finalAppliedIds, ...finalDeletedIds]);
  assertSafeRemoteCredentialBindings(nextUnits, targetUnits, winningIncomingUnits, [...new Set([...source.managedIds, ...verifiedTransferIds])]);
  const depErrors = modelDependencies(nextUnits);
  if (depErrors.length > 0) throw new Error(depErrors.join('; '));

  const nextAppliedExpectedHashes: Record<string, string> = {};
  for (const id of nextManagedIds) {
    const unit = nextUnits.get(id);
    if (unit !== undefined) {
      nextAppliedExpectedHashes[id] = unitHash(unit, hashKey);
    }
  }

  const addedIds: string[] = [];
  const updatedIds: string[] = [];
  for (const id of finalAppliedIds) {
    if (!targetUnits.has(id)) addedIds.push(id);
    else if (!sameUnit(nextUnits.get(id), targetUnits.get(id))) updatedIds.push(id);
  }

  const combinedPreservedLocal = [...new Set([...relinqPlan.impact.preservedLocalIds, ...preservedFromCreds])].sort();
  const impact: PortableSpaceImpact = {
    managedCount: source.managedIds.length,
    deletedIds: [...new Set([...relinqPlan.impact.deletedIds, ...finalDeletedIds])].sort(),
    handedOffIds: relinqPlan.impact.handedOffIds,
    preservedLocalIds: combinedPreservedLocal,
    preservedDependencyIds: relinqPlan.impact.preservedDependencyIds,
    pendingReconcileIds: relinqPlan.impact.pendingReconcileIds,
    addedIds: addedIds.sort(),
    updatedIds: updatedIds.sort(),
  };

  return {
    nextUnits,
    nextRawBaseUnits: selectedRawUnits,
    nextManagedIds,
    nextAppliedExpectedHashes,
    nextDeclaredUnitIds: [...selectedRawUnits.keys()].sort(),
    appliedIds: finalAppliedIds,
    deletedIds: impact.deletedIds,
    skippedIds: [...new Set([...finalSkippedIds, ...skippedByPriority])].sort(),
    impact,
    holdsToUpsert: projection.holdsToUpsert,
    clearedHoldTargets: projection.clearedTargets,
    peerManagedUpdates,
    peerExpectedHashUpdates,
    pendingTransfersToRecord: relinqPlan.pendingTransfersToRecord,
    newlyPreservedLocalIds: new Set([...relinqPlan.newlyPreservedLocalIds, ...preservedFromCreds]),
  };
}

/** Plans a one-shot import (`syncPolicy: 'once'`) using all safety guards without registering a source or overwriting peer-managed units. */
export function planOnceImport(input: {
  readonly upstreamUnits: Units;
  readonly targetUnits: Units;
  readonly peers: readonly SubscriptionSourcePlanState[];
  readonly selection: PortableSpaceSubscriptionSelection;
  readonly bindingChoices: PortableSpaceBindingChoices;
}): {
  readonly nextUnits: Units;
  readonly appliedIds: string[];
  readonly deletedIds: string[];
  readonly skippedIds: string[];
  readonly impact: PortableSpaceImpact;
  readonly holdsToUpsert: UnboundModelHoldEntry[];
  readonly clearedHoldTargets: { readonly targetKind: 'profile' | 'persona' | 'recipe'; readonly targetName: string; readonly sourceModelId: string }[];
} {
  const { upstreamUnits, targetUnits, peers, selection, bindingChoices } = input;
  const graph = buildSubscriptionDependencyGraph(upstreamUnits, targetUnits);
  const selected = selectPhysicalUnitsForSelection(upstreamUnits, graph, selection, bindingChoices);
  const projection = projectModelBindingsForSelection({
    rawUnits: selected.selectedUnits,
    selectedEntityIds: selected.selectedEntityIds,
    graph,
    choices: bindingChoices,
    strict: true,
  });

  const peerManaged = new Set<string>();
  for (const peer of peers) {
    for (const id of peer.managedIds) peerManaged.add(id);
  }

  const filteredIncoming: Units = new Map();
  const skippedByPeer: string[] = [];
  for (const [id, unit] of projection.projectedUnits) {
    if (peerManaged.has(id)) {
      skippedByPeer.push(id);
      continue;
    }
    filteredIncoming.set(id, unit);
  }

  const merged = reconcileSubscriptionUnits(filteredIncoming, targetUnits, [], undefined, true);
  assertNoRemoteExecutableMcp(merged.nextUnits, targetUnits, merged.appliedIds);
  assertSafeRemoteCredentialBindings(merged.nextUnits, targetUnits, filteredIncoming, []);
  const depErrors = modelDependencies(merged.nextUnits);
  if (depErrors.length > 0) throw new Error(depErrors.join('; '));

  const addedIds: string[] = [];
  const updatedIds: string[] = [];
  for (const id of merged.appliedIds) {
    if (!targetUnits.has(id)) addedIds.push(id);
    else if (!sameUnit(merged.nextUnits.get(id), targetUnits.get(id))) updatedIds.push(id);
  }

  return {
    nextUnits: merged.nextUnits,
    appliedIds: merged.appliedIds,
    deletedIds: [],
    skippedIds: [...new Set([...merged.skippedIds, ...skippedByPeer])].sort(),
    impact: {
      managedCount: 0,
      deletedIds: [],
      handedOffIds: [],
      preservedLocalIds: [],
      preservedDependencyIds: [],
      pendingReconcileIds: [],
      addedIds: addedIds.sort(),
      updatedIds: updatedIds.sort(),
    },
    holdsToUpsert: projection.holdsToUpsert,
    clearedHoldTargets: projection.clearedTargets,
  };
}

/** Computes the set of non-empty scopes present in a pack that were not previously seen by this subscription. */
export function computeAvailableNewScopes(
  presentScopes: readonly PortableSubscriptionScope[],
  seenScopes: readonly PortableSubscriptionScope[] | undefined,
): PortableSubscriptionScope[] {
  if (seenScopes === undefined) return [];
  const seen = new Set(seenScopes);
  return PORTABLE_SUBSCRIPTION_SCOPES.filter((scope) => presentScopes.includes(scope) && !seen.has(scope));
}

/** Extracts the canonical set of non-empty scopes present in a sanitized unit map. */
export function presentScopesInUnits(units: Units): PortableSubscriptionScope[] {
  const present = new Set<PortableSubscriptionScope>();
  for (const unit of units.values()) {
    const scope = scopeForUnit(unit);
    if (scope !== undefined) present.add(scope);
  }
  return PORTABLE_SUBSCRIPTION_SCOPES.filter((scope) => present.has(scope));
}
