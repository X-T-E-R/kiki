import AGENT_PROFILE_TEXT from './agent.md?raw';
import EXPLORE_PROFILE_TEXT from './explore.md?raw';
import GENERAL_PROFILE_TEXT from './general.md?raw';

export const SHIPPED_AGENT_PROFILE_BUNDLE_VERSION = 3;

export interface ShippedAgentProfileTemplate {
  readonly id: string;
  readonly fileName: string;
  readonly text: string;
  readonly materializeOnFreshInstall: boolean;
}

export const SHIPPED_AGENT_PROFILE_TEMPLATES: readonly ShippedAgentProfileTemplate[] = [
  {
    id: 'agent',
    fileName: 'agent.md',
    text: AGENT_PROFILE_TEXT,
    materializeOnFreshInstall: true,
  },
  {
    id: 'explore',
    fileName: 'explore.md',
    text: EXPLORE_PROFILE_TEXT,
    materializeOnFreshInstall: true,
  },
  {
    id: 'general',
    fileName: 'general.md',
    text: GENERAL_PROFILE_TEXT,
    materializeOnFreshInstall: true,
  },
];

export function shippedAgentProfileTemplate(id: string): ShippedAgentProfileTemplate | undefined {
  return SHIPPED_AGENT_PROFILE_TEMPLATES.find((template) => template.id === id);
}
