import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { WebSocket } from 'ws';
import { startFixtureServer, FIXTURE_TOKEN } from './fixture-server.mjs';

const { createKlient } = await tsImport('../../../packages/klient/src/transports/http/index.ts', import.meta.url);
const headers = { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json' };
const SID = 'session_fixture_first_open';

async function waitFor(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for protocol condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('fixture serves the real Klient ordered view and preserves checkpoints through reconnect', async () => {
  const fixture = await startFixtureServer({ port: 0, scenario: 'first-open' });
  const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
  const client = createKlient({ endpoint, token: FIXTURE_TOKEN, WebSocket });
  try {
    const snapshot = await client.session(SID).view.snapshot();
    assert.equal(snapshot.session.id, SID);
    const page = await client.session(SID).view.transcript.page({ agentId: 'main' });
    assert.ok(JSON.stringify(page.items).includes('先通读最近的任务记录'));
    assert.ok(JSON.stringify(page.items).includes('ReadMediaFile'));
    assert.equal(page.cursor.epoch, fixture.sessions.get(SID).transcript.epoch);
    const signals = [];
    const subscription = client.session(SID).view.subscribe({ sessionCursor: { seq: snapshot.as_of_seq, epoch: snapshot.epoch }, transcriptGrades: { main: 'delta' } }, (signal) => signals.push(signal));
    await waitFor(() => signals.some((signal) => signal.type === 'ready'));
    const initial = signals.find((signal) => signal.type === 'transcript');
    assert.equal(initial.event.type, 'transcript.reset');
    subscription.updateTranscriptCursor('main', initial.event.cursor);
    const catalog = [];
    const listener = client.events.on('kosong.changed', (data) => catalog.push(data));
    await listener.ready;
    fixture.emit(SID, { type: 'event.model_catalog.changed', payload: { changed: [{ provider_id: 'fixture', provider_name: 'Fixture', added: 1, removed: 0 }], unchanged: [], failed: [] } });
    await waitFor(() => catalog.length > 0);
    const firstGeneration = signals.find((signal) => signal.type === 'ready').generation;
    for (const socket of fixture.sockets) socket.terminate();
    const session = fixture.sessions.get(SID);
    const batch = session.transcript.commit('main', [{ op: 'meta.merge', meta: { agent: { model: 'fixture/reconnected' } } }]);
    await waitFor(() => signals.some((signal) => signal.type === 'ready' && signal.generation > firstGeneration));
    assert.ok(signals.some((signal) => signal.type === 'transcript' && signal.event.type === 'transcript.ops' && signal.event.cursor.seq === batch.seq), JSON.stringify(signals.map((signal) => ({ ...signal, event: signal.event === undefined ? undefined : { type: signal.event.type, cursor: signal.event.cursor } }))));
    assert.equal(signals.filter((signal) => signal.type === 'transcript' && signal.event.type === 'transcript.reset').length, 1);
    const catchup = await client.session(SID).view.transcript.catchUp({ agentId: 'main', since: initial.event.cursor });
    assert.equal(catchup.complete, true);
    assert.equal(catchup.through_seq, batch.seq);
    const wrongEpoch = await client.session(SID).view.transcript.catchUp({ agentId: 'main', since: { ...initial.event.cursor, epoch: 'wrong' } });
    assert.equal(wrongEpoch.complete, false);
    assert.equal(catchup.batches[0].ops[0].meta.agent.model, 'fixture/reconnected');
    const future = await client.session(SID).view.transcript.catchUp({ agentId: 'main', since: { epoch: initial.event.cursor.epoch, seq: batch.seq + 1 } });
    assert.equal(future.complete, false);
    session.transcript.skipSeq('main', 1);
    session.transcript.commit('main', [{ op: 'meta.merge', meta: { agent: { model: 'fixture/after-gap' } } }]);
    const gap = await client.session(SID).view.transcript.catchUp({ agentId: 'main', since: { epoch: initial.event.cursor.epoch, seq: batch.seq } });
    assert.equal(gap.complete, false);
    assert.deepEqual(gap.batches, []);
    await fetch(`${endpoint}/__control`, { method: 'POST', headers, body: JSON.stringify({ action: 'resync', session_id: SID }) });
    await waitFor(() => signals.some((signal) => signal.type === 'resyncRequired' && signal.reason === 'epoch_changed'));
    subscription.setTranscriptGrades({ main: 'delta' });
    await waitFor(() => signals.filter((signal) => signal.type === 'transcript' && signal.event.type === 'transcript.reset').length === 2);
    assert.equal(signals.filter((signal) => signal.type === 'transcript').at(-1).event.cursor.epoch, session.epoch);
    listener.dispose();
    subscription.close();
  } finally { await client.close(); await fixture.stop(); }
});

test('fixture serves the GUI global facades through typed contracts and shared fixture state', async () => {
  const fixture = await startFixtureServer({ port: 0, scenario: 'settings' });
  const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
  const client = createKlient({ endpoint, token: FIXTURE_TOKEN, WebSocket });
  try {
    const models = await client.global.kosong.listModels();
    assert.ok(models.some((model) => model.model === 'fixture/kiki-pro'));
    const providers = await client.global.kosong.listProviders();
    assert.ok(providers.some((provider) => provider.id === 'fixture'));
    const rawProfiles = await fetch(`${endpoint}/api/agents?workspace_id=wd_fixture_000000000000`, { headers }).then((response) => response.json());
    const rawReviewer = rawProfiles.data.items.find((profile) => profile.name === 'reviewer');
    assert.deepEqual(rawReviewer.workspace_ids, [
      'wd_fixture_000000000000',
      'wd_fixture_000000000001',
      'wd_fixture_000000000002',
    ]);
    const effectiveProfiles = await fetch(`${endpoint}/api/agents?workspace_id=wd_fixture_000000000000&effective=true`, { headers }).then((response) => response.json());
    assert.deepEqual(effectiveProfiles.data.items.map((profile) => profile.name), ['agent', 'explore', 'scout', 'reviewer', 'frontend']);
    assert.equal(effectiveProfiles.data.items.find((profile) => profile.name === 'explore').source, 'user');
    assert.equal(effectiveProfiles.data.items.find((profile) => profile.name === 'scout').source, 'builtin');
    const flow = await client.global.auth.flow('fixture');
    assert.equal(flow?.status, 'pending');
    const servers = await client.global.mcp.list({ cwd: 'C:/fixture' });
    assert.ok(servers.some((server) => server.name === 'fixture-mcp'));
    const added = await client.global.mcp.add({
      server: { name: 'fixture-temp', transport: 'stdio', command: 'node' },
      cwd: 'C:/fixture',
    });
    assert.ok(added.some((server) => server.name === 'fixture-temp'));
    const removed = await client.global.mcp.remove({ name: 'fixture-temp', cwd: 'C:/fixture' });
    assert.ok(!removed.some((server) => server.name === 'fixture-temp'));
    const file = await client.global.files.save({ data: new Uint8Array([1, 2, 3]), filename: 'fixture.bin' });
    assert.equal(file.size, 3);
    assert.equal(fixture.lastFileUpload.id, file.id);
    await assert.rejects(
      client.global.mcp.remove({ name: 'fixture-plugin-mcp', cwd: 'C:/fixture' }),
      /read-only/,
    );
  } finally { await client.close(); await fixture.stop(); }
});

test('shared terminal uses the existing FakeTerminal for replay, input, resize, exit and session isolation', async () => {
  const fixture = await startFixtureServer({ port: 0, scenario: 'terminal' });
  const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
  const client = createKlient({ endpoint, token: FIXTURE_TOKEN, WebSocket });
  const sid = [...fixture.sessions.keys()][0];
  try {
    const created = await client.terminal.createTerminal(sid);
    const terminalId = created.id ?? created.terminal?.id;
    assert.ok(terminalId, JSON.stringify(created));
    const terminal = fixture.sessions.get(sid).terminals.get(terminalId);
    const signals = [];
    client.terminal.onTerminalSignal((signal) => signals.push(signal));
    let status;
    client.terminal.onStatus((value) => { status = value; });
    await waitFor(() => status === 'open');
    const attached = await client.terminal.terminalAttach(sid, terminalId);
    assert.equal(attached.replayed, 1);
    assert.ok(signals.some((signal) => signal.kind === 'output' && signal.data === '$ '));
    client.terminal.terminalInput(sid, terminalId, 'echo shared-fixture\r');
    await waitFor(() => signals.some((signal) => signal.kind === 'output' && signal.data.includes('shared-fixture\r\n')));
    client.terminal.terminalResize(sid, terminalId, 101, 31);
    await waitFor(() => terminal.record.cols === 101 && terminal.record.rows === 31);
    for (const socket of fixture.sockets) socket.terminate();
    terminal.emitBuffered('offline-fixture\r\n');
    await waitFor(() => signals.filter((signal) => signal.kind === 'attached').length === 2);
    assert.equal(signals.filter((signal) => signal.kind === 'output' && signal.data === 'offline-fixture\r\n').length, 1);
    assert.equal(terminal.attachments.size, 1);
    await assert.rejects(client.terminal.terminalAttach('not-this-session', terminalId), /session.not_found/);
    client.terminal.terminalDetach('not-this-session', terminalId);
    client.terminal.terminalInput(sid, terminalId, 'exit 7\r');
    await waitFor(() => signals.some((signal) => signal.kind === 'exit' && signal.exitCode === 7));
    assert.equal(terminal.attachments.size, 0);
    console.log('[fixture-terminal-chain]', fixture.wsInbound.filter((frame) => frame.type.startsWith('terminal_')).map((frame) => ({ type: frame.type, data: frame.data })));
  } finally { await client.close(); await fixture.stop(); }
});

test('child turn-to-delta grade upgrade reseeds detail even at the same transcript cursor', async () => {
  const fixture = await startFixtureServer({ port: 0, scenario: 'subagents' });
  const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
  const client = createKlient({ endpoint, token: FIXTURE_TOKEN, WebSocket });
  const sid = [...fixture.sessions.keys()][0];
  try {
    const snapshot = await client.session(sid).view.snapshot();
    const signals = [];
    const subscription = client.session(sid).view.subscribe({ sessionCursor: { seq: snapshot.as_of_seq, epoch: snapshot.epoch }, transcriptGrades: { '*': 'turn', main: 'delta' } }, (signal) => signals.push(signal));
    await waitFor(() => signals.some((signal) => signal.type === 'ready'));
    const childResets = () => signals.filter((signal) => signal.type === 'transcript' && signal.event.type === 'transcript.reset' && signal.event.agent_id === 'agent-review');
    const first = childResets()[0].event;
    assert.equal(first.grade, 'turn');
    assert.ok(!JSON.stringify(first.snapshot).includes('Presentation contract verified'));
    subscription.updateTranscriptCursor('agent-review', first.cursor);
    subscription.setTranscriptGrades({ '*': 'turn', main: 'delta', 'agent-review': 'delta' });
    await waitFor(() => childResets().length === 2);
    const detailed = childResets()[1].event;
    assert.deepEqual(detailed.cursor, first.cursor);
    assert.equal(detailed.grade, 'delta');
    assert.ok(JSON.stringify(detailed.snapshot).includes('Presentation contract verified'));
    console.log('[fixture-child-grade-chain]', { agent: detailed.agent_id, before: first.grade, after: detailed.grade, cursor: detailed.cursor });
    subscription.close();
  } finally { await client.close(); await fixture.stop(); }
});

test('child approval seed validates and resolved wire facts retain origin, request and tool identity', async () => {
  const fixture = await startFixtureServer({ port: 0, scenario: 'subagent-approval' });
  const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
  const client = createKlient({ endpoint, token: FIXTURE_TOKEN, WebSocket });
  const sid = [...fixture.sessions.keys()][0];
  try {
    const snapshot = await client.session(sid).view.snapshot();
    const signals = [];
    const subscription = client.session(sid).view.subscribe({ sessionCursor: { seq: snapshot.as_of_seq, epoch: snapshot.epoch }, transcriptGrades: { '*': 'delta' } }, (signal) => signals.push(signal));
    await waitFor(() => signals.some((signal) => signal.type === 'ready'));
    assert.ok(!signals.some((signal) => signal.type === 'protocolError'));
    const post = (path, body) => fetch(`${endpoint}/api/sessions/${sid}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }).then((response) => response.json());
    const result = await post('/prompts', { content: [{ type: 'text', text: 'Clean the build output.' }] });
    assert.equal(result.code, 0, result.msg);
    const pending = () => signals.flatMap((signal) => signal.type === 'transcript' && signal.event.type === 'transcript.ops' ? signal.event.ops : []).filter((op) => op.op === 'interaction.upsert' && op.interaction.state === 'pending');
    await waitFor(() => pending().length >= 2);
    const approved = await post('/approvals/approval_fixture_child', { decision: 'approved', scope: 'once' });
    assert.equal(approved.code, 0, approved.msg);
    const resolved = () => signals.flatMap((signal) => signal.type === 'transcript' && signal.event.type === 'transcript.ops' ? [{ agentId: signal.event.agent_id, ops: signal.event.ops }] : []).flatMap(({ agentId, ops }) => ops.filter((op) => op.op === 'interaction.upsert' && op.interaction.state === 'approved').map((op) => ({ agentId, interaction: op.interaction })));
    await waitFor(() => resolved().length >= 2);
    assert.deepEqual(new Set(resolved().map((entry) => entry.agentId)), new Set(['main', 'agent-worker']));
    for (const { interaction } of resolved()) {
      assert.equal(interaction.origin.agentId, 'agent-worker');
      assert.equal(interaction.toolCallId, 'child-rm');
      assert.equal(interaction.request.action, 'Run: rm -rf build');
    }
    console.log('[fixture-child-approval-chain]', JSON.stringify(resolved()));
    subscription.close();
  } finally { await client.close(); await fixture.stop(); }
});

test('fixture fails closed for missing auth, unsupported methods and invalid ordered view input', async () => {
  const fixture = await startFixtureServer({ port: 0, scenario: 'basic-stream' });
  const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
  try {
    const call = (body, auth = headers) => fetch(`${endpoint}/api/klient/call`, { method: 'POST', headers: auth, body: JSON.stringify(body) }).then((response) => response.json());
    assert.equal((await call({}, { 'content-type': 'application/json' })).code, 40101);
    assert.equal((await call({})).code, 40001);
    assert.notEqual((await call({ procedure: { scope: 'core', service: 'unknown', method: 'read' }, params: [] })).code, 0);
    assert.equal((await call({ procedure: { scope: 'core', service: 'agentPanelService', method: 'read' }, params: [{}] })).code, 40001);
    const sid = [...fixture.sessions.keys()][0];
    const response = await fetch(`${endpoint}/api/klient/session-view/${sid}/transcript?agent_id=main&page_size=101`, { headers }).then((result) => result.json());
    assert.equal(response.code, 40001);
    const socket = new WebSocket(endpoint.replace('http:', 'ws:') + '/api/klient/events', [`kimi-code.bearer.${FIXTURE_TOKEN}`]);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const received = new Promise((resolve) => socket.once('message', (raw) => resolve(JSON.parse(String(raw)))));
    socket.send(JSON.stringify({ type: 'view_attach', id: 'invalid', sessionId: sid, data: { generation: 1, input: {} } }));
    assert.equal((await received).type, 'view_error');
    socket.terminate();
  } finally { await fixture.stop(); }
});
