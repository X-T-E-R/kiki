import { describe, expect, it, vi } from 'vitest';

import { ToolAccesses } from '../../src/loop';
import type { Logger, LogPayload } from '../../src/logging';
import type { ResolvedAgentProfile } from '../../src/profile';
import { compileToolArgsValidator, validateToolArgs } from '../../src/tools/args-validator';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  formatSubagentTimeoutDescription,
  type SessionSubagentHost,
} from '../../src/session/subagent-host';
import { AgentTool, AgentToolInputSchema } from '../../src/tools/builtin/collaboration/agent';
import {
  AgentCollaborationController,
  FOLLOWUP_TASK_PARAMETERS,
  INTERRUPT_AGENT_PARAMETERS,
  LIST_AGENTS_PARAMETERS,
  SPAWN_AGENT_PARAMETERS,
  WAIT_AGENT_PARAMETERS,
} from '../../src/tools/builtin/collaboration/agent-collaboration';
import type { BackgroundManager, BackgroundTaskInfo } from '../../src/agent/background';
import { userCancellationReason } from '../../src/utils/abort';
import { agentTask, createBackgroundManager } from '../agent/background/helpers';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

describe('agent collaboration production schemas', () => {
  it('strictly validates every adapter input with the runtime AJV path', () => {
    const spawn = compileToolArgsValidator(SPAWN_AGENT_PARAMETERS);
    expect(validateToolArgs(spawn, { task_name: 'build_api', message: 'Keep whitespace\n', fork_turns: 'NONE' })).toBeNull();
    const invalidInputs: Array<Record<string, string | boolean>> = [
      { task_name: 'root', message: 'x' },
      { task_name: 'Bad', message: 'x' },
      { task_name: 'a/b', message: 'x' },
      { task_name: 'ok', message: '   ' },
      { task_name: 'ok', message: 'x', fork_turns: 'all' },
      { task_name: 'ok', message: 'x', fork_context: true },
      { task_name: 'ok', message: 'x', run_in_background: true },
    ];
    for (const invalid of invalidInputs) expect(validateToolArgs(spawn, invalid)).not.toBeNull();

    expect(validateToolArgs(compileToolArgsValidator(LIST_AGENTS_PARAMETERS), {})).toBeNull();
    expect(validateToolArgs(compileToolArgsValidator(LIST_AGENTS_PARAMETERS), { all: true })).not.toBeNull();
    expect(validateToolArgs(compileToolArgsValidator(WAIT_AGENT_PARAMETERS), { timeout_ms: 10_000 })).toBeNull();
    expect(validateToolArgs(compileToolArgsValidator(WAIT_AGENT_PARAMETERS), { timeout_ms: 9_999 })).not.toBeNull();
    expect(validateToolArgs(compileToolArgsValidator(FOLLOWUP_TASK_PARAMETERS), { target: 'a', message: 'x' })).toBeNull();
    expect(validateToolArgs(compileToolArgsValidator(FOLLOWUP_TASK_PARAMETERS), { target: 'a', message: ' ' })).not.toBeNull();
    expect(validateToolArgs(compileToolArgsValidator(INTERRUPT_AGENT_PARAMETERS), { target: 'a' })).toBeNull();
  });
});

describe('agent collaboration lifecycle adapter', () => {
  type NamedFixture = { taskName: string; agentId: string; agentType: string; ownerAgentId: string; latestTaskId?: string };
  interface SharedFixtureState { named: NamedFixture[]; pending: Map<string, string>; nextAgent: number; events: string[]; onPublish?: () => void; }
  function fixture(ownerAgentId = 'main', shared: SharedFixtureState = { named: [], pending: new Map(), nextAgent: 0, events: [] }) {
    const named = shared.named;
    const tasks = new Map<string, BackgroundTaskInfo>();
    let nextTask = 0;
    const spawn = vi.fn(async (options: { collaborationTaskName?: string; collaborationTaskId?: string; profileName: string; prompt: string; deferCollaborationRun?: boolean }) => {
      const agentId = `agent-${String(shared.nextAgent++)}`;
      named.push({ taskName: options.collaborationTaskName!, agentId, agentType: options.profileName,
        ownerAgentId, latestTaskId: options.collaborationTaskId });
      return { agentId, profileName: options.profileName, resumed: false,
        completion: new Promise<never>(() => {}),
        publishPrepared: options.deferCollaborationRun === true ? () => {
          shared.events.push(`spawned:${agentId}`);
          shared.onPublish?.();
        } : undefined,
        cancelPrepared: vi.fn() };
    });
    const resume = vi.fn(async (agentId: string, _options: { prompt: string }) => ({ agentId,
      profileName: named.find((entry) => entry.agentId === agentId)!.agentType,
      resumed: true, completion: new Promise<never>(() => {}) }));
    const host = {
      spawn,
      resume,
      currentAgentId: () => ownerAgentId,
      namedAgents: () => named.filter((entry) => entry.ownerAgentId === ownerAgentId).toSorted((a, b) => a.taskName.localeCompare(b.taskName)),
      reserveNamedAgent: (taskName: string) => {
        if (shared.pending.has(taskName) || named.some((entry) => entry.taskName === taskName)) return false;
        shared.pending.set(taskName, ownerAgentId);
        return true;
      },
      commitNamedAgent: (taskName: string) => { if (shared.pending.get(taskName) === ownerAgentId) shared.pending.delete(taskName); },
      releaseNamedAgent: (taskName: string) => { if (shared.pending.get(taskName) === ownerAgentId) shared.pending.delete(taskName); },
      discardNamedAgent: async (agentId: string) => {
        const index = named.findIndex((entry) => entry.agentId === agentId);
        if (index >= 0) named.splice(index, 1);
      },
      recordNamedTask: async (agentId: string, taskId: string) => {
        const entry = named.find((candidate) => candidate.agentId === agentId)!;
        entry.latestTaskId = taskId;
      },
    } as unknown as SessionSubagentHost;
    const background = {
      assertCanRegisterBackground: vi.fn(),
      allocateTaskId: vi.fn(() => `agent-task000${String(nextTask)}`),
      registerTask: vi.fn((task: { toInfo(base: object): BackgroundTaskInfo }) => {
        const taskId = `agent-task000${String(nextTask++)}`;
        tasks.set(taskId, task.toInfo({ taskId, description: 'named', status: 'running', detached: true,
          startedAt: 1, endedAt: null }));
        return taskId;
      }),
      commitTaskRegistration: vi.fn((taskId: string) => { shared.events.push(`task:${taskId}`); }),
      rollbackTaskRegistration: vi.fn(async (taskId: string) => { tasks.delete(taskId); }),
      getTask: vi.fn((taskId: string) => tasks.get(taskId)),
      stop: vi.fn(async (taskId: string) => {
        const current = tasks.get(taskId)!;
        const stopped = { ...current, status: 'killed' as const, endedAt: 2 };
        tasks.set(taskId, stopped);
        return stopped;
      }),
      wait: vi.fn(async (taskId: string) => tasks.get(taskId)),
    } as unknown as BackgroundManager;
    return { controller: new AgentCollaborationController(host, background, 1_000), host, named, tasks, spawn, resume, background, events: shared.events };
  }

  it('spawns asynchronously, rejects duplicate names, and lists in task-name order', async () => {
    const { controller, spawn } = fixture();
    const ctx = context({}, 'call_named') as never;
    const zed = await controller.spawn({ task_name: 'zed', message: '  preserve me  ', fork_turns: 'none' }, ctx);
    const alpha = await controller.spawn({ task_name: 'alpha', message: 'work' }, ctx);
    expect(resultJson(zed)).toMatchObject({ task_name: 'zed', agent_id: 'agent-0', status: 'running' });
    expect(resultJson(alpha)).toMatchObject({ task_name: 'alpha', agent_id: 'agent-1', status: 'running' });
    expect(spawn.mock.calls[0]?.[0].prompt).toBe('  preserve me  ');
    await expect(controller.spawn({ task_name: 'zed', message: 'again' }, ctx)).resolves.toMatchObject({ isError: true });
    expect(resultJson(controller.list()).agents.map((entry: { task_name: string }) => entry.task_name)).toEqual(['alpha', 'zed']);
  });

  it('rejects running follow-up, interrupts nonrecursively, and resumes the same identity once', async () => {
    const { controller, resume } = fixture();
    const ctx = context({}, 'call_named') as never;
    await controller.spawn({ task_name: 'work', message: 'start' }, ctx);
    await expect(controller.followup({ target: 'work', message: 'next' }, ctx)).resolves.toMatchObject({ isError: true });
    const interrupted = await controller.interrupt({ target: 'work' });
    expect(resultJson(interrupted)).toMatchObject({ agent_id: 'agent-0', status: 'interrupted' });
    const followed = await controller.followup({ target: 'agent-0', message: '  exact follow-up  ' }, ctx);
    expect(resultJson(followed)).toMatchObject({ agent_id: 'agent-0', status: 'running' });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]?.[1].prompt).toBe('  exact follow-up  ');
  });

  it('returns immediately without runners and reports a bounded timeout truthfully', async () => {
    const { controller } = fixture();
    expect(resultJson(await controller.wait({})).timed_out).toBe(false);
    await controller.spawn({ task_name: 'work', message: 'start' }, context({}, 'call_named') as never);
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(10_100);
    try {
      const result = await controller.wait({ timeout_ms: 10_000 });
      expect(resultJson(result).timed_out).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it('reserves names session-wide and rejects cross-owner management by name or id', async () => {
    const shared: SharedFixtureState = { named: [], pending: new Map(), nextAgent: 0, events: [] };
    const first = fixture('caller-a', shared);
    const second = fixture('caller-b', shared);
    const ctx = context({}, 'call_named') as never;
    const [a, b] = await Promise.all([
      first.controller.spawn({ task_name: 'same', message: 'a' }, ctx),
      second.controller.spawn({ task_name: 'same', message: 'b' }, ctx),
    ]);
    expect([a, b].filter((result) => result.isError !== true)).toHaveLength(1);
    expect(first.spawn.mock.calls.length + second.spawn.mock.calls.length).toBe(1);

    const owner = a.isError === true ? second : first;
    const outsider = fixture('caller-restored-outsider', shared);
    const agentId = shared.named[0]!.agentId;
    expect(resultJson(outsider.controller.list()).agents).toEqual([]);
    await expect(outsider.controller.followup({ target: 'same', message: 'x' }, ctx)).resolves.toMatchObject({ isError: true });
    await expect(outsider.controller.followup({ target: agentId, message: 'x' }, ctx)).resolves.toMatchObject({ isError: true });
    await expect(outsider.controller.interrupt({ target: 'same' })).resolves.toMatchObject({ isError: true });
    await expect(outsider.controller.interrupt({ target: agentId })).resolves.toMatchObject({ isError: true });
    expect(outsider.background.getTask).not.toHaveBeenCalled();
    expect(outsider.background.stop).not.toHaveBeenCalled();
    expect(resultJson(owner.controller.list()).agents).toHaveLength(1);
    await expect(owner.controller.spawn({ task_name: 'same', message: 'again' }, ctx)).resolves.toMatchObject({ isError: true });
  });

  it('releases a failed allocation reservation so the same name can be retried', async () => {
    const background = createBackgroundManager().manager;
    const visibleAtPublish: boolean[] = [];
    const shared: SharedFixtureState = { named: [], pending: new Map(), nextAgent: 0, events: [],
      onPublish: () => { visibleAtPublish.push(background.list(false).length > 0); } };
    const { host, spawn, events } = fixture('main', shared);
    const controller = new AgentCollaborationController(host, background, 1_000);
    const registerTask = background.registerTask.bind(background);
    vi.spyOn(background, 'registerTask').mockImplementationOnce((task, options) => {
      registerTask(task, options);
      throw new Error('register failed after partial registration');
    });
    const ctx = context({}, 'call_named') as never;
    await expect(controller.spawn({ task_name: 'retryable', message: 'first' }, ctx)).resolves.toMatchObject({ isError: true });
    expect(events).toEqual([]);
    expect(background.list(false)).toEqual([]);
    const retried = await controller.spawn({ task_name: 'retryable', message: 'second' }, ctx);
    expect(retried.isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/^spawned:/);
    expect(visibleAtPublish).toEqual([true]);
  });
});

function resultJson(result: { output: unknown }): any {
  return JSON.parse(result.output as string);
}

function context<Input>(args: Input, toolCallId = 'call_agent') {
  return { turnId: '0', toolCallId, args, signal };
}

function mockSubagentHost<T extends Pick<SessionSubagentHost, 'spawn'> & Partial<SessionSubagentHost>>(
  host: T,
): T & SessionSubagentHost {
  return { resume: vi.fn(), delegatableSubagents: vi.fn(() => ({})), ...host } as unknown as T & SessionSubagentHost;
}

function agentTool(
  host: SessionSubagentHost,
  background = createBackgroundManager().manager,
  subagents?: ResolvedAgentProfile['subagents'],
  options?: ConstructorParameters<typeof AgentTool>[3],
): AgentTool {
  return new AgentTool(host, background, subagents, options);
}

interface CapturedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload: LogPayload | undefined;
}

function captureLogs(): { logger: Logger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const capture =
    (level: CapturedLogEntry['level']) => (message: string, payload?: LogPayload) => {
      entries.push({ level, message, payload });
    };
  const logger: Logger = {
    error: capture('error'),
    warn: capture('warn'),
    info: capture('info'),
    debug: capture('debug'),
    createChild: () => logger,
  };
  return {
    entries,
    logger,
  };
}

describe('AgentTool', () => {
  it('accepts the snake_case background parameter', () => {
    const parsed = AgentToolInputSchema.parse({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
      run_in_background: true,
    });

    expect(parsed).toMatchObject({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
      run_in_background: true,
    });
  });

  it('exposes run_in_background and not runInBackground in the JSON schema', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;

    expect(properties).toHaveProperty('run_in_background');
    expect(properties).not.toHaveProperty('runInBackground');
  });

  it('describes subagent_type and run_in_background parameters', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);
    const properties = (
      tool.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;

    const subagentTypeDescription = properties['subagent_type']?.description ?? '';
    // #7: the description states the default is coder
    expect(subagentTypeDescription).toContain('coder');
    // #6: terminology aligned with the "Available agent types" prose heading —
    // no longer "agent registry"
    expect(subagentTypeDescription).not.toContain('registry');
    expect(subagentTypeDescription).toContain('agent type');
    expect(properties['run_in_background']?.description).toContain('false');
  });

  it('documents that resume excludes subagent_type', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);
    const properties = (
      tool.parameters as { properties: Record<string, { description?: string }> }
    ).properties;

    // Passing both resume and subagent_type is rejected at runtime (agent.ts execution()),
    // so the resume param must steer the model away from it.
    expect((properties['resume']?.description ?? '').toLowerCase()).toContain('subagent_type');
  });

  it('does not expose a timeout parameter in the JSON schema', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;

    expect(properties).not.toHaveProperty('timeout');
  });

  it('explains the fixed background subagent timeout', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);

    expect(tool.description).toContain('fixed 30-minute timeout');
    expect(tool.description).not.toContain('operator-configured background timeout');
    expect(tool.description).not.toContain('no time limit');
    // Background guidance must steer foreground-by-default, so the model doesn't
    // background-launch a result it needs and then block waiting on it.
    expect(tool.description).toContain('Default to a foreground subagent');
  });

  it('exposes a primary/secondary model parameter in the JSON schema when the experiment is enabled', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host, createBackgroundManager().manager, undefined, {
      modelChoiceEnabled: true,
    });
    const properties = (
      tool.parameters as {
        properties: Record<string, { description?: string; enum?: string[] }>;
      }
    ).properties;

    expect(properties['model']?.enum).toEqual(['primary', 'secondary']);
    expect(properties['model']?.description).toContain('secondary');
    expect(properties).toHaveProperty('model_alias');
    expect(properties).toHaveProperty('thinking_effort');
  });

  it('strips the model parameter from the JSON schema by default', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;

    expect(properties).not.toHaveProperty('model');
    expect(properties).not.toHaveProperty('model_alias');
    expect(properties).not.toHaveProperty('thinking_effort');
    expect(properties).toHaveProperty('prompt');
  });

  it('rejects conflicting selectors and binding fields on resume', () => {
    const base = { prompt: 'Investigate', description: 'Find cause' };
    expect(
      AgentToolInputSchema.safeParse({ ...base, model: 'primary', model_alias: 'primary' }).success,
    ).toBe(false);
    expect(
      AgentToolInputSchema.safeParse({ ...base, resume: 'agent-existing', thinking_effort: 'low' })
        .success,
    ).toBe(false);
  });

  it('enforces binding constraints through the production AJV schema', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const enabled = agentTool(host, createBackgroundManager().manager, undefined, {
      modelChoiceEnabled: true,
    });
    const validator = compileToolArgsValidator(enabled.parameters);
    const base = { prompt: 'Investigate', description: 'Find cause' };

    expect(validateToolArgs(validator, { ...base, model: 'primary', model_alias: 'fast' })).not.toBeNull();
    expect(validateToolArgs(validator, { ...base, resume: 'agent-old', thinking_effort: 'low' })).not.toBeNull();
    expect(validateToolArgs(validator, { ...base, model_alias: '   ' })).not.toBeNull();
    expect(validateToolArgs(validator, { ...base, thinking_effort: '\t' })).not.toBeNull();
    expect(
      validateToolArgs(validator, {
        ...base,
        model_alias: ' fast-model ',
        thinking_effort: ' low ',
      }),
    ).toBeNull();

    const disabled = compileToolArgsValidator(agentTool(host).parameters);
    expect(validateToolArgs(disabled, { ...base, model_alias: 'fast' })).not.toBeNull();
  });

  it('trims binding fields before they reach the subagent host', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: Promise.resolve({ result: 'done' }),
      }),
    });
    const tool = agentTool(host, createBackgroundManager().manager, undefined, {
      modelChoiceEnabled: true,
    });

    await executeTool(
      tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        model_alias: ' fast-model ',
        thinking_effort: ' low ',
      }),
    );

    expect(host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ modelAlias: 'fast-model', thinkingEffort: 'low' }),
    );
  });

  it('appends the subagent model description only when provided', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const withoutModels = agentTool(host);
    expect(withoutModels.description).not.toContain('Available models');

    const withModels = agentTool(host, createBackgroundManager().manager, undefined, {
      subagentModelDescription:
        'Available models (pass via model):\n- secondary: cheap (default)\n- primary: flagship',
    });
    expect(withModels.description).toContain('Available models (pass via model):');
    expect(withModels.description).toContain('secondary: cheap');
  });

  it('renders the tool set for each subagent type', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const subagents = {
      explore: profile({
        name: 'explore',
        description: 'Read-only exploration.',
        tools: ['Read', 'Grep', 'Glob'],
      }),
      coder: profile({
        name: 'coder',
        description: 'General coding.',
        tools: ['Read', 'Write', 'Edit', 'Bash'],
      }),
    };

    const tool = agentTool(host, createBackgroundManager().manager, subagents);

    expect(tool.description).toContain('Tools: Read, Grep, Glob');
    expect(tool.description).toContain('Tools: Read, Write, Edit, Bash');
  });

  it('mentions resume preference and result visibility in the description', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);

    expect(tool.description.toLowerCase()).toContain('resume');
    expect(tool.description.toLowerCase()).toContain('only visible to you');
    expect(tool.description.toLowerCase()).toContain('when not to');
    // Moved here from system.md: the context-hygiene reason to delegate.
    expect(tool.description.toLowerCase()).toContain('out of your own context');
  });

  it('normalizes the default subagent type into tool args', () => {
    expect(
      AgentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
      }).subagent_type,
    ).toBe('coder');
    expect(
      AgentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
        subagent_type: '',
      }).subagent_type,
    ).toBe('coder');
    expect(
      AgentToolInputSchema.parse({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
      }).subagent_type,
    ).toBeUndefined();
  });

  it('describes configured subagent types', () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const subagents = {
      explore: profile({
        name: 'explore',
        description: 'Read-only exploration.',
        whenToUse: 'Use for searches.',
      }),
      coder: profile({ name: 'coder', description: 'General coding.' }),
    };

    const tool = agentTool(host, createBackgroundManager().manager, subagents);

    expect(tool.description).toContain('Available agent types');
    expect(tool.description).toContain('- explore: Read-only exploration. Use for searches.');
    expect(tool.description).toContain('- coder: General coding.');
  });

  it('spawns a foreground subagent and returns its summary', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'explore',
        resumed: false,
        completion: Promise.resolve({ result: 'child result' }),
      }),
    });
    const tool = agentTool(host);

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        subagent_type: 'explore',
      }),
    );

    expect(host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'explore',
        parentToolCallId: 'call_agent',
        prompt: 'Investigate',
        description: 'Find cause',
        runInBackground: false,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('actual_subagent_type: explore');
    expect(result.output).toContain('child result');
  });

  it('falls back to coder for an empty subagent type', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: Promise.resolve({ result: 'child result' }),
      }),
    });
    const tool = agentTool(host);

    await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        subagent_type: '',
      }),
    );

    expect(host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentToolCallId: 'call_agent',
        profileName: 'coder',
      }),
    );
  });

  it('passes the model choice through to spawn and rejects it on resume', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: Promise.resolve({ result: 'child result' }),
      }),
      resume: vi.fn().mockResolvedValue({
        agentId: 'agent-existing',
        profileName: 'coder',
        resumed: true,
        completion: Promise.resolve({ result: 'resumed result' }),
      }),
    });
    const tool = agentTool(host);

    await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        model: 'primary',
      }),
    );
    expect(host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ modelChoice: 'primary' }),
    );

    const resumed = await executeTool(tool,
      context({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
        model: 'secondary',
      }),
    );
    expect(resumed).toMatchObject({ isError: true });
    expect(resumed.output).toContain('Cannot set model');
    expect(host.resume).not.toHaveBeenCalled();
  });

  it('resumes a foreground subagent when resume is provided', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn(),
      resume: vi.fn().mockResolvedValue({
        agentId: 'agent-existing',
        profileName: 'explore',
        resumed: true,
        completion: Promise.resolve({ result: 'resumed result' }),
      }),
    });
    const tool = agentTool(host);

    const result = await executeTool(tool,
      context({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
      }),
    );

    expect(host.spawn).not.toHaveBeenCalled();
    expect(host.resume).toHaveBeenCalledWith(
      'agent-existing',
      expect.objectContaining({
        parentToolCallId: 'call_agent',
        prompt: 'Continue',
        description: 'Continue work',
        runInBackground: false,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.output).toContain('agent_id: agent-existing');
    expect(result.output).toContain('actual_subagent_type: explore');
    expect(result.output).toContain('resumed result');
  });

  it('returns an error when resuming with a subagent type', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn(),
      resume: vi.fn(),
    });
    const tool = agentTool(host);

    const result = await executeTool(tool,
      context({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
        subagent_type: 'explore',
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
    });
    expect(host.resume).not.toHaveBeenCalled();
  });

  it('does not consume a background task slot when validation fails before launch', async () => {
    const completion = new Promise<{ result: string }>(() => {});
    const background = createBackgroundManager({ maxRunningTasks: 1 }).manager;
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion,
      }),
      resume: vi.fn(),
    });
    const tool = new AgentTool(host, background);

    const invalid = await executeTool(tool,
      context({
        prompt: 'Continue',
        description: 'Invalid background resume',
        resume: 'agent-existing',
        subagent_type: 'explore',
        run_in_background: true,
      }),
    );
    const valid = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(invalid).toMatchObject({
      isError: true,
      output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
    });
    expect(valid.output).toContain('status: running');
    expect(host.resume).not.toHaveBeenCalled();
    expect(host.spawn).toHaveBeenCalledTimes(1);
  });

  it('resumes by id without constraining the subagent type', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn(),
      resume: vi.fn().mockResolvedValue({
        agentId: 'agent-existing',
        profileName: 'explore',
        resumed: true,
        completion: Promise.resolve({ result: 'resumed result' }),
      }),
    });
    const tool = agentTool(host);

    const result = await executeTool(tool,
      context({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
      }),
    );

    expect(host.spawn).not.toHaveBeenCalled();
    expect(host.resume).toHaveBeenCalledWith(
      'agent-existing',
      expect.objectContaining({
        parentToolCallId: 'call_agent',
        prompt: 'Continue',
        description: 'Continue work',
        runInBackground: false,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.output).toContain('actual_subagent_type: explore');
  });

  it('declares no resource accesses so concurrent Agent calls can run in parallel', async () => {
    const host = mockSubagentHost({ spawn: vi.fn() });
    const tool = agentTool(host);
    const execution = await tool.resolveExecution({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.accesses).toEqual(ToolAccesses.none());
  });

  it('uses the resumed agent profile in the activity description', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn(),
      getProfileName: vi.fn().mockReturnValue('explore'),
    });
    const tool = agentTool(host);
    const execution = await tool.resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      resume: ' agent-existing ',
    });

    expect(execution.isError).toBeFalsy();
    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching explore agent: Continue work');
    expect(host.getProfileName).toHaveBeenCalledWith('agent-existing');
  });

  it('registers background subagents with the background manager', async () => {
    const completion = new Promise<{ result: string }>(() => {});
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion,
      }),
    });
    const background = createBackgroundManager().manager;
    const tool = new AgentTool(host, background);

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(result.output).toContain('status: running');
    expect(result.output).toContain('agent_id: agent-child');
    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    expect(background.getTask(taskId!)).toMatchObject({
      status: 'running',
      description: 'Find cause',
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
    });
  });

  it('can detach a foreground subagent through the background manager', async () => {
    let resolveCompletion: (value: { result: string }) => void = () => {};
    const completion = new Promise<{ result: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const markActiveChildDetached = vi.fn();
    const host = mockSubagentHost({
      markActiveChildDetached,
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion,
      }),
    });
    const background = createBackgroundManager().manager;
    const tool = new AgentTool(host, background);

    const running = executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
      }),
    );
    await vi.waitFor(() => {
      expect(background.list(false)).toHaveLength(1);
    });
    const task = background.list(false)[0]!;

    expect(task).toMatchObject({
      kind: 'agent',
      detached: false,
      agentId: 'agent-child',
    });

    background.detach(task.taskId);
    const result = await running;

    expect(markActiveChildDetached).toHaveBeenCalledWith('agent-child');
    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('automatic_notification: true');

    resolveCompletion({ result: 'finished later' });
    await expect(background.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('does not recommend disabled task tools when a foreground subagent is detached', async () => {
    let resolveCompletion: (value: { result: string }) => void = () => {};
    const completion = new Promise<{ result: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion,
      }),
    });
    const background = createBackgroundManager().manager;
    const tool = agentTool(host, background, undefined, { allowBackground: false });

    const running = executeTool(
      tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
      }),
    );
    await vi.waitFor(() => {
      expect(background.list(false)).toHaveLength(1);
    });
    const task = background.list(false)[0]!;

    background.detach(task.taskId);
    const result = await running;

    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('next_step: The completion arrives automatically');
    expect(result.output).not.toContain('TaskOutput');
    expect(result.output).not.toContain('TaskStop');

    resolveCompletion({ result: 'finished later' });
    await expect(background.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('steers the AI away from waiting and gives a resume hint on background launch', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: new Promise<{ result: string }>(() => {}),
      }),
    });
    const background = createBackgroundManager().manager;
    const tool = new AgentTool(host, background);

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    // M9: next_step steers away from waiting on a background launch (no poll/TaskOutput).
    expect(result.output).toContain('next_step:');
    expect(result.output).toContain('do NOT wait, poll, or call TaskOutput on it');
    expect(result.output).not.toContain('block=false');
    // M9: resume_hint — continue the same subagent instance
    expect(result.output).toContain('resume_hint:');
    expect(result.output).toContain('Agent(resume="agent-child"');
    // The hint disambiguates the two look-alike identifiers in this output:
    // `agent_id` (what `subagentHost.resume` accepts) and `task_id` (the
    // BackgroundManager ledger id, which also shows up as `source_id` in
    // later <notification> entries). LLMs regularly copy the wrong one.
    expect(result.output).toMatch(/agent_id.*not.*task_id|task_id.*not.*agent_id/i);
    // Recovery scenario — `task.lost` etc. — must be called out so the
    // model knows the hint is not only for happy-path follow-up work.
    expect(result.output).toMatch(/task\.lost|task\.failed|task\.killed/);
  });

  it('rejects background subagents when background execution is disabled', async () => {
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: new Promise<{ result: string }>(() => {}),
      }),
    });
    const tool = agentTool(host, createBackgroundManager().manager, undefined, {
      allowBackground: false,
    });

    expect(tool.description).toContain('Background agent execution is disabled for this agent.');
    expect(tool.description).not.toContain('the subagent runs detached from this turn');

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      output:
        'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.',
    });
    expect(host.spawn).not.toHaveBeenCalled();
  });

  it('returns an error when background registration hits the task limit', async () => {
    const background = createBackgroundManager({ maxRunningTasks: 1 }).manager;
    background.registerTask(agentTask(new Promise(() => {}), 'existing agent'));
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: new Promise<{ result: string }>(() => {}),
      }),
    });
    const tool = new AgentTool(host, background);

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Too many background tasks are already running.',
    });
    expect(host.spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects one of two concurrent background subagents when the task limit is reached', async () => {
    const background = createBackgroundManager({ maxRunningTasks: 1 }).manager;
    const host = mockSubagentHost({
      spawn: vi
        .fn()
        .mockResolvedValueOnce({
          agentId: 'agent-first',
          profileName: 'coder',
          resumed: false,
          completion: new Promise<{ result: string }>(() => {}),
        })
        .mockResolvedValueOnce({
          agentId: 'agent-second',
          profileName: 'coder',
          resumed: false,
          completion: Promise.resolve({ result: 'second result' }),
        }),
    });
    const tool = new AgentTool(host, background);

    const first = executeTool(tool,
      context({
        prompt: 'Investigate first',
        description: 'Find first',
        run_in_background: true,
      }),
    );
    const second = executeTool(tool,
      context({
        prompt: 'Investigate second',
        description: 'Find second',
        run_in_background: true,
      }),
    );

    const results = await Promise.all([first, second]);

    expect(host.spawn).toHaveBeenCalledTimes(2);
    expect(results).toContainEqual(
      expect.objectContaining({ output: expect.stringContaining('status: running') }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        isError: true,
        output: 'Too many background tasks are already running.',
      }),
    );
  });

  it('returns tool errors when spawning fails', async () => {
    const error = new Error('missing subagent');
    const { logger, entries } = captureLogs();
    const host = mockSubagentHost({
      spawn: vi.fn().mockRejectedValue(error),
    });
    const tool = agentTool(host, createBackgroundManager().manager, undefined, { log: logger });

    const result = await executeTool(tool,
      context({ prompt: 'Investigate', description: 'Find cause' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: missing subagent',
    });
    expect(entries).toEqual([
      {
        level: 'warn',
        message: 'subagent launch failed',
        payload: expect.objectContaining({
          toolCallId: 'call_agent',
          runInBackground: false,
          operation: 'spawn',
          subagentType: 'coder',
          error,
        }),
      },
    ]);
  });

  it('logs background registration failures', async () => {
    const error = new Error('background unavailable');
    const { logger, entries } = captureLogs();
    const host = mockSubagentHost({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: new Promise<{ result: string }>(() => {}),
      }),
    });
    const background = createBackgroundManager().manager;
    vi.spyOn(background, 'registerTask').mockImplementation(() => {
      throw error;
    });
    const tool = new AgentTool(host, background, undefined, { log: logger });

    const result = await executeTool(tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'background unavailable',
    });
    expect(entries).toEqual([
      {
        level: 'warn',
        message: 'background agent task registration failed',
        payload: expect.objectContaining({
          toolCallId: 'call_agent',
          agentId: 'agent-child',
          subagentType: 'coder',
          error,
        }),
      },
    ]);
  });

  it('reports a deliberate user interruption when a foreground subagent is cancelled by the user', async () => {
    const controller = new AbortController();
    const host = mockSubagentHost({
      spawn: vi.fn(
        (
          profileNameOrOptions: string | { readonly signal: AbortSignal },
          legacyOptions?: { readonly signal: AbortSignal },
        ) =>
        Promise.resolve({
          agentId: 'agent-child',
          profileName: 'coder',
          resumed: false,
          completion: new Promise<{ result: string }>((_resolve, reject) => {
            const signal =
              typeof profileNameOrOptions === 'string'
                ? legacyOptions!.signal
                : profileNameOrOptions.signal;
            const onAbort = (): void => {
              reject(signal.reason);
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }),
        }),
      ),
    });
    const tool = agentTool(host);

    const resultPromise = executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_agent',
      args: { prompt: 'Investigate', description: 'Find cause' },
      signal: controller.signal,
    });
    // Let spawn wire up and the tool reach `await handle.completion`.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(userCancellationReason());
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status: failed');
    // The old message ("The subagent was stopped by the user.") is too weak —
    // the model still blamed a "system limit". The new message rules that out.
    expect(result.output).not.toContain('was stopped by the user');
    expect(result.output).toContain('not a system error');
    expect(result.output).toContain('capacity');
    expect(result.output).toContain('wait for the user');
  });

  it('returns the spawned agent id when a foreground subagent times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const host = mockSubagentHost({
        spawn: vi.fn(
          (
            profileNameOrOptions: string | { readonly signal: AbortSignal },
            legacyOptions?: { readonly signal: AbortSignal },
          ) =>
          Promise.resolve({
            agentId: 'agent-child',
            profileName: 'coder',
            resumed: false,
            completion: new Promise<{ result: string }>((_resolve, reject) => {
              const signal =
                typeof profileNameOrOptions === 'string'
                  ? legacyOptions!.signal
                  : profileNameOrOptions.signal;
              signal.addEventListener(
                'abort',
                () => {
                  reject(signal.reason);
                },
                { once: true },
              );
            }),
          }),
        ),
      });
      const tool = agentTool(host);

      const resultPromise = executeTool(tool,
        context({
          prompt: 'Investigate',
          description: 'Find cause',
        }),
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_SUBAGENT_TIMEOUT_MS);
      const result = await resultPromise;

      expect(result).toMatchObject({ isError: true });
      expect(result.output).toContain('agent_id: agent-child');
      expect(result.output).toContain('actual_subagent_type: coder');
      expect(result.output).toContain('status: failed');
      expect(result.output).toContain(
        `subagent error: Agent timed out after ${formatSubagentTimeoutDescription(DEFAULT_SUBAGENT_TIMEOUT_MS)}.`,
      );
      expect(result.output).toContain('resume_hint:');
      expect(result.output).toContain('Agent(resume="agent-child", prompt="continue")');
      expect(result.output).toContain('do not set subagent_type');
      expect(result.output).toContain('retains its prior context');
    } finally {
      vi.useRealTimers();
    }
  });
});

function profile(input: {
  readonly name: string;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly tools?: readonly string[];
}): ResolvedAgentProfile {
  return {
    name: input.name,
    description: input.description,
    whenToUse: input.whenToUse,
    systemPrompt: () => `${input.name} prompt`,
    tools: [...(input.tools ?? [])],
  };
}
