import { join } from 'pathe';

import { IBootstrapService } from '#/app/bootstrap/bootstrap';

import { MiniDbMailboxBackend } from './miniDbMailboxBackend';

export { MiniDbMailboxBackend } from './miniDbMailboxBackend';

export class MiniDbThreadMailboxStore {
  private readonly backend: MiniDbMailboxBackend;

  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    this.backend = new MiniDbMailboxBackend(join(bootstrap.storeDir, 'thread-mailbox-v1'));
  }

  acceptMessage: MiniDbMailboxBackend['acceptMessage'] = (input) => this.backend.acceptMessage(input);
  beginDelivery: MiniDbMailboxBackend['beginDelivery'] = (messageId) =>
    this.backend.beginDelivery(messageId);
  acknowledgeDelivery: MiniDbMailboxBackend['acknowledgeDelivery'] = (messageId, attemptId) =>
    this.backend.acknowledgeDelivery(messageId, attemptId);
  markUndeliverable: MiniDbMailboxBackend['markUndeliverable'] = (messageId, attemptId, reason) =>
    this.backend.markUndeliverable(messageId, attemptId, reason);
  listPendingDeliveries: MiniDbMailboxBackend['listPendingDeliveries'] = () =>
    this.backend.listPendingDeliveries();
  appendActivity: MiniDbMailboxBackend['appendActivity'] = (input) =>
    this.backend.appendActivity(input);
  readActivity: MiniDbMailboxBackend['readActivity'] = (target, afterSeq, limit) =>
    this.backend.readActivity(target, afterSeq, limit);
  getWorkspaceOverride: MiniDbMailboxBackend['getWorkspaceOverride'] = (workspaceId) =>
    this.backend.getWorkspaceOverride(workspaceId);
  setWorkspaceOverride: MiniDbMailboxBackend['setWorkspaceOverride'] = (workspaceId, enabled) =>
    this.backend.setWorkspaceOverride(workspaceId, enabled);
  clearWorkspaceOverride: MiniDbMailboxBackend['clearWorkspaceOverride'] = (workspaceId) =>
    this.backend.clearWorkspaceOverride(workspaceId);
}
