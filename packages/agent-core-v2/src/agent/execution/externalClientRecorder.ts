import { ExternalActivity, ExternalText, externalClientOrigin } from './externalClientEvents';
import type { ExternalClientSessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import type { AgentExecutorAgentContext } from '#/app/agentExecutor/agentExecutor';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentStateService } from '#/agent/state/agentState';
import { TurnEnded, turnKey } from '#/agent/loop/turnOps';
import { TurnStarted, TurnStepCompleted, TurnStepInterrupted } from '#/agent/loop/turnEvents';
import type { ContentPart } from '#/kosong/contract/message';
import type { ToolExecutionResult } from '#/agent/toolExecutor/toolExecutor';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { toKimiErrorPayload } from '#/errors';

export interface ExternalClientRecorderOptions extends ExternalClientSessionMeta {
  readonly operationId: string;
  readonly activityId?: string;
  readonly toolCallId?: string;
}

export interface ExternalClientRecorderSourceOptions {
  readonly source: ExternalClientSessionMeta;
  readonly operationId: string;
  readonly activityId?: string;
  readonly toolCallId?: string;
}

export interface ExternalToolCallInput {
  readonly toolCallId?: string;
  readonly name?: string;
  readonly args?: unknown;
}

export interface ExternalToolResultInput {
  readonly toolCallId?: string;
  readonly output: string | readonly ContentPart[];
  readonly isError?: boolean;
  readonly note?: string;
  readonly errorCode?: string;
}

export interface ExternalTextInput {
  readonly recordId?: string;
  readonly idempotencyKey?: string;
  readonly text: string;
  readonly kind: 'note' | 'user_excerpt' | 'assistant_excerpt' | 'handoff';
  readonly title?: string;
  readonly relatedOperationIds?: readonly string[];
  readonly related_operation_ids?: readonly string[];
  readonly sourceUrl?: string;
  readonly source_url?: string;
  readonly clientTime?: string;
  readonly client_time?: string;
}

export interface ExternalTextReceipt {
  readonly recordId: string;
  readonly turnId: number;
  readonly operationId: string;
}

export class ExternalClientRecorder {
  readonly turnId: number;
  readonly stepId: string;
  readonly activityId: string;
  readonly operationId: string;
  readonly source: ExternalClientSessionMeta;
  private readonly dispatcher: IEventDispatcher;
  private readonly context: IAgentContextMemoryService;
  private toolName = '';
  private toolCallId: string;
  private input: unknown;
  private started = false;
  private ended = false;
  private toolCallRecorded = false;
  private toolResultRecorded = false;
  private startedAt = 0;

  constructor(
    agent: AgentExecutorAgentContext,
    options: ExternalClientRecorderOptions | ExternalClientRecorderSourceOptions,
  ) {
    this.source = 'source' in options ? options.source : {
      connectionId: options.connectionId,
      clientName: options.clientName,
      sessionRef: options.sessionRef,
      driver: options.driver,
    };
    this.operationId = options.operationId;
    this.activityId = options.activityId ?? options.operationId;
    this.toolCallId = options.toolCallId ?? `external:${encodeURIComponent(this.source.sessionRef)}:${encodeURIComponent(this.operationId)}`;
    this.dispatcher = agent.accessor.get(IEventDispatcher);
    this.context = agent.accessor.get(IAgentContextMemoryService);
    const states = agent.accessor.get(IAgentStateService);
    const current = states.get(turnKey);
    this.turnId = current.nextTurnId;
    states.set(turnKey, { ...current, nextTurnId: current.nextTurnId + 1 });
    this.stepId = `external-step-${this.turnId}-${encodeURIComponent(this.activityId)}`;
  }

  async begin(toolName: string, input?: unknown): Promise<void> {
    if (this.started) return;
    if (this.ended) throw new Error('External client activity has already ended');
    this.toolName = toolName;
    this.input = input;
    this.startedAt = Date.now();
    await this.dispatcher.dispatch(new ExternalActivity({
      activityId: this.activityId,
      phase: 'started',
      operationId: this.operationId,
      toolCallId: this.toolCallId,
      toolName,
      turnId: this.turnId,
      source: this.source,
      input,
    }));
    await this.dispatcher.dispatch(new TurnStarted({
      turnId: this.turnId,
      origin: externalClientOrigin(this.source),
      source: 'external',
    }));
    this.started = true;
    this.context.appendLoopEvent({
      type: 'step.begin',
      uuid: this.stepId,
      turnId: String(this.turnId),
      step: 1,
    });
    await this.dispatcher.flush();
  }

  toolCall(call: ExternalToolCallInput = {}): void {
    this.assertStarted();
    if (this.toolCallRecorded) return;
    this.toolCallId = call.toolCallId ?? this.toolCallId;
    this.toolName = call.name ?? this.toolName;
    const args = call.args === undefined ? this.input : call.args;
    this.context.appendLoopEvent({
      type: 'tool.call',
      stepUuid: this.stepId,
      toolCallId: this.toolCallId,
      name: this.toolName,
      args,
      uuid: `${this.stepId}:tool:${this.toolCallId}`,
      turnId: String(this.turnId),
      step: 1,
    });
    this.toolCallRecorded = true;
  }

  async toolResult(result: ToolExecutionResult | ExternalToolResultInput): Promise<void> {
    this.assertStarted();
    const normalized = normalizeToolResult(result, this.toolCallId);
    if (!this.toolCallRecorded) this.toolCall({ toolCallId: normalized.toolCallId });
    if (this.toolResultRecorded) return;
    this.context.appendLoopEvent({
      type: 'tool.result',
      toolCallId: normalized.toolCallId,
      result: {
        output: normalized.output,
        isError: normalized.isError,
        note: normalized.note,
        errorCode: normalized.errorCode,
      },
      parentUuid: `${this.stepId}:tool:${normalized.toolCallId}`,
    });
    this.toolResultRecorded = true;
    await this.dispatcher.flush();
  }

  async saveText(input: ExternalTextInput): Promise<ExternalTextReceipt> {
    if (!this.started) await this.begin('kiki_save_text', { text: input.text, kind: input.kind, title: input.title });
    this.assertStarted();
    const recordId = input.recordId ?? input.idempotencyKey ?? `${this.activityId}:text`;
    const relatedOperationIds = input.relatedOperationIds ?? input.related_operation_ids ?? [this.operationId];
    await this.dispatcher.dispatch(new ExternalText({
      recordId,
      turnId: this.turnId,
      text: input.text,
      kind: input.kind,
      title: input.title,
      relatedOperationIds,
      sourceUrl: input.sourceUrl ?? input.source_url,
      clientTime: input.clientTime ?? input.client_time,
      source: this.source,
    }));
    await this.dispatcher.flush();
    return { recordId, turnId: this.turnId, operationId: this.operationId };
  }

  async end(reason: 'completed' | 'failed' | 'cancelled', error?: unknown): Promise<void> {
    this.assertStarted();
    if (this.ended) return;
    if (this.toolCallRecorded && !this.toolResultRecorded) {
      await this.toolResult({
        toolCallId: this.toolCallId,
        output: error instanceof Error ? error.message : 'External activity ended before a tool result was recorded.',
        isError: true,
      });
    }
    this.ended = true;
    const activityPhase = reason === 'failed' ? 'failed' : reason === 'cancelled' ? 'cancelled' : 'completed';
    const errorMessage = error === undefined
      ? undefined
      : error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : JSON.stringify(error);
    const finishReason = reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'interrupted' : 'error';
    this.context.appendLoopEvent({
      type: 'step.end',
      uuid: this.stepId,
      turnId: String(this.turnId),
      step: 1,
      finishReason,
    });
    if (reason === 'completed') {
      await this.dispatcher.dispatch(new TurnStepCompleted({
        turnId: this.turnId,
        step: 1,
        stepId: this.stepId,
        finishReason,
      }));
    } else {
      await this.dispatcher.dispatch(new TurnStepInterrupted({
        turnId: this.turnId,
        step: 1,
        stepId: this.stepId,
        reason: finishReason,
        message: errorMessage,
      }));
    }
    await this.dispatcher.dispatch(new ExternalActivity({
      activityId: this.activityId,
      phase: activityPhase,
      operationId: this.operationId,
      toolCallId: this.toolCallId,
      toolName: this.toolName,
      turnId: this.turnId,
      source: this.source,
      input: this.input,
      error: errorMessage,
    }));
    await this.dispatcher.dispatch(new TurnEnded({
      turnId: this.turnId,
      reason,
      error: reason === 'failed' ? toKimiErrorPayload(error ?? new Error('External client activity failed')) : undefined,
      durationMs: Math.max(0, Date.now() - this.startedAt),
    }));
    await this.dispatcher.flush();
  }

  private assertStarted(): void {
    if (!this.started) throw new Error('External client activity has not started');
  }
}

function normalizeToolResult(
  input: ToolExecutionResult | ExternalToolResultInput,
  fallbackToolCallId: string,
): ExternalToolResultInput & { readonly toolCallId: string } {
  if ('result' in input) {
    return {
      toolCallId: input.toolCallId,
      output: input.result.output,
      isError: input.result.isError,
      note: input.result.note,
    };
  }
  return { ...input, toolCallId: input.toolCallId ?? fallbackToolCallId };
}
