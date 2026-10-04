import type { UsageExportConsent, UsageExportDestination, UsageExportHandoff, UsageExportHandoffArm, UsageExportItem, UsageExportPreview, UsageExportSave, UsageExportScope, UsageExportStatus, UsageExportVibeAuth, UsageExportVibeAuthInput } from '@kiki/protocol';

export interface UsageExportFacade {
  status(): Promise<UsageExportStatus>;
  saveDraft(input: UsageExportSave): Promise<UsageExportDestination>;
  beginVibeAuth(id: string, input: UsageExportVibeAuthInput): Promise<UsageExportVibeAuth>;
  pollVibeAuth(flowId: string): Promise<UsageExportVibeAuth>;
  cancelVibeAuth(flowId: string): Promise<UsageExportVibeAuth>;
  preview(id: string): Promise<UsageExportPreview>;
  testProtocol(id: string): Promise<{ outcome: 'delivered' | 'retry' | 'needs-auth' | 'too-large' | 'invalid' | 'remote-diverged'; error_category: string | null }>;
  enable(id: string, consent: UsageExportConsent): Promise<UsageExportDestination>;
  disable(id: string): Promise<UsageExportDestination>;
  remove(id: string, discardPending: boolean): Promise<{ removed: true }>;
  syncNow(id: string): Promise<UsageExportStatus>;
  backfill(id: string, scope: UsageExportScope): Promise<UsageExportPreview>;
  diagnostics(): Promise<UsageExportStatus>;
  exportLocal(id: string): Promise<{ schema_version: 'kiki.usage.local-export.v1'; items: UsageExportItem[] }>;
  rebuild(force: boolean): Promise<UsageExportStatus>;
  retry(id: string): Promise<UsageExportStatus>;
  setQueueCapacity(bytes: number): Promise<UsageExportStatus>;
  clearQueue(id: string, acknowledge: true): Promise<UsageExportStatus>;
  withdraw(id: string, acknowledge: true): Promise<UsageExportStatus>;
  handoff(id: string): Promise<UsageExportHandoff | null>;
  planHandoff(id: string, cutoffAt?: number): Promise<UsageExportHandoff>;
  armHandoff(id: string, input: UsageExportHandoffArm): Promise<UsageExportHandoff>;
  refreshHandoff(id: string): Promise<UsageExportHandoff | null>;
  rollbackHandoff(id: string, cutoffAt: number, acknowledge: true): Promise<UsageExportHandoff>;
}
