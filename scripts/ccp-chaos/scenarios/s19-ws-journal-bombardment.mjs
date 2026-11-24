import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import inspector from 'node:inspector';
import module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const { mkdtemp, readFile, rm, stat, writeFile } = fs.promises;
const rawOpen = fs.promises.open;
const rawRename = fs.promises.rename;
let renameFaultInjector = null;
let closeFaultInjector = null;
let fsFaultHooksInstalled = false;

function installFsFaultHooks() {
  if (fsFaultHooksInstalled) return;
  fsFaultHooksInstalled = true;
  fs.promises.rename = async function patchedRename(oldPath, newPath) {
    if (typeof renameFaultInjector === 'function') {
      const err = renameFaultInjector(oldPath, newPath);
      if (err) throw err;
    }
    return rawRename.call(this, oldPath, newPath);
  };
  fs.promises.open = async function patchedOpen(filePath, flags, mode) {
    const fh = await rawOpen.call(this, filePath, flags, mode);
    if (typeof closeFaultInjector === 'function') {
      const predicate = closeFaultInjector;
      const origOwnClose = fh.close.bind(fh);
      fh.close = async function patchedOwnClose() {
        await origOwnClose();
        const err = predicate(filePath);
        if (err) throw err;
      };
    }
    return fh;
  };
}

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
  totalSentCount = 0;
  terminateCalls = 0;
  closeCalls = 0;
  maxRetainedFrames;

  constructor(maxRetainedFrames = 5000) {
    super();
    this.maxRetainedFrames = maxRetainedFrames;
  }

  send(data, _opts, cb) {
    this.totalSentCount += 1;
    if (typeof data === 'string') {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = { _raw: data.slice(0, 64) };
      }
      if (this.maxRetainedFrames > 0) {
        this.sentFrames.push(parsed);
        if (this.sentFrames.length > this.maxRetainedFrames) {
          this.sentFrames.shift();
        }
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
  const perType = new Map();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return { dispose: () => { listeners.delete(fn); } };
    },
    on(type, fn) {
      let set = perType.get(type);
      if (!set) {
        set = new Set();
        perType.set(type, set);
      }
      set.add(fn);
      return { dispose: () => { set.delete(fn); } };
    },
    emit(event) {
      for (const fn of listeners) fn(event);
      const typed = perType.get(event?.type);
      if (typed) {
        for (const fn of typed) fn(event);
      }
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
          if (token === coreTokens.IAgentContextMemoryService) {
            return { get: () => [] };
          }
          if (token === coreTokens.IWireService) {
            return { flush: async () => {} };
          }
          if (token === coreTokens.IAgentScopeContext) {
            return { scope: () => `s19:${sid}:child-1` };
          }
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
              getHandle: (id) => agents.find((a) => a.id === id),
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
          if (token === coreTokens.ISessionMetadata) {
            const meta = {
              id: sid,
              private: false,
              agents: { main: { type: 'main' }, 'child-1': { type: 'subagent', parentAgentId: 'main' } },
            };
            return {
              snapshot: () => meta,
              read: async () => meta,
            };
          }
          if (token === coreTokens.ISessionContext) {
            return { sessionId: sid, ephemeral: false };
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
            size: async () => 0,
            stat: async () => undefined,
            read: async () => undefined,
            readRange: async () => undefined,
            exists: async () => false,
            list: async () => [],
            write: async () => {},
            append: async () => {},
            remove: async () => {},
          };
        }
        if (token === coreTokens.IAppendLogStore) {
          return {
            async *read() {},
            append: () => {},
            flush: async () => {},
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
    installFsFaultHooks();
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
    const [journalMod, encoderMod, broadcasterMod, wsMod, transcriptMod, coreMod] = await Promise.all([
      import(pathToFileURL(path.join(REPO_ROOT, 'packages/kap-server/src/transport/ws/v1/sessionEventJournal.ts')).href),
      import(pathToFileURL(path.join(REPO_ROOT, 'packages/kap-server/src/transport/ws/v1/boundedJsonEncoder.ts')).href),
      import(pathToFileURL(path.join(REPO_ROOT, 'packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts')).href),
      import(pathToFileURL(path.join(REPO_ROOT, 'packages/kap-server/src/transport/ws/v1/wsConnectionV1.ts')).href),
      import(pathToFileURL(path.join(REPO_ROOT, 'packages/kap-server/src/services/transcript/transcriptService.ts')).href),
      import('@kiki/agent-core-v2'),
    ]);
    return { journalMod, encoderMod, broadcasterMod, wsMod, transcriptMod, coreMod };
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
    const { journalMod, encoderMod, broadcasterMod, wsMod, transcriptMod, coreMod } = await loadKapModules();

    const { SessionEventJournal, MAX_SINGLE_JOURNAL_LINE_BYTES, getJournalProcessPendingBytes } = journalMod;
    const { encodeJsonLineBounded } = encoderMod;
    const { SessionEventBroadcaster } = broadcasterMod;
    const { WsConnectionV1 } = wsMod;
    const { TranscriptService } = transcriptMod;

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
    // Cell 1: Single-session 2,000 mixed heavy bombardment + real TranscriptService + dual reconnects
    // -----------------------------------------------------------------------
    progress('S19 [1/6]: Running single-session 2,000-event mixed bombardment with real TranscriptService + modern subscribe_v2/transcript_since + legacy message snapshot parity...');
    const cell1Dir = path.join(workDir, 'cell1-single');
    fs.mkdirSync(cell1Dir, { recursive: true });

    const { result: cell1, sampling: cell1Sampling } = await runWithHeapSampling(async () => {
      const sid = 's19_single';
      const { core, sessions } = createSessionHarness(coreMod, [sid]);
      const harness = sessions.get(sid);
      const transcriptService = new TranscriptService({ homeDir: cell1Dir, core });
      transcriptService.forSessionLive(sid);
      await transcriptService.whenReady(sid);
      const broadcaster = new SessionEventBroadcaster({ eventsDir: cell1Dir, core, transcriptService });
      const connectionRegistry = { add: () => {}, remove: () => {} };

      const openWsClient = async (mode, cursor, transcriptSince) => {
        const socket = new InMemoryWsSocket(4000);
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
              ...(cursor ? { cursor } : {}),
              ...(transcriptSince !== undefined && transcriptSince > 0
                ? { transcript_since: { main: transcriptSince } }
                : {}),
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

      const scanModernTranscriptWatermark = (socket, prevSeq) => {
        let maxSeq = prevSeq;
        let opsFrames = 0;
        let resetFrames = 0;
        for (const frame of socket.sentFrames) {
          const ev = frame?.type === 'session_event' ? frame.payload : frame;
          const evType = ev?.type;
          const inner = ev?.payload;
          if (evType === 'transcript.ops' && inner?.agent_id === 'main') {
            opsFrames += 1;
            const s = Number(inner?.through_seq ?? inner?.cursor?.seq ?? 0);
            if (Number.isSafeInteger(s) && s > maxSeq) maxSeq = s;
          } else if (evType === 'transcript.reset' && inner?.agent_id === 'main') {
            resetFrames += 1;
            const s = Number(inner?.cursor?.seq ?? 0);
            if (Number.isSafeInteger(s) && s > maxSeq) maxSeq = s;
          }
        }
        return { maxSeq, opsFrames, resetFrames };
      };

      let modernClient = await openWsClient('modern');
      let legacyClient = await openWsClient('legacy');
      let modernCursor = await broadcaster.getCursor(sid);
      let legacyCursor = { ...modernCursor };

      let modernExtraResets = 0;
      let legacyGapResyncs = 0;
      let legacySnapshotMessageChecks = 0;
      let legacySnapshotMessageParity = true;
      let modernTranscriptSinceCycles = 0;
      let modernTranscriptOpsCount = 0;
      let lastTranscriptSeq = scanModernTranscriptWatermark(modernClient.socket, 0).maxSeq;
      let reconnectCycles = 0;
      let peakLiveFileBytes = 0;
      let peakTailBytes = 0;
      let expectedAttentionSeq = 0;
      let activeTurnId = 0;

      for (let i = 0; i < mixedSchedule.length; i += 1) {
        const kind = mixedSchedule[i];
        if (i % 50 === 0) {
          activeTurnId += 1;
          harness.mainBus.emit({
            type: 'turn.started',
            turnId: activeTurnId,
            origin: { kind: 'user' },
          });
        }
        if (kind === 'tool_16m') {
          harness.mainBus.emit({
            type: 'tool.result',
            turnId: activeTurnId || 1,
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
        } else if (i % 50 === 49) {
          harness.mainBus.emit({
            type: 'turn.ended',
            turnId: activeTurnId,
            reason: 'completed',
          });
        } else {
          harness.mainBus.emit({
            type: 'tool.call.started',
            turnId: activeTurnId || 1,
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

          const beforeCloseScan = scanModernTranscriptWatermark(modernClient.socket, lastTranscriptSeq);
          lastTranscriptSeq = beforeCloseScan.maxSeq;
          modernTranscriptOpsCount += beforeCloseScan.opsFrames;

          modernClient.conn.close();
          legacyClient.conn.close();
          reconnectCycles += 1;

          const modernReplay = await broadcaster.getBufferedSince(sid, modernCursor, undefined, { '*': 'delta' });
          if (modernReplay.resyncRequired !== false) {
            modernExtraResets += 1;
          }
          modernClient = await openWsClient('modern', modernCursor, lastTranscriptSeq);
          if (lastTranscriptSeq > 0) modernTranscriptSinceCycles += 1;
          const modernAckResync = modernClient.ack?.payload?.resync_required?.includes(sid);
          if (modernAckResync) {
            modernExtraResets += 1;
          }
          const afterOpenScan = scanModernTranscriptWatermark(modernClient.socket, lastTranscriptSeq);
          lastTranscriptSeq = afterOpenScan.maxSeq;
          modernTranscriptOpsCount += afterOpenScan.opsFrames;
          modernCursor = { seq: modernReplay.currentSeq, epoch: modernReplay.epoch };

          legacyClient = await openWsClient('legacy', legacyCursor);
          const legacyResync = legacyClient.ack?.payload?.resync_required?.includes(sid);
          if (legacyResync) {
            legacyGapResyncs += 1;
            const snap = await broadcaster.getSnapshotState(sid, { captureMessages: true });
            legacySnapshotMessageChecks += 1;
            const expectedCtx = harness.getContext();
            if (
              snap.contextMessageCount !== expectedCtx.length ||
              snap.contextMessages.length !== expectedCtx.length ||
              (expectedCtx.length > 0 && snap.contextMessages.at(-1) !== expectedCtx.at(-1))
            ) {
              legacySnapshotMessageParity = false;
            }
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
      const finalSnapshot = await broadcaster.getSnapshotState(sid, { captureMessages: true });
      const liveMetrics = broadcaster.getSessionJournalMetrics(sid);
      const liveTranscriptAgent = transcriptService.forSessionLive(sid)?.getAgent('main');
      const liveTranscriptTurnCount =
        liveTranscriptAgent?.snapshot()?.items?.filter((item) => item.kind === 'turn').length ?? 0;

      modernClient.conn.close();
      legacyClient.conn.close();
      await broadcaster.close();
      transcriptService.dispose();

      const closedFileBytes = (await stat(path.join(cell1Dir, `${sid}.jsonl`))).size;
      const coldPeek = await SessionEventJournal.peekWatermark(path.join(cell1Dir, `${sid}.jsonl`));

      return {
        totalEvents: mixedSchedule.length + 1,
        logicalGiantMiB: 250 * 16 + 16,
        reconnectCycles,
        modernExtraResets,
        legacyGapResyncs,
        legacySnapshotMessageChecks,
        legacySnapshotMessageParity,
        modernTranscriptSinceCycles,
        modernTranscriptOpsCount,
        lastTranscriptSeq,
        liveTranscriptTurnCount,
        modernUnsuppressedResync: modernUnsuppressedReplay.resyncRequired,
        legacyUnsuppressedResync: legacyUnsuppressedReplay.resyncRequired,
        cursorParity:
          modernCursor.seq === legacyCursor.seq &&
          modernCursor.epoch === legacyCursor.epoch &&
          finalCursor.seq === finalSnapshot.seq &&
          finalCursor.epoch === finalSnapshot.epoch &&
          finalCursor.attentionSeq === finalSnapshot.attentionSeq &&
          finalSnapshot.contextMessageCount === harness.getContext().length &&
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
    // Cell 2: 16 concurrent sessions with real WsConnectionV1 targets
    // -----------------------------------------------------------------------
    progress('S19 [2/6]: Running 16 concurrent sessions with real WsConnectionV1 targets sharing 2,000 mixed events (4,000 MiB logical)...');
    const cell2Dir = path.join(workDir, 'cell2-concurrent-16');
    fs.mkdirSync(cell2Dir, { recursive: true });
    const sessionIds16 = Array.from({ length: 16 }, (_, idx) => `s19_c_${idx}`);
    const { core: core16, sessions: sessions16 } = createSessionHarness(coreMod, sessionIds16);
    const bc16 = new SessionEventBroadcaster({ eventsDir: cell2Dir, core: core16 });
    const registry16 = { add: () => {}, remove: () => {} };
    const wsClients16 = [];
    for (const sid of sessionIds16) {
      const socket = new InMemoryWsSocket(16);
      const conn = new WsConnectionV1({
        socket,
        broadcaster: bc16,
        connectionRegistry: registry16,
        remoteAddress: '127.0.0.1',
        userAgent: `s19-c16-${sid}`,
        heartbeatIntervalMs: 0,
      });
      const subId = `sub-${sid}`;
      socket.emit('message', JSON.stringify({
        type: 'subscribe_v2',
        id: subId,
        payload: { session_id: sid, transcript: { '*': 'delta' }, transcript_coverage_version: 2 },
      }));
      await waitForAck(socket, subId);
      wsClients16.push({ sid, socket, conn });
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

    let c16RealTargetsTotalSent = 0;
    for (const c of wsClients16) {
      c16RealTargetsTotalSent += c.socket.totalSentCount;
      c.conn.close();
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
      realTargetsTotalSent: c16RealTargetsTotalSent,
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
    // Cell 3: Extreme tier 2,000 x 16 MiB = 31.25 GiB logical with real WsConnectionV1 target
    // -----------------------------------------------------------------------
    let cell3 = { skipped: !includeExtreme };
    if (includeExtreme) {
      progress('S19 [3/6]: Running extreme tier 2,000 x 16 MiB (31.25 GiB logical payload) with real WsConnectionV1 target...');
      const cell3Dir = path.join(workDir, 'cell3-extreme-31g');
      fs.mkdirSync(cell3Dir, { recursive: true });
      const sid = 's19_extreme';
      const { core: coreExt, sessions: sessionsExt } = createSessionHarness(coreMod, [sid]);
      const bcExt = new SessionEventBroadcaster({ eventsDir: cell3Dir, core: coreExt });
      const extSocket = new InMemoryWsSocket(16);
      const extConn = new WsConnectionV1({
        socket: extSocket,
        broadcaster: bcExt,
        connectionRegistry: { add: () => {}, remove: () => {} },
        remoteAddress: '127.0.0.1',
        userAgent: 's19-extreme-modern',
        heartbeatIntervalMs: 0,
      });
      extSocket.emit('message', JSON.stringify({
        type: 'subscribe_v2',
        id: 'sub-ext',
        payload: { session_id: sid, transcript: { '*': 'delta' }, transcript_coverage_version: 2 },
      }));
      await waitForAck(extSocket, 'sub-ext');
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
      const extRealTargetSent = extSocket.totalSentCount;
      extConn.close();
      await bcExt.close();
      const extClosedBytes = (await stat(path.join(cell3Dir, `${sid}.jsonl`))).size;
      const postExtMem = forceGcAndRss();
      cell3 = {
        skipped: false,
        events: extCount,
        logicalGiB: roundNum((extCount * 16) / 1024, 2),
        finalSeq: extCursor.seq,
        realTargetSent: extRealTargetSent,
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
    // Cell 4: Write amplification dual windows:
    //   Window A: midway [B0, 2*B0) (~6 MiB) prefill + 1,000 small events (zero thrash)
    //   Window B: >= 1,100 bounded events crossing >= 3 full rotations (<= 2.5x)
    //   plus separate closeConvergenceTempBytes reporting
    // -----------------------------------------------------------------------
    progress('S19 [4/6]: Measuring dual write-amplification windows (midway [B0,2B0)+1000 small events AND >=3 full rotations)...');
    const cell4Dir = path.join(workDir, 'cell4-write-amp');
    fs.mkdirSync(cell4Dir, { recursive: true });
    const b0 = 4 * MiB;

    const midwayPath = path.join(cell4Dir, 'amp_midway_small.jsonl');
    const midwayJournal = await SessionEventJournal.open(midwayPath, undefined, 4000, b0);
    const pad16k = 'w'.repeat(16 * KiB);
    // Pre-fill to ~6 MiB (1.5 * B0, safely in [B0, 2*B0))
    for (let i = 1; i <= 380; i += 1) {
      midwayJournal.append(midwayJournal.nextSeq(), {
        type: 'event.session.work_changed',
        seq: i,
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: { agentId: 'main', pad: pad16k },
      });
      if (i % 16 === 0) await midwayJournal.flush();
    }
    await midwayJournal.flush();
    const midwayPrefillStats = midwayJournal.stats();
    const midwayPrefillBytes = (await stat(midwayPath)).size;

    const smallPad = 's'.repeat(160);
    for (let i = 1; i <= 1000; i += 1) {
      const seq = midwayJournal.nextSeq();
      midwayJournal.append(seq, {
        type: 'event.session.work_changed',
        seq,
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: { agentId: 'main', pad: smallPad },
      });
      if (i % 50 === 0) await midwayJournal.flush();
    }
    await midwayJournal.flush();
    const midwayAfterStats = midwayJournal.stats();
    const midwayPeakLiveBytes = (await stat(midwayPath)).size;
    await midwayJournal.close();
    const midwayAfterCloseStats = midwayJournal.stats();
    const midwayClosedBytes = (await stat(midwayPath)).size;
    const midwayDeltaAppended = midwayAfterStats.appendedBytes - midwayPrefillStats.appendedBytes;
    const midwayDeltaCompact = midwayAfterStats.compactedTempBytes - midwayPrefillStats.compactedTempBytes;
    const midwayDeltaValid = midwayAfterStats.validBoundedLineBytes - midwayPrefillStats.validBoundedLineBytes;
    const midwaySmallRotations = midwayAfterStats.compactionCount - midwayPrefillStats.compactionCount;
    const midwaySmallWriteAmplification =
      midwayDeltaValid > 0 ? (midwayDeltaAppended + midwayDeltaCompact) / midwayDeltaValid : Infinity;

    const ampPath = path.join(cell4Dir, 'amp_rotations.jsonl');
    const ampJournal = await SessionEventJournal.open(ampPath, undefined, 1000, b0);
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

    // Window B: 1,100 bounded ~16 KiB events (~17.6 MiB valid bounded lines -> >=3 full rotations)
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
      midwayPrefillBytes,
      midwaySmallEvents: 1000,
      midwaySmallRotations,
      midwaySmallWriteAmplification: roundNum(midwaySmallWriteAmplification, 4),
      midwayPeakLiveBytes,
      midwayClosedBytes,
      midwayCloseConvergenceTempBytes: midwayAfterCloseStats.closeCompactedTempBytes,
      prefillFileBytes: prefillFileSize,
      windowEvents: 1100,
      rotationsInWindow: deltaRotations,
      deltaAppendedBytes: deltaAppended,
      deltaCompactedTempBytes: deltaCompactTemp,
      deltaValidBoundedLineBytes: deltaValidBounded,
      writeAmplification: roundNum(writeAmplification, 4),
      statCloseCompactedTempBytes: afterCloseStats.closeCompactedTempBytes,
      closeConvergenceTempBytes: afterCloseStats.closeCompactedTempBytes,
      peakLiveFileBytes: Math.max(ampPeakLiveBytes, midwayPeakLiveBytes),
      closedFileBytes: Math.max(ampClosedBytes, midwayClosedBytes),
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
    const fh = await rawOpen(coldHugePath, 'w');
    try {
      await fh.write(`${headerLine}\n`);
      await fh.write(mkLegacy16m(1, 'turn.ended'));
      await fh.write(mkLegacy16m(2, 'tool.result'));
      await fh.write(mkLegacy16m(3, 'context.spliced'));
    } finally {
      await fh.close();
    }

    const protoProbe = await rawOpen(coldHugePath, 'r');
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
    // Cell 6: Fault injection (short write, zero-progress, rename, close, sync + post-recovery writes)
    // -----------------------------------------------------------------------
    progress('S19 [6/6]: Executing fault injection (short write, zero-progress rollback, rename failure, close/sync failure + post-recovery writes)...');
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
      fj.append(fj.nextSeq(), { type: 'tool.call.started', seq: 4, timestamp: '2026-01-01T00:00:00Z', payload: { afterRecovery: true } });
      await fj.flush();
      const recovered = await fj.readSince(0, 10);
      shortAndZeroRecovered =
        recovered.map((e) => e.seq).join(',') === '1,2,3,4' && !fj.poisoned;
    } finally {
      fhProto.writev = origWritev;
      await fj.close();
    }

    // Real rename failure during compaction + subsequent non-zero recovery write
    const renameFailPath = path.join(cell6Dir, 'fault_rename.jsonl');
    let renameFaultInjected = false;
    let renameFailRecovered = false;
    const rj = await SessionEventJournal.open(renameFailPath, undefined, 2, 64 * KiB);
    try {
      renameFaultInjector = (_oldPath, newPath) => {
        if (!renameFaultInjected && path.resolve(String(newPath)) === path.resolve(renameFailPath)) {
          renameFaultInjected = true;
          return Object.assign(new Error('EACCES injected rename failure'), { code: 'EACCES' });
        }
        return null;
      };
      for (let i = 1; i <= 5; i += 1) {
        rj.append(rj.nextSeq(), { type: 'tool.call.started', seq: i, timestamp: '2026-01-01T00:00:00Z', payload: { n: i } });
        await rj.flush();
      }
      renameFaultInjector = null;
      const failedCount = rj.stats().compactFailureCount;
      rj.append(rj.nextSeq(), { type: 'turn.ended', seq: 6, timestamp: '2026-01-01T00:00:00Z', payload: { recovered: true } });
      await rj.flush();
      const postRenameEntries = await rj.readSince(0, 10);
      const postRenameBytes = (await stat(renameFailPath)).size;
      renameFailRecovered =
        renameFaultInjected &&
        failedCount >= 1 &&
        !rj.poisoned &&
        postRenameBytes > 0 &&
        postRenameEntries.some((e) => e.seq === 6);
    } finally {
      renameFaultInjector = null;
      await rj.close();
    }

    // Real close failure (tail verification + sync retry) + subsequent non-zero write
    const closeFailPath = path.join(cell6Dir, 'fault_close.jsonl');
    let closeFaultInjected = false;
    let closeFailRecovered = false;
    const cj = await SessionEventJournal.open(closeFailPath);
    try {
      closeFaultInjector = (targetPath) => {
        if (!closeFaultInjected && path.resolve(String(targetPath)) === path.resolve(closeFailPath)) {
          closeFaultInjected = true;
          return Object.assign(new Error('EIO injected close'), { code: 'EIO' });
        }
        return null;
      };
      cj.append(cj.nextSeq(), { type: 'turn.started', seq: 1, timestamp: '2026-01-01T00:00:00Z', payload: {} });
      await cj.flush();
      closeFaultInjector = null;
      cj.append(cj.nextSeq(), { type: 'turn.ended', seq: 2, timestamp: '2026-01-01T00:00:00Z', payload: { afterCloseFault: true } });
      await cj.flush();
      const afterCloseFault = await cj.readSince(0, 10);
      closeFailRecovered =
        closeFaultInjected &&
        !cj.poisoned &&
        afterCloseFault.map((e) => e.seq).join(',') === '1,2';
    } finally {
      closeFaultInjector = null;
      await cj.close();
    }

    // Real fsync failure during compaction + clean recovery write
    const syncFailPath = path.join(cell6Dir, 'fault_sync.jsonl');
    const origSync = fhProto.sync;
    let syncFaultInjected = false;
    let syncFailCleanClose = false;
    const sj = await SessionEventJournal.open(syncFailPath, undefined, 2, 64 * KiB);
    try {
      fhProto.sync = async function patchedSync() {
        if (!syncFaultInjected) {
          syncFaultInjected = true;
          throw Object.assign(new Error('EIO injected sync'), { code: 'EIO' });
        }
        return origSync.call(this);
      };
      for (let i = 1; i <= 5; i += 1) {
        sj.append(sj.nextSeq(), { type: 'turn.started', seq: i, timestamp: '2026-01-01T00:00:00Z', payload: { i } });
        await sj.flush();
      }
      fhProto.sync = origSync;
      sj.append(sj.nextSeq(), { type: 'turn.ended', seq: 6, timestamp: '2026-01-01T00:00:00Z', payload: { afterSyncFault: true } });
      await sj.close();
      const syncPeek = await SessionEventJournal.peekWatermark(syncFailPath);
      syncFailCleanClose =
        syncFaultInjected &&
        syncPeek.seq === 6 &&
        (await stat(syncFailPath)).size > 0;
    } finally {
      fhProto.sync = origSync;
    }

    const cell6 = {
      shortAndZeroRecovered,
      renameFailRecovered,
      closeFailRecovered,
      syncFailCleanClose,
      shortInjected,
      zeroInjected,
      renameFaultInjected,
      closeFaultInjected,
      syncFaultInjected,
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
    check(
      cell1.legacySnapshotMessageChecks > 0 && cell1.legacySnapshotMessageParity,
      `cell1 legacy snapshot message parity failed (checks=${cell1.legacySnapshotMessageChecks})`,
    );
    check(
      cell1.modernTranscriptSinceCycles > 0 && cell1.lastTranscriptSeq > 0 && cell1.liveTranscriptTurnCount > 0,
      `cell1 real TranscriptService / transcript_since reconnect failed (cycles=${cell1.modernTranscriptSinceCycles}, seq=${cell1.lastTranscriptSeq}, turns=${cell1.liveTranscriptTurnCount})`,
    );
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

    check(cell2.realTargetsTotalSent >= 16, `cell2 real WsConnectionV1 targets sent=${cell2.realTargetsTotalSent}`);
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
      check(cell3.realTargetSent >= 1, `cell3 real WsConnectionV1 target sent=${cell3.realTargetSent}`);
      check(cell3.peakLiveFileBytes <= BUDGETS.maxLiveFileBytes, `cell3 peakLiveFileBytes=${cell3.peakLiveFileBytes}`);
      check(cell3.closedFileBytes <= BUDGETS.maxClosedFileBytes, `cell3 closedFileBytes=${cell3.closedFileBytes}`);
      check(cell3.peakTailBytes <= BUDGETS.maxTailBytes, `cell3 peakTailBytes=${cell3.peakTailBytes}`);
      check(cell3.maxLineBytes <= BUDGETS.maxLineBytes, `cell3 maxLineBytes=${cell3.maxLineBytes}`);
      check(cell3.maxBatchWriteBytes <= BUDGETS.maxBatchWriteBytes, `cell3 maxBatchWriteBytes=${cell3.maxBatchWriteBytes}`);
      check(cell3.maxSingleAllocBytes < BUDGETS.maxSingleAllocBytes, `cell3 maxSingleAllocBytes=${cell3.maxSingleAllocBytes}`);
      check(cell3.rssDeltaAfterDrainBytes <= BUDGETS.maxPostGcRssDeltaBytes, `cell3 post-GC RSS delta=${roundMiB(cell3.rssDeltaAfterDrainBytes)} MiB > 64 MiB`);
    }

    check(cell4.midwaySmallRotations === 0, `cell4 midway [B0,2B0) small-event window thrashed with ${cell4.midwaySmallRotations} rotations`);
    check(cell4.midwaySmallWriteAmplification <= BUDGETS.maxWriteAmplification, `cell4 midwaySmallWriteAmplification=${cell4.midwaySmallWriteAmplification} > ${BUDGETS.maxWriteAmplification}`);
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
    check(cell6.renameFailRecovered, 'cell6 rename compaction failure recovery failed');
    check(cell6.closeFailRecovered, 'cell6 close failure tail-verify recovery failed');
    check(cell6.syncFailCleanClose, 'cell6 sync failure recovery/close failed');

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
  const tierIdx = args.indexOf('--tier');
  const tierVal = tierIdx >= 0 ? args[tierIdx + 1] : undefined;
  const tier =
    args.includes('--tier=smoke') || args.includes('--smoke') || tierVal === 'smoke' ? 'smoke' : 'full';
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
