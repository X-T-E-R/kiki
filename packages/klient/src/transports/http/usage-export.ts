import { usageExportConsentSchema, usageExportDestinationSchema, usageExportHandoffArmSchema, usageExportHandoffSchema, usageExportPreviewSchema, usageExportSaveSchema, usageExportScopeSchema, usageExportStatusSchema, usageExportVibeAuthInputSchema, usageExportVibeAuthSchema } from '@kiki/protocol';
import type { UsageExportFacade } from '../../core/facade/usage-export.js';
import type { HttpRestTransport } from './rest.js';

export function createUsageExportFacade(transport: HttpRestTransport): UsageExportFacade {
  const prefix = '/usage-export';
  const path = (id: string, action: string) => `${prefix}/destinations/${encodeURIComponent(id)}/${action}`;
  return {
    status: async () => usageExportStatusSchema.parse(await transport.json(prefix)),
    saveDraft: async (input) => usageExportDestinationSchema.parse(await transport.json(prefix + '/destinations', { method: 'POST', body: usageExportSaveSchema.parse(input) })),
    beginVibeAuth: async (id, input) => usageExportVibeAuthSchema.parse(await transport.json(path(id, 'auth/begin'), { method: 'POST', body: usageExportVibeAuthInputSchema.parse(input) })),
    pollVibeAuth: async (flowId) => usageExportVibeAuthSchema.parse(await transport.json(`${prefix}/auth/${encodeURIComponent(flowId)}/poll`, { method: 'POST', body: {} })),
    cancelVibeAuth: async (flowId) => usageExportVibeAuthSchema.parse(await transport.json(`${prefix}/auth/${encodeURIComponent(flowId)}/cancel`, { method: 'POST', body: {} })),
    preview: async (id) => usageExportPreviewSchema.parse(await transport.json(path(id, 'preview'))),
    testProtocol: (id) => transport.json(path(id, 'test'), { method: 'POST', body: {} }),
    enable: async (id, input) => usageExportDestinationSchema.parse(await transport.json(path(id, 'enable'), { method: 'POST', body: usageExportConsentSchema.parse(input) })),
    disable: async (id) => usageExportDestinationSchema.parse(await transport.json(path(id, 'disable'), { method: 'POST', body: {} })),
    remove: (id, discardPending) => transport.json(path(id, 'remove'), { method: 'POST', body: { discard_pending: discardPending } }),
    syncNow: async (id) => usageExportStatusSchema.parse(await transport.json(path(id, 'sync'), { method: 'POST', body: {} })),
    backfill: async (id, scope) => usageExportPreviewSchema.parse(await transport.json(path(id, 'backfill'), { method: 'POST', body: usageExportScopeSchema.parse(scope) })),
    diagnostics: async () => usageExportStatusSchema.parse(await transport.json(prefix + '/diagnostics')),
    exportLocal: (id) => transport.json(path(id, 'export')),
    rebuild: async (force) => usageExportStatusSchema.parse(await transport.json(prefix + '/rebuild', { method: 'POST', body: { force } })),
    retry: async (id) => usageExportStatusSchema.parse(await transport.json(path(id, 'retry'), { method: 'POST', body: {} })),
    setQueueCapacity: async (bytes) => usageExportStatusSchema.parse(await transport.json(prefix + '/queue-capacity', { method: 'PUT', body: { bytes } })),
    clearQueue: async (id, acknowledge) => usageExportStatusSchema.parse(await transport.json(path(id, 'clear-queue'), { method: 'POST', body: { acknowledge } })),
    withdraw: async (id, acknowledge) => usageExportStatusSchema.parse(await transport.json(path(id, 'withdraw'), { method: 'POST', body: { acknowledge } })),
    handoff: async (id) => usageExportHandoffSchema.nullable().parse(await transport.json(path(id, 'handoff'))),
    planHandoff: async (id, cutoffAt) => usageExportHandoffSchema.parse(await transport.json(path(id, 'handoff/plan'), { method: 'POST', body: { cutoff_at: cutoffAt } })),
    armHandoff: async (id, input) => usageExportHandoffSchema.parse(await transport.json(path(id, 'handoff/arm'), { method: 'POST', body: usageExportHandoffArmSchema.parse(input) })),
    refreshHandoff: async (id) => usageExportHandoffSchema.nullable().parse(await transport.json(path(id, 'handoff/refresh'), { method: 'POST', body: {} })),
    rollbackHandoff: async (id, cutoffAt, acknowledge) => usageExportHandoffSchema.parse(await transport.json(path(id, 'handoff/rollback'), { method: 'POST', body: { cutoff_at: cutoffAt, acknowledge } })),
  };
}
