import os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export function roundMs(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Number(value.toFixed(2));
}

export function roundMb(bytes) {
  if (!Number.isFinite(bytes)) return 0;
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

export function quantiles(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].filter((v) => Number.isFinite(v)).toSorted((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  }
  const pick = (q) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return roundMs(sorted[idx]);
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: roundMs(sorted[0]),
    p50: pick(0.5),
    p95: pick(0.95),
    max: roundMs(sorted.at(-1)),
    mean: roundMs(sum / sorted.length),
  };
}

export class EventLoopWindowMonitor {
  constructor(resolutionMs = 20) {
    this.resolutionMs = resolutionMs;
    this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    this.histogram.enable();
    this.prevElu = performance.eventLoopUtilization();
    this.prevMem = process.memoryUsage();
  }

  beginWindow() {
    this.histogram.reset();
    this.prevElu = performance.eventLoopUtilization();
    this.prevMem = process.memoryUsage();
  }

  endWindow() {
    const eluDiff = performance.eventLoopUtilization(
      performance.eventLoopUtilization(),
      this.prevElu,
    );
    const currMem = process.memoryUsage();
    const samples = this.histogram.count;
    const hasSamples = samples > 0;
    const rawP50 = hasSamples ? this.histogram.percentile(50) / 1e6 : null;
    const rawP99 = hasSamples ? this.histogram.percentile(99) / 1e6 : null;
    const rawMax = hasSamples ? this.histogram.max / 1e6 : null;
    this.histogram.reset();
    return {
      eldSamples: samples,
      eldP50Ms: rawP50 === null ? null : roundMs(rawP50),
      eldP99Ms: rawP99 === null ? null : roundMs(rawP99),
      eldMaxMs: rawMax === null ? null : roundMs(rawMax),
      eldRawMaxMs: rawMax,
      elu: Number((eluDiff.utilization * 100).toFixed(1)),
      rssMb: roundMb(currMem.rss),
      heapUsedMb: roundMb(currMem.heapUsed),
      rssDeltaMb: Number(((currMem.rss - this.prevMem.rss) / (1024 * 1024)).toFixed(2)),
      heapDeltaMb: Number(((currMem.heapUsed - this.prevMem.heapUsed) / (1024 * 1024)).toFixed(2)),
    };
  }

  dispose() {
    this.histogram.disable();
  }
}

export function collectForbiddenTokens(corpusHome, sampledSourceIds = []) {
  const tokens = new Set();
  const addVariants = (raw) => {
    if (typeof raw !== 'string' || raw.trim().length < 3) return;
    tokens.add(raw);
    tokens.add(raw.replaceAll('\\', '/'));
    tokens.add(raw.replaceAll('/', '\\'));
    tokens.add(JSON.stringify(raw).slice(1, -1));
  };
  addVariants(corpusHome);
  addVariants(os.homedir());
  try {
    const username = os.userInfo().username;
    if (username && username.length >= 3) tokens.add(username);
  } catch {
    // Ignore environments without OS user lookup.
  }
  for (const id of sampledSourceIds) {
    if (typeof id === 'string' && id.length >= 6) tokens.add(id);
  }
  return [...tokens];
}

export function assertZeroPrivateLeaks(text, forbiddenTokens) {
  const lower = text.toLowerCase();
  for (const token of forbiddenTokens) {
    if (token.length < 3) continue;
    if (lower.includes(token.toLowerCase())) {
      throw new Error('Privacy guard triggered: report contained a local path, username, or private session identifier');
    }
  }
  if (/session_[0-9a-f]{8}-[0-9a-f]{4}-/iu.test(text)) {
    throw new Error('Privacy guard triggered: report contained a raw session UUID');
  }
}
