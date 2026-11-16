import { mkdir, mkdtemp, rm, stat as nodeStat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CpuWorkerError } from '#/app/cpuWorker/host';
import * as cpuRuntime from '#/app/cpuWorker/runtime';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

import { symlinkDir, windowsSymlinksUnavailable } from '../../../_base/utils/symlink';

let dir: string;
let fs: HostFileSystem;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kimi-hostfs-'));
  fs = new HostFileSystem();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cpuRuntime.closeCpuPool();
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe('HostFileSystem stat / lstat', () => {
  it('retains native ownership and permission metadata for protected file readers', async () => {
    const path = join(dir, 'private.txt');
    await writeFile(path, 'fixture-value', { mode: 0o600 });
    const expected = await nodeStat(path);
    expect(await fs.stat(path)).toMatchObject({ mode: expected.mode, uid: expected.uid });
    expect(await fs.lstat(path)).toMatchObject({ mode: expected.mode, uid: expected.uid });
  });

  it.skipIf(windowsSymlinksUnavailable)('stat follows a symlink to a regular file while lstat stats the link', async () => {
    const target = join(dir, 'target.txt');
    await writeFile(target, 'hello', 'utf-8');
    const link = join(dir, 'link.txt');
    await symlink(target, link);

    const st = await fs.stat(link);
    expect(st.isFile).toBe(true);
    expect(st.isSymbolicLink).not.toBe(true);

    const lst = await fs.lstat(link);
    expect(lst.isSymbolicLink).toBe(true);
    expect(lst.isFile).toBe(false);
  });

  it('stat follows a symlink to a directory', async () => {
    const target = join(dir, 'subdir');
    await mkdir(target);
    const link = join(dir, 'dirlink');
    await symlinkDir(target, link);

    expect((await fs.stat(link)).isDirectory).toBe(true);
    expect((await fs.lstat(link)).isDirectory).toBe(false);
  });

  it('stat rejects a dangling symlink while lstat still stats the link', async () => {
    const link = join(dir, 'dangling');
    await symlinkDir(join(dir, 'missing'), link);

    await expect(fs.stat(link)).rejects.toThrow();
    expect((await fs.lstat(link)).isSymbolicLink).toBe(true);
  });
});

describe('HostFileSystem readLineRange', () => {
  async function collect(path: string, startLine: number, maxLines: number): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of fs.readLineRange(path, { startLine, maxLines })) lines.push(line);
    return lines;
  }

  async function collectTail(path: string, options: { tailLines: number; fileSize?: number }): Promise<{ startLine: number; totalLines: number; lines: string[] }> {
    const located = await fs.readTailRange(path, options);
    const lines: string[] = [];
    for await (const line of located.lines) lines.push(line);
    return { startLine: located.startLine, totalLines: located.totalLines, lines };
  }

  async function materialize(lines: AsyncGenerator<string>): Promise<string[]> {
    const result: string[] = [];
    for await (const line of lines) result.push(line);
    return result;
  }

  it('reads worker tails with exact counts for final LF and no final LF', async () => {
    const withLf = join(dir, 'tail-final-lf.txt');
    const withLfContent = `${'prefix\n'.repeat(200_000)}tail-a\ntail-b\n`;
    await writeFile(withLf, withLfContent, 'utf-8');
    await expect(collectTail(withLf, { tailLines: 2 })).resolves.toEqual({
      startLine: 200_001,
      totalLines: 200_002,
      lines: ['tail-a\n', 'tail-b\n'],
    });

    const withoutLf = join(dir, 'tail-no-final-lf.txt');
    const withoutLfContent = `${'prefix\n'.repeat(200_000)}tail-a\ntail-b`;
    await writeFile(withoutLf, withoutLfContent, 'utf-8');
    await expect(collectTail(withoutLf, { tailLines: 2 })).resolves.toEqual({
      startLine: 200_001,
      totalLines: 200_002,
      lines: ['tail-a\n', 'tail-b'],
    });
  });

  it('preserves CRLF and mixed newline terminators in worker tails', async () => {
    const path = join(dir, 'tail-mixed-newlines.txt');
    await writeFile(path, `${'prefix\r\n'.repeat(100_000)}crlf\r\nmixed\nlast\r\n`, 'utf-8');

    await expect(collectTail(path, { tailLines: 3 })).resolves.toEqual({
      startLine: 100_001,
      totalLines: 100_003,
      lines: ['crlf\r\n', 'mixed\n', 'last\r\n'],
    });
  });

  it('decodes UTF-8 that crosses a 256 KiB worker chunk boundary', async () => {
    const path = join(dir, 'tail-utf8-boundary.txt');
    const chunkSize = 256 * 1024;
    const prefix = Buffer.alloc(chunkSize - 1, 0x61);
    const first = Buffer.concat([prefix, Buffer.from('€\n')]);
    const remaining = chunkSize * 2 - first.length;
    const second = Buffer.concat([Buffer.from('tail-'), Buffer.alloc(remaining - 6, 0x62), Buffer.from('\n')]);
    await writeFile(path, Buffer.concat([first, second]));

    const result = await collectTail(path, { tailLines: 2 });
    expect(result).toEqual({
      startLine: 1,
      totalLines: 2,
      lines: [`${'a'.repeat(chunkSize - 1)}€\n`, `tail-${'b'.repeat(remaining - 6)}\n`],
    });
  });

  it('rejects invalid UTF-8 in a skipped prefix', async () => {
    const path = join(dir, 'tail-invalid-prefix.txt');
    await writeFile(path, Buffer.concat([Buffer.alloc(300 * 1024, 0x61), Buffer.from([0xff]), Buffer.from('\ntail\n')]));

    await expect(fs.readTailRange(path, { tailLines: 1 })).rejects.toMatchObject({ code: 'os.fs.unknown' });
  });

  it('rejects NUL bytes in a skipped prefix', async () => {
    const path = join(dir, 'tail-nul-prefix.txt');
    await writeFile(path, Buffer.concat([Buffer.alloc(300 * 1024, 0x61), Buffer.from([0]), Buffer.from('\ntail\n')]));

    await expect(fs.readTailRange(path, { tailLines: 1 })).rejects.toMatchObject({ code: 'os.fs.unknown' });
  });

  it('invalidates a lazy tail iterator after the source changes', async () => {
    const path = join(dir, 'tail-lazy-change.txt');
    const original = `${'prefix\n'.repeat(100_000)}tail\n`;
    await writeFile(path, original, 'utf-8');
    const located = await fs.readTailRange(path, { tailLines: 1 });
    await writeFile(path, `${original}changed\n`, 'utf-8');

    await expect(materialize(located.lines)).rejects.toThrow(/changed after locating/u);
  });

  it('passes a known file size into the real tail worker without a routing stat', async () => {
    const path = join(dir, 'tail-known-size.txt');
    await writeFile(path, `${'prefix\n'.repeat(200_000)}tail\n`, 'utf-8');
    const fileSize = (await nodeStat(path)).size;
    const run = vi.spyOn(cpuRuntime, 'runCpuTask');

    await expect(collectTail(path, { tailLines: 1, fileSize })).resolves.toMatchObject({ lines: ['tail\n'] });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toEqual({ type: 'file.tailRange', path, options: { tailLines: 1, fileSize } });
  });

  it('shares high-offset indexing without materializing skipped wire records', async () => {
    const path = join(dir, 'large-wire.jsonl');
    const lines = Array.from({ length: 18000 }, (_, index) => `${JSON.stringify({ index, text: '数据'.repeat(650), pad: 'x'.repeat(200) })}\r\n`);
    await writeFile(path, lines.join(''), 'utf-8');
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      const offsets = [12450, 14130, 16050, 16970];
      const windows = await Promise.all(offsets.map((offset) => collect(path, offset, 35)));
      expect(windows).toEqual(offsets.map((offset) => lines.slice(offset - 1, offset + 34)));
      expect(concat.mock.calls.length).toBeLessThan(32);
      concat.mockClear();
      expect(await collect(path, 14130, 35)).toEqual(windows[1]);
      expect(concat.mock.calls.length).toBeLessThan(8);
    } finally {
      concat.mockRestore();
    }
  });

  it('reads a bounded window and preserves a BOM on non-first lines', async () => {
    const path = join(dir, 'range.txt');
    await writeFile(path, 'a\n\uFEFFb\nc\nd\n', 'utf-8');

    await expect(collect(path, 2, 2)).resolves.toEqual(['\uFEFFb\n', 'c\n']);
  });

  it('preserves the reason for a pre-aborted read', async () => {
    const path = join(dir, 'pre-abort.txt');
    await writeFile(path, 'line\n', 'utf-8');
    const controller = new AbortController();
    const reason = new Error('pre-abort');
    controller.abort(reason);

    await expect(fs.readLines(path, { signal: controller.signal }).next()).rejects.toBe(reason);
  });

  it('preserves the reason when aborted after yielding a line', async () => {
    const path = join(dir, 'abort-after-line.txt');
    await writeFile(path, 'first\nsecond\n', 'utf-8');
    const controller = new AbortController();
    const reason = new Error('abort-after-line');
    const lines = fs.readLines(path, { signal: controller.signal });

    await expect(lines.next()).resolves.toEqual({ value: 'first\n', done: false });
    controller.abort(reason);
    await expect(lines.next()).rejects.toBe(reason);
  });

  it('invalidates sparse line checkpoints after a rewrite', async () => {
    const path = join(dir, 'rewrite.txt');
    await writeFile(
      path,
      Array.from({ length: 700 }, (_, index) => `old-${String(index + 1)}`).join('\n'),
      'utf-8',
    );
    await expect(collect(path, 513, 2)).resolves.toEqual(['old-513\n', 'old-514\n']);

    await writeFile(
      path,
      Array.from({ length: 700 }, (_, index) => `new-value-${String(index + 1)}`).join('\n'),
      'utf-8',
    );
    await expect(collect(path, 513, 2)).resolves.toEqual([
      'new-value-513\n',
      'new-value-514\n',
    ]);
  });

  describe('CPU worker routing', () => {
    async function largeFixture(): Promise<{ path: string; lines: string[] }> {
      const path = join(dir, 'large.log');
      const lines = Array.from({ length: 4000 }, (_, index) => `${String(index + 1)} ${'x'.repeat(120)}\n`);
      await writeFile(path, lines.join(''), 'utf-8');
      return { path, lines };
    }

    it('reads large files in a CPU worker with the signal outside the operation', async () => {
      const { path, lines } = await largeFixture();
      const run = vi.spyOn(cpuRuntime, 'runCpuTask');
      const controller = new AbortController();
      const window: string[] = [];
      for await (const line of fs.readLineRange(path, { startLine: 3500, maxLines: 3, signal: controller.signal })) window.push(line);
      expect(window).toEqual(lines.slice(3499, 3502));
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]).toEqual([
        { type: 'file.lineRange', path, options: { startLine: 3500, maxLines: 3 } },
        { signal: controller.signal },
      ]);
    });

    it('keeps small files on the in-process reader', async () => {
      const path = join(dir, 'small.txt');
      await writeFile(path, 'a\nb\nc\n', 'utf-8');
      const run = vi.spyOn(cpuRuntime, 'runCpuTask');
      await expect(collect(path, 2, 2)).resolves.toEqual(['b\n', 'c\n']);
      expect(run).not.toHaveBeenCalled();
    });

    it('falls back in process when the pool is full or the worker asset is missing', async () => {
      const { path, lines } = await largeFixture();
      const run = vi.spyOn(cpuRuntime, 'runCpuTask')
        .mockRejectedValueOnce(new CpuWorkerError('CPU_QUEUE_FULL', 'CPU worker queue is full'))
        .mockRejectedValueOnce(new Error('CPU worker asset is unavailable'));
      await expect(collect(path, 10, 2)).resolves.toEqual(lines.slice(9, 11));
      await expect(collect(path, 3999, 5)).resolves.toEqual(lines.slice(3998));
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('surfaces worker timeouts and caller cancellation instead of rereading', async () => {
      const { path } = await largeFixture();
      const run = vi.spyOn(cpuRuntime, 'runCpuTask')
        .mockRejectedValueOnce(new CpuWorkerError('CPU_TIMEOUT', 'CPU task timed out'));
      await expect(collect(path, 10, 2)).rejects.toMatchObject({ code: 'CPU_TIMEOUT' });
      const controller = new AbortController();
      const reason = new Error('cancel read');
      run.mockImplementationOnce(async () => {
        controller.abort(reason);
        throw new CpuWorkerError('CPU_WORKER_EXIT', 'terminated');
      });
      await expect(fs.readLineRange(path, { startLine: 10, maxLines: 2, signal: controller.signal }).next()).rejects.toBe(reason);
    });
  });
});
