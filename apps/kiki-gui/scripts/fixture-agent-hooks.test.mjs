/**
 * Unit coverage for the agent-hooks fixture route.
 *
 * The route exists only to stop the agent panel rendering "Could not read
 * injected rules" in public captures, so its whole value is that a seeded rule
 * survives the trip out verbatim. These cases seed deliberately non-default
 * values so that regression cannot hide behind a fallback.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tsImport } from 'tsx/esm/api';

import { handleAgentHooks } from './fixture-agent-hooks.mjs';

const { agentHooksInspectSchema } = await tsImport(
  '../../../packages/protocol/src/rest/agentHooks.ts',
  import.meta.url,
);

/** Calls the handler directly and returns the payload it would have written. */
function inspect(agentId, seed) {
  let payload;
  const server = {
    scenario: { data: { agentHooks: seed } },
    envelope: (_res, data) => { payload = data; },
  };
  const answered = handleAgentHooks(server, {}, { transcript: { snapshot: () => undefined } }, `/agents/${agentId}/hooks`);
  assert.equal(answered, true, 'the handler must claim the route');
  return payload;
}

test('a seeded rule is returned verbatim and satisfies the inspect schema', () => {
  const payload = inspect('main', {
    revision: 'hooks-seeded',
    rules: [{
      id: 'hook-verify-identity',
      path: 'hooks/review-notes.toml',
      namespace: 'session',
      event: 'step.before',
      action: { type: 'observe' },
      reason: 'hold the line while a review is open',
      order: 7,
    }],
  });

  assert.deepEqual(payload.rules, [{
    id: 'hook-verify-identity',
    path: 'hooks/review-notes.toml',
    namespace: 'session',
    event: 'step.before',
    action: { type: 'observe' },
    active: true,
    reason: 'hold the line while a review is open',
    completedSteps: 0,
    order: 7,
    resetPending: false,
  }]);

  // The real schema, not a lookalike: `order` must be an integer, and a raw
  // array would have been rejected here rather than shipped in a capture.
  const parsed = agentHooksInspectSchema.safeParse(payload);
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
});

test('a rule keeps its own position when the seed does not name one', () => {
  const payload = inspect('main', {
    rules: [
      { id: 'hook-first' },
      { id: 'hook-second' },
      { id: 'hook-third' },
    ],
  });

  assert.deepEqual(payload.rules.map((rule) => rule.order), [0, 1, 2]);
  assert.deepEqual(payload.rules.map((rule) => rule.id), ['hook-first', 'hook-second', 'hook-third']);
});

test('an agent with no seeded rules answers the honest resting state', () => {
  const payload = inspect('main', {});
  assert.deepEqual(payload.rules, []);
  assert.deepEqual(payload.sources, []);
  assert.deepEqual(payload.diagnostics, []);
  assert.equal(payload.binding.agentRole, 'root');
  assert.equal(agentHooksInspectSchema.safeParse(payload).success, true);
});

test('the route ignores a tail that is not an agent hooks path', () => {
  const answered = handleAgentHooks({ scenario: { data: {} }, envelope: () => assert.fail('must not answer') }, {}, {}, '/agents/main/compact');
  assert.equal(answered, false);
});
