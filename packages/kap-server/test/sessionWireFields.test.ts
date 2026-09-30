import { describe, expect, it } from 'vitest';

import {
  IAgentActivityView,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentTokenCountingService,
  IAgentUsageService,
  ILogService,
  ISessionActivityView,
  ISessionDeliveryService,
  ISessionManager,
  ISessionMetadata,
  type Scope,
} from '@kiki/agent-core-v2';

import { IModelPricingService } from '../src/pricing/modelPricingService';
import { resolveSessionFacts, toWireSession, type SessionFacts, type SessionWireFields } from '../src/routes/sessions';

const fields: SessionWireFields = {
  id: 's1',
  workspaceId: 'w1',
  createdAt: 1,
  updatedAt: 2,
  archived: false,
};

const coldFacts: SessionFacts = {
  busy: false,
  mainTurnActive: false,
  pendingInteraction: 'none',
  live: false,
};

describe('toWireSession creator metadata', () => {
  it('projects persisted creator IDs into session.metadata for session lists', () => {
    const wire = toWireSession({
      ...fields,
      custom: { created_by_session_id: 'source-session', created_by_agent_id: 'main' },
    }, '/tmp/ws', coldFacts);
    expect(wire.metadata).toEqual({
      cwd: '/tmp/ws', created_by_session_id: 'source-session', created_by_agent_id: 'main',
    });
  });

  it('does not invent creator or fork ancestry for ordinary sessions', () => {
    expect(toWireSession(fields, '/tmp/ws', coldFacts).metadata).toEqual({ cwd: '/tmp/ws' });
  });
});

describe('toWireSession last_turn_reason', () => {
  it('falls back to the persisted outcome for a cold session', () => {
    const wire = toWireSession({ ...fields, lastTurnReason: 'failed' }, '/tmp/ws', coldFacts);
    expect(wire.last_turn_reason).toBe('failed');
  });

  it('prefers the live fact for a warm session', () => {
    const wire = toWireSession({ ...fields, lastTurnReason: 'failed' }, '/tmp/ws', {
      ...coldFacts,
      lastTurnReason: 'completed',
    });
    expect(wire.last_turn_reason).toBe('completed');
  });

  it('omits the outcome when neither side has one', () => {
    expect(toWireSession(fields, '/tmp/ws', coldFacts).last_turn_reason).toBeUndefined();
  });

  it('never falls back for a live session mid-turn (no stale outcome)', () => {
    const busyFacts: SessionFacts = { busy: true, mainTurnActive: true, pendingInteraction: 'none', live: true };
    const wire = toWireSession({ ...fields, lastTurnReason: 'failed' }, '/tmp/ws', busyFacts);
    expect(wire.last_turn_reason).toBeUndefined();
  });

  it('a warm session without a live outcome does not read the persisted one', () => {
    const wire = toWireSession(
      { ...fields, lastTurnReason: 'failed' },
      '/tmp/ws',
      { ...coldFacts, live: true },
    );
    expect(wire.last_turn_reason).toBeUndefined();
  });
});

interface FakeAgent {
  readonly id: string;
  readonly accessor: { get(id: unknown): unknown };
  readonly services: Map<unknown, unknown>;
  readonly unreadable?: boolean;
}

function agentOf(id: string, services: Map<unknown, unknown>): FakeAgent {
  const agent: FakeAgent = {
    id,
    services,
    accessor: {
      get: (service) => {
        if (!services.has(service)) throw new Error(`unexpected service in agent ${id}`);
        return services.get(service);
      },
    },
  };
  return agent;
}

function unreadableAgent(id: string): FakeAgent {
  return { id, services: new Map(), accessor: { get: () => { throw new Error('usage store offline'); } }, unreadable: true };
}

const USAGE_STATUS = {
  total: { inputOther: 5, output: 6, inputCacheRead: 7, inputCacheCreation: 8 },
  byModel: {},
};

function liveSession(agents: readonly FakeAgent[]) {
  const warns: { readonly message: string; readonly payload: unknown }[] = [];
  let usageThrows = false;
  const main = agentOf('main', new Map<unknown, unknown>([
    [IAgentProfileService, {
      data: () => undefined,
      getModel: () => 'example-model',
      getModelCapabilities: () => ({ max_context_tokens: 200_000 }),
    }],
    [IAgentUsageService, { status: () => {
      if (usageThrows) throw new Error('usage store offline');
      return USAGE_STATUS;
    } }],
    [IAgentTokenCountingService, { statusSize: () => 42 }],
    [IAgentActivityView, { state: () => ({}) }],
  ]));
  const listed = [main, ...agents];
  const sessionAccessor = new Map<unknown, unknown>([
    [IAgentLifecycleService, { list: () => listed }],
    [ISessionMetadata, { usage: () => undefined }],
    [ISessionActivityView, { state: () => ({ busy: false, mainTurnActive: false, pendingInteraction: 'none' }) }],
    [ISessionDeliveryService, { mode: () => 'reply' }],
  ]);
  const handle = { id: 's1', accessor: { get: (service: unknown) => sessionAccessor.get(service) } };
  const core = {
    accessor: {
      get: (service: unknown) => {
        if (service === ISessionManager) return { get: () => handle };
        if (service === IModelPricingService) return { calculate: () => undefined };
        if (service === ILogService) {
          return { warn: (message: string, payload: unknown) => { warns.push({ message, payload }); } };
        }
        throw new Error('unexpected core service');
      },
    },
  } as unknown as Scope;
  return { core, warns, failUsageRead: () => { usageThrows = true; } };
}

describe('resolveSessionFacts usage failures', () => {
  it('projects live usage with no error marker when every read succeeds', () => {
    const { core, warns } = liveSession([]);
    const facts = resolveSessionFacts(core, 's1');
    expect(facts.live).toBe(true);
    expect(facts.usageError).toBeUndefined();
    expect(facts.usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 6,
      cache_read_tokens: 7,
      cache_creation_tokens: 8,
      context_tokens: 42,
      context_limit: 200_000,
    });
    expect(warns).toEqual([]);
  });

  it('reads every live agent when the session has no aggregated summary yet', () => {
    const child = agentOf('worker-1', new Map<unknown, unknown>([
      [IAgentUsageService, {
        status: () => ({ total: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 }, byModel: {} }),
      }],
    ]));
    const { core, warns } = liveSession([child]);
    const facts = resolveSessionFacts(core, 's1');
    expect(facts.usageError).toBeUndefined();
    expect(facts.usage).toMatchObject({ input_tokens: 6, output_tokens: 8, cache_read_tokens: 10, cache_creation_tokens: 12 });
    expect(warns).toEqual([]);
  });

  it('keeps the totals it read and reports a skipped agent instead of dropping the failure', () => {
    const { core, warns } = liveSession([unreadableAgent('partial-worker')]);
    const facts = resolveSessionFacts(core, 's1');
    expect(facts.usage).toMatchObject({ input_tokens: 5, output_tokens: 6 });
    expect(facts.usageError).toBe('agent-read-failed');
    expect(toWireSession(fields, '/tmp/ws', facts).usage_error).toBe('agent-read-failed');
    expect(warns).toEqual([
      { message: 'session usage: agent usage unavailable', payload: { agent_id: 'partial-worker', error: 'usage store offline' } },
    ]);
  });

  it('reports a failed read with no usage and logs why, instead of an empty usage', () => {
    const { core, warns, failUsageRead } = liveSession([]);
    failUsageRead();
    const facts = resolveSessionFacts(core, 's1');
    expect(facts.usage).toBeUndefined();
    expect(facts.usageError).toBe('read-failed');
    const wire = toWireSession(fields, '/tmp/ws', facts);
    expect(wire.usage_error).toBe('read-failed');
    expect(wire.usage).toMatchObject({ input_tokens: 0, output_tokens: 0, turn_count: 0 });
    expect(warns).toEqual([
      { message: 'session usage: read failed', payload: { error: 'usage store offline' } },
    ]);
  });
});
