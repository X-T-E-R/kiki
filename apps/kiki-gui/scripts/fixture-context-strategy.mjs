/**
 * Fixture stand-in for `GET/PATCH /sessions/{id}/agents/{agent}/context-strategy`
 * (kap-server routes/contextStrategy.ts) and the strategy-aware manual
 * `:compact`. Resolution mirrors agent-core's getContextStrategy:
 *   main:     session override → profile → global (loop_control) → default
 *   subagent: profile → subagent default (always read-only here)
 * A `save: 'global'` PATCH writes loop_control.contextStrategy and drops the
 * session override, like the engine.
 *
 * Scenario seeds (all optional):
 *   contextStrategy: {
 *     profiles:  { [profileName]: 'summarize' | 'fresh' | 'auto' },
 *     overrides: { [sessionId]: strategy },
 *     executor:  [sessionId],   // external executor: fixed summarize, locked
 *     disabled:  [sessionId],   // older engine: the route 404s
 *   }
 */

const STRATEGIES = new Set(['summarize', 'fresh', 'auto']);

function seedOf(server) {
  return server.scenario?.data.contextStrategy ?? {};
}

function overridesOf(server) {
  if (server.contextStrategyOverrides === undefined) {
    server.contextStrategyOverrides = new Map(Object.entries(seedOf(server).overrides ?? {}));
  }
  return server.contextStrategyOverrides;
}

export function resolveContextStrategy(server, session, agentId) {
  const seed = seedOf(server);
  if ((seed.executor ?? []).includes(session.record.id)) return { strategy: 'summarize', source: 'executor', shadow: false };
  const profileName = session.record.agent_config?.profile ?? 'agent';
  const profile = seed.profiles?.[profileName];
  const loop = server.config.loop_control ?? {};
  if (agentId !== 'main') {
    if (profile !== undefined) return { strategy: profile, source: 'profile', shadow: false };
    return { strategy: loop.subagentContextStrategy ?? 'summarize', source: 'subagent', shadow: false };
  }
  const override = overridesOf(server).get(session.record.id);
  if (override !== undefined) return { strategy: override, source: 'session', shadow: false };
  if (profile !== undefined) return { strategy: profile, source: 'profile', shadow: false };
  if (loop.contextStrategy !== undefined) return { strategy: loop.contextStrategy, source: 'global', shadow: false };
  return { strategy: 'summarize', source: 'default', shadow: false };
}

/** Resets per-scenario state; call when a scenario loads. */
export function resetContextStrategy(server) {
  server.contextStrategyOverrides = undefined;
}

function publishStatus(server, session) {
  const current = resolveContextStrategy(server, session, 'main');
  server.emit(session.record.id, {
    type: 'agent.status.updated',
    agentId: 'main',
    payload: { contextStrategy: current.strategy, contextStrategySource: current.source },
  });
}

/**
 * Handles `/agents/{agentId}/context-strategy` under a session. Returns true
 * when the request was answered.
 */
export function handleContextStrategy(server, res, session, tail, body, method) {
  const match = /^\/agents\/([^/]+)\/context-strategy$/.exec(tail);
  if (match === null) return false;
  const agentId = decodeURIComponent(match[1]);
  if ((seedOf(server).disabled ?? []).includes(session.record.id)) {
    server.envelope(res, null, 40404, 'route not found');
    return true;
  }
  if (method !== 'PATCH') {
    server.envelope(res, resolveContextStrategy(server, session, agentId));
    return true;
  }
  if (agentId !== 'main') {
    server.envelope(res, null, 40001, 'Session strategy override belongs to the main agent');
    return true;
  }
  const input = body ?? {};
  if (input.strategy !== null && !STRATEGIES.has(input.strategy)) {
    server.envelope(res, null, 40001, 'strategy must be summarize, auto, fresh or null');
    return true;
  }
  const overrides = overridesOf(server);
  if (input.save === 'global') {
    const strategy = input.strategy ?? resolveContextStrategy(server, session, 'main').strategy;
    server.config.loop_control = { ...(server.config.loop_control ?? {}), contextStrategy: strategy };
    overrides.delete(session.record.id);
  } else if (input.strategy === null) {
    overrides.delete(session.record.id);
  } else {
    overrides.set(session.record.id, input.strategy);
  }
  publishStatus(server, session);
  server.envelope(res, resolveContextStrategy(server, session, 'main'));
  return true;
}
