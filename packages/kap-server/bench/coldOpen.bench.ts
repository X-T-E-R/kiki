/**
 * Cold-open perf harness for the transcript session-open path.
 *
 * Reports instead of asserting, so the same file runs unchanged against an
 * older revision to produce comparable before/after numbers. Two lanes, each
 * measuring one half of the cold-open cost:
 *
 *   A. WS `subscribe_v2` seeding — how many agent wire journals one cold
 *      session open folds, given a persisted roster of `SUBAGENTS` agents that
 *      are NOT live in the process. Counted at `TranscriptService`
 *      `readColdSnapshot`, which is exactly one full wire read + fold.
 *   B. REST snapshot message history — the wire fold + blob rehydration +
 *      message projection that the snapshot route performs for the main agent
 *      before slicing the newest 100 messages.
 *
 * Wall times come from a single run on the developer machine and are indicative
 * only; the fold/read counts and byte totals are deterministic.
 */

import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_WIRE_RECORD_KEY,
  IAgentBlobService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPromptService,
  IAgentScopeContext,
  IAgentTaskService,
  IAppendLogStore,
  IEventBus,
  IEventService,
  ISessionActivityView,
  ISessionIndex,
  ISessionInteractionService,
  ISessionLifecycleService,
  ISessionManager,
  ISessionMetadata,
  IWireService,
  IWorkspaceInstanceManager,
  LifecycleScope,
  SessionInteractionService,
  StateRegistry,
  type ContextMessage,
  type IAgentScopeHandle,
  type ISessionStateService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import {
  captureContextMessageHistory,
  loadCapturedMessageHistory,
} from '../src/services/messages/messageHistory';
import { TranscriptService } from '../src/services/transcript/transcriptService';
import {
  SessionEventBroadcaster,
  type BroadcastTarget,
} from '../src/transport/ws/v1/sessionEventBroadcaster';

/** Vitest swallows `console.log` under a redirected stdout, so results also go
 * to a file. `BENCH_LABEL` tags the revision, `BENCH_OUT` picks the sink. */
function report(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
  const out = process.env.BENCH_OUT;
  if (out === undefined || out === '') return;
  appendFileSync(out, `${process.env.BENCH_LABEL ?? 'unlabeled'} ${line}\n`);
}

const SUBAGENTS = 24;
const TURNS_PER_AGENT = 40;
const ASSISTANT_TEXT = 'x'.repeat(2_048);
const SESSION_ID = 's1';
const WORKSPACE_ID = 'ws';

class BenchSessionStateService extends StateRegistry implements ISessionStateService {
  declare readonly _serviceBrand: undefined;
}

function wireRecords(turns: number): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (let turnId = 0; turnId < turns; turnId++) {
    const stepUuid = `step-${turnId}`;
    records.push(
      {
        type: 'turn.prompt',
        turnId,
        promptId: `prompt-${turnId}`,
        input: [{ type: 'text', text: `question ${turnId}` }],
        origin: { kind: 'user' },
        time: turnId * 1_000 + 1,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId, step: 1, uuid: stepUuid },
        time: turnId * 1_000 + 2,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId,
          stepUuid,
          uuid: `part-${turnId}`,
          part: { type: 'text', text: ASSISTANT_TEXT },
        },
        time: turnId * 1_000 + 3,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId, step: 1, uuid: stepUuid },
        time: turnId * 1_000 + 4,
      },
      { type: 'turn.ended', turnId, reason: 'completed', time: turnId * 1_000 + 5 },
    );
  }
  return records;
}

function serialize(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

async function seedHome(agentIds: readonly string[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-cold-open-bench-'));
  const body = serialize(wireRecords(TURNS_PER_AGENT));
  for (const agentId of agentIds) {
    const dir = join(home, 'sessions', WORKSPACE_ID, SESSION_ID, 'agents', agentId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'wire.jsonl'), body);
  }
  return home;
}

interface BenchAgent {
  readonly id: string;
  readonly bus: BenchBus;
  readonly accessor: { get: (token: unknown) => unknown };
}

class BenchBus {
  private readonly listeners = new Set<(event: unknown) => void>();
  subscribe(listener: (event: unknown) => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  emit(event: unknown): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

class BenchAgents {
  private readonly handles = new Map<string, BenchAgent>();
  list(): BenchAgent[] {
    return [...this.handles.values()];
  }
  get(id: string): BenchAgent | undefined {
    return this.handles.get(id);
  }
  onDidCreate(): { dispose: () => void } {
    return { dispose: () => undefined };
  }
  onDidDispose(): { dispose: () => void } {
    return { dispose: () => undefined };
  }
  add(id: string): BenchAgent {
    const bus = new BenchBus();
    const handle: BenchAgent = {
      id,
      bus,
      accessor: {
        get: (token: unknown) => {
          if (token === IEventBus) return bus;
          if (token === IAgentLoopService) return { status: () => ({ state: 'idle' }) };
          if (token === IAgentTaskService) return { list: () => [] };
          if (token === IAgentPromptService) return { list: () => ({ pending: [] }) };
          return undefined;
        },
      },
    };
    this.handles.set(id, handle);
    return handle;
  }
}

/**
 * Just enough of the engine surface for the transcript service and the
 * broadcaster: one session whose persisted roster lists every agent, but whose
 * live agent set holds only the ones handed in (a cold open materializes main).
 */
function benchCore(agents: BenchAgents, rosterAgentIds: readonly string[]): Scope {
  const interactions = new SessionInteractionService(new BenchSessionStateService());
  const metaAgents = Object.fromEntries(
    rosterAgentIds.map((agentId) => [
      agentId,
      agentId === 'main' ? { type: 'main' } : { type: 'sub', parentAgentId: 'main' },
    ]),
  );
  const sessionFor = (sessionId: string): unknown =>
    sessionId !== SESSION_ID
      ? undefined
      : {
          id: sessionId,
          kind: LifecycleScope.Session,
          accessor: {
            get: (token: unknown) => {
              if (token === IAgentLifecycleService) return agents;
              if (token === ISessionInteractionService) return interactions;
              if (token === ISessionMetadata) return { read: async () => ({ agents: metaAgents }) };
              if (token === ISessionActivityView) {
                return {
                  state: () => ({
                    busy: false,
                    mainTurnActive: false,
                    pendingInteraction: 'none' as const,
                  }),
                  onDidChange: () => ({ dispose: () => undefined }),
                };
              }
              return undefined;
            },
          },
          dispose: () => undefined,
        };
  const sessionLifecycle = {
    onDidCloseSession: () => ({ dispose: () => undefined }),
    onDidArchiveSession: () => ({ dispose: () => undefined }),
    get: sessionFor,
  };
  const program = {
    accessor: {
      get: (token: unknown) => (token === ISessionLifecycleService ? sessionLifecycle : undefined),
    },
  };
  return {
    accessor: {
      get: (token: unknown) => {
        if (token === IEventService) return { subscribe: () => ({ dispose: () => undefined }) };
        if (token === ISessionManager) {
          return {
            get: sessionFor,
            list: () => [sessionFor(SESSION_ID)],
            onDidCloseSession: () => ({ dispose: () => undefined }),
            onDidArchiveSession: () => ({ dispose: () => undefined }),
          };
        }
        if (token === IWorkspaceInstanceManager) {
          return {
            list: () => [{ program }],
            onDidChange: () => ({ dispose: () => undefined }),
          };
        }
        if (token === ISessionIndex) {
          return { get: async () => ({ workspaceId: WORKSPACE_ID, createdAt: 0 }) };
        }
        return undefined;
      },
    },
  } as unknown as Scope;
}

function silentTarget(): BroadcastTarget {
  return { send: () => undefined };
}

describe('cold open', () => {
  it('A: WS subscribe seeding over a cold persisted roster', async () => {
    const rosterAgentIds = ['main', ...Array.from({ length: SUBAGENTS }, (_, i) => `sub-${i}`)];
    const home = await seedHome(rosterAgentIds);
    const eventsDir = await mkdtemp(join(tmpdir(), 'kiki-cold-open-bench-events-'));
    const perAgentBytes = (
      await stat(join(home, 'sessions', WORKSPACE_ID, SESSION_ID, 'agents', 'main', 'wire.jsonl'))
    ).size;
    const agents = new BenchAgents();
    agents.add('main');
    const core = benchCore(agents, rosterAgentIds);
    const service = new TranscriptService({ homeDir: home, core });
    const folded: string[] = [];
    const readColdSnapshot = service.readColdSnapshot.bind(service);
    service.readColdSnapshot = async (sessionId, agentId = 'main') => {
      folded.push(agentId);
      return readColdSnapshot(sessionId, agentId);
    };
    const broadcaster = new SessionEventBroadcaster({ eventsDir, core, transcriptService: service });
    try {
      const startedAt = performance.now();
      await broadcaster.subscribe(SESSION_ID, silentTarget(), undefined, {
        '*': 'turn',
        main: 'delta',
      });
      const ms = performance.now() - startedAt;
      report(
        `[bench] cold-open A rosterAgents=${rosterAgentIds.length} turnsPerAgent=${TURNS_PER_AGENT} ` +
          `wireBytesPerAgent=${perAgentBytes} => wireFolds=${folded.length} ` +
          `wireBytesFolded=${folded.length * perAgentBytes} ms=${ms.toFixed(1)}`,
      );
      expect(folded.length).toBeGreaterThan(0);
    } finally {
      await broadcaster.close();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      await rm(eventsDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('C: REST snapshot subagent tool-call counts over a cold roster', async () => {
    const subagentIds = Array.from({ length: SUBAGENTS }, (_, i) => `sub-${i}`);
    const home = await seedHome(['main', ...subagentIds]);
    const perAgentBytes = (
      await stat(join(home, 'sessions', WORKSPACE_ID, SESSION_ID, 'agents', 'main', 'wire.jsonl'))
    ).size;
    const agents = new BenchAgents();
    agents.add('main');
    const service = new TranscriptService({
      homeDir: home,
      core: benchCore(agents, ['main', ...subagentIds]),
    });
    const folded: string[] = [];
    const readColdSnapshot = service.readColdSnapshot.bind(service);
    service.readColdSnapshot = async (sessionId, agentId = 'main') => {
      folded.push(agentId);
      return readColdSnapshot(sessionId, agentId);
    };
    try {
      const startedAt = performance.now();
      const counts = await service.getAgentToolCallCounts(SESSION_ID, subagentIds);
      const ms = performance.now() - startedAt;
      report(
        `[bench] cold-open C subagentsRequested=${subagentIds.length} ` +
          `wireBytesPerAgent=${perAgentBytes} => wireFolds=${folded.length} ` +
          `wireBytesFolded=${folded.length * perAgentBytes} counts=${counts.size} ms=${ms.toFixed(1)}`,
      );
      expect(counts.size).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('B: REST snapshot main-agent message history fold', async () => {
    const records = wireRecords(TURNS_PER_AGENT * 4);
    const bytes = Buffer.byteLength(serialize(records));
    let appendLogReads = 0;
    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token !== IAppendLogStore) return undefined;
          return {
            read: async function* (_scope: unknown, key: unknown) {
              if (key !== AGENT_WIRE_RECORD_KEY) return;
              appendLogReads += 1;
              for (const record of records) yield record;
            },
          };
        },
      },
    } as unknown as Scope;
    const agent = {
      accessor: {
        get: (token: unknown) => {
          if (token === IWireService) return { flush: async () => undefined };
          if (token === IAgentScopeContext) return { scope: () => ({ id: 'main' }) };
          if (token === IAgentBlobService) {
            return { loadParts: async (parts: unknown) => parts };
          }
          return undefined;
        },
      },
    } as unknown as IAgentScopeHandle;

    const contextMessages: ContextMessage[] = Array.from(
      { length: TURNS_PER_AGENT * 4 },
      (_, index) =>
        index % 2 === 0
          ? { role: 'user', content: [{ type: 'text', text: `question ${index}` }] }
          : {
              role: 'assistant',
              content: [{ type: 'text', text: ASSISTANT_TEXT }],
              toolCalls: [],
            },
    ) as ContextMessage[];

    const startedAt = performance.now();
    const captured = await captureContextMessageHistory(core, agent, contextMessages);
    const projected = await loadCapturedMessageHistory(
      agent,
      SESSION_ID,
      0,
      captured.messages,
      captured.times,
    );
    const ms = performance.now() - startedAt;
    report(
      `[bench] cold-open B wireRecords=${records.length} wireBytes=${bytes} ` +
        `contextMessages=${contextMessages.length} => appendLogReads=${appendLogReads} ` +
        `projectedMessages=${projected.length} ms=${ms.toFixed(1)}`,
    );
    expect(appendLogReads).toBe(1);
  });
});
