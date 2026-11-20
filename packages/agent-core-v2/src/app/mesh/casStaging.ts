import { createHash } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const DEFAULT_STALE_LOCK_MS = 3_600_000;

export interface CasStageResult {
  readonly sha256: string;
  readonly blobPath: string;
  readonly size: number;
  readonly deduplicated: boolean;
  readonly waitedForInFlight: boolean;
}

export interface CasStageOptions {
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly beforeWriteHook?: () => Promise<void>;
}

/**
 * Content-addressed staging store with `transfer-<sha256>.lock` in-flight deduplication
 * and automatic stale-lock pruning (> 1h).
 */
export class CasStagingStore {
  readonly blobsDir: string;
  readonly locksDir: string;

  constructor(
    rootDir: string,
    private readonly staleLockMs: number = DEFAULT_STALE_LOCK_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    const resolved = resolve(rootDir);
    this.blobsDir = join(resolved, 'blobs');
    this.locksDir = join(resolved, 'locks');
  }

  blobPath(sha256: string): string {
    assertSha256(sha256);
    return join(this.blobsDir, sha256);
  }

  lockPath(sha256: string): string {
    assertSha256(sha256);
    return join(this.locksDir, `transfer-${sha256}.lock`);
  }

  async hasBlob(sha256: string): Promise<boolean> {
    try {
      return (await stat(this.blobPath(sha256))).isFile();
    } catch {
      return false;
    }
  }

  async readBlob(sha256: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.blobPath(sha256));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async pruneStaleLocks(): Promise<readonly string[]> {
    await mkdir(this.locksDir, { recursive: true });
    const entries = await readdir(this.locksDir);
    const pruned: string[] = [];
    const currentNow = this.now();
    for (const name of entries) {
      if (!/^transfer-[0-9a-f]{64}\.lock$/.test(name)) continue;
      const fullPath = join(this.locksDir, name);
      if (await this.isLockStale(fullPath, currentNow)) {
        await rm(fullPath, { force: true });
        pruned.push(name);
      }
    }
    return pruned.toSorted();
  }

  async stageBytes(bytes: Uint8Array, options: CasStageOptions = {}): Promise<CasStageResult> {
    const buffer = Buffer.from(bytes);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const targetBlobPath = this.blobPath(sha256);
    const targetLockPath = this.lockPath(sha256);

    await mkdir(this.blobsDir, { recursive: true });
    await mkdir(this.locksDir, { recursive: true });

    if (await this.hasBlob(sha256)) {
      return {
        sha256,
        blobPath: targetBlobPath,
        size: buffer.byteLength,
        deduplicated: true,
        waitedForInFlight: false,
      };
    }

    const waitTimeoutMs = options.waitTimeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 20;
    const deadline = this.now() + waitTimeoutMs;
    let waitedForInFlight = false;

    for (;;) {
      const acquired = await this.tryAcquireLock(targetLockPath, sha256);
      if (acquired) {
        try {
          if (await this.hasBlob(sha256)) {
            return {
              sha256,
              blobPath: targetBlobPath,
              size: buffer.byteLength,
              deduplicated: true,
              waitedForInFlight,
            };
          }
          if (options.beforeWriteHook !== undefined) {
            await options.beforeWriteHook();
          }
          const tempBlob = `${targetBlobPath}.tmp-${process.pid}-${this.now()}`;
          await writeFile(tempBlob, buffer);
          await rename(tempBlob, targetBlobPath);
          return {
            sha256,
            blobPath: targetBlobPath,
            size: buffer.byteLength,
            deduplicated: false,
            waitedForInFlight,
          };
        } finally {
          await rm(targetLockPath, { force: true }).catch(() => undefined);
        }
      }

      waitedForInFlight = true;
      if (await this.isLockStale(targetLockPath, this.now())) {
        await rm(targetLockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (await this.hasBlob(sha256)) {
        return {
          sha256,
          blobPath: targetBlobPath,
          size: buffer.byteLength,
          deduplicated: true,
          waitedForInFlight: true,
        };
      }
      if (this.now() >= deadline) {
        throw new Error(`Timed out waiting for in-flight transfer lock transfer-${sha256}.lock`);
      }
      await delay(pollIntervalMs);
    }
  }

  async stageFile(filePath: string, options: CasStageOptions = {}): Promise<CasStageResult> {
    const bytes = await readFile(filePath);
    return this.stageBytes(bytes, options);
  }

  private async tryAcquireLock(lockFilePath: string, sha256: string): Promise<boolean> {
    try {
      const handle = await open(lockFilePath, 'wx');
      try {
        await handle.writeFile(
          JSON.stringify({ sha256, pid: process.pid, createdAt: this.now() }),
          'utf8',
        );
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  private async isLockStale(lockFilePath: string, currentNow: number): Promise<boolean> {
    try {
      const info = await stat(lockFilePath);
      const raw = await readFile(lockFilePath, 'utf8').catch(() => '');
      let createdAt = info.mtimeMs;
      try {
        const parsed = JSON.parse(raw) as { createdAt?: unknown };
        if (typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt)) {
          createdAt = parsed.createdAt;
        }
      } catch {
      }
      return currentNow - createdAt > this.staleLockMs;
    } catch {
      return false;
    }
  }
}

function assertSha256(sha256: string): void {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`Invalid SHA-256 digest: ${sha256}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref?.();
  });
}
