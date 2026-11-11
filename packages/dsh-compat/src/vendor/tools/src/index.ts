import type { JsonValue } from '../../util-values/src/index';
import type { ToolCallId } from '../../llm/src/brand';
import type { UserMessage } from '../../llm/src/message';
import type { ContentBlock, ToolSchema } from '../../llm/src/types';
import { HarnessError } from '../../llm/src/error';
import type { JsonSchemaNode } from './json-schema';
import type { ToolCallView, ToolResultView } from './presentation';
import type { DshLiveAgentFacade } from '../../../index';

export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode;
  render(args: unknown, value: JsonValue): ContentBlock[];
  presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}

export interface ToolResult {
  content: ContentBlock[];
  isError: boolean;
  meta?: JsonValue;
}

declare const toolExecutionTokenBrand: unique symbol;

export type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true };

export interface ToolExecutionInput {
  readonly callId: ToolCallId | string;
  readonly rootCallId?: ToolCallId | string;
  readonly name: string;
  readonly schema?: ToolSchema;
  readonly arguments: unknown;
  readonly agent?: DshLiveAgentFacade;
  readonly parent?: ToolExecutionToken;
  readonly signal: AbortSignal;
}

export type ToolExecutionMode =
  | { kind: 'parallel' }
  | { kind: 'exclusive' };

export interface ToolExecution extends ToolExecutionInput {
  readonly callId: ToolCallId;
  readonly rootCallId: ToolCallId;
  readonly token: ToolExecutionToken;
}

export interface ToolDispatchExecution extends Omit<ToolExecution, 'signal'> {
  signal: AbortSignal;
}

export interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void;
  concludeTurn(): void;
}

export interface ToolErrorInfo {
  name: string;
  code: string;
  reason?: string;
}

export interface ToolFailure {
  message: string;
  info?: ToolErrorInfo;
}

export class ToolNotFoundError extends HarnessError {
  constructor(toolName: string, reachableFrom?: string) {
    super(
      reachableFrom === undefined
        ? `unknown tool "${toolName}"`
        : `unknown tool "${toolName}": ${reachableFrom}`,
      'UNKNOWN_TOOL',
    );
  }
}

export class ToolOutputError extends HarnessError {
  readonly violations: string[];

  constructor(toolName: string, violations: string[]) {
    super(`tool "${toolName}" returned invalid output: ${violations.join('; ')}`, 'INVALID_TOOL_OUTPUT');
    this.violations = violations;
  }
}

export interface ToolExecutionSuccess {
  readonly isError: false;
  readonly value: JsonValue;
  readonly content: ContentBlock[];
  readonly error?: never;
  readonly meta?: JsonValue;
  readonly additionalContexts?: UserMessage[];
  readonly concludesTurn?: true;
}

export interface ToolExecutionFailure {
  readonly isError: true;
  readonly error: ToolFailure;
  readonly value?: never;
  readonly content: ContentBlock[];
  readonly meta?: JsonValue;
  readonly additionalContexts?: UserMessage[];
  readonly concludesTurn?: never;
}

export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure;

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel'; reason?: string }
  | { kind: 'ask'; reason?: string; displayReason?: { readonly en: string; readonly [locale: string]: string } | string };

export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] };

export interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition;
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
  projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
  timeoutMs?: number;
  isConcurrencySafe?(args: unknown): boolean;
  presentCall?(args: unknown): ToolCallView | undefined;
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}

export const TOOL_ABORTED = 'ABORTED';
export const TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH';
