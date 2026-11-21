import { execFileSync, fork, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { Session as InspectorSession } from 'node:inspector/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import { deflateSync } from 'node:zlib';

import { clone10kSubagents } from './clone-10k-subagents.mjs';
import { createContractTwinServer } from './contract-twin-server.mjs';
import { buildChaosConfigToml, generateChaosCorpus, retargetRestoredCorpus } from './corpus-generator.mjs';
import { runScenarioS6TenKSubagents } from './scenario-10k-subagents.mjs';
import {
  generateExtremeMediaSession,
  runScenarioS7LongRunningSoak,
  runScenarioS8MediaWeakNetStorm,
} from './scenario-soak-and-media-weaknet.mjs';
import {
  resolveS9TierConfig,
  runScenarioS9BrowserFlightRecorder,
  seedS9ChaosExtensions,
} from './scenario-s9-browser-flight-recorder.mjs';
import { runScenarioS10LiveStorm } from './scenarios/s10-live-orchestrator-storm.mjs';
import { runP01ColdChildFanoutProbe } from './scenarios/p01-cold-child-open.mjs';
import { runScenarioS11Mesh256 } from './scenarios/s11-mesh-256-1024.mjs';
import { runScenarioS12BlindHmacTrials } from './scenarios/s12-blind-hmac-trials.mjs';
import { runScenarioS13ChaosFaults } from './scenarios/s13-chaos-faults.mjs';
import { runScenarioS14IdleCpu } from './scenarios/s14-idle-cpu.mjs';
import { listDescendantPids } from './telemetry/process-tree.mjs';
import { buildIsolatedPerfEnv } from '../perf/sandbox-stager.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const isCliMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename);
const isServerWorker = process.argv[2] === '--server-worker';

function roundMs(val) {
  return Number(Number(val ?? 0).toFixed(2));
}

function roundMiB(bytes) {
  return Number((Number(bytes ?? 0) / (1024 * 1024)).toFixed(2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quantile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return roundMs(sorted[idx]);
}

function summarize(samples) {
  if (!samples.length) return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...samples].toSorted((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: roundMs(sorted[0]),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: roundMs(sorted.at(-1)),
    mean: roundMs(sum / sorted.length),
  };
}

export function readLinuxProcMetrics(pid) {
  const out = { vmRssMiB: null, vmHwmMiB: null, writeBytes: null, fdCount: null };
  if (process.platform !== 'linux') return out;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    const hwm = /^VmHWM:\s+(\d+)\s+kB$/mu.exec(status);
    if (rss) out.vmRssMiB = Number((Number(rss[1]) / 1024).toFixed(2));
    if (hwm) out.vmHwmMiB = Number((Number(hwm[1]) / 1024).toFixed(2));
  } catch {}
  try {
    const io = fs.readFileSync(`/proc/${pid}/io`, 'utf8');
    const wb = /^write_bytes:\s+(\d+)$/mu.exec(io);
    if (wb) out.writeBytes = Number(wb[1]);
  } catch {}
  try {
    out.fdCount = fs.readdirSync(`/proc/${pid}/fd`).length;
  } catch {}
  return out;
}

function summarizeHeapProfile(profile, topN = 20) {
  if (!profile?.head) return [];
  const agg = new Map();
  const walk = (node) => {
    const size = Number(node.selfSize ?? 0);
    if (size > 0 && node.callFrame) {
      const fn = node.callFrame.functionName || '(anonymous)';
      const url = (node.callFrame.url || '(native)').replace(/^file:\/\//u, '').replace(REPO_ROOT, '.');
      const key = `${fn} @ ${url}:${node.callFrame.lineNumber}`;
      agg.set(key, (agg.get(key) ?? 0) + size);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  };
  walk(profile.head);
  return [...agg.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([frame, bytes]) => ({ frame, selfMiB: roundMiB(bytes), selfBytes: bytes }));
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function generateValidSyntheticPng(width = 1200, height = 900) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  let state = 0x12345678;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const off = rowStart + 1 + x * 3;
      raw[off] = (state >>> 24) & 0xff;
      raw[off + 1] = (state >>> 16) & 0xff;
      raw[off + 2] = (state >>> 8) & 0xff;
    }
  }
  const compressed = deflateSync(raw, { level: 1 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

function buildMultipartUpload(filename, mimeType, bytes, sessionId) {
  const boundary = `----kikiChaosUpload${randomBytes(6).toString('hex')}`;
  const parts = [];
  if (sessionId) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="session_id"\r\n\r\n${sessionId}\r\n`, 'utf8'));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'utf8',
    ),
  );
  parts.push(bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

if (isServerWorker) {
  const homeDir = process.argv[3];
  const osHomeDir = process.argv[4];
  const { enableIndependentWorkerHeaps } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/agent-core-v2/src/_base/node/workerHeapPolicy.ts')).href
  );
  enableIndependentWorkerHeaps();

  let ioTrace = null;
  const origFsOpen = fs.promises.open.bind(fs.promises);
  const origCreateReadStream = fs.createReadStream.bind(fs);
  const origJsonParse = JSON.parse.bind(JSON);
  const matchTargetPath = (filePath, suffix) => {
    if (!suffix || !filePath) return false;
    const normP = String(filePath).replaceAll('\\', '/');
    const normS = String(suffix).replaceAll('\\', '/');
    return normP.endsWith(normS);
  };
  fs.promises.open = async (filePath, ...rest) => {
    const handle = await origFsOpen(filePath, ...rest);
    const state = ioTrace;
    if (state !== null && matchTargetPath(filePath, state.targetPathSuffix)) {
      state.wireOpenCount += 1;
      const openRecord = { bytes: 0, caller: (new Error().stack ?? '').split('\n').slice(2, 12).map((s) => s.trim()).join(' <- ') };
      state.opens.push(openRecord);
      let handleBytes = 0;
      let handleReadMs = 0;
      let inFlightReads = 0;
      let activeReadStart = 0;
      let fileSize = 0;
      try {
        fileSize = (await handle.stat()).size;
      } catch {}
      const origRead = handle.read.bind(handle);
      handle.read = async (...args) => {
        const t0 = performance.now();
        if (inFlightReads === 0) activeReadStart = t0;
        inFlightReads += 1;
        try {
          const res = await origRead(...args);
          const now = performance.now();
          inFlightReads -= 1;
          if (inFlightReads === 0) {
            const windowDt = now - activeReadStart;
            handleReadMs += windowDt;
            state.wireScanMs += windowDt;
          }
          const n = typeof res?.bytesRead === 'number' ? res.bytesRead : 0;
          state.wireReadBytes += n;
          handleBytes += n;
          const elapsedReadMs = inFlightReads === 0 ? handleReadMs : handleReadMs + (now - activeReadStart);
          openRecord.bytes = handleBytes;
          openRecord.readMs = roundMs(elapsedReadMs);
          if (fileSize > 0 && handleBytes >= fileSize * 0.95 && handleBytes - n < fileSize * 0.95) {
            state.fullPassCount += 1;
          }
          if (fileSize > 0 && handleBytes >= fileSize * 0.95) {
            state.fullPassScanMs = Math.max(state.fullPassScanMs, elapsedReadMs);
            state.fullPassBytes = Math.max(state.fullPassBytes, handleBytes);
          }
          return res;
        } catch (err) {
          const now = performance.now();
          inFlightReads -= 1;
          if (inFlightReads === 0) {
            const windowDt = now - activeReadStart;
            handleReadMs += windowDt;
            state.wireScanMs += windowDt;
          }
          throw err;
        }
      };
    }
    return handle;
  };
  fs.createReadStream = (filePath, ...rest) => {
    const stream = origCreateReadStream(filePath, ...rest);
    const state = ioTrace;
    if (state !== null && matchTargetPath(filePath, state.targetPathSuffix)) {
      state.wireOpenCount += 1;
      let lastChunkTs = performance.now();
      stream.on('data', (chunk) => {
        const now = performance.now();
        state.wireScanMs += Math.min(50, now - lastChunkTs);
        lastChunkTs = now;
        state.wireReadBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk), 'utf8');
      });
    }
    return stream;
  };
  syncBuiltinESMExports();

  const stopIoTrace = () => {
    if (!ioTrace) return null;
    JSON.parse = origJsonParse;
    const out = {
      targetPathSuffix: ioTrace.targetPathSuffix,
      wireReadBytes: ioTrace.wireReadBytes,
      wireOpenCount: ioTrace.wireOpenCount,
      opens: ioTrace.opens,
      rawPassCount: Math.max(1, ioTrace.fullPassCount),
      wireScanMs: roundMs(ioTrace.fullPassScanMs > 0 ? ioTrace.fullPassScanMs : ioTrace.wireScanMs),
      fullPassBytes: ioTrace.fullPassBytes,
      jsonParseInputBytes: ioTrace.jsonParseInputBytes,
      jsonParseCalls: ioTrace.jsonParseCalls,
    };
    ioTrace = null;
    return out;
  };
  const startIoTrace = (targetPathSuffix) => {
    stopIoTrace();
    const state = {
      targetPathSuffix: String(targetPathSuffix ?? ''),
      wireReadBytes: 0,
      wireOpenCount: 0,
      opens: [],
      fullPassCount: 0,
      fullPassScanMs: 0,
      fullPassBytes: 0,
      wireScanMs: 0,
      jsonParseInputBytes: 0,
      jsonParseCalls: 0,
    };
    ioTrace = state;
    JSON.parse = (text, reviver) => {
      if (typeof text === 'string') {
        state.jsonParseInputBytes += Buffer.byteLength(text, 'utf8');
        state.jsonParseCalls += 1;
      }
      return reviver === undefined ? origJsonParse(text) : origJsonParse(text, reviver);
    };
  };

  const [{ startServer }, { ISessionManager, IAgentLifecycleService, ISessionActivityView, MAIN_AGENT_ID }] = await Promise.all([
    import(pathToFileURL(path.join(REPO_ROOT, 'packages/kap-server/src/start.ts')).href),
    import(pathToFileURL(path.join(REPO_ROOT, 'packages/agent-core-v2/src/index.ts')).href),
  ]);

  let unhandledRejections = 0;
  let uncaughtExceptions = 0;
  const errorSamples = [];
  process.on('unhandledRejection', (err) => {
    unhandledRejections += 1;
    if (errorSamples.length < 25) {
      errorSamples.push({ kind: 'unhandledRejection', message: String(err?.stack ?? err).slice(0, 600) });
    }
  });
  process.on('uncaughtException', (err) => {
    uncaughtExceptions += 1;
    if (errorSamples.length < 25) {
      errorSamples.push({ kind: 'uncaughtException', message: String(err?.stack ?? err).slice(0, 600) });
    }
  });

  const inspector = new InspectorSession();
  inspector.connect();
  let heapSamplingActive = false;

  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();
  let eluStart = performance.eventLoopUtilization();
  let maxSingleTickStallMs = 0;
  let lastTick = performance.now();
  const tickTimer = setInterval(() => {
    const now = performance.now();
    maxSingleTickStallMs = Math.max(maxSingleTickStallMs, Math.max(0, now - lastTick - 15));
    lastTick = now;
  }, 15);
  tickTimer.unref();

  const bootT0 = performance.now();
  const server = await startServer({
    hostIdentity: { productName: 'kiki-chaos-bench', version: '0.0.0-chaos', platform: process.platform },
    host: '127.0.0.1',
    port: 0,
    homeDir,
    userSkillDir: path.join(osHomeDir, 'skills'),
    userAgentProfileHomeDir: path.join(osHomeDir, 'agents'),
    logLevel: 'silent',
    runtimeManaged: false,
  });
  const bootMs = roundMs(performance.now() - bootT0);

  const snapshotMetrics = (includeSpaces = false) => {
    const mem = process.memoryUsage();
    const proc = readLinuxProcMetrics(process.pid);
    const elu = performance.eventLoopUtilization(eluStart);
    const hs = v8.getHeapStatistics();
    return {
      pid: process.pid,
      rssMiB: proc.vmRssMiB ?? roundMiB(mem.rss),
      vmHwmMiB: proc.vmHwmMiB ?? roundMiB(mem.rss),
      heapUsedMiB: roundMiB(mem.heapUsed),
      heapTotalMiB: roundMiB(mem.heapTotal),
      externalMiB: roundMiB(mem.external),
      arrayBuffersMiB: roundMiB(mem.arrayBuffers),
      v8HeapLimitMiB: roundMiB(hs.heap_size_limit),
      v8MallocedMiB: roundMiB(hs.malloced_memory),
      ...(includeSpaces
        ? {
            heapSpacesMiB: v8.getHeapSpaceStatistics().map((sp) => ({
              name: sp.space_name,
              usedMiB: roundMiB(sp.space_used_size),
              sizeMiB: roundMiB(sp.space_size),
            })),
          }
        : {}),
      writeBytes: proc.writeBytes,
      fdCount: proc.fdCount,
      eldP99Ms: eld.count > 0 ? roundMs(Math.max(0, eld.percentile(99) / 1e6 - 10)) : 0,
      eldMaxMs: eld.count > 0 ? roundMs(Math.max(0, eld.max / 1e6 - 10)) : 0,
      maxSingleTickStallMs: roundMs(maxSingleTickStallMs),
      eventLoopUtilization: Number(elu.utilization.toFixed(4)),
      unhandledRejections,
      uncaughtExceptions,
      errorSamples: [...errorSamples],
      liveSessionCount: server.core.accessor.get(ISessionManager).listLive?.().length ?? null,
    };
  };

  process.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.cmd === 'metrics') {
      process.send?.({ id: msg.id, metrics: snapshotMetrics(Boolean(msg.includeSpaces)) });
    } else if (msg.cmd === 'resetWindow') {
      eld.reset();
      maxSingleTickStallMs = 0;
      eluStart = performance.eventLoopUtilization();
      lastTick = performance.now();
      process.send?.({ id: msg.id, metrics: snapshotMetrics(false) });
    } else if (msg.cmd === 'startHeapSampling') {
      try {
        if (!heapSamplingActive) {
          await inspector.post('HeapProfiler.enable');
          await inspector.post('HeapProfiler.startSampling', { samplingInterval: 32768 });
          heapSamplingActive = true;
        }
        process.send?.({ id: msg.id, ok: true });
      } catch (err) {
        process.send?.({ id: msg.id, ok: false, error: String(err) });
      }
    } else if (msg.cmd === 'sampleHeapNow') {
      try {
        let topRetainers = [];
        if (heapSamplingActive) {
          const { profile } = await inspector.post('HeapProfiler.getSamplingProfile');
          topRetainers = summarizeHeapProfile(profile, 20);
        }
        process.send?.({ id: msg.id, metrics: snapshotMetrics(true), topRetainers });
      } catch (err) {
        process.send?.({ id: msg.id, metrics: snapshotMetrics(true), topRetainers: [], error: String(err) });
      }
    } else if (msg.cmd === 'stopHeapSampling') {
      try {
        let topRetainers = [];
        if (heapSamplingActive) {
          const { profile } = await inspector.post('HeapProfiler.stopSampling');
          heapSamplingActive = false;
          topRetainers = summarizeHeapProfile(profile, 25);
        }
        process.send?.({ id: msg.id, metrics: snapshotMetrics(true), topRetainers });
      } catch (err) {
        process.send?.({ id: msg.id, metrics: snapshotMetrics(true), topRetainers: [], error: String(err) });
      }
    } else if (msg.cmd === 'gc') {
      if (typeof globalThis.gc === 'function') {
        globalThis.gc();
        await sleep(80);
        globalThis.gc();
        await sleep(80);
      }
      process.send?.({ id: msg.id, metrics: snapshotMetrics(true), gcAvailable: typeof globalThis.gc === 'function' });
    } else if (msg.cmd === 'closeSession') {
      await server.core.accessor.get(ISessionManager).close(msg.sessionId).catch(() => undefined);
      process.send?.({ id: msg.id, ok: true });
    } else if (msg.cmd === 'beginIoTrace') {
      startIoTrace(msg.targetPathSuffix);
      process.send?.({ id: msg.id, ok: true });
    } else if (msg.cmd === 'endIoTrace') {
      process.send?.({ id: msg.id, ioTrace: stopIoTrace() });
    } else if (msg.cmd === 'inspectLiveAgents') {
      const handle = server.core.accessor.get(ISessionManager).get(msg.sessionId);
      if (!handle) {
        process.send?.({ id: msg.id, activeChildCount: 0, liveChildCount: 0, childIds: [], busy: false });
      } else {
        const agents = handle.accessor.get(IAgentLifecycleService).list();
        const children = agents.filter((a) => a.id !== MAIN_AGENT_ID);
        const activity = handle.accessor.get(ISessionActivityView).state();
        process.send?.({
          id: msg.id,
          activeChildCount: children.length,
          liveChildCount: children.length,
          childIds: children.map((a) => a.id),
          busy: Boolean(activity.busy),
          executing: Boolean(activity.executing),
        });
      }
    } else if (msg.cmd === 'shutdown') {
      clearInterval(tickTimer);
      eld.disable();
      try {
        inspector.disconnect();
      } catch {}
      await server.close().catch(() => undefined);
      process.send?.({ id: msg.id, metrics: snapshotMetrics(false) });
      process.exit(0);
    }
  });

  process.send?.({
    ready: true,
    pid: process.pid,
    bootMs,
    port: server.port,
    endpoint: `http://127.0.0.1:${server.port}`,
    token: server.localOwnerToken,
    identity: server.admission.identity,
    metrics: snapshotMetrics(true),
  });
} else if (isCliMain && process.env.KIKI_CHAOS_TSX_READY !== '1') {
  const rootRequire = createRequire(path.join(REPO_ROOT, 'package.json'));
  const tsxImportUrl = pathToFileURL(rootRequire.resolve('tsx/esm')).href;
  const rawLoaderUrl = pathToFileURL(path.join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs')).href;
  const child = spawnSync(
    process.execPath,
    ['--import', rawLoaderUrl, '--import', tsxImportUrl, import.meta.filename, ...process.argv.slice(2)],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '16', KIKI_CHAOS_TSX_READY: '1' },
    },
  );
  process.exit(child.status ?? 1);
}

async function spawnManagedServer({ homeDir, osHomeDir, maxOldSpaceMb = 2048, extraEnv = {} }) {
  fs.mkdirSync(osHomeDir, { recursive: true });
  const req = createRequire(path.join(REPO_ROOT, 'package.json'));
  const tsxUrl = pathToFileURL(req.resolve('tsx/esm')).href;
  const rawLoaderUrl = pathToFileURL(path.join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs')).href;

  const child = fork(import.meta.filename, ['--server-worker', homeDir, osHomeDir], {
    cwd: REPO_ROOT,
    execArgv: [`--max-old-space-size=${maxOldSpaceMb}`, '--expose-gc', '--import', rawLoaderUrl, '--import', tsxUrl],
    env: buildIsolatedPerfEnv({
      homeDir,
      osHomeDir,
      extra: {
        UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '16',
        KIKI_CHAOS_TSX_READY: '1',
        KIKI_CRON_NO_JITTER: '1',
        KIKI_CRON_NO_STALE: '1',
        ...extraEnv,
      },
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const stderrLines = [];
  child.stdout?.resume();
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text && stderrLines.length < 40) stderrLines.push(text.slice(0, 400));
  });

  const readyMsg = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Managed server boot timed out after 120s. stderr=${stderrLines.join(' | ')}`)),
      120_000,
    );
    child.once('message', (m) => {
      if (m?.ready) {
        clearTimeout(timer);
        resolve(m);
      }
    });
    child.once('exit', (code, sig) => {
      clearTimeout(timer);
      reject(new Error(`Managed server exited prematurely code=${code} sig=${sig} stderr=${stderrLines.join(' | ')}`));
    });
  });

  child.setMaxListeners(200);
  let exitInfo = null;
  child.on('error', () => {});
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  const rpc = (cmd, payload = {}, timeoutMs = 45_000) =>
    new Promise((resolve, reject) => {
      if (!child.connected || exitInfo !== null) {
        reject(new Error(`RPC ${cmd} failed: server exited (${JSON.stringify(exitInfo)})`));
        return;
      }
      const id = randomUUID();
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMsg);
        child.off('exit', onExit);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`RPC ${cmd} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(`RPC ${cmd} aborted: server exited (code=${code}, signal=${signal})`));
      };
      const onMsg = (m) => {
        if (m?.id === id) {
          cleanup();
          resolve(m);
        }
      };
      child.on('message', onMsg);
      child.once('exit', onExit);
      try {
        child.send({ id, cmd, ...payload }, (err) => {
          if (err) {
            cleanup();
            reject(err);
          }
        });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

  return {
    child,
    getExitInfo: () => exitInfo,
    pid: readyMsg.pid,
    bootMs: readyMsg.bootMs,
    port: readyMsg.port,
    endpoint: readyMsg.endpoint,
    token: readyMsg.token,
    identity: readyMsg.identity,
    initialMetrics: readyMsg.metrics,
    stderrLines,
    metrics: async (includeSpaces = false) => (await rpc('metrics', { includeSpaces })).metrics,
    resetWindow: async () => (await rpc('resetWindow')).metrics,
    startHeapSampling: async () => rpc('startHeapSampling'),
    sampleHeapNow: async () => rpc('sampleHeapNow'),
    stopHeapSampling: async () => rpc('stopHeapSampling'),
    gc: async () => rpc('gc'),
    closeSession: async (sessionId) => rpc('closeSession', { sessionId }),
    beginIoTrace: async (targetPathSuffix) => rpc('beginIoTrace', { targetPathSuffix }),
    endIoTrace: async () => (await rpc('endIoTrace')).ioTrace,
    inspectLiveAgents: async (sessionId) => rpc('inspectLiveAgents', { sessionId }),
    shutdown: async () => {
      try {
        const res = await rpc('shutdown', {}, 15_000);
        return res.metrics;
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {}
        return null;
      }
    },
    sigkill: async () => {
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      const descendants = listDescendantPids(child.pid);
      for (const pid of [...descendants].reverse()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {}
      return exited;
    },
  };
}

async function apiJson(endpoint, token, method, urlPath, body, timeoutMs = 45_000) {
  const t0 = performance.now();
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}${urlPath}`, {
      method,
      headers,
      signal: controller.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, elapsedMs: roundMs(performance.now() - t0), json, rawText: text.slice(0, 400) };
  } catch (err) {
    return {
      status: 0,
      elapsedMs: roundMs(performance.now() - t0),
      json: null,
      rawText: String(err?.message ?? err).slice(0, 200),
      networkError: err?.name === 'AbortError' ? 'timeout' : String(err?.code ?? err?.message ?? 'fetch_error'),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function submitAndWaitTurn({ endpoint, token, sessionId, content, promptId, timeoutMs = 60_000 }) {
  const t0 = performance.now();
  const effectivePromptId = promptId ?? `p_${randomUUID().slice(0, 12)}`;
  const res = await apiJson(
    endpoint,
    token,
    'POST',
    `/api/sessions/${encodeURIComponent(sessionId)}/prompts`,
    {
      prompt_id: effectivePromptId,
      content: Array.isArray(content) ? content : [{ type: 'text', text: content }],
    },
    timeoutMs,
  );
  const submitMs = res.elapsedMs;
  if (res.status !== 200 || res.json?.code !== 0) {
    return {
      ok: false,
      stage: 'submit',
      promptId: effectivePromptId,
      httpStatus: res.status,
      code: res.json?.code ?? res.networkError ?? 'http_error',
      msg: res.json?.msg ?? res.rawText,
      submitMs,
      totalMs: roundMs(performance.now() - t0),
    };
  }

  const deadline = performance.now() + timeoutMs;
  let lastStatus = null;
  let observedBusyOrExplicitIdle = false;
  while (performance.now() < deadline) {
    const st = await apiJson(endpoint, token, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/status`, undefined, 15_000);
    lastStatus = st.json?.data ?? null;
    if (st.status !== 200 || !lastStatus || typeof lastStatus !== 'object') {
      await sleep(80);
      continue;
    }
    const hasBusySignal =
      typeof lastStatus.busy === 'boolean' ||
      typeof lastStatus.executing === 'boolean' ||
      typeof lastStatus.main_turn_active === 'boolean' ||
      typeof lastStatus.state === 'string' ||
      typeof lastStatus.loop?.status === 'string';
    if (!hasBusySignal) {
      await sleep(80);
      continue;
    }
    const isBusy =
      lastStatus.busy === true ||
      lastStatus.executing === true ||
      lastStatus.main_turn_active === true ||
      lastStatus.state === 'running' ||
      lastStatus.loop?.status === 'running';
    if (isBusy) {
      observedBusyOrExplicitIdle = true;
      await sleep(50);
      continue;
    }
    const reason = lastStatus.last_turn_reason ?? lastStatus.lastTurnReason ?? null;
    if (reason === null && !observedBusyOrExplicitIdle && performance.now() - t0 < 200) {
      await sleep(50);
      continue;
    }
    return {
      ok: true,
      promptId: effectivePromptId,
      submitMs,
      totalMs: roundMs(performance.now() - t0),
      lastTurnReason: reason ?? (lastStatus.busy === false ? 'completed' : 'unknown'),
    };
  }
  return {
    ok: false,
    stage: 'wait_settle',
    promptId: effectivePromptId,
    code: 'settle_timeout',
    submitMs,
    totalMs: roundMs(performance.now() - t0),
    lastStatus,
  };
}

async function runScenarioS1({ server, twin, corpus, createKlient, WebSocket, progress }) {
  progress('S1: Cold 3.1 GiB session open, ThreadRead, subagent expand, and cold prompt wake with real History tools...');
  await server.resetWindow();
  await server.startHeapSampling();
  const preMetrics = await server.metrics(true);
  const klient = createKlient({ endpoint: server.endpoint, token: server.token, WebSocket, timeoutMs: 60_000 });

  try {
    const openT0 = performance.now();
    let mainResetMs = null;
    let readyMs = null;
    let snapshotMs = null;
    let resolveOpen;
    let rejectOpen;
    const openDone = new Promise((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });

    const view = klient.session(corpus.giantSessionId).view;
    const sub = view.subscribe(
      { sessionCursor: { seq: 0 }, transcriptGrades: { '*': 'turn', main: 'delta' }, bootstrap: true },
      (signal) => {
        if (signal.type === 'transcript' && signal.event.agent_id === 'main' && signal.event.type === 'transcript.reset') {
          if (mainResetMs === null) mainResetMs = roundMs(performance.now() - openT0);
          if (readyMs !== null) resolveOpen();
        } else if (signal.type === 'snapshot') {
          if (snapshotMs === null) snapshotMs = roundMs(performance.now() - openT0);
        } else if (signal.type === 'ready') {
          if (readyMs === null) readyMs = roundMs(performance.now() - openT0);
          if (mainResetMs !== null) resolveOpen();
        } else if (signal.type === 'protocolError') {
          rejectOpen(new Error(`S1 protocolError: ${signal.detail ?? 'unknown'}`));
        }
      },
    );

    const sideReads = Promise.all([
      apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${corpus.giantSessionId}`),
      apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${corpus.giantSessionId}/status`),
      apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${corpus.giantSessionId}/skills`),
      apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${corpus.giantSessionId}/agents/main/hooks?observe=true`),
    ]);

    await Promise.race([
      Promise.all([openDone, sideReads]),
      sleep(45_000).then(() => {
        throw new Error('S1 cold open timed out after 45s');
      }),
    ]);
    const coldOpenTotalMs = roundMs(performance.now() - openT0);

    const threadReadT0 = performance.now();
    const threadPage = await view.transcript.page({ agentId: 'main', pageSize: 20 });
    const threadReadMs = roundMs(performance.now() - threadReadT0);

    const subExpandT0 = performance.now();
    sub.setTranscriptGrades({ '*': 'turn', main: 'delta', [corpus.heavySubagentId]: 'delta' });
    const subPage = await view.transcript.page({ agentId: corpus.heavySubagentId, pageSize: 20 });
    const subExpandMs = roundMs(performance.now() - subExpandT0);
    sub.close();
    await server.closeSession(corpus.giantSessionId).catch(() => undefined);

    const wakeResult = await submitAndWaitTurn({
      endpoint: server.endpoint,
      token: server.token,
      sessionId: corpus.giantSessionId,
      content: '[CHAOS_SCOPE:s1_giant_wake] [TOOLS:GIANT_HISTORY] Wake cold 3.1 GiB session and inspect history tools.',
      timeoutMs: 60_000,
    });

    const heapSnap = await server.stopHeapSampling();
    const gcRes = await server.gc();

    return {
      passed:
        (mainResetMs ?? coldOpenTotalMs) < 800 &&
        threadReadMs < 1000 &&
        wakeResult.ok &&
        wakeResult.totalMs < 5000,
      thresholds: { coldOpenTtfcMaxMs: 800, subagentExpandTargetMs: 50, coldPromptWakeMaxMs: 5000 },
      giantWireGiB: corpus.giantMainWireGiB,
      subagentCount: corpus.subagentCount,
      coldOpenTtfcMs: mainResetMs ?? coldOpenTotalMs,
      coldOpenSnapshotMs: snapshotMs,
      coldOpenReadyMs: readyMs,
      coldOpenTotalMs,
      threadReadMs,
      threadReadItems: Array.isArray(threadPage?.items) ? threadPage.items.length : 0,
      subagentExpandMs: subExpandMs,
      subagentExpandItems: Array.isArray(subPage?.items) ? subPage.items.length : 0,
      coldPromptWake: wakeResult,
      twinToolStatsAfterS1: twin.getStats().toolStats,
      memoryMiB: {
        preRss: preMetrics.rssMiB,
        peakRss: heapSnap.metrics.rssMiB,
        vmHwm: heapSnap.metrics.vmHwmMiB,
        postGcRss: gcRes.metrics.rssMiB,
        postGcHeapUsed: gcRes.metrics.heapUsedMiB,
      },
      topHeapRetainers: heapSnap.topRetainers.slice(0, 10),
      eventLoop: {
        eldP99Ms: heapSnap.metrics.eldP99Ms,
        eldMaxMs: heapSnap.metrics.eldMaxMs,
        maxSingleTickStallMs: heapSnap.metrics.maxSingleTickStallMs,
        eventLoopUtilization: heapSnap.metrics.eventLoopUtilization,
      },
    };
  } finally {
    await klient.close().catch(() => undefined);
  }
}

async function runScenarioS2a({ server, twin, workspaceDir, concurrency, createKlient, WebSocket, progress }) {
  progress(`S2a: ${concurrency}-way Multi-Tool Chaos Storm + Two-Snapshot Barrier Heap Audit...`);
  twin.resetStats();
  await server.resetWindow();
  await server.startHeapSampling();
  const preMetrics = await server.metrics(true);
  const stormStart = performance.now();

  const createdSessionIds = [];
  for (let i = 0; i < concurrency; i += 16) {
    const batch = Array.from({ length: Math.min(16, concurrency - i) }, (_, idx) => i + idx);
    const created = await Promise.all(
      batch.map((idx) =>
        apiJson(server.endpoint, server.token, 'POST', '/api/sessions', {
          title: `Chaos Storm Session #${idx + 1}`,
          metadata: { cwd: workspaceDir },
        }),
      ),
    );
    for (const c of created) {
      if (c.status === 200 && c.json?.code === 0 && c.json?.data?.id) {
        createdSessionIds.push(c.json.data.id);
      }
    }
  }

  const barrierId = `midstream_${concurrency}`;
  const barrierCount = Math.min(64, createdSessionIds.length);
  const barrier = twin.prepareBarrier(barrierId);
  progress(`S2a Barrier: Holding ${barrierCount} concurrent SSE streams midstream for Snapshot A...`);
  const barrierPrompts = createdSessionIds.slice(0, barrierCount).map((sid, idx) =>
    submitAndWaitTurn({
      endpoint: server.endpoint,
      token: server.token,
      sessionId: sid,
      content: `[CHAOS_SCOPE:bar_${sid}] [CHAOS_BARRIER:${barrierId}] Midstream barrier probe #${idx} ${'P'.repeat(4096)}`,
      timeoutMs: 90_000,
    }),
  );
  const arrivedAtBarrier = await barrier.waitForArrivals(barrierCount, 45_000);
  const snapshotA = await server.sampleHeapNow();
  const twinMidStats = twin.getStats();
  progress(
    `Snapshot A (Midstream Barrier, arrived=${arrivedAtBarrier}/${barrierCount}, twinReqs=${twinMidStats.counters.totalRequests}, violations=${twinMidStats.counters.contractViolations}): VmRSS=${snapshotA.metrics.rssMiB} MiB, heapUsed=${snapshotA.metrics.heapUsedMiB} MiB, external=${snapshotA.metrics.externalMiB} MiB`,
  );
  barrier.release();
  const barrierOutcomes = await Promise.all(barrierPrompts);
  if (arrivedAtBarrier < barrierCount) {
    const failedSample = barrierOutcomes.find((o) => !o.ok);
    if (failedSample) {
      progress(`S2a Barrier sample non-ok outcome: ${JSON.stringify(failedSample).slice(0, 400)}`);
    }
  }

  const pngBytes = generateValidSyntheticPng(1800, 1350);
  const early413SessionId = createdSessionIds[0];
  const mp = buildMultipartUpload('chaos-413-hero.png', 'image/png', pngBytes, early413SessionId);
  const uploadRes = await fetch(`${server.endpoint}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': mp.contentType },
    body: mp.body,
  });
  const uploadJson = await uploadRes.json();
  const uploadedFileId = uploadJson?.data?.id ?? null;

  const injectedTags = [
    '[CHAOS:PING_EOF]',
    '[CHAOS:PING_ERROR]',
    '[CHAOS:MALFORMED_TOOL]',
    '[CHAOS:SOFT_SAFETY]',
    '[CHAOS:RATE_LIMIT_429]',
    '[CHAOS:MID_STREAM_EOF]',
  ];
  const toolProfiles = ['WORKSPACE', 'HISTORY', 'MEMORY_TODO', 'THREAD', 'SUBAGENT', 'BRANCH'];

  let wsDisconnectsSimulated = 0;
  let wsReconnectsSucceeded = 0;
  const latenciesMs = [];
  const faultOutcomes = {
    ping_eof: { attempted: 0, recovered: 0 },
    ping_error: { attempted: 0, recovered: 0 },
    malformed_tool: { attempted: 0, recovered: 0 },
    soft_safety: { attempted: 0, terminalExpected: 0 },
    rate_limit_429: { attempted: 0, recovered: 0 },
    mid_stream_eof: { attempted: 0, recovered: 0 },
    early_413: { attempted: 0, recovered: 0 },
    multi_tool: { attempted: 0, succeeded: 0 },
  };

  let peakRssMiB = Math.max(preMetrics.rssMiB, snapshotA.metrics.rssMiB);
  let peakFdCount = snapshotA.metrics.fdCount ?? 0;
  const pollProc = setInterval(() => {
    const proc = readLinuxProcMetrics(server.pid);
    if (proc.vmRssMiB && proc.vmRssMiB > peakRssMiB) peakRssMiB = proc.vmRssMiB;
    if (proc.fdCount && proc.fdCount > peakFdCount) peakFdCount = proc.fdCount;
  }, 200);

  try {
    const turnPromises = createdSessionIds.map(async (sid, idx) => {
      const shouldChurnWs = idx % 10 === 0;
      let wsChurnPromise = Promise.resolve();
      if (shouldChurnWs) {
        wsChurnPromise = (async () => {
          const k = createKlient({ endpoint: server.endpoint, token: server.token, WebSocket, timeoutMs: 20_000 });
          try {
            const sub = k.session(sid).view.subscribe(
              { sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' }, bootstrap: true },
              () => {},
            );
            await sleep(40 + (idx % 60));
            sub.close();
            wsDisconnectsSimulated += 1;
            await k.close().catch(() => undefined);
            const k2 = createKlient({ endpoint: server.endpoint, token: server.token, WebSocket, timeoutMs: 20_000 });
            try {
              const page = await k2.session(sid).view.transcript.page({ agentId: 'main', pageSize: 10 });
              if (page) wsReconnectsSucceeded += 1;
            } finally {
              await k2.close().catch(() => undefined);
            }
          } catch {}
        })();
      }

      if (idx === 0 && uploadedFileId) {
        faultOutcomes.early_413.attempted += 1;
        const r = await submitAndWaitTurn({
          endpoint: server.endpoint,
          token: server.token,
          sessionId: sid,
          content: [
            { type: 'text', text: `[CHAOS_SCOPE:early413_${sid}] [CHAOS:EARLY_413] Analyze this multi-MB synthetic image.` },
            { type: 'image', source: { kind: 'file', file_id: uploadedFileId }, name: 'chaos-413-hero.png' },
          ],
          timeoutMs: 90_000,
        });
        latenciesMs.push(r.totalMs);
        if (r.ok && r.lastTurnReason === 'completed') faultOutcomes.early_413.recovered += 1;
        await wsChurnPromise;
        return { sid, kind: 'early_413', ...r };
      }

      const injectFault = idx >= 1 && idx <= Math.max(12, Math.floor(concurrency * 0.2));
      if (injectFault) {
        const tag = injectedTags[(idx - 1) % injectedTags.length];
        const kind =
          tag === '[CHAOS:PING_EOF]'
            ? 'ping_eof'
            : tag === '[CHAOS:PING_ERROR]'
              ? 'ping_error'
              : tag === '[CHAOS:MALFORMED_TOOL]'
                ? 'malformed_tool'
                : tag === '[CHAOS:SOFT_SAFETY]'
                  ? 'soft_safety'
                  : tag === '[CHAOS:RATE_LIMIT_429]'
                    ? 'rate_limit_429'
                    : 'mid_stream_eof';
        faultOutcomes[kind].attempted += 1;
        const r = await submitAndWaitTurn({
          endpoint: server.endpoint,
          token: server.token,
          sessionId: sid,
          content: `[CHAOS_SCOPE:${kind}_${sid}] ${tag} Execute chaos turn ${idx}.`,
          timeoutMs: 90_000,
        });
        latenciesMs.push(r.totalMs);
        if (kind === 'soft_safety') {
          if (r.ok) faultOutcomes.soft_safety.terminalExpected += 1;
        } else if (r.ok && r.lastTurnReason === 'completed') {
          faultOutcomes[kind].recovered += 1;
        }
        await wsChurnPromise;
        return { sid, kind, ...r };
      }

      const toolProfile = toolProfiles[idx % toolProfiles.length];
      faultOutcomes.multi_tool.attempted += 1;
      const r = await submitAndWaitTurn({
        endpoint: server.endpoint,
        token: server.token,
        sessionId: sid,
        content: `[CHAOS_SCOPE:tool_${toolProfile}_${sid}] [TOOLS:${toolProfile}] Execute real multi-tool storm turn ${idx}.`,
        timeoutMs: 120_000,
      });
      latenciesMs.push(r.totalMs);
      if (r.ok && r.lastTurnReason === 'completed') faultOutcomes.multi_tool.succeeded += 1;
      await wsChurnPromise;
      return { sid, kind: `tool:${toolProfile}`, ...r };
    });

    const results = await Promise.all(turnPromises);

    const probeSessions = createdSessionIds.slice(0, Math.min(8, createdSessionIds.length));
    const followUpResults = await Promise.all(
      probeSessions.map((sid, idx) =>
        submitAndWaitTurn({
          endpoint: server.endpoint,
          token: server.token,
          sessionId: sid,
          content: `[CHAOS_SCOPE:unlock_${sid}] Post-chaos lock probe ${idx}.`,
          timeoutMs: 30_000,
        }),
      ),
    );
    const wedgedLocks = followUpResults.filter((r) => !r.ok).length;

    const stormWallMs = roundMs(performance.now() - stormStart);
    const postStormMetrics = await server.metrics(true);
    if (postStormMetrics.rssMiB > peakRssMiB) peakRssMiB = postStormMetrics.rssMiB;

    for (const sid of createdSessionIds) {
      await server.closeSession(sid).catch(() => undefined);
    }
    await sleep(300);
    const gcRes = await server.gc();
    const snapshotB = await server.stopHeapSampling();
    const twinStats = twin.getStats();

    const settledCount = results.filter((r) => r.ok).length;
    const throughputTurnsPerSec = Number((results.length / (stormWallMs / 1000)).toFixed(2));

    return {
      passed:
        snapshotB.metrics.unhandledRejections === 0 &&
        snapshotB.metrics.uncaughtExceptions === 0 &&
        twinStats.counters.contractViolations === 0 &&
        wedgedLocks === 0 &&
        settledCount === createdSessionIds.length,
      concurrency,
      sessionsCreated: createdSessionIds.length,
      turnsSettled: settledCount,
      stormWallMs,
      throughputTurnsPerSec,
      latencyMs: summarize(latenciesMs),
      wedgedPromptLocks: wedgedLocks,
      wsChurn: { disconnectsSimulated: wsDisconnectsSimulated, reconnectsSucceeded: wsReconnectsSucceeded },
      faultOutcomes,
      twinStats,
      twoSnapshotBarrier: {
        barrierTarget: barrierCount,
        arrivedAtBarrier,
        snapshotA_midstream: {
          rssMiB: snapshotA.metrics.rssMiB,
          vmHwmMiB: snapshotA.metrics.vmHwmMiB,
          heapUsedMiB: snapshotA.metrics.heapUsedMiB,
          externalMiB: snapshotA.metrics.externalMiB,
          heapSpacesMiB: snapshotA.metrics.heapSpacesMiB,
          topRetainers: snapshotA.topRetainers.slice(0, 12),
        },
        snapshotB_postDrainGc: {
          rssMiB: gcRes.metrics.rssMiB,
          vmHwmMiB: gcRes.metrics.vmHwmMiB,
          heapUsedMiB: gcRes.metrics.heapUsedMiB,
          externalMiB: gcRes.metrics.externalMiB,
          heapSpacesMiB: gcRes.metrics.heapSpacesMiB,
          topRetainers: snapshotB.topRetainers.slice(0, 15),
        },
      },
      memoryMiB: {
        preRss: preMetrics.rssMiB,
        midstreamBarrierRss: snapshotA.metrics.rssMiB,
        peakRss: peakRssMiB,
        vmHwm: gcRes.metrics.vmHwmMiB,
        postGcRss: gcRes.metrics.rssMiB,
        rssDropFromPeak: Number((peakRssMiB - gcRes.metrics.rssMiB).toFixed(2)),
        postGcHeapUsed: gcRes.metrics.heapUsedMiB,
      },
      eventLoop: {
        eldP99Ms: postStormMetrics.eldP99Ms,
        eldMaxMs: postStormMetrics.eldMaxMs,
        maxSingleTickStallMs: postStormMetrics.maxSingleTickStallMs,
        eventLoopUtilization: postStormMetrics.eventLoopUtilization,
      },
      processHealth: {
        unhandledRejections: gcRes.metrics.unhandledRejections,
        uncaughtExceptions: gcRes.metrics.uncaughtExceptions,
        errorSamples: gcRes.metrics.errorSamples,
        peakFdCount,
        postGcFdCount: gcRes.metrics.fdCount,
      },
    };
  } finally {
    clearInterval(pollProc);
  }
}

async function runScenarioS2bExtreme1000({ server, twin, workspaceDir, extremeConcurrency, progress }) {
  progress(`S2b (Diagnostic Breaking-Point Tier): Firing ${extremeConcurrency}-way concurrent multi-tool storm...`);
  twin.resetStats();
  await server.resetWindow();
  await server.startHeapSampling();
  const preMetrics = await server.metrics(true);
  const startedAt = performance.now();

  const sessionIds = [];
  const createErrors = Object.create(null);
  const createBatch = 50;
  for (let i = 0; i < extremeConcurrency; i += createBatch) {
    const batch = Array.from({ length: Math.min(createBatch, extremeConcurrency - i) }, (_, idx) => i + idx);
    const created = await Promise.all(
      batch.map((idx) =>
        apiJson(
          server.endpoint,
          server.token,
          'POST',
          '/api/sessions',
          { title: `Extreme1000 #${idx + 1}`, metadata: { cwd: workspaceDir } },
          30_000,
        ),
      ),
    );
    for (const c of created) {
      if (c.status === 200 && c.json?.code === 0 && c.json?.data?.id) {
        sessionIds.push(c.json.data.id);
      } else {
        const key = `${c.status}:${c.json?.code ?? c.networkError ?? 'err'}:${String(c.json?.msg ?? c.rawText).slice(0, 60)}`;
        createErrors[key] = (createErrors[key] ?? 0) + 1;
      }
    }
  }

  let peakRssMiB = preMetrics.rssMiB;
  let peakFdCount = preMetrics.fdCount ?? 0;
  let midSnapshot = null;
  const poll = setInterval(() => {
    const proc = readLinuxProcMetrics(server.pid);
    if (proc.vmRssMiB && proc.vmRssMiB > peakRssMiB) peakRssMiB = proc.vmRssMiB;
    if (proc.fdCount && proc.fdCount > peakFdCount) peakFdCount = proc.fdCount;
  }, 150);

  const errorBreakdown = Object.create(null);
  const latenciesMs = [];
  const profiles = ['WORKSPACE', 'HISTORY', 'MEMORY_TODO', 'THREAD'];

  const profileCounts = Object.fromEntries(profiles.map((p) => [p, 0]));

  try {
    const midTimer = setTimeout(async () => {
      try {
        midSnapshot = await server.sampleHeapNow();
      } catch {}
    }, 3500);

    const turnPromises = sessionIds.map(async (sid, idx) => {
      const useTools = idx % 4 === 0;
      const profile = profiles[Math.floor(idx / 4) % profiles.length];
      if (useTools) profileCounts[profile] += 1;
      const text = useTools
        ? `[CHAOS_SCOPE:x1000_${sid}] [TOOLS:${profile}] Extreme 1000-way tool turn ${idx}.`
        : `[CHAOS_SCOPE:x1000_${sid}] Extreme 1000-way stream turn ${idx}.`;
      const r = await submitAndWaitTurn({
        endpoint: server.endpoint,
        token: server.token,
        sessionId: sid,
        content: text,
        timeoutMs: 120_000,
      });
      latenciesMs.push(r.totalMs);
      if (!r.ok) {
        const errKey = `${r.stage}:${r.httpStatus ?? 0}:${r.code ?? 'err'}:${String(r.msg ?? '').slice(0, 60)}`;
        errorBreakdown[errKey] = (errorBreakdown[errKey] ?? 0) + 1;
      }
      return r;
    });

    const results = await Promise.all(turnPromises);
    clearTimeout(midTimer);

    const wallMs = roundMs(performance.now() - startedAt);
    let postMetrics = null;
    let rpcMetricsTimedOut = false;
    try {
      postMetrics = await server.metrics(true);
      if (postMetrics.rssMiB > peakRssMiB) peakRssMiB = postMetrics.rssMiB;
    } catch (err) {
      rpcMetricsTimedOut = true;
      progress(`S2b breaking-point signal: post-storm server.metrics() timed out (${String(err?.message ?? err)})`);
    }

    if (server.child.connected) {
      for (let i = 0; i < sessionIds.length; i += 50) {
        if (!server.child.connected) break;
        await Promise.all(sessionIds.slice(i, i + 50).map((sid) => server.closeSession(sid).catch(() => undefined)));
      }
      await sleep(300);
    }
    let gcRes = null;
    let heapStop = null;
    if (server.child.connected) {
      try {
        gcRes = await server.gc();
        heapStop = await server.stopHeapSampling();
      } catch (err) {
        progress(`S2b post-drain gc/heapStop note: ${String(err?.message ?? err)}`);
      }
    }
    const finalProc = readLinuxProcMetrics(server.pid);
    const serverExitInfo = server.getExitInfo?.() ?? null;

    const settled = results.filter((r) => r.ok).length;
    const failed = results.length - settled;

    return {
      diagnosticOnly: true,
      targetConcurrency: extremeConcurrency,
      sessionsCreated: sessionIds.length,
      createErrors,
      turnsAttempted: results.length,
      turnsSettled: settled,
      turnsFailed: failed,
      successRatePct: results.length > 0 ? Number(((settled / results.length) * 100).toFixed(2)) : 0,
      wallMs,
      throughputTurnsPerSec: Number((settled / (wallMs / 1000)).toFixed(2)),
      latencyMs: summarize(latenciesMs),
      toolProfileCounts: profileCounts,
      errorBreakdown,
      rpcMetricsTimedOut,
      serverExitedUnderLoad: serverExitInfo !== null,
      serverExitInfo,
      serverStderrTail: server.stderrLines.slice(-10),
      twinStats: twin.getStats(),
      memoryMiB: {
        preRss: preMetrics.rssMiB,
        midStormRss: midSnapshot?.metrics?.rssMiB ?? null,
        midStormHeapUsed: midSnapshot?.metrics?.heapUsedMiB ?? null,
        peakRss: peakRssMiB,
        vmHwm: gcRes?.metrics?.vmHwmMiB ?? finalProc.vmHwmMiB ?? null,
        postGcRss: gcRes?.metrics?.rssMiB ?? finalProc.vmRssMiB ?? null,
        postGcHeapUsed: gcRes?.metrics?.heapUsedMiB ?? null,
      },
      topHeapRetainers: (midSnapshot?.topRetainers?.length ? midSnapshot.topRetainers : (heapStop?.topRetainers ?? [])).slice(0, 15),
      eventLoop: {
        eldP99Ms: postMetrics?.eldP99Ms ?? null,
        eldMaxMs: postMetrics?.eldMaxMs ?? null,
        maxSingleTickStallMs: postMetrics?.maxSingleTickStallMs ?? null,
        eventLoopUtilization: postMetrics?.eventLoopUtilization ?? null,
      },
      processHealth: {
        peakFdCount,
        postGcFdCount: gcRes?.metrics?.fdCount ?? finalProc.fdCount ?? null,
        unhandledRejections: gcRes?.metrics?.unhandledRejections ?? null,
        uncaughtExceptions: gcRes?.metrics?.uncaughtExceptions ?? null,
      },
    };
  } finally {
    clearInterval(poll);
  }
}

async function runScenarioS3({ workRoot, twin, createKlient, WebSocket, progress }) {
  progress('S3: ENOSPC disk-full resilience (AgentBlobService) + SIGKILL (kill -9) wire crash recovery...');
  const enospcResult = {
    mechanism: 'none',
    realKernelEnospc: false,
    agentBlobGracefulFallback: false,
    dataUriPreserved: false,
    error: null,
  };

  const [{ AgentBlobServiceImpl }, { BlobStoreService }, { FileStorageService }] = await Promise.all([
    import(pathToFileURL(path.join(REPO_ROOT, 'packages/agent-core-v2/src/agent/blob/agentBlobServiceImpl.ts')).href),
    import(pathToFileURL(path.join(REPO_ROOT, 'packages/agent-core-v2/src/persistence/backends/node-fs/blobStoreService.ts')).href),
    import(pathToFileURL(path.join(REPO_ROOT, 'packages/agent-core-v2/src/persistence/backends/node-fs/fileStorageService.ts')).href),
  ]);

  const tmpfsDir = path.join(workRoot, 'enospc-tmpfs');
  fs.mkdirSync(tmpfsDir, { recursive: true });
  let mountedTmpfs = false;
  if (process.platform === 'linux') {
    try {
      execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=16M', 'tmpfs', tmpfsDir], { stdio: 'pipe' });
      mountedTmpfs = true;
      enospcResult.mechanism = 'linux_tmpfs_16m';
    } catch {
      mountedTmpfs = false;
    }
  }

  try {
    if (mountedTmpfs) {
      const fillerPath = path.join(tmpfsDir, 'filler.bin');
      const chunk = Buffer.alloc(1024 * 1024, 0x41);
      const fd = fs.openSync(fillerPath, 'w');
      let filledMb = 0;
      try {
        for (let i = 0; i < 20; i += 1) {
          fs.writeSync(fd, chunk);
          filledMb += 1;
        }
      } catch (err) {
        if (err?.code === 'ENOSPC') enospcResult.realKernelEnospc = true;
      } finally {
        fs.closeSync(fd);
      }
      enospcResult.filledMb = filledMb;

      const fsStorage = new FileStorageService(tmpfsDir);
      const blobStore = new BlobStoreService(fsStorage);
      const blobService = new AgentBlobServiceImpl(blobStore, { scope: (name) => `agents/main/${name}` });

      const bigBase64 = randomBytes(512 * 1024).toString('base64');
      const dataUri = `data:image/png;base64,${bigBase64}`;
      const offloaded = await blobService.offloadParts([{ type: 'image_url', image_url: { url: dataUri } }]);
      enospcResult.dataUriPreserved = offloaded?.[0]?.image_url?.url === dataUri;
      enospcResult.agentBlobGracefulFallback = enospcResult.dataUriPreserved;
    } else {
      enospcResult.mechanism = 'simulated_enospc_blob_store';
      const enospcStore = {
        async put() {
          const err = new Error('ENOSPC: no space left on device, write');
          err.code = 'ENOSPC';
          throw err;
        },
        async has() {
          return false;
        },
        async get() {
          return undefined;
        },
      };
      const blobService = new AgentBlobServiceImpl(enospcStore, { scope: (name) => `agents/main/${name}` });
      const bigBase64 = randomBytes(16 * 1024).toString('base64');
      const dataUri = `data:image/png;base64,${bigBase64}`;
      const offloaded = await blobService.offloadParts([{ type: 'image_url', image_url: { url: dataUri } }]);
      enospcResult.dataUriPreserved = offloaded?.[0]?.image_url?.url === dataUri;
      enospcResult.agentBlobGracefulFallback = enospcResult.dataUriPreserved;
    }
  } catch (err) {
    enospcResult.error = String(err?.stack ?? err).slice(0, 400);
  } finally {
    if (mountedTmpfs) {
      try {
        execFileSync('umount', [tmpfsDir], { stdio: 'pipe' });
      } catch {}
    }
  }

  const crashRoot = path.join(workRoot, 'sigkill-recovery');
  const crashHome = path.join(crashRoot, 'home');
  const crashOsHome = path.join(crashRoot, 'os-home');
  const crashWs = path.join(crashRoot, 'workspace');
  fs.rmSync(crashRoot, { recursive: true, force: true });
  fs.mkdirSync(crashHome, { recursive: true });
  fs.mkdirSync(crashWs, { recursive: true });
  fs.writeFileSync(
    path.join(crashHome, 'config.toml'),
    buildChaosConfigToml({ anthropicBaseUrl: twin.httpBaseUrl, openaiBaseUrl: twin.httpV1BaseUrl, enableSearch: false }),
    'utf8',
  );

  const sigkillResult = {
    committedTurnsBeforeCrash: 0,
    killedSignal: null,
    truncatedWireBytesInjected: 0,
    recoveredOnRestart: false,
    committedTurnsAfterRestart: 0,
    postRestartTurnSucceeded: false,
    error: null,
  };

  let s1 = null;
  let s2 = null;
  try {
    s1 = await spawnManagedServer({ homeDir: crashHome, osHomeDir: crashOsHome, maxOldSpaceMb: 1024 });
    const created = await apiJson(s1.endpoint, s1.token, 'POST', '/api/sessions', {
      title: 'SIGKILL Recovery Target',
      metadata: { cwd: crashWs },
    });
    const sid = created.json.data.id;

    for (let t = 1; t <= 3; t += 1) {
      const r = await submitAndWaitTurn({
        endpoint: s1.endpoint,
        token: s1.token,
        sessionId: sid,
        content: `[CHAOS_SCOPE:sigkill_${t}] Durable turn #${t} prior to SIGKILL.`,
        timeoutMs: 30_000,
      });
      if (r.ok) sigkillResult.committedTurnsBeforeCrash += 1;
    }

    const inFlight = apiJson(s1.endpoint, s1.token, 'POST', `/api/sessions/${encodeURIComponent(sid)}/prompts`, {
      prompt_id: 'sigkill_midflight',
      content: [{ type: 'text', text: '[CHAOS_SCOPE:sigkill_mid] [CHAOS:SLOW_DRIP] In-flight turn interrupted by SIGKILL.' }],
    }).catch(() => null);
    await sleep(25);
    const killOutcome = await s1.sigkill();
    await inFlight;
    sigkillResult.killedSignal = killOutcome.signal;
    s1 = null;

    const sessionsDir = path.join(crashHome, 'sessions');
    const wsDirs = fs.readdirSync(sessionsDir);
    let mainWirePath = null;
    for (const w of wsDirs) {
      const candidate = path.join(sessionsDir, w, sid, 'agents', 'main', 'wire.jsonl');
      if (fs.existsSync(candidate)) {
        mainWirePath = candidate;
        break;
      }
    }
    if (mainWirePath) {
      const partialTail = '{"type":"context.append_loop_event","event":{"type":"text","text":"truncated-mid-record-by-power-loss';
      fs.appendFileSync(mainWirePath, partialTail, 'utf8');
      sigkillResult.truncatedWireBytesInjected = Buffer.byteLength(partialTail);
    }

    s2 = await spawnManagedServer({ homeDir: crashHome, osHomeDir: crashOsHome, maxOldSpaceMb: 1024 });
    const k2 = createKlient({ endpoint: s2.endpoint, token: s2.token, WebSocket, timeoutMs: 30_000 });
    try {
      const page = await k2.session(sid).view.transcript.page({ agentId: 'main', pageSize: 20 });
      const items = page?.items ?? [];
      const turns = items.filter((it) => it.kind === 'turn');
      sigkillResult.committedTurnsAfterRestart = turns.length;
      sigkillResult.recoveredOnRestart = turns.length >= sigkillResult.committedTurnsBeforeCrash;
    } finally {
      await k2.close().catch(() => undefined);
    }

    const postTurn = await submitAndWaitTurn({
      endpoint: s2.endpoint,
      token: s2.token,
      sessionId: sid,
      content: '[CHAOS_SCOPE:sigkill_post] Verify recovered session accepts new prompts cleanly.',
      timeoutMs: 30_000,
    });
    sigkillResult.postRestartTurnSucceeded = postTurn.ok && postTurn.lastTurnReason === 'completed';
  } catch (err) {
    sigkillResult.error = String(err?.stack ?? err).slice(0, 600);
  } finally {
    if (s1) await s1.shutdown().catch(() => undefined);
    if (s2) await s2.shutdown().catch(() => undefined);
  }

  return {
    passed: enospcResult.agentBlobGracefulFallback && sigkillResult.recoveredOnRestart && sigkillResult.postRestartTurnSucceeded,
    enospc: enospcResult,
    sigkill: sigkillResult,
  };
}

async function runScenarioS4({ workRoot, twin, createKlient, progress }) {
  progress('S4: Multi-Space (Main + Isolated Child Space) + 8-digit claimPair + kiki-handshake-invited-v1 over loopback TLS...');
  const root = path.join(workRoot, 'multi-space-pairing');
  const mainHome = path.join(root, 'main-home');
  const mainOsHome = path.join(root, 'main-os-home');
  const childHome = path.join(root, 'child-space-home');
  const childOsHome = path.join(root, 'child-os-home');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(mainHome, { recursive: true });
  fs.writeFileSync(
    path.join(mainHome, 'config.toml'),
    buildChaosConfigToml({ anthropicBaseUrl: twin.httpBaseUrl, openaiBaseUrl: twin.httpV1BaseUrl, enableSearch: false }),
    'utf8',
  );

  const result = {
    passed: false,
    childSpaceCreated: false,
    childSpaceId: null,
    isolationVerified: false,
    pairCodeFormatValid: false,
    claimPairOverTlsSucceeded: false,
    tlsPinnedFingerprintMatched: false,
    invitedHandshakeProofVerified: false,
    approvedHandshakeProofVerified: false,
    error: null,
  };

  let mainSrv = null;
  let childSrv = null;
  let mainClient = null;
  let childClient = null;
  try {
    mainSrv = await spawnManagedServer({ homeDir: mainHome, osHomeDir: mainOsHome, maxOldSpaceMb: 1024 });

    const createSpaceRes = await apiJson(mainSrv.endpoint, mainSrv.token, 'POST', '/api/homes', {
      path: childHome,
      name: 'Chaos Isolated Child Space',
      inherit: { credentials: 'isolated' },
    });
    if (createSpaceRes.status !== 200 || createSpaceRes.json?.code !== 0) {
      throw new Error(`POST /api/homes failed: ${JSON.stringify(createSpaceRes)}`);
    }
    result.childSpaceCreated = true;
    result.childSpaceId = createSpaceRes.json.data.id;

    childSrv = await spawnManagedServer({ homeDir: childHome, osHomeDir: childOsHome, maxOldSpaceMb: 1024 });

    const childOnlyWs = path.join(root, 'child-ws');
    fs.mkdirSync(childOnlyWs, { recursive: true });
    const childSessionRes = await apiJson(childSrv.endpoint, childSrv.token, 'POST', '/api/sessions', {
      title: 'Child Space Private Session',
      metadata: { cwd: childOnlyWs },
    });
    const childSid = childSessionRes.json?.data?.id;
    const mainListRes = await apiJson(mainSrv.endpoint, mainSrv.token, 'GET', '/api/sessions?page_size=50');
    const mainSessionIds = (mainListRes.json?.data?.sessions ?? mainListRes.json?.data?.items ?? []).map((s) => s.id);
    result.isolationVerified = Boolean(childSid) && !mainSessionIds.includes(childSid);

    mainClient = createKlient({ endpoint: mainSrv.endpoint, token: mainSrv.token, timeoutMs: 20_000 });
    childClient = createKlient({ endpoint: childSrv.endpoint, token: childSrv.token, timeoutMs: 20_000 });

    const pairIssued = await childClient.rest.connections.createPairCode({ allowBridge: true });
    result.pairCodeFormatValid = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/u.test(pairIssued.code);

    const claimEndpoint = pairIssued.suggestedEndpoints?.[0] ?? childSrv.endpoint;
    const pairedRecord = await mainClient.rest.connections.pair({
      endpoint: claimEndpoint,
      code: pairIssued.code,
      fingerprint: pairIssued.tlsFingerprint,
      label: 'Paired Child Space',
      backgroundSummary: false,
      requestBridge: true,
    });
    result.claimPairOverTlsSucceeded = Boolean(pairedRecord?.id && pairedRecord.enabled);
    result.tlsPinnedFingerprintMatched =
      Boolean(pairIssued.tlsFingerprint) && pairedRecord.pinnedFingerprint === pairIssued.tlsFingerprint;

    const invitedSource = {
      homeId: '11111111-1111-4111-8111-111111111111',
      hostId: 'chaos-invited-peer',
      protocol: 1,
    };
    const inviteRes = await apiJson(childSrv.endpoint, childSrv.token, 'POST', '/api/remote-connections/inbound/invitations', {
      source: invitedSource,
      label: 'Invited Chaos Peer',
      expiresInMs: 120_000,
    });
    if (inviteRes.status !== 200 || inviteRes.json?.code !== 0) {
      throw new Error(`POST inbound/invitations failed: ${JSON.stringify(inviteRes)}`);
    }
    const { invitation, grant } = inviteRes.json.data;
    const inviteDigest = createHash('sha256').update(invitation).digest('hex');
    const nonce = randomBytes(16).toString('hex');
    const reqProof = createHmac('sha256', inviteDigest).update(`kiki-handshake-req-v1:${nonce}`).digest('hex');

    const hsRes = await fetch(`${childSrv.endpoint}/api/remote-connections/handshake`, {
      headers: {
        'x-kiki-handshake-grant': grant.id,
        'x-kiki-handshake-nonce': nonce,
        'x-kiki-handshake-proof': reqProof,
      },
    });
    const hsStatus = hsRes.headers.get('x-kiki-handshake-status');
    const hsProof = hsRes.headers.get('x-kiki-handshake-proof');
    const expectedInvitedProof = createHmac('sha256', inviteDigest)
      .update(`kiki-handshake-invited-v1:${nonce}:${childSrv.identity.homeId}:${childSrv.identity.hostId}`)
      .digest('hex');
    result.invitedHandshakeProofVerified = hsStatus === 'invited' && hsProof === expectedInvitedProof;

    const claimInvRes = await apiJson(childSrv.endpoint, childSrv.token, 'POST', '/api/remote-connections/claim', {
      invitation,
      source: invitedSource,
    });
    const claimedPeerToken = claimInvRes.json?.data?.grant ?? claimInvRes.json?.data?.peerToken;
    if (claimedPeerToken) {
      const peerDigest = createHash('sha256').update(claimedPeerToken).digest('hex');
      const nonce2 = randomBytes(16).toString('hex');
      const reqProof2 = createHmac('sha256', peerDigest).update(`kiki-handshake-req-v1:${nonce2}`).digest('hex');
      const hs2 = await fetch(`${childSrv.endpoint}/api/remote-connections/handshake`, {
        headers: {
          'x-kiki-handshake-grant': grant.id,
          'x-kiki-handshake-nonce': nonce2,
          'x-kiki-handshake-proof': reqProof2,
        },
      });
      const expectedApprovedProof = createHmac('sha256', peerDigest)
        .update(`kiki-handshake-res-v1:${nonce2}:${childSrv.identity.homeId}:${childSrv.identity.hostId}`)
        .digest('hex');
      result.approvedHandshakeProofVerified =
        hs2.headers.get('x-kiki-handshake-status') === 'approved' &&
        hs2.headers.get('x-kiki-handshake-proof') === expectedApprovedProof;
    }

    result.passed =
      result.childSpaceCreated &&
      result.isolationVerified &&
      result.pairCodeFormatValid &&
      result.claimPairOverTlsSucceeded &&
      result.tlsPinnedFingerprintMatched &&
      result.invitedHandshakeProofVerified &&
      result.approvedHandshakeProofVerified;
  } catch (err) {
    result.error = String(err?.stack ?? err).slice(0, 600);
  } finally {
    await mainClient?.close().catch(() => undefined);
    await childClient?.close().catch(() => undefined);
    if (childSrv) await childSrv.shutdown().catch(() => undefined);
    if (mainSrv) await mainSrv.shutdown().catch(() => undefined);
  }
  return result;
}

const GUI_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

async function runScenarioS5BrowserUx({ server, corpus, progress }) {
  progress('S5: Frontend Perceived-UX & CDP Renderer Memory Gate under live concurrent backend load...');
  const kapRequire = createRequire(path.join(REPO_ROOT, 'packages', 'kap-server', 'package.json'));
  const { chromium } = kapRequire('playwright');
  const { ensureGuiStaticBuild } = await import('../perf/browser-runner.mjs');

  const result = {
    passed: false,
    guiBuildMs: 0,
    coldOpenFirstTurnMs: null,
    stuckPreparingDetected: false,
    pageErrors: [],
    scrollLongTasks: null,
    subagentSwitchMs: null,
    subagentSwitchLongTasks: null,
    branchSwitchMs: null,
    composerTypingLatencyMs: null,
    cdpMemory: {},
    backgroundTurnsCompletedDuringBrowser: 0,
    error: null,
  };

  let staticServer = null;
  let browser = null;
  let stopBackgroundLoad = false;

  try {
    const build = ensureGuiStaticBuild(path.join(REPO_ROOT, '.tmp', 'chaos-gui-dist'));
    result.guiBuildMs = build.buildMs;

    staticServer = createHttpServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
      if (urlPath === '/__kiki/local-server') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      let file = path.normalize(path.join(build.distDir, urlPath));
      if (!file.startsWith(build.distDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(build.distDir, 'index.html');
      }
      const stream = fs.createReadStream(file);
      stream.once('open', () => {
        res.writeHead(200, { 'content-type': GUI_MIME[path.extname(file)] ?? 'application/octet-stream' });
        stream.pipe(res);
      });
      stream.once('error', () => {
        if (!res.headersSent) res.writeHead(404);
        res.end('not found');
      });
    });
    await new Promise((resolve) => staticServer.listen(0, '127.0.0.1', resolve));
    const webUrl = `http://127.0.0.1:${staticServer.address().port}`;
    const deepLink = (routePath) =>
      `${webUrl}${routePath}?server=${encodeURIComponent(server.endpoint)}&token=${encodeURIComponent(server.token)}`;

    const bgSessions = [];
    for (let i = 0; i < 6; i += 1) {
      const c = await apiJson(server.endpoint, server.token, 'POST', '/api/sessions', {
        title: `S5 BG Load #${i + 1}`,
        metadata: { cwd: corpus.workspaceDir },
      });
      if (c.json?.data?.id) bgSessions.push(c.json.data.id);
    }

    const bgWorker = (async () => {
      let round = 0;
      while (!stopBackgroundLoad && round < 10) {
        round += 1;
        await Promise.all(
          bgSessions.map(async (sid, idx) => {
            if (stopBackgroundLoad) return;
            const r = await submitAndWaitTurn({
              endpoint: server.endpoint,
              token: server.token,
              sessionId: sid,
              content: `[CHAOS_SCOPE:s5_bg_${round}_${idx}] [TOOLS:WORKSPACE] Background load during browser UX test.`,
              timeoutMs: 30_000,
            });
            if (r.ok) result.backgroundTurnsCompletedDuringBrowser += 1;
          }),
        );
        await sleep(80);
      }
    })();

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      try {
        localStorage.setItem('kiki.locale', 'en');
        localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
      } catch {}
      const state = { longTasks: [], rafGaps: [] };
      window.__chaosUxProbe = {
        reset() {
          state.longTasks = [];
          state.rafGaps = [];
        },
        drain() {
          const durations = state.longTasks.map((t) => t.duration);
          const out = {
            longTaskCount: durations.length,
            maxLongTaskMs: durations.length ? Number(Math.max(...durations).toFixed(2)) : 0,
            totalBlockingTimeMs: Number(durations.reduce((a, d) => a + Math.max(0, d - 50), 0).toFixed(2)),
            maxRafGapMs: state.rafGaps.length ? Number(Math.max(...state.rafGaps).toFixed(2)) : 0,
          };
          state.longTasks = [];
          state.rafGaps = [];
          return out;
        },
      };
      try {
        const obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) state.longTasks.push({ duration: e.duration });
        });
        obs.observe({ type: 'longtask', buffered: true });
      } catch {}
      let prev = performance.now();
      const tick = (now) => {
        const gap = now - prev;
        prev = now;
        if (gap > 32) state.rafGaps.push(gap);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const page = await context.newPage();
    page.on('pageerror', (err) => result.pageErrors.push(String(err?.message ?? err).slice(0, 300)));

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const readCdpMetrics = async () => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      const map = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
      return {
        jsHeapUsedMiB: roundMiB(map.JSHeapUsedSize ?? 0),
        jsHeapTotalMiB: roundMiB(map.JSHeapTotalSize ?? 0),
        nodes: map.Nodes ?? 0,
        jsEventListeners: map.JSEventListeners ?? 0,
      };
    };

    result.cdpMemory.beforeOpen = await readCdpMetrics();

    const openT0 = performance.now();
    await page.goto(deepLink(`/s/${corpus.giantSessionId}`), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: 30_000 });
    result.coldOpenFirstTurnMs = roundMs(performance.now() - openT0);
    result.coldOpenLongTasks = await page.evaluate(() => window.__chaosUxProbe?.drain?.() ?? null);

    await sleep(600);
    const bodyText = await page.evaluate(() => document.body.innerText ?? '');
    result.stuckPreparingDetected = /History is preparing/iu.test(bodyText);
    result.cdpMemory.afterGiantOpen = await readCdpMetrics();

    await page.evaluate(() => window.__chaosUxProbe?.reset?.());
    await page.evaluate(async () => {
      const scroller = document.querySelector('[data-transcript-scroll]');
      if (!scroller) return;
      for (const ratio of [0.7, 0.4, 0.15, 0.0, 0.85, 1.0]) {
        scroller.scrollTop = Math.floor(scroller.scrollHeight * ratio);
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 90));
      }
      await new Promise((r) => setTimeout(r, 200));
    });
    result.scrollLongTasks = await page.evaluate(() => window.__chaosUxProbe?.drain?.() ?? null);

    await page.evaluate(() => window.__chaosUxProbe?.reset?.());
    const sw1T0 = performance.now();
    await page.evaluate(
      ({ sid, aid }) => {
        const search = window.location.search;
        window.history.pushState({}, '', `/s/${sid}/agent/${encodeURIComponent(aid)}${search}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
      { sid: corpus.giantSessionId, aid: corpus.heavySubagentId },
    );
    await page.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: 20_000 });
    result.subagentSwitchMs = roundMs(performance.now() - sw1T0);
    result.subagentSwitchLongTasks = await page.evaluate(() => window.__chaosUxProbe?.drain?.() ?? null);

    const branchId = `subagent_${String(corpus.subagentCount).padStart(4, '0')}`;
    const sw2T0 = performance.now();
    await page.evaluate(
      ({ sid, aid }) => {
        const search = window.location.search;
        window.history.pushState({}, '', `/s/${sid}/agent/${encodeURIComponent(aid)}${search}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
      { sid: corpus.giantSessionId, aid: branchId },
    );
    await sleep(300);
    result.branchSwitchMs = roundMs(performance.now() - sw2T0);

    await page.evaluate(
      ({ sid }) => {
        const search = window.location.search;
        window.history.pushState({}, '', `/s/${sid}${search}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
      { sid: corpus.giantSessionId },
    );
    await sleep(250);
    result.cdpMemory.afterSwitches = await readCdpMetrics();

    const composerSelector = 'textarea[data-composer-input], textarea[placeholder], [contenteditable="true"]';
    const composer = await page.waitForSelector(composerSelector, { timeout: 10_000 }).catch(() => null);
    if (composer) {
      await composer.click();
      const keyLatencies = [];
      const text = 'Check composer latency';
      for (const ch of text) {
        const kt0 = performance.now();
        await page.keyboard.type(ch, { delay: 0 });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
        keyLatencies.push(roundMs(performance.now() - kt0));
      }
      result.composerTypingLatencyMs = summarize(keyLatencies);
    }

    await page.goto(deepLink('/s/chaos_bg_0001'), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(500);
    await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
    await sleep(200);
    result.cdpMemory.afterSwitchAwayLightSession = await readCdpMetrics();

    stopBackgroundLoad = true;
    await bgWorker;

    result.passed =
      result.pageErrors.length === 0 &&
      !result.stuckPreparingDetected &&
      result.coldOpenFirstTurnMs !== null &&
      result.coldOpenFirstTurnMs < 2000 &&
      (result.composerTypingLatencyMs === null || result.composerTypingLatencyMs.p95 < 50);
  } catch (err) {
    stopBackgroundLoad = true;
    result.error = String(err?.stack ?? err).slice(0, 600);
  } finally {
    await browser?.close().catch(() => undefined);
    if (staticServer) await new Promise((resolve) => staticServer.close(() => resolve()));
  }

  return result;
}

export async function runChaosScaleSuite(options = {}) {
  const startedAt = performance.now();
  const dir = path.resolve(options.dir ?? '/tmp/kiki-chaos-nvme');
  const tier = options.tier === 'smoke' ? 'smoke' : 'full';
  const s9TierConfig = resolveS9TierConfig(tier);
  const giantGiB = options.giantGiB ?? (tier === 'smoke' ? s9TierConfig.giantGiB : 3.1);
  const subagentCount = options.subagentCount ?? (tier === 'smoke' ? 80 : 1520);
  const concurrency = options.concurrency ?? (tier === 'smoke' ? 16 : 128);
  const extremeConcurrency = options.extremeConcurrency ?? (tier === 'smoke' ? 0 : 1000);
  const maxOldSpaceMb = options.maxOldSpaceMb ?? 2048;
  const existingCorpus = Boolean(options.existingCorpus);
  const runBrowser = options.runBrowser !== false;
  const s6Only = Boolean(options.s6Only);
  const s7Only = Boolean(options.s7Only);
  const s8Only = Boolean(options.s8Only);
  const s9Only = Boolean(options.s9Only);
  const s10Only = Boolean(options.s10Only);
  const p01Only = Boolean(options.p01Only);
  const s11Only = Boolean(options.s11Only);
  const s12Only = Boolean(options.s12Only);
  const s13Only = Boolean(options.s13Only);
  const s14Only = Boolean(options.s14Only);
  const v23Smoke = Boolean(options.v23Smoke);
  const v23Full = Boolean(options.v23Full);
  const effectiveTier = v23Full ? 'full' : v23Smoke ? 'smoke' : tier;
  const runS7S8 = Boolean(options.runS7S8);
  const runAll = Boolean(options.runAll);
  const isolatedOnly =
    s6Only || s7Only || s8Only || s9Only || s10Only || p01Only || s11Only || s12Only || s13Only || s14Only || v23Smoke || v23Full || runS7S8;
  const runS6 = s6Only || runAll || Boolean(options.runS6);
  const runS7 = s7Only || runS7S8 || runAll || Boolean(options.runS7);
  const runS8 = s8Only || runS7S8 || runAll || Boolean(options.runS8);
  const runS9 = s9Only || runAll || Boolean(options.runS9);
  const runS10 = s10Only || v23Smoke || v23Full || runAll || Boolean(options.runS10);
  const runP01 = p01Only || v23Smoke || v23Full || runAll || Boolean(options.runP01);
  const runS11 = s11Only || v23Smoke || v23Full || runAll || Boolean(options.runS11);
  const runS12 = s12Only || v23Smoke || v23Full || runAll || Boolean(options.runS12);
  const runS13 = s13Only || v23Smoke || v23Full || runAll || Boolean(options.runS13);
  const runS14 = s14Only || v23Smoke || v23Full || runAll || Boolean(options.runS14);
  const runId = options.runId ?? `chaos_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const s7Cycles = options.s7Cycles ?? 200;
  const tenKSubagentCount = options.tenKSubagentCount ?? (tier === 'smoke' ? s9TierConfig.subagentCount : 10_000);
  const s6StepTimeoutMs = options.s6StepTimeoutMs ?? 45_000;
  const progress = (msg) => process.stderr.write(`[ccp-chaos] ${msg}\n`);

  const { createKlient } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/klient/src/transports/http/index.ts')).href
  );
  const kapRequire = createRequire(path.join(REPO_ROOT, 'packages', 'kap-server', 'package.json'));
  const { WebSocket } = kapRequire('ws');

  const twin = await createContractTwinServer({ mode: 'clean', seed: 20261120, enableTls: true });
  progress(`Contract Twin live: HTTP/1.1=${twin.httpBaseUrl}, HTTP/2 TLS=${twin.h2BaseUrl}`);

  const corpus = existingCorpus && fs.existsSync(path.join(dir, 'home', 'workspaces.json'))
    ? retargetRestoredCorpus({
        dir,
        anthropicBaseUrl: twin.httpBaseUrl,
        openaiBaseUrl: twin.httpV1BaseUrl,
        enableSearch: true,
      })
    : generateChaosCorpus({
        dir,
        giantGiB,
        subagentCount,
        heavySubagentMiB: options.heavySubagentMiB ?? (tier === 'smoke' ? 1 : 16),
        backgroundSessionCount: options.backgroundSessionCount ?? (tier === 'smoke' ? 12 : 80),
        anthropicBaseUrl: twin.httpBaseUrl,
        openaiBaseUrl: twin.httpV1BaseUrl,
        enableSearch: true,
      });
  twin.setWorkspaceDir(corpus.workspaceDir);
  progress(
    `Corpus ready (${corpus.restoredFromArchive ? 'RESTORED from Drive DIRECT_HTTPS' : `generated in ${corpus.elapsedMs}ms`}): giant=${corpus.giantMainWireGiB} GiB, subagents=${corpus.subagentCount}, bg=${corpus.backgroundSessionCount}`,
  );

  let tenKCorpus = null;
  if (runS6 || runS9) {
    const existing10kState = path.join(corpus.homeDir, 'sessions', corpus.workspaceId, 'chaos_10k_subagents', 'state.json');
    let canReuse10k = false;
    let existingTotalSubs = 0;
    let existingStateBytes = 0;
    if (options.reuse10kSession && fs.existsSync(existing10kState)) {
      existingStateBytes = fs.statSync(existing10kState).size;
      const stateObj = JSON.parse(fs.readFileSync(existing10kState, 'utf8'));
      existingTotalSubs = Math.max(0, Object.keys(stateObj.agents ?? {}).length - 1);
      if (existingTotalSubs >= tenKSubagentCount) {
        canReuse10k = true;
      } else {
        progress(
          `Cached 10k-subagent corpus has only ${existingTotalSubs} subagents < requested ${tenKSubagentCount}; rebuilding cleanly...`,
        );
      }
    }
    if (canReuse10k) {
      tenKCorpus = {
        rootDir: corpus.rootDir,
        homeDir: corpus.homeDir,
        workspaceDir: corpus.workspaceDir,
        workspaceId: corpus.workspaceId,
        sessionId: 'chaos_10k_subagents',
        lightSessionId: 'chaos_bg_0001',
        subagentCount: existingTotalSubs,
        coldHistoricalNeedleIds: ['subagent_00042', `subagent_${String(Math.max(2, Math.floor(existingTotalSubs / 2))).padStart(5, '0')}`],
        familyPopoverTargetId: 'subagent_00001',
        deepestInspectTargetId: `subagent_${String(existingTotalSubs).padStart(5, '0')}`,
        stateJsonPath: existing10kState,
        stateJsonBytes: existingStateBytes,
        stateJsonMiB: Number((existingStateBytes / (1024 * 1024)).toFixed(2)),
        exceeds16MiBColdMetaCap: existingStateBytes > 16 * 1024 * 1024,
        reusedExisting: true,
      };
      progress(`Reused existing 10k-subagent corpus: session=${tenKCorpus.sessionId}, subagents=${tenKCorpus.subagentCount}, state.json=${tenKCorpus.stateJsonMiB} MiB`);
    } else {
      tenKCorpus = clone10kSubagents({
        dir,
        sourceSessionId: corpus.giantSessionId,
        targetSessionId: 'chaos_10k_subagents',
        subagentCount: tenKSubagentCount,
      });
      progress(
        `Cloned 10k-subagent corpus in ${tenKCorpus.elapsedMs}ms: subagents=${tenKCorpus.subagentCount}, state.json=${tenKCorpus.stateJsonMiB} MiB (exceeds16MiB=${tenKCorpus.exceeds16MiBColdMetaCap}), links=${JSON.stringify(tenKCorpus.wireLinkStats)}`,
      );
    }
  }

  let mediaCorpus = null;
  if (runS7 || runS8) {
    mediaCorpus = generateExtremeMediaSession({
      dir,
      sessionId: 'chaos_extreme_media',
      imageCount: options.s8ImageCount ?? 600,
      giantImageCount: options.s8GiantImageCount ?? 8,
      videoCount: options.s8VideoCount ?? 40,
      audioCount: options.s8AudioCount ?? 30,
    });
    progress(
      `Extreme media corpus ready in ${mediaCorpus.elapsedMs}ms: session=${mediaCorpus.sessionId}, imgs=${mediaCorpus.imageCount} (${mediaCorpus.giantImageCount} giant @ ${mediaCorpus.giantPngMiB} MiB), AV=${mediaCorpus.totalPlaybackAssets} (${mediaCorpus.videoCount} MP4 + ${mediaCorpus.audioCount} WAV)`,
    );
  }

  let s9Corpus = null;
  if (runS9) {
    s9Corpus = seedS9ChaosExtensions({
      dir,
      corpus,
      tierConfig: s9TierConfig,
    });
    progress(
      `S9 full-stack corpus extensions ready in ${s9Corpus.elapsedMs}ms (tier=${s9TierConfig.tier}): sessions=${s9Corpus.seededSessionCount}, personas=${s9Corpus.personaIds.length}, media=${s9Corpus.mediaSessionId} (ogg=${s9Corpus.oggBytes}B, mp4=${s9Corpus.mp4Bytes}B)`,
    );
  }

  const osHomeDir = path.join(dir, 'os-home');
  let mainServer = null;
  let sharedBrowserHandle = null;
  const report = {
    runId,
    buildId: options.buildId ?? 'local',
    mode: v23Full || v23Smoke ? 'v23' : 'standard',
    tier: v23Full ? 'v23-full' : v23Smoke ? 'v23-smoke' : effectiveTier,
    skipped: 0,
    timestamp: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpus: os.cpus().length,
      totalMemGiB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
      maxOldSpaceMb,
      corpusDir: dir,
    },
    corpus,
    tenKCorpus,
    mediaCorpus: mediaCorpus
      ? {
          sessionId: mediaCorpus.sessionId,
          anchorSessionId: mediaCorpus.anchorSessionId,
          imageCount: mediaCorpus.imageCount,
          giantImageCount: mediaCorpus.giantImageCount,
          giantPngMiB: mediaCorpus.giantPngMiB,
          videoCount: mediaCorpus.videoCount,
          audioCount: mediaCorpus.audioCount,
          totalPlaybackAssets: mediaCorpus.totalPlaybackAssets,
          elapsedMs: mediaCorpus.elapsedMs,
        }
      : null,
    scenarios: {},
    overallPassed: false,
    totalWallMs: 0,
  };

  const persistCheckpoint = () => {
    if (!options.outPath) return;
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    report.totalWallMs = roundMs(performance.now() - startedAt);
    fs.writeFileSync(options.outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  };

  try {
    mainServer = await spawnManagedServer({ homeDir: corpus.homeDir, osHomeDir, maxOldSpaceMb });
    progress(`Booted Kiki kap-server pid=${mainServer.pid} in ${mainServer.bootMs}ms (rss=${mainServer.initialMetrics.rssMiB} MiB)`);
    report.serverBootMs = mainServer.bootMs;
    report.initialServerMetrics = mainServer.initialMetrics;
    persistCheckpoint();

    if (!isolatedOnly) {
      report.scenarios.S1_giantColdSession = await runScenarioS1({
        server: mainServer,
        twin,
        corpus,
        createKlient,
        WebSocket,
        progress,
      });
      await mainServer.closeSession(corpus.giantSessionId).catch(() => undefined);
      persistCheckpoint();

      report.scenarios.S2a_concurrencyChaosStorm128 = await runScenarioS2a({
        server: mainServer,
        twin,
        workspaceDir: corpus.workspaceDir,
        concurrency,
        createKlient,
        WebSocket,
        progress,
      });
      persistCheckpoint();

      if (runBrowser) {
        report.scenarios.S5_frontendBrowserUx = await runScenarioS5BrowserUx({
          server: mainServer,
          corpus,
          progress,
        });
        persistCheckpoint();
      }

      report.scenarios.S3_enospcAndSigkill = await runScenarioS3({
        workRoot: dir,
        twin,
        createKlient,
        WebSocket,
        progress,
      });
      persistCheckpoint();

      report.scenarios.S4_multiSpaceAndPairing = await runScenarioS4({
        workRoot: dir,
        twin,
        createKlient,
        progress,
      });
      persistCheckpoint();

      if (extremeConcurrency > 0) {
        try {
          report.scenarios.S2b_extremeBreakingPoint1000 = await runScenarioS2bExtreme1000({
            server: mainServer,
            twin,
            workspaceDir: corpus.workspaceDir,
            extremeConcurrency,
            progress,
          });
        } catch (err) {
          report.scenarios.S2b_extremeBreakingPoint1000 = {
            diagnosticOnly: true,
            targetConcurrency: extremeConcurrency,
            error: String(err?.stack ?? err).slice(0, 800),
            serverExitInfo: mainServer?.getExitInfo?.() ?? null,
            serverStderrTail: mainServer?.stderrLines?.slice(-10) ?? [],
          };
        }
        persistCheckpoint();
      }
    }

    if (runS6 && tenKCorpus) {
      report.scenarios.S6_tenKSubagentsScale = await runScenarioS6TenKSubagents({
        server: mainServer,
        twin,
        target: tenKCorpus,
        createKlient,
        WebSocket,
        runBrowser,
        stepTimeoutMs: s6StepTimeoutMs,
        progress,
      });
      persistCheckpoint();
    }

    if (runS7 && mediaCorpus && runBrowser) {
      report.scenarios.S7_longRunningSoak = await runScenarioS7LongRunningSoak({
        server: mainServer,
        corpus,
        mediaCorpus,
        tenKCorpus,
        totalCycles: s7Cycles,
        progress,
      });
      persistCheckpoint();
    }

    if (runS8 && mediaCorpus && runBrowser) {
      report.scenarios.S8_extremeMediaWeakNet = await runScenarioS8MediaWeakNetStorm({
        server: mainServer,
        mediaCorpus,
        stepTimeoutMs: s6StepTimeoutMs,
        progress,
      });
      persistCheckpoint();
    }

    if (runS9 && s9Corpus && runBrowser) {
      // HIGH #3: Evict and reboot kap-server before S9 Drill 1 if earlier scenarios ran (e.g. S5 warmed chaos_giant_3g)
      if (!isolatedOnly || runS6 || runS7 || runS8) {
        progress('S9 Coldness Guard: restarting kap-server so chaos_giant_3g starts genuinely COLD for S9 Drill 1...');
        await mainServer.closeSession(corpus.giantSessionId).catch(() => undefined);
        await mainServer.shutdown().catch(() => undefined);
        mainServer = await spawnManagedServer({ homeDir: corpus.homeDir, osHomeDir, maxOldSpaceMb });
      }
      report.scenarios.S9_fullstackBrowserFlightRecorder = await runScenarioS9BrowserFlightRecorder({
        server: mainServer,
        corpus,
        tenKCorpus,
        s9Corpus,
        tier,
        progress,
      });
      persistCheckpoint();
    }

    let s10ReopenCandidate = null;
    let s10ReopenCandidates = [];
    const trackedWorkloadPids = new Set();
    let t0LastTerminalReceiptAt = Date.now();
    if (runS10) {
      const s10Res = await runScenarioS10LiveStorm({
        server: mainServer,
        twin,
        corpus,
        WebSocket,
        tier: effectiveTier,
        runBrowser,
        keepBrowserAlive: runBrowser && (runP01 || runS14),
        progress,
      });
      s10ReopenCandidate = s10Res.reopenCandidate ?? null;
      s10ReopenCandidates = Array.isArray(s10Res.reopenCandidates)
        ? s10Res.reopenCandidates
        : s10ReopenCandidate
          ? [s10ReopenCandidate]
          : [];
      sharedBrowserHandle = s10Res.browserHandle ?? null;
      const { browserHandle: _bh, ...s10Serializable } = s10Res;
      report.scenarios.S10_liveOrchestratorStorm = s10Serializable;
      report.scenarios.s10 = s10Serializable;
      t0LastTerminalReceiptAt = Date.now();
      persistCheckpoint();
    }

    if (runP01) {
      if (runS10) {
        if (s10ReopenCandidate?.sessionId) {
          await mainServer.closeSession(s10ReopenCandidate.sessionId).catch(() => undefined);
        }
        await mainServer.gc().catch(() => undefined);
        await sleep(500);
      }
      const p01Res = await runP01ColdChildFanoutProbe({
        server: mainServer,
        corpus,
        WebSocket,
        tier: effectiveTier,
        targetBytes: options.p01Bytes ?? null,
        stepCount: options.p01Steps ?? 200,
        reopenSession: s10ReopenCandidates.length > 0 ? s10ReopenCandidates : s10ReopenCandidate,
        browserHandle: sharedBrowserHandle,
        progress,
      });
      report.scenarios.P01_coldChildOpen = p01Res;
      report.scenarios.p01 = p01Res;
      t0LastTerminalReceiptAt = Date.now();
      persistCheckpoint();
    }

    if (runS11) {
      const s11Res = await runScenarioS11Mesh256({
        server: mainServer,
        respawnServer: async () => {
          mainServer = await spawnManagedServer({ homeDir: corpus.homeDir, osHomeDir, maxOldSpaceMb });
          return mainServer;
        },
        corpus,
        tier: effectiveTier,
        meshSessions: options.meshSessions,
        progress,
      });
      if (s11Res.activeServer) mainServer = s11Res.activeServer;
      if (sharedBrowserHandle?.reconnectToServer) {
        await sharedBrowserHandle.reconnectToServer(mainServer, s10ReopenCandidate?.sessionId ?? null).catch(() => undefined);
      }
      const { activeServer: _srv, ...s11Serializable } = s11Res;
      report.scenarios.S11_mesh256 = s11Serializable;
      report.scenarios.s11 = s11Serializable;
      t0LastTerminalReceiptAt = Date.now();
      persistCheckpoint();
    }

    if (runS12) {
      const s12Res = await runScenarioS12BlindHmacTrials({
        server: mainServer,
        corpus,
        workRoot: dir,
        progress,
      });
      report.scenarios.S12_blindHmacControl = s12Res;
      report.scenarios.s12 = s12Res;
      t0LastTerminalReceiptAt = Date.now();
      persistCheckpoint();
    }

    if (runS13) {
      const s13Res = await runScenarioS13ChaosFaults({
        server: mainServer,
        corpus,
        WebSocket,
        workRoot: dir,
        progress,
      });
      for (const pid of s13Res.spawnedPids ?? []) {
        if (Number.isInteger(pid) && pid > 0) trackedWorkloadPids.add(pid);
      }
      report.scenarios.S13_chaosFaults = s13Res;
      report.scenarios.s13 = s13Res;
      t0LastTerminalReceiptAt = Date.now();
      persistCheckpoint();
    }

    if (runS14) {
      const s14Res = await runScenarioS14IdleCpu({
        serverPid: mainServer.pid,
        browserHandle: sharedBrowserHandle,
        trackedWorkloadPids: [...trackedWorkloadPids],
        t0LastTerminalReceiptAt,
        tier: effectiveTier,
        settleSec: options.idleSettleSec,
        windowCount: options.idleWindows,
        windowSec: options.idleWindowSec,
        progress,
      });
      report.scenarios.S14_idleCpu = s14Res;
      report.scenarios.s14 = s14Res;
      persistCheckpoint();
    }

    if (sharedBrowserHandle) {
      await sharedBrowserHandle.close().catch(() => undefined);
      sharedBrowserHandle = null;
    }

    await mainServer.shutdown().catch(() => undefined);
    mainServer = null;

    const exitCodes = [];
    const recordCheck = (res) => {
      if (!res) {
        exitCodes.push(2);
        return false;
      }
      if (typeof res.exitCode === 'number') exitCodes.push(res.exitCode);
      else exitCodes.push(res.passed ? 0 : 1);
      return Boolean(res.passed);
    };

    if (isolatedOnly) {
      const checks = [];
      if (runS6) checks.push(recordCheck(report.scenarios.S6_tenKSubagentsScale));
      if (runS7) checks.push(recordCheck(report.scenarios.S7_longRunningSoak));
      if (runS8) checks.push(recordCheck(report.scenarios.S8_extremeMediaWeakNet));
      if (runS9) checks.push(recordCheck(report.scenarios.S9_fullstackBrowserFlightRecorder));
      if (runS10) checks.push(recordCheck(report.scenarios.S10_liveOrchestratorStorm));
      if (runP01) checks.push(recordCheck(report.scenarios.P01_coldChildOpen));
      if (runS11) checks.push(recordCheck(report.scenarios.S11_mesh256));
      if (runS12) checks.push(recordCheck(report.scenarios.S12_blindHmacControl));
      if (runS13) checks.push(recordCheck(report.scenarios.S13_chaosFaults));
      if (runS14) checks.push(recordCheck(report.scenarios.S14_idleCpu));
      report.overallPassed = checks.length > 0 && checks.every(Boolean);
    } else {
      const checks = [
        recordCheck(report.scenarios.S1_giantColdSession),
        recordCheck(report.scenarios.S2a_concurrencyChaosStorm128),
        recordCheck(report.scenarios.S3_enospcAndSigkill),
        recordCheck(report.scenarios.S4_multiSpaceAndPairing),
      ];
      if (runBrowser) checks.push(recordCheck(report.scenarios.S5_frontendBrowserUx));
      if (runS6) checks.push(recordCheck(report.scenarios.S6_tenKSubagentsScale));
      if (runS7) checks.push(recordCheck(report.scenarios.S7_longRunningSoak));
      if (runS8) checks.push(recordCheck(report.scenarios.S8_extremeMediaWeakNet));
      if (runS9) checks.push(recordCheck(report.scenarios.S9_fullstackBrowserFlightRecorder));
      if (runS10) checks.push(recordCheck(report.scenarios.S10_liveOrchestratorStorm));
      if (runP01) checks.push(recordCheck(report.scenarios.P01_coldChildOpen));
      if (runS11) checks.push(recordCheck(report.scenarios.S11_mesh256));
      if (runS12) checks.push(recordCheck(report.scenarios.S12_blindHmacControl));
      if (runS13) checks.push(recordCheck(report.scenarios.S13_chaosFaults));
      if (runS14) checks.push(recordCheck(report.scenarios.S14_idleCpu));
      report.overallPassed = checks.every(Boolean);
    }
    report.exitCode = report.overallPassed ? 0 : exitCodes.includes(2) ? 2 : 1;
  } finally {
    if (sharedBrowserHandle) await sharedBrowserHandle.close().catch(() => undefined);
    if (mainServer) await mainServer.shutdown().catch(() => undefined);
    await twin.close().catch(() => undefined);
  }

  report.totalWallMs = roundMs(performance.now() - startedAt);
  if (options.outPath) {
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}

if (isCliMain && !isServerWorker) {
  const args = process.argv.slice(2);
  const opts = {
    dir: '/tmp/kiki-chaos-nvme',
    tier: 'full',
    giantGiB: undefined,
    subagentCount: undefined,
    concurrency: undefined,
    extremeConcurrency: undefined,
    maxOldSpaceMb: 2048,
    existingCorpus: false,
    runBrowser: true,
    s6Only: false,
    s7Only: false,
    s8Only: false,
    s9Only: false,
    s10Only: false,
    p01Only: false,
    s11Only: false,
    s12Only: false,
    s13Only: false,
    s14Only: false,
    v23Smoke: false,
    v23Full: false,
    p01Bytes: undefined,
    meshSessions: undefined,
    idleSettleSec: undefined,
    idleWindows: undefined,
    idleWindowSec: undefined,
    runS7S8: false,
    runAll: false,
    runS6: false,
    runS7: false,
    runS8: false,
    runS9: false,
    runS10: false,
    runP01: false,
    runS11: false,
    runS12: false,
    runS13: false,
    runS14: false,
    runId: undefined,
    buildId: undefined,
    s7Cycles: 200,
    reuse10kSession: false,
    tenKSubagentCount: undefined,
    s6StepTimeoutMs: 45_000,
    outPath: '/tmp/kiki-chaos-results.json',
  };
  let explicitOut = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dir' && args[i + 1]) opts.dir = args[++i];
    else if (args[i] === '--tier' && args[i + 1]) opts.tier = args[++i];
    else if (args[i] === '--giant-gib' && args[i + 1]) opts.giantGiB = Number(args[++i]);
    else if (args[i] === '--subagents' && args[i + 1]) opts.subagentCount = Number(args[++i]);
    else if (args[i] === '--concurrency' && args[i + 1]) opts.concurrency = Number(args[++i]);
    else if (args[i] === '--extreme-concurrency' && args[i + 1]) opts.extremeConcurrency = Number(args[++i]);
    else if (args[i] === '--max-old-space-mb' && args[i + 1]) opts.maxOldSpaceMb = Number(args[++i]);
    else if (args[i] === '--existing-corpus') opts.existingCorpus = true;
    else if (args[i] === '--no-browser') opts.runBrowser = false;
    else if (args[i] === '--s6-only') opts.s6Only = true;
    else if (args[i] === '--s7-only') opts.s7Only = true;
    else if (args[i] === '--s8-only') opts.s8Only = true;
    else if (args[i] === '--s9-only') opts.s9Only = true;
    else if (args[i] === '--s10-only') opts.s10Only = true;
    else if (args[i] === '--p01-only') opts.p01Only = true;
    else if (args[i] === '--s11-only') opts.s11Only = true;
    else if (args[i] === '--s12-only') opts.s12Only = true;
    else if (args[i] === '--s13-only') opts.s13Only = true;
    else if (args[i] === '--s14-only') opts.s14Only = true;
    else if (args[i] === '--v23-smoke') opts.v23Smoke = true;
    else if (args[i] === '--v23-full') { opts.v23Full = true; opts.tier = 'full'; }
    else if (args[i] === '--p01-bytes' && args[i + 1]) opts.p01Bytes = Number(args[++i]);
    else if (args[i] === '--mesh-sessions' && args[i + 1]) opts.meshSessions = Number(args[++i]);
    else if (args[i] === '--idle-settle-sec' && args[i + 1]) opts.idleSettleSec = Number(args[++i]);
    else if (args[i] === '--idle-windows' && args[i + 1]) opts.idleWindows = Number(args[++i]);
    else if (args[i] === '--idle-window-sec' && args[i + 1]) opts.idleWindowSec = Number(args[++i]);
    else if (args[i] === '--run-s7-s8') opts.runS7S8 = true;
    else if (args[i] === '--run-all') opts.runAll = true;
    else if (args[i] === '--run-s6') opts.runS6 = true;
    else if (args[i] === '--run-s7') opts.runS7 = true;
    else if (args[i] === '--run-s8') opts.runS8 = true;
    else if (args[i] === '--run-s9') opts.runS9 = true;
    else if (args[i] === '--run-s10') opts.runS10 = true;
    else if (args[i] === '--run-p01') opts.runP01 = true;
    else if (args[i] === '--run-s11') opts.runS11 = true;
    else if (args[i] === '--run-s12') opts.runS12 = true;
    else if (args[i] === '--run-s13') opts.runS13 = true;
    else if (args[i] === '--run-s14') opts.runS14 = true;
    else if (args[i] === '--manifest' && args[i + 1]) {
      const m = JSON.parse(fs.readFileSync(args[++i], 'utf8'));
      if (m.tier) opts.tier = m.tier;
      if (typeof m.p01Bytes === 'number') opts.p01Bytes = m.p01Bytes;
      if (typeof m.meshSessions === 'number') opts.meshSessions = m.meshSessions;
      if (Array.isArray(m.scenarios)) {
        for (const sc of m.scenarios) {
          if (sc === 's10') opts.runS10 = true;
          else if (sc === 'p01') opts.runP01 = true;
          else if (sc === 's11') opts.runS11 = true;
          else if (sc === 's12') opts.runS12 = true;
          else if (sc === 's13') opts.runS13 = true;
          else if (sc === 's14') opts.runS14 = true;
        }
        opts.v23Smoke = true;
      }
    }
    else if (args[i] === '--run-id' && args[i + 1]) opts.runId = args[++i];
    else if (args[i] === '--build-id' && args[i + 1]) opts.buildId = args[++i];
    else if (args[i] === '--s7-cycles' && args[i + 1]) opts.s7Cycles = Number(args[++i]);
    else if (args[i] === '--reuse-10k-session') opts.reuse10kSession = true;
    else if (args[i] === '--tenk-subagents' && args[i + 1]) opts.tenKSubagentCount = Number(args[++i]);
    else if (args[i] === '--s6-step-timeout-ms' && args[i + 1]) opts.s6StepTimeoutMs = Number(args[++i]);
    else if (args[i] === '--out' && args[i + 1]) { opts.outPath = args[++i]; explicitOut = true; }
  }
  const report = await runChaosScaleSuite(opts);
  if (explicitOut) {
    process.stdout.write(
      `${JSON.stringify({
        runId: report.runId,
        buildId: report.buildId,
        overallPassed: report.overallPassed,
        exitCode: report.exitCode,
        outPath: opts.outPath,
      })}\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  if (!report.overallPassed) {
    process.exitCode = report.exitCode || 1;
  }
}
