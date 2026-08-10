import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

export const COLLABORATION_TASK_NAME_LABEL = 'collaborationTaskName';
export const COLLABORATION_AGENT_TYPE_LABEL = 'collaborationAgentType';
export const COLLABORATION_LATEST_TASK_LABEL = 'collaborationLatestTaskId';

export interface IAgentCollaborationRegistry {
  readonly _serviceBrand: undefined;
  reserve(taskName: string, ownerAgentId: string): Promise<boolean>;
  commit(taskName: string, ownerAgentId: string): void;
  release(taskName: string, ownerAgentId: string): void;
}

export const IAgentCollaborationRegistry =
  createDecorator<IAgentCollaborationRegistry>('agentCollaborationRegistry');

export class AgentCollaborationRegistry implements IAgentCollaborationRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly pending = new Map<string, string>();

  constructor(@ISessionMetadata private readonly metadata: ISessionMetadata) {}

  async reserve(taskName: string, ownerAgentId: string): Promise<boolean> {
    await this.metadata.ready;
    if (this.pending.has(taskName)) return false;
    const agents = (await this.metadata.read()).agents ?? {};
    if (this.pending.has(taskName)) return false;
    if (Object.values(agents).some((meta) => meta.labels?.[COLLABORATION_TASK_NAME_LABEL] === taskName)) {
      return false;
    }
    this.pending.set(taskName, ownerAgentId);
    return true;
  }

  commit(taskName: string, ownerAgentId: string): void {
    if (this.pending.get(taskName) === ownerAgentId) this.pending.delete(taskName);
  }

  release(taskName: string, ownerAgentId: string): void {
    if (this.pending.get(taskName) === ownerAgentId) this.pending.delete(taskName);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentCollaborationRegistry,
  AgentCollaborationRegistry,
  ScopeActivation.OnScopeCreated,
  'agentCollaborationRegistry',
);
