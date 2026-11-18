import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import { EventLoopWindowMonitor, quantiles, roundMb, roundMs } from './metrics.mjs';

const kapRequire = createRequire(new URL('../../packages/kap-server/package.json', import.meta.url));
const { WebSocket } = kapRequire('ws');

const PERF_HOST_IDENTITY = {
  productName: 'kiki-perf-harness',
  version: '0.0.0-perf',
  platform: 'perf_local',
};

function createNoopModelCatalog() {
  return {
    _serviceBrand: undefined,
    get: () => {
      throw new Error('modelCatalog.get disabled in read-only perf harness');
    },
    getRequester: () => {
      throw new Error('modelCatalog.getRequester disabled in read-only perf harness');
    },
    getConnectionRequester: () => {
      throw new Error('modelCatalog.getConnectionRequester disabled in read-only perf harness');
    },
    getConnectionEndpoint: () => {
      throw new Error('modelCatalog.getConnectionEndpoint disabled in read-only perf harness');
    },
    inspect: () => {
      throw new Error('modelCatalog.inspect disabled in read-only perf harness');
    },
    ping: () => {
      throw new Error('modelCatalog.ping disabled in read-only perf harness');
    },
    findByName: () => [],
    listModels: async () => [],
    listProviders: async () => [],
    getProvider: async () => {
      throw new Error('modelCatalog.getProvider disabled in read-only perf harness');
    },
    setDefaultModel: async () => {
      throw new Error('modelCatalog.setDefaultModel disabled in read-only perf harness');
    },
  };
}

function createCountedFetch(counterRef) {
  return async (input, init) => {
    counterRef.requests += 1;
    const res = await fetch(input, init);
    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 0) {
      counterRef.headerBytes += contentLength;
    }
    return res;
  };
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function findHydratableContentRef(items) {
  if (!Array.isArray(items)) return null;
  const pickRef = (refs) => {
    if (Array.isArray(refs)) {
      return refs.find((value) => value && typeof value === 'object' && value.source && value.path) ?? null;
    }
    if (refs && typeof refs === 'object') {
      return Object.values(refs).find((value) => value && typeof value === 'object' && value.source && value.path) ?? null;
    }
    return null;
  };
  for (const item of items) {
    if (!item || item.kind !== 'turn') continue;
    const direct = pickRef(item.contentRefs);
    if (direct) return direct;
    if (Array.isArray(item.steps)) {
      for (const step of item.steps) {
        if (!Array.isArray(step.frames)) continue;
        for (const frame of step.frames) {
          const fromFrame = pickRef(frame?.contentRefs);
          if (fromFrame) return fromFrame;
        }
      }
    }
  }
  return null;
}

function extractMediaFileIds(resetEvent, pageEvents = []) {
  const ids = new Set();
  const collectFromAttachments = (attachments) => {
    if (!Array.isArray(attachments)) return;
    for (const att of attachments) {
      const fid = att?.source?.fileId ?? att?.fileId ?? att?.attachmentId;
      if (typeof fid === 'string' && fid.length > 0 && !fid.startsWith('http')) {
        ids.add(fid);
      }
    }
  };
  collectFromAttachments(resetEvent?.snapshot?.attachments ?? resetEvent?.attachments);
  for (const page of pageEvents) {
    collectFromAttachments(page?.attachments);
  }
  return [...ids];
}

async function fetchOlderPageWithSlices(view, { agentId, beforeTurn, beforeItem, pageSize = 40, maxSlices = 24 }) {
  let cursorTurn = beforeTurn;
  let cursorItem = beforeItem;
  let backoffMs = 80;
  let slices = 0;
  const started = performance.now();
  while (slices < maxSlices) {
    slices += 1;
    const page = await view.transcript.page({
      agentId,
      ...(cursorItem ? { beforeItem: cursorItem } : cursorTurn ? { beforeTurn: cursorTurn } : {}),
      pageSize,
    });
    const readiness = page?.read?.readiness ?? page?.read?.kind;
    if (readiness === 'preparing') {
      const cont = page.next_cursor ?? page.read?.continuation;
      if (cont && typeof cont === 'string') {
        cursorItem = cont;
        cursorTurn = undefined;
      }
      await sleep(backoffMs);
      backoffMs = Math.min(1000, backoffMs * 2);
      continue;
    }
    return {
      elapsedMs: roundMs(performance.now() - started),
      slices,
      page,
    };
  }
  return {
    elapsedMs: roundMs(performance.now() - started),
    slices,
    page: null,
    timedOutPreparing: true,
  };
}

async function hydrateContentRefWithRetry(view, { agentId, ref, maxAttempts = 16 }) {
  let backoffMs = 80;
  const started = performance.now();
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const seg = await view.transcript.content({ agentId, ref });
      return {
        ok: Boolean(seg),
        elapsedMs: roundMs(performance.now() - started),
        attempts,
      };
    } catch (error) {
      const code = error?.code;
      if (code === 40923) {
        await sleep(backoffMs);
        backoffMs = Math.min(1000, backoffMs * 2);
        continue;
      }
      return {
        ok: false,
        elapsedMs: roundMs(performance.now() - started),
        attempts,
        errorCode: typeof code === 'number' ? code : 'error',
      };
    }
  }
  return {
    ok: false,
    elapsedMs: roundMs(performance.now() - started),
    attempts,
    errorCode: 'max_attempts',
  };
}

export async function bootPerfServer(homeDir) {
  const [{ IModelCatalog }, { startServer }] = await Promise.all([
    import(new URL('../../packages/agent-core-v2/src/index.ts', import.meta.url).href),
    import(new URL('../../packages/kap-server/src/start.ts', import.meta.url).href),
  ]);
  const bootStarted = performance.now();
  const seeds = [[IModelCatalog, createNoopModelCatalog()]];
  const server = await startServer({
    hostIdentity: PERF_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir,
    logLevel: 'silent',
    seeds,
  });
  const bootMs = roundMs(performance.now() - bootStarted);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const token = server.localOwnerToken;
  return { server, endpoint, token, bootMs };
}

export async function runProtocolSuite({ endpoint, token, samples, maxScrollPages = 4 }) {
  const [{ createKlient }, { TRANSCRIPT_COVERAGE_VERSION }] = await Promise.all([
    import(new URL('../../packages/klient/src/transports/http/index.ts', import.meta.url).href),
    import(new URL('../../packages/transcript/src/index.ts', import.meta.url).href),
  ]);
  const trace = (msg) => {
    if (process.env.KIKI_PERF_TRACE === '1') {
      process.stderr.write(`[perf:trace] ${msg}\n`);
    }
  };
  const eld = new EventLoopWindowMonitor(20);
  const netCounter = { requests: 0, headerBytes: 0 };
  const countedFetch = createCountedFetch(netCounter);
  const headers = { authorization: `Bearer ${token}` };

  const getJson = async (urlPath) => {
    const res = await countedFetch(`${endpoint}${urlPath}`, { headers });
    const text = await res.text();
    netCounter.headerBytes += Buffer.byteLength(text);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, bytes: Buffer.byteLength(text), body: parsed };
  };

  try {
    netCounter.requests = 0;
    netCounter.headerBytes = 0;
    eld.beginWindow();
    const listStarted = performance.now();
    const [sessionsList, sessionHeads, sessionsQuery] = await Promise.all([
      getJson('/api/sessions?limit=50'),
      getJson('/api/personas/session-heads?per_persona_limit=5'),
      getJson('/api/sessions/query?limit=50'),
    ]);
    const coldCatalogMs = roundMs(performance.now() - listStarted);
    const coldCatalogEld = eld.endWindow();
    trace(`catalog done in ${coldCatalogMs}ms (queryItems=${Array.isArray(sessionsQuery.body?.data?.items) ? sessionsQuery.body.data.items.length : 0}, headsStatus=${sessionHeads.status})`);
    const catalogSummary = {
      coldCatalogMs,
      httpRequests: netCounter.requests,
      payloadMb: roundMb(netCounter.headerBytes),
      sessionsListed: Array.isArray(sessionsList.body?.data?.sessions)
        ? sessionsList.body.data.sessions.length
        : Array.isArray(sessionsList.body?.data?.items)
          ? sessionsList.body.data.items.length
          : Array.isArray(sessionsList.body?.data)
            ? sessionsList.body.data.length
            : 0,
      queryItems: Array.isArray(sessionsQuery.body?.data?.items) ? sessionsQuery.body.data.items.length : 0,
      headsStatus: sessionHeads.status,
      ...coldCatalogEld,
    };

    const sampleResults = [];
    for (const sample of samples) {
      trace(`${sample.label} [${sample.stratum}] starting coldOpen...`);
      const klient = createKlient({
        endpoint,
        token,
        fetch: countedFetch,
        WebSocket,
        timeoutMs: 60_000,
      });

      try {
        netCounter.requests = 0;
        netCounter.headerBytes = 0;
        eld.beginWindow();
        const openStarted = performance.now();

        let mainResetMs = null;
        let snapshotMs = null;
        let readyMs = null;
        let mainResetEvent = null;
        let resolveOpen;
        let rejectOpen;
        const openPromise = new Promise((resolve, reject) => {
          resolveOpen = resolve;
          rejectOpen = reject;
        });

        const checkDone = () => {
          if (mainResetMs !== null && readyMs !== null) {
            resolveOpen();
          }
        };

        const view = klient.session(sample.sandboxId).view;
        const sub = view.subscribe(
          {
            sessionCursor: { seq: 0 },
            transcriptGrades: { '*': 'turn', main: 'delta' },
            bootstrap: true,
          },
          (signal) => {
            if (signal.type === 'transcript' && signal.event.agent_id === 'main' && signal.event.type === 'transcript.reset') {
              if (mainResetMs === null) {
                mainResetMs = roundMs(performance.now() - openStarted);
                mainResetEvent = signal.event;
              }
              checkDone();
            } else if (signal.type === 'snapshot') {
              if (snapshotMs === null) {
                snapshotMs = roundMs(performance.now() - openStarted);
              }
            } else if (signal.type === 'ready') {
              if (readyMs === null) {
                readyMs = roundMs(performance.now() - openStarted);
              }
              checkDone();
            } else if (signal.type === 'protocolError') {
              rejectOpen(new Error(`protocolError on ${sample.label}: ${signal.detail ?? 'unknown'}`));
            }
          },
        );

        const sideReadsPromise = Promise.all([
          getJson(`/api/sessions/${sample.sandboxId}`),
          getJson(`/api/sessions/${sample.sandboxId}/agents/main/hooks?observe=true`),
          getJson(`/api/sessions/${sample.sandboxId}/skills`),
        ]);

        await Promise.race([
          Promise.all([openPromise, sideReadsPromise]),
          sleep(45_000).then(() => {
            throw new Error(`Cold open timed out after 45s on ${sample.label}`);
          }),
        ]);

        const coldOpenTotalMs = roundMs(performance.now() - openStarted);
        trace(`${sample.label} coldOpen=${coldOpenTotalMs}ms (reset=${mainResetMs}ms, snap=${snapshotMs}ms, ready=${readyMs}ms)`);
        const coldOpenEld = eld.endWindow();
        const coldOpenHttpRequests = netCounter.requests;
        const coldOpenPayloadMb = roundMb(netCounter.headerBytes);

        const resetSnapshot = mainResetEvent?.snapshot;
        const resetItems = Array.isArray(resetSnapshot?.items) ? resetSnapshot.items : [];
        const resetTurns = resetItems.filter((item) => item.kind === 'turn');
        const hasStepsPartialInReset = resetTurns.some((t) => t.stepsPartial === true);

        netCounter.requests = 0;
        netCounter.headerBytes = 0;
        eld.beginWindow();
        const pageTimingsMs = [];
        const pageSlices = [];
        const fetchedPages = [];
        let cursorTurn = resetTurns.length > 0 ? resetTurns[0].turnId : undefined;
        const canPageOlder = Boolean(resetSnapshot?.hasMoreOlder || mainResetEvent?.coverage?.hasMoreOlder) && Boolean(cursorTurn);

        let hydrationResult = null;
        let candidateRef = findHydratableContentRef(resetItems);

        if (canPageOlder) {
          for (let p = 0; p < maxScrollPages && cursorTurn; p += 1) {
            const reqBefore = netCounter.requests;
            const res = await fetchOlderPageWithSlices(view, {
              agentId: 'main',
              beforeTurn: cursorTurn,
              pageSize: 40,
            });
            pageTimingsMs.push(res.elapsedMs);
            pageSlices.push({ slices: res.slices, httpRequests: netCounter.requests - reqBefore });
            const pageData = res.page;
            if (!pageData || !Array.isArray(pageData.items) || pageData.items.length === 0) break;
            fetchedPages.push(pageData);
            if (!candidateRef) {
              candidateRef = findHydratableContentRef(pageData.items);
            }
            const olderTurns = pageData.items.filter((item) => item.kind === 'turn');
            if (olderTurns.length === 0 || (!pageData.has_more && !pageData.coverage?.hasMoreOlder)) {
              break;
            }
            cursorTurn = olderTurns[0].turnId;
          }
        }

        if (candidateRef) {
          trace(`${sample.label} hydrating ContentRef (${candidateRef.source.kind}:${candidateRef.path.join('.')})...`);
          hydrationResult = await hydrateContentRefWithRetry(view, {
            agentId: 'main',
            ref: candidateRef,
          });
          trace(`${sample.label} hydrated in ${hydrationResult.elapsedMs}ms (attempts=${hydrationResult.attempts})`);
        }

        let mediaProbe = null;
        const mediaIds = extractMediaFileIds(mainResetEvent, fetchedPages).slice(0, 3);
        if (mediaIds.length > 0) {
          const mediaStart = performance.now();
          let okCount = 0;
          for (const fid of mediaIds) {
            const mediaRes = await countedFetch(
              `${endpoint}/api/sessions/${sample.sandboxId}/media/${encodeURIComponent(fid)}/preview`,
              { headers },
            );
            await mediaRes.arrayBuffer().catch(() => undefined);
            if (mediaRes.status === 200) okCount += 1;
          }
          mediaProbe = {
            probedCount: mediaIds.length,
            okCount,
            elapsedMs: roundMs(performance.now() - mediaStart),
          };
        }

        const scrollEld = eld.endWindow();
        const scrollHttpRequests = netCounter.requests;

        let coldSubagent = null;
        if (sample.maxChildAgentId) {
          netCounter.requests = 0;
          netCounter.headerBytes = 0;
          eld.beginWindow();
          const subStart = performance.now();
          const subId = sample.maxChildAgentId;

          let subResetMs = null;
          const subResetWait = new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              clearInterval(checkInterval);
              resolve(value);
            };
            const timer = setTimeout(() => finish(false), 15_000);
            const checkInterval = setInterval(() => {
              if (subResetMs !== null) {
                finish(true);
              }
            }, 10);
          });

          sub.setTranscriptGrades({ '*': 'turn', main: 'delta', [subId]: 'delta' });
          const [subPageRes, subHooksRes] = await Promise.all([
            fetchOlderPageWithSlices(view, { agentId: subId, pageSize: 20 }),
            getJson(`/api/sessions/${sample.sandboxId}/agents/${encodeURIComponent(subId)}/hooks?observe=true`),
          ]);
          subResetMs = roundMs(performance.now() - subStart);
          await subResetWait;
          const subEld = eld.endWindow();
          coldSubagent = {
            ttfcMs: subResetMs,
            pageMs: subPageRes.elapsedMs,
            slices: subPageRes.slices,
            hooksStatus: subHooksRes.status,
            httpRequests: netCounter.requests,
            childWireMb: roundMb(sample.maxChildWireBytes),
            ...subEld,
          };
        }

        sub.close();
        sampleResults.push({
          label: sample.label,
          stratum: sample.stratum,
          descriptor: sample.descriptor,
          structure: {
            mainWireMb: roundMb(sample.mainWireBytes),
            subagentCount: sample.subagentCount,
            maxChildWireMb: roundMb(sample.maxChildWireBytes),
            attachmentCount: sample.totalAttachmentCount,
          },
          coldOpen: {
            ttfcMs: mainResetMs ?? coldOpenTotalMs,
            snapshotMs,
            readyMs: readyMs ?? coldOpenTotalMs,
            totalMs: coldOpenTotalMs,
            httpRequests: coldOpenHttpRequests,
            payloadMb: coldOpenPayloadMb,
            initialTurnCount: resetTurns.length,
            hasStepsPartialInReset,
            ...coldOpenEld,
          },
          scrollOlder: {
            pagesFetched: pageTimingsMs.length,
            pageMsQuantiles: quantiles(pageTimingsMs),
            pageTimingsMs,
            pageSlices,
            httpRequests: scrollHttpRequests,
            canonicalHydration: hydrationResult,
            mediaProbe,
            ...scrollEld,
          },
          coldSubagent,
        });
      } finally {
        await klient.close().catch(() => undefined);
      }
    }

    return {
      transcriptCoverageVersion: TRANSCRIPT_COVERAGE_VERSION,
      catalogSummary,
      sampleResults,
      aggregates: {
        coldOpenTtfcMs: quantiles(sampleResults.map((r) => r.coldOpen.ttfcMs)),
        coldOpenTotalMs: quantiles(sampleResults.map((r) => r.coldOpen.totalMs)),
        olderPageMs: quantiles(sampleResults.flatMap((r) => r.scrollOlder.pageTimingsMs)),
        coldSubagentTtfcMs: quantiles(
          sampleResults.filter((r) => r.coldSubagent !== null).map((r) => r.coldSubagent.ttfcMs),
        ),
        maxServerEldP99Ms: roundMs(
          Math.max(
            catalogSummary.eldP99Ms,
            ...sampleResults.map((r) => r.coldOpen.eldP99Ms),
            ...sampleResults.map((r) => r.scrollOlder.eldP99Ms),
            ...sampleResults.map((r) => r.coldSubagent?.eldP99Ms ?? 0),
          ),
        ),
      },
    };
  } finally {
    eld.dispose();
  }
}
