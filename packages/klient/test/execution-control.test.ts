import { describe, expect, it } from 'vitest';
import { createSessionFacade } from '../src/core/facade/session.js';
import { executionControlStateSchema } from '../src/contract/session/executionControl.js';
import { sessionEvents } from '../src/contract/session/events.js';

describe('session execution control facade', () => {
  it('routes explicit controls to one session and preserves operation identities', async () => {
    const calls: unknown[] = [];
    const state = { phase: 'paused' as const, pauseOperationId: 'pause-1', agents: [] };
    const facade = createSessionFacade(async (...args) => { calls.push(args); return state; }, 'session-1');
    expect(await facade.execution.read()).toEqual(state);
    await facade.execution.pause({ operationId: 'pause-1' });
    await facade.execution.cancelPause({ operationId: 'cancel-1', pauseOperationId: 'pause-1' });
    await facade.execution.resume({ operationId: 'resume-1', pauseOperationId: 'pause-1' });
    expect(calls).toEqual([
      [{ sessionId: 'session-1' }, 'sessionExecutionControl', 'read', []],
      [{ sessionId: 'session-1' }, 'sessionExecutionControl', 'pause', [{ operationId: 'pause-1' }]],
      [{ sessionId: 'session-1' }, 'sessionExecutionControl', 'cancelPause', [{ operationId: 'cancel-1', pauseOperationId: 'pause-1' }], { timeoutMs: 0 }],
      [{ sessionId: 'session-1' }, 'sessionExecutionControl', 'resume', [{ operationId: 'resume-1', pauseOperationId: 'pause-1' }], { timeoutMs: 0 }],
    ]);
    expect(executionControlStateSchema.parse(state)).toEqual(state);
    expect(sessionEvents['execution.changed']).toMatchObject({ service: 'sessionExecutionControl', event: 'onDidChange' });
  });
});
