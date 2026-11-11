import { lstat, mkdir, readlink, realpath, rm, rmdir, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Stats } from 'node:fs';

const ERROR_STEP_TYPE = 17;
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
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
const NATIVE_SESSION_ID = /^[\w-]+$/;
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
}

interface LastStep {
  readonly type: number;
  readonly payload: Uint8Array | null;
}

interface ManagedPath {
  readonly path: string;
  readonly info: Stats;
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
    return { type: row.type, payload: row.payload instanceof Uint8Array ? row.payload : null };
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
  const apiError = API_ERROR.exec(text);
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
  if (apiError === null) {
    return {
      kind: 'provider_error',
      message: 'Antigravity stopped this turn because of an error.',
      retryable: false,
    };
  }
  const [, httpStatus, message, status] = apiError;
  const rateLimited = httpStatus === '429' || status === 'RESOURCE_EXHAUSTED';
  return {
    kind: rateLimited ? 'usage_limit' : 'provider_error',
    message: message!.trim(),
    code: status,
    retryable: rateLimited || Number(httpStatus) >= 500,
    resetAt: resetAtFrom(text, nowMs),
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
