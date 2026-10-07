import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startFixtureServer } from './fixture-server.mjs';

test('fixture preflight permits the client request correlation header', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'hero-shell' });
  try {
    const response = await fetch(`http://127.0.0.1:${server.http.address().port}/api/meta`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:54321',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,x-request-id',
      },
    });
    assert.equal(response.status, 204);
    assert.ok(response.headers.get('access-control-allow-headers')?.toLowerCase().split(',').map((value) => value.trim()).includes('x-request-id'));
  } finally {
    await server.stop();
  }
});

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

test('archive fixture requires the explicit family body and retains partial outcomes', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'thread-relations' });
  const root = 'session_fixture_release';
  const child = 'session_fixture_docs_thread';
  const other = 'session_fixture_changelog_thread';
  const request = async (path, body) => (await fetch(`http://127.0.0.1:${server.http.address().port}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer kiki-fixture-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).json();
  try {
    const single = await request(`/api/sessions/${root}:archive`, {});
    assert.deepEqual(single.data.outcomes, [{ id: root, ok: true }]);
    assert.notEqual(server.sessions.get(child).record.archived, true);
    await request('/__control', { action: 'archive_partial_fail_next', session_id: child });
    const partial = await request(`/api/sessions/${root}:archive`, { include_attached: true, exclude_session_ids: [] });
    assert.equal(partial.code, 0);
    assert.equal(partial.data.archived, false);
    assert.deepEqual(partial.data.outcomes.map(({ id, ok }) => ({ id, ok })), [
      { id: root, ok: true }, { id: child, ok: false }, { id: other, ok: true },
    ]);
    assert.equal(server.sessions.get(root).record.archived, true);
    assert.notEqual(server.sessions.get(child).record.archived, true);
    assert.equal(server.sessions.get(other).record.archived, true);
  } finally { await server.stop(); }
});

test('archive fixture deletes one archived family, holds back the excluded, and clears the rest on request', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'archived-conversations' });
  const origin = `http://127.0.0.1:${server.http.address().port}`;
  const root = 'session_fixture_arch_root';
  const attached = 'session_fixture_arch_attached';
  const secondChild = 'session_fixture_arch_second_child';
  const promoted = 'session_fixture_arch_promoted';
  const live = 'session_fixture_arch_live';
  const liveChild = 'session_fixture_arch_live_child';
  const releases = 'session_fixture_arch_releases';
  const late = 'session_fixture_arch_late';
  const stuck = 'session_fixture_arch_stuck';
  const headers = { authorization: 'Bearer kiki-fixture-token', 'content-type': 'application/json' };
  const post = async (path, body) => (await fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })).json();
  const get = async (path) => (await fetch(`${origin}${path}`, { headers })).json();
  try {
    // The archive page's read: only archived rows, and `q` is the server's.
    const listed = await get('/api/sessions?archived_only=true&page_size=50');
    const ids = listed.data.items.map((session) => session.id);
    assert.ok(ids.includes(root) && ids.includes(promoted) && ids.includes(releases));
    assert.ok(!ids.includes(live) && !ids.includes(liveChild));
    // The needle is title + cwd + workspace_id, never the workspace name.
    const byTitle = await get(`/api/sessions?archived_only=true&q=${encodeURIComponent('Release notes')}`);
    assert.deepEqual(byTitle.data.items.map((session) => session.id), [releases]);
    const byCwd = await get('/api/sessions?archived_only=true&q=fixture/releases');
    assert.ok(byCwd.data.items.some((session) => session.id === late),
      'a cwd match is a match, like the real route');
    const byWorkspaceId = await get('/api/sessions?archived_only=true&q=archive_review');
    assert.ok(byWorkspaceId.data.items.length > 0, 'a workspace id match is a match');
    const byWorkspaceName = await get('/api/sessions?archived_only=true&q=review%20desk');
    assert.deepEqual(byWorkspaceName.data.items, [], 'the workspace name is not searched');

    // A single delete takes the archived family with it and holds back the row
    // the caller excluded.
    const one = await post(`/api/sessions/${root}:delete-archived`, { exclude_session_ids: [promoted] });
    assert.equal(one.code, 0);
    assert.deepEqual(one.data.deleted_ids, [root, attached, secondChild]);
    assert.deepEqual(one.data.failed, []);
    assert.equal(server.sessions.has(root), false);
    assert.equal(server.sessions.has(attached), false);
    assert.equal(server.sessions.has(secondChild), false);
    assert.equal(server.sessions.get(promoted).record.archived, true);
    assert.notEqual(server.sessions.get(live).record.archived, true);

    // A refused member is reported, not silently dropped.
    await post('/__control', { action: 'delete_archived_fail_next', session_id: releases });
    const partial = await post(`/api/sessions/${releases}:delete-archived`, {});
    assert.equal(partial.code, 0);
    assert.deepEqual(partial.data.deleted_ids, []);
    assert.equal(partial.data.failed.length, 1);
    assert.equal(partial.data.failed[0].id, releases);
    assert.equal(server.sessions.has(releases), true);

    // Clearing the archive reaches every archived conversation on the
    // connection and never an unarchived one.
    await post('/__control', { action: 'delete_all_archived_fail_next', session_id: stuck });
    const all = await post('/api/sessions:delete-archived', {});
    assert.equal(all.code, 0);
    assert.ok(!all.data.deleted_ids.includes(stuck));
    assert.ok(!all.data.deleted_ids.includes(live) && !all.data.deleted_ids.includes(liveChild));
    assert.deepEqual(all.data.failed.map((entry) => entry.id), [stuck]);

    // Several refusals at once: each is reported, not folded into one count.
    const partialFamily = await startFixtureServer({ port: 0, scenario: 'archived-conversations' });
    try {
      const partialOrigin = `http://127.0.0.1:${partialFamily.http.address().port}`;
      const partialPost = async (route, body) => (await fetch(`${partialOrigin}${route}`, {
        method: 'POST', headers: { authorization: 'Bearer kiki-fixture-token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })).json();
      await partialPost('/__control', { action: 'delete_archived_fail_list', session_ids: [attached, secondChild] });
      const many = await partialPost(`/api/sessions/${root}:delete-archived`, {});
      assert.deepEqual(many.data.deleted_ids, [root]);
      assert.deepEqual(many.data.failed.map((entry) => entry.id).sort(), [attached, secondChild].sort());
      assert.ok(many.data.failed.every((entry) => entry.message !== ''), 'every refusal carries a reason');
      assert.ok(many.data.failed.every((entry) => entry.title !== ''), 'every refusal carries a name');
    } finally { await partialFamily.stop(); }

    const left = await get('/api/sessions?include_archive=true&page_size=100');
    assert.deepEqual(left.data.items.map((session) => session.id).sort(), [live, liveChild, stuck].sort());
  } finally { await server.stop(); }
});
