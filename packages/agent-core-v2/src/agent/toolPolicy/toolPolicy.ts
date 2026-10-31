import { createDecorator } from '#/_base/di/instantiation';
import type { ToolSource } from '#/tool/toolContract';

import type { ToolActivationPolicy } from './evaluate';

export interface IAgentToolPolicyService {
  readonly _serviceBrand: undefined;

  isToolActive(name: string, source?: ToolSource): boolean;
  isToolActiveForDisclosure(name: string, source?: ToolSource): boolean;
  /**
   * Runs `evaluate` synchronously with one profile and capability-policy snapshot shared by every
   * activity check inside it. Nothing is retained after it returns; later checks read fresh state.
   */
  withSnapshot<T>(evaluate: () => T): T;
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

/** Runs `evaluate` inside the policy's shared snapshot; partial test doubles without one run it directly. */
export function withToolPolicySnapshot<T>(policy: IAgentToolPolicyService, evaluate: () => T): T {
  return typeof policy.withSnapshot === 'function' ? policy.withSnapshot(evaluate) : evaluate();
}
