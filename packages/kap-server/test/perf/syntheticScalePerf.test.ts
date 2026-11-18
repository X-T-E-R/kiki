import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import { getLiveSessionById, IModelCatalog, type ScopeSeed } from '@kiki/agent-core-v2';
import { encodeWorkDirKey } from '@kiki/agent-core-v2/_base/utils/workdir-slug';
import { createKlient } from '@kiki/klient/http';
import type { ContentRef, TranscriptResetEvent } from '@kiki/transcript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../../src/start';
import { authHeaders, bearerToken } from '../helpers/auth';
import { TEST_HOST_IDENTITY } from '../helpers/hostIdentity';

const SESSION_ID = 'scale_session_primary';
const HEAVY_SUBAGENT_ID = 'agent-heavy';
const TOTAL_SUBAGENTS = 120;
const MAIN_TURNS = 140;
const SUBAGENT_TURNS = 90;

function toUint32(value: number): number {
  const mod = value % 4_294_967_296;
  return mod < 0 ? mod + 4_294_967_296 : Math.trunc(mod);
}

function createMulberry32(seed: number): () => number {
  let state = toUint32(seed);
  return () => {
    state = toUint32(state + 0x6d2b79f5);
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return toUint32(t ^ (t >>> 14)) / 4_294_967_296;
  };
}

function createNoopModelCatalog(): IModelCatalog {
  const unexercised = () => {
    throw new Error('modelCatalog disabled in syntheticScalePerf');
  };
  return {
    _serviceBrand: undefined,
    get: unexercised,
    getRequester: unexercised,
    getConnectionRequester: unexercised,
    getConnectionEndpoint: unexercised,
    inspect: unexercised,
    ping: unexercised,
    findByName: () => [],
    listModels: async () => [],
    listProviders: async () => [],
    getProvider: unexercised,
    setDefaultModel: unexercised,
  };
}

function buildMainWirePayload(rng: () => number): string {
  const opaqueSystemPrompt = 'S'.repeat(180 * 1024);
  const largeToolChunk = 'L'.repeat(72 * 1024);
  const mediumAssistantChunk = 'A'.repeat(6 * 1024);
  const lines: string[] = [];

  for (let turnId = 0; turnId < MAIN_TURNS; turnId += 1) {
    const baseTime = 1_700_000_000_000 + turnId * 1_000;
    const stepUuid = `step-${turnId}`;
    const callId = `call-${turnId}`;
    const includeOpaqueRequest = turnId % 5 === 0;
    const includeOversizedTool = turnId % 3 === 0 || rng() > 0.7;

    lines.push(
      JSON.stringify({
        type: 'turn.prompt',
        turnId,
        promptId: `prompt-${turnId}`,
        input: [{ type: 'text', text: `scale prompt ${turnId}` }],
        origin: { kind: 'user' },
        time: baseTime + 1,
      }),
    );

    if (includeOpaqueRequest) {
      lines.push(
        JSON.stringify({
          type: 'llm.request',
          turnId,
          systemPrompt: opaqueSystemPrompt,
          time: baseTime + 2,
        }),
      );
    }

    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId, step: 1, uuid: stepUuid },
        time: baseTime + 3,
      }),
    );

    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          turnId,
          stepUuid,
          toolCallId: callId,
          name: 'Read',
          args: { path: `src/module_${turnId}.ts` },
        },
        time: baseTime + 4,
      }),
    );

    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: callId,
          result: {
            output: includeOversizedTool ? `HEAD-${turnId}\n${largeToolChunk}\nTAIL-${turnId}` : `ok-${turnId}`,
            isError: false,
          },
        },
        time: baseTime + 5,
      }),
    );

    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId,
          stepUuid,
          uuid: `part-${turnId}`,
          part: { type: 'text', text: `turn-${turnId} ${mediumAssistantChunk}` },
        },
        time: baseTime + 6,
      }),
    );

    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId, step: 1, uuid: stepUuid },
        time: baseTime + 7,
      }),
    );

    lines.push(
      JSON.stringify({
        type: 'turn.ended',
        turnId,
        reason: 'completed',
        time: baseTime + 8,
      }),
    );
  }

  return `${lines.join('\n')}\n`;
}

function buildHeavySubagentWirePayload(): string {
  const chunk = 'C'.repeat(80 * 1024);
  const lines: string[] = [];
  for (let turnId = 0; turnId < SUBAGENT_TURNS; turnId += 1) {
    const stepUuid = `sub-step-${turnId}`;
    const baseTime = 1_700_050_000_000 + turnId * 500;
    lines.push(
      JSON.stringify({
        type: 'turn.prompt',
        turnId,
        promptId: `sub-prompt-${turnId}`,
        input: [{ type: 'text', text: `subagent task ${turnId}` }],
        origin: { kind: 'user' },
        time: baseTime + 1,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId, step: 1, uuid: stepUuid },
        time: baseTime + 2,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId,
          stepUuid,
          uuid: `sub-part-${turnId}`,
          part: { type: 'text', text: `sub-turn-${turnId} ${chunk}` },
        },
        time: baseTime + 3,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId, step: 1, uuid: stepUuid },
        time: baseTime + 4,
      }),
      JSON.stringify({
        type: 'turn.ended',
        turnId,
        reason: 'completed',
        time: baseTime + 5,
      }),
    );
  }
  return `${lines.join('\n')}\n`;
}

function findFirstContentRef(items: readonly Record<string, unknown>[]): ContentRef | undefined {
  const pickFrom = (raw: unknown): ContentRef | undefined => {
    if (Array.isArray(raw)) {
      return raw.find((entry): entry is ContentRef => entry !== null && typeof entry === 'object' && 'source' in entry && 'path' in entry);
    }
    if (raw !== null && typeof raw === 'object') {
      return Object.values(raw as Record<string, ContentRef>)[0];
    }
    return undefined;
  };
  for (const item of items) {
    if (item['kind'] !== 'turn') continue;
    const direct = pickFrom(item['contentRefs']);
    if (direct !== undefined) return direct;
    const steps = item['steps'] as readonly Record<string, unknown>[] | undefined;
    if (steps === undefined) continue;
    for (const step of steps) {
      const frames = step['frames'] as readonly Record<string, unknown>[] | undefined;
      if (frames === undefined) continue;
      for (const frame of frames) {
        const fromFrame = pickFrom(frame['contentRefs']);
        if (fromFrame !== undefined) return fromFrame;
      }
    }
  }
  return undefined;
}

describe('synthetic scale performance gate (cold open, older-page scroll, 120-subagent roster, 8MiB cold child)', () => {
  let homeDir = '';
  let server: RunningServer | undefined;
  let endpoint = '';
  let mainWireBytes = 0;
  let heavySubagentWireBytes = 0;

  beforeAll(async () => {
    const rng = createMulberry32(0x2026_1118);
    homeDir = await mkdtemp(join(tmpdir(), 'kiki-synthetic-scale-'));
    const workspaceRoot = join(homeDir, 'workspace');
    const workspaceId = encodeWorkDirKey(workspaceRoot);
    await mkdir(workspaceRoot, { recursive: true });

    const nowIso = new Date(1_700_000_000_000).toISOString();
    await writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({
        version: 1,
        workspaces: {
          [workspaceId]: {
            root: workspaceRoot,
            name: 'Scale Gate Workspace',
            created_at: nowIso,
            last_opened_at: nowIso,
          },
        },
        deleted_workspace_ids: [],
      }),
    );
    await writeFile(join(homeDir, 'config.toml'), '[search]\nenabled = false\n');

    const sessionDir = join(homeDir, 'sessions', workspaceId, SESSION_ID);
    const mainDir = join(sessionDir, 'agents', 'main');
    const heavySubDir = join(sessionDir, 'agents', HEAVY_SUBAGENT_ID);
    const mediaDir = join(sessionDir, 'media', 'files');
    await mkdir(mainDir, { recursive: true });
    await mkdir(heavySubDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });

    const mainPayload = buildMainWirePayload(rng);
    mainWireBytes = Buffer.byteLength(mainPayload);
    await writeFile(join(mainDir, 'wire.jsonl'), mainPayload);

    const heavySubPayload = buildHeavySubagentWirePayload();
    heavySubagentWireBytes = Buffer.byteLength(heavySubPayload);
    await writeFile(join(heavySubDir, 'wire.jsonl'), heavySubPayload);

    const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    for (let m = 0; m < 30; m += 1) {
      await writeFile(join(mediaDir, `asset_${m}.png`), pngHeader);
    }

    const agentsMeta: Record<string, Record<string, unknown>> = {
      main: { type: 'main', model: 'example/scale-model', toolCallCount: MAIN_TURNS },
      [HEAVY_SUBAGENT_ID]: {
        type: 'sub',
        parentAgentId: 'main',
        displayName: 'Subagent Heavy',
        model: 'example/scale-sub',
        status: 'completed',
        completedAt: 1_700_060_000_000,
        toolCallCount: SUBAGENT_TURNS,
      },
    };

    for (let i = 1; i < TOTAL_SUBAGENTS; i += 1) {
      const subId = `agent-${i}`;
      const subDir = join(sessionDir, 'agents', subId);
      await mkdir(subDir, { recursive: true });
      await writeFile(
        join(subDir, 'wire.jsonl'),
        `${JSON.stringify({
          type: 'turn.prompt',
          turnId: 0,
          promptId: `p-${i}`,
          input: [{ type: 'text', text: `child ${i}` }],
          origin: { kind: 'user' },
          time: 1_700_010_000_000 + i,
        })}\n${JSON.stringify({ type: 'turn.ended', turnId: 0, reason: 'completed', time: 1_700_010_000_100 + i })}\n`,
      );
      agentsMeta[subId] = {
        type: 'sub',
        parentAgentId: 'main',
        displayName: `Subagent #${i}`,
        model: 'example/scale-sub',
        status: 'completed',
        completedAt: 1_700_010_000_200 + i,
      };
    }

    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify({
        id: SESSION_ID,
        version: 2,
        title: 'Synthetic Scale Primary Session',
        titleKind: 'custom',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_090_000_000,
        archived: false,
        cwd: workspaceRoot,
        agents: agentsMeta,
      }),
    );

    for (let c = 0; c < 24; c += 1) {
      const catalogId = `scale_catalog_${c}`;
      const catalogDir = join(homeDir, 'sessions', workspaceId, catalogId);
      await mkdir(join(catalogDir, 'agents', 'main'), { recursive: true });
      await writeFile(join(catalogDir, 'agents', 'main', 'wire.jsonl'), '');
      await writeFile(
        join(catalogDir, 'state.json'),
        JSON.stringify({
          id: catalogId,
          version: 2,
          title: `Catalog Session #${c}`,
          titleKind: 'custom',
          createdAt: 1_700_000_000_000 + c,
          updatedAt: 1_700_080_000_000 + c,
          archived: false,
          cwd: workspaceRoot,
          agents: { main: { type: 'main', model: 'example/scale-model' } },
        }),
      );
    }

    const seeds: ScopeSeed = [[IModelCatalog, createNoopModelCatalog()]];
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir,
      logLevel: 'silent',
      seeds,
    });
    endpoint = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (homeDir !== '') {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('generates >10 MiB main wire and >6 MiB cold subagent wire and serves cold catalog without resuming sessions', async () => {
    expect(mainWireBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(heavySubagentWireBytes).toBeGreaterThan(6 * 1024 * 1024);

    const started = performance.now();
    const headers = authHeaders(server as RunningServer);
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
  });

  it('serves cold session open TTFC, older-page scroll slices, contentRef hydration, and 8 MiB cold subagent within scale bounds', async () => {
    const eld = monitorEventLoopDelay({ resolution: 20 });
    eld.enable();
    const klient = createKlient({
      endpoint,
      token: bearerToken(server as RunningServer),
      WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
      timeoutMs: 30_000,
    });

    try {
      eld.reset();
      const openStarted = performance.now();
      let resetEvent: TranscriptResetEvent | undefined;
      let mainResetMs = -1;
      let readyMs = -1;

      const view = klient.session(SESSION_ID).view;
      const openDone = new Promise<void>((resolve, reject) => {
        view.subscribe(
          {
            sessionCursor: { seq: 0 },
            transcriptGrades: { '*': 'turn', main: 'delta' },
            bootstrap: true,
          },
          (signal) => {
            if (signal.type === 'transcript' && signal.event.agent_id === 'main' && signal.event.type === 'transcript.reset') {
              if (mainResetMs < 0) {
                mainResetMs = performance.now() - openStarted;
                resetEvent = signal.event;
              }
              if (readyMs >= 0) resolve();
            } else if (signal.type === 'ready') {
              readyMs = performance.now() - openStarted;
              if (mainResetMs >= 0) resolve();
            } else if (signal.type === 'protocolError') {
              reject(new Error(signal.detail));
            }
          },
        );
      });

      await openDone;
      expect(mainResetMs).toBeGreaterThanOrEqual(0);
      expect(mainResetMs).toBeLessThan(3_000);
      expect(resetEvent).toBeDefined();
      const initialTurns = resetEvent!.snapshot.items.filter((item) => item.kind === 'turn');
      expect(initialTurns.length).toBe(20);
      expect(resetEvent!.snapshot.hasMoreOlder || resetEvent!.coverage.hasMoreOlder).toBe(true);
      expect(getLiveSessionById(server!.core.accessor, SESSION_ID)).toBeUndefined();

      let beforeTurn: string | undefined = initialTurns[0]!.turnId;
      let hydrated = false;
      for (let pageIdx = 0; pageIdx < 2; pageIdx += 1) {
        const pageStart = performance.now();
        let page = await view.transcript.page({ agentId: 'main', beforeTurn, pageSize: 40 });
        while (page.read?.readiness === 'preparing' && page.next_cursor !== undefined) {
          page = await view.transcript.page({
            agentId: 'main',
            beforeItem: page.next_cursor,
            pageSize: 40,
          });
        }
        const pageMs = performance.now() - pageStart;
        expect(pageMs).toBeLessThan(6_000);
        const pageTurns = page.items.filter((item) => item.kind === 'turn');
        expect(pageTurns.length).toBeGreaterThan(0);
        beforeTurn = pageTurns[0]!.turnId;

        if (!hydrated) {
          const ref = findFirstContentRef(page.items as unknown as readonly Record<string, unknown>[]);
          if (ref !== undefined) {
            let attempts = 0;
            const fetchContent = view.transcript.content;
            expect(fetchContent).toBeDefined();
            while (attempts < 10 && fetchContent !== undefined) {
              attempts += 1;
              try {
                const segment = await fetchContent({ agentId: 'main', ref });
                expect(segment).toBeDefined();
                hydrated = true;
                break;
              } catch (error) {
                if ((error as { readonly code?: number }).code !== 40923) throw error;
                await new Promise<void>((r) => {
                  setTimeout(r, 40);
                });
              }
            }
          }
        }
      }
      expect(hydrated).toBe(true);

      const subStart = performance.now();
      let subPage = await view.transcript.page({ agentId: HEAVY_SUBAGENT_ID, pageSize: 20 });
      while (subPage.read?.readiness === 'preparing' && subPage.next_cursor !== undefined) {
        subPage = await view.transcript.page({
          agentId: HEAVY_SUBAGENT_ID,
          beforeItem: subPage.next_cursor,
          pageSize: 20,
        });
      }
      const hooksRes = await fetch(
        `${endpoint}/api/sessions/${SESSION_ID}/agents/${HEAVY_SUBAGENT_ID}/hooks?observe=true`,
        { headers: authHeaders(server as RunningServer) } as never,
      );
      const subMs = performance.now() - subStart;
      const subTurns = subPage.items.filter((item) => item.kind === 'turn');
      expect(subTurns.length).toBeGreaterThan(0);
      expect(subTurns.length).toBeLessThanOrEqual(20);
      expect(subPage.has_more).toBe(true);
      expect(hooksRes.status).toBe(200);
      expect(subMs).toBeLessThan(2_500);

      const eldP99Ms = eld.count > 0 ? Math.max(0, eld.percentile(99) / 1e6 - 20) : 0;
      expect(eldP99Ms).toBeLessThan(800);
    } finally {
      eld.disable();
      await klient.close();
    }
  });
});
