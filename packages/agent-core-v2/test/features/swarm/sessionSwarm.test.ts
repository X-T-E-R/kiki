import { describe, expect, it } from 'vitest';

import { EVENT2_REGISTRY, event2FromRecord } from '#/app/event/event2';
import { SubagentSuspended } from '#/features/swarm/session/sessionSwarmService';

const HISTORIC_SUBAGENT_SUSPENDED_RECORD = {
  type: 'subagent.suspended',
  subagentId: 'child-3',
  reason: 'approval',
  time: 5_000,
} as const;

describe('SubagentSuspended historical wire compatibility', () => {
  it('keeps the historic event type and payload schema', () => {
    expect(SubagentSuspended.type).toBe('subagent.suspended');
    expect(SubagentSuspended.durable).toBe(true);
    expect(SubagentSuspended.observable).toBe(true);
    expect(
      SubagentSuspended.schema.safeParse({
        subagentId: HISTORIC_SUBAGENT_SUSPENDED_RECORD.subagentId,
        reason: HISTORIC_SUBAGENT_SUSPENDED_RECORD.reason,
      }).success,
    ).toBe(true);
    expect(
      SubagentSuspended.schema.safeParse({
        subagentId: HISTORIC_SUBAGENT_SUSPENDED_RECORD.subagentId,
        reason: 42,
      }).success,
    ).toBe(false);
  });

  it('decodes a registered historic record and serializes it unchanged', () => {
    expect(EVENT2_REGISTRY.get(HISTORIC_SUBAGENT_SUSPENDED_RECORD.type)).toBe(SubagentSuspended);

    const decoded = event2FromRecord(SubagentSuspended, HISTORIC_SUBAGENT_SUSPENDED_RECORD);

    expect(decoded).toBeInstanceOf(SubagentSuspended);
    expect(decoded).toMatchObject(HISTORIC_SUBAGENT_SUSPENDED_RECORD);
    expect(decoded?.serialize()).toEqual(HISTORIC_SUBAGENT_SUSPENDED_RECORD);
  });
});
