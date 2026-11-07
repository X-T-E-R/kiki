import { HARNESS_QUOTA_MIN_REFRESH_MS, type HarnessQuotaReading, type PluginHarnessQuotaSnapshot } from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { Service } from '#/_base/di/service';
import { IPluginHostService } from './pluginHostService';

export class HarnessQuotaCache {
  private readonly entries = new Map<string, { readonly at: number; readonly readings: readonly HarnessQuotaReading[]; readonly error?: string }>();
  private readonly inflight = new Map<string, Promise<readonly HarnessQuotaReading[]>>();

  constructor(private readonly now: () => number = Date.now) {}

  snapshots(definitions: readonly PluginHarnessQuotaSnapshot[]): { readonly sources: readonly PluginHarnessQuotaSnapshot[] } {
    return { sources: definitions.map((definition) => {
      const hit = this.entries.get(definition.id);
      const fresh = hit !== undefined && hit.error === undefined;
      return { ...definition, engineIds: [...definition.engineIds], readAt: fresh ? new Date(hit.at).toISOString() : undefined, readings: fresh ? [...hit.readings] : undefined };
    }) };
  }

  async read(sourceId: string, intervalMs: number, load: () => Promise<readonly HarnessQuotaReading[]>): Promise<readonly HarnessQuotaReading[]> {
    const interval = Math.max(HARNESS_QUOTA_MIN_REFRESH_MS, Number.isFinite(intervalMs) ? intervalMs : HARNESS_QUOTA_MIN_REFRESH_MS);
    const hit = this.entries.get(sourceId);
    if (hit !== undefined && this.now() - hit.at < interval) {
      if (hit.error !== undefined) throw new Error(hit.error);
      return hit.readings;
    }
    const pending = this.inflight.get(sourceId);
    if (pending !== undefined) return pending;
    const flight = Promise.resolve().then(load).then((readings) => {
      this.entries.set(sourceId, { at: this.now(), readings });
      return readings;
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.entries.set(sourceId, { at: this.now(), readings: [], error: message });
      throw error instanceof Error ? error : new Error(message);
    }).finally(() => {
      if (this.inflight.get(sourceId) === flight) this.inflight.delete(sourceId);
    });
    this.inflight.set(sourceId, flight);
    return flight;
  }
}

export interface IHarnessQuotaService {
  readonly _serviceBrand: undefined;
  definitions(): Promise<readonly PluginHarnessQuotaSnapshot[]>;
  cached(): Promise<{ readonly sources: readonly PluginHarnessQuotaSnapshot[] }>;
  read(sourceId: string, signal?: AbortSignal): Promise<readonly HarnessQuotaReading[]>;
}

export const IHarnessQuotaService = createDecorator<IHarnessQuotaService>('harnessQuotaService');

export class HarnessQuotaService extends Service implements IHarnessQuotaService {
  declare readonly _serviceBrand: undefined;
  private readonly cache = new HarnessQuotaCache();

  constructor(@IPluginHostService private readonly hosts: IPluginHostService) {
    super();
    this.hosts.attachQuotaCache(() => this.cached());
  }

  async definitions(): Promise<readonly PluginHarnessQuotaSnapshot[]> {
    const sources = await this.hosts.listHarnessQuotaSources();
    return sources.map((source) => ({ ...source, engineIds: [...source.engineIds], readings: undefined }));
  }

  async cached(): Promise<{ readonly sources: readonly PluginHarnessQuotaSnapshot[] }> {
    return this.cache.snapshots(await this.definitions());
  }

  async read(sourceId: string, signal?: AbortSignal): Promise<readonly HarnessQuotaReading[]> {
    const definition = (await this.hosts.listHarnessQuotaSources()).find((source) => source.id === sourceId);
    if (definition === undefined) throw new Error(`Unknown harness quota source ${sourceId}`);
    signal?.throwIfAborted();
    return this.cache.read(sourceId, definition.minRefreshIntervalMs, () => this.hosts.readHarnessQuota(sourceId, signal ?? AbortSignal.timeout(30_000)));
  }
}

registerScopedService(LifecycleScope.App, IHarnessQuotaService, HarnessQuotaService, ScopeActivation.OnDemand, 'plugin');
