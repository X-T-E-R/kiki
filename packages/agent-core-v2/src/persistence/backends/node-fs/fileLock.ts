import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'pathe';

import {
  StorageError,
  StorageErrors,
  type IStorageLock,
  type StorageLockOptions,
  toStorageIoError,
} from '#/persistence/interface/storage';

interface FileLockPayload {
  readonly version: 1;
  readonly pid: number;
  readonly processStartedAt: number;
  readonly token: string;
  readonly acquiredAt: number;
  readonly leaseMs: number;
  readonly owner?: Readonly<Record<string, unknown>>;
}

interface InspectedLock {
  readonly payload?: FileLockPayload;
  readonly active: boolean;
  readonly mine: boolean;
}

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_RENEW_INTERVAL_MS = 15_000;
const TAKEOVER_SETTLE_BASE_MS = 60;
const TAKEOVER_SETTLE_MAX_MS = 2_000;
const PROCESS_STARTED_AT = Math.floor(Date.now() - process.uptime() * 1_000);
const HELD = new Set<FileLock>();
let exitHooked = false;
let sidecarSequence = 0;

function nextSidecarSequence(): number {
  sidecarSequence += 1;
  return sidecarSequence;
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isPayload(value: unknown): value is FileLockPayload {
  if (value === null || typeof value !== 'object') return false;
  const payload = value as Partial<FileLockPayload>;
  return (
    payload.version === 1 &&
    typeof payload.pid === 'number' &&
    typeof payload.processStartedAt === 'number' &&
    typeof payload.token === 'string' &&
    typeof payload.acquiredAt === 'number' &&
    typeof payload.leaseMs === 'number' &&
    payload.leaseMs > 0
  );
}

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('beforeExit', () => {
    for (const lock of HELD) lock.releaseSync();
  });
}

/** Acquires a renewable local-filesystem exclusive lock: tokenized process ownership with atomic
 *  create/takeover semantics, kept fresh through a lease heartbeat, reclaiming dead or expired owners
 *  and releasing only the token held by this lock instance. */
export async function acquireFileLock(
  lockPath: string,
  options: StorageLockOptions = {},
  modes: { readonly dirMode?: number; readonly fileMode?: number } = {},
): Promise<IStorageLock> {
  const lock = new FileLock(lockPath, options, modes);
  try {
    if (await lock.acquire()) return lock;
    const inspected = await lock.inspectOwner();
    throw new StorageError(
      StorageErrors.codes.STORAGE_LOCKED,
      typeof inspected?.owner?.['sessionId'] === 'string'
        ? `Session "${inspected.owner['sessionId']}" is active in another process`
        : 'Storage is locked by another process',
      {
        details: {
          path: lockPath,
          owner: inspected?.owner,
          pid: inspected?.pid,
          acquiredAt: inspected?.acquiredAt,
        },
      },
    );
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw toStorageIoError(error, { path: lockPath, op: 'lock' });
  }
}

class FileLock implements IStorageLock {
  private readonly leaseMs: number;
  private readonly renewIntervalMs: number;
  private readonly owner?: Readonly<Record<string, unknown>>;
  private readonly dirMode?: number;
  private readonly fileMode?: number;
  private token = '';
  private acquiredAt = 0;
  private held = false;
  private renewTimer: ReturnType<typeof setInterval> | undefined;
  private serialized = Promise.resolve();

  constructor(
    private readonly lockPath: string,
    options: StorageLockOptions,
    modes: { readonly dirMode?: number; readonly fileMode?: number },
  ) {
    this.leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
    this.renewIntervalMs = Math.max(
      250,
      Math.min(options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS, this.leaseMs / 2),
    );
    this.owner = options.owner;
    this.dirMode = modes.dirMode;
    this.fileMode = modes.fileMode;
  }

  acquire(): Promise<boolean> {
    return this.runExclusive(() => this.acquireOnce());
  }

  release(): Promise<void> {
    return this.runExclusive(async () => {
      if (!this.held) return;
      this.stopHeartbeat();
      const current = await this.inspect();
      if (current?.mine === true) await unlink(this.lockPath).catch(() => undefined);
      this.held = false;
      HELD.delete(this);
    });
  }

  releaseSync(): void {
    if (!this.held) return;
    this.stopHeartbeat();
    try {
      const parsed = JSON.parse(fsSync.readFileSync(this.lockPath, 'utf8')) as unknown;
      if (isPayload(parsed) && parsed.token === this.token) fsSync.unlinkSync(this.lockPath);
    } catch {
    }
    this.held = false;
    HELD.delete(this);
  }

  async inspectOwner(): Promise<FileLockPayload | undefined> {
    return (await this.inspect())?.payload;
  }

  private async acquireOnce(): Promise<boolean> {
    if (this.held) return true;
    this.token = `${process.pid}:${randomUUID()}`;
    this.acquiredAt = Date.now();
    await mkdir(dirname(this.lockPath), { recursive: true, mode: this.dirMode });
    const watchPath = `${this.lockPath}.watch-${process.pid}-${nextSidecarSequence()}`;
    await writeFile(watchPath, this.payloadText(), { mode: this.fileMode });
    try {
      await this.reapDeadWatches();
      if (await this.tryCreate()) return true;
      const seen = await this.inspect();
      if (seen === null || seen.active) return false;
      return await this.takeOver();
    } finally {
      await unlink(watchPath).catch(() => undefined);
    }
  }

  private async tryCreate(): Promise<boolean> {
    const tempPath = `${this.lockPath}.tmp-${process.pid}-${nextSidecarSequence()}`;
    try {
      await writeFile(tempPath, this.payloadText(), { mode: this.fileMode });
      await link(tempPath, this.lockPath);
      this.markHeld();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return false;
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  private async takeOver(): Promise<boolean> {
    const bidPath = `${this.lockPath}.bid-${process.pid}-${nextSidecarSequence()}`;
    const startedAt = Date.now();
    try {
      await writeFile(bidPath, this.payloadText(), { mode: this.fileMode });
      for (let attempt = 0; ; attempt += 1) {
        const gate = await this.inspect();
        if (gate === null || gate.active || gate.mine) return false;
        try {
          await rename(bidPath, this.lockPath);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' && process.platform === 'win32' && attempt < 50) {
            await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
            continue;
          }
          if (code === 'EEXIST' || code === 'EPERM') return false;
          throw error;
        }
      }
      let settleMs = Math.min(
        TAKEOVER_SETTLE_MAX_MS,
        Math.max(TAKEOVER_SETTLE_BASE_MS, (Date.now() - startedAt) * 4),
      );
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        const current = await this.inspect();
        if (current?.mine !== true) return false;
        if (!(await this.hasLiveForeignWatch())) break;
        settleMs = Math.min(TAKEOVER_SETTLE_MAX_MS, settleMs * 2);
      }
      this.markHeld();
      return true;
    } finally {
      await unlink(bidPath).catch(() => undefined);
    }
  }

  private async inspect(): Promise<InspectedLock | null> {
    let raw: string;
    let modifiedAt: number;
    try {
      const [content, fileStat] = await Promise.all([
        readFile(this.lockPath, 'utf8'),
        stat(this.lockPath),
      ]);
      raw = content;
      modifiedAt = fileStat.mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let payload: FileLockPayload | undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isPayload(parsed)) payload = parsed;
    } catch {
    }
    if (payload === undefined) return { active: false, mine: false };
    const samePidWrongStart =
      payload.pid === process.pid && Math.abs(payload.processStartedAt - PROCESS_STARTED_AT) > 2_000;
    return {
      payload,
      active: !samePidWrongStart && pidAlive(payload.pid) && modifiedAt + payload.leaseMs > Date.now(),
      mine: payload.token === this.token,
    };
  }

  private async reapDeadWatches(): Promise<void> {
    const directory = dirname(this.lockPath);
    const prefix = `${basename(this.lockPath)}.watch-`;
    for (const entry of await readdir(directory).catch(() => [] as string[])) {
      if (!entry.startsWith(prefix)) continue;
      const watchPath = join(directory, entry);
      if (!(await this.watchIsActive(watchPath))) await unlink(watchPath).catch(() => undefined);
    }
  }

  private async hasLiveForeignWatch(): Promise<boolean> {
    const directory = dirname(this.lockPath);
    const prefix = `${basename(this.lockPath)}.watch-`;
    for (const entry of await readdir(directory).catch(() => [] as string[])) {
      if (!entry.startsWith(prefix)) continue;
      const watchPath = join(directory, entry);
      const payload = await this.readPayload(watchPath);
      if (payload?.token === this.token) continue;
      if (await this.watchIsActive(watchPath, payload)) return true;
      await unlink(watchPath).catch(() => undefined);
    }
    return false;
  }

  private async watchIsActive(
    watchPath: string,
    knownPayload?: FileLockPayload,
  ): Promise<boolean> {
    try {
      const [payload, fileStat] = await Promise.all([
        knownPayload === undefined ? this.readPayload(watchPath) : knownPayload,
        stat(watchPath),
      ]);
      if (payload === undefined) return false;
      const samePidWrongStart =
        payload.pid === process.pid && Math.abs(payload.processStartedAt - PROCESS_STARTED_AT) > 2_000;
      return !samePidWrongStart && pidAlive(payload.pid) && fileStat.mtimeMs + payload.leaseMs > Date.now();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async readPayload(path: string): Promise<FileLockPayload | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      return isPayload(parsed) ? parsed : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return undefined;
    }
  }

  private markHeld(): void {
    this.held = true;
    HELD.add(this);
    hookExit();
    this.renewTimer = setInterval(() => {
      void this.renew().catch(() => undefined);
    }, this.renewIntervalMs);
    this.renewTimer.unref?.();
  }

  private renew(): Promise<void> {
    return this.runExclusive(async () => {
      if (!this.held) return;
      const current = await this.inspect();
      if (current?.mine !== true) {
        this.stopHeartbeat();
        this.held = false;
        HELD.delete(this);
        return;
      }
      const now = new Date();
      await utimes(this.lockPath, now, now);
    });
  }

  private stopHeartbeat(): void {
    if (this.renewTimer === undefined) return;
    clearInterval(this.renewTimer);
    this.renewTimer = undefined;
  }

  private payloadText(): string {
    const payload: FileLockPayload = {
      version: 1,
      pid: process.pid,
      processStartedAt: PROCESS_STARTED_AT,
      token: this.token,
      acquiredAt: this.acquiredAt,
      leaseMs: this.leaseMs,
      owner: this.owner,
    };
    return JSON.stringify(payload);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serialized.then(operation, operation);
    this.serialized = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
