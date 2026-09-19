import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  agentEventSchema,
  assistantDeltaEventSchema,
  eventSchema,
  shellCompletedEventSchema,
  thinkingDeltaEventSchema,
  toolCallStartedEventSchema,
} from '../events';
import type { Event } from '../events';
import type { ToolInputDisplay } from '../display';

type _AssertEventNonNever = Event extends never ? never : true;
const _assertEvent: _AssertEventNonNever = true;

type _AssertToolInputDisplayNonNever = ToolInputDisplay extends never ? never : true;
const _assertDisplay: _AssertToolInputDisplayNonNever = true;

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const sdkPackageName = ['@moonshot-ai', 'kimi-code-sdk'].join('/');

function readPackageFiles(): string {
  const files = ['package.json', ...sourceFiles(join(packageRoot, 'src'))];
  return files
    .map((file) => readFileSync(join(packageRoot, file), 'utf8'))
    .join('\n');
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(relative(packageRoot, full));
    }
  }
  return files;
}

describe('events / display re-exports', () => {
  it('does not depend on the node SDK package', () => {
    expect(readPackageFiles()).not.toContain(sdkPackageName);
  });

  it('Event re-export is non-never (compile-time check passed)', () => {
    expect(_assertEvent).toBe(true);
  });

  it('ToolInputDisplay re-export is non-never (12-arm union preserved)', () => {
    expect(_assertDisplay).toBe(true);
  });

  it('validates concrete agent event payloads with Zod schemas', () => {
    expect(
      assistantDeltaEventSchema.parse({
        type: 'assistant.delta',
        turnId: 1,
        delta: 'hello',
      }),
    ).toEqual({
      type: 'assistant.delta',
      turnId: 1,
      delta: 'hello',
    });

    expect(
      toolCallStartedEventSchema.safeParse({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_1',
        name: 'bash',
        args: { command: 'pwd' },
        display: { kind: 'command', command: 'pwd', language: 'bash' },
      }).success,
    ).toBe(true);

    expect(
      shellCompletedEventSchema.parse({
        type: 'shell.completed',
        commandId: 'cmd-1',
        isError: false,
      }),
    ).toEqual({ type: 'shell.completed', commandId: 'cmd-1', isError: false });
    expect(
      agentEventSchema.safeParse({
        type: 'shell.completed',
        commandId: 'cmd-1',
        isError: true,
        taskId: 'task-1',
      }).success,
    ).toBe(true);
  });

  it('preserves legacy and step-owned assistant and thinking deltas', () => {
    expect(
      assistantDeltaEventSchema.parse({
        type: 'assistant.delta',
        turnId: 1,
        delta: 'legacy',
      }),
    ).toEqual({ type: 'assistant.delta', turnId: 1, delta: 'legacy' });
    expect(
      assistantDeltaEventSchema.parse({
        type: 'assistant.delta',
        turnId: 1,
        step: 2,
        stepId: 'step-2',
        delta: 'owned',
      }),
    ).toEqual({
      type: 'assistant.delta',
      turnId: 1,
      step: 2,
      stepId: 'step-2',
      delta: 'owned',
    });
    expect(
      thinkingDeltaEventSchema.parse({
        type: 'thinking.delta',
        turnId: 1,
        delta: 'legacy thought',
      }),
    ).toEqual({ type: 'thinking.delta', turnId: 1, delta: 'legacy thought' });
    expect(
      thinkingDeltaEventSchema.parse({
        type: 'thinking.delta',
        turnId: 1,
        step: 2,
        stepId: 'step-2',
        delta: 'owned thought',
      }),
    ).toEqual({
      type: 'thinking.delta',
      turnId: 1,
      step: 2,
      stepId: 'step-2',
      delta: 'owned thought',
    });
  });

  it('rejects unknown event types through the full agent event union', () => {
    expect(
      agentEventSchema.safeParse({
        type: 'unknown.event',
        turnId: 1,
      }).success,
    ).toBe(false);
  });

  it('validates session-scoped daemon events with agentId and sessionId', () => {
    const parsed = eventSchema.parse({
      type: 'turn.started',
      agentId: 'agent_1',
      sessionId: 'sess_1',
      turnId: 1,
      origin: { kind: 'user' },
      promptId: 'prompt_1',
    });

    expect(parsed.agentId).toBe('agent_1');
    expect(parsed.sessionId).toBe('sess_1');
    expect((parsed as { promptId?: string }).promptId).toBe('prompt_1');
  });

  it('validates prompt.submitted events', () => {
    const parsed = eventSchema.parse({
      type: 'prompt.submitted',
      agentId: 'main',
      sessionId: 'sess_1',
      promptId: 'prompt_1',
      userMessageId: 'msg_1',
      status: 'blocked',
      content: [{ type: 'text', text: 'hello' }],
      createdAt: '2026-06-11T00:00:00.000Z',
    });

    expect(parsed.type).toBe('prompt.submitted');
    expect((parsed as { promptId: string }).promptId).toBe('prompt_1');
    expect((parsed as { status: string }).status).toBe('blocked');
  });

  it('validates queued prompt lifecycle events', () => {
    const queued = eventSchema.parse({
      type: 'prompt.queued',
      agentId: 'main',
      sessionId: 'sess_1',
      promptId: 'prompt_1',
      content: [{ type: 'text', text: 'queued' }],
      queueLength: 2,
    });
    const replaced = eventSchema.parse({
      type: 'prompt.replaced',
      agentId: 'main',
      sessionId: 'sess_1',
      promptId: 'prompt_1',
      content: [{ type: 'text', text: 'replacement' }],
      replacedAt: '2026-06-11T00:00:01.000Z',
    });
    const moved = eventSchema.parse({
      type: 'prompt.moved',
      agentId: 'main',
      sessionId: 'sess_1',
      promptId: 'prompt_2',
      targetIndex: 0,
      queuedPromptIds: ['prompt_2', 'prompt_1'],
      movedAt: '2026-06-11T00:00:02.000Z',
    });

    expect(queued.type).toBe('prompt.queued');
    expect(replaced.type).toBe('prompt.replaced');
    expect(moved.type).toBe('prompt.moved');
  });

  it('carries deferred-append timing and revision on the queue lifecycle events', () => {
    const queued = eventSchema.parse({
      type: 'prompt.queued',
      agentId: 'main',
      sessionId: 'sess_1',
      promptId: 'prompt_1',
      content: [{ type: 'text', text: 'queued' }],
      queueLength: 2,
      appendTiming: 'tasks_done',
      revision: 3,
    });
    const replaced = eventSchema.parse({
      type: 'prompt.replaced',
      agentId: 'main',
      sessionId: 'sess_1',
      promptId: 'prompt_1',
      content: [{ type: 'text', text: 'replacement' }],
      replacedAt: '2026-06-11T00:00:01.000Z',
      message: { role: 'user' },
      revision: 4,
    });
    const timing = eventSchema.parse({
      type: 'prompt.timing_changed',
      agentId: 'main',
      sessionId: 'sess_1',
      promptId: 'prompt_1',
      appendTiming: 'subagents_done',
      revision: 5,
      changedAt: '2026-06-11T00:00:02.000Z',
    });

    expect((queued as { appendTiming?: string }).appendTiming).toBe('tasks_done');
    expect((queued as { revision?: number }).revision).toBe(3);
    expect((replaced as { revision?: number }).revision).toBe(4);
    expect((timing as { appendTiming: string }).appendTiming).toBe('subagents_done');
    expect((timing as { revision: number }).revision).toBe(5);
  });

  it('validates the durable prompt queue facts', () => {
    const enqueued = eventSchema.parse({
      type: 'prompt.enqueued',
      agentId: 'main',
      sessionId: 'sess_1',
      schemaVersion: 1,
      promptId: 'prompt_1',
      userMessageId: 'msg_1',
      createdAt: '2026-06-11T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'queued' }] },
      execution: { model: 'kimi-code/k2' },
      goalId: 'goal_1',
      deferredDisabledTools: ['Bash'],
      alreadyMaterialized: false,
      appendTiming: 'agent_idle',
      revision: 1,
      queueIndex: 0,
    });
    const goalCreation = eventSchema.parse({
      type: 'prompt.enqueued',
      agentId: 'main',
      sessionId: 'sess_1',
      schemaVersion: 1,
      promptId: 'prompt_goal',
      userMessageId: 'msg_goal',
      createdAt: '2026-06-11T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'create goal' }] },
      execution: { goalObjective: 'create goal' },
      goalId: null,
      alreadyMaterialized: false,
      appendTiming: 'agent_idle',
      revision: 1,
      queueIndex: 1,
    });
    const launch = eventSchema.parse({
      type: 'prompt.launch_committed',
      agentId: 'main',
      sessionId: 'sess_1',
      launchId: 'launch_1',
      promptId: 'prompt_1',
      revision: 1,
      committedAt: '2026-06-11T00:00:01.000Z',
    });

    expect((enqueued as { queueIndex: number }).queueIndex).toBe(0);
    expect((enqueued as { appendTiming: string }).appendTiming).toBe('agent_idle');
    expect((goalCreation as { goalId: string | null }).goalId).toBeNull();
    expect((launch as { launchId: string }).launchId).toBe('launch_1');
  });

  it('rejects a prompt.timing_changed event with an unknown timing', () => {
    const result = eventSchema.safeParse({
      type: 'prompt.timing_changed',
      agentId: 'main',
      sessionId: 'sess_1',
      promptId: 'prompt_1',
      appendTiming: 'immediate',
      revision: 1,
      changedAt: '2026-06-11T00:00:02.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('validates prompt.started events', () => {
    const started = eventSchema.parse({
      type: 'prompt.started',
      agentId: 'main',
      sessionId: 'sess_1',
      promptId: 'prompt_1',
    });

    expect(started.type).toBe('prompt.started');
    expect((started as { promptId: string }).promptId).toBe('prompt_1');
  });

  it('rejects a prompt.started event without a promptId', () => {
    const result = eventSchema.safeParse({
      type: 'prompt.started',
      agentId: 'main',
      sessionId: 'sess_1',
    });

    expect(result.success).toBe(false);
  });

  it('parses every event type the union declares, including config.changed', () => {
    const declared = new Set(
      agentEventSchema.options.map(
        (option) => (option.shape.type as { value: string }).value,
      ),
    );

    expect(declared.has('prompt.started')).toBe(true);
    expect(declared.has('prompt.queued')).toBe(true);
    expect(declared.has('event.config.changed')).toBe(true);
  });

  it('accepts legacy and timestamped agent.disposed lifecycle events', () => {
    const legacy = eventSchema.parse({
      type: 'agent.disposed',
      agentId: 'agent-1',
      sessionId: 'sess_1',
    });
    const timestamped = eventSchema.parse({
      type: 'agent.disposed',
      agentId: 'agent-1',
      sessionId: 'sess_1',
      time: 1_717_000_000_000,
    });

    expect(legacy).toMatchObject({ type: 'agent.disposed', agentId: 'agent-1' });
    expect(timestamped).toMatchObject({
      type: 'agent.disposed',
      agentId: 'agent-1',
      time: 1_717_000_000_000,
    });
  });

  it('preserves detached on task events', () => {
    const parsed = eventSchema.parse({
      type: 'task.started',
      agentId: 'main',
      sessionId: 'sess_1',
      info: {
        kind: 'process',
        taskId: 'bash-deadbeef',
        description: 'Bash: sleep 10',
        status: 'running',
        detached: false,
        startedAt: 1,
        endedAt: null,
        command: 'sleep 10',
        pid: 123,
        exitCode: null,
      },
    });

    expect(parsed.type).toBe('task.started');
    expect((parsed as { info: { detached?: boolean } }).info.detached).toBe(false);
  });

  it('validates event.session.created events', () => {
    const parsed = eventSchema.parse({
      type: 'event.session.created',
      agentId: 'main',
      sessionId: 'sess_1',
      session: {
        id: 'sess_1',
        workspace_id: 'wd_project_123456abcdef',
        title: 'Created session',
        created_at: '2026-06-11T00:00:00.000Z',
        updated_at: '2026-06-11T00:00:00.000Z',
        busy: false,
        metadata: { cwd: '/tmp/project' },
        agent_config: { model: 'kimi-k2' },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_cost_usd: 0,
          context_tokens: 0,
          context_limit: 0,
          turn_count: 0,
        },
        permission_rules: [],
        message_count: 0,
        last_seq: 0,
      },
    });

    expect(parsed.type).toBe('event.session.created');
    expect((parsed as { session: { id: string } }).session.id).toBe('sess_1');
  });

  it('validates workspace lifecycle events', () => {
    const workspace = {
      id: 'wd_project_123456abcdef',
      root: '/tmp/project',
      name: 'project',
      created_at: '2026-06-11T00:00:00.000Z',
      last_opened_at: '2026-06-11T00:00:00.000Z',
      session_count: 1,
      pinned: false,
    };

    const created = eventSchema.parse({
      type: 'event.workspace.created',
      agentId: 'main',
      sessionId: '__global__',
      workspace,
    });
    expect(created.type).toBe('event.workspace.created');

    const updated = eventSchema.parse({
      type: 'event.workspace.updated',
      agentId: 'main',
      sessionId: '__global__',
      workspace: { ...workspace, name: 'renamed' },
    });
    expect(updated.type).toBe('event.workspace.updated');

    const deleted = eventSchema.parse({
      type: 'event.workspace.deleted',
      agentId: 'main',
      sessionId: '__global__',
      workspace_id: workspace.id,
      root: workspace.root,
    });
    expect(deleted.type).toBe('event.workspace.deleted');
    expect((deleted as { root: string }).root).toBe('/tmp/project');
  });

  it('validates event.session.status_changed events', () => {
    const parsed = eventSchema.parse({
      type: 'event.session.status_changed',
      agentId: 'main',
      sessionId: 'sess_1',
      status: 'running',
      previous_status: 'idle',
      current_prompt_id: 'prompt_1',
    });

    expect(parsed.type).toBe('event.session.status_changed');
    expect((parsed as { status: string }).status).toBe('running');
    expect((parsed as { previous_status: string }).previous_status).toBe('idle');
    expect((parsed as { current_prompt_id: string }).current_prompt_id).toBe('prompt_1');
  });

  it('validates orthogonal session work facts for unsubscribed clients', () => {
    const parsed = eventSchema.parse({
      type: 'event.session.work_changed',
      agentId: 'main',
      sessionId: 'sess_1',
      busy: true,
      main_turn_active: false,
      pending_interaction: 'question',
      last_turn_reason: 'completed',
    });

    expect(parsed).toMatchObject({
      main_turn_active: false,
      pending_interaction: 'question',
    });
  });

  it('rejects event.session.status_changed with invalid status', () => {
    expect(
      eventSchema.safeParse({
        type: 'event.session.status_changed',
        agentId: 'main',
        sessionId: 'sess_1',
        status: 'unknown',
        previous_status: 'idle',
      }).success,
    ).toBe(false);
  });
});
