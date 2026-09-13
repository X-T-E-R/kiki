import { describe, expect, it } from 'vitest';

import type { PromptListResponse, Session, SessionUsage, Task } from '@kiki/protocol';

import {
  buildActivityModel,
  formatElapsedClock,
  pendingKindOf,
  promptPreviewText,
} from './activity';

function usage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
    ...overrides,
  };
}

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspace_id: 'wd_test',
    title: id,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    busy: false,
    metadata: { cwd: 'C:/tmp' },
    agent_config: { model: '' },
    usage: usage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
    ...overrides,
  };
}

function promptItem(promptId: string, text: string, createdAt: string, status: 'running' | 'queued' = 'running') {
  return {
    prompt_id: promptId,
    user_message_id: `msg_${promptId}`,
    status,
    content: [{ type: 'text' as const, text }],
    created_at: createdAt,
  };
}

function prompts(
  active: ReturnType<typeof promptItem> | null,
  queued: ReturnType<typeof promptItem>[] = [],
): PromptListResponse {
  return { active, queued };
}

function task(id: string, status: Task['status'], kind: Task['kind'] = 'bash'): Task {
  return {
    id,
    session_id: 's1',
    kind,
    description: id,
    status,
    created_at: '2026-08-10T00:00:00.000Z',
  };
}

describe('promptPreviewText', () => {
  it('returns the first non-empty text part', () => {
    expect(
      promptPreviewText([
        { type: 'text', text: '  ' },
        { type: 'text', text: 'fix the flaky test' },
      ]),
    ).toBe('fix the flaky test');
    expect(promptPreviewText([{ type: 'thinking', thinking: 'hmm' }])).toBeUndefined();
  });
});

describe('pendingKindOf', () => {
  it('passes approval/question through and normalizes everything else', () => {
    expect(pendingKindOf(session('a', { pending_interaction: 'approval' }))).toBe('approval');
    expect(pendingKindOf(session('b', { pending_interaction: 'question' }))).toBe('question');
    expect(pendingKindOf(session('c', { pending_interaction: 'none' }))).toBe('none');
    expect(pendingKindOf(session('d'))).toBe('none');
  });
});

describe('buildActivityModel', () => {
  it('assembles running entries with queue depth, task counts, and the turn anchor', () => {
    const busy = session('busy', {
      busy: true,
      main_turn_active: true,
      updated_at: '2026-08-10T01:00:00.000Z',
    });
    const model = buildActivityModel({
      sessions: [busy],
      prompts: {
        busy: prompts(promptItem('p1', 'refactor the aggregator', '2026-08-10T00:58:00.000Z'), [
          promptItem('p2', 'then the tests', '2026-08-10T00:59:00.000Z', 'queued'),
          promptItem('p3', 'and lint', '2026-08-10T00:59:30.000Z', 'queued'),
        ]),
      },
      tasks: {
        busy: [task('t1', 'running'), task('t2', 'completed'), task('t3', 'running', 'subagent')],
      },
      untitled: 'Untitled',
    });
    expect(model.running).toHaveLength(1);
    const entry = model.running[0];
    expect(entry).toMatchObject({
      sessionId: 'busy',
      mainTurnActive: true,
      turnStartedAt: '2026-08-10T00:58:00.000Z',
      promptPreview: 'refactor the aggregator',
      queuedCount: 2,
      runningTaskCount: 1, // the subagent-kind task stays out, mirroring the rail
    });
    expect(model.queuedTotal).toBe(2);
    expect(model.runningTaskTotal).toBe(1);
  });

  it('lets live queuedPromptIds win over a stale REST prompt list', () => {
    const busy = session('busy', { busy: true });
    const model = buildActivityModel({
      sessions: [busy],
      prompts: {
        busy: prompts(promptItem('p1', 'hold the floor', '2026-08-10T00:58:00.000Z'), [
          promptItem('p2', 'steer me in', '2026-08-10T00:59:00.000Z', 'queued'),
          promptItem('p3', 'clear me out', '2026-08-10T00:59:30.000Z', 'queued'),
        ]),
      },
      tasks: {},
      untitled: 'Untitled',
      liveQueuedCounts: { busy: 1 },
    });
    expect(model.running[0]?.queuedCount).toBe(1);
    expect(model.queuedTotal).toBe(1);
  });

  it('falls back to the record last_prompt and zero counts without fetched data', () => {
    const model = buildActivityModel({
      sessions: [session('busy', { busy: true, last_prompt: 'ship it' })],
      prompts: {},
      tasks: {},
      untitled: 'Untitled',
    });
    expect(model.running[0]).toMatchObject({
      promptPreview: 'ship it',
      queuedCount: 0,
      runningTaskCount: 0,
      turnStartedAt: undefined,
      mainTurnActive: false,
    });
  });

  it('labels a busy untitled session from its title fallback chain', () => {
    const model = buildActivityModel({
      sessions: [session('x', { busy: true, title: '' })],
      prompts: {},
      tasks: {},
      untitled: 'Untitled session',
    });
    expect(model.running[0]?.title).toBe('Untitled session');
  });

  it('splits waiting sessions off the running list and chips busy-pending ones', () => {
    const model = buildActivityModel({
      sessions: [
        session('busy-pending', {
          busy: true,
          pending_interaction: 'approval',
          updated_at: '2026-08-10T02:00:00.000Z',
        }),
        session('stuck', {
          pending_interaction: 'question',
          updated_at: '2026-08-10T03:00:00.000Z',
        }),
      ],
      prompts: {},
      tasks: {},
      untitled: 'Untitled',
    });
    expect(model.running.map((entry) => entry.sessionId)).toEqual(['busy-pending']);
    expect(model.running[0]?.pendingInteraction).toBe('approval');
    expect(model.waiting.map((entry) => entry.sessionId)).toEqual(['stuck']);
  });

  it('sorts both lists most-recently-updated first', () => {
    const model = buildActivityModel({
      sessions: [
        session('old-busy', { busy: true, updated_at: '2026-08-09T00:00:00.000Z' }),
        session('new-busy', { busy: true, updated_at: '2026-08-10T00:00:00.000Z' }),
        session('old-wait', { pending_interaction: 'approval', updated_at: '2026-08-08T00:00:00.000Z' }),
        session('new-wait', { pending_interaction: 'question', updated_at: '2026-08-09T12:00:00.000Z' }),
      ],
      prompts: {},
      tasks: {},
      untitled: 'Untitled',
    });
    expect(model.running.map((entry) => entry.sessionId)).toEqual(['new-busy', 'old-busy']);
    expect(model.waiting.map((entry) => entry.sessionId)).toEqual(['new-wait', 'old-wait']);
  });
});

describe('formatElapsedClock', () => {
  it('renders m:ss under the hour and h:mm:ss beyond', () => {
    expect(formatElapsedClock(0)).toBe('0:00');
    expect(formatElapsedClock(47_000)).toBe('0:47');
    expect(formatElapsedClock(12 * 60_000 + 3_000)).toBe('12:03');
    expect(formatElapsedClock(3600_000 + 2 * 60_000 + 40_000)).toBe('1:02:40');
  });

  it('clamps negative drift to zero', () => {
    expect(formatElapsedClock(-5_000)).toBe('0:00');
  });
});
