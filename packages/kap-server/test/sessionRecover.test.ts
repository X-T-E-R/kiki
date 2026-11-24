import { describe, expect, it, vi } from 'vitest';

import {
  IAgentExecutionService,
  IAgentLifecycleService,
  IAgentPromptService,
  IAgentStateService,
  IAgentTaskService,
  IEventService,
  ISessionManager,
  ISessionMetadata,
  MAIN_AGENT_ID,
  type Scope,
} from '@kiki/agent-core-v2';
import { turnKey } from '@kiki/agent-core-v2/agent/loop/turnOps';
import {
  currentRuntimeBootId,
  setRuntimeBootIdForTesting,
} from '@kiki/agent-core-v2/session/sessionActivity/sessionOutcomeMirrorService';

import { registerSessionRecoverRoute, toWireInterruptedWork } from '../src/routes/sessionRecover';

describe('toWireInterruptedWork', () => {
  it('suppresses interrupted_work while session is live busy', () => {
    const result = toWireInterruptedWork(
      {
        updatedAt: 1_700_000_000_000,
        activeRunBootId: 'previous-boot-id',
        interruptedWork: {
          interruptedAt: 1_700_000_000_000,
          mainInterrupted: true,
          lostTasks: 2,
        },
      },
      true,
    );
    expect(result).toBeUndefined();
  });

  it('synthesizes cold interrupted_work in O(1) when activeRunBootId belongs to a previous process boot', () => {
    const prev = setRuntimeBootIdForTesting('boot-new');
    try {
      expect(currentRuntimeBootId()).toBe('boot-new');
      const stale = toWireInterruptedWork(
        { updatedAt: 1_700_000_000_000, activeRunBootId: 'boot-old' },
        false,
      );
      expect(stale).toEqual({
        interrupted_at: new Date(1_700_000_000_000).toISOString(),
        main_interrupted: true,
      });

      const current = toWireInterruptedWork(
        { updatedAt: 1_700_000_000_000, activeRunBootId: 'boot-new' },
        false,
      );
      expect(current).toBeUndefined();
    } finally {
      setRuntimeBootIdForTesting(prev);
    }
  });

  it('projects persisted interruptedWork targets onto wire snake_case schema', () => {
    const wire = toWireInterruptedWork(
      {
        updatedAt: 1_700_000_000_000,
        interruptedWork: {
          interruptedAt: 1_700_000_001_000,
          mainInterrupted: true,
          lostTasks: 3,
          interruptedBranches: 1,
          targets: [
            { agentId: 'main', kind: 'main', reason: 'recovery' },
            { agentId: 'branch-1', label: 'Refactor', kind: 'branch', reason: 'branch_interrupted', lostTasks: 2 },
          ],
        },
      },
      false,
    );
    expect(wire).toEqual({
      interrupted_at: new Date(1_700_000_001_000).toISOString(),
      main_interrupted: true,
      lost_tasks: 3,
      interrupted_branches: 1,
      targets: [
        { agent_id: 'main', label: undefined, kind: 'main', reason: 'recovery', lost_tasks: undefined },
        { agent_id: 'branch-1', label: 'Refactor', kind: 'branch', reason: 'branch_interrupted', lost_tasks: 2 },
      ],
    });
  });
});

describe('POST /sessions/:session_id/recover', () => {
  function setupRoute(options: {
    readonly executionState?: 'idle' | 'running';
    readonly unfinishedTurn?: boolean;
    readonly lostTask?: boolean;
  }) {
    const enqueued: unknown[] = [];
    const metadataPatches: unknown[] = [];
    const publishedEvents: unknown[] = [];
    const resumedQueues: number[] = [];

    const agentServices = new Map<unknown, unknown>([
      [
        IAgentExecutionService,
        { status: () => ({ state: options.executionState ?? 'idle' }) },
      ],
      [
        IAgentPromptService,
        {
          list: () => ({ active: undefined, launching: undefined, pending: [] }),
          resumeRecoveredQueue: () => { resumedQueues.push(1); },
          enqueue: async (input: unknown) => {
            enqueued.push(input);
            return { id: 'prompt-recovery-1' };
          },
        },
      ],
      [
        IAgentStateService,
        {
          has: (key: unknown) => key === turnKey,
          get: () => ({
            nextTurnId: 2,
            cancelledTurnIds: [],
            heldCancelledTurns: {},
            anchorTurnIds: [1],
            activeTurnIds: options.unfinishedTurn ? [1] : [],
            lastEnded: options.unfinishedTurn ? undefined : { turnId: 1, reason: 'completed' },
          }),
        },
      ],
      [
        IAgentTaskService,
        {
          resumeRestoration: async () => {},
          list: () =>
            options.lostTask
              ? [
                  {
                    taskId: 'task-lost-1',
                    kind: 'agent',
                    agentId: 'child-1',
                    status: 'lost',
                    description: 'Interrupted worker',
                  },
                ]
              : [],
        },
      ],
    ]);
    const mainHandle = {
      id: MAIN_AGENT_ID,
      accessor: { get: (id: unknown) => agentServices.get(id) },
    };
    const sessionServices = new Map<unknown, unknown>([
      [
        IAgentLifecycleService,
        {
          get: (id: string) => (id === MAIN_AGENT_ID ? mainHandle : undefined),
          create: async () => mainHandle,
          list: () => [mainHandle],
        },
      ],
      [
        ISessionMetadata,
        {
          read: async () => ({
            id: 'session-1',
            createdAt: 1,
            updatedAt: 2,
            archived: false,
            agents: {
              [MAIN_AGENT_ID]: { type: 'main' },
              'child-1': { type: 'sub', displayName: 'Worker' },
            },
          }),
          update: async (patch: unknown) => {
            metadataPatches.push(patch);
          },
        },
      ],
    ]);
    const sessionHandle = {
      accessor: { get: (id: unknown) => sessionServices.get(id) },
    };
    const coreServices = new Map<unknown, unknown>([
      [
        ISessionManager,
        {
          get: () => sessionHandle,
          acquire: async () => ({ handle: sessionHandle, dispose: async () => {} }),
        },
      ],
      [
        IEventService,
        { publish: (event: unknown) => publishedEvents.push(event) },
      ],
    ]);
    const core = { accessor: { get: (id: unknown) => coreServices.get(id) } } as unknown as Scope;

    let handler: ((req: { id: string; params: unknown; body: unknown }, reply: { send(payload: unknown): unknown }) => Promise<void>) | undefined;
    const app = {
      post: (_path: string, _options: unknown, fn: typeof handler) => {
        handler = fn;
      },
    };
    registerSessionRecoverRoute(app, core);
    return {
      invoke: async (body: Record<string, unknown> = {}) => {
        const send = vi.fn();
        await handler!({ id: 'req-1', params: { session_id: 'session-1' }, body }, { send });
        return send.mock.calls[0]?.[0] as { code: number; data: Record<string, unknown> };
      },
      enqueued,
      metadataPatches,
      publishedEvents,
    };
  }

  it('recovers an unfinished turn and lost child task via system_trigger without duplicating user prompts', async () => {
    const harness = setupRoute({ unfinishedTurn: true, lostTask: true });
    const res = await harness.invoke({});
    expect(res.code).toBe(0);
    expect(res.data).toMatchObject({
      session_id: 'session-1',
      agent_id: 'main',
      status: 'recovered',
      prompt_id: 'prompt-recovery-1',
    });
    expect(harness.enqueued).toHaveLength(1);
    const enqueued = harness.enqueued[0] as {
      waitForLaunch: boolean;
      message: { origin: { kind: string; name: string }; content: Array<{ text: string }> };
    };
    expect(enqueued.waitForLaunch).toBe(false);
    expect(enqueued.message.origin).toEqual({ kind: 'system_trigger', name: 'interruption_recovery' });
    expect(enqueued.message.content[0]?.text).toContain('<system-reminder>');
    expect(enqueued.message.content[0]?.text).toContain('task-lost-1');
    expect(harness.metadataPatches).toContainEqual(expect.objectContaining({ interruptedWork: undefined }));
    expect(harness.publishedEvents.length).toBe(1);
  });

  it('returns already_running idempotently when the target agent is active', async () => {
    const harness = setupRoute({ executionState: 'running', unfinishedTurn: true });
    const res = await harness.invoke({});
    expect(res.code).toBe(0);
    expect(res.data).toMatchObject({ status: 'already_running', recovered_targets: [] });
    expect(harness.enqueued).toHaveLength(0);
  });

  it('returns nothing_to_recover when there are no unfinished turns, lost tasks, or stale markers', async () => {
    const harness = setupRoute({ unfinishedTurn: false, lostTask: false });
    const res = await harness.invoke({});
    expect(res.code).toBe(0);
    expect(res.data).toMatchObject({ status: 'nothing_to_recover', recovered_targets: [] });
    expect(harness.enqueued).toHaveLength(0);
  });
});
