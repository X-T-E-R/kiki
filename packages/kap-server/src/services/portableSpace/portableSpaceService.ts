import { randomInt, randomUUID } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import type { IAtomicDocumentStore } from '@kiki/agent-core-v2';
import {
  portableSpaceSourceRecordSchema,
  type PortableSpaceApplyInput,
  type PortableSpaceApplyReceipt,
  type PortableSpaceCenterCommit,
  type PortableSpaceCenterDirectSyncInput,
  type PortableSpaceCenterSourcesListResponse,
  type PortableSpaceCenterSubscribeInput,
  type PortableSpaceCenterTokenSyncInput,
  type PortableSpaceDeltaInput,
  type PortableSpaceEndpoint,
  type PortableSpaceExportInput,
  type PortableSpaceExportReceipt,
  type PortableSpaceForkInput,
  type PortableSpaceInspectInput,
  type PortableSpaceMutateInput,
  type PortableSpacePackUnpackInput,
  type PortableSpacePatchSourceInput,
  type PortableSpacePatchSourceResult,
  type PortableSpacePreviewInput,
  type PortableSpacePreviewResult,
  type PortableSpaceRegisterSourceInput,
  type PortableSpaceRekeyInput,
  type PortableSpaceRemovePreviewResult,
  type PortableSpaceRemoveReviewedInput,
  type PortableSpaceRemoveReviewedResponse,
  type PortableSpaceReorderSourcesInput,
  type PortableSpaceReorderSourcesResult,
  type PortableSpaceSourcePreviewInput,
  type PortableSpaceSourceRecord,
  type PortableSpaceSourcesListResponse,
  type PortableSpaceSubscribeInput,
  type PortableSpaceSubscribePreviewInput,
  type PortableSpaceSubscribePreviewManifest,
  type PortableSpaceSubscriptionSyncInput,
  type PortableSpaceSubscriptionSyncResult,
} from '@kiki/protocol';
import { z } from 'zod';
import { formatRecipients, parseRecipients } from './ageCodec';
import { endpointForPath, endpointKey, inspectTree, resealOptions, SpaceEndpoints, type LoadedSpaceTree } from './endpoints';
import { holdBackgroundPluginChanges, reconcileOfficialPlugins, writeLive, type OfficialPluginReconcileError } from './liveSpace';
import { applyUnset, assignPath, isUnitId, modelDependencies, planChanges, reconcile, sameUnit, unitHashes, type Change, type VerifiedBase } from './mergeEngine';
import { missing, pathFormat, readBounded, writeFileAtomic } from './spaceFiles';
import { SubscriptionCenterCoordinator } from './subscriptionCenter';
import { portableNotFound, portableValidationError } from './subscriptionErrors';
import { SubscriptionPreviewStore } from './subscriptionPreviewStore';
import { packTarGz, safePortablePath, unpackTarGz } from './tarArchive';
import { commonUnits, domainForFile, encodeToml, filesFromUnits, object, parseToml, platformUnits, PLAIN, putUnit, RECIPIENTS, SEALED, selectedUnits, toUnits, type ForkBase, type PortableSpaceTree, type Units } from './treeProjection';
import { assertNoRemoteExecutableMcp, assertSafeRemoteCredentialBindings, reconcileSubscriptionUnits, sanitizeEtag } from './urlSubscription';

/** Optional runtime collaborators for Subscription Center persistence and change notifications. */
export interface PortableSpaceServiceOptions {
  readonly documents?: IAtomicDocumentStore;
  readonly onChanged?: (event: {
    readonly spaceId: string;
    readonly reason: 'subscribed' | 'synced' | 'updated' | 'reordered' | 'removed' | 'imported';
  }) => void;
}

interface Plan {
  input: PortableSpacePreviewInput;
  tree: LoadedSpaceTree;
  sourceTrees: LoadedSpaceTree[];
  left: Units;
  right: Units;
  changes: Change[];
  base?: VerifiedBase;
  unchangedCount: number;
  key: string;
}
interface StoredFork extends ForkBase { source: string; destination: string; shared?: boolean }
interface Preview { at: number; plan: Plan }
const TTL = 5 * 60_000;
const DEFAULT_AUTO_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AUTO_SYNC_JITTER_MS = 30 * 60 * 1000;
const DEFAULT_STARTUP_SYNC_MIN_DELAY_MS = 60_000;
const DEFAULT_STARTUP_SYNC_MAX_DELAY_MS = 180_000;
const DEFAULT_STARTUP_FRESHNESS_WINDOW_MS = 12 * 60 * 60 * 1000;
const sourceListSchema = z.array(portableSpaceSourceRecordSchema);

function agreedBase(left: Units, right: Units, key: string, prior: VerifiedBase | undefined): VerifiedBase {
  const units = new Map([...left].filter(([id, unit]) => sameUnit(unit, right.get(id))));
  const hashes = unitHashes(units, key);
  for (const [id, hash] of Object.entries(prior?.hashes ?? {})) {
    if (Object.hasOwn(hashes, id) || !left.has(id) && !right.has(id)) continue;
    hashes[id] = hash;
    const old = prior?.units.get(id);
    if (old) units.set(id, old);
  }
  return { units, hashes };
}

function hasEmbeddedBase(endpoint: PortableSpaceEndpoint): boolean {
  return endpoint.kind === 'archive' || endpoint.kind === 'dir';
}

function equalUnits(a: Units, b: Units) {
  return a.size === b.size && [...a].every(([id, unit]) => sameUnit(unit, b.get(id)));
}
function preservePlatformLayers(original: Units, before: Units, next: Units, platform: string): Units {
  const platformName = `config.${platform}.toml`;
  const result = new Map(original);
  for (const id of new Set([...before.keys(), ...next.keys()])) {
    const old = before.get(id);
    const unit = next.get(id);
    if (sameUnit(old, unit)) continue;
    const layerUnit = (old ?? unit)?.domain === 'config' ? [...result.entries()].find(([, layer]) => layer.domain === 'config' && layer.key[0] === platformName && isDeepStrictEqual(layer.key.slice(1), (old ?? unit)?.key)) : undefined;
    if (!unit) {
      result.delete(id);
      if (layerUnit) result.delete(layerUnit[0]);
    } else if (layerUnit) putUnit(result, 'config', layerUnit[1].key, unit.value);
    else result.set(id, unit);
  }
  return result;
}

function sameTree(a: PortableSpaceTree, b: PortableSpaceTree) {
  return equalUnits(a.units, b.units) && isDeepStrictEqual(a.unset, b.unset) && a.overlay === b.overlay
    && isDeepStrictEqual(a.recipients, b.recipients) && isDeepStrictEqual(a.fork, b.fork) && a.encryptionMode === b.encryptionMode;
}

export class PortableSpaceService {
  private tail: Promise<unknown> = Promise.resolve();
  private previews = new Map<string, Preview>();
  private readonly previewStore = new SubscriptionPreviewStore();
  private readonly center: SubscriptionCenterCoordinator;
  private readonly pendingAutoReconcileTimers = new Set<ReturnType<typeof setTimeout>>();
  private startupSyncTimer: ReturnType<typeof setTimeout> | undefined;
  private periodicSyncTimer: ReturnType<typeof setInterval> | undefined;
  private autoSyncAbort: AbortController | undefined;
  private activeAutoSync: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly endpoints: SpaceEndpoints, options: PortableSpaceServiceOptions = {}) {
    this.center = new SubscriptionCenterCoordinator({
      endpoints: this.endpoints,
      previewStore: this.previewStore,
      documents: options.documents,
      sources: () => this.sources(),
      saveSources: (items) => this.saveSources(items),
      loadBase: (id) => this.loadBase(id),
      saveBase: (id, units, key, hashes) => this.saveBase(id, units, key, hashes),
      hashKey: () => this.hashKey(),
      notifyChanged: (spaceId, reason) => options.onChanged?.({ spaceId, reason }),
      scheduleAutoReconcile: (sourceId) => {
        if (this.stopped) return;
        const timer = setTimeout(() => {
          this.pendingAutoReconcileTimers.delete(timer);
          if (this.stopped) return;
          void this.syncSubscriptionCenter(sourceId, { force: true, createBackup: true }, undefined, { backgroundAutoSync: true }).catch(() => undefined);
        }, 0);
        timer.unref?.();
        this.pendingAutoReconcileTimers.add(timer);
      },
    });
  }

  startAutoSync(options: {
    readonly intervalMs?: number;
    readonly startupDelayMs?: number;
    readonly startupFreshnessMs?: number;
  } = {}): void {
    void this.stopAutoSync();
    this.stopped = false;
    const controller = new AbortController();
    this.autoSyncAbort = controller;
    const startupDelayMs = options.startupDelayMs ?? randomInt(DEFAULT_STARTUP_SYNC_MIN_DELAY_MS, DEFAULT_STARTUP_SYNC_MAX_DELAY_MS + 1);
    const intervalMs = options.intervalMs ?? (DEFAULT_AUTO_SYNC_INTERVAL_MS + randomInt(0, DEFAULT_AUTO_SYNC_JITTER_MS + 1));
    const startupFreshnessMs = options.startupFreshnessMs ?? DEFAULT_STARTUP_FRESHNESS_WINDOW_MS;
    const run = (skipIfFreshMs?: number) => {
      if (this.stopped || controller.signal.aborted || this.activeAutoSync !== undefined) return;
      const pass = this.syncAllAutoSubscriptions(controller.signal, skipIfFreshMs).then(() => undefined, () => undefined).finally(() => {
        if (this.activeAutoSync === pass) this.activeAutoSync = undefined;
      });
      this.activeAutoSync = pass;
    };
    this.startupSyncTimer = setTimeout(() => {
      this.startupSyncTimer = undefined;
      run(startupFreshnessMs);
    }, startupDelayMs);
    this.startupSyncTimer.unref?.();
    this.periodicSyncTimer = setInterval(() => run(undefined), intervalMs);
    this.periodicSyncTimer.unref?.();
  }

  async stopAutoSync(timeoutMs = 5000): Promise<void> {
    this.stopped = true;
    this.previewStore.dispose();
    for (const timer of this.pendingAutoReconcileTimers) {
      clearTimeout(timer);
    }
    this.pendingAutoReconcileTimers.clear();
    if (this.startupSyncTimer !== undefined) {
      clearTimeout(this.startupSyncTimer);
      this.startupSyncTimer = undefined;
    }
    if (this.periodicSyncTimer !== undefined) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = undefined;
    }
    if (this.autoSyncAbort !== undefined) {
      this.autoSyncAbort.abort(new Error('Auto-sync stopped'));
      this.autoSyncAbort = undefined;
    }
    const inflight = this.activeAutoSync;
    if (inflight !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          inflight,
          new Promise<void>((resolveWait) => {
            timer = setTimeout(resolveWait, timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }

  async syncAllAutoSubscriptions(
    signal?: AbortSignal,
    skipIfFreshMs?: number,
  ): Promise<PortableSpaceSubscriptionSyncResult[]> {
    const items = await this.sources();
    const results: PortableSpaceSubscriptionSyncResult[] = [];
    const now = Date.now();
    for (const item of items) {
      if (this.stopped || signal?.aborted) break;
      if (item.endpoint.kind !== 'url' || item.autoSync === false) continue;
      if (!(await this.center.isSourceAutoPollEligible(item))) continue;
      if (skipIfFreshMs !== undefined && skipIfFreshMs > 0 && !item.lastSyncError && item.lastCheckedAt !== undefined) {
        const checkedMs = Date.parse(item.lastCheckedAt);
        if (Number.isFinite(checkedMs) && now - checkedMs >= 0 && now - checkedMs < skipIfFreshMs) {
          continue;
        }
      }
      try {
        results.push(await this.syncSubscription(item.id, { force: false, createBackup: true }, signal, { backgroundAutoSync: true }));
      } catch {
      }
    }
    return results;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run;
    return run;
  }

  private get sourceFile() { return join(this.endpoints.home, 'portable-spaces.json'); }
  private get forkRegistry() { return join(this.endpoints.home, '.portable-space-bases.json'); }
  private get baseRoot() { return join(this.endpoints.home, '.portable-space-bases'); }
  private async hashKey() { return (await this.endpoints.sync.ensureDeviceKeypair()).identity; }
  private async sources(): Promise<PortableSpaceSourceRecord[]> {
    const bytes = await missing(readBounded(this.sourceFile));
    return bytes ? sourceListSchema.parse(JSON.parse(bytes.toString('utf8'))) : [];
  }

  async list(): Promise<PortableSpaceSourcesListResponse> {
    const [key, knownRecipients, items] = await Promise.all([this.endpoints.sync.ensureDeviceKeypair(), this.endpoints.knownRecipients(), this.sources()]);
    return { deviceRecipient: key.recipient, knownRecipients, items };
  }

  /** Returns the Subscription Center v1 view (`?view=center-v1`) with order revisions and per-source policies/selections. */
  listCenter(): Promise<PortableSpaceCenterSourcesListResponse> {
    return this.center.listCenterSources();
  }

  /** Previews a URL or local archive without mutating live state or creating a device keypair. */
  previewSubscribe(input: PortableSpaceSubscribePreviewInput): Promise<PortableSpaceSubscribePreviewManifest> {
    return this.center.previewSubscribe(input);
  }

  /** Commits a previewed Center subscription (`auto | manual`) or one-shot import (`once`). */
  subscribeCenter(input: PortableSpaceCenterSubscribeInput): Promise<PortableSpaceCenterCommit> {
    return this.exclusive(() => this.center.subscribeCenter(input));
  }

  /** Previews an existing URL source for update/edit or computes reviewed cleanup impact without network I/O. */
  previewSource(id: string, input: PortableSpaceSourcePreviewInput = {}): Promise<PortableSpaceSubscribePreviewManifest> {
    return this.center.previewSource(id, input);
  }

  /** Commits a reviewed token sync or Center v1 direct sync for an existing URL subscription. */
  syncSubscriptionCenter(
    id: string,
    input: PortableSpaceCenterTokenSyncInput | PortableSpaceCenterDirectSyncInput,
    signal?: AbortSignal,
    options?: { readonly backgroundAutoSync?: boolean },
  ): Promise<PortableSpaceCenterCommit> {
    return this.exclusive(() => this.center.syncSubscriptionCenter(id, input, signal, options));
  }

  /** Patches source metadata or updates selective scope/bindings under the single-home serialization lock. */
  patchSource(id: string, input: PortableSpacePatchSourceInput): Promise<PortableSpacePatchSourceResult> {
    return this.exclusive(() => this.center.patchSource(id, input));
  }

  /** Atomically reorders URL subscriptions for a space after verifying expectedOrderRevision. */
  reorderSources(input: PortableSpaceReorderSourcesInput): Promise<PortableSpaceReorderSourcesResult> {
    return this.exclusive(() => this.center.reorderSources(input));
  }

  /** Computes local zero-network removal impact for a registered source. */
  previewRemoveSource(id: string): Promise<PortableSpaceRemovePreviewResult> {
    return this.center.previewRemoveSource(id);
  }

  /** Executes reviewed source detach or guarded purge with peer handoff and backup. */
  removeReviewedSource(id: string, input: PortableSpaceRemoveReviewedInput): Promise<PortableSpaceRemoveReviewedResponse> {
    return this.exclusive(() => this.center.removeReviewedSource(id, input));
  }

  addRecipient(recipient: string, label?: string) {
    return this.exclusive(async () => {
      const items = await this.endpoints.knownRecipients();
      const next = [...items.filter((entry) => entry.recipient !== recipient), { recipient, label }];
      await writeFileAtomic(this.endpoints.recipientsFile, `${formatRecipients(next)}\n`, 0o600);
      return this.list();
    });
  }

  private async saveSources(items: PortableSpaceSourceRecord[]) {
    await writeFileAtomic(this.sourceFile, `${JSON.stringify(items, null, 2)}\n`, 0o600);
  }

  private async recordDestination(receipt: PortableSpaceExportReceipt, refreshOnly = false): Promise<PortableSpaceExportReceipt> {
    const { destination, format, spaceMode, secretMode, encryptionMode } = receipt;
    if (destination === '-') return receipt;
    const path = resolve(destination);
    const endpoint = endpointForPath(path, format);
    const items = await this.sources();
    const existing = items.find((item) => endpointKey(item.endpoint) === endpointKey(endpoint));
    if (!existing) {
      if (refreshOnly) return receipt;
      const scratch = resolve(tmpdir());
      const realScratch = await missing(realpath(scratch)) ?? scratch;
      const realPath = await realpath(path);
      if ([path, realPath].some((value) => value.split(sep).some((part) => part.toLowerCase() === '.tmp') || [scratch, realScratch].some((root) => {
        const suffix = relative(root, value);
        return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
      }))) return receipt;
    }
    const sourceRecord: PortableSpaceSourceRecord = { ...existing, id: existing?.id ?? randomUUID(), endpoint, label: existing?.label ?? basename(path).slice(0, 256), format, spaceMode, secretMode, encryptionMode, updatedAt: new Date().toISOString() };
    await this.saveSources(existing ? items.map((item) => item.id === existing.id ? sourceRecord : item) : [...items, sourceRecord]);
    return { ...receipt, sourceRecord };
  }

  register(input: PortableSpaceRegisterSourceInput): Promise<PortableSpaceSourceRecord> {
    return this.exclusive(async () => {
      const tree = await this.endpoints.load(input.endpoint, { unlock: input.unlock });
      const items = await this.sources();
      const existing = items.find((entry) => endpointKey(entry.endpoint) === endpointKey(input.endpoint));
      const record: PortableSpaceSourceRecord = {
        id: existing?.id ?? randomUUID(), endpoint: input.endpoint, label: input.label ?? tree.label,
        linkedSpaceId: input.linkToSpaceId ?? existing?.linkedSpaceId ?? (input.endpoint.kind === 'url' ? 'main' : undefined),
        format: tree.format, spaceMode: tree.overlay ? 'overlay' : 'full', secretMode: tree.secretMode,
        encryptionMode: tree.encryptionMode, gitBranch: input.endpoint.kind === 'git' ? input.endpoint.ref : undefined,
        updatedAt: new Date().toISOString(), lastSyncedAt: existing?.lastSyncedAt,
        autoSync: input.autoSync ?? existing?.autoSync ?? (input.endpoint.kind === 'url' ? true : undefined),
        etag: existing?.lastSyncedAt !== undefined ? sanitizeEtag(existing.etag) : undefined,
        lastCheckedAt: input.endpoint.kind === 'url' ? new Date().toISOString() : existing?.lastCheckedAt,
        lastSyncError: undefined,
        managedIds: existing?.managedIds,
      };
      if (input.linkToSpaceId && !existing?.linkedSpaceId) {
        const live = await this.endpoints.load({ kind: 'live', spaceId: input.linkToSpaceId });
        const agreed = new Map([...tree.units].filter(([id, unit]) => sameUnit(unit, live.units.get(id))));
        await this.saveBase(record.id, agreed, await this.hashKey());
      }
      await this.saveSources([...items.filter((item) => item.id !== record.id), record]);
      return record;
    });
  }

  subscribe(input: PortableSpaceSubscribeInput): Promise<PortableSpaceSubscriptionSyncResult> {
    return this.exclusive(async () => {
      const endpoint: Extract<PortableSpaceEndpoint, { kind: 'url' }> = { kind: 'url', url: input.url };
      const items = await this.sources();
      const existing = items.find((entry) => endpointKey(entry.endpoint) === endpointKey(endpoint));
      if (existing !== undefined) {
        const ledgerEntry = await this.center.readSourceLedgerEntry(existing.id, existing);
        const hasSelectiveState =
          ledgerEntry.selection !== undefined
          || Object.keys(ledgerEntry.bindingChoices.modelBindings ?? {}).length > 0
          || Object.keys(ledgerEntry.bindingChoices.unitModelBindings ?? {}).length > 0
          || (ledgerEntry.bindingChoices.deferredSlotIds?.length ?? 0) > 0;
        if (hasSelectiveState) {
          const commit = await this.center.syncSubscriptionCenter(existing.id, {
            force: true,
            createBackup: input.createBackup !== false,
            unlock: input.unlock,
          });
          const refreshed = (await this.sources()).find((entry) => entry.id === existing.id) ?? existing;
          return {
            source: refreshed,
            status: commit.status === 'imported' ? 'updated' : commit.status,
            appliedIds: commit.appliedIds,
            deletedIds: commit.deletedIds,
            skippedIds: commit.skippedIds,
            ...(commit.backupPath !== undefined ? { backupPath: commit.backupPath } : {}),
            ...(commit.kind === 'subscription' && commit.error !== undefined ? { error: commit.error } : {}),
          };
        }
      }
      const loaded = await this.endpoints.loadUrl(endpoint, { unlock: input.unlock });
      if (loaded.status !== 'ok') throw new Error('Unexpected 304 response during initial subscription');
      const now = new Date().toISOString();
      const recordId = existing?.id ?? randomUUID();
      const spaceId = input.linkToSpaceId ?? existing?.linkedSpaceId ?? 'main';
      const isFirstSubscribe = existing?.lastSyncedAt === undefined && existing?.managedIds === undefined;
      const applied = await this.applySubscriptionTree(recordId, spaceId, loaded.tree, existing?.managedIds ?? [], isFirstSubscribe, input.createBackup !== false, undefined, false);
      const pendingPlugins = applied.pluginErrors.map((entry) => entry.id);
      const pluginErrorMsg = applied.pluginErrors.length > 0
        ? `Official plugin reconciliation pending (${applied.pluginErrors.map((entry) => `${entry.id}: ${entry.message}`).join('; ')})`.slice(0, 1024)
        : undefined;
      const record: PortableSpaceSourceRecord = {
        id: recordId,
        endpoint,
        label: input.label ?? existing?.label ?? loaded.tree.label,
        linkedSpaceId: spaceId,
        format: loaded.tree.format,
        spaceMode: loaded.tree.overlay ? 'overlay' : 'full',
        secretMode: loaded.tree.secretMode,
        encryptionMode: loaded.tree.encryptionMode,
        updatedAt: now,
        lastSyncedAt: now,
        lastCheckedAt: now,
        autoSync: input.autoSync ?? existing?.autoSync ?? true,
        etag: sanitizeEtag(loaded.etag),
        etagOrigin: loaded.finalOrigin,
        lastSyncError: pluginErrorMsg,
        managedIds: applied.nextManagedIds,
        ...(pendingPlugins.length > 0 ? { pendingOfficialPlugins: pendingPlugins } : {}),
      };
      const nextRecords = [...items.filter((item) => item.id !== record.id), record];
      await this.saveSources(nextRecords);
      await this.center.syncLedgerAfterLegacyApply({
        record,
        spaceId,
        rawBaseUnits: applied.rawBaseUnits,
        nextUnits: applied.nextUnits,
        nextManagedIds: applied.nextManagedIds,
        hashKey: applied.hashKey,
        records: nextRecords,
        installedPluginIds: applied.installedPluginIds,
        pendingPluginReviewIds: applied.heldPluginIds,
      });
      return {
        source: record,
        status: 'updated',
        appliedIds: applied.appliedIds,
        deletedIds: applied.deletedIds,
        skippedIds: applied.skippedIds,
        backupPath: applied.backupPath,
      };
    });
  }

  syncSubscription(
    id: string,
    input: Partial<PortableSpaceSubscriptionSyncInput> = {},
    signal?: AbortSignal,
    options?: { readonly backgroundAutoSync?: boolean },
  ): Promise<PortableSpaceSubscriptionSyncResult> {
    return this.exclusive(async () => {
      const items = await this.sources();
      const existing = items.find((entry) => entry.id === id);
      if (existing === undefined) throw portableNotFound('Portable Space source not found');
      if (existing.endpoint.kind !== 'url') throw new Error('Only URL subscriptions support subscription sync');
      const spaceId = existing.linkedSpaceId ?? 'main';
      const ledgerEntry = await this.center.readSourceLedgerEntry(existing.id, existing);
      const multiUrlSpace = items.filter((entry) => entry.endpoint.kind === 'url' && (entry.linkedSpaceId ?? 'main') === spaceId).length > 1;
      const shouldUseCenterEngine =
        multiUrlSpace
        || ledgerEntry.selection !== undefined
        || ledgerEntry.pendingTransfers.length > 0
        || Object.keys(ledgerEntry.bindingChoices.modelBindings ?? {}).length > 0
        || Object.keys(ledgerEntry.bindingChoices.unitModelBindings ?? {}).length > 0
        || (ledgerEntry.bindingChoices.deferredSlotIds?.length ?? 0) > 0;
      if (shouldUseCenterEngine) {
        const commit = await this.center.syncSubscriptionCenter(id, {
          force: input.force ?? false,
          createBackup: input.createBackup !== false,
        }, signal, options);
        const refreshed = (await this.sources()).find((entry) => entry.id === id) ?? existing;
        return {
          source: refreshed,
          status: commit.status === 'imported' ? 'updated' : commit.status,
          appliedIds: commit.appliedIds,
          deletedIds: commit.deletedIds,
          skippedIds: commit.skippedIds,
          ...(commit.backupPath !== undefined ? { backupPath: commit.backupPath } : {}),
          ...(commit.kind === 'subscription' && commit.error !== undefined ? { error: commit.error } : {}),
        };
      }
      const backgroundAutoSync = options?.backgroundAutoSync === true;
      const now = new Date().toISOString();
      try {
        const canRevalidate = input.force !== true && existing.lastSyncedAt !== undefined && existing.etag !== undefined;
        const loaded = await this.endpoints.loadUrl(existing.endpoint, {
          ifNoneMatch: canRevalidate ? sanitizeEtag(existing.etag) : undefined,
          ifNoneMatchOrigin: canRevalidate ? existing.etagOrigin : undefined,
          signal,
        });
        if (loaded.status === 'not_modified') {
          if (!canRevalidate) throw new Error('Unexpected 304 response without an applied baseline');
          let nextPendingPlugins: string[] | undefined;
          let nextPluginError: string | undefined;
          if ((existing.pendingOfficialPlugins?.length ?? 0) > 0) {
            const priorBase = await this.loadBase(existing.id);
            const desiredRetry = new Map<string, boolean>();
            for (const pluginId of existing.pendingOfficialPlugins ?? []) {
              const unitId = `plugins:plugins.${pluginId.replaceAll('%', '%25').replaceAll('.', '%2E')}`;
              const unit = priorBase?.units.get(unitId);
              desiredRetry.set(pluginId, unit === undefined ? true : object(unit.value)['enabled'] !== false);
            }
            const retryResult = await reconcileOfficialPlugins(this.endpoints.live, desiredRetry, {
              allowInstall: !backgroundAutoSync,
            });
            if (retryResult.errors.length > 0) {
              nextPendingPlugins = retryResult.errors.map((entry) => entry.id);
              nextPluginError = `Official plugin reconciliation pending (${retryResult.errors.map((entry) => `${entry.id}: ${entry.message}`).join('; ')})`.slice(0, 1024);
            } else if (retryResult.heldIds.length > 0) {
              nextPendingPlugins = retryResult.heldIds;
              nextPluginError = `Plugin changes require interactive confirmation (${retryResult.heldIds.join(', ')})`.slice(0, 1024);
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
          await this.saveSources(items.map((item) => item.id === existing.id ? updated : item));
          return {
            source: updated,
            status: 'not_modified',
            appliedIds: [],
            deletedIds: [],
            skippedIds: [],
          };
        }
        if (signal?.aborted) throw new Error('Subscription sync cancelled');
        const isFirstSubscribe = existing.lastSyncedAt === undefined && existing.managedIds === undefined;
        const applied = await this.applySubscriptionTree(
          existing.id,
          spaceId,
          loaded.tree,
          existing.managedIds ?? [],
          isFirstSubscribe,
          input.createBackup !== false,
          signal,
          backgroundAutoSync,
          ledgerEntry.installedPluginIds,
        );
        const pendingPlugins = applied.pluginErrors.map((entry) => entry.id);
        const pluginErrorMsg = applied.pluginErrors.length > 0
          ? `Official plugin reconciliation pending (${applied.pluginErrors.map((entry) => `${entry.id}: ${entry.message}`).join('; ')})`.slice(0, 1024)
          : applied.heldPluginIds.length > 0
            ? `Plugin changes require interactive confirmation (${applied.heldPluginIds.join(', ')})`.slice(0, 1024)
            : undefined;
        const updated: PortableSpaceSourceRecord = {
          ...existing,
          format: loaded.tree.format,
          spaceMode: loaded.tree.overlay ? 'overlay' : 'full',
          secretMode: loaded.tree.secretMode,
          encryptionMode: loaded.tree.encryptionMode,
          updatedAt: now,
          lastCheckedAt: now,
          lastSyncedAt: now,
          etag: applied.heldPluginIds.length > 0 ? sanitizeEtag(existing.etag) : sanitizeEtag(loaded.etag),
          etagOrigin: applied.heldPluginIds.length > 0 ? existing.etagOrigin : loaded.finalOrigin,
          lastSyncError: pluginErrorMsg,
          managedIds: applied.nextManagedIds,
          pendingOfficialPlugins: pendingPlugins.length > 0 ? pendingPlugins : undefined,
        };
        const nextRecords = items.map((item) => item.id === existing.id ? updated : item);
        await this.saveSources(nextRecords);
        await this.center.syncLedgerAfterLegacyApply({
          record: updated,
          spaceId,
          rawBaseUnits: applied.rawBaseUnits,
          nextUnits: applied.nextUnits,
          nextManagedIds: applied.nextManagedIds,
          hashKey: applied.hashKey,
          records: nextRecords,
          installedPluginIds: applied.installedPluginIds,
          pendingPluginReviewIds: applied.heldPluginIds,
        });
        return {
          source: updated,
          status: 'updated',
          appliedIds: applied.appliedIds,
          deletedIds: applied.deletedIds,
          skippedIds: applied.skippedIds,
          backupPath: applied.backupPath,
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]!.slice(0, 1024);
        const failed: PortableSpaceSourceRecord = {
          ...existing,
          lastCheckedAt: now,
          lastSyncError: message,
        };
        await this.saveSources(items.map((item) => item.id === existing.id ? failed : item));
        return {
          source: failed,
          status: 'error',
          appliedIds: [],
          deletedIds: [],
          skippedIds: [],
          error: message,
        };
      }
    });
  }

  private async applySubscriptionTree(
    recordId: string,
    spaceId: 'main' | string,
    upstreamTree: LoadedSpaceTree,
    previousManagedIds: readonly string[],
    isFirstSubscribe: boolean,
    createBackup: boolean,
    signal?: AbortSignal,
    backgroundAutoSync = false,
    ownedPlugins?: readonly string[],
  ): Promise<{
    nextManagedIds: string[];
    appliedIds: string[];
    deletedIds: string[];
    skippedIds: string[];
    pluginErrors: OfficialPluginReconcileError[];
    installedPluginIds: string[];
    heldPluginIds: string[];
    backupPath?: string;
    rawBaseUnits: Units;
    nextUnits: Units;
    hashKey: string;
  }> {
    if (signal?.aborted) throw new Error('Subscription sync cancelled');
    const liveEndpoint: PortableSpaceEndpoint = { kind: 'live', spaceId };
    await this.endpoints.assertWritable(liveEndpoint);
    const upstreamUnits = platformUnits(upstreamTree.units, process.platform);
    const liveTree = await this.endpoints.load(liveEndpoint, { includeMemories: false, includeCredentials: true });
    if (signal?.aborted) throw new Error('Subscription sync cancelled');
    const targetUnits = commonUnits(liveTree.units);
    const priorBase = await this.loadBase(recordId);
    const merged = reconcileSubscriptionUnits(upstreamUnits, targetUnits, previousManagedIds, priorBase, isFirstSubscribe);
    assertNoRemoteExecutableMcp(merged.nextUnits, targetUnits, [...merged.appliedIds, ...merged.deletedIds]);
    assertSafeRemoteCredentialBindings(merged.nextUnits, targetUnits, upstreamUnits, previousManagedIds);
    const errors = modelDependencies(merged.nextUnits);
    if (errors.length) throw new Error(errors.join('; '));
    if (signal?.aborted) throw new Error('Subscription sync cancelled');
    let effectiveNextUnits = merged.nextUnits;
    let effectiveNextBaseUnits = merged.nextBaseUnits;
    const heldPluginIdsOut = new Set<string>();
    if (backgroundAutoSync) {
      const held = await holdBackgroundPluginChanges({
        live: this.endpoints.live,
        homeDir: this.endpoints.home,
        nextUnits: merged.nextUnits,
        targetUnits,
        nextBaseUnits: merged.nextBaseUnits,
        priorBaseUnits: priorBase?.units,
      });
      effectiveNextUnits = held.nextUnits;
      effectiveNextBaseUnits = held.nextBaseUnits;
      for (const heldId of held.heldPluginIds) heldPluginIdsOut.add(heldId);
    }
    let backupPath: string | undefined;
    const pluginErrors: OfficialPluginReconcileError[] = [];
    const installedPluginIdsOut = new Set<string>(ownedPlugins ?? []);
    const ownedPluginIds = new Set<string>(ownedPlugins ?? []);
    const wroteLive = !equalUnits(effectiveNextUnits, targetUnits);
    if (wroteLive) {
      if (createBackup) {
        backupPath = join(this.endpoints.home, 'backups', 'portable-spaces', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.kiki.tgz`);
        const { recipient } = await this.endpoints.sync.ensureDeviceKeypair();
        await this.endpoints.write(backupPath, liveTree, { format: 'tgz', secretMode: 'sealed', encryption: { mode: 'x25519', recipients: [recipient] } });
      }
      await writeLive(this.endpoints.live, effectiveNextUnits, targetUnits, 'override', pluginErrors, {
        allowPluginInstall: !backgroundAutoSync,
        ownedPluginIds,
        installedPluginIdsOut,
        heldPluginIdsOut,
      });
    }
    const pendingUpstreamPlugins = new Map<string, boolean>();
    const appliedSet = new Set(merged.appliedIds);
    for (const [unitId, unit] of effectiveNextBaseUnits) {
      if (unit.domain !== 'plugins' || unit.key[0] !== 'plugins' || unit.key[1] === undefined) continue;
      if (wroteLive && appliedSet.has(unitId)) continue;
      pendingUpstreamPlugins.set(unit.key[1], object(unit.value)['enabled'] !== false);
    }
    if (pendingUpstreamPlugins.size > 0) {
      const result = await reconcileOfficialPlugins(this.endpoints.live, pendingUpstreamPlugins, {
        allowInstall: !backgroundAutoSync,
        ownedPluginIds,
      });
      for (const installedId of result.installedIds) installedPluginIdsOut.add(installedId);
      for (const heldId of result.heldIds) heldPluginIdsOut.add(heldId);
      if (result.errors.length > 0) pluginErrors.push(...result.errors);
    }
    const key = await this.hashKey();
    await this.saveBase(recordId, effectiveNextBaseUnits, key);
    return {
      nextManagedIds: merged.nextManagedIds,
      appliedIds: merged.appliedIds,
      deletedIds: merged.deletedIds,
      skippedIds: merged.skippedIds,
      pluginErrors,
      installedPluginIds: [...installedPluginIdsOut].sort(),
      heldPluginIds: [...heldPluginIdsOut].sort(),
      backupPath,
      rawBaseUnits: effectiveNextBaseUnits,
      nextUnits: effectiveNextUnits,
      hashKey: key,
    };
  }

  remove(id: string): Promise<{ removed: true }> {
    return this.exclusive(async () => {
      const current = await this.sources();
      const target = current.find((item) => item.id === id);
      if (target === undefined) throw portableNotFound('Portable Space source not found');
      const remaining = current.filter((item) => item.id !== id);
      await this.saveSources(remaining);
      await rm(join(this.baseRoot, safePortablePath(id)), { recursive: true, force: true });
      await this.center.removeLedgerEntry(id, remaining, target.linkedSpaceId ?? 'main');
      return { removed: true };
    });
  }

  async inspect(input: PortableSpaceInspectInput) {
    return inspectTree(input.endpoint, await this.endpoints.load(input.endpoint, { unlock: input.unlock }));
  }

  export(input: PortableSpaceExportInput) {
    return this.exclusive(async () => {
      const source = await this.endpoints.load(input.source, { unlock: input.sourceUnlock, includeMemories: input.includeMemories, includeCredentials: input.secretMode !== 'none' && (!input.domains || input.domains.includes('credentials')), sessions: input.sessions, targetPlatform: input.targetPlatform });
      const units = selectedUnits(source.units, input.domains, input.pick);
      if (input.sessions.mode === 'none') for (const [id, unit] of units) if (unit.domain === 'sessions') units.delete(id);
      const excluded = source.excluded?.filter((item) => (input.domains === undefined || input.domains.includes(item.domain)) && (input.pick === undefined || input.pick.some((selector) => item.id === selector || item.path === selector || item.path.startsWith(`${selector}.`))));
      return this.recordDestination(await this.endpoints.write(input.destination, { ...source, units, excluded: excluded?.length ? excluded : undefined, overlay: input.spaceMode === 'overlay', unset: new Set(input.unset ?? (input.spaceMode === 'overlay' ? source.unset : [])) }, input));
    });
  }

  pack(input: PortableSpacePackUnpackInput) {
    return this.exclusive(async () => {
      const endpoint: PortableSpaceEndpoint = { kind: input.action === 'pack' ? 'dir' : 'archive', path: input.sourcePath };
      const source = await this.endpoints.load(endpoint, { unlock: input.unlock, includeCredentials: input.secretMode !== 'none' });
      const format = input.action === 'unpack' ? 'dir' : input.format ?? pathFormat(input.destinationPath);
      if (input.action === 'pack' && format === 'dir') throw new Error('Pack destination must be an age or tgz archive');
      const secretMode = input.secretMode ?? (source.secretMode === 'none' ? 'none' : 'sealed');
      const encryption = input.encryption ?? (source.encryptionMode === 'passphrase' ? { mode: 'passphrase', passphrase: source.matchedPassphrase } : undefined);
      return this.recordDestination(await this.endpoints.write(input.destinationPath, source, { format, secretMode, encryption }));
    });
  }

  private async forkRecords(): Promise<Record<string, StoredFork>> {
    const raw = await missing(readBounded(this.forkRegistry));
    return raw ? JSON.parse(raw.toString('utf8')) as Record<string, StoredFork> : {};
  }

  private async saveBase(id: string, units: Units, key: string, hashes = unitHashes(units, key)) {
    const root = join(this.baseRoot, id);
    await writeFileAtomic(join(root, 'public.tgz'), packTarGz(filesFromUnits(new Map([...units].filter(([, unit]) => unit.domain !== 'credentials')))), 0o600);
    await writeFileAtomic(join(root, 'hashes.json'), `${JSON.stringify(hashes)}\n`, 0o600);
  }

  private async loadBase(id: string, expected?: Record<string, string>): Promise<VerifiedBase | undefined> {
    const root = join(this.baseRoot, id);
    const raw = await missing(readBounded(join(root, 'hashes.json')));
    if (!raw) return;
    const hashes = JSON.parse(raw.toString('utf8')) as Record<string, string>;
    if (expected && !isDeepStrictEqual(hashes, expected)) return;
    const units = toUnits(unpackTarGz(await readBounded(join(root, 'public.tgz'))), this.endpoints.live.registry);
    if (Object.entries(unitHashes(units, '')).some(([unit, hash]) => hashes[unit] !== hash)) throw new Error('Portable Space base snapshot is damaged');
    return { hashes, units };
  }

  fork(input: PortableSpaceForkInput) {
    return this.exclusive(async () => {
      const source = await this.endpoints.load(input.source, { unlock: input.sourceUnlock, includeMemories: input.includeMemories, includeCredentials: input.secretMode !== 'none' && (!input.domains || input.domains.includes('credentials')) });
      const key = await this.hashKey();
      const forkId = randomUUID();
      const view = selectedUnits(source.units, input.domains, input.pick);
      const units = new Map(view);
      const unset = new Set(input.unset ?? (input.overlay ? source.unset : []));
      applyUnset(units, unset);
      const format = input.format ?? pathFormat(input.destination);
      const baseline = input.secretMode === 'none' || (format === 'tgz' && input.secretMode === undefined)
        ? new Map([...view].filter(([, item]) => item.domain !== 'credentials')) : view;
      const fork: ForkBase = { forkId, createdAt: new Date().toISOString(), unitHashes: unitHashes(baseline, key) };
      const destination = endpointKey(await this.endpoints.destination(input.destination));
      if (destination === endpointKey(input.source)) throw new Error('Fork destination must differ from its source');
      const excluded = source.excluded?.filter((item) => (input.domains === undefined || input.domains.includes(item.domain)) && (input.pick === undefined || input.pick.some((selector) => item.id === selector || item.path === selector || item.path.startsWith(`${selector}.`))));
      const receipt = await this.endpoints.write(input.destination, { ...source, units, excluded: excluded?.length ? excluded : undefined, unset, overlay: input.overlay, fork }, input);
      await this.saveBase(forkId, baseline, key);
      const records = await this.forkRecords();
      records[forkId] = { ...fork, source: endpointKey(input.source), destination };
      await writeFileAtomic(this.forkRegistry, `${JSON.stringify(records, null, 2)}\n`, 0o600);
      return this.recordDestination(receipt);
    });
  }

  delta(input: PortableSpaceDeltaInput) {
    return this.exclusive(async () => {
      const [source, base] = await Promise.all([
        this.endpoints.load(input.source, { unlock: input.sourceUnlock, sessions: input.sessions }),
        this.endpoints.load(input.since, { unlock: input.sinceUnlock, sessions: input.sessions }),
      ]);
      const left = selectedUnits(source.units, input.domains);
      const right = selectedUnits(base.units, input.domains);
      const units = new Map([...left].filter(([id, unit]) => !sameUnit(unit, right.get(id))));
      const unset = new Set([...right].filter(([id]) => !left.has(id)).map(([, unit]) => unit.path));
      return this.endpoints.write(input.destination, { ...source, units, unset, overlay: true }, input);
    });
  }

  private async linked(input: PortableSpacePreviewInput): Promise<PortableSpaceSourceRecord | undefined> {
    const left = input.sources[0]!;
    const right = input.target;
    return (await this.sources()).find((entry) => entry.linkedSpaceId && ((left.kind === 'live' && left.spaceId === entry.linkedSpaceId && endpointKey(right) === endpointKey(entry.endpoint)) || (right.kind === 'live' && right.spaceId === entry.linkedSpaceId && endpointKey(left) === endpointKey(entry.endpoint))));
  }

  private async findBase(input: PortableSpacePreviewInput, source: PortableSpaceTree, target: PortableSpaceTree, key: string): Promise<VerifiedBase | undefined> {
    if (input.base) {
      const tree = await this.endpoints.load(input.base, { unlock: input.baseUnlock });
      const units = input.target.kind === 'live' || input.sources[0]?.kind === 'live' ? platformUnits(tree.units, input.targetPlatform ?? process.platform) : tree.units;
      return { units, hashes: unitHashes(units, key) };
    }
    const link = await this.linked(input);
    if (link) return this.loadBase(link.id);
    const records = await this.forkRecords();
    const leftKey = endpointKey(input.sources[0]!);
    const rightKey = endpointKey(input.target);
    const verified = (tree: PortableSpaceTree) => {
      const stamp = tree.fork;
      if (!stamp) return;
      const known = records[stamp.forkId];
      return known && known.createdAt === stamp.createdAt && isDeepStrictEqual(known.unitHashes, stamp.unitHashes) ? known : undefined;
    };
    const left = verified(source);
    const right = verified(target);
    const names = (record: StoredFork, key: string) => record.source === key || record.destination === key;
    const known = left && right && isDeepStrictEqual(left.unitHashes, right.unitHashes) ? left
      : left && !left.shared && names(left, rightKey) ? left : right && !right.shared && names(right, leftKey) ? right : undefined;
    return known ? this.loadBase(known.forkId, known.unitHashes) : undefined;
  }

  private async plan(input: PortableSpacePreviewInput, includeDiffPreview = true): Promise<Plan> {
    if (input.target.kind === 'url') throw portableValidationError('URL subscription endpoints are read-only');
    if (input.target.kind === 'live' && input.sources.some((source) => source.kind === 'url')) {
      throw portableValidationError('Use the reviewed Subscription Center subscribe/sync flow for URL subscriptions into a live space');
    }
    if (input.mode === 'sync' && input.sources.length !== 1) throw new Error('Sync requires one source and one target');
    const targetKey = endpointKey(input.target);
    if (input.sources.some((source) => endpointKey(source) === targetKey)) throw new Error('Source and target must differ');
    const [tree, ...sourceTrees] = await Promise.all([
      this.endpoints.load(input.target, { unlock: input.targetUnlock, targetPlatform: input.targetPlatform }).catch((error: NodeJS.ErrnoException) => {
        const target = input.target;
        if (error.code !== 'ENOENT' || target.kind !== 'dir' && target.kind !== 'archive') throw error;
        return { units: new Map(), unset: new Set<string>(), overlay: false, recipients: [], format: target.kind === 'dir' ? 'dir' : pathFormat(target.path), secretMode: 'none', encryptionMode: 'none', label: target.path } satisfies PortableSpaceTree;
      }),
      ...input.sources.map((endpoint, index) => this.endpoints.load(endpoint, { unlock: input.sourceUnlocks?.[index], targetPlatform: input.targetPlatform })),
    ]);
    const sync = input.mode === 'sync';
    const platform = input.targetPlatform ?? process.platform;
    const hasLive = input.target.kind === 'live' || sync && input.sources[0]?.kind === 'live';
    const layer = (units: Units, endpoint: PortableSpaceEndpoint) => endpoint.kind === 'live' ? commonUnits(units) : hasLive ? platformUnits(units, platform) : units;
    const right = layer(tree.units, input.target);
    const targetMasks = sync && tree.overlay ? tree.unset : new Set<string>();
    applyUnset(right, targetMasks);
    const left: Units = new Map();
    const masks = new Set<string>();
    for (const [index, source] of sourceTrees.entries()) {
      for (const [id, unit] of layer(source.units, input.sources[index]!)) left.set(id, unit);
      if (source.overlay) {
        applyUnset(left, source.unset);
        for (const mask of source.unset) masks.add(mask);
      }
    }
    if (!sync) for (const mask of masks) for (const [id, unit] of right) {
      if (left.has(id) || !mask.startsWith(`${unit.path}.`) || Buffer.isBuffer(unit.value)) continue;
      const value = object(unit.value);
      assignPath(value, mask.slice(unit.path.length + 1).split('.'), undefined);
      left.set(id, { ...unit, value });
    }
    const link = input.mode === 'merge' && input.sources.length === 1 ? await this.linked(input) : undefined;
    const key = sync || link ? await this.hashKey() : '';
    const base = sync ? await this.findBase(input, sourceTrees[0]!, tree, key) : link ? await this.loadBase(link.id) : undefined;
    const domains = input.mode === 'replace' && !input.domains && sourceTrees.every((source) => source.secretMode === 'none')
      ? [...new Set([...left.values(), ...right.values()].flatMap((unit) => unit.domain === 'credentials' ? [] : [unit.domain]))] : input.domains;
    return { input, tree, sourceTrees, left, right, base, key, ...await planChanges({ ...input, domains }, left, right, masks, base, key, targetMasks, includeDiffPreview) };
  }

  private errors(plan: Plan, result: ReturnType<typeof reconcile>): string[] {
    return [...plan.input.target.kind === 'live' ? modelDependencies(result.rightResult) : [],
      ...plan.input.mode === 'sync' && plan.input.sources[0]?.kind === 'live' ? modelDependencies(result.leftResult) : []];
  }

  async preview(input: PortableSpacePreviewInput): Promise<PortableSpacePreviewResult> {
    const plan = await this.plan(input);
    const previewToken = randomUUID();
    const now = Date.now();
    for (const [token, preview] of this.previews) if (preview.at + TTL <= now) this.previews.delete(token);
    this.previews.set(previewToken, { at: now, plan });
    const rows = plan.changes.map((change) => change.row);
    return { mode: input.mode, hasVerifiedBase: plan.base !== undefined, rows, previewToken,
      sourceLabels: plan.sourceTrees.map((tree) => tree.label), targetLabel: plan.tree.label, unchangedCount: plan.unchangedCount,
      conflictCount: rows.filter((row) => row.change === 'conflict').length, expiresAt: new Date(now + TTL).toISOString(),
      dependencyErrors: this.errors(plan, reconcile(plan.changes, plan.left, plan.right, input.mode === 'sync')) };
  }

  apply(input: PortableSpaceApplyInput): Promise<PortableSpaceApplyReceipt> {
    return this.exclusive(async () => {
      const cached = input.previewToken ? this.previews.get(input.previewToken) : undefined;
      if (input.previewToken && (!cached || Date.now() > cached.at + TTL)) throw new Error('Portable Space preview expired');
      const request = cached?.plan.input ?? input.direct;
      if (!request) throw new Error('Apply requires a preview token or direct plan');
      const plan = await this.plan(request, false);
      if (cached && (!sameTree(cached.plan.tree, plan.tree) || cached.plan.sourceTrees.some((tree, index) => !sameTree(tree, plan.sourceTrees[index]!)) || !isDeepStrictEqual(cached.plan.base?.hashes, plan.base?.hashes))) throw new Error('Portable Space changed after preview; preview it again');
      const sync = request.mode === 'sync';
      const result = reconcile(plan.changes, plan.left, plan.right, sync, input.selectedIds, input.resolutions);
      const errors = this.errors(plan, result);
      if (errors.length) throw new Error(errors.join('; '));
      const writes = [{ endpoint: request.target, original: plan.tree, units: result.rightResult, before: plan.right, unlock: request.targetUnlock, encryption: input.targetEncryption }];
      if (sync) writes.push({ endpoint: request.sources[0]!, original: plan.sourceTrees[0]!, units: result.leftResult, before: plan.left, unlock: request.sourceUnlocks?.[0], encryption: undefined });
      const link = request.sources.length === 1 ? await this.linked(request) : undefined;
      const key = sync || link ? plan.key || await this.hashKey() : '';
      const agreed = sync || link ? agreedBase(result.leftResult, result.rightResult, key, plan.base ?? (link ? await this.loadBase(link.id) : undefined)) : undefined;
      const advance = sync && writes.some((write) => hasEmbeddedBase(write.endpoint)) && (result.appliedIds.length > 0 || (plan.base === undefined && plan.changes.length === 0));
      const fork: StoredFork | undefined = advance ? {
        forkId: randomUUID(), createdAt: new Date().toISOString(), unitHashes: agreed!.hashes,
        source: endpointKey(request.sources[0]!), destination: endpointKey(request.target), shared: writes.every((write) => hasEmbeddedBase(write.endpoint)),
      } : undefined;
      const updated = writes.filter((write) => !equalUnits(write.units, write.before) || fork && hasEmbeddedBase(write.endpoint));
      const publishOptions = await Promise.all(updated.map(async (write) => {
        await this.endpoints.assertWritable(write.endpoint);
        if (write.endpoint.kind === 'live') return undefined;
        const options = resealOptions(write.original, write.encryption);
        if (options.secretMode === 'none' && [...write.units.values()].some((unit) => unit.domain === 'credentials')) options.secretMode = 'sealed';
        return options;
      }));
      let backupPath: string | undefined;
      const gitSyncedSkills: string[] = [];
      for (const [index, write] of updated.entries()) {
        if (write.endpoint.kind === 'live') {
          if (input.createBackup) {
            backupPath = join(this.endpoints.home, 'backups', 'portable-spaces', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.kiki.tgz`);
            const { recipient } = await this.endpoints.sync.ensureDeviceKeypair();
            await this.endpoints.write(backupPath, write.original, { format: 'tgz', secretMode: 'sealed', encryption: { mode: 'x25519', recipients: [recipient] } });
          }
          gitSyncedSkills.push(...await writeLive(this.endpoints.live, write.units, write.before, request.mode));
        } else {
          const livePeer = request.target.kind === 'live' || sync && request.sources[0]?.kind === 'live';
          const units = livePeer ? preservePlatformLayers(write.original.units, write.before, write.units, request.targetPlatform ?? process.platform) : write.units;
          const unset = new Set(write.original.unset);
          for (const [id, unit] of write.units) {
            if (sameUnit(unit, write.before.get(id))) continue;
            for (const mask of unset) if (id === mask || unit.path === mask || unit.path.startsWith(`${mask}.`) || unit.path.startsWith(`${mask}/`)) unset.delete(mask);
          }
          const tree = { ...write.original, units, unset, fork: hasEmbeddedBase(write.endpoint) && fork ? { forkId: fork.forkId, createdAt: fork.createdAt, unitHashes: fork.unitHashes } : write.original.fork };
          if (write.endpoint.kind === 'git') await this.endpoints.publish(write.endpoint, tree, write.original, publishOptions[index]!, write.unlock);
          else if (write.endpoint.kind === 'url') throw new Error('URL subscription endpoints are read-only');
          else await this.endpoints.write(write.endpoint.path, tree, publishOptions[index]);
        }
      }
      if (fork && agreed) {
        await this.saveBase(fork.forkId, agreed.units, key, agreed.hashes);
        const records = await this.forkRecords();
        records[fork.forkId] = fork;
        await writeFileAtomic(this.forkRegistry, `${JSON.stringify(records, null, 2)}
`, 0o600);
      }
      if (link && agreed) {
        await this.saveBase(link.id, agreed.units, key, agreed.hashes);
        await this.saveSources((await this.sources()).map((item) => item.id === link.id ? { ...item, lastSyncedAt: new Date().toISOString() } : item));
      }
      if (input.previewToken) this.previews.delete(input.previewToken);
      return { mode: request.mode, appliedIds: result.appliedIds, skippedIds: result.skippedIds, deletedIds: result.deletedIds, backupPath, gitSyncedSkills, restartRequired: false };
    });
  }

  mutate(input: PortableSpaceMutateInput) {
    return this.exclusive(async () => {
      if (input.target.kind === 'git' || input.target.kind === 'url') throw new Error('Mutate a local Portable Space rather than a remote URL');
      const original = await this.endpoints.load(input.target, { unlock: input.unlock });
      const files = filesFromUnits(original.units);
      const unset = new Set(original.unset);
      let overlay = original.overlay;
      let recipients = original.recipients;
      const registry = this.endpoints.live.registry;
      const admit = (path: string) => {
        const canonical = safePortablePath(path);
        if (!domainForFile(canonical) && !/^(?:config(?:\.(?:win32|linux|darwin))?|extensions|overlay)\.toml$/.test(canonical) && !['mcp.json', PLAIN, RECIPIENTS].includes(canonical)) throw new Error(`Not a writable portable file: ${canonical}`);
        return canonical;
      };
      const assign = (path: string, value: Buffer) => {
        if (path === RECIPIENTS) recipients = parseRecipients(value.toString('utf8'));
        else if (path === 'overlay.toml') {
          const data = parseToml(value);
          if (data['schema'] !== 1 || data['mode'] !== 'overlay' || !Array.isArray(data['unset']) || !data['unset'].every((entry) => typeof entry === 'string')) throw new Error('Invalid overlay.toml');
          overlay = true;
          unset.clear();
          for (const item of data['unset']) unset.add(item as string);
        } else files.set(path, value);
      };
      for (const action of input.actions) {
        if (action.op === 'set' || action.op === 'unset') {
          if (action.op === 'set' && action.key.includes('/')) throw new Error('Use rm/cp for file paths');
          const units = toUnits(files, registry);
          const existing = [...units.values()].filter((unit) => !Buffer.isBuffer(unit.value) && (action.key === unit.path || action.key.startsWith(`${unit.path}.`))).sort((a, b) => b.path.length - a.path.length)[0];
          const raw = parseToml(files.get('config.toml'));
          const suffix = existing ? action.key.slice(existing.path.length).split('.').filter(Boolean) : [];
          const key = existing?.domain === 'mcp' ? ['mcp', ...existing.key, ...suffix]
            : existing?.domain === 'config' || existing?.domain === 'credentials' ? [...existing.key, ...suffix] : action.key.split('.');
          if (action.op === 'set') {
            if (action.value === undefined || action.value === null) throw new Error('Use unset rather than assigning null');
            if (key[0] === 'mcp' || key[0] === 'providers' || key[0] === 'nb_search') {
              const secrets = parseToml(files.get(PLAIN));
              assignPath(secrets, key, undefined);
              files.set(PLAIN, encodeToml(secrets));
            }
            if (key[0] === 'mcp') {
              const current = files.get('mcp.json');
              const servers = current ? object(object(JSON.parse(current.toString('utf8')))['mcpServers']) : {};
              assignPath(servers, key.slice(1), action.value);
              files.set('mcp.json', Buffer.from(JSON.stringify({ mcpServers: servers })));
            } else if (key[0] === 'pool') {
              const secrets = parseToml(files.get(PLAIN));
              assignPath(secrets, key, action.value);
              files.set(PLAIN, encodeToml(secrets));
            } else {
              assignPath(raw, key, action.value);
              files.set('config.toml', encodeToml(raw));
            }
            unset.delete(action.key);
          } else {
            applyUnset(units, [action.key]);
            files.clear();
            for (const [path, bytes] of filesFromUnits(units)) files.set(path, bytes);
            if (action.recordOverlayUnset) { overlay = true; unset.add(action.key); }
          }
        } else if (action.op === 'rm') {
          for (const path of action.paths) {
            if (isUnitId(path)) {
              const units = toUnits(files, registry);
              if (units.delete(path)) {
                files.clear();
                for (const [key, bytes] of filesFromUnits(units)) files.set(key, bytes);
              }
              continue;
            }
            const canonical = safePortablePath(path);
            if (canonical === RECIPIENTS) recipients = [];
            else if (canonical === 'overlay.toml') { overlay = false; unset.clear(); }
            else {
              const units = toUnits(files, registry);
              let structured = false;
              for (const [id, unit] of units) if (unit.path === canonical || unit.path.startsWith(`${canonical}/`)) structured = units.delete(id) || structured;
              if (structured) {
                files.clear();
                for (const [key, bytes] of filesFromUnits(units)) files.set(key, bytes);
              }
              if (canonical === SEALED) files.delete(PLAIN);
              for (const key of files.keys()) if (key === canonical || key.startsWith(`${canonical}/`)) files.delete(key);
            }
          }
        } else if (action.op === 'writeFile') {
          const path = admit(action.path);
          const bytes = Buffer.from(action.contentBase64, 'base64');
          if (bytes.toString('base64') !== action.contentBase64) throw new Error('Invalid portable file content');
          assign(path, bytes);
        } else {
          const from = await this.endpoints.load(action.from, { unlock: action.fromUnlock });
          const path = safePortablePath(action.fromPath);
          const source = filesFromUnits(from.units);
          if (from.recipients.length) source.set(RECIPIENTS, Buffer.from(formatRecipients(from.recipients)));
          if (from.overlay) source.set('overlay.toml', encodeToml({ schema: 1, mode: 'overlay', unset: [...from.unset] }));
          const entries = [...source].filter(([entry]) => entry === path || entry.startsWith(`${path}/`));
          if (!entries.length) throw new Error(`No portable file found at ${path}`);
          const to = safePortablePath(action.toPath ?? path);
          for (const [entry, bytes] of entries) assign(admit(`${to}${entry.slice(path.length)}`), bytes);
        }
      }
      const units = toUnits(files, registry);
      const next = { ...original, units, unset, overlay, recipients };
      const changed = !sameTree(original, next);
      if (changed) {
        await this.endpoints.assertWritable(input.target);
        if (input.target.kind === 'live') {
          const errors = modelDependencies(units);
          if (errors.length) throw new Error(errors.join('; '));
          await writeLive(this.endpoints.live, units, original.units);
        } else {
          const options = resealOptions(original, input.encryption);
          if (options.secretMode === 'none' && [...units.values()].some((unit) => unit.domain === 'credentials')) options.secretMode = 'sealed';
          const receipt = await this.endpoints.write(input.target.path, next, options);
          await this.recordDestination(receipt, true);
          next.secretMode = receipt.secretMode;
          next.encryptionMode = receipt.encryptionMode;
          if (receipt.encryptionMode === 'passphrase') next.recipients = [];
          else if (input.encryption?.mode === 'x25519' && input.encryption.recipients?.length) next.recipients = input.encryption.recipients.map((recipient) => ({ recipient }));
          else if (receipt.encryptionMode === 'x25519' && !next.recipients.length) {
            const { recipient } = await this.endpoints.sync.ensureDeviceKeypair();
            next.recipients = [{ recipient }, ...(await this.endpoints.knownRecipients()).filter((entry) => entry.recipient !== recipient)];
          }
        }
      }
      return { changed, appliedOps: changed ? input.actions.length : 0, inspect: inspectTree(input.target, next) };
    });
  }

  rekey(input: PortableSpaceRekeyInput) {
    return this.exclusive(async () => {
      const endpoint = await this.endpoints.destination(input.target);
      const tree = await this.endpoints.load(endpoint, { unlock: input.unlock });
      const destination = input.outputPath ?? input.target;
      const format = input.outputPath ? pathFormat(destination) : tree.format;
      const receipt = await this.endpoints.write(destination, tree, { format, secretMode: 'sealed', encryption: input.encryption, replaceManaged: input.outputPath === undefined });
      await this.recordDestination(receipt, true);
      const output = endpointForPath(destination, receipt.format);
      const recipients = input.encryption.mode === 'passphrase' ? [] : input.encryption.recipients?.map((recipient) => ({ recipient })) ?? (tree.recipients.length ? tree.recipients : await this.endpoints.knownRecipients());
      if (receipt.encryptionMode === 'x25519' && !recipients.length) recipients.push({ recipient: (await this.endpoints.sync.ensureDeviceKeypair()).recipient });
      return inspectTree(output, { ...tree, format, secretMode: receipt.secretMode, encryptionMode: receipt.encryptionMode, recipients });
    });
  }
}
