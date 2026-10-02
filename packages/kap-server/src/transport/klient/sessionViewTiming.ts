import { channel } from 'node:diagnostics_channel';

const timing = channel('kiki.session-view.timing');

export function recordSessionViewTiming(stage: string, startedAt: number, fields: {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly generation?: number;
  readonly admittedAgents?: number;
  readonly priorityAgents?: number;
}): void {
  if (timing.hasSubscribers) timing.publish({ stage, durationMs: performance.now() - startedAt, ...fields });
}
