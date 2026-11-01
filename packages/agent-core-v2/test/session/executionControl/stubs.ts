import { Event } from '#/_base/event';
import type { ExecutionControlState, ISessionExecutionControl } from '#/session/executionControl/executionControl';

const running: ExecutionControlState = { phase: 'running', agents: [] };

export function stubExecutionControl(): ISessionExecutionControl {
  return {
    _serviceBrand: undefined,
    onDidChange: Event.None as Event<ExecutionControlState>,
    read: async () => running,
    pause: async () => running,
    resume: async () => running,
    register: () => ({ dispose: () => {} }),
    ready: async () => {},
    isHeld: () => false,
    resumePoint: () => undefined,
    park: () => {},
    isParked: () => false,
    invalidate: async () => {},
  };
}
