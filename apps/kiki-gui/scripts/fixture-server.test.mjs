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
