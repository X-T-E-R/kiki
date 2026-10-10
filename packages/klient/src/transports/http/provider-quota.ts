import { providerQuotaEnableSchema, providerQuotaSelectSchema, providerQuotaSnapshotSchema } from '@kiki/protocol';
import type { ProviderQuotaFacade } from '../../core/facade/provider-quota.js';
import type { HttpRestTransport } from './rest.js';

export function createProviderQuotaFacade(transport: HttpRestTransport): ProviderQuotaFacade {
  const prefix = '/usage/provider-quotas';
  return {
    snapshot: async () => providerQuotaSnapshotSchema.parse(await transport.json(prefix)),
    refresh: async (sourceId) => providerQuotaSnapshotSchema.parse(await transport.json(prefix + '/refresh', { method: 'POST', body: providerQuotaSelectSchema.parse({ source_id: sourceId }) })),
    setEnabled: async (sourceId, enabled) => providerQuotaSnapshotSchema.parse(await transport.json(prefix + '/enabled', { method: 'PUT', body: providerQuotaEnableSchema.parse({ source_id: sourceId, enabled }) })),
  };
}
