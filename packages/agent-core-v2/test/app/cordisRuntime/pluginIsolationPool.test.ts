import { setInterval, clearInterval } from 'node:timers';
import { serialize } from 'node:v8';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { PluginIsolationPoolService } from '../../../src/app/cordisRuntime/pluginIsolationPoolService';

const fixturePath = fileURLToPath(new URL('./fixtures/isolation-plugin.mjs', import.meta.url));
const ghostWorkerPath = new URL('./fixtures/ghost-identity-worker.mjs', import.meta.url);
const pools: PluginIsolationPoolService[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.dispose()));
});

function makePool(
  budget: ConstructorParameters<typeof PluginIsolationPoolService>[0] = {},
  entry?: URL,
) {
  const pool = new PluginIsolationPoolService({
    callTimeoutMs: 30_000,
    oldSpaceMb: 128,
    ...budget,
  }, entry);
  pools.push(pool);
  return pool;
}

function register(pool: PluginIsolationPoolService, pluginId = 'fixture-plugin') {
  return pool.registerWorkerPlugin({ pluginId, entryPath: fixturePath, settings: { fixture: true } });
}

function invoke<TPayload, TResult>(
  pool: PluginIsolationPoolService,
  pluginId: string,
  generation: number,
  slot: string,
  payload: TPayload,
  timeoutMs?: number,
) {
  return pool.invoke<TPayload, TResult>({ pluginId, generation, slot, payload, timeoutMs });
}

describe('plugin isolation worker pool', () => {
  it('keeps the parent event loop live and replaces a timed-out worker before the next request', async () => {
    const pool = makePool({ maxWorkers: 1, maxActiveRequests: 1 });
    const registration = await register(pool);
    const warm = await invoke<{ value: string }, { payload: { value: string }; threadId: number }>(
      pool, 'fixture-plugin', registration.generation, 'echo', { value: 'warm' },
    );
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 10);

    try {
      await expect(invoke<null, never>(
        pool, 'fixture-plugin', registration.generation, 'spin', null, 750,
      )).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      clearInterval(ticker);
    }

    expect(ticks).toBeGreaterThan(1);
    const recovered = await invoke<{ value: string }, { payload: { value: string }; threadId: number }>(
      pool, 'fixture-plugin', registration.generation, 'echo', { value: 'after-timeout' },
    );
    expect(recovered.value).toMatchObject({ payload: { value: 'after-timeout' } });
    expect(recovered.value.threadId).not.toBe(warm.value.threadId);
  }, 60_000);

  it('bounds the waiting request count while one handler is active', async () => {
    const pool = makePool({
      maxWorkers: 1,
      maxActiveRequests: 1,
      maxQueuedRequests: 1,
      maxQueuedBytes: 16_384,
      maxPayloadBytes: 16_384,
    });
    const registration = await register(pool);
    const active = invoke(pool, 'fixture-plugin', registration.generation, 'wait', { delayMs: 200 });
    const queued = invoke(pool, 'fixture-plugin', registration.generation, 'wait', { delayMs: 0 });

    await expect(invoke(pool, 'fixture-plugin', registration.generation, 'echo', 'overflow'))
      .rejects.toMatchObject({ code: 'queue_full' });
    await Promise.all([active, queued]);
  }, 30_000);

  it('bounds queued bytes independently of the request-count limit', async () => {
    const pluginId = 'byte-limited-plugin';
    const generation = 1;
    const smallPayload = { delayMs: 0, tag: 'small' };
    const largePayload = { delayMs: 0, tag: 'x'.repeat(2048) };
    const smallBytes = serialize({ pluginId, generation, slot: 'wait', payload: smallPayload }).byteLength;
    const pool = makePool({
      maxWorkers: 1,
      maxActiveRequests: 1,
      maxQueuedRequests: 3,
      maxQueuedBytes: smallBytes,
      maxPayloadBytes: 8192,
    });
    const registration = await register(pool, pluginId);
    const active = invoke(pool, pluginId, registration.generation, 'wait', { delayMs: 200 });
    const queued = invoke(pool, pluginId, registration.generation, 'wait', smallPayload);

    await expect(invoke(pool, pluginId, registration.generation, 'wait', largePayload))
      .rejects.toMatchObject({ code: 'queue_full' });
    await Promise.all([active, queued]);
  }, 30_000);

  it('rejects stale generations after plugin replacement and serves the new generation', async () => {
    const pool = makePool({ maxWorkers: 1, maxActiveRequests: 1 });
    const previous = await register(pool, 'replaceable-plugin');
    await invoke(pool, 'replaceable-plugin', previous.generation, 'echo', 'before-replacement');
    const current = await register(pool, 'replaceable-plugin');

    expect(current.generation).toBe(previous.generation + 1);
    await expect(invoke(pool, 'replaceable-plugin', previous.generation, 'echo', 'stale'))
      .rejects.toMatchObject({ code: 'revoked' });
    await expect(invoke(pool, 'replaceable-plugin', current.generation, 'echo', 'current'))
      .resolves.toMatchObject({ generation: current.generation, value: { payload: 'current' } });
  }, 30_000);

  it.each(['attemptId', 'conversationRevision'] as const)(
    'rejects a ghost worker response with mismatched %s',
    async (mismatch) => {
      const pluginId = `ghost-${mismatch}`;
      const pool = makePool({ maxWorkers: 1, maxActiveRequests: 1 }, ghostWorkerPath);
      const registration = await pool.registerWorkerPlugin({
        pluginId,
        entryPath: fixturePath,
        settings: { mismatch },
      });

      await expect(pool.invoke({
        pluginId,
        generation: registration.generation,
        slot: 'echo',
        attemptId: 'attempt-current',
        conversationRevision: 17,
        payload: { value: 'current request' },
      })).rejects.toMatchObject({ code: 'stale_result' });
    },
  );
});
