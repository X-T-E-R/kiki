import { Error2, type Error2Options } from '#/_base/errors/errors';
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

export class ChatProviderError extends Error2 {
  constructor(
    message: string,
    code: ProviderErrorCode = PROVIDER_API_ERROR_CODE,
    options?: Error2Options,
  ) {
    super(code, message, { ...options, name: 'ChatProviderError' });
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
    super(sanitizeStatusErrorMessage(message), code, {
      details: { statusCode, requestId: requestId ?? null, traceId: traceId ?? null },
    });
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

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as object).constructor?.name === 'APIUserAbortError'
  );
}

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

export function isRetryableGenerateError(error: unknown): boolean {
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
    return (
      error.statusCode === 408 ||
      error.statusCode === 409 ||
      error.statusCode === 429 ||
      (error.statusCode >= 500 && error.statusCode <= 599)
    );
  }
  return error instanceof ChatProviderError && !isImageFormatError(error);
}

const NETWORK_RE = /network|connection|connect|disconnect|terminated/i;
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

const REQUEST_TOO_LARGE_MESSAGE_PATTERNS = [
  /request exceeds the maximum size/,
  /request entity too large/,
  /request_too_large/,
  /exceeds? the maximum allowed number of bytes/,
  /payload too large/,
  /content too large/,
  /request (?:body )?too large/,
] as const;

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
  return `${text.slice(0, STATUS_ERROR_BODY_SNIPPET_MAX_CHARS)}...`;
}

function truncateStatusErrorMessage(text: string): string {
  if (text.length <= STATUS_ERROR_MESSAGE_MAX_CHARS) return text;
  return `${text.slice(0, STATUS_ERROR_MESSAGE_MAX_CHARS - 3)}...`;
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

function extractStatusErrorBodyDetail(body: unknown): string | null {
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
      if (trimmed.length > 0) return trimmed;
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

function compose400StatusErrorMessage(message: string, body: unknown): string {
  const redactedMessage = redactSensitiveText(message);
  const detail = extractStatusErrorBodyDetail(body);
  let assembled = redactedMessage;
  if (detail !== null && !messageContainsStatusErrorDetail(redactedMessage, detail)) {
    const snippet = truncateStatusErrorSnippet(detail);
    if (!messageContainsStatusErrorDetail(redactedMessage, snippet)) {
      assembled = `${redactedMessage} — ${snippet}`;
    }
  }
  return truncateStatusErrorMessage(assembled);
}

function appendStatusErrorBodySnippet(statusCode: number, message: string, body: unknown): string {
  if (statusCode !== 400) return message;
  return compose400StatusErrorMessage(message, body);
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
    return new APIProviderRateLimitError(message, requestId, retryAfterMs, traceId);
  }
  if (isContextOverflowStatusError(statusCode, message)) {
    return new APIContextOverflowError(statusCode, displayMessage, requestId, retryAfterMs, traceId);
  }
  if (isRequestTooLargeStatusError(statusCode, message)) {
    return new APIRequestTooLargeError(statusCode, displayMessage, requestId, retryAfterMs, traceId);
  }
  if (isProviderOverloadStatusError(statusCode, message)) {
    return new APIProviderOverloadedError(statusCode, displayMessage, requestId, retryAfterMs, traceId);
  }
  const hinted = appendThinkingEffortConfigHint(statusCode, displayMessage);
  return new APIStatusError(
    statusCode,
    statusCode === 400 ? truncateStatusErrorMessage(hinted) : hinted,
    requestId,
    retryAfterMs,
    traceId,
  );
}

export function parseRetryAfterMs(headers: unknown): number | null {
  const raw =
    headers !== null &&
    typeof headers === 'object' &&
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get(name: string): string | null }).get('retry-after')
      : null;
  if (raw === null || raw === undefined) return null;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

export function parseTraceId(headers: unknown): string | null {
  const raw =
    headers !== null &&
    typeof headers === 'object' &&
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get(name: string): string | null }).get('x-trace-id')
      : null;
  if (raw === null || raw === undefined || raw.length === 0) return null;
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

export function isRequestTooLargeStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 413) return false;
  const lowerMessage = message.toLowerCase();
  return REQUEST_TOO_LARGE_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
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
