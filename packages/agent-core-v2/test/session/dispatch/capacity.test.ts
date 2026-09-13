import { describe, expect, it } from 'vitest';

import { DispatchCapacity } from '#/session/dispatch/capacity';
import { DEFAULT_MAX_DIRECT_CHILDREN, DEFAULT_MAX_TOTAL_SUBAGENTS, SubagentConfigSchema } from '#/session/subagent/configSection';

describe('dispatch capacity', () => {
  it('defaults to sixteen direct children and an unlimited tree', () => {
    expect(DEFAULT_MAX_DIRECT_CHILDREN).toBe(16);
    expect(DEFAULT_MAX_TOTAL_SUBAGENTS).toBe(0);
    expect(SubagentConfigSchema.safeParse({ maxDirectChildren: -1 }).success).toBe(false);
    expect(SubagentConfigSchema.safeParse({ maxTotalSubagents: 1.5 }).success).toBe(false);
  });

  it('reserves atomically before asynchronous creation and releases idempotently', async () => {
    const capacity = new DispatchCapacity();
    const limits = { maxDirectChildren: 1, maxTotalSubagents: 0 };
    const attempts = await Promise.allSettled([0, 1].map(async () => capacity.reserve('main', limits)));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts[1]).toMatchObject({ status: 'rejected', reason: {
      code: 'dispatch.limit_exceeded', details: { layer: 'direct', current: 1, limit: 1 },
    } });
    if (attempts[0]?.status !== 'fulfilled') throw new Error('First reservation failed');
    attempts[0].value();
    attempts[0].value();
    expect(() => capacity.reserve('main', limits)).not.toThrow();
  });

  it('counts descendants after their parent finishes without charging another session', () => {
    const capacity = new DispatchCapacity();
    const limits = { maxDirectChildren: 2, maxTotalSubagents: 2 };
    const parent = capacity.reserve('main', limits, 'child');
    capacity.reserve('child', limits, 'grandchild');
    expect(() => capacity.reserve('grandchild', limits)).toThrow(expect.objectContaining({
      code: 'dispatch.limit_exceeded', details: expect.objectContaining({ layer: 'tree', current: 2, limit: 2 }),
    }));
    parent();
    capacity.reserve('grandchild', limits, 'great-grandchild');
    expect(() => capacity.reserve('main', limits)).toThrow();
    expect(() => new DispatchCapacity().reserve('main', limits)).not.toThrow();
  });

  it('reserves resume once, rejects a concurrent resume, and allows the next run after release', () => {
    const capacity = new DispatchCapacity();
    const limits = { maxDirectChildren: 8, maxTotalSubagents: 0 };
    const release = capacity.reserve('main', limits, 'child');
    expect(() => capacity.reserve('main', limits, 'child')).toThrow(expect.objectContaining({ code: 'agent.already_running' }));
    release();
    expect(() => capacity.reserve('main', limits, 'child')).not.toThrow();
  });

  it('retains one agent slot across execution and turn owners without early or duplicate release', () => {
    const capacity = new DispatchCapacity();
    const limits = { maxDirectChildren: 1, maxTotalSubagents: 1 };
    const execution = capacity.reserve('main', limits, 'A');
    execution.claim('A');
    const turn = capacity.retain('A')!;
    execution();
    execution();
    expect(() => capacity.reserve('main', limits, 'B')).toThrow(expect.objectContaining({ code: 'dispatch.limit_exceeded' }));
    turn();
    turn();
    expect(capacity.retain('A')).toBeUndefined();
    const next = capacity.reserve('main', limits, 'B');
    next();
  });

  it('keeps direct owners separate and supports explicitly unlimited limits', () => {
    const capacity = new DispatchCapacity();
    const limits = { maxDirectChildren: 1, maxTotalSubagents: 0 };
    for (let index = 0; index < 100; index++) capacity.reserve(String(index), limits);
    expect(() => capacity.reserve('0', limits)).toThrow();
    for (let index = 0; index < 100; index++) capacity.reserve('0', { maxDirectChildren: 0, maxTotalSubagents: 0 });
  });
});
