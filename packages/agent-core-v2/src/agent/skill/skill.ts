import { createDecorator } from "#/_base/di/instantiation";
import type { SkillActivationOrigin } from '#/agent/contextMemory/types';
import type { DeferredAppendTiming, PromptExecutionBinding, PromptLaunchResult, PromptReservation } from '#/agent/prompt/prompt';
import type { ContentPart } from '#/kosong/contract/message';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
  readonly content?: readonly ContentPart[];
}

export interface PromptSkillActivation {
  readonly name: string;
  readonly args?: string;
}

export interface PromptWithSkillsInput {
  readonly input: readonly ContentPart[];
  readonly skills: readonly PromptSkillActivation[];
  readonly execution?: PromptExecutionBinding;
  readonly appendTiming?: DeferredAppendTiming;
  readonly deferredDisabledTools?: readonly string[];
}

export interface PromptWithSkillsResult {
  readonly turn_id?: number;
  readonly prompt_id: string;
  readonly created_at: string;
  readonly state: 'running' | 'queued' | 'blocked';
  readonly append_timing: DeferredAppendTiming;
  readonly revision: number;
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  activate(input: SkillActivationInput): Promise<PromptLaunchResult>;
  promptWithSkills(input: PromptWithSkillsInput): Promise<PromptWithSkillsResult>;
  recordModelToolActivation(origin: SkillActivationOrigin): void;
}

export const skillPromptAdmission = Symbol('skillPromptAdmission');

type SkillPromptAdmissionHook = (
  input: PromptWithSkillsInput,
  reservation: PromptReservation,
) => Promise<PromptWithSkillsResult>;

export function submitReservedSkillPrompt(
  service: IAgentSkillService,
  input: PromptWithSkillsInput,
  reservation: PromptReservation,
): Promise<PromptWithSkillsResult> {
  return (service as IAgentSkillService & { [skillPromptAdmission]: SkillPromptAdmissionHook })[
    skillPromptAdmission
  ](input, reservation);
}

export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
