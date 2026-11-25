import type { ProviderQuotaMeter, ProviderQuotaSnapshot, ProviderQuotaSource } from '@kiki/protocol';

export interface QuotaTarget {
  id: string; label: string; kind: ProviderQuotaSource['kind']; providerId: string; accountLabel: string;
  revision: string; active: boolean; supported: boolean; unsupportedReason?: string;
  auth: ProviderQuotaSource['auth']; source: ProviderQuotaSource['source'];
  fetch(signal: AbortSignal): Promise<ProviderQuotaMeter[]>;
}
export interface QuotaPreferences {
  read(): Promise<Record<string, boolean>>;
  update(id: string, enabled: boolean): Promise<void>;
}
export class QuotaFailure extends Error {
  readonly status?: number;
  readonly partialMeters?: ProviderQuotaMeter[];
  constructor(
    readonly reason: 'auth_required' | 'invalid_response' | 'request_failed' | 'rate_limited',
    options?: { readonly status?: number; readonly partialMeters?: ProviderQuotaMeter[] },
  ) {
    super(reason);
    this.status = options?.status;
    this.partialMeters = options?.partialMeters;
  }
}
interface CacheEntry { revision: string; checked: number; dataAt?: number; meters: ProviderQuotaMeter[]; reason?: string }
const TTL = 5 * 60_000;
const RETRY = 60_000;
export class ProviderQuotaService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly flights = new Map<string, { readonly revision: string; readonly promise: Promise<void> }>();
  private readonly controllers = new Map<string, { readonly revision: string; readonly controller: AbortController }>();
  close(): void { for (const entry of this.controllers.values()) entry.controller.abort(); }
  constructor(private readonly targets: () => Promise<QuotaTarget[]>, private readonly preferences: QuotaPreferences, private readonly now: () => number = Date.now) {}

  async snapshot(): Promise<ProviderQuotaSnapshot> {
    const targets = await this.targets(); const enabled = await this.preferences.read(); const now = this.now();
    const revisions = new Map(targets.map((target) => [target.id, target.revision]));
    for (const id of this.cache.keys()) if (!revisions.has(id)) this.cache.delete(id);
    for (const [id, entry] of [...this.controllers.entries()]) {
      const currentRevision = revisions.get(id);
      if (currentRevision === undefined || currentRevision !== entry.revision) {
        entry.controller.abort();
        this.controllers.delete(id);
        if (this.flights.get(id)?.revision === entry.revision) this.flights.delete(id);
      }
    }
    return { schema_version: '1', generated_at: new Date(now).toISOString(), sources: targets.map((target) => this.view(target, enabled, now)) };
  }
  async setEnabled(id: string, enabled: boolean): Promise<ProviderQuotaSnapshot> {
    if (!(await this.targets()).some((target) => target.id === id)) throw new Error('quota_source_not_found');
    await this.preferences.update(id, enabled);
    this.controllers.get(id)?.controller.abort();
    this.controllers.delete(id);
    this.flights.delete(id);
    this.cache.delete(id);
    return this.snapshot();
  }
  async refresh(id: string): Promise<ProviderQuotaSnapshot> {
    const target = (await this.targets()).find((candidate) => candidate.id === id);
    if (!target) throw new Error('quota_source_not_found');
    const enabled = await this.preferences.read();
    if (!target.active || enabled[id] === false || !target.supported) return this.snapshot();
    const existingFlight = this.flights.get(id);
    if (existingFlight !== undefined && existingFlight.revision === target.revision) {
      await existingFlight.promise;
      return this.snapshot();
    }
    if (existingFlight !== undefined) {
      this.controllers.get(id)?.controller.abort();
      this.controllers.delete(id);
      this.flights.delete(id);
    }
    const cached = this.cache.get(id);
    if (cached?.revision === target.revision && this.now() < cached.checked + RETRY) return this.snapshot();
    const controller = new AbortController();
    this.controllers.set(id, { revision: target.revision, controller });
    const work = this.fetchTarget(target, controller.signal);
    this.flights.set(id, { revision: target.revision, promise: work });
    try { await work; } finally {
      if (this.flights.get(id)?.promise === work) this.flights.delete(id);
      if (this.controllers.get(id)?.controller === controller) this.controllers.delete(id);
    }
    return this.snapshot();
  }
  private async fetchTarget(target: QuotaTarget, signal: AbortSignal): Promise<void> {
    let meters: ProviderQuotaMeter[] = []; let reason: string | undefined; let partialMeters: ProviderQuotaMeter[] | undefined;
    try {
      meters = await target.fetch(signal);
      if (meters.length === 0) reason = 'no_data';
    } catch (error) {
      if (error instanceof QuotaFailure) {
        reason = error.reason;
        partialMeters = error.partialMeters;
      } else {
        reason = 'request_failed';
      }
    }
    const latest = (await this.targets()).find((candidate) => candidate.id === target.id);
    if (signal.aborted || !latest || latest.revision !== target.revision || !latest.active || (await this.preferences.read())[target.id] === false) return;
    const previous = this.cache.get(target.id);
    const keep = reason !== undefined && reason !== 'auth_required' && reason !== 'no_data' && previous?.revision === target.revision;
    let nextMeters = meters;
    let nextDataAt: number | undefined;
    if (reason === undefined) {
      nextDataAt = this.now();
    } else if (keep && partialMeters !== undefined && partialMeters.length > 0) {
      const updatedById = new Map(partialMeters.map((meter) => [meter.id, meter]));
      const merged = previous.meters.map((meter) => updatedById.get(meter.id) ?? meter);
      for (const meter of partialMeters) {
        if (!merged.some((existing) => existing.id === meter.id)) merged.push(meter);
      }
      nextMeters = merged;
      nextDataAt = previous.dataAt;
    } else if (keep) {
      nextMeters = previous.meters;
      nextDataAt = previous.dataAt;
    } else if (partialMeters !== undefined && partialMeters.length > 0) {
      nextMeters = partialMeters;
      nextDataAt = this.now();
    }
    this.cache.set(target.id, { revision: target.revision, checked: this.now(), dataAt: nextDataAt, meters: nextMeters, reason });
  }
  private view(target: QuotaTarget, preferences: Record<string, boolean>, now: number): ProviderQuotaSource {
    const enabled = target.active && preferences[target.id] !== false;
    const cached = this.cache.get(target.id); const entry = cached?.revision === target.revision ? cached : undefined;
    const expired = entry?.dataAt !== undefined && (now >= entry.dataAt + TTL || entry.meters.some((meter) => meter.window?.reset_at !== undefined && Date.parse(meter.window.reset_at) <= now));
    const partial = entry?.meters.some((meter) => meter.status !== undefined && meter.status !== 'ready') ?? false;
    const anyReadable = entry?.meters.some((meter) => meter.remaining !== null || meter.used !== null || meter.limit !== null) ?? false;
    let status: ProviderQuotaSource['status'] = 'unknown';
    if (!enabled) status = 'off';
    else if (!target.supported) status = 'unsupported';
    else if (entry?.reason === 'auth_required') status = 'auth_required';
    else if (entry?.dataAt !== undefined && (expired || entry.reason || partial && anyReadable)) status = 'stale';
    else if (entry?.reason === 'no_data') status = 'unknown';
    else if (entry?.reason || partial && !anyReadable && entry?.meters.some((meter) => meter.status === 'error')) status = 'error';
    else if (!(partial && !anyReadable) && entry?.dataAt !== undefined) status = 'ready';
    const reason = status === 'unsupported' ? target.unsupportedReason ?? 'no_official_quota_api' : status === 'off' ? 'disabled' : entry?.reason ?? (expired ? 'cache_expired' : partial ? 'partial_data' : entry ? undefined : 'not_refreshed');
    const messages: Record<string, string> = { disabled: '此来源已关闭，不会发起额度请求。', no_official_quota_api: '此来源暂无可用的官方额度接口；本地消耗不代表厂商余额。', not_refreshed: '尚未查询，点击刷新获取官方额度。', no_data: '官方接口未返回可读额度；不代表剩余为零。', cache_expired: '这是上次查询结果，请刷新确认当前额度。', partial_data: '部分额度表项状态异常，详见各表项说明。', auth_required: '登录或凭据已失效，请在对应来源重新连接后刷新。', invalid_response: '官方接口响应不符合已知格式，请稍后重试。', request_failed: '额度查询失败，请稍后重试。', rate_limited: '官方接口暂时限流，请稍后重试。' };
    return { id: target.id, label: target.label, kind: target.kind, provider_id: target.providerId, account_label: target.accountLabel,
      enabled, supported: target.supported, status, reason, message: reason ? messages[reason] ?? reason : undefined,
      revision: target.revision,
      checked_at: entry ? new Date(entry.checked).toISOString() : undefined, data_as_of: entry?.dataAt !== undefined ? new Date(entry.dataAt).toISOString() : undefined,
      refresh_after: entry ? new Date(entry.checked + RETRY).toISOString() : undefined, stale_at: entry?.dataAt !== undefined ? new Date(entry.dataAt + TTL).toISOString() : undefined,
      refreshing: this.flights.get(target.id)?.revision === target.revision, refresh_mode: 'explicit', auth: target.auth, source: target.source, meters: enabled && target.supported ? entry?.meters ?? [] : [] };
  }
}
