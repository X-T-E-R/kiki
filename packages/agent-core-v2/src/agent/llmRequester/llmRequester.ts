import { createDecorator } from '#/_base/di/instantiation';
import type { AnthropicResponseCaptureInput, AnthropicResponseCaptureStatus } from './anthropicResponseCapture';
import type { FinishReason, ThinkingEffort } from '#/kosong/contract/provider';
import type { Message, StreamedMessagePart } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import type { ModelRequestTiming } from '#/kosong/model/modelRequester';
import type { LogContext } from '#/_base/log/log';

export type AgentLLMRequestLogFields = Readonly<LogContext>;

export type AgentLLMRequestSource =
  | {
      readonly type: 'turn';
      readonly turnId: number;
      readonly step?: number;
      readonly logFields?: AgentLLMRequestLogFields;
    }
  | {
      readonly type: 'operation';
      readonly turnId?: number;
      readonly requestKind?: string;
      readonly logFields?: AgentLLMRequestLogFields;
    };

export interface AgentLLMRequestFinish {
  message: Message;
  usage: TokenUsage;
  model?: string | undefined;
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  providerMessageId?: string;
  timing?: ModelRequestTiming;
  traceId?: string;
}

export type AgentLLMRequestPartHandler = (part: StreamedMessagePart) => void | Promise<void>;

export interface AgentLLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly Tool[];
  systemPrompt?: string;
  source?: AgentLLMRequestSource;
  maxOutputSize?: number;
  onAttemptRetry?: () => void;
}

export interface AgentLLMRequestTask {
  readonly trace: LLMRequestTrace;
  readonly result: Promise<AgentLLMRequestFinish>;
}

export interface PreparedTurnRequestConfig {
  readonly thinkingEffort: ThinkingEffort;
}

export interface IAgentLLMRequesterService {
  readonly _serviceBrand: undefined;

  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined;
  invalidatePromptSnapshots(): number;
  /** Arms an in-memory, default-off diagnostic lease for this exact session/agent and provider/model/effort. Captures future Anthropic SSE bytes in a separate logs append-log, never request/auth headers or canonical history. Expiry is within two hours; 1–100 attempts, 8 MiB per response and 64 MiB per lease are ceilings, not coverage claims. */
  armAnthropicResponseCapture(input: AnthropicResponseCaptureInput): AnthropicResponseCaptureStatus;
  /** Flushes diagnostic records and returns their scope/key and capture health without returning payloads. Null means never armed; process or agent recreation does not restore a lease. */
  anthropicResponseCaptureStatus(): Promise<AnthropicResponseCaptureStatus | null>;
  /** Stops only the matching lease, including capture on active responses, without cancelling model requests; flushes retained records. */
  stopAnthropicResponseCapture(captureId: string): Promise<AnthropicResponseCaptureStatus>;

  request(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish>;

  start(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): AgentLLMRequestTask;
}

export const IAgentLLMRequesterService = createDecorator<IAgentLLMRequesterService>(
  'agentLLMRequesterService',
);
