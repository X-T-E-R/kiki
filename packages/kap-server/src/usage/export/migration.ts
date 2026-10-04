import { legacyHandoffReceiptSchema, usageExportHandoffSchema, usageExportReceiptSchema, type LegacyHandoffReceipt, type UsageExportHandoff, type UsageExportScope } from '@kiki/protocol';

export { collectorHandoffIdentitySchema, legacyHandoffReceiptSchema, usageExportHandoffSchema, type LegacyHandoffReceipt, type UsageExportHandoff } from '@kiki/protocol';

export function planUsageExportHandoff(input: {
  data_home_fingerprint: string; account_fingerprint: string; stream_id: string; now: number; cutoff_at?: number;
}): UsageExportHandoff {
  const cutoff_at = input.cutoff_at ?? (Math.floor(input.now / 1_800_000) + 2) * 1_800_000;
  if (!Number.isSafeInteger(input.now) || cutoff_at <= input.now) throw new Error('handoff_future_boundary_required');
  return usageExportHandoffSchema.parse({
    schema_version: 'kiki.usage.handoff.v1', data_home_fingerprint: input.data_home_fingerprint,
    account_fingerprint: input.account_fingerprint, cutoff_at, namespace: `kiki-${input.stream_id}`,
    phase: 'prepared', legacy_receipt: null, native_receipt: null, previous_cutoff_at: null,
  });
}

export function armUsageExportHandoff(state: UsageExportHandoff, proof: {
  now: number; cutoff_at: number; data_home_fingerprint: string; account_fingerprint: string;
  donor_cutoff_persisted: boolean; native_projection_complete: boolean; native_test_delivered: boolean;
}): UsageExportHandoff {
  const current = usageExportHandoffSchema.parse(state);
  if (current.phase !== 'prepared' || proof.now >= current.cutoff_at || proof.cutoff_at !== current.cutoff_at
    || proof.data_home_fingerprint !== current.data_home_fingerprint || proof.account_fingerprint !== current.account_fingerprint
    || !proof.donor_cutoff_persisted || !proof.native_projection_complete || !proof.native_test_delivered) throw new Error('handoff_readiness_unproven');
  return { ...current, phase: 'armed' };
}

export function recordLegacyHandoffReceipt(state: UsageExportHandoff, receipt: LegacyHandoffReceipt): UsageExportHandoff {
  const current = usageExportHandoffSchema.parse(state);
  const proof = legacyHandoffReceiptSchema.parse(receipt);
  if (!['armed', 'awaiting-native'].includes(current.phase) || proof.cutoff_at !== current.cutoff_at || proof.completed_at < current.cutoff_at) throw new Error('handoff_legacy_cutoff_unproven');
  return { ...current, legacy_receipt: proof, phase: current.native_receipt === null ? 'awaiting-native' : 'completed' };
}

export function confirmNativeHandoff(state: UsageExportHandoff, input: {
  receipt: unknown; completed_at: number; namespace: string; earliest_bucket_at: number;
}): UsageExportHandoff {
  const current = usageExportHandoffSchema.parse(state);
  const receipt = usageExportReceiptSchema.parse(input.receipt);
  if (!['armed', 'awaiting-native'].includes(current.phase) || input.completed_at < current.cutoff_at
    || input.namespace !== current.namespace || input.earliest_bucket_at < current.cutoff_at || receipt.items.length === 0
    || receipt.items.some(item => !['applied', 'duplicate'].includes(item.status) || `kiki-${item.stream_id}` !== current.namespace)) throw new Error('handoff_native_receipt_unconfirmed');
  return { ...current, native_receipt: receipt, phase: current.legacy_receipt === null ? 'armed' : 'completed' };
}

export function nativeHandoffScope(state: UsageExportHandoff, scope: UsageExportScope): UsageExportScope | null {
  const current = usageExportHandoffSchema.parse(state);
  if (current.phase === 'prepared') return null;
  const start_at = Math.max(scope.start_at, current.phase === 'rollback-prepared' ? current.previous_cutoff_at ?? current.cutoff_at : current.cutoff_at);
  const end_at = current.phase === 'rollback-prepared' ? Math.min(scope.end_at ?? current.cutoff_at, current.cutoff_at) : scope.end_at;
  if (end_at !== null && end_at <= start_at) throw new Error('handoff_scope_empty');
  return { ...scope, start_at, end_at };
}

export function planUsageExportRollback(state: UsageExportHandoff, now: number, cutoff_at: number): UsageExportHandoff {
  const current = usageExportHandoffSchema.parse(state);
  if (!['armed', 'awaiting-native', 'completed'].includes(current.phase) || cutoff_at <= now || cutoff_at <= current.cutoff_at) throw new Error('handoff_rollback_new_boundary_required');
  return usageExportHandoffSchema.parse({ ...current, phase: 'rollback-prepared', previous_cutoff_at: current.cutoff_at, cutoff_at });
}
