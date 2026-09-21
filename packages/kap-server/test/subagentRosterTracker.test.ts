import type { Event } from '../src/transport/ws/v1/events';
import { describe, expect, it } from 'vitest';

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
    parentToolCallId: 'tc_swarm_1',
    description: `task ${subagentId}`,
    userLabel: `task ${subagentId}`,
    swarmIndex: 0,
    runInBackground: false,
    ...extra,
  });
}

describe('SubagentRosterTracker', () => {
  it('seeds a roster entry from subagent.spawned with the swarm identity metadata', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { swarmIndex: 2, model: 'provider/secondary', thinkingEffort: 'low' }));

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
        parent_tool_call_id: 'tc_swarm_1',
        tool_call_count: 0,
        swarm_index: 2,
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
      expect(t.get(SID)[0]?.live).toBeUndefined();
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
        created_at: new Date(300).toISOString(),
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

  it('clears disposal boundaries with the session state', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, ev({ type: 'agent.disposed', agentId: 'agent-1', time: 200 }));
    t.clear(SID);

    t.apply(SID, spawn('agent-1', { time: 100, taskId: 'task-old' }));
    expect(t.get(SID)[0]).toMatchObject({ status: 'running', subagent_phase: 'queued' });
  });

  it('returns fresh copies that callers cannot mutate back into the tracker', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1'));
    const first = t.get(SID);
    first[0]!.description = 'mutated';
    expect(t.get(SID)[0]?.description).toBe('task agent-1');
  });
});
