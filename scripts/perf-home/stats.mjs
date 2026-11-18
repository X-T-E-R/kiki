import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export function roundMs(value) {
  return Number(value.toFixed(2));
}

export function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return roundMs(sorted[0]);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[Math.min(base + 1, sorted.length - 1)];
  return roundMs(sorted[base] + rest * (next - sorted[base]));
}

export function summarizeSamples(samples) {
  if (samples.length === 0) {
    return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    minMs: roundMs(sorted[0]),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: roundMs(sorted[sorted.length - 1]),
    meanMs: roundMs(sum / sorted.length),
  };
}

export class EventLoopMonitor {
  constructor() {
    this.histogram = monitorEventLoopDelay({ resolution: 10 });
    this.eluStart = performance.eventLoopUtilization();
    this.histogram.enable();
  }

  resetWindow() {
    this.histogram.reset();
    this.eluStart = performance.eventLoopUtilization();
  }

  snapshot() {
    const elu = performance.eventLoopUtilization(this.eluStart);
    const nsToMs = (ns) => (Number.isFinite(ns) && ns > 0 ? roundMs(Math.max(0, ns / 1e6 - 10)) : 0);
    const rawToMs = (ns) => (Number.isFinite(ns) && ns > 0 ? roundMs(ns / 1e6) : 0);
    return {
      p50Ms: nsToMs(this.histogram.percentile(50)),
      p99Ms: nsToMs(this.histogram.percentile(99)),
      maxMs: nsToMs(this.histogram.max),
      rawMaxMs: rawToMs(this.histogram.max),
      elu: Number(elu.utilization.toFixed(4)),
    };
  }

  close() {
    this.histogram.disable();
  }
}

export function assertZeroPii(serialized, forbiddenTokens) {
  const lower = serialized.toLowerCase();
  for (const raw of forbiddenTokens) {
    if (typeof raw !== 'string') continue;
    const token = raw.trim();
    if (token.length < 4) continue;
    const normalized = token.toLowerCase();
    if (
      normalized === 'main' ||
      normalized === 'user' ||
      normalized === 'test' ||
      normalized === 'home' ||
      normalized === 'work' ||
      normalized === 'temp' ||
      normalized === 'native' ||
      normalized === 'agent'
    ) {
      continue;
    }
    if (lower.includes(normalized)) {
      throw new Error(`PII safety gate tripped: output contained forbidden private token (length=${token.length})`);
    }
    const forwardSlash = normalized.replaceAll('\\', '/');
    if (forwardSlash.length >= 6 && lower.includes(forwardSlash)) {
      throw new Error(`PII safety gate tripped: output contained forbidden path token (length=${forwardSlash.length})`);
    }
  }
}

export function formatSampleLabel(index, sample) {
  return `sample#${index}[wire=${Math.round(sample.totalWireBytes / 1048576)}MB, main=${Math.round(sample.mainWireBytes / 1048576)}MB, ckpt=${Math.round(sample.mainCkptBytes / 1048576)}MB, state=${Math.round(sample.stateBytes / 1024)}KB, agents=${sample.agentCount}]`;
}
