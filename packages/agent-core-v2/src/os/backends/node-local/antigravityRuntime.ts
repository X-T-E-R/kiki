import { constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rm, rmdir, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Stats } from 'node:fs';

const PLANNER_RESPONSE_STEP_TYPE = 15;
const ERROR_STEP_TYPE = 17;
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
const PRE_EDIT_FILE_LIMIT = 1024 * 1024;
const SUBAGENT_BYTE_BUDGET = 512 * 1024;
const MAX_SUBAGENT_ENTRIES = 24;
const STEP_TEXT_CAP = 4_000;
const TOOL_INPUT_CAP = 1_000;
const HIGH_PRIORITY_MESSAGE = 'MESSAGE_PRIORITY_HIGH';
const LOW_PRIORITY_MESSAGE = 'MESSAGE_PRIORITY_LOW';

const API_ERROR = /Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\n]*)/s;
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
const INVALID_THINKING_SIGNATURE = /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/;
const RESET_DELAY = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
const RETRY_DELAY = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};
const NATIVE_SESSION_ID = /^[\w-]{1,64}$/;
const CONVERSATION_DIRS = [
  ['antigravity-acp', 'conversations'],
  ['antigravity-cli', 'conversations'],
] as const;

export interface AntigravityTurnFailure {
  readonly kind: 'usage_limit' | 'provider_error';
  readonly message: string;
  readonly code?: string;
  readonly retryable: boolean;
  readonly resetAt?: string;
  readonly poisonedSession?: boolean;
  readonly continuable?: boolean;
}

export interface AntigravitySubagentLatestStep {
  readonly index: number;
  readonly type: string;
  readonly status?: string;
  readonly text?: string;
  readonly toolCalls: readonly { readonly name: string; readonly input: string }[];
}

export interface AntigravitySubagentEntry {
  readonly conversationId: string;
  readonly toolCallId?: string;
  readonly role?: string;
  readonly prompt?: string;
  readonly state?: string;
  readonly reported: boolean;
  readonly latestStep?: AntigravitySubagentLatestStep;
  readonly incomplete: boolean;
}

export interface AntigravitySubagentWorkSnapshot {
  readonly entries: readonly AntigravitySubagentEntry[];
  readonly incomplete: boolean;
}

interface LastStep {
  readonly type: number;
  readonly payload: Uint8Array | null;
  readonly reachedModel: boolean;
}

interface ManagedPath {
  readonly path: string;
  readonly info: Stats;
}

interface ReadBudget {
  remainingBytes: number;
  incomplete: boolean;
}

export async function prepareAntigravityRuntime(input: {
  readonly profileHome: string;
  readonly tempHome: string;
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
}): Promise<void> {
  await Promise.all([
    mkdir(input.profileHome, { recursive: true, mode: 0o700 }),
    mkdir(input.tempHome, { recursive: true, mode: 0o700 }),
  ]);
  const globalHome = join(input.userHome, '.gemini');
  for (const relative of [join('config', 'skills'), join('antigravity-cli', 'skills')]) {
    const link = join(input.profileHome, relative);
    const target = join(globalHome, relative);
    await linkSkills(link, target, input.platform).catch(() => undefined);
  }
}

export async function removeAntigravityRuntimeTemp(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

/** Stats a local file attachment for size validation. */
export async function statLocalAttachmentFile(
  filePath: string,
): Promise<{ readonly size: number } | undefined> {
  const info = await stat(filePath).catch(() => undefined);
  return info?.isFile() === true ? { size: info.size } : undefined;
}

/** Reads at most `maxBytes + 1` bytes from a local file attachment so oversized files are rejected without buffering them fully. */
export async function readLocalAttachmentBytes(
  filePath: string,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY);
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const toRead = Math.min(info.size, maxBytes + 1);
    const buffer = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Reads a pre-edit local file of at most 1 MiB when it resolves inside authorized workspace roots. */
export function readAntigravityPreEditFileInRoots(
  filePath: string,
  allowedRoots: readonly string[],
): string | undefined {
  if (!filePath || allowedRoots.length === 0) return undefined;
  let resolvedFile: string;
  try {
    resolvedFile = realpathSync(filePath);
  } catch {
    return undefined;
  }
  const authorized = allowedRoots.some((root) => {
    try {
      const resolvedRoot = realpathSync(root);
      return isPathInsideRoot(resolvedFile, resolvedRoot);
    } catch {
      return false;
    }
  });
  if (!authorized) return undefined;
  try {
    const info = statSync(resolvedFile);
    if (!info.isFile() || info.size > PRE_EDIT_FILE_LIMIT) return undefined;
    const raw = readFileSync(resolvedFile);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}

export async function watchAntigravityTurnOutcome(
  profileDirectory: string,
  sessionId: string,
  now: () => number = Date.now,
): Promise<(stopReason: string) => Promise<AntigravityTurnFailure | undefined>> {
  const typedOnly = async (stopReason: string) => turnFailure(stopReason, undefined, now());
  if (!NATIVE_SESSION_ID.test(sessionId)) return typedOnly;
  const root = await realpath(profileDirectory).catch(() => undefined);
  if (root === undefined) return typedOnly;
  const candidates: Array<{
    readonly segments: readonly string[];
    readonly identity: Stats | undefined;
    readonly startIndex: number;
  }> = [];
  for (const dirSegments of CONVERSATION_DIRS) {
    const segments = [...dirSegments, `${sessionId}.db`];
    const dir = await antigravityManagedPath(root, dirSegments, 'directory');
    if (dir === undefined) {
      const foreignDir = await lstat(join(root, ...dirSegments)).then(() => true, () => false);
      if (!foreignDir) candidates.push({ segments, identity: undefined, startIndex: -1 });
      continue;
    }
    const db = await antigravityManagedPath(root, segments, 'file');
    if (db === undefined) {
      const foreignFile = await lstat(join(root, ...segments)).then(() => true, () => false);
      if (!foreignFile) candidates.push({ segments, identity: undefined, startIndex: -1 });
      continue;
    }
    const index = readSteps(db.path, lastStepIndex);
    if (index !== undefined) {
      candidates.push({ segments, identity: db.info, startIndex: index });
    }
  }
  if (candidates.length === 0) return typedOnly;
  return async (stopReason: string) => {
    for (const candidate of candidates) {
      const after = await antigravityManagedPath(root, candidate.segments, 'file');
      if (after === undefined) continue;
      const sameFile = candidate.identity === undefined ||
        (after.info.dev === candidate.identity.dev && after.info.ino === candidate.identity.ino);
      if (!sameFile) continue;
      const step = readSteps(after.path, lastStepAfter(candidate.startIndex));
      const failure = turnFailure(stopReason, step, now());
      if (failure !== undefined) return failure;
    }
    return turnFailure(stopReason, undefined, now());
  };
}

/** Inspects Antigravity detached subagent records under `brain/<sessionId>/.system_generated` within a 512 KiB / 24-entry read-only budget. */
export async function inspectAntigravitySubagentWork(input: {
  readonly profileDirectory: string;
  readonly sessionId: string;
  readonly toolCallId?: string;
}): Promise<AntigravitySubagentWorkSnapshot> {
  if (!NATIVE_SESSION_ID.test(input.sessionId)) return { entries: [], incomplete: false };
  const profileRoot = await realpath(input.profileDirectory).catch(() => undefined);
  if (profileRoot === undefined) return { entries: [], incomplete: false };

  const budget: ReadBudget = { remainingBytes: SUBAGENT_BYTE_BUDGET, incomplete: false };
  const subagentsDir = await antigravityManagedPath(
    profileRoot,
    ['antigravity-acp', 'brain', input.sessionId, '.system_generated', 'subagents'],
    'directory',
  );
  if (subagentsDir === undefined) return { entries: [], incomplete: false };

  const rawDirEntries = await readdir(subagentsDir.path).catch(() => undefined);
  if (rawDirEntries === undefined) return { entries: [], incomplete: true };
  const allChildIds = rawDirEntries
    .filter((name) => name.endsWith('.json') && NATIVE_SESSION_ID.test(name.slice(0, -5)))
    .map((name) => name.slice(0, -5))
    .toSorted();
  if (allChildIds.length > MAX_SUBAGENT_ENTRIES) {
    budget.incomplete = true;
  }
  const childIds = allChildIds.slice(0, MAX_SUBAGENT_ENTRIES);
  if (childIds.length === 0) return { entries: [], incomplete: budget.incomplete };

  const parentInbox = await readBoundedInbox(profileRoot, input.sessionId, budget);
  const reportedSenders = new Set(
    parentInbox.map((message) => message.sender).filter((sender): sender is string => typeof sender === 'string'),
  );

  const entries: AntigravitySubagentEntry[] = [];
  for (const childId of childIds) {
    const descriptor = await readBoundedJson(
      profileRoot,
      ['antigravity-acp', 'brain', input.sessionId, '.system_generated', 'subagents', `${childId}.json`],
      budget,
    );
    const descriptorObj = recordOf(descriptor);
    const descriptorSub = recordOf(descriptorObj?.['subagentDescriptor']);
    let role = stringOf(descriptorSub?.['role']);
    let prompt: string | undefined;
    let launchToolCallId: string | undefined;
    const state = stringOf(descriptorObj?.['state']);

    const childInbox = await readBoundedInbox(profileRoot, childId, budget);
    for (const message of childInbox) {
      if (message.sender !== input.sessionId) continue;
      const tool = recordOf(recordOf(message.sourceMetadata)?.['tool']);
      const toolCall = recordOf(tool?.['toolCall']);
      const toolConvId = stringOf(tool?.['conversationId']);
      if (
        (toolConvId === undefined || toolConvId === input.sessionId) &&
        stringOf(toolCall?.['name']) === 'invoke_subagent'
      ) {
        launchToolCallId = stringOf(toolCall?.['id']);
        const parsedArgs = parseJsonString(stringOf(toolCall?.['argumentsJson']));
        const launch = extractLaunchRolePrompt(parsedArgs);
        if (launch?.role) role = launch.role;
        if (launch?.prompt) prompt = launch.prompt;
        if (prompt === undefined && typeof message.content === 'string') {
          prompt = capText(message.content, STEP_TEXT_CAP);
        }
        break;
      }
    }

    if (input.toolCallId !== undefined && launchToolCallId !== input.toolCallId) {
      continue;
    }

    const transcript = await readLatestTranscriptStep(profileRoot, childId, budget);
    const entryIncomplete = budget.incomplete || transcript.incomplete;
    entries.push({
      conversationId: childId,
      toolCallId: launchToolCallId,
      role,
      prompt: prompt === undefined ? undefined : capText(prompt, STEP_TEXT_CAP),
      state,
      reported: reportedSenders.has(childId),
      latestStep: transcript.step,
      incomplete: entryIncomplete,
    });
  }

  return { entries, incomplete: budget.incomplete };
}

/** Returns launching tool call IDs whose detached Antigravity children have neither reported back nor been killed. */
export async function readAntigravityChildrenAtWork(input: {
  readonly profileDirectory: string;
  readonly sessionId: string;
  readonly toolCallIds: readonly string[];
}): Promise<{ readonly activeToolCallIds: readonly string[]; readonly incomplete: boolean }> {
  if (input.toolCallIds.length === 0) return { activeToolCallIds: [], incomplete: false };
  const snapshot = await inspectAntigravitySubagentWork({
    profileDirectory: input.profileDirectory,
    sessionId: input.sessionId,
  });
  const wanted = new Set(input.toolCallIds);
  const activeToolCallIds: string[] = [];
  for (const entry of snapshot.entries) {
    if (entry.toolCallId === undefined || !wanted.has(entry.toolCallId)) continue;
    if (entry.reported || entry.state === 'SUBAGENT_STATE_KILLED') continue;
    activeToolCallIds.push(entry.toolCallId);
  }
  return { activeToolCallIds, incomplete: snapshot.incomplete };
}

/** True when Antigravity has an unread high-priority wake message or trailing waking SYSTEM_MESSAGE step queued for the session. */
export async function readAntigravityPendingReply(input: {
  readonly profileDirectory: string;
  readonly sessionId: string;
}): Promise<boolean> {
  if (!NATIVE_SESSION_ID.test(input.sessionId)) return false;
  const profileRoot = await realpath(input.profileDirectory).catch(() => undefined);
  if (profileRoot === undefined) return false;
  const budget: ReadBudget = { remainingBytes: SUBAGENT_BYTE_BUDGET, incomplete: false };

  const inboxDirSegments = ['antigravity-acp', 'brain', input.sessionId, '.system_generated', 'messages'];
  const inboxDir = await antigravityManagedPath(profileRoot, inboxDirSegments, 'directory');
  if (inboxDir !== undefined) {
    const names = await readdir(inboxDir.path).catch(() => undefined);
    if (names !== undefined) {
      let readReceipts: Readonly<Record<string, boolean>> = {};
      if (names.includes('read.json')) {
        const parsedReceipts = recordOf(await readBoundedJson(profileRoot, [...inboxDirSegments, 'read.json'], budget));
        if (parsedReceipts !== undefined) {
          const receipts: Record<string, boolean> = {};
          for (const [key, value] of Object.entries(parsedReceipts)) {
            if (typeof value === 'boolean') receipts[key] = value;
          }
          readReceipts = receipts;
        }
      }
      const messageNames = names
        .filter((name) => name.endsWith('.json') && name !== 'read.json')
        .toSorted()
        .slice(0, MAX_SUBAGENT_ENTRIES);
      for (const name of messageNames) {
        const fileId = name.slice(0, -5);
        if (readReceipts[fileId] === true) continue;
        const msg = recordOf(await readBoundedJson(profileRoot, [...inboxDirSegments, name], budget));
        if (msg === undefined) continue;
        const msgId = stringOf(msg['id']);
        if (msgId !== undefined && readReceipts[msgId] === true) continue;
        if (stringOf(msg['priority']) === HIGH_PRIORITY_MESSAGE) return true;
      }
    }
  }

  const latest = await readLatestTranscriptStep(profileRoot, input.sessionId, budget);
  if (latest.step === undefined || latest.step.type !== 'SYSTEM_MESSAGE') return false;
  const text = latest.step.text;
  return text === undefined ||
    text.includes(`priority=${HIGH_PRIORITY_MESSAGE}`) ||
    !text.includes(`priority=${LOW_PRIORITY_MESSAGE}`);
}

export async function antigravityManagedPath(
  profileRoot: string,
  segments: readonly string[],
  kind: 'file' | 'directory',
): Promise<ManagedPath | undefined> {
  let current = profileRoot;
  let info: Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    info = await lstat(current).catch(() => undefined);
    const expectFile = kind === 'file' && index === segments.length - 1;
    if (info === undefined || info.isSymbolicLink() || (expectFile ? !info.isFile() : !info.isDirectory())) {
      return undefined;
    }
  }
  if (info === undefined) return undefined;
  return (await realpath(current).catch(() => undefined)) === current ? { path: current, info } : undefined;
}

function isPathInsideRoot(filePath: string, rootPath: string): boolean {
  const normalize = (value: string) => {
    const resolved = resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const file = normalize(filePath);
  const root = normalize(rootPath);
  if (file === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return file.startsWith(prefix);
}

interface InboxMessageRecord {
  readonly sender?: string;
  readonly content?: string;
  readonly sourceMetadata?: unknown;
}

async function readBoundedJson(
  profileRoot: string,
  segments: readonly string[],
  budget: ReadBudget,
): Promise<unknown> {
  if (budget.remainingBytes <= 0) {
    budget.incomplete = true;
    return undefined;
  }
  const file = await antigravityManagedPath(profileRoot, segments, 'file');
  if (file === undefined) return undefined;
  if (file.info.size > budget.remainingBytes) {
    budget.incomplete = true;
    return undefined;
  }
  const text = await readFile(file.path, 'utf8').catch(() => undefined);
  if (text === undefined) {
    budget.incomplete = true;
    return undefined;
  }
  budget.remainingBytes -= Buffer.byteLength(text, 'utf8');
  return parseJsonString(text);
}

async function readBoundedInbox(
  profileRoot: string,
  conversationId: string,
  budget: ReadBudget,
): Promise<InboxMessageRecord[]> {
  const dirSegments = ['antigravity-acp', 'brain', conversationId, '.system_generated', 'messages'];
  const dir = await antigravityManagedPath(profileRoot, dirSegments, 'directory');
  if (dir === undefined) return [];
  const entries = await readdir(dir.path).catch(() => undefined);
  if (entries === undefined) {
    budget.incomplete = true;
    return [];
  }
  const allMessages = entries
    .filter((name) => name.endsWith('.json') && name !== 'read.json')
    .toSorted();
  if (allMessages.length > MAX_SUBAGENT_ENTRIES) {
    budget.incomplete = true;
  }
  const messages: InboxMessageRecord[] = [];
  for (const name of allMessages.slice(0, MAX_SUBAGENT_ENTRIES)) {
    const parsed = recordOf(await readBoundedJson(profileRoot, [...dirSegments, name], budget));
    if (parsed === undefined) continue;
    messages.push({
      sender: stringOf(parsed['sender']),
      content: stringOf(parsed['content']),
      sourceMetadata: parsed['sourceMetadata'],
    });
  }
  return messages;
}

async function readLatestTranscriptStep(
  profileRoot: string,
  conversationId: string,
  budget: ReadBudget,
): Promise<{ readonly step?: AntigravitySubagentLatestStep; readonly incomplete: boolean }> {
  const transcript = await antigravityManagedPath(
    profileRoot,
    ['antigravity-acp', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl'],
    'file',
  );
  if (transcript === undefined) return { incomplete: false };
  if (budget.remainingBytes <= 0) {
    budget.incomplete = true;
    return { incomplete: true };
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(transcript.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0) return { incomplete: false };
    const cap = Math.min(info.size, budget.remainingBytes);
    const truncated = info.size > cap;
    if (truncated) budget.incomplete = true;
    const tailStart = Math.max(0, info.size - cap);
    const readStart = Math.max(0, tailStart - 1);
    const length = info.size - readStart;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, readStart);
    budget.remainingBytes = Math.max(0, budget.remainingBytes - bytesRead);
    const slice = buffer.subarray(0, bytesRead);
    let lineStart = 0;
    if (tailStart > 0) {
      const firstNewline = slice.indexOf(0x0a);
      if (firstNewline === -1) return { incomplete: true };
      lineStart = firstNewline + 1;
    }
    const text = slice.toString('utf8', lineStart);
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      const step = parseTranscriptStep(line);
      if (step !== undefined) return { step, incomplete: truncated };
    }
    return { incomplete: truncated };
  } catch {
    budget.incomplete = true;
    return { incomplete: true };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseTranscriptStep(line: string): AntigravitySubagentLatestStep | undefined {
  const obj = recordOf(parseJsonString(line));
  if (obj === undefined) return undefined;
  const stepIndex = obj['step_index'];
  const type = stringOf(obj['type']);
  if (typeof stepIndex !== 'number' || !Number.isInteger(stepIndex) || stepIndex < 0 || type === undefined) {
    return undefined;
  }
  const status = stringOf(obj['status']);
  const content = stringOf(obj['content']);
  const error = stringOf(obj['error']);
  const rawText = content ?? error;
  const rawCalls = Array.isArray(obj['tool_calls']) ? obj['tool_calls'] : [];
  const toolCalls = rawCalls.flatMap((entry) => {
    const call = recordOf(entry);
    const name = stringOf(call?.['name']);
    if (name === undefined) return [];
    let serialized = '{}';
    try {
      serialized = JSON.stringify(call?.['args'] ?? {}) ?? '{}';
    } catch {
      serialized = '{}';
    }
    return [{ name, input: capText(serialized, TOOL_INPUT_CAP) }];
  });
  return {
    index: stepIndex,
    type,
    status,
    text: rawText === undefined ? undefined : capText(rawText, STEP_TEXT_CAP),
    toolCalls,
  };
}

function extractLaunchRolePrompt(value: unknown): { readonly role?: string; readonly prompt?: string } | undefined {
  const obj = recordOf(value);
  if (obj === undefined) return undefined;
  const subagents = obj['Subagents'] ?? obj['subagents'];
  if (Array.isArray(subagents) && subagents.length > 0) {
    const first = recordOf(subagents[0]);
    if (first !== undefined) {
      return {
        role: stringOf(first['Role']) ?? stringOf(first['role']),
        prompt: stringOf(first['Prompt']) ?? stringOf(first['prompt']),
      };
    }
  }
  const role = stringOf(obj['Role']) ?? stringOf(obj['role']);
  const prompt = stringOf(obj['Prompt']) ?? stringOf(obj['prompt']);
  return role === undefined && prompt === undefined ? undefined : { role, prompt };
}

function parseJsonString(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function capText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function readSteps<T>(file: string, read: (database: DatabaseSync) => T): T | undefined {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    database.exec('PRAGMA busy_timeout = 100');
    const hasSteps = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
      .get() !== undefined;
    return hasSteps ? read(database) : undefined;
  } catch {
    return undefined;
  } finally {
    try { database?.close(); } catch {}
  }
}

function lastStepIndex(database: DatabaseSync): number {
  const row = database.prepare('SELECT max(idx) AS idx FROM steps').get() as { idx?: unknown } | undefined;
  return typeof row?.idx === 'number' ? row.idx : -1;
}

function lastStepAfter(index: number): (database: DatabaseSync) => LastStep | undefined {
  return (database) => {
    const row = database
      .prepare('SELECT step_type AS type, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1')
      .get(MAX_ERROR_PAYLOAD_BYTES, index) as { type?: unknown; payload?: unknown } | undefined;
    if (typeof row?.type !== 'number') return undefined;
    const reachedModel = database
      .prepare('SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1')
      .get(index, PLANNER_RESPONSE_STEP_TYPE) !== undefined;
    return {
      type: row.type,
      payload: row.payload instanceof Uint8Array ? row.payload : null,
      reachedModel,
    };
  };
}

function resetAtFrom(text: string, nowMs: number): string | undefined {
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp !== undefined && Number.isFinite(Date.parse(timestamp))) return timestamp;
  const delay = RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1];
  if (delay === undefined) return undefined;
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) {
    delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit!] ?? 0);
  }
  return delayMs > 0 ? new Date(nowMs + delayMs).toISOString() : undefined;
}

function statusError(text: string): readonly [string, string, string, string] | null {
  const match = STATUS_ERROR.exec(text);
  return match === null ? null : [match[0], match[2]!, match[3]!, match[1]!];
}

function turnFailure(
  stopReason: string,
  step: LastStep | undefined,
  nowMs: number,
): AntigravityTurnFailure | undefined {
  const errorText = step?.type === ERROR_STEP_TYPE
    ? new TextDecoder().decode(step.payload ?? new Uint8Array())
    : undefined;
  if (errorText === undefined && stopReason !== 'refusal') return undefined;
  const text = errorText ?? '';
  const apiError = API_ERROR.exec(text) ?? statusError(text);
  if (stopReason === 'refusal' || QUOTA_EXHAUSTED.test(text)) {
    const resetAt = resetAtFrom(text, nowMs);
    return {
      kind: 'usage_limit',
      message: 'You have reached your Antigravity quota for this period.',
      code: apiError?.[3] ?? 'QUOTA_EXHAUSTED',
      retryable: true,
      resetAt,
    };
  }
  if (INVALID_THINKING_SIGNATURE.test(text)) {
    return {
      kind: 'provider_error',
      message: "Antigravity's saved conversation can no longer be sent to the model. The next message starts a fresh Antigravity session with this thread's context.",
      code: 'INVALID_THINKING_SIGNATURE',
      retryable: true,
      poisonedSession: true,
    };
  }
  if (apiError === null) {
    return {
      kind: 'provider_error',
      message: 'Antigravity stopped this turn because of an error.',
      retryable: false,
    };
  }
  const [, httpStatus, message, status] = apiError;
  const rateLimited = httpStatus === '429' || status === 'RESOURCE_EXHAUSTED';
  const transientNotFound = httpStatus === '404' && step?.reachedModel === true;
  return {
    kind: rateLimited ? 'usage_limit' : 'provider_error',
    message: message!.trim(),
    code: status,
    retryable: rateLimited || transientNotFound || Number(httpStatus) >= 500,
    resetAt: resetAtFrom(text, nowMs),
    continuable: transientNotFound || undefined,
  };
}

async function linkSkills(link: string, target: string, platform: NodeJS.Platform): Promise<void> {
  const targetExists = await stat(target).then((info) => info.isDirectory(), () => false);
  const existing = await lstat(link).catch(() => undefined);
  if (!targetExists) {
    if (existing?.isSymbolicLink()) await rm(link, { force: true });
    return;
  }
  if (existing?.isSymbolicLink()) {
    const current = await readlink(link).then((value) => resolve(dirname(link), value), () => undefined);
    if (current === resolve(target)) return;
    await rm(link, { force: true });
  } else if (existing !== undefined) {
    if (!existing.isDirectory()) return;
    await rmdir(link).catch(() => undefined);
    if (await lstat(link).then(() => true, () => false)) return;
  }
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link, platform === 'win32' ? 'junction' : 'dir');
}
