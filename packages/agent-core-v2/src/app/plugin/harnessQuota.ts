import {
  HARNESS_QUOTA_MIN_REFRESH_MS,
  HARNESS_QUOTA_UNAVAILABLE_MESSAGE,
  type HarnessQuotaActionId,
  type HarnessQuotaActionResponse,
  type HarnessQuotaReading,
  type PluginHarnessQuotaSnapshot,
} from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { abortable, isAbortError } from '#/_base/utils/abort';
import { LifecycleScope } from '#/app/scopes';
import { Service } from '#/_base/di/service';
import { Error2, ErrorCodes } from '#/errors';
import { IAntigravityService } from '#/app/agentExecutor/antigravityService';
import { OFFICIAL_ANTIGRAVITY_QUOTA_SOURCE_ID } from '#/app/agentExecutor/antigravityQuota';
import { IPluginHostService } from './pluginHostService';

const OFFICIAL_ANTIGRAVITY_QUOTA_DEFINITION: PluginHarnessQuotaSnapshot = {
  id: OFFICIAL_ANTIGRAVITY_QUOTA_SOURCE_ID,
  label: 'Google Antigravity (Official)',
  engineIds: ['antigravity-acp'],
  minRefreshIntervalMs: 300_000,
};

interface QuotaFlight {
  readonly controller: AbortController;
  promise: Promise<readonly HarnessQuotaReading[]>;
  waiters: number;
  settled: boolean;
}

function effectiveInterval(intervalMs: number): number {
  return Math.max(HARNESS_QUOTA_MIN_REFRESH_MS, Number.isFinite(intervalMs) ? intervalMs : HARNESS_QUOTA_MIN_REFRESH_MS);
}

export class HarnessQuotaCache {
  private readonly entries = new Map<string, { readonly at: number; readonly readings: readonly HarnessQuotaReading[]; readonly error?: string; readonly lastSuccessAt?: number }>();
  private readonly inflight = new Map<string, QuotaFlight>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  snapshots(definitions: readonly PluginHarnessQuotaSnapshot[]): { readonly sources: readonly PluginHarnessQuotaSnapshot[] } {
    const current = this.now();
    return { sources: definitions.map((definition) => {
      const hit = this.entries.get(definition.id);
      const interval = effectiveInterval(definition.minRefreshIntervalMs);
      const fresh = hit !== undefined && hit.error === undefined && current - hit.at < interval;
      const readAtMs = hit?.error === undefined ? hit?.at : hit?.lastSuccessAt;
      return {
        ...definition,
        engineIds: [...definition.engineIds],
        actions: definition.actions === undefined ? undefined : definition.actions.map((item) => ({ ...item })),
        readAt: readAtMs !== undefined ? new Date(readAtMs).toISOString() : undefined,
        readings: fresh ? [...hit.readings] : undefined,
        error: hit?.error !== undefined ? HARNESS_QUOTA_UNAVAILABLE_MESSAGE : undefined,
      };
    }) };
  }

  async read(
    sourceId: string,
    intervalMs: number,
    load: (signal: AbortSignal) => Promise<readonly HarnessQuotaReading[]>,
    signal?: AbortSignal,
  ): Promise<readonly HarnessQuotaReading[]> {
    signal?.throwIfAborted();
    const interval = effectiveInterval(intervalMs);
    const hit = this.entries.get(sourceId);
    if (hit !== undefined && this.now() - hit.at < interval) {
      if (hit.error !== undefined) throw new Error(hit.error);
      return hit.readings;
    }
    let flight = this.inflight.get(sourceId);
    if (flight === undefined || flight.controller.signal.aborted) {
      const generation = this.generations.get(sourceId) ?? 0;
      const controller = new AbortController();
      const created: QuotaFlight = {
        controller,
        promise: Promise.resolve([]),
        waiters: 0,
        settled: false,
      };
      created.promise = Promise.resolve().then(() => load(controller.signal)).then((readings) => {
        if ((this.generations.get(sourceId) ?? 0) === generation) {
          const at = this.now();
          this.entries.set(sourceId, { at, readings, lastSuccessAt: at });
        }
        return readings;
      }, (error: unknown) => {
        const cancelled = controller.signal.aborted || isAbortError(error);
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = rawMessage.trim() || HARNESS_QUOTA_UNAVAILABLE_MESSAGE;
        if (!cancelled && (this.generations.get(sourceId) ?? 0) === generation) {
          const previous = this.entries.get(sourceId);
          this.entries.set(sourceId, { at: this.now(), readings: [], error: message, lastSuccessAt: previous?.lastSuccessAt });
        }
        throw error instanceof Error && error.message.trim() !== '' ? error : new Error(message);
      }).finally(() => {
        created.settled = true;
        if (this.inflight.get(sourceId) === created) this.inflight.delete(sourceId);
      });
      flight = created;
      this.inflight.set(sourceId, flight);
    }
    flight.waiters += 1;
    try {
      return signal === undefined ? await flight.promise : await abortable(flight.promise, signal);
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort(signal?.reason);
      }
    }
  }
  invalidate(sourceId: string): void {
    this.generations.set(sourceId, (this.generations.get(sourceId) ?? 0) + 1);
    this.entries.delete(sourceId);
    this.inflight.delete(sourceId);
  }
}

export interface IHarnessQuotaService {
  readonly _serviceBrand: undefined;
  definitions(): Promise<readonly PluginHarnessQuotaSnapshot[]>;
  cached(): Promise<{ readonly sources: readonly PluginHarnessQuotaSnapshot[] }>;
  read(sourceId: string, signal?: AbortSignal): Promise<readonly HarnessQuotaReading[]>;
  performAction?(
    sourceId: string,
    action: HarnessQuotaActionId,
    accountId?: string,
    signal?: AbortSignal,
  ): Promise<HarnessQuotaActionResponse>;
}

export const IHarnessQuotaService = createDecorator<IHarnessQuotaService>('harnessQuotaService');

export class HarnessQuotaService extends Service implements IHarnessQuotaService {
  declare readonly _serviceBrand: undefined;
  private readonly cache = new HarnessQuotaCache();

  constructor(
    @IPluginHostService private readonly hosts: IPluginHostService,
    @IAntigravityService private readonly antigravity?: IAntigravityService,
  ) {
    super();
    this.hosts.attachQuotaCache(() => this.cached());
  }

  async definitions(): Promise<readonly PluginHarnessQuotaSnapshot[]> {
    const sources = await this.hosts.listHarnessQuotaSources();
    const projected: PluginHarnessQuotaSnapshot[] = sources.map((source) => ({
      ...source,
      engineIds: [...source.engineIds],
      actions: source.actions === undefined ? undefined : source.actions.map((item) => ({ ...item })),
      readings: undefined,
    }));
    if (this.antigravity !== undefined && !projected.some((source) => source.id === OFFICIAL_ANTIGRAVITY_QUOTA_SOURCE_ID)) {
      projected.push({
        ...OFFICIAL_ANTIGRAVITY_QUOTA_DEFINITION,
        engineIds: [...OFFICIAL_ANTIGRAVITY_QUOTA_DEFINITION.engineIds],
      });
    }
    return projected;
  }

  async cached(): Promise<{ readonly sources: readonly PluginHarnessQuotaSnapshot[] }> {
    return this.cache.snapshots(await this.definitions());
  }

  async read(sourceId: string, signal?: AbortSignal): Promise<readonly HarnessQuotaReading[]> {
    if (sourceId === OFFICIAL_ANTIGRAVITY_QUOTA_SOURCE_ID && this.antigravity !== undefined) {
      signal?.throwIfAborted();
      return this.cache.read(
        sourceId,
        OFFICIAL_ANTIGRAVITY_QUOTA_DEFINITION.minRefreshIntervalMs,
        (flightSignal) => this.antigravity!.readAllInstanceQuotas(
          AbortSignal.any([flightSignal, AbortSignal.timeout(30_000)]),
        ),
        signal,
      );
    }
    const definition = (await this.hosts.listHarnessQuotaSources()).find((source) => source.id === sourceId);
    if (definition === undefined) throw new Error(`Unknown harness quota source ${sourceId}`);
    signal?.throwIfAborted();
    return this.cache.read(
      sourceId,
      definition.minRefreshIntervalMs,
      (flightSignal) => this.hosts.readHarnessQuota(sourceId, AbortSignal.any([flightSignal, AbortSignal.timeout(30_000)])),
      signal,
    );
  }

  async performAction(
    sourceId: string,
    action: HarnessQuotaActionId,
    accountId?: string,
    signal?: AbortSignal,
  ): Promise<HarnessQuotaActionResponse> {
    if (sourceId === OFFICIAL_ANTIGRAVITY_QUOTA_SOURCE_ID && this.antigravity !== undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `Action ${action} is not declared for harness quota source ${sourceId}`);
    }
    const definition = (await this.hosts.listHarnessQuotaSources()).find((source) => source.id === sourceId);
    if (definition === undefined) {
      throw new Error2(ErrorCodes.PLUGIN_NOT_FOUND, `Unknown harness quota source ${sourceId}`);
    }
    const declared = definition.actions?.find((item) => item.id === action);
    if (declared === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `Action ${action} is not declared for harness quota source ${sourceId}`);
    }
    if (declared.scope === 'account' && !accountId) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `Action ${action} requires account_id`);
    }
    if (typeof this.hosts.performHarnessQuotaAction !== 'function') {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Harness quota actions are not supported by the plugin host');
    }
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(30_000);
    const effective = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const result = await this.hosts.performHarnessQuotaAction(sourceId, action, accountId, effective);
    if (result.ok) this.cache.invalidate(sourceId);
    return result;
  }
}

registerScopedService(LifecycleScope.App, IHarnessQuotaService, HarnessQuotaService, ScopeActivation.OnDemand, 'plugin');
