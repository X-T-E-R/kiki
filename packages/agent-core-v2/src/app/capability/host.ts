import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { IHostProcessService } from '#/os/interface/hostProcess';

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function runCommand(
  hostProcess: IHostProcessService,
  command: string,
  args: readonly string[],
  options: { timeout?: number } = {},
): Promise<CommandResult> {
  const spawned = await hostProcess.spawn(command, args, { windowsHide: true }).then(
    (proc) => ({ ok: true as const, proc }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!spawned.ok) {
    return { code: -1, stdout: '', stderr: spawned.error instanceof Error ? spawned.error.message : String(spawned.error) };
  }
  const { proc } = spawned;
  try {
    const work = Promise.all([
      collect(proc.stdout),
      collect(proc.stderr),
      proc.wait().catch(() => -1),
    ] as const);
    let timer: NodeJS.Timeout | undefined;
    const timed = options.timeout === undefined
      ? work
      : Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              void proc.kill().catch(() => {});
              reject(new Error(`command timed out after ${options.timeout}ms: ${command}`));
            }, options.timeout);
            timer.unref?.();
          }),
        ]);
    try {
      const [stdout, stderr, code] = await timed;
      return { code, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } finally {
    void proc.dispose();
  }
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: 'manual' },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: object | null;
}>;

export async function downloadToFile(
  url: string,
  destPath: string,
  onPercent?: (percent: number) => void,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  options: { idleTimeoutMs?: number; sha256?: string; maxBytes?: number } = {},
): Promise<number> {
  if (options.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(options.sha256)) {
    throw new Error('A verified download requires a valid SHA-256 digest');
  }
  if (options.sha256 !== undefined && new URL(url).protocol !== 'https:') {
    throw new Error('A verified download requires HTTPS');
  }
  const hash = options.sha256 === undefined ? undefined : createHash('sha256');
  const idleTimeoutMs = options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
  const headerController = new AbortController();
  const headerTimer = setTimeout(() => {
    headerController.abort();
  }, idleTimeoutMs);
  headerTimer.unref?.();
  let resp;
  try {
    resp = await fetchImpl(url, {
      signal: headerController.signal,
      redirect: hash === undefined ? undefined : 'manual',
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new Error(`Failed to download ${url}: no response within ${idleTimeoutMs}ms`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(headerTimer);
  }
  if (!resp.ok || resp.body === null) {
    throw new Error(`Failed to download ${url}: HTTP ${resp.status}`);
  }
  const total = Number(resp.headers.get('content-length') ?? 0);
  if (options.maxBytes !== undefined && Number.isFinite(total) && total > options.maxBytes) {
    throw new Error(`Download exceeds ${options.maxBytes} bytes`);
  }
  await mkdir(path.dirname(destPath), { recursive: true });
  let received = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      armIdleWatchdog();
      received += chunk.length;
      if (options.maxBytes !== undefined && received > options.maxBytes) {
        callback(new Error(`Download exceeds ${options.maxBytes} bytes`));
        return;
      }
      hash?.update(chunk);
      if (total > 0 && onPercent !== undefined) {
        onPercent(Math.min(99, Math.floor((received / total) * 100)));
      }
      callback(null, chunk);
    },
  });
  function armIdleWatchdog(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      meter.destroy(new Error(`Download stalled for ${idleTimeoutMs}ms: ${url}`));
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }
  armIdleWatchdog();
  try {
    await pipeline(
      Readable.fromWeb(resp.body as import('node:stream/web').ReadableStream),
      meter,
      createWriteStream(destPath),
    );
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
  }
  if (hash !== undefined && hash.digest('hex') !== options.sha256) {
    throw new Error('Downloaded artifact SHA-256 does not match the pinned release');
  }
  onPercent?.(100);
  return received;
}

const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
