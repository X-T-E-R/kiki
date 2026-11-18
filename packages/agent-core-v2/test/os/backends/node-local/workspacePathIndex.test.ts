import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import type { CpuRequestOptions } from '#/app/cpuWorker/host';
import { WorkspacePathIndex } from '#/os/backends/node-local/workspacePathIndex';
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
});
