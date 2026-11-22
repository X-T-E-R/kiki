import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import {
  generateRealDirectoryTree,
  prepopulateHistoryNavigationDb,
  prepopulateSearchIndexV2,
  prepopulateUsageReadModelV2,
  runConcurrentHistoryWalReaders,
} from '../fixtures/real-scale-generators.mjs';
import { loadChaosMatrix, resolveS17MatrixConfig } from '../matrix/loader.mjs';
import {
  listSurvivingWorkloadDescendantsChecked,
  sampleProcessHandleCount,
} from '../telemetry/process-tree.mjs';
import { evaluateS17WorkstationCliffVerdict } from '../verify/verdict.mjs';
import { seedColdCheckpointlessChildSession } from './p01-cold-child-open.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const MiB = 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundMs(val) {
  return Number(Number(val ?? 0).toFixed(2));
}

function summarize(values) {
  if (!values || values.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: roundMs(sorted[0]),
    p50: roundMs(pick(0.5)),
    p95: roundMs(pick(0.95)),
    p99: roundMs(pick(0.99)),
    max: roundMs(sorted.at(-1)),
    mean: roundMs(sum / sorted.length),
  };
}

function encodeToolPlan(plan) {
  return `[V23_TOOL_PLAN:${Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url')}]`;
}

async function apiJson(endpoint, token, method, urlPath, body, timeoutMs = 25_000) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}${urlPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, rawText: text.slice(0, 300), elapsedMs: roundMs(performance.now() - t0) };
  } catch (error) {
    return {
      status: 0,
      json: null,
      rawText: '',
      error: error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error),
      elapsedMs: roundMs(performance.now() - t0),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function submitAndWaitTurn(endpoint, token, sessionId, text, timeoutMs = 45_000) {
  const t0 = performance.now();
  const promptId = `p_s17_${randomUUID().slice(0, 10)}`;
  const submit = await apiJson(
    endpoint,
    token,
    'POST',
    `/api/sessions/${encodeURIComponent(sessionId)}/prompts`,
    { prompt_id: promptId, content: [{ type: 'text', text }] },
    timeoutMs,
  );
  const admissionMs = submit.elapsedMs;
  if (submit.status !== 200 || submit.json?.code !== 0) {
    return {
      ok: false,
      promptId,
      stage: 'submit',
      status: submit.status,
      code: submit.json?.code ?? submit.error ?? 'error',
      msg: submit.json?.msg ?? submit.rawText,
      admissionMs,
      totalMs: roundMs(performance.now() - t0),
    };
  }
  const deadline = performance.now() + timeoutMs;
  let observedBusy = false;
  while (performance.now() < deadline) {
    const st = await apiJson(endpoint, token, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/status`, undefined, 10_000);
    const data = st.json?.data;
    if (st.status === 200 && data) {
      const busy =
        data.busy === true ||
        data.executing === true ||
        data.main_turn_active === true ||
        data.state === 'running' ||
        data.loop?.status === 'running';
      if (busy) {
        observedBusy = true;
        await sleep(50);
        continue;
      }
      const sessRes = await apiJson(endpoint, token, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}`, undefined, 10_000);
      const sessData = sessRes.json?.data;
      const reason =
        data.last_turn_reason ??
        data.lastTurnReason ??
        sessData?.last_turn_reason ??
        sessData?.lastTurnReason ??
        null;
      const sessBusy = sessData?.busy === true || sessData?.executing === true || sessData?.main_turn_active === true;
      if (sessBusy || (reason === null && !observedBusy && performance.now() - t0 < 500)) {
        await sleep(50);
        continue;
      }
      if (reason === null) {
        await sleep(50);
        continue;
      }
      return {
        ok: true,
        completed: reason === 'completed',
        promptId,
        admissionMs,
        totalMs: roundMs(performance.now() - t0),
        lastTurnReason: reason,
        observedBusy,
      };
    }
    await sleep(60);
  }
  return { ok: false, completed: false, promptId, stage: 'settle_timeout', admissionMs, totalMs: roundMs(performance.now() - t0) };
}

async function startStalledMockServers({ mcpStallMs, sshStallMs }) {
  const mcpSockets = new Set();
  let mcpConnectionsAccepted = 0;
  const mcpServer = http.createServer((req, res) => {
    mcpConnectionsAccepted += 1;
    mcpSockets.add(req.socket);
    req.socket.once('close', () => mcpSockets.delete(req.socket));
    const timer = setTimeout(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(504, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'synthetic_mcp_stall_timeout' }));
      }
    }, mcpStallMs);
    req.once('close', () => clearTimeout(timer));
  });
  await new Promise((resolve, reject) => {
    mcpServer.once('error', reject);
    mcpServer.listen(0, '127.0.0.1', resolve);
  });
  const mcpPort = mcpServer.address().port;

  const sshSockets = new Set();
  let sshConnectionsAccepted = 0;
  const sshServer = net.createServer((socket) => {
    sshConnectionsAccepted += 1;
    sshSockets.add(socket);
    socket.once('close', () => sshSockets.delete(socket));
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {}
    }, sshStallMs);
    socket.once('close', () => clearTimeout(timer));
  });
  await new Promise((resolve, reject) => {
    sshServer.once('error', reject);
    sshServer.listen(0, '127.0.0.1', resolve);
  });
  const sshPort = sshServer.address().port;

  return {
    mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
    sshPort,
    getCounts: () => ({ mcpConnectionsAccepted, sshConnectionsAccepted }),
    close: async () => {
      for (const s of mcpSockets) {
        try {
          s.destroy();
        } catch {}
      }
      for (const s of sshSockets) {
        try {
          s.destroy();
        } catch {}
      }
      await Promise.all([
        new Promise((resolve) => mcpServer.close(() => resolve())),
        new Promise((resolve) => sshServer.close(() => resolve())),
      ]);
    },
  };
}

/**
 * Pre-populates the three real SQLite stores (`search-index-v2`, `history-navigation`,
 * `usage-read-model-v2`) BEFORE server boot so `kap-server` opens them live with real data.
 */
export function prepopulateS17SqliteStores({ homeDir, workspaceId, sessionIds, s17Config }) {
  const sqCfg = s17Config.sqliteContention;
  const searchNeedle = 'WORKSTATION_CLIFF_SEARCH_NEEDLE';
  const navNeedle = 'HISTORY_NAV_WAL_NEEDLE';
  const searchSeed = prepopulateSearchIndexV2({
    homeDir,
    workspaceId,
    sessionIds,
    docCount: sqCfg.searchSeedDocs,
    needleToken: searchNeedle,
  });
  const historyNavSeed = prepopulateHistoryNavigationDb({
    homeDir,
    workspaceId,
    sessionIds,
    rowCount: sqCfg.historyNavSeedRows,
    needleToken: navNeedle,
  });
  const usageSeed = prepopulateUsageReadModelV2({
    homeDir,
    workspaceId,
    sessionIds,
    factCount: sqCfg.usageSeedFacts,
  });
  return { searchSeed, historyNavSeed, usageSeed };
}

/**
 * Scenario S17: Empirical Workstation-Cliff Stress & Chaos Gate.
 * Covers all live 2026-11-22 empirical cliffs:
 *   1. Dual WorkspacePathIndex real-directory cliffs (sub-overflow + >250k non-Git umbrella, zero symlinks)
 *   2. Real [search] + multi-store SQLite contention (search-index-v2 FTS5 + history-navigation WAL + usage v2)
 *   3. Multi-session concurrent writers + simultaneous cold giant main & checkpointless child wire opens
 *   4. Synchronized 429 (Retry-After / x-should-retry) & 524 upstream faults
 *   5. Slow/stalled MCP & SSH mock endpoints with healthz latency probe
 *   6. Resident-session eviction memory/handle drain
 *   7. Windows native process-helper contention (win32 Bash bursts under CPU worker load)
 */
export async function runScenarioS17WorkstationCliff({
  server,
  twin,
  corpus,
  matrix = null,
  tier = 'smoke',
  sqliteSeeds = null,
  workRoot,
  progress = () => {},
}) {
  const startedAt = performance.now();
  const loadedMatrix = matrix ?? loadChaosMatrix(tier);
  const effectiveTier = loadedMatrix.tier === 'full' ? 'full' : 'smoke';
  const cfg = resolveS17MatrixConfig(loadedMatrix);
  const runId = `s17_${randomUUID().slice(0, 8)}`;
  const scratchRoot = path.join(workRoot || corpus.rootDir || os.tmpdir(), `s17-cliff-${runId}`);
  fs.mkdirSync(scratchRoot, { recursive: true });

  const { workspacePathInventory } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/agent-core-v2/src/os/backends/node-local/workspacePathInventory.ts')).href
  );

  await server.resetWindow();
  const preMetrics = await server.metrics(true);
  const createdSessionIds = [];
  const createSession = async (title, cwd) => {
    const res = await apiJson(server.endpoint, server.token, 'POST', '/api/sessions', {
      title,
      metadata: { cwd },
    });
    if (res.status !== 200 || res.json?.code !== 0 || !res.json?.data?.id) {
      throw new Error(`S17 createSession(${title}) failed: ${JSON.stringify(res)}`);
    }
    createdSessionIds.push(res.json.data.id);
    return res.json.data.id;
  };

  try {
    // ------------------------------------------------------------------
    // 1. Dual WorkspacePathIndex Real-Directory Cliffs (ZERO symlinks!)
    // ------------------------------------------------------------------
    const cliffCfg = cfg.workspacePathCliffs;
    progress(
      `S17 [1/7]: Generating dual real-directory WorkspacePathIndex trees (sub=${cliffCfg.subOverflowFiles} < cap=${cliffCfg.inventoryLimit} < umbrella=${cliffCfg.umbrellaOverflowFiles}, zero symlinks)...`,
    );
    const subRoot = path.join(scratchRoot, 'sub-overflow-git');
    const umbrellaRoot = path.join(scratchRoot, 'umbrella-overflow-nongit');
    const [subTree, umbrellaTree] = await Promise.all([
      generateRealDirectoryTree({
        rootDir: subRoot,
        fileCount: cliffCfg.subOverflowFiles,
        isGitRepo: true,
        needlePrefix: 'SUB_CLIFF_NEEDLE',
      }),
      generateRealDirectoryTree({
        rootDir: umbrellaRoot,
        fileCount: cliffCfg.umbrellaOverflowFiles,
        isGitRepo: false,
        needlePrefix: 'UMBRELLA_CLIFF_NEEDLE',
      }),
    ]);

    const subInvT0 = performance.now();
    const subInv = workspacePathInventory(subRoot, cliffCfg.inventoryLimit);
    const subInvMs = roundMs(performance.now() - subInvT0);

    const overInvT0 = performance.now();
    const overInv = workspacePathInventory(umbrellaRoot, cliffCfg.inventoryLimit);
    const overInvMs = roundMs(performance.now() - overInvT0);

    const subNeedle = subTree.sampleNeedles[0]?.needle ?? 'SUB_CLIFF_NEEDLE_000000';
    const umbrellaNeedle = umbrellaTree.sampleNeedles[0]?.needle ?? 'UMBRELLA_CLIFF_NEEDLE_000000';

    const [subSessionId, umbrellaSessionId] = await Promise.all([
      createSession(`S17 Sub-Overflow Cliff ${runId}`, subRoot),
      createSession(`S17 Umbrella Overflow Cliff ${runId}`, umbrellaRoot),
    ]);

    const preCliffTools = twin.getStats().toolStats;
    const subMutatedFile = `pkg_00/cliff_mutated_${runId}.ts`;
    const subPlan = encodeToolPlan({
      steps: [
        {
          calls: [
            { name: 'Glob', input: { pattern: '**/*.ts' } },
            { name: 'Grep', input: { pattern: subNeedle, output_mode: 'files_with_matches' } },
            {
              name: 'Bash',
              input: {
                command: `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('${subMutatedFile}', 'export const MUTATED = 1;'); console.log('sub_cliff_ok')"`,
                description: 'Trigger WorkspacePathIndex invalidation under concurrent Glob+Grep',
              },
            },
          ],
        },
        {
          calls: [
            { name: 'Glob', input: { pattern: 'pkg_00/**/*.ts' } },
            { name: 'Grep', input: { pattern: subNeedle, output_mode: 'content' } },
          ],
        },
      ],
      finalText: 'S17_SUB_CLIFF_OK',
    });

    const umbrellaPlan = encodeToolPlan({
      steps: [
        {
          calls: [
            { name: 'Glob', input: { pattern: 'pkg_00/**/*.ts' } },
            { name: 'Grep', input: { pattern: umbrellaNeedle, output_mode: 'files_with_matches' } },
            {
              name: 'Bash',
              input: {
                command: `${JSON.stringify(process.execPath)} -e "console.log('umbrella_cliff_ok')"`,
                description: 'Verify non-Git umbrella fallback does not starve cpuWorker',
              },
            },
          ],
        },
      ],
      finalText: 'S17_UMBRELLA_CLIFF_OK',
    });

    const extraProbeCount = Math.max(2, Number(cliffCfg.concurrentToolProbes ?? 2));
    const [subToolRes, umbrellaToolRes, ...fsSearchProbes] = await Promise.all([
      submitAndWaitTurn(server.endpoint, server.token, subSessionId, `[CHAOS_SCOPE:s17_sub_${runId}] ${subPlan}`, 60_000),
      submitAndWaitTurn(server.endpoint, server.token, umbrellaSessionId, `[CHAOS_SCOPE:s17_over_${runId}] ${umbrellaPlan}`, 60_000),
      ...Array.from({ length: extraProbeCount }, (_, pi) =>
        apiJson(
          server.endpoint,
          server.token,
          'POST',
          `/api/sessions/${encodeURIComponent(pi % 2 === 0 ? subSessionId : umbrellaSessionId)}/fs:search`,
          { query: 'file_00000', limit: 20 },
          20_000,
        ),
      ),
    ]);
    const postMutationFsSearch = await apiJson(
      server.endpoint,
      server.token,
      'POST',
      `/api/sessions/${encodeURIComponent(subSessionId)}/fs:search`,
      { query: `cliff_mutated_${runId}`, limit: 10 },
      20_000,
    );
    const postCliffTools = twin.getStats().toolStats;
    const toolDeltaOk = (name) => Math.max(0, (postCliffTools[name]?.resultsOk ?? 0) - (preCliffTools[name]?.resultsOk ?? 0));
    const toolDeltaErr = (name) => Math.max(0, (postCliffTools[name]?.resultsError ?? 0) - (preCliffTools[name]?.resultsError ?? 0));
    const cliffToolEvidence = {
      concurrentProbesExecuted: fsSearchProbes.length,
      concurrentProbesSucceeded: fsSearchProbes.filter((r) => r.status === 200 && r.json?.code === 0).length,
      postMutationFileVisible:
        postMutationFsSearch.status === 200 &&
        postMutationFsSearch.json?.code === 0 &&
        JSON.stringify(postMutationFsSearch.json?.data ?? '').includes(`cliff_mutated_${runId}`),
      bashResultsOk: toolDeltaOk('Bash'),
      globResultsOk: toolDeltaOk('Glob'),
      grepResultsOk: toolDeltaOk('Grep'),
      toolErrors: toolDeltaErr('Bash') + toolDeltaErr('Glob') + toolDeltaErr('Grep'),
    };
    const cliffToolsClean =
      cliffToolEvidence.bashResultsOk >= 2 &&
      cliffToolEvidence.globResultsOk >= 3 &&
      cliffToolEvidence.grepResultsOk >= 3 &&
      cliffToolEvidence.toolErrors === 0 &&
      cliffToolEvidence.concurrentProbesSucceeded === cliffToolEvidence.concurrentProbesExecuted &&
      cliffToolEvidence.postMutationFileVisible;

    const workspacePathCliffs = {
      inventoryLimit: cliffCfg.inventoryLimit,
      symlinksUsed: subTree.symlinksUsed + umbrellaTree.symlinksUsed,
      toolEvidence: cliffToolEvidence,
      subOverflow: {
        fileCount: subTree.sourceFileCount,
        totalEntries: subTree.totalEntries,
        generationMs: subTree.elapsedMs,
        inventoryMs: subInvMs,
        overflow: subInv.overflow,
        entryCount: subInv.entries.length,
        concurrentToolsPassed: Boolean(subToolRes.completed && cliffToolsClean),
        toolTurnMs: subToolRes.totalMs,
        error: subToolRes.completed && cliffToolsClean ? null : JSON.stringify({ subToolRes, cliffToolEvidence }),
      },
      umbrellaOverflow: {
        fileCount: umbrellaTree.sourceFileCount,
        totalEntries: umbrellaTree.totalEntries,
        isNonGit: !fs.existsSync(path.join(umbrellaRoot, '.git')),
        generationMs: umbrellaTree.elapsedMs,
        inventoryMs: overInvMs,
        overflow: overInv.overflow,
        fallbackToolsPassed: Boolean(umbrellaToolRes.completed && cliffToolsClean),
        toolTurnMs: umbrellaToolRes.totalMs,
        error: umbrellaToolRes.completed && cliffToolsClean ? null : JSON.stringify({ umbrellaToolRes, cliffToolEvidence }),
      },
    };

    // ------------------------------------------------------------------
    // 2. Real [search] + Multi-Store SQLite Contention
    // ------------------------------------------------------------------
    const sqCfg = cfg.sqliteContention;
    progress(
      `S17 [2/7]: Running real [search] + multi-store SQLite contention (search=${sqCfg.concurrentSearchQueries}, walReaders=${sqCfg.concurrentWalReaders})...`,
    );
    const configToml = fs.existsSync(path.join(corpus.homeDir, 'config.toml'))
      ? fs.readFileSync(path.join(corpus.homeDir, 'config.toml'), 'utf8')
      : '';
    const searchEnabled = /\[search\][\s\S]*?enabled\s*=\s*true/u.test(configToml);

    const searchNeedle = sqliteSeeds?.searchSeed?.needleToken ?? 'WORKSTATION_CLIFF_SEARCH_NEEDLE';
    const navDbPath = sqliteSeeds?.historyNavSeed?.dbPath ?? path.join(corpus.homeDir, 'server', 'history-navigation.sqlite');
    const navNeedle = sqliteSeeds?.historyNavSeed?.needleToken ?? 'HISTORY_NAV_WAL_NEEDLE';

    const searchLatencies = [];
    let searchOk = 0;
    let searchFail = 0;
    let searchHitsTotal = 0;

    const listLatencies = [];
    let listOk = 0;
    let listFail = 0;

    const usageLatencies = [];
    let usageOk = 0;
    let usageFail = 0;

    const contentionSessionId = await createSession(`S17 SQLite Contention ${runId}`, corpus.workspaceDir);
    const [searchResults, listResults, usageResults, walRes, promptUnderContention, searchStatusRes] = await Promise.all([
      Promise.all(
        Array.from({ length: sqCfg.concurrentSearchQueries }, async (_, idx) => {
          const query = idx % 2 === 0 ? searchNeedle : 'Synthetic chaos benchmark';
          const res = await apiJson(server.endpoint, server.token, 'POST', '/api/search', { query, page_size: 15 }, 15_000);
          searchLatencies.push(res.elapsedMs);
          if (res.status === 200 && res.json?.code === 0) {
            searchOk += 1;
            const items = res.json?.data?.items ?? res.json?.data?.hits;
            searchHitsTotal += Array.isArray(items) ? items.length : 0;
          } else {
            searchFail += 1;
          }
          return res;
        }),
      ),
      Promise.all(
        Array.from({ length: Math.max(4, Math.floor(sqCfg.concurrentSearchQueries / 2)) }, async (_, idx) => {
          const url = idx % 2 === 0 ? '/api/sessions?page_size=50' : '/api/sessions/query?page_size=50';
          const res = await apiJson(server.endpoint, server.token, 'GET', url, undefined, 15_000);
          listLatencies.push(res.elapsedMs);
          if (res.status === 200 && res.json?.code === 0) listOk += 1;
          else listFail += 1;
          return res;
        }),
      ),
      Promise.all(
        Array.from({ length: Math.max(4, Math.floor(sqCfg.concurrentSearchQueries / 2)) }, async () => {
          const res = await apiJson(
            server.endpoint,
            server.token,
            'GET',
            '/api/usage?page_size=25',
            undefined,
            15_000,
          );
          usageLatencies.push(res.elapsedMs);
          if (res.status === 200 && res.json?.code === 0) usageOk += 1;
          else usageFail += 1;
          return res;
        }),
      ),
      fs.existsSync(navDbPath)
        ? runConcurrentHistoryWalReaders({
            dbPath: navDbPath,
            needleToken: navNeedle,
            readerCount: sqCfg.concurrentWalReaders,
            queriesPerReader: 6,
          })
        : Promise.resolve({
            readerCount: 0,
            workerThreadsUsed: false,
            overlappingWalWriter: false,
            walWritesCompleted: 0,
            walBytesObserved: 0,
            queriesAttempted: 0,
            succeeded: 0,
            failed: 1,
            matchedRows: 0,
            p95Ms: 0,
            maxMs: 0,
          }),
      submitAndWaitTurn(
        server.endpoint,
        server.token,
        contentionSessionId,
        `[CHAOS_SCOPE:s17_sq_prompt_${runId}] Verify prompt admission responsiveness under multi-store SQLite contention.`,
        30_000,
      ),
      apiJson(server.endpoint, server.token, 'GET', '/api/search/status', undefined, 10_000),
    ]);
    void searchResults;
    void listResults;
    void usageResults;

    const sqliteContention = {
      searchEnabled,
      searchIndexerState: searchStatusRes.json?.data?.index_state?.state ?? 'unknown',
      seededSearchDocs: sqliteSeeds?.searchSeed?.seededDocs ?? 0,
      seededHistoryNavRows: sqliteSeeds?.historyNavSeed?.seededRows ?? 0,
      seededUsageFacts: sqliteSeeds?.usageSeed?.seededFacts ?? 0,
      searchDbBytes: sqliteSeeds?.searchSeed?.dbBytes ?? 0,
      historyNavDbBytes: sqliteSeeds?.historyNavSeed?.dbBytes ?? 0,
      usageDbBytes: sqliteSeeds?.usageSeed?.dbBytes ?? 0,
      searchQueriesSucceeded: searchOk,
      searchQueriesFailed: searchFail,
      searchHitsTotal,
      searchLatencyMs: summarize(searchLatencies),
      listQueriesSucceeded: listOk,
      listQueriesFailed: listFail,
      listLatencyMs: summarize(listLatencies),
      usageQueriesSucceeded: usageOk,
      usageQueriesFailed: usageFail,
      usageLatencyMs: summarize(usageLatencies),
      walConcurrentReadsCompleted: walRes.succeeded,
      walReaderStats: walRes,
      promptUnderContentionOk: Boolean(promptUnderContention.completed),
      promptAdmissionMs: promptUnderContention.admissionMs,
      promptError: promptUnderContention.completed ? null : JSON.stringify(promptUnderContention),
    };

    // ------------------------------------------------------------------
    // 3. Multi-Session Concurrent Writers + Simultaneous Cold Giant Main & Child Opens
    // ------------------------------------------------------------------
    const msCfg = cfg.multiSessionStorm;
    const coldChildTargetBytes = Math.round(Number(cfg.corpus.checkpointlessChildWireMiB ?? 10) * MiB);
    const coldChildSessionId = `chaos_s17_coldchild_${runId}`;
    const coldChildAgentId = 'sub_cold_s17';
    const coldChildSeed = seedColdCheckpointlessChildSession({
      homeDir: corpus.homeDir,
      workspaceId: corpus.workspaceId,
      workspaceDir: corpus.workspaceDir,
      sessionId: coldChildSessionId,
      childAgentId: coldChildAgentId,
      targetBytes: coldChildTargetBytes,
      stepCount: effectiveTier === 'full' ? 320 : 80,
    });
    await server.closeSession(corpus.giantSessionId).catch(() => undefined);

    progress(
      `S17 [3/7]: Firing ${msCfg.activeWritingSessions} concurrent writing sessions (+${msCfg.activeChildren} children) simultaneously with cold giant main (${corpus.giantMainWireGiB} GiB) + cold child (${(coldChildSeed.wireMeta.bytesWritten / MiB).toFixed(1)} MiB)...`,
    );
    const preStormTwin = twin.getStats();
    const writerSessionIds = await Promise.all(
      Array.from({ length: msCfg.activeWritingSessions }, (_, idx) =>
        createSession(`S17 Multi-Writer #${idx + 1} ${runId}`, corpus.workspaceDir),
      ),
    );
    const leaderCount = Math.min(2, writerSessionIds.length);
    const childrenPerLeader = Math.max(1, Math.ceil(msCfg.activeChildren / Math.max(1, leaderCount)));
    const coldGiantOpensTarget = Math.max(1, Number(msCfg.coldGiantOpens ?? 1));

    const stormWritersStartMs = performance.now();
    const writerPromises = writerSessionIds.map((sid, idx) => {
      if (idx < leaderCount) {
        const childCalls = Array.from({ length: childrenPerLeader }, (_, ci) => {
          const outFile = `.s17-storm-child-${runId}-${idx}-${ci}.txt`;
          const childPlan = encodeToolPlan({
            steps: [
              {
                calls: [
                  {
                    name: 'Write',
                    input: {
                      path: outFile,
                      content: `S17_CHILD_WRITE_${runId}_${idx}_${ci}\n`,
                    },
                  },
                  { name: 'Read', input: { path: 'src/mod-001.ts' } },
                ],
              },
            ],
            finalText: `S17_CHILD_DONE_${idx}_${ci}`,
          });
          return {
            name: 'AgentRun',
            input: {
              profile: 'general',
              model_alias: 'twin-anthropic',
              effort: 'high',
              name: `s17_${runId.replace(/[^a-z0-9_]/giu, '_')}_${idx}_${ci}`,
              background: false,
              description: `S17 storm child ${idx}-${ci}`,
              prompt: `[CHAOS_SCOPE:s17_child_${runId}_${idx}_${ci}] ${childPlan}`,
            },
          };
        });
        const leadPlan = encodeToolPlan({
          steps: [{ calls: childCalls }],
          finalText: `S17_LEAD_DONE_${idx}`,
        });
        return submitAndWaitTurn(
          server.endpoint,
          server.token,
          sid,
          `[CHAOS_SCOPE:s17_wlead_${runId}_${idx}] ${leadPlan}`,
          90_000,
        ).then((r) => ({ ...r, finishedAtMs: performance.now() }));
      }
      const writerOutFile = `.s17-storm-writer-${runId}-${idx}.txt`;
      const writerPlan = encodeToolPlan({
        steps: [
          {
            calls: [
              { name: 'Write', input: { path: writerOutFile, content: `S17_WRITER_${runId}_${idx}\n` } },
              { name: 'Grep', input: { pattern: 'CHAOS_TOKEN_001', output_mode: 'files_with_matches' } },
            ],
          },
        ],
        finalText: `S17_WRITER_DONE_${idx}`,
      });
      return submitAndWaitTurn(
        server.endpoint,
        server.token,
        sid,
        `[CHAOS_SCOPE:s17_writer_${runId}_${idx}] ${writerPlan}`,
        60_000,
      ).then((r) => ({ ...r, finishedAtMs: performance.now() }));
    });

    await sleep(350);
    const coldOpensStartMs = performance.now();
    const [coldMainResponses, coldChildRes] = await Promise.all([
      Promise.all(
        Array.from({ length: coldGiantOpensTarget }, () =>
          apiJson(
            server.endpoint,
            server.token,
            'GET',
            `/api/sessions/${encodeURIComponent(corpus.giantSessionId)}/transcript?agent_id=main&transcript_coverage_version=2`,
            undefined,
            30_000,
          ),
        ),
      ),
      apiJson(
        server.endpoint,
        server.token,
        'GET',
        `/api/sessions/${encodeURIComponent(coldChildSessionId)}/transcript?agent_id=${encodeURIComponent(coldChildAgentId)}&transcript_coverage_version=2`,
        undefined,
        30_000,
      ),
    ]);
    const coldOpensEndMs = performance.now();
    const writerOutcomes = await Promise.all(writerPromises);

    let observedActiveChildren = 0;
    for (let idx = 0; idx < leaderCount; idx += 1) {
      const sid = writerSessionIds[idx];
      const statePath = path.join(corpus.homeDir, 'sessions', corpus.workspaceId, sid, 'state.json');
      if (fs.existsSync(statePath)) {
        try {
          const stObj = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          observedActiveChildren += Math.max(0, Object.keys(stObj.agents ?? {}).filter((k) => k !== 'main').length);
        } catch {}
      }
    }

    const postStormTwin = twin.getStats();
    const writeResultsOk = Math.max(
      0,
      (postStormTwin.toolStats?.Write?.resultsOk ?? 0) - (preStormTwin.toolStats?.Write?.resultsOk ?? 0),
    );
    const coldMainItemsList = coldMainResponses.map((r) =>
      r.status === 200 && r.json?.code === 0 && Array.isArray(r.json?.data?.items) ? r.json.data.items.length : 0,
    );
    const coldMainOpensSucceeded = coldMainItemsList.filter((n) => n > 0).length;
    const coldChildTranscriptItems =
      coldChildRes.status === 200 && coldChildRes.json?.code === 0 && Array.isArray(coldChildRes.json?.data?.items)
        ? coldChildRes.json.data.items.length
        : 0;
    const multiSessionStorm = {
      writingSessionsAttempted: writerOutcomes.length,
      writingSessionsSucceeded: writerOutcomes.filter((o) => o.completed).length,
      activeChildrenTarget: msCfg.activeChildren,
      observedActiveChildren,
      writeResultsOk,
      coldOpensOverlappedWriters:
        writerOutcomes.some((w) => (w.finishedAtMs ?? 0) > coldOpensStartMs) && coldOpensEndMs > stormWritersStartMs,
      coldMainWireGiB: corpus.giantMainWireGiB,
      coldMainWireBytes: corpus.giantMainWireBytes,
      coldMainOpenMs: coldMainResponses[0]?.elapsedMs ?? 0,
      coldMainOpensAttempted: coldGiantOpensTarget,
      coldMainOpensSucceeded,
      coldMainTranscriptItems: coldMainItemsList[0] ?? 0,
      coldChildWireMiB: Number((coldChildSeed.wireMeta.bytesWritten / MiB).toFixed(2)),
      coldChildWireBytes: coldChildSeed.wireMeta.bytesWritten,
      coldChildOpenMs: coldChildRes.elapsedMs,
      coldChildOpensSucceeded: coldChildTranscriptItems > 0 ? 1 : 0,
      coldChildTranscriptItems,
      contractViolations: Math.max(0, postStormTwin.counters.contractViolations - preStormTwin.counters.contractViolations),
      writerLatencyMs: summarize(writerOutcomes.map((o) => o.totalMs)),
    };

    // ------------------------------------------------------------------
    // 4. Synchronized 429 (Retry-After / x-should-retry) & 524 Upstream Faults
    // ------------------------------------------------------------------
    const ufCfg = cfg.upstreamFaults;
    progress(
      `S17 [4/7]: Injecting synchronized 429 Retry-After (${ufCfg.sync429RetryAfterCount}), 429 x-should-retry:false (${ufCfg.sync429NoRetryCount}), and 524 (${ufCfg.sync524TimeoutCount})...`,
    );
    const [raSessions, nrSessions, gw524Sessions] = await Promise.all([
      Promise.all(Array.from({ length: ufCfg.sync429RetryAfterCount }, (_, i) => createSession(`S17 429-RA #${i}`, corpus.workspaceDir))),
      Promise.all(Array.from({ length: ufCfg.sync429NoRetryCount }, (_, i) => createSession(`S17 429-NR #${i}`, corpus.workspaceDir))),
      Promise.all(Array.from({ length: ufCfg.sync524TimeoutCount }, (_, i) => createSession(`S17 524 #${i}`, corpus.workspaceDir))),
    ]);

    const raScopes = raSessions.map((_, i) => `s17_429ra_${runId}_${i}`);
    const nrScopes = nrSessions.map((_, i) => `s17_429nr_${runId}_${i}`);
    const gw524Scopes = gw524Sessions.map((_, i) => `s17_524_${runId}_${i}`);

    const [raResults, nrResults, gw524Results] = await Promise.all([
      Promise.all(
        raSessions.map((sid, i) =>
          submitAndWaitTurn(
            server.endpoint,
            server.token,
            sid,
            `[CHAOS_SCOPE:${raScopes[i]}] [CHAOS:RATE_LIMIT_429_RETRY_AFTER] Synchronized 429 Retry-After test ${i}.`,
            45_000,
          ),
        ),
      ),
      Promise.all(
        nrSessions.map((sid, i) =>
          submitAndWaitTurn(
            server.endpoint,
            server.token,
            sid,
            `[CHAOS_SCOPE:${nrScopes[i]}] [CHAOS:RATE_LIMIT_429_NO_RETRY] Synchronized 429 x-should-retry false veto ${i}.`,
            30_000,
          ),
        ),
      ),
      Promise.all(
        gw524Sessions.map((sid, i) =>
          submitAndWaitTurn(
            server.endpoint,
            server.token,
            sid,
            `[CHAOS_SCOPE:${gw524Scopes[i]}] [CHAOS:GATEWAY_524] Synchronized 524 gateway timeout recovery ${i}.`,
            45_000,
          ),
        ),
      ),
    ]);

    const faultTwinStats = twin.getStats();
    const attempts = faultTwinStats.scopeAttempts ?? {};
    const timestamps = faultTwinStats.scopeAttemptTimestamps ?? {};
    const sync429RetryAfterRecovered = raResults.filter(
      (r, i) => r.completed && (attempts[raScopes[i]] ?? 0) >= 2,
    ).length;
    const sync429RetryAfterDelaysMs = raScopes.map((s) => {
      const ts = timestamps[s] ?? [];
      return ts.length >= 2 ? ts[1] - ts[0] : 0;
    });
    const sync429RetryAfterDelayRespected = sync429RetryAfterDelaysMs.filter((d) => d >= 800).length;
    const sync429NoRetryVetoRespected = nrResults.filter(
      (r, i) =>
        r.ok &&
        (r.lastTurnReason === 'failed' || r.lastTurnReason === 'error') &&
        (attempts[nrScopes[i]] ?? 0) === 1,
    ).length;
    const sync524Recovered = gw524Results.filter(
      (r, i) => r.completed && (attempts[gw524Scopes[i]] ?? 0) >= 2,
    ).length;

    const upstreamFaults = {
      sync429RetryAfterAttempted: raResults.length,
      sync429RetryAfterRecovered,
      sync429RetryAfterDelayRespected,
      sync429RetryAfterDelaysMs,
      sync429NoRetryAttempted: nrResults.length,
      sync429NoRetryVetoRespected,
      sync429NoRetryTerminalReasons: nrResults.map((r) => r.lastTurnReason ?? null),
      sync524Attempted: gw524Results.length,
      sync524Recovered,
      faultCounters: {
        rate_limit_429_retry_after: faultTwinStats.faultsInjected.rate_limit_429_retry_after ?? 0,
        rate_limit_429_no_retry: faultTwinStats.faultsInjected.rate_limit_429_no_retry ?? 0,
        gateway_524: faultTwinStats.faultsInjected.gateway_524 ?? 0,
      },
    };

    // ------------------------------------------------------------------
    // 5. Slow / Stalled MCP & SSH Mock Endpoints
    // ------------------------------------------------------------------
    const stallCfg = cfg.externalStalls;
    progress(`S17 [5/7]: Probing stalled local MCP & SSH mock endpoints while monitoring /api/healthz...`);
    const mocks = await startStalledMockServers({
      mcpStallMs: stallCfg.mcpStallMs,
      sshStallMs: stallCfg.sshStallMs,
    });
    const healthLatencies = [];
    let healthFailures = 0;
    let stopHealthPoll = false;
    const healthPoller = (async () => {
      while (!stopHealthPoll) {
        const h = await apiJson(server.endpoint, server.token, 'GET', '/api/healthz', undefined, 5_000);
        if (h.status === 200) healthLatencies.push(h.elapsedMs);
        else healthFailures += 1;
        await sleep(80);
      }
    })();

    let mcpRes = null;
    let sshPlanRes = null;
    try {
      [mcpRes, sshPlanRes] = await Promise.all([
        apiJson(
          server.endpoint,
          server.token,
          'POST',
          '/api/mcp/servers:test',
          {
            server: {
              name: `chaos-stalled-mcp-${runId}`,
              transport: 'http',
              url: mocks.mcpUrl,
            },
          },
          stallCfg.probeTimeoutMs,
        ),
        apiJson(
          server.endpoint,
          server.token,
          'POST',
          '/api/remote-connections/ssh/plan',
          {
            id: `chaos_stall_${runId}`,
            label: `Chaos Stall SSH ${runId}`,
            target: { kind: 'host', hostname: '127.0.0.1', username: 'chaos', port: mocks.sshPort },
            remoteHome: '/tmp/kiki-chaos-ssh-stall',
            remoteExecutable: 'kiki',
            remoteShell: 'posix',
          },
          stallCfg.probeTimeoutMs,
        ),
      ]);
    } finally {
      stopHealthPoll = true;
      await healthPoller;
      await mocks.close();
    }
    const mockCounts = mocks.getCounts();
    const postStallHealth = await apiJson(server.endpoint, server.token, 'GET', '/api/healthz', undefined, 5_000);
    const externalStalls = {
      mcpStallProbed: mcpRes !== null,
      mcpConnectionsAccepted: mockCounts.mcpConnectionsAccepted,
      mcpStallContained: Boolean(postStallHealth.status === 200 && mockCounts.mcpConnectionsAccepted >= 1 && (mcpRes?.status ?? 0) > 0),
      mcpElapsedMs: mcpRes?.elapsedMs ?? null,
      mcpStatus: mcpRes?.status ?? 0,
      sshStallProbed: sshPlanRes !== null,
      sshConnectionsAccepted: mockCounts.sshConnectionsAccepted,
      sshStallContained: Boolean(postStallHealth.status === 200 && mockCounts.sshConnectionsAccepted >= 1 && (sshPlanRes?.status ?? 0) > 0),
      sshElapsedMs: sshPlanRes?.elapsedMs ?? null,
      sshStatus: sshPlanRes?.status ?? 0,
      concurrentHealthSamples: healthLatencies.length,
      concurrentHealthFailures: healthFailures,
      concurrentHealthMaxMs: healthLatencies.length > 0 ? roundMs(Math.max(...healthLatencies)) : null,
    };

    // ------------------------------------------------------------------
    // 6. Resident-Session Eviction Memory / Handle Drain Check
    // ------------------------------------------------------------------
    const evCfg = cfg.residencyEviction;
    progress(`S17 [6/7]: Checking resident-session eviction memory/handle drain (${evCfg.sessionsToOpen} sessions)...`);
    const evictSessionIds = await Promise.all(
      Array.from({ length: evCfg.sessionsToOpen }, (_, i) =>
        createSession(`S17 Evict #${i + 1} ${runId}`, corpus.workspaceDir),
      ),
    );
    await Promise.all(
      evictSessionIds.map((sid, i) =>
        submitAndWaitTurn(
          server.endpoint,
          server.token,
          sid,
          `[CHAOS_SCOPE:s17_evict_${runId}_${i}] Residency eviction materialization turn ${i}.`,
          30_000,
        ),
      ),
    );
    const peakEvictMetrics = await server.metrics(true);
    const peakHandleCount = peakEvictMetrics.fdCount ?? sampleProcessHandleCount(server.pid);
    let postAutoSweepMetrics = peakEvictMetrics;
    for (let poll = 0; poll < 16; poll += 1) {
      await sleep(350);
      postAutoSweepMetrics = await server.metrics(true);
      if (
        typeof postAutoSweepMetrics.liveSessionCount === 'number' &&
        postAutoSweepMetrics.liveSessionCount <= evCfg.maxLiveSessions
      ) {
        break;
      }
    }
    const allEvictTargets = [...new Set([...createdSessionIds, corpus.giantSessionId, coldChildSessionId])];
    await Promise.all(allEvictTargets.map((sid) => server.closeSession(sid).catch(() => undefined)));
    createdSessionIds.length = 0;
    await sleep(250);
    const postEvictGc = await server.gc();
    const postEvictLiveSessions = postEvictGc.metrics?.liveSessionCount ?? null;
    const postEvictHandleCount = postEvictGc.metrics?.fdCount ?? sampleProcessHandleCount(server.pid);

    const residencyEviction = {
      sessionsOpened: evictSessionIds.length,
      peakLiveSessions: peakEvictMetrics.liveSessionCount,
      peakRssMiB: peakEvictMetrics.rssMiB,
      peakHandleCount,
      postAutoSweepLiveSessions: postAutoSweepMetrics.liveSessionCount,
      autoEvictionAttempts: postAutoSweepMetrics.residencyReport?.evictionAttempts ?? 0,
      autoEvictionSuccesses: postAutoSweepMetrics.residencyReport?.evictionSuccesses ?? 0,
      autoEvictedBelowCap:
        typeof postAutoSweepMetrics.liveSessionCount === 'number' &&
        postAutoSweepMetrics.liveSessionCount <= evCfg.maxLiveSessions,
      postEvictLiveSessions,
      postEvictMaxLiveSessions: evCfg.postEvictMaxLiveSessions,
      postEvictRssMiB: postEvictGc.metrics?.rssMiB ?? null,
      postEvictHeapUsedMiB: postEvictGc.metrics?.heapUsedMiB ?? null,
      postEvictHandleCount,
      drainedCleanly:
        typeof postEvictLiveSessions === 'number' && postEvictLiveSessions <= evCfg.postEvictMaxLiveSessions,
      unhandledRejections: postEvictGc.metrics?.unhandledRejections ?? 0,
      uncaughtExceptions: postEvictGc.metrics?.uncaughtExceptions ?? 0,
    };

    // ------------------------------------------------------------------
    // 7. Windows Native Process-Helper Contention (win32 Bash bursts + CPU worker Glob/Grep)
    // ------------------------------------------------------------------
    const phCfg = cfg.processHelperContention;
    progress(
      `S17 [7/7]: Running process-helper contention (${phCfg.bashBursts} Bash bursts + ${phCfg.concurrentGlobGrep} Glob/Grep on platform=${process.platform})...`,
    );
    const preHelperTools = twin.getStats().toolStats;
    const helperSessions = await Promise.all(
      Array.from({ length: phCfg.bashBursts }, (_, i) => createSession(`S17 Helper Burst #${i + 1} ${runId}`, subRoot)),
    );
    const burstLatencies = [];
    const burstResults = await Promise.all(
      helperSessions.map(async (sid, i) => {
        const plan = encodeToolPlan({
          steps: [
            {
              calls: [
                {
                  name: 'Bash',
                  input: {
                    command: `${JSON.stringify(process.execPath)} -e "const c=require('node:crypto');console.log(c.createHash('sha256').update('burst_${i}').digest('hex'))"`,
                    description: `S17 helper burst ${i}`,
                  },
                },
                ...(i < phCfg.concurrentGlobGrep
                  ? [
                      { name: 'Glob', input: { pattern: 'pkg_00/**/*.ts' } },
                      { name: 'Grep', input: { pattern: subNeedle, output_mode: 'files_with_matches' } },
                    ]
                  : []),
              ],
            },
          ],
          finalText: `S17_HELPER_BURST_OK_${i}`,
        });
        const res = await submitAndWaitTurn(
          server.endpoint,
          server.token,
          sid,
          `[CHAOS_SCOPE:s17_helper_${runId}_${i}] ${plan}`,
          45_000,
        );
        burstLatencies.push(res.totalMs);
        return res;
      }),
    );
    const postHelperTools = twin.getStats().toolStats;
    const helperBashOk = Math.max(0, (postHelperTools.Bash?.resultsOk ?? 0) - (preHelperTools.Bash?.resultsOk ?? 0));
    const helperGlobOk = Math.max(0, (postHelperTools.Glob?.resultsOk ?? 0) - (preHelperTools.Glob?.resultsOk ?? 0));
    const helperGrepOk = Math.max(0, (postHelperTools.Grep?.resultsOk ?? 0) - (preHelperTools.Grep?.resultsOk ?? 0));
    const helperToolErrors =
      Math.max(0, (postHelperTools.Bash?.resultsError ?? 0) - (preHelperTools.Bash?.resultsError ?? 0)) +
      Math.max(0, (postHelperTools.Glob?.resultsError ?? 0) - (preHelperTools.Glob?.resultsError ?? 0)) +
      Math.max(0, (postHelperTools.Grep?.resultsError ?? 0) - (preHelperTools.Grep?.resultsError ?? 0));
    await Promise.all(helperSessions.map((sid) => server.closeSession(sid).catch(() => undefined)));
    createdSessionIds.length = 0;
    let survivorScan = { ok: false, survivors: [], error: 'unrun' };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(150);
      survivorScan = listSurvivingWorkloadDescendantsChecked(server.pid);
      if (survivorScan.ok && survivorScan.survivors.length === 0) break;
    }
    const burstsSucceeded = burstResults.filter((r) => r.completed).length;
    const processHelperContention = {
      platform: process.platform,
      burstsAttempted: burstResults.length,
      burstsSucceeded,
      concurrentGlobGrepCount: phCfg.concurrentGlobGrep,
      bashToolCallsOk: helperBashOk,
      globToolCallsOk: helperGlobOk,
      grepToolCallsOk: helperGrepOk,
      toolErrors: helperToolErrors,
      win32HelperVerified:
        process.platform === 'win32'
          ? Boolean(burstsSucceeded === burstResults.length && helperBashOk >= burstResults.length && helperToolErrors === 0)
          : null,
      processScanSucceeded: survivorScan.ok,
      processScanError: survivorScan.error,
      burstLatencyMs: summarize(burstLatencies),
      survivingDescendants: survivorScan.survivors.length,
      survivingDescendantDetails: survivorScan.survivors.slice(0, 5).map((p) => ({
        pid: p.pid,
        name: p.name ?? '',
        cmdline: p.cmdline.slice(0, 200),
      })),
    };

    const postMetrics = await server.metrics(true);
    const report = {
      runId,
      matrixName: loadedMatrix.name,
      tier: effectiveTier,
      platform: process.platform,
      workspacePathCliffs,
      sqliteContention,
      multiSessionStorm,
      upstreamFaults,
      externalStalls,
      residencyEviction,
      processHelperContention,
      eld: {
        p99Ms: postMetrics.eldP99Ms ?? 0,
        maxMs: postMetrics.eldMaxMs ?? 0,
        maxSingleTickStallMs: postMetrics.maxSingleTickStallMs ?? 0,
        elu: postMetrics.eventLoopUtilization ?? 0,
      },
      memoryMiB: {
        preRss: preMetrics.rssMiB,
        postRss: postMetrics.rssMiB,
        vmHwm: postMetrics.vmHwmMiB,
        postHeapUsed: postMetrics.heapUsedMiB,
      },
      elapsedMs: roundMs(performance.now() - startedAt),
    };

    const verdict = evaluateS17WorkstationCliffVerdict(report, loadedMatrix);
    progress(
      `S17 Workstation Cliff (${loadedMatrix.name}) Result: passed=${verdict.passed} exitCode=${verdict.exitCode} subOverflow=${workspacePathCliffs.subOverflow.overflow} umbrellaOverflow=${workspacePathCliffs.umbrellaOverflow.overflow} searchP95=${sqliteContention.searchLatencyMs.p95}ms walReads=${sqliteContention.walConcurrentReadsCompleted} 429ra=${upstreamFaults.sync429RetryAfterRecovered}/${upstreamFaults.sync429RetryAfterAttempted} 429nr=${upstreamFaults.sync429NoRetryVetoRespected}/${upstreamFaults.sync429NoRetryAttempted} 524=${upstreamFaults.sync524Recovered}/${upstreamFaults.sync524Attempted} helperBursts=${processHelperContention.burstsSucceeded}/${processHelperContention.burstsAttempted} eldP99=${report.eld.p99Ms}ms wall=${report.elapsedMs}ms`,
    );
    return {
      ...verdict,
      ...report,
    };
  } finally {
    await Promise.all(createdSessionIds.map((sid) => server.closeSession(sid).catch(() => undefined)));
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}
