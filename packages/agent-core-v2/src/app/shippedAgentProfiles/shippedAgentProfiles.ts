import AGENT_PROFILE_TEXT from './agent.md?raw';
import CODER_PROFILE_TEXT from './coder.md?raw';
import EXPLORE_PROFILE_TEXT from './explore.md?raw';
import GENERAL_PROFILE_TEXT from './general.md?raw';
import PLAN_PROFILE_TEXT from './plan.md?raw';

export const SHIPPED_AGENT_PROFILE_BUNDLE_VERSION = 2;

export interface ShippedAgentProfileTemplate {
  readonly id: string;
  readonly fileName: string;
  readonly text: string;
  readonly materializeOnFreshInstall: boolean;
  readonly materializeOnLegacyInstall: boolean;
}

export const SHIPPED_AGENT_PROFILE_TEMPLATES: readonly ShippedAgentProfileTemplate[] = [
  {
    id: 'agent',
    fileName: 'agent.md',
    text: AGENT_PROFILE_TEXT,
    materializeOnFreshInstall: true,
    materializeOnLegacyInstall: true,
  },
  {
    id: 'explore',
    fileName: 'explore.md',
    text: EXPLORE_PROFILE_TEXT,
    materializeOnFreshInstall: true,
    materializeOnLegacyInstall: true,
  },
  {
    id: 'general',
    fileName: 'general.md',
    text: GENERAL_PROFILE_TEXT,
    materializeOnFreshInstall: true,
    materializeOnLegacyInstall: true,
  },
  {
    id: 'coder',
    fileName: 'coder.md',
    text: CODER_PROFILE_TEXT,
    materializeOnFreshInstall: false,
    materializeOnLegacyInstall: true,
  },
  {
    id: 'plan',
    fileName: 'plan.md',
    text: PLAN_PROFILE_TEXT,
    materializeOnFreshInstall: false,
    materializeOnLegacyInstall: true,
  },
];

export function shippedAgentProfileTemplate(id: string): ShippedAgentProfileTemplate | undefined {
  return SHIPPED_AGENT_PROFILE_TEMPLATES.find((template) => template.id === id);
}
