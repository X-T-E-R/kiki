import { readFile, stat } from 'node:fs/promises';

import {
  RequestError,
  type InitializeResponse,
  type ReadTextFileRequest,
  type RequestPermissionRequest,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';

const TOOL_TEXT_LIMIT = 8_000;
const TOOL_TEXT_TRUNCATED = '[Earlier output truncated]\n\n';
const QUESTION_LABEL_LIMIT = 512;
const CLIENT_READ_TITLES = new Set(['Running client_view_file', 'Run client_view_file?']);

export interface AntigravityUserInputOption {
  readonly optionId: string;
  readonly label: string;
}

export interface AntigravityUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly AntigravityUserInputOption[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function versionParts(version: string | null | undefined): readonly number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? '');
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function atLeast(version: string | null | undefined, minimum: readonly number[]): boolean {
  const parsed = versionParts(version);
  return parsed !== undefined && compareVersions(parsed, minimum) >= 0;
}

export function antigravityClientName(runtimeVersion: string | null | undefined, fallback: string): string {
  return atLeast(runtimeVersion, [1, 5, 1]) ? fallback : 'zed';
}

export function antigravityClientFileReads(runtimeVersion: string | null | undefined): boolean {
  return runtimeVersion?.trim() !== '1.4.5' && !atLeast(runtimeVersion, [1, 5, 1]);
}

export function antigravityCliSessionMode(modeId: string): string {
  if (modeId === 'yolo') return 'auto';
  if (modeId === 'auto_edit') return 'accept-edits';
  return modeId;
}

export function antigravitySessionMode(selectedSource: string | undefined, modeId: string): string {
  return selectedSource === 'agy-cli' ? antigravityCliSessionMode(modeId) : modeId;
}

export function antigravitySupportsSystemPromptAppend(initialize: InitializeResponse): boolean {
  const version = initialize.agentInfo?.version?.trim();
  if (version === '1.4.5') return true;
  const advertised = record(record(initialize._meta)?.['antigravity'])?.['systemPrompt']
    ?? record(record(initialize.agentCapabilities?._meta)?.['antigravity'])?.['systemPrompt'];
  return record(advertised)?.['append'] === true;
}

export function antigravitySessionMeta(
  initialize: InitializeResponse,
  sessionMeta: Record<string, unknown> | undefined,
  systemPromptAppend?: string,
): Record<string, unknown> | undefined {
  const version = initialize.agentInfo?.version;
  const parsed = versionParts(version);
  const disabled = parsed !== undefined && compareVersions(parsed, [1, 4, 2]) >= 0 && compareVersions(parsed, [1, 4, 5]) <= 0;
  const appendSupported = antigravitySupportsSystemPromptAppend(initialize);
  const appendText = systemPromptAppend !== undefined && systemPromptAppend.length > 0 && appendSupported
    ? systemPromptAppend
    : undefined;
  if (!disabled && appendText === undefined) return sessionMeta;
  const existing = record(sessionMeta?.['antigravity']) ?? {};
  const existingTools = Array.isArray(existing['disabledTools'])
    ? existing['disabledTools'].filter((value): value is string => typeof value === 'string')
    : [];
  const existingPrompt = record(existing['systemPrompt']) ?? {};
  const nextAntigravity: Record<string, unknown> = { ...existing };
  if (disabled) {
    nextAntigravity['disabledTools'] = [...new Set([...existingTools, 'run_workflow'])];
  }
  if (appendText !== undefined) {
    nextAntigravity['systemPrompt'] = { ...existingPrompt, append: appendText };
  }
  return {
    ...sessionMeta,
    antigravity: nextAntigravity,
  };
}

export function legacyAntigravityModelFamily(options: readonly SessionConfigOption[], model: string): string | undefined {
  const modelOption = options.find((option) => option.id === 'model' && option.type === 'select');
  if (modelOption?.type !== 'select') return undefined;
  const families = modelOption.options.flatMap((entry) => 'value' in entry ? [entry.value] : entry.options.map((option) => option.value));
  return families.filter((family) => model.startsWith(`${family}-`)).toSorted((left, right) => right.length - left.length)[0];
}

export function isAntigravityUserInputRequest(request: RequestPermissionRequest): boolean {
  return request.toolCall.toolCallId.startsWith('interaction_');
}

function copyBoundedText(text: string): string {
  return Buffer.from(text, 'utf16le').toString('utf16le');
}

function questionLabel(name: string, optionId: string): string {
  const label = name.trim() || optionId;
  return label.length > QUESTION_LABEL_LIMIT
    ? copyBoundedText(`${label.slice(0, QUESTION_LABEL_LIMIT - 3)}...`)
    : label;
}

export function extractAntigravityUserInputQuestion(
  request: RequestPermissionRequest,
): AntigravityUserInputQuestion | undefined {
  if (!isAntigravityUserInputRequest(request) || request.options.length === 0) return undefined;
  const ids = new Set<string>();
  const labels = new Set<string>();
  const options: AntigravityUserInputOption[] = [];
  for (const option of request.options) {
    const label = questionLabel(option.name, option.optionId);
    if (!option.optionId.trim() || ids.has(option.optionId) || labels.has(label)) return undefined;
    ids.add(option.optionId);
    labels.add(label);
    options.push({ optionId: option.optionId, label });
  }
  const title = request.toolCall.title?.trim() || 'Choose an option.';
  return {
    id: request.toolCall.toolCallId,
    header: 'Question',
    question: title.length > TOOL_TEXT_LIMIT ? copyBoundedText(`${title.slice(0, TOOL_TEXT_LIMIT - 3)}...`) : title,
    options,
  };
}

export function resolveAntigravityUserInputOptionId(
  question: AntigravityUserInputQuestion,
  answer: unknown,
): string | undefined {
  if (typeof answer !== 'string' || answer.length === 0) return undefined;
  const exact = question.options.find((option) => option.optionId === answer);
  if (exact !== undefined) return exact.optionId;
  const byLabel = question.options.filter((option) => option.label === answer);
  return byLabel.length === 1 ? byLabel[0]?.optionId : undefined;
}

function boundText(text: string, limit = TOOL_TEXT_LIMIT): string {
  return text.length <= limit ? text : copyBoundedText(`${TOOL_TEXT_TRUNCATED}${text.slice(-limit)}`);
}

export function stripAntigravitySystemMessages(text: string): string {
  return text.replace(/<system_message\b[^>]*>[\s\S]*?<\/system_message>/gi, '').replace(/<system_message\b[^>]*>[\s\S]*$/gi, '');
}

interface ToolPayloadBudget {
  nodes: number;
  text: number;
}

function sanitizeToolValue(value: unknown, budget: ToolPayloadBudget, depth: number): unknown {
  if (depth > 12 || budget.nodes-- <= 0) return undefined;
  if (typeof value === 'string') {
    if (/^data:image\//i.test(value) || budget.text <= 0) return undefined;
    const text = boundText(stripAntigravitySystemMessages(value), Math.min(TOOL_TEXT_LIMIT, budget.text));
    budget.text -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const entry of value) {
      if (budget.nodes <= 0) break;
      const sanitized = sanitizeToolValue(entry, budget, depth + 1);
      if (sanitized !== undefined) result.push(sanitized);
    }
    return result;
  }
  const object = record(value);
  if (object === undefined) return value;
  const entries: Array<readonly [string, unknown]> = [];
  for (const [key, entry] of Object.entries(object)) {
    if (budget.nodes <= 0) break;
    if ((object['type'] === 'image' && (key === 'data' || key === 'blob')) ||
      (key === 'blob' && typeof object['mimeType'] === 'string' && object['mimeType'].startsWith('image/')) ||
      ((key === 'formatted_output' || key === 'formattedOutput') && (entry === object['combinedOutput'] || entry === object['combined_output']))) continue;
    const sanitized = sanitizeToolValue(entry, budget, depth + 1);
    if (sanitized !== undefined) entries.push([key, sanitized]);
  }
  return Object.fromEntries(entries);
}

export function sanitizeAntigravityToolPayload(payload: unknown): unknown {
  return sanitizeToolValue(payload, { nodes: 512, text: 64_000 }, 0);
}

export function normalizeAntigravitySessionUpdate<T>(notification: T): T {
  const source = record(notification);
  const update = record(source?.['update']);
  if (source === undefined || update === undefined || (update['sessionUpdate'] !== 'tool_call' && update['sessionUpdate'] !== 'tool_call_update')) return notification;
  const contentBudget = { nodes: 512, text: 32_000 };
  const content = Array.isArray(update['content']) ? update['content'].flatMap((entry) => {
    const sanitized = sanitizeToolValue(entry, contentBudget, 0);
    return sanitized === undefined ? [] : [sanitized];
  }) : update['content'];
  return {
    ...source,
    update: {
      ...update,
      title: typeof update['title'] === 'string' ? boundText(stripAntigravitySystemMessages(update['title'])) : update['title'],
      rawInput: update['rawInput'] === undefined ? undefined : sanitizeAntigravityToolPayload(update['rawInput']),
      rawOutput: update['rawOutput'] === undefined ? undefined : sanitizeAntigravityToolPayload(update['rawOutput']),
      content,
      _meta: update['_meta'] === undefined ? undefined : sanitizeAntigravityToolPayload(update['_meta']),
    },
  } as T;
}

function clientReadPath(update: Record<string, unknown>): string | undefined {
  if (typeof update['title'] !== 'string' || !CLIENT_READ_TITLES.has(update['title'])) return undefined;
  const locations = Array.isArray(update['locations']) ? update['locations'] : [];
  const target = record(locations[0])?.['path'] ?? record(update['rawInput'])?.['absolute_path'];
  return typeof target === 'string' && target ? target : undefined;
}

export function makeAntigravityReadRepair() {
  type Outcome = 'served' | 'refused';
  const openReads = new Map<string, { readonly path: string; outcome?: Outcome }>();
  const earlyOutcomes: Array<{ readonly path: string; readonly outcome: Outcome }> = [];
  return {
    reset: () => {
      openReads.clear();
      earlyOutcomes.length = 0;
    },
    attempted: (path: string, served: boolean): void => {
      const outcome = served ? 'served' : 'refused';
      for (const [, read] of openReads) {
        if (read.path !== path || read.outcome !== undefined) continue;
        read.outcome = outcome;
        return;
      }
      earlyOutcomes.push({ path, outcome });
    },
    repair: <T>(notification: T): T => {
      const source = record(notification);
      const update = record(source?.['update']);
      if (source === undefined || update === undefined || (update['sessionUpdate'] !== 'tool_call' && update['sessionUpdate'] !== 'tool_call_update')) return notification;
      const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : undefined;
      if (toolCallId === undefined) return notification;
      const path = clientReadPath(update);
      if (path !== undefined && !openReads.has(toolCallId)) {
        const early = earlyOutcomes.findIndex((entry) => entry.path === path);
        const outcome = early === -1 ? undefined : earlyOutcomes.splice(early, 1)[0]?.outcome;
        openReads.set(toolCallId, outcome === undefined ? { path } : { path, outcome });
      }
      const read = openReads.get(toolCallId);
      if (update['status'] === 'pending' || update['status'] === 'in_progress') {
        return read?.outcome === 'served' ? { ...source, update: { ...update, status: 'completed' } } as T : notification;
      }
      if (update['status'] !== 'completed' && update['status'] !== 'failed') return notification;
      openReads.delete(toolCallId);
      if (update['status'] === 'completed' || read?.outcome !== 'served') return notification;
      const { rawOutput: _stepError, ...rest } = update;
      return { ...source, update: { ...rest, status: 'completed' } } as T;
    },
  };
}

export async function readAntigravityTextFile(request: ReadTextFileRequest): Promise<string> {
  const info = await stat(request.path);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) {
    throw RequestError.invalidParams({ path: request.path }, 'Antigravity client reads require a text file of at most 8 MiB');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(request.path));
  } catch {
    throw RequestError.invalidParams({ path: request.path }, 'Antigravity client reads require UTF-8 text');
  }
  if (text.includes('\0')) throw RequestError.invalidParams({ path: request.path }, 'Antigravity client reads reject binary data');
  if (request.line === null || request.line === undefined) {
    if (request.limit === null || request.limit === undefined) return text;
  }
  const lines = text.split('\n');
  const start = Math.max(0, (request.line ?? 1) - 1);
  const end = request.limit === null || request.limit === undefined ? lines.length : Math.min(lines.length, start + request.limit);
  return lines.slice(start, end).join('\n');
}

const COPILOT_LOST_SESSION_MARKERS = [
  'session event delivery failed: session not found: ',
  'session lock unavailable during is_session_generation_current: acquisition timed out',
] as const;

export function isCopilotLostSessionError(error: unknown): boolean {
  if (!(error instanceof RequestError) || error.code !== -32603) return false;
  const details = record(error.data)?.['details'];
  return [error.message, details].some(
    (text) => typeof text === 'string' && COPILOT_LOST_SESSION_MARKERS.some((marker) => text.includes(marker)),
  );
}
