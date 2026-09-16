import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface CognitionAnchorProjectionInput {
  readonly sourceType: string | undefined;
  readonly turnId: number | undefined;
  readonly step: number | undefined;
  readonly hasExplicitSystemPrompt: boolean;
}

/** `cognition` domain — first-turn system-prompt anchor contract (Agent scope). Projects a slim
 *  replacement `systemPrompt` onto the opening LLM requests of a turn so the bound model's
 *  `[models.<alias>.cognition].anchor` text can govern early reasoning; it never mutates profile or
 *  turn-config snapshots, lasts `[models.<alias>.cognition].anchorSteps` (default 1) steps, and
 *  restarts each turn only when `anchorScope` is `turn` (default `session`). */
export interface IAgentCognitionAnchorService {
  readonly _serviceBrand: undefined;

  /**
   * Returns a full replacement system prompt when the step-scoped
   * anchor still applies; `undefined` leaves the requester's resolved
   * prompt unchanged.
   */
  project(input: CognitionAnchorProjectionInput): Promise<string | undefined>;
}

export const IAgentCognitionAnchorService: ServiceIdentifier<IAgentCognitionAnchorService> =
  createDecorator<IAgentCognitionAnchorService>('agentCognitionAnchorService');
