import type {
  EncryptedCredentialEnvelope,
  ProjectIdentity,
  SkillRootSyncPlan,
  SyncBundle,
  SyncBundleExportInput,
  SyncBundleImportInput,
  SyncBundleImportReceipt,
  SyncCredentialMergeInput,
  SyncCredentialMergeReceipt,
  SyncCredentialSealInput,
  SyncPeerTransferInput,
  SyncProjectIdentityResolveInput,
} from '@kiki/protocol';
import type { HttpRestRequestOptions } from './http-rest.js';

export interface SyncFacade {
  getDevicePublicKey(): Promise<{ readonly recipient: string }>;
  sealCredentials(input: SyncCredentialSealInput): Promise<{
    readonly envelopes: readonly EncryptedCredentialEnvelope[];
    readonly skipped: readonly { readonly credentialId: string; readonly reason: string }[];
  }>;
  mergeCredentials(input: SyncCredentialMergeInput): Promise<SyncCredentialMergeReceipt>;
  resolveProjectIdentity(input: SyncProjectIdentityResolveInput): Promise<ProjectIdentity>;
  exportPortableConfig(): Promise<Record<string, unknown>>;
  planSkillsSync(workDir?: string): Promise<readonly SkillRootSyncPlan[]>;
  exportBundle(input?: Partial<SyncBundleExportInput>): Promise<SyncBundle>;
  importBundle(bundle: SyncBundleImportInput): Promise<SyncBundleImportReceipt>;
  pushToPeer(peerId: string, input?: Partial<SyncPeerTransferInput>, options?: HttpRestRequestOptions): Promise<SyncBundleImportReceipt>;
  pullFromPeer(peerId: string, input?: Partial<SyncPeerTransferInput>, options?: HttpRestRequestOptions): Promise<SyncBundleImportReceipt>;
}
