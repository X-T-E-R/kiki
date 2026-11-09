const AMBIGUOUS_DELIVERY_MESSAGE = 'The provider request ended without an observed outcome.';

function readObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Extract a readable message from an error string that embeds a raw JSON
 * provider payload (such as `Anthropic error: {"error":{...}}`).
 */
export function extractReadableErrorMessage(rawMessage: string): string {
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
  const label =
    code !== undefined && !innerMessage.includes(code)
      ? `${code}: ${innerMessage}`
      : type !== undefined && !innerMessage.includes(type)
        ? `${type}: ${innerMessage}`
        : innerMessage;
  if (prefix.length === 0 || prefix === 'Error' || prefix === 'error') return label;
  if (label.startsWith(prefix)) return label;
  return `${prefix}: ${label}`;
}

interface ErrorRecordEntry {
  readonly code?: string;
  readonly name?: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

function collectErrorRecordChain(rawError: unknown): ErrorRecordEntry[] {
  const chain: ErrorRecordEntry[] = [];
  const seen = new Set<object>();
  let current = readObjectRecord(rawError);
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const message = typeof current['message'] === 'string' ? current['message'] : '';
    const code = readNonEmptyString(current, 'code');
    const name = readNonEmptyString(current, 'name');
    const details = readObjectRecord(current['details']);
    chain.push({ code, name, message, details });
    current = readObjectRecord(current['cause']);
  }
  return chain;
}

const ORDERED_DETAIL_KEYS: readonly string[] = [
  'statusCode',
  'upstreamStatus',
  'upstreamErrorCode',
  'upstreamErrorType',
  'errorSource',
  'requestId',
  'traceId',
  'request_delivery',
  'request_output',
  'upstream_retryable',
  'finishReason',
  'rawFinishReason',
  'retryAfterMs',
  'retry_attempts',
  'retry_max_attempts',
  'upstreamDetails',
];

function formatDetailScalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const SPECIFIC_CAUSE_MAX_CHARS = 300;
const SPECIFIC_CAUSE_PREFIX_PROBE = 48;

function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const point = text.codePointAt(index - 1);
  return point !== undefined && point > 0xffff;
}

function sliceUtf16Prefix(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.min(Math.trunc(maxChars) || 0, text.length));
  return text.slice(0, splitsSurrogatePair(text, limit) ? limit - 1 : limit);
}

function truncateUtf16Line(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return sliceUtf16Prefix(text, maxChars);
  return `${sliceUtf16Prefix(text, maxChars - 3)}...`;
}

function extractProviderPrefix(message: string): string | undefined {
  const match = /^([A-Za-z][A-Za-z0-9 _-]{0,30}error):\s+/i.exec(message.trim());
  const prefix = match?.[1]?.trim();
  if (prefix === undefined || prefix.toLowerCase() === 'error') return undefined;
  return prefix;
}

/**
 * Promote a specific `upstreamDetails.message` over an outer generic transport
 * message when the outer message does not already contain the upstream reason,
 * truncating the assembled single-line summary on a complete UTF-16 code-point
 * boundary.
 */
export function summarizeUpstreamCause(
  outerMessage: string,
  mergedDetails: Record<string, unknown> | undefined,
): string | undefined {
  if (mergedDetails === undefined) return undefined;
  const upstreamDetails = readObjectRecord(mergedDetails['upstreamDetails']);
  const upstreamMessage = readNonEmptyString(upstreamDetails, 'message');
  if (upstreamMessage === undefined) return undefined;
  const normalizedOuter = outerMessage.replaceAll(/\s+/g, ' ').trim();
  const normalizedUpstream = upstreamMessage.replaceAll(/\s+/g, ' ').trim();
  if (normalizedUpstream.length === 0) return undefined;
  const probe = sliceUtf16Prefix(
    normalizedUpstream,
    Math.min(SPECIFIC_CAUSE_PREFIX_PROBE, normalizedUpstream.length),
  );
  if (normalizedOuter.includes(normalizedUpstream) || (probe.length > 0 && normalizedOuter.includes(probe))) {
    return undefined;
  }
  const rawCode = upstreamDetails?.['code'];
  const code = (
    readNonEmptyString(mergedDetails, 'upstreamErrorCode') ??
    (typeof rawCode === 'string' && rawCode.trim().length > 0
      ? rawCode.trim()
      : typeof rawCode === 'number' && Number.isFinite(rawCode)
        ? String(rawCode)
        : undefined)
  )?.replaceAll(/\s+/g, ' ');
  const type = (
    readNonEmptyString(mergedDetails, 'upstreamErrorType') ??
    readNonEmptyString(upstreamDetails, 'type') ??
    readNonEmptyString(upstreamDetails, 'status')
  )?.replaceAll(/\s+/g, ' ');
  const label =
    code !== undefined && !normalizedUpstream.includes(code)
      ? `${code}: ${normalizedUpstream}`
      : type !== undefined && !normalizedUpstream.includes(type)
        ? `${type}: ${normalizedUpstream}`
        : normalizedUpstream;
  const providerPrefix = extractProviderPrefix(outerMessage);
  const assembled =
    providerPrefix === undefined || label.startsWith(providerPrefix)
      ? label
      : `${providerPrefix}: ${label}`;
  return truncateUtf16Line(assembled, SPECIFIC_CAUSE_MAX_CHARS);
}

/**
 * Project a turn-end error payload (live event or persisted wire record) into
 * its primary human-readable message and optional full diagnostic details.
 */
export function projectTurnError(rawError: unknown): {
  readonly error?: string;
  readonly errorDetails?: string;
} {
  if (typeof rawError === 'string') {
    const trimmed = rawError.trim();
    if (trimmed.length === 0) return {};
    const readable = extractReadableErrorMessage(rawError);
    return {
      error: readable,
      errorDetails: readable !== rawError ? rawError : undefined,
    };
  }
  const chain = collectErrorRecordChain(rawError);
  if (chain.length === 0) return {};
  const top = chain[0]!;
  const primary =
    chain.find(
      (entry) => entry.message.trim().length > 0 && entry.message !== AMBIGUOUS_DELIVERY_MESSAGE,
    ) ?? top;
  if (primary.message.length === 0 && top.message.length === 0) return {};
  const hadAmbiguousWrapper = top.message === AMBIGUOUS_DELIVERY_MESSAGE && primary !== top;
  const outerReadable = extractReadableErrorMessage(primary.message);

  const mergedDetails: Record<string, unknown> = {};
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const entryDetails = chain[i]?.details;
    if (entryDetails === undefined) continue;
    for (const [key, value] of Object.entries(entryDetails)) {
      if (value === undefined || value === null) continue;
      mergedDetails[key] = value;
    }
  }

  const promotedCause = summarizeUpstreamCause(outerReadable, mergedDetails);
  let error = promotedCause ?? outerReadable;
  if (hadAmbiguousWrapper && !error.includes(AMBIGUOUS_DELIVERY_MESSAGE)) {
    error = `${error} (${AMBIGUOUS_DELIVERY_MESSAGE})`;
  }
  const retryOwner = chain.find((entry) => entry.details?.['retry_exhausted'] === true) ?? top;
  const retryDetails = retryOwner.details;
  const attempts = retryDetails?.['retry_attempts'];
  const maxAttempts = retryDetails?.['retry_max_attempts'];
  if (
    retryDetails?.['retry_exhausted'] === true &&
    typeof attempts === 'number' &&
    Number.isSafeInteger(attempts) &&
    attempts >= 1 &&
    typeof maxAttempts === 'number' &&
    Number.isSafeInteger(maxAttempts) &&
    maxAttempts >= 1 &&
    attempts >= maxAttempts
  ) {
    const summary = `Retry attempts exhausted (${attempts}/${maxAttempts}).`;
    if (!error.startsWith(summary)) error = `${summary} ${error}`;
  }

  const detailFields: string[] = [];
  const code = primary.code ?? top.code;
  if (code !== undefined) detailFields.push(`code=${code}`);
  const consumedKeys = new Set<string>(['error_kind', 'retry', 'retry_exhausted']);
  for (const key of ORDERED_DETAIL_KEYS) {
    if (!(key in mergedDetails)) continue;
    consumedKeys.add(key);
    detailFields.push(`${key}=${formatDetailScalar(mergedDetails[key])}`);
  }
  for (const [key, value] of Object.entries(mergedDetails)) {
    if (consumedKeys.has(key)) continue;
    detailFields.push(`${key}=${formatDetailScalar(value)}`);
  }

  const causeLines: string[] = [];
  if (
    promotedCause !== undefined &&
    outerReadable.trim().length > 0 &&
    outerReadable !== error
  ) {
    causeLines.push(outerReadable);
  }
  for (const entry of chain) {
    if (entry === primary) continue;
    const msg = entry.message.trim();
    if (msg.length === 0 || msg === AMBIGUOUS_DELIVERY_MESSAGE) continue;
    const readableCause = extractReadableErrorMessage(msg);
    if (readableCause !== error && !causeLines.includes(readableCause)) {
      causeLines.push(readableCause);
    }
  }

  const hasRawJsonDiff = primary.message.trim() !== error.trim() && primary.message.includes('{');
  if (detailFields.length === 0 && causeLines.length === 0 && !hasRawJsonDiff) {
    return { error };
  }

  const lines: string[] = [error];
  if (detailFields.length > 0) lines.push(detailFields.join(' · '));
  for (const cause of causeLines) lines.push(`cause: ${cause}`);
  if (hasRawJsonDiff) lines.push(`raw: ${primary.message.trim()}`);
  return {
    error,
    errorDetails: lines.join('\n'),
  };
}
