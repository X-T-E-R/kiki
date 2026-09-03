import { collection } from '#/_base/di/collection';
import type { AgentProfileContribution as ProfileContribution } from '@kiki/agent-profiles/agentProfileContribution';

export {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type SkippedAgentFile,
} from '@kiki/agent-profiles/agentProfileContribution';

export type AgentProfileContribution = ProfileContribution;

export interface AgentProfileContributionRecord {
  readonly sourceId: string;
  readonly priority?: number;
  readonly workspaceKey?: string;
  readonly contribution: ProfileContribution;
}

export const AgentProfileContribution = collection<AgentProfileContributionRecord>('agent-profile');
