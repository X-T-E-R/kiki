import { readFile, stat } from 'node:fs/promises';

import {
  PROTOCOL_VERSION,
  RequestError,
  type InitializeResponse,
  type PermissionOption,
  type ReadTextFileRequest,
  type RequestPermissionRequest,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';

import {
  ANTIGRAVITY_EDIT_DIFF_OMITTED,
  antigravityEditPatch,
  isAntigravitySnippetPatch,
} from '#/antigravityEditLocation';

const TOOL_TEXT_LIMIT = 8_000;
const TOOL_TEXT_TRUNCATED = '[Earlier output truncated]\n\n';
const COMMAND_LINE_TRUNCATED = '\n\n[Command truncated]';
const QUESTION_LABEL_LIMIT = 512;
const WARNING_TEXT_LIMIT = 512;
const SECURITY_WARNING_META_KEY = 'agy.security.warning';
const OFFICIAL_ANTIGRAVITY_SERVER_NAME = 'Antigravity ACP Server';
const CLIENT_READ_TITLES = new Set(['Running client_view_file', 'Run client_view_file?']);

const COMMAND_LINE_FIELDS = new Set(['CommandLine', 'command_line', 'commandLine', 'command']);
const COMMAND_TEXT_FIELDS = new Set([
  'aggregatedOutput',
  'combinedOutput',
  'combined_output',
  'output',
  'text',
]);

export const ANTIGRAVITY_SCHEDULE_TITLES: ReadonlySet<string> = new Set([
  'Run schedule',
  'Running schedule',
]);

export const ANTIGRAVITY_SUBAGENT_TITLES: ReadonlySet<string> = new Set([
  'Running start_subagent',
  'Run start_subagent?',
  'Running invoke_subagent',
  'Run invoke_subagent?',
  'Run invoke_subagent',
]);

export const ANTIGRAVITY_SUBAGENT_BATCH_TITLE = 'Antigravity subagent batch';

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

export interface AntigravityChildLaunch {
  readonly role: string;
  readonly prompt: string;
}

export interface AntigravityUpdateNormalizationOptions {
  readonly readPreEditFile?: (path: string) => string | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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

export function isOfficialAntigravityAcpServer(initialize: InitializeResponse): boolean {
  return initialize.agentInfo?.name === OFFICIAL_ANTIGRAVITY_SERVER_NAME &&
    initialize.protocolVersion === PROTOCOL_VERSION;
}

export function antigravitySupportsPromptSteering(initialize: InitializeResponse): boolean {
  return isOfficialAntigravityAcpServer(initialize) &&
    atLeast(initialize.agentInfo?.version, [1, 5, 0]);
}

export function antigravitySupportsLogout(initialize: InitializeResponse): boolean {
  const capabilities = record(initialize.agentCapabilities);
  const auth = record(capabilities?.['authCapabilities']) ?? record(capabilities?.['auth']);
  const logout = auth?.['logout'];
  return logout === true || record(logout) !== undefined;
}

export function antigravitySupportsEmbeddedContext(initialize: InitializeResponse): boolean {
  return initialize.agentCapabilities?.promptCapabilities?.embeddedContext === true;
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

export function antigravitySessionMode(
  selectedSource: string | undefined,
  modeId: string,
  availableModes?: readonly string[],
): string {
  if (selectedSource === 'agy-cli') {
    const mapped = antigravityCliSessionMode(modeId);
    if (availableModes === undefined || availableModes.includes(mapped)) {
      return mapped;
    }
  }
  if (modeId === 'auto') {
    return availableModes?.includes('auto') === true ? 'auto' : 'default';
  }
  if (modeId === 'yolo' || modeId === 'auto_edit') {
    return 'default';
  }
  if (availableModes !== undefined && !availableModes.includes(modeId) && availableModes.includes('default')) {
    return 'default';
  }
  return modeId;
}

export function antigravitySecurityWarning(option: PermissionOption): string | undefined {
  const meta = record(option._meta);
  const warning = record(meta?.[SECURITY_WARNING_META_KEY]);
  if (warning === undefined) return undefined;
  const message = typeof warning['message'] === 'string' ? warning['message'].trim() : '';
  const title = typeof warning['title'] === 'string' ? warning['title'].trim() : '';
  const text = message || title;
  if (!text) return undefined;
  return text.length > WARNING_TEXT_LIMIT
    ? copyBoundedText(`${text.slice(0, WARNING_TEXT_LIMIT - 3).replace(/[\uD800-\uDBFF]$/u, '')}...`)
    : text;
}

const PROXIED_MCP_TITLE = /^MCP Tool (?<tool>[A-Za-z0-9_]+)\??$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isAntigravityManagedMcpRequest(
  request: RequestPermissionRequest,
  leasedServerName: string,
): boolean {
  if (!leasedServerName) return false;
  const title = request.toolCall.title?.trim() ?? '';
  const rawInput = record(request.toolCall.rawInput);
  const proxiedTool = PROXIED_MCP_TITLE.exec(title)?.groups?.['tool'];
  if (proxiedTool !== undefined) {
    return rawInput?.['ServerName'] === leasedServerName && rawInput?.['ToolName'] === proxiedTool;
  }
  if (typeof rawInput?.['CommandLine'] === 'string' || typeof rawInput?.['command_line'] === 'string') {
    return false;
  }
  const directPattern = new RegExp(`^Run mcp_${escapeRegExp(leasedServerName)}_(?<tool>[A-Za-z0-9_]+)\\??$`);
  return directPattern.test(title);
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

export function boundAntigravityToolText(text: string, limit = TOOL_TEXT_LIMIT): string {
  return text.length <= limit ? text : copyBoundedText(`${TOOL_TEXT_TRUNCATED}${text.slice(-limit)}`);
}

export function boundAntigravityCommandOutput(text: string, limit = TOOL_TEXT_LIMIT): string {
  if (
    text.length <= limit ||
    (text.length <= limit + TOOL_TEXT_TRUNCATED.length && text.startsWith(TOOL_TEXT_TRUNCATED))
  ) {
    return text;
  }
  const tail = text.slice(-limit).replace(/^[\uDC00-\uDFFF]/u, '');
  return copyBoundedText(`${TOOL_TEXT_TRUNCATED}${tail}`);
}

export function boundAntigravityCommandLine(text: string, limit = TOOL_TEXT_LIMIT): string {
  if (
    text.length <= limit ||
    (text.length <= limit + COMMAND_LINE_TRUNCATED.length && text.endsWith(COMMAND_LINE_TRUNCATED))
  ) {
    return text;
  }
  const head = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '');
  return copyBoundedText(`${head}${COMMAND_LINE_TRUNCATED}`);
}

export function isCutAntigravityToolText(text: string): boolean {
  return text.includes(TOOL_TEXT_TRUNCATED);
}

export function stripAntigravitySystemMessages(text: string): string {
  return text
    .replace(/<system_message\b[^>]*>[\s\S]*?<\/system_message>/gi, '')
    .replace(/<system_message\b[^>]*>[\s\S]*$/gi, '');
}

export function stripAntigravityToolSummary(value: unknown): unknown {
  const object = record(value);
  if (object === undefined) return value;
  let next: Record<string, unknown> = object;
  if ('toolSummary' in next) {
    const { toolSummary: _toolSummary, ...rest } = next;
    next = rest;
  }
  const args = record(next['Arguments']);
  if (args !== undefined && 'toolSummary' in args) {
    const { toolSummary: _toolSummary, ...restArgs } = args;
    next = { ...next, Arguments: restArgs };
  }
  return next;
}

interface ToolPayloadBudget {
  nodes: number;
  text: number;
}

function sanitizeToolValue(
  value: unknown,
  budget: ToolPayloadBudget,
  depth: number,
  field?: string,
): unknown {
  if (depth > 12 || budget.nodes-- <= 0) return undefined;
  if (typeof value === 'string') {
    if (/^data:image\//i.test(value) || budget.text <= 0) return undefined;
    const stripped = stripAntigravitySystemMessages(value);
    const limit = Math.min(TOOL_TEXT_LIMIT, budget.text);
    const text = field !== undefined && COMMAND_LINE_FIELDS.has(field)
      ? boundAntigravityCommandLine(stripped, limit)
      : field !== undefined && COMMAND_TEXT_FIELDS.has(field)
        ? boundAntigravityCommandOutput(stripped, limit)
        : boundAntigravityToolText(stripped, limit);
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
    const sanitized = sanitizeToolValue(entry, budget, depth + 1, key);
    if (sanitized !== undefined) entries.push([key, sanitized]);
  }
  return Object.fromEntries(entries);
}

export function sanitizeAntigravityToolPayload(payload: unknown): unknown {
  return sanitizeToolValue(payload, { nodes: 512, text: 64_000 }, 0);
}

function hasTruncatedText(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith(TOOL_TEXT_TRUNCATED);
  if (Array.isArray(value)) return value.some(hasTruncatedText);
  const object = record(value);
  return object !== undefined && Object.values(object).some(hasTruncatedText);
}

function editTargetPath(rawInput: unknown, locations: unknown): string | undefined {
  if (Array.isArray(locations)) {
    const first = record(locations[0]);
    if (typeof first?.['path'] === 'string' && first['path'].length > 0) return first['path'];
  }
  const input = record(rawInput);
  if (input === undefined) return undefined;
  for (const key of ['TargetFile', 'target_file', 'AbsolutePath', 'absolute_path', 'file_path', 'filePath', 'path', 'Path']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function applyEditPatches(
  content: readonly unknown[] | undefined,
  rawInput: unknown,
  locations: unknown,
  readPreEditFile: ((path: string) => string | undefined) | undefined,
): unknown[] | undefined {
  const existing = Array.isArray(content) ? content : [];
  const hasDiffEntry = existing.some((entry) => record(entry)?.['type'] === 'diff');
  const entries = hasDiffEntry
    ? existing
    : (() => {
        const path = editTargetPath(rawInput, locations);
        if (path === undefined) return existing;
        const patch = antigravityEditPatch({ path, rawInput, locations, readPreEditFile });
        if (patch === undefined) return existing;
        const formatted = patch === ANTIGRAVITY_EDIT_DIFF_OMITTED || patch.length > TOOL_TEXT_LIMIT
          ? { format: 'omitted' }
          : isAntigravitySnippetPatch(patch)
            ? { format: 'snippet', text: patch }
            : { text: patch };
        return [...existing, { type: 'diff', path, patch: formatted }];
      })();

  if (!hasDiffEntry) return entries.length > 0 ? entries : undefined;

  return entries.map((entry) => {
    const diff = record(entry);
    if (diff === undefined || diff['type'] !== 'diff' || typeof diff['path'] !== 'string') {
      return entry;
    }
    if (diff['patch'] !== undefined) {
      const patch = record(diff['patch']);
      const cut = patch !== undefined &&
        patch['format'] !== 'omitted' &&
        (typeof patch['text'] !== 'string' || patch['text'].startsWith(TOOL_TEXT_TRUNCATED));
      return cut ? { ...diff, patch: { format: 'omitted' } } : diff;
    }
    if ([rawInput, diff['oldText'], diff['newText']].some(hasTruncatedText)) {
      return { ...diff, patch: { format: 'omitted' } };
    }
    const text = antigravityEditPatch({
      path: diff['path'],
      rawInput,
      locations,
      readPreEditFile,
    });
    if (text === ANTIGRAVITY_EDIT_DIFF_OMITTED || (text !== undefined && text.length > TOOL_TEXT_LIMIT)) {
      return { ...diff, patch: { format: 'omitted' } };
    }
    if (text === undefined) return diff;
    return {
      ...diff,
      patch: isAntigravitySnippetPatch(text) ? { format: 'snippet', text } : { text },
    };
  });
}

export function normalizeAntigravitySessionUpdate<T>(
  notification: T,
  options?: AntigravityUpdateNormalizationOptions,
): T {
  const source = record(notification);
  const update = record(source?.['update']);
  if (source === undefined || update === undefined || (update['sessionUpdate'] !== 'tool_call' && update['sessionUpdate'] !== 'tool_call_update')) {
    return notification;
  }
  const contentBudget = { nodes: 512, text: 32_000 };
  const sanitizedContent = Array.isArray(update['content'])
    ? update['content'].flatMap((entry) => {
        const sanitized = sanitizeToolValue(entry, contentBudget, 0);
        return sanitized === undefined ? [] : [sanitized];
      })
    : undefined;
  const sanitizedRawInput = update['rawInput'] === undefined
    ? undefined
    : sanitizeAntigravityToolPayload(stripAntigravityToolSummary(update['rawInput']));
  const sanitizedRawOutput = update['rawOutput'] === undefined
    ? undefined
    : sanitizeAntigravityToolPayload(update['rawOutput']);
  const readPreEditFile = update['status'] === 'pending' ? options?.readPreEditFile : undefined;
  const content = update['kind'] === 'edit'
    ? applyEditPatches(sanitizedContent, sanitizedRawInput, update['locations'], readPreEditFile) ?? sanitizedContent
    : sanitizedContent;
  return {
    ...source,
    update: {
      ...update,
      title: typeof update['title'] === 'string'
        ? boundAntigravityToolText(stripAntigravitySystemMessages(update['title']))
        : update['title'],
      rawInput: sanitizedRawInput,
      rawOutput: sanitizedRawOutput,
      content: content ?? update['content'],
      _meta: update['_meta'] === undefined ? undefined : sanitizeAntigravityToolPayload(update['_meta']),
    },
  } as T;
}

function antigravityUpdateSteps(rawInput: unknown): Array<{ readonly content: string; readonly priority: string; readonly status: string }> | undefined {
  const input = record(rawInput);
  const steps = input?.['steps'];
  if (!Array.isArray(steps)) return undefined;
  return steps.flatMap((step) => {
    const entry = record(step);
    if (entry === undefined || typeof entry['title'] !== 'string') return [];
    const rawStatus = entry['status'];
    return [{
      content: entry['title'],
      priority: 'medium',
      status: rawStatus === 'done'
        ? 'completed'
        : typeof rawStatus === 'string'
          ? rawStatus
          : 'pending',
    }];
  });
}

export function makeAntigravityUpdateStepsPlans() {
  const calls = new Set<string>();
  return <T>(notification: T): T | undefined => {
    const source = record(notification);
    const update = record(source?.['update']);
    if (source === undefined || update === undefined || (update['sessionUpdate'] !== 'tool_call' && update['sessionUpdate'] !== 'tool_call_update')) {
      return notification;
    }
    const sessionId = typeof source['sessionId'] === 'string' ? source['sessionId'] : '';
    const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : '';
    const key = `${sessionId}\u0000${toolCallId}`;
    if (
      update['title'] === 'Run update_steps' &&
      (update['kind'] === undefined || update['kind'] === null || update['kind'] === 'other')
    ) {
      calls.add(key);
    }
    if (!calls.has(key)) return notification;
    if (update['status'] === 'completed' || update['status'] === 'failed') calls.delete(key);
    const entries = antigravityUpdateSteps(update['rawInput']);
    return entries === undefined
      ? undefined
      : { ...source, update: { sessionUpdate: 'plan', entries } } as T;
  };
}

export function antigravityIsScheduleToolCall(toolCall: { readonly title?: string }): boolean {
  return toolCall.title !== undefined && ANTIGRAVITY_SCHEDULE_TITLES.has(toolCall.title);
}

export function antigravityCommandOutlivesPrompt(toolCall: {
  readonly kind?: string;
  readonly title?: string;
  readonly rawInput?: unknown;
}): boolean {
  if (antigravityIsScheduleToolCall(toolCall)) return false;
  const input = record(toolCall.rawInput);
  return toolCall.kind === 'execute' && input?.['IsDaemon'] !== true;
}

export function antigravityToolOutlivesPrompt(toolCall: {
  readonly kind?: string;
  readonly title?: string;
  readonly rawInput?: unknown;
}): boolean {
  return antigravityIsScheduleToolCall(toolCall) || antigravityCommandOutlivesPrompt(toolCall);
}

export function classifyAntigravitySubagentToolCall(toolCall: {
  readonly kind?: string;
  readonly title?: string;
  readonly meta?: unknown;
}): 'subagent' | 'mcp' | undefined {
  if (
    (toolCall.kind !== undefined && toolCall.kind !== 'other') ||
    toolCall.title === undefined ||
    !ANTIGRAVITY_SUBAGENT_TITLES.has(toolCall.title)
  ) {
    return undefined;
  }
  const meta = record(toolCall.meta);
  return meta?.['is_mcp_tool_call'] === true ? 'mcp' : 'subagent';
}

function parseSingleLaunch(value: unknown): AntigravityChildLaunch | undefined {
  const entry = record(value);
  if (entry === undefined) return undefined;
  const role = typeof entry['Role'] === 'string'
    ? entry['Role']
    : typeof entry['role'] === 'string'
      ? entry['role']
      : undefined;
  const prompt = typeof entry['Prompt'] === 'string'
    ? entry['Prompt']
    : typeof entry['prompt'] === 'string'
      ? entry['prompt']
      : undefined;
  if (role === undefined || prompt === undefined) return undefined;
  return { role, prompt };
}

export function antigravitySubagentLaunches(input: unknown): readonly AntigravityChildLaunch[] | undefined {
  const object = record(input);
  if (object === undefined) return undefined;
  const batch = object['Subagents'] ?? object['subagents'];
  if (Array.isArray(batch) && batch.length > 0) {
    const parsed = batch.map(parseSingleLaunch);
    return parsed.every((entry): entry is AntigravityChildLaunch => entry !== undefined) ? parsed : undefined;
  }
  const single = parseSingleLaunch(object);
  return single === undefined ? undefined : [single];
}

export function describeAntigravitySubagentLaunches(
  launches: readonly AntigravityChildLaunch[],
): { readonly title: string; readonly prompt: string } {
  const [only] = launches;
  return launches.length === 1 && only !== undefined
    ? { title: only.role, prompt: only.prompt }
    : {
        title: launches.map((launch) => launch.role).join(', '),
        prompt: launches.map((launch) => `${launch.role}\n${launch.prompt}`).join('\n\n'),
      };
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
