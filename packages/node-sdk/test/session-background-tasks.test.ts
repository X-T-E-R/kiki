import { Error2, getLiveSessionById, IAgentLifecycleService } from '@kiki/agent-core-v2';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarness, ErrorCodes, SDKRpcClient, type KimiError } from '#/index';

import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.listBackgroundTasks / getBackgroundTaskOutput', () => {
  it('lists an empty task set for a fresh session', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_list_empty', workDir });
      const tasks = await session.listBackgroundTasks();
      expect(tasks).toEqual([]);

      const filtered = await session.listBackgroundTasks({ activeOnly: true });
      expect(filtered).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('returns empty output for an unknown task id', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_unknown', workDir });
      // Unknown task ids must not throw — UI fetches output speculatively.
      await expect(session.getBackgroundTaskOutput('bash-deadbeef')).resolves.toBe('');
    } finally {
      await harness.close();
    }
  });

  it('rejects empty task ids with a stable error code', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_empty_id', workDir });
      await expect(session.getBackgroundTaskOutput('')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'task.task_id_empty',
      } satisfies Partial<KimiError>);
      await expect(session.stopBackgroundTask('')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'task.task_id_empty',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_closed', workDir });
      await session.close();

      await expect(session.listBackgroundTasks()).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
      await expect(session.getBackgroundTaskOutput('bash-aaaaaaaa')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
      await expect(session.stopBackgroundTask('bash-aaaaaaaa')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('stopBackgroundTask is a no-op for an unknown task id', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_stop_unknown', workDir });
      // Unknown task ids must not throw — the core BPM silently no-ops.
      await expect(
        session.stopBackgroundTask('bash-deadbeef', { reason: 'test' }),
      ).resolves.toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});

describe('Session print background policy', () => {
  it('keeps exit/drain policy and delegates drains through the core lifecycle', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-print-policy-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-print-policy-work-');
    const client = new SDKRpcClient({ homeDir, identity: TEST_IDENTITY });
    const sessionId = 'ses_print_policy';

    try {
      await client.createSession({ id: sessionId, workDir });
      const handle = getLiveSessionById(client.engineAccessor, sessionId);
      expect(handle).toBeDefined();
      const lifecycle = handle!.accessor.get(IAgentLifecycleService);
      const drainSpy = vi.spyOn(lifecycle, 'drainBackgroundTasks').mockResolvedValue(undefined);

      try {
        await client.setConfig({
          background: {
            printBackgroundMode: 'exit',
            printWaitCeilingS: 2,
            printMaxTurns: 2,
          },
        });
        await expect(client.handlePrintMainTurnCompleted({ sessionId })).resolves.toBe('finish');
        await expect(client.waitForBackgroundTasksOnPrint({ sessionId })).resolves.toBeUndefined();
        expect(drainSpy).not.toHaveBeenCalled();

        await client.setConfig({ background: { printBackgroundMode: 'drain' } });
        await expect(client.handlePrintMainTurnCompleted({ sessionId })).resolves.toBe('finish');
        await expect(client.waitForBackgroundTasksOnPrint({ sessionId })).resolves.toBeUndefined();
        expect(drainSpy).toHaveBeenNthCalledWith(1, 2_000);
        expect(drainSpy).toHaveBeenNthCalledWith(2, 2_000);

        drainSpy.mockRejectedValueOnce(new Error2('request.invalid', 'drain rejected'));
        await expect(client.waitForBackgroundTasksOnPrint({ sessionId })).rejects.toMatchObject({
          name: 'KimiError',
          code: ErrorCodes.REQUEST_INVALID,
          message: 'drain rejected',
        } satisfies Partial<KimiError>);
      } finally {
        drainSpy.mockRestore();
      }
    } finally {
      await client.close();
    }
  });

  it('delegates steer counts and preserves turn and deadline bounds', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-print-steer-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-print-steer-work-');
    const deadlineWorkDir = await makeTempDir(tempDirs, 'kimi-sdk-print-deadline-work-');
    const client = new SDKRpcClient({ homeDir, identity: TEST_IDENTITY });

    try {
      const maxTurnsSessionId = 'ses_print_steer_turns';
      await client.setConfig({
        background: {
          printBackgroundMode: 'steer',
          printWaitCeilingS: 10,
          printMaxTurns: 2,
        },
      });
      await client.createSession({ id: maxTurnsSessionId, workDir });
      const maxTurnsHandle = getLiveSessionById(client.engineAccessor, maxTurnsSessionId);
      expect(maxTurnsHandle).toBeDefined();
      const maxTurnsLifecycle = maxTurnsHandle!.accessor.get(IAgentLifecycleService);
      const countSpy = vi.spyOn(maxTurnsLifecycle, 'countPendingBackgroundTasks').mockReturnValue(1);

      try {
        await expect(client.handlePrintMainTurnCompleted({ sessionId: maxTurnsSessionId })).resolves.toBe(
          'continue',
        );
        countSpy.mockReturnValue(0);
        await expect(client.handlePrintMainTurnCompleted({ sessionId: maxTurnsSessionId })).resolves.toBe(
          'finish',
        );
        await expect(client.handlePrintMainTurnCompleted({ sessionId: maxTurnsSessionId })).resolves.toBe(
          'finish',
        );
        expect(countSpy).toHaveBeenCalledTimes(2);
        await expect(
          client.waitForBackgroundTasksOnPrint({ sessionId: maxTurnsSessionId }),
        ).resolves.toBeUndefined();
      } finally {
        countSpy.mockRestore();
      }

      const deadlineSessionId = 'ses_print_steer_deadline';
      await client.setConfig({ background: { printWaitCeilingS: 1, printMaxTurns: 100 } });
      await client.createSession({ id: deadlineSessionId, workDir: deadlineWorkDir });
      const deadlineHandle = getLiveSessionById(client.engineAccessor, deadlineSessionId);
      expect(deadlineHandle).toBeDefined();
      const deadlineLifecycle = deadlineHandle!.accessor.get(IAgentLifecycleService);
      const deadlineCountSpy = vi
        .spyOn(deadlineLifecycle, 'countPendingBackgroundTasks')
        .mockReturnValue(1);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);

      try {
        await expect(client.handlePrintMainTurnCompleted({ sessionId: deadlineSessionId })).resolves.toBe(
          'continue',
        );
        nowSpy.mockReturnValue(11_000);
        await expect(client.handlePrintMainTurnCompleted({ sessionId: deadlineSessionId })).resolves.toBe(
          'finish',
        );
        expect(deadlineCountSpy).toHaveBeenCalledTimes(1);
      } finally {
        nowSpy.mockRestore();
        deadlineCountSpy.mockRestore();
      }
    } finally {
      await client.close();
    }
  });

  it('requires a live session for both print policy methods', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-print-closed-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-print-closed-work-');
    const client = new SDKRpcClient({ homeDir, identity: TEST_IDENTITY });
    const sessionId = 'ses_print_closed';

    try {
      await client.createSession({ id: sessionId, workDir });
      await client.closeSession({ sessionId });

      await expect(client.waitForBackgroundTasksOnPrint({ sessionId })).rejects.toMatchObject({
        name: 'KimiError',
        code: ErrorCodes.SESSION_NOT_FOUND,
      } satisfies Partial<KimiError>);
      await expect(client.handlePrintMainTurnCompleted({ sessionId })).rejects.toMatchObject({
        name: 'KimiError',
        code: ErrorCodes.SESSION_NOT_FOUND,
      } satisfies Partial<KimiError>);
    } finally {
      await client.close();
    }
  });
});
