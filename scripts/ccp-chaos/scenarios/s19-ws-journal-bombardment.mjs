import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import inspector from 'node:inspector';
import module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const MiB = 1024 * 1024;
const KiB = 1024;

const BUDGETS = Object.freeze({
  maxSingleAllocBytes: 8 * MiB,
  maxLineBytes: 256 * KiB,
  maxBatchWriteBytes: 256 * KiB,
  maxLiveFileBytes: Math.round(8.5 * MiB),
  maxClosedFileBytes: Math.round(4.5 * MiB),
  maxTailBytes: 8 * MiB,
  maxRetainedPerSessionBytes: 16 * MiB,
  maxPostGcRssDeltaBytes: 64 * MiB,
  maxWriteAmplification: 2.5,
});

function roundNum(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function roundMiB(bytes) {
  return roundNum(bytes / MiB, 3);
}

class InMemoryWsSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sentFrames = [];
  terminateCalls = 0;
  closeCalls = 0;

  send(data, _opts, cb) {
    if (typeof data === 'string') {
      try {
        this.sentFrames.push(JSON.parse(data));
      } catch {
        this.sentFrames.push({ _raw: data.slice(0, 64) });
      }
    }
    if (typeof _opts === 'function') _opts(null);
    else if (typeof cb === 'function') cb(null);
  }

  terminate() {
    this.terminateCalls += 1;
    this.readyState = 3;
    this.emit('close');
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.emit('close');
  }
}

function createFakeBus() {
  const listeners = new Set();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return { dispose: () => { listeners.delete(fn); } };
    },
    emit(event) {
      for (const fn of listeners) fn(event);
    },
  };
}

function createSessionHarness(coreTokens, sessionIds) {
  const sessions = new Map();
  const coreEvents = createFakeBus();

  for (const sid of sessionIds) {
    const mainBus = createFakeBus();
    const childBus = createFakeBus();
    let authoritativeContext = [];
    const mainAgent = {
      id: 'main',
      accessor: {
        get(token) {
          if (token === coreTokens.IEventBus) return mainBus;
          if (token === coreTokens.IAgentContextMemoryService) {
            return { get: () => authoritativeContext };
          }
          if (token === coreTokens.IWireService) {
            return { flush: async () => {} };
          }
          if (token === coreTokens.IAgentScopeContext) {
            return { scope: () => `s19:${sid}:main` };
          }
          return undefined;
        },
      },
    };
    const childAgent = {
      id: 'child-1',
      accessor: {
        get(token) {
          if (token === coreTokens.IEventBus) return childBus;
          return undefined;
        },
      },
    };
    const agents = [mainAgent, childAgent];
    const workState = {
      busy: false,
      executing: false,
      cleanupPending: false,
      mainTurnActive: false,
      pendingInteraction: 'none',
      lastTurnReason: 'completed',
    };
    const sessionHandle = {
      accessor: {
        get(token) {
          if (token === coreTokens.IAgentLifecycleService) {
            return {
              list: () => agents,
              get: (id) => agents.find((a) => a.id === id),
              onDidCreate: () => ({ dispose: () => {} }),
              onDidDispose: () => ({ dispose: () => {} }),
            };
          }
          if (token === coreTokens.ISessionActivityView) {
            return {
              state: () => workState,
              onDidChange: () => ({ dispose: () => {} }),
            };
          }
          if (token === coreTokens.ISessionInteractionService) {
            return {
              listPending: () => [],
              onDidChangePending: () => ({ dispose: () => {} }),
              onDidResolve: () => ({ dispose: () => {} }),
              acquireConsumer: () => {},
              releaseConsumer: () => {},
            };
          }
          return undefined;
        },
      },
    };
    sessions.set(sid, {
      sessionHandle,
      mainBus,
      childBus,
      setContext(messages) {
        authoritativeContext = messages;
      },
      getContext() {
        return authoritativeContext;
      },
    });
  }

  const core = {
    accessor: {
      get(token) {
        if (token === coreTokens.IEventService) return coreEvents;
        if (token === coreTokens.ISessionManager) {
          return {
            get: (sid) => sessions.get(sid)?.sessionHandle,
            acquire: async (sid) => {
              const entry = sessions.get(sid);
              return entry ? { handle: entry.sessionHandle, dispose: async () => {} } : undefined;
            },
            isEphemeral: () => false,
          };
        }
        if (token === coreTokens.ISessionIndex) {
          return { get: async () => undefined };
        }
        if (token === coreTokens.IFileSystemStorageService) {
          return {
            pathFor: () => undefined,
            mtime: async () => 0,
            stat: async () => undefined,
          };
        }
        return undefined;
      },
    },
  };

  return { core, sessions };
}

function buildMixedSchedule(total = 2000, toolResultCount = 200, spliceCount = 50) {
  const schedule = Array.from({ length: total }, () => 'small');
  const stepTool = Math.floor(total / toolResultCount);
  for (let i = 0; i < toolResultCount; i += 1) {
    schedule[Math.min(total - 1, i * stepTool + 1)] = 'tool_16m';
  }
  const stepSplice = Math.floor(total / spliceCount);
  let placed = 0;
  for (let i = 0; i < total && placed < spliceCount; i += stepSplice) {
    let idx = i;
    while (idx < total && schedule[idx] !== 'small') idx += 1;
    if (idx < total) {
      schedule[idx] = 'splice_16m';
      placed += 1;
    }
  }
  return schedule;
}

function collectMaxJournalHeapSample(profile) {
  let maxJournalSampleBytes = 0;
  let maxJournalSampleFn = null;
  let maxOverallSampleBytes = 0;
  const journalPathPattern = /(?:sessionEventJournal|sessionEventBroadcaster|sessionEventReplay|boundedJsonEncoder|wsConnectionV1)/u;

  function walk(node, inJournal) {
    const cf = node.callFrame ?? {};
    const url = String(cf.url ?? '');
    const fn = String(cf.functionName ?? '');
    const matched = inJournal || journalPathPattern.test(url);
    if (matched && node.selfSize > maxJournalSampleBytes) {
      maxJournalSampleBytes = node.selfSize;
      maxJournalSampleFn = `${fn || '(anon)'}@${path.basename(url)}:${cf.lineNumber ?? 0}`;
    }
    if (node.selfSize > maxOverallSampleBytes) {
      maxOverallSampleBytes = node.selfSize;
    }
    for (const child of node.children ?? []) {
      walk(child, matched);
    }
  }

  if (profile?.head) walk(profile.head, false);
  const sampleMaxSingle = Math.max(
    0,
    ...(profile?.samples ?? []).map((s) => Number(s.size) || 0),
  );
  return {
    maxJournalSampleBytes,
    maxJournalSampleFn,
    maxOverallSampleBytes,
    sampleMaxSingle,
    sampleCount: profile?.samples?.length ?? 0,
  };
}

async function runWithHeapSampling(fn) {
  const session = new inspector.Session();
  session.connect();
  const post = (method, params = {}) =>
    new Promise((resolve, reject) => {
      session.post(method, params, (err, res) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(res);
      });
    });
  await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', { samplingInterval: 65536 });
  try {
    const result = await fn();
    const { profile } = await post('HeapProfiler.stopSampling');
    await post('HeapProfiler.disable');
    session.disconnect();
    return { result, sampling: collectMaxJournalHeapSample(profile) };
  } catch (error) {
    try {
      await post('HeapProfiler.stopSampling');
      await post('HeapProfiler.disable');
    } catch {}
    session.disconnect();
    throw error;
  }
}

async function waitForAck(sock, id, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = sock.sentFrames.find((f) => f?.type === 'ack' && f?.id === id);
    if (frame) return frame;
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
  }
  throw new Error(`Timed out waiting for WS ack id=${id}`);
}

function forceGcAndRss() {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    globalThis.gc();
  }
  const mem = process.memoryUsage();
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    externalBytes: mem.external,
    arrayBuffersBytes: mem.arrayBuffers,
  };
}

let cachedKapModulesPromise = null;

function loadKapModules() {
  if (cachedKapModulesPromise) return cachedKapModulesPromise;
  cachedKapModulesPromise = (async () => {
    const pkgMap = new Map();
    const packagesRoot = path.join(REPO_ROOT, 'packages');
    for (const dir of fs.readdirSync(packagesRoot)) {
      const pkgDir = path.join(packagesRoot, dir);
      const pkgPath = path.join(pkgDir, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const srcEntry = path.join(pkgDir, 'src', 'index.ts');
      const exportEntry =
        pkg.exports?.['.']?.['@kiki/source'] ??
        pkg.exports?.['.']?.source ??
        pkg.exports?.['.']?.import ??
        pkg.exports?.['.']?.default ??
        pkg.exports?.['.'] ??
        pkg.main;
      const resolved = fs.existsSync(srcEntry)
        ? srcEntry
        : typeof exportEntry === 'string'
          ? path.resolve(pkgDir, exportEntry)
          : null;
      if (pkg.name && resolved && fs.existsSync(resolved)) {
        pkgMap.set(pkg.name, pathToFileURL(resolved).href);
      }
    }
    if (typeof module.registerHooks === 'function') {
      module.registerHooks({
        resolve(specifier, context, nextResolve) {
          const mapped = pkgMap.get(specifier);
          if (mapped) return nextResolve(mapped, context);
          return nextResolve(specifier, context);
        },
      });
    }
    if (process.env.KIKI_S19_RAW_LOADER !== '1') {
      await import(pathToFileURL(path.join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs')).href);
    }
    const rootRequire = createRequire(path.join(REPO_ROOT, 'package.json'));
    const tsxApiUrl = pathToFileURL(rootRequire.resolve('tsx/esm/api')).href;
    const { register } = await import(tsxApiUrl);
    register();
    const [journalMod, encoderMod, broadcasterMod, wsMod, coreMod] = await Promise.all([
      import(pathToFileURL(path.join(REPO_ROOT, 'packages/kap-server/src/transport/ws/v1/sessionEventJournal.ts')).href),
      import(pathToFileURL(path.join(REPO_ROOT, 'packages/kap-server/src/transport/ws/v1/boundedJsonEncoder.ts')).href),
      import(pathToFileURL(path.join(REPO_ROOT, 'packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts')).href),
      import(pathToFileURL(path.join(REPO_ROOT, 'packages/kap-server/src/transport/ws/v1/wsConnectionV1.ts')).href),
      import('@kiki/agent-core-v2'),
    ]);
    return { journalMod, encoderMod, broadcasterMod, wsMod, coreMod };
  })();
  return cachedKapModulesPromise;
}

/**
 * S19 WS Event Journal Bombardment Gate (Frame Audit §1 & §5).
 * Exercises bounded UTF-8 JSON encoding, chunked writev, 2x/1x hysteresis,
 * dual-client reconnect parity (modern delta + legacy), 16-session concurrency,
 * 31.25 GiB extreme bounded generator, cold 16 MiB streaming reads, write
 * amplification dual windows, and fault injection under `--max-old-space-size=1024`.
 */
export async function runScenarioS19JournalBombardment(options = {}) {
  const tier = options.tier === 'smoke' ? 'smoke' : 'full';
  const includeExtreme = options.includeExtreme ?? tier === 'full';
  const progress = typeof options.progress === 'function' ? options.progress : () => {};

  const workDir = options.dir
    ? path.resolve(options.dir)
    : await mkdtemp(path.join(os.tmpdir(), 'kiki-s19-journal-'));
  const ownsWorkDir = !options.dir;
  const failures = [];
  const unhandledErrors = [];
  const onUnhandled = (err) => unhandledErrors.push(String(err));
  process.on('unhandledRejection', onUnhandled);

  const startedAt = performance.now();

  try {
    const { journalMod, encoderMod, broadcasterMod, wsMod, coreMod } = await loadKapModules();

    const { SessionEventJournal, MAX_SINGLE_JOURNAL_LINE_BYTES, getJournalProcessPendingBytes } = journalMod;
    const { encodeJsonLineBounded } = encoderMod;
    const { SessionEventBroadcaster } = broadcasterMod;
    const { WsConnectionV1 } = wsMod;

    // Pre-allocate ONE reusable 16 MiB fixture string BEFORE sampling so fixture allocation is separated.
    const giantPayload16MiB = 'G'.repeat(16 * MiB);
    const fixtureMsg16MiB = {
      role: 'assistant',
      content: [{ type: 'text', text: giantPayload16MiB }],
      toolCalls: [],
    };
    const baselineMem = forceGcAndRss();
    const mixedSchedule = buildMixedSchedule(2000, 200, 50);

    // -----------------------------------------------------------------------
    // Cell 1: Single-session 2,000 mixed heavy bombardment + dual reconnects
    // -----------------------------------------------------------------------
    progress('S19 [1/6]: Running single-session 2,000-event mixed bombardment (4,000 MiB logical payload) with modern delta + legacy reconnects...');
    const cell1Dir = path.join(workDir, 'cell1-single');
    fs.mkdirSync(cell1Dir, { recursive: true });

    const { result: cell1, sampling: cell1Sampling } = await runWithHeapSampling(async () => {
      const sid = 's19_single';
      const { core, sessions } = createSessionHarness(coreMod, [sid]);
      const harness = sessions.get(sid);
      const broadcaster = new SessionEventBroadcaster({ eventsDir: cell1Dir, core });
      const connectionRegistry = { add: () => {}, remove: () => {} };

      const openWsClient = async (mode, cursor) => {
        const socket = new InMemoryWsSocket();
        const conn = new WsConnectionV1({
          socket,
          broadcaster,
          connectionRegistry,
          remoteAddress: '127.0.0.1',
          userAgent: `s19-${mode}`,
          heartbeatIntervalMs: 0,
        });
        const helloId = `hello-${mode}-${Math.random().toString(36).slice(2, 8)}`;
        if (mode === 'modern') {
          socket.emit('message', JSON.stringify({
            type: 'subscribe_v2',
            id: helloId,
            payload: {
              session_id: sid,
              transcript: { '*': 'delta' },
              transcript_coverage_version: 2,
            },
          }));
          const ack = await waitForAck(socket, helloId);
          return { socket, conn, ack };
        }
        socket.emit('message', JSON.stringify({
          type: 'subscribe',
          id: helloId,
          payload: {
            session_ids: [sid],
            ...(cursor ? { cursors: { [sid]: cursor } } : {}),
          },
        }));
        const ack = await waitForAck(socket, helloId);
        return { socket, conn, ack };
      };

      let modernClient = await openWsClient('modern');
      let legacyClient = await openWsClient('legacy');
      let modernCursor = await broadcaster.getCursor(sid);
      let legacyCursor = { ...modernCursor };

      let modernExtraResets = 0;
      let legacyGapResyncs = 0;
      let reconnectCycles = 0;
      let peakLiveFileBytes = 0;
      let peakTailBytes = 0;
      let expectedAttentionSeq = 0;

      for (let i = 0; i < mixedSchedule.length; i += 1) {
        const kind = mixedSchedule[i];
        if (kind === 'tool_16m') {
          harness.mainBus.emit({
            type: 'tool.result',
            turnId: Math.floor(i / 20) + 1,
            toolCallId: `tool-${i}`,
            output: giantPayload16MiB,
          });
        } else if (kind === 'splice_16m') {
          const nextCtx = [fixtureMsg16MiB];
          harness.setContext(nextCtx);
          harness.mainBus.emit({
            type: 'context.spliced',
            start: 0,
            deleteCount: 0,
            messages: nextCtx,
          });
        } else if (i % 50 === 0) {
          harness.mainBus.emit({
            type: 'turn.ended',
            turnId: Math.floor(i / 50) + 1,
            reason: 'completed',
          });
        } else {
          harness.mainBus.emit({
            type: 'tool.call.started',
            turnId: Math.floor(i / 20) + 1,
            toolCallId: `tool-${i}`,
            name: 'Read',
            args: { path: `/tmp/file-${i}.txt` },
          });
        }

        if ((i + 1) % 200 === 0) {
          await broadcaster.flushSessionJournal(sid);
          const cursorNow = await broadcaster.getCursor(sid);
          expectedAttentionSeq = cursorNow.attentionSeq;
          const filePath = path.join(cell1Dir, `${sid}.jsonl`);
          if (fs.existsSync(filePath)) {
            const sz = (await stat(filePath)).size;
            if (sz > peakLiveFileBytes) peakLiveFileBytes = sz;
          }
          const m = broadcaster.getSessionJournalMetrics(sid);
          if (m && m.tailBytes > peakTailBytes) peakTailBytes = m.tailBytes;

          // Disconnect and reconnect both modern delta and legacy clients every 200 events
          modernClient.conn.close();
          legacyClient.conn.close();
          reconnectCycles += 1;

          const modernReplay = await broadcaster.getBufferedSince(sid, modernCursor, undefined, { '*': 'delta' });
          if (modernReplay.resyncRequired !== false) {
            modernExtraResets += 1;
          }
          modernCursor = { seq: modernReplay.currentSeq, epoch: modernReplay.epoch };
          modernClient = await openWsClient('modern');

          legacyClient = await openWsClient('legacy', legacyCursor);
          const legacyResync = legacyClient.ack?.payload?.resync_required?.includes(sid);
          if (legacyResync) {
            legacyGapResyncs += 1;
            const snap = await broadcaster.getSnapshotState(sid, { captureMessages: false });
            legacyCursor = { seq: snap.seq, epoch: snap.epoch };
          } else {
            const ackCursor = legacyClient.ack?.payload?.cursors?.[sid];
            legacyCursor = ackCursor ?? { seq: cursorNow.seq, epoch: cursorNow.epoch };
          }
        }
      }

      // Unsuppressed 16 MiB event must trigger journal_gap for BOTH modern delta and legacy
      const beforeUnsuppressed = await broadcaster.getCursor(sid);
      harness.mainBus.emit({
        type: 'custom.unsuppressed.oversized',
        data: giantPayload16MiB,
      });
      await broadcaster.flushSessionJournal(sid);
      const modernUnsuppressedReplay = await broadcaster.getBufferedSince(
        sid,
        beforeUnsuppressed,
        undefined,
        { '*': 'delta' },
      );
      const legacyUnsuppressedReplay = await broadcaster.getBufferedSince(sid, beforeUnsuppressed);

      const finalCursor = await broadcaster.getCursor(sid);
      const finalSnapshot = await broadcaster.getSnapshotState(sid, { captureMessages: false });
      const liveMetrics = broadcaster.getSessionJournalMetrics(sid);

      modernClient.conn.close();
      legacyClient.conn.close();
      await broadcaster.close();

      const closedFileBytes = (await stat(path.join(cell1Dir, `${sid}.jsonl`))).size;
      const coldPeek = await SessionEventJournal.peekWatermark(path.join(cell1Dir, `${sid}.jsonl`));

      return {
        totalEvents: mixedSchedule.length + 1,
        logicalGiantMiB: 250 * 16 + 16,
        reconnectCycles,
        modernExtraResets,
        legacyGapResyncs,
        modernUnsuppressedResync: modernUnsuppressedReplay.resyncRequired,
        legacyUnsuppressedResync: legacyUnsuppressedReplay.resyncRequired,
        cursorParity:
          modernCursor.seq === legacyCursor.seq &&
          modernCursor.epoch === legacyCursor.epoch &&
          finalCursor.seq === finalSnapshot.seq &&
          finalCursor.epoch === finalSnapshot.epoch &&
          finalCursor.attentionSeq === finalSnapshot.attentionSeq &&
          coldPeek.seq === finalCursor.seq &&
          coldPeek.epoch === finalCursor.epoch &&
          coldPeek.attentionSeq === finalCursor.attentionSeq &&
          expectedAttentionSeq > 0,
        finalCursor,
        coldPeek,
        peakLiveFileBytes,
        closedFileBytes,
        peakTailBytes,
        journalStats: liveMetrics?.journal,
      };
    });

    // -----------------------------------------------------------------------
    // Cell 2: 16 concurrent sessions sharing the 2,000-event mixed recipe
    // -----------------------------------------------------------------------
    progress('S19 [2/6]: Running 16 concurrent sessions sharing 2,000 mixed events (4,000 MiB logical)...');
    const cell2Dir = path.join(workDir, 'cell2-concurrent-16');
    fs.mkdirSync(cell2Dir, { recursive: true });
    const sessionIds16 = Array.from({ length: 16 }, (_, idx) => `s19_c_${idx}`);
    const { core: core16, sessions: sessions16 } = createSessionHarness(coreMod, sessionIds16);
    const bc16 = new SessionEventBroadcaster({ eventsDir: cell2Dir, core: core16 });
    const dummyTargets16 = [];
    for (const sid of sessionIds16) {
      const target = { send: () => {}, sendDurableCursor: () => {}, sendControl: () => {} };
      dummyTargets16.push(target);
      await bc16.subscribe(sid, target, undefined, { '*': 'delta' });
    }

    let c16PeakLiveFileBytes = 0;
    let c16PeakTailBytes = 0;
    let c16MaxLineBytes = 0;
    let c16MaxBatchWriteBytes = 0;
    let c16MaxSingleAllocBytes = 0;

    for (let i = 0; i < mixedSchedule.length; i += 1) {
      const sid = sessionIds16[i % sessionIds16.length];
      const harness = sessions16.get(sid);
      const kind = mixedSchedule[i];
      if (kind === 'tool_16m') {
        harness.mainBus.emit({ type: 'tool.result', turnId: 1, toolCallId: `t-${i}`, output: giantPayload16MiB });
      } else if (kind === 'splice_16m') {
        harness.setContext([fixtureMsg16MiB]);
        harness.mainBus.emit({ type: 'context.spliced', start: 0, deleteCount: 0, messages: [fixtureMsg16MiB] });
      } else {
        harness.mainBus.emit({ type: 'tool.call.started', turnId: 1, toolCallId: `t-${i}`, name: 'Read' });
      }
      if ((i + 1) % 250 === 0) {
        await Promise.all(sessionIds16.map((s) => bc16.flushSessionJournal(s)));
        for (const s of sessionIds16) {
          const p = path.join(cell2Dir, `${s}.jsonl`);
          if (fs.existsSync(p)) {
            c16PeakLiveFileBytes = Math.max(c16PeakLiveFileBytes, (await stat(p)).size);
          }
          const m = bc16.getSessionJournalMetrics(s);
          if (m) {
            c16PeakTailBytes = Math.max(c16PeakTailBytes, m.tailBytes);
            c16MaxLineBytes = Math.max(c16MaxLineBytes, m.journal.maxLineBytes);
            c16MaxBatchWriteBytes = Math.max(c16MaxBatchWriteBytes, m.journal.maxBatchWriteBytes);
            c16MaxSingleAllocBytes = Math.max(c16MaxSingleAllocBytes, m.journal.maxSingleAllocBytes);
          }
        }
      }
    }

    await bc16.close();
    let c16MaxClosedFileBytes = 0;
    for (const sid of sessionIds16) {
      const p = path.join(cell2Dir, `${sid}.jsonl`);
      if (fs.existsSync(p)) {
        c16MaxClosedFileBytes = Math.max(c16MaxClosedFileBytes, (await stat(p)).size);
      }
    }
    const postCell2Mem = forceGcAndRss();
    const cell2 = {
      sessionCount: 16,
      totalEvents: mixedSchedule.length,
      peakLiveFileBytes: c16PeakLiveFileBytes,
      maxClosedFileBytes: c16MaxClosedFileBytes,
      peakTailBytes: c16PeakTailBytes,
      maxLineBytes: c16MaxLineBytes,
      maxBatchWriteBytes: c16MaxBatchWriteBytes,
      maxSingleAllocBytes: c16MaxSingleAllocBytes,
      processPendingAfterCloseBytes: getJournalProcessPendingBytes(),
      rssDeltaAfterDrainBytes: postCell2Mem.rssBytes - baselineMem.rssBytes,
    };

    // -----------------------------------------------------------------------
    // Cell 3: Extreme tier 2,000 x 16 MiB = 31.25 GiB logical (bounded reuse)
    // -----------------------------------------------------------------------
    let cell3 = { skipped: !includeExtreme };
    if (includeExtreme) {
      progress('S19 [3/6]: Running extreme tier 2,000 x 16 MiB (31.25 GiB logical payload) via bounded generator reuse...');
      const cell3Dir = path.join(workDir, 'cell3-extreme-31g');
      fs.mkdirSync(cell3Dir, { recursive: true });
      const sid = 's19_extreme';
      const { core: coreExt, sessions: sessionsExt } = createSessionHarness(coreMod, [sid]);
      const bcExt = new SessionEventBroadcaster({ eventsDir: cell3Dir, core: coreExt });
      await bcExt.subscribe(sid, { send: () => {}, sendDurableCursor: () => {} }, undefined, { '*': 'delta' });
      const h = sessionsExt.get(sid);

      let extPeakLiveBytes = 0;
      let extPeakTailBytes = 0;
      const extCount = 2000;
      for (let i = 0; i < extCount; i += 1) {
        h.mainBus.emit({
          type: i % 5 === 0 ? 'context.spliced' : 'tool.result',
          turnId: i + 1,
          toolCallId: `ext-${i}`,
          ...(i % 5 === 0
            ? { start: 0, deleteCount: 0, messages: [fixtureMsg16MiB] }
            : { output: giantPayload16MiB }),
        });
        if ((i + 1) % 200 === 0) {
          await bcExt.flushSessionJournal(sid);
          const p = path.join(cell3Dir, `${sid}.jsonl`);
          if (fs.existsSync(p)) {
            extPeakLiveBytes = Math.max(extPeakLiveBytes, (await stat(p)).size);
          }
          const m = bcExt.getSessionJournalMetrics(sid);
          if (m) extPeakTailBytes = Math.max(extPeakTailBytes, m.tailBytes);
        }
      }
      const extMetrics = bcExt.getSessionJournalMetrics(sid);
      const extCursor = await bcExt.getCursor(sid);
      await bcExt.close();
      const extClosedBytes = (await stat(path.join(cell3Dir, `${sid}.jsonl`))).size;
      const postExtMem = forceGcAndRss();
      cell3 = {
        skipped: false,
        events: extCount,
        logicalGiB: roundNum((extCount * 16) / 1024, 2),
        finalSeq: extCursor.seq,
        peakLiveFileBytes: extPeakLiveBytes,
        closedFileBytes: extClosedBytes,
        peakTailBytes: extPeakTailBytes,
        maxLineBytes: extMetrics?.journal.maxLineBytes ?? 0,
        maxBatchWriteBytes: extMetrics?.journal.maxBatchWriteBytes ?? 0,
        maxSingleAllocBytes: extMetrics?.journal.maxSingleAllocBytes ?? 0,
        rssDeltaAfterDrainBytes: postExtMem.rssBytes - baselineMem.rssBytes,
      };
    }

    // -----------------------------------------------------------------------
    // Cell 4: Write amplification (prefilled between B0 and 2*B0; >=1000 events & >=3 rotations)
    // -----------------------------------------------------------------------
    progress('S19 [4/6]: Measuring pre-filled write amplification across >=1,000 events and >=3 full rotations...');
    const cell4Dir = path.join(workDir, 'cell4-write-amp');
    fs.mkdirSync(cell4Dir, { recursive: true });
    const ampPath = path.join(cell4Dir, 'amp.jsonl');
    const b0 = 4 * MiB;
    const ampJournal = await SessionEventJournal.open(ampPath, undefined, 1000, b0);
    const pad16k = 'w'.repeat(16 * KiB);
    // Pre-fill to ~5 MiB (between 4 MiB B0 and 8 MiB 2*B0)
    for (let i = 1; i <= 320; i += 1) {
      ampJournal.append(ampJournal.nextSeq(), {
        type: 'event.session.work_changed',
        seq: i,
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: { agentId: 'main', pad: pad16k },
      });
      if (i % 16 === 0) await ampJournal.flush();
    }
    await ampJournal.flush();
    const prefillStats = ampJournal.stats();
    const prefillFileSize = (await stat(ampPath)).size;

    // Window: 1,100 bounded ~16 KiB events (~17.6 MiB valid bounded lines -> >=3 full rotations!)
    let ampPeakLiveBytes = prefillFileSize;
    for (let i = 1; i <= 1100; i += 1) {
      const seq = ampJournal.nextSeq();
      ampJournal.append(seq, {
        type: 'event.session.work_changed',
        seq,
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: { agentId: 'main', pad: pad16k },
      });
      if (i % 20 === 0) {
        await ampJournal.flush();
        ampPeakLiveBytes = Math.max(ampPeakLiveBytes, (await stat(ampPath)).size);
      }
    }
    await ampJournal.flush();
    const afterWindowStats = ampJournal.stats();
    await ampJournal.close();
    const afterCloseStats = ampJournal.stats();
    const ampClosedBytes = (await stat(ampPath)).size;

    const deltaAppended = afterWindowStats.appendedBytes - prefillStats.appendedBytes;
    const deltaCompactTemp = afterWindowStats.compactedTempBytes - prefillStats.compactedTempBytes;
    const deltaValidBounded = afterWindowStats.validBoundedLineBytes - prefillStats.validBoundedLineBytes;
    const deltaRotations = afterWindowStats.compactionCount - prefillStats.compactionCount;
    const writeAmplification = deltaValidBounded > 0 ? (deltaAppended + deltaCompactTemp) / deltaValidBounded : Infinity;
    const cell4 = {
      prefillFileBytes: prefillFileSize,
      windowEvents: 1100,
      rotationsInWindow: deltaRotations,
      deltaAppendedBytes: deltaAppended,
      deltaCompactedTempBytes: deltaCompactTemp,
      deltaValidBoundedLineBytes: deltaValidBounded,
      writeAmplification: roundNum(writeAmplification, 4),
      closeConvergenceTempBytes: afterCloseStats.closeCompactedTempBytes,
      peakLiveFileBytes: ampPeakLiveBytes,
      closedFileBytes: ampClosedBytes,
    };

    // -----------------------------------------------------------------------
    // Cell 5: Cold 16 MiB legacy head/mid/tail + edge & boundary matrix
    // -----------------------------------------------------------------------
    progress('S19 [5/6]: Verifying cold 16 MiB head/middle/tail streaming reads and boundary edge matrix...');
    const cell5Dir = path.join(workDir, 'cell5-edges');
    fs.mkdirSync(cell5Dir, { recursive: true });

    const coldHugePath = path.join(cell5Dir, 'cold_16m_hmt.jsonl');
    const fakeNested = '{"kind":"event","seq":999999,"attention_seq":999999}';
    const headerLine = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_cold_16m', created_at: 1 });
    const mkLegacy16m = (seq, type) =>
      `{"kind":"event","seq":${seq},"envelope":{"type":"${type}","seq":${seq},"epoch":"ep_cold_16m","session_id":"s_cold","timestamp":"2026-01-01T00:00:00Z","payload":{"agentId":"main","fake":${JSON.stringify(fakeNested)},"blob":"${giantPayload16MiB}"}}}\n`;
    const fh = await open(coldHugePath, 'w');
    try {
      await fh.write(`${headerLine}\n`);
      await fh.write(mkLegacy16m(1, 'turn.ended'));
      await fh.write(mkLegacy16m(2, 'tool.result'));
      await fh.write(mkLegacy16m(3, 'context.spliced'));
    } finally {
      await fh.close();
    }

    const protoProbe = await open(coldHugePath, 'r');
    const fhProto = Object.getPrototypeOf(protoProbe);
    await protoProbe.close();
    const origRead = fhProto.read;
    let maxReadChunkBytes = 0;
    fhProto.read = async function patchedRead(buffer, offset, length, position) {
      if (length > maxReadChunkBytes) maxReadChunkBytes = length;
      return origRead.call(this, buffer, offset, length, position);
    };
    let coldWatermark;
    let coldRange;
    try {
      coldWatermark = await SessionEventJournal.peekWatermark(coldHugePath);
      const coldJournal = await SessionEventJournal.open(coldHugePath);
      coldRange = await coldJournal.readRecordsSince(0, 3, 10);
      await coldJournal.close();
    } finally {
      fhProto.read = origRead;
    }

    // 256 KiB +/- 1 with LF, ASCII + CJK + escapes
    const probeBase = { kind: 'event', seq: 1, attention_seq: 1, envelope: { type: 't', seq: 1, timestamp: '2026-01-01T00:00:00Z', payload: { s: '' } } };
    const overhead = Buffer.byteLength(JSON.stringify(probeBase), 'utf8') + 1;
    const exact256k = encodeJsonLineBounded(
      { ...probeBase, envelope: { ...probeBase.envelope, payload: { s: 'a'.repeat(MAX_SINGLE_JOURNAL_LINE_BYTES - overhead) } } },
      MAX_SINGLE_JOURNAL_LINE_BYTES,
    );
    const over256kBy1 = encodeJsonLineBounded(
      { ...probeBase, envelope: { ...probeBase.envelope, payload: { s: 'a'.repeat(MAX_SINGLE_JOURNAL_LINE_BYTES - overhead + 1) } } },
      MAX_SINGLE_JOURNAL_LINE_BYTES,
    );
    const cjkEsc = encodeJsonLineBounded({ text: '汉字边界\n\t"\\🚀' }, 1024);

    // Zero capacity
    const zeroCapPath = path.join(cell5Dir, 'zero_cap.jsonl');
    const zc = await SessionEventJournal.open(zeroCapPath, undefined, 0);
    zc.append(zc.nextSeq(), { type: 'turn.ended', seq: 1, timestamp: '2026-01-01T00:00:00Z', payload: {} });
    await zc.close();
    const zcLines = (await readFile(zeroCapPath, 'utf8')).trim().split('\n');
    const zcPeek = await SessionEventJournal.peekWatermark(zeroCapPath);

    // Damaged tail
    const damagedPath = path.join(cell5Dir, 'damaged_tail.jsonl');
    await writeFile(
      damagedPath,
      `${headerLine}\n${JSON.stringify({ kind: 'event', seq: 1, attention_seq: 1, envelope: { type: 'turn.ended', seq: 1, timestamp: '2026-01-01T00:00:00Z', payload: {} } })}\n{"kind":"event","seq":2`,
    );
    const damagedPeek = await SessionEventJournal.peekWatermark(damagedPath);

    // Cross-chunk 64 KiB boundary
    const chunkPath = path.join(cell5Dir, 'cross_chunk.jsonl');
    const firstChunk = JSON.stringify({ kind: 'event', seq: 1, attention_seq: 1, envelope: { type: 'turn.started', seq: 1, timestamp: '2026-01-01T00:00:00Z', payload: {} } });
    const rec2 = { kind: 'event', seq: 2, attention_seq: 1, envelope: { type: 'tool.result', seq: 2, timestamp: '2026-01-01T00:00:00Z', payload: '' } };
    rec2.envelope.payload = 'c'.repeat(64 * KiB - 1 - Buffer.byteLength(JSON.stringify(rec2)) - 1);
    await writeFile(chunkPath, `${headerLine}\n${firstChunk}\n${JSON.stringify(rec2)}\n`);
    const chunkJournal = await SessionEventJournal.open(chunkPath, undefined, 2);
    chunkJournal.append(chunkJournal.nextSeq(), { type: 'turn.ended', seq: 3, timestamp: '2026-01-01T00:00:00Z', payload: {} });
    await chunkJournal.close();
    const chunkPeek = await SessionEventJournal.peekWatermark(chunkPath);

    const cell5 = {
      cold16mWatermark: coldWatermark,
      cold16mRecordCount: coldRange.records.length,
      cold16mAllGaps: coldRange.records.every((r) => r.kind === 'gap' && r.reason === 'legacy_oversized_line'),
      cold16mMaxReadChunkBytes: maxReadChunkBytes,
      exact256kOk: exact256k.ok && exact256k.bytes === MAX_SINGLE_JOURNAL_LINE_BYTES,
      over256kBy1Rejected: !over256kBy1.ok && over256kBy1.reason === 'exceeded',
      cjkEscOk: cjkEsc.ok && JSON.parse(cjkEsc.buffer.toString('utf8')).text === '汉字边界\n\t"\\🚀',
      zeroCapLineCount: zcLines.length,
      zeroCapPeek: zcPeek,
      damagedTailPeek: damagedPeek,
      crossChunkPeek: chunkPeek,
    };

    // -----------------------------------------------------------------------
    // Cell 6: Fault injection (short write, zero-progress, close/sync failure)
    // -----------------------------------------------------------------------
    progress('S19 [6/6]: Executing fault injection (short write, zero-progress rollback, sync failure)...');
    const cell6Dir = path.join(workDir, 'cell6-faults');
    fs.mkdirSync(cell6Dir, { recursive: true });

    const faultPath = path.join(cell6Dir, 'fault_short_zero.jsonl');
    const fj = await SessionEventJournal.open(faultPath);
    fj.append(fj.nextSeq(), { type: 'turn.started', seq: 1, timestamp: '2026-01-01T00:00:00Z', payload: {} });
    await fj.flush();

    const origWritev = fhProto.writev;
    let shortInjected = false;
    let zeroInjected = false;
    fhProto.writev = async function patchedWritev(buffers, pos) {
      if (!shortInjected) {
        shortInjected = true;
        const first = buffers[0];
        const half = Math.max(1, Math.floor(first.byteLength / 2));
        const res = await origWritev.call(this, [Buffer.from(first.buffer, first.byteOffset, half)], pos);
        return { bytesWritten: res.bytesWritten, buffers };
      }
      if (!zeroInjected) {
        zeroInjected = true;
        await origWritev.call(this, [Buffer.from('{"torn')], pos);
        return { bytesWritten: 0, buffers };
      }
      return origWritev.call(this, buffers, pos);
    };
    let shortAndZeroRecovered = false;
    try {
      fj.append(fj.nextSeq(), { type: 'tool.call.started', seq: 2, timestamp: '2026-01-01T00:00:00Z', payload: {} });
      await fj.flush();
      fj.append(fj.nextSeq(), { type: 'turn.ended', seq: 3, timestamp: '2026-01-01T00:00:00Z', payload: {} });
      await fj.flush();
      await fj.flush();
      const recovered = await fj.readSince(0, 10);
      shortAndZeroRecovered =
        recovered.map((e) => e.seq).join(',') === '1,2,3' && !fj.poisoned;
    } finally {
      fhProto.writev = origWritev;
      await fj.close();
    }

    const syncFailPath = path.join(cell6Dir, 'fault_sync.jsonl');
    const origSync = fhProto.sync;
    fhProto.sync = async function patchedSync() {
      throw Object.assign(new Error('EIO injected sync'), { code: 'EIO' });
    };
    let syncFailCleanClose = false;
    try {
      const sj = await SessionEventJournal.open(syncFailPath);
      sj.append(sj.nextSeq(), { type: 'turn.started', seq: 1, timestamp: '2026-01-01T00:00:00Z', payload: {} });
      await sj.close();
      syncFailCleanClose = true;
    } finally {
      fhProto.sync = origSync;
    }

    const cell6 = {
      shortAndZeroRecovered,
      syncFailCleanClose,
      shortInjected,
      zeroInjected,
    };

    // -----------------------------------------------------------------------
    // Final Oracle Verdict
    // -----------------------------------------------------------------------
    const check = (cond, msg) => {
      if (!cond) failures.push(msg);
    };

    check(unhandledErrors.length === 0, `unhandled rejections observed: ${unhandledErrors.join('; ')}`);
    check(cell1.modernExtraResets === 0, `cell1 modern delta had ${cell1.modernExtraResets} extra resets`);
    check(cell1.legacyGapResyncs > 0, 'cell1 legacy client never observed expected journal_gap resync');
    check(cell1.modernUnsuppressedResync === 'journal_gap', `cell1 unsuppressed 16MiB failed for modern: ${cell1.modernUnsuppressedResync}`);
    check(cell1.legacyUnsuppressedResync === 'journal_gap', `cell1 unsuppressed 16MiB failed for legacy: ${cell1.legacyUnsuppressedResync}`);
    check(cell1.cursorParity === true, 'cell1 modern/legacy/snapshot/cold cursor parity mismatch');
    check(cell1.peakLiveFileBytes <= BUDGETS.maxLiveFileBytes, `cell1 peakLiveFileBytes=${cell1.peakLiveFileBytes} > ${BUDGETS.maxLiveFileBytes}`);
    check(cell1.closedFileBytes <= BUDGETS.maxClosedFileBytes, `cell1 closedFileBytes=${cell1.closedFileBytes} > ${BUDGETS.maxClosedFileBytes}`);
    check(cell1.peakTailBytes <= BUDGETS.maxTailBytes, `cell1 peakTailBytes=${cell1.peakTailBytes} > ${BUDGETS.maxTailBytes}`);
    check((cell1.journalStats?.maxLineBytes ?? 0) <= BUDGETS.maxLineBytes, `cell1 maxLineBytes=${cell1.journalStats?.maxLineBytes}`);
    check((cell1.journalStats?.maxBatchWriteBytes ?? 0) <= BUDGETS.maxBatchWriteBytes, `cell1 maxBatchWriteBytes=${cell1.journalStats?.maxBatchWriteBytes}`);
    check((cell1.journalStats?.maxSingleAllocBytes ?? 0) < BUDGETS.maxSingleAllocBytes, `cell1 maxSingleAllocBytes=${cell1.journalStats?.maxSingleAllocBytes}`);
    check(cell1Sampling.maxJournalSampleBytes < BUDGETS.maxSingleAllocBytes, `cell1 V8 heap sample in journal path=${cell1Sampling.maxJournalSampleBytes} (${cell1Sampling.maxJournalSampleFn})`);

    check(cell2.peakLiveFileBytes <= BUDGETS.maxLiveFileBytes, `cell2 peakLiveFileBytes=${cell2.peakLiveFileBytes}`);
    check(cell2.maxClosedFileBytes <= BUDGETS.maxClosedFileBytes, `cell2 maxClosedFileBytes=${cell2.maxClosedFileBytes}`);
    check(cell2.peakTailBytes <= BUDGETS.maxTailBytes, `cell2 peakTailBytes=${cell2.peakTailBytes}`);
    check(cell2.maxLineBytes <= BUDGETS.maxLineBytes, `cell2 maxLineBytes=${cell2.maxLineBytes}`);
    check(cell2.maxBatchWriteBytes <= BUDGETS.maxBatchWriteBytes, `cell2 maxBatchWriteBytes=${cell2.maxBatchWriteBytes}`);
    check(cell2.maxSingleAllocBytes < BUDGETS.maxSingleAllocBytes, `cell2 maxSingleAllocBytes=${cell2.maxSingleAllocBytes}`);
    check(cell2.processPendingAfterCloseBytes === 0, `cell2 leaked processPendingBytes=${cell2.processPendingAfterCloseBytes}`);
    check(cell2.rssDeltaAfterDrainBytes <= BUDGETS.maxPostGcRssDeltaBytes, `cell2 post-GC RSS delta=${roundMiB(cell2.rssDeltaAfterDrainBytes)} MiB > 64 MiB`);

    if (includeExtreme) {
      check(cell3.finalSeq === 2000, `cell3 finalSeq=${cell3.finalSeq} !== 2000`);
      check(cell3.peakLiveFileBytes <= BUDGETS.maxLiveFileBytes, `cell3 peakLiveFileBytes=${cell3.peakLiveFileBytes}`);
      check(cell3.closedFileBytes <= BUDGETS.maxClosedFileBytes, `cell3 closedFileBytes=${cell3.closedFileBytes}`);
      check(cell3.peakTailBytes <= BUDGETS.maxTailBytes, `cell3 peakTailBytes=${cell3.peakTailBytes}`);
      check(cell3.maxLineBytes <= BUDGETS.maxLineBytes, `cell3 maxLineBytes=${cell3.maxLineBytes}`);
      check(cell3.maxBatchWriteBytes <= BUDGETS.maxBatchWriteBytes, `cell3 maxBatchWriteBytes=${cell3.maxBatchWriteBytes}`);
      check(cell3.maxSingleAllocBytes < BUDGETS.maxSingleAllocBytes, `cell3 maxSingleAllocBytes=${cell3.maxSingleAllocBytes}`);
      check(cell3.rssDeltaAfterDrainBytes <= BUDGETS.maxPostGcRssDeltaBytes, `cell3 post-GC RSS delta=${roundMiB(cell3.rssDeltaAfterDrainBytes)} MiB > 64 MiB`);
    }

    check(cell4.rotationsInWindow >= 3, `cell4 rotationsInWindow=${cell4.rotationsInWindow} < 3`);
    check(cell4.writeAmplification <= BUDGETS.maxWriteAmplification, `cell4 writeAmplification=${cell4.writeAmplification} > ${BUDGETS.maxWriteAmplification}`);
    check(cell4.peakLiveFileBytes <= BUDGETS.maxLiveFileBytes, `cell4 peakLiveFileBytes=${cell4.peakLiveFileBytes}`);
    check(cell4.closedFileBytes <= BUDGETS.maxClosedFileBytes, `cell4 closedFileBytes=${cell4.closedFileBytes}`);

    check(
      cell5.cold16mWatermark.epoch === 'ep_cold_16m' &&
        cell5.cold16mWatermark.seq === 3 &&
        cell5.cold16mWatermark.attentionSeq === 1,
      `cell5 cold16mWatermark mismatch: ${JSON.stringify(cell5.cold16mWatermark)}`,
    );
    check(cell5.cold16mRecordCount === 3 && cell5.cold16mAllGaps, 'cell5 cold 16MiB head/mid/tail gap projection failed');
    check(cell5.cold16mMaxReadChunkBytes <= 64 * KiB, `cell5 cold16mMaxReadChunkBytes=${cell5.cold16mMaxReadChunkBytes} > 64 KiB`);
    check(cell5.exact256kOk && cell5.over256kBy1Rejected && cell5.cjkEscOk, 'cell5 256KiB+/-1 or CJK/escape check failed');
    check(cell5.zeroCapLineCount === 1 && cell5.zeroCapPeek.seq === 1 && cell5.zeroCapPeek.attentionSeq === 1, 'cell5 zero capacity check failed');
    check(cell5.damagedTailPeek.seq === 1 && cell5.damagedTailPeek.attentionSeq === 1, 'cell5 damaged tail check failed');
    check(cell5.crossChunkPeek.seq === 3 && cell5.crossChunkPeek.attentionSeq === 3, 'cell5 cross-chunk check failed');

    check(cell6.shortAndZeroRecovered, 'cell6 short/zero-progress writev recovery failed');
    check(cell6.syncFailCleanClose, 'cell6 sync failure close did not settle cleanly');

    const finalMem = forceGcAndRss();
    const durationMs = Math.round(performance.now() - startedAt);
    const report = {
      scenario: 'S19_WS_JOURNAL_BOMBARDMENT',
      tier,
      passed: failures.length === 0,
      durationMs,
      nodeVersion: process.version,
      execArgv: process.execArgv,
      budgets: BUDGETS,
      baselineMem,
      finalMem,
      cell1SingleSession: cell1,
      cell1V8HeapSampling: cell1Sampling,
      cell2Concurrent16: cell2,
      cell3Extreme31GiB: cell3,
      cell4WriteAmplification: cell4,
      cell5ColdAndEdges: cell5,
      cell6FaultInjection: cell6,
      failures,
    };
    progress(`S19 Result: passed=${report.passed} durationMs=${durationMs} failures=${failures.length}`);
    return report;
  } finally {
    process.off('unhandledRejection', onUnhandled);
    if (ownsWorkDir) {
      await rm(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => {});
    }
  }
}

const isCliMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isCliMain && process.env.KIKI_S19_TSX_READY !== '1') {
  const args = process.argv.slice(2);
  const resolvedArgs = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if ((a === '--out-json' || a === '--dir') && args[i + 1]) {
      resolvedArgs.push(a, path.resolve(args[i + 1]));
      i += 1;
    } else {
      resolvedArgs.push(a);
    }
  }
  const heapArg = resolvedArgs.find((a) => a.startsWith('--max-old-space-mb='));
  const maxOldSpaceMb = heapArg ? Number(heapArg.slice('--max-old-space-mb='.length)) : 1024;
  const rawLoaderUrl = pathToFileURL(path.join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs')).href;
  const child = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${maxOldSpaceMb}`,
      '--expose-gc',
      '--import',
      rawLoaderUrl,
      import.meta.filename,
      ...resolvedArgs,
    ],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        KIKI_S19_TSX_READY: '1',
        KIKI_S19_RAW_LOADER: '1',
      },
    },
  );
  process.exit(child.status ?? 1);
}

if (isCliMain && process.env.KIKI_S19_TSX_READY === '1') {
  const args = process.argv.slice(2);
  const tier = args.includes('--tier=smoke') || args.includes('--smoke') ? 'smoke' : 'full';
  const outIdx = args.indexOf('--out-json');
  const outJsonPath = outIdx >= 0 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : null;
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx >= 0 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : undefined;

  const report = await runScenarioS19JournalBombardment({
    tier,
    includeExtreme: tier === 'full' || args.includes('--extreme'),
    dir,
    progress: (msg) => console.log(`[s19] ${msg}`),
  });

  if (outJsonPath) {
    fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
    fs.writeFileSync(outJsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.passed ? 0 : 1);
}
