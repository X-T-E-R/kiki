import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { MiniDb } from '@kiki/minidb';
import { getSearchWorkerRuntimeState } from '@kiki/kap-server/search-worker-runtime';

import {
  getEmbeddedNativeAssetManifest,
  getNativeCacheBase,
  getNativePackageRoot,
} from './native-assets';

const smokePackages = ['@mariozechner/clipboard', '@napi-rs/keyring', '@kiki/pi-tui', 'node-pty'];

export async function smokeNativePty(): Promise<void> {
  const pty = await import('node-pty');
  const windows = process.platform === 'win32';
  const shell = windows
    ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : '/bin/sh';
  const token = `pty-${process.pid}-${Date.now()}`;
  for (const killed of [false, true]) {
    const script = windows
      ? `[Console]::WriteLine('PTY_READY'); $line = [Console]::ReadLine(); [Console]::WriteLine('PTY_INPUT:' + $line); [Console]::WriteLine('PTY_SIZE:' + [Console]::WindowWidth + ':' + [Console]::WindowHeight); exit 23`
      : `printf 'PTY_READY\\n'; IFS= read -r line; printf 'PTY_INPUT:%s\\n' "$line"; printf 'PTY_SIZE:'; stty size; exit 23`;
    const proc = pty.spawn(shell, windows ? ['-NoLogo', '-NoProfile', '-Command', script] : ['-c', script], {
      name: 'xterm-256color', cwd: process.cwd(), cols: 80, rows: 24, env: process.env,
    });
    let output = '';
    let exited = false;
    let changed: (() => void) | undefined;
    const data = proc.onData((chunk) => { output += chunk; changed?.(); });
    let exitTimer: ReturnType<typeof setTimeout>;
    const exit = new Promise<number>((resolve, reject) => {
      exitTimer = setTimeout(() => reject(new Error(`PTY exit timed out: ${output}`)), 15_000);
      proc.onExit((event) => { exited = true; clearTimeout(exitTimer); resolve(event.exitCode); changed?.(); });
    });
    // Attach rejection handling before waiting for the first output event.
    void exit.catch(() => {});
    const waitFor = (expected: string): Promise<void> => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        changed = undefined;
        reject(new Error(`PTY output did not include ${expected}: ${output}`));
      }, 10_000);
      changed = () => {
        const plain = output.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '');
        if (plain.includes(expected)) {
          clearTimeout(timeout); changed = undefined; resolve();
        } else if (exited) {
          clearTimeout(timeout); changed = undefined; reject(new Error(`PTY exited before ${expected}: ${output}`));
        }
      };
      changed();
    });
    try {
      await waitFor('PTY_READY');
      proc.resize(96, 31);
      if (killed) {
        proc.kill();
        await exit;
      } else {
        proc.write(`${token}\r`);
        await waitFor(`PTY_INPUT:${token}`);
        await waitFor(windows ? 'PTY_SIZE:96:31' : 'PTY_SIZE:31 96');
        const code = await exit;
        if (code !== 23) throw new Error(`PTY exit code ${code} !== 23`);
      }
      try {
        process.kill(proc.pid, 0);
        throw new Error(`PTY child ${proc.pid} is still alive after ${killed ? 'kill' : 'exit'}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    } finally {
      if (!exited) {
        proc.kill();
        await exit.catch(() => {});
      }
      clearTimeout(exitTimer!);
      data.dispose();
    }
  }
}

function smokeKeyringNativeLoad(): void {
  const keyring = createRequire(import.meta.url)('@napi-rs/keyring') as { AsyncEntry?: unknown };
  if (typeof keyring.AsyncEntry !== 'function') {
    throw new TypeError('Native keyring binding does not export AsyncEntry');
  }
}

function smokePiTuiNativeLoad(): void {
  const platform = process.platform;
  const arch = process.arch;
  let rel: string | undefined;
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    rel = join('native', 'darwin', 'prebuilds', `darwin-${arch}`, 'darwin-modifiers.node');
  } else if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    rel = join('native', 'win32', 'prebuilds', `win32-${arch}`, 'win32-console-mode.node');
  }
  if (rel === undefined) return;

  const req = createRequire(import.meta.url);
  const helper = req(join(dirname(process.execPath), rel)) as {
    isModifierPressed?: unknown;
    enableVirtualTerminalInput?: unknown;
  };
  if (
    typeof helper.isModifierPressed !== 'function' &&
    typeof helper.enableVirtualTerminalInput !== 'function'
  ) {
    throw new TypeError(`pi-tui native helper exports are unexpected: ${rel}`);
  }
}

async function smokeMinidbWorker(): Promise<void> {
  const cacheBase = getNativeCacheBase();
  mkdirSync(cacheBase, { recursive: true });
  const dir = mkdtempSync(join(cacheBase, 'sea-minidb-smoke-'));
  let db: MiniDb<Record<string, unknown>> | null = null;
  try {
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    const total = 4_200;
    for (let base = 0; base < total; base += 500) {
      await db.batch(
        Array.from({ length: Math.min(500, total - base) }, (_, offset) => {
          const id = base + offset;
          return {
            op: 'set' as const,
            key: `doc-${id}`,
            value: { text: `sea worker searchable document ${id}` },
          };
        }),
      );
    }
    await db.createTextIndex('smoke', { fields: ['text'] });
    if (db.stats.textWorkerBuilds < 1) {
      throw new Error(`MiniDb worker did not run: ${JSON.stringify(db.stats)}`);
    }
    if (db.stats.textWorkerFallbacks !== 0) {
      throw new Error(
        `MiniDb worker unexpectedly fell back: ${db.stats.lastTextWorkerFallback ?? 'unknown'}`,
      );
    }
    if (!db.search('smoke', 'searchable').some((hit) => hit.key === 'doc-0')) {
      throw new Error('MiniDb worker-built text index returned an incorrect search result');
    }
  } finally {
    await db?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

async function smokeSearchWorker(): Promise<void> {
  // The SEA-extracted global-search worker entry must boot from disk and
  // complete the versioned ready handshake.
  const runtime = getSearchWorkerRuntimeState();
  if (!runtime.configured) {
    throw new Error('search worker runtime was not configured');
  }
  const cacheBase = getNativeCacheBase();
  mkdirSync(cacheBase, { recursive: true });
  const dir = mkdtempSync(join(cacheBase, 'sea-search-worker-'));
  const worker = new Worker(runtime.path, {
    workerData: { dir, bootSalt: 'sea-smoke' },
  });
  try {
    const ready = once(worker, 'message', {
      signal: AbortSignal.timeout(15_000),
    }) as Promise<unknown[]>;
    const [event] = await ready;
    const v = (event as { type?: string; v?: number }).v;
    if ((event as { type?: string }).type !== 'ready' || typeof v !== 'number') {
      throw new Error(`search worker handshake is unexpected: ${JSON.stringify(event)}`);
    }
  } finally {
    await worker.terminate().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function smokeAuthNative(): Promise<void> {
  const auth = createRequire(import.meta.url)('@kiki/auth-native') as typeof import('@kiki/auth-native');
  const cacheBase = getNativeCacheBase();
  mkdirSync(cacheBase, { recursive: true });
  const dir = mkdtempSync(join(cacheBase, 'auth-native-smoke-'));
  try {
    const plaintext = Buffer.from('SYNTHETIC_AUTH_SMOKE');
    const ciphertext = await auth.ageEncrypt(plaintext, 'synthetic-smoke-passphrase');
    const decrypted = await auth.ageDecrypt(ciphertext, 'synthetic-smoke-passphrase');
    if (!Buffer.from(decrypted).equals(plaintext)) throw new Error('auth-native age roundtrip mismatch');
    const canonical = await auth.canonicalizeOriginalHome(dir);
    if (canonical.length === 0 || (process.platform === 'win32' && !canonical.startsWith('\\\\?\\'))) {
      throw new Error('auth-native original home canonicalization mismatch');
    }
    const authPath = join(dir, 'auth.json');
    const guard = await auth.acquireGrokAuthLock(authPath, { timeoutMs: 1000 });
    try {
      if (!guard.isCurrent()) throw new Error('auth-native held lock identity mismatch');
      if (auth.tryAcquireGrokAuthLock(authPath) !== null) throw new Error('auth-native same-process mutual exclusion failed');
      let timedOut = false;
      try { await auth.acquireGrokAuthLock(authPath, { timeoutMs: 30 }); }
      catch (error) { timedOut = (error as { code?: string }).code === 'AUTH_LOCK_TIMEOUT'; }
      if (!timedOut) throw new Error('auth-native timeout did not preserve holder');
      const controller = new AbortController();
      const waiting = auth.acquireGrokAuthLock(authPath, { signal: controller.signal });
      controller.abort();
      let cancelled = false;
      try { await waiting; }
      catch (error) { cancelled = (error as { name?: string }).name === 'AbortError'; }
      if (!cancelled) throw new Error('auth-native acquisition did not cancel');
    } finally { guard.release(); }
    guard.release();
    if (guard.isCurrent()) throw new Error('auth-native released lock still reports current');
    const next = await auth.acquireGrokAuthLock(authPath, { timeoutMs: 0 });
    next.release();
    process.stdout.write('Auth native smoke passed: age encrypt/decrypt; canonical home; lock exclusion/timeout/cancel/release\n');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

async function runSmoke(): Promise<void> {
  const manifest = getEmbeddedNativeAssetManifest();
  if (manifest === null) throw new Error('Native asset manifest is not available.');
  for (const packageName of smokePackages) {
    if (getNativePackageRoot(packageName, { manifest }) === null) {
      throw new Error(`Native package is not available: ${packageName}`);
    }
  }
  smokePiTuiNativeLoad();
  smokeKeyringNativeLoad();
  await smokeMinidbWorker();
  await smokeSearchWorker();
  await smokeNativePty();
  await smokeAuthNative();
  process.stdout.write(
    `Native asset smoke passed: ${manifest.target}; MiniDb worker build passed; search worker ready; PTY input/resize/exit/kill passed\n`,
  );
}

export function runNativeAssetSmokeIfRequested(): boolean {
  const authOnly = process.env['KIKI_AUTH_NATIVE_SMOKE'] === '1';
  if (!authOnly && process.env['KIKI_NATIVE_ASSET_SMOKE'] !== '1') return false;
  void (authOnly ? smokeAuthNative() : runSmoke()).then(
    () => { process.exitCode = 0; },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Native asset smoke failed: ${message}\n`);
      process.exit(1);
    },
  );
  return true;
}
