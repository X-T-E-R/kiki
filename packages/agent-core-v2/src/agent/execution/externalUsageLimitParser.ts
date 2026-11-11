import { redactMemorySecrets } from '#/app/memory/memorySafety';
import { Error2, ErrorCodes, isCodedError } from '#/errors';
import { parseClaudeUsageWindows, type ClaudeUsageWindow } from './claudeUsageWindowParser';

export interface ExternalUsageLimitContext {
  readonly executorId?: string;
  readonly stderrTail?: string;
  readonly observedResetAt?: string;
  readonly observedWindows?: readonly ClaudeUsageWindow[];
  readonly accountLabel?: string;
  readonly accountSource?: string;
  readonly nowMs?: number;
}

export interface ParsedExternalUsageLimit {
  readonly message: string;
  readonly statusCode: number;
  readonly upstreamErrorCode?: string;
  readonly upstreamErrorType?: string;
  readonly resetAt?: string;
  readonly resetAtMs?: number;
  readonly retryAfterMs?: number;
  readonly stderrTail?: string;
  readonly windows?: readonly ClaudeUsageWindow[];
}

const XAI_RATE_LIMITED_RPC_CODE = -32003;
const MAX_SAFE_DATE_MS = 8.64e15;

const EXPLICIT_QUOTA_CODE_SET = new Set([
  'provider.rate_limit',
  'provider.rate-limit',
  'provider.quota',
  'usagelimitexceeded',
  'usage_limit_exceeded',
  'ratelimitexceeded',
  'rate_limit_exceeded',
  'rate_limit_error',
  'quota_exhausted',
  'quotaexceeded',
  'quota_exceeded',
  'resource_exhausted',
  'insufficient_quota',
  'too_many_requests',
  'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_workplace_individual_usage_limit_exceeded',
]);

const SHARING_LIMIT_CODE_SET = new Set([
  'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_workplace_individual_usage_limit_exceeded',
]);

const PERMANENT_BILLING_PATTERN = /\bstatus(?:\s*code)?\s*[:=]\s*402\b|\bHTTP\s+402\b|\bpayment[_\s-]*required\b|\bcredit\s+balance\s+is\s+too\s+low\b/i;

const NETWORK_DISCONNECT_PATTERN = /\b(?:wsarecv|wsasend|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)\b|socket\s+hang\s+up|read\s+tcp|write\s+tcp|connection\s+was\s+forcibly\s+closed|network\s+(?:error|issue|disconnected)/i;

const EXPLICIT_QUOTA_TEXT_PATTERN = /\b(?:RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|rate_limit_error|rate_limit_event|usage_limit_exceeded|rate_limit_exceeded|ConnectError:\s*\[resource_exhausted\])\b|you(?:'ve|\s+have)\s+hit\s+your\s+[^\n.]{0,60}limit|has\s+reached\s+their\s+Subscription\s+Sharing\s+usage\s+limit|quota[\s_-]*(?:reached|exceeded|exhausted)|rate[\s_-]*limit[\s_-]*(?:reached|exceeded)|usage[\s_-]*limit[\s_-]*(?:reached|exceeded)|insufficient[\s_-]*quota|额度(?:已用尽|耗尽|不足)/i;

const HTTP_429_TEXT_PATTERN = /\b(?:HTTP(?:\/[\d.]+)?\s+429|status(?:\s*code)?\s*[:=]\s*429|\[429\]|Error\s+429)\b|\btoo\s+many\s+requests\b/i;

const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /(Bearer\s+)\S+/gi,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxai-[A-Za-z0-9_-]{12,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
  /([?&](?:api[_-]?key|access[_-]?token|token|key|secret)=)[^&\s"']+/gi,
];

/**
 * Extract normalized cross-harness 429 / usage-limit facts across Codex,
 * Claude, Grok (`_x.ai`), Cursor, Kiro, OpenCode, and Antigravity error
 * envelopes and stderr diagnostics.
 */
export function parseExternalUsageLimit(
  error: unknown,
  context: ExternalUsageLimitContext = {},
): ParsedExternalUsageLimit | undefined {
  const nowMs = context.nowMs ?? Date.now();
  const nodes = collectErrorNodes(error);
  const stderrText = sanitizeText(context.stderrTail);
  const texts = collectCandidateTexts(nodes, stderrText);
  const combined = texts.join('\n');

  if (hasHttp402(nodes, combined)) return undefined;

  const statusCode = extractStatusCode(nodes, combined);
  const rpcCode = extractRpcCode(nodes);
  const upstreamErrorCode = extractErrorCode(nodes, combined);
  const upstreamErrorType = extractErrorType(nodes, combined);
  const rejectedRateLimitEvent = hasRejectedRateLimitInfo(nodes);

  const normalizedCode = upstreamErrorCode?.toLowerCase();
  const normalizedType = upstreamErrorType?.toLowerCase();
  const explicitStructured =
    statusCode === 429 ||
    rpcCode === XAI_RATE_LIMITED_RPC_CODE ||
    rejectedRateLimitEvent ||
    (normalizedCode !== undefined && EXPLICIT_QUOTA_CODE_SET.has(normalizedCode)) ||
    (normalizedType !== undefined && EXPLICIT_QUOTA_CODE_SET.has(normalizedType));

  const explicitText = EXPLICIT_QUOTA_TEXT_PATTERN.test(combined);
  const pureNetwork = !explicitStructured && !explicitText && NETWORK_DISCONNECT_PATTERN.test(combined);
  if (pureNetwork) return undefined;

  const matched = explicitStructured || explicitText || HTTP_429_TEXT_PATTERN.test(combined);
  if (!matched) return undefined;

  const sharingLimit =
    (normalizedCode !== undefined && SHARING_LIMIT_CODE_SET.has(normalizedCode)) ||
    /has\s+reached\s+their\s+Subscription\s+Sharing\s+usage\s+limit/i.test(combined);

  const errorWindows = [...new Map(nodes.flatMap(parseClaudeUsageWindows).map((window) => [window.id, window])).values()];
  const windowsById = new Map((context.observedWindows ?? []).map((window) => [window.id, window]));
  for (const window of errorWindows) windowsById.set(window.id, window);
  const windows = [...windowsById.values()];
  const errorWindowsResetAt = exhaustedWindowsResetAt(errorWindows);
  const observedWindowsResetAt = sharingLimit ? undefined : exhaustedWindowsResetAt(windows);
  const directTiming = errorWindowsResetAt === undefined
    ? extractResetTiming(nodes, texts, undefined, nowMs)
    : undefined;
  const timing = errorWindowsResetAt !== undefined
    ? finalizeResetIso(errorWindowsResetAt, nowMs)
    : directTiming?.resetAt !== undefined || directTiming?.retryAfterMs !== undefined
      ? directTiming
      : observedWindowsResetAt !== undefined
        ? finalizeResetIso(observedWindowsResetAt, nowMs)
        : extractResetTiming(nodes, texts, sharingLimit ? undefined : context.observedResetAt, nowMs);
  const baseMessage = selectReadableMessage(nodes, texts, upstreamErrorCode);

  return {
    message: baseMessage,
    statusCode: statusCode ?? 429,
    upstreamErrorCode,
    upstreamErrorType,
    resetAt: timing.resetAt,
    resetAtMs: timing.resetAtMs,
    retryAfterMs: timing.retryAfterMs,
    stderrTail: stderrText && stderrText.length > 0 ? stderrText.slice(-4096) : undefined,
    windows: windows.length === 0 ? undefined : windows,
  };
}

function exhaustedWindowsResetAt(windows: readonly ClaudeUsageWindow[]): string | undefined {
  return windows.flatMap((window) => window.usedPercent === 100 && window.resetsAt !== undefined
    ? [window.resetsAt] : []).sort().at(-1);
}

/**
 * Normalize an external executor error into an `Error2(PROVIDER_RATE_LIMIT)`
 * when it represents a rate-limit or quota exhaustion, preserving cause chains,
 * `resetAt` / `retryAfterMs` details, and optional plugin-account attribution.
 */
export function normalizeExternalExecutorError(
  error: unknown,
  context: ExternalUsageLimitContext = {},
): unknown {
  const parsed = parseExternalUsageLimit(error, context);
  if (parsed === undefined) {
    return wrapAccountPrefix(error, context);
  }

  const existingDetails = isCodedError(error) ? error.details : undefined;
  const details: Record<string, unknown> = {
    ...existingDetails,
    executorId: context.executorId ?? existingDetails?.['executorId'],
    accountSource: context.accountSource ?? existingDetails?.['accountSource'],
    statusCode: parsed.statusCode,
    reason_code: 'quota_exceeded',
    upstreamErrorCode: parsed.upstreamErrorCode ?? existingDetails?.['upstreamErrorCode'],
    upstreamErrorType: parsed.upstreamErrorType ?? existingDetails?.['upstreamErrorType'],
    resetAt: parsed.resetAt ?? existingDetails?.['resetAt'],
    resetAtMs: parsed.resetAtMs ?? existingDetails?.['resetAtMs'],
    retryAfterMs: parsed.retryAfterMs ?? existingDetails?.['retryAfterMs'],
    stderrTail: parsed.stderrTail ?? existingDetails?.['stderrTail'],
    windows: parsed.windows ?? existingDetails?.['windows'],
  };
  for (const key of Object.keys(details)) {
    if (details[key] === undefined) delete details[key];
  }

  const withResetHint = parsed.resetAt !== undefined && !parsed.message.includes(parsed.resetAt)
    ? `${parsed.message} (resets at ${parsed.resetAt})`
    : parsed.message;
  const finalMessage = formatAccountMessage(withResetHint, context);

  if (
    isCodedError(error) &&
    error.code === ErrorCodes.PROVIDER_RATE_LIMIT &&
    error.message === finalMessage &&
    error.details?.['resetAt'] === details['resetAt'] &&
    error.details?.['statusCode'] === details['statusCode'] &&
    (parsed.windows === undefined || JSON.stringify(error.details?.['windows']) === JSON.stringify(parsed.windows))
  ) {
    return error;
  }

  return new Error2(ErrorCodes.PROVIDER_RATE_LIMIT, finalMessage, {
    details,
    cause: error instanceof Error ? error : undefined,
  });
}

/**
 * Extract an ISO `resetAt` timestamp from a streaming `session.info` or
 * rate-limit notification payload so a subsequent failed turn can attach it.
 */
export function extractStreamingRateLimitResetAt(meta: unknown, nowMs = Date.now()): string | undefined {
  const rec = objectOf(meta);
  if (rec === undefined) return undefined;
  const claudeReset = exhaustedWindowsResetAt(parseClaudeUsageWindows(rec));
  if (claudeReset !== undefined) return claudeReset;
  const direct = parseIsoOrEpoch(rec['resetAt'] ?? rec['resetsAt'] ?? rec['reset_at'] ?? rec['resets_at']);
  if (direct !== undefined) return direct;
  const rateLimitInfo = objectOf(rec['rate_limit_info'] ?? rec['rateLimitInfo']);
  if (rateLimitInfo !== undefined) {
    const infoReset = parseIsoOrEpoch(rateLimitInfo['resetsAt'] ?? rateLimitInfo['resets_at'] ?? rateLimitInfo['resetAt']);
    if (infoReset !== undefined) return infoReset;
  }
  const usageLimit = objectOf(rec['usageLimit']);
  if (usageLimit !== undefined) {
    const usageReset = parseIsoOrEpoch(usageLimit['resetAt'] ?? usageLimit['resetsAt']);
    if (usageReset !== undefined) return usageReset;
  }
  const rateLimits = objectOf(rec['rateLimits']);
  if (rateLimits !== undefined) {
    const windowResets: string[] = [];
    for (const key of ['primary', 'secondary'] as const) {
      const win = objectOf(rateLimits[key]);
      const used = numberOf(win?.['usedPercent'] ?? win?.['used_percent']);
      if (used !== undefined && used >= 100) {
        const iso = parseIsoOrEpoch(win?.['resetsAt'] ?? win?.['resets_at']);
        if (iso !== undefined) windowResets.push(iso);
      }
    }
    if (windowResets.length > 0) {
      return windowResets.reduce((latest, current) => (Date.parse(current) > Date.parse(latest) ? current : latest));
    }
  }
  const retrySec = numberOf(rec['retryAfterSeconds'] ?? rec['retry_after_seconds']);
  if (retrySec !== undefined && retrySec > 0) {
    return isoFromMs(nowMs + Math.round(retrySec * 1000));
  }
  return undefined;
}

function wrapAccountPrefix(error: unknown, context: ExternalUsageLimitContext): unknown {
  if (context.accountSource === undefined) return error;
  const base = error instanceof Error ? error.message : 'Engine request failed';
  const prefixed = formatAccountMessage(base, context);
  if (isCodedError(error) && error instanceof Error2) {
    if (error.message === prefixed) return error;
    return new Error2(error.code, prefixed, {
      name: error.name,
      details: {
        ...error.details,
        executorId: context.executorId ?? error.details?.['executorId'],
        accountSource: context.accountSource,
      },
      cause: error,
    });
  }
  return new Error(prefixed, { cause: error });
}

function formatAccountMessage(message: string, context: ExternalUsageLimitContext): string {
  if (context.accountSource === undefined) return message;
  const label = context.accountLabel ?? context.executorId ?? 'instance';
  const prefix = `Executor instance "${label}" (${context.accountSource}): `;
  return message.startsWith(prefix) ? message : `${prefix}${message}`;
}

function collectErrorNodes(root: unknown): Readonly<Record<string, unknown>>[] {
  const queue: unknown[] = [root];
  const seen = new Set<object>();
  const out: Readonly<Record<string, unknown>>[] = [];

  while (queue.length > 0 && out.length < 32) {
    const current = queue.shift();
    if (typeof current === 'string') {
      const parsed = tryParseEmbeddedJson(current);
      if (parsed !== undefined) queue.push(parsed);
      continue;
    }
    const rec = objectOf(current);
    if (rec === undefined || seen.has(rec)) continue;
    seen.add(rec);
    out.push(rec);

    for (const key of [
      'error',
      'cause',
      'data',
      'details',
      'outcome',
      'usageLimit',
      'codexErrorInfo',
      'codex_error_info',
      'responseTooManyFailedAttempts',
      'response_too_many_failed_attempts',
      'api_error_params',
      'rate_limit_info',
      'rateLimitInfo',
      'upstreamDetails',
      'responseBody',
      'body',
    ]) {
      const child = rec[key];
      if (child !== undefined && child !== null) queue.push(child);
    }
    for (const textKey of ['message', 'additionalDetails', 'detail', 'stderrTail', 'responseBody']) {
      const rawText = rec[textKey];
      if (typeof rawText === 'string') {
        const parsed = tryParseEmbeddedJson(rawText);
        if (parsed !== undefined) queue.push(parsed);
      }
    }
  }
  return out;
}

function collectCandidateTexts(
  nodes: readonly Readonly<Record<string, unknown>>[],
  stderrTail: string | undefined,
): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const cleaned = sanitizeText(value);
    if (cleaned && cleaned.length > 0 && !out.includes(cleaned)) out.push(cleaned);
  };
  for (const node of nodes) {
    push(node['errorMessage']);
    push(node['message']);
    push(node['additionalDetails']);
    push(node['detail']);
    push(node['reason']);
    push(node['stderrTail']);
  }
  if (stderrTail) push(stderrTail);
  return out;
}

function hasHttp402(nodes: readonly Readonly<Record<string, unknown>>[], combinedText: string): boolean {
  for (const node of nodes) {
    for (const key of ['status', 'statusCode', 'httpStatusCode', 'http_status_code', 'api_error_status', 'upstreamStatus']) {
      if (numberOf(node[key]) === 402) return true;
    }
  }
  return PERMANENT_BILLING_PATTERN.test(combinedText);
}

function extractStatusCode(nodes: readonly Readonly<Record<string, unknown>>[], combinedText: string): number | undefined {
  for (const node of nodes) {
    for (const key of ['httpStatusCode', 'http_status_code', 'statusCode', 'status_code', 'api_error_status', 'upstreamStatus', 'status']) {
      const code = numberOf(node[key]);
      if (code !== undefined && code >= 100 && code <= 599) {
        if (code === 429) return 429;
      }
    }
  }
  if (/\b429\b/.test(combinedText) && HTTP_429_TEXT_PATTERN.test(combinedText)) return 429;
  for (const node of nodes) {
    for (const key of ['httpStatusCode', 'http_status_code', 'statusCode', 'status_code', 'api_error_status', 'upstreamStatus', 'status']) {
      const code = numberOf(node[key]);
      if (code !== undefined && code >= 400 && code <= 599) return code;
    }
  }
  return undefined;
}

function extractRpcCode(nodes: readonly Readonly<Record<string, unknown>>[]): number | undefined {
  for (const node of nodes) {
    const code = numberOf(node['remoteCode'] ?? node['rpcCode'] ?? node['code']);
    if (code !== undefined && code < 0) return code;
  }
  return undefined;
}

function extractErrorCode(nodes: readonly Readonly<Record<string, unknown>>[], combinedText: string): string | undefined {
  for (const node of nodes) {
    for (const key of ['upstreamErrorCode', 'errorCode', 'reason_code', 'code', 'reason']) {
      const val = stringOf(node[key]);
      if (val !== undefined && val !== 'remote' && val !== 'internal' && val !== 'protocol') {
        return val;
      }
    }
    const info = node['codexErrorInfo'] ?? node['codex_error_info'];
    if (typeof info === 'string' && info.trim().length > 0) return info.trim();
  }
  if (/ConnectError:\s*\[resource_exhausted\]/i.test(combinedText)) return 'resource_exhausted';
  if (/\bQUOTA_EXHAUSTED\b/.test(combinedText)) return 'QUOTA_EXHAUSTED';
  if (/\bRESOURCE_EXHAUSTED\b/.test(combinedText)) return 'RESOURCE_EXHAUSTED';
  if (/\brate_limit_error\b/i.test(combinedText)) return 'rate_limit_error';
  if (extractRpcCode(nodes) === XAI_RATE_LIMITED_RPC_CODE) return 'xai_rate_limited';
  return undefined;
}

function extractErrorType(nodes: readonly Readonly<Record<string, unknown>>[], combinedText: string): string | undefined {
  for (const node of nodes) {
    for (const key of ['upstreamErrorType', 'errorType', 'rateLimitType', 'rate_limit_type', 'type']) {
      const val = stringOf(node[key]);
      if (val !== undefined && val !== 'error' && val !== 'failed') return val;
    }
  }
  if (/\brate_limit_error\b/i.test(combinedText)) return 'rate_limit_error';
  return undefined;
}

function hasRejectedRateLimitInfo(nodes: readonly Readonly<Record<string, unknown>>[]): boolean {
  for (const node of nodes) {
    const status = stringOf(node['status'])?.toLowerCase();
    if (status === 'rejected' && ('resetsAt' in node || 'resets_at' in node || 'rateLimitType' in node || 'rate_limit_type' in node)) {
      return true;
    }
  }
  return false;
}

function extractResetTiming(
  nodes: readonly Readonly<Record<string, unknown>>[],
  texts: readonly string[],
  observedResetAt: string | undefined,
  nowMs: number,
): { readonly resetAt?: string; readonly resetAtMs?: number; readonly retryAfterMs?: number } {
  for (const node of nodes) {
    for (const key of ['resetAt', 'resetsAt', 'reset_at', 'resets_at', 'quotaResetTimeStamp', 'quota_reset_timestamp']) {
      const iso = parseIsoOrEpoch(node[key]);
      if (iso !== undefined) return finalizeResetIso(iso, nowMs);
    }
    const headers = objectOf(node['responseHeaders'] ?? node['headers']);
    if (headers !== undefined) {
      const headerReset = readHeaderCaseInsensitive(headers, ['x-ratelimit-reset', 'ratelimit-reset']);
      const isoFromHeader = parseIsoOrEpoch(headerReset);
      if (isoFromHeader !== undefined) return finalizeResetIso(isoFromHeader, nowMs);
      const retryAfterMsHeader = readHeaderCaseInsensitive(headers, ['retry-after-ms']);
      const retryMsNum = numberFromUnknown(retryAfterMsHeader);
      if (retryMsNum !== undefined && retryMsNum > 0) return finalizeDelayMs(retryMsNum, nowMs);
      const retryAfterHeader = readHeaderCaseInsensitive(headers, ['retry-after']);
      const retrySec = numberFromUnknown(retryAfterHeader);
      if (retrySec !== undefined && retrySec > 0) return finalizeDelayMs(retrySec * 1000, nowMs);
      const headerDateIso = parseIsoOrEpoch(retryAfterHeader);
      if (headerDateIso !== undefined) return finalizeResetIso(headerDateIso, nowMs);
    }
    const retryMs = numberFromUnknown(node['retryAfterMs'] ?? node['retry_after_ms']);
    if (retryMs !== undefined && retryMs > 0) return finalizeDelayMs(retryMs, nowMs);
    const retrySec = numberFromUnknown(
      node['retryAfterSeconds'] ??
      node['retry_after_seconds'] ??
      node['resetsInSeconds'] ??
      node['resets_in_seconds'] ??
      node['retry_after'] ??
      node['retryAfter'],
    );
    if (retrySec !== undefined && retrySec > 0) return finalizeDelayMs(retrySec * 1000, nowMs);
    for (const delayKey of ['quotaResetDelay', 'quota_reset_delay', 'retryDelay', 'retry_delay']) {
      const delayStr = stringOf(node[delayKey]);
      const parsedDelay = delayStr === undefined ? undefined : parseDurationMs(delayStr);
      if (parsedDelay !== undefined && parsedDelay > 0) return finalizeDelayMs(parsedDelay, nowMs);
    }
  }

  for (const text of texts) {
    const quotaTsMatch = /quotaResetTimeStamp\s*[:=]\s*["']?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/i.exec(text);
    if (quotaTsMatch?.[1]) {
      const iso = parseIsoOrEpoch(quotaTsMatch[1]);
      if (iso !== undefined) return finalizeResetIso(iso, nowMs);
    }
    const resetsAtIsoMatch = /\b(?:resets?\s+at|resetAt|resetsAt|resets_at|reset_at)\s*[:=]?\s*["']?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/i.exec(text);
    if (resetsAtIsoMatch?.[1]) {
      const iso = parseIsoOrEpoch(resetsAtIsoMatch[1]);
      if (iso !== undefined) return finalizeResetIso(iso, nowMs);
    }
    const resetsAtEpochMatch = /"(?:resetsAt|resets_at|resetAt|reset_at)"\s*:\s*(\d{9,16})\b/.exec(text);
    if (resetsAtEpochMatch?.[1]) {
      const iso = parseIsoOrEpoch(Number(resetsAtEpochMatch[1]));
      if (iso !== undefined) return finalizeResetIso(iso, nowMs);
    }
    const resetAfterMatch = /\b(?:reset|resets|retry|try\s+again)\s+(?:after|in)\s+((?:\d+(?:\.\d+)?\s*(?:d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds|ms)\s*)+)/i.exec(text);
    if (resetAfterMatch?.[1]) {
      const delayMs = parseDurationMs(resetAfterMatch[1]);
      if (delayMs !== undefined && delayMs > 0) return finalizeDelayMs(delayMs, nowMs);
    }
    const goDelayMatch = /\b(?:quotaResetDelay|retryDelay)\s*[:=]\s*["']?((?:\d+(?:\.\d+)?(?:h|m|s|ms))+)/i.exec(text);
    if (goDelayMatch?.[1]) {
      const delayMs = parseDurationMs(goDelayMatch[1]);
      if (delayMs !== undefined && delayMs > 0) return finalizeDelayMs(delayMs, nowMs);
    }
  }

  if (observedResetAt !== undefined) {
    const iso = parseIsoOrEpoch(observedResetAt);
    if (iso !== undefined) return finalizeResetIso(iso, nowMs);
  }

  return {};
}

function finalizeResetIso(iso: string, nowMs: number): { readonly resetAt: string; readonly resetAtMs: number; readonly retryAfterMs?: number } {
  const resetAtMs = Date.parse(iso);
  const delta = resetAtMs - nowMs;
  return {
    resetAt: iso,
    resetAtMs,
    retryAfterMs: delta > 0 ? delta : undefined,
  };
}

function finalizeDelayMs(delayMs: number, nowMs: number): { readonly resetAt?: string; readonly resetAtMs?: number; readonly retryAfterMs: number } {
  const rounded = Math.max(1, Math.round(delayMs));
  const targetMs = nowMs + rounded;
  const iso = isoFromMs(targetMs);
  return {
    resetAt: iso,
    resetAtMs: iso === undefined ? undefined : targetMs,
    retryAfterMs: rounded,
  };
}

function parseDurationMs(raw: string): number | undefined {
  let totalMs = 0;
  let matched = false;
  const pattern = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m(?!s)|seconds?|secs?|s|ms)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const amount = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    if (!Number.isFinite(amount) || amount < 0) continue;
    matched = true;
    if (unit === 'ms') totalMs += amount;
    else if (unit.startsWith('s')) totalMs += amount * 1000;
    else if (unit.startsWith('m')) totalMs += amount * 60_000;
    else if (unit.startsWith('h')) totalMs += amount * 3_600_000;
    else if (unit.startsWith('d')) totalMs += amount * 86_400_000;
  }
  return matched && totalMs > 0 ? Math.round(totalMs) : undefined;
}

function parseIsoOrEpoch(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 1e11 ? value : value * 1000;
    return isoFromMs(ms);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (numeric > 1e9) return isoFromMs(numeric > 1e11 ? numeric : numeric * 1000);
      return undefined;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return isoFromMs(parsed);
  }
  return undefined;
}

function isoFromMs(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0 || ms >= MAX_SAFE_DATE_MS) return undefined;
  return new Date(ms).toISOString();
}

function selectReadableMessage(
  nodes: readonly Readonly<Record<string, unknown>>[],
  texts: readonly string[],
  code: string | undefined,
): string {
  for (const node of nodes) {
    const usageLimit = objectOf(node['usageLimit']);
    const usageMsg = sanitizeText(stringOf(usageLimit?.['message']));
    if (usageMsg) return usageMsg;
  }
  for (const text of texts) {
    const unpacked = unpackJsonMessage(text);
    if (unpacked !== undefined && !isGenericWrapperMessage(unpacked)) return unpacked;
  }
  const nonGeneric = texts.find((text) => !isGenericWrapperMessage(text));
  if (nonGeneric !== undefined) return truncateMessage(nonGeneric);
  if (texts[0] !== undefined) return truncateMessage(texts[0]);
  return code ? `Provider rate limit reached (${code}).` : 'Provider rate limit or quota reached.';
}

function unpackJsonMessage(text: string): string | undefined {
  const parsed = tryParseEmbeddedJson(text);
  const root = objectOf(parsed);
  if (root === undefined) return undefined;
  const inner = objectOf(root['error']) ?? root;
  const msg = sanitizeText(stringOf(inner['message']) ?? stringOf(inner['detail']) ?? stringOf(root['message']));
  return msg === undefined ? undefined : truncateMessage(msg);
}

function isGenericWrapperMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === 'internal error' ||
    normalized === 'engine request failed' ||
    normalized === 'external executor failed' ||
    /^codex turn completed with status\b/.test(normalized)
  );
}

function truncateMessage(text: string): string {
  const singleLine = text.replaceAll(/\s+/g, ' ').trim();
  return singleLine.length <= 400 ? singleLine : `${singleLine.slice(0, 397)}...`;
}

function sanitizeText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let result = redactMemorySecrets(value);
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    result = result.replace(pattern, (_full, prefix?: string) => (typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return result.trim();
}

function readHeaderCaseInsensitive(
  headers: Readonly<Record<string, unknown>>,
  names: readonly string[],
): string | number | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(headers)) {
    if (!wanted.has(key.toLowerCase())) continue;
    if (typeof value === 'string' || typeof value === 'number') return value;
    if (Array.isArray(value) && (typeof value[0] === 'string' || typeof value[0] === 'number')) return value[0];
  }
  return undefined;
}

function tryParseEmbeddedJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start || end - start > 65_536) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
