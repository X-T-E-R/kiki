import {
  agentReferenceCandidatesQuerySchema,
  agentReferenceCandidatesResponseSchema,
  closeTerminalResponseSchema,
  createTerminalRequestSchema,
  decisionConnectionProbeInputSchema,
  decisionConnectionProbeResultSchema,
  deleteArchivedSessionRequestSchema,
  deleteArchivedSessionsResponseSchema,
  detachSessionGroupResponseSchema,
  executorAccountSourcesResponseSchema,
  executorAccountsResponseSchema,
  executorDiscoveryResponseSchema,
  getTerminalResponseSchema,
  harnessQuotaActionRequestSchema,
  harnessQuotaActionResponseSchema,
  harnessQuotaCacheResponseSchema,
  harnessQuotaReadRequestSchema,
  listTerminalsResponseSchema,
  memoryAdvisorProbeInputSchema,
  memoryAdvisorProbeResultSchema,
  memoryAdvisorStatusSchema,
  memorySettingsPatchSchema,
  memorySettingsResponseSchema,
  moveReviewerKeyInputSchema,
  moveReviewerKeyResultSchema,
  pluginModelCatalogSchema,
  promptSubmitReceiptSchema,
  resolveSidebarUnitsRequestSchema,
  resolveSidebarUnitsResponseSchema,
  sidebarGroupMembersResponseSchema,
  sidebarSessionsPageSchema,
} from '@kiki/protocol';
import { listAgentTasksQuerySchema, listAgentTasksResponseSchema } from '../../contract/session/agent-tasks.js';
import { sessionMediaPlaybackSchema } from '../../contract/session/media-playback.js';

export interface HttpChannelValidator {
  readonly listTerminals: (v: unknown) => ReturnType<typeof listTerminalsResponseSchema.parse>;
  readonly createTerminalInput: (v: unknown) => ReturnType<typeof createTerminalRequestSchema.parse>;
  readonly getTerminal: (v: unknown) => ReturnType<typeof getTerminalResponseSchema.parse>;
  readonly closeTerminal: (v: unknown) => ReturnType<typeof closeTerminalResponseSchema.parse>;
  readonly promptSubmitReceipt: (v: unknown) => ReturnType<typeof promptSubmitReceiptSchema.parse>;
  readonly decisionProbeInput: (v: unknown) => ReturnType<typeof decisionConnectionProbeInputSchema.parse>;
  readonly decisionProbeOutput: (v: unknown) => ReturnType<typeof decisionConnectionProbeResultSchema.parse>;
  readonly moveReviewerKeyInput: (v: unknown) => ReturnType<typeof moveReviewerKeyInputSchema.parse>;
  readonly moveReviewerKeyOutput: (v: unknown) => ReturnType<typeof moveReviewerKeyResultSchema.parse>;
  readonly memorySettingsOutput: (v: unknown) => ReturnType<typeof memorySettingsResponseSchema.parse>;
  readonly memorySettingsPatch: (v: unknown) => ReturnType<typeof memorySettingsPatchSchema.parse>;
  readonly memoryAdvisorProbeInput: (v: unknown) => ReturnType<typeof memoryAdvisorProbeInputSchema.parse>;
  readonly memoryAdvisorProbeOutput: (v: unknown) => ReturnType<typeof memoryAdvisorProbeResultSchema.parse>;
  readonly memoryAdvisorStatus: (v: unknown) => ReturnType<typeof memoryAdvisorStatusSchema.parse> | null;
  readonly detachGroup: (v: unknown) => ReturnType<typeof detachSessionGroupResponseSchema.parse>;
  readonly deleteArchivedInput: (v: unknown) => ReturnType<typeof deleteArchivedSessionRequestSchema.parse>;
  readonly deleteArchivedOutput: (v: unknown) => ReturnType<typeof deleteArchivedSessionsResponseSchema.parse>;
  readonly listAgentTasksQuery: (v: unknown) => ReturnType<typeof listAgentTasksQuerySchema.parse>;
  readonly listAgentTasksResponse: (v: unknown) => ReturnType<typeof listAgentTasksResponseSchema.parse>;
  readonly mediaPlayback: (v: unknown) => ReturnType<typeof sessionMediaPlaybackSchema.parse>;
  readonly sidebarList: (v: unknown) => ReturnType<typeof sidebarSessionsPageSchema.parse>;
  readonly sidebarGroupMembers: (v: unknown) => ReturnType<typeof sidebarGroupMembersResponseSchema.parse>;
  readonly resolveSidebarUnitsInput: (v: unknown) => ReturnType<typeof resolveSidebarUnitsRequestSchema.parse>;
  readonly resolveSidebarUnitsOutput: (v: unknown) => ReturnType<typeof resolveSidebarUnitsResponseSchema.parse>;
  readonly executorDiscovery: (v: unknown) => ReturnType<typeof executorDiscoveryResponseSchema.parse>;
  readonly executorAccountSources: (v: unknown) => ReturnType<typeof executorAccountSourcesResponseSchema.parse>;
  readonly executorAccounts: (v: unknown) => ReturnType<typeof executorAccountsResponseSchema.parse>;
  readonly harnessQuotaCache: (v: unknown) => ReturnType<typeof harnessQuotaCacheResponseSchema.parse>;
  readonly harnessQuotaReadInput: (v: unknown) => ReturnType<typeof harnessQuotaReadRequestSchema.parse>;
  readonly harnessQuotaActionInput: (v: unknown) => ReturnType<typeof harnessQuotaActionRequestSchema.parse>;
  readonly harnessQuotaActionOutput: (v: unknown) => ReturnType<typeof harnessQuotaActionResponseSchema.parse>;
  readonly agentRefCandidatesQuery: (v: unknown) => ReturnType<typeof agentReferenceCandidatesQuerySchema.parse>;
  readonly agentRefCandidatesOutput: (v: unknown) => ReturnType<typeof agentReferenceCandidatesResponseSchema.parse>;
  readonly pluginModelCatalog: (v: unknown) => ReturnType<typeof pluginModelCatalogSchema.parse>;
}

export const defaultHttpChannelValidator: HttpChannelValidator = {
  listTerminals: (v) => listTerminalsResponseSchema.parse(v),
  createTerminalInput: (v) => createTerminalRequestSchema.parse(v),
  getTerminal: (v) => getTerminalResponseSchema.parse(v),
  closeTerminal: (v) => closeTerminalResponseSchema.parse(v),
  promptSubmitReceipt: (v) => promptSubmitReceiptSchema.parse(v),
  decisionProbeInput: (v) => decisionConnectionProbeInputSchema.parse(v),
  decisionProbeOutput: (v) => decisionConnectionProbeResultSchema.parse(v),
  moveReviewerKeyInput: (v) => moveReviewerKeyInputSchema.parse(v),
  moveReviewerKeyOutput: (v) => moveReviewerKeyResultSchema.parse(v),
  memorySettingsOutput: (v) => memorySettingsResponseSchema.parse(v),
  memorySettingsPatch: (v) => memorySettingsPatchSchema.parse(v),
  memoryAdvisorProbeInput: (v) => memoryAdvisorProbeInputSchema.parse(v),
  memoryAdvisorProbeOutput: (v) => memoryAdvisorProbeResultSchema.parse(v),
  memoryAdvisorStatus: (v) => memoryAdvisorStatusSchema.nullable().parse(v),
  detachGroup: (v) => detachSessionGroupResponseSchema.parse(v),
  deleteArchivedInput: (v) => deleteArchivedSessionRequestSchema.parse(v),
  deleteArchivedOutput: (v) => deleteArchivedSessionsResponseSchema.parse(v),
  listAgentTasksQuery: (v) => listAgentTasksQuerySchema.parse(v),
  listAgentTasksResponse: (v) => listAgentTasksResponseSchema.parse(v),
  mediaPlayback: (v) => sessionMediaPlaybackSchema.parse(v),
  sidebarList: (v) => sidebarSessionsPageSchema.parse(v),
  sidebarGroupMembers: (v) => sidebarGroupMembersResponseSchema.parse(v),
  resolveSidebarUnitsInput: (v) => resolveSidebarUnitsRequestSchema.parse(v),
  resolveSidebarUnitsOutput: (v) => resolveSidebarUnitsResponseSchema.parse(v),
  executorDiscovery: (v) => executorDiscoveryResponseSchema.parse(v),
  executorAccountSources: (v) => executorAccountSourcesResponseSchema.parse(v),
  executorAccounts: (v) => executorAccountsResponseSchema.parse(v),
  harnessQuotaCache: (v) => harnessQuotaCacheResponseSchema.parse(v),
  harnessQuotaReadInput: (v) => harnessQuotaReadRequestSchema.parse(v),
  harnessQuotaActionInput: (v) => harnessQuotaActionRequestSchema.parse(v),
  harnessQuotaActionOutput: (v) => harnessQuotaActionResponseSchema.parse(v),
  agentRefCandidatesQuery: (v) => agentReferenceCandidatesQuerySchema.parse(v),
  agentRefCandidatesOutput: (v) => agentReferenceCandidatesResponseSchema.parse(v),
  pluginModelCatalog: (v) => pluginModelCatalogSchema.parse(v),
};
