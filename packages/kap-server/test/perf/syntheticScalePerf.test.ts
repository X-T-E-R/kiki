import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import { getLiveSessionById, IModelCatalog, IWorkspaceInstanceManager, type ScopeSeed } from '@kiki/agent-core-v2';
import { encodeWorkDirKey } from '@kiki/agent-core-v2/_base/utils/workdir-slug';
import { createKlient } from '@kiki/klient/http';
import type { ContentRef, TranscriptResetEvent } from '@kiki/transcript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { runResourceProbe } from '../../../../scripts/perf/resource-probe.mjs';
import { HistoryNavigation } from '../../src/services/history/historyNavigation';
import { type RunningServer, startServer } from '../../src/start';
import { authHeaders, bearerToken } from '../helpers/auth';
import { TEST_HOST_IDENTITY } from '../helpers/hostIdentity';

const SESSION_ID = 'scale_session_primary';
const HEAVY_SUBAGENT_ID = 'agent-heavy';
const TOTAL_SUBAGENTS = 120;
const MAIN_TURNS = 140;
const SUBAGENT_TURNS = 90;

function createMulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function createNoopModelCatalog(): IModelCatalog {
  const fail = () => { throw new Error('modelCatalog disabled in syntheticScalePerf'); };
  return {
    _serviceBrand: undefined, get: fail, getRequester: fail, getConnectionRequester: fail, getConnectionEndpoint: fail,
    inspect: fail, ping: fail, findByName: () => [], listModels: async () => [], listProviders: async () => [],
    getProvider: fail, setDefaultModel: fail,
  };
}

function buildMainWirePayload(rng: () => number): string {
  const opaque = 'S'.repeat(180 * 1024), largeTool = 'L'.repeat(72 * 1024), assistant = 'A'.repeat(6 * 1024);
  const lines: string[] = [];
  for (let turnId = 0; turnId < MAIN_TURNS; turnId += 1) {
    const t = 1_700_000_000_000 + turnId * 1_000, stepUuid = `step-${turnId}`, callId = `call-${turnId}`;
    const big = turnId % 2 === 0 || rng() > 0.6;
    lines.push(JSON.stringify({ type: 'turn.prompt', turnId, promptId: `prompt-${turnId}`, input: [{ type: 'text', text: `scale prompt ${turnId}` }], origin: { kind: 'user' }, time: t + 1 }));
    if (turnId % 5 === 0) lines.push(JSON.stringify({ type: 'llm.request', turnId, systemPrompt: opaque, time: t + 2 }));
    lines.push(
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId, step: 1, uuid: stepUuid }, time: t + 3 }),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', turnId, stepUuid, toolCallId: callId, name: 'Read', args: { path: `src/module_${turnId}.ts` } }, time: t + 4 }),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: callId, result: { output: big ? `HEAD-${turnId}\n${largeTool}\nTAIL-${turnId}` : `ok-${turnId}`, isError: false } }, time: t + 5 }),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', turnId, stepUuid, uuid: `part-${turnId}`, part: { type: 'text', text: `turn-${turnId} ${assistant}` } }, time: t + 6 }),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.end', turnId, step: 1, uuid: stepUuid }, time: t + 7 }),
      JSON.stringify({ type: 'turn.ended', turnId, reason: 'completed', time: t + 8 }),
    );
  }
  return `${lines.join('\n')}\n`;
}

function buildHeavySubagentWirePayload(): string {
  const chunk = 'C'.repeat(80 * 1024), lines: string[] = [];
  for (let turnId = 0; turnId < SUBAGENT_TURNS; turnId += 1) {
    const stepUuid = `sub-step-${turnId}`, t = 1_700_050_000_000 + turnId * 500;
    lines.push(
      JSON.stringify({ type: 'turn.prompt', turnId, promptId: `sub-prompt-${turnId}`, input: [{ type: 'text', text: `subagent task ${turnId}` }], origin: { kind: 'user' }, time: t + 1 }),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId, step: 1, uuid: stepUuid }, time: t + 2 }),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', turnId, stepUuid, uuid: `sub-part-${turnId}`, part: { type: 'text', text: `sub-turn-${turnId} ${chunk}` } }, time: t + 3 }),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.end', turnId, step: 1, uuid: stepUuid }, time: t + 4 }),
      JSON.stringify({ type: 'turn.ended', turnId, reason: 'completed', time: t + 5 }),
    );
  }
  return `${lines.join('\n')}\n`;
}

function findFirstContentRef(items: readonly Record<string, unknown>[]): ContentRef | undefined {
  const pick = (raw: unknown): ContentRef | undefined => {
    if (Array.isArray(raw)) return raw.find((e): e is ContentRef => e !== null && typeof e === 'object' && 'source' in e && 'path' in e);
    return raw !== null && typeof raw === 'object' ? Object.values(raw as Record<string, ContentRef>)[0] : undefined;
  };
  for (const item of items) {
    if (item['kind'] !== 'turn') continue;
    const direct = pick(item['contentRefs']);
    if (direct !== undefined) return direct;
    for (const step of (item['steps'] as readonly Record<string, unknown>[] | undefined) ?? []) {
      for (const frame of (step['frames'] as readonly Record<string, unknown>[] | undefined) ?? []) {
        const fromFrame = pick(frame['contentRefs']);
        if (fromFrame !== undefined) return fromFrame;
      }
    }
  }
  return undefined;
}

describe('synthetic scale performance gate (cold open, older-page scroll, 120-subagent roster, physical invariants)', () => {
  let homeDir = '';
  let server: RunningServer | undefined;
  let endpoint = '';
  let mainWireBytes = 0;
  let heavySubagentWireBytes = 0;
  let coldCanonicalFallbacks = 0;
  let giantCheckpointJsonDecodes = 0;
  let origReadCanonical: typeof HistoryNavigation.prototype.readCanonicalEntity;
  let origJsonParse: typeof JSON.parse;

  beforeAll(async () => {
    origReadCanonical = HistoryNavigation.prototype.readCanonicalEntity;
    HistoryNavigation.prototype.readCanonicalEntity = function (...args) {
      coldCanonicalFallbacks += 1;
      return origReadCanonical.apply(this, args);
    };
    origJsonParse = JSON.parse;
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      if (typeof text === 'string' && text.length > 262_144 && text.includes('"acceptedDurableFacts"')) giantCheckpointJsonDecodes += 1;
      return origJsonParse(text, reviver);
    }) as typeof JSON.parse;

    const rng = createMulberry32(0x2026_1118);
    homeDir = await mkdtemp(join(tmpdir(), 'kiki-synthetic-scale-'));
    const workspaceRoot = join(homeDir, 'workspace'), workspaceId = encodeWorkDirKey(workspaceRoot);
    const nowIso = new Date(1_700_000_000_000).toISOString();
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(homeDir, 'workspaces.json'), JSON.stringify({
      version: 1, workspaces: { [workspaceId]: { root: workspaceRoot, name: 'Scale Gate Workspace', created_at: nowIso, last_opened_at: nowIso } }, deleted_workspace_ids: [],
    }));
    await writeFile(join(homeDir, 'config.toml'), '[search]\nenabled = false\n');

    const sessionDir = join(homeDir, 'sessions', workspaceId, SESSION_ID);
    const mainDir = join(sessionDir, 'agents', 'main'), heavySubDir = join(sessionDir, 'agents', HEAVY_SUBAGENT_ID), mediaDir = join(sessionDir, 'media', 'files');
    await Promise.all([mkdir(mainDir, { recursive: true }), mkdir(heavySubDir, { recursive: true }), mkdir(mediaDir, { recursive: true })]);

    const mainPayload = buildMainWirePayload(rng), heavySubPayload = buildHeavySubagentWirePayload();
    mainWireBytes = Buffer.byteLength(mainPayload);
    heavySubagentWireBytes = Buffer.byteLength(heavySubPayload);
    await Promise.all([writeFile(join(mainDir, 'wire.jsonl'), mainPayload), writeFile(join(heavySubDir, 'wire.jsonl'), heavySubPayload)]);

    const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await Promise.all(Array.from({ length: 30 }, (_, m) => writeFile(join(mediaDir, `asset_${m}.png`), pngHeader)));

    const agentsMeta: Record<string, Record<string, unknown>> = {
      main: { type: 'main', model: 'example/scale-model', toolCallCount: MAIN_TURNS },
      [HEAVY_SUBAGENT_ID]: { type: 'sub', parentAgentId: 'main', displayName: 'Subagent Heavy', model: 'example/scale-sub', status: 'completed', completedAt: 1_700_060_000_000, toolCallCount: SUBAGENT_TURNS },
    };

    await Promise.all(Array.from({ length: TOTAL_SUBAGENTS - 1 }, async (_, idx) => {
      const i = idx + 1, subId = `agent-${i}`, subDir = join(sessionDir, 'agents', subId);
      await mkdir(subDir, { recursive: true });
      await writeFile(join(subDir, 'wire.jsonl'),
        `${JSON.stringify({ type: 'turn.prompt', turnId: 0, promptId: `p-${i}`, input: [{ type: 'text', text: `child ${i}` }], origin: { kind: 'user' }, time: 1_700_010_000_000 + i })}\n${JSON.stringify({ type: 'turn.ended', turnId: 0, reason: 'completed', time: 1_700_010_000_100 + i })}\n`);
      agentsMeta[subId] = { type: 'sub', parentAgentId: 'main', displayName: `Subagent #${i}`, model: 'example/scale-sub', status: 'completed', completedAt: 1_700_010_000_200 + i };
    }));

    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({
      id: SESSION_ID, version: 2, title: 'Synthetic Scale Primary Session', titleKind: 'custom',
      createdAt: 1_700_000_000_000, updatedAt: 1_700_090_000_000, archived: false, cwd: workspaceRoot, agents: agentsMeta,
    }));

    await Promise.all(Array.from({ length: 24 }, async (_, c) => {
      const catalogId = `scale_catalog_${c}`, catalogDir = join(homeDir, 'sessions', workspaceId, catalogId);
      await mkdir(join(catalogDir, 'agents', 'main'), { recursive: true });
      await writeFile(join(catalogDir, 'agents', 'main', 'wire.jsonl'), '');
      await writeFile(join(catalogDir, 'state.json'), JSON.stringify({
        id: catalogId, version: 2, title: `Catalog Session #${c}`, titleKind: 'custom',
        createdAt: 1_700_000_000_000 + c, updatedAt: 1_700_080_000_000 + c, archived: false, cwd: workspaceRoot,
        agents: { main: { type: 'main', model: 'example/scale-model' } },
      }));
    }));

    const seeds: ScopeSeed = [[IModelCatalog, createNoopModelCatalog()]];
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir,
      userSkillDir: join(homeDir, 'isolated-skills'), userAgentProfileHomeDir: join(homeDir, 'isolated-agents'),
      logLevel: 'silent', seeds,
    });
    endpoint = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    HistoryNavigation.prototype.readCanonicalEntity = origReadCanonical;
    JSON.parse = origJsonParse;
    if (server !== undefined) { await server.close(); server = undefined; }
    if (homeDir !== '') await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('serves cold catalog over >10 MiB main wire and >6 MiB subagent wire without resuming sessions or watcher roots', async () => {
    expect(mainWireBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(heavySubagentWireBytes).toBeGreaterThan(6 * 1024 * 1024);
    const started = performance.now(), headers = authHeaders(server as RunningServer);
    const [listRes, queryRes, headsRes] = await Promise.all([
      fetch(`${endpoint}/api/sessions?limit=50`, { headers } as never),
      fetch(`${endpoint}/api/sessions/query?limit=50`, { headers } as never),
      fetch(`${endpoint}/api/personas/session-heads?per_persona_limit=5`, { headers } as never),
    ]);
    const elapsedMs = performance.now() - started;
    const queryBody = (await queryRes.json()) as { readonly data?: { readonly items?: unknown[] } };
    expect(listRes.status).toBe(200);
    expect(queryRes.status).toBe(200);
    expect(headsRes.status).toBe(200);
    expect(queryBody.data?.items?.length).toBe(25);
    expect(elapsedMs).toBeLessThan(4_000);
    expect(getLiveSessionById(server!.core.accessor, SESSION_ID)).toBeUndefined();
    expect(server!.core.accessor.get(IWorkspaceInstanceManager).list().length).toBe(0);
  });

  it('serves cold TTFC, zero-fallback tail ContentRef hydration, older-page slices, and 8 MiB cold child within physical bounds', async () => {
    const eld = monitorEventLoopDelay({ resolution: 20 });
    eld.enable();
    let maxSingleTickStallMs = 0, lastTick = performance.now();
    const stallTimer = setInterval(() => {
      const now = performance.now();
      maxSingleTickStallMs = Math.max(maxSingleTickStallMs, Math.max(0, now - lastTick - 15));
      lastTick = now;
    }, 15);
    const klient = createKlient({
      endpoint, token: bearerToken(server as RunningServer),
      WebSocket: WebSocket as unknown as typeof globalThis.WebSocket, timeoutMs: 30_000,
    });

    try {
      eld.reset();
      coldCanonicalFallbacks = 0;
      giantCheckpointJsonDecodes = 0;
      const openStarted = performance.now();
      let resetEvent: TranscriptResetEvent | undefined, mainResetMs = -1, readyMs = -1;
      const view = klient.session(SESSION_ID).view;
      await new Promise<void>((resolve, reject) => {
        view.subscribe({ sessionCursor: { seq: 0 }, transcriptGrades: { '*': 'turn', main: 'delta' }, bootstrap: true }, (signal) => {
          if (signal.type === 'transcript' && signal.event.agent_id === 'main' && signal.event.type === 'transcript.reset') {
            if (mainResetMs < 0) { mainResetMs = performance.now() - openStarted; resetEvent = signal.event; }
            if (readyMs >= 0) resolve();
          } else if (signal.type === 'ready') {
            readyMs = performance.now() - openStarted;
            if (mainResetMs >= 0) resolve();
          } else if (signal.type === 'protocolError') reject(new Error(signal.detail));
        });
      });

      expect(mainResetMs).toBeGreaterThanOrEqual(0);
      expect(mainResetMs).toBeLessThan(3_000);
      const initialTurns = resetEvent!.snapshot.items.filter((item) => item.kind === 'turn');
      expect(initialTurns.length).toBe(20);
      expect(resetEvent!.snapshot.hasMoreOlder || resetEvent!.coverage.hasMoreOlder).toBe(true);
      expect(getLiveSessionById(server!.core.accessor, SESSION_ID)).toBeUndefined();

      const tailRef = findFirstContentRef(initialTurns as unknown as readonly Record<string, unknown>[]);
      expect(tailRef).toBeDefined();
      coldCanonicalFallbacks = 0;
      expect(await view.transcript.content!({ agentId: 'main', ref: tailRef! })).toBeDefined();
      expect(coldCanonicalFallbacks).toBe(0);
      expect(giantCheckpointJsonDecodes).toBe(0);

      let beforeTurn: string | undefined = initialTurns[0]!.turnId, olderHydrated = false;
      for (let pageIdx = 0; pageIdx < 2; pageIdx += 1) {
        const pageStart = performance.now();
        let page = await view.transcript.page({ agentId: 'main', beforeTurn, pageSize: 40 });
        while (page.read?.readiness === 'preparing' && page.next_cursor !== undefined) {
          page = await view.transcript.page({ agentId: 'main', beforeItem: page.next_cursor, pageSize: 40 });
        }
        expect(performance.now() - pageStart).toBeLessThan(6_000);
        const pageTurns = page.items.filter((item) => item.kind === 'turn');
        expect(pageTurns.length).toBeGreaterThan(0);
        beforeTurn = pageTurns[0]!.turnId;
        if (!olderHydrated) {
          const ref = findFirstContentRef(page.items as unknown as readonly Record<string, unknown>[]);
          if (ref !== undefined) {
            for (let attempt = 0; attempt < 10; attempt += 1) {
              try { expect(await view.transcript.content!({ agentId: 'main', ref })).toBeDefined(); olderHydrated = true; break; }
              catch (error) {
                if ((error as { readonly code?: number }).code !== 40923) throw error;
                await new Promise<void>((r) => setTimeout(r, 40));
              }
            }
          }
        }
      }
      expect(olderHydrated).toBe(true);

      const subStart = performance.now();
      let subPage = await view.transcript.page({ agentId: HEAVY_SUBAGENT_ID, pageSize: 20 });
      while (subPage.read?.readiness === 'preparing' && subPage.next_cursor !== undefined) {
        subPage = await view.transcript.page({ agentId: HEAVY_SUBAGENT_ID, beforeItem: subPage.next_cursor, pageSize: 20 });
      }
      expect(server!.core.accessor.get(IWorkspaceInstanceManager).list().length).toBe(0);
      const hooksRes = await fetch(`${endpoint}/api/sessions/${SESSION_ID}/agents/${HEAVY_SUBAGENT_ID}/hooks?observe=true`, { headers: authHeaders(server as RunningServer) } as never);
      expect(performance.now() - subStart).toBeLessThan(2_500);
      const subTurns = subPage.items.filter((item) => item.kind === 'turn');
      expect(subTurns.length).toBeGreaterThan(0);
      expect(subTurns.length).toBeLessThanOrEqual(20);
      expect(subPage.has_more).toBe(true);
      expect(hooksRes.status).toBe(200);
      expect(server!.core.accessor.get(IWorkspaceInstanceManager).list().length).toBeLessThanOrEqual(1);
      expect(getLiveSessionById(server!.core.accessor, SESSION_ID)).toBeUndefined();
      expect(giantCheckpointJsonDecodes).toBe(0);
      expect(maxSingleTickStallMs).toBeLessThan(1_000);
      expect(eld.count > 0 ? Math.max(0, eld.percentile(99) / 1e6 - 20) : 0).toBeLessThan(800);
    } finally {
      clearInterval(stallTimer);
      eld.disable();
      await klient.close();
    }
  });

  it('enforces isolated child-process resource probe invariants (2N/N roster, watcher roots, heartbeat gap)', async () => {
    const probe = await runResourceProbe();
    expect(probe.coldWatcherRoots).toBe(0);
    expect(probe.liveWatcherRoots).toBeLessThanOrEqual(2);
    expect(probe.coldCanonicalFallbacks).toBe(0);
    expect(probe.giantCheckpointJsonDecodes).toBe(0);
    expect(probe.maxSessionCreateMs).toBeLessThanOrEqual(1_500);
    expect(probe.maxClientGapMs).toBeLessThanOrEqual(1_000);
    expect(probe.maxSingleTickStallMs).toBeLessThanOrEqual(1_000);
  }, 60_000);
});
