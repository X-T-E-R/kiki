import type { BridgePolicy, BridgeGrant, BridgeInstall, BridgeLink, BridgeReceipt, BridgeStatus, BridgeTargetInput, LocalBridgePolicy, RemoteConnection } from '@kiki/protocol';
import type { HttpRestRequestOptions } from './http-rest.js';
export interface ThreadBridgesFacade {
  status(options?: HttpRestRequestOptions): Promise<BridgeStatus>;
  approve(input: BridgePolicy, options?: HttpRestRequestOptions): Promise<{ grant: BridgeGrant; credential: string }>;
  registerTarget(input: BridgeTargetInput, options?: HttpRestRequestOptions): Promise<RemoteConnection>;
  provisionLocal(input: LocalBridgePolicy, options?: HttpRestRequestOptions): Promise<BridgeLink>;
  install(input: BridgeInstall, options?: HttpRestRequestOptions): Promise<BridgeLink>;
  setEnabled(direction: 'inbound' | 'outbound', bridgeId: string, enabled: boolean, options?: HttpRestRequestOptions): Promise<BridgeStatus>;
  revoke(direction: 'inbound' | 'outbound', bridgeId: string, options?: HttpRestRequestOptions): Promise<BridgeStatus>;
  receipts(query?: { cursor?: string; limit?: number }, options?: HttpRestRequestOptions): Promise<{ items: BridgeReceipt[]; nextCursor?: string }>;
  retry(options?: HttpRestRequestOptions): Promise<{ items: BridgeReceipt[]; nextCursor?: string }>;
}
