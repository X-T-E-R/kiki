import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IConfigService, type ConfigSectionChangedEvent } from '#/app/config/config';
import { IRequestGovernance } from '#/app/requestGovernance/requestGovernance';
import { RequestGovernanceService } from '#/app/requestGovernance/requestGovernanceService';
import { RequestGovernanceConfigSchema, requestGovernanceFromToml, requestGovernanceToToml } from '#/app/requestGovernance/configSection';
import { parse, stringify } from 'smol-toml';
import type { RequestAttempt } from '#/kosong/model/requestAdmission';

const disposables: Array<{ dispose(): void }> = [];
afterEach(() => { for (const item of disposables.splice(0).toReversed()) item.dispose(); vi.useRealTimers(); });

function governor(value: unknown = {}) {
  const ix = new TestInstantiationService();
  const change = new Emitter<ConfigSectionChangedEvent>();
  let settings = RequestGovernanceConfigSchema.parse(value);
  ix.stub(IConfigService, { get: <T>() => settings as T, onDidSectionChange: change.event });
  ix.set(IRequestGovernance, new SyncDescriptor(RequestGovernanceService));
  const service = ix.get(IRequestGovernance);
  disposables.push(ix, change);
  return { service, update: (value: unknown) => {
    settings = RequestGovernanceConfigSchema.parse(value);
    change.fire({ domain: 'requestGovernance' } as ConfigSectionChangedEvent);
  } };
}
let next = 0;
function attempt(sessionId = 'session-a', extras: Partial<RequestAttempt> = {}): RequestAttempt {
  const id = `attempt-${next++}`;
  return { logicalRequestId: id, attemptId: id, modelId: 'model-a', providerId: 'provider-a', sessionId, agentId: `${sessionId}-main`, purpose: 'turn', waitBudget: { waitedMs: 0 }, ...extras };
}
const cap = (maxConcurrent: number, extras = {}) => ({ id: 'cap', maxConcurrent, ...extras });

describe('RequestGovernance', () => {
  it('does not queue or reject with no configured rules', async () => {
    const { service } = governor();
    const permits = await Promise.all(Array.from({ length: 40 }, () => service.acquire(attempt())));
    expect(service.snapshot()).toMatchObject({ active: 40, queued: 0, coverage: { external: 'unmanaged' } });
    permits.forEach((permit) => { permit.release(); permit.release(); });
    expect(service.snapshot().active).toBe(0);
  });

  it('atomically caps 20 requests from each of two sessions at two', async () => {
    const { service } = governor({ rules: [cap(2)] });
    let peak = 0;
    const work = Array.from({ length: 40 }, (_, i) => service.acquire(attempt(i % 2 === 0 ? 'session-a' : 'session-b')).then(async (permit) => {
      peak = Math.max(peak, service.snapshot().active);
      expect(service.snapshot().active).toBeLessThanOrEqual(2);
      await Promise.resolve();
      permit.release();
    }));
    expect(service.snapshot()).toMatchObject({ active: 2, queued: 38 });
    await Promise.all(work);
    expect(peak).toBe(2);
    expect(service.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('combines global, per-session, model, provider and child selectors without partial reservation', async () => {
    const { service } = governor({ rules: [cap(3), { id: 'session', scope: 'each_session', maxConcurrent: 1 }, { id: 'child-provider', providers: ['provider-a'], subagentsOnly: true, maxConcurrent: 1 }] });
    const root = await service.acquire(attempt());
    const child = await service.acquire(attempt('session-b', { parentAgentId: 'main', modelId: 'model-b' }));
    const controller = new AbortController();
    const queued = service.acquire(attempt('session-c', { parentAgentId: 'main' }), controller.signal);
    expect(service.snapshot()).toMatchObject({ active: 2, queued: 1 });
    const free = await service.acquire(attempt('session-d', { providerId: 'provider-b' }));
    expect(service.snapshot().active).toBe(3);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    root.release(); child.release(); free.release();
    expect(service.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('rejects only currently blocking reject rules and protects the queue', async () => {
    const { service } = governor({ maxQueueSize: 1, rules: [cap(1)] });
    const permit = await service.acquire(attempt());
    const controller = new AbortController();
    const queued = service.acquire(attempt(), controller.signal);
    await expect(service.acquire(attempt())).rejects.toMatchObject({ code: 'request.queue_full' });
    controller.abort(); await expect(queued).rejects.toBeDefined();
    permit.release();
    const rejected = governor({ rules: [cap(1, { overflow: 'reject' })] }).service;
    const first = await rejected.acquire(attempt());
    await expect(rejected.acquire(attempt())).rejects.toMatchObject({ code: 'request.limit_rejected' });
    first.release();
  });

  it('keeps cumulative waiting budgets across attempts and never admits cancelled queues', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { service } = governor({ maxWaitMs: 100, rules: [cap(1)] });
    const occupied = await service.acquire(attempt());
    const budget = { waitedMs: 0 };
    const controller = new AbortController();
    const queued = service.acquire(attempt('session-b', { waitBudget: budget }), controller.signal);
    const cancelled = expect(queued).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(60);
    controller.abort(); await cancelled;
    expect(budget.waitedMs).toBe(60);
    const retry = service.acquire(attempt('session-b', { waitBudget: budget }));
    const timeout = expect(retry).rejects.toMatchObject({ code: 'request.queue_timeout' });
    await vi.advanceTimersByTimeAsync(40); await timeout;
    occupied.release();
    expect(service.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('re-evaluates waiting requests and existing active occupancy when rules change', async () => {
    const { service, update } = governor();
    const first = await service.acquire(attempt());
    const second = await service.acquire(attempt());
    update({ rules: [cap(1)] });
    const third = service.acquire(attempt());
    expect(service.snapshot()).toMatchObject({ active: 2, queued: 1 });
    first.release(); expect(service.snapshot().queued).toBe(1);
    second.release(); (await third).release();
    expect(service.snapshot().active).toBe(0);
  });

  it('treats a disabled rule as absent and drains its queue when it is switched off', async () => {
    const { service, update } = governor({ rules: [cap(1)] });
    const permit = await service.acquire(attempt());
    const queued = service.acquire(attempt());
    expect(service.snapshot()).toMatchObject({ active: 1, queued: 1 });
    update({ rules: [cap(1, { enabled: false })] });
    (await queued).release();
    expect(service.snapshot()).toMatchObject({ active: 1, queued: 0 });
    expect(service.snapshot().rules[0]).toMatchObject({ id: 'cap', enabled: false });
    update({ rules: [cap(1)] });
    const held = service.acquire(attempt('session-b'));
    expect(service.snapshot()).toMatchObject({ active: 1, queued: 1 });
    permit.release();
    (await held).release();
    expect(service.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });
  it('defers observer mutations until admission completes and preserves queued requests', async () => {
    const { service, update } = governor({ rules: [cap(1)] });
    const first = await service.acquire(attempt());
    const second = service.acquire(attempt());
    const third = service.acquire(attempt());
    let notifications = 0;
    const listener = service.onDidChange(() => {
      notifications += 1;
      if (notifications === 1) update({ rules: [cap(2)] });
    });
    disposables.push(listener);
    first.release();
    expect(notifications).toBe(0);
    expect(service.snapshot()).toMatchObject({ active: 1, queued: 1 });
    const permits = await Promise.all([second, third]);
    expect(service.snapshot()).toMatchObject({ active: 2, queued: 0 });
    permits.forEach((permit) => { permit.release(); });
    expect(service.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });
});

it('round-trips nested TOML rule keys without rewriting model/provider IDs or retaining removed caps', () => {
  const raw = parse(`
[request_governance]
schema_version = 1
max_wait_ms = 300000
max_queue_size = 1024
[[request_governance.rules]]
id = "example-cap"
scope = "each_session"
models = ["example_model"]
providers = ["example_provider"]
subagents_only = true
max_concurrent = 2
max_wait_ms = 100
`);
  const settings = RequestGovernanceConfigSchema.parse(requestGovernanceFromToml(raw['request_governance']));
  expect(settings.rules[0]).toMatchObject({ models: ['example_model'], providers: ['example_provider'], subagentsOnly: true, maxConcurrent: 2, maxWaitMs: 100 });
  expect(RequestGovernanceConfigSchema.parse(requestGovernanceFromToml(parse(stringify({ request_governance: requestGovernanceToToml(settings, raw['request_governance']) }))['request_governance']))).toEqual(settings);
  settings.rules[0]!.maxConcurrent = undefined;
  const removed = requestGovernanceToToml(settings, raw['request_governance']) as { rules: Record<string, unknown>[] };
  expect(removed.rules[0]).not.toHaveProperty('max_concurrent');
  expect(removed.rules[0]).not.toHaveProperty('maxConcurrent');
  expect(RequestGovernanceConfigSchema.safeParse({ rules: [cap(0)] }).success).toBe(false);
  expect(RequestGovernanceConfigSchema.safeParse({ rules: [cap(1), cap(2)] }).success).toBe(false);
});

function agentAttempt(agentId: string, extras: Partial<import('#/app/requestGovernance/agentActivity').AgentExecutionAttempt> = {}): import('#/app/requestGovernance/agentActivity').AgentExecutionAttempt {
  return { sessionId: 'session-a', agentId, ancestorAgentIds: [], executorId: 'native', modelId: 'model-a', profileId: 'worker', role: agentId === 'main' ? 'main' : 'subagent', readPhase: () => 'running', ...extras };
}
const agentCap = (maxConcurrent: number, extras = {}) => cap(maxConcurrent, { resource: 'agent_execution', ...extras });

describe('Agent execution governance', () => {
  it('counts tool stages, native main and external children once, independently of requests and idle rosters', async () => {
    const { service } = governor();
    let phase: import('#/app/requestGovernance/agentActivity').AgentActivityPhase = 'running';
    const first = await service.acquireAgent(agentAttempt('main', { readPhase: () => phase }));
    const nested = await service.acquireAgent(agentAttempt('main'));
    const external = await service.acquireAgent(agentAttempt('child', { executorId: 'external-test', modelId: undefined }));
    const independent = await service.acquireAgent(agentAttempt('seat', { role: 'independent', executorId: 'external-test', profileId: undefined, modelId: undefined }));
    const request = await service.acquire(attempt());
    expect(service.agentSnapshot()).toMatchObject({ active: 3, queued: 0, main: 1, subagent: 1, independent: 1 });
    expect(service.snapshot().active).toBe(1);
    expect(service.agentSnapshot().dimensions).toContainEqual(expect.objectContaining({ dimension: 'model', id: null, active: 2 }));
    phase = 'tool_waiting';
    expect(service.agentSnapshot().agents.find((row) => row.agentId === 'main')?.phase).toBe('tool_waiting');
    phase = 'suspended';
    expect(service.agentSnapshot().active).toBe(3);
    phase = 'cancelling';
    first.release(); first.release();
    expect(service.agentSnapshot().active).toBe(3);
    nested.release(); external.release(); independent.release(); request.release();
    expect(service.agentSnapshot().active).toBe(0);
  });

  it('atomically enforces executor/profile/model/role and per-session selectors without blocking model requests', async () => {
    const { service } = governor({ rules: [agentCap(1, { scope: 'each_session', executors: ['external-test'], profiles: ['worker'], models: ['external-model'], roles: ['subagent'] })] });
    const matching = agentAttempt('a', { executorId: 'external-test', modelId: 'external-model' });
    const occupied = await service.acquireAgent(matching);
    const queued = service.acquireAgent({ ...matching, agentId: 'b' });
    expect(service.agentSnapshot()).toMatchObject({ active: 1, queued: 1, queuedSubagent: 1 });
    const permits = await Promise.all([
      service.acquireAgent({ ...matching, agentId: 'main', role: 'main' }),
      service.acquireAgent({ ...matching, agentId: 'c', sessionId: 'session-b' }),
      service.acquireAgent({ ...matching, agentId: 'd', modelId: undefined }),
      service.acquireAgent({ ...matching, agentId: 'e', profileId: 'other' }),
      service.acquireAgent({ ...matching, agentId: 'f', executorId: 'native' }),
      service.acquire(attempt()),
    ]);
    occupied.release(); (await queued).release(); permits.forEach((permit) => permit.release());
    expect(service.agentSnapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('rejects cap-one ancestor contention with actionable rule and parent facts, but queues independent competition FIFO', async () => {
    const { service } = governor({ rules: [agentCap(1)] });
    const occupied = await service.acquireAgent(agentAttempt('main'));
    const retained = await service.acquireAgent(agentAttempt('main'));
    await expect(service.acquireAgent(agentAttempt('child', { ancestorAgentIds: ['main'], parentAgentId: 'main' }))).rejects.toMatchObject({
      code: 'request.agent_ancestor_limit', details: { rules: ['cap'], occupyingAncestors: [{ ruleId: 'cap', sessionId: 'session-a', agentId: 'main' }], action: 'separate_main_subagent_rules_or_raise_limit' },
    });
    const first = service.acquireAgent(agentAttempt('first', { sessionId: 'session-b' }));
    const second = service.acquireAgent(agentAttempt('second', { sessionId: 'session-c' }));
    occupied.release();
    expect(service.agentSnapshot()).toMatchObject({ active: 1, queued: 2 });
    retained.release();
    const firstPermit = await first;
    expect(service.agentSnapshot().agents[0]?.agentId).toBe('first');
    firstPermit.release(); (await second).release();
    expect(service.agentSnapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('cancels queued work, re-evaluates rules without terminating in-flight work and ignores stale releases', async () => {
    const { service, update } = governor({ rules: [agentCap(1)] });
    const occupied = await service.acquireAgent(agentAttempt('a'));
    const controller = new AbortController();
    const aborted = service.acquireAgent(agentAttempt('b'), controller.signal);
    controller.abort(); await expect(aborted).rejects.toBeDefined();
    const pending = service.acquireAgent(agentAttempt('b'));
    update({ rules: [agentCap(2)] });
    const admitted = await pending;
    expect(service.agentSnapshot().active).toBe(2);
    update({ rules: [agentCap(1)] });
    expect(service.agentSnapshot().active).toBe(2);
    occupied.release(); admitted.release();
    const newEpisode = await service.acquireAgent(agentAttempt('a'));
    occupied.release();
    expect(service.agentSnapshot().active).toBe(1);
    newEpisode.release();
    expect(service.agentSnapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('deduplicates concurrently queued same-agent retain calls and releases the final reference', async () => {
    const { service } = governor({ rules: [agentCap(1)] });
    const occupied = await service.acquireAgent(agentAttempt('a'));
    const first = service.acquireAgent(agentAttempt('b'));
    const second = service.acquireAgent(agentAttempt('b'));
    expect(service.agentSnapshot().queued).toBe(1);
    occupied.release();
    const permits = await Promise.all([first, second]);
    expect(service.agentSnapshot().active).toBe(1);
    permits[0]!.release(); expect(service.agentSnapshot().active).toBe(1);
    permits[1]!.release(); expect(service.agentSnapshot().active).toBe(0);
  });
});

it('atomically caps simultaneous external agent episodes without changing request occupancy', async () => {
  const { service } = governor({ rules: [agentCap(2, { executors: ['external-example'] })] });
  let peak = 0;
  const work = Array.from({ length: 20 }, (_, index) => service.acquireAgent(agentAttempt(`agent-${index}`, { executorId: 'external-example', sessionId: `session-${index % 2}` })).then(async (permit) => {
    peak = Math.max(peak, service.agentSnapshot().active);
    expect(service.agentSnapshot().active).toBeLessThanOrEqual(2);
    await Promise.resolve();
    permit.release();
  }));
  expect(service.agentSnapshot()).toMatchObject({ active: 2, queued: 18 });
  expect(service.snapshot()).toMatchObject({ active: 0, queued: 0 });
  await Promise.all(work);
  expect(peak).toBe(2);
  expect(service.agentSnapshot()).toMatchObject({ active: 0, queued: 0 });
});
