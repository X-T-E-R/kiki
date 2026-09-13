import { describe, expect, it, vi } from 'vitest';

import { Session } from '#/session';
import { createKimiHarness } from '#/index';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_IDENTITY } from './test-identity';
import type { SDKRpcClientBase } from '#/rpc';

function makeSession() {
  const rpc = {
    createGoal: vi.fn(async () => ({ goalId: 'g1' })),
    getGoal: vi.fn(async () => ({ goal: null })),
    pauseGoal: vi.fn(async () => ({ goalId: 'g1' })),
    resumeGoal: vi.fn(async () => ({ goalId: 'g1' })),
    cancelGoal: vi.fn(async () => ({ goalId: 'g1' })),
    getCronTasks: vi.fn(async () => ({ tasks: [] })),
    clearSessionHandlers: vi.fn(),
  } as unknown as SDKRpcClientBase;
  const session = new Session({ id: 'ses_goal', workDir: '/tmp/work', rpc });
  return { session, rpc };
}

describe('Session goal methods', () => {
  it('runs the complete goal lifecycle through the real SDK and shared facade', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kiki-sdk-goal-'));
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    try {
      const session = await harness.createSession({ id: 'goal-facade', workDir: homeDir });
      const goal = await session.createGoal({ objective: 'Complete the example' });
      expect((await session.getGoal()).goal?.goalId).toBe(goal.goalId);
      expect((await session.pauseGoal()).status).toBe('paused');
      expect((await session.resumeGoal()).status).toBe('active');
      await session.cancelGoal();
      expect((await session.getGoal()).goal).toBeNull();
      await session.close();
      await expect(session.getGoal()).rejects.toMatchObject({ code: 'session.closed' });
    } finally {
      await harness.close();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('createGoal forwards the supported payload with sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.createGoal({
      objective: 'Ship feature X',
      replace: true,
    });
    expect(rpc.createGoal).toHaveBeenCalledWith({
      sessionId: 'ses_goal',
      objective: 'Ship feature X',
      replace: true,
    });
  });

  it('getGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.getGoal();
    expect(rpc.getGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('pauseGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.pauseGoal();
    expect(rpc.pauseGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('resumeGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.resumeGoal();
    expect(rpc.resumeGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('cancelGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.cancelGoal();
    expect(rpc.cancelGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('getCronTasks forwards sessionId and returns the task list', async () => {
    const { session, rpc } = makeSession();
    const result = await session.getCronTasks();
    expect(rpc.getCronTasks).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
    expect(result).toEqual({ tasks: [] });
  });

  it('does not expose a public clearGoal or updateGoal method', () => {
    const { session } = makeSession();
    expect((session as unknown as { clearGoal?: unknown }).clearGoal).toBeUndefined();
    expect((session as unknown as { updateGoal?: unknown }).updateGoal).toBeUndefined();
  });

  it('keeps the goal metadata key reserved for lifecycle methods', async () => {
    const { session } = makeSession();

    await expect(
      session.updateMetadata({ goal: { status: 'complete' } }),
    ).rejects.toMatchObject({ code: 'goal.metadata_reserved' });
  });
});
