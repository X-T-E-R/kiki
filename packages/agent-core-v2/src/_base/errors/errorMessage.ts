import { isCodedError, toErrorPayload, type ErrorPayload } from './serialize';

const AMBIGUOUS_DELIVERY_MESSAGE = 'The provider request ended without an observed outcome.';

function readObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function extractReadableInlineJsonMessage(rawMessage: string): string {
  const trimmed = rawMessage.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart < 0 || !trimmed.endsWith('}')) return rawMessage;
  const prefix = trimmed.slice(0, jsonStart).replace(/[\s:：-]+$/, '').trim();
  const jsonSlice = trimmed.slice(jsonStart);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return rawMessage;
  }
  const root = readObjectRecord(parsed);
  if (root === undefined) return rawMessage;
  const nested = readObjectRecord(root['error']) ?? root;
  const innerMessage =
    readNonEmptyString(nested, 'message') ??
    readNonEmptyString(nested, 'detail') ??
    readNonEmptyString(root, 'message') ??
    readNonEmptyString(root, 'detail');
  if (innerMessage === undefined) return rawMessage;
  const code =
    readNonEmptyString(nested, 'code') ??
    readNonEmptyString(nested, 'reason') ??
    readNonEmptyString(root, 'code');
  const type =
    readNonEmptyString(nested, 'type') ??
    readNonEmptyString(nested, 'status') ??
    readNonEmptyString(root, 'type');
  const label = code !== undefined && !innerMessage.includes(code)
    ? `${code}: ${innerMessage}`
    : type !== undefined && !innerMessage.includes(type)
      ? `${type}: ${innerMessage}`
      : innerMessage;
  if (prefix.length === 0 || prefix === 'Error' || prefix === 'error') return label;
  if (label.startsWith(prefix)) return label;
  return `${prefix}: ${label}`;
}

function collectErrorPayloadChain(payload: ErrorPayload): ErrorPayload[] {
  const chain: ErrorPayload[] = [];
  const seen = new Set<ErrorPayload>();
  let current: ErrorPayload | undefined = payload;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function mergeDiagnosticDetails(chain: readonly ErrorPayload[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const details = chain[i]?.details;
    if (details === undefined) continue;
    for (const [key, value] of Object.entries(details)) {
      if (value === undefined || value === null) continue;
      merged[key] = value;
    }
  }
  return merged;
}

function formatErrorDiagnosticSuffix(
  merged: Record<string, unknown>,
  message: string,
  includeStatus: boolean,
): string {
  const parts: string[] = [];
  const status = merged['statusCode'] ?? merged['upstreamStatus'];
  const upstreamCode = readNonEmptyString(merged, 'upstreamErrorCode');
  const upstreamType = readNonEmptyString(merged, 'upstreamErrorType');
  const requestId = readNonEmptyString(merged, 'requestId');
  const traceId = readNonEmptyString(merged, 'traceId');
  const upstreamDetails = readObjectRecord(merged['upstreamDetails']);
  const hasUnrenderedDetail =
    includeStatus ||
    (upstreamCode !== undefined && !message.includes(upstreamCode)) ||
    (upstreamType !== undefined && upstreamType !== upstreamCode && !message.includes(upstreamType)) ||
    (requestId !== undefined && !message.includes(requestId)) ||
    (traceId !== undefined && !message.includes(traceId)) ||
    (upstreamDetails !== undefined && Object.keys(upstreamDetails).length > 0);
  if (
    hasUnrenderedDetail &&
    typeof status === 'number' &&
    !message.includes(String(status))
  ) {
    parts.push(`HTTP ${String(status)}`);
  }
  if (upstreamCode !== undefined && !message.includes(upstreamCode)) {
    parts.push(`code=${upstreamCode}`);
  }
  if (
    upstreamType !== undefined &&
    upstreamType !== upstreamCode &&
    !message.includes(upstreamType)
  ) {
    parts.push(`type=${upstreamType}`);
  }
  if (requestId !== undefined && !message.includes(requestId)) {
    parts.push(`requestId=${requestId}`);
  }
  if (traceId !== undefined && !message.includes(traceId)) {
    parts.push(`traceId=${traceId}`);
  }
  if (upstreamDetails !== undefined && Object.keys(upstreamDetails).length > 0) {
    try {
      const json = JSON.stringify(upstreamDetails);
      if (json !== undefined && !message.includes(json)) {
        parts.push(`details=${json}`);
      }
    } catch {
      void 0;
    }
  }
  return parts.length === 0 ? '' : ` [${parts.join(', ')}]`;
}

export function toErrorDisplayMessage(error: unknown): string {
  const payload = toErrorPayload(error);
  const chain = collectErrorPayloadChain(payload);
  const primaryEntry =
    chain.find((entry) => entry.message.trim().length > 0 && entry.message !== AMBIGUOUS_DELIVERY_MESSAGE) ??
    payload;
  const hadAmbiguousWrapper =
    payload.message === AMBIGUOUS_DELIVERY_MESSAGE && primaryEntry !== payload;
  let message = extractReadableInlineJsonMessage(primaryEntry.message);
  if (hadAmbiguousWrapper && !message.includes(AMBIGUOUS_DELIVERY_MESSAGE)) {
    message = `${message} (${AMBIGUOUS_DELIVERY_MESSAGE})`;
  }
  const merged = mergeDiagnosticDetails(chain);
  message = `${message}${formatErrorDiagnosticSuffix(merged, message, hadAmbiguousWrapper)}`;
  const retryOwner = chain.find((entry) => entry.details?.['retry_exhausted'] === true) ?? payload;
  const details = retryOwner.details;
  const attempts = details?.['retry_attempts'];
  const maxAttempts = details?.['retry_max_attempts'];
  if (details?.['retry_exhausted'] !== true ||
    typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 1 ||
    typeof maxAttempts !== 'number' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
    attempts < maxAttempts) return message;
  const summary = `Retry attempts exhausted (${attempts}/${maxAttempts}).`;
  return message.startsWith(summary) ? message : `${summary} ${message}`;
}

export function toErrorMessage(error: unknown, verbose = false): string {
  if (isCodedError(error)) {
    const base = `[${error.code}] ${error.message}`;
    return verbose && error.details ? `${base} ${JSON.stringify(error.details)}` : base;
  }
  if (error instanceof Error) {
    const base = error.message || error.name;
    if (verbose && error.cause !== undefined) {
      return `${base} (caused by: ${toErrorMessage(error.cause)})`;
    }
    return base;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
