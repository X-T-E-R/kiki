import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { scanCorpusSessions, selectStratifiedSamples } from '../../../../scripts/perf/corpus-scanner.mjs';
import { assertZeroPrivateLeaks, collectForbiddenTokens } from '../../../../scripts/perf/metrics.mjs';
import { captureSourceFingerprint, stageCorpusSandbox } from '../../../../scripts/perf/sandbox-stager.mjs';
import { runRealCorpusBenchmark } from '../../../../scripts/perf-real-corpus.mjs';

function seedSyntheticSourceCorpus(): string {
  const root = mkdtempSync(join(tmpdir(), 'kiki-local-corpus-verify-'));
  const sessionDir = join(root, 'sessions', 'ws_private_bucket', 'session_11111111-2222-4333-8444-555555555555');
  const mainDir = join(sessionDir, 'agents', 'main');
  const childDir = join(sessionDir, 'agents', 'agent-1');
  const blobsDir = join(mainDir, 'blobs', 'ab');
  const mediaDir = join(sessionDir, 'media', 'files');

  mkdirSync(blobsDir, { recursive: true });
  mkdirSync(childDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });

  const blobPayload = Buffer.from('synthetic-cas-blob-payload');
  const blobHash = createHash('sha256').update(blobPayload).digest('hex');
  writeFileSync(join(blobsDir, blobHash), blobPayload);
  writeFileSync(join(mediaDir, 'img_01.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  mkdirSync(join(mainDir, 'replay-checkpoints'), { recursive: true });
  writeFileSync(join(mainDir, 'replay-checkpoints', 'engine-v1'), JSON.stringify({ version: 1, offset: 128 }));

  const mainLines: string[] = [];
  for (let t = 0; t < 30; t += 1) {
    mainLines.push(
      JSON.stringify({
        type: 'turn.prompt',
        turnId: t,
        promptId: `p-${t}`,
        input: [{ type: 'text', text: `synthetic prompt ${t} ${'x'.repeat(2048)}` }],
        origin: { kind: 'user' },
        time: 10_000 + t * 10,
      }),
    );
    mainLines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId: t,
          stepUuid: `s-${t}`,
          uuid: `u-${t}`,
          part: { type: 'text', text: `synthetic reply ${t} ${'y'.repeat(4096)}` },
        },
        time: 10_001 + t * 10,
      }),
    );
    mainLines.push(JSON.stringify({ type: 'turn.ended', turnId: t, reason: 'completed', time: 10_002 + t * 10 }));
  }
  writeFileSync(join(mainDir, 'wire.jsonl'), `${mainLines.join('\n')}\n`);
  writeFileSync(join(childDir, 'wire.jsonl'), `${mainLines.slice(0, 12).join('\n')}\n`);

  writeFileSync(
    join(sessionDir, 'state.json'),
    JSON.stringify({
      id: 'session_11111111-2222-4333-8444-555555555555',
      version: 2,
      title: 'SENSITIVE_USER_SECRET_TITLE',
      lastPrompt: 'SENSITIVE_USER_SECRET_PROMPT',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      archived: false,
      cwd: 'C:/Secret/PrivateWorkspace',
      agents: {
        main: { type: 'main', model: 'example/model' },
        'agent-1': {
          type: 'sub',
          parentAgentId: 'main',
          displayName: 'SENSITIVE_AGENT_LABEL',
          resultSummary: 'SENSITIVE_SUMMARY_TEXT',
          status: 'completed',
        },
      },
    }),
  );

  return root;
}

describe('real-corpus sandbox immutability, PII scrubbing, and benchmark contract', () => {
  it('stages private writable copies without hardlinks or junctions, isolates osHomeDir, preserves engine-v1 checkpoints, and protects source fingerprints', async () => {
    const corpusRoot = seedSyntheticSourceCorpus();
    const sessionDir = join(
      corpusRoot,
      'sessions',
      'ws_private_bucket',
      'session_11111111-2222-4333-8444-555555555555',
    );
    const before = captureSourceFingerprint(sessionDir, 'agent-1');

    try {
      const scan = scanCorpusSessions(corpusRoot, { minIdleMs: 0 });
      expect(scan.available).toBe(true);
      expect(scan.eligibleCount).toBe(1);

      const selected = selectStratifiedSamples(scan.records, { seed: 42, perStratum: 1, backgroundCatalogCount: 0 });
      const samples = selected.samples.length > 0 ? selected.samples : [{
        ...scan.records[0]!,
        ordinal: 1,
        label: 'sample#1',
        sandboxId: 'perf_sample_1',
        stratum: 'medium-scroll-partial',
        descriptor: 'sample#1 [stratum=medium-scroll-partial]',
      }];
      const sandbox = stageCorpusSandbox({
        corpusHome: corpusRoot,
        samples,
        backgroundRecords: [],
      });

      expect(sandbox.hardlinkedFiles).toBe(0);
      expect(sandbox.junctionCount).toBe(0);
      expect(sandbox.copiedFiles).toBeGreaterThan(0);
      expect(existsSync(sandbox.osHomeDir)).toBe(true);
      expect(process.env['HOME']).toBe(sandbox.osHomeDir);
      expect(process.env['USERPROFILE']).toBe(sandbox.osHomeDir);

      const stagedSessionDir = join(sandbox.homeDir, 'sessions', sandbox.workspaceId, samples[0]!.sandboxId);
      expect(existsSync(join(stagedSessionDir, 'agents', 'main', 'replay-checkpoints', 'engine-v1'))).toBe(true);
      writeFileSync(join(stagedSessionDir, 'agents', 'main', 'wire.jsonl'), 'mutated-inside-sandbox\n');

      const immutability = sandbox.cleanup();
      expect(immutability.mutations).toBe(0);
      expect(existsSync(sandbox.sandboxRoot)).toBe(false);
      expect(existsSync(join(sessionDir, 'media', 'files', 'img_01.png'))).toBe(true);

      const after = captureSourceFingerprint(sessionDir, 'agent-1');
      expect(after).toEqual(before);

      const outReport = join(corpusRoot, 'out', 'report.json');
      const bench = await runRealCorpusBenchmark({
        corpusHome: corpusRoot,
        seed: 7,
        quick: true,
        browser: false,
        minIdleMs: 0,
        outPath: outReport,
      });
      expect(bench.skipped).not.toBe(true);
      if (!bench.skipped) {
        expect(bench.report.immutability.mutations).toBe(0);
      }

      const forbidden = collectForbiddenTokens(corpusRoot, ['session_11111111-2222-4333-8444-555555555555']);
      expect(() =>
        assertZeroPrivateLeaks('leak session_11111111-2222-4333-8444-555555555555', forbidden),
      ).toThrow();
    } finally {
      rmSync(corpusRoot, { recursive: true, force: true });
    }
  });

  it('executes quick protocol benchmark against the configured local corpus without mutating any source file', async () => {
    const tmpOut = mkdtempSync(join(tmpdir(), 'kiki-perf-local-out-'));
    try {
      const outcome = await runRealCorpusBenchmark({
        seed: 20261118,
        quick: true,
        browser: false,
        outPath: join(tmpOut, 'latest.json'),
      });
      if (outcome.skipped) {
        expect(typeof outcome.reason).toBe('string');
        return;
      }
      expect(outcome.report.immutability.mutations).toBe(0);
      expect(outcome.report.samples.length).toBeGreaterThan(0);
      expect(outcome.report.protocol.aggregates.coldOpenTtfcMs.count).toBeGreaterThan(0);
      expect(outcome.report.slo.passed).toBe(true);
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });
});
