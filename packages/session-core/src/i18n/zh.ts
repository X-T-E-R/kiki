/**
 * 简体中文词典 — 由 `./domains/zh/` 下的分域模块聚合导出。
 * 新增键请按字典序写入对应域模块，并与 `./domains/en/` 保持键集一致。
 */
import { agentPanelZh } from './domains/zh/agent-panel';
import { capabilitiesZh } from './domains/zh/capabilities';
import { commonZh } from './domains/zh/common';
import { composerZh } from './domains/zh/composer';
import { cronTasksZh } from './domains/zh/cron-tasks';
import { discoveryOnboardingZh } from './domains/zh/discovery-onboarding';
import { memoryZh } from './domains/zh/memory';
import { personaRoomZh } from './domains/zh/persona-room';
import { previewTermZh } from './domains/zh/preview-term';
import { sidebarZh } from './domains/zh/sidebar';
import { stAgentsZh } from './domains/zh/st-agents';
import { stBrowserCuaZh } from './domains/zh/st-browser-cua';
import { stCoreZh } from './domains/zh/st-core';
import { stExtRecipesZh } from './domains/zh/st-ext-recipes';
import { stGovernanceZh } from './domains/zh/st-governance';
import { stImNotifyZh } from './domains/zh/st-im-notify';
import { stSearchZh } from './domains/zh/st-search';
import { stSpacesRemoteZh } from './domains/zh/st-spaces-remote';
import { transcriptZh } from './domains/zh/transcript';
import { usageZh } from './domains/zh/usage';

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
