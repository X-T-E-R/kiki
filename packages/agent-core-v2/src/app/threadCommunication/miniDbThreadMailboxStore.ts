/**
 * `threadCommunication` domain — MiniDb-backed `IThreadMailboxStore` implementation.
 *
 * Roots the scope-agnostic mailbox backend under the App store directory.
 * Bound at App scope.
 */

import { join } from 'pathe';

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';

import { MiniDbMailboxBackend } from './miniDbMailboxBackend';
import { IThreadMailboxStore } from './threadMailboxStore';

export { MiniDbMailboxBackend } from './miniDbMailboxBackend';

export class MiniDbThreadMailboxStore implements IThreadMailboxStore {
  declare readonly _serviceBrand: undefined;
  private readonly backend: MiniDbMailboxBackend;

  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    this.backend = new MiniDbMailboxBackend(join(bootstrap.storeDir, 'thread-mailbox-v1'));
  }

  acceptMessage: IThreadMailboxStore['acceptMessage'] = (input) => this.backend.acceptMessage(input);
  beginDelivery: IThreadMailboxStore['beginDelivery'] = (messageId) =>
    this.backend.beginDelivery(messageId);
  acknowledgeDelivery: IThreadMailboxStore['acknowledgeDelivery'] = (messageId, attemptId) =>
    this.backend.acknowledgeDelivery(messageId, attemptId);
  markUndeliverable: IThreadMailboxStore['markUndeliverable'] = (messageId, attemptId, reason) =>
    this.backend.markUndeliverable(messageId, attemptId, reason);
  listPendingDeliveries: IThreadMailboxStore['listPendingDeliveries'] = () =>
    this.backend.listPendingDeliveries();
  appendActivity: IThreadMailboxStore['appendActivity'] = (input) =>
    this.backend.appendActivity(input);
  readActivity: IThreadMailboxStore['readActivity'] = (target, afterSeq, limit) =>
    this.backend.readActivity(target, afterSeq, limit);
  getWorkspaceOverride: IThreadMailboxStore['getWorkspaceOverride'] = (workspaceId) =>
    this.backend.getWorkspaceOverride(workspaceId);
  setWorkspaceOverride: IThreadMailboxStore['setWorkspaceOverride'] = (workspaceId, enabled) =>
    this.backend.setWorkspaceOverride(workspaceId, enabled);
  clearWorkspaceOverride: IThreadMailboxStore['clearWorkspaceOverride'] = (workspaceId) =>
    this.backend.clearWorkspaceOverride(workspaceId);
}

registerScopedService(
  LifecycleScope.App,
  IThreadMailboxStore,
  MiniDbThreadMailboxStore,
  ScopeActivation.OnScopeCreated,
  'threadCommunication',
);