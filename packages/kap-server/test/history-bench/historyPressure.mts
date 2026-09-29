import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { digestWireBytes, WIRE_TRANSCRIPT_RECEIPT_KEY } from '../../../agent-core-v2/src/wire/transcriptReceipt';
import { streamWireRecords, type ContextRecord } from '../../../transcript-live/src/wireRecords';

const TARGET_BYTES = 238_000_000;
const MIB = 1 << 20;
const MID_NEEDLE = 'history-pressure-needle-over-2mib';
const TAIL_NEEDLE = 'history-pressure-needle-deep-tail';
const SESSION_ID = 'history-pressure-session';
const WORKSPACE_ID = 'history-pressure-workspace';
const AGENT_ID = 'main';
const TEXT_CHARS = 8_192;
const CHUNK_BYTES = 1 << 20;
const FILLER = 'synthetic transcript history benchmark filler ';
const RESULT_PREFIX = 'HISTORY_BENCH_RESULT ';
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RAW_LOADER = pathToFileURL(join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs')).href;
const CORE_TSCONFIG = join(REPO_ROOT, 'packages', 'agent-core-v2', 'tsconfig.json');

type Fixture = {
  home: string;
  wirePath: string;
  bytes: number;
  records: number;
  turns: number;
  midTurn: number;
  tailTurn: number;
};

type BenchResult = {
  case: string;
  api: string;
  status: 'ok' | 'error';
  bytesRead?: number;
  records?: number;
  latencyMs?: number;
  startRssBytes?: number;
  beforeImportRssBytes?: number;
  afterImportRssBytes?: number;
  afterReadRssBytes?: number;
  osHighWaterRssBytes?: number;
  peakRssBytes?: number;
  rssDeltaBytes?: number;
  complete?: boolean;
  incompleteReason?: string;
  matches?: Record<string, { records: number[]; turnIds: number[] }>;
  selectedTurn?: number;
  needle?: string;
  needleFound?: boolean;
  outputChars?: number;
  segments?: number;
  error?: string;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function textWithNeedle(needle: string | undefined): string {
  const prefix = needle === undefined ? '' : `${needle} `;
  const available = Math.max(0, TEXT_CHARS - prefix.length);
  let filler = '';
  while (filler.length < available) filler += FILLER;
  return `${prefix}${filler.slice(0, available)}`;
}

function turnRecords(turnId: number, needle: string | undefined): string[] {
  const stepUuid = `history-pressure-step-${turnId}`;
  const time = turnId * 5_000;
  const records: Record<string, unknown>[] = [
    {
      type: 'turn.prompt',
      turnId,
      promptId: `history-pressure-prompt-${turnId}`,
      input: [{ type: 'text', text: `synthetic history prompt ${turnId}` }],
      origin: { kind: 'user' },
      time: time + 1,
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'step.begin', turnId, step: 1, uuid: stepUuid },
      time: time + 2,
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        turnId,
        stepUuid,
        uuid: `history-pressure-part-${turnId}`,
        part: { type: 'text', text: textWithNeedle(needle) },
      },
      time: time + 3,
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'step.end', turnId, step: 1, uuid: stepUuid },
      time: time + 4,
    },
    { type: 'turn.ended', turnId, reason: 'completed', time: time + 5 },
  ];
  return records.map((record) => `${JSON.stringify(record)}\n`);
}

async function writeFixture(targetBytes: number): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-history-pressure-'));
  const wireDir = join(home, 'sessions', WORKSPACE_ID, SESSION_ID, 'agents', AGENT_ID);
  await mkdir(wireDir, { recursive: true });
  const wirePath = join(wireDir, 'wire.jsonl');
  const handle = await open(wirePath, 'w');
  let bytes = 0;
  let records = 0;
  let turn = 0;
  let midTurn = -1;
  let tailTurn = -1;
  let pending = '';
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    await handle.write(pending);
    pending = '';
  };
  try {
    while (bytes < targetBytes) {
      const needle = midTurn < 0 && bytes >= 4 * MIB
        ? MID_NEEDLE
        : tailTurn < 0 && bytes >= Math.floor(targetBytes * 0.95)
          ? TAIL_NEEDLE
          : undefined;
      if (needle === MID_NEEDLE) midTurn = turn;
      if (needle === TAIL_NEEDLE) tailTurn = turn;
      const lines = turnRecords(turn, needle);
      for (const line of lines) {
        pending += line;
        bytes += Buffer.byteLength(line);
        records += 1;
        if (Buffer.byteLength(pending) >= CHUNK_BYTES) await flush();
      }
      turn += 1;
    }
    await flush();
  } finally {
    await handle.close();
  }
  const actualBytes = (await stat(wirePath)).size;
  const digest = await digestWireBytes(createReadStream(wirePath));
  await writeFile(join(wireDir, WIRE_TRANSCRIPT_RECEIPT_KEY), JSON.stringify({
    format: 1,
    epoch: 'history-pressure-fixture',
    state: 'sealed',
    trusted: true,
    wire: { size: digest.size, sha256: digest.sha256 },
  }));
  if (midTurn < 0 || tailTurn < 0) throw new Error('fixture markers were not placed');
  return { home, wirePath, bytes: actualBytes, records, turns: turn, midTurn, tailTurn };
}

function valueContainsNeedle(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((entry) => valueContainsNeedle(entry, needle));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) => valueContainsNeedle(entry, needle));
  }
  return false;
}

function turnIdOf(record: ContextRecord): number | undefined {
  if (typeof record['turnId'] === 'number') return record['turnId'];
  if (record['event'] !== null && typeof record['event'] === 'object') {
    const turnId = (record['event'] as { turnId?: unknown }).turnId;
    return typeof turnId === 'number' ? turnId : undefined;
  }
  return undefined;
}

function matchesForNeedles(): Record<string, { records: number[]; turnIds: number[] }> {
  return {
    [MID_NEEDLE]: { records: [], turnIds: [] },
    [TAIL_NEEDLE]: { records: [], turnIds: [] },
  };
}

function sampleRss(): number {
  return process.memoryUsage().rss;
}

function recordMatcher(
  matches: Record<string, { records: number[]; turnIds: number[] }>,
  recordIndex: number,
  record: ContextRecord,
): void {
  for (const needle of [MID_NEEDLE, TAIL_NEEDLE]) {
    if (!valueContainsNeedle(record, needle)) continue;
    const entry = matches[needle]!;
    entry.records.push(recordIndex);
    const turnId = turnIdOf(record);
    if (turnId !== undefined && !entry.turnIds.includes(turnId)) entry.turnIds.push(turnId);
  }
}

async function runStreamWorker(caseName: string, wirePath: string, maxBytes: number | undefined): Promise<BenchResult> {
  const matches = matchesForNeedles();
  let recordIndex = 0;
  const startRssBytes = sampleRss();
  let peakRssBytes = startRssBytes;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
  }, 10);
  const started = performance.now();
  try {
    const result = await streamWireRecords(wirePath, {
      chunkBytes: CHUNK_BYTES,
      maxBytes,
      onRecord: (record) => {
        recordIndex += 1;
        recordMatcher(matches, recordIndex, record);
      },
    });
    const latencyMs = performance.now() - started;
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
    return {
      case: caseName,
      api: 'transcript-live.streamWireRecords',
      status: 'ok',
      bytesRead: result.bytesRead,
      records: result.recordCount,
      latencyMs,
      startRssBytes,
      peakRssBytes,
      rssDeltaBytes: peakRssBytes - startRssBytes,
      complete: result.complete,
      incompleteReason: result.incompleteReason,
      matches,
    };
  } catch (error) {
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
    return {
      case: caseName,
      api: 'transcript-live.streamWireRecords',
      status: 'error',
      latencyMs: performance.now() - started,
      startRssBytes,
      peakRssBytes,
      rssDeltaBytes: peakRssBytes - startRssBytes,
      error: String(error),
    };
  } finally {
    clearInterval(sampler);
  }
}

async function runContinuationWorker(caseName: string, wirePath: string): Promise<BenchResult> {
  const matches = matchesForNeedles();
  const startRssBytes = sampleRss();
  let peakRssBytes = startRssBytes;
  let bytesRead = 0;
  let records = 0;
  let cursor = 0;
  let segments = 0;
  let incompleteReason: string | undefined;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
  }, 10);
  const started = performance.now();
  const onRecord = (record: ContextRecord): void => {
    records += 1;
    recordMatcher(matches, records, record);
  };
  try {
    for (;;) {
      const segmentStart = cursor;
      const result = await streamWireRecords(wirePath, {
        chunkBytes: CHUNK_BYTES,
        maxBytes: 2 * MIB,
        startByteOffset: segmentStart,
        onRecord,
      });
      segments += 1;
      bytesRead += result.bytesRead;
      cursor = result.nextByteOffset;
      incompleteReason = result.incompleteReason;
      if (result.complete) break;
      if (cursor <= segmentStart) throw new Error(`continuation made no progress at byte ${segmentStart}`);
      if (segments > 1000) throw new Error('continuation exceeded 1000 segments');
    }
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
    return {
      case: caseName,
      api: 'transcript-live.streamWireRecords',
      status: 'ok',
      bytesRead,
      records,
      latencyMs: performance.now() - started,
      startRssBytes,
      peakRssBytes,
      rssDeltaBytes: peakRssBytes - startRssBytes,
      complete: true,
      incompleteReason,
      segments,
      matches,
    };
  } catch (error) {
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
    return {
      case: caseName,
      api: 'transcript-live.streamWireRecords',
      status: 'error',
      bytesRead,
      records,
      latencyMs: performance.now() - started,
      startRssBytes,
      peakRssBytes,
      rssDeltaBytes: peakRssBytes - startRssBytes,
      segments,
      error: String(error),
    };
  } finally {
    clearInterval(sampler);
  }
}

async function runNavigationImportWorker(): Promise<BenchResult> {
  const beforeImportRssBytes = sampleRss();
  await import('../../src/services/history/historyLocatorStore');
  const afterImportRssBytes = sampleRss();
  const osHighWaterRssBytes = process.resourceUsage().maxRSS * 1024;
  return { case: 'navigation-import', api: 'HistoryLocatorStore.import', status: 'ok',
    beforeImportRssBytes, afterImportRssBytes, osHighWaterRssBytes,
    peakRssBytes: Math.max(afterImportRssBytes, osHighWaterRssBytes) };
}

async function runNavigationWorker(caseName: string, wirePath: string): Promise<BenchResult> {
  const beforeImportRssBytes = sampleRss();
  const { HistoryLocatorStore } = await import('../../src/services/history/historyLocatorStore');
  const afterImportRssBytes = sampleRss();
  const documents = new Map<string, unknown>();
  const queryStore = {
    get: async (collection: string, key: string) => documents.get(`${collection}:${key}`),
    put: async (collection: string, key: string, value: unknown) => { documents.set(`${collection}:${key}`, value); },
    batch: async (ops: readonly { kind: string; collection: string; key: string; value: unknown }[]) => {
      for (const op of ops) if (op.kind === 'put') documents.set(`${op.collection}:${op.key}`, op.value);
    },
  };
  const transcript = { historyWireLocation: async () => ({ wirePath, workspaceId: WORKSPACE_ID }) };
  const nav = new HistoryLocatorStore(queryStore as never, transcript as never);
  const matches = matchesForNeedles();
  const startRssBytes = sampleRss();
  let peakRssBytes = startRssBytes;
  let bytesRead = 0;
  let records = 0;
  let segments = 0;
  const started = performance.now();
  const sampler = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, sampleRss()); }, 10);
  let cursor: { offset: number; incarnation: string } | undefined;
  const asOf = (await stat(wirePath)).size;
  try {
    for (;;) {
      const scan = await nav.scan(SESSION_ID, AGENT_ID, undefined,
        { query: 'history-pressure-needle', mode: 'any', pageSize: 2, asOf, cursor });
      if (scan === undefined) throw new Error('navigation source missing');
      segments += 1;
      bytesRead += scan.bytesRead;
      records += scan.recordsRead;
      for (const hit of scan.hits ?? []) {
        const source = await nav.read(hit.ref!);
        if (source.status !== 'ok') throw new Error(`navigation ref failed: ${source.status}`);
        for (const needle of [MID_NEEDLE, TAIL_NEEDLE]) {
          if (!source.text?.includes(needle)) continue;
          matches[needle]!.turnIds.push(hit.turn!);
          matches[needle]!.records.push(records);
        }
      }
      peakRssBytes = Math.max(peakRssBytes, sampleRss());
      if (scan.complete) break;
      if (scan.nextByteOffset <= (cursor?.offset ?? 0)) throw new Error('navigation made no progress');
      cursor = { offset: scan.nextByteOffset, incarnation: scan.incarnation };
    }
    const afterReadRssBytes = sampleRss();
    const osHighWaterRssBytes = process.resourceUsage().maxRSS * 1024;
    return { case: caseName, api: 'HistoryLocatorStore.scan/read', status: 'ok', bytesRead,
      records, latencyMs: performance.now() - started, beforeImportRssBytes, afterImportRssBytes,
      startRssBytes, afterReadRssBytes, osHighWaterRssBytes,
      peakRssBytes: Math.max(peakRssBytes, afterReadRssBytes, osHighWaterRssBytes),
      rssDeltaBytes: Math.max(peakRssBytes, afterReadRssBytes, osHighWaterRssBytes) - startRssBytes,
      complete: true, matches, segments };
  } catch (error) {
    const afterReadRssBytes = sampleRss();
    const osHighWaterRssBytes = process.resourceUsage().maxRSS * 1024;
    return { case: caseName, api: 'HistoryLocatorStore.scan/read', status: 'error', bytesRead,
      records, latencyMs: performance.now() - started, beforeImportRssBytes, afterImportRssBytes,
      startRssBytes, afterReadRssBytes, osHighWaterRssBytes,
      peakRssBytes: Math.max(peakRssBytes, afterReadRssBytes, osHighWaterRssBytes),
      rssDeltaBytes: Math.max(peakRssBytes, afterReadRssBytes, osHighWaterRssBytes) - startRssBytes,
      matches, segments, error: String(error) };
  } finally { clearInterval(sampler); }
}

async function runCurrentHistoryRead(
  caseName: string,
  homeDir: string,
  selectedTurn: number,
  needle: string,
): Promise<BenchResult> {
  const startRssBytes = sampleRss();
  let peakRssBytes = startRssBytes;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
  }, 10);
  const started = performance.now();
  let service: {
    readColdSnapshot: (sessionId: string, agentId: string) => Promise<unknown>;
    memoryReport: () => unknown;
    dispose: () => void;
  } | undefined;
  try {
    const { ISessionIndex, ISessionManager, IWorkspaceInstanceManager } = await import('@kiki/agent-core-v2');
    const { TranscriptService } = await import('../../src/services/transcript/transcriptService');
    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token === ISessionManager) return { get: () => undefined, list: () => [] };
          if (token === IWorkspaceInstanceManager) {
            return { list: () => [], onDidChange: () => ({ dispose: () => undefined }) };
          }
          if (token === ISessionIndex) {
            return { get: async (sessionId: string) => sessionId === SESSION_ID
              ? { workspaceId: WORKSPACE_ID, createdAt: 0 }
              : undefined };
          }
          return undefined;
        },
      },
    };
    service = new TranscriptService({ homeDir, core: core as never });
    const snapshot = await service.readColdSnapshot(SESSION_ID, AGENT_ID);
    const turn = (snapshot as { items?: readonly { kind?: string; ordinal?: number }[] } | undefined)?.items?.find(
      (item) => item.kind === 'turn' && item.ordinal === selectedTurn,
    );
    const text = turn === undefined ? undefined : JSON.stringify(turn);
    const report = service.memoryReport() as { coldReads?: { bytes: number; records: number } };
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
    const result: BenchResult = {
      case: caseName,
      api: 'current-v1-TranscriptService.readColdSnapshot',
      status: 'ok',
      bytesRead: report.coldReads?.bytes,
      records: report.coldReads?.records,
      latencyMs: performance.now() - started,
      startRssBytes,
      peakRssBytes,
      rssDeltaBytes: peakRssBytes - startRssBytes,
      complete: true,
      selectedTurn,
      needle,
      needleFound: text?.includes(needle) ?? false,
      outputChars: text?.length ?? 0,
    };
    return result;
  } catch (error) {
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
    return {
      case: caseName,
      api: 'current-v1-TranscriptService.readColdSnapshot',
      status: 'error',
      latencyMs: performance.now() - started,
      startRssBytes,
      peakRssBytes,
      rssDeltaBytes: peakRssBytes - startRssBytes,
      selectedTurn,
      needle,
      error: String(error),
    };
  } finally {
    service?.dispose();
    clearInterval(sampler);
  }
}

function workerResult(result: BenchResult): void {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

async function runWorker(args: readonly string[]): Promise<void> {
  const mode = args[1];
  const wirePath = args[2];
  if (wirePath === undefined || mode === undefined) throw new Error('worker mode and wire path are required');
  if (mode === 'prefix-2mib') {
    workerResult(await runStreamWorker(mode, wirePath, 2 * MIB));
    return;
  }
  if (mode === 'prefix-8mib') {
    workerResult(await runStreamWorker(mode, wirePath, 8 * MIB));
    return;
  }
  if (mode === 'continuation-2mib') {
    workerResult(await runContinuationWorker(mode, wirePath));
    return;
  }
  if (mode === 'full-stream') {
    workerResult(await runStreamWorker(mode, wirePath, undefined));
    return;
  }
  if (mode === 'navigation-import') {
    workerResult(await runNavigationImportWorker());
    return;
  }
  if (mode === 'navigation') {
    workerResult(await runNavigationWorker(mode, wirePath));
    return;
  }
  const selectedTurn = positiveInteger(args[3], 0);
  const needle = mode === 'current-history-mid' ? MID_NEEDLE : TAIL_NEEDLE;
  const homeDir = args[4];
  if (homeDir === undefined) throw new Error('history API worker home is required');
  workerResult(await runCurrentHistoryRead(mode, homeDir, selectedTurn, needle));
}

function workerCommand(mode: string, fixture: Fixture): Promise<BenchResult> {
  return new Promise((resolve, reject) => {
    const script = import.meta.filename;
    const child = spawn(process.execPath, [...process.execArgv, '--import', RAW_LOADER, script, '--worker', mode, fixture.wirePath,
      `${mode === 'current-history-mid' ? fixture.midTurn : fixture.tailTurn}`, fixture.home], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_NO_WARNINGS: '1', TSX_TSCONFIG_PATH: CORE_TSCONFIG },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(RESULT_PREFIX));
      if (line !== undefined) {
        try {
          resolve(JSON.parse(line.slice(RESULT_PREFIX.length)) as BenchResult);
          return;
        } catch (error) {
          reject(new Error(`invalid worker result: ${String(error)}\n${stdout}\n${stderr}`));
          return;
        }
      }
      reject(new Error(`worker ${mode} exited code=${code} signal=${signal}\n${stdout}\n${stderr}`));
    });
  });
}

function printUsage(): void {
  process.stdout.write([
    'Usage: pnpm -C packages/kap-server exec tsx test/history-bench/historyPressure.mts [--navigation] [--current-api]',
    '',
    'HISTORY_BENCH_BYTES overrides the default 238000000-byte fixture.',
    '--navigation scans the current navigation model through the deep-tail marker with bounded scan cursors.',
    '--current-api runs the checked-out v1 HistoryRead archive backend for both marker turns.',
    'Synthetic input is always removed before the command exits.',
  ].join('\n'));
}

async function runParent(args: readonly string[]): Promise<void> {
  if (args.includes('--help')) {
    printUsage();
    return;
  }
  const targetBytes = positiveInteger(process.env['HISTORY_BENCH_BYTES'], TARGET_BYTES);
  if (targetBytes < 8 * MIB) throw new Error(`HISTORY_BENCH_BYTES must be at least ${8 * MIB}`);
  let fixture: Fixture | undefined;
  try {
    fixture = await writeFixture(targetBytes);
    process.stdout.write(`HISTORY_BENCH_FIXTURE ${JSON.stringify({
      targetBytes,
      actualBytes: fixture.bytes,
      records: fixture.records,
      turns: fixture.turns,
      midTurn: fixture.midTurn,
      tailTurn: fixture.tailTurn,
      wirePath: fixture.wirePath,
    })}\n`);
    for (const mode of ['prefix-2mib', 'prefix-8mib', 'continuation-2mib', 'full-stream']) {
      process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(await workerCommand(mode, fixture))}\n`);
    }
    if (args.includes('--navigation')) {
      process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(await workerCommand('navigation-import', fixture))}\n`);
      process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(await workerCommand('navigation', fixture))}\n`);
    }
    if (args.includes('--current-api')) {
      for (const mode of ['current-history-mid', 'current-history-tail']) {
        process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(await workerCommand(mode, fixture))}\n`);
      }
    } else {
      process.stdout.write('HISTORY_BENCH_CURRENT_API skipped; pass --current-api for checked-out v1 replay baseline\n');
    }
  } finally {
    if (fixture !== undefined) await rm(fixture.home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--worker') await runWorker(args);
  else await runParent(args);
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
}
