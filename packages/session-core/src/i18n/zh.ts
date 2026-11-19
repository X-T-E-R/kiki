/**
 * 简体中文词典 — 由 `./domains/zh/` 下的分域模块聚合导出。
 * 新增键请按字典序写入对应域模块，并与 `./domains/en/` 保持键集一致。
 */
import { agentPanelZh } from './domains/zh/agent-panel.ts';
import { capabilitiesZh } from './domains/zh/capabilities.ts';
import { commonZh } from './domains/zh/common.ts';
import { composerZh } from './domains/zh/composer.ts';
import { cronTasksZh } from './domains/zh/cron-tasks.ts';
import { discoveryOnboardingZh } from './domains/zh/discovery-onboarding.ts';
import { memoryZh } from './domains/zh/memory.ts';
import { personaRoomZh } from './domains/zh/persona-room.ts';
import { previewTermZh } from './domains/zh/preview-term.ts';
import { sidebarZh } from './domains/zh/sidebar.ts';
import { stAgentsZh } from './domains/zh/st-agents.ts';
import { stBrowserCuaZh } from './domains/zh/st-browser-cua.ts';
import { stCoreZh } from './domains/zh/st-core.ts';
import { stExtRecipesZh } from './domains/zh/st-ext-recipes.ts';
import { stGovernanceZh } from './domains/zh/st-governance.ts';
import { stImNotifyZh } from './domains/zh/st-im-notify.ts';
import { stSearchZh } from './domains/zh/st-search.ts';
import { stSpacesRemoteZh } from './domains/zh/st-spaces-remote.ts';
import { transcriptZh } from './domains/zh/transcript.ts';
import { usageZh } from './domains/zh/usage.ts';

export const zhDomains = {
  'agent-panel': agentPanelZh,
  'capabilities': capabilitiesZh,
  'common': commonZh,
  'composer': composerZh,
  'cron-tasks': cronTasksZh,
  'discovery-onboarding': discoveryOnboardingZh,
  'memory': memoryZh,
  'persona-room': personaRoomZh,
  'preview-term': previewTermZh,
  'sidebar': sidebarZh,
  'st-agents': stAgentsZh,
  'st-browser-cua': stBrowserCuaZh,
  'st-core': stCoreZh,
  'st-ext-recipes': stExtRecipesZh,
  'st-governance': stGovernanceZh,
  'st-im-notify': stImNotifyZh,
  'st-search': stSearchZh,
  'st-spaces-remote': stSpacesRemoteZh,
  'transcript': transcriptZh,
  'usage': usageZh,
} as const;

export const zh = {
  ...agentPanelZh,
  ...capabilitiesZh,
  ...commonZh,
  ...composerZh,
  ...cronTasksZh,
  ...discoveryOnboardingZh,
  ...memoryZh,
  ...personaRoomZh,
  ...previewTermZh,
  ...sidebarZh,
  ...stAgentsZh,
  ...stBrowserCuaZh,
  ...stCoreZh,
  ...stExtRecipesZh,
  ...stGovernanceZh,
  ...stImNotifyZh,
  ...stSearchZh,
  ...stSpacesRemoteZh,
  ...transcriptZh,
  ...usageZh,
};
