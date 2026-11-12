import { execFileSync } from 'node:child_process';
import { access, appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { TranscriptService } from '../src/services/transcript/transcriptService';
import { HistoryNavigation } from '../src/services/history/historyNavigation';

const BASELINE = 'cac800c750';
const COMPARE_V2 = process.env['KIKI_HISTORY_NAVIGATION_BENCHMARK'] === '1';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRATCH_DIR = join(ROOT, '.tmp');
const HISTORY_DIR = fileURLToPath(new URL('../src/services/history/', import.meta.url));
const SESSION = 'synthetic-session';
const AGENT = 'main';
const WORKSPACE = 'synthetic-workspace';
const INITIAL_TURNS = 10_000;
const MAX_SCAN_BYTES = 8 << 20;

interface ScanResult {
  readonly complete: boolean;
  readonly nextByteOffset: number;
  readonly ordinal: number;
  readonly bytesRead: number;
  readonly recordsRead: number;
}

interface NavigationBaselineModules {
  readonly HistoryNavigationDb: { lazy(path: string): { close(): Promise<void> } };
  readonly HistoryLocatorStore: new (store: unknown, transcript: TranscriptService) => {
    scan(session: string, agent: string): Promise<ScanResult | undefined>;
  };
}

interface DelayMetrics {
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly samples: number;
  readonly monitorP99Ms: number;
  readonly monitorMaxMs: number;
}

interface Timed<T> extends DelayMetrics {
  readonly result: T;
  readonly wallMs: number;
}

function wireLine(record: Record<string, unknown>): string { return `${JSON.stringify(record)}\n`; }

function turnWire(turnId: number): string {
  const stepUuid = `step-${turnId}`;
  return [
    wireLine({ type: 'turn.prompt', turnId, promptId: `prompt-${turnId}`, origin: { kind: 'user' },
      input: [{ type: 'text', text: `Search history for synthetic request ${turnId}` }], time: 1_800_000_000_000 + turnId }),
    wireLine({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId, step: 1, uuid: stepUuid },
      time: 1_800_000_000_001 + turnId }),
    wireLine({ type: 'context.append_loop_event', event: { type: 'content.part', turnId, stepUuid,
      uuid: `frame-${turnId}`, part: { type: 'text', text: `Synthetic assistant answer for turn ${turnId}` } },
      time: 1_800_000_000_002 + turnId }),
    wireLine({ type: 'turn.ended', turnId, reason: 'completed', time: 1_800_000_000_003 + turnId }),
  ].join('');
}

async function writeSyntheticWire(path: string, start: number, count: number, append: boolean): Promise<void> {
  const contents = Array.from({ length: count }, (_unused, index) => turnWire(start + index)).join('');
  if (append) await appendFile(path, contents);
  else await writeFile(path, contents);
}

function transcriptStub(wirePath: string): TranscriptService & { readonly callbackCalls: () => number } {
  let callbackCalls = 0;
  const unexpectedCallback = async (): Promise<never> => {
    callbackCalls += 1;
    throw new Error('scan unexpectedly requested a cold-history callback');
  };
  return {
    historyWireLocation: async (sessionId: string, agentId: string) => {
      if (sessionId !== SESSION || agentId !== AGENT) throw new Error('unexpected history locator');
      return { workspaceId: WORKSPACE, wirePath };
    },
    detailCacheBudgetBytes: () => 64 << 20,
    readRetainedColdTurn: unexpectedCallback,
    readColdWindowTurn: unexpectedCallback,
    readProjectedColdTurn: unexpectedCallback,
    callbackCalls: () => callbackCalls,
  } as unknown as TranscriptService & { readonly callbackCalls: () => number };
}

function rewriteBaselineImports(source: string, outputPath: string, overrides: ReadonlyMap<string, string>): string {
  const outputDir = dirname(outputPath);
  return source.replaceAll(/\bfrom\s+(['"])(\.{1,2}\/[^'"]+)\1/gu, (_match, quote: string, specifier: string) => {
    const resolved = overrides.get(specifier) ?? resolve(HISTORY_DIR, specifier);
    const target = extname(resolved) === '' ? `${resolved}.ts` : resolved;
    const mapped = relative(outputDir, target).replaceAll('\\', '/');
    const modulePath = mapped.startsWith('./') || mapped.startsWith('../') ? mapped : `./${mapped}`;
    return `from ${quote}${modulePath}${quote}`;
  }).replaceAll(/\bfrom\s+(['"])@kiki\/([^/'"]+)(\/[^'"]*)?\1/gu,
    (_match, quote: string, packageName: string, subpath = '') => {
      const exportedSubpath = packageName === 'transcript' && subpath === '/navigationWireAdapter'
        ? 'facts/navigationWireAdapter' : subpath.slice(1) || 'index';
      const sourcePath = resolve(ROOT, 'packages', packageName, 'src', `${exportedSubpath}.ts`);
      const mapped = relative(outputDir, sourcePath).replaceAll('\\', '/');
      const modulePath = mapped.startsWith('./') || mapped.startsWith('../') ? mapped : `./${mapped}`;
      return `from ${quote}${modulePath}${quote}`;
    });
}

function gitShow(path: string): string {
  return execFileSync('git', ['show', `${BASELINE}:${path}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function loadBaselineModules(paths: readonly [string, string, string]): Promise<NavigationBaselineModules> {
  await mkdir(SCRATCH_DIR, { recursive: true });
  const [dbPath, locatorPath, statePath] = paths;
  const dbSource = gitShow('packages/kap-server/src/services/history/historyNavigationDb.ts');
  const locatorSource = gitShow('packages/kap-server/src/services/history/historyLocatorStore.ts');
  const stateSource = gitShow('packages/kap-server/src/services/history/historyNavigationState.ts');
  await writeFile(statePath, rewriteBaselineImports(stateSource, statePath, new Map()));
  await writeFile(locatorPath, rewriteBaselineImports(locatorSource, locatorPath, new Map([
    ['./historyNavigationDb', dbPath],
  ])));
  await writeFile(dbPath, rewriteBaselineImports(dbSource, dbPath, new Map([
    ['./historyNavigationState', statePath],
    ['./historyLocatorStore', locatorPath],
  ])));
  const [db, locator] = await Promise.all([import(pathToFileURL(dbPath).href), import(pathToFileURL(locatorPath).href)]);
  return { HistoryNavigationDb: db['HistoryNavigationDb'], HistoryLocatorStore: locator['HistoryLocatorStore'] } as NavigationBaselineModules;
}

function indexedRows(path: string, session: string): number {
  const db = new DatabaseSync(path);
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const query = version >= 3
      ? 'SELECT count(*) AS count FROM rows r JOIN scopes s ON s.id=r.scope WHERE s.workspace=? AND s.session=? AND s.agent=? AND r.active=1'
      : 'SELECT count(*) AS count FROM rows WHERE workspace=? AND session=? AND agent=? AND active=1';
    return (db.prepare(query).get(WORKSPACE, session, AGENT) as { count: number }).count;
  } finally { db.close(); }
}

async function checkpointedDatabaseBytes(path: string): Promise<number> {
  const db = new DatabaseSync(path);
  try {
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
    expect(checkpoint.busy).toBe(0);
  } finally { db.close(); }
  return (await stat(path)).size;
}

function immediateSampler(): { stop(): Pick<DelayMetrics, 'p99Ms' | 'maxMs' | 'samples'> } {
  let stopped = false;
  let previous = performance.now();
  let iterations = 0;
  const samples: number[] = [];
  const tick = (): void => {
    if (stopped) return;
    const now = performance.now();
    samples.push(now - previous);
    previous = now;
    iterations += 1;
    if (iterations % 1000 === 0) {
      setTimeout(() => {
        if (stopped) return;
        previous = performance.now();
        setImmediate(tick);
      }, 1);
    } else setImmediate(tick);
  };
  setImmediate(tick);
  return {
    stop: () => {
      stopped = true;
      const ordered = samples.toSorted((a, b) => a - b);
      let maxMs = 0;
      for (const sample of samples) maxMs = Math.max(maxMs, sample);
      return { p99Ms: ordered[Math.max(0, Math.ceil(ordered.length * 0.99) - 1)] ?? 0,
        maxMs, samples: samples.length };
    },
  };
}

async function idleEventLoop(): Promise<DelayMetrics> {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const sampler = immediateSampler();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const immediate = sampler.stop();
  const metrics = { ...immediate, monitorP99Ms: delay.percentile(99) / 1e6, monitorMaxMs: delay.max / 1e6 };
  delay.disable();
  return metrics;
}

async function timed<T>(run: () => Promise<T>): Promise<Timed<T>> {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const sampler = immediateSampler();
  const started = performance.now();
  try {
    const result = await run();
    const wallMs = performance.now() - started;
    const immediate = sampler.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { result, wallMs, ...immediate,
      monitorP99Ms: delay.percentile(99) / 1e6, monitorMaxMs: delay.max / 1e6 };
  } finally { sampler.stop(); delay.disable(); }
}

async function scanToCompletion(scan: () => Promise<ScanResult | undefined>): Promise<ScanResult> {
  let result: ScanResult | undefined;
  let bytesRead = 0;
  let recordsRead = 0;
  let previousOffset = -1;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    result = await scan();
    if (result === undefined) throw new Error('history navigation returned no scan result');
    bytesRead += result.bytesRead;
    recordsRead += result.recordsRead;
    if (result.complete) return { ...result, bytesRead, recordsRead };
    if (result.nextByteOffset <= previousOffset) throw new Error('history navigation scan stopped before EOF');
    previousOffset = result.nextByteOffset;
  }
  throw new Error('history navigation scan exceeded sixteen slices');
}

function nextTurn(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

async function assertRemoved(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('history navigation worker', () => {
  it('indexes a large wire without blocking the caller and survives cancellation, close and reopen', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-worker-'));
    const wirePath = join(home, 'wire.jsonl');
    const baselineDbPath = join(home, 'v2-navigation.sqlite');
    const workerDbPath = join(home, 'worker-navigation.sqlite');
    const nonce = `${process.pid}-${Math.random().toString(16).slice(2)}`;
    const baselineDbModulePath = join(SCRATCH_DIR, `historyNavigationDb.v2-${nonce}.ts`);
    const baselineLocatorModulePath = join(SCRATCH_DIR, `historyLocatorStore.v2-${nonce}.ts`);
    const baselineStateModulePath = join(SCRATCH_DIR, `historyNavigationState.v2-${nonce}.ts`);
    const baselineModulePaths = [baselineDbModulePath, baselineLocatorModulePath, baselineStateModulePath] as const;
    const transcript = transcriptStub(wirePath);
    let baselineStore: { close(): Promise<void> } | undefined;
    let navigation: HistoryNavigation | undefined;
    let homeRemoved = false;
    const removedBaselineModules = new Set<string>();
    try {
      await writeSyntheticWire(wirePath, 0, INITIAL_TURNS, false);
      const wireBytes = (await stat(wirePath)).size;
      const wireRecords = INITIAL_TURNS * 4;
      expect(wireBytes).toBeLessThan(MAX_SCAN_BYTES);

      const idleBaseline = await idleEventLoop();
      const baseline = COMPARE_V2 ? await (async () => {
        const modules = await loadBaselineModules(baselineModulePaths);
        baselineStore = modules.HistoryNavigationDb.lazy(baselineDbPath);
        const locator = new modules.HistoryLocatorStore(baselineStore, transcript);
        const measured = await timed(() => scanToCompletion(() => locator.scan(SESSION, AGENT)));
        const rows = indexedRows(baselineDbPath, SESSION);
        expect(measured.result).toMatchObject({ complete: true, recordsRead: wireRecords, nextByteOffset: wireBytes });
        await baselineStore.close();
        baselineStore = undefined;
        return { ...measured, rows, sqliteBytes: await checkpointedDatabaseBytes(baselineDbPath) };
      })() : undefined;

      await writeFile(wirePath, '');
      navigation = new HistoryNavigation(workerDbPath, transcript);
      const warmup = await navigation.scan(SESSION, AGENT);
      expect(warmup).toMatchObject({ complete: true, nextByteOffset: 0, recordsRead: 0 });
      await writeSyntheticWire(wirePath, 0, INITIAL_TURNS, false);
      const worker = await timed(() => scanToCompletion(() => navigation!.scan(SESSION, AGENT)));
      const workerRows = indexedRows(workerDbPath, SESSION);
      expect(worker.result.complete).toBe(true);
      expect(worker.result.recordsRead).toBe(wireRecords);
      expect(worker.result.nextByteOffset).toBe(wireBytes);
      expect(workerRows).toBe(INITIAL_TURNS * 3);
      if (baseline !== undefined) {
        expect(workerRows).toBe(baseline.rows);
        expect(worker.result.ordinal).toBe(baseline.result.ordinal);
      }
      expect(transcript.callbackCalls()).toBe(0);
      await navigation.close();
      navigation = undefined;
      const workerSqliteBytes = await checkpointedDatabaseBytes(workerDbPath);
      const sqliteByteRatio = baseline === undefined ? undefined : workerSqliteBytes / baseline.sqliteBytes;
      console.log(`[history-navigation-benchmark] ${JSON.stringify({ sourceBytes: wireBytes, sourceRecords: wireRecords,
        idleBaseline, baseline,
        worker: { rows: workerRows, bytesRead: worker.result.bytesRead, sqliteBytes: workerSqliteBytes,
          wallMs: worker.wallMs, eventLoopP99Ms: worker.p99Ms, eventLoopMaxMs: worker.maxMs,
          eventLoopSamples: worker.samples, monitorEventLoopP99Ms: worker.monitorP99Ms,
          monitorEventLoopMaxMs: worker.monitorMaxMs },
        sqliteByteRatio, sqliteShrinkPercent: sqliteByteRatio === undefined ? undefined : (1 - sqliteByteRatio) * 100 })}`);
      if (sqliteByteRatio !== undefined) expect(sqliteByteRatio).toBeLessThan(0.8);

      navigation = new HistoryNavigation(workerDbPath, transcript);
      const reopened = await navigation.scan(SESSION, AGENT);
      expect(reopened).toMatchObject({ complete: true, nextByteOffset: wireBytes, recordsRead: 0 });
      expect(indexedRows(workerDbPath, SESSION)).toBe(workerRows);

      await writeSyntheticWire(wirePath, INITIAL_TURNS, 12_000, true);
      const queuedAbort = new AbortController();
      const activeScan = navigation.scan(SESSION, AGENT);
      await nextTurn();
      let activeSettled = false;
      void activeScan.then(() => { activeSettled = true; }, () => { activeSettled = true; });
      const queuedScan = navigation.scan(SESSION, AGENT, queuedAbort.signal);
      await nextTurn();
      expect(activeSettled).toBe(false);
      queuedAbort.abort();
      await expect(queuedScan).rejects.toMatchObject({ name: 'AbortError' });
      const activeResult = await activeScan;
      expect(activeResult?.complete).toBe(false);
      const completedAppend = await scanToCompletion(() => navigation!.scan(SESSION, AGENT));
      expect(completedAppend.complete).toBe(true);
      expect(indexedRows(workerDbPath, SESSION)).toBeGreaterThan(workerRows);

      await writeSyntheticWire(wirePath, INITIAL_TURNS + 12_000, 8_000, true);
      const activeAbort = new AbortController();
      const cancelledActive = navigation.scan(SESSION, AGENT, activeAbort.signal);
      await nextTurn();
      activeAbort.abort();
      await expect(cancelledActive).rejects.toMatchObject({ name: 'AbortError' });
      const recovered = await scanToCompletion(() => navigation!.scan(SESSION, AGENT));
      expect(recovered.complete).toBe(true);
      expect(indexedRows(workerDbPath, SESSION)).toBeGreaterThan(60_000);
      expect(transcript.callbackCalls()).toBe(0);

      await navigation.close();
      navigation = undefined;
      await rm(home, { recursive: true, force: true });
      homeRemoved = true;
      await assertRemoved(home);
      await Promise.all(baselineModulePaths.map(async (path) => {
        await rm(path, { force: true });
        removedBaselineModules.add(path);
        await assertRemoved(path);
      }));
      expect(worker.p99Ms).toBeLessThan(10);
    } finally {
      try { await navigation?.close(); }
      finally {
        try { await baselineStore?.close(); }
        finally {
          const cleanup = [
            ...(homeRemoved ? [] : [rm(home, { recursive: true, force: true })]),
            ...baselineModulePaths.filter(path => !removedBaselineModules.has(path)).map(path => rm(path, { force: true })),
          ];
          await Promise.all(cleanup);
        }
      }
    }
  }, 120_000);
});

describe('history navigation worker boundaries', () => {
  it('cancels source admission before a worker opens and closes with an unresolved locator', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-admission-'));
    const transcript = {
      historyWireLocation: () => new Promise<never>(() => undefined),
      detailCacheBudgetBytes: () => 0,
    } as unknown as TranscriptService;
    const navigation = new HistoryNavigation(join(home, 'navigation.sqlite'), transcript);
    try {
      const controller = new AbortController();
      const read = navigation.scan(SESSION, AGENT, controller.signal);
      controller.abort();
      await expect(read).rejects.toMatchObject({ name: 'AbortError' });
      const pending = navigation.scan(SESSION, AGENT);
      const rejected = expect(pending).rejects.toThrow('closed');
      await navigation.close();
      await rejected;
    } finally { await navigation.close(); await rm(home, { recursive: true, force: true }); }
  });

  it('keeps cold tail folding in the worker and retains failure proofs by real resident identity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'history-navigation-canonical-worker-'));
    const wirePath = join(home, 'wire.jsonl');
    let projectedCalls = 0;
    const source = { ...transcriptStub(wirePath),
      readRetainedColdTurn: async () => undefined,
      readColdWindowTurn: async () => undefined,
      readProjectedColdTurn: async () => { projectedCalls += 1; throw new Error('main-thread fold'); },
    } as unknown as TranscriptService;
    const navigation = new HistoryNavigation(join(home, 'navigation.sqlite'), source);
    try {
      await writeFile(wirePath, wireLine({ type: 'note', padding: 'x'.repeat(1 << 20) }).repeat(9) + turnWire(15));
      const result = await navigation.readCanonicalEntity(SESSION, AGENT, { kind: 'turn', id: 't15' }, new AbortController().signal);
      expect(result.status).toBe('found');
      expect(projectedCalls).toBe(0);
      expect(navigation.canonicalReadReport().projectionRecords).toBeLessThan(13);
      await scanToCompletion(() => navigation.scan(SESSION, AGENT));
      if (result.status !== 'found') throw new Error('missing canonical turn');
      const resident = result.entity as import('@kiki/transcript').TranscriptTurn;
      const mismatched = { ...resident, prompt: 'different resident content' };
      const signal = new AbortController().signal;
      const proof = await navigation.prepareResidentProof(SESSION, AGENT, signal);
      expect(proof).toBeDefined();
      expect(await proof!.prove(mismatched, signal)).toEqual({ status: 'mismatch' });
      const pages = navigation.canonicalReadReport().proofPages;
      expect(await proof!.prove(mismatched, signal)).toEqual({ status: 'mismatch' });
      expect(navigation.canonicalReadReport()).toMatchObject({ proofPages: pages, proofSkipped: 1 });
      const verified = await proof!.prove(resident, signal);
      expect(verified.status).toBe('found');
      if (verified.status === 'found') expect(verified.snapshot.items[0]).toBe(resident);
      const directory = await navigation.lookupDirectory(WORKSPACE, SESSION, AGENT, 15);
      expect(directory.status).toBe('ok');
      if (directory.status === 'ok') expect(await navigation.readBlocks(directory.ref, 16000)).toMatchObject({ status: 'ok' });
      const internal = navigation as unknown as { worker: { worker: import('node:worker_threads').Worker } };
      await internal.worker.worker.terminate();
      expect(await navigation.scan(SESSION, AGENT)).toMatchObject({ complete: true, recordsRead: 0 });
    } finally { await navigation.close(); await rm(home, { recursive: true, force: true }); }
  });
});
