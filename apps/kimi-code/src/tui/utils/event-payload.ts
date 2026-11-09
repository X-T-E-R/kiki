import { isKimiError } from '@kiki/node-sdk';
import { summarizeUpstreamCause } from '@kiki/transcript';

import {
  STREAMING_ARGS_FIELD_RE,
  STREAMING_ARGS_PREVIEW_MAX_CHARS,
} from '#/tui/constant/streaming';

export function appendStreamingArgsPreview(
  current: string | undefined,
  next: string | null | undefined,
): string {
  const existing = (current ?? '').slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);
  if (next === null || next === undefined || next.length === 0) return existing;
  const remaining = STREAMING_ARGS_PREVIEW_MAX_CHARS - existing.length;
  if (remaining <= 0) return existing;
  return `${existing}${next.slice(0, remaining)}`;
}

function unescapeJsonString(s: string): string {
  return s.replaceAll(/\\(["\\/bfnrt])/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      default:
        return ch;
    }
  });
}

export function parseStreamingArgs(argumentsText: string): Record<string, unknown> {
  const previewText = argumentsText.slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);
  if (previewText.trim().length === 0) return {};
  if (
    argumentsText.length <= STREAMING_ARGS_PREVIEW_MAX_CHARS &&
    previewText.trimEnd().endsWith('}')
  ) {
    try {
      const parsed = JSON.parse(previewText) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to partial scan
    }
  }
  const result: Record<string, unknown> = {};
  for (const match of previewText.matchAll(STREAMING_ARGS_FIELD_RE)) {
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    if (!(key in result)) {
      result[key] = unescapeJsonString(rawValue);
    }
  }
  return result;
}

export function argsRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

export function serializeToolResultOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  return JSON.stringify(output, null, 2);
}

export function isTodoItemShape(
  value: unknown,
): value is { title: string; status: 'pending' | 'in_progress' | 'done' } {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as { title?: unknown; status?: unknown };
  if (typeof rec.title !== 'string' || rec.title.length === 0) return false;
  return rec.status === 'pending' || rec.status === 'in_progress' || rec.status === 'done';
}

export function formatErrorMessage(error: unknown): string {
  if (isKimiError(error)) {
    return formatErrorPayload({
      code: error.code,
      message: error.message,
      details: error.details,
      cause: error.cause,
    });
  }
  return error instanceof Error ? error.message : String(error);
}

interface ErrorPayloadLike {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export function formatErrorPayload(error: ErrorPayloadLike): string {
  const filteredMessage = formatProviderFilteredMessage(error.details);
  if (filteredMessage !== undefined) return `[${error.code}] ${filteredMessage}`;
  const causeMessage = readCauseMessage(error.cause);
  const rawBaseMessage =
    error.message === 'The provider request ended without an observed outcome.' &&
    causeMessage !== undefined
      ? `${causeMessage} (${error.message})`
      : error.message;
  const promotedCause = summarizeUpstreamCause(rawBaseMessage, error.details);
  const normalizedOuter = rawBaseMessage.replaceAll(/\s+/g, ' ').trim();
  const baseMessage =
    promotedCause === undefined
      ? rawBaseMessage
      : normalizedOuter.length > 0 && normalizedOuter !== promotedCause
        ? `${promotedCause} (${normalizedOuter})`
        : promotedCause;
  const diagnosticSuffix = formatDiagnosticSuffix(error.details, baseMessage);
  return `[${error.code}] ${baseMessage}${diagnosticSuffix}`;
}

function readCauseMessage(cause: unknown): string | undefined {
  if (typeof cause === 'string' && cause.trim().length > 0) return cause.trim();
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const msg = (cause as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim().length > 0) return msg.trim();
  }
  return undefined;
}

function formatDiagnosticSuffix(
  details: Record<string, unknown> | undefined,
  message: string,
): string {
  if (details === undefined) return '';
  const items: string[] = [];
  const status = details['statusCode'] ?? details['upstreamStatus'];
  if (typeof status === 'number' && !message.includes(String(status))) {
    items.push(`status=${String(status)}`);
  }
  const upstreamCode = stringDetail(details, 'upstreamErrorCode');
  if (upstreamCode !== undefined && !message.includes(upstreamCode)) {
    items.push(`code=${upstreamCode}`);
  }
  const upstreamType = stringDetail(details, 'upstreamErrorType');
  if (
    upstreamType !== undefined &&
    upstreamType !== upstreamCode &&
    !message.includes(upstreamType)
  ) {
    items.push(`type=${upstreamType}`);
  }
  const requestId = stringDetail(details, 'requestId');
  if (requestId !== undefined && !message.includes(requestId)) {
    items.push(`requestId=${requestId}`);
  }
  const traceId = stringDetail(details, 'traceId');
  if (traceId !== undefined && !message.includes(traceId)) {
    items.push(`traceId=${traceId}`);
  }
  return items.length === 0 ? '' : ` (${items.join(', ')})`;
}

function formatProviderFilteredMessage(
  details: Record<string, unknown> | undefined,
): string | undefined {
  const finishReason = stringDetail(details, 'finishReason');
  const rawFinishReason = stringDetail(details, 'rawFinishReason');
  if (finishReason !== 'filtered' && rawFinishReason !== 'content_filter') return undefined;

  const normalizedFinishReason = finishReason ?? 'filtered';
  const raw = rawFinishReason === undefined ? '' : `, rawFinishReason=${rawFinishReason}`;
  return `Provider filtered the response before visible output (finishReason=${normalizedFinishReason}${raw}).`;
}

function stringDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
