import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startFixtureServer } from './fixture-server.mjs';

const WORKSPACE = 'wd_fixture_000000000000';
const CARD = 'board_tools_flaky';

const boardRead = (server) => server.klient.callGlobal(
  { scope: 'core', service: 'taskBoardService', method: 'read' },
  [{ action: 'list', workspaceId: WORKSPACE }],
);
const statusOf = (server) => boardRead(server).value.cards.find((card) => card.id === CARD)?.status;

/**
 * Scenario modules are imported once per process and cached, so the proof's
 * per-job fixture servers all resolve to the same module object. A walk that
 * writes through a route must only change its own server: otherwise the board
 * card a later job asserts on (`workspace-tools[locale=zh]` looking for
 * `board_tools_flaky` still in progress) has already been moved by the job that
 * ran first.
 */
test('each fixture server owns its scenario data', async () => {
  const scenarioModule = await import('../fixtures/workspace-tools.scenario.mjs');
  const moduleStatus = () => scenarioModule.default.taskBoard.cards.find((card) => card.id === CARD)?.status;
  const first = await startFixtureServer({ port: 0, scenario: 'workspace-tools' });
  const second = await startFixtureServer({ port: 0, scenario: 'workspace-tools' });
  try {
    assert.equal(statusOf(first), 'in_progress');
    assert.equal(statusOf(second), 'in_progress');
    const written = first.klient.callGlobal(
      { scope: 'core', service: 'taskBoardService', method: 'write' },
      [{ action: 'update', id: CARD, workspaceId: WORKSPACE, expectedRevision: 2, patch: { status: 'done' } }],
    );
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal(statusOf(first), 'done');
    assert.equal(statusOf(second), 'in_progress', 'a second server sees the first server’s write');
    assert.equal(moduleStatus(), 'in_progress', 'the imported scenario module was mutated in place');
  } finally {
    await first.stop();
    await second.stop();
  }
});

test('automatic workspace fixture previews globals without leaking project profiles or workspace identities', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'auto-workspace-profiles' });
  try {
    const response = await fetch(`http://127.0.0.1:${server.http.address().port}/api/agents?unscoped=true`, {
      headers: { authorization: 'Bearer kiki-fixture-token' },
    });
    const body = await response.json();
    assert.equal(body.code, 0);
    assert.equal(body.data.complete, true);
    assert.deepEqual(body.data.items.map((item) => item.name), ['agent', 'auto-lead']);
    assert.ok(body.data.items.every((item) => item.workspace_id === undefined && item.workspace_ids === undefined));
    assert.deepEqual(server.workspaces, []);
  } finally {
    await server.stop();
  }
});


async function memoryRequest(server, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${server.http.address().port}/api/memory/${path}`, {
    method, headers: { authorization: 'Bearer kiki-fixture-token', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}

test('memory provenance fixture exposes a real pending create and preserves its metadata through acceptance and Undo', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'memory-provenance' });
  try {
    const inbox = await memoryRequest(server, 'GET', 'global/inbox');
    assert.equal(inbox.code, 0);
    const candidate = inbox.data.find((entry) => entry.id === 'm_20261005_999999');
    assert.ok(candidate);
    assert.equal(candidate.pending_action, undefined);
    assert.equal(candidate.supersedes, undefined);
    assert.equal(candidate.basis.kind, 'derived');
    const kept = await memoryRequest(server, 'PUT', `global/${candidate.id}`, { action: 'update', type: candidate.type, title: candidate.title, body: candidate.body, reason: 'Accept the reviewed proposal.', expected_revision: candidate.revision, basis: candidate.basis, validity: candidate.validity });
    assert.equal(kept.code, 0);
    assert.equal(kept.data.outcome, 'applied');
    assert.equal(kept.data.entry.status, 'active');
    assert.deepEqual(kept.data.entry.basis, candidate.basis);
    const undone = await memoryRequest(server, 'POST', 'global/undo', { operation_id: kept.data.operationId });
    assert.equal(undone.code, 0);
    const restored = await memoryRequest(server, 'GET', `global/${candidate.id}`);
    assert.equal(restored.data.status, 'pending');
    assert.deepEqual(restored.data.basis, candidate.basis);
    const withdrawn = await memoryRequest(server, 'POST', 'global/undo', { operation_id: 'op_fixture_provenance_pending' });
    assert.equal(withdrawn.code, 0);
    assert.equal((await memoryRequest(server, 'GET', `global/${candidate.id}`)).code, 40423);
  } finally { await server.stop(); }
});

test('memory provenance REST loop reads automatic metadata, undoes its real journal and refuses stale Undo after a concurrent edit', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'memory-provenance' });
  try {
    const id = 'm_20261005_111111';
    const stored = await memoryRequest(server, 'GET', `global/${id}`);
    assert.equal(stored.data.basis.kind, 'human');
    const same = await memoryRequest(server, 'PUT', `global/${id}`, { action: 'update', type: stored.data.type, title: stored.data.title, body: stored.data.body, reason: 'Confirm the stored rule.', expected_revision: stored.data.revision, basis: stored.data.basis, validity: stored.data.validity });
    assert.equal(same.data.outcome, 'unchanged');
    assert.equal(same.data.operationId, null);
    assert.equal(same.data.entry.revision, stored.data.revision);
    const undone = await memoryRequest(server, 'POST', 'global/undo', { operation_id: 'op_fixture_provenance_applied' });
    assert.equal(undone.code, 0);
    const before = (await memoryRequest(server, 'GET', `global/${id}`)).data;
    assert.equal(before.basis, undefined);
    const edited = await memoryRequest(server, 'PUT', `global/${id}`, { action: 'update', type: before.type, title: before.title, body: 'A newer rule from another window.', reason: 'Current human correction.', expected_revision: before.revision, basis: { kind: 'human', note: 'Explicit current correction.' } });
    assert.equal(edited.data.outcome, 'applied');
    const conflict = await memoryRequest(server, 'POST', 'global/undo', { operation_id: 'op_fixture_provenance_applied' });
    assert.equal(conflict.code, 40944);
    assert.equal((await memoryRequest(server, 'GET', `global/${id}`)).data.body, 'A newer rule from another window.');
  } finally { await server.stop(); }
});


test('usage export fixture exposes an empty ordinary capability without an experimental flag', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'settings-ia' });
  try {
    const base = `http://127.0.0.1:${server.http.address().port}/api`;
    const headers = { authorization: 'Bearer kiki-fixture-token' };
    const meta = await (await fetch(`${base}/meta`, { headers })).json();
    assert.equal(Object.hasOwn(meta.data.experimental_flags, 'usage_export'), false);
    assert.equal(meta.data.experimental_flags.local_session_resume, true);
    const response = await fetch(`${base}/usage-export`, { headers });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.code, 0);
    assert.deepEqual(status.data.destinations, []);
  } finally { await server.stop(); }
});
