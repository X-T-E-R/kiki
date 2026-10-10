export const CONNECTION_OPERATIONS = {
  meta: ['GET', '/meta'], spaceSummary: ['GET', '/space-summary'],
  sessions: ['GET', '/sessions'], sessionQuery: ['GET', '/sessions/query'], ephemeralSessions: ['GET', '/sessions/ephemeral'],
  sessionCreate: ['POST', '/sessions'], session: ['GET', '/sessions/{sessionId}'],
  sessionUpdate: ['PATCH', '/sessions/{sessionId}'], sessionArchive: ['POST', '/sessions/{sessionId}:archive'],
  sessionRestore: ['POST', '/sessions/{sessionId}:restore'], sessionFork: ['POST', '/sessions/{sessionId}:fork'],
  saveEphemeral: ['POST', '/sessions/{sessionId}/ephemeral/save'], endEphemeral: ['POST', '/sessions/{sessionId}/ephemeral/end'],
  compact: ['POST', '/sessions/{sessionId}:compact'], undo: ['POST', '/sessions/{sessionId}:undo'],
  autoCompact: ['GET', '/sessions/{sessionId}/agents/{agentId}/auto-compact'],
  autoCompactUpdate: ['PATCH', '/sessions/{sessionId}/agents/{agentId}/auto-compact'],
  agentHooks: ['GET', '/sessions/{sessionId}/agents/{agentId}/hooks'],
  sessionProfile: ['POST', '/sessions/{sessionId}/profile'],
  personaSettings: ['GET', '/sessions/{sessionId}/persona-settings'], personaSettingsApply: ['POST', '/sessions/{sessionId}/persona-settings'],
  goal: ['GET', '/sessions/{sessionId}/goal'], messages: ['GET', '/sessions/{sessionId}/messages'],
  snapshot: ['GET', '/klient/session-view/{sessionId}/snapshot'],
  transcript: ['GET', '/klient/session-view/{sessionId}/transcript'],
  content: ['POST', '/klient/session-view/{sessionId}/transcript/content'],
  catchUp: ['GET', '/klient/session-view/{sessionId}/transcript/catch-up'],
  transcriptPage: ['GET', '/sessions/{sessionId}/transcript'],
  transcriptDetail: ['GET', '/sessions/{sessionId}/transcript/detail'], transcriptDetails: ['GET', '/sessions/{sessionId}/transcript/details'],
  transcriptOps: ['GET', '/sessions/{sessionId}/transcript/ops'], transcriptPlan: ['GET', '/sessions/{sessionId}/transcript/plan'],
  procedure: ['POST', '/klient/call'],
  prompts: ['GET', '/sessions/{sessionId}/prompts'], prompt: ['POST', '/sessions/{sessionId}/prompts'],
  steer: ['POST', '/sessions/{sessionId}/prompts/steer'], abort: ['POST', '/sessions/{sessionId}/abort'],
  approvals: ['GET', '/sessions/{sessionId}/approvals'], approval: ['POST', '/sessions/{sessionId}/approvals/{interactionId}'],
  questions: ['GET', '/sessions/{sessionId}/questions'], question: ['POST', '/sessions/{sessionId}/questions/{interactionId}'],
  taskList: ['GET', '/sessions/{sessionId}/tasks'], task: ['GET', '/sessions/{sessionId}/tasks/{taskId}'],
  agentTaskList: ['GET', '/sessions/{sessionId}/agent-tasks'],
  userMessages: ['GET', '/sessions/{sessionId}/user-messages'],
  skills: ['GET', '/sessions/{sessionId}/skills'], skillActivate: ['POST', '/sessions/{sessionId}/skills/{skillName}:activate'],
  context: ['GET', '/sessions/{sessionId}/context'], metrics: ['GET', '/sessions/{sessionId}/metrics'],
  media: ['GET', '/sessions/{sessionId}/media/{fileId}'],
  mediaPreview: ['GET', '/sessions/{sessionId}/media/{fileId}/preview'],
  fileUpload: ['POST', '/files'], file: ['GET', '/files/{fileId}'],
  tools: ['GET', '/tools'], models: ['GET', '/models'], providers: ['GET', '/providers'], auth: ['GET', '/auth'],
  configRead: ['GET', '/config'], usage: ['GET', '/usage'], requestGovernance: ['GET', '/usage/realtime'],
  agentActivity: ['GET', '/usage/realtime/agents'],
  usagePricing: ['GET', '/usage/pricing'], usageRescanStatus: ['GET', '/usage/rescan'],
  workspaces: ['GET', '/workspaces'], workspace: ['GET', '/workspaces/{workspaceId}'], workspaceSkills: ['GET', '/workspaces/{workspaceId}/skills'],
  worktrees: ['GET', '/worktrees'], worktree: ['GET', '/worktrees/{worktreeId}'], worktreeInspect: ['POST', '/worktrees/{worktreeId}:inspect'],
  fsSearch: ['POST', '/sessions/{sessionId}/fs:search'], draftFsSearch: ['POST', '/workspace/fs:search'],
  commands: ['GET', '/sessions/{sessionId}/commands'],
  agentCapabilities: ['GET', '/agents/capabilities'], agentConfig: ['GET', '/sessions/{sessionId}/agent-config'],
  agentConfigUpdate: ['PATCH', '/sessions/{sessionId}/agent-config'],
  profiles: ['GET', '/agents'], shippedProfiles: ['GET', '/agents/shipped'],
  previewModelMenu: ['POST', '/agents/{profileId}/model-menu:preview'], previewExecutorPrompt: ['POST', '/agents/{profileId}/executor-prompt:preview'],
  plugins: ['GET', '/plugins'], plugin: ['GET', '/plugins/{pluginId}'],
  pluginSettings: ['GET', '/plugins/{pluginId}/settings'], pluginCommands: ['GET', '/plugins/commands'],
  pluginPanels: ['GET', '/plugins/panels'], pluginPanelDocument: ['GET', '/plugins/{pluginId}/panels/{panelId}/document'],
  pluginPanelBridge: ['POST', '/plugins/{pluginId}/panels/{panelId}/bridge'],
  pluginMarketplace: ['GET', '/plugins/marketplace'], pluginRecommendations: ['POST', '/plugins/recommendations/match'],
  skins: ['GET', '/skins'], skin: ['GET', '/skins/{skinId}'],
  appearancePacks: ['GET', '/appearance/packs'], appearancePack: ['GET', '/appearance/packs/{packId}'],
  appearanceAsset: ['GET', '/appearance/packs/{packId}/files/{fileName}'],
  spacePreferences: ['GET', '/homes/{spaceId}/settings'],
  personas: ['GET', '/personas'], persona: ['GET', '/personas/{personaId}'], personaAvatar: ['GET', '/personas/{personaId}/avatar'],
  personaHome: ['POST', '/personas/{personaId}/home'], personaState: ['PATCH', '/personas/{personaId}/state'],
  bots: ['GET', '/bots'], botHome: ['POST', '/bots/{botId}/home'],
  rooms: ['GET', '/rooms'], roomItems: ['GET', '/rooms/items'], roomThreads: ['GET', '/rooms/threads'], room: ['GET', '/rooms/{roomId}'],
  roomLog: ['GET', '/rooms/{roomId}/log'], roomUsage: ['GET', '/rooms/{roomId}/usage'],
  roomMessage: ['POST', '/rooms/{roomId}/messages'], roomPause: ['POST', '/rooms/{roomId}/pause'], roomContinue: ['POST', '/rooms/{roomId}/continue'], roomStop: ['POST', '/rooms/{roomId}/stop'],
  cron: ['GET', '/cron'], threadMessages: ['GET', '/threads/messages'],
  search: ['POST', '/search'], searchStatus: ['GET', '/search/status'],
  mcpRuntime: ['GET', '/mcp/runtime/servers'], executors: ['GET', '/executors'],
  catalogProviders: ['GET', '/catalog/providers'], catalogProvider: ['GET', '/catalog/providers/{providerId}'],
  oauthUsage: ['GET', '/oauth/usage'], nbSearchCapabilities: ['GET', '/nb-search/capabilities'],
  requestIdentity: ['GET', '/request-identity'], notificationsSettings: ['GET', '/notifications/settings'],
  notificationsProviders: ['GET', '/notifications/providers'], notificationsDeliveries: ['GET', '/notifications/deliveries'],
  memorySources: ['GET', '/memory/sources'], memoryEntries: ['GET', '/memory/{scope}'], memoryEntry: ['GET', '/memory/{scope}/{entryId}'],
  memoryJournal: ['GET', '/memory/{scope}/journal'], memoryInbox: ['GET', '/memory/{scope}/inbox'],
} as const;
export type ConnectionOperation = keyof typeof CONNECTION_OPERATIONS;
export interface ResolvedConnectionOperation { operation: ConnectionOperation; params: Record<string, string> }
const invalidParam = (value: string): boolean => !value || value === '.' || value === '..' || value.includes('/') || value.includes('\\');
export function matchConnectionOperation(method: string, path: string): ResolvedConnectionOperation | undefined {
  const entries = Object.entries(CONNECTION_OPERATIONS).toSorted((a, b) => (a[1][1].match(/\{/g)?.length ?? 0) - (b[1][1].match(/\{/g)?.length ?? 0));
  for (const [operation, [verb, template]] of entries) {
    if (verb !== method) continue;
    const names: string[] = [];
    const expression = template.split(/(\{[A-Za-z]+\})/).map((part) => {
      if (part.startsWith('{')) { names.push(part.slice(1, -1)); return '([^/]+)'; }
      return part.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    const match = new RegExp('^/api' + expression + '$').exec(path.startsWith('/api/') ? path : '/api' + path);
    if (match === null) continue;
    const params: Record<string, string> = {}; let valid = true;
    for (let i = 0; i < names.length; i += 1) {
      let value: string; try { value = decodeURIComponent(match[i + 1]!); } catch { valid = false; break; }
      if (invalidParam(value)) { valid = false; break; }
      params[names[i]!] = value;
    }
    if (valid) return { operation: operation as ConnectionOperation, params };
  }
  return undefined;
}
export function connectionOperationPath(operation: ConnectionOperation, params: Record<string, string> = {}): string {
  return '/api' + CONNECTION_OPERATIONS[operation][1].replaceAll(/\{([A-Za-z]+)\}/g, (_, name: string) => {
    const value = params[name]; if (value === undefined || invalidParam(value)) throw new Error(`Invalid ${name}`);
    return encodeURIComponent(value);
  });
}
