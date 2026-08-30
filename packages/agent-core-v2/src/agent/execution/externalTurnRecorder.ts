import { randomUUID } from 'node:crypto';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import {
  AssistantDelta,
  ThinkingDelta,
  ToolCallDelta,
  TurnStarted,
  TurnStepCompleted,
  TurnStepInterrupted,
  TurnStepStarted,
} from '#/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '#/agent/loop/turnOps';
import { ToolCallStarted, ToolProgress, ToolResultEvent } from '#/agent/toolExecutor/toolExecutorEvents';
import type { AgentExecutorAgentContext } from '#/app/agentExecutor/agentExecutor';
import { toKimiErrorPayload } from '#/errors';
import type { ContentPart } from '#/kosong/contract/message';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';

import {
  ExecutorPlanRemove,
  ExecutorPlanUpdate,
  ExecutorRuntimeUpdate,
  ExecutorTurnMetadata,
  type ExecutorLossCode,
  type ExecutorProfileDelivery,
  type ExecutorResumeMode,
} from './externalExecutorOps';

export type ExternalExecutorContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name?: string }
  | { readonly type: 'opaque'; readonly contentType: string };

export type ExternalExecutorEvent =
  | {
      readonly type: 'message.delta';
      readonly role: 'user' | 'assistant';
      readonly messageId?: string;
      readonly content: ExternalExecutorContent;
    }
  | {
      readonly type: 'thought.delta';
      readonly messageId?: string;
      readonly content: ExternalExecutorContent;
    }
  | {
      readonly type: 'tool.call';
      readonly toolCallId: string;
      readonly title: string;
      readonly kind?: string;
      readonly status?: string;
      readonly rawInput?: unknown;
      readonly content?: readonly unknown[];
      readonly locations?: readonly unknown[];
    }
  | {
      readonly type: 'tool.update';
      readonly toolCallId: string;
      readonly title?: string;
      readonly kind?: string;
      readonly status?: string;
      readonly rawInput?: unknown;
      readonly rawOutput?: unknown;
      readonly content?: readonly unknown[];
      readonly locations?: readonly unknown[];
    }
  | { readonly type: 'plan.update'; readonly plan: unknown; readonly unstable: boolean }
  | { readonly type: 'plan.remove'; readonly planId?: string; readonly unstable: true }
  | { readonly type: 'commands.update'; readonly commands: readonly unknown[] }
  | { readonly type: 'mode.update'; readonly currentModeId: string }
  | { readonly type: 'config.update'; readonly configOptions: readonly unknown[] }
  | { readonly type: 'session.info'; readonly title?: string; readonly meta?: unknown }
  | { readonly type: 'usage'; readonly used: number; readonly size: number; readonly cost?: unknown }
  | { readonly type: 'unknown'; readonly updateType: string };

export interface ExternalTurnRecorderMetadata {
  readonly executorId: string;
  readonly protocol: string;
  readonly resumeMode: ExecutorResumeMode;
  readonly profileDelivery: ExecutorProfileDelivery;
  readonly outboundPrompt?: string;
  readonly initialLosses?: readonly ExecutorLossCode[];
}

interface Segment {
  readonly kind: 'text' | 'think';
  readonly messageId?: string;
  text: string;
}

interface UserSegment {
  readonly messageId?: string;
  text: string;
}

interface RecordedTool {
  readonly remoteId: string;
  readonly namespacedId: string;
  title: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  terminal: boolean;
}

const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed']);
const MAX_BOUNDED_JSON_BYTES = 32 * 1024;

export class ExternalTurnRecorder {
  readonly stepId: string;
  readonly losses = new Set<ExecutorLossCode>();
  readonly #dispatcher: IEventDispatcher;
  readonly #wire: IWireService;
  readonly #context: IAgentContextMemoryService;
  readonly #segments: Segment[] = [];
  readonly #userSegments: UserSegment[] = [];
  readonly #tools = new Map<string, RecordedTool>();
  #partOrdinal = 0;
  #ended = false;
  #lastAssistantText = '';

  constructor(
    private readonly agent: AgentExecutorAgentContext,
    readonly turnId: number,
    readonly remoteSessionId: string,
    readonly metadata: ExternalTurnRecorderMetadata,
  ) {
    this.stepId = `external-step-${turnId}-${randomUUID()}`;
    this.#dispatcher = agent.accessor.get(IEventDispatcher);
    this.#wire = agent.accessor.get(IWireService);
    this.#context = agent.accessor.get(IAgentContextMemoryService);
    for (const loss of metadata.initialLosses ?? []) this.losses.add(loss);
  }

  async begin(prompt: string, origin: PromptOrigin): Promise<void> {
    await this.#dispatcher.dispatch(
      new TurnPrompt({
        turnId: this.turnId,
        input: [{ type: 'text', text: prompt }],
        origin,
      }),
    );
    await this.#dispatcher.dispatch(
      new TurnStarted({ turnId: this.turnId, origin, prompt }),
    );
    await this.#dispatcher.dispatch(
      new TurnStepStarted({ turnId: this.turnId, step: 1, stepId: this.stepId }),
    );
    this.#context.appendLoopEvent({
      type: 'step.begin',
      uuid: this.stepId,
      turnId: String(this.turnId),
      step: 1,
    });
  }

  async record(event: ExternalExecutorEvent): Promise<void> {
    switch (event.type) {
      case 'message.delta':
        await this.#messageDelta(event);
        return;
      case 'thought.delta':
        await this.#thoughtDelta(event);
        return;
      case 'tool.call':
        await this.#toolCall(event);
        return;
      case 'tool.update':
        await this.#toolUpdate(event);
        return;
      case 'plan.update':
        if (event.unstable) this.losses.add('unstable_acp_plan');
        await this.#dispatcher.dispatch(
          new ExecutorPlanUpdate({
            turnId: this.turnId,
            plan: boundedUnknown(event.plan),
            unstable: event.unstable,
          }),
        );
        return;
      case 'plan.remove':
        this.losses.add('unstable_acp_plan');
        await this.#dispatcher.dispatch(
          new ExecutorPlanRemove({
            turnId: this.turnId,
            planId: event.planId,
            unstable: true,
          }),
        );
        return;
      case 'commands.update':
        await this.#runtimeUpdate('commands', boundedUnknown(event.commands));
        return;
      case 'mode.update':
        await this.#runtimeUpdate('mode', event.currentModeId);
        return;
      case 'config.update':
        await this.#runtimeUpdate('config', boundedUnknown(event.configOptions));
        return;
      case 'session.info':
        await this.#runtimeUpdate(
          'session',
          boundedUnknown({ title: event.title, meta: event.meta }),
        );
        return;
      case 'usage':
        this.losses.add('usage_context_only');
        await this.#runtimeUpdate('usage', boundedUnknown(event));
        return;
      case 'unknown':
        this.losses.add('unknown_update_dropped');
        await this.#runtimeUpdate('unknown', { updateType: event.updateType });
    }
  }

  async complete(finishReason?: string): Promise<void> {
    await this.#end('completed', finishReason);
  }

  async fail(error: unknown): Promise<void> {
    await this.#end('failed', 'error', error);
  }

  async cancel(reason: unknown): Promise<void> {
    await this.#end('cancelled', 'cancelled', reason);
  }

  summary(): string {
    return this.#lastAssistantText;
  }

  toolCallId(remoteToolCallId: string): string {
    return `external:${encodeURIComponent(this.remoteSessionId)}:${remoteToolCallId}`;
  }

  async #messageDelta(
    event: Extract<ExternalExecutorEvent, { type: 'message.delta' }>,
  ): Promise<void> {
    if (event.role === 'user') {
      this.#userDelta(event);
      return;
    }
    if (event.content.type !== 'text') {
      this.losses.add('unknown_update_dropped');
      return;
    }
    if (event.messageId === undefined) this.losses.add('message_id_missing');
    this.#appendSegment('text', event.messageId, event.content.text);
    this.#lastAssistantText += event.content.text;
    await this.#dispatcher.dispatch(
      new AssistantDelta({
        turnId: this.turnId,
        step: 1,
        stepId: this.stepId,
        partId: event.messageId,
        delta: event.content.text,
      }),
    );
  }

  async #thoughtDelta(
    event: Extract<ExternalExecutorEvent, { type: 'thought.delta' }>,
  ): Promise<void> {
    if (event.content.type !== 'text') {
      this.losses.add('unknown_update_dropped');
      return;
    }
    if (event.messageId === undefined) this.losses.add('message_id_missing');
    this.#appendSegment('think', event.messageId, event.content.text);
    await this.#dispatcher.dispatch(
      new ThinkingDelta({
        turnId: this.turnId,
        step: 1,
        stepId: this.stepId,
        partId: event.messageId,
        delta: event.content.text,
      }),
    );
  }

  #userDelta(event: Extract<ExternalExecutorEvent, { type: 'message.delta' }>): void {
    if (this.metadata.outboundPrompt === undefined) {
      this.losses.add('user_message_attribution_missing');
    }
    if (event.messageId === undefined) {
      this.losses.add('message_id_missing');
      this.losses.add('user_message_attribution_missing');
    }
    const text = externalContentText(event.content);
    const current = this.#userSegments.at(-1);
    if (current !== undefined && current.messageId === event.messageId) {
      current.text += text;
      return;
    }
    this.#userSegments.push({ messageId: event.messageId, text });
  }

  #appendSegment(kind: Segment['kind'], messageId: string | undefined, text: string): void {
    const current = this.#segments.at(-1);
    if (current !== undefined && current.kind === kind && current.messageId === messageId) {
      current.text += text;
      return;
    }
    this.#segments.push({ kind, messageId, text });
  }

  async #toolCall(event: Extract<ExternalExecutorEvent, { type: 'tool.call' }>): Promise<void> {
    const namespacedId = this.toolCallId(event.toolCallId);
    const tool: RecordedTool = {
      remoteId: event.toolCallId,
      namespacedId,
      title: event.title,
      kind: event.kind,
      status: event.status,
      rawInput: boundedUnknown(event.rawInput),
      terminal: false,
    };
    if (event.rawInput === undefined) this.losses.add('tool_input_partial');
    this.#tools.set(event.toolCallId, tool);
    this.#context.appendLoopEvent({
      type: 'tool.call',
      stepUuid: this.stepId,
      toolCallId: namespacedId,
      name: event.title,
      args: tool.rawInput,
      extras: boundedRecord({
        remoteToolCallId: event.toolCallId,
        kind: event.kind,
        status: event.status,
        locations: event.locations,
      }),
      uuid: `${this.stepId}:tool:${event.toolCallId}`,
      turnId: String(this.turnId),
      step: 1,
    });
    await this.#dispatcher.dispatch(
      new ToolCallStarted({
        turnId: this.turnId,
        toolCallId: namespacedId,
        name: event.title,
        args: tool.rawInput,
        description: event.kind,
        display: {
          kind: 'generic',
          summary: event.title,
          detail: boundedUnknown({ kind: event.kind, locations: event.locations }),
        },
      }),
    );
  }

  async #toolUpdate(event: Extract<ExternalExecutorEvent, { type: 'tool.update' }>): Promise<void> {
    let tool = this.#tools.get(event.toolCallId);
    if (tool === undefined) {
      tool = {
        remoteId: event.toolCallId,
        namespacedId: this.toolCallId(event.toolCallId),
        title: event.title ?? event.kind ?? 'External tool',
        kind: event.kind,
        status: event.status,
        rawInput: boundedUnknown(event.rawInput),
        terminal: false,
      };
      this.#tools.set(event.toolCallId, tool);
      await this.#toolCall({
        type: 'tool.call',
        toolCallId: event.toolCallId,
        title: tool.title,
        kind: event.kind,
        status: event.status,
        rawInput: event.rawInput,
        content: event.content,
        locations: event.locations,
      });
      tool = this.#tools.get(event.toolCallId)!;
    }
    if (event.title !== undefined) tool.title = event.title;
    if (event.kind !== undefined) tool.kind = event.kind;
    if (event.status !== undefined) tool.status = event.status;
    if (event.rawInput !== undefined) tool.rawInput = boundedUnknown(event.rawInput);
    if (!TERMINAL_TOOL_STATUSES.has(event.status ?? '')) {
      await this.#dispatcher.dispatch(
        new ToolProgress({
          turnId: this.turnId,
          toolCallId: tool.namespacedId,
          update: {
            kind: 'status',
            text: event.status ?? summarizeContent(event.content),
            customData: boundedUnknown({
              title: event.title,
              kind: event.kind,
              locations: event.locations,
            }),
          },
        }),
      );
      return;
    }
    const isError = event.status === 'failed';
    const output = event.rawOutput === undefined
      ? summarizeContent(event.content)
      : stringifyOutput(event.rawOutput);
    if (event.rawOutput === undefined) this.losses.add('tool_output_summary_only');
    this.#context.appendLoopEvent({
      type: 'tool.result',
      toolCallId: tool.namespacedId,
      result: {
        output,
        isError,
        note: event.rawOutput === undefined
          ? 'External tool output summarized from external executor content'
          : undefined,
      },
      parentUuid: `${this.stepId}:tool:${event.toolCallId}`,
    });
    tool.terminal = true;
    await this.#dispatcher.dispatch(
      new ToolResultEvent({
        turnId: this.turnId,
        toolCallId: tool.namespacedId,
        output,
        isError,
        synthetic: true,
      }),
    );
  }

  async #runtimeUpdate(
    kind: 'commands' | 'mode' | 'config' | 'session' | 'usage' | 'unknown',
    value: unknown,
  ): Promise<void> {
    await this.#dispatcher.dispatch(
      new ExecutorRuntimeUpdate({ turnId: this.turnId, kind, value }),
    );
  }

  async #end(
    reason: 'completed' | 'failed' | 'cancelled',
    finishReason?: string,
    error?: unknown,
  ): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    for (const segment of this.#segments) {
      const part: ContentPart = segment.kind === 'text'
        ? { type: 'text', text: segment.text }
        : { type: 'think', think: segment.text };
      this.#context.appendLoopEvent({
        type: 'content.part',
        stepUuid: this.stepId,
        part,
        uuid: `${this.stepId}:part:${this.#partOrdinal++}`,
        turnId: String(this.turnId),
        step: 1,
      });
    }
    for (const tool of this.#tools.values()) {
      if (tool.terminal) continue;
      this.#context.appendLoopEvent({
        type: 'tool.result',
        toolCallId: tool.namespacedId,
        result: {
          output: 'External tool did not report a terminal result before the turn ended.',
          isError: true,
        },
        parentUuid: `${this.stepId}:tool:${tool.remoteId}`,
      });
      await this.#dispatcher.dispatch(
        new ToolResultEvent({
          turnId: this.turnId,
          toolCallId: tool.namespacedId,
          output: 'External tool did not report a terminal result before the turn ended.',
          isError: true,
          synthetic: true,
        }),
      );
    }
    await this.#dispatcher.dispatch(
      new ExecutorTurnMetadata({
        turnId: this.turnId,
        executorId: this.metadata.executorId,
        protocol: this.metadata.protocol,
        resumeMode: this.metadata.resumeMode,
        profileDelivery: this.metadata.profileDelivery,
        fidelity: this.losses.size === 0 ? 'full' : 'degraded',
        losses: [...this.losses].toSorted(),
      }),
    );
    await this.#wire.flush();
    this.#context.appendLoopEvent({
      type: 'step.end',
      uuid: this.stepId,
      turnId: String(this.turnId),
      step: 1,
      finishReason,
      rawFinishReason: finishReason,
    });
    this.#appendExternalUserMessages();
    if (reason === 'completed') {
      await this.#dispatcher.dispatch(
        new TurnStepCompleted({
          turnId: this.turnId,
          step: 1,
          stepId: this.stepId,
          finishReason,
          rawFinishReason: finishReason,
        }),
      );
    } else {
      await this.#dispatcher.dispatch(
        new TurnStepInterrupted({
          turnId: this.turnId,
          step: 1,
          stepId: this.stepId,
          reason: reason === 'cancelled' ? 'aborted' : 'error',
          message: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
        }),
      );
    }
    await this.#dispatcher.dispatch(
      new TurnEnded({
        turnId: this.turnId,
        reason,
        error: reason === 'failed'
          ? toKimiErrorPayload(error ?? new Error('External executor failed'))
          : undefined,
        interruptReason: reason === 'failed' ? 'error' : reason === 'cancelled' ? 'aborted' : undefined,
      }),
    );
    await this.#wire.flush();
  }

  #appendExternalUserMessages(): void {
    let promptEchoSuppressed = false;
    for (const segment of this.#userSegments) {
      if (
        !promptEchoSuppressed &&
        this.metadata.outboundPrompt !== undefined &&
        segment.text === this.metadata.outboundPrompt
      ) {
        promptEchoSuppressed = true;
        continue;
      }
      this.#context.append({
        role: 'user',
        content: [{ type: 'text', text: segment.text }],
        toolCalls: [],
        id: segment.messageId,
        providerMessageId: segment.messageId,
        origin: {
          kind: 'system_trigger',
          name: `external-executor:${this.metadata.executorId}`,
        },
      });
    }
  }
}

function externalContentText(content: ExternalExecutorContent): string {
  switch (content.type) {
    case 'text':
      return content.text;
    case 'image':
      return `[External image: ${content.mimeType}]`;
    case 'resource_link':
      return `[External resource: ${content.name ?? content.uri} (${content.uri})]`;
    case 'opaque':
      return `[External content: ${content.contentType}]`;
  }
}

function boundedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return boundedUnknown(value) as Record<string, unknown>;
}

function boundedUnknown(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return String(value);
    if (Buffer.byteLength(json, 'utf8') <= MAX_BOUNDED_JSON_BYTES) return JSON.parse(json) as unknown;
    return { truncated: true, preview: json.slice(0, MAX_BOUNDED_JSON_BYTES) };
  } catch {
    return String(value);
  }
}

function summarizeContent(content: readonly unknown[] | undefined): string {
  if (content === undefined || content.length === 0) return '';
  const texts: string[] = [];
  for (const item of content) {
    const record = objectOf(item);
    const nested = objectOf(record?.['content']);
    const text = stringOf(nested?.['text']) ?? stringOf(record?.['text']);
    if (text !== undefined) texts.push(text);
  }
  if (texts.length > 0) return texts.join('\n');
  return stringifyOutput(content);
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json.slice(0, MAX_BOUNDED_JSON_BYTES);
  } catch {
    return String(value);
  }
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
