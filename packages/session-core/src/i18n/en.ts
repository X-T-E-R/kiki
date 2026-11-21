/**
 * English dictionary — aggregated from domain modules under `./domains/en/`.
 * Add new keys to the matching domain file in lexicographical order.
 */
import { agentPanelEn } from './domains/en/agent-panel.ts';
import { capabilitiesEn } from './domains/en/capabilities.ts';
import { commonEn } from './domains/en/common.ts';
import { composerEn } from './domains/en/composer.ts';
import { cronTasksEn } from './domains/en/cron-tasks.ts';
import { discoveryOnboardingEn } from './domains/en/discovery-onboarding.ts';
import { memoryEn } from './domains/en/memory.ts';
import { mobileEn } from './domains/en/mobile.ts';
import { personaRoomEn } from './domains/en/persona-room.ts';
import { previewTermEn } from './domains/en/preview-term.ts';
import { sidebarEn } from './domains/en/sidebar.ts';
import { stAgentsEn } from './domains/en/st-agents.ts';
import { stBrowserCuaEn } from './domains/en/st-browser-cua.ts';
import { stCoreEn } from './domains/en/st-core.ts';
import { stExtRecipesEn } from './domains/en/st-ext-recipes.ts';
import { stGovernanceEn } from './domains/en/st-governance.ts';
import { stImNotifyEn } from './domains/en/st-im-notify.ts';
import { stSearchEn } from './domains/en/st-search.ts';
import { stSpacesRemoteEn } from './domains/en/st-spaces-remote.ts';
import { transcriptEn } from './domains/en/transcript.ts';
import { usageEn } from './domains/en/usage.ts';

export const enDomains = {
  'agent-panel': agentPanelEn,
  'capabilities': capabilitiesEn,
  'common': commonEn,
  'composer': composerEn,
  'cron-tasks': cronTasksEn,
  'discovery-onboarding': discoveryOnboardingEn,
  'memory': memoryEn,
  'mobile': mobileEn,
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
  ...mobileEn,
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
