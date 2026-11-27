const MESSAGE_KEYS = ['message', 'error_message', 'detail', 'reason', 'error', 'title'] as const;
const MAX_LENGTH = 160;

export type DiagnosticCategory =
  | 'capacity'
  | 'rate_limit'
  | 'quota'
  | 'service'
  | 'auth'
  | 'permission'
  | 'context_limit'
  | 'thinking_truncated'
  | 'empty_response'
  | 'unknown';

const INTERNAL_GENERIC_ERROR_CODES = new Set([
  'internal',
  'unknown',
  'provider.api_error',
  'provider.connection_error',
  'provider.timeout',
  'provider.overloaded',
]);

export function isMeaningfulUserErrorCode(code: string | undefined): code is string {
  if (code === undefined) return false;
  const normalized = code.trim().toLowerCase();
  return normalized !== '' && !INTERNAL_GENERIC_ERROR_CODES.has(normalized);
}

export interface DecodedDiagnostic {
  readonly decodedMessage: string;
  readonly rawEnvelope?: string;
  readonly code?: string;
  readonly status?: string;
  readonly requestId?: string;
  readonly category: DiagnosticCategory;
  readonly hasDistinctRaw: boolean;
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function collectMessages(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectMessages(entry, depth + 1, out);
    }
    return out;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['issues', 'errors', 'details'] as const) {
      if (Array.isArray(record[key])) {
        collectMessages(record[key], depth + 1, out);
      }
    }
    const typeText = nonBlank(record['type']);
    const msgText = nonBlank(record['message']) ?? nonBlank(record['error_message']);
    if (msgText !== undefined) {
      const entry = typeText !== undefined && !msgText.includes(typeText) ? `${typeText}: ${msgText}` : msgText;
      if (!out.includes(entry)) out.push(entry);
    }
    for (const key of MESSAGE_KEYS) {
      if (key === 'message' || key === 'error_message') continue;
      if (record[key] !== undefined) collectMessages(record[key], depth + 1, out);
    }
  }
  return out;
}

function messageOf(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = messageOf(entry, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of MESSAGE_KEYS) {
      const found = messageOf(record[key], depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function balancedSpan(text: string, start: number): string | undefined {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '\\') index += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth += 1;
    else if ((char === '}' || char === ']') && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

function parseJsonOnce(text: string): unknown {
  const start = text.search(/[{["]/);
  const attempts = [
    text,
    start > 0 ? text.slice(start) : undefined,
    start >= 0 && (text[start] === '{' || text[start] === '[') ? balancedSpan(text, start) : undefined,
  ];
  for (const attempt of attempts) {
    if (attempt === undefined) continue;
    try {
      return JSON.parse(attempt) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

function parsePayloadDeep(text: string): unknown {
  const first = parseJsonOnce(text);
  if (typeof first === 'string') {
    const inner = parseJsonOnce(first.trim());
    return inner !== undefined ? inner : first;
  }
  return first;
}

interface ExtractedMeta {
  code?: string;
  status?: string;
  requestId?: string;
}

function extractMetaFromObject(value: unknown, meta: ExtractedMeta, depth = 0): void {
  if (depth > 5 || value === null || value === undefined || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) extractMetaFromObject(entry, meta, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (meta.code === undefined) {
    const rawCode = record['code'] ?? record['error_code'] ?? record['errorCode'];
    if (typeof rawCode === 'string' && rawCode.trim() !== '') meta.code = rawCode.trim();
    else if (typeof rawCode === 'number' && Number.isFinite(rawCode)) meta.code = String(rawCode);
  }
  if (meta.status === undefined) {
    const rawStatus = record['status'] ?? record['statusCode'] ?? record['status_code'] ?? record['httpStatus'];
    if (typeof rawStatus === 'number' && Number.isFinite(rawStatus)) meta.status = String(rawStatus);
    else if (typeof rawStatus === 'string' && /^\d{3}$/.test(rawStatus.trim())) meta.status = rawStatus.trim();
  }
  if (meta.requestId === undefined) {
    const rawReq = record['request_id'] ?? record['requestId'] ?? record['x-request-id'] ?? record['trace_id'] ?? record['traceId'];
    if (typeof rawReq === 'string' && rawReq.trim() !== '') meta.requestId = rawReq.trim();
  }
  for (const nestedKey of ['error', 'detail', 'details', 'response', 'meta', 'data'] as const) {
    if (record[nestedKey] !== undefined) extractMetaFromObject(record[nestedKey], meta, depth + 1);
  }
}

function extractMetaFromText(text: string, meta: ExtractedMeta): void {
  if (meta.requestId === undefined) {
    const reqMatch = /\b(?:request[_ -]?id|trace[_ -]?id|x-request-id)\s*[:=]\s*([A-Za-z0-9._:-]+)/i.exec(text);
    if (reqMatch?.[1] !== undefined) meta.requestId = reqMatch[1];
  }
  if (meta.code === undefined) {
    const codeMatch = /(?<!exit[_ -])(?<!return[_ -])(?<!status[_ -])\b(?:error[_ -]?code|code)\s*[:=]\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/i.exec(text);
    const candidate = codeMatch?.[1];
    if (candidate !== undefined && !/^\d{1,3}$/.test(candidate)) {
      meta.code = candidate;
    }
  }
  if (meta.status === undefined) {
    const statusMatch = /\b(?:http\s*status|status(?:\s*code)?)\s*[:=]?\s*(\d{3})\b/i.exec(text);
    if (statusMatch?.[1] !== undefined) meta.status = statusMatch[1];
  }
}

function stripRequestIdsForClassification(text: string, requestId?: string): string {
  let cleaned = text.replace(/\b(?:request[_ -]?id|trace[_ -]?id|x-request-id)\s*[:=]\s*[A-Za-z0-9._:-]+/gi, '');
  if (requestId !== undefined && requestId !== '') {
    cleaned = cleaned.split(requestId).join('');
  }
  return cleaned;
}

export function classifyDiagnosticCategory(input: {
  readonly message: string;
  readonly code?: string;
  readonly status?: string;
  readonly requestId?: string;
}): DiagnosticCategory {
  const scrubbed = stripRequestIdsForClassification(input.message, input.requestId);
  const code = (input.code ?? '').toLowerCase();
  const status = input.status?.trim();

  if (
    /no capacity available|model_overloaded|overloaded_error|capacity exhausted|service overloaded|insufficient capacity/i.test(scrubbed) ||
    code === 'overloaded' ||
    code === 'model_overloaded' ||
    code === 'capacity_exceeded'
  ) {
    return 'capacity';
  }

  if (
    /quota[_ -]?exceeded|insufficient[_ -]?quota|quota exhausted|billing[_ -]?hard[_ -]?limit|credit balance is too low|out of credits/i.test(scrubbed) ||
    code === 'insufficient_quota' ||
    code === 'quota_exceeded'
  ) {
    return 'quota';
  }

  if (
    status === '429' ||
    /rate[_ -]?limit|too many requests|requests per minute|tokens per minute/i.test(scrubbed) ||
    code === 'rate_limit_exceeded' ||
    code === 'rate_limit_error'
  ) {
    return 'rate_limit';
  }

  if (
    /context[_ -]?length[_ -]?exceeded|prompt is too long|maximum context length|too many tokens|input is too long/i.test(scrubbed) ||
    code === 'context_length_exceeded'
  ) {
    return 'context_limit';
  }

  if (
    status === '401' ||
    /invalid[_ -]?api[_ -]?key|authentication[_ -]?error|invalid credentials|unauthorized|api key not valid|model and thinking effort are required to bind profile|no default model configured/i.test(scrubbed) ||
    code === 'authentication_error' ||
    code === 'invalid_api_key'
  ) {
    return 'auth';
  }

  if (
    status === '403' ||
    /permission[_ -]?denied|forbidden|not authorized to access/i.test(scrubbed) ||
    code === 'permission_error' ||
    code === 'permission_denied'
  ) {
    return 'permission';
  }

  if (
    status === '502' ||
    status === '503' ||
    status === '504' ||
    /bad gateway|service unavailable|gateway timeout|stream reset|econnreset|socket hang up|upstream.*(?:timeout|unavailable|disconnected)/i.test(scrubbed)
  ) {
    return 'service';
  }

  if (/only thinking content without any text or tool calls/i.test(scrubbed)) {
    return 'thinking_truncated';
  }

  if (/returned an empty response \(no content, no tool calls\)/i.test(scrubbed)) {
    return 'empty_response';
  }

  return 'unknown';
}

export function decodeFullDiagnostic(
  raw: string | undefined,
  errorDetails?: string | undefined,
): DecodedDiagnostic {
  const rawPrimary = nonBlank(raw);
  const rawSecondary = nonBlank(errorDetails);
  const meta: ExtractedMeta = {};

  let decodedMessage: string | undefined;
  const parsedPrimary = rawPrimary !== undefined && /[{["]/.test(rawPrimary) ? parsePayloadDeep(rawPrimary) : undefined;
  const parsedSecondary = rawSecondary !== undefined && /[{["]/.test(rawSecondary) ? parsePayloadDeep(rawSecondary) : undefined;

  if (parsedPrimary !== undefined && typeof parsedPrimary === 'object') {
    extractMetaFromObject(parsedPrimary, meta);
    const messages = collectMessages(parsedPrimary);
    if (messages.length > 0) {
      const start = rawPrimary!.search(/[{[]/);
      const prefix = start > 0 ? rawPrimary!.slice(0, start).replace(/[\s:：-]+$/, '').trim() : '';
      const joined = messages.join('\n');
      decodedMessage = prefix !== '' && !joined.startsWith(prefix) ? `${prefix}: ${joined}` : joined;
    }
  } else if (typeof parsedPrimary === 'string' && parsedPrimary.trim() !== '') {
    decodedMessage = parsedPrimary.trim();
  }

  if (parsedSecondary !== undefined && typeof parsedSecondary === 'object') {
    extractMetaFromObject(parsedSecondary, meta);
    if (decodedMessage === undefined) {
      const messages = collectMessages(parsedSecondary);
      if (messages.length > 0) decodedMessage = messages.join('\n');
    }
  }

  if (rawPrimary !== undefined) extractMetaFromText(rawPrimary, meta);
  if (rawSecondary !== undefined) extractMetaFromText(rawSecondary, meta);

  const finalMessage = decodedMessage ?? rawPrimary ?? rawSecondary ?? '';

  const rawParts: string[] = [];
  if (rawPrimary !== undefined) rawParts.push(rawPrimary);
  if (rawSecondary !== undefined && !rawParts.some((part) => part === rawSecondary || part.includes(rawSecondary))) {
    rawParts.push(rawSecondary);
  }
  const combinedRaw = rawParts.length > 0 ? rawParts.join('\n\n') : undefined;
  const hasDistinctRaw = combinedRaw !== undefined && combinedRaw !== finalMessage;

  const combinedForClass = [finalMessage, rawPrimary, rawSecondary].filter(Boolean).join('\n');
  const category = classifyDiagnosticCategory({
    message: combinedForClass,
    code: meta.code,
    status: meta.status,
    requestId: meta.requestId,
  });

  return {
    decodedMessage: finalMessage,
    rawEnvelope: hasDistinctRaw ? combinedRaw : undefined,
    code: meta.code,
    status: meta.status,
    requestId: meta.requestId,
    category,
    hasDistinctRaw,
  };
}

export function buildDiagnosticClipboardText(
  diagnostic: DecodedDiagnostic,
  fallbackStatusText?: string,
): string {
  const sections: string[] = [];
  const main = diagnostic.decodedMessage.trim();
  if (main !== '') {
    sections.push(main);
  } else if (fallbackStatusText !== undefined && fallbackStatusText.trim() !== '') {
    sections.push(fallbackStatusText.trim());
  }

  const metaLines: string[] = [];
  const combinedSoFar = sections.join('\n');
  if (diagnostic.code !== undefined && !combinedSoFar.includes(diagnostic.code)) {
    metaLines.push(`Code: ${diagnostic.code}`);
  }
  if (diagnostic.status !== undefined && !new RegExp(`\\b${diagnostic.status}\\b`).test(combinedSoFar)) {
    metaLines.push(`Status: ${diagnostic.status}`);
  }
  if (diagnostic.requestId !== undefined && !combinedSoFar.includes(diagnostic.requestId)) {
    metaLines.push(`Request ID: ${diagnostic.requestId}`);
  }
  if (metaLines.length > 0) {
    sections.push(metaLines.join('\n'));
  }

  if (diagnostic.rawEnvelope !== undefined && diagnostic.rawEnvelope.trim() !== '') {
    const rawTrimmed = diagnostic.rawEnvelope.trim();
    if (rawTrimmed !== main && !combinedSoFar.includes(rawTrimmed)) {
      sections.push(rawTrimmed);
    }
  }

  return sections.join('\n\n');
}

export function plainFailure(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let text = raw.trim();
  if (text === '') return undefined;
  if (/[{[]/.test(text)) {
    const payload = parsePayloadDeep(text);
    if (payload !== undefined) {
      const prefix = text.slice(0, Math.max(0, text.search(/[{[]/))).replace(/[\s:：-]+$/, '').trim();
      const message = messageOf(payload);
      if (message === undefined) return prefix === '' ? undefined : prefix;
      text = message.trim();
    }
  }
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== '' && !/^at\s/.test(part));
  if (line === undefined) return undefined;
  if (/^[{[]/.test(line) && /[}\]]$/.test(line)) return undefined;
  const clean = line.replace(/^(?:Error|error):\s*/, '').replaceAll(/\s+/g, ' ');
  return clean.length > MAX_LENGTH ? `${clean.slice(0, MAX_LENGTH - 1)}…` : clean;
}
