import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Empirical byte-size quantile definitions from Kiki production telemetry
 * (Astra v2.2 §2 & §9.1). Each population is kept strictly separate.
 */
export const EMPIRICAL_POPULATIONS = Object.freeze({
  repoFiles: Object.freeze({
    n: 7207,
    min: 11,
    p50: 5_222,
    p75: 12_902,
    p90: 30_413,
    p95: 49_050,
    p99: 138_547,
    max: 27_472_691,
    mean: 18_330,
  }),
  bashAndSubagentLogs: Object.freeze({
    n: 4791,
    min: 128,
    p50: 2_355,
    p75: 9_216,
    p90: 56_934,
    p95: 87_450,
    p99: 364_544,
    max: 16_882_074,
    mean: 38_912,
  }),
  spilledToolBlobs: Object.freeze({
    n: 1961,
    min: 32_768,
    p50: 110_490,
    p75: 151_552,
    p90: 191_283,
    p95: 224_358,
    p99: 312_832,
    max: 388_403,
    mean: 128_000,
  }),
  historicalChildWires: Object.freeze({
    n: 521,
    checkpointlessCensusCount: 511,
    min: 65_536,
    p50: 3_680_502,
    p75: 7_109_345,
    p90: 18_255_708,
    p95: 28_919_726,
    p99: 64_634_225,
    max: 106_262_692,
    mean: 7_518_290,
  }),
});

export const P01_COLD_CHILD_SIZES_BYTES = Object.freeze([
  { label: '20MB', targetBytes: 20 * 1024 * 1024, stepCount: 120 },
  { label: '60MB', targetBytes: 60 * 1024 * 1024, stepCount: 220 },
  { label: '82.65MB', targetBytes: Math.round(82.65 * 1024 * 1024), stepCount: 280 },
  { label: '100MB', targetBytes: 100 * 1024 * 1024, stepCount: 340 },
]);

export function createSeededRng(seed) {
  let s = (typeof seed === 'number' ? seed : Number.parseInt(createHash('sha256').update(String(seed)).digest('hex').slice(0, 8), 16)) >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic piecewise-monotone rank-quantile inverse ECDF sampler.
 * Produces an exact rank vector matching the supplied quantile knots.
 */
export function sampleEmpiricalSizeAtRank(pop, rank01) {
  const q = Math.max(0, Math.min(1, rank01));
  const knots = [
    [0.0, pop.min],
    [0.5, pop.p50],
    [0.75, pop.p75],
    [0.9, pop.p90],
    [0.95, pop.p95],
    [0.99, pop.p99],
    [1.0, pop.max],
  ];
  for (let i = 1; i < knots.length; i += 1) {
    const [q0, v0] = knots[i - 1];
    const [q1, v1] = knots[i];
    if (q <= q1) {
      const t = q1 === q0 ? 0 : (q - q0) / (q1 - q0);
      const logInterp = Math.exp(Math.log(Math.max(1, v0)) * (1 - t) + Math.log(Math.max(1, v1)) * t);
      return Math.round(logInterp);
    }
  }
  return pop.max;
}

export function buildRankStratifiedSizes(pop, count, seed = 'default') {
  const rng = createSeededRng(seed);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const rank = count === 1 ? 0.5 : i / (count - 1);
    sizes.push(sampleEmpiricalSizeAtRank(pop, rank));
  }
  for (let i = sizes.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [sizes[i], sizes[j]] = [sizes[j], sizes[i]];
  }
  return sizes;
}

export function computeQuantiles(values) {
  if (!values.length) {
    return { n: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
  const mean = sorted.reduce((acc, v) => acc + v, 0) / sorted.length;
  return {
    n: sorted.length,
    min: sorted[0],
    p50: pick(0.5),
    p75: pick(0.75),
    p90: pick(0.9),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[sorted.length - 1],
    mean: Math.round(mean),
  };
}

/**
 * Computes two-sample KS ECDF distance and relative quantile residuals against
 * a target empirical population.
 */
export function evaluateDistributionParity(actualValues, targetPop, { toleranceRel = 0.05, maxKs = 0.03 } = {}) {
  const actual = computeQuantiles(actualValues);
  const referenceValues = Array.from({ length: Math.max(actualValues.length, 200) }, (_, i, arr) =>
    sampleEmpiricalSizeAtRank(targetPop, arr.length === 1 ? 0.5 : i / (arr.length - 1)),
  ).sort((a, b) => a - b);
  const sortedActual = [...actualValues].sort((a, b) => a - b);

  let i = 0;
  let j = 0;
  let ks = 0;
  while (i < sortedActual.length && j < referenceValues.length) {
    if (sortedActual[i] <= referenceValues[j]) {
      i += 1;
    } else {
      j += 1;
    }
    const diff = Math.abs(i / sortedActual.length - j / referenceValues.length);
    if (diff > ks) ks = diff;
  }

  const residuals = {};
  for (const key of ['p50', 'p75', 'p90', 'p95', 'p99']) {
    const exp = targetPop[key];
    const got = actual[key];
    const relErr = exp > 0 ? Math.abs(got - exp) / exp : 0;
    residuals[key] = { expected: exp, actual: got, relErr: Number(relErr.toFixed(4)), ok: relErr <= toleranceRel };
  }
  const ok = ks <= maxKs && Object.values(residuals).every((r) => r.ok);
  return {
    ok,
    ks: Number(ks.toFixed(4)),
    maxKs,
    actual,
    residuals,
  };
}

/**
 * Generates a single-turn (`turn 0`) replayable checkpointless child `wire.jsonl`
 * with 100–350 distinct tool steps matching the exact target byte budget (for
 * P0-1: 20 MB, 60 MB, 82.65 MB, 100 MB). No repeated turn IDs or duplicate toolCallIds.
 */
export function writeCheckpointlessColdChildWire({
  wirePath,
  agentId,
  targetBytes,
  stepCount = 200,
  distinctiveMarker = `COLD_CHILD_MARKER_${agentId}`,
  baseTime = Date.now() - 45 * 60_000,
}) {
  fs.mkdirSync(path.dirname(wirePath), { recursive: true });
  const fd = fs.openSync(wirePath, 'w');
  let bytesWritten = 0;
  const writeLine = (obj) => {
    const line = `${JSON.stringify(obj)}\n`;
    const buf = Buffer.from(line, 'utf8');
    fs.writeSync(fd, buf);
    bytesWritten += buf.length;
  };

  try {
    writeLine({ type: 'metadata', protocol_version: '1.6', created_at: baseTime });
    writeLine({
      type: 'turn.prompt',
      turnId: 0,
      promptId: `p_cold_${agentId}_0`,
      input: [{ type: 'text', text: `Cold child workspace audit for ${agentId} (${distinctiveMarker})` }],
      origin: { kind: 'user' },
      time: baseTime + 10,
    });
    writeLine({
      type: 'context.append_message',
      message: {
        id: `u_cold_${agentId}_0`,
        role: 'user',
        content: [{ type: 'text', text: `Cold child workspace audit for ${agentId} (${distinctiveMarker})` }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      time: baseTime + 11,
    });

    const perStepTarget = Math.max(1024, Math.floor((targetBytes - 4096) / stepCount));
    for (let s = 1; s <= stepCount; s += 1) {
      const ts = baseTime + s * 250;
      const stepUuid = `step-${agentId}-0-${s}`;
      const callId = `tc-${agentId}-0-${s}`;
      const payloadTarget = Math.max(256, perStepTarget - 520);
      const header = `step=${s}/${stepCount} agent=${agentId} marker=${distinctiveMarker} file=src/mod_${String(s).padStart(4, '0')}.ts\n`;
      const repeatUnit = `row:${s}:${agentId}:checksum_${(s * 2654435761) >>> 0}\n`;
      const repeats = Math.max(1, Math.floor((payloadTarget - header.length) / repeatUnit.length));
      const toolOutput = header + repeatUnit.repeat(repeats);

      writeLine({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '0', step: s, uuid: stepUuid }, time: ts });
      writeLine({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          turnId: '0',
          stepUuid,
          toolCallId: callId,
          name: s % 3 === 0 ? 'Grep' : s % 3 === 1 ? 'Read' : 'Bash',
          args: { path: `src/mod_${String(s).padStart(4, '0')}.ts`, step: s },
        },
        time: ts + 1,
      });
      writeLine({
        type: 'context.append_loop_event',
        event: { type: 'tool.result', toolCallId: callId, result: { output: toolOutput, isError: false } },
        time: ts + 2,
      });
      writeLine({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId: '0',
          stepUuid,
          part: { type: 'text', text: `Verified step ${s}/${stepCount} (${distinctiveMarker}).` },
        },
        time: ts + 3,
      });
      writeLine({
        type: 'context.append_loop_event',
        event: {
          type: 'step.end',
          turnId: '0',
          step: s,
          uuid: stepUuid,
          usage: { inputOther: 1200 + s * 10, output: 180 + (s % 40), inputCacheRead: 400, inputCacheCreation: 0 },
        },
        time: ts + 4,
      });
    }

    writeLine({
      type: 'turn.ended',
      turnId: 0,
      durationMs: stepCount * 250,
      reason: 'completed',
      time: baseTime + (stepCount + 1) * 250,
    });
  } finally {
    fs.closeSync(fd);
  }

  return {
    wirePath,
    agentId,
    stepCount,
    bytesWritten,
    distinctiveMarker,
    checkpoints: [],
  };
}
