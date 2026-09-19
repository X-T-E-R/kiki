import { createDecorator } from '#/_base/di/instantiation';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { parseAgentFileText } from '@kiki/agent-profiles/agentFile';
import { agentProfileFromFile } from '@kiki/agent-profiles/agentProfileFromFile';
import { renderSystemPromptResult } from '#/app/agentProfileCatalog/profile-shared';

export const SHIPPED_AGENT_PROFILE_SCHEME = 'shipped://agent-profiles/';

export interface IShippedAgentProfileSource {
  readonly _serviceBrand: undefined;
  list(): readonly AgentProfile[];
  get(name: string): AgentProfile | undefined;
  getDefault(): AgentProfile;
}

export const IShippedAgentProfileSource =
  createDecorator<IShippedAgentProfileSource>('shippedAgentProfileSource');

export function renderShippedBasePrompt(
  context: Parameters<AgentProfile['renderSystemPrompt']>[0],
): ReturnType<AgentProfile['renderSystemPrompt']> {
  return renderSystemPromptResult('', context, { skillActive: true });
}
