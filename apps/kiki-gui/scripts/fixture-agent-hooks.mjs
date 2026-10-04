/**
 * Fixture stand-in for `GET /sessions/{id}/agents/{agent}/hooks`
 * (kap-server's agent-hooks inspect route).
 *
 * Why it exists: the agent panel's "Injected rules" block calls this on every
 * session. Without the route the request 404s and the panel renders its
 * failure state — "Could not read injected rules" with a Retry button — in
 * every fixture capture, including the public ones. An error state is a true
 * rendering of an unreachable endpoint, but it is not a picture of the product
 * a reader is meant to believe in, so the route answers with the honest
 * resting state instead.
 *
 * The payload is exactly `agentHooksInspectSchema`
 * (`packages/protocol/src/rest/agentHooks.ts`): a revision, the binding it was
 * read for, the rule files it looked at, diagnostics, and the rules.
 *
 * Scenario seeds (all optional):
 *   agentHooks: {
 *     revision:   'hooks-1',
 *     sources:    [{ namespace, path, status }],
 *     diagnostics:[{ path, hookId, message }],
 *     rules:      [{ id, path, namespace, event, action, active, … }]
 *   }
 * An absent seed is a valid answer: the agent has no injected rules, which is
 * what `rules: []` means and what the panel says in that case.
 */

const EVENTS = new Set([
  'prompt.submit', 'step.before', 'step.after', 'turn.after',
  'session.start', 'turn.stopping', 'tool.before', 'tool.after',
]);

/** The binding is the agent the call was made for, not a seeded value. */
function bindingOf(server, session, agentId) {
  return {
    executorId: 'native',
    modelId: session?.transcript?.snapshot?.('main')?.meta?.agent?.model,
    agentRole: agentId === undefined || agentId === 'main' ? 'root' : 'subagent',
  };
}

function ruleOf(seed, index) {
  const event = EVENTS.has(seed.event) ? seed.event : 'prompt.submit';
  const type = seed.action?.type === 'observe' ? 'observe' : 'inject';
  return {
    id: seed.id ?? `hook-${index + 1}`,
    path: seed.path ?? 'hooks/team-guidance.toml',
    namespace: seed.namespace ?? 'project',
    event,
    action: { type },
    active: seed.active !== false,
    ...(seed.reason === undefined ? {} : { reason: seed.reason }),
    completedSteps: Number.isInteger(seed.completedSteps) ? seed.completedSteps : 0,
    ...(seed.nextDue === undefined ? {} : { nextDue: seed.nextDue }),
    ...(seed.semanticRevision === undefined ? {} : { semanticRevision: seed.semanticRevision }),
    order: Number.isInteger(seed.order) ? seed.order : index,
    resetPending: seed.resetPending === true,
  };
}

/**
 * Handles the route. The session handler hands over the whole tail
 * (`/agents/<agentId>/hooks`), because that is what the path parser keeps —
 * session ids never contain '/', so the agent segment lives inside the tail.
 * Returns true when it answered, so the caller can stop looking.
 */
const AGENT_HOOKS_TAIL = /^\/agents\/([^/]+)\/hooks$/;

export function handleAgentHooks(server, res, session, tail) {
  const match = AGENT_HOOKS_TAIL.exec(tail);
  if (match === null) return false;
  const agentId = decodeURIComponent(match[1]);
  const seed = server.scenario?.data.agentHooks ?? {};
  const rules = (seed.rules ?? []).map((rule, index) => ruleOf(rule, index));
  server.envelope(res, {
    revision: seed.revision ?? 'hooks-rev-1',
    binding: bindingOf(server, session, agentId),
    sources: (seed.sources ?? []).map((source) => ({
      namespace: source.namespace ?? 'project',
      path: source.path ?? 'hooks/team-guidance.toml',
      status: source.status ?? 'loaded',
    })),
    diagnostics: (seed.diagnostics ?? []).map((entry) => ({
      path: entry.path ?? 'hooks/team-guidance.toml',
      ...(entry.hookId === undefined ? {} : { hookId: entry.hookId }),
      message: entry.message ?? '',
    })),
    rules,
  });
  return true;
}
