import { ScopeActivation } from '#/_base/di/instantiation';
import '#/app/branch/configSection';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { AgentBranchGuardService, IAgentBranchGuardService } from './agentBranchGuardService';
import './branchOps';
import { ISessionBranchService, ISessionBtwService } from './btw';
import { SessionBranchService, SessionBtwService } from './btwService';
import { BranchTool, IBranchTool } from './tools/branchTool';
import { IMergeTool, MergeTool } from './tools/mergeTool';

export class BtwFeature extends Feature {
  static override readonly name = 'btw';

  constructor() {
    super();
    this.contributeAgentService(IAgentBranchGuardService, AgentBranchGuardService, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeService(LifecycleScope.Session, ISessionBranchService, SessionBranchService, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeService(LifecycleScope.Session, ISessionBtwService, SessionBtwService);
    this.contributeTool(IBranchTool, BranchTool, {
      name: 'Branch',
      domain: 'branch',
    });
    this.contributeTool(IMergeTool, MergeTool, {
      name: 'Merge',
      domain: 'branch',
    });
  }
}

registerFeature(BtwFeature);
