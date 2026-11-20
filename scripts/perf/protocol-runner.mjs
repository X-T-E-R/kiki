import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { EventLoopWindowMonitor, quantiles, roundMb, roundMs } from './metrics.mjs';

const kapRequire = createRequire(new URL('../../packages/kap-server/package.json', import.meta.url));
const { WebSocket } = kapRequire('ws');

const PERF_HOST_IDENTITY = {
  productName: 'kiki-perf-harness',
  version: '0.0.0-perf',
  platform: 'perf_local',
};

const DEFAULT_PERF_MAX_CONTEXT_SIZE = 200_000;
const SAFE_MODEL_ALIAS_RE = /^[A-Za-z0-9._:/-]+$/u;

function collectStagedModelAliases(homeDir) {
  const aliases = new Set(['mock-fast']);
  const sessionsRoot = path.join(homeDir, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return [...aliases];
  let wsEntries = [];
  try {
    wsEntries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return [...aliases];
  }
  for (const wsEntry of wsEntries) {
    if (!wsEntry.isDirectory()) continue;
    const wsDir = path.join(sessionsRoot, wsEntry.name);
    let sessEntries = [];
    try {
      sessEntries = fs.readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessEntry of sessEntries) {
      if (!sessEntry.isDirectory()) continue;
      const statePath = path.join(wsDir, sessEntry.name, 'state.json');
      try {
        const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (!raw?.agents || typeof raw.agents !== 'object') continue;
        for (const meta of Object.values(raw.agents)) {
          if (
            meta &&
            typeof meta === 'object' &&
            typeof meta.model === 'string' &&
            meta.model.length > 0 &&
            meta.model.length <= 160 &&
            SAFE_MODEL_ALIAS_RE.test(meta.model) &&
            (meta.executor === undefined || meta.executor === 'native')
          ) {
            aliases.add(meta.model);
          }
        }
      } catch {
        // Ignore unreadable state files while building read-only catalog.
      }
    }
  }
  return [...aliases].toSorted();
}

function createReadOnlyPerfModelCatalog(homeDir) {
  const aliases = collectStagedModelAliases(homeDir);
  const catalogItems = aliases.map((modelId) => ({
    id: modelId,
    provider_id: 'perf-mock',
    enabled: true,
    remote_id: modelId,
    display_name: modelId,
    max_context_size: DEFAULT_PERF_MAX_CONTEXT_SIZE,
    capabilities: ['thinking', 'tool_use'],
    effective_capabilities: ['thinking', 'tool_use'],
    protocol: 'openai_responses',
    effective_protocol: 'openai_responses',
    protocol_source: 'model',
    endpoint_source: 'config',
    auth_source: 'config',
    support_efforts: ['low', 'medium', 'high'],
    default_effort: 'high',
  }));
  const modelsById = new Map(
    aliases.map((modelId) => [
      modelId,
      {
        id: modelId,
        name: modelId,
        aliases: [modelId],
        protocol: 'openai_responses',
        protocolSource: 'model',
        baseUrl: 'https://example.test/v1',
        headers: {},
        capabilities: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
          dynamically_loaded_tools: false,
        },
        maxContextSize: DEFAULT_PERF_MAX_CONTEXT_SIZE,
        displayName: modelId,
        supportEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        alwaysThinking: false,
        providerType: 'openai_responses',
        providerName: 'perf-mock',
        imagePolicy: { acceptedTypes: [], convertUnsupported: false },
        authProvider: {
          canRefresh: false,
          getAuth: async () => undefined,
        },
      },
    ]),
  );
  const perfProvider = {
    id: 'perf-mock',
    enabled: true,
    type: 'openai_responses',
    service: 'chat',
    base_url: 'https://example.test/v1',
    effective_base_url: 'https://example.test/v1',
    default_model: aliases[0] ?? 'mock-fast',
    has_api_key: true,
    status: 'ready',
    models: aliases,
    model_source: 'static',
  };

  return {
    _serviceBrand: undefined,
    get: (id) => {
      const found = modelsById.get(id);
      if (!found) {
        throw new Error(`read-only perf catalog model not found: ${id}`);
      }
      return found;
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
    findByName: (name) => aliases.filter((alias) => alias === name || alias.endsWith(`/${name}`)),
    listModels: async () => catalogItems,
    listProviders: async () => [perfProvider],
    getProvider: async (providerId) => {
      if (providerId === perfProvider.id) return perfProvider;
      throw new Error(`read-only perf catalog provider not found: ${providerId}`);
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
  const seeds = [[IModelCatalog, createReadOnlyPerfModelCatalog(homeDir)]];
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

export async function runProtocolSuite({ endpoint, token, samples, warmupSessionId = null, maxScrollPages = 4 }) {
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
    const started = performance.now();
    const res = await countedFetch(`${endpoint}${urlPath}`, { headers });
    const text = await res.text();
    const elapsedMs = roundMs(performance.now() - started);
    netCounter.headerBytes += Buffer.byteLength(text);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, elapsedMs, bytes: Buffer.byteLength(text), body: parsed };
  };

  const timedCall = async (fn) => {
    const started = performance.now();
    try {
      const value = await fn();
      return { ok: true, elapsedMs: roundMs(performance.now() - started), value };
    } catch (error) {
      return {
        ok: false,
        elapsedMs: roundMs(performance.now() - started),
        code: typeof error?.code === 'number' ? error.code : null,
      };
    }
  };

  try {
    netCounter.requests = 0;
    netCounter.headerBytes = 0;
    eld.beginWindow();
    const listStarted = performance.now();
    let [sessionsList, sessionHeads, sessionsQuery] = await Promise.all([
      getJson('/api/sessions?page_size=50'),
      getJson('/api/personas/session-heads?per_persona_limit=5'),
      getJson('/api/sessions/query?page_size=50'),
    ]);
    const catalogDeadline = performance.now() + 5_000;
    while (
      performance.now() < catalogDeadline &&
      (sessionsList.body?.code === 40939 || sessionHeads.body?.code === 40939 || sessionsQuery.body?.code === 40939)
    ) {
      await sleep(50);
      [sessionsList, sessionHeads, sessionsQuery] = await Promise.all([
        sessionsList.body?.code === 40939 ? getJson('/api/sessions?page_size=50') : Promise.resolve(sessionsList),
        sessionHeads.body?.code === 40939 ? getJson('/api/personas/session-heads?per_persona_limit=5') : Promise.resolve(sessionHeads),
        sessionsQuery.body?.code === 40939 ? getJson('/api/sessions/query?page_size=50') : Promise.resolve(sessionsQuery),
      ]);
    }
    const coldCatalogMs = roundMs(performance.now() - listStarted);
    const coldCatalogEld = eld.endWindow();
    if (warmupSessionId) {
      const warmupKlient = createKlient({ endpoint, token, fetch, WebSocket, timeoutMs: 15_000 });
      await Promise.all([
        fetch(`${endpoint}/api/sessions/${warmupSessionId}/status`, { headers }).then((r) => r.text()).catch(() => null),
        warmupKlient.global.agentPanel.read({ session_id: warmupSessionId, agent_id: 'main' }).catch(() => null),
      ]);
      await warmupKlient.close?.().catch?.(() => undefined);
    }
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
          getJson(`/api/sessions/${sample.sandboxId}/status`),
          getJson(`/api/sessions/${sample.sandboxId}/agents/main/hooks?observe=true`),
          getJson(`/api/sessions/${sample.sandboxId}/skills`),
          getJson(`/api/sessions/${sample.sandboxId}/agents/main/auto-compact?observe=true`),
          getJson(`/api/sessions/${sample.sandboxId}/agents/main/context-strategy?observe=true`),
          timedCall(() => klient.global.agentPanel.read({ session_id: sample.sandboxId, agent_id: 'main' })),
          getJson(`/api/sessions/${sample.sandboxId}/goal`),
        ]);

        const [, sideReads] = await Promise.race([
          Promise.all([openPromise, sideReadsPromise]),
          sleep(45_000).then(() => {
            throw new Error(`Cold open timed out after 45s on ${sample.label}`);
          }),
        ]);

        const [
          sessionGetRes,
          statusRes,
          hooksRes,
          skillsRes,
          autoCompactRes,
          contextStrategyRes,
          agentPanelRes,
          goalRes,
        ] = sideReads;
        const routeTimingsMs = {
          sessionGet: sessionGetRes.elapsedMs,
          status: statusRes.elapsedMs,
          hooks: hooksRes.elapsedMs,
          skills: skillsRes.elapsedMs,
          autoCompact: autoCompactRes.elapsedMs,
          contextStrategy: contextStrategyRes.elapsedMs,
          agentPanelRead: agentPanelRes.elapsedMs,
          goal: goalRes.elapsedMs,
        };
        const maxColdRouteMs = roundMs(Math.max(...Object.values(routeTimingsMs)));
        const routeCodes = {
          status: statusRes.body?.code ?? statusRes.status,
          autoCompact: autoCompactRes.body?.code ?? autoCompactRes.status,
          contextStrategy: contextStrategyRes.body?.code ?? contextStrategyRes.status,
          goal: goalRes.body?.code ?? goalRes.status,
          agentPanelOk: agentPanelRes.ok,
        };

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

        const probeColdAgent = async (agentId, childWireBytes) => {
          netCounter.requests = 0;
          netCounter.headerBytes = 0;
          eld.beginWindow();
          const subStart = performance.now();

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

          sub.setTranscriptGrades({ '*': 'turn', main: 'delta', [agentId]: 'delta' });
          const encodedAid = encodeURIComponent(agentId);
          const [subPageRes, subHooksRes, subAutoCompactRes, subContextStrategyRes, subAgentPanelRes] = await Promise.all([
            fetchOlderPageWithSlices(view, { agentId, pageSize: 20 }),
            getJson(`/api/sessions/${sample.sandboxId}/agents/${encodedAid}/hooks?observe=true`),
            getJson(`/api/sessions/${sample.sandboxId}/agents/${encodedAid}/auto-compact?observe=true`),
            getJson(`/api/sessions/${sample.sandboxId}/agents/${encodedAid}/context-strategy?observe=true`),
            timedCall(() => klient.global.agentPanel.read({ session_id: sample.sandboxId, agent_id: agentId })),
          ]);
          subResetMs = roundMs(performance.now() - subStart);
          await subResetWait;
          const subEld = eld.endWindow();
          const agentRouteTimingsMs = {
            hooks: subHooksRes.elapsedMs,
            autoCompact: subAutoCompactRes.elapsedMs,
            contextStrategy: subContextStrategyRes.elapsedMs,
            agentPanelRead: subAgentPanelRes.elapsedMs,
          };
          return {
            ttfcMs: subResetMs,
            pageMs: subPageRes.elapsedMs,
            slices: subPageRes.slices,
            hooksStatus: subHooksRes.status,
            autoCompactCode: subAutoCompactRes.body?.code ?? subAutoCompactRes.status,
            contextStrategyCode: subContextStrategyRes.body?.code ?? subContextStrategyRes.status,
            agentPanelOk: subAgentPanelRes.ok,
            routeTimingsMs: agentRouteTimingsMs,
            maxRouteMs: roundMs(Math.max(...Object.values(agentRouteTimingsMs))),
            httpRequests: netCounter.requests,
            childWireMb: roundMb(childWireBytes),
            ...subEld,
          };
        };

        let coldSubagent = null;
        if (sample.maxChildAgentId) {
          coldSubagent = await probeColdAgent(sample.maxChildAgentId, sample.maxChildWireBytes);
        }

        let coldBranch = null;
        if (sample.branchAgentId && sample.branchAgentId !== sample.maxChildAgentId) {
          coldBranch = await probeColdAgent(sample.branchAgentId, sample.branchWireBytes ?? 0);
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
            hasBranch: Boolean(sample.branchAgentId),
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
            routeTimingsMs,
            maxColdRouteMs,
            routeCodes,
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
          coldBranch,
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
        maxColdRouteMs: roundMs(
          Math.max(0, ...sampleResults.map((r) => r.coldOpen.maxColdRouteMs ?? 0)),
        ),
        coldRouteMaxQuantiles: quantiles(sampleResults.map((r) => r.coldOpen.maxColdRouteMs ?? 0)),
        maxServerEldP99Ms: roundMs(
          Math.max(
            catalogSummary.eldP99Ms,
            ...sampleResults.map((r) => r.coldOpen.eldP99Ms),
            ...sampleResults.map((r) => r.scrollOlder.eldP99Ms),
            ...sampleResults.map((r) => r.coldSubagent?.eldP99Ms ?? 0),
            ...sampleResults.map((r) => r.coldBranch?.eldP99Ms ?? 0),
          ),
        ),
      },
    };
  } finally {
    eld.dispose();
  }
}
