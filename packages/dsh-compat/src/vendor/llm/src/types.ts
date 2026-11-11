import type { Branded } from '../../brand/src/index';
import type { FileAttachmentRef, ImageAttachmentRef } from '../../attachment/src/types';
import type { MessageId, ProviderRequestId, ReasoningEffortId, ToolCallId } from './brand';
import type { Message, UserMessage } from './message';

export interface LlmFailure {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
  readonly requestId?: ProviderRequestId;
  readonly offloadImages?: number;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ReasoningBlock {
  type: 'reasoning';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  attachment: ImageAttachmentRef;
  offloaded?: true;
}

export interface FileBlock {
  type: 'file';
  attachment: FileAttachmentRef;
}

export interface ToolCallBlock {
  type: 'tool-call';
  id: ToolCallId;
  name: string;
  arguments: string;
}

export interface ToolAdditionBlock {
  type: 'tool-addition';
  toolName: string;
  tool?: never;
}

export interface ToolRemovalBlock {
  type: 'tool-removal';
  toolName: string;
}

export interface ResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

export interface ContentBlockMap {
  text: TextBlock;
  reasoning: ReasoningBlock;
  image: ImageBlock;
  file: FileBlock;
  'tool-call': ToolCallBlock;
  'tool-addition': ToolAdditionBlock;
  'tool-removal': ToolRemovalBlock;
  resource_link: ResourceLinkBlock;
}

export type ContentBlockType = keyof ContentBlockMap;
export type ContentBlock = ContentBlockMap[ContentBlockType];

export interface FinishReasonMap {
  stop: { kind: 'stop' };
  'tool-calls': { kind: 'tool-calls' };
  'max-tokens': { kind: 'max-tokens' };
  aborted: { kind: 'aborted'; failure: LlmFailure };
  error: { kind: 'error'; failure: LlmFailure };
}

export type FinishReason = FinishReasonMap[keyof FinishReasonMap];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ModelModalityMap {
  text: 'text';
  image: 'image';
}

export type ModelModality = ModelModalityMap[keyof ModelModalityMap];

export interface LlmModelInfo {
  provider: string;
  id: string;
  name: string;
  description?: string;
  inputModalities?: readonly ModelModality[];
}

export interface LlmModelContext {
  contextWindow: number;
}

export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: LlmModelContext;
  defaultMaxTokens?: number;
}

export interface ToolSchema {
  deferLoading?: true;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RequestUserInput {
  readonly role: 'user';
  readonly content: UserMessage['content'];
  readonly id?: never;
  readonly source?: never;
}

export type RequestMessage = Message | RequestUserInput;

export interface ToolHistory {
  readonly tools: readonly ToolSchema[];
  readonly updates: readonly {
    readonly messageId: MessageId;
    readonly additions: readonly ToolSchema[];
  }[];
}

export interface GenerateOptions {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffortId;
  messages: RequestMessage[];
  system?: string;
  tools?: ToolSchema[];
  toolHistory?: ToolHistory;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
  sessionId?: Branded<'SessionId'>;
  purpose?: 'compaction' | 'session-title';
}
