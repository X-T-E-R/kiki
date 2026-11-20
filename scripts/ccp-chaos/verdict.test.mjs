import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildDecodableMp4,
  buildDecodableOggOpus,
  buildScreenshotPng,
  inspectMp4Structure,
} from './fixtures/media.mjs';
import {
  buildRankStratifiedSizes,
  EMPIRICAL_POPULATIONS,
  writeCheckpointlessColdChildWire,
} from './fixtures/empirical-manifest.mjs';
import { MeshNodeStateMachine } from './twin/chained-workload.mjs';
import {
  computeScopedHmac,
  domainDigest,
  evaluateCcpRunVerdict,
  evaluateIdleCpuGate,
  evaluateP01ColdChildGate,
  evaluateP02MainOnlyWsGate,
  evaluateP03CronOutboxRecovery,
  evaluateP04BlindMutationControl,
  evaluateP1TimeoutVsDetachCell,
  evaluateS10Verdict,
  EXIT_HARNESS_FAIL,
  EXIT_PASS,
  EXIT_PRODUCT_FAIL,
  verifyMeshGraph,
  verifySavedBundle,
  verifySixStageChildChain,
} from './verify/verdict.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AST_BUILD_SCRIPT = path.resolve(__dirname, 'workloads', 'ast-build.mjs');

describe('v2.3 Harness & Negative Meta-Gates (verdict.test.mjs)', () => {
  it('meta-gate #1: dropping child tool calls fails S10 verdict with EXIT_HARNESS_FAIL', () => {
    const res = evaluateS10Verdict(
      {
        peakActiveChildren: 4,
        totalChildToolCalls: 0,
        overlapBucketsQualified: 2,
        promptAdmission: { p95Ms: 80, maxMs: 120 },
        sendToReceipt: { p95Ms: 110, maxMs: 180 },
        eld: { p99Ms: 18, maxMs: 42 },
      },
      { minPeakActiveChildren: 4, minChildToolCalls: 8, minOverlapBuckets: 1 },
    );
    assert.equal(res.passed, false);
    assert.equal(res.exitCode, EXIT_HARNESS_FAIL);
    assert.match(res.harnessFailures.join(' '), /child tool calls/i);
  });

  it('meta-gate #2: removing browser flight recorder when required fails S10 verdict', () => {
    const res = evaluateS10Verdict(
      {
        peakActiveChildren: 4,
        totalChildToolCalls: 12,
        overlapBucketsQualified: 2,
        browserRequired: true,
        flightRecorder: null,
        promptAdmission: { p95Ms: 80, maxMs: 120 },
        sendToReceipt: { p95Ms: 110, maxMs: 180 },
        eld: { p99Ms: 18, maxMs: 42 },
      },
      { minPeakActiveChildren: 4, minChildToolCalls: 8, minOverlapBuckets: 1 },
    );
    assert.equal(res.passed, false);
    assert.equal(res.exitCode, EXIT_HARNESS_FAIL);
    assert.match(res.harnessFailures.join(' '), /flight recorder/i);
  });

  it('meta-gate #3 (CRIT #1): remote runner exit 1 with a stale green JSON fails non-zero', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-verdict-stale-'));
    try {
      fs.writeFileSync(
        path.join(tmp, 'manifest.json'),
        JSON.stringify({ runId: 'run_new_999', buildId: 'abc1234', requiredStages: ['hygiene', 'unitTests', 'chaos'] }),
      );
      // Stale green chaos-report.json from an earlier run!
      fs.writeFileSync(
        path.join(tmp, 'chaos-report.json'),
        JSON.stringify({ runId: 'run_old_111', overallPassed: true, skipped: 0 }),
      );
      fs.writeFileSync(
        path.join(tmp, 'run-receipt.json'),
        JSON.stringify({
          runId: 'run_new_999',
          buildId: 'abc1234',
          remoteExitCode: 1,
          stages: { hygiene: { exitCode: 0 }, unitTests: { exitCode: 0 }, chaos: { exitCode: 1 } },
        }),
      );
      const res = verifySavedBundle(tmp);
      assert.equal(res.passed, false);
      assert.notEqual(res.exitCode, EXIT_PASS);
      assert.equal(res.exitCode, EXIT_HARNESS_FAIL);
      assert.match(res.harnessFailures.join(' '), /Stale or un-stamped chaos report runId/i);

      // Even if runId matched, remoteExitCode=1 must exit non-zero (EXIT_PRODUCT_FAIL)
      const directFail = evaluateCcpRunVerdict({
        expectedRunId: 'run_new_999',
        expectedBuildId: 'abc1234',
        remoteExitCode: 1,
        receipt: {
          runId: 'run_new_999',
          buildId: 'abc1234',
          stages: { hygiene: { exitCode: 0 }, unitTests: { exitCode: 0 }, chaos: { exitCode: 1 } },
        },
        chaosReport: { runId: 'run_new_999', overallPassed: false, skipped: 0 },
      });
      assert.equal(directFail.passed, false);
      assert.equal(directFail.exitCode, EXIT_PRODUCT_FAIL);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('S10 product failure gate catches 16s prompt_admission & transcript root remounts', () => {
    const res = evaluateS10Verdict({
      peakActiveChildren: 8,
      totalChildToolCalls: 48,
      overlapBucketsQualified: 4,
      browserRequired: true,
      flightRecorder: { sampleCount: 120, cls: 0.001, rawLayoutShift: 0.001, transcriptRootRemounts: 1, consoleErrors: 0 },
      promptAdmission: { p95Ms: 16278, maxMs: 16278 },
      sendToReceipt: { p95Ms: 16400, maxMs: 16400 },
      eld: { p99Ms: 2609, maxMs: 3894 },
    });
    assert.equal(res.passed, false);
    assert.equal(res.exitCode, EXIT_PRODUCT_FAIL);
    assert.ok(res.productFailures.some((f) => f.includes('prompt_admission')));
    assert.ok(res.productFailures.some((f) => f.includes('remounted')));
    assert.ok(res.productFailures.some((f) => f.includes('ELD')));
  });

  it('§10.1 P0-1 cold child gate enforces both legacy (>2GB/s raw pass, <=2MiB parse) and reopen (<=2MiB raw+parse) lanes', () => {
    const passLegacy = evaluateP01ColdChildGate({
      lane: 'legacy',
      wasColdBeforeOpen: true,
      checkpoints: [],
      preexistingSummaryOrSidecar: false,
      firstPaintMs: 145,
      controlBarSettleMs: 220,
      responses: [{ status: 200, code: 0 }],
      rawPassCount: 1,
      legacyScanBytesPerSec: 2_800_000_000,
      auxiliaryTargetReadBytes: 128 * 1024,
      aggregateParseInputBytes: 512 * 1024,
      fullReplayMatches: true,
    });
    assert.equal(passLegacy.passed, true);

    const failSlowScan = evaluateP01ColdChildGate({
      lane: 'legacy',
      wasColdBeforeOpen: true,
      checkpoints: [],
      firstPaintMs: 180,
      controlBarSettleMs: 240,
      responses: [{ status: 200, code: 0 }],
      rawPassCount: 1,
      legacyScanBytesPerSec: 800_000_000,
      aggregateParseInputBytes: 512 * 1024,
    });
    assert.equal(failSlowScan.passed, false);
    assert.equal(failSlowScan.exitCode, EXIT_PRODUCT_FAIL);

    const failLegacyOverParse = evaluateP01ColdChildGate({
      lane: 'legacy',
      wasColdBeforeOpen: true,
      checkpoints: [],
      firstPaintMs: 180,
      controlBarSettleMs: 240,
      responses: [{ code: 40923, reason: 'history_canonical_preparing' }],
      rawPassCount: 1,
      legacyScanBytesPerSec: 2_500_000_000,
      aggregateParseInputBytes: 80 * 1024 * 1024,
    });
    assert.equal(failLegacyOverParse.passed, false);
    assert.ok(failLegacyOverParse.productFailures.some((f) => f.includes('40923')));
    assert.ok(failLegacyOverParse.productFailures.some((f) => f.includes('JSON-parsed')));

    const failReopenFixtureCheat = evaluateP01ColdChildGate({
      lane: 'reopen',
      wasColdBeforeOpen: true,
      productionCheckpointPublished: true,
      fixtureBuiltCheckpoint: true,
      firstPaintMs: 90,
      controlBarSettleMs: 140,
      responses: [{ status: 200, code: 0 }],
      aggregateWireReadBytes: 512 * 1024,
      aggregateParseInputBytes: 256 * 1024,
    });
    assert.equal(failReopenFixtureCheat.passed, false);
    assert.equal(failReopenFixtureCheat.exitCode, EXIT_PRODUCT_FAIL);
  });

  it('§10.2 P0-2 main-only WS gate rejects unsubscribed child byte leaks AND rolling-5s underproduction', () => {
    const leak = evaluateP02MainOnlyWsGate({
      requiredStreamingChildren: 12,
      activeStreamingChildren: 12,
      controlClientChildBytes: 65536,
      unsubscribedChildContentBytes: 128,
      unsubscribedChildContentFrames: 1,
      inboundBytesPerSecP99: 8192,
      inboundBytesPerSecPeak: 16384,
      inboundFramesPerSecP99: 10,
      inboundFramesPerSecPeak: 20,
    });
    assert.equal(leak.passed, false);
    assert.equal(leak.exitCode, EXIT_PRODUCT_FAIL);

    const underproduced = evaluateP02MainOnlyWsGate({
      requiredStreamingChildren: 12,
      activeStreamingChildren: 12,
      controlClientChildBytes: 65536,
      unsubscribedChildContentBytes: 0,
      unsubscribedChildContentFrames: 0,
      inboundBytesPerSecP99: 4096,
      inboundBytesPerSecPeak: 8192,
      inboundFramesPerSecP99: 4,
      inboundFramesPerSecPeak: 8,
      rolling5sWindows: [
        { productiveChildren4s: 5, streamingChildren3s: 2, perChildStreams: [{ childId: 'c0', activeSeconds: 5, deltas: 10, usefulBytes: 500 }] },
      ],
    });
    assert.equal(underproduced.passed, false);
    assert.equal(underproduced.exitCode, EXIT_HARNESS_FAIL);
  });

  it('§10.3 mesh state machine yields on Incomplete, forwards on Ready, and verifies structured wire origin & Cron recovery', () => {
    const node = new MeshNodeStateMachine({
      runId: 'r1',
      epoch: 1,
      nodeId: 'S3',
      expectedUpstreamIds: ['S1', 'S2'],
      outboundEdges: [{ to: 'S4', kind: 'peer' }],
    });
    const r1 = node.receive({
      sourceId: 'S1',
      payloadDigest: 'aaa',
      origin: { kind: 'peer_thread', sourceSessionId: 'S1', messageId: 'm1' },
    });
    assert.equal(r1.accepted, true);
    assert.equal(r1.status, 'Incomplete');
    const rBad = node.receive({ sourceId: 'S2', payloadDigest: 'bbb', origin: { kind: 'label_only' } });
    assert.equal(rBad.accepted, false);
    const r2 = node.receive({
      sourceId: 'S2',
      payloadDigest: 'bbb',
      origin: { kind: 'room_message', roomId: 'room1', targeted: true, mailboxMessageId: 'mb2', roomEntryId: 're2' },
    });
    assert.equal(r2.accepted, true);
    assert.equal(r2.status, 'Ready');
    const intents = node.buildOutboxIntents();
    assert.equal(intents.length, 1);

    const graphFail = verifyMeshGraph({
      expectedEdges: [{ epoch: 1, from: 'S3', to: 'S4', kind: 'peer', requireStructuredOrigin: true }],
      observedEdges: [
        { epoch: 1, from: 'S3', to: 'S4', kind: 'peer', senderReceiptOk: true, targetConsumed: true, persistedWireOrigin: null },
      ],
    });
    assert.equal(graphFail.ok, false);

    const cronPass = evaluateP03CronOutboxRecovery({
      cronJob: {
        jobId: 'cron_1',
        deliveryMode: 'queue',
        oneShot: true,
        instruction: "Drain this session's committed outbox.",
        carriedPayloadOrKey: false,
      },
      becameDueWhileDown: true,
      manualIntervention: false,
      futureInboundDelivered: false,
      replacementStartToRestartMs: 2100,
      cronOriginJobId: 'cron_1',
      usedOriginalKeysAndBytes: true,
      drainMsFromReplacementStart: 9400,
      allTargetsConsumedOnce: true,
    });
    assert.equal(cronPass.passed, true);
  });

  it('§10.4 blind 4-trial HMAC-SHA256 mutation control passes authentic controls and rejects tampered returns', () => {
    const key = 'isolated-test-hmac-key-v23';
    const makeRec = (run, resultValue, artifactDigest) => ({
      version: 'v2.3',
      run,
      epoch: 1,
      source: 'child_0',
      destination: 'validator_0',
      edgeKind: 'tool',
      stage: 'build',
      inputIdentity: 'unit_0001.ts',
      resultValue,
      artifactDigest,
    });
    const recBase = makeRec('r_a1', '42001', 'digest_aaa');
    const recChanged = makeRec('r_b2', '99123', 'digest_bbb');
    const recTamperedTool = makeRec('r_c3', '42001', 'digest_ccc');
    const recTamperedPeer = makeRec('r_d4', '55002', 'digest_ddd');

    const res = evaluateP04BlindMutationControl({
      scopedKey: key,
      trials: [
        { hiddenKind: 'valid_baseline', record: recBase, tag: computeScopedHmac(key, recBase), validatorAccepted: true, semanticDownstreamArg: 'arg_42001' },
        { hiddenKind: 'valid_changed_challenge', record: recChanged, tag: computeScopedHmac(key, recChanged), validatorAccepted: true, semanticDownstreamArg: 'arg_99123' },
        {
          hiddenKind: 'tampered_tool_return',
          record: recTamperedTool,
          consumedRecord: { ...recTamperedTool, resultValue: '42002' },
          tag: computeScopedHmac(key, recTamperedTool),
          validatorAccepted: false,
          dependentWriteOrForwardOccurred: false,
          usedFaultFlagOrTrialName: false,
          rejectionDiagnostic: { epoch: 1, source: 'child_0', destination: 'validator_0', stage: 'build', inputIdentity: 'unit_0001.ts', failedBinding: 'hmac_mismatch' },
        },
        {
          hiddenKind: 'tampered_peer_input',
          record: recTamperedPeer,
          consumedRecord: { ...recTamperedPeer, resultValue: '55003' },
          tag: computeScopedHmac(key, recTamperedPeer),
          validatorAccepted: false,
          dependentWriteOrForwardOccurred: false,
          usedFaultFlagOrTrialName: false,
          rejectionDiagnostic: { epoch: 1, source: 'child_0', destination: 'validator_0', stage: 'build', inputIdentity: 'unit_0001.ts', failedBinding: 'hmac_mismatch' },
        },
      ],
    });
    assert.equal(res.passed, true);
  });

  it('§10.5 distinguishes terminating timeout from foreground_detached -> TaskStop and rejects premature completion', () => {
    const okTimeout = evaluateP1TimeoutVsDetachCell({
      kind: 'terminating_timeout',
      earlyExitVariant: true,
      grandchildActiveAtTrigger: true,
      prematureTaskCompletionWhileGrandchildAlive: false,
      timeline: { rootExitMs: 500, triggerReceivedMs: 5000, grandchildExitMs: 5400 },
      scheduledDeadlineMs: 5000,
      cleanupAtMs: 5600,
      terminalStatus: 'timed_out',
      survivingDescendants: 0,
    });
    assert.equal(okTimeout.passed, true);

    const okDetach = evaluateP1TimeoutVsDetachCell({
      kind: 'foreground_detach_then_stop',
      earlyExitVariant: false,
      prematureTaskCompletionWhileGrandchildAlive: false,
      detachReason: 'foreground_detached',
      detachReceiptDelayFromDeadlineMs: 120,
      terminalStatusAfterStop: 'killed',
      cleanupMsFromStopIngress: 450,
      survivingDescendants: 0,
    });
    assert.equal(okDetach.passed, true);

    const badPremature = evaluateP1TimeoutVsDetachCell({
      kind: 'terminating_timeout',
      prematureTaskCompletionWhileGrandchildAlive: true,
      scheduledDeadlineMs: 5000,
      cleanupAtMs: 5200,
      terminalStatus: 'timed_out',
      survivingDescendants: 1,
    });
    assert.equal(badPremature.passed, false);
    assert.equal(badPremature.exitCode, EXIT_PRODUCT_FAIL);
  });

  it('6-stage child chain verifier catches corrupted spill tail or altered constant', () => {
    const runId = 'r_chain';
    const childId = 'c0';
    const finalDigest = domainDigest('child-final/v2', [runId, childId, '12345', 'sha_edit', 'sha_footer', 'sha_spill', 'mem1', 'hist1']);
    const good = {
      toolCallsExecuted: 8,
      stages: {
        discover: { executed: true },
        read: { executed: true, extractedConstant: '12345' },
        change: { executed: true, postimageSha256: 'sha_edit' },
        build: { executed: true, footerDigest: 'sha_footer', cpuMs: 60 },
        recover: { executed: true, spillPath: '/tmp/spill.log', spillTailRead: true, spillTailSha256: 'sha_spill', memoryFact: 'mem1', historyRef: 'hist1' },
        account: { executed: true, todoCompleted: true, receiptCount: 1, finalDigest },
      },
    };
    const expected = {
      runId,
      childId,
      requiredToolCount: 6,
      expectedConstant: '12345',
      expectedEditedFileSha256: 'sha_edit',
      expectedFooterDigest: 'sha_footer',
      minBuildCpuMs: 20,
      requireSpillTailRead: true,
      expectedSpillTailSha256: 'sha_spill',
      expectedMemoryFact: 'mem1',
      expectedHistoryRef: 'hist1',
    };
    assert.equal(verifySixStageChildChain({ expected, observed: good }).ok, true);

    const corruptedSpill = structuredClone(good);
    corruptedSpill.stages.recover.spillTailSha256 = 'sha_wrong';
    const failSpill = verifySixStageChildChain({ expected, observed: corruptedSpill });
    assert.equal(failSpill.ok, false);
    assert.equal(failSpill.firstBrokenStage, 'recover');
  });

  it('HIGH #2 media fixtures generate genuine ftyp+moov+trak+mdat MP4, valid Ogg/Opus, realistic PNG, and real CPU ast-build.mjs', () => {
    const mp4 = buildDecodableMp4({ durationSec: 2, minBytes: 32 * 1024 });
    const info = inspectMp4Structure(mp4);
    assert.equal(info.hasFtyp, true);
    assert.equal(info.hasMoov, true);
    assert.equal(info.hasTrak, true);
    assert.equal(info.hasMdat, true);
    assert.ok(mp4.byteLength >= 32 * 1024);

    const ogg = buildDecodableOggOpus({ durationSec: 1.2 });
    assert.equal(ogg.subarray(0, 4).toString('ascii'), 'OggS');
    assert.ok(ogg.includes(Buffer.from('OpusHead', 'ascii')));

    const png = buildScreenshotPng({ width: 1280, height: 720, seed: 42 });
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(png.byteLength > 20 * 1024);

    // Verify empirical rank sampler + ast-build.mjs real execution
    const samples = buildRankStratifiedSizes(EMPIRICAL_POPULATIONS.repoFiles, 200, 'seed-123');
    assert.equal(samples.length, 200);
    assert.ok(Math.min(...samples) >= EMPIRICAL_POPULATIONS.repoFiles.min);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-ast-test-'));
    try {
      for (let i = 0; i < 6; i += 1) {
        fs.writeFileSync(path.join(tmp, `sample_${i}.ts`), `export const X_${i} = ${42 + i};\nexport function f${i}(a: number) { return a + X_${i}; }\n`);
      }
      const out = execFileSync(
        process.execPath,
        [AST_BUILD_SCRIPT, '--dir', tmp, '--challenge', 'test-chal', '--needle', 'X_0', '--passes', '12', '--partitions', '1'],
        { encoding: 'utf8' },
      );
      assert.ok(Buffer.byteLength(out, 'utf8') >= 20 * 1024);
      assert.match(out, /AST_BUILD_FOOTER\s+\{/u);

      const wirePath = path.join(tmp, 'cold-child.jsonl');
      const wireMeta = writeCheckpointlessColdChildWire({ wirePath, agentId: 'sub_cold_1', targetBytes: 256 * 1024, stepCount: 20 });
      assert.deepEqual(wireMeta.checkpoints, []);
      assert.ok(wireMeta.bytesWritten >= 240 * 1024);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('idle CPU gate requires rAF disabled and enforces <=2% server / <=3% renderer / 0 descendants', () => {
    const pass = evaluateIdleCpuGate({
      recorderRafDisabled: true,
      requiredWindowCount: 2,
      windows: [
        { serverCorePct: 0.4, rendererPlusGpuCorePct: 0.9, survivingDescendants: 0 },
        { serverCorePct: 1.1, rendererPlusGpuCorePct: 1.5, survivingDescendants: 0 },
      ],
    });
    assert.equal(pass.passed, true);

    const failHighCpu = evaluateIdleCpuGate({
      recorderRafDisabled: true,
      requiredWindowCount: 1,
      windows: [{ serverCorePct: 14.2, rendererPlusGpuCorePct: 1.0, survivingDescendants: 0 }],
    });
    assert.equal(failHighCpu.passed, false);
    assert.equal(failHighCpu.exitCode, EXIT_PRODUCT_FAIL);
  });
});
