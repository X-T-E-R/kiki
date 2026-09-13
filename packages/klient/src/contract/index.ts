/**
 * The aggregated klient contract — service wire name → method → zod
 * input/output schemas, across the core/session/agent scopes. The klient
 * factory validates every call against this table; transports never see it.
 * Event registrations live in the per-scope `events.ts` files alongside
 * their payload schemas.
 */

import type { KlientContract } from './types.js';
import { agentActivityViewContract } from './agent/activity.js';
import {
  agentCommandContract,
  agentContextMemoryContract,
  agentFullCompactionContract,
  agentLoopContract,
  agentMcpContract,
  agentPermissionModeContract,
  agentPlanContract,
  agentRuntimeBindingContract,
  agentProfileContract,
  agentPromptContract,
  agentShellCommandContract,
  agentSkillContract,
  agentTaskContract,
  agentTokenCountingContract,
  agentUsageContract,
} from './agent/services.js';
import { authContract, authSummaryContract } from './global/auth.js';
import { capabilitiesContract } from './global/capabilities.js';
import { catalogContract } from './global/catalog.js';
import { providerDiscoveryContract } from './global/providerDiscovery.js';
import { configContract } from './global/config.js';
import { envContract } from './global/env.js';
import { filesContract } from './global/files.js';
import { flagsContract } from './global/flags.js';
import { hostFsContract } from './global/hostFs.js';
import { modelsContract } from './global/models.js';
import { mcpManagementContract } from './global/mcpManagement.js';
import { pluginsContract } from './global/plugins.js';
import { providersContract } from './global/providers.js';
import { sessionsContract } from './global/sessions.js';
import { workspacesContract } from './global/workspaces.js';
import { threadsContract } from './global/threads.js';
import { sessionActivityViewContract } from './session/activity.js';
import { sessionApprovalContract } from './session/approval.js';
import { sessionInteractionContract } from './session/interaction.js';
import { agentLifecycleContract, sessionManagerContract } from './session/lifecycle.js';
import { sessionMetadataContract } from './session/metadata.js';
import { sessionQuestionContract } from './session/question.js';
import { sessionSkillCatalogContract } from './session/skills.js';
import { sessionTitleContract } from './session/title.js';
import { sessionBtwContract } from './session/btw.js';
import { sessionCronContract } from './session/cron.js';
import { sessionInitContract } from './session/init.js';
import { sessionTodoContract } from './session/todo.js';

export const globalContract: KlientContract = {
  agentLifecycleService: agentLifecycleContract,
  sessionCronService: sessionCronContract,
  sessionBtwService: sessionBtwContract,
  sessionInitService: sessionInitContract,
  sessionTodoService: sessionTodoContract,
  // core (app scope)
  sessionIndex: sessionsContract,
  workspaceService: workspacesContract,
  configService: configContract,
  providerService: providersContract,
  modelService: modelsContract,
  modelResolver: catalogContract,
  providerDiscovery: providerDiscoveryContract,
  oauthService: authContract,
  authSummaryService: authSummaryContract,
  flagService: flagsContract,
  pluginService: pluginsContract,
  capabilityService: capabilitiesContract,
  hostFolderBrowser: hostFsContract,
  bootstrapService: envContract,
  threadCommunicationService: threadsContract,
  fileService: filesContract,
  mcpManagementService: mcpManagementContract,
  sessionManager: sessionManagerContract,
  // session scope
  sessionMetadata: sessionMetadataContract,
  sessionActivityView: sessionActivityViewContract,
  sessionInteractionService: sessionInteractionContract,
  sessionApprovalService: sessionApprovalContract,
  sessionQuestionService: sessionQuestionContract,
  sessionSkillCatalog: sessionSkillCatalogContract,
  sessionTitleService: sessionTitleContract,
  // agent scope
  agentPromptService: agentPromptContract,
  agentSkillService: agentSkillContract,
  agentLoopService: agentLoopContract,
  agentPermissionModeService: agentPermissionModeContract,
  agentCommandService: agentCommandContract,
  agentRuntimeBindingService: agentRuntimeBindingContract,
  agentContextMemoryService: agentContextMemoryContract,
  agentTokenCountingService: agentTokenCountingContract,
  agentActivityView: agentActivityViewContract,
  agentShellCommandService: agentShellCommandContract,
  agentProfileService: agentProfileContract,
  agentUsageService: agentUsageContract,
  agentPlanService: agentPlanContract,
  agentTaskService: agentTaskContract,
  agentMcpService: agentMcpContract,
  agentFullCompactionService: agentFullCompactionContract,
};

export type { KlientContract, ProcedureContract, ServiceContract, StreamingProcedureContract } from './types.js';
export { isStreamingContract } from './types.js';
