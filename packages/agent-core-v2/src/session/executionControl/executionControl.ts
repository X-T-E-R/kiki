import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { ProfileBindingSnapshot } from '#/agent/profile/profile';
import type { TurnSeed } from '#/agent/loop/stepRequest';

export interface ExecutionPendingTool {
  readonly call: import('#/kosong/contract/message').ToolCall;
  readonly callUuid?: string;
  readonly wait?: import('#/tool/toolContract').ExecutionTaskWait;
}

export interface ExecutionPendingStep {
  readonly stopTurn?: boolean;
  readonly forcedStopTurn?: boolean;
  readonly sendMessageCompletionBlocked?: boolean;
  readonly userDeliveryConfirmed?: boolean;
  readonly step: number;
  readonly stepId: string;
  readonly logicalStepId?: string;
  readonly attempt?: number;
  readonly response: import('#/agent/llmRequester/llmRequester').AgentLLMRequestFinish;
  readonly trace: import('#/kosong/contract/requestTrace').LLMRequestTrace;
  readonly tools: readonly ExecutionPendingTool[];
}

export interface ExecutionResumePoint {
  readonly pendingStep?: ExecutionPendingStep;
  readonly turnId: number;
  readonly completedSteps: number;
  readonly seed: TurnSeed;
  readonly binding: ProfileBindingSnapshot;
}

export interface ExecutionPauseAgent {
  readonly agentId: string;
  readonly state: 'settling' | 'paused' | 'idle' | 'unknown';
  readonly turnId?: number;
  readonly resumable: boolean;
  readonly detail?: string;
}

export interface ExecutionControlState {
  readonly phase: 'running' | 'pausing' | 'paused' | 'resuming' | 'failed';
  readonly pauseOperationId?: string;
  readonly resumeOperationId?: string;
  readonly cancelPauseOperationId?: string;
  readonly requestedAt?: string;
  readonly pausedAt?: string;
  readonly resumedAt?: string;
  readonly agents: readonly ExecutionPauseAgent[];
  readonly error?: string;
}

export interface ExecutionPauseParticipant {
  turnId?(): number | undefined;
  pause(signal: AbortSignal): Promise<ExecutionResumePoint | undefined>;
  resume(point?: ExecutionResumePoint): Promise<import('#/agent/loop/loop').Turn | undefined>;
}

export interface ISessionExecutionControl {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<ExecutionControlState>;
  read(): Promise<ExecutionControlState>;
  pause(input: { readonly operationId: string }): Promise<ExecutionControlState>;
  cancelPause(input: { readonly operationId: string; readonly pauseOperationId: string }): Promise<ExecutionControlState>;
  pauseSignal(): AbortSignal;
  isPausing(): boolean;
  isDurablyPaused(): boolean;
  resume(input: { readonly operationId: string; readonly pauseOperationId: string }): Promise<ExecutionControlState>;
  register(agentId: string, participant: ExecutionPauseParticipant): IDisposable;
  ready(): Promise<void>;
  isHeld(): boolean;
  resumePoint(agentId: string): ExecutionResumePoint | undefined;
  park(agentId: string): void;
  isParked(agentId: string): boolean;
  invalidate(agentId: string, turnId: number): Promise<void>;
  retainAgent(agentId: string): Promise<void>;
}

export const ISessionExecutionControl = createDecorator<ISessionExecutionControl>('sessionExecutionControl');
