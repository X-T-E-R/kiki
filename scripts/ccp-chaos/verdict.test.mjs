import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

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
import { extractSenderThreadSendResultPreview } from './scenarios/s11-mesh-256-1024.mjs';
import { extractWireLoopEvent, resolveTerminatingTimeoutStatus } from './scenarios/s13-chaos-faults.mjs';
import { generateSyntheticMp4 } from './scenario-soak-and-media-weaknet.mjs';
import { isKnownInternalKikiHelper } from './telemetry/process-tree.mjs';
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
  evaluateS16MobileVerdict,
  evaluateS17WorkstationCliffVerdict,
  EXIT_HARNESS_FAIL,
  EXIT_PASS,
  EXIT_PRODUCT_FAIL,
  validateMatrixThresholdParity,
  verifyMeshGraph,
  verifySavedBundle,
  verifySixStageChildChain,
} from './verify/verdict.mjs';
import { loadChaosMatrix } from './matrix/loader.mjs';
import { evaluateWebAssetsBudget } from './web-assets-bridge.mjs';

const AST_BUILD_SCRIPT = path.resolve(import.meta.dirname, 'workloads', 'ast-build.mjs');

void describe('v2.3 Harness & Negative Meta-Gates (verdict.test.mjs)', () => {
  void it('meta-gate #1: dropping child tool calls fails S10 verdict with EXIT_HARNESS_FAIL', () => {
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

  void it('meta-gate #2: removing browser flight recorder when required fails S10 verdict', () => {
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

  void it('meta-gate #3 (CRIT #1): remote runner exit 1 with a stale green JSON fails non-zero', () => {
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
        chaosReport: { runId: 'run_new_999', buildId: 'abc1234', overallPassed: false, skipped: 0 },
      });
      assert.equal(directFail.passed, false);
      assert.equal(directFail.exitCode, EXIT_PRODUCT_FAIL);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  void it('S10 product failure gate catches 16s prompt_admission & transcript root remounts', () => {
    const res = evaluateS10Verdict({
      tier: 'smoke',
      peakActiveChildren: 8,
      totalChildToolCalls: 48,
      overlapBucketsQualified: 4,
      browserRequired: true,
      guiDistServed: true,
      durableReceiptsVerified: true,
      failedSends: 0,
      flightRecorder: {
        sampleCount: 120,
        cls: 0.001,
        rawLayoutShift: 0.001,
        transcriptRootRemounts: 1,
        consoleErrors: 0,
        composerTyping: { samples: 12, p95Ms: 14 },
      },
      textPromptAdmission: { samples: 4, p95Ms: 1011, maxMs: 1011 },
      pngPromptAdmission: { samples: 2, p95Ms: 16278, maxMs: 16278 },
      promptAdmission: { p95Ms: 16278, maxMs: 16278 },
      sendToReceipt: { samples: 6, p95Ms: 16400, maxMs: 16400 },
      eld: { p99Ms: 2609, maxMs: 3894 },
      p02: {
        tier: 'smoke',
        requiredStreamingChildren: 2,
        activeStreamingChildren: 4,
        controlClientChildBytes: 4096,
        unsubscribedChildContentBytes: 0,
        unsubscribedChildContentFrames: 0,
        inboundBytesPerSecP99: 2048,
        inboundBytesPerSecPeak: 4096,
        inboundFramesPerSecP99: 4,
        inboundFramesPerSecPeak: 8,
        rolling5sWindows: [{ windowMs: 5000, productiveChildren4s: 2, streamingChildren3s: 1, perChildStreams: [{ childId: 'c0', activeSeconds: 2, deltas: 20, usefulBytes: 1024 }] }],
      },
    });
    assert.equal(res.passed, false);
    assert.equal(res.exitCode, EXIT_PRODUCT_FAIL);
    assert.ok(res.productFailures.some((f) => f.includes('prompt_admission')));
    assert.ok(res.productFailures.some((f) => f.includes('remounted')));
    assert.ok(res.productFailures.some((f) => f.includes('ELD')));
  });

  void it('§10.1 P0-1 cold child gate enforces both legacy (>2GB/s raw pass, <=2MiB parse) and reopen (<=2MiB raw+parse) lanes', () => {
    const completeResponses = (hooksCode = 40901) => [
      { path: '/api/sessions/s/transcript?agent_id=c&transcript_coverage_version=2', status: 200, code: 0 },
      { path: '/api/agents/capabilities?session_id=s&agent_id=c&metrics_settle=true', status: 200, code: 0 },
      { path: '/api/sessions/s/agents/c/model-switches', status: 200, code: 0 },
      { path: '/api/sessions/s/agents/c/hooks?observe=true', status: 200, code: hooksCode },
      { path: '/api/sessions/s/agents/c/auto-compact?observe=true', status: 200, code: 0 },
      { path: '/api/sessions/s/agents/c/context-strategy?observe=true', status: 200, code: 0 },
      { path: '/api/sessions/s/status', status: 200, code: 0 },
      { path: '/api/sessions/s/transcript/plan?agent_id=c', status: 200, code: 0 },
    ];
    const passLegacy = evaluateP01ColdChildGate({
      lane: 'legacy',
      wasColdBeforeOpen: true,
      checkpoints: [],
      preexistingSummaryOrSidecar: false,
      httpTranscriptMs: 145,
      wsFirstResetMs: 210,
      firstPaintMs: 145,
      controlBarSettleMs: 220,
      responses: completeResponses(40901),
      rawPassCount: 1,
      wireBytes: 80 * 1024 * 1024,
      aggregateWireReadBytes: 80 * 1024 * 1024,
      legacyScanBytesPerSec: 2_800_000_000,
      auxiliaryTargetReadBytes: 128 * 1024,
      aggregateParseInputBytes: 512 * 1024,
      ioTraceSource: 'server_product_trace',
      fullReplayMatches: true,
      fullReplayProof: { matches: true, turnCount: 12 },
    });
    assert.equal(passLegacy.passed, true);

    const failHttp404 = evaluateP01ColdChildGate({
      lane: 'legacy',
      wasColdBeforeOpen: true,
      checkpoints: [],
      httpTranscriptMs: 145,
      wsFirstResetMs: 180,
      firstPaintMs: 145,
      controlBarSettleMs: 220,
      responses: [{ ...completeResponses()[0], status: 404, code: 40401 }, ...completeResponses().slice(1)],
      rawPassCount: 1,
      wireBytes: 80 * 1024 * 1024,
      aggregateWireReadBytes: 80 * 1024 * 1024,
      legacyScanBytesPerSec: 2_800_000_000,
      aggregateParseInputBytes: 512 * 1024,
      ioTraceSource: 'server_product_trace',
      fullReplayMatches: true,
    });
    assert.equal(failHttp404.passed, false);
    assert.equal(failHttp404.exitCode, EXIT_PRODUCT_FAIL);

    const failMissingThroughputAndReplay = evaluateP01ColdChildGate({
      lane: 'legacy',
      wasColdBeforeOpen: true,
      checkpoints: [],
      httpTranscriptMs: 145,
      wsFirstResetMs: 180,
      firstPaintMs: 145,
      controlBarSettleMs: 220,
      responses: completeResponses(),
      rawPassCount: 1,
      wireBytes: 80 * 1024 * 1024,
      aggregateWireReadBytes: 80 * 1024 * 1024,
      aggregateParseInputBytes: 0,
    });
    assert.equal(failMissingThroughputAndReplay.passed, false);
    assert.equal(failMissingThroughputAndReplay.exitCode, EXIT_HARNESS_FAIL);

    const failSlowScan = evaluateP01ColdChildGate({
      lane: 'legacy',
      wasColdBeforeOpen: true,
      checkpoints: [],
      httpTranscriptMs: 180,
      wsFirstResetMs: 190,
      firstPaintMs: 180,
      controlBarSettleMs: 240,
      responses: completeResponses(),
      rawPassCount: 1,
      wireBytes: 80 * 1024 * 1024,
      aggregateWireReadBytes: 80 * 1024 * 1024,
      legacyScanBytesPerSec: 800_000_000,
      aggregateParseInputBytes: 512 * 1024,
      ioTraceSource: 'server_product_trace',
      fullReplayMatches: true,
    });
    assert.equal(failSlowScan.passed, false);
    assert.equal(failSlowScan.exitCode, EXIT_PRODUCT_FAIL);

    const failLegacyOverParse = evaluateP01ColdChildGate({
      lane: 'legacy',
      wasColdBeforeOpen: true,
      checkpoints: [],
      httpTranscriptMs: 180,
      wsFirstResetMs: 190,
      firstPaintMs: 180,
      controlBarSettleMs: 240,
      responses: [...completeResponses().slice(0, 7), { path: '/api/sessions/s/transcript/plan?agent_id=c', status: 200, code: 40923, reason: 'history_canonical_preparing' }],
      rawPassCount: 1,
      wireBytes: 80 * 1024 * 1024,
      aggregateWireReadBytes: 80 * 1024 * 1024,
      legacyScanBytesPerSec: 2_500_000_000,
      aggregateParseInputBytes: 80 * 1024 * 1024,
      ioTraceSource: 'server_product_trace',
      fullReplayMatches: true,
    });
    assert.equal(failLegacyOverParse.passed, false);
    assert.ok(failLegacyOverParse.productFailures.some((f) => f.includes('40923')));
    assert.ok(failLegacyOverParse.productFailures.some((f) => f.includes('JSON-parsed')));

    const failReopenMissingProof = evaluateP01ColdChildGate({
      lane: 'reopen',
      wasColdBeforeOpen: true,
      productionCheckpointPublished: true,
      fixtureBuiltCheckpoint: false,
      httpTranscriptMs: 90,
      wsFirstResetMs: 110,
      firstPaintMs: 90,
      controlBarSettleMs: 140,
      responses: completeResponses(0),
      aggregateWireReadBytes: 512 * 1024,
      aggregateParseInputBytes: 256 * 1024,
      ioTraceSource: 'server_product_trace',
    });
    assert.equal(failReopenMissingProof.passed, false);
    assert.equal(failReopenMissingProof.exitCode, EXIT_HARNESS_FAIL);

    const failReopenFixtureCheat = evaluateP01ColdChildGate({
      lane: 'reopen',
      wasColdBeforeOpen: true,
      productionCheckpointPublished: true,
      fixtureBuiltCheckpoint: true,
      httpTranscriptMs: 90,
      wsFirstResetMs: 110,
      firstPaintMs: 90,
      controlBarSettleMs: 140,
      responses: completeResponses(0),
      aggregateWireReadBytes: 512 * 1024,
      aggregateParseInputBytes: 256 * 1024,
      ioTraceSource: 'server_product_trace',
      summaryProof: {
        sourceIdentity: '1:2',
        storeGeneration: 'g1',
        checkpointHash: 'cc',
        coveredByteOffset: 1024,
        headSha256: 'aa',
        boundarySha256: 'bb',
        formatVersion: 1,
        verified: true,
      },
    });
    assert.equal(failReopenFixtureCheat.passed, false);
    assert.equal(failReopenFixtureCheat.exitCode, EXIT_PRODUCT_FAIL);
  });

  void it('§10.2 P0-2 main-only WS gate rejects unsubscribed child byte leaks AND rolling-5s underproduction', () => {
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

    const emptyRolling = evaluateP02MainOnlyWsGate({
      requiredStreamingChildren: 12,
      activeStreamingChildren: 12,
      controlClientChildBytes: 65536,
      unsubscribedChildContentBytes: 0,
      unsubscribedChildContentFrames: 0,
      inboundBytesPerSecP99: 4096,
      inboundBytesPerSecPeak: 8192,
      inboundFramesPerSecP99: 4,
      inboundFramesPerSecPeak: 8,
      rolling5sWindows: [],
    });
    assert.equal(emptyRolling.passed, false);
    assert.equal(emptyRolling.exitCode, EXIT_HARNESS_FAIL);

    const emptyStages = evaluateCcpRunVerdict({
      expectedRunId: 'r1',
      expectedBuildId: 'b1',
      remoteExitCode: 0,
      receipt: { runId: 'r1', buildId: 'b1', stages: {} },
      chaosReport: { runId: 'r1', overallPassed: true, skipped: 0 },
      requiredStages: [],
    });
    assert.equal(emptyStages.passed, false);
    assert.equal(emptyStages.exitCode, EXIT_HARNESS_FAIL);

    const missingBuildId = evaluateCcpRunVerdict({
      expectedRunId: 'r1',
      expectedBuildId: '',
      remoteExitCode: 0,
      receipt: { runId: 'r1', buildId: '', stages: { chaos: { exitCode: 0 } } },
      chaosReport: { runId: 'r1', overallPassed: true, skipped: 0 },
      requiredStages: ['chaos'],
    });
    assert.equal(missingBuildId.passed, false);
    assert.equal(missingBuildId.exitCode, EXIT_HARNESS_FAIL);

    const idleMissingBrowser = evaluateIdleCpuGate({
      recorderRafDisabled: true,
      windows: Array.from({ length: 12 }, () => ({ serverCorePct: 0.4, survivingDescendants: 0 })),
    });
    assert.equal(idleMissingBrowser.passed, false);
    assert.equal(idleMissingBrowser.exitCode, EXIT_HARNESS_FAIL);

    const idleTooFewWindows = evaluateIdleCpuGate({
      recorderRafDisabled: true,
      headlessNoBrowser: true,
      windows: [{ serverCorePct: 0.4, survivingDescendants: 0 }],
    });
    assert.equal(idleTooFewWindows.passed, false);
    assert.equal(idleTooFewWindows.exitCode, EXIT_HARNESS_FAIL);

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

  void it('§10.3 mesh state machine yields on Incomplete, forwards on Ready, and verifies structured wire origin & Cron recovery', () => {
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

    const tmpWireDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-s11-diag-'));
    try {
      const wirePath = path.join(tmpWireDir, 'wire.jsonl');
      fs.writeFileSync(
        wirePath,
        [
          JSON.stringify({
            type: 'context.append_message',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_ts_1',
                  name: 'ThreadSend',
                  input: { content: 'MESH_PEER_E1_test_0 digest=abc', idempotency_key: 'ik_1' },
                },
              ],
            },
          }),
          JSON.stringify({
            type: 'context.append_message',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_ts_1',
                  is_error: true,
                  content: 'undeliverable: target mailbox busy',
                },
              ],
            },
          }),
        ].join('\n'),
        'utf8',
      );
      const preview = extractSenderThreadSendResultPreview(wirePath, {
        nonce: 'MESH_PEER_E1_test_0',
        idempotencyKey: 'ik_1',
      });
      assert.equal(preview, '[is_error=true] undeliverable: target mailbox busy');
    } finally {
      fs.rmSync(tmpWireDir, { recursive: true, force: true });
    }
  });

  void it('§10.4 blind 4-trial HMAC-SHA256 mutation control passes authentic controls and rejects tampered returns', () => {
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

  void it('§10.5 distinguishes terminating timeout from foreground_detached -> TaskStop and rejects premature completion', () => {
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

    // Regression: REST /tasks maps core timed_out -> status:"failed", while canonical wire task.terminated carries info.status:"timed_out"
    const fromWire = resolveTerminatingTimeoutStatus({
      taskRow: { id: 'bash-abc12345', kind: 'bash', status: 'failed' },
      wireRecords: [{ type: 'task.terminated', info: { taskId: 'bash-abc12345', kind: 'process', status: 'timed_out' } }],
      dead: true,
    });
    assert.equal(fromWire.observedStatus, 'timed_out');
    assert.equal(fromWire.premature, false);

    const fromApiReason = resolveTerminatingTimeoutStatus({
      taskRow: { id: 'bash-abc12346', kind: 'bash', status: 'failed', terminal_reason: 'timed_out' },
      wireRecords: [],
      dead: true,
    });
    assert.equal(fromApiReason.observedStatus, 'timed_out');

    // Non-timeout failure must NEVER be masked as timed_out even when the process is dead
    const nonTimeoutFailure = resolveTerminatingTimeoutStatus({
      taskRow: { id: 'bash-abc12347', kind: 'bash', status: 'failed' },
      wireRecords: [{ type: 'task.terminated', info: { taskId: 'bash-abc12347', kind: 'process', status: 'failed', stopReason: 'exit 1' } }],
      dead: true,
    });
    assert.equal(nonTimeoutFailure.observedStatus, 'failed');

    const unconfirmedFailure = resolveTerminatingTimeoutStatus({
      taskRow: { id: 'bash-abc12348', kind: 'bash', status: 'failed' },
      wireRecords: [],
      dead: true,
    });
    assert.equal(unconfirmedFailure.observedStatus, 'failed');
  });

  void it('6-stage child chain verifier catches corrupted spill tail or altered constant', () => {
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

  void it('HIGH #2 media fixtures generate genuine ftyp+moov+trak+mdat MP4, valid Ogg/Opus, realistic PNG, and real CPU ast-build.mjs', () => {
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

  void it('idle CPU gate requires rAF disabled and enforces <=2% server / <=3% renderer / 0 descendants', () => {
    const pass = evaluateIdleCpuGate({
      tier: 'smoke',
      windowSec: 10,
      recorderRafDisabled: true,
      browserEnabled: true,
      windows: [
        { elapsedSec: 10, serverCorePct: 0.4, processCount: 2, rendererPlusGpuCorePct: 0.9, rendererProcessCount: 2, survivingDescendants: 0 },
        { elapsedSec: 10, serverCorePct: 1.1, processCount: 2, rendererPlusGpuCorePct: 1.5, rendererProcessCount: 2, survivingDescendants: 0 },
        { elapsedSec: 10, serverCorePct: 0.7, processCount: 2, rendererPlusGpuCorePct: 1.2, rendererProcessCount: 2, survivingDescendants: 0 },
      ],
    });
    assert.equal(pass.passed, true);

    const failHighCpu = evaluateIdleCpuGate({
      tier: 'smoke',
      windowSec: 10,
      recorderRafDisabled: true,
      browserEnabled: true,
      windows: [
        { elapsedSec: 10, serverCorePct: 14.2, processCount: 2, rendererPlusGpuCorePct: 1.0, rendererProcessCount: 2, survivingDescendants: 0 },
        { elapsedSec: 10, serverCorePct: 0.5, processCount: 2, rendererPlusGpuCorePct: 1.0, rendererProcessCount: 2, survivingDescendants: 0 },
        { elapsedSec: 10, serverCorePct: 0.5, processCount: 2, rendererPlusGpuCorePct: 1.0, rendererProcessCount: 2, survivingDescendants: 0 },
      ],
    });
    assert.equal(failHighCpu.passed, false);
    assert.equal(failHighCpu.exitCode, EXIT_PRODUCT_FAIL);

    // Regression: dev-mode SqliteSearchHost indexer child is an internal Kiki helper, while arbitrary workloads are NOT
    assert.equal(
      isKnownInternalKikiHelper(
        '/tmp/kiki-tools/node-v24.22.1-linux-x64/bin/node --max-old-space-size=815 --experimental-transform-types --import tsx --import file:///tmp/kiki-work/packages/kap-server/src/search/sqlite/register-dev-hooks.mjs /tmp/kiki-work/packages/kap-server/src/search/sqlite/indexerDev.ts /tmp/kiki-chaos-nvme/home/search-index-v2/index.sqlite',
      ),
      true,
    );
    assert.equal(isKnownInternalKikiHelper('/usr/bin/kiki __search-indexer /home/.kiki/search-index-v2/index.sqlite'), true);
    assert.equal(isKnownInternalKikiHelper('node /tmp/kiki-s13-faults/terminating_timeout_gc.cjs'), false);
    assert.equal(isKnownInternalKikiHelper('node /tmp/untrusted/indexerDev.ts'), false);
  });

  void it('closes all 6 fail-open counterexamples in verdict.mjs', () => {
    // Counterexample #1: P0-1 HTTP 302, missing code, slow wsFirstResetMs (>300ms), or driver-simulated scan must FAIL
    const p01Base = {
      lane: 'legacy',
      wasColdBeforeOpen: true,
      checkpoints: [],
      preexistingSummaryOrSidecar: false,
      httpTranscriptMs: 140,
      wsFirstResetMs: 416,
      firstPaintMs: 140,
      controlBarSettleMs: 220,
      responses: [
        { path: '/api/sessions/s/transcript?agent_id=c', status: 302 },
        { path: '/api/agents/capabilities?session_id=s&agent_id=c&metrics_settle=true', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/model-switches', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/hooks?observe=true', status: 200, code: 40901 },
        { path: '/api/sessions/s/agents/c/auto-compact?observe=true', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/context-strategy?observe=true', status: 200, code: 0 },
        { path: '/api/sessions/s/status', status: 200, code: 0 },
        { path: '/api/sessions/s/transcript/plan?agent_id=c', status: 200, code: 0 },
      ],
      rawPassCount: 1,
      wireBytes: 80 * 1024 * 1024,
      aggregateWireReadBytes: 80 * 1024 * 1024,
      legacyScanBytesPerSec: 2_800_000_000,
      aggregateParseInputBytes: 512 * 1024,
      driverSimulatedScan: true,
      fullReplayMatches: true,
    };
    const r1 = evaluateP01ColdChildGate(p01Base);
    assert.equal(r1.passed, false);
    assert.ok(r1.productFailures.some((f) => f.includes('WS transcript.reset')));
    assert.ok(r1.productFailures.some((f) => f.includes('302')));
    assert.ok(r1.harnessFailures.some((f) => f.includes('IO attribution')));

    // Counterexample #2: P0-2 caller passing minRollingWindows: 0 must NOT bypass rolling5sWindows
    const r2 = evaluateP02MainOnlyWsGate({
      tier: 'smoke',
      minRollingWindows: 0,
      requiredStreamingChildren: 4,
      activeStreamingChildren: 4,
      controlClientChildBytes: 1024,
      unsubscribedChildContentBytes: 0,
      unsubscribedChildContentFrames: 0,
      inboundBytesPerSecP99: 1024,
      inboundBytesPerSecPeak: 2048,
      inboundFramesPerSecP99: 4,
      inboundFramesPerSecPeak: 8,
      rolling5sWindows: [],
    });
    assert.equal(r2.passed, false);
    assert.equal(r2.exitCode, EXIT_HARNESS_FAIL);

    // Counterexample #3: S10 caller passing relaxed limits or stub HTML must NOT pass
    const r3 = evaluateS10Verdict(
      {
        tier: 'smoke',
        peakActiveChildren: 4,
        totalChildToolCalls: 16,
        overlapBucketsQualified: 2,
        browserRequired: true,
        guiDistServed: false,
        usedStubHtml: true,
        failedSends: 0,
        durableReceiptsVerified: true,
        flightRecorder: { sampleCount: 100, cls: 0, rawLayoutShift: 0, transcriptRootRemounts: 0, consoleErrors: 0, composerTyping: { samples: 10, p95Ms: 12 } },
        textPromptAdmission: { samples: 2, p95Ms: 900, maxMs: 900 },
        pngPromptAdmission: { samples: 2, p95Ms: 200, maxMs: 200 },
        promptAdmission: { p95Ms: 900, maxMs: 900 },
        sendToReceipt: { samples: 4, p95Ms: 900, maxMs: 900 },
        eld: { p99Ms: 10, maxMs: 20 },
      },
      { promptAdmissionTextP95Ms: 5000, sendToReceiptP95Ms: 5000 },
    );
    assert.equal(r3.passed, false);
    assert.ok(r3.productFailures.some((f) => f.includes('warm text prompt_admission')));
    assert.ok(r3.harnessFailures.some((f) => f.includes('stub HTML')));

    // Counterexample #4: S14 full tier ignoring headlessNoBrowser=true & rejecting 0-process sampling
    const r4 = evaluateIdleCpuGate({
      tier: 'full',
      headlessNoBrowser: true,
      recorderRafDisabled: true,
      windows: Array.from({ length: 12 }, () => ({ serverCorePct: 0.5, processCount: 0, survivingDescendants: 0 })),
    });
    assert.equal(r4.passed, false);
    assert.equal(r4.exitCode, EXIT_HARNESS_FAIL);
    assert.ok(r4.harnessFailures.some((f) => f.includes('full tier requires visible browser')));
    assert.ok(r4.harnessFailures.some((f) => f.includes('0 server processes')));

    // Counterexample #5: verifySavedBundle / evaluateCcpRunVerdict rejects missing v2.3 scenarios or empty S13 cells
    const r5 = evaluateCcpRunVerdict({
      expectedRunId: 'run_v23_1',
      expectedBuildId: 'sha_1234',
      remoteExitCode: 0,
      receipt: {
        runId: 'run_v23_1',
        buildId: 'sha_1234',
        stages: { hygiene: { exitCode: 0 }, unitTests: { exitCode: 0 }, chaos: { exitCode: 0 } },
      },
      chaosReport: {
        runId: 'run_v23_1',
        buildId: 'sha_1234',
        mode: 'v23',
        tier: 'v23-smoke',
        overallPassed: true,
        skipped: 0,
        scenarios: { s13: { cells: [] } },
      },
    });
    assert.equal(r5.passed, false);
    assert.equal(r5.exitCode, EXIT_HARNESS_FAIL);
    assert.ok(r5.harnessFailures.some((f) => f.includes('Missing required v2.3 scenario "p01"')));
    assert.ok(r5.harnessFailures.some((f) => f.includes('S13 scenario requires >= 3')));

    // Counterexample #6: mismatched buildId in chaosReport vs manifest fails closed
    const r6 = evaluateCcpRunVerdict({
      expectedRunId: 'run_v23_2',
      expectedBuildId: 'sha_expected',
      remoteExitCode: 0,
      receipt: {
        runId: 'run_v23_2',
        buildId: 'sha_expected',
        stages: { hygiene: { exitCode: 0 }, unitTests: { exitCode: 0 }, chaos: { exitCode: 0 } },
      },
      chaosReport: {
        runId: 'run_v23_2',
        buildId: 'sha_different',
        overallPassed: true,
        skipped: 0,
      },
    });
    assert.equal(r6.passed, false);
    assert.equal(r6.exitCode, EXIT_HARNESS_FAIL);
    assert.ok(r6.harnessFailures.some((f) => f.includes('chaos report buildId')));
  });

  void it('Round-2 affirmative evidence & bundle stage/tier binding negative gates', () => {
    // 1. hygiene-only receipt rejected by verifySavedBundle with EXIT_HARNESS_FAIL
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-verdict-hygiene-only-'));
    try {
      fs.writeFileSync(
        path.join(tmp, 'manifest.json'),
        JSON.stringify({ runId: 'r_hyg', buildId: 'b_hyg', tier: 'v23-smoke', requiredStages: ['hygiene'] }),
      );
      fs.writeFileSync(
        path.join(tmp, 'run-receipt.json'),
        JSON.stringify({ runId: 'r_hyg', buildId: 'b_hyg', remoteExitCode: 0, stages: { hygiene: { exitCode: 0 } } }),
      );
      fs.writeFileSync(
        path.join(tmp, 'chaos-report.json'),
        JSON.stringify({ runId: 'r_hyg', buildId: 'b_hyg', tier: 'v23-smoke', overallPassed: true, skipped: 0 }),
      );
      const rHyg = verifySavedBundle(tmp);
      assert.equal(rHyg.passed, false);
      assert.equal(rHyg.exitCode, EXIT_HARNESS_FAIL);
      assert.ok(rHyg.harnessFailures.some((f) => f.includes('unitTests') || f.includes('chaos')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // 2. manifest.tier !== report.tier rejected with EXIT_HARNESS_FAIL
    const rTier = evaluateCcpRunVerdict({
      expectedRunId: 'r_tier',
      expectedBuildId: 'b_tier',
      expectedTier: 'v23-full',
      remoteExitCode: 0,
      receipt: { runId: 'r_tier', buildId: 'b_tier', stages: { hygiene: { exitCode: 0 }, unitTests: { exitCode: 0 }, chaos: { exitCode: 0 } } },
      chaosReport: { runId: 'r_tier', buildId: 'b_tier', tier: 'v23-smoke', overallPassed: true, skipped: 0 },
    });
    assert.equal(rTier.passed, false);
    assert.equal(rTier.exitCode, EXIT_HARNESS_FAIL);
    assert.ok(rTier.harnessFailures.some((f) => f.includes('Tier mismatch')));

    // 3. S13 missing or < 8 chaosFaults rejected with EXIT_HARNESS_FAIL
    const rS13 = evaluateCcpRunVerdict({
      expectedRunId: 'r_s13',
      expectedBuildId: 'b_s13',
      expectedTier: 'v23-smoke',
      remoteExitCode: 0,
      receipt: { runId: 'r_s13', buildId: 'b_s13', stages: { hygiene: { exitCode: 0 }, unitTests: { exitCode: 0 }, chaos: { exitCode: 0 } } },
      chaosReport: {
        runId: 'r_s13',
        buildId: 'b_s13',
        tier: 'v23-smoke',
        overallPassed: true,
        skipped: 0,
        scenarios: {
          s13: {
            cells: [
              { kind: 'terminating_timeout', prematureTaskCompletionWhileGrandchildAlive: false, scheduledDeadlineMs: 2000, cleanupAtMs: 2500, terminalStatus: 'timed_out', survivingDescendants: 0 },
              { kind: 'foreground_detach_then_stop', prematureTaskCompletionWhileGrandchildAlive: false, detachReason: 'foreground_detached', detachReceiptDelayFromDeadlineMs: 100, terminalStatusAfterStop: 'killed', cleanupMsFromStopIngress: 300, survivingDescendants: 0 },
              { kind: 'direct_cancel', prematureTaskCompletionWhileGrandchildAlive: false, terminalStatus: 'killed', cleanupMsFromCancelIngress: 200, survivingDescendants: 0 },
            ],
            faultCells: [{ kind: 'f1', passed: true }],
          },
        },
      },
    });
    assert.equal(rS13.passed, false);
    assert.equal(rS13.exitCode, EXIT_HARNESS_FAIL);
    assert.ok(rS13.harnessFailures.some((f) => f.includes('>= 8 live chaosFaults')));

    // 4. S10 missing p02, missing cls, or missing true maxMs rejected with EXIT_HARNESS_FAIL
    const rS10 = evaluateS10Verdict({
      tier: 'smoke',
      peakActiveChildren: 4,
      totalChildToolCalls: 16,
      overlapBucketsQualified: 2,
      browserRequired: true,
      guiDistServed: true,
      failedSends: 0,
      durableReceiptsVerified: true,
      durableReceiptsMissing: 0,
      flightRecorder: { sampleCount: 50, transcriptRootRemounts: 0, consoleErrors: 0, composerTyping: { samples: 10, p95Ms: 10 } },
      textPromptAdmission: { samples: 2, p95Ms: 80 },
      pngPromptAdmission: { samples: 2, p95Ms: 120, maxMs: 150 },
      promptAdmission: { p95Ms: 120, maxMs: 150 },
      sendToReceipt: { samples: 4, p95Ms: 200, maxMs: 250 },
      eld: { p99Ms: 12, maxMs: 25 },
    });
    assert.equal(rS10.passed, false);
    assert.equal(rS10.exitCode, EXIT_HARNESS_FAIL);
    assert.ok(rS10.harnessFailures.some((f) => f.includes('p02')));
    assert.ok(rS10.harnessFailures.some((f) => f.includes('numeric cls')));
    assert.ok(rS10.harnessFailures.some((f) => f.includes('textPromptAdmission.maxMs')));

    // 5. P0-1 > 8 MiB cold /hooks?observe=true returning code=0 rejected with EXIT_PRODUCT_FAIL
    const rP01Hooks = evaluateP01ColdChildGate({
      lane: 'legacy',
      wasColdBeforeOpen: true,
      checkpoints: [],
      preexistingSummaryOrSidecar: false,
      httpTranscriptMs: 120,
      wsFirstResetMs: 150,
      firstPaintMs: 150,
      controlBarSettleMs: 220,
      responses: [
        { path: '/api/sessions/s/transcript?agent_id=c', status: 200, code: 0 },
        { path: '/api/agents/capabilities?session_id=s&agent_id=c&metrics_settle=true', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/model-switches', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/hooks?observe=true', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/auto-compact?observe=true', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/context-strategy?observe=true', status: 200, code: 0 },
        { path: '/api/sessions/s/status', status: 200, code: 0 },
        { path: '/api/sessions/s/transcript/plan?agent_id=c', status: 200, code: 0 },
      ],
      rawPassCount: 1,
      wireBytes: 20 * 1024 * 1024,
      aggregateWireReadBytes: 20 * 1024 * 1024,
      legacyScanBytesPerSec: 3_000_000_000,
      aggregateParseInputBytes: 256 * 1024,
      ioTraceSource: 'server_product_trace',
      fullReplayMatches: true,
    });
    assert.equal(rP01Hooks.passed, false);
    assert.equal(rP01Hooks.exitCode, EXIT_PRODUCT_FAIL);
    assert.ok(rP01Hooks.productFailures.some((f) => f.includes('/hooks')));
  });

  void it('F2/F3/F4/S16 zero-compromise gates: webAssets compression, honest wireReadyMs + browserGuiCheck, and S16 mobile thresholds', () => {
    // F2: 0%-compressed 6.57 MiB JS fails evaluateWebAssetsBudget; compressed passes
    const badAssets = evaluateWebAssetsBudget({
      servedByKapServer: true,
      jsAssetsCount: 17,
      jsTotalTransferBytes: 6_890_000,
      jsCompressedCount: 0,
      jsUncompressedCount: 17,
      allJsCompressed: false,
      contentEncodings: ['identity'],
      failedAssets: [],
      jsWrongContentType: [],
    });
    assert.equal(badAssets.passed, false);
    assert.ok(badAssets.failures.some((f) => /uncompressed/i.test(f)));

    const goodAssets = evaluateWebAssetsBudget({
      servedByKapServer: true,
      jsAssetsCount: 8,
      jsTotalTransferBytes: 900_000,
      jsCompressedCount: 8,
      jsUncompressedCount: 0,
      allJsCompressed: true,
      contentEncodings: ['br'],
      failedAssets: [],
      jsWrongContentType: [],
    });
    assert.equal(goodAssets.passed, true);

    // Large valid compressed JS delivery passes by default without ungrounded size ceilings,
    // while an explicit caller maxTransferBytes ceiling is honored when supplied.
    const largeValidCompressedAssets = evaluateWebAssetsBudget({
      servedByKapServer: true,
      jsAssetsCount: 8,
      jsTotalTransferBytes: 3 * 1024 * 1024,
      jsCompressedCount: 8,
      jsUncompressedCount: 0,
      allJsCompressed: true,
      contentEncodings: ['br'],
      failedAssets: [],
      jsWrongContentType: [],
    });
    assert.equal(largeValidCompressedAssets.passed, true);

    const explicitCeilingExceeded = evaluateWebAssetsBudget(
      {
        servedByKapServer: true,
        jsAssetsCount: 8,
        jsTotalTransferBytes: 3 * 1024 * 1024,
        jsCompressedCount: 8,
        jsUncompressedCount: 0,
        allJsCompressed: true,
        contentEncodings: ['gzip'],
        failedAssets: [],
        jsWrongContentType: [],
      },
      { maxTransferBytes: 2 * 1024 * 1024 },
    );
    assert.equal(explicitCeilingExceeded.passed, false);
    assert.ok(explicitCeilingExceeded.failures.some((f) => /explicit .* ceiling/i.test(f)));

    // F3 & F4 + Item 2: P01 rejects missing browserGuiCheck when required AND rejects newConsoleErrors
    const p01MissingBrowser = evaluateP01ColdChildGate({
      wasColdBeforeOpen: true,
      checkpoints: [],
      httpTranscriptMs: 90,
      wsFirstResetMs: 110,
      wireReadyMs: 120,
      controlBarSettleMs: 180,
      responses: [
        { path: '/api/sessions/s/transcript?agent_id=c', status: 200, code: 0 },
        { path: '/api/agents/capabilities?session_id=s&agent_id=c&metrics_settle=true', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/model-switches', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/hooks?observe=true', status: 200, code: 40901 },
        { path: '/api/sessions/s/agents/c/auto-compact?observe=true', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/context-strategy?observe=true', status: 200, code: 0 },
        { path: '/api/sessions/s/status', status: 200, code: 0 },
        { path: '/api/sessions/s/transcript/plan?agent_id=c', status: 200, code: 0 },
      ],
      rawPassCount: 1,
      wireBytes: 20 * 1024 * 1024,
      aggregateWireReadBytes: 20 * 1024 * 1024,
      legacyScanBytesPerSec: 3_000_000_000,
      aggregateParseInputBytes: 256 * 1024,
      ioTraceSource: 'server_product_trace',
      fullReplayMatches: true,
      browserGuiRequired: true,
      browserGuiCheck: null,
    });
    assert.equal(p01MissingBrowser.passed, false);
    assert.equal(p01MissingBrowser.exitCode, EXIT_HARNESS_FAIL);
    assert.ok(p01MissingBrowser.harnessFailures.some((f) => /browserGuiCheck/i.test(f)));

    const p01FailBrowser = evaluateP01ColdChildGate({
      wasColdBeforeOpen: true,
      checkpoints: [],
      httpTranscriptMs: 90,
      wsFirstResetMs: 110,
      wireReadyMs: 120,
      controlBarSettleMs: 180,
      responses: [
        { path: '/api/sessions/s/transcript?agent_id=c', status: 200, code: 0 },
        { path: '/api/agents/capabilities?session_id=s&agent_id=c&metrics_settle=true', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/model-switches', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/hooks?observe=true', status: 200, code: 40901 },
        { path: '/api/sessions/s/agents/c/auto-compact?observe=true', status: 200, code: 0 },
        { path: '/api/sessions/s/agents/c/context-strategy?observe=true', status: 200, code: 0 },
        { path: '/api/sessions/s/status', status: 200, code: 0 },
        { path: '/api/sessions/s/transcript/plan?agent_id=c', status: 200, code: 0 },
      ],
      rawPassCount: 1,
      wireBytes: 20 * 1024 * 1024,
      aggregateWireReadBytes: 20 * 1024 * 1024,
      legacyScanBytesPerSec: 3_000_000_000,
      aggregateParseInputBytes: 256 * 1024,
      ioTraceSource: 'server_product_trace',
      fullReplayMatches: true,
      browserGuiRequired: true,
      browserGuiCheck: {
        ok: false,
        firstMessagePaintMs: 4200,
        newConsoleErrors: 2,
        pageErrors: ['ReferenceError: x'],
        mobileCheck: { ok: false, firstMessagePaintMs: 5500, error: 'mobile slow paint' },
      },
    });
    assert.equal(p01FailBrowser.passed, false);
    assert.equal(p01FailBrowser.exitCode, EXIT_PRODUCT_FAIL);
    assert.ok(p01FailBrowser.productFailures.some((f) => /browser GUI/i.test(f)));
    assert.ok(p01FailBrowser.productFailures.some((f) => /console error/i.test(f)));
    assert.ok(p01FailBrowser.productFailures.some((f) => /mobile Chromium/i.test(f)));

    const mobileEmulation = {
      viewport: { width: 393, height: 852, dpr: 3 },
      cpuThrottlingRate: 4,
      network: { latencyMs: 40, downloadMbps: 15, uploadMbps: 5 },
      reducedMotion: 'no-preference',
    };

    // S16: reproduces real dorm-3090 baseline failure (0%-compressed 6.57 MiB JS, 7266ms boot, 1805ms TTFM, 66.7ms scroll P95)
    const s16Lag = evaluateS16MobileVerdict({
      emulation: mobileEmulation,
      coldBoot: { coldBootToShellMs: 7266, totalBlockingTimeMs: 2980, maxLongTaskMs: 1844 },
      webAssetsAudit: {
        servedByKapServer: true,
        jsChunkCount: 17,
        compressedJsChunkCount: 0,
        uncompressedJsChunkCount: 17,
        jsTotalEncodedMiB: 6.57,
      },
      heavyOpen: {
        firstMessagePaintMs: 1805,
        totalBlockingTimeMs: 950,
        maxLongTaskMs: 490,
        httpRpcRequestCount: 17,
        httpRpcTransferBytes: 162_700,
        errorToastsOnOpen: 0,
      },
      touchScroll: { frameCount: 28, frameP95Ms: 66.7, maxLongTaskMs: 101 },
      rapidSwitch: { count: 5, latencyMs: { p95: 420 }, stickyUnreadCount: 0 },
      pageErrors: [],
      consoleErrorCount: 0,
    });
    assert.equal(s16Lag.passed, false);
    assert.equal(s16Lag.exitCode, EXIT_PRODUCT_FAIL);
    assert.ok(s16Lag.productFailures.length >= 3);

    // S16: clean optimized mobile session passes
    const s16Fast = evaluateS16MobileVerdict({
      emulation: mobileEmulation,
      coldBoot: { coldBootToShellMs: 1400, totalBlockingTimeMs: 180, maxLongTaskMs: 160 },
      webAssetsAudit: {
        servedByKapServer: true,
        jsChunkCount: 6,
        compressedJsChunkCount: 6,
        uncompressedJsChunkCount: 0,
        jsTotalEncodedMiB: 0.42,
      },
      heavyOpen: {
        firstMessagePaintMs: 520,
        totalBlockingTimeMs: 120,
        maxLongTaskMs: 110,
        httpRpcRequestCount: 6,
        httpRpcTransferBytes: 48_000,
        errorToastsOnOpen: 0,
      },
      touchScroll: { frameCount: 30, frameP95Ms: 22, maxLongTaskMs: 40 },
      rapidSwitch: { count: 5, latencyMs: { p95: 380 }, stickyUnreadCount: 0 },
      pageErrors: [],
      consoleErrorCount: 0,
    });
    assert.equal(s16Fast.passed, true);
    assert.equal(s16Fast.exitCode, EXIT_PASS);

    // Item 5: vacuous S16 report (0 jsChunks, 0 scroll frames, missing TBT/LongTask, missing rapidSwitch p95) fails harness
    const s16Vacuous = evaluateS16MobileVerdict({
      emulation: mobileEmulation,
      coldBoot: { coldBootToShellMs: 1000 },
      webAssetsAudit: { servedByKapServer: true, jsChunkCount: 0, compressedJsChunkCount: 0, jsTotalEncodedMiB: 0 },
      heavyOpen: { firstMessagePaintMs: 400 },
      touchScroll: { frameCount: 0, frameP95Ms: 16 },
      rapidSwitch: { count: 5, latencyMs: {} },
      pageErrors: [],
    });
    assert.equal(s16Vacuous.passed, false);
    assert.equal(s16Vacuous.exitCode, EXIT_HARNESS_FAIL);
    assert.ok(s16Vacuous.harnessFailures.length >= 5);

    // Item 3: S13 extractWireLoopEvent unwraps native context.append_loop_event.event
    const unwrappedCall = extractWireLoopEvent({
      time: 1_760_000_001_000,
      type: 'context.append_loop_event',
      payload: { event: { type: 'tool.call', payload: { id: 'call_1', name: 'Bash' } } },
    });
    assert.equal(unwrappedCall?.type, 'tool.call');
    assert.equal(unwrappedCall?.payload?.name, 'Bash');
    assert.equal(unwrappedCall?.time, 1_760_000_001_000);

    // Item 6: S8 synthetic MP4 is genuinely decodable (ftyp+moov+trak+mdat), not mdat-only filler
    const mp4Info = inspectMp4Structure(generateSyntheticMp4(64 * 1024));
    assert.equal(mp4Info.hasFtyp, true);
    assert.equal(mp4Info.hasMoov, true);
    assert.equal(mp4Info.hasTrak, true);
    assert.equal(mp4Info.hasMdat, true);

    // S16 meta-gate: unthrottled CPU fails with EXIT_HARNESS_FAIL
    const s16Cheated = evaluateS16MobileVerdict({
      emulation: { ...mobileEmulation, cpuThrottlingRate: 1 },
      coldBoot: { coldBootToShellMs: 500, totalBlockingTimeMs: 10, maxLongTaskMs: 20 },
      webAssetsAudit: { servedByKapServer: true, jsChunkCount: 6, compressedJsChunkCount: 6, jsTotalEncodedMiB: 0.42 },
      heavyOpen: { firstMessagePaintMs: 200, totalBlockingTimeMs: 10, maxLongTaskMs: 20, httpRpcRequestCount: 5, errorToastsOnOpen: 0 },
      touchScroll: { frameP95Ms: 16.7, maxLongTaskMs: 20 },
      rapidSwitch: { count: 5, latencyMs: { p95: 150 }, stickyUnreadCount: 0 },
      pageErrors: [],
      consoleErrorCount: 0,
    });
    assert.equal(s16Cheated.passed, false);
    assert.equal(s16Cheated.exitCode, EXIT_HARNESS_FAIL);
  });

  it('S17 Workstation-Cliff negative meta-gates & single-source matrix target evaluation', () => {
    // Structural validation rejects non-positive targets, missing sections, and underscaled full workloads,
    // while tightening a target in the matrix runs cleanly and evaluates verdict against the new target.
    const nonPositiveMatrix = structuredClone(loadChaosMatrix('smoke'));
    nonPositiveMatrix.tiers.s17WorkstationCliff.sqliteContention.searchP95MaxMs = 0;
    const parityFail = validateMatrixThresholdParity(nonPositiveMatrix);
    assert.equal(parityFail.ok, false);
    assert.ok(parityFail.drifts.some((d) => d.includes('searchP95MaxMs')));

    const missingIdle = structuredClone(loadChaosMatrix('smoke'));
    delete missingIdle.tiers.idleCpu;
    assert.equal(validateMatrixThresholdParity(missingIdle).ok, false);

    const underscaledFull = structuredClone(loadChaosMatrix('ccp'));
    underscaledFull.tiers.s17WorkstationCliff.corpus.coldSessions = 1;
    assert.equal(validateMatrixThresholdParity(underscaledFull).ok, false);

    const tightenedMatrix = structuredClone(loadChaosMatrix('smoke'));
    tightenedMatrix.tiers.s17WorkstationCliff.sqliteContention.searchP95MaxMs = 150;
    assert.equal(validateMatrixThresholdParity(tightenedMatrix).ok, true);

    const cleanS17 = () => ({
      runId: 's17_unit_clean',
      matrixName: 'smoke',
      tier: 'smoke',
      platform: 'win32',
      workspacePathCliffs: {
        inventoryLimit: 500,
        symlinksUsed: 0,
        toolEvidence: {
          concurrentProbesExecuted: 4,
          concurrentProbesSucceeded: 4,
          postMutationFileVisible: true,
          bashResultsOk: 2,
          globResultsOk: 3,
          grepResultsOk: 3,
          toolErrors: 0,
        },
        subOverflow: { fileCount: 360, entryCount: 401, overflow: false, concurrentToolsPassed: true },
        umbrellaOverflow: { fileCount: 640, isNonGit: true, overflow: true, fallbackToolsPassed: true },
      },
      sqliteContention: {
        searchEnabled: true,
        searchIndexerState: 'ready',
        seededSearchDocs: 400,
        seededHistoryNavRows: 300,
        seededUsageFacts: 400,
        searchQueriesSucceeded: 8,
        searchQueriesFailed: 0,
        searchHitsTotal: 24,
        searchLatencyMs: { p95: 420 },
        listQueriesSucceeded: 4,
        listQueriesFailed: 0,
        listLatencyMs: { p95: 180 },
        usageQueriesSucceeded: 4,
        usageQueriesFailed: 0,
        usageLatencyMs: { p95: 310 },
        walConcurrentReadsCompleted: 24,
        walReaderStats: {
          workerThreadsUsed: true,
          overlappingWalWriter: true,
          walWritesCompleted: 4,
          walBytesObserved: 16384,
          failed: 0,
          matchedRows: 240,
        },
        promptUnderContentionOk: true,
        promptAdmissionMs: 920,
      },
      multiSessionStorm: {
        writingSessionsAttempted: 4,
        writingSessionsSucceeded: 4,
        activeChildrenTarget: 4,
        observedActiveChildren: 4,
        writeResultsOk: 6,
        coldOpensOverlappedWriters: true,
        coldMainWireBytes: 12_641_291,
        coldMainOpensAttempted: 1,
        coldMainOpensSucceeded: 1,
        coldMainTranscriptItems: 12,
        coldChildWireBytes: 10_737_418,
        coldChildOpensSucceeded: 1,
        coldChildTranscriptItems: 5,
        contractViolations: 0,
      },
      upstreamFaults: {
        sync429RetryAfterAttempted: 2,
        sync429RetryAfterRecovered: 2,
        sync429RetryAfterDelayRespected: 2,
        sync429RetryAfterDelaysMs: [1050, 1080],
        sync429NoRetryAttempted: 1,
        sync429NoRetryVetoRespected: 1,
        sync524Attempted: 2,
        sync524Recovered: 2,
      },
      externalStalls: {
        mcpStallProbed: true,
        mcpConnectionsAccepted: 1,
        mcpStallContained: true,
        sshStallProbed: true,
        sshConnectionsAccepted: 1,
        sshStallContained: true,
        concurrentHealthSamples: 12,
        concurrentHealthFailures: 0,
        concurrentHealthMaxMs: 42,
      },
      residencyEviction: {
        sessionsOpened: 8,
        peakLiveSessions: 8,
        peakRssMiB: 1320,
        peakHandleCount: 440,
        postAutoSweepLiveSessions: 4,
        autoEvictionAttempts: 8,
        autoEvictionSuccesses: 4,
        autoEvictedBelowCap: true,
        postEvictLiveSessions: 0,
        postEvictMaxLiveSessions: 4,
        postEvictRssMiB: 1280,
        postEvictHandleCount: 410,
        drainedCleanly: true,
        unhandledRejections: 0,
        uncaughtExceptions: 0,
      },
      processHelperContention: {
        platform: 'win32',
        burstsAttempted: 4,
        burstsSucceeded: 4,
        concurrentGlobGrepCount: 4,
        bashToolCallsOk: 4,
        globToolCallsOk: 4,
        grepToolCallsOk: 4,
        toolErrors: 0,
        win32HelperVerified: true,
        processScanSucceeded: true,
        burstLatencyMs: { p95: 4200 },
        survivingDescendants: 0,
      },
      eld: { p99Ms: 35, maxMs: 180 },
    });

    const ok = evaluateS17WorkstationCliffVerdict(cleanS17(), 'smoke');
    assert.equal(ok.passed, true);

    const slowForTightened = cleanS17();
    slowForTightened.sqliteContention.searchLatencyMs = { p50: 80, p95: 250, max: 300 };
    assert.equal(evaluateS17WorkstationCliffVerdict(slowForTightened, 'smoke').passed, true);
    const tightenedVerdict = evaluateS17WorkstationCliffVerdict(slowForTightened, tightenedMatrix);
    assert.equal(tightenedVerdict.passed, false);
    assert.equal(tightenedVerdict.exitCode, EXIT_PRODUCT_FAIL);
    assert.equal(ok.passed, true, `Expected cleanS17 pass, got: ${JSON.stringify(ok)}`);
    assert.equal(ok.exitCode, EXIT_PASS);

    // 1. Symlink cheat fails harness
    const withSymlinks = cleanS17();
    withSymlinks.workspacePathCliffs.symlinksUsed = 12;
    assert.equal(evaluateS17WorkstationCliffVerdict(withSymlinks, 'smoke').exitCode, EXIT_HARNESS_FAIL);

    // 2. Disabled [search] fails harness
    const searchOff = cleanS17();
    searchOff.sqliteContention.searchEnabled = false;
    assert.equal(evaluateS17WorkstationCliffVerdict(searchOff, 'smoke').exitCode, EXIT_HARNESS_FAIL);

    // 3. Zero search hits fails product gate
    const zeroHits = cleanS17();
    zeroHits.sqliteContention.searchHitsTotal = 0;
    assert.equal(evaluateS17WorkstationCliffVerdict(zeroHits, 'smoke').exitCode, EXIT_PRODUCT_FAIL);

    // 4. Failed WAL reads or missing Worker threads fail harness
    const walFailed = cleanS17();
    walFailed.sqliteContention.walReaderStats.failed = 1;
    assert.equal(evaluateS17WorkstationCliffVerdict(walFailed, 'smoke').exitCode, EXIT_HARNESS_FAIL);

    // 5. Underscaled writers/children or zero-byte cold wires fail harness (including full tier)
    const underscaledStorm = cleanS17();
    underscaledStorm.multiSessionStorm.writingSessionsAttempted = 1;
    underscaledStorm.multiSessionStorm.writingSessionsSucceeded = 1;
    assert.equal(evaluateS17WorkstationCliffVerdict(underscaledStorm, 'smoke').exitCode, EXIT_HARNESS_FAIL);

    const zeroWire = cleanS17();
    zeroWire.multiSessionStorm.coldChildWireBytes = 0;
    assert.equal(evaluateS17WorkstationCliffVerdict(zeroWire, 'smoke').exitCode, EXIT_HARNESS_FAIL);

    // 6. Smoke receipt mutated to full file counts still fails full tier on underscaled writers/children/seeds
    const fakeFull = cleanS17();
    fakeFull.workspacePathCliffs.subOverflow.fileCount = 220_000;
    fakeFull.workspacePathCliffs.umbrellaOverflow.fileCount = 290_000;
    assert.equal(evaluateS17WorkstationCliffVerdict(fakeFull, 'full').exitCode, EXIT_HARNESS_FAIL);

    // 7. Missing ELD fails harness
    const noEld = cleanS17();
    delete noEld.eld;
    assert.equal(evaluateS17WorkstationCliffVerdict(noEld, 'smoke').exitCode, EXIT_HARNESS_FAIL);

    // 8. SSH mock with 0 accepted connections fails harness
    const sshUncontacted = cleanS17();
    sshUncontacted.externalStalls.sshConnectionsAccepted = 0;
    assert.equal(evaluateS17WorkstationCliffVerdict(sshUncontacted, 'smoke').exitCode, EXIT_HARNESS_FAIL);

    // 9. Failed 429 x-should-retry:false veto or unhonored Retry-After delay fails product gate
    const badVeto = cleanS17();
    badVeto.upstreamFaults.sync429NoRetryVetoRespected = 0;
    assert.equal(evaluateS17WorkstationCliffVerdict(badVeto, 'smoke').exitCode, EXIT_PRODUCT_FAIL);

    const noDelay = cleanS17();
    noDelay.upstreamFaults.sync429RetryAfterDelayRespected = 0;
    assert.equal(evaluateS17WorkstationCliffVerdict(noDelay, 'smoke').exitCode, EXIT_PRODUCT_FAIL);

    // 10. Failed automatic eviction or failed process scan fails gate
    const noAutoEvict = cleanS17();
    noAutoEvict.residencyEviction.autoEvictedBelowCap = false;
    noAutoEvict.residencyEviction.autoEvictionSuccesses = 0;
    assert.equal(evaluateS17WorkstationCliffVerdict(noAutoEvict, 'smoke').exitCode, EXIT_PRODUCT_FAIL);

    const badScan = cleanS17();
    badScan.processHelperContention.processScanSucceeded = false;
    assert.equal(evaluateS17WorkstationCliffVerdict(badScan, 'smoke').exitCode, EXIT_HARNESS_FAIL);

    // 11. Surviving workload descendants fail product gate
    const leakedChild = cleanS17();
    leakedChild.processHelperContention.survivingDescendants = 1;
    assert.equal(evaluateS17WorkstationCliffVerdict(leakedChild, 'smoke').exitCode, EXIT_PRODUCT_FAIL);

    // 12. S17 integrates cleanly into evaluateCcpRunVerdict, and empty scenarios/missing skipped fail closed
    const ccpPass = evaluateCcpRunVerdict({
      expectedRunId: 'run_s17_ok',
      expectedBuildId: 'build_s17_ok',
      remoteExitCode: 0,
      receipt: {
        runId: 'run_s17_ok',
        buildId: 'build_s17_ok',
        stages: { hygiene: { exitCode: 0 }, unitTests: { exitCode: 0 }, chaos: { exitCode: 0 } },
      },
      chaosReport: {
        runId: 'run_s17_ok',
        buildId: 'build_s17_ok',
        mode: 'workstation-cliff',
        tier: 'smoke',
        matrix: { name: 'smoke', tier: 'smoke', parityOk: true },
        overallPassed: true,
        skipped: 0,
        scenarios: { s17: cleanS17() },
      },
      hygieneReport: { ok: true, contractFailures: [], unexemptedDisabled: [], unexemptedTreeMocks: [] },
    });
    assert.equal(ccpPass.passed, true, `Expected ccpPass.passed=true, got: ${JSON.stringify(ccpPass)}`);
    assert.equal(ccpPass.exitCode, EXIT_PASS);

    const strippedBundle = evaluateCcpRunVerdict({
      expectedRunId: 'run_s17_ok',
      expectedBuildId: 'build_s17_ok',
      remoteExitCode: 0,
      receipt: {
        runId: 'run_s17_ok',
        buildId: 'build_s17_ok',
        stages: { hygiene: { exitCode: 0 }, unitTests: { exitCode: 0 }, chaos: { exitCode: 0 } },
      },
      chaosReport: {
        runId: 'run_s17_ok',
        buildId: 'build_s17_ok',
        overallPassed: true,
      },
      hygieneReport: { ok: true, contractFailures: [], unexemptedDisabled: [], unexemptedTreeMocks: [] },
    });
    assert.equal(strippedBundle.passed, false);
    assert.equal(strippedBundle.exitCode, EXIT_HARNESS_FAIL);

    // 13. Smoke matrix cannot spoof expectedTier='full', and 1-byte wires / leaked handles / missing toolEvidence fail
    const spoofedMatrix = evaluateCcpRunVerdict({
      expectedRunId: 'run_s17_ok',
      expectedBuildId: 'build_s17_ok',
      expectedTier: 'full',
      remoteExitCode: 0,
      receipt: {
        runId: 'run_s17_ok',
        buildId: 'build_s17_ok',
        stages: { hygiene: { exitCode: 0 }, unitTests: { exitCode: 0 }, chaos: { exitCode: 0 } },
      },
      chaosReport: {
        runId: 'run_s17_ok',
        buildId: 'build_s17_ok',
        mode: 'workstation-cliff',
        tier: 'full',
        matrix: { name: 'smoke', tier: 'smoke', parityOk: true },
        overallPassed: true,
        skipped: 0,
        scenarios: { s17: cleanS17() },
      },
      hygieneReport: { ok: true, contractFailures: [], unexemptedDisabled: [], unexemptedTreeMocks: [] },
    });
    assert.equal(spoofedMatrix.passed, false);
    assert.equal(spoofedMatrix.exitCode, EXIT_HARNESS_FAIL);

    const oneByteWire = cleanS17();
    oneByteWire.multiSessionStorm.coldMainWireBytes = 1;
    assert.equal(evaluateS17WorkstationCliffVerdict(oneByteWire, 'smoke').exitCode, EXIT_HARNESS_FAIL);

    const missingToolEv = cleanS17();
    delete missingToolEv.workspacePathCliffs.toolEvidence;
    assert.equal(evaluateS17WorkstationCliffVerdict(missingToolEv, 'smoke').exitCode, EXIT_HARNESS_FAIL);

    const leakedHandles = cleanS17();
    leakedHandles.residencyEviction.postEvictHandleCount = 999_999;
    assert.equal(evaluateS17WorkstationCliffVerdict(leakedHandles, 'smoke').exitCode, EXIT_PRODUCT_FAIL);
  });
});
