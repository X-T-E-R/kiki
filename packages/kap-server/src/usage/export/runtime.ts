import { join } from 'node:path';
import { IBootstrapService, IConfigService, type Scope } from '@kiki/agent-core-v2';
import { parseBooleanEnv } from '@kiki/agent-core-v2/_base/utils/env';
import { IModelPricingService } from '../../pricing/modelPricingService';
import { UsageAggregationService } from '../usageAggregationService';
import type { UsageExportAdapter } from './adapter';
import { UsageExportSecretStore } from './secrets';
import { UsageExportService } from './service';
import { UsageExportStore } from './store';
import { createWebhookUsageAdapter } from './webhook';
import { createVibeUsageAdapter } from './vibe';
import { createScriptUsageAdapter } from './script';

export class UsageExportRuntime {
  readonly service: UsageExportService;
  constructor(core: Scope, homeDir: string) {
    const bootstrap = core.accessor.get(IBootstrapService);
    const experimental = core.accessor.get(IConfigService).get<Record<string, boolean>>('experimental');
    const legacyDisabled = (parseBooleanEnv(bootstrap.getEnv('KIKI_EXPERIMENTAL_USAGE_EXPORT')) ?? experimental?.['usage_export']) === false;
    const store = new UsageExportStore(join(homeDir, 'usage-export', 'export.sqlite'), legacyDisabled);
    const credentialsHome = bootstrap.credentialsHomeDir;
    if (store.writer) store.installationKey();
    const secrets = new UsageExportSecretStore(credentialsHome, () => store.installationKey());
    this.service = new UsageExportService(store, new UsageAggregationService(core, Date.now, { cacheMaxBytes: 4 * 1024 * 1024, cacheMaxRecords: 5_000, cacheMaxEntries: 20 }), core.accessor.get(IModelPricingService), secrets, [createWebhookUsageAdapter(), createVibeUsageAdapter(), createScriptUsageAdapter()], { sourceHome: homeDir });
  }
  registerAdapter(adapter: UsageExportAdapter): void { this.service.registerAdapter(adapter); }
  start(): void { this.service.start(); }
  close(): Promise<void> { return this.service.close(); }
}
