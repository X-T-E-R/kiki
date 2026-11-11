import type { Message, StreamedMessagePart } from './message';
import type {
  FinishReason,
  RequestParams,
  SamplingOptions,
  ServiceTier,
  ThinkingEffort,
} from './provider';
import type { Tool } from './tool';
import type { TokenUsage } from './usage';

/** JSON-serializable scalar, array, or object value allowed in deterministic vendor transport patches. */
export type TransportJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly TransportJsonValue[]
  | { readonly [key: string]: TransportJsonValue };

/** Deeply immutable view of a resolved LLM request before baseline fingerprinting and wire projection. */
export interface FrozenLLMRequestSnapshot {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly step?: number;
  readonly logicalRequestId: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly protocol: string;
  readonly providerType?: string;
  readonly systemPrompt: string;
  readonly tools: readonly Readonly<Tool>[];
  readonly messages: readonly Readonly<Message>[];
  readonly thinkingEffort?: ThinkingEffort;
  readonly maxCompletionTokens?: number;
  readonly sampling?: Readonly<SamplingOptions>;
  readonly serviceTier?: ServiceTier;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Declarative pre-baseline request overlay returned by E2 policy hooks without mutating history or signatures. */
export interface PreBaselineRequestPatch {
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly sampling?: Readonly<SamplingOptions>;
  readonly serviceTier?: ServiceTier;
  readonly thinkingEffort?: ThinkingEffort;
  readonly maxCompletionTokens?: number;
  readonly extraRequestParams?: RequestParams;
  readonly deterministicVendorFields?: Readonly<Record<string, TransportJsonValue>>;
  readonly forceFullResponsesInput?: boolean;
}

/** Verification result ensuring a request patch preserves thinking signature blocks and Responses WS invariants. */
export interface RequestInvariantCheckResult {
  readonly ok: boolean;
  readonly invalidateResponsesBaseline: boolean;
  readonly violationCode?:
    | 'RESERVED_HEADER_FORBIDDEN'
    | 'THINKING_SIGNATURE_MUTATION_FORBIDDEN'
    | 'TOOL_ORDER_MUTATION_FORBIDDEN'
    | 'MESSAGE_HISTORY_MUTATION_FORBIDDEN'
    | 'THINKING_DISABLE_WITH_SIGNED_HISTORY';
  readonly message?: string;
}

/** Control handle passed to synchronous zero-allocation E3 stream tap observers. */
export interface StreamTapAbortControl {
  abortForRecovery(reason: {
    readonly pluginId: string;
    readonly code: string;
    readonly detail: string;
  }): void;
}

/** Synchronous read-only observer invoked on normalized stream parts; `undefined` return statically forbids `async` functions. */
export type LLMStreamTapObserver = (
  part: Readonly<StreamedMessagePart>,
  control: StreamTapAbortControl,
) => undefined;

/** Post-stream settlement snapshot passed to E3 response observers after signature and tool-call normalization. */
export interface SettledLLMResponseSnapshot {
  readonly logicalRequestId: string;
  readonly responseId?: string;
  readonly traceId?: string;
  readonly modelName: string;
  readonly protocol: string;
  readonly providerType?: string;
  readonly message: Readonly<Message>;
  readonly usage: Readonly<TokenUsage>;
  readonly finishReason?: FinishReason;
  readonly rawFinishReason?: string;
}
