import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { Emitter, Event } from '#/_base/event';
import { RESOURCE_DEFAULTS, resourceDefaults } from '#/_base/node/resourceDefaults';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { CpuWorkersConfigSchema } from '#/app/cpuWorker/configSection';
import { RequestGovernanceConfigSchema } from '#/app/requestGovernance/configSection';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { SessionManager } from '#/app/sessionManager/sessionManagerService';
import { DEFAULT_SESSION_RESIDENCY_CONFIG, SessionResidencyConfigSchema, type SessionResidencyConfig } from '#/app/sessionManager/configSection';
import type { SessionClosedEvent, SessionCreatedEvent } from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

const GiB = 1024 ** 3;

it.each([
  { parallelism: 1, gib: 4, workers: 1, heap: 512, sessions: 32 },
  { parallelism: 8, gib: 16, workers: 7, heap: 512, sessions: 128 },
  { parallelism: 20, gib: 32, workers: 16, heap: 512, sessions: 256 },
  { parallelism: 20, gib: 64, workers: 16, heap: 1024, sessions: 512 },
])('sizes defaults for $parallelism CPUs / $gib GiB', ({ parallelism, gib, workers, heap, sessions }) => {
  const value = resourceDefaults({ parallelism, memoryBytes: gib * GiB });
  expect(value.cpuWorkers).toBe(workers);
  expect(value.workerHeapMb).toBe(heap);
  expect(value.liveSessions).toBe(sessions);
  expect(value.workerQueue).toBeGreaterThanOrEqual(128);
  expect(value.cpuWorkers * heap * 1024 ** 2).toBeLessThanOrEqual(gib * GiB / 4);
});

it('caps worker heap, CPU workers, and search indexer budgets on Android and mobile profiles', () => {
  for (const hardware of [
    { parallelism: 8, memoryBytes: 12 * GiB, platform: 'android', env: {} },
    { parallelism: 8, memoryBytes: 8 * GiB, platform: 'linux', env: { KIKI_PLATFORM: 'android' } },
    { parallelism: 6, memoryBytes: 6 * GiB, platform: 'linux', env: { KIKI_RUNTIME_PROFILE: 'mobile' } },
  ]) {
    const value = resourceDefaults(hardware);
    expect(value.workerHeapMb).toBe(96);
    expect(value.cpuWorkers).toBe(2);
    expect(value.searchIndexerSoftMb).toBe(160);
    expect(value.searchIndexerHardMb).toBe(256);
  }
  const dualCoreMobile = resourceDefaults({ parallelism: 2, memoryBytes: 4 * GiB, platform: 'android', env: {} });
  expect(dualCoreMobile.cpuWorkers).toBe(1);
  expect(dualCoreMobile.workerHeapMb).toBe(96);
});

it('keeps explicit resource choices above old schema caps and preserves uncapped provider rules', () => {
  expect(CpuWorkersConfigSchema.parse({ maxWorkers: 200, maxQueue: 5000, maxQueuedBytes: GiB })).toMatchObject({ maxWorkers: 200, maxQueue: 5000, maxQueuedBytes: GiB, timeoutMs: 30_000 });
  expect(SessionResidencyConfigSchema.parse({ maxLiveSessions: 1000, maxConcurrentRestores: 100, maxQueuedRestores: 5000, idleTtlMs: 172_800_000 })).toMatchObject({ maxLiveSessions: 1000, maxConcurrentRestores: 100, maxQueuedRestores: 5000 });
  expect(RequestGovernanceConfigSchema.parse({ maxQueueSize: 77, rules: [] })).toMatchObject({ maxQueueSize: 77, maxWaitMs: 300_000, rules: [] });
  expect(DEFAULT_SESSION_RESIDENCY_CONFIG.maxResidentHeapBytes).toBeLessThanOrEqual(getHeapStatistics().heap_size_limit * 0.6);
});

async function residencyFixture(home: string, configured: SessionResidencyConfig) {
  const didCreate = new Emitter<SessionCreatedEvent>();
  const didClose = new Emitter<SessionClosedEvent>();
  const handles = new Map<string, ISessionScopeHandle>();
  let restores = 0;
  let active = 0;
  let peak = 0;
  const controller = {
    onWillCreateSession: Event.None, onDidCreateSession: didCreate.event,
    onWillCloseSession: Event.None, onDidCloseSession: didClose.event,
    onDidArchiveSession: Event.None, onDidForkSession: Event.None,
    resume: async (sessionId: string) => {
      const existing = handles.get(sessionId);
      if (existing !== undefined) return existing;
      restores++;
      peak = Math.max(peak, ++active);
      try {
        const body = JSON.parse(await readFile(join(home, `${sessionId}.json`), 'utf8')) as { text: string };
        await new Promise(resolve => setTimeout(resolve, 10));
        const handle = { id: sessionId, body } as unknown as ISessionScopeHandle;
        handles.set(sessionId, handle);
        didCreate.fire({ sessionId, handle, source: 'resume' });
        return handle;
      } finally { active--; }
    },
    unload: async (sessionId: string, canCommit?: () => boolean) => {
      if (canCommit?.() === false) return false;
      handles.delete(sessionId);
      didClose.fire({ sessionId, reason: 'evict' });
      return true;
    },
    close: async (sessionId: string) => { handles.delete(sessionId); didClose.fire({ sessionId }); },
    dispose: () => { handles.clear(); },
  } as unknown as SessionLifecycleService;
  const workspace = { id: 'fixture', program: { sessionControllerGeneration: 'fixture', createSessionController: () => controller } } as unknown as WorkspaceInstance;
  const disposables = new DisposableStore();
  const services = createServices(disposables, { additionalServices: reg => {
    reg.definePartialInstance(IWorkspaceInstanceManager, { acquire: async () => ({ instance: workspace, dispose: () => {} }), get: () => workspace });
    reg.definePartialInstance(ISessionIndex, { get: async () => ({ workspaceId: workspace.id, cwd: home }) as Awaited<ReturnType<ISessionIndex['get']>> });
    reg.definePartialInstance(IConfigService, { ready: Promise.resolve(), get: (() => configured) as IConfigService['get'] });
    reg.definePartialInstance(IFlagService, { enabled: () => true });
    reg.define(ISessionManager, SessionManager);
  } });
  return { manager: services.get(ISessionManager), close: () => disposables.dispose(), metrics: () => ({ restores, peak }) };
}

async function measure(home: string, configured: SessionResidencyConfig, concurrent: boolean) {
  const fixture = await residencyFixture(home, configured);
  const elapsed: number[] = [];
  const initialMemory = process.memoryUsage();
  let peakHeap = initialMemory.heapUsed;
  let peakRss = initialMemory.rss;
  const sampleMemory = () => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); };
  const sample = setInterval(sampleMemory, 5);
  const started = performance.now();
  try {
    const resume = async (index: number) => {
      const start = performance.now();
      try { await fixture.manager.resume(`session-${index}`); return true; }
      catch { return false; }
      finally { elapsed.push(performance.now() - start); }
    };
    const successes = concurrent
      ? (await Promise.all(Array.from({ length: 100 }, (_, index) => resume(index)))).filter(Boolean).length
      : await (async () => { for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 100; i++) expect(await resume(i)).toBe(true); return 200; })();
    elapsed.sort((a, b) => a - b);
    const report = fixture.manager.residencyReport!();
    sampleMemory();
    return { initialHeapMiB: Math.round(initialMemory.heapUsed / 1024 ** 2), initialRssMiB: Math.round(initialMemory.rss / 1024 ** 2), successes, elapsedMs: Math.round(performance.now() - started), p99Ms: Math.round(elapsed[Math.ceil(elapsed.length * 0.99) - 1]!), ...fixture.metrics(), live: report.liveSessions, evictions: report.evictionSuccesses, peakHeapMiB: Math.round(peakHeap / 1024 ** 2), peakRssMiB: Math.round(peakRss / 1024 ** 2) };
  } finally { clearInterval(sample); await fixture.close(); }
}

describe('100-session resource policy fixture', () => {
  it('admits cold bursts and retains a revisited idle working set', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-resource-home-'));
    const old = { idleTtlMs: 600_000, minIdleMs: 0, maxLiveSessions: 8, maxConcurrentRestores: 4, maxQueuedRestores: 8, maxResidentHeapBytes: 1536 * 1024 ** 2 };
    const hardware = process.env['KIKI_RESOURCE_BENCHMARK_NATIVE'] === '1' ? RESOURCE_DEFAULTS : resourceDefaults({ parallelism: 8, memoryBytes: 16 * GiB });
    const next = { ...DEFAULT_SESSION_RESIDENCY_CONFIG, maxLiveSessions: hardware.liveSessions, maxConcurrentRestores: hardware.cpuWorkers, maxQueuedRestores: hardware.queuedRestores, minIdleMs: 0 };
    try {
      const text = 'fixture history '.repeat(8192);
      await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(home, `session-${index}.json`), JSON.stringify({ text: `${index}:${text}` }))));
      const oldBurst = await measure(home, old, true);
      const nextBurst = await measure(home, next, true);
      const oldRevisit = await measure(home, old, false);
      const nextRevisit = await measure(home, next, false);
      const result = { resourcePolicyBenchmark: { hardwareDefaults: hardware, oldBurst, nextBurst, oldRevisit, nextRevisit } };
      const output = process.env['KIKI_RESOURCE_BENCHMARK_OUTPUT'];
      if (output !== undefined) await writeFile(output, JSON.stringify(result, null, 2));
      expect(oldBurst.successes).toBe(12);
      expect(nextBurst.successes).toBe(100);
      expect(nextBurst.peak).toBeLessThanOrEqual(next.maxConcurrentRestores);
      expect(oldRevisit.evictions).toBe(192);
      expect(oldRevisit.restores).toBe(200);
      expect(nextRevisit.evictions).toBe(0);
      expect(nextRevisit.restores).toBe(100);
      expect(nextRevisit.live).toBe(100);
    } finally { await rm(home, { recursive: true, force: true }); }
  }, 30_000);
});
