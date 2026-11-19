// Verifies the machine-readable JSON report schemas emitted by
// `bench/bench.ts --quick --json` and `bench/open-lifecycle.ts --quick --json`.
// Run via: pnpm --filter @kiki/minidb run bench:verify

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const pkgDir = fileURLToPath(new URL('..', import.meta.url));

async function runBenchJson(script: string, reportPath: string): Promise<Record<string, any>> {
  await execFileAsync(
    process.execPath,
    ['--import', 'tsx', path.join(pkgDir, 'bench', script), '--quick', '--json', reportPath],
    { cwd: pkgDir, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(await fs.readFile(reportPath, 'utf8'));
}

function verifyMainBenchReport(report: Record<string, any>): void {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.tool, 'minidb/bench');
  assert.equal(typeof report.startedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(report.startedAt)), 'startedAt is an ISO timestamp');
  assert.equal(typeof report.node, 'string');
  assert.equal(typeof report.platform, 'string');
  assert.equal(typeof report.arch, 'string');
  assert.equal(typeof report.seed, 'number');
  assert.ok(Array.isArray(report.scenarios));
  assert.ok(report.scenarios.length >= 10, 'all scenario families ran');

  for (const s of report.scenarios) {
    assert.equal(typeof s.name, 'string');
    assert.ok(s.name.length > 0);
    assert.equal(typeof s.durationMs, 'number', `${s.name}.durationMs`);
    assert.ok(s.durationMs >= 0);
    if (s.ops !== undefined) assert.equal(typeof s.ops, 'number', `${s.name}.ops`);
    if (s.opsPerSec !== undefined) assert.equal(typeof s.opsPerSec, 'number', `${s.name}.opsPerSec`);
    for (const k of ['mean', 'p50', 'p95', 'p99', 'max']) {
      assert.equal(typeof s.eventLoopDelayMs[k], 'number', `${s.name}.eventLoopDelayMs.${k}`);
    }
    assert.ok(s.peakRssBytes > 0, `${s.name}.peakRssBytes`);
    assert.ok(s.peakHeapUsedBytes > 0, `${s.name}.peakHeapUsedBytes`);
    if (s.latencyMs !== undefined) {
      for (const k of ['p50', 'p95', 'p99', 'max']) {
        assert.equal(typeof s.latencyMs[k], 'number', `${s.name}.latencyMs.${k}`);
      }
    }
  }

  const byName = (re: RegExp) => report.scenarios.find((s: any) => re.test(s.name));

  const cold = byName(/cold open/);
  assert.ok(cold, 'a cold-open scenario exists');
  for (const k of ['keys', 'recoveryBytes', 'recoveryFrames', 'recoveryDurationMs', 'indexRebuildDurationMs', 'textRebuildDurationMs', 'walFsyncs']) {
    assert.equal(typeof cold.extra[k], 'number', `cold open extra.${k}`);
  }

  const idle = byName(/idle everysec/);
  assert.ok(idle, 'the idle everysec scenario exists');
  assert.equal(idle.extra.walFsyncs, 0, 'idle everysec db: zero background fsyncs');
  assert.equal(idle.extra.walFsyncErrors, 0);

  const dirty = byName(/write then idle/);
  assert.ok(dirty, 'the dirty-window scenario exists');
  assert.ok(dirty.extra.walFsyncs >= 1, 'a write triggers a background fsync');

  for (const re of [/search word/, /search ngram/]) {
    const search = byName(re);
    assert.ok(search, `${re} scenario exists`);
    assert.ok(Array.isArray(search.extra.queries));
    for (const q of search.extra.queries) {
      assert.equal(typeof q.q, 'string');
      assert.equal(typeof q.hits, 'number');
      assert.equal(typeof q.medianMs, 'number');
    }
  }

  const compact = byName(/compact \d/);
  assert.ok(compact, 'a compaction scenario exists');
  for (const k of ['keys', 'compactionDurationMs', 'compactionSnapshotDurationMs', 'compactionRotationDurationMs', 'compactionPostingsDurationMs', 'snapshotBytesWritten']) {
    assert.equal(typeof compact.extra[k], 'number', `compact extra.${k}`);
  }
}

function verifyOpenLifecycleReport(report: Record<string, any>): void {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.tool, 'minidb/bench/open-lifecycle');
  assert.ok(Array.isArray(report.scenarios));

  const byName = (re: RegExp) => report.scenarios.find((s: any) => re.test(s.name));

  for (const s of report.scenarios) {
    assert.equal(typeof s.durationMs, 'number', `${s.name}.durationMs`);
    for (const k of ['mean', 'p50', 'p95', 'p99', 'max']) {
      assert.equal(typeof s.eventLoopDelayMs[k], 'number', `${s.name}.eventLoopDelayMs.${k}`);
    }
    assert.ok(s.inputLatencyMs, `${s.name}.inputLatencyMs`);
    for (const k of ['count', 'p50', 'p95', 'p99', 'max']) {
      assert.equal(typeof s.inputLatencyMs[k], 'number', `${s.name}.inputLatencyMs.${k}`);
    }
  }

  const PHASES = [
    'openMs',
    'generationCandidateLoadMs',
    'storeImageLoadMs',
    'nonTextImageLoadMs',
    'textImageLoadMs',
    'postingsIntegrityCheckMs',
    'walScanMs',
    'walApplyMs',
    'fullRecoveryMs',
    'textRebuildMs',
  ];
  const small = byName(/small corpus, healthy generation/);
  const wal = byName(/large WAL delta/);
  const large = byName(/large full-text generation/);
  const corrupt = byName(/corrupt generation \(full-recovery fallback\)/);
  const deferred = byName(/deferred text rebuild \(degraded -> ready\)/);
  for (const [name, s] of Object.entries({ small, wal, large, corrupt, deferred })) {
    assert.ok(s, `${name} scenario exists`);
    for (const k of PHASES) assert.equal(typeof s.extra.phases[k], 'number', `${name}.extra.phases.${k}`);
  }

  for (const [name, s] of Object.entries({ small, wal, large })) {
    assert.equal(s.extra.state, 'ready', name);
    assert.deepEqual(s.extra.path, ['no-generation', 'generation-load', 'wal-catch-up', 'ready'], name);
    assert.equal(s.extra.phases.fullRecoveryMs, 0, name);
    assert.equal(s.extra.phases.textRebuildMs, 0, name);
    assert.equal(s.extra.generationLoads, 1, name);
    assert.equal(s.extra.indexRebuildDecoded, 0, name);
  }
  assert.ok(wal.extra.walDeltaAppliedOps > 0, 'wal delta replayed');
  assert.equal(wal.extra.closePublishedGeneration, false, 'close left the generation untouched');
  assert.ok(wal.extra.phases.walApplyMs > 0, 'wal apply measured');

  assert.equal(corrupt.extra.state, 'degraded');
  assert.deepEqual(corrupt.extra.path, ['no-generation', 'generation-load', 'full-rebuild', 'degraded']);
  assert.ok(corrupt.extra.phases.fullRecoveryMs > 0, 'full recovery measured');
  assert.equal(corrupt.extra.generationLoadFallbacks, 1);
  assert.equal(deferred.extra.state, 'ready');
  assert.ok(deferred.extra.textDeferredBuilds >= 1, 'deferred build committed');
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-bench-verify-'));
  try {
    const [benchReport, openReport] = await Promise.all([
      runBenchJson('bench.ts', path.join(dir, 'bench-report.json')),
      runBenchJson('open-lifecycle.ts', path.join(dir, 'open-report.json')),
    ]);
    verifyMainBenchReport(benchReport);
    verifyOpenLifecycleReport(openReport);
    console.log('bench:verify OK (bench.ts + open-lifecycle.ts JSON schemas verified)');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
