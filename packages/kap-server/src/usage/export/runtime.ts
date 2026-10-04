import { join } from 'node:path';
import { IBootstrapService, registerFlagDefinition, type Scope } from '@kiki/agent-core-v2';
import { IModelPricingService } from '../../pricing/modelPricingService';
import { UsageAggregationService } from '../usageAggregationService';
import type { UsageExportAdapter } from './adapter';
import { UsageExportSecretStore } from './secrets';
import { UsageExportService } from './service';
import { UsageExportStore } from './store';
import { createWebhookUsageAdapter } from './webhook';
import { createVibeUsageAdapter } from './vibe';
import { createScriptUsageAdapter } from './script';

registerFlagDefinition({ id: 'usage_export', title: 'content-free usage export', env: 'KIKI_EXPERIMENTAL_USAGE_EXPORT', surface: 'core', default: false, description: 'Content-free usage export with explicit per-destination consent.' });
export class UsageExportRuntime {
  readonly service: UsageExportService;
  constructor(core: Scope, homeDir: string) {
    const store = new UsageExportStore(join(homeDir, 'usage-export', 'export.sqlite'));
    const credentialsHome = core.accessor.get(IBootstrapService).credentialsHomeDir;
    if (store.writer) store.installationKey();
    const secrets = new UsageExportSecretStore(credentialsHome, () => store.installationKey());
    this.service = new UsageExportService(store, new UsageAggregationService(core, Date.now, { cacheMaxBytes: 4 * 1024 * 1024, cacheMaxRecords: 5_000, cacheMaxEntries: 20 }), core.accessor.get(IModelPricingService), secrets, [createWebhookUsageAdapter(), createVibeUsageAdapter(), createScriptUsageAdapter()], { sourceHome: homeDir });
  }
  registerAdapter(adapter: UsageExportAdapter): void { this.service.registerAdapter(adapter); }
  start(): void { this.service.start(); }
  close(): Promise<void> { return this.service.close(); }
}
