import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import type { CpuRequestOptions } from '#/app/cpuWorker/host';
import { isUncRoot, WorkspacePathIndex } from '#/os/backends/node-local/workspacePathIndex';
import type { WorkspacePathEntry } from '#/os/backends/node-local/workspacePathInventory';

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
      expect(trigramUpdateBatches).toEqual([98 + 1 + 1 + 50]);

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
});
