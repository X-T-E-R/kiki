import { randomBytes, randomUUID } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { usageExportConsentSchema, usageExportPreviewSchema, usageExportSaveSchema, usageExportScopeSchema, usageExportStatusSchema, type UsageExportConsent, type UsageExportDestination, type UsageExportItem, type UsageExportPreview, type UsageExportSave, type UsageExportScope, type UsageExportStatus } from '@kiki/protocol';
import type { IModelPricingService } from '../../pricing/modelPricingService';
import type { UsageAggregationService } from '../usageAggregationService';
import { USAGE_EXPORT_ERROR_CATEGORIES, type UsageExportAdapter, type UsageExportAdapterContext, type UsageExportAdapterResult } from './adapter';
import { digest, opaqueId, projectSource } from './projection';
import { UsageExportStore } from './store';
import { UsageExportSecretStore } from './secrets';
import { postUsageExport, validateExportTarget } from './transport';
import { requiresVibeRemoteRebuild } from './vibe';
import { usageExportHandoffArmSchema, usageExportHandoffSchema, type UsageExportHandoff, type UsageExportHandoffArm, type UsageExportReceipt } from '@kiki/protocol';
import { armUsageExportHandoff, confirmNativeHandoff, planUsageExportHandoff, planUsageExportRollback, recordLegacyHandoffReceipt, nativeHandoffScope } from './migration';
import { activateCollectorHandoff, canonicalExportHome, readCollectorHandoff, resumeCollectorHandoff } from './handoffFile';

export interface UsageExportServiceOptions { readonly now?: () => number; readonly random?: () => number; readonly sourceHome?: string }
export class UsageExportService {
  private readonly adapters = new Map<string, UsageExportAdapter>();
  private readonly flights = new Map<string, Promise<void>>();
  private readonly protocolFlights = new Set<Promise<{ outcome: UsageExportAdapterResult['outcome']; error_category: string | null }>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly now: () => number;
  private readonly random: () => number;
  private scanFlight: Promise<void> | undefined;
  private scanRun: string | undefined;
  private continuationTimer: NodeJS.Timeout | undefined;
  private timer: NodeJS.Timeout | undefined;
  private electionTimer: NodeJS.Timeout | undefined;
  private closing = false;
  private started = false;
  private recoveryFlight: Promise<void> | undefined;
  constructor(readonly store: UsageExportStore, private readonly reader: UsageAggregationService, private readonly pricing: IModelPricingService, private readonly secrets: UsageExportSecretStore, adapters: readonly UsageExportAdapter[], private readonly options: UsageExportServiceOptions = {}) {
    this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
    for (const adapter of adapters) this.registerAdapter(adapter);
  }
  registerAdapter(adapter: UsageExportAdapter): void {
    if (!Number.isSafeInteger(adapter.maxBatchItems) || adapter.maxBatchItems < 1 || adapter.maxBatchItems > 200 || adapter.maxBodyBytes < 1024 || adapter.maxBodyBytes > 1_048_576) throw new Error('invalid-adapter-limits');
    this.adapters.set(adapter.kind, adapter);
  }
  status(): UsageExportStatus {
    return usageExportStatusSchema.parse({ writer: this.store.writer, scan_complete: this.store.meta('scan-complete') === 'true', scan_error: this.store.meta('scan-error') || null, destinations: this.store.list().map((destination) => ({ destination, queue: this.store.queue(destination.id) })) });
  }
  private fingerprint(destination: UsageExportDestination): string {
    const target = destination.target.kind === 'script' ? { kind: 'script', command: destination.target.command } : { kind: destination.target.kind, endpoint: destination.target.endpoint, private_grant: destination.target.private_grant, authentication: destination.target.kind === 'webhook' ? destination.target.authentication : 'bearer' };
    return digest({ policy: 'kiki.usage.bucket.v1', target, account: destination.account_fingerprint, scope: destination.scope, stream: destination.stream_id, adapter: this.adapters.get(destination.target.kind)?.mappingVersion ?? 'unavailable' });
  }
  async saveDraft(input: UsageExportSave): Promise<UsageExportDestination> {
    if (!this.store.writer) throw new Error('export-writer-unavailable');
    const { draft, secret } = usageExportSaveSchema.parse(input); validateExportTarget(draft.target);
    const id = draft.id ?? randomUUID(); const previous = draft.id === undefined ? undefined : this.store.get(id);
    const handoff = previous === undefined ? null : this.handoff(id);
    if (handoff !== null && (draft.scope.start_at < (handoff.previous_cutoff_at ?? handoff.cutoff_at) || (handoff.phase === 'rollback-prepared' && (draft.scope.end_at === null || draft.scope.end_at > handoff.cutoff_at)))) throw new Error('handoff-scope-crosses-cutoff');
    const storage = secret?.storage ?? previous?.credential_storage ?? 'none';
    const currentSecret = secret?.value ?? (previous === undefined ? undefined : await this.secrets.read(id, storage));
    const accountFingerprint = opaqueId(this.store.installationKey(), draft.target.kind === 'script' ? `script\0${draft.target.command}` : `unverified-credential\0${currentSecret ?? 'anonymous'}`);
    const next: UsageExportDestination = { id, label: draft.label, target: draft.target, account_fingerprint: accountFingerprint, scope: draft.scope, schedule_minutes: draft.schedule_minutes, stream_id: previous?.stream_id ?? randomBytes(24).toString('hex'), enabled: false, consent_fingerprint: null, credential_storage: storage, state: 'draft', next_at: null, last_success_at: previous?.last_success_at ?? null, error_category: null };
    const sameIdentity = previous !== undefined && previous.account_fingerprint === accountFingerprint && previous.target.kind === next.target.kind && (previous.target.kind === 'script' || next.target.kind === 'script' || previous.target.endpoint === next.target.endpoint);
    if (previous !== undefined && !sameIdentity && (this.store.queue(id).pending + this.store.queue(id).inflight + this.store.queue(id).quarantined > 0 || previous.last_success_at !== null)) throw new Error('identity-change-requires-new-destination');
    const shrunk = previous !== undefined && scopeWithin(next.scope, previous.scope);
    if (previous !== undefined && sameIdentity && previous.consent_fingerprint !== null && shrunk && consentTargetEqual(previous, next)) {
      next.consent_fingerprint = this.fingerprint(next); next.enabled = previous.enabled; next.state = previous.enabled ? 'ready' : 'disabled'; next.next_at = previous.next_at;
    }
    this.controllers.get(id)?.abort();
    if (secret !== undefined) {
      await this.secrets.save(id, secret.value, secret.storage, secret.acknowledge_file_storage);
      if (previous !== undefined && previous.credential_storage !== storage && previous.credential_storage !== 'none') await this.secrets.remove(id, previous.credential_storage);
    }
    this.store.save(next); if (next.enabled) await this.store.refreshDestinationAsync(id); this.scheduleTimer(); return next;
  }
  async preview(id: string): Promise<UsageExportPreview> {
    await this.scan(); const preview = await this.store.previewAsync(id); const destination = this.store.get(id);
    const disclosures = [
      'Only UTC half-hour model/token/quality/cost buckets are exported; no conversation, title, workspace path, profile or real hostname.',
      'The receiver can observe your IP address and usage timing. Unknown local model aliases use destination-specific opaque identifiers.',
      'Scheduling runs while the Kiki backend is alive; it does not keep the daemon alive or call a model.',
      'The displayed account fingerprint identifies this configured credential locally, not a verified remote account. Unverified key changes require fresh consent.',
    ];
    if (destination.target.kind === 'script') disclosures.push('This approved command has full OS-user permissions and may read files or use the network independently. Official stdin contains only the content-free usage protocol; this is not a sandbox.');
    if (destination.credential_storage === 'private-file') disclosures.push('The secret is stored server-side in a private file (POSIX 0600/0700 or Windows user ACL), not encrypted at rest.');
    if (destination.target.kind !== 'script' && destination.target.private_grant !== undefined) disclosures.push('You are authorizing only the configured endpoint and exact private IP/port/protocol, not all private networks.');
    return usageExportPreviewSchema.parse({ destination, preview_fingerprint: this.fingerprint(destination), items: preview.items, total_buckets: preview.total, source_complete: this.store.meta('scan-complete') === 'true' && !this.store.meta('scan-error'), invalid_records: this.store.invalidRecords(), disclosures });
  }
  async enable(id: string, input: UsageExportConsent): Promise<UsageExportDestination> {
    const consent = usageExportConsentSchema.parse(input); const destination = this.store.get(id);
    if (this.handoff(id)?.phase === 'prepared') throw new Error('handoff-use-arm');
    if (this.fingerprint(destination) !== consent.preview_fingerprint) throw new Error('consent-preview-changed');
    if (!this.adapters.has(destination.target.kind)) throw new Error('adapter-unavailable');
    try {
      const next = await this.store.updateWithMetadataAsync(id, { enabled: true, consent_fingerprint: consent.preview_fingerprint, state: 'ready', error_category: null, next_at: this.now() }, {});
      this.scheduleTimer(); return next;
    } catch (error) { if (error instanceof Error && error.message === 'export-queue-full') this.store.update(id, { state: 'queue-full', error_category: 'queue-full' }); throw error; }
  }
  disable(id: string): UsageExportDestination { this.controllers.get(id)?.abort(); const next = this.store.update(id, { enabled: false, state: 'disabled', next_at: null }); this.scheduleTimer(); return next; }
  async testProtocol(id: string): Promise<{ outcome: UsageExportAdapterResult['outcome']; error_category: string | null }> {
    if (this.closing) throw new Error('export-closing');
    const flight = this.runProtocolTest(id); this.protocolFlights.add(flight);
    try { return await flight; } finally { this.protocolFlights.delete(flight); }
  }
  private async runProtocolTest(id: string): Promise<{ outcome: UsageExportAdapterResult['outcome']; error_category: string | null }> {
    if (!this.store.writer) throw new Error('export-writer-unavailable');
    const destination = this.store.get(id); const adapter = this.adapters.get(destination.target.kind); if (adapter === undefined) return { outcome: 'invalid', error_category: 'adapter_unavailable' };
    const controller = new AbortController(); const controllerKey = `test:${id}:${randomUUID()}`; this.controllers.set(controllerKey, controller);
    const timer = setTimeout(() => { controller.abort(); }, 60_000); timer.unref();
    let result: UsageExportAdapterResult;
    try { result = await adapter.test(this.context(destination, controller.signal, 'protocol-test', () => !this.closing && this.fingerprint(this.store.get(id)) === this.fingerprint(destination))); }
    catch { result = { outcome: 'retry', errorCategory: 'network' }; }
    finally { clearTimeout(timer); this.controllers.delete(controllerKey); }
    const category = safeCategory(result);
    if (this.closing) return { outcome: result.outcome, error_category: category };
    const current = this.store.list().find((entry) => entry.id === id);
    if (current === undefined || this.fingerprint(current) !== this.fingerprint(destination)) return { outcome: 'retry', error_category: 'generic' };
    this.store.setMeta(`tested:${id}`, result.outcome === 'delivered' ? this.fingerprint(destination) : '');
    if (current.enabled && result.outcome === 'delivered' && current.state === 'needs-auth') this.store.update(id, { state: 'ready', error_category: null, next_at: this.now() });
    return { outcome: result.outcome, error_category: category };
  }
  async scan(force = false): Promise<void> {
    if (!this.store.writer || this.closing) return;
    if (this.scanFlight !== undefined) { await this.scanFlight; if (!force) return; }
    const flight = (async () => {
      await this.pricing.ready;
      if (this.closing) return;
      if (force) { await this.reader.invalidateExportCheckpoints(); if (this.scanRun !== undefined) this.store.discardStage(this.scanRun); this.scanRun = undefined; }
      const run = this.scanRun ?? randomUUID(); this.scanRun = run;
      try {
        const includeEphemeral = this.store.list().some((destination) => destination.scope.include_ephemeral);
        const result = await this.reader.readExportSources(async (source) => { if (this.closing) throw new Error('export-closing'); this.store.stage(run, projectSource(source, this.pricing)); }, includeEphemeral);
        if (this.closing) return;
        if (!result.complete) {
          this.store.setMeta('scan-error', result.reason ?? 'scan-incomplete');
          if (result.reason === 'record_budget' || result.reason === 'deadline') {
            if (this.started && !this.closing) { this.continuationTimer = setTimeout(() => { void this.scan().catch(() => {}); }, 25); this.continuationTimer.unref(); }
            return;
          }
          if (this.store.meta('scan-complete') === 'true') await this.store.publishStageAsync(run, false, result.reason); else this.store.discardStage(run);
          this.scanRun = undefined; return;
        }
        await this.store.publishStageAsync(run); this.scanRun = undefined;
      } catch (error) {
        await this.reader.resetExportRead(); if (this.closing) return;
        this.store.discardStage(run); this.scanRun = undefined; const category = error instanceof Error && error.message === 'export-queue-full' ? 'queue-full' : 'scan-failed';
        this.store.setMeta('scan-error', category);
        if (category === 'queue-full') for (const destination of this.store.list()) if (destination.enabled) this.store.update(destination.id, { state: 'queue-full', error_category: category });
      }
    })();
    this.scanFlight = flight; try { await flight; } finally { if (this.scanFlight === flight) this.scanFlight = undefined; }
  }
  async syncNow(id: string): Promise<UsageExportStatus> { await this.scan(); await this.deliver(id, true); return this.status(); }
  async backfill(id: string, scope: UsageExportScope): Promise<UsageExportPreview> {
    const destination = this.store.get(id); await this.saveDraft({ draft: { id, label: destination.label, target: destination.target, scope: usageExportScopeSchema.parse(scope), schedule_minutes: destination.schedule_minutes as 0 | 5 | 15 | 30 | 60 } }); return this.preview(id);
  }
  diagnostics(): UsageExportStatus { return this.status(); }
  exportLocal(id: string): { schema_version: 'kiki.usage.local-export.v1'; items: UsageExportItem[] } { return { schema_version: 'kiki.usage.local-export.v1', items: this.store.exportQueue(id) }; }
  setQueueCapacity(bytes: number): UsageExportStatus { this.store.setCapacity(bytes); return this.status(); }
  clearQueue(id: string, acknowledge: boolean): UsageExportStatus { if (!acknowledge) throw new Error('clear-queue-requires-consent'); this.controllers.get(id)?.abort(); this.store.clearQueue(id); return this.status(); }
  retry(id: string): UsageExportStatus { this.store.retryQuarantined(id); this.store.setMeta(`attempt:${id}`, '0'); this.store.update(id, { state: this.store.get(id).enabled ? 'ready' : 'disabled', error_category: null, next_at: this.now() }); this.scheduleTimer(); return this.status(); }
  withdraw(id: string, acknowledge: boolean): UsageExportStatus { if (!acknowledge) throw new Error('withdraw-requires-consent'); const destination = this.store.get(id); const adapter = this.adapters.get(destination.target.kind); if (!adapter?.capabilities.delete) throw new Error('destination-cannot-delete'); this.store.withdraw(id); return this.status(); }
  private context(destination: UsageExportDestination, signal: AbortSignal, batchId: string, permit: () => boolean, previousAcknowledged?: readonly UsageExportItem[]): UsageExportAdapterContext {
    return { target: structuredClone(destination.target), signal, previousAcknowledged, post: (request) => postUsageExport(destination, request, this.secrets, batchId, signal, permit) };
  }
  async remove(id: string, discardPending: boolean): Promise<{ removed: true }> {
    const destination = this.store.get(id); const queue = this.store.queue(id);
    if (queue.pending + queue.inflight + queue.quarantined > 0 && !discardPending) throw new Error('remove-requires-queue-consent');
    this.disable(id); for (const [key, controller] of this.controllers) if (key.startsWith(`test:${id}:`)) controller.abort(); await this.flights.get(id);
    await this.secrets.remove(id, destination.credential_storage); this.store.remove(id); this.scheduleTimer(); return { removed: true };
  }
  handoff(id: string): UsageExportHandoff | null {
    this.store.get(id); const state = this.store.meta(`handoff:${id}`); return state === null ? null : usageExportHandoffSchema.parse(JSON.parse(state));
  }
  async planHandoff(id: string, cutoffAt?: number): Promise<UsageExportHandoff> {
    if (this.options.sourceHome === undefined) throw new Error('handoff-source-home-unavailable');
    const destination = this.store.get(id); const queue = this.store.queue(id);
    if (destination.target.kind !== 'vibe' || destination.last_success_at !== null || queue.pending + queue.inflight + queue.quarantined > 0) throw new Error('handoff-requires-new-vibe-draft');
    const state = planUsageExportHandoff({ data_home_fingerprint: opaqueId(this.store.installationKey(), await canonicalExportHome(this.options.sourceHome)), account_fingerprint: destination.account_fingerprint, stream_id: destination.stream_id, now: this.now(), cutoff_at: cutoffAt });
    this.disable(id); this.store.update(id, { scope: { ...destination.scope, start_at: state.cutoff_at }, consent_fingerprint: null, state: 'draft' });
    this.store.setMeta(`handoff:${id}`, JSON.stringify(state)); return state;
  }
  async armHandoff(id: string, input: UsageExportHandoffArm): Promise<UsageExportHandoff> {
    const consent = usageExportHandoffArmSchema.parse(input); const state = this.handoff(id); const destination = this.store.get(id);
    if (state === null || this.options.sourceHome === undefined || this.fingerprint(destination) !== consent.preview_fingerprint) throw new Error('handoff-consent-changed');
    await this.scan();
    const secret = await this.secrets.read(id, destination.credential_storage); if (secret === undefined) throw new Error('credential-unavailable');
    const proof = await readCollectorHandoff(consent.collector_file, this.options.sourceHome, destination, state, secret);
    const armed = armUsageExportHandoff(state, { now: this.now(), cutoff_at: proof.entry.cutoff_at, data_home_fingerprint: state.data_home_fingerprint, account_fingerprint: destination.account_fingerprint, donor_cutoff_persisted: true, native_projection_complete: this.store.meta('scan-complete') === 'true' && !this.store.meta('scan-error'), native_test_delivered: this.store.meta(`tested:${id}`) === this.fingerprint(destination) });
    this.store.updateWithMetadata(id, { enabled: false, next_at: null }, { [`handoff-arm:${id}`]: JSON.stringify({ file: consent.collector_file, fingerprint: consent.preview_fingerprint }), [`handoff:${id}`]: JSON.stringify(armed) });
    await this.finishHandoffArm(id); return this.handoff(id)!;
  }
  private async finishHandoffArm(id: string): Promise<void> {
    const pending = this.store.meta(`handoff-arm:${id}`); const state = this.handoff(id); if (pending === null || pending === '' || state === null || this.options.sourceHome === undefined) return;
    const input = JSON.parse(pending) as { file: string; fingerprint: string }; const destination = this.store.get(id);
    if (!['armed', 'awaiting-native'].includes(state.phase) || this.fingerprint(destination) !== input.fingerprint) throw new Error('handoff-consent-changed');
    const secret = await this.secrets.read(id, destination.credential_storage); if (secret === undefined) throw new Error('credential-unavailable');
    const proof = await readCollectorHandoff(input.file, this.options.sourceHome, destination, state, secret);
    await activateCollectorHandoff(input.file, proof, this.now());
    if (this.closing) return;
    await this.store.updateWithMetadataAsync(id, { enabled: true, consent_fingerprint: input.fingerprint, state: 'ready', next_at: this.now(), error_category: null }, { [`collector-file:${id}`]: input.file, [`handoff-arm:${id}`]: '' }); this.scheduleTimer();
  }
  async refreshHandoff(id: string): Promise<UsageExportHandoff | null> {
    const state = this.handoff(id); if (state === null || !['armed', 'awaiting-native'].includes(state.phase)) return state;
    const file = this.store.meta(`collector-file:${id}`); if (file === null || this.options.sourceHome === undefined) return state;
    const destination = this.store.get(id); const secret = await this.secrets.read(id, destination.credential_storage); if (secret === undefined) throw new Error('credential-unavailable');
    const proof = await readCollectorHandoff(file, this.options.sourceHome, destination, state, secret);
    if (proof.entry.last_receipt !== null) { const next = recordLegacyHandoffReceipt(state, proof.entry.last_receipt); this.store.setMeta(`handoff:${id}`, JSON.stringify(next)); return next; }
    return state;
  }
  async rollbackHandoff(id: string, cutoffAt: number, acknowledge: boolean): Promise<UsageExportHandoff> {
    if (!acknowledge || this.options.sourceHome === undefined) throw new Error('handoff-rollback-requires-consent');
    const state = this.handoff(id); const file = this.store.meta(`collector-file:${id}`); if (state === null || file === null) throw new Error('handoff-not-found');
    const next = planUsageExportRollback(state, this.now(), cutoffAt); const destination = this.store.get(id);
    const secret = await this.secrets.read(id, destination.credential_storage); if (secret === undefined) throw new Error('credential-unavailable');
    await readCollectorHandoff(file, this.options.sourceHome, destination, state, secret);
    const scoped = { ...destination, scope: nativeHandoffScope(next, destination.scope)! };
    this.controllers.get(id)?.abort(); await this.flights.get(id);
    await this.store.updateWithMetadataAsync(id, { scope: scoped.scope, consent_fingerprint: this.fingerprint(scoped) }, { [`handoff:${id}`]: JSON.stringify(next), [`handoff-rollback:${id}`]: file });
    await this.finishHandoffRollback(id); return next;
  }
  private async finishHandoffRollback(id: string): Promise<void> {
    const file = this.store.meta(`handoff-rollback:${id}`); const state = this.handoff(id);
    if (!file || state?.phase !== 'rollback-prepared' || this.options.sourceHome === undefined) return;
    const destination = this.store.get(id); const secret = await this.secrets.read(id, destination.credential_storage); if (secret === undefined) throw new Error('credential-unavailable');
    const proof = await readCollectorHandoff(file, this.options.sourceHome, destination, state, secret);
    await resumeCollectorHandoff(file, proof, state.cutoff_at);
    if (!this.closing) this.store.setMeta(`handoff-rollback:${id}`, '');
  }
  private async recordNativeHandoff(id: string, receipt: UsageExportReceipt, items: readonly UsageExportItem[]): Promise<void> {
    const state = this.handoff(id); if (state === null || !['armed', 'awaiting-native'].includes(state.phase)) return;
    const starts = items.flatMap((item) => item.bucket === null ? [] : [Date.parse(item.bucket.start_at)]); if (starts.length === 0) return;
    const next = confirmNativeHandoff(state, { receipt, completed_at: this.now(), namespace: `kiki-${this.store.get(id).stream_id}`, earliest_bucket_at: Math.min(...starts) });
    this.store.setMeta(`handoff:${id}`, JSON.stringify(next)); await this.refreshHandoff(id);
  }
  async deliver(id: string, manual = false): Promise<void> {
    const running = this.flights.get(id); if (running !== undefined) return running;
    if (this.closing || !this.store.writer) return;
    const flight = this.runDelivery(id, manual); this.flights.set(id, flight);
    try { await flight; } finally { this.flights.delete(id); this.scheduleTimer(); }
  }
  private async runDelivery(id: string, manual: boolean): Promise<void> {
    let destination = this.store.get(id); if (!destination.enabled || destination.consent_fingerprint !== this.fingerprint(destination)) return;
    if (!manual && ['needs-auth', 'adapter-unavailable'].includes(destination.state)) return;
    const adapter = this.adapters.get(destination.target.kind); if (adapter === undefined) { this.store.update(id, { state: 'adapter-unavailable', error_category: 'adapter_unavailable' }); return; }
    if (this.store.meta(`withdrawn:${id}`) !== 'true') {
      try { await this.store.refreshDestinationAsync(id); }
      catch (error) { if (this.closing) return; if (error instanceof Error && error.message === 'export-queue-full') this.store.update(id, { state: 'queue-full', error_category: 'queue-full' }); else if (this.store.get(id).enabled) this.store.update(id, { next_at: this.now() + 1000 }); return; }
    }
    const maxItems = Math.min(adapter.maxBatchItems, Number(this.store.meta(`batch-limit:${id}`) ?? adapter.maxBatchItems));
    for (let i = 0; i < 10 && !this.closing; i++) {
      destination = this.store.get(id); if (!destination.enabled) return;
      const batch = this.store.take(id, maxItems, adapter.maxBodyBytes); if (batch === undefined) { this.nextNormal(id); return; }
      const controller = new AbortController(); this.controllers.set(id, controller);
      const timeout = setTimeout(() => controller.abort(), 60_000); timeout.unref();
      let result: UsageExportAdapterResult;
      try {
        const related = adapter.kind === 'vibe' ? this.store.acknowledgedRelated(id, batch) : [];
        const identityDiverged = adapter.kind === 'vibe' && related.some((entry) => !entry.sameBucket && entry.current !== null && (entry.current.operation === 'delete' || requiresVibeRemoteRebuild(entry.acknowledged, entry.current)));
        result = identityDiverged ? { outcome: 'remote-diverged', errorCategory: 'remote_diverged' } : await adapter.send(structuredClone(batch), this.context(destination, controller.signal, batch.batch_id, () => !this.closing && this.store.get(id).enabled && this.store.get(id).consent_fingerprint === this.fingerprint(this.store.get(id)), related.filter((entry) => entry.sameBucket).map((entry) => entry.acknowledged)));
      }
      catch { result = { outcome: 'retry', errorCategory: 'network' }; }
      finally { clearTimeout(timeout); this.controllers.delete(id); }
      if (this.closing || !this.store.get(id).enabled) return;
      const category = safeCategory(result);
      if (result.outcome === 'delivered' && result.receipt !== undefined) {
        try {
          const ack = this.store.acknowledge(id, result.receipt, this.now());
          if (ack.remaining > 0) { this.retryLater(id, result.retryAfterMs, 'partial_receipt'); return; }
          this.store.setMeta(`attempt:${id}`, '0');
          if (ack.rejected === 0) {
            const quarantined = this.store.queue(id).quarantined > 0;
            this.store.update(id, { last_success_at: this.now(), state: quarantined ? this.store.get(id).state : 'ready', error_category: quarantined ? this.store.get(id).error_category : null });
            await this.recordNativeHandoff(id, result.receipt, batch.items).catch(() => { this.store.setMeta(`handoff-error:${id}`, 'handoff-proof-pending'); });
          }
        } catch { this.store.releaseBatch(id, batch.batch_id, true); this.store.update(id, { state: 'quarantined', error_category: 'invalid_protocol' }); return; }
      } else if (result.outcome === 'needs-auth') { this.store.update(id, { state: 'needs-auth', next_at: null, error_category: category ?? 'http_auth' }); return; }
      else if (result.outcome === 'retry') { this.retryLater(id, result.retryAfterMs, category ?? 'network'); return; }
      else if ((result.outcome === 'too-large' || result.outcome === 'invalid') && batch.items.length > 1) {
        this.store.releaseBatch(id, batch.batch_id); this.store.setMeta(`batch-limit:${id}`, String(Math.max(1, Math.floor(batch.items.length / 2)))); this.store.update(id, { state: 'retrying', next_at: this.now() + 1000, error_category: category ?? 'http_too_large' }); return;
      } else { this.store.releaseBatch(id, batch.batch_id, true); this.store.update(id, { state: result.outcome === 'remote-diverged' ? 'remote-diverged' : 'quarantined', next_at: this.now() + 1000, error_category: category ?? (result.outcome === 'remote-diverged' ? 'remote_diverged' : 'invalid_protocol') }); }
      await yieldToEventLoop();
    }
    this.store.update(id, { next_at: this.now() + 1000 });
  }
  private retryLater(id: string, retryAfterMs: number | undefined, category: string): void {
    const attempt = Math.min(11, Number(this.store.meta(`attempt:${id}`) ?? 0) + 1); this.store.setMeta(`attempt:${id}`, String(attempt));
    const delay = Math.max(Math.min(30_000 * 2 ** Math.min(attempt - 1, 10), 21_600_000) * (0.9 + this.random() * 0.2), Number.isFinite(retryAfterMs) ? Math.min(retryAfterMs ?? 0, 86_400_000) : 0);
    this.store.update(id, { state: 'retrying', next_at: Math.floor(this.now() + delay), error_category: category });
  }
  private nextNormal(id: string): void {
    const destination = this.store.get(id); const next = destination.schedule_minutes === 0 ? null : Math.floor(this.now() + destination.schedule_minutes * 60_000 * (0.9 + this.random() * 0.2));
    this.store.update(id, { next_at: next });
  }
  start(): void {
    if (this.closing) return;
    if (!this.store.tryPromote()) { this.electionTimer = setTimeout(() => this.start(), 2000); this.electionTimer.unref(); return; }
    this.started = true;
    this.recoveryFlight = (async () => {
      for (const destination of this.store.list()) {
        if (this.closing) break;
        if (this.store.meta(`handoff-arm:${destination.id}`)) await this.finishHandoffArm(destination.id).catch(() => { if (!this.closing) this.store.update(destination.id, { enabled: false, state: 'disabled', error_category: 'handoff-recovery-needs-new-cutoff' }); });
        await this.finishHandoffRollback(destination.id).catch(() => { if (!this.closing) this.store.setMeta(`handoff-error:${destination.id}`, 'handoff-proof-pending'); });
        await this.refreshHandoff(destination.id).catch(() => { if (!this.closing) this.store.setMeta(`handoff-error:${destination.id}`, 'handoff-proof-pending'); });
      }
    })();
    for (const destination of this.store.list()) if (destination.enabled && destination.next_at !== null && destination.next_at <= this.now()) this.store.update(destination.id, { next_at: Math.floor(this.now() + this.random() * 30_000) });
    this.scheduleTimer();
  }
  private scheduleTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer); if (this.closing || !this.store.writer || !this.started) return;
    const due = this.store.list().filter((destination) => destination.enabled && destination.next_at !== null && !['needs-auth', 'adapter-unavailable'].includes(destination.state));
    if (due.length === 0) return;
    const next = Math.min(...due.map((destination) => destination.next_at ?? this.now()));
    this.timer = setTimeout(() => { void this.tick().catch(() => { this.scheduleTimer(); }); }, Math.max(1, Math.min(30_000, next - this.now()))); this.timer.unref();
  }
  async tick(): Promise<void> {
    if (this.closing || !this.store.writer) return;
    const due = this.store.list().filter((destination) => destination.enabled && destination.next_at !== null && destination.next_at <= this.now());
    if (due.length > 0) await this.scan();
    for (let i = 0; i < due.length; i += 2) await Promise.all(due.slice(i, i + 2).map((destination) => this.deliver(destination.id)));
    this.scheduleTimer();
  }
  async close(): Promise<void> {
    if (this.closing) return; this.closing = true; if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.continuationTimer !== undefined) clearTimeout(this.continuationTimer);
    if (this.electionTimer !== undefined) clearTimeout(this.electionTimer);
    for (const controller of this.controllers.values()) controller.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.flights.values(), ...this.protocolFlights, this.scanFlight, this.recoveryFlight]), new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); })]); if (timer !== undefined) clearTimeout(timer);
    this.store.close();
  }
}
function safeCategory(result: UsageExportAdapterResult): string | null { return result.errorCategory === undefined ? null : USAGE_EXPORT_ERROR_CATEGORIES.includes(result.errorCategory) ? result.errorCategory : 'generic'; }
function consentTargetEqual(a: UsageExportDestination, b: UsageExportDestination): boolean {
  if (a.target.kind === 'script' && b.target.kind === 'script') return a.target.command === b.target.command;
  if (a.target.kind === 'webhook' && b.target.kind === 'webhook') return a.target.endpoint === b.target.endpoint && a.target.authentication === b.target.authentication && digest(a.target.private_grant) === digest(b.target.private_grant);
  return digest(a.target) === digest(b.target);
}
function scopeWithin(next: UsageExportScope, previous: UsageExportScope): boolean { return next.start_at >= previous.start_at && (previous.end_at === null || (next.end_at !== null && next.end_at <= previous.end_at)) && (!next.include_ephemeral || previous.include_ephemeral) && previous.excluded_workspace_ids.every((id) => next.excluded_workspace_ids.includes(id)); }
