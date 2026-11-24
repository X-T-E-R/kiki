import type {
  InteractionRespondRequest,
  InteractionRespondResult,
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmCompleteStreamEvent,
  PromptSubmitResult,
  PromptSubmission,
  RawEventFrame,
  RawEventStreamGrade,
  Session,
  SessionCreate,
} from '@kiki/protocol';
import type { HttpRestRequestOptions } from './http-rest.js';

export interface RawSessionEventsStreamOptions extends HttpRestRequestOptions {
  readonly after?: string;
  readonly grade?: RawEventStreamGrade;
  readonly format?: 'sse' | 'ndjson';
}

export interface RawGlobalEventsStreamOptions extends HttpRestRequestOptions {
  readonly after?: string;
  readonly format?: 'sse' | 'ndjson';
}

export interface RawSubstrateFacade {
  /** R1: Create a session with optional session-scoped mcp_servers and declarative user_tools. */
  createSession(body: SessionCreate, options?: HttpRestRequestOptions): Promise<Session>;
  /** R1: Submit a prompt with optional wait, output_schema, and include_thinking. */
  submitPrompt(
    sessionId: string,
    body: PromptSubmission,
    options?: HttpRestRequestOptions,
  ): Promise<PromptSubmitResult>;
  /** R2: Stateless cursor event stream for one session (SSE or NDJSON). */
  streamSessionEvents(
    sessionId: string,
    onFrame: (frame: RawEventFrame) => void,
    options?: RawSessionEventsStreamOptions,
  ): Promise<void>;
  /** R2: Stateless global public event stream (SSE or NDJSON). */
  streamGlobalEvents(
    onFrame: (frame: RawEventFrame) => void,
    options?: RawGlobalEventsStreamOptions,
  ): Promise<void>;
  /** R3: Single-shot sessionless governed LLM completion. */
  llmComplete(
    input: LlmCompleteRequest,
    options?: HttpRestRequestOptions,
  ): Promise<LlmCompleteResponse>;
  /** R3: Streaming sessionless governed LLM completion. */
  llmCompleteStream(
    input: LlmCompleteRequest,
    onEvent: (event: LlmCompleteStreamEvent) => void,
    options?: HttpRestRequestOptions & { readonly format?: 'sse' | 'ndjson' },
  ): Promise<void>;
  /** R4(c): Statelessly respond to a pending user_tool interaction. */
  respondInteraction(
    sessionId: string,
    interactionId: string,
    body: InteractionRespondRequest,
    options?: HttpRestRequestOptions,
  ): Promise<InteractionRespondResult>;
}
