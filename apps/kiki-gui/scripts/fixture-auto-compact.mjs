/**
 * Fixture stand-in for `GET/PATCH /sessions/{id}/agents/{agent}/auto-compact`
 * (kap-server routes/autoCompact.ts). Mirrors the engine's resolution closely
 * enough for the GUI to exercise every state honestly:
 *   session override (per agent, per model) → profile → model → global % →
 *   legacy `min(0.85·U, U − R)`; explicit layers clamp to [floor, U − R].
 * Writes land in the same fixture state the settings pages read (model
 * catalog, agent profiles, config.loop_control), so a saved default shows up
 * everywhere and later GETs resolve from it.
 *
 * Scenario seeds (all optional):
 *   autoCompact: {
 *     windows:   { [modelId]: { usable?: number, reserved?: number } },
 *     overrides: { [sessionId]: { [agentId]: { [modelId]: tokens } } },
 *     disabled:  [sessionId]   // older engine: the route 404s
 *   }
 */

const DEFAULT_RESERVED = 50_000;

function loopControl(server) {
  const raw = server.config.loop_control;
  const record = raw !== null && typeof raw === 'object' ? raw : {};
  const pick = (camel, snake) => record[camel] ?? record[snake];
  return {
    autoCompact: pick('autoCompact', 'auto_compact'),
    ratio: pick('compactionTriggerRatio', 'compaction_trigger_ratio'),
    reserved: pick('reservedContextSize', 'reserved_context_size'),
  };
}

function modelFor(server, session, agentId) {
  const agent = agentId === 'main' ? undefined : server.autoCompactAgents?.[session.record.id]?.[agentId];
  const id = agent?.model || session.record.agent_config?.model || server.config.default_model || 'fixture/kiki-pro';
  const catalog = server.models.length > 0 || server.modelsDeclared ? server.models : [
    { id: 'fixture/kiki-pro', max_context_size: 262_144 },
    { id: 'fixture/kiki-lite', max_context_size: 131_072 },
  ];
  return { id, entry: catalog.find((item) => item.id === id), profile: agent?.profile ?? session.record.agent_config?.profile ?? 'agent' };
}

function resolve(server, session, agentId, { ignoreSession = false } = {}) {
  const seed = server.scenario?.data.autoCompact ?? {};
  const { id: modelId, entry, profile: profileName } = modelFor(server, session, agentId);
  const loop = loopControl(server);
  const window = seed.windows?.[modelId] ?? {};
  const usable = window.usable ?? entry?.max_input_size ?? entry?.max_context_size ?? 262_144;
  const reserved = window.reserved ?? loop.reserved ?? DEFAULT_RESERVED;
  const ceil = Math.max(0, usable - reserved);
  const floor = Math.min(ceil, 64_000);
  const clamp = (tokens) => Math.max(floor, Math.min(tokens, ceil));
  const overrides = server.autoCompactOverrides.get(`${session.record.id}:${agentId}`) ?? {};
  const profile = server.agentProfiles.find((item) => item.name === profileName);
  const status = (tokens, source) => ({ tokens, source, effectiveMaxContextTokens: usable, reservedContextTokens: reserved });
  if (!ignoreSession && overrides[modelId] !== undefined) return status(clamp(overrides[modelId]), 'session');
  const modelProfile = profile?.model_profiles?.find((item) => item.alias === modelId)?.auto_compact;
  if (modelProfile !== undefined) return status(clamp(modelProfile), 'profile');
  if (profile?.auto_compact !== undefined) return status(clamp(profile.auto_compact), 'profile');
  if (entry?.auto_compact !== undefined) return status(clamp(entry.auto_compact), 'model');
  if (typeof loop.autoCompact === 'string') {
    return status(clamp(Math.round((usable * Number(loop.autoCompact.replace('%', ''))) / 100)), 'global');
  }
  const legacy = Math.min(usable * (loop.ratio ?? 0.85), reserved > 0 && reserved < usable ? usable - reserved : Infinity);
  return status(legacy, 'legacy');
}

/** Same rounding as agent-core's globalPercentFromTokens. */
function percentOf(tokens, usable) {
  const percent = Math.min(100, Math.max(0.00000001, Math.round(tokens / usable * 10_000_000_000) / 100_000_000));
  return `${percent.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

function publishStatus(server, session, agentId) {
  const current = resolve(server, session, agentId);
  server.emit(session.record.id, {
    type: 'agent.status.updated',
    agentId,
    payload: {
      autoCompactTokens: current.tokens,
      autoCompactSource: current.source,
      effectiveMaxContextTokens: current.effectiveMaxContextTokens,
      reservedContextTokens: current.reservedContextTokens,
    },
  });
}

/**
 * Handles `/agents/{agentId}/auto-compact` under a session. Returns true when
 * the request was answered.
 */
export function handleAutoCompact(server, res, session, tail, body, method) {
  const match = /^\/agents\/([^/]+)\/auto-compact$/.exec(tail);
  if (match === null) return false;
  const agentId = decodeURIComponent(match[1]);
  const seed = server.scenario?.data.autoCompact ?? {};
  if ((seed.disabled ?? []).includes(session.record.id)) {
    server.envelope(res, null, 40404, 'route not found');
    return true;
  }
  const key = `${session.record.id}:${agentId}`;
  if (!server.autoCompactOverrides.has(key)) {
    server.autoCompactOverrides.set(key, { ...(seed.overrides?.[session.record.id]?.[agentId] ?? {}) });
  }
  if (method !== 'PATCH') {
    server.envelope(res, resolve(server, session, agentId));
    return true;
  }
  const input = body ?? {};
  const tokens = input.tokens;
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0)) {
    server.envelope(res, null, 40001, 'tokens must be a positive integer or null');
    return true;
  }
  if (input.save !== undefined && tokens === null) {
    server.envelope(res, null, 40001, 'saving a default requires an absolute positive token count');
    return true;
  }
  const { id: modelId, profile: profileName } = modelFor(server, session, agentId);
  let savedAs;
  if (input.save === 'model') {
    const index = server.models.findIndex((item) => item.id === modelId);
    if (index === -1) {
      server.envelope(res, null, 40413, `Model ${modelId} not found`);
      return true;
    }
    server.models[index] = { ...server.models[index], auto_compact: tokens };
    server.modelsDeclared = true;
    savedAs = tokens;
  } else if (input.save === 'profile') {
    const profile = server.agentProfiles.find((item) => item.name === profileName);
    if (profile === undefined || !['user', 'workspace', 'extra'].includes(profile.source)) {
      server.envelope(res, null, 40934, 'The active profile is not an editable file-backed profile');
      return true;
    }
    profile.auto_compact = tokens;
    savedAs = tokens;
  } else if (input.save === 'global') {
    const usable = resolve(server, session, agentId).effectiveMaxContextTokens;
    const loop = { ...(server.config.loop_control ?? {}) };
    for (const legacy of ['compactionTriggerRatio', 'compaction_trigger_ratio', 'compactionSoftContextSize', 'compaction_soft_context_size', 'auto_compact']) {
      delete loop[legacy];
    }
    savedAs = percentOf(tokens, usable);
    server.config.loop_control = { ...loop, autoCompact: savedAs };
  }
  const overrides = server.autoCompactOverrides.get(key);
  if (tokens === null) delete overrides[modelId];
  else overrides[modelId] = tokens;
  const defaults = resolve(server, session, agentId, { ignoreSession: true });
  const before = resolve(server, session, agentId);
  const overrideCleared = input.save !== undefined && before.source === 'session' && before.tokens === defaults.tokens;
  if (overrideCleared) delete overrides[modelId];
  publishStatus(server, session, agentId);
  server.envelope(res, {
    effective: resolve(server, session, agentId),
    default: defaults,
    overrideCleared,
    ...(savedAs === undefined ? {} : { savedAs }),
  });
  return true;
}
