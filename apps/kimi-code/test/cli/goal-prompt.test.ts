import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GOAL_EXIT_CODES,
  formatGoalSummaryText,
  goalExitCode,
  goalSummaryJson,
  parseHeadlessGoalCreate,
} from '#/cli/goal-prompt';
import { runPrompt } from '#/cli/run-prompt';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    goalId: 'g1',
    objective: 'work',
    status: 'complete',
    turnsUsed: 2,
    tokensUsed: 120,
    wallClockMs: 0,
    budget: {} as never,
    ...overrides,
  };
}

describe('goalExitCode', () => {
  it('maps final statuses to distinct codes', () => {
    expect(goalExitCode('complete')).toBe(GOAL_EXIT_CODES.complete);
    expect(goalExitCode('blocked')).toBe(GOAL_EXIT_CODES.blocked);
    expect(goalExitCode('paused')).toBe(GOAL_EXIT_CODES.paused);
    expect(goalExitCode(undefined)).toBe(0);
    // Folded-away statuses map to success (treated as complete/absent).
    expect(goalExitCode('impossible')).toBe(0);
    // The distinct codes are unique across the statuses.
    expect(new Set(Object.values(GOAL_EXIT_CODES)).size).toBe(Object.values(GOAL_EXIT_CODES).length);
  });
});

describe('parseHeadlessGoalCreate', () => {
  it('parses a create command into objective + replace', () => {
    const result = parseHeadlessGoalCreate('/goal Ship feature X');
    expect(result).toEqual({ objective: 'Ship feature X', replace: false });
  });

  it('returns undefined for non-goal prompts and non-create subcommands', () => {
    expect(parseHeadlessGoalCreate('say hello')).toBeUndefined();
    expect(parseHeadlessGoalCreate('/goal status')).toBeUndefined();
    expect(parseHeadlessGoalCreate('/goal pause')).toBeUndefined();
  });

  it('rejects malformed goal create prompts instead of falling through', () => {
    expect(() => parseHeadlessGoalCreate(`/goal ${'x'.repeat(4001)}`)).toThrow(
      'Goal objective is too long',
    );
  });
});

describe('goal summary', () => {
  it('includes id, status, reason, and usage', () => {
    const summary = goalSummaryJson(
      snapshot({
        status: 'blocked',
        terminalReason: 'need creds',
      }) as never,
    );
    expect(summary).toMatchObject({
      type: 'goal.summary',
      goalId: 'g1',
      status: 'blocked',
      reason: 'need creds',
      turnsUsed: 2,
      tokensUsed: 120,
    });
  });

  it('renders a null goal', () => {
    expect(goalSummaryJson(null).status).toBeNull();
    expect(formatGoalSummaryText(null)).toContain('no goal');
  });
});

// --- Integration: runPrompt headless goal path -----------------------------

const mocks = vi.hoisted(() => {
  const eventHandlers = new Set<(event: any) => void>();
  const mainEvent = (event: Record<string, unknown>) => ({ sessionId: 'ses_goal', agentId: 'main', ...event });
  const session = {
    id: 'ses_goal',
    setModel: vi.fn(),
    setThinking: vi.fn(),
    setPermission: vi.fn(),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    getStatus: vi.fn(async () => ({ permission: 'auto', model: 'k2' })),
    createGoal: vi.fn(async () => snapshot({ status: 'active' })),
    getGoal: vi.fn(async () => ({ goal: snapshot({ status: 'complete' }) })),
    getCronTasks: vi.fn(async () => ({ tasks: [] })),
    onEvent: vi.fn((handler: (event: any) => void) => {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    }),
    prompt: vi.fn(async () => {
      for (const handler of eventHandlers) {
        handler(mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
        handler(mainEvent({ type: 'assistant.delta', turnId: 1, delta: 'done' }));
        handler(mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
      }
    }),
    waitForBackgroundTasksOnPrint: vi.fn(async () => {}),
  };
  return {
    session,
    eventHandlers,
    mainEvent,
    experimentalFeatures: [{ id: 'micro_compaction', enabled: true }],
    sessions: [] as Array<{ readonly id: string; readonly workDir: string }>,
  };
});

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    createKimiHarness: () => ({
      homeDir: '/tmp/kimi-goal-home',
      auth: { getCachedAccessToken: vi.fn() },
      ensureConfigFile: vi.fn(),
      getConfig: vi.fn(async () => ({ providers: {}, defaultModel: 'k2' })),
      getConfigDiagnostics: vi.fn(async () => ({ warnings: [] as readonly string[] })),
      getExperimentalFeatures: vi.fn(async () => mocks.experimentalFeatures),
      createSession: vi.fn(async () => mocks.session),
      resumeSession: vi.fn(async () => mocks.session),
      listSessions: vi.fn(async () => mocks.sessions),
      close: vi.fn(),
      track: vi.fn(),
    }),
  };
});

function opts(overrides: Partial<Parameters<typeof runPrompt>[0]> = {}) {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: '/goal Ship feature X',
    skillsDirs: [],
    ...overrides,
  } as Parameters<typeof runPrompt>[0];
}

function writer() {
  let text = '';
  return { write: (chunk: string) => ((text += chunk), true), text: () => text };
}
