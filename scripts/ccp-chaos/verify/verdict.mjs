import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadChaosMatrix, resolveS17MatrixConfig } from '../matrix/loader.mjs';

/**
 * Single strict evidence validator and exit-code authority (Astra v2.3 §§7, 9, 10).
 *
 * Exit codes:
 *   0 — complete passing required manifest (skipped === 0, zero product/harness failures)
 *   1 — product / SLO / data-integrity failure
 *   2 — harness / evidence / stale-receipt / missing-prerequisite failure
 */

export const EXIT_PASS = 0;
export const EXIT_PRODUCT_FAIL = 1;
export const EXIT_HARNESS_FAIL = 2;

const DEFAULT_SMOKE_MATRIX = loadChaosMatrix('smoke');
const DEFAULT_FULL_MATRIX = loadChaosMatrix('ccp');

export const FROZEN_V23_THRESHOLDS = Object.freeze({
  p01: Object.freeze({
    httpTranscriptMaxMs: 300,
    wsFirstResetMaxMs: 300,
    wireReadyMaxMs: 300,
    firstPaintMaxMs: 300,
    browserFirstMessagePaintMaxMs: 2_500,
    mobileFirstMessagePaintMaxMs: 4_000,
    controlBarSettleMaxMs: 500,
    maxParseInputBytes: 2 * 1024 * 1024,
    maxReopenWireReadBytes: 2 * 1024 * 1024,
    maxLegacyAuxiliaryBytes: 2 * 1024 * 1024,
    minLegacyScanBytesPerSec: 2_000_000_000,
    requiredEndpointSubstrings: Object.freeze([
      '/transcript?',
      '/agents/capabilities',
      'metrics_settle=true',
      '/model-switches',
      '/hooks?observe=true',
      '/auto-compact?observe=true',
      '/context-strategy?observe=true',
      '/status',
      '/transcript/plan',
    ]),
    fullRequiredSizeMiB: Object.freeze([...DEFAULT_FULL_MATRIX.tiers.p01ColdChild.sizesMiB]),
  }),
  p02: Object.freeze({
    maxInboundBytesPerSecP99: 128 * 1024,
    maxInboundBytesPerSecPeak: 1024 * 1024,
    maxInboundFramesPerSecP99: 64,
    maxInboundFramesPerSecPeak: 192,
    minRollingWindowsSmoke: 1,
    minRollingWindowsFull: 6,
    minRollingWindowMs: 4_500,
  }),
  s10: Object.freeze({
    promptAdmissionTextP95Ms: DEFAULT_SMOKE_MATRIX.tiers.s10.promptAdmissionTextP95Ms,
    promptAdmissionTextMaxMs: DEFAULT_SMOKE_MATRIX.tiers.s10.promptAdmissionTextMaxMs,
    promptAdmissionPngP95Ms: DEFAULT_SMOKE_MATRIX.tiers.s10.promptAdmissionPngP95Ms,
    promptAdmissionPngMaxMs: DEFAULT_SMOKE_MATRIX.tiers.s10.promptAdmissionPngMaxMs,
    promptAdmissionP95Ms: DEFAULT_SMOKE_MATRIX.tiers.s10.promptAdmissionP95Ms,
    promptAdmissionMaxMs: DEFAULT_SMOKE_MATRIX.tiers.s10.promptAdmissionMaxMs,
    sendToReceiptP95Ms: DEFAULT_SMOKE_MATRIX.tiers.s10.sendToReceiptP95Ms,
    sendToReceiptMaxMs: DEFAULT_SMOKE_MATRIX.tiers.s10.sendToReceiptMaxMs,
    eldP99Ms: DEFAULT_SMOKE_MATRIX.tiers.s10.eldP99Ms,
    eldMaxMs: DEFAULT_SMOKE_MATRIX.tiers.s10.eldMaxMs,
    clsMax: 0.02,
    rawLayoutShiftMax: 0.02,
    composerTypingP95Ms: 32,
    tiers: Object.freeze({
      smoke: Object.freeze({ minPeakActiveChildren: 4, minChildToolCalls: 12, minOverlapBuckets: 1 }),
      full: Object.freeze({ minPeakActiveChildren: 12, minChildToolCalls: 48, minOverlapBuckets: 3 }),
    }),
  }),
  s14: Object.freeze({
    maxServerCorePct: DEFAULT_SMOKE_MATRIX.tiers.idleCpu.maxServerCorePct,
    maxRendererPlusGpuCorePct: DEFAULT_SMOKE_MATRIX.tiers.idleCpu.maxRendererPlusGpuCorePct,
    minWindowsSmoke: DEFAULT_SMOKE_MATRIX.tiers.idleCpu.windowCount,
    minWindowsFull: DEFAULT_FULL_MATRIX.tiers.idleCpu.windowCount,
  }),
  s16: Object.freeze({
    coldBootToShellMaxMs: 4_000,
    heavyFirstMessagePaintMaxMs: 2_500,
    heavyTbtMaxMs: 1_200,
    heavyMaxLongTaskMs: 600,
    scrollFrameP95MaxMs: 33.4,
    switchFirstMessagePaintP95MaxMs: 2_000,
  }),
  s17: Object.freeze({
    searchP95MaxMs: DEFAULT_SMOKE_MATRIX.tiers.s17WorkstationCliff.sqliteContention.searchP95MaxMs,
    listP95MaxMs: DEFAULT_SMOKE_MATRIX.tiers.s17WorkstationCliff.sqliteContention.listP95MaxMs,
    usageP95MaxMs: DEFAULT_SMOKE_MATRIX.tiers.s17WorkstationCliff.sqliteContention.usageP95MaxMs,
    promptAdmissionMaxMs: DEFAULT_SMOKE_MATRIX.tiers.s17WorkstationCliff.sqliteContention.promptAdmissionMaxMs,
    externalStallHealthMaxMs: DEFAULT_SMOKE_MATRIX.tiers.s17WorkstationCliff.externalStalls.healthMaxMs,
    processHelperBurstP95MaxMs: DEFAULT_SMOKE_MATRIX.tiers.s17WorkstationCliff.processHelperContention.maxBurstP95Ms,
    eldP99MaxMs: 250,
    eldMaxMs: 1_500,
  }),
});

function isPositiveFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Validates structural soundness and positive finite targets of a loaded chaos matrix.
 * Matrix JSON is the single authoritative target source for runner + verdict.
 */
export function validateMatrixThresholdParity(matrix) {
  const drifts = [];
  if (!matrix || typeof matrix !== 'object' || !matrix.tiers) {
    return { ok: false, drifts: ['Missing matrix.tiers'] };
  }
  const s10 = matrix.tiers.s10 ?? {};
  for (const key of [
    'promptAdmissionTextP95Ms',
    'promptAdmissionTextMaxMs',
    'promptAdmissionPngP95Ms',
    'promptAdmissionPngMaxMs',
    'promptAdmissionP95Ms',
    'promptAdmissionMaxMs',
    'sendToReceiptP95Ms',
    'sendToReceiptMaxMs',
    'eldP99Ms',
    'eldMaxMs',
  ]) {
    if (!isPositiveFiniteNumber(s10[key])) {
      drifts.push(`tiers.s10.${key} must be a positive finite number, got ${String(s10[key])}`);
    }
  }
  const idle = matrix.tiers.idleCpu;
  if (!idle || typeof idle !== 'object') {
    drifts.push('Missing tiers.idleCpu');
  } else {
    if (!isPositiveFiniteNumber(idle.maxServerCorePct)) {
      drifts.push(`tiers.idleCpu.maxServerCorePct must be a positive finite number, got ${String(idle.maxServerCorePct)}`);
    }
    if (!isPositiveFiniteNumber(idle.maxRendererPlusGpuCorePct)) {
      drifts.push(`tiers.idleCpu.maxRendererPlusGpuCorePct must be a positive finite number, got ${String(idle.maxRendererPlusGpuCorePct)}`);
    }
  }
  const p01 = matrix.tiers.p01ColdChild;
  if (!p01 || !Array.isArray(p01.sizesMiB) || p01.sizesMiB.length === 0 || p01.sizesMiB.some((s) => !isPositiveFiniteNumber(Number(s)))) {
    drifts.push('Missing or invalid tiers.p01ColdChild.sizesMiB');
  }
  const s17 = matrix.tiers.s17WorkstationCliff;
  if (!s17 || typeof s17 !== 'object') {
    drifts.push('Missing tiers.s17WorkstationCliff');
  } else {
    if (s17.sqliteContention?.enableSearch !== true) {
      drifts.push('tiers.s17WorkstationCliff.sqliteContention.enableSearch must be true');
    }
    for (const [label, val] of [
      ['s17.sqliteContention.searchP95MaxMs', s17.sqliteContention?.searchP95MaxMs],
      ['s17.sqliteContention.listP95MaxMs', s17.sqliteContention?.listP95MaxMs],
      ['s17.sqliteContention.usageP95MaxMs', s17.sqliteContention?.usageP95MaxMs],
      ['s17.sqliteContention.promptAdmissionMaxMs', s17.sqliteContention?.promptAdmissionMaxMs],
      ['s17.externalStalls.healthMaxMs', s17.externalStalls?.healthMaxMs],
      ['s17.processHelperContention.maxBurstP95Ms', s17.processHelperContention?.maxBurstP95Ms],
    ]) {
      if (!isPositiveFiniteNumber(val)) {
        drifts.push(`${label} must be a positive finite number, got ${String(val)}`);
      }
    }
    const sub = Number(s17.workspacePathCliffs?.subOverflowFiles ?? 0);
    const over = Number(s17.workspacePathCliffs?.umbrellaOverflowFiles ?? 0);
    const cap = Number(s17.workspacePathCliffs?.inventoryLimit ?? 0);
    if (!(sub > 0 && sub < cap && over > cap)) {
      drifts.push(`s17.workspacePathCliffs must straddle inventoryLimit (${sub} < ${cap} < ${over})`);
    }
    if (matrix.tier === 'full') {
      if ((s17.corpus?.coldSessions ?? 0) < 500) {
        drifts.push(`full tier s17.corpus.coldSessions=${s17.corpus?.coldSessions} < 500`);
      }
      if ((s17.corpus?.maxSubagentsPerSession ?? 0) < 1528) {
        drifts.push(`full tier s17.corpus.maxSubagentsPerSession=${s17.corpus?.maxSubagentsPerSession} < 1528`);
      }
      if ((s17.corpus?.giantMainWireMiB ?? 0) < 3200) {
        drifts.push(`full tier s17.corpus.giantMainWireMiB=${s17.corpus?.giantMainWireMiB} < 3200`);
      }
      if ((s17.corpus?.checkpointlessChildWireMiB ?? 0) < 408) {
        drifts.push(`full tier s17.corpus.checkpointlessChildWireMiB=${s17.corpus?.checkpointlessChildWireMiB} < 408`);
      }
      if (sub < 200_000 || sub >= 250_000) {
        drifts.push(`full tier s17.workspacePathCliffs.subOverflowFiles=${sub} outside [200000, 250000)`);
      }
      if (over < 280_000) {
        drifts.push(`full tier s17.workspacePathCliffs.umbrellaOverflowFiles=${over} < 280000`);
      }
      if ((s17.multiSessionStorm?.activeWritingSessions ?? 0) < 8) {
        drifts.push(`full tier s17.multiSessionStorm.activeWritingSessions=${s17.multiSessionStorm?.activeWritingSessions} < 8`);
      }
      if ((s17.multiSessionStorm?.activeChildren ?? 0) < 40) {
        drifts.push(`full tier s17.multiSessionStorm.activeChildren=${s17.multiSessionStorm?.activeChildren} < 40`);
      }
    }
  }
  return { ok: drifts.length === 0, drifts };
}

export function domainDigest(domain, fields) {
  const h = createHash('sha256');
  const writeField = (val) => {
    const buf = Buffer.isBuffer(val) || val instanceof Uint8Array ? val : Buffer.from(String(val), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.byteLength, 0);
    h.update(len);
    h.update(buf);
  };
  writeField(domain);
  for (const f of fields) writeField(f);
  return h.digest('hex');
}

export function canonicalHmacPayload({
  version = 'v2.3',
  run,
  epoch,
  source,
  destination,
  edgeKind,
  stage,
  inputIdentity,
  resultValue,
  artifactDigest,
}) {
  return JSON.stringify([
    String(version),
    String(run),
    Number(epoch),
    String(source),
    String(destination),
    String(edgeKind),
    String(stage),
    String(inputIdentity),
    String(resultValue),
    String(artifactDigest),
  ]);
}

export function computeScopedHmac(scopedKey, record) {
  const payload = typeof record === 'string' ? record : canonicalHmacPayload(record);
  return createHmac('sha256', Buffer.isBuffer(scopedKey) ? scopedKey : Buffer.from(String(scopedKey), 'utf8'))
    .update(payload, 'utf8')
    .digest('hex');
}

export function verifyScopedHmac(scopedKey, record, observedTag) {
  if (typeof observedTag !== 'string' || !/^[0-9a-f]{64}$/iu.test(observedTag)) {
    return false;
  }
  const expected = computeScopedHmac(scopedKey, record);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(observedTag, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies a 6-stage data-authentic child chain independently from observed
 * evidence and pristine ground-truth expectations.
 */
export function verifySixStageChildChain({ expected, observed }) {
  const failures = [];
  if (!observed || typeof observed !== 'object') {
    return { ok: false, firstBrokenStage: 'missing', failures: ['Missing observed child chain record'] };
  }

  const requiredStages = ['discover', 'read', 'change', 'build', 'recover', 'account'];
  for (const stage of requiredStages) {
    if (!observed.stages?.[stage] || observed.stages[stage].executed !== true) {
      failures.push(`Stage '${stage}' was skipped or not executed`);
      return { ok: false, firstBrokenStage: stage, failures };
    }
  }

  if (expected.requiredToolCount > 0 && (observed.toolCallsExecuted ?? 0) < expected.requiredToolCount) {
    failures.push(`Child executed ${observed.toolCallsExecuted ?? 0} tool calls < required ${expected.requiredToolCount}`);
    return { ok: false, firstBrokenStage: 'discover', failures };
  }

  if (expected.expectedConstant !== undefined && observed.stages.read.extractedConstant !== expected.expectedConstant) {
    failures.push(`Read extracted constant ${observed.stages.read.extractedConstant} !== expected ${expected.expectedConstant}`);
    return { ok: false, firstBrokenStage: 'read', failures };
  }

  if (expected.expectedEditedFileSha256 && observed.stages.change.postimageSha256 !== expected.expectedEditedFileSha256) {
    failures.push(`Edited file postimage sha256 mismatch: got ${observed.stages.change.postimageSha256}, expected ${expected.expectedEditedFileSha256}`);
    return { ok: false, firstBrokenStage: 'change', failures };
  }

  if (expected.expectedFooterDigest && observed.stages.build.footerDigest !== expected.expectedFooterDigest) {
    failures.push(`Build footer digest mismatch: got ${observed.stages.build.footerDigest}, expected ${expected.expectedFooterDigest}`);
    return { ok: false, firstBrokenStage: 'build', failures };
  }

  if (expected.minBuildCpuMs > 0 && (observed.stages.build.cpuMs ?? 0) < expected.minBuildCpuMs) {
    failures.push(`Build CPU floor breach: ${observed.stages.build.cpuMs ?? 0}ms < ${expected.minBuildCpuMs}ms`);
    return { ok: false, firstBrokenStage: 'build', failures };
  }

  if (expected.requireSpillTailRead) {
    if (!observed.stages.recover.spillPath || observed.stages.recover.spillTailRead !== true) {
      failures.push('Required spill-path tail Read was not performed');
      return { ok: false, firstBrokenStage: 'recover', failures };
    }
    if (expected.expectedSpillTailSha256 && observed.stages.recover.spillTailSha256 !== expected.expectedSpillTailSha256) {
      failures.push(`Spill tail digest mismatch: got ${observed.stages.recover.spillTailSha256}, expected ${expected.expectedSpillTailSha256}`);
      return { ok: false, firstBrokenStage: 'recover', failures };
    }
  }

  if (expected.expectedMemoryFact && observed.stages.recover.memoryFact !== expected.expectedMemoryFact) {
    failures.push('Recovered memory fact mismatch');
    return { ok: false, firstBrokenStage: 'recover', failures };
  }

  if (expected.expectedHistoryRef && observed.stages.recover.historyRef !== expected.expectedHistoryRef) {
    failures.push('Recovered history ref mismatch');
    return { ok: false, firstBrokenStage: 'recover', failures };
  }

  if (observed.stages.account.todoCompleted !== true || observed.stages.account.receiptCount !== 1) {
    failures.push(`Account stage invalid: todoCompleted=${observed.stages.account.todoCompleted} receiptCount=${observed.stages.account.receiptCount}`);
    return { ok: false, firstBrokenStage: 'account', failures };
  }

  const recomputedFinal = domainDigest('child-final/v2', [
    expected.runId,
    expected.childId,
    observed.stages.read.extractedConstant,
    observed.stages.change.postimageSha256,
    observed.stages.build.footerDigest,
    observed.stages.recover.spillTailSha256 ?? 'inline',
    observed.stages.recover.memoryFact ?? '',
    observed.stages.recover.historyRef ?? '',
  ]);

  if (observed.stages.account.finalDigest !== recomputedFinal) {
    failures.push(`Final child digest mismatch: got ${observed.stages.account.finalDigest}, recomputed ${recomputedFinal}`);
    return { ok: false, firstBrokenStage: 'account', failures };
  }

  return { ok: true, firstBrokenStage: null, failures: [], recomputedFinal };
}

/**
 * Independently verifies a multi-hop inter-communicating thread/room mesh graph
 * (Astra v2.3 §§9.3, 10.3). Checks exact semantic root, per-edge delivery cardinality,
 * target persisted wire.jsonl structured origin (`peer_thread` / `room_message`),
 * mention targeting, and downstream consumption.
 */
export function verifyMeshGraph({ expectedEdges, observedEdges, expectedGraphRoot, observedGraphRoot }) {
  const failures = [];
  const obsByKey = new Map();
  for (const edge of observedEdges ?? []) {
    const key = `${edge.epoch}:${edge.from}->${edge.to}:${edge.kind}`;
    const list = obsByKey.get(key) ?? [];
    list.push(edge);
    obsByKey.set(key, list);
  }

  let firstBrokenEdge = null;
  for (const exp of expectedEdges ?? []) {
    const key = `${exp.epoch}:${exp.from}->${exp.to}:${exp.kind}`;
    const matches = obsByKey.get(key) ?? [];
    if (matches.length === 0) {
      firstBrokenEdge ??= key;
      failures.push(`Missing edge ${key} (expected durable send + target consumption)`);
      continue;
    }
    if (matches.length > 1) {
      firstBrokenEdge ??= key;
      failures.push(`Duplicate edge consumption on ${key} (count=${matches.length})`);
      continue;
    }
    const obs = matches[0];
    if (obs.senderReceiptOk !== true) {
      firstBrokenEdge ??= key;
      failures.push(`Edge ${key} missing sender receipt`);
    }
    if (obs.targetConsumed !== true) {
      firstBrokenEdge ??= key;
      failures.push(`Edge ${key} has sender receipt but missing downstream target consumption`);
    }
    if (exp.expectedPayloadDigest && obs.payloadDigest !== exp.expectedPayloadDigest) {
      firstBrokenEdge ??= key;
      failures.push(`Edge ${key} payload digest mismatch: got ${obs.payloadDigest}, expected ${exp.expectedPayloadDigest}`);
    }
    if (exp.requireStructuredOrigin) {
      const origin = obs.persistedWireOrigin;
      if (!origin || typeof origin !== 'object') {
        firstBrokenEdge ??= key;
        failures.push(`Edge ${key} missing persisted target wire.jsonl structured origin`);
      } else if (exp.kind === 'peer') {
        if (origin.kind !== 'peer_thread' || origin.sourceSessionId !== exp.from || !origin.messageId) {
          firstBrokenEdge ??= key;
          failures.push(`Edge ${key} invalid peer_thread origin: ${JSON.stringify(origin)}`);
        }
      } else if (exp.kind === 'room') {
        if (
          origin.kind !== 'room_message' ||
          origin.roomId !== exp.roomId ||
          origin.targeted !== true ||
          !origin.mailboxMessageId ||
          !origin.roomEntryId
        ) {
          firstBrokenEdge ??= key;
          failures.push(`Edge ${key} invalid room_message origin: ${JSON.stringify(origin)}`);
        }
      }
    }
    if (exp.kind === 'room' && (obs.unauthorizedWakeCount ?? 0) > 0) {
      firstBrokenEdge ??= key;
      failures.push(`Edge ${key} caused ${obs.unauthorizedWakeCount} unauthorized room wake(s)`);
    }
  }

  if (expectedGraphRoot && observedGraphRoot !== expectedGraphRoot) {
    failures.push(`Mesh graphRoot mismatch: got ${observedGraphRoot}, expected ${expectedGraphRoot}`);
  }

  return {
    ok: failures.length === 0,
    firstBrokenEdge,
    verifiedEdgeCount: (expectedEdges?.length ?? 0) - failures.length,
    failures,
  };
}

/**
 * Evaluates §10.3 persisted session-owned Cron outbox recovery after crash.
 */
export function evaluateP03CronOutboxRecovery(trace) {
  const productFailures = [];
  const harnessFailures = [];
  if (!trace || typeof trace !== 'object') {
    harnessFailures.push('P0-3 missing cron outbox recovery trace');
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, productFailures, harnessFailures };
  }
  const cron = trace.cronJob ?? {};
  if (cron.deliveryMode !== 'queue' || cron.oneShot !== true) {
    harnessFailures.push(`P0-3 invalid cron job config: deliveryMode=${cron.deliveryMode}, oneShot=${cron.oneShot}`);
  }
  if (cron.instruction !== "Drain this session's committed outbox.") {
    harnessFailures.push(`P0-3 cron instruction must be fixed outbox-drain text, got "${cron.instruction}"`);
  }
  if (cron.carriedPayloadOrKey === true) {
    harnessFailures.push('P0-3 cron job illegally carried payload, recipient, witness, or send key');
  }
  if (trace.becameDueWhileDown !== true || trace.manualIntervention === true || trace.futureInboundDelivered === true) {
    harnessFailures.push('P0-3 crash precondition failed (cron must fire due while down with zero manual intervention or future inbound)');
  }
  if (trace.replacementStartToRestartMs > 10_000) {
    harnessFailures.push(`P0-3 restart took ${trace.replacementStartToRestartMs}ms > 10s`);
  }
  if (!trace.cronOriginJobId || trace.cronOriginJobId !== cron.jobId) {
    productFailures.push(`P0-3 missing or mismatched cron_job origin.jobId (${trace.cronOriginJobId} vs ${cron.jobId})`);
  }
  if (trace.usedOriginalKeysAndBytes !== true) {
    productFailures.push('P0-3 drained intents did not preserve original keys and bytes');
  }
  if (typeof trace.drainMsFromReplacementStart !== 'number' || trace.drainMsFromReplacementStart > 60_000) {
    productFailures.push(`P0-3 drain time from replacement start ${trace.drainMsFromReplacementStart}ms > 60,000ms`);
  }
  if (trace.allTargetsConsumedOnce !== true) {
    productFailures.push('P0-3 offline verifier did not observe exact-once target consumption');
  }
  const exitCode = harnessFailures.length > 0 ? EXIT_HARNESS_FAIL : productFailures.length > 0 ? EXIT_PRODUCT_FAIL : EXIT_PASS;
  return { passed: exitCode === EXIT_PASS, exitCode, productFailures, harnessFailures };
}

/**
 * Evaluates P0-1 Cold Child Open Gate (Astra v2.3 §10.1):
 * - Lane 'legacy': pristine historical wire, checkpoints: [], no summary/sidecar.
 *   Allows 1 shared sequential raw pass > 2.0 GB/s (decimal) + <= 2 MiB auxiliary reads,
 *   and <= 2 MiB aggregate JSON-parsed input.
 * - Lane 'reopen': newly completed native child whose production completion durably
 *   published a source-bound checkpoint/summary before eviction. Fresh-process reopen
 *   requires <= 2 MiB aggregate raw target I/O AND <= 2 MiB parsed input, plus valid proof.
 */
export function evaluateP01ColdChildGate(trial) {
  const productFailures = [];
  const harnessFailures = [];
  if (!trial || typeof trial !== 'object') {
    harnessFailures.push('P0-1 missing cold child trial evidence');
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, productFailures, harnessFailures };
  }

  const lane = trial.lane ?? (trial.productionCheckpointPublished ? 'reopen' : 'legacy');
  const T = FROZEN_V23_THRESHOLDS.p01;
  const TWO_MIB = T.maxParseInputBytes;

  if (trial.wasColdBeforeOpen !== true) {
    harnessFailures.push('P0-1 pre-condition violation: target child was not cold before open');
  }
  if (typeof trial.httpTranscriptMs !== 'number' || !Number.isFinite(trial.httpTranscriptMs)) {
    harnessFailures.push('P0-1 missing measured httpTranscriptMs');
  } else if (trial.httpTranscriptMs >= T.httpTranscriptMaxMs) {
    productFailures.push(`P0-1 GET /transcript ${trial.httpTranscriptMs}ms >= ${T.httpTranscriptMaxMs}ms`);
  }
  if (typeof trial.wsFirstResetMs !== 'number' || !Number.isFinite(trial.wsFirstResetMs)) {
    harnessFailures.push('P0-1 missing measured wsFirstResetMs');
  } else if (trial.wsFirstResetMs >= T.wsFirstResetMaxMs) {
    productFailures.push(`P0-1 WS transcript.reset ${trial.wsFirstResetMs}ms >= ${T.wsFirstResetMaxMs}ms`);
  }
  const wireReadyMs = typeof trial.wireReadyMs === 'number' ? trial.wireReadyMs : trial.firstPaintMs;
  const wireReadyLimit = T.wireReadyMaxMs ?? T.firstPaintMaxMs;
  if (typeof wireReadyMs !== 'number' || !Number.isFinite(wireReadyMs) || wireReadyMs >= wireReadyLimit) {
    productFailures.push(`P0-1 wire-ready (HTTP+WS bootstrap) ${wireReadyMs}ms >= ${wireReadyLimit}ms`);
  }
  if (trial.browserGuiRequired === true && (!trial.browserGuiCheck || typeof trial.browserGuiCheck !== 'object')) {
    harnessFailures.push('P0-1 expected browserGuiCheck receipt is missing');
  } else if (trial.browserGuiCheck !== undefined && trial.browserGuiCheck !== null) {
    const bg = trial.browserGuiCheck;
    if (bg.ok !== true) {
      productFailures.push(`P0-1 browser GUI child open failed: ${bg.error ?? JSON.stringify(bg)}`);
    }
    if (typeof bg.newConsoleErrors === 'number' && bg.newConsoleErrors > 0) {
      productFailures.push(`P0-1 browser GUI emitted ${bg.newConsoleErrors} console error(s)`);
    }
    if (Array.isArray(bg.pageErrors) && bg.pageErrors.length > 0) {
      productFailures.push(`P0-1 browser GUI emitted ${bg.pageErrors.length} pageerror(s): ${bg.pageErrors[0]}`);
    }
    const guiPaintMs =
      typeof bg.firstMessagePaintMs === 'number'
        ? bg.firstMessagePaintMs
        : typeof bg.navigatedMs === 'number'
          ? bg.navigatedMs
          : null;
    if (guiPaintMs === null || !Number.isFinite(guiPaintMs)) {
      harnessFailures.push('P0-1 browser GUI check missing firstMessagePaintMs / navigatedMs');
    } else if (guiPaintMs >= T.browserFirstMessagePaintMaxMs) {
      productFailures.push(`P0-1 browser GUI firstMessagePaintMs ${guiPaintMs}ms >= ${T.browserFirstMessagePaintMaxMs}ms`);
    }
    if (bg.mobileCheck) {
      if (bg.mobileCheck.ok !== true) {
        productFailures.push(`P0-1 mobile Chromium child open failed: ${bg.mobileCheck.error ?? 'not ok'}`);
      }
      if (typeof bg.mobileCheck.newConsoleErrors === 'number' && bg.mobileCheck.newConsoleErrors > 0) {
        productFailures.push(`P0-1 mobile Chromium emitted ${bg.mobileCheck.newConsoleErrors} console error(s)`);
      }
      if (
        typeof bg.mobileCheck.firstMessagePaintMs !== 'number'
        || !Number.isFinite(bg.mobileCheck.firstMessagePaintMs)
      ) {
        harnessFailures.push('P0-1 mobile Chromium check missing firstMessagePaintMs');
      } else if (bg.mobileCheck.firstMessagePaintMs >= T.mobileFirstMessagePaintMaxMs) {
        productFailures.push(
          `P0-1 mobile Chromium firstMessagePaintMs ${bg.mobileCheck.firstMessagePaintMs}ms >= ${T.mobileFirstMessagePaintMaxMs}ms`,
        );
      }
    }
  }
  if (typeof trial.controlBarSettleMs !== 'number' || trial.controlBarSettleMs >= T.controlBarSettleMaxMs) {
    productFailures.push(`P0-1 control bar settle ${trial.controlBarSettleMs}ms >= ${T.controlBarSettleMaxMs}ms`);
  }
  if (!Array.isArray(trial.responses) || trial.responses.length === 0) {
    harnessFailures.push('P0-1 missing endpoint response receipts');
  } else {
    for (const requiredSub of T.requiredEndpointSubstrings) {
      if (!trial.responses.some((r) => typeof r.path === 'string' && r.path.includes(requiredSub))) {
        harnessFailures.push(`P0-1 fanout missing required endpoint matching "${requiredSub}"`);
      }
    }
    const forbidden = trial.responses.filter((r) => {
      if (r.code === 50001 || r.code === 40923 || r.status === 'preparing' || r.reason === 'history_canonical_preparing') {
        return true;
      }
      if (r.status !== 200) {
        return true;
      }
      if (!Number.isInteger(r.code)) {
        return true;
      }
      const isLargeColdHooksObserve =
        typeof r.path === 'string' &&
        r.path.includes('/hooks') &&
        r.path.includes('observe=true') &&
        (trial.wireBytes ?? 0) > 8 * 1024 * 1024;
      if (isLargeColdHooksObserve) {
        return r.code !== 40901;
      }
      return r.code !== 0;
    });
    if (forbidden.length > 0) {
      productFailures.push(`P0-1 forbidden or failed initial-open responses: ${JSON.stringify(forbidden)}`);
    }
  }

  if (trial.driverSimulatedScan === true || (trial.ioTraceSource !== undefined && trial.ioTraceSource !== 'server_product_trace')) {
    harnessFailures.push(`P0-1 invalid IO attribution source (ioTraceSource=${trial.ioTraceSource}, driverSimulatedScan=${trial.driverSimulatedScan})`);
  }

  if (typeof trial.aggregateParseInputBytes !== 'number' || !Number.isFinite(trial.aggregateParseInputBytes)) {
    harnessFailures.push('P0-1 missing aggregateParseInputBytes attribution');
  } else if (trial.aggregateParseInputBytes <= 0 && (trial.wireBytes ?? 1) > 0) {
    harnessFailures.push('P0-1 unmeasured aggregateParseInputBytes (0B on non-empty wire)');
  } else if (trial.aggregateParseInputBytes > TWO_MIB) {
    productFailures.push(`P0-1 aggregate JSON-parsed input ${trial.aggregateParseInputBytes}B > 2 MiB (${lane})`);
  }

  if (lane === 'legacy') {
    if (!Array.isArray(trial.checkpoints) || trial.checkpoints.length > 0) {
      harnessFailures.push('P0-1 legacy lane violation: target child had non-empty checkpoints');
    }
    if (trial.preexistingSummaryOrSidecar === true) {
      harnessFailures.push('P0-1 legacy lane violation: target-derived summary/sidecar existed before open');
    }
    const rawPassCount = trial.rawPassCount ?? 1;
    if (rawPassCount > 1) {
      productFailures.push(`P0-1 legacy lane performed ${rawPassCount} raw passes > 1 shared pass`);
    }
    if (typeof trial.auxiliaryTargetReadBytes === 'number' && trial.auxiliaryTargetReadBytes > T.maxLegacyAuxiliaryBytes) {
      productFailures.push(`P0-1 legacy lane auxiliary reads ${trial.auxiliaryTargetReadBytes}B > 2 MiB`);
    }
    if (typeof trial.legacyScanBytesPerSec !== 'number' || !Number.isFinite(trial.legacyScanBytesPerSec)) {
      harnessFailures.push('P0-1 legacy lane missing measured legacyScanBytesPerSec');
    } else if (trial.legacyScanBytesPerSec <= T.minLegacyScanBytesPerSec) {
      productFailures.push(
        `P0-1 legacy raw prefilter throughput ${(trial.legacyScanBytesPerSec / 1e9).toFixed(2)} GB/s <= 2.0 GB/s`,
      );
    }
    if (typeof trial.aggregateWireReadBytes !== 'number' || !Number.isFinite(trial.aggregateWireReadBytes) || trial.aggregateWireReadBytes <= 0) {
      harnessFailures.push('P0-1 legacy lane missing measured aggregateWireReadBytes');
    } else if (typeof trial.wireBytes === 'number' && trial.aggregateWireReadBytes > trial.wireBytes + TWO_MIB) {
      productFailures.push(
        `P0-1 legacy wire read ${trial.aggregateWireReadBytes}B > single pass + 2 MiB (${trial.wireBytes + TWO_MIB}B)`,
      );
    }
    if (trial.fullReplayMatches !== true) {
      productFailures.push('P0-1 legacy prefilter result did not prove match with independent full replay');
    } else if (trial.fullReplayProof !== undefined && (trial.fullReplayProof.matches !== true || (trial.fullReplayProof.turnCount ?? 0) <= 0)) {
      productFailures.push(`P0-1 legacy fullReplayProof invalid: ${JSON.stringify(trial.fullReplayProof)}`);
    }
  } else if (lane === 'reopen') {
    if (trial.productionCheckpointPublished !== true) {
      productFailures.push('P0-1 reopen lane failed: production completion did not publish source-bound checkpoint before eviction');
    }
    if (trial.fixtureBuiltCheckpoint === true || trial.firstReaderBuiltCheckpoint === true) {
      productFailures.push('P0-1 reopen lane failed: checkpoint was fixture-built or secretly built by first reader');
    }
    if (typeof trial.aggregateWireReadBytes !== 'number' || !Number.isFinite(trial.aggregateWireReadBytes) || trial.aggregateWireReadBytes <= 0) {
      harnessFailures.push('P0-1 reopen lane missing measured aggregateWireReadBytes attribution');
    } else if (trial.aggregateWireReadBytes > T.maxReopenWireReadBytes) {
      productFailures.push(`P0-1 reopen lane aggregate raw target I/O ${trial.aggregateWireReadBytes}B > 2 MiB`);
    }
    if (!trial.summaryProof || typeof trial.summaryProof !== 'object') {
      harnessFailures.push('P0-1 reopen lane missing required summaryProof');
    } else {
      const p = trial.summaryProof;
      const storeGen = p.storeGeneration ?? p.generation;
      const boundaryHash = p.boundarySha256 ?? p.tailSha256;
      const missingFields = [];
      if (!p.sourceIdentity) missingFields.push('sourceIdentity');
      if (storeGen === undefined || storeGen === null || storeGen === '') missingFields.push('storeGeneration');
      if (typeof p.checkpointHash !== 'string' || p.checkpointHash.trim().length === 0) missingFields.push('checkpointHash');
      if (typeof p.coveredByteOffset !== 'number' || p.coveredByteOffset <= 0) missingFields.push('coveredByteOffset');
      if (!p.headSha256) missingFields.push('headSha256');
      if (!boundaryHash) missingFields.push('boundarySha256');
      if (p.formatVersion === undefined || p.formatVersion === null || p.formatVersion === '') missingFields.push('formatVersion');
      if (missingFields.length > 0) {
        productFailures.push(`P0-1 reopen summary proof missing required fields: ${missingFields.join(', ')}`);
      }
      if (p.diskGeneration && storeGen && p.diskGeneration !== storeGen) {
        productFailures.push(`P0-1 reopen storeGeneration mismatch: checkpoint=${storeGen} vs disk=${p.diskGeneration}`);
      }
      if (p.verified !== true) {
        productFailures.push('P0-1 reopen summary proof failed independent recomputation');
      }
    }
  } else {
    harnessFailures.push(`P0-1 unknown lane "${lane}"`);
  }

  const exitCode = harnessFailures.length > 0 ? EXIT_HARNESS_FAIL : productFailures.length > 0 ? EXIT_PRODUCT_FAIL : EXIT_PASS;
  return { passed: exitCode === EXIT_PASS, exitCode, lane, productFailures, harnessFailures };
}

/**
 * Evaluates P0-2 Main-Only WebSocket Isolation Gate (Astra v2.3 §§9.2, 10.2).
 * Enforces zero unsubscribed-child content bytes/frames, byte/frame rate ceilings,
 * AND §10.2 continuous rolling-5s producer load floors across the entire scoring interval.
 * Ignores caller-supplied minRollingWindows: 0; uses frozen tier minimums.
 */
export function evaluateP02MainOnlyWsGate(report, tierOverride = null) {
  const productFailures = [];
  const harnessFailures = [];
  if (!report || typeof report !== 'object') {
    harnessFailures.push('P0-2 missing main-only WS isolation evidence');
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, productFailures, harnessFailures };
  }

  const T = FROZEN_V23_THRESHOLDS.p02;
  const tier = (tierOverride ?? report.tier) === 'full' ? 'full' : 'smoke';
  const N = Math.max(1, report.requiredStreamingChildren ?? 1);
  if ((report.activeStreamingChildren ?? 0) < N) {
    harnessFailures.push(`P0-2 insufficient concurrent streaming children: ${report.activeStreamingChildren ?? 0} < ${N}`);
  }
  if ((report.controlClientChildBytes ?? 0) <= 0) {
    harnessFailures.push('P0-2 positive-control child_k delta subscriber received 0 bytes (child stream was silent)');
  }
  if (report.usedLegacySubscribe === true || report.bareSubscribeV2 === false) {
    harnessFailures.push('P0-2 main-only isolation probe must use bare subscribe_v2 without legacy subscribe');
  }

  const minRollingWindows = tier === 'full' ? T.minRollingWindowsFull : T.minRollingWindowsSmoke;
  if (!Array.isArray(report.rolling5sWindows) || report.rolling5sWindows.length < minRollingWindows) {
    harnessFailures.push(
      `P0-2 §10.2 missing rolling5sWindows evidence: got ${Array.isArray(report.rolling5sWindows) ? report.rolling5sWindows.length : 0} < required ${minRollingWindows}`,
    );
  } else {
    const minActive = Math.ceil(0.9 * N);
    const minStreaming = Math.ceil(N / 3);
    for (let i = 0; i < report.rolling5sWindows.length; i += 1) {
      const w = report.rolling5sWindows[i];
      if (w.windowMs !== undefined && w.windowMs < T.minRollingWindowMs) {
        harnessFailures.push(`P0-2 §10.2 rolling window #${i} span ${w.windowMs}ms < ${T.minRollingWindowMs}ms`);
      }
      if ((w.productiveChildren4s ?? 0) < minActive) {
        harnessFailures.push(
          `P0-2 §10.2 underproduction in rolling window #${i}: productiveChildren4s=${w.productiveChildren4s ?? 0} < ceil(0.9*${N})=${minActive}`,
        );
      }
      if ((w.streamingChildren3s ?? 0) < minStreaming) {
        harnessFailures.push(
          `P0-2 §10.2 underproduction in rolling window #${i}: streamingChildren3s=${w.streamingChildren3s ?? 0} < ceil(${N}/3)=${minStreaming}`,
        );
      }
      if (Array.isArray(w.perChildStreams)) {
        for (const cs of w.perChildStreams) {
          const activeSec = Math.max(0.001, cs.activeSeconds ?? 0);
          if (cs.deltas / activeSec < 8 || cs.usefulBytes / activeSec < 256) {
            harnessFailures.push(
              `P0-2 §10.2 stream floor breach for ${cs.childId} in window #${i}: ${(cs.deltas / activeSec).toFixed(1)} deltas/s, ${(cs.usefulBytes / activeSec).toFixed(1)} B/s`,
            );
          }
        }
      }
    }
  }

  if ((report.unsubscribedChildContentBytes ?? 0) > 0 || (report.unsubscribedChildContentFrames ?? 0) > 0) {
    productFailures.push(
      `P0-2 leaked unsubscribed child content on main-only socket: bytes=${report.unsubscribedChildContentBytes} frames=${report.unsubscribedChildContentFrames}`,
    );
  }
  if ((report.inboundBytesPerSecP99 ?? Infinity) > T.maxInboundBytesPerSecP99) {
    productFailures.push(`P0-2 inbound WS bytes/s p99 ${report.inboundBytesPerSecP99} > 128 KiB`);
  }
  if ((report.inboundBytesPerSecPeak ?? Infinity) > T.maxInboundBytesPerSecPeak) {
    productFailures.push(`P0-2 inbound WS bytes/s peak ${report.inboundBytesPerSecPeak} > 1 MiB`);
  }
  if ((report.inboundFramesPerSecP99 ?? Infinity) > T.maxInboundFramesPerSecP99) {
    productFailures.push(`P0-2 inbound WS frames/s p99 ${report.inboundFramesPerSecP99} > 64`);
  }
  if ((report.inboundFramesPerSecPeak ?? Infinity) > T.maxInboundFramesPerSecPeak) {
    productFailures.push(`P0-2 inbound WS frames/s peak ${report.inboundFramesPerSecPeak} > 192`);
  }

  const exitCode =
    productFailures.length > 0 && (report.unsubscribedChildContentBytes ?? 0) > 0
      ? EXIT_PRODUCT_FAIL
      : harnessFailures.length > 0
        ? EXIT_HARNESS_FAIL
        : productFailures.length > 0
          ? EXIT_PRODUCT_FAIL
          : EXIT_PASS;
  return { passed: exitCode === EXIT_PASS, exitCode, productFailures, harnessFailures };
}

/**
 * Evaluates §10.4 Blind Same-Path HMAC-SHA256 Mutation Control (4 randomized trials per seed).
 */
export function evaluateP04BlindMutationControl({ scopedKey, trials }) {
  const productFailures = [];
  const harnessFailures = [];
  if (!scopedKey || !Array.isArray(trials) || trials.length < 4) {
    harnessFailures.push(`P0-4 requires scopedKey and 4 blind trials, got ${trials?.length ?? 0}`);
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, productFailures, harnessFailures };
  }

  const byKind = new Map(trials.map((t) => [t.hiddenKind, t]));
  const requiredKinds = ['valid_baseline', 'valid_changed_challenge', 'tampered_tool_return', 'tampered_peer_input'];
  for (const kind of requiredKinds) {
    if (!byKind.has(kind)) harnessFailures.push(`P0-4 missing blind trial "${kind}"`);
  }
  if (harnessFailures.length > 0) {
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, productFailures, harnessFailures };
  }

  const base = byKind.get('valid_baseline');
  const changed = byKind.get('valid_changed_challenge');
  for (const t of [base, changed]) {
    if (t.validatorAccepted !== true) {
      productFailures.push(`P0-4 valid trial "${t.hiddenKind}" was unexpectedly rejected by downstream validator`);
    }
    if (!verifyScopedHmac(scopedKey, t.record, t.tag)) {
      productFailures.push(`P0-4 valid trial "${t.hiddenKind}" failed independent HMAC-SHA256 verification`);
    }
  }
  if (
    base.semanticDownstreamArg === changed.semanticDownstreamArg ||
    base.record?.artifactDigest === changed.record?.artifactDigest
  ) {
    productFailures.push('P0-4 valid_baseline and valid_changed_challenge produced identical semantic downstream arg or artifactDigest');
  }

  for (const kind of ['tampered_tool_return', 'tampered_peer_input']) {
    const t = byKind.get(kind);
    if (t.usedFaultFlagOrTrialName === true) {
      harnessFailures.push(`P0-4 "${kind}" rejection cheated via fault flag or trial name`);
    }
    if (t.validatorAccepted !== false) {
      productFailures.push(`P0-4 "${kind}" was falsely accepted by downstream validator`);
    }
    if (t.dependentWriteOrForwardOccurred === true) {
      productFailures.push(`P0-4 "${kind}" performed dependent write or forward despite tampered payload`);
    }
    const diag = t.rejectionDiagnostic ?? {};
    const missingDiag = ['epoch', 'source', 'destination', 'stage', 'inputIdentity', 'failedBinding'].filter(
      (k) => diag[k] === undefined || diag[k] === null || diag[k] === '',
    );
    if (missingDiag.length > 0) {
      productFailures.push(`P0-4 "${kind}" rejection diagnostic missing: ${missingDiag.join(', ')}`);
    }
    if (verifyScopedHmac(scopedKey, t.consumedRecord ?? t.record, t.tag)) {
      harnessFailures.push(`P0-4 "${kind}" tampered record still matched original HMAC (injection did not mutate payload)`);
    }
  }

  const exitCode = harnessFailures.length > 0 ? EXIT_HARNESS_FAIL : productFailures.length > 0 ? EXIT_PRODUCT_FAIL : EXIT_PASS;
  return { passed: exitCode === EXIT_PASS, exitCode, productFailures, harnessFailures };
}

/**
 * Evaluates §10.5 Timeout Termination vs Foreground Auto-Detach vs Direct Cancel cells.
 */
export function evaluateP1TimeoutVsDetachCell(cell) {
  const productFailures = [];
  const harnessFailures = [];
  if (!cell || typeof cell !== 'object') {
    harnessFailures.push('P1 missing timeout/detach cell evidence');
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, productFailures, harnessFailures };
  }

  if (cell.prematureTaskCompletionWhileGrandchildAlive === true) {
    productFailures.push('P1 immediate failure: task completed prematurely while owned grandchild was still alive');
  }

  if (cell.earlyExitVariant === true) {
    const tl = cell.timeline ?? {};
    if (
      typeof tl.rootExitMs !== 'number' ||
      typeof tl.triggerReceivedMs !== 'number' ||
      typeof tl.grandchildExitMs !== 'number' ||
      !(tl.rootExitMs < tl.triggerReceivedMs && tl.triggerReceivedMs < tl.grandchildExitMs)
    ) {
      harnessFailures.push(
        `P1 early-exit timeline invalid (need rootExit < triggerReceived < grandchildExit): ${JSON.stringify(tl)}`,
      );
    }
    if (cell.grandchildActiveAtTrigger !== true) {
      harnessFailures.push('P1 early-exit grandchild was not runnable/accumulating CPU at trigger');
    }
  }

  if ((cell.survivingDescendants ?? 0) > 0) {
    productFailures.push(`P1 ${cell.survivingDescendants} surviving descendant(s) after termination`);
  }

  if (cell.kind === 'terminating_timeout') {
    if (cell.terminalStatus !== 'timed_out') {
      productFailures.push(`P1 terminating_timeout expected timed_out, got ${cell.terminalStatus}`);
    }
    const slackMs = (cell.cleanupAtMs ?? Infinity) - (cell.scheduledDeadlineMs ?? 0);
    if (slackMs > 2_000) {
      productFailures.push(`P1 terminating_timeout cleanup exceeded deadline + 2s (${slackMs}ms)`);
    }
  } else if (cell.kind === 'foreground_detach_then_stop') {
    if (cell.detachReason !== 'foreground_detached') {
      productFailures.push(`P1 foreground_detach expected foreground_detached receipt, got ${cell.detachReason}`);
    }
    if ((cell.detachReceiptDelayFromDeadlineMs ?? Infinity) > 2_000) {
      productFailures.push(`P1 foreground_detached receipt delay ${cell.detachReceiptDelayFromDeadlineMs}ms > 2000ms`);
    }
    if (cell.terminalStatusAfterStop !== 'killed') {
      productFailures.push(`P1 after TaskStop expected killed, got ${cell.terminalStatusAfterStop}`);
    }
    if ((cell.cleanupMsFromStopIngress ?? Infinity) > 2_000) {
      productFailures.push(`P1 TaskStop cleanup ${cell.cleanupMsFromStopIngress}ms > 2000ms`);
    }
  } else if (cell.kind === 'direct_cancel') {
    if (cell.terminalStatus !== 'killed') {
      productFailures.push(`P1 direct_cancel expected killed, got ${cell.terminalStatus}`);
    }
    if ((cell.cleanupMsFromCancelIngress ?? Infinity) > 2_000) {
      productFailures.push(`P1 direct_cancel cleanup ${cell.cleanupMsFromCancelIngress}ms > 2000ms`);
    }
  } else {
    harnessFailures.push(`P1 unknown cell kind "${cell.kind}"`);
  }

  const exitCode = harnessFailures.length > 0 ? EXIT_HARNESS_FAIL : productFailures.length > 0 ? EXIT_PRODUCT_FAIL : EXIT_PASS;
  return { passed: exitCode === EXIT_PASS, exitCode, productFailures, harnessFailures };
}

/**
 * Evaluates Idle CPU Gate over consecutive 10s windows [T0+30s, T0+150s) (Astra v2.3 §§5, 9.5).
 */
export function evaluateIdleCpuGate(idleReport, tierOverride = null) {
  const productFailures = [];
  const harnessFailures = [];
  if (!idleReport || typeof idleReport !== 'object') {
    harnessFailures.push('Idle CPU gate missing report');
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, productFailures, harnessFailures };
  }
  const matrixOverride = tierOverride && typeof tierOverride === 'object' && tierOverride.tiers ? tierOverride : null;
  const tier = ((matrixOverride?.tier ?? (typeof tierOverride === 'string' ? tierOverride : null) ?? idleReport.tier) === 'full') ? 'full' : 'smoke';
  const idleCfg = matrixOverride?.tiers?.idleCpu ?? (tier === 'full' ? DEFAULT_FULL_MATRIX.tiers.idleCpu : DEFAULT_SMOKE_MATRIX.tiers.idleCpu);
  const T = {
    ...FROZEN_V23_THRESHOLDS.s14,
    maxServerCorePct: isPositiveFiniteNumber(idleCfg?.maxServerCorePct) ? idleCfg.maxServerCorePct : FROZEN_V23_THRESHOLDS.s14.maxServerCorePct,
    maxRendererPlusGpuCorePct: isPositiveFiniteNumber(idleCfg?.maxRendererPlusGpuCorePct) ? idleCfg.maxRendererPlusGpuCorePct : FROZEN_V23_THRESHOLDS.s14.maxRendererPlusGpuCorePct,
  };
  const windows = idleReport.windows;
  const requiredWindowCount = isPositiveFiniteNumber(idleCfg?.windowCount) ? idleCfg.windowCount : (tier === 'full' ? T.minWindowsFull : T.minWindowsSmoke);
  if (!Array.isArray(windows) || windows.length < requiredWindowCount) {
    harnessFailures.push(`Idle CPU gate missing windows: got ${windows?.length ?? 0} < required ${requiredWindowCount}`);
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, productFailures, harnessFailures };
  }
  if (idleReport.recorderRafDisabled !== true) {
    harnessFailures.push('Idle CPU gate invalid: flight recorder rAF loop was not disabled during idle measurement');
  }
  if (tier === 'full' && idleReport.headlessNoBrowser === true) {
    harnessFailures.push('Idle CPU gate invalid: full tier requires visible browser renderer+GPU CPU measurement');
  }
  const requireBrowser = tier === 'full' || idleReport.browserEnabled === true || idleReport.headlessNoBrowser !== true;
  const minWindowSec = tier === 'full' ? 10 : 4;
  for (let i = 0; i < windows.length; i += 1) {
    const w = windows[i];
    const windowDurationSec = typeof w.elapsedSec === 'number' ? w.elapsedSec : idleReport.windowSec;
    if (typeof windowDurationSec !== 'number' || !Number.isFinite(windowDurationSec) || windowDurationSec < minWindowSec * 0.9) {
      harnessFailures.push(`Idle window #${i + 1}: windowSec ${windowDurationSec} < required ${minWindowSec}s`);
    }
    if (typeof w.processCount !== 'number' || !Number.isFinite(w.processCount) || w.processCount <= 0) {
      harnessFailures.push(`Idle window #${i + 1}: OS process sampling missing or returned 0 server processes`);
    }
    if (typeof w.serverCorePct !== 'number' || !Number.isFinite(w.serverCorePct)) {
      harnessFailures.push(`Idle window #${i + 1}: missing serverCorePct`);
    } else if (w.serverCorePct > T.maxServerCorePct) {
      productFailures.push(`Idle window #${i + 1}: server+helpers CPU ${w.serverCorePct}% > ${T.maxServerCorePct}%`);
    }
    if (requireBrowser) {
      if (typeof w.rendererProcessCount !== 'number' || !Number.isFinite(w.rendererProcessCount) || w.rendererProcessCount <= 0) {
        harnessFailures.push(`Idle window #${i + 1}: OS process sampling missing or returned 0 Chromium renderer/gpu processes`);
      }
      if (typeof w.rendererPlusGpuCorePct !== 'number' || !Number.isFinite(w.rendererPlusGpuCorePct)) {
        harnessFailures.push(`Idle window #${i + 1}: missing rendererPlusGpuCorePct (visible browser required)`);
      } else if (w.rendererPlusGpuCorePct > T.maxRendererPlusGpuCorePct) {
        productFailures.push(`Idle window #${i + 1}: renderer+GPU CPU ${w.rendererPlusGpuCorePct}% > ${T.maxRendererPlusGpuCorePct}%`);
      }
    }
    if (typeof w.survivingDescendants !== 'number' || !Number.isFinite(w.survivingDescendants)) {
      harnessFailures.push(`Idle window #${i + 1}: missing numeric survivingDescendants from OS process table`);
    } else if (w.survivingDescendants > 0) {
      productFailures.push(`Idle window #${i + 1}: ${w.survivingDescendants} surviving workload descendant(s)`);
    }
  }
  const exitCode = harnessFailures.length > 0 ? EXIT_HARNESS_FAIL : productFailures.length > 0 ? EXIT_PRODUCT_FAIL : EXIT_PASS;
  return { passed: exitCode === EXIT_PASS, exitCode, productFailures, harnessFailures };
}

/**
 * Evaluates a CCP / outer-runner receipt bundle (CRIT #1 + Astra §7).
 * Rejects stale/missing receipts, mismatched runId/buildId, empty requiredStages, missing v2.3 scenarios, or any failed stage.
 */
export function evaluateCcpRunVerdict({
  expectedRunId,
  expectedBuildId,
  expectedTier = null,
  remoteExitCode,
  receipt,
  chaosReport,
  requiredStages = ['hygiene', 'unitTests', 'chaos'],
  enforceMandatoryStages = false,
  requireAllV23Scenarios = undefined,
}) {
  const productFailures = [];
  const harnessFailures = [];
  const MANDATORY_BUNDLE_STAGES = ['hygiene', 'unitTests', 'chaos'];

  if (!expectedRunId) harnessFailures.push('Missing expectedRunId');
  if (typeof expectedBuildId !== 'string' || expectedBuildId.trim().length === 0) {
    harnessFailures.push('Missing expectedBuildId');
  }
  if (!Array.isArray(requiredStages) || requiredStages.length === 0) {
    harnessFailures.push('requiredStages must be a non-empty array');
  }
  const effectiveStages = Array.isArray(requiredStages) ? [...requiredStages] : [];
  if (enforceMandatoryStages) {
    for (const req of MANDATORY_BUNDLE_STAGES) {
      if (!effectiveStages.includes(req)) {
        harnessFailures.push(`Bundle manifest omitted mandatory stage "${req}"`);
        effectiveStages.push(req);
      }
    }
  }
  if (!receipt || typeof receipt !== 'object') {
    harnessFailures.push('Missing remote run-receipt.json (cannot accept stale or absent receipt)');
  } else {
    if (receipt.runId !== expectedRunId) {
      harnessFailures.push(`Stale/mismatched run-receipt runId: got "${receipt.runId}", expected "${expectedRunId}"`);
    }
    if (typeof receipt.buildId !== 'string' || receipt.buildId.trim().length === 0 || (expectedBuildId && receipt.buildId !== expectedBuildId)) {
      harnessFailures.push(`Missing or mismatched buildId: got "${receipt.buildId}", expected "${expectedBuildId}"`);
    }
    for (const stage of effectiveStages) {
      const st = receipt.stages?.[stage];
      if (!st || typeof st.exitCode !== 'number') {
        harnessFailures.push(`Missing fresh stage receipt for "${stage}"`);
      } else if (st.exitCode !== 0) {
        if (stage === 'chaos' && st.exitCode === 1) {
          productFailures.push(`Stage "${stage}" failed with exitCode=${st.exitCode}`);
        } else {
          harnessFailures.push(`Stage "${stage}" failed with exitCode=${st.exitCode}`);
        }
      }
    }
  }

  if (effectiveStages.includes('chaos')) {
    if (!chaosReport || typeof chaosReport !== 'object') {
      harnessFailures.push('Missing downloaded chaos report JSON');
    } else {
      if (chaosReport.runId !== expectedRunId) {
        harnessFailures.push(`Stale or un-stamped chaos report runId: got "${chaosReport.runId}", expected "${expectedRunId}"`);
      }
      if (
        typeof chaosReport.buildId !== 'string' ||
        chaosReport.buildId.trim().length === 0 ||
        (expectedBuildId && chaosReport.buildId !== expectedBuildId)
      ) {
        harnessFailures.push(`Missing or mismatched chaos report buildId: got "${chaosReport.buildId}", expected "${expectedBuildId}"`);
      }
      if (typeof expectedTier === 'string' && expectedTier.trim().length > 0) {
        const normTier = (v) => {
          if (v === 'v23-full' || v === 'full') return 'full';
          if (v === 'v23-smoke' || v === 'smoke') return 'smoke';
          return String(v ?? '');
        };
        if (typeof chaosReport.tier !== 'string' || chaosReport.tier.trim().length === 0) {
          harnessFailures.push(`Missing chaos report tier (expected "${String(expectedTier)}")`);
        } else if (normTier(chaosReport.tier) !== normTier(expectedTier)) {
          harnessFailures.push(`Tier mismatch between manifest ("${String(expectedTier)}") and chaos report ("${chaosReport.tier}")`);
        }
      }
      if (chaosReport.overallPassed !== true) {
        productFailures.push('Chaos report overallPassed is not true');
      }
      if (chaosReport.skipped !== 0) {
        harnessFailures.push(`Chaos report must record skipped === 0, got ${String(chaosReport.skipped)}`);
      }

      const rawSc = chaosReport.scenarios;
      if (chaosReport.overallPassed === true && (!rawSc || typeof rawSc !== 'object' || Object.keys(rawSc).length === 0)) {
        harnessFailures.push('Chaos report scenarios map is missing or empty');
      }
      const sc = rawSc && typeof rawSc === 'object' ? rawSc : {};
      const reportTier =
        chaosReport.tier === 'v23-full' || chaosReport.tier === 'full' ? 'full' : 'smoke';
      const enforceV23Set =
        requireAllV23Scenarios === true ||
        chaosReport.mode === 'v23' ||
        chaosReport.tier === 'v23-smoke' ||
        chaosReport.tier === 'v23-full';
      const enforceWorkstationCliff = chaosReport.mode === 'workstation-cliff';

      if (enforceV23Set) {
        for (const key of ['p01', 's10', 's11', 's12', 's13', 's14', 's16']) {
          if (!sc[key] || typeof sc[key] !== 'object') {
            harnessFailures.push(`Missing required v2.3 scenario "${key}" in chaos report`);
          }
        }
      }
      if (enforceWorkstationCliff && (!sc.s17 || typeof sc.s17 !== 'object')) {
        harnessFailures.push('Missing required scenario "s17" in workstation-cliff chaos report');
      }

      if (sc.p01) {
        const trials = Array.isArray(sc.p01.trials)
          ? sc.p01.trials
          : sc.p01.trial
            ? [sc.p01.trial]
            : [];
        if (trials.length === 0) {
          harnessFailures.push('P0-1 scenario has 0 trials');
        } else {
          for (const t of trials) {
            const v = evaluateP01ColdChildGate(t);
            productFailures.push(...v.productFailures);
            harnessFailures.push(...v.harnessFailures);
          }
          if (enforceV23Set) {
            const lanes = new Set(trials.map((t) => t.lane));
            if (!lanes.has('legacy') || !lanes.has('reopen')) {
              harnessFailures.push(`P0-1 requires both legacy and reopen lanes, got [${[...lanes].join(', ')}]`);
            }
            if (reportTier === 'full') {
              for (const reqMiB of FROZEN_V23_THRESHOLDS.p01.fullRequiredSizeMiB) {
                const matched = trials.some((t) => t.lane === 'legacy' && typeof t.wireBytes === 'number' && Math.abs(t.wireBytes / (1024 * 1024) - reqMiB) <= 3);
                if (!matched) {
                  harnessFailures.push(`P0-1 full tier missing legacy trial near ${reqMiB} MiB`);
                }
              }
            }
          }
        }
      }

      if (sc.s10) {
        if (!sc.s10.evidence || typeof sc.s10.evidence !== 'object') {
          harnessFailures.push('S10 scenario missing evidence object');
        } else {
          const v = evaluateS10Verdict(sc.s10.evidence, { tier: reportTier, matrix: chaosReport.matrix });
          productFailures.push(...v.productFailures);
          harnessFailures.push(...v.harnessFailures);
        }
      }

      if (sc.s11) {
        if (!sc.s11.graphEvidence || !Array.isArray(sc.s11.graphEvidence.expectedEdges) || sc.s11.graphEvidence.expectedEdges.length === 0) {
          harnessFailures.push('S11 scenario missing non-empty graphEvidence.expectedEdges');
        } else {
          const g = verifyMeshGraph(sc.s11.graphEvidence);
          if (!g.ok) productFailures.push(...g.failures);
        }
        if (!sc.s11.cronOutboxTrace) {
          harnessFailures.push('S11 scenario missing cronOutboxTrace');
        } else {
          const c = evaluateP03CronOutboxRecovery(sc.s11.cronOutboxTrace);
          productFailures.push(...c.productFailures);
          harnessFailures.push(...c.harnessFailures);
        }
      }

      if (sc.s12) {
        if (!sc.s12.blindControl) {
          harnessFailures.push('S12 scenario missing blindControl evidence');
        } else {
          const b = evaluateP04BlindMutationControl(sc.s12.blindControl);
          productFailures.push(...b.productFailures);
          harnessFailures.push(...b.harnessFailures);
        }
      }

      if (sc.s13) {
        const cells = Array.isArray(sc.s13.osKillCells)
          ? sc.s13.osKillCells
          : Array.isArray(sc.s13.cells)
            ? sc.s13.cells
            : [];
        if (cells.length < 3) {
          harnessFailures.push(`S13 scenario requires >= 3 §10.5 OS kill cells, got ${cells.length}`);
        } else {
          const kinds = new Set(cells.map((c) => c.kind));
          for (const reqKind of ['terminating_timeout', 'foreground_detach_then_stop', 'direct_cancel']) {
            if (!kinds.has(reqKind)) {
              harnessFailures.push(`S13 missing required cell kind "${reqKind}"`);
            }
          }
          for (const cell of cells) {
            const c = evaluateP1TimeoutVsDetachCell(cell);
            productFailures.push(...c.productFailures);
            harnessFailures.push(...c.harnessFailures);
          }
        }
        const chaosFaults = Array.isArray(sc.s13.chaosFaults)
          ? sc.s13.chaosFaults
          : Array.isArray(sc.s13.faultCells)
            ? sc.s13.faultCells
            : [];
        if (chaosFaults.length < 8) {
          harnessFailures.push(`S13 scenario requires >= 8 live chaosFaults, got ${chaosFaults.length}`);
        } else {
          for (const fc of chaosFaults) {
            if (fc.passed !== true) {
              productFailures.push(`S13 fault cell "${fc.kind}" failed: ${fc.error ?? 'unknown'}`);
            }
          }
        }
      }

      if (sc.s14) {
        if (!sc.s14.idleReport) {
          harnessFailures.push('S14 scenario missing idleReport');
        } else {
          const idle = evaluateIdleCpuGate(sc.s14.idleReport, chaosReport.matrix?.tiers ? chaosReport.matrix : reportTier);
          productFailures.push(...idle.productFailures);
          harnessFailures.push(...idle.harnessFailures);
        }
      }

      if (sc.s16) {
        const s16Eval = evaluateS16MobileVerdict(sc.s16);
        productFailures.push(...s16Eval.productFailures);
        harnessFailures.push(...s16Eval.harnessFailures);
      }

      const normExpectedTier = (t) => (String(t ?? '').includes('full') ? 'full' : 'smoke');
      if (expectedTier !== undefined && expectedTier !== null && chaosReport.matrix?.tier) {
        if (normExpectedTier(chaosReport.matrix.tier) !== normExpectedTier(expectedTier)) {
          harnessFailures.push(
            `Matrix tier mismatch between manifest ("${String(expectedTier)}") and chaos report matrix ("${chaosReport.matrix.tier}")`,
          );
        }
      }
      if (sc.s17) {
        const expectedS17Target =
          chaosReport.matrix?.tiers &&
          (expectedTier === undefined ||
            expectedTier === null ||
            normExpectedTier(chaosReport.matrix.tier) === normExpectedTier(expectedTier))
            ? chaosReport.matrix
            : expectedTier !== undefined && expectedTier !== null
              ? normExpectedTier(expectedTier)
              : chaosReport.matrix?.name ?? reportTier;
        const s17Eval = evaluateS17WorkstationCliffVerdict(sc.s17, expectedS17Target);
        productFailures.push(...s17Eval.productFailures);
        harnessFailures.push(...s17Eval.harnessFailures);
      } else if (chaosReport.mode === 'workstation-cliff') {
        harnessFailures.push('Missing required workstation-cliff scenario "s17" in chaos report');
      }
    }
  }

  if (typeof remoteExitCode === 'number' && remoteExitCode !== 0) {
    if (remoteExitCode === 1 && harnessFailures.length === 0) {
      if (productFailures.length === 0) productFailures.push(`Remote runner exited with code ${remoteExitCode}`);
    } else if (remoteExitCode !== 1) {
      harnessFailures.push(`Remote runner exited with code ${remoteExitCode}`);
    }
  }

  const exitCode =
    harnessFailures.length > 0
      ? EXIT_HARNESS_FAIL
      : productFailures.length > 0
        ? EXIT_PRODUCT_FAIL
        : EXIT_PASS;

  return {
    passed: exitCode === EXIT_PASS,
    exitCode,
    status: exitCode === EXIT_PASS ? 'PASS' : exitCode === EXIT_PRODUCT_FAIL ? 'PRODUCT_FAIL' : 'HARNESS_FAIL',
    productFailures,
    harnessFailures,
  };
}

/**
 * Evaluates Scenario S10 (Live Multi-Subagent Orchestrator Storm) evidence
 * against FROZEN v2.3 thresholds (caller-supplied limits can NEVER relax SLOs).
 */
export function evaluateS10Verdict(evidence, options = {}) {
  const productFailures = [];
  const harnessFailures = [];
  const tier = (options.matrix?.tier ?? options.tier ?? evidence?.tier) === 'full' ? 'full' : 'smoke';
  const s10Cfg = options.matrix?.tiers?.s10 ?? (tier === 'full' ? DEFAULT_FULL_MATRIX.tiers.s10 : DEFAULT_SMOKE_MATRIX.tiers.s10);
  const T = {
    ...FROZEN_V23_THRESHOLDS.s10,
    ...s10Cfg,
    tiers: FROZEN_V23_THRESHOLDS.s10.tiers,
  };
  const scaleFloor = T.tiers[tier];
  const minPeakChildren = Math.max(scaleFloor.minPeakActiveChildren, options.minPeakActiveChildren ?? 0);
  const minChildToolCalls = Math.max(scaleFloor.minChildToolCalls, options.minChildToolCalls ?? 0);
  const minOverlapBuckets = Math.max(scaleFloor.minOverlapBuckets, options.minOverlapBuckets ?? 0);

  if (!evidence || typeof evidence !== 'object') {
    harnessFailures.push('S10 missing evidence');
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, productFailures, harnessFailures };
  }

  if ((evidence.peakActiveChildren ?? 0) < minPeakChildren) {
    harnessFailures.push(`S10 insufficient concurrent children: peak=${evidence.peakActiveChildren ?? 0} < ${minPeakChildren}`);
  }
  if ((evidence.totalChildToolCalls ?? 0) < minChildToolCalls) {
    harnessFailures.push(`S10 insufficient child tool calls: ${evidence.totalChildToolCalls ?? 0} < ${minChildToolCalls}`);
  }
  if ((evidence.overlapBucketsQualified ?? 0) < minOverlapBuckets) {
    harnessFailures.push(`S10 insufficient overlapping load buckets: ${evidence.overlapBucketsQualified ?? 0} < ${minOverlapBuckets}`);
  }

  const browserRequired = tier === 'full' || evidence.browserRequired === true || (evidence.flightRecorder !== null && evidence.flightRecorder !== undefined);
  if (browserRequired) {
    if (!evidence.flightRecorder || (evidence.flightRecorder.sampleCount ?? 0) === 0) {
      harnessFailures.push('S10 browser flight recorder missing or recorded 0 samples');
    }
    if (evidence.guiDistServed === false || evidence.usedStubHtml === true) {
      harnessFailures.push('S10 browser test used stub HTML instead of real built @kiki/gui dist');
    }
  }

  if (!evidence.textPromptAdmission || (evidence.textPromptAdmission.samples ?? 1) <= 0) {
    harnessFailures.push('S10 missing warm text prompt_admission samples');
  } else {
    if (typeof evidence.textPromptAdmission.p95Ms !== 'number' || !Number.isFinite(evidence.textPromptAdmission.p95Ms)) {
      harnessFailures.push('S10 missing numeric textPromptAdmission.p95Ms');
    } else if (evidence.textPromptAdmission.p95Ms > T.promptAdmissionTextP95Ms) {
      productFailures.push(`S10 warm text prompt_admission p95 ${evidence.textPromptAdmission.p95Ms}ms > ${T.promptAdmissionTextP95Ms}ms`);
    }
    if (typeof evidence.textPromptAdmission.maxMs !== 'number' || !Number.isFinite(evidence.textPromptAdmission.maxMs)) {
      harnessFailures.push('S10 missing numeric textPromptAdmission.maxMs');
    } else if (evidence.textPromptAdmission.maxMs > T.promptAdmissionTextMaxMs) {
      productFailures.push(`S10 warm text prompt_admission max ${evidence.textPromptAdmission.maxMs}ms > ${T.promptAdmissionTextMaxMs}ms`);
    }
  }

  if (!evidence.pngPromptAdmission || (evidence.pngPromptAdmission.samples ?? 1) <= 0) {
    harnessFailures.push('S10 missing warm PNG prompt_admission samples');
  } else {
    if (typeof evidence.pngPromptAdmission.p95Ms !== 'number' || !Number.isFinite(evidence.pngPromptAdmission.p95Ms)) {
      harnessFailures.push('S10 missing numeric pngPromptAdmission.p95Ms');
    } else if (evidence.pngPromptAdmission.p95Ms > T.promptAdmissionPngP95Ms) {
      productFailures.push(`S10 warm PNG prompt_admission p95 ${evidence.pngPromptAdmission.p95Ms}ms > ${T.promptAdmissionPngP95Ms}ms`);
    }
    if (typeof evidence.pngPromptAdmission.maxMs !== 'number' || !Number.isFinite(evidence.pngPromptAdmission.maxMs)) {
      harnessFailures.push('S10 missing numeric pngPromptAdmission.maxMs');
    } else if (evidence.pngPromptAdmission.maxMs > T.promptAdmissionPngMaxMs) {
      productFailures.push(`S10 warm PNG prompt_admission max ${evidence.pngPromptAdmission.maxMs}ms > ${T.promptAdmissionPngMaxMs}ms`);
    }
  }

  if ((evidence.promptAdmission?.p95Ms ?? Infinity) > T.promptAdmissionP95Ms) {
    productFailures.push(`S10 prompt_admission p95 ${evidence.promptAdmission?.p95Ms}ms > ${T.promptAdmissionP95Ms}ms`);
  }
  if ((evidence.promptAdmission?.maxMs ?? Infinity) > T.promptAdmissionMaxMs) {
    productFailures.push(`S10 prompt_admission max ${evidence.promptAdmission?.maxMs}ms > ${T.promptAdmissionMaxMs}ms`);
  }

  if ((evidence.failedSends ?? 0) > 0) {
    productFailures.push(`S10 had ${evidence.failedSends} failed user send(s)`);
  }
  if (evidence.durableReceiptsVerified !== true) {
    harnessFailures.push('S10 missing affirmative durableReceiptsVerified === true');
  }
  if ((evidence.durableReceiptsMissing ?? 0) > 0) {
    productFailures.push(`S10 missing ${evidence.durableReceiptsMissing} durable user prompt receipt(s)`);
  }
  if (!evidence.sendToReceipt || (evidence.sendToReceipt.samples ?? 1) <= 0) {
    harnessFailures.push('S10 missing durable sendToReceipt samples');
  } else {
    if ((evidence.sendToReceipt.p95Ms ?? Infinity) > T.sendToReceiptP95Ms) {
      productFailures.push(`S10 send-to-receipt p95 ${evidence.sendToReceipt.p95Ms}ms > ${T.sendToReceiptP95Ms}ms`);
    }
    if ((evidence.sendToReceipt.maxMs ?? Infinity) > T.sendToReceiptMaxMs) {
      productFailures.push(`S10 send-to-receipt max ${evidence.sendToReceipt.maxMs}ms > ${T.sendToReceiptMaxMs}ms`);
    }
  }

  if ((evidence.eld?.p99Ms ?? Infinity) > T.eldP99Ms) {
    productFailures.push(`S10 ELD p99 ${evidence.eld?.p99Ms}ms > ${T.eldP99Ms}ms`);
  }
  if ((evidence.eld?.maxMs ?? Infinity) > T.eldMaxMs) {
    productFailures.push(`S10 ELD max ${evidence.eld?.maxMs}ms > ${T.eldMaxMs}ms`);
  }

  if (evidence.flightRecorder) {
    if ((evidence.flightRecorder.transcriptRootRemounts ?? 0) > 0) {
      productFailures.push(`S10 transcript root remounted ${evidence.flightRecorder.transcriptRootRemounts} time(s)`);
    }
    if (typeof evidence.flightRecorder.cls !== 'number' || !Number.isFinite(evidence.flightRecorder.cls)) {
      harnessFailures.push('S10 flightRecorder missing numeric cls');
    } else if (evidence.flightRecorder.cls > T.clsMax) {
      productFailures.push(`S10 CLS ${evidence.flightRecorder.cls} > ${T.clsMax}`);
    }
    if (typeof evidence.flightRecorder.rawLayoutShift !== 'number' || !Number.isFinite(evidence.flightRecorder.rawLayoutShift)) {
      harnessFailures.push('S10 flightRecorder missing numeric rawLayoutShift');
    } else if (evidence.flightRecorder.rawLayoutShift > T.rawLayoutShiftMax) {
      productFailures.push(`S10 raw input-inclusive layout shift ${evidence.flightRecorder.rawLayoutShift} > ${T.rawLayoutShiftMax}`);
    }
    if ((evidence.flightRecorder.consoleErrors ?? 0) > 0) {
      productFailures.push(`S10 console/page errors: ${evidence.flightRecorder.consoleErrors}`);
    }
    const typing = evidence.flightRecorder.composerTyping ?? evidence.composerTyping;
    if (typing) {
      if ((typing.samples ?? 0) <= 0) {
        harnessFailures.push('S10 composerTyping recorded 0 samples');
      } else if ((typing.p95Ms ?? Infinity) > T.composerTypingP95Ms) {
        productFailures.push(`S10 composerTyping p95 ${typing.p95Ms}ms > ${T.composerTypingP95Ms}ms`);
      }
    } else if (browserRequired) {
      harnessFailures.push('S10 missing composerTyping metrics from browser session');
    }
  }

  if (evidence.chainVerifications) {
    for (const cv of evidence.chainVerifications) {
      if (!cv.ok) productFailures.push(`S10 child chain failed (${cv.firstBrokenStage}): ${(cv.failures ?? []).join('; ')}`);
    }
  }

  const p02Evidence = evidence.p02 ?? evidence.p02MainOnlyWs;
  if (!p02Evidence || typeof p02Evidence !== 'object') {
    harnessFailures.push('S10 missing required p02 main-only WS isolation evidence');
  } else {
    const p02 = evaluateP02MainOnlyWsGate(p02Evidence, tier);
    productFailures.push(...p02.productFailures);
    harnessFailures.push(...p02.harnessFailures);
  }

  if (evidence.p01ColdChildren) {
    for (const trial of evidence.p01ColdChildren) {
      const p01 = evaluateP01ColdChildGate(trial);
      productFailures.push(...p01.productFailures);
      harnessFailures.push(...p01.harnessFailures);
    }
  }

  const exitCode =
    harnessFailures.length > 0
      ? EXIT_HARNESS_FAIL
      : productFailures.length > 0
        ? EXIT_PRODUCT_FAIL
        : EXIT_PASS;

  return {
    passed: exitCode === EXIT_PASS,
    exitCode,
    status: exitCode === EXIT_PASS ? 'PASS' : exitCode === EXIT_PRODUCT_FAIL ? 'PRODUCT_FAIL' : 'HARNESS_FAIL',
    productFailures,
    harnessFailures,
  };
}

/**
 * S16 Mobile Extreme Heavy-Session Load & Lag Root-Cause Gate.
 * Strictly gates kap-server webAssets delivery + compression, mobile 4x CPU + 40ms/15Mbps
 * cold boot, heavy-session TTFM/TBT/LongTask, touch scroll P95 frame time, rapid 5-session
 * switching, and escaped UI regressions (zero error toasts / zero sticky unread dots).
 */
export function evaluateS16MobileVerdict(report) {
  const productFailures = [];
  const harnessFailures = [];
  if (!report || typeof report !== 'object') {
    harnessFailures.push('S16 missing mobile heavy-session report');
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, status: 'HARNESS_FAIL', productFailures, harnessFailures };
  }
  const T = FROZEN_V23_THRESHOLDS.s16;

  if (report.webAssetsAudit?.servedByKapServer !== true) {
    harnessFailures.push('S16 GUI was not served through kap-server real webAssets route');
  }
  if ((report.emulation?.cpuThrottlingRate ?? 0) < 4) {
    harnessFailures.push(`S16 missing mobile CPU throttling (rate=${report.emulation?.cpuThrottlingRate})`);
  }
  if ((report.emulation?.network?.latencyMs ?? 0) < 30) {
    harnessFailures.push(`S16 missing mobile RTT throttling (latencyMs=${report.emulation?.network?.latencyMs})`);
  }
  if (report.emulation?.reducedMotion !== 'no-preference') {
    harnessFailures.push(`S16 reducedMotion must be "no-preference" for real jank measurement (got ${report.emulation?.reducedMotion})`);
  }

  if (Array.isArray(report.pageErrors) && report.pageErrors.length > 0) {
    productFailures.push(`S16 emitted ${report.pageErrors.length} pageerror(s): ${report.pageErrors[0]}`);
  }

  const web = report.webAssetsAudit;
  if (!web || typeof web !== 'object') {
    harnessFailures.push('S16 missing webAssetsAudit telemetry');
  } else {
    if (typeof web.jsChunkCount !== 'number' || web.jsChunkCount <= 0) {
      harnessFailures.push(`S16 webAssetsAudit observed ${web.jsChunkCount ?? 0} JS chunks (must be > 0)`);
    } else if (web.compressedJsChunkCount < web.jsChunkCount) {
      productFailures.push(
        `S16 kap-server webAssets served uncompressed JS (${web.compressedJsChunkCount}/${web.jsChunkCount} compressed, ${web.jsTotalEncodedMiB} MiB wire)`,
      );
    }
    if (typeof web.jsTotalEncodedMiB !== 'number' || !Number.isFinite(web.jsTotalEncodedMiB) || web.jsTotalEncodedMiB <= 0) {
      harnessFailures.push(`S16 webAssetsAudit missing positive jsTotalEncodedMiB (got ${web.jsTotalEncodedMiB})`);
    } else if (isPositiveFiniteNumber(report.maxJsWireMiB) && web.jsTotalEncodedMiB > report.maxJsWireMiB) {
      productFailures.push(`S16 JS wire transfer ${web.jsTotalEncodedMiB} MiB > ${report.maxJsWireMiB} MiB budget`);
    }
  }

  const bootMs = report.coldBoot?.coldBootToShellMs;
  if (typeof bootMs !== 'number' || !Number.isFinite(bootMs)) {
    harnessFailures.push('S16 missing coldBootToShellMs');
  } else if (bootMs > T.coldBootToShellMaxMs) {
    productFailures.push(`S16 mobile cold boot ${bootMs}ms > ${T.coldBootToShellMaxMs}ms`);
  }

  const heavy = report.heavyOpen;
  if (!heavy) {
    harnessFailures.push('S16 missing heavyOpen measurements');
  } else {
    if (typeof heavy.firstMessagePaintMs !== 'number' || !Number.isFinite(heavy.firstMessagePaintMs)) {
      harnessFailures.push('S16 missing heavyOpen.firstMessagePaintMs');
    } else if (heavy.firstMessagePaintMs > T.heavyFirstMessagePaintMaxMs) {
      productFailures.push(`S16 heavy session TTFM ${heavy.firstMessagePaintMs}ms > ${T.heavyFirstMessagePaintMaxMs}ms`);
    }
    if (typeof heavy.totalBlockingTimeMs !== 'number' || !Number.isFinite(heavy.totalBlockingTimeMs)) {
      harnessFailures.push('S16 missing heavyOpen.totalBlockingTimeMs');
    } else if (heavy.totalBlockingTimeMs > T.heavyTbtMaxMs) {
      productFailures.push(`S16 heavy session TBT ${heavy.totalBlockingTimeMs}ms > ${T.heavyTbtMaxMs}ms`);
    }
    if (typeof heavy.maxLongTaskMs !== 'number' || !Number.isFinite(heavy.maxLongTaskMs)) {
      harnessFailures.push('S16 missing heavyOpen.maxLongTaskMs');
    } else if (heavy.maxLongTaskMs > T.heavyMaxLongTaskMs) {
      productFailures.push(`S16 heavy session max LongTask ${heavy.maxLongTaskMs}ms > ${T.heavyMaxLongTaskMs}ms`);
    }
    if (Array.isArray(heavy.errorToastsOnOpen) && heavy.errorToastsOnOpen.length > 0) {
      productFailures.push(`S16 heavy session raised ${heavy.errorToastsOnOpen.length} error toast(s) on open: ${heavy.errorToastsOnOpen[0]}`);
    }
  }

  const scroll = report.touchScroll;
  if (!scroll || typeof scroll !== 'object') {
    harnessFailures.push('S16 missing touchScroll measurements');
  } else {
    if (typeof scroll.frameCount !== 'number' || scroll.frameCount <= 0) {
      harnessFailures.push(`S16 touchScroll observed ${scroll.frameCount ?? 0} frames (must be > 0)`);
    }
    if (typeof scroll.frameP95Ms !== 'number' || !Number.isFinite(scroll.frameP95Ms)) {
      harnessFailures.push('S16 missing touchScroll.frameP95Ms');
    } else if (scroll.frameP95Ms > T.scrollFrameP95MaxMs) {
      productFailures.push(`S16 mobile touch-scroll frame P95 ${scroll.frameP95Ms}ms > ${T.scrollFrameP95MaxMs}ms`);
    }
  }

  const sw = report.rapidSwitch;
  if (!sw || typeof sw !== 'object') {
    harnessFailures.push('S16 missing rapidSwitch measurements');
  } else {
    if ((sw.count ?? 0) < 5) {
      harnessFailures.push(`S16 rapid switch ran only ${sw.count ?? 0}/5 sessions`);
    }
    if (typeof sw.latencyMs?.p95 !== 'number' || !Number.isFinite(sw.latencyMs.p95)) {
      harnessFailures.push('S16 rapid switch missing latencyMs.p95');
    } else if (sw.latencyMs.p95 > T.switchFirstMessagePaintP95MaxMs) {
      productFailures.push(`S16 rapid switch TTFM P95 ${sw.latencyMs.p95}ms > ${T.switchFirstMessagePaintP95MaxMs}ms`);
    }
    if ((sw.stickyUnreadCount ?? 0) > 0) {
      productFailures.push(`S16 rapid switch left ${sw.stickyUnreadCount} viewed session(s) with sticky unread state`);
    }
  }

  const exitCode =
    harnessFailures.length > 0
      ? EXIT_HARNESS_FAIL
      : productFailures.length > 0
        ? EXIT_PRODUCT_FAIL
        : EXIT_PASS;

  return {
    passed: exitCode === EXIT_PASS,
    exitCode,
    status: exitCode === EXIT_PASS ? 'PASS' : exitCode === EXIT_PRODUCT_FAIL ? 'PRODUCT_FAIL' : 'HARNESS_FAIL',
    productFailures,
    harnessFailures,
  };
}

/**
 * Evaluates Scenario S17: Empirical Workstation-Cliff Stress Gate
 * (dual real-directory WorkspacePathIndex cliffs, real [search] + multi-store SQLite contention,
 * multi-session concurrent writing storm + cold giant main/child wire opens, synchronized 429/524
 * faults, stalled MCP/SSH endpoints, residency eviction drain, and process-helper contention).
 */
export function evaluateS17WorkstationCliffVerdict(report, matrixOrTierOverride = null) {
  const productFailures = [];
  const harnessFailures = [];
  if (!report || typeof report !== 'object') {
    harnessFailures.push('S17 missing workstation-cliff report');
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, status: 'HARNESS_FAIL', productFailures, harnessFailures };
  }
  let expectedMatrix;
  try {
    if (matrixOrTierOverride && typeof matrixOrTierOverride === 'object' && matrixOrTierOverride.tiers) {
      expectedMatrix = matrixOrTierOverride;
    } else {
      const targetName =
        typeof matrixOrTierOverride === 'string'
          ? matrixOrTierOverride
          : report.matrixName && ['smoke', 'ccp', 'workstation-cliff'].includes(report.matrixName)
            ? report.matrixName
            : report.tier === 'full'
              ? 'ccp'
              : 'smoke';
      expectedMatrix = loadChaosMatrix(targetName);
    }
  } catch (error) {
    harnessFailures.push(`S17 failed to resolve expected matrix: ${String(error?.message ?? error)}`);
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, status: 'HARNESS_FAIL', productFailures, harnessFailures };
  }
  const tier = expectedMatrix.tier === 'full' ? 'full' : 'smoke';
  const expectedCfg = resolveS17MatrixConfig(expectedMatrix);
  const T = {
    ...FROZEN_V23_THRESHOLDS.s17,
    searchP95MaxMs: isPositiveFiniteNumber(expectedCfg.sqliteContention?.searchP95MaxMs)
      ? expectedCfg.sqliteContention.searchP95MaxMs
      : FROZEN_V23_THRESHOLDS.s17.searchP95MaxMs,
    listP95MaxMs: isPositiveFiniteNumber(expectedCfg.sqliteContention?.listP95MaxMs)
      ? expectedCfg.sqliteContention.listP95MaxMs
      : FROZEN_V23_THRESHOLDS.s17.listP95MaxMs,
    usageP95MaxMs: isPositiveFiniteNumber(expectedCfg.sqliteContention?.usageP95MaxMs)
      ? expectedCfg.sqliteContention.usageP95MaxMs
      : FROZEN_V23_THRESHOLDS.s17.usageP95MaxMs,
    promptAdmissionMaxMs: isPositiveFiniteNumber(expectedCfg.sqliteContention?.promptAdmissionMaxMs)
      ? expectedCfg.sqliteContention.promptAdmissionMaxMs
      : FROZEN_V23_THRESHOLDS.s17.promptAdmissionMaxMs,
    externalStallHealthMaxMs: isPositiveFiniteNumber(expectedCfg.externalStalls?.healthMaxMs)
      ? expectedCfg.externalStalls.healthMaxMs
      : FROZEN_V23_THRESHOLDS.s17.externalStallHealthMaxMs,
    processHelperBurstP95MaxMs: isPositiveFiniteNumber(expectedCfg.processHelperContention?.maxBurstP95Ms)
      ? expectedCfg.processHelperContention.maxBurstP95Ms
      : FROZEN_V23_THRESHOLDS.s17.processHelperBurstP95MaxMs,
  };

  // 1. Dual WorkspacePathIndex Real-Directory Cliffs (NO symlinks!)
  const cliffs = report.workspacePathCliffs;
  if (!cliffs || typeof cliffs !== 'object') {
    harnessFailures.push('S17 missing workspacePathCliffs evidence');
  } else {
    if (cliffs.symlinksUsed !== 0) {
      harnessFailures.push(`S17 workspacePathCliffs illegally used ${cliffs.symlinksUsed} symlink(s) (must use real directories/files)`);
    }
    const sub = cliffs.subOverflow;
    const over = cliffs.umbrellaOverflow;
    const minSubFiles = expectedCfg.workspacePathCliffs.subOverflowFiles;
    const minOverFiles = expectedCfg.workspacePathCliffs.umbrellaOverflowFiles;
    if (!sub || sub.overflow !== false || (sub.entryCount ?? 0) <= 0 || (sub.fileCount ?? 0) < minSubFiles) {
      harnessFailures.push(`S17 sub-overflow cliff invalid (overflow=${sub?.overflow}, files=${sub?.fileCount} < ${minSubFiles}, entries=${sub?.entryCount})`);
    }
    if (sub && sub.concurrentToolsPassed !== true) {
      productFailures.push(`S17 sub-overflow concurrent Bash+Glob+Grep leg failed: ${sub.error ?? 'incomplete'}`);
    }
    if (!over || over.isNonGit !== true || over.overflow !== true || (over.fileCount ?? 0) < minOverFiles) {
      harnessFailures.push(`S17 umbrella overflow cliff invalid (isNonGit=${over?.isNonGit}, overflow=${over?.overflow}, files=${over?.fileCount} < ${minOverFiles})`);
    }
    if (over && over.fallbackToolsPassed !== true) {
      productFailures.push(`S17 umbrella overflow fallback leg failed or starved cpuWorker: ${over.error ?? 'incomplete'}`);
    }
    if (!cliffs.toolEvidence || typeof cliffs.toolEvidence !== 'object') {
      harnessFailures.push('S17 workspacePathCliffs missing toolEvidence');
    } else {
      if ((cliffs.toolEvidence.concurrentProbesExecuted ?? 0) < Math.max(2, expectedCfg.workspacePathCliffs.concurrentToolProbes ?? 2)) {
        harnessFailures.push(`S17 workspacePathCliffs concurrent probes under-executed (${cliffs.toolEvidence.concurrentProbesExecuted})`);
      }
      if ((cliffs.toolEvidence.toolErrors ?? 0) > 0 || cliffs.toolEvidence.postMutationFileVisible !== true) {
        productFailures.push(`S17 workspacePathCliffs tool/invalidation evidence failed (${JSON.stringify(cliffs.toolEvidence)})`);
      }
    }
    if (tier === 'full') {
      if ((sub?.fileCount ?? 0) < 200_000 || (sub?.fileCount ?? 0) >= 250_000) {
        harnessFailures.push(`S17 full tier sub-overflow fileCount=${sub?.fileCount} outside [200000, 250000)`);
      }
      if ((over?.fileCount ?? 0) < 280_000) {
        harnessFailures.push(`S17 full tier umbrella fileCount=${over?.fileCount} < 280000`);
      }
    }
  }

  // 2. Real [search] + Multi-Store SQLite Contention
  const sq = report.sqliteContention;
  if (!sq || typeof sq !== 'object') {
    harnessFailures.push('S17 missing sqliteContention evidence');
  } else {
    if (sq.searchEnabled !== true) {
      harnessFailures.push('S17 sqliteContention ran with [search] disabled');
    }
    if (sq.searchIndexerState === 'unavailable') {
      productFailures.push('S17 SQLite search indexer reported unavailable');
    }
    if (
      (sq.seededSearchDocs ?? 0) < expectedCfg.sqliteContention.searchSeedDocs ||
      (sq.seededHistoryNavRows ?? 0) < expectedCfg.sqliteContention.historyNavSeedRows ||
      (sq.seededUsageFacts ?? 0) < expectedCfg.sqliteContention.usageSeedFacts
    ) {
      harnessFailures.push(
        `S17 sqliteContention underscaled seeds (search=${sq.seededSearchDocs}/${expectedCfg.sqliteContention.searchSeedDocs}, nav=${sq.seededHistoryNavRows}/${expectedCfg.sqliteContention.historyNavSeedRows}, usage=${sq.seededUsageFacts}/${expectedCfg.sqliteContention.usageSeedFacts})`,
      );
    }
    const walStats = sq.walReaderStats;
    if (
      !walStats ||
      walStats.workerThreadsUsed !== true ||
      walStats.overlappingWalWriter !== true ||
      (walStats.failed ?? 1) > 0 ||
      (walStats.matchedRows ?? 0) <= 0 ||
      (sq.walConcurrentReadsCompleted ?? 0) < expectedCfg.sqliteContention.concurrentWalReaders
    ) {
      harnessFailures.push(
        `S17 sqliteContention WAL multi-thread contention incomplete (reads=${sq.walConcurrentReadsCompleted}, failed=${walStats?.failed}, workerThreads=${walStats?.workerThreadsUsed}, overlappingWriter=${walStats?.overlappingWalWriter}, matchedRows=${walStats?.matchedRows})`,
      );
    }
    if ((sq.searchQueriesSucceeded ?? 0) < expectedCfg.sqliteContention.concurrentSearchQueries || (sq.searchQueriesFailed ?? 0) > 0) {
      productFailures.push(`S17 /api/search failed under contention (ok=${sq.searchQueriesSucceeded}/${expectedCfg.sqliteContention.concurrentSearchQueries}, failed=${sq.searchQueriesFailed})`);
    }
    if ((sq.searchHitsTotal ?? 0) <= 0) {
      productFailures.push('S17 /api/search returned 0 total hits against pre-populated search-index-v2');
    }
    if (!Number.isFinite(sq.searchLatencyMs?.p95)) {
      harnessFailures.push('S17 missing finite /api/search latency p95');
    } else if (sq.searchLatencyMs.p95 > T.searchP95MaxMs) {
      productFailures.push(`S17 /api/search p95 ${sq.searchLatencyMs.p95}ms > ${T.searchP95MaxMs}ms`);
    }
    if ((sq.listQueriesSucceeded ?? 0) <= 0 || (sq.listQueriesFailed ?? 0) > 0) {
      productFailures.push(`S17 /api/sessions list failed under contention (ok=${sq.listQueriesSucceeded}, failed=${sq.listQueriesFailed})`);
    }
    if (!Number.isFinite(sq.listLatencyMs?.p95)) {
      harnessFailures.push('S17 missing finite /api/sessions list latency p95');
    } else if (sq.listLatencyMs.p95 > T.listP95MaxMs) {
      productFailures.push(`S17 /api/sessions list p95 ${sq.listLatencyMs.p95}ms > ${T.listP95MaxMs}ms`);
    }
    if ((sq.usageQueriesSucceeded ?? 0) <= 0 || (sq.usageQueriesFailed ?? 0) > 0) {
      productFailures.push(`S17 /api/usage accounting failed under contention (ok=${sq.usageQueriesSucceeded}, failed=${sq.usageQueriesFailed})`);
    }
    if (!Number.isFinite(sq.usageLatencyMs?.p95)) {
      harnessFailures.push('S17 missing finite /api/usage latency p95');
    } else if (sq.usageLatencyMs.p95 > T.usageP95MaxMs) {
      productFailures.push(`S17 /api/usage p95 ${sq.usageLatencyMs.p95}ms > ${T.usageP95MaxMs}ms`);
    }
    if (sq.promptUnderContentionOk !== true) {
      productFailures.push(`S17 prompt submission under SQLite contention failed: ${sq.promptError ?? 'not ok'}`);
    } else if (!Number.isFinite(sq.promptAdmissionMs)) {
      harnessFailures.push('S17 missing finite promptAdmissionMs under SQLite contention');
    } else if (sq.promptAdmissionMs > T.promptAdmissionMaxMs) {
      productFailures.push(`S17 prompt admission under SQLite contention ${sq.promptAdmissionMs}ms > ${T.promptAdmissionMaxMs}ms`);
    }
  }

  // 3. Multi-Session Concurrent Storm + Simultaneous Cold Giant Wire Opens
  const ms = report.multiSessionStorm;
  if (!ms || typeof ms !== 'object') {
    harnessFailures.push('S17 missing multiSessionStorm evidence');
  } else {
    const reqWriters = expectedCfg.multiSessionStorm.activeWritingSessions;
    const reqChildren = expectedCfg.multiSessionStorm.activeChildren;
    const reqColdOpens = expectedCfg.multiSessionStorm.coldGiantOpens ?? 1;
    if ((ms.writingSessionsAttempted ?? 0) < reqWriters) {
      harnessFailures.push(`S17 multi-session writers underscaled (${ms.writingSessionsAttempted} < ${reqWriters})`);
    } else if ((ms.writingSessionsSucceeded ?? 0) < (ms.writingSessionsAttempted ?? 0)) {
      productFailures.push(`S17 multi-session writers incomplete (${ms.writingSessionsSucceeded}/${ms.writingSessionsAttempted})`);
    }
    if ((ms.observedActiveChildren ?? 0) < reqChildren) {
      harnessFailures.push(`S17 observed spawned children underscaled (${ms.observedActiveChildren} < ${reqChildren})`);
    }
    if ((ms.writeResultsOk ?? 0) < reqWriters) {
      productFailures.push(`S17 multi-session storm Write tool results too low (${ms.writeResultsOk} < ${reqWriters})`);
    }
    if (ms.coldOpensOverlappedWriters !== true) {
      harnessFailures.push('S17 cold wire opens did not overlap active writing storm');
    }
    const minMainBytes = Math.floor(Number(expectedCfg.corpus.giantMainWireMiB ?? 1) * 1024 * 1024 * 0.9);
    const minChildBytes = Math.floor(Number(expectedCfg.corpus.checkpointlessChildWireMiB ?? 1) * 1024 * 1024 * 0.9);
    if ((ms.coldMainWireBytes ?? 0) < minMainBytes || (ms.coldChildWireBytes ?? 0) < minChildBytes) {
      harnessFailures.push(
        `S17 cold wire byte sizes underscaled (main=${ms.coldMainWireBytes} < ${minMainBytes}, child=${ms.coldChildWireBytes} < ${minChildBytes})`,
      );
    }
    if ((ms.coldMainOpensSucceeded ?? 0) < reqColdOpens || (ms.coldMainTranscriptItems ?? 0) <= 0) {
      productFailures.push(`S17 simultaneous cold giant main wire open failed (${ms.coldMainOpensSucceeded}/${reqColdOpens}, items=${ms.coldMainTranscriptItems})`);
    }
    if ((ms.coldChildOpensSucceeded ?? 0) <= 0 || (ms.coldChildTranscriptItems ?? 0) <= 0) {
      productFailures.push(`S17 simultaneous cold checkpointless child wire open failed (ok=${ms.coldChildOpensSucceeded}, items=${ms.coldChildTranscriptItems})`);
    }
    if ((ms.contractViolations ?? 0) > 0) {
      productFailures.push(`S17 twin recorded ${ms.contractViolations} contract violation(s)`);
    }
  }

  // 4. Synchronized 429 (Retry-After / x-should-retry) & 524 Upstream Faults
  const uf = report.upstreamFaults;
  if (!uf || typeof uf !== 'object') {
    harnessFailures.push('S17 missing upstreamFaults evidence');
  } else {
    const reqRa = expectedCfg.upstreamFaults.sync429RetryAfterCount;
    const reqNr = expectedCfg.upstreamFaults.sync429NoRetryCount;
    const req524 = expectedCfg.upstreamFaults.sync524TimeoutCount;
    if ((uf.sync429RetryAfterAttempted ?? 0) < reqRa) {
      harnessFailures.push(`S17 sync 429 Retry-After underscaled (${uf.sync429RetryAfterAttempted} < ${reqRa})`);
    } else if ((uf.sync429RetryAfterRecovered ?? 0) < (uf.sync429RetryAfterAttempted ?? 0)) {
      productFailures.push(`S17 sync 429 Retry-After recovery failed (${uf.sync429RetryAfterRecovered}/${uf.sync429RetryAfterAttempted})`);
    } else if ((uf.sync429RetryAfterDelayRespected ?? 0) < (uf.sync429RetryAfterAttempted ?? 0)) {
      productFailures.push(`S17 sync 429 Retry-After delay not honored (${uf.sync429RetryAfterDelayRespected}/${uf.sync429RetryAfterAttempted}, delays=${JSON.stringify(uf.sync429RetryAfterDelaysMs)})`);
    }
    if ((uf.sync429NoRetryAttempted ?? 0) < reqNr) {
      harnessFailures.push(`S17 sync 429 x-should-retry:false underscaled (${uf.sync429NoRetryAttempted} < ${reqNr})`);
    } else if ((uf.sync429NoRetryVetoRespected ?? 0) < (uf.sync429NoRetryAttempted ?? 0)) {
      productFailures.push(`S17 sync 429 x-should-retry:false veto failed (${uf.sync429NoRetryVetoRespected}/${uf.sync429NoRetryAttempted})`);
    }
    if ((uf.sync524Attempted ?? 0) < req524) {
      harnessFailures.push(`S17 sync 524 underscaled (${uf.sync524Attempted} < ${req524})`);
    } else if ((uf.sync524Recovered ?? 0) < (uf.sync524Attempted ?? 0)) {
      productFailures.push(`S17 sync 524 Gateway Timeout recovery failed (${uf.sync524Recovered}/${uf.sync524Attempted})`);
    }
  }

  // 5. Slow / Stalled MCP & SSH Mock Endpoints
  const stalls = report.externalStalls;
  if (!stalls || typeof stalls !== 'object') {
    harnessFailures.push('S17 missing externalStalls evidence');
  } else {
    if (stalls.mcpStallProbed !== true || (stalls.mcpConnectionsAccepted ?? 0) < 1) {
      harnessFailures.push(`S17 MCP stall endpoint was not contacted (probed=${stalls.mcpStallProbed}, accepted=${stalls.mcpConnectionsAccepted})`);
    } else if (stalls.mcpStallContained !== true) {
      productFailures.push(`S17 MCP stall hung or broke server health: ${stalls.mcpError ?? 'uncontained'}`);
    }
    if (stalls.sshStallProbed !== true || (stalls.sshConnectionsAccepted ?? 0) < 1) {
      harnessFailures.push(`S17 SSH stall endpoint was not contacted (probed=${stalls.sshStallProbed}, accepted=${stalls.sshConnectionsAccepted})`);
    } else if (stalls.sshStallContained !== true) {
      productFailures.push(`S17 SSH stall hung or broke server health: ${stalls.sshError ?? 'uncontained'}`);
    }
    if ((stalls.concurrentHealthSamples ?? 0) < 3) {
      harnessFailures.push(`S17 externalStalls recorded too few concurrent /api/healthz samples (${stalls.concurrentHealthSamples})`);
    }
    if ((stalls.concurrentHealthFailures ?? 0) > 0) {
      productFailures.push(`S17 server /api/healthz had ${stalls.concurrentHealthFailures} failure(s) during MCP/SSH stalls`);
    }
    if (!Number.isFinite(stalls.concurrentHealthMaxMs)) {
      harnessFailures.push('S17 externalStalls missing finite concurrentHealthMaxMs');
    } else if (stalls.concurrentHealthMaxMs > T.externalStallHealthMaxMs) {
      productFailures.push(`S17 server /api/healthz stalled during MCP/SSH timeouts (${stalls.concurrentHealthMaxMs}ms > ${T.externalStallHealthMaxMs}ms)`);
    }
  }

  // 6. Resident-Session Eviction Memory / Handle Drain
  const ev = report.residencyEviction;
  if (!ev || typeof ev !== 'object') {
    harnessFailures.push('S17 missing residencyEviction evidence');
  } else {
    if ((ev.sessionsOpened ?? 0) < expectedCfg.residencyEviction.sessionsToOpen) {
      harnessFailures.push(`S17 residencyEviction opened too few sessions (${ev.sessionsOpened} < ${expectedCfg.residencyEviction.sessionsToOpen})`);
    }
    if (!Number.isFinite(ev.peakLiveSessions) || ev.peakLiveSessions <= expectedCfg.residencyEviction.maxLiveSessions) {
      harnessFailures.push(`S17 residencyEviction peakLiveSessions=${ev.peakLiveSessions} did not exceed maxLiveSessions=${expectedCfg.residencyEviction.maxLiveSessions}`);
    }
    if (ev.autoEvictedBelowCap !== true || (ev.autoEvictionSuccesses ?? 0) <= 0) {
      productFailures.push(`S17 SessionManager automatic residency eviction did not drain below cap (postAuto=${ev.postAutoSweepLiveSessions}, cap=${expectedCfg.residencyEviction.maxLiveSessions}, successes=${ev.autoEvictionSuccesses})`);
    }
    if (!Number.isFinite(ev.postEvictLiveSessions) || ev.drainedCleanly !== true) {
      productFailures.push(`S17 residency eviction did not drain live sessions cleanly (postLive=${ev.postEvictLiveSessions}, maxAllowed=${ev.postEvictMaxLiveSessions})`);
    }
    if (
      !Number.isFinite(ev.peakRssMiB) ||
      !Number.isFinite(ev.postEvictRssMiB) ||
      !Number.isFinite(ev.peakHandleCount) ||
      !Number.isFinite(ev.postEvictHandleCount)
    ) {
      harnessFailures.push(
        `S17 residency eviction missing RSS/handle telemetry (peakRss=${ev.peakRssMiB}, postRss=${ev.postEvictRssMiB}, peakHandles=${ev.peakHandleCount}, postHandles=${ev.postEvictHandleCount})`,
      );
    } else {
      if (ev.postEvictRssMiB > ev.peakRssMiB * 1.2) {
        productFailures.push(`S17 residency eviction RSS grew post-eviction (${ev.postEvictRssMiB} MiB > 1.2x peak ${ev.peakRssMiB} MiB)`);
      }
      if (ev.postEvictHandleCount > ev.peakHandleCount + 64) {
        productFailures.push(`S17 residency eviction leaked OS handles (${ev.postEvictHandleCount} > peak ${ev.peakHandleCount} + 64)`);
      }
    }
    if ((ev.unhandledRejections ?? 0) > 0 || (ev.uncaughtExceptions ?? 0) > 0) {
      productFailures.push(`S17 residency eviction observed uncaught/unhandled errors (${ev.unhandledRejections}/${ev.uncaughtExceptions})`);
    }
  }

  // 7. Process-Helper Contention (win32 Bash bursts under CPU worker load)
  const ph = report.processHelperContention;
  if (!ph || typeof ph !== 'object') {
    harnessFailures.push('S17 missing processHelperContention evidence');
  } else {
    const reqBursts = expectedCfg.processHelperContention.bashBursts;
    const reqGlobGrep = expectedCfg.processHelperContention.concurrentGlobGrep;
    if ((ph.burstsAttempted ?? 0) < reqBursts) {
      harnessFailures.push(`S17 process-helper bursts underscaled (${ph.burstsAttempted} < ${reqBursts})`);
    } else if ((ph.burstsSucceeded ?? 0) < (ph.burstsAttempted ?? 0)) {
      productFailures.push(`S17 process-helper Bash bursts failed (${ph.burstsSucceeded}/${ph.burstsAttempted})`);
    }
    if ((ph.bashToolCallsOk ?? 0) < reqBursts || (ph.globToolCallsOk ?? 0) < reqGlobGrep || (ph.grepToolCallsOk ?? 0) < reqGlobGrep || (ph.toolErrors ?? 0) > 0) {
      productFailures.push(`S17 process-helper concurrent Bash/Glob/Grep tool evidence failed (bash=${ph.bashToolCallsOk}/${reqBursts}, glob=${ph.globToolCallsOk}/${reqGlobGrep}, grep=${ph.grepToolCallsOk}/${reqGlobGrep}, errors=${ph.toolErrors})`);
    }
    if (ph.platform === 'win32' && ph.win32HelperVerified !== true) {
      productFailures.push('S17 win32 process-helper verification failed');
    }
    if (ph.processScanSucceeded !== true) {
      harnessFailures.push(`S17 process-tree descendant scan failed: ${ph.processScanError ?? 'unknown'}`);
    } else if ((ph.survivingDescendants ?? 0) > 0) {
      productFailures.push(`S17 process-helper contention left ${ph.survivingDescendants} surviving descendant(s)`);
    }
    if (!Number.isFinite(ph.burstLatencyMs?.p95)) {
      harnessFailures.push('S17 missing finite process-helper burst latency p95');
    } else if (ph.burstLatencyMs.p95 > T.processHelperBurstP95MaxMs) {
      productFailures.push(`S17 process-helper Bash burst p95 ${ph.burstLatencyMs.p95}ms > ${T.processHelperBurstP95MaxMs}ms`);
    }
  }

  // 8. Server Event Loop Health (required finite evidence)
  if (!Number.isFinite(report.eld?.p99Ms) || !Number.isFinite(report.eld?.maxMs)) {
    harnessFailures.push(`S17 missing finite server ELD telemetry (p99=${report.eld?.p99Ms}, max=${report.eld?.maxMs})`);
  } else {
    if (report.eld.p99Ms > T.eldP99MaxMs) {
      productFailures.push(`S17 ELD p99 ${report.eld.p99Ms}ms > ${T.eldP99MaxMs}ms`);
    }
    if (report.eld.maxMs > T.eldMaxMs) {
      productFailures.push(`S17 ELD max ${report.eld.maxMs}ms > ${T.eldMaxMs}ms`);
    }
  }

  const exitCode =
    harnessFailures.length > 0
      ? EXIT_HARNESS_FAIL
      : productFailures.length > 0
        ? EXIT_PRODUCT_FAIL
        : EXIT_PASS;

  return {
    passed: exitCode === EXIT_PASS,
    exitCode,
    status: exitCode === EXIT_PASS ? 'PASS' : exitCode === EXIT_PRODUCT_FAIL ? 'PRODUCT_FAIL' : 'HARNESS_FAIL',
    productFailures,
    harnessFailures,
  };
}

/**
 * Offline verifier CLI entry (`node scripts/ccp-chaos/verify/verdict.mjs <bundleDir>`).
 */
export function verifySavedBundle(bundleDir) {
  const manifestPath = path.join(bundleDir, 'manifest.json');
  const receiptPath = path.join(bundleDir, 'run-receipt.json');
  const reportPath = fs.existsSync(path.join(bundleDir, 'chaos-report.json'))
    ? path.join(bundleDir, 'chaos-report.json')
    : path.join(bundleDir, 'kiki-chaos-results.json');
  if (!fs.existsSync(manifestPath)) {
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, status: 'HARNESS_FAIL', productFailures: [], harnessFailures: [`Missing ${manifestPath}`] };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
  const chaosReport = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
  return evaluateCcpRunVerdict({
    expectedRunId: manifest.runId,
    expectedBuildId: manifest.buildId,
    expectedTier: manifest.tier ?? null,
    remoteExitCode: receipt?.remoteExitCode,
    receipt,
    chaosReport,
    requiredStages: manifest.requiredStages ?? ['hygiene', 'unitTests', 'chaos'],
    enforceMandatoryStages: true,
    requireAllV23Scenarios: manifest.requireAllV23Scenarios,
  });
}

const isCli = Boolean(process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename);
if (isCli && process.argv[2]) {
  const result = verifySavedBundle(path.resolve(process.argv[2]));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.exitCode;
}
