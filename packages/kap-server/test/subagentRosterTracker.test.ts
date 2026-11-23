import type { Event } from '../src/transport/ws/v1/events';
import type { AgentActivityState, SessionMeta } from '@kiki/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import { sessionAgentCounts } from '../src/routes/sessionAgentCounts';
import { sessionAgentRoster } from '../src/routes/sessionAgentRoster';
import { SubagentRosterTracker } from '../src/transport/ws/v1/subagentRosterTracker';

const SID = 'sess_1';

function ev(partial: Record<string, unknown>): Event {
  return { agentId: 'main', sessionId: SID, ...partial } as unknown as Event;
}

function spawn(subagentId: string, extra: Record<string, unknown> = {}): Event {
  return ev({
    type: 'subagent.spawned',
    subagentId,
    subagentName: 'kimi-subagent',
    parentAgentId: 'main',
    parentToolCallId: 'tc_child_1',
    description: `task ${subagentId}`,
    userLabel: `task ${subagentId}`,
    runInBackground: false,
    ...extra,
  });
}

describe('SubagentRosterTracker', () => {
  it('does not synthesize birth from spawn or task starts across generations', () => {
    const tracker = new SubagentRosterTracker();
    tracker.apply(SID, spawn('child', { time: 100 }));
    expect(tracker.get(SID)[0]?.created_at).toBeUndefined();
    tracker.apply(SID, ev({ type: 'subagent.completed', subagentId: 'child', time: 200, resultSummary: 'done' }));
    tracker.apply(SID, spawn('child', { time: 300 }));
    expect(tracker.get(SID)[0]).toMatchObject({ created_at: undefined, started_at: new Date(300).toISOString() });
    tracker.seedTask(SID, 'main', { kind: 'agent', taskId: 'next', agentId: 'child', description: 'next',
      status: 'running', startedAt: 400, endedAt: null });
    expect(tracker.get(SID)[0]?.created_at).toBeUndefined();
  });
  it('ignores late lifecycle events belonging to an older registered task', () => {
    const tracker = new SubagentRosterTracker();
    for (const [taskId, startedAt] of [['task-a', 100], ['task-b', 200]] as const) {
      tracker.apply(SID, ev({
        type: 'task.started',
        time: startedAt,
        info: {
          taskId,
          kind: 'agent',
          agentId: 'child',
          detached: false,
          description: 'task child',
          status: 'running',
          startedAt,
          endedAt: null,
        },
      }));
      tracker.apply(SID, spawn('child', { taskId, time: startedAt }));
    }
    expect(tracker.get(SID)[0]).toMatchObject({
      status: 'running',
      started_at: new Date(200).toISOString(),
    });
    tracker.apply(SID, ev({ type: 'subagent.completed', subagentId: 'child', taskId: 'task-a', resultSummary: 'old complete', time: 300 }));
    tracker.apply(SID, ev({ type: 'subagent.failed', subagentId: 'child', taskId: 'task-a', error: 'old error', time: 400 }));
    expect(tracker.get(SID)[0]).toMatchObject({ status: 'running' });
    tracker.apply(SID, ev({ type: 'subagent.completed', subagentId: 'child', taskId: 'task-b', resultSummary: 'new complete', time: 500 }));
    tracker.apply(SID, ev({ type: 'subagent.started', subagentId: 'child', taskId: 'task-a', time: 600 }));
    expect(tracker.get(SID)[0]).toMatchObject({ status: 'completed', output_preview: 'new complete' });
  });

  it('seeds a roster entry from subagent.spawned with its identity metadata', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { model: 'provider/secondary', thinkingEffort: 'low' }));

    expect(t.get(SID)).toEqual([
      expect.objectContaining({
        id: 'agent-1',
        session_id: SID,
        kind: 'subagent',
        description: 'task agent-1',
        label: 'task agent-1',
        status: 'running',
        subagent_phase: 'queued',
        profile: 'kimi-subagent',
        parent_agent_id: 'main',
        parent_tool_call_id: 'tc_child_1',
        tool_call_count: 0,
        run_in_background: false,
        model: 'provider/secondary',
        thinking_effort: 'low',
      }),
    ]);
  });

  it('resolves the display name from user label, spawned name, then agent id', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-label', { userLabel: 'User label', subagentName: 'spawned' }));
    t.apply(SID, spawn('agent-name', { userLabel: undefined, subagentName: 'spawned' }));
    t.apply(SID, spawn('agent-id', { userLabel: undefined, subagentName: '' }));

    expect(t.get(SID).map((entry) => entry.description)).toEqual([
      'User label',
      'spawned',
      'agent-id',
    ]);
  });

  it('treats an empty parentToolCallId as absent', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { parentToolCallId: '' }));
    expect(t.get(SID)[0]?.parent_tool_call_id).toBeUndefined();
  });

  it('preserves existing description when a follow-up subagent.spawned omits userLabel', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { userLabel: 'Audit auth flow', subagentName: 'implementer', taskId: 'task-1', time: 100 }));
    t.apply(SID, ev({ type: 'subagent.completed', subagentId: 'agent-1', taskId: 'task-1', resultSummary: 'done', time: 200 }));
    t.apply(SID, spawn('agent-1', { userLabel: undefined, subagentName: 'implementer', parentToolCallId: '', taskId: 'task-2', time: 300 }));
    expect(t.get(SID)[0]).toMatchObject({
      description: 'Audit auth flow',
      label: 'Audit auth flow',
      parent_tool_call_id: 'tc_child_1',
    });
  });

  it('counts distinct child tool calls in the reconnect roster', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1'));
    const started = (toolCallId: string): Event =>
      ev({ type: 'tool.call.started', agentId: 'agent-1', turnId: 1, toolCallId, name: 'Bash', args: {} });

    t.apply(SID, started('tool-1'));
    t.apply(SID, started('tool-1'));
    t.apply(SID, started('tool-2'));

    expect(t.get(SID)[0]?.tool_call_count).toBe(2);
  });

  it('keeps background subagents in the reconnect roster', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { runInBackground: true }));
    expect(t.get(SID)[0]).toMatchObject({
      id: 'agent-1',
      status: 'running',
      run_in_background: true,
    });
  });

  it('keeps the entry when a foreground subagent detaches into a background task', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1'));

    const taskStarted = (detached: boolean): Event =>
      ev({
        type: 'task.started',
        info: {
          taskId: 'task_1',
          kind: 'agent',
          agentId: 'agent-1',
          detached,
          description: 'task agent-1',
          status: 'running',
          startedAt: 1,
          endedAt: null,
        },
      });

    t.apply(SID, taskStarted(false));
    expect(t.get(SID)).toHaveLength(1);

    t.apply(SID, taskStarted(true));
    expect(t.get(SID)[0]).toMatchObject({
      id: 'agent-1',
      status: 'running',
      run_in_background: true,
    });
  });

  it('seeds a detached running child from task.started before subagent.spawned', () => {
    const t = new SubagentRosterTracker();
    t.apply(
      SID,
      ev({
        type: 'task.started',
        agentId: 'main',
        info: {
          taskId: 'task_1',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'task agent-1',
          status: 'running',
          startedAt: 1,
          endedAt: null,
        },
      }),
    );

    expect(t.get(SID)[0]).toMatchObject({
      id: 'agent-1',
      parent_agent_id: 'main',
      status: 'running',
      subagent_phase: 'working',
      run_in_background: true,
    });
  });

  it('follows foreground subagent phase transitions even when spawn carries a task id', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { taskId: 'task-foreground' }));
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent-1' }));
    expect(t.get(SID)[0]).toMatchObject({ subagent_phase: 'working' });
    expect(t.get(SID)[0]?.started_at).toBeDefined();

    t.apply(
      SID,
      ev({ type: 'subagent.suspended', subagentId: 'agent-1', reason: 'rate limit' }),
    );
    expect(t.get(SID)[0]).toMatchObject({
      subagent_phase: 'suspended',
      suspended_reason: 'rate limit',
    });

    const startedAt = t.get(SID)[0]?.started_at;
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent-1' }));
    expect(t.get(SID)[0]).toMatchObject({ subagent_phase: 'working', started_at: startedAt });
    expect(t.get(SID)[0]?.suspended_reason).toBeUndefined();

    t.apply(
      SID,
      ev({ type: 'subagent.completed', subagentId: 'agent-1', resultSummary: 'done' }),
    );
    expect(t.get(SID)[0]).toMatchObject({
      subagent_phase: 'completed',
      status: 'completed',
      output_preview: 'done',
    });
    expect(t.get(SID)[0]?.completed_at).toBeDefined();
  });

  it('marks failures with the error preview', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1'));
    t.apply(SID, ev({ type: 'subagent.failed', subagentId: 'agent-1', error: 'boom' }));
    expect(t.get(SID)[0]).toMatchObject({
      subagent_phase: 'failed',
      status: 'failed',
      output_preview: 'boom',
    });
  });

  it('marks a terminated foreground AgentRun as cancelled instead of failed', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { taskId: 'task-foreground' }));
    t.apply(SID, ev({ type: 'subagent.failed', subagentId: 'agent-1', error: 'terminated' }));
    expect(t.get(SID)[0]).toMatchObject({
      subagent_phase: undefined,
      status: 'cancelled',
      output_preview: 'terminated',
    });
  });

  it('retains the roster across parent and child turn boundaries', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1'));

    t.apply(SID, ev({ type: 'turn.ended', agentId: 'agent-1', turnId: 1 }));
    expect(t.get(SID)).toHaveLength(1);

    t.apply(SID, ev({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' }));
    expect(t.get(SID)).toHaveLength(1);

    t.apply(SID, ev({ type: 'turn.started', agentId: 'main', turnId: 2 }));
    expect(t.get(SID)[0]).toMatchObject({ id: 'agent-1', status: 'running' });
  });

  it('does not infer child failure from the main turn ending', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { runInBackground: true }));
    t.apply(SID, spawn('agent-2'));
    t.apply(SID, ev({ type: 'subagent.completed', subagentId: 'agent-2', resultSummary: 'done' }));

    t.apply(SID, ev({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'cancelled' }));

    const entries = t.get(SID);
    expect(entries[0]).toMatchObject({
      id: 'agent-1',
      status: 'running',
      subagent_phase: 'queued',
      run_in_background: true,
    });
    expect(entries[0]?.completed_at).toBeUndefined();
    expect(entries[1]).toMatchObject({ id: 'agent-2', status: 'completed', output_preview: 'done' });
  });

  it.each([
    ['completed', 'completed', 'completed'],
    ['failed', 'failed', 'failed'],
    ['timed_out', 'failed', 'failed'],
    ['lost', 'failed', 'failed'],
    ['killed', 'cancelled', undefined],
  ] as const)(
    'maps task.terminated %s to snapshot %s/%s idempotently',
    (taskStatus, status, phase) => {
      const t = new SubagentRosterTracker();
      t.apply(SID, spawn('agent-1', { runInBackground: true }));
      const terminated = ev({
        type: 'task.terminated',
        info: {
          taskId: 'task_1',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'task agent-1',
          status: taskStatus,
          startedAt: 1,
          endedAt: 2,
          stopReason: taskStatus === 'completed' ? undefined : `ended ${taskStatus}`,
        },
      });

      t.apply(SID, terminated);
      t.apply(SID, terminated);

      expect(t.get(SID)).toHaveLength(1);
      expect(t.get(SID)[0]).toMatchObject({
        id: 'agent-1',
        status,
        subagent_phase: phase,
      });
      expect(t.get(SID)[0]?.completed_at).toBe(new Date(2).toISOString());
    },
  );

  it('retains a terminal row through wakeup, startup, completion, and a failed next wake', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old', model: 'provider/old' }));
    t.apply(SID, ev({
      type: 'task.terminated', time: 200,
      info: {
        taskId: 'task-old', kind: 'agent', agentId: 'agent-1', detached: false,
        description: 'old run', status: 'completed', startedAt: 100, endedAt: 200,
      },
    }));
    t.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 201 }));
    expect(t.get(SID)[0]).toMatchObject({
      status: 'completed', subagent_phase: 'completed', live: false,
      model: 'provider/old', completed_at: new Date(200).toISOString(),
    });
    t.apply(SID, ev({ type: 'agent.created', agentId: 'agent-1', time: 200 }));
    expect(t.get(SID)[0]?.refreshing).toBeUndefined();

    t.apply(SID, ev({ type: 'agent.created', agentId: 'agent-1', time: 250 }));
    expect(t.get(SID)[0]).toMatchObject({
      status: 'completed', subagent_phase: 'completed', refreshing: true,
      model: 'provider/old', completed_at: new Date(200).toISOString(),
    });
    expect(t.get(SID)[0]?.live).toBeUndefined();
    t.apply(SID, ev({
      type: 'task.started', time: 300,
      info: {
        taskId: 'task-new', kind: 'agent', agentId: 'agent-1', detached: true,
        description: 'new run', status: 'running', startedAt: 300, endedAt: null,
        model: 'provider/new',
      },
    }));
    expect(t.get(SID)[0]).toMatchObject({
      status: 'running', subagent_phase: 'working', refreshing: true,
      model: 'provider/new', started_at: new Date(300).toISOString(),
    });
    expect(t.get(SID)[0]?.completed_at).toBeUndefined();
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent-1', taskId: 'task-new', time: 301 }));
    expect(t.get(SID)[0]?.refreshing).toBeUndefined();
    t.apply(SID, ev({
      type: 'task.terminated', time: 400,
      info: {
        taskId: 'task-new', kind: 'agent', agentId: 'agent-1', detached: true,
        description: 'new run', status: 'completed', startedAt: 300, endedAt: 400,
        model: 'provider/new',
      },
    }));
    expect(t.get(SID)[0]).toMatchObject({
      status: 'completed', subagent_phase: 'completed', model: 'provider/new',
      completed_at: new Date(400).toISOString(),
    });
    expect(t.get(SID)[0]?.refreshing).toBeUndefined();
    t.apply(SID, ev({ type: 'agent.created', agentId: 'agent-1', time: 450 }));
    expect(t.get(SID)[0]?.refreshing).toBe(true);
    t.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 460 }));
    expect(t.get(SID)[0]).toMatchObject({
      status: 'completed', live: false, completed_at: new Date(400).toISOString(),
    });
    expect(t.get(SID)[0]?.refreshing).toBeUndefined();
    t.apply(SID, ev({
      type: 'task.started', time: 500,
      info: {
        taskId: 'task-failed', kind: 'agent', agentId: 'agent-1', detached: true,
        description: 'failed run', status: 'running', startedAt: 500, endedAt: null,
      },
    }));
    expect(t.get(SID)[0]?.refreshing).toBe(true);
    t.apply(SID, ev({
      type: 'task.terminated', time: 600,
      info: {
        taskId: 'task-failed', kind: 'agent', agentId: 'agent-1', detached: true,
        description: 'failed run', status: 'failed', startedAt: 500, endedAt: 600,
        stopReason: 'provider error',
      },
    }));
    expect(t.get(SID)[0]).toMatchObject({
      status: 'failed', subagent_phase: 'failed', completed_at: new Date(600).toISOString(),
    });
    expect(t.get(SID)[0]?.refreshing).toBeUndefined();
  });

  it('expires an unconfirmed wake without replacing the prior terminal metadata', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { time: 100, model: 'provider/old' }));
    t.apply(SID, ev({ type: 'subagent.completed', subagentId: 'agent-1', time: 200, resultSummary: 'done' }));
    t.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 201 }));
    t.apply(SID, ev({ type: 'agent.created', agentId: 'agent-1', time: 300 }));
    const pending = t.get(SID)[0]!;
    expect(pending).toMatchObject({ status: 'completed', refreshing: true, model: 'provider/old' });
    expect(pending.live).toBeUndefined();
    const deadline = Date.parse(pending.refreshing_until!);
    expect(deadline).toBeGreaterThan(Date.now());
    const now = vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
    try {
      expect(t.get(SID)[0]).toMatchObject({
        status: 'completed', live: false, model: 'provider/old',
        completed_at: new Date(200).toISOString(),
      });
      expect(t.get(SID)[0]?.refreshing).toBeUndefined();
      expect(t.get(SID)[0]?.refreshing_until).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it('reopens a terminal child when a newer foreground spawn resumes the same agent', () => {
    const t = new SubagentRosterTracker();
    t.apply(
      SID,
      spawn('agent-1', { time: 1_000, taskId: 'task-old', runInBackground: true }),
    );
    t.apply(
      SID,
      ev({
        type: 'tool.call.started',
        agentId: 'agent-1',
        turnId: 1,
        toolCallId: 'tool-1',
        name: 'Bash',
        args: {},
      }),
    );
    t.apply(
      SID,
      ev({
        type: 'task.terminated',
        info: {
          taskId: 'task-old',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'old run',
          status: 'killed',
          startedAt: 1_000,
          endedAt: 2_000,
          stopReason: 'old stop',
        },
      }),
    );

    t.apply(
      SID,
      spawn('agent-1', { time: 1_500, taskId: 'task-old', runInBackground: false }),
    );
    expect(t.get(SID)[0]).toMatchObject({ status: 'cancelled', tool_call_count: 1 });

    t.apply(
      SID,
      spawn('agent-1', { time: 2_001, taskId: 'task-new', runInBackground: false }),
    );
    expect(t.get(SID)[0]).toMatchObject({
      status: 'running',
      subagent_phase: 'queued',
      run_in_background: false,
      tool_call_count: 0,
      started_at: new Date(2_001).toISOString(),
    });
    expect(t.get(SID)[0]?.completed_at).toBeUndefined();
    expect(t.get(SID)[0]?.output_preview).toBeUndefined();

    t.apply(
      SID,
      ev({
        type: 'task.terminated',
        info: {
          taskId: 'task-old',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'old run',
          status: 'killed',
          startedAt: 1_000,
          endedAt: 2_000,
          stopReason: 'old stop',
        },
      }),
    );
    expect(t.get(SID)[0]).toMatchObject({ status: 'running', subagent_phase: 'queued' });

    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent-1' }));
    expect(t.get(SID)[0]).toMatchObject({ status: 'running', subagent_phase: 'working' });
  });

  it.each(['subagent.started', 'tool.call.started'] as const)(
    'reopens a disposed terminal row on newer %s activity',
    (type) => {
      const t = new SubagentRosterTracker();
      t.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old' }));
      t.apply(
        SID,
        ev({
          type: 'task.terminated',
          time: 200,
          info: {
            taskId: 'task-old',
            kind: 'agent',
            agentId: 'agent-1',
            detached: true,
            description: 'old run',
            status: 'completed',
            startedAt: 100,
            endedAt: 200,
          },
        }),
      );
      t.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 250 }));
      t.apply(
        SID,
        type === 'subagent.started'
          ? ev({ type, subagentId: 'agent-1', time: 300 })
          : ev({
              type,
              agentId: 'agent-1',
              turnId: 2,
              toolCallId: 'tool-new',
              name: 'Bash',
              args: {},
              time: 300,
            }),
      );

      expect(t.get(SID)[0]).toMatchObject({
        status: 'running',
        subagent_phase: 'working',
        started_at: new Date(300).toISOString(),
        tool_call_count: type === 'tool.call.started' ? 1 : 0,
      });
      expect(t.get(SID)[0]?.live).toBe(true);
      expect(t.get(SID)[0]?.completed_at).toBeUndefined();
    },
  );

  it('retains a known nonterminal row as not live after disposal', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old' }));
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent-1', time: 110 }));

    t.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 200 }));

    expect(t.get(SID)[0]).toMatchObject({
      id: 'agent-1',
      live: false,
      status: 'running',
      subagent_phase: 'working',
    });
  });

  it.each([
    ['subagent.started', 'working', undefined],
    ['subagent.suspended', 'suspended', 'new pause'],
  ] as const)(
    'resets every run field when %s directly recovers a disposed generation',
    (type, phase, suspendedReason) => {
      const t = new SubagentRosterTracker();
      t.apply(
        SID,
        spawn('agent-1', {
          time: 100,
          taskId: 'task-old',
          runInBackground: true,
          model: 'old-model',
          thinkingEffort: 'high',
        }),
      );
      t.apply(
        SID,
        ev({
          type: 'subagent.suspended',
          subagentId: 'agent-1',
          reason: 'old pause',
          time: 120,
        }),
      );
      t.apply(
        SID,
        ev({
          type: 'tool.call.started',
          agentId: 'agent-1',
          turnId: 1,
          toolCallId: 'tool-old',
          name: 'Bash',
          args: {},
          time: 130,
        }),
      );
      t.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 200 }));
      t.apply(
        SID,
        type === 'subagent.started'
          ? ev({ type, subagentId: 'agent-1', time: 300 })
          : ev({ type, subagentId: 'agent-1', reason: suspendedReason, time: 300 }),
      );
      t.apply(
        SID,
        ev({
          type: 'task.terminated',
          time: 410,
          info: {
            taskId: 'task-old',
            kind: 'agent',
            agentId: 'agent-1',
            detached: true,
            description: 'old run',
            status: 'failed',
            startedAt: 100,
            endedAt: 400,
            stopReason: 'late old failure',
          },
        }),
      );

      const entry = t.get(SID)[0];
      expect(entry).toMatchObject({
        status: 'running',
        subagent_phase: phase,
        tool_call_count: 0,
        created_at: undefined,
        started_at: new Date(300).toISOString(),
      });
      expect(entry?.run_in_background).toBeUndefined();
      expect(entry?.model).toBeUndefined();
      expect(entry?.thinking_effort).toBeUndefined();
      expect(entry?.completed_at).toBeUndefined();
      expect(entry?.output_preview).toBeUndefined();
      expect(entry?.suspended_reason).toBe(suspendedReason);
    },
  );

  it('keeps explicit terminal evidence across disposal in either event order', () => {
    const terminalFirst = new SubagentRosterTracker();
    terminalFirst.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old' }));
    terminalFirst.apply(
      SID,
      ev({
        type: 'task.terminated',
        time: 150,
        info: {
          taskId: 'task-old',
          kind: 'agent',
          agentId: 'agent-1',
          detached: false,
          description: 'old run',
          status: 'completed',
          startedAt: 100,
          endedAt: 150,
        },
      }),
    );
    terminalFirst.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 200 }));
    terminalFirst.apply(
      SID,
      ev({
        type: 'task.started',
        time: 250,
        info: {
          taskId: 'task-stale',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'stale run',
          status: 'running',
          startedAt: 175,
          endedAt: null,
        },
      }),
    );
    expect(terminalFirst.get(SID)[0]).toMatchObject({
      status: 'completed',
      subagent_phase: 'completed',
    });

    const disposalFirst = new SubagentRosterTracker();
    disposalFirst.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old' }));
    disposalFirst.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 200 }));
    disposalFirst.apply(
      SID,
      ev({
        type: 'task.terminated',
        time: 250,
        info: {
          taskId: 'task-old',
          kind: 'agent',
          agentId: 'agent-1',
          detached: false,
          description: 'old run',
          status: 'failed',
          startedAt: 100,
          endedAt: 190,
          stopReason: 'failed late',
        },
      }),
    );
    expect(disposalFirst.get(SID)[0]).toMatchObject({
      status: 'failed',
      subagent_phase: 'failed',
      output_preview: 'failed late',
    });
  });

  it('does not let stale spawn, task, or lifecycle activity revive a disposed generation', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old' }));
    t.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 200 }));
    t.apply(
      SID,
      ev({
        type: 'task.started',
        time: 250,
        info: {
          taskId: 'task-old',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'old run',
          status: 'running',
          startedAt: 100,
          endedAt: null,
        },
      }),
    );
    t.apply(SID, spawn('agent-1', { time: 150, taskId: 'task-old' }));
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent-1', time: 175 }));

    expect(t.get(SID)[0]).toMatchObject({
      live: false,
      status: 'running',
      subagent_phase: 'queued',
    });
  });

  it('requires a distinct task or spawn to start strictly after disposal', () => {
    const fromTask = new SubagentRosterTracker();
    fromTask.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old' }));
    fromTask.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 200 }));
    fromTask.apply(
      SID,
      ev({
        type: 'task.started',
        time: 210,
        info: {
          taskId: 'task-new',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'new run',
          status: 'running',
          startedAt: 200,
          endedAt: null,
        },
      }),
    );
    expect(fromTask.get(SID)[0]).toMatchObject({ live: false, subagent_phase: 'queued' });

    fromTask.apply(
      SID,
      ev({
        type: 'task.started',
        time: 211,
        info: {
          taskId: 'task-newer',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'newer run',
          status: 'running',
          startedAt: 201,
          endedAt: null,
        },
      }),
    );
    expect(fromTask.get(SID)[0]).toMatchObject({
      status: 'running',
      subagent_phase: 'working',
      started_at: new Date(201).toISOString(),
      run_in_background: true,
    });

    const fromSpawn = new SubagentRosterTracker();
    fromSpawn.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old' }));
    fromSpawn.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 200 }));
    fromSpawn.apply(SID, spawn('agent-1', { time: 200, taskId: 'task-new' }));
    expect(fromSpawn.get(SID)[0]).toMatchObject({ live: false, subagent_phase: 'queued' });

    fromSpawn.apply(SID, spawn('agent-1', { time: 201, taskId: 'task-newer' }));
    expect(fromSpawn.get(SID)[0]).toMatchObject({
      status: 'running',
      subagent_phase: 'queued',
      started_at: new Date(201).toISOString(),
    });
  });

  it('does not let same-millisecond or untimed lifecycle terminals close a newer task run', () => {
    const run = (terminalFirst: boolean) => {
      const t = new SubagentRosterTracker();
      t.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old' }));
      t.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 200 }));
      if (terminalFirst) {
        t.apply(
          SID,
          ev({
            type: 'subagent.failed',
            subagentId: 'agent-1',
            error: 'stale failure',
            time: 200,
          }),
        );
      }
      t.apply(
        SID,
        ev({
          type: 'task.started',
          time: 310,
          info: {
            taskId: 'task-new',
            kind: 'agent',
            agentId: 'agent-1',
            detached: true,
            description: 'new run',
            status: 'running',
            startedAt: 300,
            endedAt: null,
          },
        }),
      );
      if (!terminalFirst) {
        t.apply(
          SID,
          ev({
            type: 'subagent.failed',
            subagentId: 'agent-1',
            error: 'stale failure',
            time: 300,
          }),
        );
      }
      t.apply(
        SID,
        ev({
          type: 'subagent.completed',
          subagentId: 'agent-1',
          resultSummary: 'untimed stale completion',
        }),
      );
      return t.get(SID)[0];
    };

    for (const terminalFirst of [false, true]) {
      expect(run(terminalFirst)).toMatchObject({
        status: 'running',
        subagent_phase: 'working',
        started_at: new Date(300).toISOString(),
      });
    }
  });

  it('requires matching task termination once the current generation is task-bound', () => {
    const taskBound = new SubagentRosterTracker();
    taskBound.apply(
      SID,
      ev({
        type: 'task.started',
        info: {
          taskId: 'task-current',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'current run',
          status: 'running',
          startedAt: 300,
          endedAt: null,
        },
      }),
    );
    taskBound.apply(
      SID,
      ev({
        type: 'subagent.completed',
        subagentId: 'agent-1',
        resultSummary: 'identity-free terminal',
        time: 400,
      }),
    );
    expect(taskBound.get(SID)[0]).toMatchObject({
      status: 'running',
      subagent_phase: 'working',
      started_at: new Date(300).toISOString(),
    });

    taskBound.apply(
      SID,
      ev({
        type: 'task.terminated',
        info: {
          taskId: 'task-current',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'current run',
          status: 'completed',
          startedAt: 300,
          endedAt: 400,
        },
      }),
    );
    expect(taskBound.get(SID)[0]).toMatchObject({
      status: 'completed',
      subagent_phase: 'completed',
      completed_at: new Date(400).toISOString(),
    });

    const legacy = new SubagentRosterTracker();
    legacy.apply(SID, spawn('agent-legacy', { time: 100, taskId: undefined }));
    legacy.apply(
      SID,
      ev({
        type: 'subagent.completed',
        subagentId: 'agent-legacy',
        resultSummary: 'legacy terminal',
        time: 200,
      }),
    );
    expect(legacy.get(SID)[0]).toMatchObject({
      status: 'completed',
      subagent_phase: 'completed',
      output_preview: 'legacy terminal',
    });
  });

  it('does not merge run fields from a same-millisecond distinct spawn', () => {
    const t = new SubagentRosterTracker();
    t.apply(
      SID,
      ev({
        type: 'task.started',
        info: {
          taskId: 'task-current',
          kind: 'agent',
          agentId: 'agent-1',
          detached: false,
          description: 'current run',
          status: 'running',
          startedAt: 300,
          endedAt: null,
          model: 'current-model',
          thinkingEffort: 'high',
        },
      }),
    );
    t.apply(
      SID,
      spawn('agent-1', {
        time: 300,
        taskId: 'task-stale',
        runInBackground: true,
        model: 'stale-model',
        thinkingEffort: 'low',
        userLabel: 'Updated identity',
      }),
    );

    expect(t.get(SID)[0]).toMatchObject({
      description: 'Updated identity',
      label: 'Updated identity',
      status: 'running',
      subagent_phase: 'working',
      run_in_background: false,
      model: 'current-model',
      thinking_effort: 'high',
      started_at: new Date(300).toISOString(),
    });
  });

  it('clears prior run fields when a task or spawn starts a new generation', () => {
    const createOldRun = () => {
      const t = new SubagentRosterTracker();
      t.apply(
        SID,
        spawn('agent-1', {
          time: 100,
          taskId: 'task-old',
          runInBackground: true,
          model: 'old-model',
          thinkingEffort: 'high',
        }),
      );
      t.apply(
        SID,
        ev({
          type: 'tool.call.started',
          agentId: 'agent-1',
          turnId: 1,
          toolCallId: 'tool-old',
          name: 'Bash',
          args: {},
          time: 110,
        }),
      );
      t.apply(
        SID,
        ev({
          type: 'task.terminated',
          info: {
            taskId: 'task-old',
            kind: 'agent',
            agentId: 'agent-1',
            detached: true,
            description: 'old run',
            status: 'failed',
            startedAt: 100,
            endedAt: 200,
            stopReason: 'old failure',
          },
        }),
      );
      return t;
    };

    const fromTask = createOldRun();
    fromTask.apply(
      SID,
      ev({
        type: 'task.started',
        info: {
          taskId: 'task-new',
          kind: 'agent',
          agentId: 'agent-1',
          detached: false,
          description: 'new run',
          status: 'running',
          startedAt: 300,
          endedAt: null,
        },
      }),
    );

    const fromSpawn = createOldRun();
    fromSpawn.apply(
      SID,
      spawn('agent-1', {
        time: 300,
        taskId: 'task-new',
        runInBackground: false,
        model: undefined,
        thinkingEffort: undefined,
      }),
    );

    for (const entry of [fromTask.get(SID)[0], fromSpawn.get(SID)[0]]) {
      expect(entry).toMatchObject({
        status: 'running',
        run_in_background: false,
        tool_call_count: 0,
        started_at: new Date(300).toISOString(),
      });
      expect(entry?.model).toBeUndefined();
      expect(entry?.thinking_effort).toBeUndefined();
      expect(entry?.completed_at).toBeUndefined();
      expect(entry?.output_preview).toBeUndefined();
    }
  });

  it('keeps task termination authoritative for the matching task id', () => {
    const t = new SubagentRosterTracker();
    t.apply(
      SID,
      ev({
        type: 'task.started',
        info: {
          taskId: 'task-current',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'current run',
          status: 'running',
          startedAt: 300,
          endedAt: null,
        },
      }),
    );
    t.apply(
      SID,
      ev({
        type: 'task.terminated',
        info: {
          taskId: 'task-current',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'current run',
          status: 'completed',
          startedAt: 300,
          endedAt: 300,
        },
      }),
    );
    t.apply(
      SID,
      ev({
        type: 'subagent.completed',
        subagentId: 'agent-1',
        resultSummary: 'late lifecycle result',
        time: 301,
      }),
    );

    expect(t.get(SID)[0]).toMatchObject({
      status: 'completed',
      subagent_phase: 'completed',
      started_at: new Date(300).toISOString(),
      completed_at: new Date(300).toISOString(),
    });
    expect(t.get(SID)[0]?.output_preview).toBeUndefined();
  });

  it('converges when a new task and an old spawn descriptor arrive in either order', () => {
    const run = (descriptorFirst: boolean) => {
      const t = new SubagentRosterTracker();
      t.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old' }));
      t.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 200 }));
      if (descriptorFirst) {
        t.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old', userLabel: 'old' }));
      }
      t.apply(
        SID,
        ev({
          type: 'task.started',
          info: {
            taskId: 'task-new',
            kind: 'agent',
            agentId: 'agent-1',
            detached: true,
            description: 'new run',
            status: 'running',
            startedAt: 300,
            endedAt: null,
          },
        }),
      );
      if (!descriptorFirst) {
        t.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old', userLabel: 'old' }));
      }
      return t.get(SID)[0];
    };

    for (const descriptorFirst of [false, true]) {
      expect(run(descriptorFirst)).toMatchObject({
        status: 'running',
        subagent_phase: 'working',
        started_at: new Date(300).toISOString(),
      });
    }
  });

  it('ignores an old terminal task after a newer generation has started', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old' }));
    t.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 200 }));
    t.apply(
      SID,
      ev({
        type: 'task.started',
        time: 210,
        info: {
          taskId: 'task-new',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'new run',
          status: 'running',
          startedAt: 210,
          endedAt: null,
        },
      }),
    );
    t.apply(
      SID,
      ev({
        type: 'task.terminated',
        time: 220,
        info: {
          taskId: 'task-old',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'old run',
          status: 'killed',
          startedAt: 100,
          endedAt: 200,
          stopReason: 'old stop',
        },
      }),
    );

    expect(t.get(SID)[0]).toMatchObject({
      status: 'running',
      subagent_phase: 'working',
      started_at: new Date(210).toISOString(),
    });
  });

  it('keeps a live suspended phase against a same-run task refresh', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-1' }));
    const taskStarted = ev({
      type: 'task.started',
      time: 110,
      info: {
        taskId: 'task-1',
        kind: 'agent',
        agentId: 'agent-1',
        detached: true,
        description: 'same run',
        status: 'running',
        startedAt: 100,
        endedAt: null,
      },
    });
    t.apply(SID, taskStarted);
    t.apply(
      SID,
      ev({ type: 'subagent.suspended', subagentId: 'agent-1', reason: 'paused', time: 120 }),
    );
    t.apply(SID, taskStarted);

    expect(t.get(SID)[0]).toMatchObject({
      status: 'running',
      subagent_phase: 'suspended',
      suspended_reason: 'paused',
    });
  });

  it('keeps the first terminal task state against late nonterminal lifecycle events', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { runInBackground: true }));
    t.apply(
      SID,
      ev({
        type: 'task.terminated',
        info: {
          taskId: 'task_1',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'task agent-1',
          status: 'killed',
          startedAt: 1,
          endedAt: 2,
        },
      }),
    );
    t.apply(
      SID,
      ev({
        type: 'task.started',
        info: {
          taskId: 'task_1',
          kind: 'agent',
          agentId: 'agent-1',
          detached: true,
          description: 'task agent-1',
          status: 'running',
          startedAt: 1,
          endedAt: null,
        },
      }),
    );
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent-1' }));
    t.apply(SID, ev({ type: 'subagent.completed', subagentId: 'agent-1', resultSummary: 'late' }));

    expect(t.get(SID)[0]).toMatchObject({
      status: 'cancelled',
      subagent_phase: undefined,
    });
  });

  it('ignores lifecycle events for unknown subagents', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'ghost' }));
    t.apply(SID, ev({ type: 'subagent.completed', subagentId: 'ghost', resultSummary: 'x' }));
    expect(t.get(SID)).toEqual([]);
  });

  it('keeps 7 concurrent governance-queued subagents running with started_at across spawned -> scope ready -> turn started -> turn ended -> task completed without flashing idle', () => {
    const tracker = new SubagentRosterTracker();
    const agentIds = Array.from({ length: 7 }, (_, index) => `rev_sub_${index + 1}`);
    const metaAgents: Record<string, NonNullable<SessionMeta['agents']>[string]> = { main: {} };
    for (const [index, id] of agentIds.entries()) {
      metaAgents[id] = { type: 'sub', parentAgentId: 'main', displayName: 'reviewer', userLabel: id, createdAt: 1000 + index };
      tracker.apply(SID, spawn(id, { time: 2000 + index, taskId: `agent-0000000${index}`, runInBackground: true, userLabel: id }));
    }
    const meta: SessionMeta = { id: SID, createdAt: 1, updatedAt: 2010, archived: false, agents: metaAgents };

    const stage1 = sessionAgentRoster(SID, meta, tracker.get(SID), new Map());
    expect(stage1).toHaveLength(7);
    for (const [index, id] of agentIds.entries()) {
      expect(stage1.find((entry) => entry.id === id)).toMatchObject({
        status: 'running',
        activity_status: 'running',
        live: true,
        started_at: new Date(2000 + index).toISOString(),
      });
    }
    expect(sessionAgentCounts(meta.agents, stage1)).toMatchObject({ active: 7, idle: 0, completed: 0, unknown: 0 });

    const runtime = new Map<string, AgentActivityState & { readonly model?: string }>(
      agentIds.map((id) => [id, { lifecycle: 'ready', background: [] }]),
    );
    const stage2 = sessionAgentRoster(SID, meta, tracker.get(SID), runtime);
    for (const [index, id] of agentIds.entries()) {
      expect(stage2.find((entry) => entry.id === id)).toMatchObject({
        status: 'running',
        activity_status: 'running',
        live: true,
        started_at: new Date(2000 + index).toISOString(),
      });
    }
    expect(sessionAgentCounts(meta.agents, stage2)).toMatchObject({ active: 7, idle: 0, completed: 0, unknown: 0 });

    const seventh = agentIds[6]!;
    runtime.set(seventh, {
      lifecycle: 'ready',
      background: [],
      turn: { turnId: 1, origin: { kind: 'user' }, phase: 'running', step: 1, ending: false, pendingApprovals: [], activeToolCalls: [], since: 2500 },
    });
    const stage3 = sessionAgentRoster(SID, meta, tracker.get(SID), runtime);
    expect(stage3.find((entry) => entry.id === seventh)).toMatchObject({
      status: 'running',
      activity_status: 'running',
      live: true,
    });
    expect(sessionAgentCounts(meta.agents, stage3)).toMatchObject({ active: 7, idle: 0, completed: 0 });

    runtime.set(seventh, {
      lifecycle: 'ready',
      background: [],
      lastTurn: { turnId: 1, reason: 'completed', at: 3000 },
    });
    const stage4 = sessionAgentRoster(SID, meta, tracker.get(SID), runtime);
    expect(stage4.find((entry) => entry.id === seventh)).toMatchObject({
      status: 'completed',
      activity_status: 'completed',
      completed_at: new Date(3000).toISOString(),
    });
    expect(sessionAgentCounts(meta.agents, stage4)).toMatchObject({ active: 6, idle: 0, completed: 1 });

    tracker.apply(SID, ev({
      type: 'task.terminated',
      time: 3010,
      info: {
        taskId: 'agent-00000006',
        kind: 'agent',
        agentId: seventh,
        detached: true,
        description: seventh,
        status: 'completed',
        startedAt: 2006,
        endedAt: 3010,
      },
    }));
    const stage5 = sessionAgentRoster(SID, meta, tracker.get(SID), runtime);
    expect(stage5.find((entry) => entry.id === seventh)).toMatchObject({
      status: 'completed',
      activity_status: 'completed',
    });
    expect(sessionAgentCounts(meta.agents, stage5)).toMatchObject({ active: 6, idle: 0, completed: 1 });
  });

  it('drops to idle instead of staying stuck running after a disposed scope reopens idle and the 120s refreshing lease expires', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const tracker = new SubagentRosterTracker();
      tracker.apply(SID, spawn('child-lease', { time: 1_000, taskId: 'task-lease', runInBackground: true }));
      tracker.apply(SID, ev({ type: 'agent.disposed', agentId: 'child-lease', time: 2_000 }));
      tracker.markRefreshing(SID, 'child-lease', 3_000);

      vi.advanceTimersByTime(125_000);
      const rows = tracker.get(SID);
      expect(rows[0]).toMatchObject({
        id: 'child-lease',
        live: false,
        refreshing: undefined,
      });

      const meta: SessionMeta = {
        id: SID,
        createdAt: 1,
        updatedAt: 3_000,
        archived: false,
        agents: {
          main: {},
          'child-lease': { type: 'sub', parentAgentId: 'main', displayName: 'worker', createdAt: 1_000 },
        },
      };
      const runtime = new Map<string, AgentActivityState & { readonly model?: string }>([
        ['child-lease', { lifecycle: 'ready', background: [] }],
      ]);
      const roster = sessionAgentRoster(SID, meta, rows, runtime);
      expect(roster.find((entry) => entry.id === 'child-lease')).toMatchObject({
        activity_status: 'idle',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears disposal boundaries with the session state', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 200 }));
    t.clear(SID);

    t.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old' }));
    expect(t.get(SID)[0]).toMatchObject({ status: 'running', subagent_phase: 'queued' });
  });

  it('completes a task-bound background subagent immediately on matching taskId and accepts unseen post-terminal autonomous receipts while rejecting retired tasks', () => {
    const tracker = new SubagentRosterTracker();
    tracker.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-bg-1', runInBackground: true }));
    tracker.apply(SID, ev({
      type: 'task.started',
      time: 100,
      info: {
        taskId: 'task-bg-1',
        kind: 'agent',
        agentId: 'agent-1',
        detached: true,
        description: 'bg run',
        status: 'running',
        startedAt: 100,
        endedAt: null,
      },
    }));
    tracker.apply(SID, ev({
      type: 'subagent.completed',
      subagentId: 'agent-1',
      taskId: 'task-bg-1',
      resultSummary: 'done fast',
      time: 200,
    }));
    expect(tracker.get(SID)[0]).toMatchObject({
      status: 'completed',
      subagent_phase: 'completed',
      completed_at: new Date(200).toISOString(),
      output_preview: 'done fast',
      refreshing: undefined,
    });

    tracker.apply(SID, ev({ type: 'agent.created', agentId: 'agent-1', time: 250 }));
    expect(tracker.get(SID)[0]?.refreshing).toBe(true);
    tracker.apply(SID, ev({ type: 'turn.started', agentId: 'agent-1', turnId: 2, time: 300 }));
    expect(tracker.get(SID)[0]).toMatchObject({
      status: 'running',
      subagent_phase: 'working',
      live: true,
      refreshing: undefined,
      started_at: new Date(300).toISOString(),
      completed_at: undefined,
    });

    tracker.apply(SID, ev({
      type: 'subagent.started',
      subagentId: 'agent-1',
      taskId: 'task-bg-1',
      time: 350,
    }));
    tracker.apply(SID, ev({
      type: 'subagent.completed',
      subagentId: 'agent-1',
      taskId: 'task-bg-1',
      resultSummary: 'stale retired task',
      time: 360,
    }));
    expect(tracker.get(SID)[0]).toMatchObject({
      status: 'running',
      subagent_phase: 'working',
    });

    tracker.apply(SID, ev({
      type: 'task.terminated',
      time: 400,
      info: {
        taskId: 'task-bg-2',
        kind: 'agent',
        agentId: 'agent-1',
        detached: true,
        description: 'run 2',
        status: 'completed',
        startedAt: 300,
        endedAt: 400,
      },
    }));
    expect(tracker.get(SID)[0]).toMatchObject({
      status: 'completed',
      completed_at: new Date(400).toISOString(),
    });

    tracker.apply(SID, ev({
      type: 'subagent.started',
      subagentId: 'agent-1',
      taskId: 'agent-receipt-turn-3',
      time: 500,
    }));
    expect(tracker.get(SID)[0]).toMatchObject({
      status: 'running',
      subagent_phase: 'working',
      refreshing: undefined,
      started_at: new Date(500).toISOString(),
    });
    tracker.apply(SID, ev({
      type: 'subagent.completed',
      subagentId: 'agent-1',
      taskId: 'agent-receipt-turn-3',
      resultSummary: 'autonomous reply',
      time: 501,
    }));
    expect(tracker.get(SID)[0]).toMatchObject({
      status: 'completed',
      subagent_phase: 'completed',
      completed_at: new Date(501).toISOString(),
      output_preview: 'autonomous reply',
    });
  });

  it('returns fresh copies that callers cannot mutate back into the tracker', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1'));
    const first = t.get(SID);
    first[0]!.description = 'mutated';
    expect(t.get(SID)[0]?.description).toBe('task agent-1');
  });
});
