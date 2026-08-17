import { describe, expect, it, vi } from 'vitest';

import { agentTask } from './background/helpers';
import { testAgent } from './harness/agent';

describe('Agent lifecycle', () => {
  it('closes idempotently only after dynamically spawned lifecycle work becomes idle', async () => {
    const { agent } = testAgent();
    const firstCompletion = createDeferred<{ result: string }>();
    const secondCompletion = createDeferred<{ result: string }>();
    const cronStopSpy = vi.spyOn(agent.cron!, 'stop');
    const recordsCloseSpy = vi.spyOn(agent.records, 'close');
    const steerSpy = vi.spyOn(agent.turn, 'steer').mockReturnValue(null);
    let secondTaskId: string | undefined;
    vi.spyOn(agent.turn, 'waitForIdle').mockImplementation(async () => {
      if (secondTaskId === undefined) {
        secondTaskId = agent.background.registerTask(
          agentTask(secondCompletion.promise, 'spawned by terminal notification'),
        );
      }
    });

    agent.background.registerTask(agentTask(firstCompletion.promise, 'initial background task'));
    const closePromise = agent.close();

    expect(agent.close()).toBe(closePromise);
    expect(recordsCloseSpy).not.toHaveBeenCalled();

    firstCompletion.resolve({ result: 'first done' });
    await vi.waitFor(() => {
      expect(secondTaskId).toBeDefined();
    });

    expect(recordsCloseSpy).not.toHaveBeenCalled();
    expect(agent.background.getTask(secondTaskId!)?.status).toBe('running');

    secondCompletion.resolve({ result: 'second done' });
    await closePromise;

    expect(cronStopSpy).toHaveBeenCalledOnce();
    expect(steerSpy).toHaveBeenCalledTimes(2);
    expect(recordsCloseSpy).toHaveBeenCalledOnce();
  });
});

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolveValue: (value: T) => void = () => {
    /* replaced below */
  };
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: resolveValue,
  };
}
