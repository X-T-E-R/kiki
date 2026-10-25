import { IInstantiationService, type Scope } from '@kiki/agent-core-v2';

import { UsageAggregationService } from './usageAggregationService';
import { UsageSourceTracker } from './usageSourceTracker';

const runtimes = new WeakMap<Scope, { service: UsageAggregationService; sources: UsageSourceTracker }>();

export function usageRuntime(core: Scope): { service: UsageAggregationService; sources: UsageSourceTracker } {
  let runtime = runtimes.get(core);
  if (runtime === undefined) {
    const sources = new UsageSourceTracker(core);
    const service = new UsageAggregationService(core, Date.now, {}, sources);
    runtime = { service, sources };
    runtimes.set(core, runtime);
    core.accessor.get(IInstantiationService).onWillDispose(() => {
      service.dispose();
      sources.dispose();
      runtimes.delete(core);
    });
  }
  return runtime;
}
