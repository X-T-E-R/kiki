/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  readRetryAfterMs,
  retryBackoffDelays,
  retryErrorFields,
  sleepForRetry,
} from '#/_base/utils/retry';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { Event2, registerEvent2Class } from '#/app/event/event2';
import { unwrapErrorCause } from '#/errors';
import {
  IAgentLoopService,
  type LoopErrorContext,
} from '#/agent/loop/loop';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/agent/loop/configSection';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { RETRY_SECTION, type RetryConfig } from './configSection';
import { resolveRetryPolicy } from './retryPolicy';
import { IAgentStepRetryService } from './stepRetry';

const DEFAULT_STEP_RETRY_BASE_DELAY_MS = 2_000;

export interface TurnStepRetryingPayload {
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

const turnStepRetryingSchema = z.object({
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
  failedAttempt: z.number(),
  nextAttempt: z.number(),
  maxAttempts: z.number(),
  delayMs: z.number(),
  errorName: z.string(),
  errorMessage: z.string(),
  statusCode: z.number().optional(),
});

export class TurnStepRetrying extends Event2<TurnStepRetryingPayload> {
  static override readonly type = 'turn.step.retrying';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = turnStepRetryingSchema;
}
export interface TurnStepRetrying extends TurnStepRetryingPayload {}
registerEvent2Class(TurnStepRetrying);

export const stepRetryLastFailedDriverIdKey = defineState<string | undefined>(
  'stepRetry.lastFailedDriverId',
  () => undefined as string | undefined,
);
export const stepRetryFailedAttemptsKey = defineState<number>(
  'stepRetry.failedAttempts',
  () => 0,
);

export class AgentStepRetryService extends Disposable implements IAgentStepRetryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IConfigService private readonly config: IConfigService,
    @IEventBus private readonly eventBus: IEventBus,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(stepRetryLastFailedDriverIdKey);
    this.states.contributeState(stepRetryFailedAttemptsKey);
    this._register(
      this.loopService.registerLoopErrorHandler({
        id: 'step-retry',
        match: (context) => this.shouldRetry(context.error),
        handle: (context) => this.recover(context),
      }),
    );
    this._register(
      this.loopService.hooks.onDidFinishStep.register('step-retry', async (_ctx, next) => {
        this.resetAttempts();
        await next();
      }),
    );
    this._register(this.eventBus.subscribe(TurnStarted, () => this.resetAttempts()));
  }

  private get lastFailedDriverId(): string | undefined {
    return this.states.get(stepRetryLastFailedDriverIdKey);
  }

  private set lastFailedDriverId(value: string | undefined) {
    this.states.set(stepRetryLastFailedDriverIdKey, value);
  }

  private get failedAttempts(): number {
    return this.states.get(stepRetryFailedAttemptsKey);
  }

  private set failedAttempts(value: number) {
    this.states.set(stepRetryFailedAttemptsKey, value);
  }

  private resetAttempts(): void {
    this.lastFailedDriverId = undefined;
    this.failedAttempts = 0;
  }

  private retryConfig(): RetryConfig | undefined {
    return this.config.get<RetryConfig | undefined>(RETRY_SECTION);
  }

  private shouldRetry(error: unknown): boolean {
    return resolveRetryPolicy(this.retryConfig(), unwrapErrorCause(error)).retry;
  }

  private async recover(context: LoopErrorContext): Promise<boolean> {
    const driver = context.failedDriver;
    if (driver === undefined || context.step === undefined) return false;

    if (this.lastFailedDriverId !== driver.id) {
      this.lastFailedDriverId = driver.id;
      this.failedAttempts = 0;
    }
    this.failedAttempts += 1;

    const error = unwrapErrorCause(context.error);
    const retryConfig = this.retryConfig();
    const decision = resolveRetryPolicy(retryConfig, error);
    const maxAttempts = Math.max(
      decision.maxAttempts ??
        retryConfig?.maxAttempts ??
        this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxAttemptsPerStep ??
        DEFAULT_MAX_RETRY_ATTEMPTS,
      1,
    );
    if (this.failedAttempts >= maxAttempts) {
      this.resetAttempts();
      return false;
    }

    const delayMs =
      readRetryAfterMs(error) ??
      decision.backoffMs ??
      retryBackoffDelays(maxAttempts, DEFAULT_STEP_RETRY_BASE_DELAY_MS)[
        this.failedAttempts - 1
      ] ??
      0;
    void this.dispatcher.dispatch(
      new TurnStepRetrying({
        turnId: context.turnId,
        step: context.step,
        stepId: context.stepId,
        failedAttempt: this.failedAttempts,
        nextAttempt: this.failedAttempts + 1,
        maxAttempts,
        delayMs,
        ...retryErrorFields(error),
      }),
    );
    await sleepForRetry(delayMs, context.signal);

    if (context.currentStep?.signal.aborted === true) return false;
    context.retry(driver, { at: 'head' });
    return true;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentStepRetryService,
  AgentStepRetryService,
  ScopeActivation.OnScopeCreated,
  'stepRetry',
);
