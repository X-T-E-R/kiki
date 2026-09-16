import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ISessionMetadata, type DelegatorRef } from '#/session/sessionMetadata/sessionMetadata';

export const COLLABORATION_TASK_NAME_LABEL = 'collaborationTaskName';
export const COLLABORATION_AGENT_TYPE_LABEL = 'collaborationAgentType';
export const COLLABORATION_LATEST_TASK_LABEL = 'collaborationLatestTaskId';

/** Session-scoped named-delegation reservation registry: coordinates task-name ownership across agent
 *  and external delegators, while durable ownership stays in Session metadata and delegation
 *  documents. */
export interface IAgentCollaborationRegistry {
  readonly _serviceBrand: undefined;
  reserve(taskName: string, owner: DelegatorRef): Promise<boolean>;
  commit(taskName: string, owner: DelegatorRef): void;
  release(taskName: string, owner: DelegatorRef): void;
}

export const IAgentCollaborationRegistry =
  createDecorator<IAgentCollaborationRegistry>('agentCollaborationRegistry');

export class AgentCollaborationRegistry implements IAgentCollaborationRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly pending = new Map<string, string>();

  constructor(@ISessionMetadata private readonly metadata: ISessionMetadata) {}

  async reserve(taskName: string, owner: DelegatorRef): Promise<boolean> {
    await this.metadata.ready;
    if (this.pending.has(taskName)) return false;
    const agents = (await this.metadata.read()).agents ?? {};
    if (this.pending.has(taskName)) return false;
    if (Object.values(agents).some((meta) =>
      meta.labels?.[COLLABORATION_TASK_NAME_LABEL] === taskName ||
      meta.labels?.['externalDelegationTaskName'] === taskName,
    )) {
      return false;
    }
    this.pending.set(taskName, ownerKey(owner));
    return true;
  }

  commit(taskName: string, owner: DelegatorRef): void {
    if (this.pending.get(taskName) === ownerKey(owner)) this.pending.delete(taskName);
  }

  release(taskName: string, owner: DelegatorRef): void {
    if (this.pending.get(taskName) === ownerKey(owner)) this.pending.delete(taskName);
  }
}

function ownerKey(owner: DelegatorRef): string {
  return owner.kind === 'agent' ? `agent:${owner.agentId}` : `external:${owner.delegationId}`;
}

registerScopedService(
  LifecycleScope.Session,
  IAgentCollaborationRegistry,
  AgentCollaborationRegistry,
  ScopeActivation.OnScopeCreated,
  'agentCollaborationRegistry',
);
