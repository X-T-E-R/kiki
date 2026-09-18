/**
 * Service name → DI token registry for the in-process dispatcher. Only leaf
 * modules are imported (tokens + types) — never the engine root barrel, so
 * hosting klient in-process does not force the full registration side effects
 * beyond what the host already bootstrapped.
 */

import type { ServiceIdentifier } from '@kiki/agent-core-v2/_base/di/instantiation';
import { ITaskBoardService } from '@kiki/agent-core-v2/app/taskBoard/taskBoard';
import { IAgentPanelService } from '../agentPanelService.js';
import { ISessionIndex } from '@kiki/agent-core-v2/app/sessionIndex/sessionIndex';
import { IWorkspaceService } from '@kiki/agent-core-v2/app/workspace/workspace';
import { IConfigService } from '@kiki/agent-core-v2/app/config/config';
import { IModelService } from '@kiki/agent-core-v2/kosong/model/model';
import { IModelCatalog } from '@kiki/agent-core-v2/kosong/model/catalog';
import { IProviderDiscoveryService } from '@kiki/agent-core-v2/app/kosongConfig/discovery';
import { IModelCatalogMutationService } from '@kiki/agent-core-v2/app/kosongConfig/modelCatalogMutation';
import { IProviderService } from '@kiki/agent-core-v2/kosong/provider/provider';
import {
  IAuthSummaryService,
  IOAuthService,
} from '@kiki/agent-core-v2/app/auth/auth';
import { IFlagService } from '@kiki/agent-core-v2/app/flag/flag';
import { IPluginService } from '@kiki/agent-core-v2/app/plugin/plugin';
import { ICapabilityService } from '@kiki/agent-core-v2/app/capability/capability';
import { IBootstrapService } from '@kiki/agent-core-v2/app/bootstrap/bootstrap';
import { IEventService } from '@kiki/agent-core-v2/app/event/event';
import { IFileService } from '@kiki/agent-core-v2/app/file/fileService';
import { IHostFolderBrowser } from '@kiki/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import { IWorkspaceInstanceManager } from '@kiki/agent-core-v2/workspace/workspaceInstance/workspaceInstanceManager';
import { ISessionManager } from '@kiki/agent-core-v2/app/sessionManager/sessionManager';
import { ISessionMetadata } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ISessionActivityView } from '@kiki/agent-core-v2/session/sessionActivity/sessionActivity';
import { ISessionInteractionService } from '@kiki/agent-core-v2/session/interaction/interaction';
import { ISessionApprovalService } from '@kiki/agent-core-v2/session/approval/approval';
import { ISessionQuestionService } from '@kiki/agent-core-v2/session/question/question';
import { ISessionSkillCatalog } from '@kiki/agent-core-v2/session/sessionSkillCatalog/skillCatalog';
import { ISessionTitleService } from '@kiki/agent-core-v2/session/sessionTitle/sessionTitle';
import { IAgentPromptService } from '@kiki/agent-core-v2/agent/prompt/prompt';
import { IAgentSkillService } from '@kiki/agent-core-v2/agent/skill/skill';
import { IAgentLoopService } from '@kiki/agent-core-v2/agent/loop/loop';
import { IAgentContextInjectorService } from '@kiki/agent-core-v2/agent/contextInjector/contextInjector';
import { IAgentContextRebuildService } from '@kiki/agent-core-v2/agent/contextRebuild/contextRebuild';
import { IAgentConversationUndoService } from '@kiki/agent-core-v2/agent/undo/undo';
import { IAgentPluginCommandService } from '@kiki/agent-core-v2/agent/pluginCommand/pluginCommand';
import { IAgentPluginService } from '@kiki/agent-core-v2/agent/plugin/agentPlugin';
import { IAgentPermissionModeService } from '@kiki/agent-core-v2/agent/permissionMode/permissionMode';
import { IAgentCommandService } from '@kiki/agent-core-v2/agent/command/agentCommand';
import { IAgentRuntimeBindingService } from '@kiki/agent-core-v2/agent/runtimeBinding/runtimeBinding';
import {
  IAgentContextMemoryService,
  IAgentContextMutationService,
} from '@kiki/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentTokenCountingService } from '@kiki/agent-core-v2/agent/tokenCounting/tokenCounting';
import { IAgentActivityView } from '@kiki/agent-core-v2/agent/activityView/activityView';
import { IAgentPlanService } from '@kiki/agent-core-v2/features/plan/plan';
import { IAgentSwarmService } from '@kiki/agent-core-v2/features/swarm/agent/swarm';
import { IAgentProfileService } from '@kiki/agent-core-v2/agent/profile/profile';
import { IAgentShellCommandService } from '@kiki/agent-core-v2/agent/shellCommand/shellCommand';
import { IAgentTaskService } from '@kiki/agent-core-v2/agent/task/task';
import { IAgentUsageService } from '@kiki/agent-core-v2/agent/usage/usage';
import { IAgentMcpService } from '@kiki/agent-core-v2/agent/mcp/mcp';
import { IAgentFullCompactionService } from '@kiki/agent-core-v2/agent/fullCompaction/fullCompaction';
import { IThreadCommunicationService } from '@kiki/agent-core-v2/app/threadCommunication/threadCommunication';
import { IMcpManagementService } from '@kiki/agent-core-v2/app/mcpManagement/mcpManagement';
import { IAgentGoalService } from '@kiki/agent-core-v2/agent/goal/goal';
import { IAgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { ISessionBtwService } from '@kiki/agent-core-v2/features/btw/btw';
import { ISessionInitService } from '@kiki/agent-core-v2/features/sessionInit/sessionInit';
import { ISessionCronService } from '@kiki/agent-core-v2/session/cron/sessionCronService';
import { ISessionTodoService } from '@kiki/agent-core-v2/session/todo/sessionTodo';

/** Wire service name (decorator id string) → token. */
export const serviceTokens: Readonly<Record<string, ServiceIdentifier<unknown>>> = {
  agentGoalService: IAgentGoalService,
  agentLifecycleService: IAgentLifecycleService,
  sessionCronService: ISessionCronService,
  taskBoardService: ITaskBoardService,
  agentPanelService: IAgentPanelService,
  sessionIndex: ISessionIndex,
  workspaceService: IWorkspaceService,
  configService: IConfigService,
  modelService: IModelService,
  modelResolver: IModelCatalog,
  modelCatalogMutation: IModelCatalogMutationService,
  providerDiscovery: IProviderDiscoveryService,
  providerService: IProviderService,
  oauthService: IOAuthService,
  authSummaryService: IAuthSummaryService,
  flagService: IFlagService,
  pluginService: IPluginService,
  capabilityService: ICapabilityService,
  hostFolderBrowser: IHostFolderBrowser,
  bootstrapService: IBootstrapService,
  threadCommunicationService: IThreadCommunicationService,
  fileService: IFileService,
  workspaceInstanceManager: IWorkspaceInstanceManager,
  sessionManager: ISessionManager,
  sessionMetadata: ISessionMetadata,
  sessionActivityView: ISessionActivityView,
  sessionBtwService: ISessionBtwService,
  sessionInitService: ISessionInitService,
  sessionTodoService: ISessionTodoService,
  sessionInteractionService: ISessionInteractionService,
  sessionApprovalService: ISessionApprovalService,
  sessionQuestionService: ISessionQuestionService,
  sessionSkillCatalog: ISessionSkillCatalog,
  sessionTitleService: ISessionTitleService,
  agentPromptService: IAgentPromptService,
  agentSkillService: IAgentSkillService,
  agentLoopService: IAgentLoopService,
  agentContextInjectorService: IAgentContextInjectorService,
  agentContextMutationService: IAgentContextMutationService,
  agentContextRebuildService: IAgentContextRebuildService,
  agentConversationUndoService: IAgentConversationUndoService,
  agentPluginCommandService: IAgentPluginCommandService,
  agentPluginService: IAgentPluginService,
  agentPermissionModeService: IAgentPermissionModeService,
  agentCommandService: IAgentCommandService,
  agentRuntimeBindingService: IAgentRuntimeBindingService,
  agentContextMemoryService: IAgentContextMemoryService,
  agentTokenCountingService: IAgentTokenCountingService,
  agentActivityView: IAgentActivityView,
  agentShellCommandService: IAgentShellCommandService,
  agentProfileService: IAgentProfileService,
  agentUsageService: IAgentUsageService,
  agentPlanService: IAgentPlanService,
  agentSwarmService: IAgentSwarmService,
  agentTaskService: IAgentTaskService,
  agentMcpService: IAgentMcpService,
  agentFullCompactionService: IAgentFullCompactionService,
  mcpManagementService: IMcpManagementService,
};

export { IEventService };
