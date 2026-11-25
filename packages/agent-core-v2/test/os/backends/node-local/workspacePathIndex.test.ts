import { EventEmitter } from 'node:events';
import type { FSWatcher, WatchListener } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import type { CpuRequestOptions } from '#/app/cpuWorker/host';
import { isUncRoot, WorkspacePathIndex } from '#/os/backends/node-local/workspacePathIndex';
import {
  isAlwaysIgnoredPathSegment,
  workspacePathEntry,
  workspacePathInventory,
  type WorkspacePathEntry,
} from '#/os/backends/node-local/workspacePathInventory';

interface FakeWatcherController {
  readonly watch: typeof import('node:fs').watch;
  emit(eventType: 'rename' | 'change', filename: string | null): void;
  emitError(error: Error): void;
}

function createFakeWatcher(): FakeWatcherController {
  const emitter = new EventEmitter();
  let listener: WatchListener<string> | undefined;
  const fakeWatcher = Object.assign(emitter, {
    close(): void {},
    ref() { return fakeWatcher; },
    unref() { return fakeWatcher; },
  }) as unknown as FSWatcher;
  const watch = ((_path: unknown, _options: unknown, cb?: WatchListener<string>) => {
    listener = cb;
    return fakeWatcher;
  }) as unknown as typeof import('node:fs').watch;
  return {
    watch,
    emit(eventType, filename) {
      listener?.(eventType, filename as unknown as string);
    },
    emitError(error) {
      emitter.emit('error', error);
    },
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-path-index-unit-'));
  tempDirs.push(dir);
  return dir;
}

describe('WorkspacePathIndex demand start and coalesced mutations', () => {
  it('stays cold with zero CPU inventory or stat work until an index consumer queries it', async () => {
    const root = await makeTempDir();
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    const calls: string[] = [];
    let releaseInventory!: () => void;
    const inventoryGate = new Promise<void>((resolveGate) => { releaseInventory = resolveGate; });
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown, _options?: CpuRequestOptions) => {
        const op = operation as { readonly type: string };
        calls.push(op.type);
        if (op.type === 'workspace.paths') {
          await inventoryGate;
          return {
            overflow: false,
            entries: [{ path: 'a.ts', name: 'a.ts', kind: 'file', mtimeMs: 10, ctimeMs: 10, size: 20, ino: 1 }],
          } as T;
        }
        return undefined as T;
      },
    };

    const index = new WorkspacePathIndex(root, cpu);
    try {
      expect(index.isStarted).toBe(false);
      await index.mutation(join(root, 'a.ts'));
      index.invalidate();
      expect(index.isStarted).toBe(false);
      expect(calls).toEqual([]);

      expect(await index.glob(root, '*.ts')).toBeUndefined();
      expect(index.isStarted).toBe(true);
      expect(calls).toEqual(['workspace.paths']);

      releaseInventory();
      await index.refresh();
      expect(await index.glob(root, '*.ts')).toEqual([join(root, 'a.ts')]);
    } finally {
      releaseInventory();
      await index.dispose();
    }
  });

  it('coalesces a 100-file mutation burst into a single published array generation and batched trigram update', async () => {
    const dir = await makeTempDir();
    const root = join(dir, 'repo');
    await mkdir(root, { recursive: true });

    const initialEntries: WorkspacePathEntry[] = Array.from({ length: 2_000 }, (_, i) => ({
      path: i < 50 ? `nested/sub/file-${i}.ts` : `src/file-${i}.ts`,
      name: `file-${i}.ts`,
      kind: 'file',
      mtimeMs: 100 + i,
      ctimeMs: 100 + i,
      size: 64,
      ino: i + 1,
    }));

    const trigramUpdateBatches: number[] = [];
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as { readonly type: string; readonly path?: string; readonly entries?: readonly unknown[]; readonly removed?: readonly string[] };
        if (op.type === 'workspace.paths') {
          return { overflow: false, entries: initialEntries } as T;
        }
        if (op.type === 'workspace.trigram.begin' || op.type === 'workspace.trigram.finish') {
          return true as T;
        }
        if (op.type === 'workspace.trigram.update') {
          if (op.removed !== undefined) {
            trigramUpdateBatches.push((op.entries?.length ?? 0) + op.removed.length);
          }
          return true as T;
        }
        if (op.type === 'workspace.path') {
          const target = op.path?.replaceAll('\\', '/') ?? '';
          if (target.endsWith('/transient.tmp') || target.endsWith('/nested')) {
            return undefined as T;
          }
          const rel = target.slice(root.replaceAll('\\', '/').length + 1);
          const name = rel.split('/').at(-1)!;
          return {
            path: rel,
            name,
            kind: 'file',
            mtimeMs: 9_999,
            ctimeMs: 9_999,
            size: 128,
            ino: 99_999,
          } as T;
        }
        return undefined as T;
      },
    };

    const index = new WorkspacePathIndex(root, cpu, join(dir, 'cache'));
    try {
      await index.refresh();
      await index.trigram!.whenReady();
      const baseSnapshot = index.snapshot();
      expect(baseSnapshot?.revision).toBe(1);
      expect(baseSnapshot?.entries).toHaveLength(2_000);

      await Promise.all([
        ...Array.from({ length: 98 }, (_, i) => index.mutation(join(root, 'src', `burst-${i}.ts`))),
        index.mutation(join(root, 'src', 'transient.tmp')),
        index.mutation(join(root, 'nested')),
      ]);
      await index.whenSettled();

      const afterBurst = index.snapshot();
      expect(afterBurst?.revision).toBe(2);
      expect(afterBurst?.entries).toHaveLength(2_000 - 50 + 98);
      expect(afterBurst?.entries.some((entry) => entry.path.startsWith('nested/'))).toBe(false);
      expect(afterBurst?.entries.some((entry) => entry.path === 'src/burst-97.ts')).toBe(true);

      await index.trigram!.whenReady();
      expect(trigramUpdateBatches).toEqual([98 + 1 + 50]);

      await index.mutation(join(root, '.gitignore'));
      expect(index.snapshot()).toBeUndefined();
    } finally {
      await index.dispose();
    }
  });

  it('diffs incremental reconciles against byPath so unchanged files are not re-trigrammed', async () => {
    const dir = await makeTempDir();
    const root = join(dir, 'repo');
    await mkdir(root, { recursive: true });

    let entries: WorkspacePathEntry[] = Array.from({ length: 1_550 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      name: `file-${i}.ts`,
      kind: 'file',
      mtimeMs: 100 + i,
      ctimeMs: 100 + i,
      size: 64,
      ino: i + 1,
    }));

    let beginCount = 0;
    let finishCount = 0;
    const incrementalUpdates: Array<{ readonly entries: readonly string[]; readonly removed: readonly string[] }> = [];
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as {
          readonly type: string;
          readonly entries?: readonly WorkspacePathEntry[];
          readonly removed?: readonly string[];
        };
        if (op.type === 'workspace.paths') return { overflow: false, entries } as T;
        if (op.type === 'workspace.trigram.begin') { beginCount += 1; return true as T; }
        if (op.type === 'workspace.trigram.finish') { finishCount += 1; return true as T; }
        if (op.type === 'workspace.trigram.update') {
          if (op.removed !== undefined) {
            incrementalUpdates.push({
              entries: (op.entries ?? []).map((entry) => entry.path),
              removed: op.removed,
            });
          }
          return true as T;
        }
        return undefined as T;
      },
    };

    const index = new WorkspacePathIndex(root, cpu, join(dir, 'cache'), { reconcileDebounceMs: 10 });
    try {
      await index.refresh();
      await index.trigram!.whenReady();
      expect(beginCount).toBe(1);
      expect(finishCount).toBe(1);
      expect(incrementalUpdates).toEqual([]);

      await index.refresh();
      await index.trigram!.whenReady();
      expect(beginCount).toBe(1);
      expect(finishCount).toBe(1);
      expect(incrementalUpdates).toEqual([]);

      entries = [
        ...entries.slice(1, 1_550).map((entry, idx) => idx === 0
          ? { ...entry, mtimeMs: entry.mtimeMs + 50, size: 128 }
          : entry),
        { path: 'src/added.ts', name: 'added.ts', kind: 'file', mtimeMs: 9_999, ctimeMs: 9_999, size: 32, ino: 99_999 },
      ];

      await index.mutation(join(root, '.gitignore'));
      expect(index.snapshot()).toBeUndefined();
      await index.refresh();
      await index.trigram!.whenReady();

      expect(beginCount).toBe(1);
      expect(finishCount).toBe(1);
      expect(incrementalUpdates).toEqual([
        {
          entries: ['src/file-1.ts', 'src/added.ts'],
          removed: ['src/file-0.ts'],
        },
      ]);
    } finally {
      await index.dispose();
    }
  });

  it('skips recursive fs.watch, inventory walks and trigram indexing for UNC and network roots', async () => {
    const dir = await makeTempDir();
    const calls: string[] = [];
    let watchCalls = 0;
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        calls.push((operation as { readonly type: string }).type);
        return undefined as T;
      },
    };
    const fakeWatch = (() => {
      watchCalls += 1;
      throw new Error('watch must not be invoked on UNC roots');
    }) as unknown as typeof import('node:fs').watch;

    for (const uncRoot of ['\\\\nas.hp\\media\\videos', '//nas.hp/media/videos', '\\\\?\\UNC\\nas.hp\\media']) {
      expect(isUncRoot(uncRoot)).toBe(true);
      const index = new WorkspacePathIndex(uncRoot, cpu, join(dir, 'cache'), { watch: fakeWatch });
      try {
        expect(index.isNetworkRoot).toBe(true);
        expect(index.trigram).toBeUndefined();
        expect(index.snapshot()).toBeUndefined();
        expect(await index.glob(uncRoot, '**/*.mp4')).toBeUndefined();
        expect(index.fuzzy('video', false)).toBeUndefined();
        await index.refresh();
        index.invalidate();
        index.notifyExternalChange();
        expect(index.isStarted).toBe(false);
        expect(index.isWatching).toBe(false);
      } finally {
        await index.dispose();
      }
    }
    expect(watchCalls).toBe(0);
    expect(calls).toEqual([]);
  });

  it('skips full rebuilds on external changes with a healthy watcher and coalesces N changes without a watcher', async () => {
    const dir = await makeTempDir();
    const root = join(dir, 'repo');
    await mkdir(root, { recursive: true });

    let inventoryCalls = 0;
    let trigramBeginCalls = 0;
    const sampleEntries: WorkspacePathEntry[] = Array.from({ length: 1_550 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      name: `file-${i}.ts`,
      kind: 'file',
      mtimeMs: 100 + i,
      ctimeMs: 100 + i,
      size: 64,
      ino: i + 1,
    }));
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as { readonly type: string };
        if (op.type === 'workspace.paths') {
          inventoryCalls += 1;
          return { overflow: false, entries: sampleEntries } as T;
        }
        if (op.type === 'workspace.trigram.begin') {
          trigramBeginCalls += 1;
          return true as T;
        }
        if (op.type === 'workspace.trigram.update' || op.type === 'workspace.trigram.finish') {
          return true as T;
        }
        return undefined as T;
      },
    };

    const watchedIndex = new WorkspacePathIndex(root, cpu, join(dir, 'cache-watched'), { reconcileDebounceMs: 25 });
    try {
      await watchedIndex.refresh();
      await watchedIndex.trigram!.whenReady();
      expect(watchedIndex.isWatching).toBe(true);
      expect(inventoryCalls).toBe(1);
      expect(trigramBeginCalls).toBe(1);

      for (let i = 0; i < 6; i += 1) watchedIndex.notifyExternalChange();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));

      expect(watchedIndex.snapshot()?.entries).toHaveLength(1_550);
      expect(inventoryCalls).toBe(1);
      expect(trigramBeginCalls).toBe(1);
    } finally {
      await watchedIndex.dispose();
    }

    inventoryCalls = 0;
    trigramBeginCalls = 0;
    const unwatchedIndex = new WorkspacePathIndex(root, cpu, join(dir, 'cache-unwatched'), {
      watch: (() => { throw new Error('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'); }) as unknown as typeof import('node:fs').watch,
      reconcileDebounceMs: 30,
    });
    try {
      await unwatchedIndex.refresh();
      await unwatchedIndex.trigram!.whenReady();
      expect(unwatchedIndex.isWatching).toBe(false);
      expect(inventoryCalls).toBe(1);
      expect(trigramBeginCalls).toBe(1);

      for (let i = 0; i < 6; i += 1) unwatchedIndex.notifyExternalChange();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      await unwatchedIndex.trigram!.whenReady();

      expect(inventoryCalls).toBe(2);
      expect(trigramBeginCalls).toBe(1);
    } finally {
      await unwatchedIndex.dispose();
    }
  });

  it('replays watcher-delivered add, modify, and delete events that arrive during an in-flight scan onto the scan snapshot and trigram index', async () => {
    const dir = await makeTempDir();
    const root = join(dir, 'repo');
    await mkdir(root, { recursive: true });

    const staleEntries: WorkspacePathEntry[] = Array.from({ length: 1_550 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      name: `file-${i}.ts`,
      kind: 'file',
      mtimeMs: 100 + i,
      ctimeMs: 100 + i,
      size: 64,
      ino: i + 1,
    }));

    const lateEntry: WorkspacePathEntry = {
      path: 'src/late.txt',
      name: 'late.txt',
      kind: 'file',
      mtimeMs: 9_001,
      ctimeMs: 9_001,
      size: 16,
      ino: 90_001,
    };
    const modifiedEntry: WorkspacePathEntry = {
      path: 'src/file-1.ts',
      name: 'file-1.ts',
      kind: 'file',
      mtimeMs: 9_002,
      ctimeMs: 9_002,
      size: 128,
      ino: 2,
    };

    let inventoryCalls = 0;
    let trigramBeginCalls = 0;
    const indexedPaths = new Set<string>();
    let scanEnteredResolve!: () => void;
    const scanEntered = new Promise<void>((resolveEntered) => { scanEnteredResolve = resolveEntered; });
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolveGate) => { releaseScan = resolveGate; });

    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as {
          readonly type: string;
          readonly path?: string;
          readonly entries?: readonly WorkspacePathEntry[];
          readonly removed?: readonly string[];
          readonly literal?: string;
        };
        if (op.type === 'workspace.paths') {
          inventoryCalls += 1;
          if (inventoryCalls === 2) {
            scanEnteredResolve();
            await scanGate;
          }
          return { overflow: false, entries: staleEntries } as T;
        }
        if (op.type === 'workspace.path') {
          const target = op.path?.replaceAll('\\', '/') ?? '';
          if (target.endsWith('/src/late.txt')) return lateEntry as T;
          if (target.endsWith('/src/file-1.ts')) return modifiedEntry as T;
          if (target.endsWith('/src/file-0.ts')) return undefined as T;
          return undefined as T;
        }
        if (op.type === 'workspace.trigram.begin') {
          trigramBeginCalls += 1;
          indexedPaths.clear();
          return true as T;
        }
        if (op.type === 'workspace.trigram.update') {
          for (const entry of op.entries ?? []) indexedPaths.add(entry.path);
          for (const removed of op.removed ?? []) indexedPaths.delete(removed);
          return true as T;
        }
        if (op.type === 'workspace.trigram.finish') return true as T;
        if (op.type === 'workspace.trigram.query') {
          if (op.literal === 'lateNeedle') {
            return (indexedPaths.has('src/late.txt') ? ['src/late.txt'] : []) as T;
          }
          if (op.literal === 'removedNeedle') {
            return (indexedPaths.has('src/file-0.ts') ? ['src/file-0.ts'] : []) as T;
          }
          return [] as T;
        }
        return undefined as T;
      },
    };

    const fakeWatcher = createFakeWatcher();
    const index = new WorkspacePathIndex(root, cpu, join(dir, 'cache'), { watch: fakeWatcher.watch });
    try {
      await index.refresh();
      await index.trigram!.whenReady();
      expect(trigramBeginCalls).toBe(1);

      const scanPromise = index.refresh();
      await scanEntered;

      fakeWatcher.emit('rename', join('src', 'late.txt'));
      fakeWatcher.emit('change', join('src', 'file-1.ts'));
      fakeWatcher.emit('rename', join('src', 'file-0.ts'));
      await index.whenSettled();

      const midScanSnapshot = index.snapshot();
      expect(midScanSnapshot?.entries.some((entry) => entry.path === 'src/late.txt')).toBe(true);
      await index.trigram!.whenReady();

      releaseScan();
      await scanPromise;
      await index.trigram!.whenReady();

      expect(trigramBeginCalls).toBe(1);
      expect(await index.glob(root, 'src/late.txt')).toEqual([join(root, 'src', 'late.txt')]);
      expect(await index.glob(root, 'src/file-0.ts')).toEqual([]);
      expect(index.mtime(join(root, 'src', 'file-1.ts'))).toBe(9_002);

      const finalSnapshot = index.snapshot();
      expect(finalSnapshot).toBeDefined();
      expect(await index.trigram!.candidates(finalSnapshot!, 'lateNeedle', true, false)).toContain('src/late.txt');
      expect(await index.trigram!.candidates(finalSnapshot!, 'removedNeedle', true, false)).toEqual([]);
    } finally {
      releaseScan();
      await index.dispose();
    }
  });

  it('discards a stale scan and falls back to the filesystem when retained scan mutations overflow or the watcher errors mid-scan', async () => {
    const dir = await makeTempDir();
    const root = join(dir, 'repo');
    await mkdir(root, { recursive: true });

    const baseEntries: WorkspacePathEntry[] = [
      { path: 'src/base.ts', name: 'base.ts', kind: 'file', mtimeMs: 10, ctimeMs: 10, size: 10, ino: 1 },
    ];
    const freshEntries: WorkspacePathEntry[] = [
      ...baseEntries,
      { path: 'src/m1.ts', name: 'm1.ts', kind: 'file', mtimeMs: 20, ctimeMs: 20, size: 10, ino: 2 },
      { path: 'src/m2.ts', name: 'm2.ts', kind: 'file', mtimeMs: 21, ctimeMs: 21, size: 10, ino: 3 },
      { path: 'src/m3.ts', name: 'm3.ts', kind: 'file', mtimeMs: 22, ctimeMs: 22, size: 10, ino: 4 },
    ];

    let inventoryCalls = 0;
    let scan2EnteredResolve!: () => void;
    const scan2Entered = new Promise<void>((resolveEntered) => { scan2EnteredResolve = resolveEntered; });
    let releaseScan2!: () => void;
    const scan2Gate = new Promise<void>((resolveGate) => { releaseScan2 = resolveGate; });
    let scan3DoneResolve!: () => void;
    const scan3Done = new Promise<void>((resolveDone) => { scan3DoneResolve = resolveDone; });

    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as { readonly type: string; readonly path?: string };
        if (op.type === 'workspace.paths') {
          inventoryCalls += 1;
          if (inventoryCalls === 1) return { overflow: false, entries: baseEntries } as T;
          if (inventoryCalls === 2) {
            scan2EnteredResolve();
            await scan2Gate;
            return { overflow: false, entries: baseEntries } as T;
          }
          queueMicrotask(() => { scan3DoneResolve(); });
          return { overflow: false, entries: freshEntries } as T;
        }
        if (op.type === 'workspace.path') {
          const name = op.path?.replaceAll('\\', '/').split('/').at(-1) ?? 'x.ts';
          return { path: `src/${name}`, name, kind: 'file', mtimeMs: 20, ctimeMs: 20, size: 10, ino: 99 } as T;
        }
        return undefined as T;
      },
    };

    const fakeWatcher = createFakeWatcher();
    const index = new WorkspacePathIndex(root, cpu, undefined, {
      watch: fakeWatcher.watch,
      reconcileDebounceMs: 20,
      maxScanRetainedMutations: 2,
    });
    try {
      await index.refresh();
      expect(index.snapshot()?.entries).toHaveLength(1);

      const staleScan = index.refresh();
      await scan2Entered;

      fakeWatcher.emit('rename', join('src', 'm1.ts'));
      fakeWatcher.emit('rename', join('src', 'm2.ts'));
      fakeWatcher.emit('rename', join('src', 'm3.ts'));
      await index.whenSettled();

      releaseScan2();
      await staleScan;

      expect(index.error).toBeUndefined();
      expect(index.snapshot()).toBeUndefined();
      expect(await index.glob(root, 'src/*.ts')).toBeUndefined();

      await scan3Done;
      await index.refresh();
      expect(inventoryCalls).toBeGreaterThanOrEqual(3);
      expect(index.snapshot()?.entries.map((entry) => entry.path)).toEqual([
        'src/base.ts',
        'src/m1.ts',
        'src/m2.ts',
        'src/m3.ts',
      ]);
    } finally {
      releaseScan2();
      await index.dispose();
    }

    let errScanEnteredResolve!: () => void;
    const errScanEntered = new Promise<void>((resolveEntered) => { errScanEnteredResolve = resolveEntered; });
    let releaseErrScan!: () => void;
    const errScanGate = new Promise<void>((resolveGate) => { releaseErrScan = resolveGate; });
    let errInventoryCalls = 0;
    const errCpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as { readonly type: string };
        if (op.type === 'workspace.paths') {
          errInventoryCalls += 1;
          if (errInventoryCalls === 2) {
            errScanEnteredResolve();
            await errScanGate;
          }
          return { overflow: false, entries: baseEntries } as T;
        }
        return undefined as T;
      },
    };
    const errWatcher = createFakeWatcher();
    const errIndex = new WorkspacePathIndex(root, errCpu, undefined, {
      watch: errWatcher.watch,
      reconcileDebounceMs: 60_000,
    });
    try {
      await errIndex.refresh();
      const inFlight = errIndex.refresh();
      await errScanEntered;
      errWatcher.emitError(new Error('watch buffer overflow'));
      releaseErrScan();
      await inFlight;
      expect(errIndex.isWatching).toBe(false);
      expect(errIndex.snapshot()).toBeUndefined();
      expect(await errIndex.glob(root, 'src/*.ts')).toBeUndefined();
    } finally {
      releaseErrScan();
      await errIndex.dispose();
    }
  });

  it('does not restart a trigram rebuild from a discarded snapshot after inventory overflow resets the trigram index', async () => {
    const dir = await makeTempDir();
    const root = join(dir, 'repo');
    await mkdir(root, { recursive: true });

    const entries: WorkspacePathEntry[] = Array.from({ length: 1_550 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      name: `file-${i}.ts`,
      kind: 'file',
      mtimeMs: 100 + i,
      ctimeMs: 100 + i,
      size: 64,
      ino: i + 1,
    }));

    let overflow = false;
    let beginCount = 0;
    let finishCount = 0;
    let updateEnteredResolve!: () => void;
    const updateEntered = new Promise<void>((resolveEntered) => { updateEnteredResolve = resolveEntered; });
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolveGate) => { releaseUpdate = resolveGate; });
    let pausedUpdate = false;

    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as { readonly type: string };
        if (op.type === 'workspace.paths') {
          return (overflow ? { overflow: true, entries: [] } : { overflow: false, entries }) as T;
        }
        if (op.type === 'workspace.trigram.begin') {
          beginCount += 1;
          return true as T;
        }
        if (op.type === 'workspace.trigram.update') {
          if (!pausedUpdate) {
            pausedUpdate = true;
            updateEnteredResolve();
            await updateGate;
          }
          return true as T;
        }
        if (op.type === 'workspace.trigram.finish') {
          finishCount += 1;
          return true as T;
        }
        return undefined as T;
      },
    };

    const index = new WorkspacePathIndex(root, cpu, join(dir, 'cache'));
    try {
      await index.refresh();
      const firstSnapshot = index.snapshot();
      expect(firstSnapshot).toBeDefined();
      await updateEntered;
      expect(beginCount).toBe(1);

      overflow = true;
      await index.refresh();
      expect(index.isOverflowed).toBe(true);
      expect(index.snapshot()).toBeUndefined();

      releaseUpdate();
      await index.trigram!.whenReady();

      expect(beginCount).toBe(1);
      expect(finishCount).toBe(0);
      expect(await index.trigram!.candidates(firstSnapshot!, 'needle', true, false)).toBeUndefined();
    } finally {
      releaseUpdate();
      await index.dispose();
    }
  });

  it('coalesces burst trigram updates behind a 200ms timer and flushes cleanly before candidates queries', async () => {
    const dir = await makeTempDir();
    const root = join(dir, 'repo');
    await mkdir(root, { recursive: true });

    const baseEntries: WorkspacePathEntry[] = Array.from({ length: 1_550 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      name: `file-${i}.ts`,
      kind: 'file',
      mtimeMs: 100 + i,
      ctimeMs: 100 + i,
      size: 64,
      ino: i + 1,
    }));
    const calls: Array<{ type: string; entries?: number; removed?: number }> = [];
    let releaseBlockedUpdate: (() => void) | undefined;
    let blockNextUpdate = false;
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as {
          readonly type: string;
          readonly entries?: readonly WorkspacePathEntry[];
          readonly removed?: readonly string[];
        };
        if (op.type === 'workspace.paths') return { overflow: false, entries: baseEntries } as T;
        if (op.type === 'workspace.trigram.begin' || op.type === 'workspace.trigram.finish') return true as T;
        if (op.type === 'workspace.trigram.update') {
          calls.push({ type: op.type, entries: op.entries?.length ?? 0, removed: op.removed?.length ?? 0 });
          if (blockNextUpdate) {
            blockNextUpdate = false;
            await new Promise<void>((resolve) => { releaseBlockedUpdate = resolve; });
          }
          return true as T;
        }
        if (op.type === 'workspace.trigram.query') {
          calls.push({ type: op.type });
          return ['src/file-0.ts'] as T;
        }
        return undefined as T;
      },
    };

    const index = new WorkspacePathIndex(root, cpu, join(dir, 'cache'));
    try {
      await index.refresh();
      await index.trigram!.whenReady();
      calls.length = 0;

      const snap = index.snapshot()!;
      const nextSnap = { ...snap, revision: snap.revision + 1 };
      for (let i = 0; i < 5; i += 1) {
        index.trigram!.patch(nextSnap, `src/file-${i}.ts`, { ...baseEntries[i]!, mtimeMs: 999 + i });
      }
      expect(calls).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(calls).toEqual([{ type: 'workspace.trigram.update', entries: 5, removed: 0 }]);

      calls.length = 0;
      const snap2 = { ...nextSnap, revision: nextSnap.revision + 1 };
      index.trigram!.patch(snap2, 'src/file-1.ts', { ...baseEntries[1]!, mtimeMs: 2000 });
      expect(calls).toEqual([]);
      const hit = await index.trigram!.candidates(snap2, 'needle', true, false);
      expect(hit).toEqual(['src/file-0.ts']);
      expect(calls).toEqual([
        { type: 'workspace.trigram.update', entries: 1, removed: 0 },
        { type: 'workspace.trigram.query' },
      ]);

      calls.length = 0;
      const snap3 = { ...snap2, revision: snap2.revision + 1 };
      blockNextUpdate = true;
      index.trigram!.patch(snap3, 'src/file-2.ts', { ...baseEntries[2]!, mtimeMs: 3000 });
      const supersededQuery = index.trigram!.candidates(snap3, 'needle', true, false);
      const snap4 = { ...snap3, revision: snap3.revision + 1 };
      index.trigram!.patch(snap4, 'src/file-3.ts', { ...baseEntries[3]!, mtimeMs: 4000 });
      expect(await supersededQuery).toBeUndefined();
      releaseBlockedUpdate?.();
      await index.trigram!.whenReady();

      calls.length = 0;
      const snap5 = { ...snap4, revision: snap4.revision + 1 };
      index.trigram!.patch(snap5, 'src/file-4.ts', { ...baseEntries[4]!, mtimeMs: 5000 });
      index.trigram!.reset();
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(calls).toEqual([]);
    } finally {
      await index.dispose();
    }
  });

  it('skips fs.watch cleanly without error when the workspace root does not exist', async () => {
    const dir = await makeTempDir();
    const missingRoot = join(dir, 'deleted-worktree');
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>() => ({ overflow: false, entries: [] }) as T,
    };
    const index = new WorkspacePathIndex(missingRoot, cpu);
    try {
      await index.refresh();
      expect(index.isStarted).toBe(true);
      expect(index.isWatching).toBe(false);
      expect(index.error).toBeUndefined();
    } finally {
      await index.dispose();
    }
  });

  it('skips Xcode/Apple build artifacts in inventory, single-path lookups, and watcher events', async () => {
    expect(isAlwaysIgnoredPathSegment('DerivedData')).toBe(true);
    expect(isAlwaysIgnoredPathSegment('.swiftpm')).toBe(true);
    expect(isAlwaysIgnoredPathSegment('xcuserdata')).toBe(true);
    expect(isAlwaysIgnoredPathSegment('TestRun.xcresult')).toBe(true);
    expect(isAlwaysIgnoredPathSegment('.DS_Store')).toBe(true);
    expect(isAlwaysIgnoredPathSegment('Sources')).toBe(false);

    const root = await makeTempDir();
    await mkdir(join(root, 'Sources'), { recursive: true });
    await mkdir(join(root, 'DerivedData', 'Build', 'Intermediates'), { recursive: true });
    await mkdir(join(root, '.swiftpm', 'xcode'), { recursive: true });
    await mkdir(join(root, 'App.xcodeproj', 'xcuserdata', 'dev.xcuserdatad'), { recursive: true });
    await mkdir(join(root, 'Artifacts', 'Build.xcresult', 'Data'), { recursive: true });
    await writeFile(join(root, 'Sources', 'App.swift'), 'struct App {}\n');
    await writeFile(join(root, 'DerivedData', 'Build', 'Intermediates', 'a.o'), 'bin');
    await writeFile(join(root, '.swiftpm', 'xcode', 'package.xcworkspace'), 'xml');
    await writeFile(join(root, 'App.xcodeproj', 'xcuserdata', 'dev.xcuserdatad', 'state.plist'), 'plist');
    await writeFile(join(root, 'Artifacts', 'Build.xcresult', 'Data', 'info.plist'), 'plist');
    await writeFile(join(root, '.DS_Store'), 'ds');

    const inv = workspacePathInventory(root, 1_000);
    expect(inv.overflow).toBe(false);
    expect(inv.entries.map((entry) => entry.path)).toEqual([
      'App.xcodeproj',
      'Artifacts',
      'Sources',
      'Sources/App.swift',
    ].filter((path) => inv.entries.some((entry) => entry.path === path)));
    expect(inv.entries.some((entry) => entry.path.includes('DerivedData') || entry.path.includes('.swiftpm') || entry.path.includes('xcuserdata') || entry.path.includes('.xcresult') || entry.path.includes('.DS_Store'))).toBe(false);
    expect(workspacePathEntry(root, join(root, 'DerivedData', 'Build', 'Intermediates', 'a.o'))).toBeUndefined();
    expect(workspacePathEntry(root, join(root, 'Artifacts', 'Build.xcresult', 'Data', 'info.plist'))).toBeUndefined();

    const pathCalls: string[] = [];
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as { readonly type: string; readonly path?: string };
        if (op.type === 'workspace.paths') return { overflow: false, entries: inv.entries } as T;
        if (op.type === 'workspace.path') {
          pathCalls.push(op.path ?? '');
          return undefined as T;
        }
        return undefined as T;
      },
    };
    const fakeWatcher = createFakeWatcher();
    const index = new WorkspacePathIndex(root, cpu, undefined, { watch: fakeWatcher.watch });
    try {
      await index.refresh();
      fakeWatcher.emit('change', join('DerivedData', 'Build', 'Intermediates', 'a.o'));
      fakeWatcher.emit('change', join('.swiftpm', 'xcode', 'package.xcworkspace'));
      fakeWatcher.emit('change', join('App.xcodeproj', 'xcuserdata', 'dev.xcuserdatad', 'state.plist'));
      fakeWatcher.emit('change', join('Artifacts', 'Build.xcresult', 'Data', 'info.plist'));
      fakeWatcher.emit('change', '.DS_Store');
      await index.whenSettled();
      expect(pathCalls).toEqual([]);
    } finally {
      await index.dispose();
    }
  });

  it('collapses large watcher build storms into a single debounced reconcile instead of flooding workspace.path', async () => {
    const root = await makeTempDir();
    let inventoryCalls = 0;
    let pathCalls = 0;
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as { readonly type: string };
        if (op.type === 'workspace.paths') {
          inventoryCalls += 1;
          return {
            overflow: false,
            entries: [{ path: 'src/index.ts', name: 'index.ts', kind: 'file', mtimeMs: 10, ctimeMs: 10, size: 12, ino: 1 }],
          } as T;
        }
        if (op.type === 'workspace.path') {
          pathCalls += 1;
          return undefined as T;
        }
        return undefined as T;
      },
    };
    const fakeWatcher = createFakeWatcher();
    const index = new WorkspacePathIndex(root, cpu, undefined, {
      watch: fakeWatcher.watch,
      reconcileDebounceMs: 25,
    });
    try {
      await index.refresh();
      expect(inventoryCalls).toBe(1);

      for (let i = 0; i < 120; i += 1) {
        fakeWatcher.emit('change', join('build', 'deps', `crate-${i}.rlib`));
      }
      await index.whenSettled();
      await new Promise((resolve) => setTimeout(resolve, 60));
      await index.whenSettled();

      expect(pathCalls).toBe(0);
      expect(inventoryCalls).toBe(2);
    } finally {
      await index.dispose();
    }
  });

  it('bounds whenSettled() under continuous file churn and falls back cleanly on stalled worker updates', async () => {
    const root = await makeTempDir();
    let releaseStalled: (() => void) | undefined;
    let stallPathRequests = false;
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as { readonly type: string; readonly path?: string };
        if (op.type === 'workspace.paths') {
          return {
            overflow: false,
            entries: [
              { path: 'src/app.ts', name: 'app.ts', kind: 'file', mtimeMs: 10, ctimeMs: 10, size: 12, ino: 1 },
              { path: 'dev.log', name: 'dev.log', kind: 'file', mtimeMs: 10, ctimeMs: 10, size: 12, ino: 2 },
            ],
          } as T;
        }
        if (op.type === 'workspace.path') {
          if (stallPathRequests) {
            await new Promise<void>((resolveWait) => {
              releaseStalled = resolveWait;
            });
          } else {
            await new Promise((resolveWait) => setTimeout(resolveWait, 2));
          }
          return { path: 'dev.log', name: 'dev.log', kind: 'file', mtimeMs: Date.now(), ctimeMs: 10, size: 16, ino: 2 } as T;
        }
        return undefined as T;
      },
    };
    const fakeWatcher = createFakeWatcher();
    const index = new WorkspacePathIndex(root, cpu, undefined, {
      watch: fakeWatcher.watch,
      settleTimeoutMs: 40,
    });
    let churnTimer: ReturnType<typeof setInterval> | undefined;
    try {
      await index.refresh();

      churnTimer = setInterval(() => {
        void index.mutation(join(root, 'dev.log'));
      }, 1);
      const churnStartedAt = performance.now();
      const matches = await index.glob(root, 'src/*.ts');
      const churnElapsedMs = performance.now() - churnStartedAt;
      clearInterval(churnTimer);
      churnTimer = undefined;

      expect(matches).toEqual([join(root, 'src', 'app.ts')]);
      expect(churnElapsedMs).toBeLessThan(250);

      stallPathRequests = true;
      const stalledMutation = index.mutation(join(root, 'dev.log'));
      const stallStartedAt = performance.now();
      const settled = await index.whenSettled(40);
      const fallbackGlob = await index.glob(root, 'src/*.ts');
      const stallElapsedMs = performance.now() - stallStartedAt;

      expect(settled).toBe(false);
      expect(fallbackGlob).toBeUndefined();
      expect(stallElapsedMs).toBeLessThan(250);

      releaseStalled?.();
      await stalledMutation;
    } finally {
      if (churnTimer !== undefined) clearInterval(churnTimer);
      releaseStalled?.();
      await index.dispose();
    }
  });

  it('ignores no-op gitignored mutations without dirtying snapshot revision or clearing fuzzy cache', async () => {
    const root = await makeTempDir();
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as { readonly type: string };
        if (op.type === 'workspace.paths') {
          return {
            overflow: false,
            entries: [{ path: 'src/keep.ts', name: 'keep.ts', kind: 'file', mtimeMs: 10, ctimeMs: 10, size: 12, ino: 1 }],
          } as T;
        }
        if (op.type === 'workspace.path') return undefined as T;
        return undefined as T;
      },
    };
    const fakeWatcher = createFakeWatcher();
    const index = new WorkspacePathIndex(root, cpu, undefined, { watch: fakeWatcher.watch });
    try {
      await index.refresh();
      const revBefore = index.snapshot()?.revision;
      const firstFuzzy = index.fuzzy('keep', false);
      expect(firstFuzzy?.map((entry) => entry.path)).toEqual(['src/keep.ts']);

      await index.mutation(join(root, 'node_modules', 'pkg', 'index.js'));
      await index.whenSettled();

      expect(index.snapshot()?.revision).toBe(revBefore);
      expect(index.fuzzy('keep', false)).toBe(firstFuzzy);
    } finally {
      await index.dispose();
    }
  });

  it('keeps fuzzy() deterministic across live updates and fast on 100k paths without sorting', async () => {
    const root = await makeTempDir();
    const syntheticEntries: WorkspacePathEntry[] = [];
    for (let i = 0; i < 100_000; i += 1) {
      const padded = String(i).padStart(6, '0');
      const name = i % 50 === 0 ? `service-${padded}.ts` : `module-${padded}.txt`;
      const path = `packages/pkg-${Math.floor(i / 5000)}/${name}`;
      syntheticEntries.push({ path, name, kind: 'file', mtimeMs: i, ctimeMs: i, size: 10, ino: i + 1 });
    }
    syntheticEntries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

    let liveState = new Map<string, WorkspacePathEntry | undefined>();
    const cpu: ICpuWorkerService = {
      _serviceBrand: undefined,
      request: async <T>(operation: unknown) => {
        const op = operation as { readonly type: string; readonly path?: string };
        if (op.type === 'workspace.paths') {
          return { overflow: false, entries: syntheticEntries } as T;
        }
        if (op.type === 'workspace.path') {
          return liveState.get(op.path ?? '') as T;
        }
        return undefined as T;
      },
    };
    const fakeWatcher = createFakeWatcher();
    const index = new WorkspacePathIndex(root, cpu, undefined, { watch: fakeWatcher.watch });
    try {
      await index.refresh();

      const t0 = performance.now();
      const matches = index.fuzzy('svc', false);
      const elapsedMs = performance.now() - t0;

      expect(matches).toBeDefined();
      expect(matches).toHaveLength(2_000);
      expect(elapsedMs).toBeLessThan(250);
      for (let i = 1; i < matches!.length; i += 1) {
        expect(matches![i - 1]!.path < matches![i]!.path).toBe(true);
      }

      const addedPath = join(root, 'packages', 'pkg-0', 'service-000001-live.ts');
      const deletedPath = join(root, 'packages', 'pkg-0', 'service-000000.ts');
      liveState.set(addedPath, {
        path: 'packages/pkg-0/service-000001-live.ts',
        name: 'service-000001-live.ts',
        kind: 'file',
        mtimeMs: 999_999,
        ctimeMs: 999_999,
        size: 20,
        ino: 999_999,
      });
      liveState.set(deletedPath, undefined);

      await index.mutation(addedPath);
      await index.mutation(deletedPath);
      await index.whenSettled();

      const updated = index.fuzzy('svc', false);
      expect(updated).toHaveLength(2_000);
      expect(updated![0]!.path).toBe('packages/pkg-0/service-000001-live.ts');
      expect(updated!.some((entry) => entry.path === 'packages/pkg-0/service-000000.ts')).toBe(false);
      for (let i = 1; i < updated!.length; i += 1) {
        expect(updated![i - 1]!.path < updated![i]!.path).toBe(true);
      }

      liveState.set(deletedPath, {
        path: 'packages/pkg-0/service-000000.ts',
        name: 'service-000000.ts',
        kind: 'file',
        mtimeMs: 1_000_000,
        ctimeMs: 1_000_000,
        size: 20,
        ino: 1_000_000,
      });
      await index.mutation(deletedPath);
      await index.whenSettled();

      const recreated = index.fuzzy('svc', false);
      expect(recreated).toHaveLength(2_001);
      expect(recreated![0]!.path).toBe('packages/pkg-0/service-000000.ts');
      expect(recreated![1]!.path).toBe('packages/pkg-0/service-000001-live.ts');
    } finally {
      await index.dispose();
    }
  });

  it('caches parsed ignore rules across workspacePathEntry calls and invalidates immediately when ignore files change', async () => {
    const root = await makeTempDir();
    const nested = join(root, 'packages', 'app', 'src');
    await mkdir(nested, { recursive: true });
    const gitignorePath = join(root, '.gitignore');
    const ruleLines = Array.from({ length: 1_500 }, (_, i) => `ignored-pattern-${i}.tmp`).join('\n');
    await writeFile(gitignorePath, `${ruleLines}\nfirst.log\n`);
    const firstFile = join(nested, 'first.log');
    const secondFile = join(nested, 'second.log');
    await writeFile(firstFile, 'a');
    await writeFile(secondFile, 'b');

    expect(workspacePathEntry(root, firstFile)).toBeUndefined();
    expect(workspacePathEntry(root, secondFile)?.path).toBe('packages/app/src/second.log');

    const t0 = performance.now();
    for (let i = 0; i < 100; i += 1) {
      expect(workspacePathEntry(root, firstFile)).toBeUndefined();
      expect(workspacePathEntry(root, secondFile)?.path).toBe('packages/app/src/second.log');
    }
    const cachedMs = performance.now() - t0;
    expect(cachedMs).toBeLessThan(1_500);

    await writeFile(gitignorePath, `${ruleLines}\nsecond.log\nextra-rule.tmp\n`);
    expect(workspacePathEntry(root, firstFile)?.path).toBe('packages/app/src/first.log');
    expect(workspacePathEntry(root, secondFile)).toBeUndefined();

    await rm(gitignorePath);
    expect(workspacePathEntry(root, secondFile)?.path).toBe('packages/app/src/second.log');
  });
});
