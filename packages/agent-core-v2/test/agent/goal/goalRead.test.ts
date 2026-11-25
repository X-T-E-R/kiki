import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { PersistedGoalReader } from '#/agent/goal/goalRead';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { executeCpuOperation, type CpuOperation } from '#/app/cpuWorker/tasks';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { StorageError } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';

function createInlineCpuWorkers(): { readonly service: ICpuWorkerService; readonly calls: CpuOperation[] } {
  const calls: CpuOperation[] = [];
  const service: ICpuWorkerService = {
    _serviceBrand: undefined,
    async request<T>(operation: CpuOperation, options?: { readonly signal?: AbortSignal }): Promise<T> {
      calls.push(operation);
      return await executeCpuOperation(operation, options?.signal) as T;
    },
  };
  return { service, calls };
}

describe('PersistedGoalReader worker scan', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('matches serial parity across cold zstd segments with boundary-spanning goal records and trailing partial EOF', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-goal-worker-'));
    dirs.push(root);
    const storage = new FileStorageService(root);
    const logs = new AppendLogStore(storage);
    const docs = new JsonAtomicDocumentStore(storage);
    const scope = 'sessions/ws/s1/agents/main';

    const filler = 'x'.repeat(200_000);
    const lines: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      lines.push(JSON.stringify({ type: 'filler', idx: i, payload: filler }));
    }
    lines.push(JSON.stringify({
      type: 'goal.create',
      goalId: 'goal-boundary',
      objective: 'cross-segment objective',
      status: 'active',
      controlRevision: 1,
      time: 10,
    }));
    for (let i = 0; i < 14; i += 1) {
      lines.push(JSON.stringify({ type: 'filler', idx: 100 + i, payload: filler }));
    }
    lines.push(JSON.stringify({
      type: 'goal.update',
      goalId: 'goal-boundary',
      turnsUsed: 7,
      tokensUsed: 4200,
      wallClockMs: 12_345,
      controlRevision: 2,
      time: 20,
    }));
    for (let i = 0; i < 6; i += 1) {
      lines.push(JSON.stringify({ type: 'filler', idx: 200 + i, payload: filler }));
    }
    const sealedBody = `${lines.join('\n')}\n`;
    const hotTail = `${JSON.stringify({
      type: 'goal.update',
      goalId: 'goal-boundary',
      turnsUsed: 9,
      controlRevision: 3,
      time: 30,
    })}\n{"type":"goal.update","truncated":true`;

    await storage.write(scope, AGENT_WIRE_RECORD_KEY, Buffer.from(sealedBody + hotTail, 'utf8'));
    await logs.sealCold(scope, AGENT_WIRE_RECORD_KEY, Buffer.byteLength(sealedBody, 'utf8'), {
      codec: 'zstd',
      segmentBytes: 1024 * 1024,
    });

    const { service: workers, calls } = createInlineCpuWorkers();
    const workerReader = new PersistedGoalReader(logs, docs, storage, workers);
    const serialReader = new PersistedGoalReader(logs, docs, storage);

    const [workerGoal, serialGoal] = await Promise.all([
      workerReader.readReady(scope),
      serialReader.readReady(scope),
    ]);

    expect(calls.filter((c) => c.type === 'wire.goalScan').length).toBeGreaterThan(1);
    expect(workerGoal).toEqual(serialGoal);
    expect(workerGoal).toMatchObject({
      goalId: 'goal-boundary',
      objective: 'cross-segment objective',
      turnsUsed: 9,
      tokensUsed: 4200,
      controlRevision: 3,
    });
  });

  it('rejects a corrupted cold segment SHA-256 during worker goal scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-goal-corrupt-'));
    dirs.push(root);
    const storage = new FileStorageService(root);
    const logs = new AppendLogStore(storage);
    const docs = new JsonAtomicDocumentStore(storage);
    const scope = 'sessions/ws/s2/agents/main';

    const filler = 'y'.repeat(250_000);
    const body = `${Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: 'filler', i, filler })).join('\n')}\n`;
    await storage.write(scope, AGENT_WIRE_RECORD_KEY, Buffer.from(body, 'utf8'));
    await logs.sealCold(scope, AGENT_WIRE_RECORD_KEY, Buffer.byteLength(body, 'utf8'), {
      codec: 'zstd',
      segmentBytes: 1024 * 1024,
    });

    const manifestRaw = await storage.read(scope, `${AGENT_WIRE_RECORD_KEY}.segments.json`);
    const manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as { segments: { key: string }[] };
    const firstSegPath = storage.pathFor(scope, manifest.segments[0]!.key)!;
    await writeFile(firstSegPath, Buffer.from('corrupt-bytes'));

    const { service: workers } = createInlineCpuWorkers();
    const reader = new PersistedGoalReader(logs, docs, storage, workers);
    await expect(reader.readReady(scope)).rejects.toThrow(StorageError);
  });
});
