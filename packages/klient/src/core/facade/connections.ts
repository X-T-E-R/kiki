import type { ConnectionIdentity, ConnectionAddInput, ConnectionGrant, ConnectionHandshake, InboundStatus, RemoteConnection, SpaceSummary, SshRemoteProfile, SshRemotePlan, SshRemoteStatus, SshConnectionRegisterInput } from '@kiki/protocol';
import type { HttpRestRequestOptions } from './http-rest.js';
export interface ConnectionsFacade {
  list(): Promise<RemoteConnection[]>;
  inbound(): Promise<InboundStatus>;
  setInbound(enabled: boolean): Promise<InboundStatus>;
  invite(input: { source: ConnectionIdentity; label: string; expiresInMs?: number }): Promise<{ grant: ConnectionGrant; invitation: string }>;
  revoke(grantId: string): Promise<InboundStatus>;
  add(input: ConnectionAddInput): Promise<RemoteConnection>;
  remove(connectionId: string): Promise<void>;
  setEnabled(connectionId: string, enabled: boolean): Promise<RemoteConnection>;
  retry(connectionId: string): Promise<RemoteConnection>;
  summary(connectionId: string, options?: HttpRestRequestOptions): Promise<SpaceSummary>;
  handshake(): Promise<ConnectionHandshake>;
  sshPlan(profile: SshRemoteProfile, options?: HttpRestRequestOptions): Promise<SshRemotePlan>;
  sshExecute(planId: string, input: { ensure: boolean }, options?: HttpRestRequestOptions): Promise<SshRemotePlan>;
  sshRegister(input: SshConnectionRegisterInput, options?: HttpRestRequestOptions): Promise<RemoteConnection>;
  sshStatus(): Promise<SshRemoteStatus[]>;
}
