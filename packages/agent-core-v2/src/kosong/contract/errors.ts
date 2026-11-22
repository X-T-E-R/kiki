import { Error2, attachErrorDetails, readAttachedErrorDetails, type Error2Options } from '#/_base/errors/errors';
import { isAbortError } from '#/_base/utils/abort';
import { sliceUtf16 } from '#/_base/text/utf16';
import type { FinishReason } from './provider';

export const CONFIG_INVALID_ERROR_CODE = 'config.invalid';

export const PROVIDER_API_ERROR_CODE = 'provider.api_error';
export const PROVIDER_FILTERED_ERROR_CODE = 'provider.filtered';
export const PROVIDER_RATE_LIMIT_ERROR_CODE = 'provider.rate_limit';
export const PROVIDER_AUTH_ERROR_CODE = 'provider.auth_error';
export const PROVIDER_CONNECTION_ERROR_CODE = 'provider.connection_error';
export const PROVIDER_OVERLOADED_ERROR_CODE = 'provider.overloaded';
export const CONTEXT_OVERFLOW_ERROR_CODE = 'context.overflow';

export type ProviderErrorCode =
  | typeof PROVIDER_API_ERROR_CODE
  | typeof PROVIDER_FILTERED_ERROR_CODE
  | typeof PROVIDER_RATE_LIMIT_ERROR_CODE
  | typeof PROVIDER_AUTH_ERROR_CODE
  | typeof PROVIDER_CONNECTION_ERROR_CODE
  | typeof PROVIDER_OVERLOADED_ERROR_CODE
  | typeof CONTEXT_OVERFLOW_ERROR_CODE;

export function sanitizeStatusErrorMessage(message: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(message);
  const extracted = titleMatch?.[1]?.trim();
  const normalized = extracted !== undefined && extracted.length > 0 ? extracted : message;
  return normalized.replaceAll('\r', '');
}

function codeForStatusError(statusCode: number): ProviderErrorCode {
  if (statusCode === 429) return PROVIDER_RATE_LIMIT_ERROR_CODE;
  if (statusCode === 401 || statusCode === 403) return PROVIDER_AUTH_ERROR_CODE;
  if (statusCode === 529) return PROVIDER_OVERLOADED_ERROR_CODE;
  return PROVIDER_API_ERROR_CODE;
}

/**
 * Stable classification of a provider failure that hosts can act on without
 * parsing provider text. `provider.api_error` carries no class of its own, so
 * its HTTP status decides between a server failure and a rejected request.
 */
export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'server'
  | 'invalid_request'
  | 'filtered'
  | 'context_overflow'
  | 'unknown';

export function providerErrorKind(code: ProviderErrorCode, statusCode?: number): ProviderErrorKind {
  switch (code) {
    case PROVIDER_AUTH_ERROR_CODE:
      return 'auth';
    case PROVIDER_RATE_LIMIT_ERROR_CODE:
      return 'rate_limit';
    case PROVIDER_CONNECTION_ERROR_CODE:
      return 'network';
    case PROVIDER_OVERLOADED_ERROR_CODE:
      return 'server';
    case PROVIDER_FILTERED_ERROR_CODE:
      return 'filtered';
    case CONTEXT_OVERFLOW_ERROR_CODE:
      return 'context_overflow';
    case PROVIDER_API_ERROR_CODE:
      break;
  }
  if (statusCode === undefined) return 'unknown';
  if (statusCode === 429) return 'rate_limit';
  if (statusCode === 401 || statusCode === 403) return 'auth';
  if (statusCode >= 500) return 'server';
  if (statusCode >= 400) return 'invalid_request';
  return 'unknown';
}

function readStatusCode(details: Error2Options['details']): number | undefined {
  const statusCode = details?.['statusCode'];
  return typeof statusCode === 'number' ? statusCode : undefined;
}

export class ChatProviderError extends Error2 {
  constructor(
    message: string,
    code: ProviderErrorCode = PROVIDER_API_ERROR_CODE,
    options?: Error2Options,
  ) {
    super(code, message, {
      ...options,
      name: 'ChatProviderError',
      details: {
        ...options?.details,
        error_kind: providerErrorKind(code, readStatusCode(options?.details)),
      },
    });
  }
}

export class APIConnectionError extends ChatProviderError {
  constructor(message: string) {
    super(message, PROVIDER_CONNECTION_ERROR_CODE);
    this.name = 'APIConnectionError';
  }
}

export class VideoUploadUnsupportedError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'VideoUploadUnsupportedError';
  }
}

export class APITimeoutError extends ChatProviderError {
  constructor(message: string) {
    super(message, PROVIDER_CONNECTION_ERROR_CODE);
    this.name = 'APITimeoutError';
  }
}

export class APIStatusError extends ChatProviderError {
  readonly statusCode: number;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly traceId: string | null;

  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
    code: ProviderErrorCode = codeForStatusError(statusCode),
  ) {
    const details: Record<string, unknown> = {
      statusCode,
      requestId: requestId ?? null,
      traceId: traceId ?? null,
    };
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      details['retryAfterMs'] = retryAfterMs;
    }
    super(sanitizeStatusErrorMessage(message), code, { details });
    this.name = 'APIStatusError';
    this.statusCode = statusCode;
    this.requestId = requestId ?? null;
    this.retryAfterMs = retryAfterMs ?? null;
    this.traceId = traceId ?? null;
  }
}

export class APIContextOverflowError extends APIStatusError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs, traceId, CONTEXT_OVERFLOW_ERROR_CODE);
    this.name = 'APIContextOverflowError';
  }
}

export class APIRequestTooLargeError extends APIStatusError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs, traceId);
    this.name = 'APIRequestTooLargeError';
  }
}

export class APIProviderRateLimitError extends APIStatusError {
  constructor(
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(429, message, requestId, retryAfterMs, traceId);
    this.name = 'APIProviderRateLimitError';
  }
}

export class APIProviderQuotaExhaustedError extends APIStatusError {
  constructor(
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(429, message, requestId, retryAfterMs, traceId, PROVIDER_API_ERROR_CODE);
    this.name = 'APIProviderQuotaExhaustedError';
  }
}

export class APIProviderOverloadedError extends APIStatusError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs, traceId, PROVIDER_OVERLOADED_ERROR_CODE);
    this.name = 'APIProviderOverloadedError';
  }
}

export class APIEmptyResponseError extends ChatProviderError {
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;

  constructor(
    message: string,
    options: {
      readonly finishReason?: FinishReason | null;
      readonly rawFinishReason?: string | null;
    } = {},
  ) {
    const finishReason = options.finishReason ?? null;
    const rawFinishReason = options.rawFinishReason ?? null;
    super(
      message,
      finishReason === 'filtered' ? PROVIDER_FILTERED_ERROR_CODE : PROVIDER_API_ERROR_CODE,
      { details: { finishReason, rawFinishReason } },
    );
    this.name = 'APIEmptyResponseError';
    this.finishReason = finishReason;
    this.rawFinishReason = rawFinishReason;
  }
}

export function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export { isAbortError };

export function throwIfAbortError(error: unknown): void {
  if (isAbortError(error)) {
    throw createAbortError();
  }
}

const IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS = [
  /unsupported media type for base64 image/,
  /invalid data url for image/,
] as const;

const IMAGE_FORMAT_STATUS_MESSAGE_PATTERNS = [
  /unsupported image (?:url|format|type)/,
  /does not represent a valid image/,
  /could not (?:process|decode) (?:the |input )?image/,
  /unable to process (?:the |input )?image/,
  /failed to decode (?:the )?image/,
  /invalid image(?: data| type| format)?/,
] as const;

const MEDIA_TYPE_FIELD_PATTERN = /(?:media|mime)_?type/;

export function isImageFormatError(error: unknown): boolean {
  if (error instanceof APIStatusError) {
    if (error instanceof APIContextOverflowError) return false;
    if (error instanceof APIRequestTooLargeError) return false;
    if (error.statusCode !== 400) return false;
    const lowerMessage = error.message.toLowerCase();
    return (
      IMAGE_FORMAT_STATUS_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage)) ||
      (MEDIA_TYPE_FIELD_PATTERN.test(lowerMessage) && lowerMessage.includes('image'))
    );
  }
  if (error instanceof ChatProviderError) {
    const lowerMessage = error.message.toLowerCase();
    return IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
  }
  return false;
}

function explicitDeliveryMark(error: object): 'unknown' | 'executed' | undefined {
  const attached = readAttachedErrorDetails(error)?.['request_delivery'];
  const details = error instanceof Error2 ? error.details?.['request_delivery'] : undefined;
  const mark = attached ?? details;
  if (mark === 'ambiguous') return 'unknown';
  if (mark === 'executed') return 'executed';
  return undefined;
}

function noteRequestDelivery(error: unknown, mark: 'ambiguous' | 'executed' | 'confirmed'): void {
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    if (!(mark === 'executed' && explicitDeliveryMark(current) === 'unknown')) {
      attachErrorDetails(current, { request_delivery: mark === 'confirmed' ? 'executed' : mark });
    }
    if (mark === 'executed') attachErrorDetails(current, { request_output: 'observed' });
    if (mark === 'confirmed') attachErrorDetails(current, { execution: 'executed', retry: false });
    current = current instanceof Error ? current.cause : undefined;
  }
}

/** Delivery observations retained for generation recovery decisions.
 *
 * `unknown` means the outcome was not observed. `executed` means actual output or
 * tool execution was observed, or a trusted boundary confirmed execution. A failure event or response id alone is neither.
 * `undefined` means neither fact is present, so a pre-stream HTTP retry and the one explicit
 * HTTP 401 refresh stay available. The walk includes causes, and the marks are
 * stored on that chain, so `unwrapErrorCause` does not remove them. Call this on
 * the original error before unwrapping.
 */
export function requestDeliveryProvenance(error: unknown): 'unknown' | 'executed' | undefined {
  const visited = new Set<unknown>();
  let current: unknown = error;
  let executed = false;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const mark = explicitDeliveryMark(current);
    if (mark === 'unknown') return 'unknown';
    if (mark === 'executed') executed = true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return executed ? 'executed' : undefined;
}

export function isAmbiguousRequestDelivery(error: unknown): boolean {
  return requestDeliveryProvenance(error) === 'unknown';
}

export function ambiguousRequestDelivery(error: unknown): ChatProviderError {
  if (
    error instanceof ChatProviderError &&
    error.message === 'The provider request ended without an observed outcome.' &&
    error.cause !== undefined
  ) {
    noteRequestDelivery(error, 'ambiguous');
    return error;
  }
  const causeDetails: Record<string, unknown> = {};
  if (typeof error === 'object' && error !== null) {
    for (const [key, value] of Object.entries(providerErrorMetadata(error))) {
      if (key === 'error_kind' || key === 'request_delivery') continue;
      causeDetails[key] = value;
    }
  }
  noteRequestDelivery(error, 'ambiguous');
  const wrapped = new ChatProviderError('The provider request ended without an observed outcome.',
    error instanceof ChatProviderError ? error.code as ProviderErrorCode : undefined, {
      cause: error,
      details: { ...causeDetails, request_delivery: 'ambiguous' },
    });
  noteRequestDelivery(wrapped, 'ambiguous');
  return wrapped;
}

/** Records that this failure happened after a response, partial output, or tool was observed. */
export function noteExecutedRequestDelivery(error: unknown): void {
  noteRequestDelivery(error, 'executed');
}

/** Records trusted execution confirmation without claiming observed output and forbids replay. */
export function noteConfirmedRequestExecution(error: unknown): void {
  noteRequestDelivery(error, 'confirmed');
}

export function isSafetyProviderErrorCode(code: string): boolean {
  const normalized = code.trim().toLowerCase();
  return (
    normalized === 'antigravity_safety' ||
    normalized === 'antigravity_soft_safety' ||
    normalized.startsWith('antigravity_safety_') ||
    normalized.startsWith('antigravity_soft_safety_') ||
    normalized === 'antigravity_session_safety_circuit' ||
    normalized === 'content_filter' ||
    normalized === 'content_policy_violation'
  );
}

export function readUpstreamSafetySubCode(details: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (details === undefined) return undefined;
  if (typeof details['upstream_code'] === 'string') return details['upstream_code'].trim();
  const upstream = details['upstreamDetails'];
  if (typeof upstream === 'object' && upstream !== null) {
    const direct = (upstream as Record<string, unknown>)['upstream_code'];
    if (typeof direct === 'string') return direct.trim();
    const nested = (upstream as Record<string, unknown>)['error'];
    if (typeof nested === 'object' && nested !== null && typeof (nested as Record<string, unknown>)['upstream_code'] === 'string') {
      return ((nested as Record<string, unknown>)['upstream_code'] as string).trim();
    }
  }
  return undefined;
}

const NON_CONTINUABLE_PROVIDER_CODES: ReadonlySet<string> = new Set([
  'antigravity_thinking_only',
  'antigravity_safety',
  'antigravity_soft_safety',
  'antigravity_safety_streak_aborted',
  'antigravity_session_safety_circuit',
  'antigravity_malformed_response',
  'antigravity_upstream_terminal_error',
]);

const NON_RETRYABLE_PROVIDER_CODES: ReadonlySet<string> = new Set([
  ...NON_CONTINUABLE_PROVIDER_CODES,
  'gateway_stream_terminal_error',
]);

/** Checks explicit same-request retry denials on the original error and its cause chain. */
export function hasExplicitRetryVeto(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const attached = readAttachedErrorDetails(current);
    const declared = current instanceof Error2 ? current.details : undefined;
    if (attached?.['retry'] === false || declared?.['retry'] === false ||
      attached?.['upstream_retryable'] === false || declared?.['upstream_retryable'] === false) return true;
    const details = providerErrorMetadata(current);
    if ((details['errorSource'] === 'provider_event' || details['errorSource'] === 'provider_http') &&
      typeof details['upstreamErrorCode'] === 'string' && NON_RETRYABLE_PROVIDER_CODES.has(details['upstreamErrorCode'])) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export function isRetryableMalformedFunctionCallError(error: unknown): boolean {
  return isRetryableUncommittedProviderError(error, (cause, code) =>
    code === 'antigravity_malformed_function_call' || code === 'MALFORMED_FUNCTION_CALL' ||
    (cause instanceof APIEmptyResponseError && cause.rawFinishReason === 'MALFORMED_FUNCTION_CALL'));
}

export function isRetryableMissingTerminalError(error: unknown): boolean {
  return isRetryableUncommittedProviderError(error, (_cause, code) => code === 'antigravity_missing_terminal');
}

export function isRetryableUncommittedStreamOverloadError(error: unknown): boolean {
  if (hasExplicitRetryVeto(error)) return false;
  return isRetryableUncommittedProviderError(error, (cause, code) => {
    const details = providerErrorMetadata(cause);
    if (details['errorSource'] !== 'provider_event') return false;
    if (cause instanceof APIProviderOverloadedError || cause instanceof APIProviderRateLimitError) return true;
    if (cause instanceof APIStatusError && !(cause instanceof APIProviderQuotaExhaustedError) &&
      (cause.statusCode === 429 || (cause.statusCode >= 500 && cause.statusCode <= 599))) {
      return true;
    }
    const type = details['upstreamErrorType'];
    return (
      code === 'server_error' || code === 'overloaded_error' || code === 'service_unavailable' ||
      type === 'service_unavailable_error' || type === 'server_error' || type === 'overloaded_error'
    );
  });
}

function isRetryableUncommittedProviderError(error: unknown, matches: (cause: object, code: unknown) => boolean): boolean {
  if (isAbortError(error)) return false;
  const visited = new Set<object>();
  let current = error;
  let matched = false;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const details = providerErrorMetadata(current);
    if (details['execution'] === 'executed' || details['retry'] === false ||
      (current instanceof Error2 && current.details?.['retry'] === false)) return false;
    const code = details['upstreamErrorCode'];
    const matchesCause = matches(current, code);
    if (typeof code === 'string' && !matchesCause && details['upstream_retryable'] === false) return false;
    matched ||= matchesCause;
    current = current instanceof Error ? current.cause : undefined;
  }
  return matched;
}

export function isRetryableGenerateError(error: unknown): boolean {
  return isRetryableProviderFailure(error, 'generation');
}

/** Only an uncommitted model-request boundary that can retract partial output may replay these network failures. This does not authorize replaying tools or other provider-side effects. */
export function isRetryableRequestInterruption(error: unknown): boolean {
  if (!isRetryableProviderFailure(error, 'interruption')) return false;
  const visited = new Set<object>();
  let current = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    if (current instanceof ChatProviderError && current.code === PROVIDER_CONNECTION_ERROR_CODE) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** Only a side-effect-free request whose entire response is buffered and discarded on failure may ignore transport replay restrictions. User retry-policy vetoes and permanent failures still apply. */
export function isRetryableBufferedRequestError(error: unknown): boolean {
  return isRetryableProviderFailure(error, 'buffered');
}

const NON_OVERRIDABLE_CLIENT_STATUS_CODES: ReadonlySet<number> = new Set([
  400, 401, 402, 403, 404, 405, 406, 407, 410, 411, 412, 413, 414, 415, 416, 417, 421, 422, 426, 431, 451,
]);

function isRetryableProviderFailure(error: unknown, mode: 'generation' | 'interruption' | 'buffered'): boolean {
  if (isAbortError(error) || (mode === 'generation' && requestDeliveryProvenance(error) === 'executed')) return false;
  const visited = new Set<object>();
  let current = error;
  let providerError = error;
  let explicitUpstreamRetry = false;
  let bufferedClientStatusDenied = false;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const details = providerErrorMetadata(current);
    if (mode === 'buffered' ? details['retry_policy_veto'] === true || details['compaction_stream_filtered'] === true : details['retry'] === false || details['upstream_retryable'] === false) return false;
    if (details['upstream_retryable'] === true) explicitUpstreamRetry = true;
    if (mode === 'generation' && details['request_output'] === 'observed') return false;
    const code = details['upstreamErrorCode'];
    const type = details['upstreamErrorType'];
    const subCode = readUpstreamSafetySubCode(details);
    if (typeof code === 'string' && (mode === 'buffered' ? isSafetyProviderErrorCode(code) : NON_RETRYABLE_PROVIDER_CODES.has(code) || isSafetyProviderErrorCode(code))) return false;
    if (typeof type === 'string' && isSafetyProviderErrorCode(type)) return false;
    if (typeof subCode === 'string' && isSafetyProviderErrorCode(subCode)) return false;
    if (mode === 'buffered' && current instanceof Error && /soft safety filter block|blocked by gemini's filters|safety filter blocks/i.test(current.message)) return false;
    if (mode === 'buffered') {
      if (current instanceof ChatProviderError &&
        (current.code === PROVIDER_FILTERED_ERROR_CODE || current.code === PROVIDER_AUTH_ERROR_CODE || current instanceof APIProviderQuotaExhaustedError || current instanceof APIContextOverflowError || current instanceof APIRequestTooLargeError || isImageFormatError(current))) return false;
      const status = current instanceof APIStatusError ? current.statusCode : details['upstreamStatus'] ?? details['statusCode'];
      if (typeof status === 'number' && NON_OVERRIDABLE_CLIENT_STATUS_CODES.has(status)) return false;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) {
        bufferedClientStatusDenied = true;
      }
    }
    if (current instanceof ChatProviderError) providerError = current;
    current = current instanceof Error ? current.cause : undefined;
  }
  if (mode === 'buffered' && bufferedClientStatusDenied && !explicitUpstreamRetry) return false;
  error = providerError;
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return true;
  }
  if (error instanceof APIEmptyResponseError) {
    return error.finishReason !== 'filtered';
  }
  if (error instanceof APIProviderOverloadedError) {
    return true;
  }
  if (error instanceof APIStatusError) {
    if (error instanceof APIProviderQuotaExhaustedError) {
      return false;
    }
    if (
      explicitUpstreamRetry &&
      mode !== 'interruption' &&
      !NON_OVERRIDABLE_CLIENT_STATUS_CODES.has(error.statusCode) &&
      !(error instanceof APIContextOverflowError) &&
      !(error instanceof APIRequestTooLargeError) &&
      !isImageFormatError(error)
    ) {
      return true;
    }
    return (
      error.statusCode === 408 ||
      error.statusCode === 409 ||
      error.statusCode === 429 ||
      (error.statusCode >= 500 && error.statusCode <= 599)
    );
  }
  if (error instanceof ChatProviderError) {
    const tail = error.details?.['google_content_tail'];
    if (tail === 'model_prefill' || tail === 'model_function_call') return false;
    const stop = error.details?.['google_stop'];
    if (stop === 'continuation_unsupported' || stop === 'think_snapshot_exhausted') return false;
    return !isImageFormatError(error);
  }
  return false;
}

const NETWORK_RE = /network|connection|connect|disconnect|terminated|ECONNRESET|EPIPE|socket hang up|unexpected EOF/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

export function classifyBaseApiError(message: string): ChatProviderError {
  if (TIMEOUT_RE.test(message)) {
    return new APITimeoutError(message);
  }
  if (NETWORK_RE.test(message)) {
    return new APIConnectionError(message);
  }
  return new ChatProviderError(`Error: ${message}`);
}

const CONTEXT_OVERFLOW_MESSAGE_PATTERNS = [
  /context[ _-]?length/,
  /(?:context[ _-]?window.*exceed|exceed.*context[ _-]?window)/,
  /maximum context/,
  /exceed(?:ed|s|ing)?\s+(?:the\s+)?max(?:imum)?\s+tokens?/,
  /(?:too many tokens.*(?:prompt|input|context)|(?:prompt|input|context).*too many tokens)/,
  /prompt is too long.*maximum/,
  /input token count.*exceeds?.*maximum number of tokens/,
  /request.*exceed(?:ed|s|ing)?.*model token limit/,
] as const;

const PROVIDER_RATE_LIMIT_MESSAGE_PATTERNS = [
  /(?:apistatuserror.*429|429.*apistatuserror)/,
  /429.*too many requests/,
  /too many requests/,
  /provider\.rate_limit/,
  /reached .*max rpm/,
  /rate[ _-]?limit(?:ed)?/,
  /rate-limited/,
] as const;

const PROVIDER_OVERLOAD_MESSAGE_PATTERNS = [/overload/] as const;

const THINKING_EFFORT_CONFIG_DOCS_URL =
  'https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#thinking';

const THINKING_EFFORT_STATUS_MESSAGE_PATTERNS = [
  /reasoning[_ .-]?effort/,
  /thinking[_ .-]?effort/,
  /output_config[\s\S]*effort/,
  /unsupported[\s\S]*effort/,
  /invalid[\s\S]*effort/,
] as const;

function appendThinkingEffortConfigHint(statusCode: number, message: string): string {
  if (statusCode !== 400 && statusCode !== 422) return message;
  const lowerMessage = message.toLowerCase();
  if (!THINKING_EFFORT_STATUS_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage))) {
    return message;
  }
  if (message.includes(THINKING_EFFORT_CONFIG_DOCS_URL)) return message;
  return `${message}

The provider rejected the configured thinking effort. Non-Kimi providers receive effort strings without client-side mapping; choose an effort supported by the selected model. For Kimi models, check support_efforts and default_effort. See ${THINKING_EFFORT_CONFIG_DOCS_URL}`;
}

const STATUS_ERROR_BODY_SNIPPET_MAX_CHARS = 500;
const STATUS_ERROR_MESSAGE_MAX_CHARS = 700;
const STATUS_ERROR_REDACTED = '[REDACTED]';
const STATUS_ERROR_SENSITIVE_KEY =
  /^(?:api[_-]?key|authorization|secret|password|token|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|bearer)$/i;
const STATUS_ERROR_SENSITIVE_KEY_SUFFIX = /(?:^|_)(?:api_key|authorization|secret|password|token|bearer)$/i;
const STATUS_ERROR_SENSITIVE_KEY_NAME =
  'access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|api[_-]?key|password|secret|token';
const STATUS_ERROR_SK_TOKEN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const STATUS_ERROR_AUTHORIZATION = /\b(Authorization)(\s*[=:]\s*)(.*)$/gim;
const STATUS_ERROR_KEY_VALUE = new RegExp(
  String.raw`\b((?:${STATUS_ERROR_SENSITIVE_KEY_NAME}))(\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)`,
  'gi',
);
const STATUS_ERROR_JSON_SECRET = new RegExp(
  String.raw`("?)((?:${STATUS_ERROR_SENSITIVE_KEY_NAME}|authorization))\1\s*:\s*(")(?:\\.|[^"\\])*(")`,
  'gi',
);

function truncateStatusErrorSnippet(text: string): string {
  if (text.length <= STATUS_ERROR_BODY_SNIPPET_MAX_CHARS) return text;
  return `${sliceUtf16(text, 0, STATUS_ERROR_BODY_SNIPPET_MAX_CHARS)}...`;
}

function truncateStatusErrorMessage(text: string): string {
  if (text.length <= STATUS_ERROR_MESSAGE_MAX_CHARS) return text;
  return `${sliceUtf16(text, 0, STATUS_ERROR_MESSAGE_MAX_CHARS - 3)}...`;
}

function isSensitiveStatusErrorKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll('-', '_');
  return STATUS_ERROR_SENSITIVE_KEY.test(normalized) || STATUS_ERROR_SENSITIVE_KEY_SUFFIX.test(normalized);
}

function redactSensitiveText(text: string): string {
  return text
    .replace(STATUS_ERROR_SK_TOKEN, STATUS_ERROR_REDACTED)
    .replace(STATUS_ERROR_AUTHORIZATION, `$1$2${STATUS_ERROR_REDACTED}`)
    .replace(STATUS_ERROR_JSON_SECRET, `$1$2$1: $3${STATUS_ERROR_REDACTED}$4`)
    .replace(STATUS_ERROR_KEY_VALUE, `$1$2${STATUS_ERROR_REDACTED}`);
}

function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (typeof value !== 'object' || value === null) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = isSensitiveStatusErrorKey(key) ? STATUS_ERROR_REDACTED : redactSensitiveValue(nested);
  }
  return redacted;
}

function readObjectStringProp(value: object, key: string): string | undefined {
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : undefined;
}

function readNestedErrorObject(value: object): object | undefined {
  const raw = (value as Record<string, unknown>)['error'];
  return typeof raw === 'object' && raw !== null ? raw : undefined;
}

/** Why the same provider request must not be sent again.
 *
 * `upstream` is an explicit boolean `retryable: false`, `budget` is an exhausted
 * attempt count, and `stream_terminal` is a provider-named gateway stream stop
 * on a stream event or an HTTP error body. These stop same-request retries.
 * `local` also prevents hook continuation.
 */
export function sameRequestRetryProhibition(
  details: Readonly<Record<string, unknown>> | undefined,
): 'local' | 'upstream' | 'budget' | 'stream_terminal' | undefined {
  if (details === undefined) return undefined;
  if (details['execution'] === 'executed') return 'local';
  const code = details['upstreamErrorCode'];
  if (typeof code === 'string' && NON_RETRYABLE_PROVIDER_CODES.has(code)) {
    const namedByProvider = details['errorSource'] === 'provider_event' || details['errorSource'] === 'provider_http';
    return namedByProvider && !NON_CONTINUABLE_PROVIDER_CODES.has(code) ? 'stream_terminal' : 'local';
  }
  if (details['retry'] === false && details['retry_exhausted'] !== true) return 'local';
  if (details['retry'] === false && details['retry_exhausted'] === true) return 'budget';
  if (details['upstream_retryable'] === false) return 'upstream';
  return undefined;
}

/** Marks a parsed provider event's own failure, keeping its exact upstream code.
 *  Only an event the provider itself named qualifies; an HTTP status alone does not. */
export function markProviderEventError<T>(error: T, upstreamErrorCode?: string | null): T {
  const code = readProviderErrorIdentifier(upstreamErrorCode) ??
    providerErrorMetadata(error)['upstreamErrorCode'];
  if (typeof code !== 'string') return error;
  return attachErrorDetails(error, { errorSource: 'provider_event', upstreamErrorCode: code });
}

/** Keeps an HTTP failure's upstream code without treating it as a stream event. */
export function markProviderHttpError<T>(error: T, upstreamErrorCode?: string | null): T {
  const code = readProviderErrorIdentifier(upstreamErrorCode);
  if (code === null) return error;
  return attachErrorDetails(error, { errorSource: 'provider_http', upstreamErrorCode: code });
}

/** The exact upstream code of a provider event failure, when the provider named one. */
export function readProviderEventErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const details = providerErrorMetadata(error);
  if (details['errorSource'] !== 'provider_event') return undefined;
  return readProviderErrorIdentifier(details['upstreamErrorCode']) ?? undefined;
}

function providerErrorMetadata(error: unknown): Readonly<Record<string, unknown>> {
  if (typeof error !== 'object' || error === null) return {};
  const attached = readAttachedErrorDetails(error) ?? {};
  const declared = error instanceof Error2 ? error.details ?? {} : {};
  return { ...declared, ...attached };
}

/** Filters a provider identifier without retaining content or credentials. */
export function readProviderErrorIdentifier(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return null;
  const redacted = redactSensitiveText(value);
  return /^[A-Za-z0-9_.:-]+$/.test(redacted) ? redacted : null;
}

function readHeaderCaseInsensitive(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(headerName: string): string | null }).get(name);
    return typeof value === 'string' ? value : undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
      return value[0];
    }
    return undefined;
  }
  return undefined;
}

/** Parses the standard `x-should-retry` header boolean directive (`true` or `false`) case-insensitively. */
export function readExplicitUpstreamShouldRetry(headers: unknown): boolean | undefined {
  const raw = readHeaderCaseInsensitive(headers, 'x-should-retry');
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'false') return false;
  if (normalized === 'true') return true;
  return undefined;
}

function explicitUpstreamRetryDenied(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const error = readNestedErrorObject(body) ?? body;
  return (error as Record<string, unknown>)['retryable'] === false;
}

/** Records an explicit upstream retry directive from JSON `retryable: false` or HTTP `x-should-retry` without writing `retry: false`. */
export function noteExplicitUpstreamRetryDenial<T>(error: T, body: unknown, headers?: unknown): T {
  const shouldRetryHeader = readExplicitUpstreamShouldRetry(headers);
  if (shouldRetryHeader === false) {
    return attachErrorDetails(error, { upstream_retryable: false, upstream_should_retry: false });
  }
  if (explicitUpstreamRetryDenied(body)) {
    return attachErrorDetails(error, { upstream_retryable: false });
  }
  if (shouldRetryHeader === true) {
    return attachErrorDetails(error, { upstream_retryable: true, upstream_should_retry: true });
  }
  return error;
}

function readObjectScalarCode(value: object, key: string): string | undefined {
  const raw = (value as Record<string, unknown>)[key];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

const ALWAYS_CONSUMED_UPSTREAM_BODY_KEYS: ReadonlySet<string> = new Set([
  'retryable',
  'error',
]);

interface UpstreamMappingContext {
  readonly mappedType?: string | null;
  readonly mappedCode?: string | null;
  readonly mappedStatus?: number;
  readonly mappedRequestId?: string | null;
  readonly displayMessage?: string;
}

const PURE_REDACTED_RESIDUE = new RegExp(
  String.raw`^(?:${STATUS_ERROR_SENSITIVE_KEY_NAME}|authorization|bearer|basic)\s*[:=]?\s*$`,
  'i',
);

function isEmptyOrPurelyRedactedText(value: string): boolean {
  const redacted = redactSensitiveText(value);
  const withoutMarkers = redacted
    .replaceAll(STATUS_ERROR_REDACTED, '')
    .replaceAll(/[\0-\u001F\u007F\s]+/g, ' ')
    .trim();
  return withoutMarkers.length === 0 || PURE_REDACTED_RESIDUE.test(withoutMarkers);
}

function isUpstreamBodyFieldConsumed(
  key: string,
  value: unknown,
  context?: UpstreamMappingContext,
): boolean {
  if (ALWAYS_CONSUMED_UPSTREAM_BODY_KEYS.has(key)) return true;
  if (key === 'type') {
    if (typeof value !== 'string') return false;
    if (value === 'error' || isEmptyOrPurelyRedactedText(value)) return true;
    return (
      context?.mappedType !== undefined &&
      context.mappedType !== null &&
      redactSensitiveText(value) === context.mappedType
    );
  }
  if (key === 'status') {
    if (typeof value === 'number') {
      return context?.mappedStatus !== undefined && value === context.mappedStatus;
    }
    if (typeof value === 'string') {
      if (isEmptyOrPurelyRedactedText(value)) return true;
      return (
        context?.mappedType !== undefined &&
        context.mappedType !== null &&
        redactSensitiveText(value) === context.mappedType
      );
    }
    return false;
  }
  if (key === 'code') {
    if (typeof value === 'string') {
      if (isEmptyOrPurelyRedactedText(value)) return true;
      return (
        context?.mappedCode !== undefined &&
        context.mappedCode !== null &&
        redactSensitiveText(value) === context.mappedCode
      );
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (context?.mappedStatus !== undefined && value === context.mappedStatus) return true;
      return (
        context?.mappedCode !== undefined &&
        context.mappedCode !== null &&
        String(value) === context.mappedCode
      );
    }
    return false;
  }
  if (key === 'request_id') {
    if (typeof value !== 'string') return false;
    if (isEmptyOrPurelyRedactedText(value)) return true;
    return (
      context?.mappedRequestId !== undefined &&
      context.mappedRequestId !== null &&
      redactSensitiveText(value) === context.mappedRequestId
    );
  }
  if (key === 'message') {
    if (typeof value !== 'string') return false;
    if (isEmptyOrPurelyRedactedText(value)) return true;
    const redacted = redactSensitiveText(value).trim();
    if (context?.displayMessage === undefined) return false;
    return redactSensitiveText(context.displayMessage).includes(redacted);
  }
  if (typeof value === 'string' && isEmptyOrPurelyRedactedText(value)) {
    return true;
  }
  return false;
}

const STREAM_PROTOCOL_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'sequence_number', 'text', 'thinking', 'redacted_thinking', 'reasoning',
  'reasoning_content', 'encrypted_content', 'delta', 'output', 'output_text',
]);

function extractUpstreamStructuredDetails(
  body: unknown,
  context: UpstreamMappingContext,
  protocolPayloadKeys?: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const envelope = body as Record<string, unknown>;
  const nested = readNestedErrorObject(envelope);
  const error = (nested ?? envelope) as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const source of nested === undefined ? [envelope] : [envelope, error]) {
    for (const [key, value] of Object.entries(source)) {
      if (isSensitiveStatusErrorKey(key) || protocolPayloadKeys?.has(key)) continue;
      if (value === undefined || value === null) continue;
      if (isUpstreamBodyFieldConsumed(key, value, context)) continue;
      extra[key] = redactSensitiveValue(value);
    }
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** Structured diagnostic metadata and sanitized upstream details retained from an SDK stream error without raw headers. */
export function providerStreamErrorDetails(
  body: unknown,
  requestId?: string | null,
  traceId?: string | null,
  displayMessage?: string,
): Readonly<Record<string, unknown>> {
  const envelope = typeof body === 'object' && body !== null ? body : undefined;
  const error = envelope === undefined ? undefined : (readNestedErrorObject(envelope) ?? envelope);
  const upstreamErrorType = readProviderErrorIdentifier(
    error === undefined
      ? undefined
      : (readObjectStringProp(error, 'type') ?? readObjectStringProp(error, 'status')),
  );
  const upstreamErrorCode = readProviderErrorIdentifier(
    error === undefined ? undefined : readObjectStringProp(error, 'code'),
  );
  const mappedRequestId =
    readProviderErrorIdentifier(requestId) ??
    readProviderErrorIdentifier(
      envelope === undefined
        ? undefined
        : (readObjectStringProp(envelope, 'request_id') ??
          (error === undefined ? undefined : readObjectStringProp(error, 'request_id'))),
    );
  const details: Record<string, unknown> = {
    errorSource: 'provider_stream',
    upstreamErrorType,
    upstreamErrorCode,
    requestId: mappedRequestId,
    traceId: readProviderErrorIdentifier(traceId),
  };
  const status = (error as Record<string, unknown> | undefined)?.['status'] ?? (envelope as Record<string, unknown> | undefined)?.['status'];
  const mappedStatus = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
  if (mappedStatus !== undefined) details['upstreamStatus'] = mappedStatus;
  if (explicitUpstreamRetryDenied(body)) details['upstream_retryable'] = false;
  const upstreamDetails = extractUpstreamStructuredDetails(body, {
    mappedType: upstreamErrorType,
    mappedCode: upstreamErrorCode,
    mappedStatus,
    mappedRequestId,
    displayMessage,
  }, STREAM_PROTOCOL_PAYLOAD_KEYS);
  if (upstreamDetails !== undefined) details['upstreamDetails'] = upstreamDetails;
  return details;
}

function extractStatusErrorBodyDetail(body: unknown, statusCode?: number): string | null {
  if (body === null || body === undefined) return null;
  const sanitized = redactSensitiveValue(body);
  if (typeof sanitized === 'string') {
    const trimmed = sanitized.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof sanitized !== 'object' || sanitized === null) return null;

  let current: object | undefined = sanitized;
  for (let depth = 0; current !== undefined && depth < 4; depth += 1) {
    const nestedMessage = readObjectStringProp(current, 'message');
    if (nestedMessage !== undefined) {
      const trimmed = nestedMessage.trim();
      if (trimmed.length > 0) {
        const rawCode = readObjectScalarCode(current, 'code');
        const codeCandidate =
          rawCode !== undefined && rawCode !== String(statusCode) ? rawCode : undefined;
        const upstreamCode =
          codeCandidate ??
          readObjectStringProp(current, 'type') ??
          readObjectStringProp(current, 'status');
        return upstreamCode === undefined ? trimmed : `${upstreamCode}: ${trimmed}`;
      }
    }
    current = readNestedErrorObject(current);
  }

  try {
    const serialized = JSON.stringify(sanitized);
    if (serialized === undefined || serialized === '{}' || serialized === '[]') return null;
    return serialized;
  } catch {
    return null;
  }
}

function tryParseJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function messageContainsStatusErrorDetail(message: string, detail: string): boolean {
  if (message.includes(detail)) return true;
  const parsedDetail = tryParseJsonValue(detail);
  if (parsedDetail === undefined) return false;
  const brace = message.indexOf('{');
  const bracket = message.indexOf('[');
  const jsonStart = brace === -1 ? bracket : bracket === -1 ? brace : Math.min(brace, bracket);
  if (jsonStart < 0) return false;
  const parsedMessage = tryParseJsonValue(message.slice(jsonStart));
  if (parsedMessage === undefined) return false;
  try {
    return JSON.stringify(parsedMessage) === JSON.stringify(parsedDetail);
  } catch {
    return false;
  }
}

function statusPrefixOfJsonOnlyMessage(message: string): string | undefined {
  const start = message.search(/[{[]/);
  if (start < 0 || tryParseJsonValue(message.slice(start)) === undefined) return undefined;
  const prefix = message.slice(0, start).trim();
  return prefix === '' || /^\d{3}(?:\s+[A-Za-z][A-Za-z ]*)?$/.test(prefix) ? prefix : undefined;
}

function composeStatusErrorMessage(message: string, body: unknown, statusCode?: number): string {
  const redactedMessage = redactSensitiveText(message);
  const detail = extractStatusErrorBodyDetail(body, statusCode);
  let assembled = redactedMessage;
  const jsonOnlyPrefix = detail === null || tryParseJsonValue(detail) !== undefined
    ? undefined
    : statusPrefixOfJsonOnlyMessage(redactedMessage);
  if (detail !== null && jsonOnlyPrefix !== undefined) {
    const snippet = truncateStatusErrorSnippet(detail);
    assembled = jsonOnlyPrefix === '' ? snippet : `${jsonOnlyPrefix} ${snippet}`;
  } else if (detail !== null && !messageContainsStatusErrorDetail(redactedMessage, detail)) {
    const snippet = truncateStatusErrorSnippet(detail);
    if (!messageContainsStatusErrorDetail(redactedMessage, snippet)) {
      assembled = `${redactedMessage} — ${snippet}`;
    }
  }
  return truncateStatusErrorMessage(assembled);
}

function appendStatusErrorBodySnippet(statusCode: number, message: string, body: unknown): string {
  if (statusCode < 400) return message;
  return composeStatusErrorMessage(message, body, statusCode);
}

function attachUpstreamStatusBodyDetails<T extends APIStatusError>(error: T, body: unknown): T {
  if (typeof body !== 'object' || body === null) return error;
  const envelope = body as Record<string, unknown>;
  const nested = readNestedErrorObject(envelope) ?? envelope;
  const extra: Record<string, unknown> = {};
  const upstreamErrorType = readProviderErrorIdentifier(
    readObjectStringProp(nested, 'type') ??
      readObjectStringProp(nested, 'status') ??
      readObjectStringProp(envelope, 'type') ??
      readObjectStringProp(envelope, 'status'),
  );
  if (upstreamErrorType !== null) extra['upstreamErrorType'] = upstreamErrorType;
  const upstreamErrorCode = readProviderErrorIdentifier(
    readObjectStringProp(nested, 'code') ?? readObjectStringProp(envelope, 'code'),
  );
  if (upstreamErrorCode !== null) extra['upstreamErrorCode'] = upstreamErrorCode;
  const bodyRequestId = readProviderErrorIdentifier(readObjectStringProp(envelope, 'request_id') ?? readObjectStringProp(nested, 'request_id'));
  if (error.requestId === null && bodyRequestId !== null) extra['requestId'] = bodyRequestId;
  const upstreamDetails = extractUpstreamStructuredDetails(body, {
    mappedType: upstreamErrorType,
    mappedCode: upstreamErrorCode,
    mappedStatus: error.statusCode,
    mappedRequestId: error.requestId ?? bodyRequestId,
    displayMessage: error.message,
  });
  if (upstreamDetails !== undefined) extra['upstreamDetails'] = upstreamDetails;
  if (Object.keys(extra).length > 0) attachErrorDetails(error, extra);
  return error;
}

const STRUCTURED_QUOTA_EXHAUSTED_CODES: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'exceeded_current_quota_error',
  'usage_limit_reached',
  'usage_not_included',
  'credit_balance_exhausted',
  'billing_hard_limit_reached',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
]);

/** Matches standard machine error codes that indicate exhausted provider quota rather than transient rate limiting. */
export function isStructuredQuotaExhaustedCode(code: unknown): boolean {
  return typeof code === 'string' && STRUCTURED_QUOTA_EXHAUSTED_CODES.has(code);
}

function hasStructuredQuotaExhaustedCode(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const envelope = body as Record<string, unknown>;
  if (
    isStructuredQuotaExhaustedCode(envelope['code']) ||
    isStructuredQuotaExhaustedCode(envelope['type'])
  ) {
    return true;
  }
  const nested = readNestedErrorObject(envelope);
  if (nested === undefined) return false;
  const nestedRecord = nested as Record<string, unknown>;
  return (
    isStructuredQuotaExhaustedCode(nestedRecord['code']) ||
    isStructuredQuotaExhaustedCode(nestedRecord['type'])
  );
}

export function isContextOverflowErrorCode(code: string | null | undefined): boolean {
  return code === 'context_length_exceeded';
}

export function normalizeAPIStatusError(
  statusCode: number,
  message: string,
  requestId?: string | null,
  retryAfterMs?: number | null,
  traceId?: string | null,
  body?: unknown,
): APIStatusError {
  const displayMessage = appendStatusErrorBodySnippet(statusCode, message, body);
  if (statusCode === 429) {
    const error = hasStructuredQuotaExhaustedCode(body)
      ? new APIProviderQuotaExhaustedError(displayMessage, requestId, retryAfterMs, traceId)
      : new APIProviderRateLimitError(displayMessage, requestId, retryAfterMs, traceId);
    return attachUpstreamStatusBodyDetails(error, body);
  }
  if (isContextOverflowStatusError(statusCode, message)) {
    return attachUpstreamStatusBodyDetails(
      new APIContextOverflowError(statusCode, displayMessage, requestId, retryAfterMs, traceId),
      body,
    );
  }
  if (isRequestTooLargeStatusError(statusCode, message)) {
    return attachUpstreamStatusBodyDetails(
      new APIRequestTooLargeError(statusCode, displayMessage, requestId, retryAfterMs, traceId),
      body,
    );
  }
  if (isProviderOverloadStatusError(statusCode, message)) {
    return attachUpstreamStatusBodyDetails(
      new APIProviderOverloadedError(statusCode, displayMessage, requestId, retryAfterMs, traceId),
      body,
    );
  }
  const hinted = appendThinkingEffortConfigHint(statusCode, displayMessage);
  return attachUpstreamStatusBodyDetails(
    new APIStatusError(
      statusCode,
      statusCode >= 400 ? truncateStatusErrorMessage(hinted) : hinted,
      requestId,
      retryAfterMs,
      traceId,
    ),
    body,
  );
}

const STRICT_NON_NEGATIVE_DECIMAL_RE = /^\d+(?:\.\d+)?$/;
const STRICT_NON_NEGATIVE_INTEGER_RE = /^\d+$/;

export function parseRetryAfterMs(headers: unknown): number | null {
  const rawMs = readHeaderCaseInsensitive(headers, 'retry-after-ms');
  if (rawMs !== undefined) {
    const trimmedMs = rawMs.trim();
    if (STRICT_NON_NEGATIVE_DECIMAL_RE.test(trimmedMs)) {
      const ms = Number(trimmedMs);
      if (Number.isFinite(ms) && ms > 0) return Math.max(1, Math.round(ms));
    }
  }
  const raw = readHeaderCaseInsensitive(headers, 'retry-after');
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!STRICT_NON_NEGATIVE_INTEGER_RE.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

export function parseTraceId(headers: unknown): string | null {
  const raw = readHeaderCaseInsensitive(headers, 'x-trace-id');
  if (raw === undefined || raw.length === 0) return null;
  return raw;
}

export function isContextOverflowStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 413 && statusCode !== 422) return false;
  const lowerMessage = message.toLowerCase();
  return CONTEXT_OVERFLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isProviderOverloadStatusError(statusCode: number, message: string): boolean {
  if (statusCode === 529) return true;
  if (statusCode !== 500 && statusCode !== 503) return false;
  const lowerMessage = message.toLowerCase();
  return PROVIDER_OVERLOAD_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isRequestTooLargeStatusError(statusCode: number, message = ''): boolean {
  return statusCode === 413 && !isContextOverflowStatusError(statusCode, message);
}

const TOOL_EXCHANGE_ADJACENCY_MESSAGE_PATTERNS = [
  /tool_use[\s\S]*tool_result/,
  /tool_result[\s\S]*tool_use/,
  /unexpected\s+`?tool_result/,
  /tool_call_id[\s\S]*not found/,
  /role\s+['"`]?tool['"`]?\s+must be a response to a preceding message/,
  /assistant message with\s+['"`]?tool_calls['"`]?\s+must be followed by tool messages/,
  /tool_call_ids? did not have response messages/,
  /insufficient tool messages following/,
] as const;

export function isToolExchangeAdjacencyError(error: unknown): boolean {
  if (!(error instanceof APIStatusError)) return false;
  if (error instanceof APIContextOverflowError) return false;
  if (error.statusCode !== 400 && error.statusCode !== 422) return false;
  const lowerMessage = error.message.toLowerCase();
  return TOOL_EXCHANGE_ADJACENCY_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

const STRUCTURAL_REQUEST_MESSAGE_PATTERNS = [
  /text content blocks must be non-empty/,
  /text content blocks must contain non-whitespace/,
  /first message must use the .*user.* role/,
  /roles must alternate/,
  /multiple .*(?:user|assistant).* roles in a row/,
  /tool_use[\s\S]*ids must be unique/,
  /message at position \d+ with role ['"`]?[a-z]+['"`]? must not be empty/,
] as const;

export function isRecoverableRequestStructureError(error: unknown): boolean {
  if (isToolExchangeAdjacencyError(error)) return true;
  if (!(error instanceof APIStatusError)) return false;
  if (error instanceof APIContextOverflowError) return false;
  if (error.statusCode !== 400 && error.statusCode !== 422) return false;
  const lowerMessage = error.message.toLowerCase();
  return STRUCTURAL_REQUEST_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isProviderRateLimitError(error: unknown): boolean {
  if (error instanceof APIProviderQuotaExhaustedError) return false;
  if (error instanceof APIProviderRateLimitError) return true;

  const statusCode = getStatusCode(error);
  if (statusCode !== undefined) return statusCode === 429;

  const lowerMessage = errorMessage(error).toLowerCase();
  return PROVIDER_RATE_LIMIT_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const record = error as Record<string, unknown>;
  const statusCode = record['statusCode'];
  if (typeof statusCode === 'number') return statusCode;
  const status = record['status'];
  if (typeof status === 'number') return status;

  const response = record['response'];
  if (typeof response !== 'object' || response === null) return undefined;
  const responseRecord = response as Record<string, unknown>;
  const responseStatusCode = responseRecord['statusCode'];
  if (typeof responseStatusCode === 'number') return responseStatusCode;
  const responseStatus = responseRecord['status'];
  return typeof responseStatus === 'number' ? responseStatus : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ApiErrorKind =
  | 'context_overflow'
  | 'overloaded'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth'
  | '5xx_server'
  | '4xx_client'
  | 'network'
  | 'timeout'
  | 'empty_response'
  | 'other';

export interface ApiErrorClassification {
  readonly kind: ApiErrorKind;
  readonly statusCode?: number;
}

export function classifyApiError(error: unknown): ApiErrorClassification {
  const statusCode = getStatusCode(error);
  if (error instanceof APIContextOverflowError) return { kind: 'context_overflow', statusCode };
  if (error instanceof APIProviderOverloadedError) return { kind: 'overloaded', statusCode };
  if (error instanceof APIProviderQuotaExhaustedError) {
    return { kind: 'quota_exhausted', statusCode };
  }
  if (error instanceof APIStatusError) {
    if (isContextOverflowStatusError(error.statusCode, error.message)) {
      return { kind: 'context_overflow', statusCode };
    }
    if (error.statusCode === 429) return { kind: 'rate_limit', statusCode };
    if (error.statusCode === 529) return { kind: 'overloaded', statusCode };
    if (error.statusCode === 401 || error.statusCode === 403) return { kind: 'auth', statusCode };
    if (error.statusCode >= 500) return { kind: '5xx_server', statusCode };
    if (error.statusCode >= 400) return { kind: '4xx_client', statusCode };
  }
  if (error instanceof APIConnectionError) return { kind: 'network', statusCode };
  if (error instanceof APITimeoutError) return { kind: 'timeout', statusCode };
  if (error instanceof APIEmptyResponseError) return { kind: 'empty_response', statusCode };
  return { kind: 'other', statusCode };
}
