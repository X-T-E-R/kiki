import { createDecorator } from '#/_base/di/instantiation';
import type { ToolSource } from '#/tool/toolContract';

import type { ToolActivationPolicy } from './evaluate';

export interface IAgentToolPolicyService {
  readonly _serviceBrand: undefined;

  isToolActive(name: string, source?: ToolSource): boolean;
  isToolActiveForDisclosure(name: string, source?: ToolSource): boolean;
  /** Evaluates a prospective native subagent profile, not the caller's own identity. */
  isToolActiveForProfile(
    profile: ToolActivationPolicy,
    name: string,
    source?: ToolSource,
  ): boolean;
  setSessionDisabledTools(names: readonly string[]): Promise<void>;
}

export const IAgentToolPolicyService =
  createDecorator<IAgentToolPolicyService>('agentToolPolicyService');
