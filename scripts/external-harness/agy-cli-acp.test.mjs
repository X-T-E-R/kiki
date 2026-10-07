import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { AgyBridge, launchArgs, promptText } from './agy-cli-acp.mjs';

const cwd = fileURLToPath(new URL('.', import.meta.url));
function bridge(model) {
  const stopProcess = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(done => child.once('close', done));
    child.stdin.end();
    await closed;
  };
  return new AgyBridge({ cliPath: process.execPath, cliPrefix: [fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url))], model, stopProcess });
}
async function session(b) { return (await b.newSession({ cwd, mcpServers: [] })).sessionId; }
function turn(b, id, text, messages) {
  return b.prompt({ sessionId: id, prompt: [{ type: 'text', text }] }, { notify: async (_method, event) => messages.push(event) });
}

test('bare launch preserves AGY model, effort, permissions and context settings', () => {
  assert.deepEqual(launchArgs({ model: 'engine-default', effort: 'engine-default', additionalDirectories: [] }),
    ['--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert.deepEqual(launchArgs({ model: 'gemini-3.8-flash-medium', effort: 'medium', additionalDirectories: [] }),
    ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'gemini-3.8-flash-medium', '--effort', 'medium']);
});

test('text-only boundary rejects rich content instead of dropping it', () => {
  assert.equal(promptText([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]), 'one\ntwo');
  assert.throws(() => promptText([{ type: 'image', data: 'x' }]), /text prompts only/);
});

test('new contexts differ, unsupported system replacement and MCP fail explicitly', async () => {
  const b = bridge();
  assert.notEqual(await session(b), await session(b));
  await assert.rejects(b.newSession({ cwd, mcpServers: [], _meta: { systemPromptOverride: 'replace' } }), /replacement is unsupported/);
  await assert.rejects(b.newSession({ cwd, mcpServers: [{ name: 'x' }] }), /MCP forwarding/);
});

test('explicit external ID reaches CLI; streamed chunks are not duplicated by result; same process keeps context', async () => {
  const b = bridge('gemini-3.8-flash-medium');
  const id = await session(b); const messages = [];
  try {
    b.setConfig({ sessionId: id, configId: 'effort', value: 'medium' });
    assert.equal((await turn(b, id, 'hello', messages)).stopReason, 'end_turn');
    const pid = b.session(id).child.pid;
    assert.equal(b.session(id).init.init.model, 'gemini-3.8-flash-medium');
    assert.equal(messages.map(m => m.update.content?.text ?? '').join(''), 'turn-1');
    messages.length = 0;
    await turn(b, id, 'again', messages);
    assert.equal(b.session(id).child.pid, pid);
    assert.equal(messages.map(m => m.update.content?.text ?? '').join(''), 'turn-2');
    assert.throws(() => b.setConfig({ sessionId: id, configId: 'effort', value: 'high' }), /frozen/);
  } finally { await b.close(); }
  assert.notEqual(b.session(id).child.exitCode, null);
});

test('permission denial is not reported as successful work', async () => {
  const b = bridge(); const id = await session(b);
  try { await assert.rejects(turn(b, id, 'deny', []), /AGY permission denied for command/); }
  finally { await b.close(); }
});

test('terminal denial settles pending tool calls before rejecting the turn', async () => {
  const b = bridge(); const id = await session(b); const messages = [];
  try {
    await assert.rejects(turn(b, id, 'deny-tool', messages), /AGY permission denied for command/);
    const updates = messages.filter(message => message.update?.sessionUpdate === 'tool_call_update');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.status, 'failed');
    assert.match(updates[0].update.content[0].content.text, /permission denied/);
  } finally { await b.close(); }
});

test('malformed NDJSON and unexpected CLI exit fail current turn and leave no live process', async () => {
  for (const text of ['malformed', 'crash']) {
    const b = bridge(); const id = await session(b);
    try { await assert.rejects(turn(b, id, text, []), /invalid NDJSON|exited before/); }
    finally { await b.close(); }
    assert.equal(b.session(id).broken, true);
  }
});

test('cancel settles the owned session after the injected process stopper and never implicitly resumes', async () => {
  const b = bridge(); const id = await session(b); const messages = [];
  const pending = turn(b, id, 'tool-hang', messages);
  pending.catch(() => {});
  await new Promise(done => setTimeout(done, 100));
  await b.cancel({ sessionId: id });
  assert.equal((await pending).stopReason, 'cancelled');
  const updates = messages.filter(message => message.update?.sessionUpdate === 'tool_call_update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.status, 'failed');
  assert.notEqual(b.session(id).child.exitCode, null);
  await assert.rejects(turn(b, id, 'again', []), /fresh session/);
  await b.close();
});

test('missing-file ERROR is a failed tool receipt, not a failed recovered AGY turn', async () => {
  const b = bridge(); const id = await session(b); const messages = [];
  try {
    assert.equal((await turn(b, id, 'missing-file', messages)).stopReason, 'end_turn');
    const updates = messages.filter(message => message.update?.sessionUpdate === 'tool_call_update');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.status, 'failed');
    assert.match(updates[0].update.content[0].content.text, /example-missing.txt: file does not exist/);
    assert.equal([...b.session(id).toolIds.values()].includes('pending'), false);
    assert.equal(b.session(id).active, undefined);
  } finally { await b.close(); }
});

test('SUCCESS does not fabricate a result for an unfinished tool', async () => {
  const b = bridge(); const id = await session(b); const messages = [];
  try {
    await assert.rejects(turn(b, id, 'unfinished-tool', messages), /terminal result arrived before a tool terminal update/);
    const updates = messages.filter(message => message.update?.sessionUpdate === 'tool_call_update');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.status, 'failed');
    assert.equal([...b.session(id).toolIds.values()].includes('pending'), false);
  } finally { await b.close(); }
});

test('real ACP transport preserves tool failure, protocol diagnostics and shuts down on stdin EOF', { timeout: 15000 }, async () => {
  const require = createRequire(new URL('../../packages/acp-client/package.json', import.meta.url));
  const sdkPath = process.env.AGY_TEST_ACP_SDK_PATH ?? require.resolve('@agentclientprotocol/sdk');
  const script = `import { runBridge } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./agy-cli-acp.mjs', import.meta.url))).href)}; await runBridge(${JSON.stringify({ sdkPath, cliPath: process.execPath, cliPrefix: [fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url))] })});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
  const frames = []; const responses = new Map(); let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    const frame = JSON.parse(line); frames.push(frame);
    if (frame.id !== undefined) { responses.get(frame.id)?.(frame); responses.delete(frame.id); }
  });
  let nextId = 0;
  const request = (method, params) => {
    const id = ++nextId;
    return new Promise(done => { responses.set(id, done); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  };
  try {
    const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    assert.ok(initialized.result);
    const created = await request('session/new', { cwd, mcpServers: [] });
    const sessionId = created.result.sessionId;
    const completed = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'missing-file' }] });
    assert.equal(completed.result.stopReason, 'end_turn');
    const update = frames.find(frame => frame.params?.update?.sessionUpdate === 'tool_call_update');
    assert.equal(update.params.update.status, 'failed');
    assert.match(update.params.update.content[0].content.text, /file does not exist/);
    const failed = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'unfinished-tool' }] });
    assert.match(failed.error.message, /terminal result arrived before a tool terminal update/);
  } finally { child.stdin.end(); }
  const exit = await closed;
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  reader.close();
});
