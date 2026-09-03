import type {
  AgentProfile,
  AgentProfileInput,
} from './agentProfileCatalog';
import {
  _clearAgentProfileContributionsForTests,
  getAgentProfileContributions as getContributions,
  registerAgentProfile as registerProfile,
} from '@kiki/agent-profiles/contribution';

export { _clearAgentProfileContributionsForTests };

export function registerAgentProfile(definition: AgentProfileInput): void {
  registerProfile(definition);
}

export function getAgentProfileContributions(): readonly AgentProfile[] {
  return getContributions() as readonly AgentProfile[];
}
