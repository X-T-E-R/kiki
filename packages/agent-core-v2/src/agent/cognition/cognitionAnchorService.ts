import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile/profile';

import {
  IAgentCognitionAnchorService,
  type CognitionAnchorProjectionInput,
} from './cognitionAnchor';

const DEFAULT_ANCHOR_STEPS = 1;
const DEFAULT_ANCHOR_SCOPE = 'session';
const FIRST_TURN_ID = 0;

/** Projects the current binding's anchor onto eligible turn requests. */
export class AgentCognitionAnchorService implements IAgentCognitionAnchorService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {}

  async project(input: CognitionAnchorProjectionInput): Promise<string | undefined> {
    if (input.sourceType !== 'turn' || input.turnId === undefined || input.hasExplicitSystemPrompt) return undefined;
    const binding = input.binding ?? await this.profile.getCognitionBinding();
    const cognition = binding.config;
    if (!stepWithinAnchorWindow(input.step, cognition?.anchorSteps ?? DEFAULT_ANCHOR_STEPS)) {
      return undefined;
    }
    if (
      (cognition?.anchorScope ?? DEFAULT_ANCHOR_SCOPE) !== 'turn' &&
      input.turnId !== FIRST_TURN_ID
    ) {
      return undefined;
    }
    return binding.anchor;
  }
}

function stepWithinAnchorWindow(step: number | undefined, anchorSteps: number): boolean {
  return step !== undefined && step >= 1 && step <= anchorSteps;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentCognitionAnchorService,
  AgentCognitionAnchorService,
  ScopeActivation.OnScopeCreated,
  'cognition',
);
