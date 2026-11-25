import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  clearUnboundModelHoldsForTarget,
  readUnboundModelHolds,
  upsertUnboundModelHolds,
  type IAtomicDocumentStore,
} from '@kiki/agent-core-v2';
import {
  evaluateSubscriptionSelection,
  parseBindingSlotTupleKey,
  PORTABLE_SPACE_DIFF_PREVIEW_MAX_CHARS,
  PORTABLE_SPACE_MAX_MANIFEST_BYTES,
  PORTABLE_SUBSCRIPTION_SCOPES,
  type PortableSpaceBindingChoices,
  type PortableSpaceCenterCommit,
  type PortableSpaceCenterDirectSyncInput,
  type PortableSpaceCenterSource,
  type PortableSpaceCenterSourcesListResponse,
  type PortableSpaceCenterSubscribeInput,
  type PortableSpaceCenterTokenSyncInput,
  type PortableSpaceEndpoint,
  type PortableSpaceImpact,
  type PortableSpacePatchSourceInput,
  type PortableSpacePatchSourceResult,
  type PortableSpaceRemovePreviewResult,
  type PortableSpaceRemoveReviewedInput,
  type PortableSpaceRemoveReviewedResponse,
  type PortableSpaceReorderSourcesInput,
  type PortableSpaceReorderSourcesResult,
  type PortableSpaceSourcePreviewInput,
  type PortableSpaceSourceRecord,
  type PortableSpaceStoredSyncPolicy,
  type PortableSpaceSubscribePreviewInput,
  type PortableSpaceSubscribePreviewItem,
  type PortableSpaceSubscribePreviewManifest,
  type PortableSpaceSubscriptionSelection,
  type PortableSpaceSyncPolicy,
  type PortableSubscriptionScope,
} from '@kiki/protocol';
import { endpointKey, type LoadedSpaceTree, type SpaceEndpoints } from './endpoints';
import { reconcileOfficialPlugins, writeLive, type OfficialPluginReconcileError } from './liveSpace';
import { sameUnit, unitHash, unitHashes, type VerifiedBase } from './mergeEngine';
import { missing, readBounded, writeFileAtomic } from './spaceFiles';
import {
  portableNotFound,
  portablePreviewStale,
  portableValidationError,
} from './subscriptionErrors';
import {
  buildLocalModelCatalog,
  buildSubscriptionDependencyGraph,
  computePackDigest,
} from './subscriptionGraph';
import {
  computeAvailableNewScopes,
  computeImpactDigest,
  computeWinnerIndex,
  emptyImpact,
  planOnceImport,
  planRelinquishment,
  planSubscriptionApply,
  presentScopesInUnits,
  type PendingTransferRecord,
  type SubscriptionSourcePlanState,
} from './subscriptionPlanner';
import {
  estimateSnapshotBytes,
  SubscriptionPreviewStore,
  type SubscribePreviewSnapshot,
} from './subscriptionPreviewStore';
import { safePortablePath } from './tarArchive';
import { commonUnits, object, platformUnits, type SpaceUnit, type Units } from './treeProjection';
import { defaultLabelForSubscriptionUrl, sanitizeEtag } from './urlSubscription';

export interface CenterSourceLedgerEntry {
  enabled: boolean;
  syncPolicy: PortableSpaceStoredSyncPolicy;
  selection?: PortableSpaceSubscriptionSelection;
  seenScopes?: PortableSubscriptionScope[];
  revision: string;
  needsReconcile: boolean;
  bindingChoices: PortableSpaceBindingChoices;
  appliedExpectedHashes: Record<string, string>;
  declaredUnitIds: string[];
  baseGeneration: number;
  pendingTransfers: PendingTransferRecord[];
  preservedLocalIds: string[];
}

interface CenterLedgerDocument {
  version: 1;
  orderRevisionBySpace: Record<string, string>;
  sources: Record<string, CenterSourceLedgerEntry>;
}

interface MutationJournalEntry {
  id: string;
  startedAt: string;
  spaceId: string;
  operation: string;
  sourceId?: string;
  stagedGeneration?: number;
  backupPath?: string;
  targetRevision: string;
}

export interface SubscriptionCenterHost {
  readonly endpoints: SpaceEndpoints;
  readonly documents?: IAtomicDocumentStore;
  readonly previewStore: SubscriptionPreviewStore;
  sources(): Promise<PortableSpaceSourceRecord[]>;
  saveSources(items: PortableSpaceSourceRecord[]): Promise<void>;
  loadBase(id: string): Promise<VerifiedBase | undefined>;
  saveBase(id: string, units: Units, key: string, hashes?: Record<string, string>): Promise<void>;
  hashKey(): Promise<string>;
  notifyChanged(spaceId: string, reason: 'subscribed' | 'synced' | 'updated' | 'reordered' | 'removed' | 'imported'): void;
  scheduleAutoReconcile(sourceId: string): void;
}

function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function normalizeLabel(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? fallback).replace(/[\x00-\x1f\x7f]/gu, '').trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback.slice(0, 120);
}

function displayOriginForEndpoint(endpoint: Extract<PortableSpaceEndpoint, { kind: 'url' | 'archive' }>): string {
  if (endpoint.kind === 'archive') {
    return basename(endpoint.path).slice(0, 256) || 'Local archive';
  }
  try {
    return new URL(endpoint.url).origin.slice(0, 256);
  } catch {
    return defaultLabelForSubscriptionUrl(endpoint.url).slice(0, 256);
  }
}

function buildSafeDiff(incoming: SpaceUnit, current: SpaceUnit | undefined): { readonly text?: string; readonly truncated?: boolean } {
  if (incoming.domain === 'credentials') return {};
  const serialize = (unit: SpaceUnit | undefined): string | undefined => {
    if (unit === undefined) return '';
    if (Buffer.isBuffer(unit.value)) {
      const str = unit.value.toString('utf8');
      if (str.includes('\0') || str.includes('\ufffd')) return undefined;
      return str;
    }
    return JSON.stringify(unit.value, null, 2);
  };
  const nextText = serialize(incoming);
  const prevText = serialize(current);
  if (nextText === undefined || prevText === undefined) return {};
  if (nextText === prevText) return {};
  const header = '--- current\n+++ incoming\n';
  const budget = PORTABLE_SPACE_DIFF_PREVIEW_MAX_CHARS - header.length;
  const half = Math.floor(budget / 2) - 4;
  const cut = (text: string, prefix: '-' | '+'): { readonly out: string; readonly truncated: boolean } => {
    if (text.length === 0) return { out: '', truncated: false };
    const lines = text.split('\n').map((line) => `${prefix}${line}`).join('\n');
    if (lines.length <= half) return { out: lines, truncated: false };
    return { out: `${lines.slice(0, Math.max(0, half - 18))}\n... (truncated)`, truncated: true };
  };
  const left = cut(prevText, '-');
  const right = cut(nextText, '+');
  const body = [left.out, right.out].filter(Boolean).join('\n');
  return {
    text: `${header}${body}`.slice(0, PORTABLE_SPACE_DIFF_PREVIEW_MAX_CHARS),
    ...(left.truncated || right.truncated ? { truncated: true } : {}),
  };
}

/** Coordinates the Subscription Center ledger, preview manifest builder, guarded commits, priority ordering, and reviewed removal. */
export class SubscriptionCenterCoordinator {
  constructor(private readonly host: SubscriptionCenterHost) {}

  private get ledgerFile(): string {
    return join(this.host.endpoints.home, 'portable-spaces-center.json');
  }

  private get journalFile(): string {
    return join(this.host.endpoints.home, '.portable-space-journal.json');
  }

  private get baseRoot(): string {
    return join(this.host.endpoints.home, '.portable-space-bases');
  }

  private async readLedger(): Promise<CenterLedgerDocument> {
    const raw = await missing(readBounded(this.ledgerFile));
    if (raw === undefined) return { version: 1, orderRevisionBySpace: {}, sources: {} };
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as Partial<CenterLedgerDocument>;
      return {
        version: 1,
        orderRevisionBySpace: parsed.orderRevisionBySpace ?? {},
        sources: parsed.sources ?? {},
      };
    } catch {
      return { version: 1, orderRevisionBySpace: {}, sources: {} };
    }
  }

  private async saveLedger(doc: CenterLedgerDocument): Promise<void> {
    await writeFileAtomic(this.ledgerFile, `${JSON.stringify(doc, null, 2)}\n`, 0o600);
  }

  private async beginJournal(entry: MutationJournalEntry): Promise<void> {
    await writeFileAtomic(this.journalFile, `${JSON.stringify(entry, null, 2)}\n`, 0o600);
  }

  private async commitJournal(): Promise<void> {
    await rm(this.journalFile, { force: true });
  }

  private defaultLedgerEntry(record: PortableSpaceSourceRecord): CenterSourceLedgerEntry {
    const syncPolicy: PortableSpaceStoredSyncPolicy = record.autoSync === false ? 'manual' : 'auto';
    return {
      enabled: true,
      syncPolicy,
      revision: sha256Hex(JSON.stringify({ id: record.id, updatedAt: record.updatedAt ?? '', etag: record.etag ?? '' })),
      needsReconcile: false,
      bindingChoices: {},
      appliedExpectedHashes: {},
      declaredUnitIds: [...(record.managedIds ?? [])],
      baseGeneration: 1,
      pendingTransfers: [],
      preservedLocalIds: [],
    };
  }

  private computeOrderRevision(items: readonly PortableSpaceSourceRecord[], spaceId: string): string {
    const urlIds = items
      .filter((item) => item.endpoint.kind === 'url' && (item.linkedSpaceId ?? 'main') === spaceId)
      .map((item) => item.id);
    return sha256Hex(JSON.stringify({ spaceId, urlIds }));
  }

  private computeTargetRevision(targetUnits: Units, hashKey: string | undefined): string {
    const sortedIds = [...targetUnits.keys()].sort();
    const parts: string[] = [];
    for (const id of sortedIds) {
      const unit = targetUnits.get(id)!;
      const digest = unit.domain === 'credentials'
        ? hashKey !== undefined
          ? unitHash(unit, hashKey)
          : this.host.previewStore.privateDigest(JSON.stringify(unit.value))
        : unitHash(unit, '');
      parts.push(`${id}=${digest}`);
    }
    return this.host.previewStore.privateDigest(parts.join('\n'));
  }

  private async readOptionalHashKey(readOnly: boolean): Promise<string | undefined> {
    if (readOnly) {
      const existing = await this.host.endpoints.sync.readExistingDeviceKeypair();
      return existing?.identity;
    }
    return this.host.hashKey();
  }

  private projectCenterSource(
    record: PortableSpaceSourceRecord,
    ledger: CenterLedgerDocument,
    priorityByUrlId: ReadonlyMap<string, number>,
  ): PortableSpaceCenterSource {
    const isUrl = record.endpoint.kind === 'url';
    const entry = ledger.sources[record.id] ?? this.defaultLedgerEntry(record);
    const availableNewScopes: PortableSubscriptionScope[] = [];
    if (!isUrl) {
      return {
        ...record,
        enabled: true,
        revision: entry.revision,
        availableNewScopes,
        needsReconcile: false,
      };
    }
    return {
      ...record,
      enabled: entry.enabled,
      priority: priorityByUrlId.get(record.id) ?? 0,
      syncPolicy: entry.syncPolicy,
      ...(entry.selection !== undefined ? { selection: entry.selection } : {}),
      revision: entry.revision,
      availableNewScopes,
      needsReconcile: entry.needsReconcile || entry.pendingTransfers.length > 0,
      ...(entry.bindingChoices.modelBindings !== undefined ? { modelBindings: entry.bindingChoices.modelBindings } : {}),
      ...(entry.bindingChoices.unitModelBindings !== undefined ? { unitModelBindings: entry.bindingChoices.unitModelBindings } : {}),
      ...(entry.bindingChoices.unmappedModelPolicy !== undefined ? { unmappedModelPolicy: entry.bindingChoices.unmappedModelPolicy } : {}),
      ...(entry.bindingChoices.deferredSlotIds !== undefined ? { deferredSlotIds: entry.bindingChoices.deferredSlotIds } : {}),
    };
  }

  private priorityMapForSpace(items: readonly PortableSpaceSourceRecord[], spaceId: string): Map<string, number> {
    const map = new Map<string, number>();
    let rank = 0;
    for (const item of items) {
      if (item.endpoint.kind === 'url' && (item.linkedSpaceId ?? 'main') === spaceId) {
        map.set(item.id, rank++);
      }
    }
    return map;
  }

  /** Lists sources with full Center v1 metadata, contiguous per-space URL priorities, and orderRevision. */
  async listCenterSources(): Promise<PortableSpaceCenterSourcesListResponse> {
    const spaceId = this.host.endpoints.live.bootstrap.spaceId ?? 'main';
    const [key, knownRecipients, rawItems, ledger] = await Promise.all([
      this.host.endpoints.sync.ensureDeviceKeypair(),
      this.host.endpoints.knownRecipients(),
      this.host.sources(),
      this.readLedger(),
    ]);
    const prioritiesBySpace = new Map<string, Map<string, number>>();
    for (const item of rawItems) {
      if (item.endpoint.kind !== 'url') continue;
      const target = item.linkedSpaceId ?? 'main';
      if (!prioritiesBySpace.has(target)) {
        prioritiesBySpace.set(target, this.priorityMapForSpace(rawItems, target));
      }
    }
    const items = rawItems.map((record) => {
      const target = record.linkedSpaceId ?? 'main';
      const pMap = prioritiesBySpace.get(target) ?? new Map<string, number>();
      return this.projectCenterSource(record, ledger, pMap);
    });
    const orderRevision = this.computeOrderRevision(rawItems, spaceId);
    return {
      deviceRecipient: key.recipient,
      knownRecipients,
      items,
      orderRevision,
    };
  }

  private async buildPlanStatesForSpace(
    spaceId: string,
    records: readonly PortableSpaceSourceRecord[],
    ledger: CenterLedgerDocument,
    loadBases: boolean,
  ): Promise<SubscriptionSourcePlanState[]> {
    const priorities = this.priorityMapForSpace(records, spaceId);
    const urlRecords = records.filter((item) => item.endpoint.kind === 'url' && (item.linkedSpaceId ?? 'main') === spaceId);
    const states: SubscriptionSourcePlanState[] = [];
    for (const record of urlRecords) {
      const entry = ledger.sources[record.id] ?? this.defaultLedgerEntry(record);
      const base = loadBases ? await this.host.loadBase(record.id).catch(() => undefined) : undefined;
      states.push({
        id: record.id,
        label: record.label,
        enabled: entry.enabled,
        priority: priorities.get(record.id) ?? 0,
        syncPolicy: entry.syncPolicy,
        selection: entry.selection,
        bindingChoices: entry.bindingChoices,
        managedIds: record.managedIds ?? [],
        appliedExpectedHashes: entry.appliedExpectedHashes,
        declaredUnitIds: entry.declaredUnitIds.length > 0 ? entry.declaredUnitIds : (record.managedIds ?? []),
        base,
        rawBaseUnits: base?.units,
        baseGeneration: entry.baseGeneration,
        pendingTransfers: entry.pendingTransfers,
        preservedLocalIds: entry.preservedLocalIds,
      });
    }
    return states;
  }

  private async loadTargetUnitsReadOnly(spaceId: string): Promise<Units> {
    const liveEndpoint: PortableSpaceEndpoint = { kind: 'live', spaceId };
    await this.host.endpoints.assertWritable(liveEndpoint);
    const liveTree = await this.host.endpoints.load(liveEndpoint, {
      includeMemories: false,
      includeCredentials: true,
      readOnly: true,
    });
    return commonUnits(liveTree.units);
  }

  private buildPreviewManifest(input: {
    readonly token: string;
    readonly expiresAt: number;
    readonly targetSpaceId: string;
    readonly suggestedLabel: string;
    readonly displayOrigin: string;
    readonly tree: LoadedSpaceTree;
    readonly packUnits: Units;
    readonly targetUnits: Units;
    readonly allowedPolicies: readonly PortableSpaceSyncPolicy[];
    readonly defaultSelection: PortableSpaceSubscriptionSelection;
    readonly savedBindingChoices: PortableSpaceBindingChoices;
    readonly existingSourceId?: string;
    readonly seenScopes?: readonly PortableSubscriptionScope[];
    readonly peerStates: readonly SubscriptionSourcePlanState[];
    readonly targetRevision: string;
    readonly orderRevision: string;
    readonly impact?: PortableSpaceImpact;
    readonly impactDigest?: string;
  }): {
    readonly manifest: PortableSpaceSubscribePreviewManifest;
    readonly packDigest: string;
    readonly graph: ReturnType<typeof buildSubscriptionDependencyGraph>;
    readonly presentScopes: PortableSubscriptionScope[];
  } {
    const graph = buildSubscriptionDependencyGraph(input.packUnits, input.targetUnits, input.tree.excluded ?? []);
    const packDigest = computePackDigest(input.packUnits);
    const presentScopes = presentScopesInUnits(input.packUnits);
    const newScopesSet = new Set(computeAvailableNewScopes(presentScopes, input.seenScopes));
    const winnerIndex = computeWinnerIndex(input.peerStates);
    const peerById = new Map(input.peerStates.map((peer) => [peer.id, peer]));

    let diffBytesRemaining = Math.floor(PORTABLE_SPACE_MAX_MANIFEST_BYTES * 0.6);
    let manifestTruncated = false;

    const rawItems: PortableSpaceSubscribePreviewItem[] = graph.entities.map((entity) => {
      const meta = graph.metadataByEntityId.get(entity.id)!;
      const selectable = meta.blockedReason === undefined;
      const currentUnit = input.targetUnits.get(entity.id);
      const ownerId = winnerIndex.currentOwnerByUnitId.get(entity.id);
      const ownedByOther = ownerId !== undefined && ownerId !== input.existingSourceId;
      const ownerPeer = ownedByOther ? peerById.get(ownerId) : undefined;

      let status: PortableSpaceSubscribePreviewItem['status'];
      if (!selectable) status = 'blocked';
      else if (ownedByOther) status = 'owned_by_other';
      else if (newScopesSet.has(entity.scope)) status = 'new_scope';
      else if (currentUnit !== undefined && sameUnit(entity.anchorUnit, currentUnit)) status = 'unchanged';
      else status = 'will_write';

      let safeDiff: string | undefined;
      let safeDiffTruncated: boolean | undefined;
      if (selectable && status !== 'unchanged' && diffBytesRemaining > 0) {
        const diff = buildSafeDiff(entity.anchorUnit, currentUnit);
        if (diff.text !== undefined) {
          const byteLen = Buffer.byteLength(diff.text, 'utf8');
          if (byteLen <= diffBytesRemaining) {
            safeDiff = diff.text;
            safeDiffTruncated = diff.truncated;
            diffBytesRemaining -= byteLen;
          } else {
            manifestTruncated = true;
            safeDiffTruncated = true;
          }
        }
      }

      const selected = selectable
        && !input.defaultSelection.excludedIds.includes(entity.id)
        && (
          input.defaultSelection.includedIds.includes(entity.id)
          || input.defaultSelection.enabledScopes.includes(entity.scope)
        );

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
        status,
        selectable,
        selected,
        ...(meta.blockedReason !== undefined ? { reason: meta.blockedReason.slice(0, 512) } : {}),
        ...(ownedByOther && ownerPeer !== undefined ? { ownerSourceId: ownerPeer.id, ownerLabel: ownerPeer.label } : {}),
        ...(safeDiff !== undefined ? { safeDiff } : {}),
        ...(safeDiffTruncated === true ? { safeDiffTruncated: true } : {}),
        ...(meta.warnings.length > 0 ? { warnings: meta.warnings.map((w) => w.slice(0, 512)) } : {}),
      };
    });

    const manifest: PortableSpaceSubscribePreviewManifest = {
      previewToken: input.token,
      packDigest,
      expiresAt: new Date(input.expiresAt).toISOString(),
      targetSpaceId: input.targetSpaceId,
      suggestedLabel: input.suggestedLabel,
      displayOrigin: input.displayOrigin,
      format: input.tree.format,
      secretMode: input.tree.secretMode,
      encryptionMode: input.tree.encryptionMode,
      allowedPolicies: [...input.allowedPolicies],
      defaultSelection: input.defaultSelection,
      items: rawItems,
      excluded: [...graph.excluded],
      bindingSlots: [...graph.bindingSlots],
      localModelOptions: [...graph.localModelOptions],
      savedBindingChoices: input.savedBindingChoices,
      catalogRevision: graph.catalogRevision,
      targetRevision: input.targetRevision,
      orderRevision: input.orderRevision,
      ...(input.impact !== undefined ? { impact: input.impact } : {}),
      ...(input.impactDigest !== undefined ? { impactDigest: input.impactDigest } : {}),
      ...(manifestTruncated ? { manifestTruncated: true } : {}),
    };

    return { manifest, packDigest, graph, presentScopes };
  }

  /** Performs a read-only, zero-disk-mutation preview of a new URL or local archive source. */
  async previewSubscribe(input: PortableSpaceSubscribePreviewInput): Promise<PortableSpaceSubscribePreviewManifest> {
    const targetSpaceId = input.linkToSpaceId ?? 'main';
    const targetUnits = await this.loadTargetUnitsReadOnly(targetSpaceId);
    const records = await this.host.sources();
    const ledger = await this.readLedger();
    const peerStates = await this.buildPlanStatesForSpace(targetSpaceId, records, ledger, false);

    let tree: LoadedSpaceTree;
    let etag: string | undefined;
    let finalOrigin: string | undefined;
    const endpoint = input.source;

    if (endpoint.kind === 'url') {
      const loaded = await this.host.endpoints.loadUrl(endpoint, {
        unlock: input.unlock,
        readOnly: true,
      });
      if (loaded.status !== 'ok') {
        throw portableValidationError('Unexpected 304 response during subscription preview');
      }
      tree = loaded.tree;
      etag = loaded.etag;
      finalOrigin = loaded.finalOrigin;
    } else {
      tree = await this.host.endpoints.load(endpoint, {
        unlock: input.unlock,
        untrustedArchive: true,
        readOnly: true,
      });
    }

    const packUnits = platformUnits(tree.units, process.platform);
    const existingRecord = endpoint.kind === 'url'
      ? records.find((entry) => endpointKey(entry.endpoint) === endpointKey(endpoint) && (entry.linkedSpaceId ?? 'main') === targetSpaceId)
      : undefined;
    const existingLedger = existingRecord !== undefined ? ledger.sources[existingRecord.id] : undefined;

    const requiresInteractiveUnlock = tree.encryptionMode === 'passphrase' || (input.unlock?.identity !== undefined);
    const allowedPolicies: PortableSpaceSyncPolicy[] = endpoint.kind === 'archive'
      ? ['once']
      : requiresInteractiveUnlock
        ? ['manual', 'once']
        : ['auto', 'manual', 'once'];

    const presentScopes = presentScopesInUnits(packUnits);
    const defaultSelection: PortableSpaceSubscriptionSelection = existingLedger?.selection ?? {
      version: 1,
      enabledScopes: presentScopes,
      excludedIds: [],
      includedIds: [],
      includeCredentials: tree.secretMode !== 'none',
    };

    const existingHashKey = await this.readOptionalHashKey(true);
    const targetRevision = this.computeTargetRevision(targetUnits, existingHashKey);
    const orderRevision = this.computeOrderRevision(records, targetSpaceId);
    const displayOrigin = displayOriginForEndpoint(endpoint);
    const suggestedLabel = normalizeLabel(existingRecord?.label ?? tree.label, displayOrigin);

    const snapshot = this.host.previewStore.put(({ token, createdAt, expiresAt }) => {
      const built = this.buildPreviewManifest({
        token,
        expiresAt,
        targetSpaceId,
        suggestedLabel,
        displayOrigin,
        tree,
        packUnits,
        targetUnits,
        allowedPolicies,
        defaultSelection,
        savedBindingChoices: existingLedger?.bindingChoices ?? {},
        existingSourceId: existingRecord?.id,
        seenScopes: existingLedger?.seenScopes,
        peerStates,
        targetRevision,
        orderRevision,
      });
      return {
        token,
        kind: 'new_subscribe',
        homeKey: this.host.endpoints.home,
        targetSpaceId,
        createdAt,
        expiresAt,
        retainedBytes: estimateSnapshotBytes(packUnits, Buffer.byteLength(JSON.stringify(built.manifest), 'utf8')),
        targetRevision,
        catalogRevision: built.graph.catalogRevision,
        orderRevision,
        sourceId: existingRecord?.id,
        sourceRevision: existingLedger?.revision,
        inFlight: false,
        consumed: false,
        endpoint,
        format: tree.format,
        secretMode: tree.secretMode,
        encryptionMode: tree.encryptionMode,
        overlay: tree.overlay,
        requiresInteractiveUnlock,
        allowedPolicies,
        suggestedLabel,
        displayOrigin,
        etag,
        finalOrigin,
        packDigest: built.packDigest,
        units: packUnits,
        excluded: built.graph.excluded,
        entities: built.graph.entities,
        entityIdByMemberUnitId: built.graph.entityIdByMemberUnitId,
        consumerItemIdsByCredential: built.graph.consumerItemIdsByCredential,
        manifest: built.manifest,
        presentScopes: built.presentScopes,
      } satisfies SubscribePreviewSnapshot;
    });

    return snapshot.manifest;
  }

  /** Previews an existing URL source for update/edit, or computes destructive review impact from a cached snapshot without remote fetch. */
  async previewSource(id: string, input: PortableSpaceSourcePreviewInput = {}): Promise<PortableSpaceSubscribePreviewManifest> {
    const records = await this.host.sources();
    const record = records.find((entry) => entry.id === id);
    if (record === undefined) throw portableNotFound(`Portable Space source "${id}" not found`);
    if (record.endpoint.kind !== 'url') {
      throw portableValidationError('Only URL subscriptions support Subscription Center preview');
    }
    const urlEndpoint = record.endpoint;
    const targetSpaceId = record.linkedSpaceId ?? 'main';
    const ledger = await this.readLedger();
    const entry = ledger.sources[record.id] ?? this.defaultLedgerEntry(record);

    if ('previewToken' in input) {
      const cached = this.host.previewStore.peek(input.previewToken, 'source_update', this.host.endpoints.home);
      if (cached.sourceId !== record.id) {
        throw portablePreviewStale('Preview token does not belong to this source');
      }
      const targetUnits = await this.loadTargetUnitsReadOnly(targetSpaceId);
      const hashKey = (await this.readOptionalHashKey(true)) ?? '';
      const peerStates = await this.buildPlanStatesForSpace(targetSpaceId, records, ledger, true);
      const selfState = peerStates.find((s) => s.id === record.id)!;
      const peers = peerStates.filter((s) => s.id !== record.id);
      const bindings: PortableSpaceBindingChoices = {
        ...(input.modelBindings !== undefined ? { modelBindings: input.modelBindings } : {}),
        ...(input.unitModelBindings !== undefined ? { unitModelBindings: input.unitModelBindings } : {}),
        ...(input.unmappedModelPolicy !== undefined ? { unmappedModelPolicy: input.unmappedModelPolicy } : {}),
        ...(input.deferredSlotIds !== undefined ? { deferredSlotIds: input.deferredSlotIds } : {}),
      };
      const plan = planSubscriptionApply({
        source: selfState,
        upstreamUnits: cached.units,
        targetUnits,
        peers,
        hashKey,
        selection: input.selection,
        bindingChoices: bindings,
        isFirstSubscribe: false,
        cleanupDeselected: true,
        strictBindings: true,
      });
      const impactDigest = computeImpactDigest({
        targetSpaceId,
        sourceId: record.id,
        selection: input.selection,
        bindingChoices: bindings,
        cleanupDeselected: true,
        catalogRevision: cached.catalogRevision,
        targetRevision: cached.targetRevision,
        impact: plan.impact,
      });
      const nextManifest: PortableSpaceSubscribePreviewManifest = {
        ...cached.manifest,
        impact: plan.impact,
        impactDigest,
      };
      this.host.previewStore.replace({
        ...cached,
        manifest: nextManifest,
        reviewedImpact: {
          selection: input.selection,
          cleanupDeselected: true,
          impact: plan.impact,
          impactDigest,
        },
      });
      return nextManifest;
    }

    const targetUnits = await this.loadTargetUnitsReadOnly(targetSpaceId);
    const loaded = await this.host.endpoints.loadUrl(record.endpoint, {
      unlock: input.unlock,
      readOnly: true,
    });
    if (loaded.status !== 'ok') {
      throw portableValidationError('Unexpected 304 response during source preview');
    }
    const packUnits = platformUnits(loaded.tree.units, process.platform);
    const peerStates = await this.buildPlanStatesForSpace(targetSpaceId, records, ledger, false);
    const presentScopes = presentScopesInUnits(packUnits);
    const defaultSelection: PortableSpaceSubscriptionSelection = entry.selection ?? {
      version: 1,
      enabledScopes: presentScopes,
      excludedIds: [],
      includedIds: [],
      includeCredentials: loaded.tree.secretMode !== 'none',
    };
    const requiresInteractiveUnlock = loaded.tree.encryptionMode === 'passphrase' || (input.unlock?.identity !== undefined);
    const allowedPolicies: PortableSpaceSyncPolicy[] = requiresInteractiveUnlock ? ['manual', 'once'] : ['auto', 'manual', 'once'];
    const existingHashKey = await this.readOptionalHashKey(true);
    const targetRevision = this.computeTargetRevision(targetUnits, existingHashKey);
    const orderRevision = this.computeOrderRevision(records, targetSpaceId);
    const displayOrigin = displayOriginForEndpoint(record.endpoint);

    const snapshot = this.host.previewStore.put(({ token, createdAt, expiresAt }) => {
      const built = this.buildPreviewManifest({
        token,
        expiresAt,
        targetSpaceId,
        suggestedLabel: record.label,
        displayOrigin,
        tree: loaded.tree,
        packUnits,
        targetUnits,
        allowedPolicies,
        defaultSelection,
        savedBindingChoices: entry.bindingChoices,
        existingSourceId: record.id,
        seenScopes: entry.seenScopes,
        peerStates,
        targetRevision,
        orderRevision,
      });
      return {
        token,
        kind: 'source_update',
        homeKey: this.host.endpoints.home,
        targetSpaceId,
        createdAt,
        expiresAt,
        retainedBytes: estimateSnapshotBytes(packUnits, Buffer.byteLength(JSON.stringify(built.manifest), 'utf8')),
        targetRevision,
        catalogRevision: built.graph.catalogRevision,
        orderRevision,
        sourceId: record.id,
        sourceRevision: entry.revision,
        inFlight: false,
        consumed: false,
        endpoint: urlEndpoint,
        format: loaded.tree.format,
        secretMode: loaded.tree.secretMode,
        encryptionMode: loaded.tree.encryptionMode,
        overlay: loaded.tree.overlay,
        requiresInteractiveUnlock,
        allowedPolicies,
        suggestedLabel: record.label,
        displayOrigin,
        etag: loaded.etag,
        finalOrigin: loaded.finalOrigin,
        packDigest: built.packDigest,
        units: packUnits,
        excluded: built.graph.excluded,
        entities: built.graph.entities,
        entityIdByMemberUnitId: built.graph.entityIdByMemberUnitId,
        consumerItemIdsByCredential: built.graph.consumerItemIdsByCredential,
        manifest: built.manifest,
        presentScopes: built.presentScopes,
      } satisfies SubscribePreviewSnapshot;
    });

    return snapshot.manifest;
  }

  private extractBindingChoices(input: PortableSpaceBindingChoices): PortableSpaceBindingChoices {
    return {
      ...(input.modelBindings !== undefined ? { modelBindings: input.modelBindings } : {}),
      ...(input.unitModelBindings !== undefined ? { unitModelBindings: input.unitModelBindings } : {}),
      ...(input.unmappedModelPolicy !== undefined ? { unmappedModelPolicy: input.unmappedModelPolicy } : {}),
      ...(input.deferredSlotIds !== undefined ? { deferredSlotIds: input.deferredSlotIds } : {}),
    };
  }

  private assertValidSelectionIds(
    snapshot: SubscribePreviewSnapshot,
    selection: PortableSpaceSubscriptionSelection,
    priorSelection?: PortableSpaceSubscriptionSelection,
  ): void {
    const knownIds = new Set(snapshot.entities.map((entity) => entity.id));
    const priorKnown = new Set([
      ...(priorSelection?.excludedIds ?? []),
      ...(priorSelection?.includedIds ?? []),
    ]);
    for (const id of [...selection.excludedIds, ...selection.includedIds]) {
      if (!knownIds.has(id) && !priorKnown.has(id)) {
        throw portableValidationError(`Unknown item ID in selection: "${id}"`);
      }
    }
  }

  private async persistUnboundHolds(
    holdsToUpsert: readonly import('@kiki/agent-core-v2').UnboundModelHoldEntry[],
    clearedTargets: readonly { readonly targetKind: 'profile' | 'persona' | 'recipe'; readonly targetName: string; readonly sourceModelId: string }[],
  ): Promise<void> {
    if (this.host.documents === undefined) return;
    const bootstrap = this.host.endpoints.live.bootstrap;
    for (const cleared of clearedTargets) {
      await clearUnboundModelHoldsForTarget(
        this.host.documents,
        bootstrap,
        cleared.targetKind,
        cleared.targetName,
        cleared.sourceModelId,
      );
    }
    if (holdsToUpsert.length > 0) {
      await upsertUnboundModelHolds(this.host.documents, bootstrap, holdsToUpsert);
    }
  }

  private async refreshAppliedExpectedHashesAfterWrite(
    targetSpaceId: string,
    appliedIds: readonly string[],
    managedIds: readonly string[],
    currentHashes: Record<string, string>,
    hashKey: string,
  ): Promise<Record<string, string>> {
    if (appliedIds.length === 0) return currentHashes;
    const postWriteUnits = await this.loadTargetUnitsReadOnly(targetSpaceId);
    const managedSet = new Set(managedIds);
    const updated: Record<string, string> = { ...currentHashes };
    for (const id of appliedIds) {
      if (!managedSet.has(id)) continue;
      const liveUnit = postWriteUnits.get(id);
      if (liveUnit !== undefined) {
        updated[id] = unitHash(liveUnit, hashKey);
      }
    }
    return updated;
  }

  private async createSealedBackup(liveTree: LoadedSpaceTree): Promise<string> {
    const backupPath = join(
      this.host.endpoints.home,
      'backups',
      'portable-spaces',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.kiki.tgz`,
    );
    const { recipient } = await this.host.endpoints.sync.ensureDeviceKeypair();
    await this.host.endpoints.write(backupPath, liveTree, {
      format: 'tgz',
      secretMode: 'sealed',
      encryption: { mode: 'x25519', recipients: [recipient] },
    });
    return backupPath;
  }

  /** Commits a previewed Center subscription (`auto | manual`) or one-shot import (`once`) using ONLY cached snapshot bytes. */
  async subscribeCenter(input: PortableSpaceCenterSubscribeInput): Promise<PortableSpaceCenterCommit> {
    return this.host.previewStore.withConsumption(input.previewToken, 'new_subscribe', this.host.endpoints.home, async (snapshot) => {
      if (!snapshot.allowedPolicies.includes(input.syncPolicy)) {
        throw portableValidationError(`Sync policy "${input.syncPolicy}" is not permitted for this source`);
      }
      const targetSpaceId = snapshot.targetSpaceId;
      const liveEndpoint: PortableSpaceEndpoint = { kind: 'live', spaceId: targetSpaceId };
      await this.host.endpoints.assertWritable(liveEndpoint);

      const records = await this.host.sources();
      const ledger = await this.readLedger();
      const liveTree = await this.host.endpoints.load(liveEndpoint, { includeMemories: false, includeCredentials: true });
      const targetUnits = commonUnits(liveTree.units);
      const readHashKey = await this.readOptionalHashKey(true);
      const currentTargetRev = this.computeTargetRevision(targetUnits, readHashKey);
      const currentOrderRev = this.computeOrderRevision(records, targetSpaceId);
      const currentCatalogRev = buildLocalModelCatalog(targetUnits).catalogRevision;

      if (
        currentTargetRev !== snapshot.targetRevision
        || currentOrderRev !== snapshot.orderRevision
        || currentCatalogRev !== snapshot.catalogRevision
      ) {
        throw portablePreviewStale();
      }

      const bindingChoices = this.extractBindingChoices(input);
      this.assertValidSelectionIds(snapshot, input.selection);
      const evalCheck = evaluateSubscriptionSelection(snapshot.manifest, input.selection, bindingChoices);
      if (!evalCheck.canConfirmInitial) {
        if (evalCheck.selectedItemIds.size === 0) {
          throw portableValidationError('Select at least one eligible item before importing');
        }
        if (evalCheck.hasHardBlockers) {
          throw portableValidationError('Resolve blocked hard dependencies before confirming');
        }
        throw portableValidationError('Bind all unresolved required model slots or explicitly choose defer before confirming');
      }

      const peerStates = await this.buildPlanStatesForSpace(targetSpaceId, records, ledger, true);

      if (input.syncPolicy === 'once') {
        const plan = planOnceImport({
          upstreamUnits: snapshot.units,
          targetUnits,
          peers: peerStates,
          selection: input.selection,
          bindingChoices,
        });
        let backupPath: string | undefined;
        const wroteLive = !equalUnitMaps(plan.nextUnits, targetUnits);
        if (wroteLive) {
          if (input.createBackup !== false) backupPath = await this.createSealedBackup(liveTree);
          await this.beginJournal({
            id: randomUUID(),
            startedAt: new Date().toISOString(),
            spaceId: targetSpaceId,
            operation: 'once_import',
            backupPath,
            targetRevision: currentTargetRev,
          });
          await writeLive(this.host.endpoints.live, plan.nextUnits, targetUnits, 'override');
          await this.commitJournal();
        }
        await this.persistUnboundHolds(plan.holdsToUpsert, plan.clearedHoldTargets);
        this.host.notifyChanged(targetSpaceId, 'imported');
        return {
          kind: 'once',
          status: 'imported',
          appliedIds: plan.appliedIds,
          deletedIds: plan.deletedIds,
          skippedIds: plan.skippedIds,
          impact: plan.impact,
          ...(backupPath !== undefined ? { backupPath } : {}),
        };
      }

      if (snapshot.endpoint.kind !== 'url') {
        throw portableValidationError('Local archives support one-time import ("once") only');
      }

      const existing = records.find((item) => endpointKey(item.endpoint) === endpointKey(snapshot.endpoint) && (item.linkedSpaceId ?? 'main') === targetSpaceId);
      const recordId = existing?.id ?? randomUUID();
      const priorEntry = existing !== undefined ? ledger.sources[existing.id] : undefined;
      const hashKey = await this.host.hashKey();
      const existingBase = existing !== undefined ? await this.host.loadBase(existing.id).catch(() => undefined) : undefined;
      const urlCount = records.filter((item) => item.endpoint.kind === 'url' && (item.linkedSpaceId ?? 'main') === targetSpaceId).length;
      const priority = existing !== undefined
        ? (this.priorityMapForSpace(records, targetSpaceId).get(existing.id) ?? urlCount)
        : urlCount;

      const selfState: SubscriptionSourcePlanState = {
        id: recordId,
        label: normalizeLabel(input.label, snapshot.suggestedLabel),
        enabled: priorEntry?.enabled ?? true,
        priority,
        syncPolicy: input.syncPolicy,
        selection: input.selection,
        bindingChoices,
        managedIds: existing?.managedIds ?? [],
        appliedExpectedHashes: priorEntry?.appliedExpectedHashes ?? {},
        declaredUnitIds: priorEntry?.declaredUnitIds ?? existing?.managedIds ?? [],
        base: existingBase,
        rawBaseUnits: existingBase?.units,
        baseGeneration: priorEntry?.baseGeneration ?? 0,
        pendingTransfers: priorEntry?.pendingTransfers ?? [],
        preservedLocalIds: priorEntry?.preservedLocalIds ?? [],
      };
      const peers = peerStates.filter((peer) => peer.id !== recordId);
      const isFirstSubscribe = existing?.lastSyncedAt === undefined && existing?.managedIds === undefined;

      const plan = planSubscriptionApply({
        source: selfState,
        upstreamUnits: snapshot.units,
        targetUnits,
        peers,
        hashKey,
        selection: input.selection,
        bindingChoices,
        isFirstSubscribe,
        cleanupDeselected: false,
        strictBindings: true,
      });

      const pluginErrors: OfficialPluginReconcileError[] = [];
      let backupPath: string | undefined;
      const wroteLive = !equalUnitMaps(plan.nextUnits, targetUnits);
      const nextGeneration = selfState.baseGeneration + 1;

      if (wroteLive) {
        if (input.createBackup !== false) backupPath = await this.createSealedBackup(liveTree);
        await this.beginJournal({
          id: randomUUID(),
          startedAt: new Date().toISOString(),
          spaceId: targetSpaceId,
          operation: 'subscribe_center',
          sourceId: recordId,
          stagedGeneration: nextGeneration,
          backupPath,
          targetRevision: currentTargetRev,
        });
        await writeLive(this.host.endpoints.live, plan.nextUnits, targetUnits, 'override', pluginErrors);
      }

      const winningPlugins = collectWinningOfficialPlugins(plan.nextRawBaseUnits, plan.nextManagedIds, wroteLive ? new Set(plan.appliedIds) : undefined);
      if (winningPlugins.size > 0) {
        const res = await reconcileOfficialPlugins(this.host.endpoints.live, winningPlugins);
        if (res.errors.length > 0) pluginErrors.push(...res.errors);
      }

      await this.host.saveBase(recordId, plan.nextRawBaseUnits, hashKey);
      const now = new Date().toISOString();
      const pendingPlugins = pluginErrors.map((entry) => entry.id);
      const pluginErrorMsg = pluginErrors.length > 0
        ? `Official plugin reconciliation pending (${pluginErrors.map((entry) => `${entry.id}: ${entry.message}`).join('; ')})`.slice(0, 1024)
        : undefined;

      const newRecord: PortableSpaceSourceRecord = {
        id: recordId,
        endpoint: snapshot.endpoint,
        label: selfState.label,
        linkedSpaceId: targetSpaceId,
        format: snapshot.format,
        spaceMode: snapshot.overlay ? 'overlay' : 'full',
        secretMode: snapshot.secretMode,
        encryptionMode: snapshot.encryptionMode,
        updatedAt: now,
        lastSyncedAt: now,
        lastCheckedAt: now,
        autoSync: input.syncPolicy === 'auto',
        etag: sanitizeEtag(snapshot.etag),
        etagOrigin: snapshot.finalOrigin,
        lastSyncError: pluginErrorMsg,
        managedIds: plan.nextManagedIds,
        ...(pendingPlugins.length > 0 ? { pendingOfficialPlugins: pendingPlugins } : {}),
      };

      const nextRecords = existing !== undefined
        ? records.map((item) => item.id === recordId ? newRecord : applyPeerManagedUpdate(item, plan.peerManagedUpdates))
        : [...records.map((item) => applyPeerManagedUpdate(item, plan.peerManagedUpdates)), newRecord];

      const nextAppliedExpectedHashes = wroteLive
        ? await this.refreshAppliedExpectedHashesAfterWrite(
            targetSpaceId,
            plan.appliedIds,
            plan.nextManagedIds,
            plan.nextAppliedExpectedHashes,
            hashKey,
          )
        : plan.nextAppliedExpectedHashes;

      const nextSeenScopes = [...new Set([...(priorEntry?.seenScopes ?? []), ...snapshot.presentScopes])];
      ledger.sources[recordId] = {
        enabled: selfState.enabled,
        syncPolicy: input.syncPolicy,
        selection: input.selection,
        seenScopes: PORTABLE_SUBSCRIPTION_SCOPES.filter((scope) => nextSeenScopes.includes(scope)),
        revision: randomUUID(),
        needsReconcile: false,
        bindingChoices,
        appliedExpectedHashes: nextAppliedExpectedHashes,
        declaredUnitIds: plan.nextDeclaredUnitIds,
        baseGeneration: nextGeneration,
        pendingTransfers: [],
        preservedLocalIds: [...new Set([...selfState.preservedLocalIds, ...plan.newlyPreservedLocalIds])].sort(),
      };
      this.applyPeerLedgerUpdates(ledger, plan.peerExpectedHashUpdates, plan.pendingTransfersToRecord);
      ledger.orderRevisionBySpace[targetSpaceId] = this.computeOrderRevision(nextRecords, targetSpaceId);

      await this.host.saveSources(nextRecords);
      await this.saveLedger(ledger);
      await this.persistUnboundHolds(plan.holdsToUpsert, plan.clearedHoldTargets);
      await this.commitJournal();
      this.host.notifyChanged(targetSpaceId, 'subscribed');

      const priorityMap = this.priorityMapForSpace(nextRecords, targetSpaceId);
      return {
        kind: 'subscription',
        source: this.projectCenterSource(newRecord, ledger, priorityMap),
        status: 'updated',
        appliedIds: plan.appliedIds,
        deletedIds: plan.deletedIds,
        skippedIds: plan.skippedIds,
        impact: plan.impact,
        ...(backupPath !== undefined ? { backupPath } : {}),
      };
    });
  }

  /** Commits a reviewed token sync or explicit Center v1 direct sync for an existing URL subscription. */
  async syncSubscriptionCenter(
    id: string,
    input: PortableSpaceCenterTokenSyncInput | PortableSpaceCenterDirectSyncInput,
    signal?: AbortSignal,
  ): Promise<PortableSpaceCenterCommit> {
    if ('previewToken' in input) {
      return this.host.previewStore.withConsumption(input.previewToken, 'source_update', this.host.endpoints.home, async (snapshot) => {
        if (snapshot.sourceId !== id) {
          throw portablePreviewStale('Preview token does not match this source');
        }
        const records = await this.host.sources();
        const existing = records.find((item) => item.id === id);
        if (existing === undefined) throw portableNotFound(`Portable Space source "${id}" not found`);
        const ledger = await this.readLedger();
        const entry = ledger.sources[id] ?? this.defaultLedgerEntry(existing);
        if (snapshot.sourceRevision !== undefined && snapshot.sourceRevision !== entry.revision) {
          throw portablePreviewStale('Source configuration changed since preview');
        }
        const targetSpaceId = existing.linkedSpaceId ?? 'main';
        const liveEndpoint: PortableSpaceEndpoint = { kind: 'live', spaceId: targetSpaceId };
        await this.host.endpoints.assertWritable(liveEndpoint);
        const liveTree = await this.host.endpoints.load(liveEndpoint, { includeMemories: false, includeCredentials: true });
        const targetUnits = commonUnits(liveTree.units);
        const readHashKey = await this.readOptionalHashKey(true);
        if (
          this.computeTargetRevision(targetUnits, readHashKey) !== snapshot.targetRevision
          || this.computeOrderRevision(records, targetSpaceId) !== snapshot.orderRevision
          || buildLocalModelCatalog(targetUnits).catalogRevision !== snapshot.catalogRevision
        ) {
          throw portablePreviewStale();
        }

        const hasBindingOverride =
          input.modelBindings !== undefined
          || input.unitModelBindings !== undefined
          || input.unmappedModelPolicy !== undefined
          || input.deferredSlotIds !== undefined;
        const bindingChoices = hasBindingOverride ? this.extractBindingChoices(input) : entry.bindingChoices;
        const peerStates = await this.buildPlanStatesForSpace(targetSpaceId, records, ledger, true);
        const selfState = peerStates.find((s) => s.id === id)!;
        const peers = peerStates.filter((s) => s.id !== id);
        const hashKey = await this.host.hashKey();

        const plan = planSubscriptionApply({
          source: selfState,
          upstreamUnits: snapshot.units,
          targetUnits,
          peers,
          hashKey,
          selection: entry.selection,
          bindingChoices,
          isFirstSubscribe: false,
          cleanupDeselected: false,
          strictBindings: true,
        });

        const pluginErrors: OfficialPluginReconcileError[] = [];
        let backupPath: string | undefined;
        const wroteLive = !equalUnitMaps(plan.nextUnits, targetUnits);
        const nextGeneration = entry.baseGeneration + 1;
        if (wroteLive) {
          if (input.createBackup !== false) backupPath = await this.createSealedBackup(liveTree);
          await this.beginJournal({
            id: randomUUID(),
            startedAt: new Date().toISOString(),
            spaceId: targetSpaceId,
            operation: 'sync_token',
            sourceId: id,
            stagedGeneration: nextGeneration,
            backupPath,
            targetRevision: snapshot.targetRevision,
          });
          await writeLive(this.host.endpoints.live, plan.nextUnits, targetUnits, 'override', pluginErrors);
        }

        const winningPlugins = collectWinningOfficialPlugins(plan.nextRawBaseUnits, plan.nextManagedIds, wroteLive ? new Set(plan.appliedIds) : undefined);
        if (winningPlugins.size > 0) {
          const res = await reconcileOfficialPlugins(this.host.endpoints.live, winningPlugins);
          if (res.errors.length > 0) pluginErrors.push(...res.errors);
        }

        await this.host.saveBase(id, plan.nextRawBaseUnits, hashKey);
        const now = new Date().toISOString();
        const pendingPlugins = pluginErrors.map((e) => e.id);
        const pluginErrorMsg = pluginErrors.length > 0
          ? `Official plugin reconciliation pending (${pluginErrors.map((e) => `${e.id}: ${e.message}`).join('; ')})`.slice(0, 1024)
          : undefined;
        const updatedRecord: PortableSpaceSourceRecord = {
          ...existing,
          format: snapshot.format,
          spaceMode: snapshot.overlay ? 'overlay' : 'full',
          secretMode: snapshot.secretMode,
          encryptionMode: snapshot.encryptionMode,
          updatedAt: now,
          lastCheckedAt: now,
          lastSyncedAt: now,
          etag: sanitizeEtag(snapshot.etag),
          etagOrigin: snapshot.finalOrigin,
          lastSyncError: pluginErrorMsg,
          managedIds: plan.nextManagedIds,
          pendingOfficialPlugins: pendingPlugins.length > 0 ? pendingPlugins : undefined,
        };
        const nextRecords = records.map((item) => item.id === id ? updatedRecord : applyPeerManagedUpdate(item, plan.peerManagedUpdates));
        const nextAppliedExpectedHashes = wroteLive
          ? await this.refreshAppliedExpectedHashesAfterWrite(
              targetSpaceId,
              plan.appliedIds,
              plan.nextManagedIds,
              plan.nextAppliedExpectedHashes,
              hashKey,
            )
          : plan.nextAppliedExpectedHashes;
        const nextSeenScopes = [...new Set([...(entry.seenScopes ?? []), ...snapshot.presentScopes])];
        ledger.sources[id] = {
          ...entry,
          seenScopes: PORTABLE_SUBSCRIPTION_SCOPES.filter((scope) => nextSeenScopes.includes(scope)),
          revision: randomUUID(),
          needsReconcile: false,
          bindingChoices,
          appliedExpectedHashes: nextAppliedExpectedHashes,
          declaredUnitIds: plan.nextDeclaredUnitIds,
          baseGeneration: nextGeneration,
          pendingTransfers: [],
          preservedLocalIds: [...new Set([...entry.preservedLocalIds, ...plan.newlyPreservedLocalIds])].sort(),
        };
        this.applyPeerLedgerUpdates(ledger, plan.peerExpectedHashUpdates, plan.pendingTransfersToRecord);
        await this.host.saveSources(nextRecords);
        await this.saveLedger(ledger);
        await this.persistUnboundHolds(plan.holdsToUpsert, plan.clearedHoldTargets);
        await this.commitJournal();
        this.host.notifyChanged(targetSpaceId, 'synced');
        const priorityMap = this.priorityMapForSpace(nextRecords, targetSpaceId);
        return {
          kind: 'subscription',
          source: this.projectCenterSource(updatedRecord, ledger, priorityMap),
          status: 'updated',
          appliedIds: plan.appliedIds,
          deletedIds: plan.deletedIds,
          skippedIds: plan.skippedIds,
          impact: plan.impact,
          ...(backupPath !== undefined ? { backupPath } : {}),
        };
      });
    }

    const records = await this.host.sources();
    const existing = records.find((item) => item.id === id);
    if (existing === undefined) throw portableNotFound(`Portable Space source "${id}" not found`);
    if (existing.endpoint.kind !== 'url') throw portableValidationError('Only URL subscriptions support sync');
    const ledger = await this.readLedger();
    const entry = ledger.sources[id] ?? this.defaultLedgerEntry(existing);
    const targetSpaceId = existing.linkedSpaceId ?? 'main';
    const priorityMap = this.priorityMapForSpace(records, targetSpaceId);
    const now = new Date().toISOString();

    const forceUnconditional = input.force === true || entry.pendingTransfers.length > 0;
    const canRevalidate = !forceUnconditional && existing.lastSyncedAt !== undefined && existing.etag !== undefined;

    try {
      const loaded = await this.host.endpoints.loadUrl(existing.endpoint, {
        ifNoneMatch: canRevalidate ? sanitizeEtag(existing.etag) : undefined,
        ifNoneMatchOrigin: canRevalidate ? existing.etagOrigin : undefined,
        unlock: input.unlock,
        signal,
      });

      if (loaded.status === 'not_modified') {
        const liveEndpoint: PortableSpaceEndpoint = { kind: 'live', spaceId: targetSpaceId };
        const liveTree = await this.host.endpoints.load(liveEndpoint, { includeMemories: false, includeCredentials: true });
        const targetUnits = commonUnits(liveTree.units);
        const catalog = buildLocalModelCatalog(targetUnits);
        let needsReconcile = entry.needsReconcile;
        const allMappedTargets = [
          ...Object.values(entry.bindingChoices.modelBindings ?? {}),
          ...Object.values(entry.bindingChoices.unitModelBindings ?? {}),
        ];
        if (allMappedTargets.some((alias) => !catalog.optionIndexById.has(alias))) {
          needsReconcile = true;
        }
        if (!needsReconcile) {
          for (const slotId of entry.bindingChoices.deferredSlotIds ?? []) {
            const parsed = parseBindingSlotTupleKey(slotId);
            const sourceModelId = parsed?.[1] ?? '';
            if (sourceModelId.length > 0 && catalog.optionIndexById.has(sourceModelId)) {
              needsReconcile = true;
              break;
            }
          }
        }

        let nextPendingPlugins: string[] | undefined;
        let nextPluginError: string | undefined;
        if ((existing.pendingOfficialPlugins?.length ?? 0) > 0 && entry.enabled) {
          const priorBase = await this.host.loadBase(id).catch(() => undefined);
          const managedSet = new Set(existing.managedIds ?? []);
          const desiredRetry = new Map<string, boolean>();
          for (const pluginId of existing.pendingOfficialPlugins ?? []) {
            const unitId = `plugins:plugins.${pluginId.replaceAll('%', '%25').replaceAll('.', '%2E')}`;
            if (!managedSet.has(unitId)) continue;
            const unit = priorBase?.units.get(unitId);
            desiredRetry.set(pluginId, unit === undefined ? true : object(unit.value)['enabled'] !== false);
          }
          if (desiredRetry.size > 0) {
            const retryResult = await reconcileOfficialPlugins(this.host.endpoints.live, desiredRetry);
            if (retryResult.errors.length > 0) {
              nextPendingPlugins = retryResult.errors.map((e) => e.id);
              nextPluginError = `Official plugin reconciliation pending (${retryResult.errors.map((e) => `${e.id}: ${e.message}`).join('; ')})`.slice(0, 1024);
            }
          }
        }

        const updated: PortableSpaceSourceRecord = {
          ...existing,
          etag: sanitizeEtag(loaded.etag) ?? sanitizeEtag(existing.etag),
          etagOrigin: loaded.finalOrigin,
          lastCheckedAt: now,
          lastSyncError: nextPluginError,
          pendingOfficialPlugins: nextPendingPlugins,
        };
        ledger.sources[id] = { ...entry, needsReconcile };
        await this.host.saveSources(records.map((item) => item.id === id ? updated : item));
        await this.saveLedger(ledger);
        return {
          kind: 'subscription',
          source: this.projectCenterSource(updated, ledger, priorityMap),
          status: 'not_modified',
          appliedIds: [],
          deletedIds: [],
          skippedIds: [],
          impact: emptyImpact(existing.managedIds?.length ?? 0),
        };
      }

      if (signal?.aborted) throw new Error('Subscription sync cancelled');
      const liveEndpoint: PortableSpaceEndpoint = { kind: 'live', spaceId: targetSpaceId };
      await this.host.endpoints.assertWritable(liveEndpoint);
      const liveTree = await this.host.endpoints.load(liveEndpoint, { includeMemories: false, includeCredentials: true });
      const targetUnits = commonUnits(liveTree.units);
      const packUnits = platformUnits(loaded.tree.units, process.platform);
      const peerStates = await this.buildPlanStatesForSpace(targetSpaceId, records, ledger, true);
      const selfState = peerStates.find((s) => s.id === id)!;
      const peers = peerStates.filter((s) => s.id !== id);
      const hashKey = await this.host.hashKey();

      const plan = planSubscriptionApply({
        source: selfState,
        upstreamUnits: packUnits,
        targetUnits,
        peers,
        hashKey,
        selection: entry.selection,
        bindingChoices: entry.bindingChoices,
        isFirstSubscribe: existing.lastSyncedAt === undefined && existing.managedIds === undefined,
        cleanupDeselected: false,
        strictBindings: true,
      });

      const pluginErrors: OfficialPluginReconcileError[] = [];
      let backupPath: string | undefined;
      const wroteLive = !equalUnitMaps(plan.nextUnits, targetUnits);
      const nextGeneration = entry.baseGeneration + 1;
      if (wroteLive) {
        if (input.createBackup !== false) backupPath = await this.createSealedBackup(liveTree);
        await this.beginJournal({
          id: randomUUID(),
          startedAt: now,
          spaceId: targetSpaceId,
          operation: 'sync_direct',
          sourceId: id,
          stagedGeneration: nextGeneration,
          backupPath,
          targetRevision: this.computeTargetRevision(targetUnits, hashKey),
        });
        await writeLive(this.host.endpoints.live, plan.nextUnits, targetUnits, 'override', pluginErrors);
      }

      const winningPlugins = collectWinningOfficialPlugins(plan.nextRawBaseUnits, plan.nextManagedIds, wroteLive ? new Set(plan.appliedIds) : undefined);
      if (winningPlugins.size > 0) {
        const res = await reconcileOfficialPlugins(this.host.endpoints.live, winningPlugins);
        if (res.errors.length > 0) pluginErrors.push(...res.errors);
      }

      await this.host.saveBase(id, plan.nextRawBaseUnits, hashKey);
      const pendingPlugins = pluginErrors.map((e) => e.id);
      const pluginErrorMsg = pluginErrors.length > 0
        ? `Official plugin reconciliation pending (${pluginErrors.map((e) => `${e.id}: ${e.message}`).join('; ')})`.slice(0, 1024)
        : undefined;
      const updatedRecord: PortableSpaceSourceRecord = {
        ...existing,
        format: loaded.tree.format,
        spaceMode: loaded.tree.overlay ? 'overlay' : 'full',
        secretMode: loaded.tree.secretMode,
        encryptionMode: loaded.tree.encryptionMode,
        updatedAt: now,
        lastCheckedAt: now,
        lastSyncedAt: now,
        etag: sanitizeEtag(loaded.etag),
        etagOrigin: loaded.finalOrigin,
        lastSyncError: pluginErrorMsg,
        managedIds: plan.nextManagedIds,
        pendingOfficialPlugins: pendingPlugins.length > 0 ? pendingPlugins : undefined,
      };
      const nextRecords = records.map((item) => item.id === id ? updatedRecord : applyPeerManagedUpdate(item, plan.peerManagedUpdates));
      const nextAppliedExpectedHashes = wroteLive
        ? await this.refreshAppliedExpectedHashesAfterWrite(
            targetSpaceId,
            plan.appliedIds,
            plan.nextManagedIds,
            plan.nextAppliedExpectedHashes,
            hashKey,
          )
        : plan.nextAppliedExpectedHashes;
      const presentScopes = presentScopesInUnits(packUnits);
      const nextSeenScopes = [...new Set([...(entry.seenScopes ?? []), ...presentScopes])];
      ledger.sources[id] = {
        ...entry,
        seenScopes: PORTABLE_SUBSCRIPTION_SCOPES.filter((scope) => nextSeenScopes.includes(scope)),
        revision: randomUUID(),
        needsReconcile: false,
        appliedExpectedHashes: nextAppliedExpectedHashes,
        declaredUnitIds: plan.nextDeclaredUnitIds,
        baseGeneration: nextGeneration,
        pendingTransfers: [],
        preservedLocalIds: [...new Set([...entry.preservedLocalIds, ...plan.newlyPreservedLocalIds])].sort(),
      };
      this.applyPeerLedgerUpdates(ledger, plan.peerExpectedHashUpdates, plan.pendingTransfersToRecord);
      await this.host.saveSources(nextRecords);
      await this.saveLedger(ledger);
      await this.persistUnboundHolds(plan.holdsToUpsert, plan.clearedHoldTargets);
      await this.commitJournal();
      this.host.notifyChanged(targetSpaceId, 'synced');

      return {
        kind: 'subscription',
        source: this.projectCenterSource(updatedRecord, ledger, this.priorityMapForSpace(nextRecords, targetSpaceId)),
        status: 'updated',
        appliedIds: plan.appliedIds,
        deletedIds: plan.deletedIds,
        skippedIds: plan.skippedIds,
        impact: plan.impact,
        ...(backupPath !== undefined ? { backupPath } : {}),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]!.slice(0, 1024);
      const failedRecord: PortableSpaceSourceRecord = {
        ...existing,
        lastCheckedAt: now,
        lastSyncError: message,
      };
      ledger.sources[id] = {
        ...entry,
        needsReconcile: entry.needsReconcile || message.includes('Unresolved required model bindings'),
      };
      await this.host.saveSources(records.map((item) => item.id === id ? failedRecord : item));
      await this.saveLedger(ledger);
      return {
        kind: 'subscription',
        source: this.projectCenterSource(failedRecord, ledger, priorityMap),
        status: 'error',
        appliedIds: [],
        deletedIds: [],
        skippedIds: [],
        impact: emptyImpact(existing.managedIds?.length ?? 0),
        error: message,
      };
    }
  }

  /** Patches metadata (`label`, `enabled`, `syncPolicy`) or updates selection range with optional reviewed cleanup. */
  async patchSource(id: string, input: PortableSpacePatchSourceInput): Promise<PortableSpacePatchSourceResult> {
    if ('expectedRevision' in input) {
      const records = await this.host.sources();
      const existing = records.find((item) => item.id === id);
      if (existing === undefined) throw portableNotFound(`Portable Space source "${id}" not found`);
      if (existing.endpoint.kind !== 'url') {
        throw portableValidationError('Only URL subscriptions can be patched via Subscription Center');
      }
      const ledger = await this.readLedger();
      const entry = ledger.sources[id] ?? this.defaultLedgerEntry(existing);
      if (entry.revision !== input.expectedRevision) {
        throw portablePreviewStale('Source revision mismatch; refresh before editing');
      }
      const nextPolicy = input.syncPolicy ?? entry.syncPolicy;
      const nextEnabled = input.enabled ?? entry.enabled;
      const nextLabel = input.label !== undefined ? normalizeLabel(input.label, existing.label) : existing.label;
      const now = new Date().toISOString();
      const updatedRecord: PortableSpaceSourceRecord = {
        ...existing,
        label: nextLabel,
        autoSync: nextPolicy === 'auto',
        updatedAt: now,
      };
      ledger.sources[id] = {
        ...entry,
        enabled: nextEnabled,
        syncPolicy: nextPolicy,
        revision: randomUUID(),
      };
      const nextRecords = records.map((item) => item.id === id ? updatedRecord : item);
      await this.host.saveSources(nextRecords);
      await this.saveLedger(ledger);
      const targetSpaceId = existing.linkedSpaceId ?? 'main';
      this.host.notifyChanged(targetSpaceId, 'updated');
      return {
        source: this.projectCenterSource(updatedRecord, ledger, this.priorityMapForSpace(nextRecords, targetSpaceId)),
        impact: emptyImpact(existing.managedIds?.length ?? 0),
      };
    }

    return this.host.previewStore.withConsumption(input.previewToken, 'source_update', this.host.endpoints.home, async (snapshot) => {
      if (snapshot.sourceId !== id) {
        throw portablePreviewStale('Preview token does not belong to this source');
      }
      const records = await this.host.sources();
      const existing = records.find((item) => item.id === id);
      if (existing === undefined) throw portableNotFound(`Portable Space source "${id}" not found`);
      const ledger = await this.readLedger();
      const entry = ledger.sources[id] ?? this.defaultLedgerEntry(existing);
      if (snapshot.sourceRevision !== undefined && snapshot.sourceRevision !== entry.revision) {
        throw portablePreviewStale('Source configuration changed since preview');
      }
      const targetSpaceId = existing.linkedSpaceId ?? 'main';
      const liveEndpoint: PortableSpaceEndpoint = { kind: 'live', spaceId: targetSpaceId };
      await this.host.endpoints.assertWritable(liveEndpoint);
      const liveTree = await this.host.endpoints.load(liveEndpoint, { includeMemories: false, includeCredentials: true });
      const targetUnits = commonUnits(liveTree.units);
      const readHashKey = await this.readOptionalHashKey(true);
      if (
        this.computeTargetRevision(targetUnits, readHashKey) !== snapshot.targetRevision
        || this.computeOrderRevision(records, targetSpaceId) !== snapshot.orderRevision
        || buildLocalModelCatalog(targetUnits).catalogRevision !== snapshot.catalogRevision
      ) {
        throw portablePreviewStale();
      }

      const bindingChoices = this.extractBindingChoices(input);
      this.assertValidSelectionIds(snapshot, input.selection, entry.selection);
      const evalCheck = evaluateSubscriptionSelection(snapshot.manifest, input.selection, bindingChoices);
      if (!evalCheck.canConfirmEdit) {
        if (evalCheck.hasHardBlockers) {
          throw portableValidationError('Resolve blocked hard dependencies before saving selection');
        }
        throw portableValidationError('Bind all unresolved required model slots or explicitly choose defer before saving');
      }

      const peerStates = await this.buildPlanStatesForSpace(targetSpaceId, records, ledger, true);
      const selfState = peerStates.find((s) => s.id === id)!;
      const peers = peerStates.filter((s) => s.id !== id);
      const hashKey = await this.host.hashKey();

      const plan = planSubscriptionApply({
        source: selfState,
        upstreamUnits: snapshot.units,
        targetUnits,
        peers,
        hashKey,
        selection: input.selection,
        bindingChoices,
        isFirstSubscribe: false,
        cleanupDeselected: input.cleanupDeselected,
        strictBindings: true,
      });

      if (input.cleanupDeselected) {
        const expectedDigest = computeImpactDigest({
          targetSpaceId,
          sourceId: id,
          selection: input.selection,
          bindingChoices,
          cleanupDeselected: true,
          catalogRevision: snapshot.catalogRevision,
          targetRevision: snapshot.targetRevision,
          impact: plan.impact,
        });
        if (input.impactDigest !== expectedDigest) {
          throw portablePreviewStale('Reviewed cleanup impact is stale; review impact again before confirming');
        }
      }

      const pluginErrors: OfficialPluginReconcileError[] = [];
      let backupPath: string | undefined;
      const wroteLive = !equalUnitMaps(plan.nextUnits, targetUnits);
      const nextGeneration = entry.baseGeneration + 1;
      if (wroteLive) {
        if (input.createBackup !== false) backupPath = await this.createSealedBackup(liveTree);
        await this.beginJournal({
          id: randomUUID(),
          startedAt: new Date().toISOString(),
          spaceId: targetSpaceId,
          operation: 'patch_range',
          sourceId: id,
          stagedGeneration: nextGeneration,
          backupPath,
          targetRevision: snapshot.targetRevision,
        });
        await writeLive(this.host.endpoints.live, plan.nextUnits, targetUnits, 'override', pluginErrors);
      }

      const winningPlugins = collectWinningOfficialPlugins(plan.nextRawBaseUnits, plan.nextManagedIds, wroteLive ? new Set(plan.appliedIds) : undefined);
      if (winningPlugins.size > 0) {
        const res = await reconcileOfficialPlugins(this.host.endpoints.live, winningPlugins);
        if (res.errors.length > 0) pluginErrors.push(...res.errors);
      }

      await this.host.saveBase(id, plan.nextRawBaseUnits, hashKey);
      const now = new Date().toISOString();
      const updatedRecord: PortableSpaceSourceRecord = {
        ...existing,
        updatedAt: now,
        lastSyncedAt: now,
        lastCheckedAt: now,
        etag: sanitizeEtag(snapshot.etag) ?? existing.etag,
        etagOrigin: snapshot.finalOrigin ?? existing.etagOrigin,
        managedIds: plan.nextManagedIds,
      };
      const nextRecords = records.map((item) => item.id === id ? updatedRecord : applyPeerManagedUpdate(item, plan.peerManagedUpdates));
      const nextAppliedExpectedHashes = wroteLive
        ? await this.refreshAppliedExpectedHashesAfterWrite(
            targetSpaceId,
            plan.appliedIds,
            plan.nextManagedIds,
            plan.nextAppliedExpectedHashes,
            hashKey,
          )
        : plan.nextAppliedExpectedHashes;
      const nextSeenScopes = [...new Set([...(entry.seenScopes ?? []), ...snapshot.presentScopes])];
      ledger.sources[id] = {
        ...entry,
        selection: input.selection,
        seenScopes: PORTABLE_SUBSCRIPTION_SCOPES.filter((scope) => nextSeenScopes.includes(scope)),
        revision: randomUUID(),
        needsReconcile: false,
        bindingChoices,
        appliedExpectedHashes: nextAppliedExpectedHashes,
        declaredUnitIds: plan.nextDeclaredUnitIds,
        baseGeneration: nextGeneration,
        pendingTransfers: [],
        preservedLocalIds: [...new Set([...entry.preservedLocalIds, ...plan.newlyPreservedLocalIds])].sort(),
      };
      this.applyPeerLedgerUpdates(ledger, plan.peerExpectedHashUpdates, plan.pendingTransfersToRecord);
      await this.host.saveSources(nextRecords);
      await this.saveLedger(ledger);
      await this.persistUnboundHolds(plan.holdsToUpsert, plan.clearedHoldTargets);
      await this.commitJournal();
      this.host.notifyChanged(targetSpaceId, 'updated');

      this.scheduleAutoPendingTransfers(nextRecords, ledger, plan.pendingTransfersToRecord);

      return {
        source: this.projectCenterSource(updatedRecord, ledger, this.priorityMapForSpace(nextRecords, targetSpaceId)),
        impact: plan.impact,
        ...(backupPath !== undefined ? { backupPath } : {}),
      };
    });
  }

  /** Atomically reorders all URL subscriptions for one space after checking expectedOrderRevision and exact permutation. */
  async reorderSources(input: PortableSpaceReorderSourcesInput): Promise<PortableSpaceReorderSourcesResult> {
    const records = await this.host.sources();
    const ledger = await this.readLedger();
    const currentOrderRevision = this.computeOrderRevision(records, input.spaceId);
    if (currentOrderRevision !== input.expectedOrderRevision) {
      throw portablePreviewStale('Subscription order changed; refresh before reordering');
    }

    const spaceUrlRecords = records.filter(
      (item) => item.endpoint.kind === 'url' && (item.linkedSpaceId ?? 'main') === input.spaceId,
    );
    const spaceUrlById = new Map(spaceUrlRecords.map((item) => [item.id, item]));
    if (input.orderedIds.length !== spaceUrlRecords.length) {
      throw portableValidationError('orderedIds must include every URL subscription for this space');
    }
    const reorderedUrls: PortableSpaceSourceRecord[] = [];
    for (const id of input.orderedIds) {
      const match = spaceUrlById.get(id);
      if (match === undefined) {
        throw portableValidationError(`Source "${id}" is not a URL subscription belonging to space "${input.spaceId}"`);
      }
      reorderedUrls.push(match);
    }

    let urlCursor = 0;
    const nextRecords = records.map((item) => {
      if (item.endpoint.kind === 'url' && (item.linkedSpaceId ?? 'main') === input.spaceId) {
        return reorderedUrls[urlCursor++]!;
      }
      return item;
    });
    const nextOrderRevision = this.computeOrderRevision(nextRecords, input.spaceId);
    ledger.orderRevisionBySpace[input.spaceId] = nextOrderRevision;
    await this.host.saveSources(nextRecords);
    await this.saveLedger(ledger);
    this.host.notifyChanged(input.spaceId, 'reordered');

    return {
      orderedIds: reorderedUrls.map((item) => item.id),
      orderRevision: nextOrderRevision,
    };
  }

  /** Computes a local, zero-network removal impact preview for a registered source. */
  async previewRemoveSource(id: string): Promise<PortableSpaceRemovePreviewResult> {
    const records = await this.host.sources();
    const record = records.find((item) => item.id === id);
    if (record === undefined) throw portableNotFound(`Portable Space source "${id}" not found`);
    const targetSpaceId = record.linkedSpaceId ?? 'main';
    const ledger = await this.readLedger();
    const entry = ledger.sources[id] ?? this.defaultLedgerEntry(record);

    const targetUnits = await this.loadTargetUnitsReadOnly(targetSpaceId);
    const hashKey = (await this.readOptionalHashKey(true)) ?? '';
    const catalog = buildLocalModelCatalog(targetUnits);
    const targetRevision = this.computeTargetRevision(targetUnits, hashKey || undefined);
    const orderRevision = this.computeOrderRevision(records, targetSpaceId);

    let impact: PortableSpaceImpact;
    if (record.endpoint.kind === 'url') {
      const peerStates = await this.buildPlanStatesForSpace(targetSpaceId, records, ledger, true);
      const selfState = peerStates.find((s) => s.id === id)!;
      const peers = peerStates.filter((s) => s.id !== id);
      const relinq = planRelinquishment({
        source: selfState,
        relinquishUnitIds: selfState.managedIds,
        targetUnits,
        peers,
        hashKey,
        deleteUnmodified: true,
      });
      impact = relinq.impact;
    } else {
      impact = emptyImpact(0);
    }

    const impactDigest = computeImpactDigest({
      targetSpaceId,
      sourceId: id,
      purgeManaged: true,
      catalogRevision: catalog.catalogRevision,
      targetRevision,
      impact,
    });

    const snapshot = this.host.previewStore.put(({ token, createdAt, expiresAt }) => ({
      token,
      kind: 'remove_source',
      homeKey: this.host.endpoints.home,
      targetSpaceId,
      createdAt,
      expiresAt,
      retainedBytes: 4096,
      targetRevision,
      catalogRevision: catalog.catalogRevision,
      orderRevision,
      sourceId: id,
      sourceRevision: entry.revision,
      inFlight: false,
      consumed: false,
      managedCount: record.managedIds?.length ?? 0,
      impact,
      impactDigest,
    }));

    return {
      previewToken: snapshot.token,
      expiresAt: new Date(snapshot.expiresAt).toISOString(),
      managedCount: snapshot.managedCount,
      impact,
      impactDigest,
    };
  }

  /** Executes a reviewed source detach (`purgeManaged: false`) or guarded purge (`purgeManaged: true`) with backup and peer handoff. */
  async removeReviewedSource(id: string, input: PortableSpaceRemoveReviewedInput): Promise<PortableSpaceRemoveReviewedResponse> {
    return this.host.previewStore.withConsumption(input.previewToken, 'remove_source', this.host.endpoints.home, async (snapshot) => {
      if (snapshot.sourceId !== id) {
        throw portablePreviewStale('Remove preview token does not belong to this source');
      }
      const records = await this.host.sources();
      const record = records.find((item) => item.id === id);
      if (record === undefined) throw portableNotFound(`Portable Space source "${id}" not found`);
      const ledger = await this.readLedger();
      const entry = ledger.sources[id] ?? this.defaultLedgerEntry(record);
      if (entry.revision !== snapshot.sourceRevision) {
        throw portablePreviewStale('Source changed after remove preview; preview again');
      }
      const targetSpaceId = record.linkedSpaceId ?? 'main';
      if (record.endpoint.kind !== 'url' && input.purgeManaged) {
        throw portableValidationError('Non-URL portable links can only be detached, not purged');
      }

      const liveEndpoint: PortableSpaceEndpoint = { kind: 'live', spaceId: targetSpaceId };
      await this.host.endpoints.assertWritable(liveEndpoint);
      const liveTree = await this.host.endpoints.load(liveEndpoint, { includeMemories: false, includeCredentials: true });
      const targetUnits = commonUnits(liveTree.units);
      const readHashKey = await this.readOptionalHashKey(true);
      const currentTargetRev = this.computeTargetRevision(targetUnits, readHashKey);
      const currentOrderRev = this.computeOrderRevision(records, targetSpaceId);
      const currentCatalogRev = buildLocalModelCatalog(targetUnits).catalogRevision;

      if (
        currentTargetRev !== snapshot.targetRevision
        || currentOrderRev !== snapshot.orderRevision
        || currentCatalogRev !== snapshot.catalogRevision
      ) {
        throw portablePreviewStale('Target space changed after remove preview; preview again');
      }

      if (input.impactDigest !== snapshot.impactDigest) {
        throw portablePreviewStale('Reviewed removal impact digest mismatch; preview again');
      }

      let impact = emptyImpact(record.managedIds?.length ?? 0);
      let backupPath: string | undefined;
      let peerManagedUpdates = new Map<string, Set<string>>();
      let peerExpectedHashUpdates = new Map<string, Record<string, string>>();
      let pendingTransfersToRecord = new Map<string, PendingTransferRecord[]>();

      if (record.endpoint.kind === 'url') {
        const hashKey = await this.host.hashKey();
        const peerStates = await this.buildPlanStatesForSpace(targetSpaceId, records, ledger, true);
        const selfState = peerStates.find((s) => s.id === id)!;
        const peers = peerStates.filter((s) => s.id !== id);
        const relinq = planRelinquishment({
          source: selfState,
          relinquishUnitIds: selfState.managedIds,
          targetUnits,
          peers,
          hashKey,
          deleteUnmodified: input.purgeManaged,
        });
        impact = relinq.impact;
        peerManagedUpdates = relinq.remainingManagedBySource;
        peerExpectedHashUpdates = relinq.updatedExpectedHashesBySource;
        pendingTransfersToRecord = relinq.pendingTransfersToRecord;

        const wroteLive = !equalUnitMaps(relinq.nextUnits, targetUnits);
        if (wroteLive) {
          if (input.createBackup !== false) backupPath = await this.createSealedBackup(liveTree);
          await this.beginJournal({
            id: randomUUID(),
            startedAt: new Date().toISOString(),
            spaceId: targetSpaceId,
            operation: 'remove_purge',
            sourceId: id,
            backupPath,
            targetRevision: currentTargetRev,
          });
          await writeLive(this.host.endpoints.live, relinq.nextUnits, targetUnits, 'override');
        }
      }

      const nextRecords = records
        .filter((item) => item.id !== id)
        .map((item) => applyPeerManagedUpdate(item, peerManagedUpdates));
      delete ledger.sources[id];
      this.applyPeerLedgerUpdates(ledger, peerExpectedHashUpdates, pendingTransfersToRecord);
      ledger.orderRevisionBySpace[targetSpaceId] = this.computeOrderRevision(nextRecords, targetSpaceId);

      await this.host.saveSources(nextRecords);
      await this.saveLedger(ledger);
      await rm(join(this.baseRoot, safePortablePath(id)), { recursive: true, force: true });
      await this.commitJournal();
      this.host.notifyChanged(targetSpaceId, 'removed');

      this.scheduleAutoPendingTransfers(nextRecords, ledger, pendingTransfersToRecord);

      return {
        removed: true,
        impact,
        ...(backupPath !== undefined ? { backupPath } : {}),
      };
    });
  }

  /** Returns the current persisted Center metadata entry for a source (read-only helper for legacy compatibility and scheduler). */
  async readSourceLedgerEntry(id: string, record: PortableSpaceSourceRecord): Promise<CenterSourceLedgerEntry> {
    const ledger = await this.readLedger();
    return ledger.sources[id] ?? this.defaultLedgerEntry(record);
  }

  /** Checks whether a URL source should run during automatic background polling. */
  async isSourceAutoPollEligible(record: PortableSpaceSourceRecord): Promise<boolean> {
    if (record.endpoint.kind !== 'url') return false;
    const entry = await this.readSourceLedgerEntry(record.id, record);
    return entry.enabled && entry.syncPolicy === 'auto';
  }

  /** Syncs Center ledger entry after a legacy subscribe/sync mutation without losing existing selective config. */
  async syncLedgerAfterLegacyApply(input: {
    readonly record: PortableSpaceSourceRecord;
    readonly spaceId: string;
    readonly rawBaseUnits: Units;
    readonly nextUnits: Units;
    readonly nextManagedIds: readonly string[];
    readonly hashKey: string;
    readonly records: readonly PortableSpaceSourceRecord[];
  }): Promise<void> {
    const ledger = await this.readLedger();
    const existing = ledger.sources[input.record.id] ?? this.defaultLedgerEntry(input.record);
    const appliedExpectedHashes: Record<string, string> = {};
    for (const unitId of input.nextManagedIds) {
      const unit = input.nextUnits.get(unitId);
      if (unit !== undefined) appliedExpectedHashes[unitId] = unitHash(unit, input.hashKey);
    }
    const presentScopes = presentScopesInUnits(input.rawBaseUnits);
    const seenScopes = [...new Set([...(existing.seenScopes ?? []), ...presentScopes])];
    ledger.sources[input.record.id] = {
      ...existing,
      syncPolicy: input.record.autoSync === false ? 'manual' : 'auto',
      seenScopes: PORTABLE_SUBSCRIPTION_SCOPES.filter((scope) => seenScopes.includes(scope)),
      revision: randomUUID(),
      appliedExpectedHashes,
      declaredUnitIds: [...input.rawBaseUnits.keys()].sort(),
      baseGeneration: existing.baseGeneration + 1,
    };
    ledger.orderRevisionBySpace[input.spaceId] = this.computeOrderRevision(input.records, input.spaceId);
    await this.saveLedger(ledger);
    this.host.notifyChanged(input.spaceId, 'synced');
  }

  /** Removes a deleted source's Center ledger entry when deleted through the legacy bare DELETE route. */
  async removeLedgerEntry(id: string, remainingRecords: readonly PortableSpaceSourceRecord[], spaceId: string): Promise<void> {
    const ledger = await this.readLedger();
    delete ledger.sources[id];
    ledger.orderRevisionBySpace[spaceId] = this.computeOrderRevision(remainingRecords, spaceId);
    await this.saveLedger(ledger);
    this.host.notifyChanged(spaceId, 'removed');
  }

  /** Returns the current unbound model hold document for tests or diagnostics. */
  async readHolds(): Promise<import('@kiki/agent-core-v2').UnboundModelHoldDocument | undefined> {
    if (this.host.documents === undefined) return undefined;
    return readUnboundModelHolds(this.host.documents, this.host.endpoints.live.bootstrap);
  }

  private applyPeerLedgerUpdates(
    ledger: CenterLedgerDocument,
    peerExpectedHashUpdates: ReadonlyMap<string, Record<string, string>>,
    pendingTransfersToRecord: ReadonlyMap<string, PendingTransferRecord[]>,
  ): void {
    for (const [peerId, hashes] of peerExpectedHashUpdates) {
      const existing = ledger.sources[peerId];
      if (existing === undefined) continue;
      existing.appliedExpectedHashes = hashes;
    }
    for (const [peerId, pending] of pendingTransfersToRecord) {
      const existing = ledger.sources[peerId];
      if (existing === undefined) continue;
      existing.pendingTransfers = [...existing.pendingTransfers, ...pending];
      existing.needsReconcile = true;
      existing.revision = randomUUID();
    }
  }

  private scheduleAutoPendingTransfers(
    records: readonly PortableSpaceSourceRecord[],
    ledger: CenterLedgerDocument,
    pendingTransfersToRecord: ReadonlyMap<string, PendingTransferRecord[]>,
  ): void {
    for (const [peerId, pending] of pendingTransfersToRecord) {
      if (pending.length === 0) continue;
      const peerRecord = records.find((item) => item.id === peerId);
      const peerLedger = ledger.sources[peerId];
      if (peerRecord?.endpoint.kind === 'url' && peerLedger?.enabled && peerLedger.syncPolicy === 'auto') {
        this.host.scheduleAutoReconcile(peerId);
      }
    }
  }
}

function equalUnitMaps(a: Units, b: Units): boolean {
  return a.size === b.size && [...a].every(([id, unit]) => sameUnit(unit, b.get(id)));
}

function applyPeerManagedUpdate(
  record: PortableSpaceSourceRecord,
  peerManagedUpdates: ReadonlyMap<string, Set<string>>,
): PortableSpaceSourceRecord {
  const nextManaged = peerManagedUpdates.get(record.id);
  if (nextManaged === undefined) return record;
  return { ...record, managedIds: [...nextManaged].sort() };
}

function collectWinningOfficialPlugins(
  rawBaseUnits: Units,
  winningManagedIds: readonly string[],
  alreadyAppliedSet?: ReadonlySet<string>,
): Map<string, boolean> {
  const winningSet = new Set(winningManagedIds);
  const result = new Map<string, boolean>();
  for (const [unitId, unit] of rawBaseUnits) {
    if (!winningSet.has(unitId)) continue;
    if (unit.domain !== 'plugins' || unit.key[0] !== 'plugins' || unit.key[1] === undefined) continue;
    if (alreadyAppliedSet?.has(unitId)) continue;
    result.set(unit.key[1], object(unit.value)['enabled'] !== false);
  }
  return result;
}
