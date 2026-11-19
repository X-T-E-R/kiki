/**
 * English dictionary — aggregated from domain modules under `./domains/en/`.
 * Add new keys to the matching domain file in lexicographical order.
 */
import { agentPanelEn } from './domains/en/agent-panel';
import { capabilitiesEn } from './domains/en/capabilities';
import { commonEn } from './domains/en/common';
import { composerEn } from './domains/en/composer';
import { cronTasksEn } from './domains/en/cron-tasks';
import { discoveryOnboardingEn } from './domains/en/discovery-onboarding';
import { memoryEn } from './domains/en/memory';
import { personaRoomEn } from './domains/en/persona-room';
import { previewTermEn } from './domains/en/preview-term';
import { sidebarEn } from './domains/en/sidebar';
import { stAgentsEn } from './domains/en/st-agents';
import { stBrowserCuaEn } from './domains/en/st-browser-cua';
import { stCoreEn } from './domains/en/st-core';
import { stExtRecipesEn } from './domains/en/st-ext-recipes';
import { stGovernanceEn } from './domains/en/st-governance';
import { stImNotifyEn } from './domains/en/st-im-notify';
import { stSearchEn } from './domains/en/st-search';
import { stSpacesRemoteEn } from './domains/en/st-spaces-remote';
import { transcriptEn } from './domains/en/transcript';
import { usageEn } from './domains/en/usage';

export const enDomains = {
  'agent-panel': agentPanelEn,
  'capabilities': capabilitiesEn,
  'common': commonEn,
  'composer': composerEn,
  'cron-tasks': cronTasksEn,
  'discovery-onboarding': discoveryOnboardingEn,
  'memory': memoryEn,
  'persona-room': personaRoomEn,
  'preview-term': previewTermEn,
  'sidebar': sidebarEn,
  'st-agents': stAgentsEn,
  'st-browser-cua': stBrowserCuaEn,
  'st-core': stCoreEn,
  'st-ext-recipes': stExtRecipesEn,
  'st-governance': stGovernanceEn,
  'st-im-notify': stImNotifyEn,
  'st-search': stSearchEn,
  'st-spaces-remote': stSpacesRemoteEn,
  'transcript': transcriptEn,
  'usage': usageEn,
} as const;

export const en = {
  ...agentPanelEn,
  ...capabilitiesEn,
  ...commonEn,
  ...composerEn,
  ...cronTasksEn,
  ...discoveryOnboardingEn,
  ...memoryEn,
  ...personaRoomEn,
  ...previewTermEn,
  ...sidebarEn,
  ...stAgentsEn,
  ...stBrowserCuaEn,
  ...stCoreEn,
  ...stExtRecipesEn,
  ...stGovernanceEn,
  ...stImNotifyEn,
  ...stSearchEn,
  ...stSpacesRemoteEn,
  ...transcriptEn,
  ...usageEn,
} as const;
