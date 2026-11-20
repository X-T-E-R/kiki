import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
  const TWO_MIB = 2 * 1024 * 1024;
  const MIN_LEGACY_SCAN_BYTES_PER_SEC = 2_000_000_000;

  if (trial.wasColdBeforeOpen !== true) {
    harnessFailures.push('P0-1 pre-condition violation: target child was not cold before open');
  }
  if (typeof trial.firstPaintMs !== 'number' || trial.firstPaintMs >= 300) {
    productFailures.push(`P0-1 first paint ${trial.firstPaintMs}ms >= 300ms`);
  }
  if (typeof trial.controlBarSettleMs !== 'number' || trial.controlBarSettleMs >= 500) {
    productFailures.push(`P0-1 control bar settle ${trial.controlBarSettleMs}ms >= 500ms`);
  }
  if (!Array.isArray(trial.responses) || trial.responses.length === 0) {
    harnessFailures.push('P0-1 missing endpoint response receipts');
  } else {
    const forbidden = trial.responses.filter((r) => {
      if (r.code === 50001 || r.code === 40923 || r.status === 'preparing' || r.reason === 'history_canonical_preparing') {
        return true;
      }
      if (typeof r.status !== 'number' || r.status === 0 || r.status >= 400) {
        return true;
      }
      const isLargeColdHooksObserve =
        typeof r.path === 'string' &&
        r.path.includes('/hooks') &&
        r.path.includes('observe=true') &&
        (trial.wireBytes ?? 0) > 8 * 1024 * 1024 &&
        (r.code === 40901 || r.code === 'SESSION_BUSY');
      if (isLargeColdHooksObserve) return false;
      if (r.code !== undefined && r.code !== null && r.code !== 0) {
        return true;
      }
      return false;
    });
    if (forbidden.length > 0) {
      productFailures.push(`P0-1 forbidden or failed initial-open responses: ${JSON.stringify(forbidden)}`);
    }
  }

  if (typeof trial.aggregateParseInputBytes !== 'number' || !Number.isFinite(trial.aggregateParseInputBytes)) {
    harnessFailures.push('P0-1 missing aggregateParseInputBytes attribution');
  } else if (trial.aggregateParseInputBytes <= 0 && (trial.wireBytes ?? 1) > 0) {
    harnessFailures.push('P0-1 unmeasured aggregateParseInputBytes (0B on non-empty wire)');
  } else if (trial.aggregateParseInputBytes > TWO_MIB) {
    productFailures.push(`P0-1 aggregate JSON-parsed input ${trial.aggregateParseInputBytes}B > 2 MiB (${lane})`);
  }

  if (lane === 'legacy') {
    if (!Array.isArray(trial.checkpoints) || trial.checkpoints.length !== 0) {
      harnessFailures.push('P0-1 legacy lane violation: target child had non-empty checkpoints');
    }
    if (trial.preexistingSummaryOrSidecar === true) {
      harnessFailures.push('P0-1 legacy lane violation: target-derived summary/sidecar existed before open');
    }
    const rawPassCount = trial.rawPassCount ?? 1;
    if (rawPassCount > 1) {
      productFailures.push(`P0-1 legacy lane performed ${rawPassCount} raw passes > 1 shared pass`);
    }
    if (typeof trial.auxiliaryTargetReadBytes === 'number' && trial.auxiliaryTargetReadBytes > TWO_MIB) {
      productFailures.push(`P0-1 legacy lane auxiliary reads ${trial.auxiliaryTargetReadBytes}B > 2 MiB`);
    }
    if (typeof trial.legacyScanBytesPerSec !== 'number' || !Number.isFinite(trial.legacyScanBytesPerSec)) {
      harnessFailures.push('P0-1 legacy lane missing measured legacyScanBytesPerSec');
    } else if (trial.legacyScanBytesPerSec <= MIN_LEGACY_SCAN_BYTES_PER_SEC) {
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
    } else if (trial.aggregateWireReadBytes > TWO_MIB) {
      productFailures.push(`P0-1 reopen lane aggregate raw target I/O ${trial.aggregateWireReadBytes}B > 2 MiB`);
    }
    if (!trial.summaryProof || typeof trial.summaryProof !== 'object') {
      harnessFailures.push('P0-1 reopen lane missing required summaryProof');
    } else {
      const p = trial.summaryProof;
      const missingFields = ['sourceIdentity', 'generation', 'coveredByteOffset', 'headSha256', 'tailSha256', 'formatVersion'].filter(
        (k) => p[k] === undefined || p[k] === null || p[k] === '',
      );
      if (missingFields.length > 0) {
        productFailures.push(`P0-1 reopen summary proof missing required fields: ${missingFields.join(', ')}`);
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
 */
export function evaluateP02MainOnlyWsGate(report) {
  const productFailures = [];
  const harnessFailures = [];
  if (!report || typeof report !== 'object') {
    harnessFailures.push('P0-2 missing main-only WS isolation evidence');
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, productFailures, harnessFailures };
  }

  const N = report.requiredStreamingChildren ?? 1;
  if ((report.activeStreamingChildren ?? 0) < N) {
    harnessFailures.push(`P0-2 insufficient concurrent streaming children: ${report.activeStreamingChildren ?? 0} < ${N}`);
  }
  if ((report.controlClientChildBytes ?? 0) <= 0) {
    harnessFailures.push('P0-2 positive-control child_k delta subscriber received 0 bytes (child stream was silent)');
  }

  // §10.2 rolling 5-second producer floors (REQUIRED — fail closed when missing or empty)
  const minRollingWindows = report.minRollingWindows ?? 1;
  if (!Array.isArray(report.rolling5sWindows) || report.rolling5sWindows.length < minRollingWindows) {
    harnessFailures.push(
      `P0-2 §10.2 missing rolling5sWindows evidence: got ${Array.isArray(report.rolling5sWindows) ? report.rolling5sWindows.length : 0} < required ${minRollingWindows}`,
    );
  } else {
    const minActive = Math.ceil(0.9 * N);
    const minStreaming = Math.ceil(N / 3);
    for (let i = 0; i < report.rolling5sWindows.length; i += 1) {
      const w = report.rolling5sWindows[i];
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

  // Product isolation assertions (an observed leak ALWAYS fails as product failure)
  if ((report.unsubscribedChildContentBytes ?? 0) > 0 || (report.unsubscribedChildContentFrames ?? 0) > 0) {
    productFailures.push(
      `P0-2 leaked unsubscribed child content on main-only socket: bytes=${report.unsubscribedChildContentBytes} frames=${report.unsubscribedChildContentFrames}`,
    );
  }
  if ((report.inboundBytesPerSecP99 ?? Infinity) > 128 * 1024) {
    productFailures.push(`P0-2 inbound WS bytes/s p99 ${report.inboundBytesPerSecP99} > 128 KiB`);
  }
  if ((report.inboundBytesPerSecPeak ?? Infinity) > 1024 * 1024) {
    productFailures.push(`P0-2 inbound WS bytes/s peak ${report.inboundBytesPerSecPeak} > 1 MiB`);
  }
  if ((report.inboundFramesPerSecP99 ?? Infinity) > 64) {
    productFailures.push(`P0-2 inbound WS frames/s p99 ${report.inboundFramesPerSecP99} > 64`);
  }
  if ((report.inboundFramesPerSecPeak ?? Infinity) > 192) {
    productFailures.push(`P0-2 inbound WS frames/s peak ${report.inboundFramesPerSecPeak} > 192`);
  }

  // Note: product leak takes precedence if observed even alongside underproduction, else harness error
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
export function evaluateIdleCpuGate(idleReport) {
  const productFailures = [];
  const harnessFailures = [];
  const windows = idleReport?.windows;
  const requiredWindowCount = idleReport?.requiredWindowCount ?? 12;
  if (!Array.isArray(windows) || windows.length < requiredWindowCount) {
    harnessFailures.push(`Idle CPU gate missing windows: got ${windows?.length ?? 0} < required ${requiredWindowCount}`);
    return { passed: false, exitCode: EXIT_HARNESS_FAIL, productFailures, harnessFailures };
  }
  if (idleReport.recorderRafDisabled !== true) {
    harnessFailures.push('Idle CPU gate invalid: flight recorder rAF loop was not disabled during idle measurement');
  }
  for (let i = 0; i < windows.length; i += 1) {
    const w = windows[i];
    if (typeof w.serverCorePct !== 'number' || !Number.isFinite(w.serverCorePct)) {
      harnessFailures.push(`Idle window #${i + 1}: missing serverCorePct`);
    } else if (w.serverCorePct > 2.0) {
      productFailures.push(`Idle window #${i + 1}: server+helpers CPU ${w.serverCorePct}% > 2.0%`);
    }
    if (idleReport.headlessNoBrowser !== true) {
      if (typeof w.rendererPlusGpuCorePct !== 'number' || !Number.isFinite(w.rendererPlusGpuCorePct)) {
        harnessFailures.push(`Idle window #${i + 1}: missing rendererPlusGpuCorePct (visible browser required)`);
      } else if (w.rendererPlusGpuCorePct > 3.0) {
        productFailures.push(`Idle window #${i + 1}: renderer+GPU CPU ${w.rendererPlusGpuCorePct}% > 3.0%`);
      }
    }
    if ((w.survivingDescendants ?? 0) > 0) {
      productFailures.push(`Idle window #${i + 1}: ${w.survivingDescendants} surviving workload descendant(s)`);
    }
  }
  const exitCode = harnessFailures.length > 0 ? EXIT_HARNESS_FAIL : productFailures.length > 0 ? EXIT_PRODUCT_FAIL : EXIT_PASS;
  return { passed: exitCode === EXIT_PASS, exitCode, productFailures, harnessFailures };
}

/**
 * Evaluates a CCP / outer-runner receipt bundle (CRIT #1 + Astra §7).
 * Rejects stale/missing receipts, mismatched runId/buildId, empty requiredStages, or any failed stage.
 */
export function evaluateCcpRunVerdict({
  expectedRunId,
  expectedBuildId,
  remoteExitCode,
  receipt,
  chaosReport,
  requiredStages = ['hygiene', 'unitTests', 'chaos'],
}) {
  const productFailures = [];
  const harnessFailures = [];

  if (!expectedRunId) harnessFailures.push('Missing expectedRunId');
  if (typeof expectedBuildId !== 'string' || expectedBuildId.trim().length === 0) {
    harnessFailures.push('Missing expectedBuildId');
  }
  if (!Array.isArray(requiredStages) || requiredStages.length === 0) {
    harnessFailures.push('requiredStages must be a non-empty array');
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
    for (const stage of Array.isArray(requiredStages) ? requiredStages : []) {
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

  if (Array.isArray(requiredStages) && requiredStages.includes('chaos')) {
    if (!chaosReport || typeof chaosReport !== 'object') {
      harnessFailures.push('Missing downloaded chaos report JSON');
    } else {
      if (chaosReport.runId !== expectedRunId) {
        harnessFailures.push(`Stale or un-stamped chaos report runId: got "${chaosReport.runId}", expected "${expectedRunId}"`);
      }
      if (chaosReport.overallPassed !== true) {
        productFailures.push('Chaos report overallPassed is not true');
      }
      if ((chaosReport.skipped ?? 0) > 0) {
        harnessFailures.push(`Chaos report has skipped=${chaosReport.skipped} > 0`);
      }
      const sc = chaosReport.scenarios ?? {};
      if (sc.p01?.trial) {
        const v = evaluateP01ColdChildGate(sc.p01.trial);
        productFailures.push(...v.productFailures);
        harnessFailures.push(...v.harnessFailures);
      }
      if (Array.isArray(sc.p01?.trials)) {
        for (const t of sc.p01.trials) {
          const v = evaluateP01ColdChildGate(t);
          productFailures.push(...v.productFailures);
          harnessFailures.push(...v.harnessFailures);
        }
      }
      if (sc.s10?.evidence) {
        const v = evaluateS10Verdict(sc.s10.evidence, sc.s10.limits ?? {});
        productFailures.push(...v.productFailures);
        harnessFailures.push(...v.harnessFailures);
      }
      if (sc.s11?.graphEvidence) {
        const g = verifyMeshGraph(sc.s11.graphEvidence);
        if (!g.ok) productFailures.push(...g.failures);
      }
      if (sc.s11?.cronOutboxTrace) {
        const c = evaluateP03CronOutboxRecovery(sc.s11.cronOutboxTrace);
        productFailures.push(...c.productFailures);
        harnessFailures.push(...c.harnessFailures);
      }
      if (sc.s12?.blindControl) {
        const b = evaluateP04BlindMutationControl(sc.s12.blindControl);
        productFailures.push(...b.productFailures);
        harnessFailures.push(...b.harnessFailures);
      }
      if (Array.isArray(sc.s13?.cells)) {
        for (const cell of sc.s13.cells) {
          const c = evaluateP1TimeoutVsDetachCell(cell);
          productFailures.push(...c.productFailures);
          harnessFailures.push(...c.harnessFailures);
        }
      }
      if (sc.s14?.idleReport) {
        const idle = evaluateIdleCpuGate(sc.s14.idleReport);
        productFailures.push(...idle.productFailures);
        harnessFailures.push(...idle.harnessFailures);
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
 * Evaluates Scenario S10 (Live Multi-Subagent Orchestrator Storm) evidence.
 */
export function evaluateS10Verdict(evidence, limits = {}) {
  const productFailures = [];
  const harnessFailures = [];
  const maxPromptAdmTextP95 = limits.promptAdmissionTextP95Ms ?? 250;
  const maxPromptAdmTextP99 = limits.promptAdmissionTextP99Ms ?? 750;
  const maxPromptAdmPngP95 = limits.promptAdmissionPngP95Ms ?? 500;
  const maxPromptAdmPngP99 = limits.promptAdmissionPngP99Ms ?? 1500;
  const maxPromptAdmP95 = limits.promptAdmissionP95Ms ?? 500;
  const maxPromptAdmMax = limits.promptAdmissionMaxMs ?? 1500;
  const maxSendP95 = limits.sendToReceiptP95Ms ?? 750;
  const maxSendMax = limits.sendToReceiptMaxMs ?? 2000;
  const maxEldP99 = limits.eldP99Ms ?? 50;
  const maxEldMax = limits.eldMaxMs ?? 250;
  const minPeakChildren = limits.minPeakActiveChildren ?? 2;
  const minChildToolCalls = limits.minChildToolCalls ?? 4;

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
  if ((evidence.overlapBucketsQualified ?? 0) < (limits.minOverlapBuckets ?? 1)) {
    harnessFailures.push(`S10 insufficient overlapping load buckets: ${evidence.overlapBucketsQualified ?? 0}`);
  }
  if (evidence.browserRequired && (!evidence.flightRecorder || (evidence.flightRecorder.sampleCount ?? 0) === 0)) {
    harnessFailures.push('S10 browser flight recorder missing or recorded 0 samples');
  }

  if (evidence.textPromptAdmission) {
    if ((evidence.textPromptAdmission.p95Ms ?? Infinity) > maxPromptAdmTextP95) {
      productFailures.push(`S10 warm text prompt_admission p95 ${evidence.textPromptAdmission.p95Ms}ms > ${maxPromptAdmTextP95}ms`);
    }
    if ((evidence.textPromptAdmission.p99Ms ?? evidence.textPromptAdmission.maxMs ?? Infinity) > maxPromptAdmTextP99) {
      productFailures.push(`S10 warm text prompt_admission p99 ${evidence.textPromptAdmission.p99Ms ?? evidence.textPromptAdmission.maxMs}ms > ${maxPromptAdmTextP99}ms`);
    }
  }
  if (evidence.pngPromptAdmission) {
    if ((evidence.pngPromptAdmission.p95Ms ?? Infinity) > maxPromptAdmPngP95) {
      productFailures.push(`S10 warm PNG prompt_admission p95 ${evidence.pngPromptAdmission.p95Ms}ms > ${maxPromptAdmPngP95}ms`);
    }
    if ((evidence.pngPromptAdmission.p99Ms ?? evidence.pngPromptAdmission.maxMs ?? Infinity) > maxPromptAdmPngP99) {
      productFailures.push(`S10 warm PNG prompt_admission p99 ${evidence.pngPromptAdmission.p99Ms ?? evidence.pngPromptAdmission.maxMs}ms > ${maxPromptAdmPngP99}ms`);
    }
  }
  if ((evidence.promptAdmission?.p95Ms ?? Infinity) > maxPromptAdmP95) {
    productFailures.push(`S10 prompt_admission p95 ${evidence.promptAdmission?.p95Ms}ms > ${maxPromptAdmP95}ms`);
  }
  if ((evidence.promptAdmission?.maxMs ?? Infinity) > maxPromptAdmMax) {
    productFailures.push(`S10 prompt_admission max ${evidence.promptAdmission?.maxMs}ms > ${maxPromptAdmMax}ms`);
  }
  if ((evidence.sendToReceipt?.p95Ms ?? Infinity) > maxSendP95) {
    productFailures.push(`S10 send-to-receipt p95 ${evidence.sendToReceipt?.p95Ms}ms > ${maxSendP95}ms`);
  }
  if ((evidence.sendToReceipt?.maxMs ?? Infinity) > maxSendMax) {
    productFailures.push(`S10 send-to-receipt max ${evidence.sendToReceipt?.maxMs}ms > ${maxSendMax}ms`);
  }
  if ((evidence.eld?.p99Ms ?? Infinity) > maxEldP99) {
    productFailures.push(`S10 ELD p99 ${evidence.eld?.p99Ms}ms > ${maxEldP99}ms`);
  }
  if ((evidence.eld?.maxMs ?? Infinity) > maxEldMax) {
    productFailures.push(`S10 ELD max ${evidence.eld?.maxMs}ms > ${maxEldMax}ms`);
  }

  if (evidence.flightRecorder) {
    if ((evidence.flightRecorder.transcriptRootRemounts ?? 0) > 0) {
      productFailures.push(`S10 transcript root remounted ${evidence.flightRecorder.transcriptRootRemounts} time(s)`);
    }
    if ((evidence.flightRecorder.cls ?? 0) > 0.02) {
      productFailures.push(`S10 CLS ${evidence.flightRecorder.cls} > 0.02`);
    }
    if ((evidence.flightRecorder.rawLayoutShift ?? 0) > 0.02) {
      productFailures.push(`S10 raw input-inclusive layout shift ${evidence.flightRecorder.rawLayoutShift} > 0.02`);
    }
    if ((evidence.flightRecorder.consoleErrors ?? 0) > 0) {
      productFailures.push(`S10 console/page errors: ${evidence.flightRecorder.consoleErrors}`);
    }
  }

  if (evidence.chainVerifications) {
    for (const cv of evidence.chainVerifications) {
      if (!cv.ok) productFailures.push(`S10 child chain failed (${cv.firstBrokenStage}): ${(cv.failures ?? []).join('; ')}`);
    }
  }

  if (evidence.p02MainOnlyWs) {
    const p02 = evaluateP02MainOnlyWsGate(evidence.p02MainOnlyWs);
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
    remoteExitCode: receipt?.remoteExitCode,
    receipt,
    chaosReport,
    requiredStages: manifest.requiredStages ?? ['hygiene', 'unitTests', 'chaos'],
  });
}

const isCli = Boolean(process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename);
if (isCli && process.argv[2]) {
  const result = verifySavedBundle(path.resolve(process.argv[2]));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.exitCode;
}
