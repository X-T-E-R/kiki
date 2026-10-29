import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { AppendLogCorruptedError, IAppendLogStore, type AppendLogTruncation } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

const enc = new TextEncoder();

interface Rec {
  readonly n: number;
}

const SCOPE = 'agents/main';
const KEY = 'wire.jsonl';

function chunkedStorage(chunks: Uint8Array[]): IFileSystemStorageService {
  return {
    _serviceBrand: undefined,
    read: async () => undefined,
    readStream: async function* () {
      for (const c of chunks) yield c;
    },
    write: async () => {},
    writeStream: async () => {},
    append: async () => {},
    acquireLock: async () => ({ release: async () => {} }),
    list: async () => [],
    delete: async () => {},
    moveDirectory: async () => {},
    size: async () => undefined,
    mtime: async () => undefined,
    pathFor: () => undefined,
    flush: async () => {},
    close: async () => {},
  };
}

describe('AppendLogStore', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let storage: InMemoryStorageService;
  let record: IAppendLogStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    storage = new InMemoryStorageService();
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    record = ix.get(IAppendLogStore);
  });

  afterEach(() => disposables.dispose());

  async function collect<R>(scope: string, key: string): Promise<readonly R[]> {
    const out: R[] = [];
    for await (const r of record.read<R>(scope, key)) {
      out.push(r);
    }
    return out;
  }

  it('reports exact source record bytes including whitespace, CRLF and unterminated Unicode', async () => {
    const first = ' {"text":"你好"} \r\n';
    const last = '{"text":"𠮷"}';
    await storage.write(SCOPE, KEY, enc.encode(`\n${first}\n${last}`));
    const bytes: number[] = [];
    const values: unknown[] = [];
    for await (const value of record.read(SCOPE, KEY, { onRecordBytes: (size) => { bytes.push(size); }, chunkBytes: 3 })) {
      values.push(value);
    }
    expect(values).toEqual([{ text: '你好' }, { text: '𠮷' }]);
    expect(bytes).toEqual([Buffer.byteLength(first), Buffer.byteLength(last)]);
  });

  it('stops within an already buffered chunk when its reader aborts', async () => {
    await storage.write(SCOPE, KEY, enc.encode('{"n":1}\n{"n":2}\n'));
    const controller = new AbortController();
    const reader = record.read<Rec>(SCOPE, KEY, { signal: controller.signal })[Symbol.asyncIterator]();
    expect(await reader.next()).toMatchObject({ value: { n: 1 }, done: false });
    controller.abort();
    await expect(reader.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reads nothing from an empty log', async () => {
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([]);
  });

  it('append + read round-trips records in order', async () => {
    record.append<Rec>(SCOPE, KEY, { n: 1 });
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    record.append<Rec>(SCOPE, KEY, { n: 3 });
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('projects committed batches with exact positions without rereading the written payload', async () => {
    const observed: { start: number; end: number; generation: string; records: unknown[] }[] = [];
    record.registerProjection({
      key: KEY,
      prepare: (_scope, records) => records.map((value) => value),
      commit: async (position, records) => {
        expect(await storage.size(SCOPE, KEY)).toBe(position.end);
        observed.push({ start: position.start, end: position.end, generation: position.generation, records });
      },
      onError: () => { throw new Error('unexpected projection failure'); },
    });
    record.append(SCOPE, KEY, { n: 1 });
    record.append(SCOPE, KEY, { text: '中文' });
    await record.flush(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 2 });
    await record.flush(SCOPE, KEY);
    expect(observed).toEqual([
      { start: 0, end: Buffer.byteLength('{"n":1}\n{"text":"中文"}\n'), generation: 'legacy', records: [{ n: 1 }, { text: '中文' }] },
      { start: Buffer.byteLength('{"n":1}\n{"text":"中文"}\n'), end: Buffer.byteLength('{"n":1}\n{"text":"中文"}\n{"n":2}\n'), generation: 'legacy', records: [{ n: 2 }] },
    ]);
  });

  it('does not reject canonical success when derived projection fails', async () => {
    const errors: unknown[] = [];
    record.registerProjection({ key: KEY, prepare: () => 1, commit: async () => { throw new Error('projection unavailable'); }, onError: (error) => { errors.push(error); } });
    record.append(SCOPE, KEY, { n: 1 });
    await record.flush();
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
    expect(errors).toHaveLength(1);
  });

  it('changes the durable generation before a managed rewrite, including a failed rewrite', async () => {
    record.append(SCOPE, KEY, { n: 1 });
    await record.flush();
    expect(await record.generation(SCOPE, KEY)).toBe('legacy');
    await record.rewrite(SCOPE, KEY, [{ n: 2 }]);
    const generation = await record.generation(SCOPE, KEY);
    expect(generation).not.toBe('legacy');
    const write = storage.write.bind(storage);
    storage.write = async (scope, key, value, options) => {
      if (key === KEY) throw new Error('rewrite failed');
      return write(scope, key, value, options);
    };
    await expect(record.rewrite(SCOPE, KEY, [{ n: 3 }])).rejects.toThrow('rewrite failed');
    expect(await record.generation(SCOPE, KEY)).not.toBe(generation);
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":2}\n');
  });

  it('batches many appends into a single durable append', async () => {
    const spy = { count: 0 };
    const original = storage.append.bind(storage);
    storage.append = async (...args) => {
      spy.count++;
      return original(...args);
    };

    for (let n = 0; n < 10; n++) record.append<Rec>(SCOPE, KEY, { n });
    await record.flush();

    expect(await collect<Rec>(SCOPE, KEY)).toHaveLength(10);
    expect(spy.count).toBe(1);
  });

  it('flushes one log without waiting for other logs', async () => {
    const blockedKey = 'other.jsonl';
    const original = storage.append.bind(storage);
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    storage.append = async (scope, key, data, options) => {
      if (key === blockedKey) await blocked;
      return original(scope, key, data, options);
    };
    const firstOwner = record.acquire(SCOPE, KEY);
    const blockedOwner = record.acquire(SCOPE, blockedKey);
    record.append(SCOPE, KEY, { n: 1 });
    record.append(SCOPE, blockedKey, { n: 2 });

    await record.flush(SCOPE, KEY);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);

    releaseBlocked();
    await record.flush();
    await firstOwner.dispose();
    await blockedOwner.dispose();
  });

  it('treats missing and retired scoped targets as a no-op', async () => {
    const logs = (record as unknown as { readonly logs: Map<string, unknown> }).logs;
    await record.flush('agents/missing', 'wire.jsonl');
    expect(logs.size).toBe(0);

    const owner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 1 });
    await record.flush(SCOPE, KEY);
    await owner.dispose();
    await record.drainRetirements();
    expect(logs.size).toBe(0);

    await record.flush(SCOPE, KEY);
    expect(logs.size).toBe(0);
  });

  function uncommittedBusy(): StorageError {
    return new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'storage append failed: unrecognized I/O error', {
      details: { path: `${SCOPE}/${KEY}`, op: 'append', errno: 'EBUSY', committed: false },
      cause: Object.assign(new Error('EBUSY'), { code: 'EBUSY', syscall: 'open' }),
    });
  }

  it('retries an uncommitted EBUSY batch and writes it once', async () => {
    let attempts = 0;
    const original = storage.append.bind(storage);
    storage.append = async (...args) => {
      attempts += 1;
      if (attempts === 1) throw uncommittedBusy();
      await original(...args);
    };
    record.append(SCOPE, KEY, { n: 1 });
    record.append(SCOPE, KEY, { n: 2 });
    await expect(record.flush(SCOPE, KEY)).rejects.toBeInstanceOf(StorageError);
    await record.flush(SCOPE, KEY);
    expect(attempts).toBe(2);
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{"n":2}\n');
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('writes an uncommitted EBUSY batch once after more than eight explicit flushes', async () => {
    let attempts = 0;
    let blocked = true;
    const original = storage.append.bind(storage);
    storage.append = async (...args) => {
      attempts += 1;
      if (blocked) throw uncommittedBusy();
      await original(...args);
    };
    record.append(SCOPE, KEY, { n: 1 });
    record.append(SCOPE, KEY, { n: 2 });
    for (let i = 0; i < 12; i += 1) {
      await expect(record.flush(SCOPE, KEY)).rejects.toBeInstanceOf(StorageError);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(attempts).toBeGreaterThan(8);
    const stalled = attempts;
    await expect(record.flush(SCOPE, KEY)).rejects.toBeInstanceOf(StorageError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toBeGreaterThan(stalled);
    expect(await storage.read(SCOPE, KEY)).toBeUndefined();
    blocked = false;
    await record.flush(SCOPE, KEY);
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{"n":2}\n');
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('retries uncommitted ENOSPC only on an explicit flush after storage recovers', async () => {
    let attempts = 0;
    const failure = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'storage append failed: no space left on device', {
      details: { path: `${SCOPE}/${KEY}`, op: 'append', errno: 'ENOSPC', committed: false },
    });
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => { reportFailure = resolve; });
    const append = storage.append.bind(storage);
    storage.append = async () => { attempts += 1; throw failure; };
    record.append(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
    expect(await reportedFailure).toBe(failure);
    expect(attempts).toBe(1);
    expect(await storage.read(SCOPE, KEY)).toBeUndefined();
    storage.append = async (...args) => { attempts += 1; await append(...args); };
    await record.flush(SCOPE, KEY);
    expect(attempts).toBe(2);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
  });

  it.each([0, 1, 11, 'full'] as const)('reconciles an ENOSPC append with %s bytes written and only appends the missing suffix', async (cut) => {
    record.append(SCOPE, KEY, { n: 0 });
    await record.flush(SCOPE, KEY);
    const prefix = (await storage.read(SCOPE, KEY))!;
    const value = { text: '示例🙂', n: 1 };
    const encoded = enc.encode(JSON.stringify(value) + '\n');
    const written = cut === 'full' ? encoded.byteLength : cut;
    const append = storage.append.bind(storage);
    const calls: Uint8Array[] = [];
    let blocked = true;
    const commits: unknown[] = [];
    record.registerProjection({ key: KEY, prepare: (_scope, values) => values,
      commit: async (_position, values) => { commits.push(values); }, onError: () => {} });
    const failure = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'no space left on device', { details: { errno: 'ENOSPC', committed: true } });
    storage.append = async (scope, key, data, options) => {
      calls.push(data.slice());
      if (blocked) {
        await append(scope, key, data.slice(0, written), options);
        throw failure;
      }
      await append(scope, key, data, options);
    };
    record.append(SCOPE, KEY, value);
    await expect(record.flush(SCOPE, KEY)).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
    expect(commits).toEqual([]);
    blocked = false;
    record.append(SCOPE, KEY, { n: 2 });
    await Promise.all([record.flush(SCOPE, KEY), record.flush(SCOPE, KEY)]);
    expect(calls[1]).toEqual(encoded.subarray(written));
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(new TextDecoder().decode(prefix) + JSON.stringify(value) + '\n{"n":2}\n');
    expect(commits).toEqual([[value], [{ n: 2 }]]);
    expect(await collect(SCOPE, KEY)).toEqual([{ n: 0 }, value, { n: 2 }]);
  });

  it('keeps a fully written batch failed until a new durable sync succeeds without reappending its bytes', async () => {
    const append = storage.append.bind(storage);
    const sizes: number[] = [];
    let failing = true;
    const failure = new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'sync failed', { details: { committed: true } });
    storage.append = async (scope, key, data, options) => {
      sizes.push(data.byteLength);
      await append(scope, key, data, options);
      if (failing) throw failure;
    };
    record.append(SCOPE, KEY, { n: 1 });
    record.append(SCOPE, KEY, { n: 2 });
    await expect(record.flush()).rejects.toBe(failure);
    await expect(record.flush()).rejects.toBe(failure);
    expect(sizes).toEqual([16, 0]);
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{"n":2}\n');
    failing = false;
    await record.flush();
    expect(sizes).toEqual([16, 0, 0]);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('retains the original byte fence when suffix recovery fails before writing', async () => {
    const append = storage.append.bind(storage);
    let attempts = 0;
    const failure = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'no space left on device', { details: { committed: true } });
    storage.append = async (scope, key, bytes, options) => {
      attempts++;
      if (attempts === 1) { await append(scope, key, bytes.subarray(0, 3), options); throw failure; }
      if (attempts === 2) throw uncommittedBusy();
      await append(scope, key, bytes, options);
    };
    record.append(SCOPE, KEY, { n: 1 });
    await expect(record.flush()).rejects.toBe(failure);
    await expect(record.flush()).rejects.toMatchObject({ details: { committed: false } });
    record.append(SCOPE, KEY, { n: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toBe(2);
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n');
    await record.flush();
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(attempts).toBe(4);
  });

  it.each(['generation', 'boundary', 'tail'] as const)('blocks reconciliation after the %s changes without appending', async (change) => {
    record.append(SCOPE, KEY, { n: 0 });
    await record.flush(SCOPE, KEY);
    const append = storage.append.bind(storage);
    let attempts = 0;
    const failure = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'no space left on device', { details: { committed: true } });
    storage.append = async (scope, key, bytes, options) => {
      attempts++;
      await append(scope, key, bytes.subarray(0, 3), options);
      throw failure;
    };
    record.append(SCOPE, KEY, { n: 1 });
    await expect(record.flush()).rejects.toBe(failure);
    if (change === 'generation') await storage.write(SCOPE, `${KEY}.generation`, enc.encode('replacement'));
    else {
      const bytes = (await storage.read(SCOPE, KEY))!;
      bytes[change === 'boundary' ? 0 : bytes.byteLength - 1] = 0;
      await storage.write(SCOPE, KEY, bytes);
    }
    await expect(record.flush()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED, details: { recovery: 'journal_mismatch' } });
    expect(attempts).toBe(1);
  });

  it('later flush reports an ambiguous auto-flush failure after one retried drain', async () => {
    const failure = new Error('append failed after commit');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      markAppendStarted();
      await appendGate;
      await originalAppend(...args);
      throw failure;
    };

    record.append(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
    record.append(SCOPE, KEY, { n: 2 });
    await appendStarted;
    releaseAppend();
    expect(await reportedFailure).toBe(failure);

    await expect(record.flush()).rejects.toBe(failure);
    expect(appendAttempts).toBe(2);
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
      '{"n":1}\n{"n":2}\n{"n":1}\n{"n":2}\n',
    );
    await expect(record.flush()).rejects.toBe(failure);
    expect(appendAttempts).toBe(2);
  });

  it('reacquire after final release waits for retiring storage before fresh I/O', async () => {
    const failure = new Error('retiring append failed');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let markReplacementAppendStarted!: () => void;
    const replacementAppendStarted = new Promise<void>((resolve) => {
      markReplacementAppendStarted = resolve;
    });
    let releaseReplacementAppend!: () => void;
    const replacementAppendGate = new Promise<void>((resolve) => {
      releaseReplacementAppend = resolve;
    });
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let appendAttempts = 0;
    let replacementStarted = false;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        markAppendStarted();
        await appendGate;
        throw failure;
      }
      if (appendAttempts === 2) {
        await appendGate;
        throw failure;
      }
      replacementStarted = true;
      markReplacementAppendStarted();
      await replacementAppendGate;
      return originalAppend(...args);
    };

    const retiringOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
    await appendStarted;
    await retiringOwner.dispose();
    const replacementOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 2 });
    const orderedFlush = record.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(replacementStarted).toBe(false);

    releaseAppend();
    expect(await reportedFailure).toBe(failure);
    await replacementAppendStarted;

    const currentFlush = record.flush();
    let flushSettled = false;
    void currentFlush.then(() => {
      flushSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushSettled).toBe(false);

    releaseReplacementAppend();
    await Promise.all([orderedFlush, currentFlush]);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 2 }]);
    await replacementOwner.dispose();
  });

  it('final release retirement is awaited by drainRetirements', async () => {
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      markAppendStarted();
      await appendGate;
      return originalAppend(...args);
    };

    const owner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 1 });
    await appendStarted;
    await owner.dispose();

    let drained = false;
    const draining = record.drainRetirements().then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseAppend();
    await draining;
    expect(drained).toBe(true);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
  });

  it('retries a failed drain append and persists subsequent turns', async () => {
    const failure = new Error('disk full');
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) throw failure;
      return originalAppend(...args);
    };

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await expect(record.flush()).rejects.toBe(failure);
    expect(appendAttempts).toBe(2);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);

    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await record.flush();
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('retries an in-flight failed drain so queued turns land after recovery', async () => {
    const failure = new Error('append blocked');
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        await appendGate;
        throw failure;
      }
      return originalAppend(...args);
    };

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    const firstFlush = record.flush();
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    releaseAppend();
    await expect(firstFlush).rejects.toBe(failure);

    await record.flush();
    expect(appendAttempts).toBe(2);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('keeps a sticky failure until every acquired owner releases it', async () => {
    const failure = new Error('shared append failed');
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts <= 2) throw failure;
      return originalAppend(...args);
    };

    const firstOwner = record.acquire(SCOPE, KEY);
    const finalOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
    expect(await reportedFailure).toBe(failure);

    await firstOwner.dispose();
    await expect(record.flush()).rejects.toBe(failure);

    await finalOwner.dispose();
    const replacementOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 2 });
    await record.flush();
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 2 }]);
    await replacementOwner.dispose();
  });

  it('rewrite atomically replaces the whole log', async () => {
    record.append<Rec>(SCOPE, KEY, { n: 1 });
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await record.flush();

    await record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }, { n: 8 }]);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 8 }]);
  });

  it('rewrite preserves an append accepted after the replacement snapshot', async () => {
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      markWriteStarted();
      await writeGate;
      return originalWrite(...args);
    };
    const replacement = [{ n: 9 }];
    record.append<Rec>(SCOPE, KEY, { n: 2 });

    const rewrite = record.rewrite<Rec>(SCOPE, KEY, replacement);
    await writeStarted;
    const flushed = record.flush();
    releaseWrite();
    await flushed;

    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
    await rewrite;
  });

  it('rewrite preserves an append whose old drain is in flight at cutover', async () => {
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseOldAppend!: () => void;
    const oldAppendGate = new Promise<void>((resolve) => {
      releaseOldAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        markAppendStarted();
        await oldAppendGate;
      }
      return originalAppend(...args);
    };
    const replacement = [{ n: 9 }];
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const rewrite = record.rewrite<Rec>(SCOPE, KEY, replacement);
    const flushed = record.flush();
    releaseOldAppend();
    await flushed;
    await rewrite;

    expect(appendAttempts).toBe(2);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
  });

  it('explicit rewrite recovers an in-flight ambiguous append failure', async () => {
    const failure = new Error('append failed after commit');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        markAppendStarted();
        await appendGate;
        await originalAppend(...args);
        throw failure;
      }
      return originalAppend(...args);
    };
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const rewrite = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    const flushed = record.flush();
    releaseAppend();
    await Promise.all([rewrite, flushed]);

    expect(appendAttempts).toBe(2);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
  });

  it('atomic rewrite rejection does not retry an append already written before cutover', async () => {
    const failure = new Error('atomic rewrite rejected');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      markAppendStarted();
      await appendGate;
      return originalAppend(...args);
    };
    storage.write = async () => {
      throw failure;
    };
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const rewriteRejected = expect(
      record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]),
    ).rejects.toBe(failure);
    releaseAppend();
    await rewriteRejected;

    await expect(record.flush()).rejects.toBe(failure);
    expect(appendAttempts).toBe(1);
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":2}\n');
  });

  it('invalid replacement records do not change append ownership', async () => {
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      markAppendStarted();
      await appendGate;
      return originalAppend(...args);
    };
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const invalid = expect(
      record.rewrite<unknown>(SCOPE, KEY, [{ n: 9n }]),
    ).rejects.toBeInstanceOf(TypeError);
    releaseAppend();
    await invalid;
    await record.flush();

    expect(appendAttempts).toBe(1);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 2 }]);
  });

  it('successful explicit rewrite recovers sticky failure and drains the tail once', async () => {
    const failure = new Error('atomic rewrite rejected');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        markAppendStarted();
        await appendGate;
      }
      return originalAppend(...args);
    };
    let writeAttempts = 0;
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      if (args[1] === KEY) {
        writeAttempts++;
        if (writeAttempts === 1) throw failure;
      }
      return originalWrite(...args);
    };
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const failedRewrite = expect(
      record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]),
    ).rejects.toBe(failure);
    releaseAppend();
    await failedRewrite;
    await expect(record.flush()).rejects.toBe(failure);
    await expect(collect<Rec>(SCOPE, KEY)).rejects.toBe(failure);
    await expect(record.close()).rejects.toBe(failure);

    await record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    await record.flush();

    expect(writeAttempts).toBe(2);
    expect(appendAttempts).toBe(2);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
  });

  it('close waits for every key before reporting the first sticky failure', async () => {
    const failedScope = 'agents/a';
    const pendingScope = 'agents/b';
    const failure = new Error('first key failed');
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let markPendingAppendStarted!: () => void;
    const pendingAppendStarted = new Promise<void>((resolve) => {
      markPendingAppendStarted = resolve;
    });
    let releasePendingAppend!: () => void;
    const pendingAppendGate = new Promise<void>((resolve) => {
      releasePendingAppend = resolve;
    });
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      if (args[0] === failedScope) throw failure;
      if (args[0] === pendingScope) {
        markPendingAppendStarted();
        await pendingAppendGate;
      }
      return originalAppend(...args);
    };
    record.append(failedScope, KEY, { n: 1 }, { onError: reportFailure });
    expect(await reportedFailure).toBe(failure);
    record.append(pendingScope, KEY, { n: 2 });
    await pendingAppendStarted;

    const closed = record.close();
    let closeSettled = false;
    void closed.finally(() => {
      closeSettled = true;
    }).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releasePendingAppend();
    await expect(closed).rejects.toBe(failure);
    expect(new TextDecoder().decode(await storage.read(pendingScope, KEY))).toBe('{"n":2}\n');
  });

  it('appends that arrive during a rewrite land after the replaced content', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      await writeGate;
      return originalWrite(...args);
    };

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await record.flush();
    const rewrite = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    releaseWrite();
    await rewrite;
    await record.flush();

    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
  });

  it('flush() awaits an in-flight rewrite', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      await writeGate;
      return originalWrite(...args);
    };

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await record.flush();
    const rewrite = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    const flushed = record.flush();
    releaseWrite();
    await flushed;
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }]);
    await rewrite;
  });

  it('flush() stays pending until an append made during rewrite is durable', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      await writeGate;
      return originalWrite(...args);
    };
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      markAppendStarted();
      await appendGate;
      return originalAppend(...args);
    };

    const rewrite = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    const flushed = record.flush();
    let flushSettled = false;
    void flushed.then(() => {
      flushSettled = true;
    });

    releaseWrite();
    await appendStarted;
    await Promise.resolve();
    await Promise.resolve();
    expect(flushSettled).toBe(false);

    releaseAppend();
    await flushed;
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
    await rewrite;
  });

  it('logs addressed by different scope/key are independent', async () => {
    record.append<Rec>('a', 'l', { n: 1 });
    record.append<Rec>('b', 'l', { n: 2 });
    expect(await collect<Rec>('a', 'l')).toEqual([{ n: 1 }]);
    expect(await collect<Rec>('b', 'l')).toEqual([{ n: 2 }]);
  });

  it('drops a torn final line (crash mid-flush)', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 }).slice(0, 4)}`;
    await storage.append(SCOPE, KEY, enc.encode(raw));

    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
  });

  it('throws AppendLogCorruptedError on a corrupted middle line', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\nGARBAGE\n${JSON.stringify({ n: 3 })}\n`;
    await storage.append(SCOPE, KEY, enc.encode(raw));

    await expect(collect<Rec>(SCOPE, KEY)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppendLogCorruptedError);
      const corrupted = error as AppendLogCorruptedError;
      expect(corrupted.code).toBe('storage.corrupted');
      expect(corrupted.details).toEqual({ scope: SCOPE, key: KEY, lineNumber: 2 });
      expect(corrupted.cause).toBeInstanceOf(SyntaxError);
      return true;
    });
  });

  it('stops at a corrupted middle line and reports it when onTruncate is given', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\nGARBAGE\n${JSON.stringify({ n: 3 })}\n`;
    await storage.append(SCOPE, KEY, enc.encode(raw));
    const truncations: AppendLogTruncation[] = [];

    const out: Rec[] = [];
    for await (const r of record.read<Rec>(SCOPE, KEY, {
      onTruncate: (truncation) => truncations.push(truncation),
    })) {
      out.push(r);
    }

    expect(out).toEqual([{ n: 1 }]);
    expect(truncations).toHaveLength(1);
    expect(truncations[0]).toMatchObject({ lineNumber: 2, reason: 'corrupted' });
    expect(truncations[0]!.cause).toBeInstanceOf(AppendLogCorruptedError);
  });

  it('reports a torn final line as truncation when onTruncate is given', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 }).slice(0, 4)}`;
    await storage.append(SCOPE, KEY, enc.encode(raw));
    const truncations: AppendLogTruncation[] = [];

    const out: Rec[] = [];
    for await (const r of record.read<Rec>(SCOPE, KEY, {
      onTruncate: (truncation) => truncations.push(truncation),
    })) {
      out.push(r);
    }

    expect(out).toEqual([{ n: 1 }]);
    expect(truncations).toEqual([{ lineNumber: 2, reason: 'truncated' }]);
  });

  it('does not report truncation for a clean log when onTruncate is given', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`;
    await storage.append(SCOPE, KEY, enc.encode(raw));
    const truncations: AppendLogTruncation[] = [];

    const out: Rec[] = [];
    for await (const r of record.read<Rec>(SCOPE, KEY, {
      onTruncate: (truncation) => truncations.push(truncation),
    })) {
      out.push(r);
    }

    expect(out).toEqual([{ n: 1 }, { n: 2 }]);
    expect(truncations).toEqual([]);
  });

  it('reads across chunk boundaries (stream read splits lines)', async () => {
    const full = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n${JSON.stringify({ n: 3 })}\n`;
    const bytes = enc.encode(full);
    const chunks = [bytes.slice(0, 7), bytes.slice(7, 23), bytes.slice(23)];
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    const out: Rec[] = [];
    for await (const r of log.read<Rec>(SCOPE, KEY)) out.push(r);
    expect(out).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('does not leak decoder state into a later read when an earlier read returns early', async () => {
    const line1 = `${JSON.stringify({ type: 'metadata', protocol_version: '1.4' })}\n`;
    const line2 = `${JSON.stringify({ type: 'context.append_message', s: '中文中文中文' })}\n`;
    const bytes = enc.encode(line1 + line2);
    const cut = bytes.indexOf(enc.encode('中')[0]!) + 1;
    const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    const first: Array<{ type: string }> = [];
    for await (const r of log.read<{ type: string }>(SCOPE, KEY)) {
      first.push(r);
      break;
    }
    expect(first).toEqual([{ type: 'metadata', protocol_version: '1.4' }]);

    const out: Array<{ type: string; s?: string }> = [];
    for await (const r of log.read<{ type: string; s?: string }>(SCOPE, KEY)) out.push(r);
    expect(out).toEqual([
      { type: 'metadata', protocol_version: '1.4' },
      { type: 'context.append_message', s: '中文中文中文' },
    ]);
  });

  it('isolates decoder state between concurrent reads', async () => {
    const content = `${JSON.stringify({ s: '中文日本語' })}\n`;
    const bytes = enc.encode(content);
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    const readAll = async (): Promise<Array<{ s: string }>> => {
      const out: Array<{ s: string }> = [];
      for await (const r of log.read<{ s: string }>(SCOPE, KEY)) out.push(r);
      return out;
    };
    const [a, b] = await Promise.all([readAll(), readAll()]);
    expect(a).toEqual([{ s: '中文日本語' }]);
    expect(b).toEqual([{ s: '中文日本語' }]);
  });

  it('reads across chunk boundaries with multi-byte UTF-8 split', async () => {
    const full = `${JSON.stringify({ n: 1, s: '中文' })}\n${JSON.stringify({ n: 2, s: '日本語' })}\n`;
    const bytes = enc.encode(full);
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    const out: Array<Rec & { s?: string }> = [];
    for await (const r of log.read<Rec & { s?: string }>(SCOPE, KEY)) out.push(r);
    expect(out).toEqual([
      { n: 1, s: '中文' },
      { n: 2, s: '日本語' },
    ]);
  });

  it('does not emit onDidWrite when a flush persists nothing', async () => {
    const events: string[] = [];
    record.onDidWrite((write) => events.push(`${write.scope}/${write.key}`));

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await record.flush();
    expect(events).toEqual([`${SCOPE}/${KEY}`]);

    await record.flush();
    await record.flush();
    expect(events).toEqual([`${SCOPE}/${KEY}`]);
  });

  it('emits onDidWrite for batches persisted before a later drain failure', async () => {
    const events: string[] = [];
    record.onDidWrite((write) => events.push(`${write.scope}/${write.key}`));
    const original = storage.append.bind(storage);
    let calls = 0;
    storage.append = async (scope, key, data, options) => {
      calls += 1;
      if (calls > 1) throw new Error('disk full');
      const result = await original(scope, key, data, options);
      record.append<Rec>(scope, key, { n: 2 });
      return result;
    };

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await expect(record.flush()).rejects.toThrow('disk full');
    expect(events).toEqual([`${SCOPE}/${KEY}`]);
  });
});
