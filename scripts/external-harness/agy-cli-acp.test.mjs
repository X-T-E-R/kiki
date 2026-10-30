import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

void test('rejects a concurrent prompt without writing another native turn', async () => {
  const b = bridge(); const id = await session(b);
  let toolStarted;
  const started = new Promise(done => { toolStarted = done; });
  const pending = b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'tool-hang' }] }, {
    notify: async (_method, event) => {
      if (event.update?.sessionUpdate === 'tool_call') toolStarted();
    },
  });
  pending.catch(() => {});
  try {
    await started;
    const s = b.session(id); const active = s.active; const child = s.child;
    const writes = [];
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (...args) => { writes.push(args[0]); return write(...args); };
    await assert.rejects(turn(b, id, 'must not become a new turn', []), /already has an active turn/);
    assert.deepEqual(writes, []);
    assert.equal(s.active, active);
    assert.equal(s.child, child);
    assert.equal(b.sessions.size, 1);
    await b.cancel({ sessionId: id });
    assert.equal((await pending).stopReason, 'cancelled');
  } finally { await b.close(); }
});

void test('steering enters the running native turn through the owned PostInvocation hook, never as a new user frame', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'agy-steer-'));
  const b = bridge();
  try {
    assert.deepEqual(b.initialize(1)._meta.steering, { supported: true });
    const id = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
    assert.deepEqual(await b.steer({ sessionId: id, prompt: [{ type: 'text', text: 'idle' }] }), { outcome: 'promptRequired', reason: 'noRunningTurn' });
    let toolDone;
    const done = new Promise(resolveDone => { toolDone = resolveDone; });
    const messages = [];
    const pending = b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'steer-loop' }] }, {
      notify: async (_method, event) => { messages.push(event); if (event.update?.sessionUpdate === 'tool_call_update') toolDone(); },
    });
    await done;
    const s = b.session(id); const child = s.child;
    const hooks = JSON.parse(await readFile(join(root, '.agents', 'hooks.json'), 'utf8'));
    assert.equal(hooks['kiki-agy-steering-bridge'].PostInvocation.length, 1);
    const writes = [];
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (...args) => { writes.push(args[0]); return write(...args); };
    assert.deepEqual(await b.steer({ sessionId: id, prompt: [{ type: 'text', text: '中途 steer' }] }), { outcome: 'injected' });
    const result = await pending;
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(writes, []);
    assert.equal(s.child, child);
    assert.match(messages.map(event => event.update?.content?.text ?? '').join(''), /steered:中途 steer/);
    assert.deepEqual(await b.steer({ sessionId: id, prompt: [{ type: 'text', text: 'after' }] }), { outcome: 'promptRequired', reason: 'noRunningTurn' });
  } finally {
    await b.close();
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    await rm(root, { recursive: true, force: true });
  }
});

void test('a queued steer the turn never drains returns promptRequired instead of claiming delivery', async () => {
  const b = bridge(); const id = await session(b);
  let toolStarted;
  const started = new Promise(done => { toolStarted = done; });
  const pending = b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'tool-hang' }] }, {
    notify: async (_method, event) => { if (event.update?.sessionUpdate === 'tool_call') toolStarted(); },
  });
  pending.catch(() => {});
  try {
    await started;
    const steered = b.steer({ sessionId: id, prompt: [{ type: 'text', text: 'late' }] });
    await b.cancel({ sessionId: id });
    assert.deepEqual(await steered, { outcome: 'promptRequired', reason: 'turnEnded' });
    assert.equal((await pending).stopReason, 'cancelled');
  } finally { await b.close(); }
});

void test('steering audit and owned hook cleanup failures never strand a message, lose the turn result or leave an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const b = bridge(); const id = await session(b);
  const audit = b.audit.bind(b);
  let failAudit = () => false;
  b.audit = async (target, type, data) => { if (failAudit(type)) throw Error(`injected ${type} failure`); return audit(target, type, data); };
  let toolStarted;
  const started = new Promise(done => { toolStarted = done; });
  const pending = b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'tool-hang' }] }, {
    notify: async (_method, event) => { if (event.update?.sessionUpdate === 'tool_call') toolStarted(); },
  });
  pending.catch(() => {});
  try {
    await started;
    const s = b.session(id);
    failAudit = type => type === 'steer_queued';
    await assert.rejects(b.steer({ sessionId: id, prompt: [{ type: 'text', text: 'not queued' }] }), /injected steer_queued failure/);
    assert.deepEqual(s.active.steering, []);
    failAudit = type => type.startsWith('steer_') && type !== 'steer_queued';
    const steered = b.steer({ sessionId: id, prompt: [{ type: 'text', text: 'delivered once' }] });
    while (s.active.steering.length === 0) await new Promise(done => setImmediate(done));
    const poll = await b.pollSteering(s, { type: 'steer_poll', conversationId: s.init.conversation_id, invocationNum: 1 });
    assert.deepEqual(poll.steering.injectSteps, [{ userMessage: 'delivered once' }]);
    poll.afterFailure();
    poll.afterWrite();
    assert.deepEqual(await steered, { outcome: 'deliveryUnknown' });
    assert.deepEqual((await b.pollSteering(s, { type: 'steer_poll', conversationId: s.init.conversation_id, invocationNum: 2 })).steering.injectSteps, []);
    const registration = s.steeringRegistration;
    const close = registration.close.bind(registration);
    let closeFails = true;
    registration.close = async () => { if (closeFails) throw Error('injected hook cleanup failure'); return close(); };
    await b.cancel({ sessionId: id });
    assert.equal((await pending).stopReason, 'cancelled');
    assert.equal(s.steeringRegistration, registration);
    closeFails = false;
    await b.closeSteeringHook(s);
    assert.equal(s.steeringRegistration, undefined);
    await new Promise(done => setImmediate(done));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); await b.close(); }
});

void test('bare launch preserves AGY model, effort, permissions and context settings', () => {
  assert.deepEqual(launchArgs({ model: 'engine-default', effort: 'engine-default', additionalDirectories: [] }),
    ['--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert.deepEqual(launchArgs({ model: 'gemini-3.8-flash-medium', effort: 'medium', additionalDirectories: [] }),
    ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'gemini-3.8-flash-medium', '--effort', 'medium']);
});

void test('explicit frozen host yolo reaches the native process without changing other permission modes', () => {
  const base = { model: 'engine-default', effort: 'engine-default', additionalDirectories: [] };
  const ordinary = launchArgs(base);
  assert.deepEqual(launchArgs({ ...base, hostGate: true, permission: { override: { mode: 'yolo' } } }), [...ordinary, '--dangerously-skip-permissions']);
  for (const mode of ['auto', 'manual', 'review', undefined]) assert.deepEqual(launchArgs({ ...base, hostGate: true, permission: { override: { mode } } }), ordinary);
  assert.deepEqual(launchArgs({ ...base, hostGate: false, permission: { override: { mode: 'yolo' } } }), ordinary);
});

void test('frozen writer roots reach the real fixture process without changing the parent or vendor permissions', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const parentCwd = process.cwd();
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-writer-'));
  const writer = join(root, 'writer space 中文');
  const materials = join(root, 'materials 中文');
  await mkdir(writer); await mkdir(materials);
  const b = bridge('claude-opus-5-5-high');
  const originalSpawn = b.spawnProcess;
  let launch;
  b.spawnProcess = (exe, args, options) => {
    launch = { exe, args, cwd: options.cwd };
    return originalSpawn(exe, args, options);
  };
  try {
    const id = (await b.newSession({ cwd: writer, additionalDirectories: [materials], mcpServers: [] })).sessionId;
    b.setConfig({ sessionId: id, configId: 'effort', value: 'high' });
    assert.equal((await turn(b, id, 'writer fixture', [])).stopReason, 'end_turn');
    assert.equal(resolve(b.session(id).init.init.cwd), resolve(writer));
    assert.equal(launch.cwd, writer);
    assert.deepEqual(launch.args.slice(1), ['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--model', 'claude-opus-5-5-high', '--add-dir', materials]);
    assert.equal(process.cwd(), parentCwd);
    assert.equal(b.session(id).permissionRegistration, undefined);
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});

void test('native init rejects another project or missing cwd before accepting its context', async () => {
  const b = bridge();
  const id = await session(b);
  const s = b.session(id);
  for (const init of [{ cwd: tmpdir() }, {}]) {
    await assert.rejects(b.event(s, { event: 'init', conversation_id: 'fixture-conversation', init }), /cwd does not match/);
    assert.equal(s.init, undefined);
  }
  await b.close();
});

void test('text-only boundary rejects rich content instead of dropping it', () => {
  assert.equal(promptText([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]), 'one\ntwo');
  assert.throws(() => promptText([{ type: 'image', data: 'x' }]), /text prompts only/);
});

void test('new contexts differ, unsupported system replacement and malformed MCP fail explicitly', async () => {
  const b = bridge();
  assert.notEqual(await session(b), await session(b));
  await assert.rejects(b.newSession({ cwd, mcpServers: [], _meta: { systemPromptOverride: 'replace' } }), /replacement is unsupported/);
  await assert.rejects(b.newSession({ cwd, mcpServers: [{ name: 'x' }] }), /stdio servers/);
});

void test('explicit external ID reaches CLI; streamed chunks are not duplicated by result; same process keeps context', async () => {
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

void test('permission denial is not reported as successful work', async () => {
  const b = bridge(); const id = await session(b);
  try { await assert.rejects(turn(b, id, 'deny', []), /AGY permission denied for command/); }
  finally { await b.close(); }
});

void test('terminal denial settles pending tool calls before rejecting the turn', async () => {
  const b = bridge(); const id = await session(b); const messages = [];
  try {
    await assert.rejects(turn(b, id, 'deny-tool', messages), /AGY permission denied for command/);
    const updates = messages.filter(message => message.update?.sessionUpdate === 'tool_call_update');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.status, 'failed');
    assert.match(updates[0].update.content[0].content.text, /permission denied/);
  } finally { await b.close(); }
});

void test('malformed NDJSON and unexpected CLI exit fail current turn and leave no live process', async () => {
  for (const text of ['malformed', 'crash']) {
    const b = bridge(); const id = await session(b);
    try { await assert.rejects(turn(b, id, text, []), /invalid NDJSON|exited before/); }
    finally { await b.close(); }
    assert.equal(b.session(id).broken, true);
  }
});

void test('real ACP early exits retain bounded safe diagnostics without mixing sessions or cancellation', { timeout: 15000 }, async () => {
  const require = createRequire(new URL('../../packages/acp-client/package.json', import.meta.url));
  const sdkPath = process.env.AGY_TEST_ACP_SDK_PATH ?? require.resolve('@agentclientprotocol/sdk');
  const vendorScript = `
    if (process.argv.includes('models')) process.exit(0);
    process.stdin.once('data', bytes => {
      const name = JSON.parse(bytes.toString()).message.content;
      const errors = {
        known: 'Fixture service unavailable: upstream refused the request.\\n',
        secret: 'Authorization: Bearer fixture-credential\\napi_key=fixture-key\\n' + 'x'.repeat(64) + '\\n',
        empty: '',
        bounded: 'Old leading diagnostic.\\n' + 'y'.repeat(16384) + '\\nFixture service unavailable after verbose output.\\n',
        truncated: 'password=' + 'z'.repeat(16384),
        hang: 'Cancellation diagnostic must not become an early-exit error.\\n'
      };
      process.stderr.write(errors[name], () => {
        if (name !== 'hang') process.exit(1);
      });
    });
    process.stdin.once('end', () => process.exit(0));
    process.stdin.resume();
  `;
  const adapterScript = `import { runBridge } from ${JSON.stringify(new URL('./agy-cli-acp.mjs', import.meta.url).href)}; await runBridge(${JSON.stringify({ sdkPath, cliPath: process.execPath, cliPrefix: ['-e', vendorScript, '--'] })});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', adapterScript], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
  const responses = new Map();
  let cancellationReady;
  const ready = new Promise(done => { cancellationReady = done; });
  child.stderr.on('data', bytes => { if (bytes.toString().includes('Cancellation diagnostic')) cancellationReady(); });
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.id !== undefined) { responses.get(frame.id)?.(frame); responses.delete(frame.id); }
  });
  let nextId = 0;
  const request = (method, params) => {
    const id = ++nextId;
    return new Promise(done => { responses.set(id, done); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  };
  try {
    assert.ok((await request('initialize', { protocolVersion: 1, clientCapabilities: {} })).result);
    const ids = {};
    for (const name of ['known', 'secret', 'empty', 'bounded', 'truncated', 'hang']) ids[name] = (await request('session/new', { cwd, mcpServers: [] })).result.sessionId;
    const failed = await Promise.all(['known', 'secret', 'empty', 'bounded', 'truncated'].map(async name => {
      const frame = await request('session/prompt', { sessionId: ids[name], prompt: [{ type: 'text', text: name }] });
      assert.equal(frame.error.code, -32603);
      assert.equal(frame.error.data.adapterCode, 'AGY_EARLY_EXIT');
      assert.equal(frame.error.data.details.exitCode, 1);
      assert.equal(frame.error.data.details.signal, null);
      return [name, frame.error];
    }));
    const errors = Object.fromEntries(failed);
    assert.match(errors.known.message, /code: 1, signal: none.*Fixture service unavailable: upstream refused the request/);
    assert.equal(errors.known.data.details.diagnostic, 'Fixture service unavailable: upstream refused the request.');
    for (const name of ['secret', 'empty', 'truncated']) {
      assert.equal(errors[name].message, 'AGY exited before terminal result (code: 1, signal: none)');
      assert.equal(errors[name].data.details.diagnostic, undefined);
    }
    assert.equal(errors.bounded.data.details.diagnostic, 'Fixture service unavailable after verbose output.');
    assert.doesNotMatch(JSON.stringify(errors), /fixture-credential|fixture-key|xxxxxxxx|yyyyyyyy|zzzzzzzz|Old leading/);
    assert(JSON.stringify(errors).length < 2000);
    const pending = request('session/prompt', { sessionId: ids.hang, prompt: [{ type: 'text', text: 'hang' }] });
    await ready;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: ids.hang } }) + '\n');
    assert.equal((await pending).result.stopReason, 'cancelled');
  } finally { child.stdin.end(); }
  assert.deepEqual(await closed, { code: 0, signal: null });
  reader.close();
});

void test('cancel settles the owned session after the injected process stopper and never implicitly resumes', async () => {
  const b = bridge(); const id = await session(b); const messages = [];
  let toolStarted;
  const started = new Promise(done => { toolStarted = done; });
  const pending = b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'tool-hang' }] }, {
    notify: async (_method, event) => {
      messages.push(event);
      if (event.update?.sessionUpdate === 'tool_call') toolStarted();
    },
  });
  pending.catch(() => {});
  await started;
  await b.cancel({ sessionId: id });
  assert.equal((await pending).stopReason, 'cancelled');
  const updates = messages.filter(message => message.update?.sessionUpdate === 'tool_call_update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.status, 'failed');
  assert.notEqual(b.session(id).child.exitCode, null);
  await assert.rejects(turn(b, id, 'again', []), /fresh session/);
  await b.close();
});

void test('missing-file ERROR is a failed tool receipt, not a failed recovered AGY turn', async () => {
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

void test('SUCCESS does not fabricate a result for an unfinished tool', async () => {
  const b = bridge(); const id = await session(b); const messages = [];
  try {
    await assert.rejects(turn(b, id, 'unfinished-tool', messages), /terminal result arrived before a tool terminal update/);
    const updates = messages.filter(message => message.update?.sessionUpdate === 'tool_call_update');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.status, 'failed');
    assert.match(updates[0].update.content[0].content.text, /fixture-conversation-1 \(view_file, ACTIVE\).*execution state is unknown/);
    assert.equal([...b.session(id).toolIds.values()].includes('pending'), false);
    assert.equal(b.session(id).broken, true);
    assert.equal(b.session(id).child.exitCode, null);
    await assert.rejects(turn(b, id, 'again', []), /do not replay these calls or reuse this session/);
  } finally { await b.close(); }
});

void test('real ACP transport preserves tool failure, protocol diagnostics and shuts down on stdin EOF', { timeout: 15000 }, async () => {
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
    assert.deepEqual(initialized.result._meta.steering, { supported: true });
    const created = await request('session/new', { cwd, mcpServers: [] });
    const sessionId = created.result.sessionId;
    const completed = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'missing-file' }] });
    assert.equal(completed.result.stopReason, 'end_turn');
    const update = frames.find(frame => frame.params?.update?.sessionUpdate === 'tool_call_update');
    assert.equal(update.params.update.status, 'failed');
    assert.match(update.params.update.content[0].content.text, /file does not exist/);
    const failed = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'unfinished-tool' }] });
    assert.match(failed.error.message, /terminal result arrived before a tool terminal update/);
    assert.equal(failed.error.code, -32603);
    assert.equal(failed.error.data.adapterCode, 'AGY_TOOL_TERMINAL_MISSING');
    assert.equal(failed.error.data.details.unresolvedTools[0].name, 'view_file');
  } finally { child.stdin.end(); }
  const exit = await closed;
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  reader.close();
});


void test('official permission hook preserves raw command, cwd and identity; only the host selected allow permits it', async () => {
  const b = new AgyBridge({ cliPath: process.execPath });
  const permission = { version: 1, hostGate: true, override: { mode: 'yolo', source: 'runtime' }, policyIdentity: 'fixture-policy', workspace: { cwd, additionalDirectories: [] } };
  await assert.rejects(b.newSession({ cwd, mcpServers: [], _meta: { 'kiki.permission': { hostGate: true } } }), /frozen Kiki permission context/);
  const id = (await b.newSession({ cwd, mcpServers: [], _meta: { 'kiki.permission': permission } })).sessionId;
  const s = b.session(id);
  s.init = { conversation_id: 'fixture-conversation' };
  const input = { conversationId: 'fixture-conversation', stepIdx: 7,
    toolCall: { name: 'run_command', args: { CommandLine: 'pwsh -Command "Get-ChildItem -Path \'C:/example/source\' | Select-Object Name"', Cwd: cwd } } };
  let captured;
  s.active = { client: { request: async (method, request) => {
    captured = { method, request };
    return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
  } } };
  assert.equal((await b.requestPermission(s, input)).decision, 'allow');
  assert.equal(captured.method, 'session/request_permission');
  assert.deepEqual(captured.request.toolCall.rawInput, input.toolCall.args);
  assert.deepEqual(captured.request._meta['kiki.tool'], { name: 'Bash', input: { command: input.toolCall.args.CommandLine, cwd } });
  assert.deepEqual(captured.request.options.map(value => value.optionId), ['allow_once', 'reject_once', 'kiki.vendor_default']);
  delete s.permission.override;
  s.active.client.request = async () => ({ outcome: { outcome: 'selected', optionId: 'kiki.vendor_default' } });
  assert.deepEqual(await b.requestPermission(s, input), { decision: 'ask' });
  s.active.client.request = async () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
  assert.equal((await b.requestPermission(s, input)).decision, 'deny');
  assert.equal((await b.requestPermission(s, { ...input, conversationId: 'other-session' })).decision, 'deny');
  s.active = undefined;
  assert.equal((await b.requestPermission(s, input)).decision, 'deny');
});

void test('native task reads project exact actions without hiding the native policy identity or host rejection', async () => {
  const { canonicalTool } = await import('./agy-cli-acp.mjs');
  const b = new AgyBridge({ cliPath: process.execPath });
  const permission = { version: 1, hostGate: true, override: { mode: 'manual', source: 'profile' }, policyIdentity: 'fixture-policy', workspace: { cwd, additionalDirectories: [] } };
  const id = (await b.newSession({ cwd, mcpServers: [], _meta: { 'kiki.permission': permission } })).sessionId;
  const s = b.session(id);
  s.init = { conversation_id: 'fixture-conversation' };
  let captured;
  let optionId = 'allow_once';
  s.active = { client: { request: async (method, request) => {
    assert.equal(method, 'session/request_permission');
    captured = request;
    return { outcome: { outcome: 'selected', optionId } };
  } } };
  try {
    for (const [args, name] of [[{ Action: 'list' }, 'TaskList'], [{ Action: 'status', TaskId: 'fixture-task' }, 'TaskOutput']]) {
      const input = { conversationId: 'fixture-conversation', stepIdx: 7, toolCall: { name: 'manage_task', args } };
      assert.equal((await b.requestPermission(s, input)).decision, 'allow');
      assert.deepEqual(captured.toolCall.rawInput, args);
      assert.equal(captured.toolCall.title, 'manage_task');
      assert.equal(captured.toolCall.kind, 'read');
      assert.deepEqual(captured._meta['kiki.tool'], { name, nativeName: 'manage_task', input: args });
      optionId = 'reject_once';
      assert.equal((await b.requestPermission(s, input)).decision, 'deny');
      optionId = 'allow_once';
    }
    for (const args of [{ Action: 'kill', TaskId: 'fixture-task' }, { Action: 'send_input', TaskId: 'fixture-task', Input: 'stop' },
      { Action: 'status' }, { Action: 'status', TaskId: '' }, { Action: 'list', TaskId: 3 }, { Action: 'list', Unknown: true }, { Action: 'unknown' }]) {
      assert.deepEqual(canonicalTool('manage_task', args, cwd), { name: 'manage_task', kind: 'other', input: args });
    }
  } finally { s.active = undefined; await b.close(); }
});

void test('URL reads project only FetchURL and a host-approved read_url domain through the authenticated hook', async () => {
  const { canonicalTool, toolPermissionResources } = await import('./agy-cli-acp.mjs');
  const { openPermissionChannel, requestHookPermission } = await import('./agy-permission-hook.mjs');
  const b = new AgyBridge({ cliPath: process.execPath });
  const id = (await b.newSession({ cwd, mcpServers: [], _meta: { 'kiki.permission': {
    version: 1, hostGate: true, override: { mode: 'yolo', source: 'runtime' }, policyIdentity: 'fixture-policy', workspace: { cwd, additionalDirectories: [] } } } })).sessionId;
  const s = b.session(id);
  s.init = { conversation_id: 'fixture-url' };
  let captured; let calls = 0; let outcome = { outcome: 'selected', optionId: 'allow_once' };
  s.active = { client: { request: async (_method, request) => { captured = request; calls++; return { outcome }; } } };
  const channel = await openPermissionChannel(input => b.requestPermission(s, input));
  const input = { conversationId: 'fixture-url', stepIdx: 1, toolCall: { name: 'read_url_content', args: { Url: 'https://DOCS.Example.test.:443/reference?q=one#part' } } };
  try {
    assert.deepEqual(await requestHookPermission(input, channel.env), {
      decision: 'allow', reason: 'Approved by the current Kiki permission gate', permissionOverrides: ['read_url(docs.example.test)'] });
    assert.equal(captured.toolCall.kind, 'fetch');
    assert.deepEqual(captured.toolCall.rawInput, input.toolCall.args);
    assert.deepEqual(captured._meta['kiki.tool'], { name: 'FetchURL', nativeName: 'read_url_content', input: { url: 'https://docs.example.test/reference?q=one#part' } });
    for (const args of [{}, { Url: 'not-a-url' }, { Url: 'file:///etc/passwd' }, { Url: 'javascript:alert(1)' },
      { Url: 'https://user:password@example.test/' }, { Url: 'https://example.test/\nother' },
      { Url: 'https://example.test/', CommandLine: 'example-command' }]) {
      assert.equal((await requestHookPermission({ ...input, toolCall: { name: 'read_url_content', args } }, channel.env)).decision, 'deny');
    }
    assert.equal(calls, 1);
    assert.equal((await requestHookPermission({ ...input, conversationId: 'other' }, channel.env)).decision, 'deny');
    assert.equal(calls, 1);
    outcome = { outcome: 'selected', optionId: 'reject_once' };
    assert.equal((await requestHookPermission(input, channel.env)).decision, 'deny');
    outcome = { outcome: 'cancelled' };
    assert.equal((await requestHookPermission(input, channel.env)).decision, 'deny');
    outcome = { outcome: 'selected', optionId: 'kiki.vendor_default' };
    assert.deepEqual(await requestHookPermission(input, channel.env), { decision: 'ask' });
    for (const name of ['execute_url', 'browser_subagent', 'unknown_url_tool']) {
      assert.deepEqual(canonicalTool(name, input.toolCall.args, cwd), { name, kind: 'other', input: input.toolCall.args });
      assert.equal(toolPermissionResources(name, input.toolCall.args), undefined);
    }
    assert.deepEqual(toolPermissionResources('read_url_content', { Url: 'http://docs.example.test:8080/path' }), ['read_url(docs.example.test)']);
  } finally { s.active = undefined; await channel.close(); await b.close(); }
});

void test('new and native load acknowledge explicit permissions only after the real hook gate is ready', async () => {
  const { mkdtemp, readFile, rm, mkdir, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-permission-receipt-'));
  const auditDir = join(root, 'audit');
  const first = bridge('gemini-3.8-flash-medium');
  first.auditDir = auditDir;
  const loaded = bridge('gemini-3.8-flash-medium');
  loaded.auditDir = auditDir;
  const permission = { version: 1, requestId: 'new-request', hostGate: true, override: { mode: 'yolo', source: 'runtime' },
    policyIdentity: 'fixture-policy', workspace: { cwd: root, additionalDirectories: [] } };
  const params = { cwd: root, mcpServers: [], _meta: { 'kiki.permission': permission } };
  const client = { notify: async () => {}, request: async () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } }) };
  try {
    const ambient = await first.newSession({ ...params, _meta: { 'kiki.permission': { ...permission, override: undefined } } });
    assert.equal(ambient._meta['kiki.permission'], undefined);
    assert.equal(first.session(ambient.sessionId).permissionChannel, undefined);
    assert.ok(!launchArgs(first.session(ambient.sessionId)).includes('--dangerously-skip-permissions'));
    const created = await first.newSession(params);
    const id = created.sessionId;
    assert.deepEqual(created._meta['kiki.permission'], { version: 1, sessionId: id, openMode: 'new', gate: 'pre-tool-hook', applied: permission });
    assert.ok(first.session(id).permissionChannel);
    assert.ok(JSON.parse(await readFile(join(root, '.agents', 'hooks.json'), 'utf8'))['kiki-agy-permission-bridge']);
    await first.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'hello' }] }, client);
    const launch = (await readFile(join(auditDir, `${id}.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse).find(record => record.type === 'launch');
    assert.ok(launch.args.includes('--dangerously-skip-permissions'));
    await assert.rejects(first.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'must-not-run' }],
      _meta: { 'kiki.permission': { ...permission, override: undefined } } }, client), /load its native conversation before restoring vendor permissions/);
    assert.equal(first.session(id).permission.override, undefined);
    assert.equal(first.session(id).hostGate, true);
    const { requestHookPermission } = await import('./agy-permission-hook.mjs');
    assert.equal((await requestHookPermission({ conversationId: 'fixture-conversation', stepIdx: 9,
      toolCall: { name: 'manage_task', args: { Action: 'list' } } }, first.session(id).permissionIdentity)).decision, 'deny');
    const prompts = (await readFile(join(auditDir, `${id}.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse).filter(record => record.type === 'prompt_sent');
    assert.equal(prompts.length, 1);
    await first.close();
    const loadPermission = { ...permission, requestId: 'fresh-load-request' };
    const resumed = await loaded.loadSession({ ...params, sessionId: id, _meta: { 'kiki.permission': loadPermission } });
    assert.deepEqual(resumed._meta['kiki.permission'], { version: 1, sessionId: id, openMode: 'load', gate: 'pre-tool-hook', applied: loadPermission });
    await assert.rejects(loaded.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'hook-deny' }] }, client), /Kiki rejected/);
    await loaded.close();
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    const restored = bridge('gemini-3.8-flash-medium');
    restored.auditDir = auditDir;
    try {
      const inherited = await restored.loadSession({ ...params, sessionId: id,
        _meta: { 'kiki.permission': { ...permission, requestId: 'restore-vendor-request', override: undefined } } });
      assert.equal(inherited._meta['kiki.permission'], undefined);
      await restored.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'continued' }] }, client);
      assert.equal(restored.session(id).init.conversation_id, 'fixture-conversation');
      const restoredLaunch = (await readFile(join(auditDir, `${id}.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse).findLast(record => record.type === 'launch');
      assert.ok(!restoredLaunch.args.includes('--dangerously-skip-permissions'));
      assert.equal(restoredLaunch.args[restoredLaunch.args.indexOf('--conversation') + 1], 'fixture-conversation');
    } finally { await restored.close(); }
    await mkdir(join(root, '.agents'), { recursive: true });
    await writeFile(join(root, '.agents', 'hooks.json'), '{"kiki-agy-permission-bridge":{}}');
    const failed = bridge('gemini-3.8-flash-medium');
    try {
      await assert.rejects(failed.newSession(params), /already owned/);
      assert.equal(failed.sessions.size, 0);
    } finally { await failed.close(); }
  } finally { await first.close(); await loaded.close(); await rm(root, { recursive: true, force: true }); }
});

void test('owned permission channel rejects bad nonce and disconnects, unrelated AGY keeps default policy', async () => {
  const { openPermissionChannel, requestHookPermission } = await import('./agy-permission-hook.mjs');
  assert.deepEqual(await requestHookPermission({}, {}), { decision: 'ask' });
  let calls = 0;
  const channel = await openPermissionChannel(async input => { calls++; return { decision: input.allow ? 'allow' : 'deny' }; });
  try {
    assert.equal((await requestHookPermission({ allow: true }, channel.env)).decision, 'allow');
    assert.equal((await requestHookPermission({ allow: false }, channel.env)).decision, 'deny');
    assert.equal((await requestHookPermission({}, { ...channel.env, KIKI_AGY_PERMISSION_TOKEN: 'wrong' })).decision, 'deny');
    assert.equal(calls, 2);
  } finally { await channel.close(); }
  assert.equal((await requestHookPermission({}, channel.env, 500)).decision, 'deny');
  const hanging = await openPermissionChannel(async () => new Promise(() => {}));
  const pending = requestHookPermission({}, hanging.env, 2000);
  await new Promise(done => setTimeout(done, 30));
  await hanging.close();
  assert.equal((await pending).decision, 'deny');
});

void test('project hook registration leases restore original bytes and preserve concurrent foreign hooks', async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { registerProjectHook } = await import('./agy-hook-registration.mjs');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-hook-'));
  const path = join(root, '.agents', 'hooks.json');
  await mkdir(join(root, '.agents'));
  const original = '{\r\n  "foreign" : { "enabled": false }\r\n}\r\n';
  const options = { cwd: root, nodePath: process.execPath, handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)) };
  try {
    await writeFile(path, original);
    const first = await registerProjectHook({ ...options, sessionId: 'first' });
    const second = await registerProjectHook({ ...options, sessionId: 'second' });
    await first.close();
    assert.ok(JSON.parse(await readFile(path, 'utf8'))['kiki-agy-permission-bridge']);
    await second.close();
    assert.equal(await readFile(path, 'utf8'), original);
    const third = await registerProjectHook({ ...options, sessionId: 'third' });
    const installed = await readFile(path, 'utf8');
    const concurrent = installed.slice(0, installed.lastIndexOf('}')) + ', "new-foreign": {"PreToolUse":[]} }';
    await writeFile(path, concurrent);
    await third.close();
    const remaining = await readFile(path, 'utf8');
    assert.equal(JSON.parse(remaining)['kiki-agy-permission-bridge'], undefined);
    assert.ok(remaining.includes('"new-foreign": {"PreToolUse":[]}'));
    assert.ok(remaining.includes('"foreign" : { "enabled": false }'));
  } finally { await rm(root, { recursive: true, force: true }); }
});


void test('fixture follows project PreToolUse through the owned hook and host ACP decision, including cancel and cleanup', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-vertical-'));
  const b = new AgyBridge({ cliPath: process.execPath, cliPrefix: [fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url))],
    stopProcess: async child => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise(done => child.once('close', done));
      child.stdin.end();
      await closed;
    } });
  const permission = { version: 1, hostGate: true, override: { mode: 'yolo', source: 'runtime' }, policyIdentity: 'fixture-policy', workspace: { cwd: root, additionalDirectories: [] } };
  const id = (await b.newSession({ cwd: root, mcpServers: [], _meta: { 'kiki.permission': permission } })).sessionId;
  const messages = [];
  let optionId = 'allow_once'; let requests = 0; let hold = false; let entered;
  const client = { notify: async (_method, event) => messages.push(event), request: async (method, request, options) => {
    requests++;
    assert.equal(method, 'session/request_permission');
    assert.equal(request._meta['kiki.tool'].input.cwd, root);
    if (hold) {
      entered();
      await new Promise((_done, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    return { outcome: { outcome: 'selected', optionId } };
  } };
  try {
    assert.equal((await b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'hook-allow' }] }, client)).stopReason, 'end_turn');
    assert.equal(requests, 1);
    assert.equal(messages.find(message => message.update?.sessionUpdate === 'tool_call_update').update.status, 'completed');
    optionId = 'reject_once'; messages.length = 0;
    await assert.rejects(b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'hook-deny' }] }, client), /AGY permission denied/);
    assert.equal(requests, 2);
    assert.equal(messages.find(message => message.update?.sessionUpdate === 'tool_call_update').update.status, 'failed');
    assert.equal(messages.filter(message => message.update?.sessionUpdate === 'tool_call_update').length, 1);
    hold = true;
    const ready = new Promise(done => { entered = done; });
    const pending = b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'hook-wait' }] }, client);
    pending.catch(() => {});
    await ready;
    await b.cancel({ sessionId: id });
    assert.equal((await pending).stopReason, 'cancelled');
    assert.equal(b.session(id).permissionRequests.size, 0);
    assert.notEqual(b.session(id).child.exitCode, null);
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(root, '.agents', '.kiki-agy-hook-ownership.json')), { code: 'ENOENT' });
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});


void test('missing native tool terminals retain exact host denials and never infer completion from approval or vendor default', { timeout: 20000 }, async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  for (const outcome of [{ outcome: 'selected', optionId: 'reject_once' }, { outcome: 'cancelled' },
    { outcome: 'selected', optionId: 'allow_once' }, { outcome: 'selected', optionId: 'kiki.vendor_default' }]) {
    const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-terminal-'));
    const b = bridge();
    const permission = { version: 1, hostGate: true, policyIdentity: 'fixture-policy', workspace: { cwd: root, additionalDirectories: [] } };
    const id = (await b.newSession({ cwd: root, mcpServers: [], _meta: { 'kiki.permission': permission } })).sessionId;
    const messages = [];
    const client = { notify: async (_method, event) => messages.push(event), request: async () => ({ outcome }) };
    const denied = outcome.outcome === 'cancelled' || outcome.optionId === 'reject_once';
    try {
      await assert.rejects(b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'hook-no-terminal' }] }, client), error => {
        assert.equal(error.code, denied ? 'AGY_PERMISSION_DENIED' : 'AGY_TOOL_TERMINAL_MISSING');
        assert.match(error.message, denied ? /Kiki rejected agy-fixture-conversation-1 before execution/ : /execution state is unknown/);
        assert.equal(error.details.unresolvedTools.length, denied ? 0 : 1);
        if (denied) assert.deepEqual(error.details.deniedToolCallIds, ['agy-fixture-conversation-1']);
        return true;
      });
      const terminals = messages.filter(message => message.update.sessionUpdate === 'tool_call_update');
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].update.status, 'failed');
      assert.match(terminals[0].update.content[0].content.text, denied ? /Kiki permission gate.*before execution/ : /execution state is unknown/);
      assert.equal(b.session(id).broken, !denied);
      assert.equal(b.session(id).child.exitCode, null);
      if (denied) assert.equal((await b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'unrelated neutral turn' }] }, client)).stopReason, 'end_turn');
      else await assert.rejects(b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'unrelated neutral turn' }] }, client), /do not replay/);
    } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
  }
});

void test('inherit starts without host hook, even with legacy ambient mode; clearing override is a fresh vendor session', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-inherit-'));
  const b = bridge('claude-opus-5-5-high');
  const originalSpawn = b.spawnProcess;
  const launches = [];
  b.spawnProcess = (exe, args, options) => { launches.push({ args, env: options.env }); return originalSpawn(exe, args, options); };
  try {
    for (const permission of [undefined, { version: 1, mode: 'yolo' }, { version: 1, hostGate: false }]) {
      const id = (await b.newSession({ cwd: root, mcpServers: [], _meta: { 'kiki.permission': permission } })).sessionId;
      assert.equal((await turn(b, id, 'hello', [])).stopReason, 'end_turn');
      assert.equal(b.session(id).permissionRegistration, undefined);
      assert.deepEqual(await b.requestPermission(b.session(id), {}), { decision: 'ask' });
      assert.equal(launches.at(-1).env.KIKI_AGY_PERMISSION_ENDPOINT, b.session(id).permissionIdentity.KIKI_AGY_PERMISSION_ENDPOINT);
      assert.deepEqual(launches.at(-1).args.slice(1), ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'claude-opus-5-5-high']);
      await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    }
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});

void test('vendor-default host outcome crosses owned channel as native ask, never as allow', async () => {
  const { openPermissionChannel, requestHookPermission } = await import('./agy-permission-hook.mjs');
  const b = new AgyBridge({ cliPath: process.execPath });
  const permission = { version: 1, hostGate: true, policyIdentity: 'explicit-rules-only', workspace: { cwd, additionalDirectories: [] } };
  const id = (await b.newSession({ cwd, mcpServers: [], _meta: { 'kiki.permission': permission } })).sessionId;
  const s = b.session(id);
  s.init = { conversation_id: 'fixture-rules-only' };
  let optionId = 'kiki.vendor_default';
  s.active = { client: { request: async () => ({ outcome: { outcome: 'selected', optionId } }) } };
  const channel = await openPermissionChannel(input => b.requestPermission(s, input));
  const input = { conversationId: 'fixture-rules-only', stepIdx: 1, toolCall: { name: 'view_file', args: { AbsolutePath: 'C:/example/source.txt' } } };
  try {
    assert.deepEqual(await requestHookPermission(input, channel.env), { decision: 'ask' });
    optionId = 'reject_once';
    assert.equal((await requestHookPermission(input, channel.env)).decision, 'deny');
  } finally { s.active = undefined; await channel.close(); }
});

void test('scoped hook recovery preserves live owner and restores dead owner original bytes without foreign loss', async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { registerProjectHook, recoverProjectHook } = await import('./agy-hook-registration.mjs');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-recovery-'));
  const options = { cwd: root, nodePath: process.execPath, handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)) };
  const hookPath = join(root, '.agents', 'hooks.json');
  try {
    assert.equal((await recoverProjectHook(options)).status, 'no-owned-registration');
    await mkdir(join(root, '.agents'));
    const original = '{\r\n "foreign": {"PreToolUse": []}\r\n}\r\n';
    await writeFile(hookPath, original);
    const live = await registerProjectHook({ ...options, sessionId: 'live' });
    assert.equal((await recoverProjectHook(options)).status, 'owned-session-still-live');
    await live.close();
    const script = `import { registerProjectHook } from ${JSON.stringify(new URL('./agy-hook-registration.mjs', import.meta.url).href)}; await registerProjectHook(${JSON.stringify({ ...options, sessionId: 'dead' })});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    assert.equal(exit, 0);
    assert.equal((await recoverProjectHook(options)).status, 'owned-registration-recovered');
    assert.equal(await readFile(hookPath, 'utf8'), original);
    await assert.rejects(readFile(join(root, '.agents', '.kiki-agy-hook-ownership.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

void test('real ACP permission request carries raw tool metadata and vendor-default ID, then EOF closes owned resources', { timeout: 15000 }, async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-acp-permission-'));
  const sdkPath = process.env.AGY_TEST_ACP_SDK_PATH ?? createRequire(new URL('../../packages/acp-client/package.json', import.meta.url)).resolve('@agentclientprotocol/sdk');
  const script = `import { runBridge } from ${JSON.stringify(new URL('./agy-cli-acp.mjs', import.meta.url).href)}; await runBridge(${JSON.stringify({ sdkPath, cliPath: process.execPath, cliPrefix: [fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url))] })});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
  const requests = []; const responses = new Map(); let stderr = ''; let optionId = 'allow_once';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.method === 'session/request_permission') {
      requests.push(frame.params);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'selected', optionId } } }) + '\n');
    } else if (frame.id !== undefined) { responses.get(frame.id)?.(frame); responses.delete(frame.id); }
  });
  let nextId = 0;
  const request = (method, params) => {
    const id = ++nextId;
    return new Promise(done => { responses.set(id, done); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  };
  try {
    assert.ok((await request('initialize', { protocolVersion: 1, clientCapabilities: {} })).result);
    const permission = { version: 1, hostGate: true, policyIdentity: 'fixture-explicit-rules', workspace: { cwd: root, additionalDirectories: [] } };
    const created = await request('session/new', { cwd: root, mcpServers: [], _meta: { 'kiki.permission': permission } });
    assert.ok(created.result, JSON.stringify(created));
    const sessionId = created.result.sessionId;
    assert.equal((await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hook-allow' }] })).result.stopReason, 'end_turn');
    assert.equal(requests[0]._meta['kiki.tool'].name, 'Bash');
    assert.equal(requests[0]._meta['kiki.tool'].input.cwd, root);
    assert.equal(requests[0].toolCall.rawInput.CommandLine, requests[0]._meta['kiki.tool'].input.command);
    assert.ok(requests[0].options.some(option => option.optionId === 'kiki.vendor_default'));
    optionId = 'kiki.vendor_default';
    const vendor = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hook-vendor' }] });
    assert.match(vendor.error.message, /AGY permission denied/);
    optionId = 'reject_once';
    const denied = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hook-deny' }] });
    assert.match(denied.error.message, /AGY permission denied/);
    assert.equal(requests.length, 3);
  } finally { child.stdin.end(); }
  assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
  reader.close();
  await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, '.agents', '.kiki-agy-hook-ownership.json')), { code: 'ENOENT' });
  await rm(root, { recursive: true, force: true });
});


void test('turn snapshot switches inherit to explicit and back without replacing native process, model or history', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { requestHookPermission } = await import('./agy-permission-hook.mjs');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-boundary-'));
  const b = bridge('gemini-3.8-flash-medium');
  const id = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
  let requests = 0;
  const client = { notify: async () => {}, request: async () => { requests++; return { outcome: { outcome: 'selected', optionId: 'allow_once' } }; } };
  try {
    await b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'hello' }] }, client);
    const pid = b.session(id).child.pid;
    const conversation = b.session(id).init.conversation_id;
    const permission = { version: 1, hostGate: true, override: { mode: 'yolo', source: 'runtime' }, policyIdentity: 'fixture-runtime', workspace: { cwd: root, additionalDirectories: [] } };
    assert.equal((await b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'hook-allow' }], _meta: { 'kiki.permission': permission } }, client)).stopReason, 'end_turn');
    assert.equal(requests, 1);
    assert.ok(JSON.parse(await readFile(join(root, '.agents', 'hooks.json'), 'utf8'))['kiki-agy-permission-bridge']);
    const other = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
    await b.prompt({ sessionId: other, prompt: [{ type: 'text', text: 'hello' }] }, client);
    assert.deepEqual(await requestHookPermission({}, b.session(other).permissionIdentity), { decision: 'ask' });
    assert.equal(requests, 1);
    const inherited = { version: 1, hostGate: false, policyIdentity: 'fixture-cleared', workspace: { cwd: root, additionalDirectories: [] } };
    assert.equal((await b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'again' }], _meta: { 'kiki.permission': inherited } }, client)).stopReason, 'end_turn');
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    assert.deepEqual(await requestHookPermission({}, b.session(id).permissionIdentity), { decision: 'ask' });
    assert.equal(b.session(id).child.pid, pid);
    assert.equal(b.session(id).init.conversation_id, conversation);
    assert.equal(b.session(id).init.init.model, 'gemini-3.8-flash-medium');
    assert.equal(b.session(id).init.init.permission_mode, 'request-review');
    assert.equal(requests, 1);
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});


void test('hook UTF8 split bytes preserve raw Chinese command and path through stdin, server and client pipes', async () => {
  const { createConnection, createServer } = await import('node:net');
  const { openPermissionChannel, requestHookPermission, permissionChannelIdentity } = await import('./agy-permission-hook.mjs');
  const hookPath = fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url));
  const input = { conversationId: 'fixture-chinese', stepIdx: 1, toolCall: { name: 'run_command', args: {
    CommandLine: 'Get-ChildItem -Path "C:/example/中文材料"', Cwd: 'C:/example/中文工作区' } } };
  const b = new AgyBridge({ cliPath: process.execPath });
  const permission = { version: 1, hostGate: true, override: { mode: 'yolo', source: 'runtime' }, policyIdentity: 'fixture-utf8', workspace: { cwd, additionalDirectories: [] } };
  const id = (await b.newSession({ cwd, mcpServers: [], _meta: { 'kiki.permission': permission } })).sessionId;
  const s = b.session(id); s.init = { conversation_id: input.conversationId };
  const host = [];
  s.active = { client: { request: async (_method, request) => { host.push(request); return { outcome: { outcome: 'selected', optionId: 'allow_once' } }; } } };
  const channel = await openPermissionChannel(value => b.requestPermission(s, value));
  try {
    const socket = createConnection(channel.env.KIKI_AGY_PERMISSION_ENDPOINT);
    await once(socket, 'connect');
    const response = new Promise(done => { let text = ''; socket.setEncoding('utf8'); socket.on('data', chunk => { text += chunk; if (text.includes('\n')) done(JSON.parse(text)); }); });
    const bytes = Buffer.from(JSON.stringify(input) + '\n');
    const split = bytes.indexOf(Buffer.from('中')) + 1;
    socket.write(channel.env.KIKI_AGY_PERMISSION_TOKEN + '\n');
    socket.write(bytes.subarray(0, split));
    await new Promise(done => setTimeout(done, 30));
    socket.write(bytes.subarray(split));
    assert.equal((await response).decision, 'allow');
    await once(socket, 'close');
    assert.deepEqual(host[0].toolCall.rawInput, input.toolCall.args);
    assert.deepEqual(host[0]._meta['kiki.tool'], { name: 'Bash', input: { command: input.toolCall.args.CommandLine, cwd: input.toolCall.args.Cwd } });
    const view = { ...input, stepIdx: 2, toolCall: { name: 'view_file', args: { AbsolutePath: 'C:/example/中文材料/原稿.txt' } } };
    const script = `process.argv[1]=${JSON.stringify(hookPath)}; process.stdin.once('data',()=>process.stderr.write('first-chunk\\n')); const setEncoding=process.stdin.setEncoding.bind(process.stdin); process.stdin.setEncoding=(...args)=>{const value=setEncoding(...args); process.stdout.write('ready\\n'); return value;}; await import(${JSON.stringify(pathToFileURL(hookPath).href)});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...channel.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', code => done(code)); });
    const lines = createInterface({ input: child.stdout });
    const received = []; let ready;
    const started = new Promise(done => { ready = done; });
    lines.on('line', line => { if (line === 'ready') ready(); else received.push(JSON.parse(line)); });
    const firstChunk = once(child.stderr, 'data');
    await started;
    const stdinBytes = Buffer.from(JSON.stringify(view));
    const stdinSplit = stdinBytes.indexOf(Buffer.from('中')) + 2;
    child.stdin.write(stdinBytes.subarray(0, stdinSplit));
    await firstChunk;
    child.stdin.end(stdinBytes.subarray(stdinSplit));
    assert.equal(await closed, 0);
    lines.close();
    assert.equal(received[0].decision, 'allow');
    assert.deepEqual(host[1].toolCall.rawInput, view.toolCall.args);
    assert.deepEqual(host[1]._meta['kiki.tool'], { name: 'Read', input: { path: view.toolCall.args.AbsolutePath } });
  } finally { s.active = undefined; await channel.close(); }
  const identity = permissionChannelIdentity();
  const server = createServer(socket => {
    socket.once('data', () => {
      const bytes = Buffer.from(JSON.stringify({ decision: 'deny', reason: '明确拒绝中文操作' }) + '\n');
      const split = bytes.indexOf(Buffer.from('明')) + 1;
      socket.write(bytes.subarray(0, split));
      setTimeout(() => socket.end(bytes.subarray(split)), 30);
    });
    socket.on('error', () => {});
  });
  await new Promise(done => server.listen(identity.KIKI_AGY_PERMISSION_ENDPOINT, done));
  try { assert.deepEqual(await requestHookPermission({}, identity), { decision: 'deny', reason: '明确拒绝中文操作' }); }
  finally { await new Promise(done => server.close(done)); }
});

void test('authenticated hook accepts over 1MiB Write args intact through real ACP host; bad nonce and cancellation never allow', { timeout: 15000 }, async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { openPermissionChannel, requestHookPermission } = await import('./agy-permission-hook.mjs');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-large-hook-'));
  const content = '完整中文正文'.repeat(100000);
  const raw = { TargetFile: 'C:/example/中文原稿.txt', CodeContent: content };
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) > 1024 * 1024);
  const expectedHash = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
  const hookPath = fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url));
  const cli = join(root, 'large-hook-cli.mjs');
  const cliSource = `import { createInterface } from 'node:readline'; import { spawn } from 'node:child_process';
    let turn=0; for await (const line of createInterface({input:process.stdin})) {
      const input=JSON.parse(line); turn++;
      if(turn===1) console.log(JSON.stringify({event:'init',conversation_id:'fixture-large',init:{cwd:process.cwd()}}));
      const child=spawn(process.execPath,[${JSON.stringify(hookPath)}],{env:process.env,stdio:['pipe','pipe','inherit']});
      let text=''; child.stdout.setEncoding('utf8'); child.stdout.on('data',c=>text+=c);
      const closed=new Promise(done=>child.once('close',done));
      child.stdin.end(JSON.stringify({conversationId:'fixture-large',stepIdx:turn,toolCall:{name:'write_to_file',args:{TargetFile:'C:/example/中文原稿.txt',CodeContent:'完整中文正文'.repeat(100000)}}}));
      await closed; const result=JSON.parse(text);
      console.log(JSON.stringify({event:'result',result:{conversation_id:'fixture-large',status:'SUCCESS',response:'fixture tool approved',num_turns:turn,denied_actions:result.decision==='allow'?undefined:[{action:'write'}]}}));
    }`;
  await writeFile(cli, cliSource);
  const sdkPath = process.env.AGY_TEST_ACP_SDK_PATH ?? createRequire(new URL('../../packages/acp-client/package.json', import.meta.url)).resolve('@agentclientprotocol/sdk');
  const script = `import {runBridge} from ${JSON.stringify(new URL('./agy-cli-acp.mjs', import.meta.url).href)}; await runBridge(${JSON.stringify({ sdkPath, cliPath: process.execPath, cliPrefix: [cli] })});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', code => done(code)); });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const replies = new Map(); let id = 0; const host = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.method === 'session/request_permission') {
      host.push(frame.params);
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:{outcome:{outcome:'selected',optionId:'allow_once'}}})+'\n');
    } else if (frame.id !== undefined) { replies.get(frame.id)?.(frame); replies.delete(frame.id); }
  });
  const request = (method, params) => { const next = ++id; return new Promise(done => { replies.set(next, done); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n'); }); };
  try {
    assert.ok((await request('initialize', { protocolVersion: 1, clientCapabilities: {} })).result);
    const permission = { version: 1, hostGate: true, override: { mode: 'yolo', source: 'runtime' }, policyIdentity: 'fixture-large', workspace: { cwd: root, additionalDirectories: [] } };
    const session = await request('session/new', { cwd: root, mcpServers: [], _meta: { 'kiki.permission': permission } });
    const result = await request('session/prompt', { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'fixture large tool' }] });
    assert.equal(result.result.stopReason, 'end_turn', stderr);
    assert.equal(host.length, 1);
    assert.equal(createHash('sha256').update(JSON.stringify(host[0].toolCall.rawInput)).digest('hex'), expectedHash);
    assert.deepEqual(host[0].toolCall.rawInput, raw);
    assert.deepEqual(host[0]._meta['kiki.tool'], { name: 'Write', input: { path: raw.TargetFile } });
  } finally { child.stdin.end(); }
  assert.equal(await closed, 0, stderr); lines.close();
  await rm(root, { recursive: true, force: true });
  let calls = 0; let entered;
  const waiting = new Promise(done => { entered = done; });
  const channel = await openPermissionChannel(async () => { calls++; entered(); return new Promise(() => {}); });
  try {
    assert.equal((await requestHookPermission(raw, { ...channel.env, KIKI_AGY_PERMISSION_TOKEN: 'bad-nonce' }, 2000)).decision, 'deny');
    assert.equal(calls, 0);
    const pending = requestHookPermission(raw, channel.env, 2000);
    await waiting;
    await channel.close();
    assert.equal((await pending).decision, 'deny');
    assert.equal(calls, 1);
  } finally { await channel.close(); }
});


void test('Windows registered hook command survives native shell quoting for exact node path and Chinese spaced paths', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { mkdtemp, mkdir, cp, readFile, rm } = await import('node:fs/promises');
  const { registerProjectHook } = await import('./agy-hook-registration.mjs');
  const { openPermissionChannel } = await import('./agy-permission-hook.mjs');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-shell-'));
  const input = { conversationId: 'fixture-windows-shell', stepIdx: 3, toolCall: { name: 'view_file', args: { AbsolutePath: 'C:/example/中文材料/原稿.txt' } } };
  const b = new AgyBridge({ cliPath: process.execPath });
  const id = (await b.newSession({ cwd: root, mcpServers: [], _meta: { 'kiki.permission': { version: 1, hostGate: true, override: { mode: 'yolo', source: 'runtime' }, policyIdentity: 'fixture-shell', workspace: { cwd: root, additionalDirectories: [] } } } })).sessionId;
  const s = b.session(id); s.init = { conversation_id: input.conversationId };
  let optionId = 'allow_once'; let calls = 0;
  s.active = { client: { request: async (_method, request) => {
    calls++; assert.deepEqual(request.toolCall.rawInput, input.toolCall.args);
    assert.deepEqual(request._meta['kiki.tool'], { name: 'Read', input: { path: input.toolCall.args.AbsolutePath } });
    return { outcome: { outcome: 'selected', optionId } };
  } } };
  const channel = await openPermissionChannel(value => b.requestPermission(s, value));
  async function shell(command) {
    const child = spawn(process.env.ComSpec, ['/d', '/s', '/c', command], { cwd: root, env: { ...process.env, ...channel.env }, stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', code => done(code)); });
    child.stdin.end(JSON.stringify(input));
    return { code: await closed, stdout, stderr };
  }
  const exactNode = process.execPath;
  const sourceHandler = fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url));
  try {
    const old = await shell(`"${exactNode}" "${sourceHandler}" & exit /b 0`);
    assert.equal(old.code, 0);
    assert.match(old.stderr, /is not recognized as an internal or external command/);
    assert.equal(old.stdout.trim(), ''); assert.equal(calls, 0);
    const spaced = join(root, '中文 空格'); await mkdir(spaced);
    const spacedNode = join(spaced, 'node runner.exe'); const spacedHandler = join(spaced, "permission 中文's hook.mjs");
    await cp(exactNode, spacedNode); await cp(sourceHandler, spacedHandler);
    for (const [nodePath, handlerPath] of [[exactNode, sourceHandler], [spacedNode, spacedHandler]]) {
      const registration = await registerProjectHook({ cwd: root, nodePath, handlerPath, sessionId: `fixture-${calls}` });
      try {
        const hooks = JSON.parse(await readFile(join(root, '.agents', 'hooks.json'), 'utf8'));
        const command = hooks['kiki-agy-permission-bridge'].PreToolUse[0].hooks[0].command;
        for (const [selected, expected] of [['allow_once', 'allow'], ['reject_once', 'deny'], ['kiki.vendor_default', undefined]]) {
          optionId = selected; const result = await shell(command);
          assert.equal(result.code, 0, result.stderr);
          const output = JSON.parse(result.stdout);
          if (expected === undefined) assert.deepEqual(output, { decision: 'ask' }); else assert.equal(output.decision, expected);
        }
      } finally { await registration.close(); }
    }
    assert.equal(calls, 6);
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(root, '.agents', '.kiki-agy-hook-ownership.json')), { code: 'ENOENT' });
  } finally { s.active = undefined; await channel.close(); await rm(root, { recursive: true, force: true }); }
});


void test('per-call resources cross downstream vendor command and write checks without retaining approval on clear', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-resources-'));
  const b = new AgyBridge({ cliPath: process.execPath, cliPrefix: [fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url))], stopProcess: async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(done => child.once('close', done)); child.stdin.end(); await exited;
  } });
  const permission = { version: 1, hostGate: true, override: { mode: 'yolo', source: 'runtime' }, policyIdentity: 'fixture-resources', workspace: { cwd: root, additionalDirectories: [] } };
  let optionId = 'allow_once'; const calls = [];
  const client = { notify: async () => {}, request: async (_method, request) => {
    calls.push(request); return { outcome: { outcome: 'selected', optionId } };
  } };
  const open = async meta => (await b.newSession({ cwd: root, mcpServers: [], _meta: { 'kiki.permission': meta } })).sessionId;
  const prompt = (id, text, meta) => b.prompt({ sessionId: id, prompt: [{ type: 'text', text }], _meta: { 'kiki.permission': meta } }, client);
  try {
    const id = await open(undefined);
    await prompt(id, 'hello', undefined);
    const pid = b.session(id).child.pid;
    assert.equal((await prompt(id, 'vendor-command', permission)).stopReason, 'end_turn');
    assert.equal((await readFile(join(root, 'command-executed.txt'), 'utf8')).trim(), 'approved');
    optionId = 'allow_always';
    assert.equal((await prompt(id, 'vendor-write', permission)).stopReason, 'end_turn');
    assert.equal(await readFile(join(root, 'fixture-report.md'), 'utf8'), 'approved report');
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].toolCall.toolCallId, calls[1].toolCall.toolCallId);
    assert.equal(b.session(id).child.pid, pid);
    await rm(join(root, 'command-executed.txt'));
    await assert.rejects(prompt(id, 'vendor-command', undefined), /AGY permission denied/);
    assert.equal(calls.length, 2);
    await assert.rejects(readFile(join(root, 'command-executed.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    await b.cancel({ sessionId: id });

    const rejectId = await open(permission);
    optionId = 'reject_once';
    await assert.rejects(prompt(rejectId, 'vendor-command-wide', permission), /AGY permission denied/);
    await assert.rejects(readFile(join(root, 'command-executed.txt')), { code: 'ENOENT' });
    await b.cancel({ sessionId: rejectId });

    const inherit = { ...permission, override: undefined };
    const inheritId = await open(inherit);
    optionId = 'kiki.vendor_default';
    assert.equal((await prompt(inheritId, 'vendor-command-wide', inherit)).stopReason, 'end_turn');
    assert.equal((await readFile(join(root, 'command-executed.txt'), 'utf8')).trim(), 'approved');
    await rm(join(root, 'command-executed.txt'));
    await assert.rejects(prompt(inheritId, 'vendor-command', inherit), /AGY permission denied/);
    await assert.rejects(readFile(join(root, 'command-executed.txt')), { code: 'ENOENT' });
    await b.cancel({ sessionId: inheritId });

    const oldId = await open(permission);
    b.requestPermission = async () => ({ decision: 'allow' });
    await assert.rejects(prompt(oldId, 'vendor-command', permission), /AGY permission denied/);
    await assert.rejects(readFile(join(root, 'command-executed.txt')), { code: 'ENOENT' });
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});


void test('agy 1.3.4 catalog ids embed effort; a bare provider id does not inherit another model menu', async () => {
  const { vendorModelIds, configOptions, encodedEffort } = await import('./agy-cli-acp.mjs');
  const catalog = [
    'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
    'gemini-4-argon-high\tGemini 4 Argon (High)',
    'gemini-4-argon-low\tGemini 4 Argon (Low)',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
    'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
    'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
    'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
    'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
    'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
    'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  ].join('\n');
  const ids = vendorModelIds(catalog);
  assert.equal(ids.includes('claude-opus-5-5-high'), true);
  assert.equal(ids.includes('gemini-3.8-flash-high'), true);
  assert.equal(ids.includes('anthropic/claude-opus-5-5'), false);
  assert.equal(encodedEffort('claude-opus-5-5-high'), 'high');
  assert.equal(encodedEffort('anthropic/claude-opus-5-5'), undefined);
  const opus = bridge('claude-opus-5-5-high');
  const opusId = await session(opus);
  opus.setConfig({ sessionId: opusId, configId: 'effort', value: 'high' });
  assert.deepEqual(configOptions(opus.session(opusId))[0].options.map(option => option.value), ['engine-default', 'high']);
  assert.deepEqual(launchArgs(opus.session(opusId)), ['--input-format', 'stream-json', '--output-format', 'stream-json',
    '--model', 'claude-opus-5-5-high']);
  const gemini = bridge('gemini-3.8-flash-high');
  const geminiId = await session(gemini);
  gemini.setConfig({ sessionId: geminiId, configId: 'effort', value: 'high' });
  assert.ok(launchArgs(gemini.session(geminiId)).includes('--effort'));
  assert.equal(launchArgs(gemini.session(geminiId))[launchArgs(gemini.session(geminiId)).indexOf('--effort') + 1], 'high');
  const bare = bridge('anthropic/claude-opus-5-5');
  const bareId = await session(bare);
  assert.deepEqual(configOptions(bare.session(bareId))[0].options.map(option => option.value), ['engine-default']);
  assert.throws(() => bare.setConfig({ sessionId: bareId, configId: 'effort', value: 'high' }), /not an advertised config/);
  assert.equal(bare.session(bareId).effort, 'engine-default');
  assert.equal(launchArgs(bare.session(bareId)).includes('--effort'), false);
  assert.throws(() => launchArgs({ model: 'engine-default', effort: 'high', additionalDirectories: [] }), /not an advertised config/);
  assert.deepEqual(launchArgs({ model: 'engine-default', effort: 'engine-default', additionalDirectories: [] }),
    ['--input-format', 'stream-json', '--output-format', 'stream-json']);
  await opus.close();
  await gemini.close();
  await bare.close();
});

void test('raw model effort suffix is authoritative, not the generic CLI effort menu', async () => {
  const { configOptions } = await import('./agy-cli-acp.mjs');
  for (const [model, effort] of [['claude-opus-5-5-high', 'high'], ['gemini-3.8-flash-medium', 'medium'], ['example-model-xhigh', 'xhigh']]) {
    const b = bridge(model); const id = await session(b);
    assert.deepEqual(configOptions(b.session(id))[0].options.map(option => option.value), ['engine-default', effort]);
    const before = b.session(id).effort;
    assert.throws(() => b.setConfig({ sessionId: id, configId: 'effort', value: effort === 'max' ? 'low' : 'max' }), /conflicts with effort/);
    assert.equal(b.session(id).effort, before);
    assert.equal(b.session(id).child, undefined);
    b.setConfig({ sessionId: id, configId: 'effort', value: effort });
    const args = launchArgs(b.session(id));
    assert.equal(args[args.indexOf('--model') + 1], model);
    assert.equal(args.includes('--effort'), !model.startsWith('claude-'));
    if (!model.startsWith('claude-')) assert.equal(args[args.indexOf('--effort') + 1], effort);
    await b.close();
  }
  assert.deepEqual(configOptions({ model: 'engine-default', effort: 'engine-default' })[0].options.map(option => option.value), ['engine-default']);
  assert.throws(() => launchArgs({ model: 'claude-opus-5-5-high', effort: 'max', additionalDirectories: [] }), /conflicts with effort/);
});

void test('Claude encoded effort survives exact native load with new and legacy launch audits', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  for (const legacy of [false, true]) {
    const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-claude-effort-'));
    const first = bridge('claude-opus-5-5-high'); first.auditDir = root;
    const loaded = bridge('claude-opus-5-5-high'); loaded.auditDir = root;
    try {
      const id = (await first.newSession({ cwd: root, mcpServers: [] })).sessionId;
      first.setConfig({ sessionId: id, configId: 'effort', value: 'high' });
      assert.equal((await turn(first, id, 'first fixture turn', [])).stopReason, 'end_turn');
      await first.close();
      const auditPath = join(root, `${id}.ndjson`);
      const records = (await readFile(auditPath, 'utf8')).trim().split('\n').map(JSON.parse);
      const launch = records.find(record => record.type === 'launch');
      assert.equal(launch.effort, 'high');
      assert.equal(launch.args.includes('--effort'), false);
      if (legacy) {
        delete launch.effort;
        launch.args.push('--effort', 'high');
        await writeFile(auditPath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
      }
      const opened = await loaded.loadSession({ sessionId: id, cwd: root, mcpServers: [] });
      assert.equal(opened.configOptions[0].currentValue, 'high');
      assert.equal(loaded.session(id).model, 'claude-opus-5-5-high');
      const args = launchArgs(loaded.session(id));
      assert.equal(args.includes('--effort'), false);
      assert.equal(args[args.indexOf('--conversation') + 1], 'fixture-conversation');
      assert.equal((await turn(loaded, id, 'next fixture turn', [])).stopReason, 'end_turn');
    } finally { await first.close(); await loaded.close(); await rm(root, { recursive: true, force: true }); }
  }
});

void test('native load uses only exact audited conversation and binding, owns a lease, and never copies history', async () => {
  const { mkdtemp, readFile, rm, appendFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-exact-load-'));
  const auditDir = join(root, 'audit');
  const first = bridge('gemini-3.8-flash-medium'); first.auditDir = auditDir;
  const id = (await first.newSession({ cwd: root, mcpServers: [] })).sessionId;
  const loaded = bridge('gemini-3.8-flash-medium'); loaded.auditDir = auditDir;
  const competitor = bridge('gemini-3.8-flash-medium'); competitor.auditDir = auditDir;
  try {
    first.setConfig({ sessionId: id, configId: 'effort', value: 'medium' });
    await turn(first, id, 'original user prompt', []);
    await assert.rejects(loaded.loadSession({ sessionId: id, cwd: root, mcpServers: [] }), /owned process/);
    await first.close();
    await assert.rejects(loaded.loadSession({ sessionId: id, cwd, mcpServers: [] }), /workspace differs/);
    const otherModel = bridge('claude-opus-5-5-high'); otherModel.auditDir = auditDir;
    await assert.rejects(otherModel.loadSession({ sessionId: id, cwd: root, mcpServers: [] }), /model differs/);
    await loaded.loadSession({ sessionId: id, cwd: root, mcpServers: [] });
    assert.equal(loaded.initialize(1).agentCapabilities.loadSession, true);
    assert.equal(loaded.session(id).effort, 'medium');
    await assert.rejects(competitor.loadSession({ sessionId: id, cwd: root, mcpServers: [] }), /already being loaded/);
    const args = launchArgs(loaded.session(id));
    assert.equal(args[args.indexOf('--conversation') + 1], 'fixture-conversation');
    assert.equal(args.includes('--continue'), false);
    const messages = [];
    assert.equal((await turn(loaded, id, 'only new user prompt', messages)).stopReason, 'end_turn');
    assert.equal(loaded.session(id).init.conversation_id, 'fixture-conversation');
    await loaded.close();
    await assert.rejects(readFile(join(auditDir, `${id}.resume-lock`)), { code: 'ENOENT' });
    const audit = await readFile(join(auditDir, `${id}.ndjson`), 'utf8');
    assert.equal(audit.includes('original user prompt'), false);
    assert.equal(audit.includes('only new user prompt'), false);
    await appendFile(join(auditDir, `${id}.ndjson`), JSON.stringify({ type: 'launch', args: [], pid: 999999 }) + '\n');
    await assert.rejects(competitor.loadSession({ sessionId: id, cwd: root, mcpServers: [] }), /no confirmed native conversation/);
    await assert.rejects(competitor.loadSession({ sessionId: '../../other', cwd: root, mcpServers: [] }), /Invalid.*session ID/);
  } finally { await first.close(); await loaded.close(); await competitor.close(); await rm(root, { recursive: true, force: true }); }
});

void test('missing file during native permission declaration stays a failed read, not a vendor denial', async () => {
  const b = bridge(); const id = await session(b); const s = b.session(id);
  b.permissionSnapshot(s, { version: 1, hostGate: true, override: { mode: 'yolo', source: 'profile' },
    policyIdentity: 'fixture-policy', workspace: { cwd, additionalDirectories: [] } });
  s.init = { conversation_id: 'fixture-missing-file' };
  const messages = []; let resolved;
  s.active = { client: { notify: async (_method, event) => messages.push(event),
    request: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }) },
    text: '', reject: error => { throw error; }, resolve: value => { resolved = value; } };
  const args = { AbsolutePath: 'C:/example/product/missing.ts' };
  assert.equal((await b.requestPermission(s, { conversationId: s.init.conversation_id, stepIdx: 2,
    toolCall: { name: 'view_file', args } })).decision, 'allow');
  const error = 'declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) failed to read file: GetFileAttributesEx C:/example/product/missing.ts: The system cannot find the file specified.';
  await b.event(s, { event: 'step_update', conversation_id: s.init.conversation_id,
    step_update: { step_type: 'tool', step_index: 2, tool_name: 'view_file', state: 'ERROR', tool_info: { parameters: args, error } } });
  assert.equal(s.active.vendorRejected, undefined);
  assert.equal(messages.at(-1).update.status, 'failed');
  assert.equal(messages.at(-1).update.rawOutput, error);
  await b.event(s, { event: 'result', result: { status: 'SUCCESS', response: 'Missing file reported accurately.' } });
  assert.equal(resolved.stopReason, 'end_turn');
  await b.close();
});

void test('native denial after exact host approval retains failed tool receipt and names the vendor layer', async () => {
  const b = bridge(); const id = await session(b); const s = b.session(id);
  const permission = { version: 1, hostGate: true, override: { mode: 'yolo', source: 'runtime' }, policyIdentity: 'fixture-policy', workspace: { cwd, additionalDirectories: [] } };
  b.permissionSnapshot(s, permission);
  s.init = { conversation_id: 'fixture-approved-then-denied' };
  const messages = []; let rejected;
  s.active = { client: { notify: async (_method, event) => messages.push(event), request: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }) }, reject: error => { rejected = error; } };
  const args = { CommandLine: 'git status --short' };
  const hook = await b.requestPermission(s, { conversationId: s.init.conversation_id, stepIdx: 2, toolCall: { name: 'run_command', args } });
  assert.equal(hook.decision, 'allow');
  assert.deepEqual(hook.permissionOverrides, ['command(git status --short)']);
  await b.event(s, { event: 'step_update', conversation_id: s.init.conversation_id, step_update: { step_type: 'tool', step_index: 2, tool_name: 'run_command', state: 'ERROR', tool_info: { parameters: args, error: 'permission check failed for command: user denied permission' } } });
  await b.event(s, { event: 'result', result: { status: 'SUCCESS', denied_actions: [{ action: 'command' }], response: '' } });
  assert.match(rejected.message, /native AGY permission engine rejected a tool after Kiki approved this exact call/);
  assert.equal(messages.at(-1).update.status, 'failed');
  assert.equal([...s.toolIds.values()].includes('pending'), false);
  assert.equal(s.active, undefined);
  await b.close();
});


void test('pre-tool hook denial cannot become successful work when native result omits denied_actions', async () => {
  for (const location of ['output', 'error']) {
    const b = bridge(); const id = await session(b); const s = b.session(id);
    const messages = []; let rejected; let resolved = false;
    s.init = { conversation_id: 'fixture-pre-hook-denial' };
    s.active = { client: { notify: async (_method, event) => messages.push(event) },
      text: '', reject: error => { rejected = error; }, resolve: () => { resolved = true; } };
    const parameters = { AbsolutePath: 'C:/example/product/package.json' };
    const toolInfo = { parameters, [location]: 'tool call denied by pre-tool hook:' };
    await b.event(s, { event: 'step_update', conversation_id: s.init.conversation_id,
      step_update: { step_type: 'tool', step_index: 2, tool_name: 'view_file', state: 'ERROR', tool_info: toolInfo } });
    await b.event(s, { event: 'result', result: { status: 'SUCCESS', response: 'unverified report text' } });
    assert.equal(rejected.code, 'AGY_PERMISSION_DENIED');
    assert.match(rejected.message, /PreToolUse hook rejected a tool before execution/);
    assert.equal(resolved, false);
    assert.equal(messages.filter(message => message.update.sessionUpdate === 'agent_message_chunk').length, 0);
    assert.equal(messages.at(-1).update.status, 'failed');
    assert.equal(s.active, undefined);
    s.active = { client: { notify: async () => {} }, text: '', reject: error => { throw error; },
      resolve: result => { assert.equal(result.stopReason, 'end_turn'); } };
    await b.event(s, { event: 'step_update', conversation_id: s.init.conversation_id,
      step_update: { step_type: 'tool', step_index: 4, tool_name: 'view_file', state: 'ERROR',
        tool_info: { parameters, error: 'file does not exist' } } });
    await b.event(s, { event: 'result', result: { status: 'SUCCESS', response: 'missing file reported' } });
    await b.close();
  }
});

void test('shared Windows hook delegates inherited and vendor-default permission to native settings', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
  const { hookCommand } = await import('./agy-hook-registration.mjs');
  const { openPermissionChannel } = await import('./agy-permission-hook.mjs');
  const b = bridge(); const id = await session(b); const s = b.session(id);
  s.init = { conversation_id: 'fixture-shared-project-hook' };
  let calls = 0; let optionId = 'allow_once';
  s.active = { client: { request: async () => {
    calls++; return { outcome: { outcome: 'selected', optionId } };
  } } };
  const channel = await openPermissionChannel(input => b.requestPermission(s, input));
  const command = hookCommand(process.execPath, fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)));
  const input = { conversationId: s.init.conversation_id, stepIdx: 2,
    toolCall: { name: 'view_file', args: { AbsolutePath: 'C:/example/product/package.json' } } };
  const run = async () => {
    const child = spawn(process.env.ComSpec, ['/d', '/s', '/c', command],
      { cwd, env: { ...process.env, ...channel.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', value => { stdout += value.toString('utf8'); });
    child.stderr.on('data', value => { stderr += value.toString('utf8'); });
    const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', code => done(code)); });
    child.stdin.end(JSON.stringify(input));
    assert.equal(await closed, 0, stderr);
    return JSON.parse(stdout);
  };
  try {
    assert.equal(s.hostGate, false);
    assert.deepEqual(await run(), { decision: 'ask' });
    assert.equal(calls, 0);
    b.permissionSnapshot(s, { version: 1, hostGate: true, policyIdentity: 'fixture-only',
      workspace: { cwd, additionalDirectories: [] } });
    const approvedRead = await run();
    assert.equal(approvedRead.decision, 'allow');
    assert.deepEqual(approvedRead.permissionOverrides, ['read_file(C:/example/product/package.json)']);
    input.toolCall = { name: 'write_to_file', args: { TargetFile: 'C:/example/reports/01.md' } };
    const approvedWrite = await run();
    assert.deepEqual(approvedWrite.permissionOverrides, ['write_file(C:/example/reports/01.md)']);
    optionId = 'reject_once';
    assert.equal((await run()).decision, 'deny');
    optionId = 'kiki.vendor_default';
    assert.deepEqual(await run(), { decision: 'ask' });
    assert.equal(calls, 4);
  } finally { s.active = undefined; await channel.close(); await b.close(); }
});

void test('real ACP session/load restores exact native argv after adapter EOF without handoff replay', { timeout: 15000 }, async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-acp-load-'));
  const auditDir = join(root, 'audit');
  const sdkPath = process.env.AGY_TEST_ACP_SDK_PATH ?? createRequire(new URL('../../packages/acp-client/package.json', import.meta.url)).resolve('@agentclientprotocol/sdk');
  const script = `import { runBridge } from ${JSON.stringify(new URL('./agy-cli-acp.mjs', import.meta.url).href)}; await runBridge(${JSON.stringify({ sdkPath, cliPath: process.execPath, cliPrefix: [fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url))], model: 'gemini-3.8-flash-medium', auditDir })});`;
  function transport() {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', code => done(code)); });
    const replies = new Map(); const frames = []; let id = 0; let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => { const frame = JSON.parse(line); frames.push(frame); if (frame.id !== undefined) { replies.get(frame.id)?.(frame); replies.delete(frame.id); } });
    return { frames, request(method, params) { const next = ++id; return new Promise(done => { replies.set(next, done); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n'); }); }, async close() { child.stdin.end(); assert.equal(await closed, 0, stderr); reader.close(); } };
  }
  let first; let second;
  try {
    first = transport();
    assert.equal((await first.request('initialize', { protocolVersion: 1, clientCapabilities: {} })).result.agentCapabilities.loadSession, true);
    const created = await first.request('session/new', { cwd: root, mcpServers: [] });
    const sessionId = created.result.sessionId;
    assert.equal((await first.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'original' }] })).result.stopReason, 'end_turn');
    await first.close(); first = undefined;
    second = transport();
    await second.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    assert.ok((await second.request('session/load', { sessionId, cwd: root, mcpServers: [] })).result);
    assert.equal((await second.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'new message only' }] })).result.stopReason, 'end_turn');
    await second.close(); second = undefined;
    const records = (await readFile(join(auditDir, `${sessionId}.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse);
    const launches = records.filter(record => record.type === 'launch');
    assert.equal(launches.length, 2);
    assert.equal(launches[1].args[launches[1].args.indexOf('--conversation') + 1], 'fixture-conversation');
    assert.equal(launches[1].args.includes('--continue'), false);
    assert.equal(records.filter(record => record.type === 'agy_init').at(-1).conversationId, 'fixture-conversation');
    assert.equal(records.filter(record => record.type === 'prompt_sent').length, 2);
    await assert.rejects(readFile(join(auditDir, `${sessionId}.resume-lock`)), { code: 'ENOENT' });
  } finally { await first?.close(); await second?.close(); await rm(root, { recursive: true, force: true }); }
});


void test('real ACP startup and recovery errors retain actionable reasons without starting or replaying a conversation', { timeout: 15000 }, async () => {
  const { mkdtemp, readFile, readdir, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-acp-startup-'));
  const auditDir = join(root, 'audit');
  const catalogCalls = join(root, 'catalog-calls.ndjson');
  const sdkPath = process.env.AGY_TEST_ACP_SDK_PATH ?? createRequire(new URL('../../packages/acp-client/package.json', import.meta.url)).resolve('@agentclientprotocol/sdk');
  const catalogScript = `require('node:fs').appendFileSync(${JSON.stringify(catalogCalls)}, JSON.stringify(process.argv.slice(1)) + '\\n'); if (process.argv[1] !== 'models') process.exit(1);`;
  const script = `import { runBridge } from ${JSON.stringify(new URL('./agy-cli-acp.mjs', import.meta.url).href)}; await runBridge(${JSON.stringify({ sdkPath, cliPath: process.execPath, cliPrefix: ['-e', catalogScript, '--'], auditDir })});`;
  function transport() {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, KIKI_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', code => done(code)); });
    const replies = new Map(); const frames = []; let id = 0; let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => { const frame = JSON.parse(line); frames.push(frame); if (frame.id !== undefined) { replies.get(frame.id)?.(frame); replies.delete(frame.id); } });
    return { frames, request(method, params) { const next = ++id; return new Promise(done => { replies.set(next, done); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n'); }); }, async close() { child.stdin.end(); assert.equal(await closed, 0, stderr); reader.close(); } };
  }
  let first; let second;
  try {
    first = transport();
    assert.ok((await first.request('initialize', { protocolVersion: 1, clientCapabilities: {} })).result);
    const rejected = await first.request('session/new', { cwd: root, mcpServers: [], _meta: { systemPromptOverride: 'replacement' } });
    assert.equal(rejected.error.code, -32603);
    assert.equal(rejected.error.message, 'System replacement is unsupported; use explicit Kiki preamble delivery');
    const denied = await first.request('session/new', { cwd: root, mcpServers: [], _meta: { 'kiki.permission': { hostGate: true } } });
    assert.equal(denied.error.code, -32603);
    assert.match(denied.error.message, /frozen Kiki permission context/);
    const created = await first.request('session/new', { cwd: root, mcpServers: [] });
    const sessionId = created.result.sessionId;
    await first.close(); first = undefined;
    const auditPath = join(auditDir, `${sessionId}.ndjson`);
    const original = await readFile(auditPath, 'utf8');
    assert.deepEqual(original.trim().split('\n').map(JSON.parse).map(record => record.type), ['session_new', 'close']);
    second = transport();
    assert.ok((await second.request('initialize', { protocolVersion: 1, clientCapabilities: {} })).result);
    const failed = await second.request('session/load', { sessionId, cwd: root, mcpServers: [] });
    assert.equal(failed.error.code, -32603);
    assert.equal(failed.error.message, 'AGY session has no confirmed native conversation to load; retain the failed attempt and create a new session');
    assert.equal(failed.error.data.adapterCode, undefined);
    assert.equal(failed.result, undefined);
    assert.equal(second.frames.some(frame => frame.method === 'session/update'), false);
    await second.close(); second = undefined;
    assert.equal(await readFile(auditPath, 'utf8'), original);
    assert.deepEqual(await readdir(auditDir), [`${sessionId}.ndjson`]);
    assert.deepEqual((await readFile(catalogCalls, 'utf8')).trim().split('\n').map(JSON.parse), [['models'], ['models']]);
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
  } finally { await first?.close(); await second?.close(); await rm(root, { recursive: true, force: true }); }
});

void test('a user frame is delivered only after stdin accepts it; cancel and write failure leave no prompt receipt', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-prompt-delivery-'));
  const auditDir = join(root, 'audit');
  const promptRecords = async (id) => (await readFile(join(auditDir, `${id}.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse)
    .filter(record => record.type === 'prompt_sent');
  const holdUserFrame = (b, onHold) => {
    const original = b.spawnProcess;
    b.spawnProcess = (exe, args, options) => {
      const child = original(exe, args, options);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, encoding, callback) => {
        const done = typeof encoding === 'function' ? encoding : callback;
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (text.includes('"event":"user"')) return onHold(chunk, done, () => write(chunk, done));
        return write(chunk, encoding, callback);
      };
      return child;
    };
  };
  const owned = [];
  try {
    const cancelled = bridge();
    owned.push(cancelled);
    cancelled.auditDir = auditDir;
    let releaseFrame;
    const held = new Promise(done => { releaseFrame = done; });
    let queued = false;
    holdUserFrame(cancelled, (_chunk, done, write) => {
      releaseFrame(error => {
        if (error) { done(error); return; }
        queued = true;
        write();
      });
      return true;
    });
    const cancelledId = await session(cancelled);
    const pending = turn(cancelled, cancelledId, 'must-not-record', []);
    pending.catch(() => {});
    const deliver = await held;
    const stopping = cancelled.cancel({ sessionId: cancelledId });
    deliver(Object.assign(new Error('stdin closed'), { code: 'EPIPE' }));
    assert.deepEqual(await pending, { stopReason: 'cancelled' });
    await stopping;
    assert.equal(queued, false);
    assert.deepEqual(await promptRecords(cancelledId), []);
    const types = (await readFile(join(auditDir, `${cancelledId}.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse).map(record => record.type);
    assert.equal(types.includes('launch'), true);
    assert.equal(types.includes('prompt_sent'), false);
    await cancelled.close();

    const failed = bridge();
    owned.push(failed);
    failed.auditDir = auditDir;
    holdUserFrame(failed, (_chunk, done) => { done(Object.assign(new Error('stdin closed'), { code: 'EPIPE' })); return true; });
    const failedId = await session(failed);
    await assert.rejects(turn(failed, failedId, 'must-not-record', []), /stdin closed/);
    assert.deepEqual(await promptRecords(failedId), []);
    await failed.close();

    const accepted = bridge();
    owned.push(accepted);
    accepted.auditDir = auditDir;
    const originalAudit = accepted.audit.bind(accepted);
    let auditedAfterAccept = false;
    accepted.audit = async (target, type, data) => {
      if (type === 'prompt_sent') auditedAfterAccept = queued;
      return originalAudit(target, type, data);
    };
    holdUserFrame(accepted, (_chunk, _done, write) => { queued = true; return write(); });
    const acceptedId = await session(accepted);
    assert.equal((await turn(accepted, acceptedId, 'hello', [])).stopReason, 'end_turn');
    assert.equal(auditedAfterAccept, true);
    assert.equal((await promptRecords(acceptedId)).length, 1);
    await accepted.close();
  } finally {
    for (const item of owned) await item.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

void test('cancel and ACP close during permission setup cannot launch a late vendor process or leave its registration', async () => {
  for (const action of ['cancel', 'close']) {
    const b = bridge(); const id = await session(b);
    let ready; let release;
    const entered = new Promise(done => { ready = done; });
    const gate = new Promise(done => { release = done; });
    let launched = false; let channelClosed = false; let registrationClosed = false;
    b.spawnProcess = () => { launched = true; throw new Error('unexpected late launch'); };
    b.syncPermissionHook = async s => {
      ready(); await gate;
      s.permissionChannel = { close: async () => { channelClosed = true; } };
      s.permissionRegistration = { close: async () => { registrationClosed = true; } };
    };
    const pending = turn(b, id, 'must not be sent', []);
    pending.catch(() => {});
    await entered;
    const stopping = action === 'cancel' ? b.cancel({ sessionId: id }) : b.close();
    release();
    await stopping;
    if (action === 'cancel') assert.deepEqual(await pending, { stopReason: 'cancelled' });
    else await assert.rejects(pending, /ACP connection closed/);
    assert.equal(launched, false);
    assert.equal(channelClosed, true);
    assert.equal(registrationClosed, true);
    await b.close();
  }
});

void test('session stdio MCP uses a native plugin without replacing main, passes env and cleans up', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-mcp-agent-'));
  const b = bridge();
  const originalSpawn = b.spawnProcess;
  let launch;
  b.spawnProcess = (exe, args, options) => {
    launch = { exe, args, env: options.env };
    return originalSpawn(exe, args, options);
  };
  const mcpServers = [{
    name: 'test-server',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: [{ name: 'TEST_KEY', value: 'test-value' }],
  }];
  try {
    const id = (await b.newSession({ cwd: root, mcpServers })).sessionId;
    await turn(b, id, 'hello mcp', []);
    const pluginPath = b.session(id).mcpPlugin.path;
    assert.equal(launch.args.includes('--agent'), false);
    assert.equal(b.session(id).init.init.agent, undefined);
    const key = `KIKI_AGY_MCP_${id.replaceAll('-', '_')}_0`;
    assert.ok(launch.env[key]);
    assert.deepEqual(JSON.parse(launch.env[key]), mcpServers[0]);
    const manifest = JSON.parse(await readFile(join(pluginPath, 'plugin.json'), 'utf8'));
    assert.equal(manifest.name.length, 23);
    assert.equal(Buffer.from(manifest.name.slice(1), 'base64url').toString('hex'), id.replaceAll('-', ''));
    assert.match(`mcp_${manifest.name}_neutral-session-ping_ping`, /^[a-zA-Z0-9_-]{1,64}$/);
    for (const tool of ['kiki_MemoryRead', 'kiki_AgentNotify', 'kiki_BrowserConnections']) {
      assert.match(`mcp_${manifest.name}_kiki-harness_${tool}`, /^[a-zA-Z0-9_-]{1,64}$/);
    }
    const fileContent = await readFile(join(pluginPath, 'mcp_config.json'), 'utf8');
    assert.match(fileContent, /--mcp-stdio/);
    assert.equal(fileContent.includes('test-value'), false);
    assert.equal(b.session(id).mcpBound.size, 1);
    await b.close();
    await assert.rejects(readFile(join(pluginPath, 'plugin.json')), { code: 'ENOENT' });
  } finally {
    await b.close();
    await rm(root, { recursive: true, force: true });
  }
});

void test('a killed adapter leaves owned keys and plugin; the next session recovers only dead owners and keeps live leases and foreign edits', { timeout: 30000 }, async () => {
  const { mkdtemp, mkdir, readFile, readdir, writeFile, rm } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const { registerProjectHook, AGY_STEERING_HOOK_KEY } = await import('./agy-hook-registration.mjs');
  const root = await mkdtemp(join(tmpdir(), 'agy-killed-owner-'));
  const hookPath = join(root, '.agents', 'hooks.json');
  const handlerPath = fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url));
  const foreign = '{\n  "foreign": {"PreToolUse": []}\n}\n';
  try {
    await mkdir(join(root, '.agents'));
    await writeFile(hookPath, foreign);
    const killedSession = randomUUID();
    const script = `import { registerProjectHook, AGY_STEERING_HOOK_KEY } from ${JSON.stringify(new URL('./agy-hook-registration.mjs', import.meta.url).href)};
      import { registerProjectMcpPlugin } from ${JSON.stringify(new URL('./agy-mcp-plugin.mjs', import.meta.url).href)};
      const base = ${JSON.stringify({ cwd: root, nodePath: process.execPath, handlerPath })};
      await registerProjectHook({ ...base, sessionId: ${JSON.stringify(killedSession)} });
      await registerProjectHook({ ...base, sessionId: ${JSON.stringify(killedSession)}, key: AGY_STEERING_HOOK_KEY, args: ['--steering'] });
      const plugin = await registerProjectMcpPlugin({ cwd: base.cwd, sessionId: ${JSON.stringify(killedSession)}, nodePath: base.nodePath, handlerPath: base.handlerPath, servers: [{ name: 'fixture', command: base.nodePath, args: [], env: [] }] });
      await plugin.beforeLaunch(); await plugin.launched(process.pid);
      process.stdout.write('READY\\n'); setInterval(() => {}, 1000);`;
    const killed = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((done, reject) => { killed.once('error', reject); killed.stdout.once('data', done); });
    killed.kill('SIGKILL');
    await new Promise(done => killed.once('close', done));
    const leftover = JSON.parse(await readFile(hookPath, 'utf8'));
    assert.ok(leftover['kiki-agy-permission-bridge'] && leftover[AGY_STEERING_HOOK_KEY]);
    assert.equal((await readdir(join(root, '.agents', 'plugins'))).length, 1);
    const live = await registerProjectHook({ cwd: root, nodePath: process.execPath, handlerPath, sessionId: 'live-other-session', key: AGY_STEERING_HOOK_KEY, args: ['--steering'] });
    const auditDir = join(root, 'audit');
    const b = new AgyBridge({ cliPath: process.execPath, cliPrefix: [fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url))], auditDir });
    try {
      const id = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
      const after = JSON.parse(await readFile(hookPath, 'utf8'));
      assert.equal(Object.hasOwn(after, 'kiki-agy-permission-bridge'), false);
      assert.ok(after[AGY_STEERING_HOOK_KEY], 'the live session lease keeps the shared steering key');
      assert.deepEqual(after.foreign, { PreToolUse: [] });
      await assert.rejects(readFile(join(root, '.agents', '.kiki-agy-hook-ownership.json')), { code: 'ENOENT' });
      assert.deepEqual(await readdir(join(root, '.agents', 'plugins')), []);
      const records = (await readFile(join(auditDir, `${id}.ndjson`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.ok(records.some(record => record.type === 'owned_recovery'));
    } finally { await b.close(); }
    await live.close();
    assert.equal(await readFile(hookPath, 'utf8'), foreign);
  } finally { await rm(root, { recursive: true, force: true }); }
});

void test('native MCP plugin ownership preserves conflicts and edits, isolates sessions and recovers only dead leases', async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const { registerProjectMcpPlugin, recoverProjectMcpPlugin } = await import('./agy-mcp-plugin.mjs');
  const root = await mkdtemp(join(tmpdir(), 'agy-plugin-owner-'));
  const options = id => ({ cwd: root, sessionId: id, nodePath: process.execPath,
    handlerPath: fileURLToPath(new URL('./agy-cli-acp.mjs', import.meta.url)),
    servers: [{ name: 'fixture', command: process.execPath, args: [], env: [{ name: 'FIXTURE_SECRET', value: 'private-fixture-value' }] }] });
  try {
    const firstId = randomUUID();
    const first = await registerProjectMcpPlugin(options(firstId));
    const second = await registerProjectMcpPlugin(options(randomUUID()));
    assert.equal((await recoverProjectMcpPlugin({ cwd: root, sessionId: firstId })).status, 'owned-session-still-live');
    assert.equal((await readFile(join(first.path, '.kiki-mcp-owner.json'), 'utf8')).includes('private-fixture-value'), false);
    assert.equal((await readFile(join(first.path, 'plugin.json'), 'utf8')).includes('enabled'), false);
    await assert.rejects(registerProjectMcpPlugin(options(firstId)), /already exists/);
    const original = await readFile(join(first.path, 'plugin.json'), 'utf8');
    await writeFile(join(first.path, 'plugin.json'), 'user edit');
    await assert.rejects(first.close(), /plugin changed/);
    assert.equal(await readFile(join(first.path, 'plugin.json'), 'utf8'), 'user edit');
    await writeFile(join(first.path, 'plugin.json'), original);
    await first.close();
    assert.ok(await readFile(join(second.path, 'plugin.json')));
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((done, reject) => { dead.once('error', reject); dead.once('close', done); });
    const receiptPath = join(second.path, '.kiki-mcp-owner.json');
    const state = JSON.parse(await readFile(receiptPath, 'utf8'));
    state.adapterPid = dead.pid;
    state.phase = 'launching';
    await writeFile(receiptPath, JSON.stringify(state));
    assert.equal((await recoverProjectMcpPlugin({ cwd: root, sessionId: state.sessionId })).status, 'native-launch-identity-unconfirmed');
    state.phase = 'launched'; state.nativePid = dead.pid;
    await writeFile(receiptPath, JSON.stringify(state));
    await writeFile(join(second.path, 'user.txt'), 'keep');
    await assert.rejects(recoverProjectMcpPlugin({ cwd: root, sessionId: state.sessionId }), /foreign files/);
    assert.equal(await readFile(join(second.path, 'user.txt'), 'utf8'), 'keep');
    await rm(join(second.path, 'user.txt'));
    assert.equal((await recoverProjectMcpPlugin({ cwd: root, sessionId: state.sessionId })).status, 'owned-registration-recovered');
    await assert.rejects(readFile(receiptPath), { code: 'ENOENT' });
    const userId = randomUUID();
    const userPath = join(root, '.agents', 'plugins', `k${Buffer.from(userId.replaceAll('-', ''), 'hex').toString('base64url')}`);
    await mkdir(userPath);
    await writeFile(join(userPath, 'plugin.json'), '{"disabled":true}');
    await assert.rejects(registerProjectMcpPlugin(options(userId)), /already exists/);
    assert.equal(await readFile(join(userPath, 'plugin.json'), 'utf8'), '{"disabled":true}');
  } finally { await rm(root, { recursive: true, force: true }); }
});

void test('unbound native stdio bootstrap is healthy and empty even with a different session lease in the environment', async () => {
  const script = fileURLToPath(new URL('./agy-cli-acp.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--mcp-stdio', 'KIKI_AGY_MCP_aaaaaaaa_0'], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, KIKI_AGY_MCP_bbbbbbbb_0: JSON.stringify({ command: 'must-not-launch', args: [], env: [] }) } });
  let output = ''; let stderr = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const ended = new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'foreign' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  assert.equal(await ended, 0, stderr);
  const frames = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames[0].result.protocolVersion, '2025-03-26');
  assert.deepEqual(frames[1].result, { tools: [] });
  assert.equal(frames[2].error.code, -32601);
  assert.equal(stderr, '');
});

void test('MCP off does not register a plugin and native disabled discovery never falls back to a custom agent', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'agy-plugin-off-'));
  const b = bridge();
  const spawnProcess = b.spawnProcess;
  b.spawnProcess = (exe, args, options) => spawnProcess(exe, args, { ...options, env: { ...options.env, AGY_FIXTURE_MCP_OFF: '1' } });
  try {
    const off = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
    assert.equal((await turn(b, off, 'hello', [])).stopReason, 'end_turn');
    assert.equal(b.session(off).mcpPlugin, undefined);
    const disabled = (await b.newSession({ cwd: root, mcpServers: [{ name: 'fixture', command: process.execPath, args: [], env: [] }] })).sessionId;
    await assert.rejects(turn(b, disabled, 'hello', []), /did not activate/);
    assert.equal(launchArgs(b.session(disabled)).includes('--agent'), false);
    b.spawnProcess = (exe, args, options) => spawnProcess(exe, args, { ...options, env: { ...options.env, AGY_FIXTURE_MCP_OFF: 'ready' } });
    const unready = (await b.newSession({ cwd: root, mcpServers: [{ name: 'fixture', command: process.execPath, args: [], env: [] }] })).sessionId;
    await assert.rejects(turn(b, unready, 'hello', []), /did not activate and initialize/);
    assert.equal(b.session(unready).mcpBound.size, 1); assert.equal(b.session(unready).mcpReady.size, 0);
    await b.close();
    await assert.rejects(readFile(join(b.session(disabled).mcpPlugin.path, 'plugin.json')), { code: 'ENOENT' });
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});

void test('session bootstrap reports readiness only after its actual stdio consumer lists target tools', async () => {
  const { Client } = await import(pathToFileURL(createRequire(new URL('../../packages/agent-core-v2/package.json', import.meta.url)).resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(createRequire(new URL('../../packages/agent-core-v2/package.json', import.meta.url)).resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  const { mkdtemp, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'agy-bootstrap-ready-'));
  const b = bridge();
  const script = `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',l=>{const q=JSON.parse(l);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'neutral',version:'1'}}:{tools:[{name:'ping',inputSchema:{type:'object'}}]};console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});`;
  const id = (await b.newSession({ cwd: root, mcpServers: [{ name: 'fixture', command: process.execPath, args: ['-e', script], env: [] }] })).sessionId;
  const s = b.session(id); const client = new Client({ name: 'neutral-consumer', version: '1' });
  try {
    await b.syncPermissionHook(s); await b.registerMcpPlugin(s);
    assert.equal((await b.bindMcpBootstrap(s, { type: 'mcp_ready', key: Object.keys(s.mcpPlugin.env)[0] })).decision, 'deny');
    const key = Object.keys(s.mcpPlugin.env)[0];
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./agy-cli-acp.mjs', import.meta.url)), '--mcp-stdio', key], env: { ...process.env, ...s.permissionIdentity, ...s.mcpPlugin.env } }));
    assert.equal(s.mcpBound.size, 1); assert.equal(s.mcpReady.size, 0);
    assert.equal((await client.listTools()).tools[0].name, 'ping');
    assert.equal(s.mcpReady.size, 1);
  } finally { await client.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

void test('agy models columns are raw ids; a listed id can be selected and an unknown or conflicting id cannot', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { vendorModelIds, configOptions } = await import('./agy-cli-acp.mjs');
  const output = 'model                         label\nfixture-alpha-high       Fixture Alpha (High)\nfixture-beta-medium     Fixture Beta (Medium)\n';
  assert.deepEqual(vendorModelIds(output), ['fixture-alpha-high', 'fixture-beta-medium']);
  assert.equal(vendorModelIds(output).includes('not-a-vendor-model'), false);
  assert.deepEqual(vendorModelIds('model\n# comment\n'), []);

  function catalogSpawn(stdout, { code = 0, stderr = '' } = {}) {
    const calls = [];
    const spawnProcess = (cmd, args) => {
      calls.push({ cmd, args });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null);
      queueMicrotask(() => {
        child.stdout.end(Buffer.from(stdout));
        child.stderr.end(Buffer.from(stderr));
        child.emit('close', code);
      });
      return child;
    };
    return { spawnProcess, calls };
  }

  const quiet = catalogSpawn(output);
  const untouched = new AgyBridge({ cliPath: 'C:/vendor/agy.exe', spawnProcess: quiet.spawnProcess, stopProcess: async () => {} });
  await untouched.newSession({ cwd, mcpServers: [] });
  assert.equal(quiet.calls.length, 0);
  await untouched.close();

  const listed = catalogSpawn(output);
  const bridge = new AgyBridge({ cliPath: 'C:/vendor/agy.exe', model: 'engine-default', spawnProcess: listed.spawnProcess, stopProcess: async () => {} });
  await bridge.loadVendorModels();
  assert.deepEqual(listed.calls, [{ cmd: 'C:/vendor/agy.exe', args: ['models'] }]);
  const id = (await bridge.newSession({ cwd, mcpServers: [] })).sessionId;
  const options = configOptions(bridge.session(id));
  assert.equal(options[0].id, 'effort');
  assert.equal(options[0].category, 'thought_level');
  assert.equal(options[1].id, 'model');
  assert.equal(options[1].category, 'model');
  assert.deepEqual(options[1].options.map(option => option.value), ['engine-default', 'fixture-alpha-high', 'fixture-beta-medium']);
  bridge.setConfig({ sessionId: id, configId: 'model', value: 'fixture-alpha-high' });
  assert.equal(launchArgs(bridge.session(id))[launchArgs(bridge.session(id)).indexOf('--model') + 1], 'fixture-alpha-high');
  assert.throws(() => bridge.setConfig({ sessionId: id, configId: 'model', value: 'not-a-vendor-model' }), /not in the vendor catalog/);
  assert.equal(bridge.session(id).model, 'fixture-alpha-high');
  assert.throws(() => bridge.setConfig({ sessionId: id, configId: 'effort', value: 'max' }), /conflicts with effort/);
  bridge.setConfig({ sessionId: id, configId: 'model', value: 'engine-default' });
  assert.equal(launchArgs(bridge.session(id)).includes('--model'), false);
  bridge.session(id).child = { pid: 1 };
  assert.throws(() => bridge.setConfig({ sessionId: id, configId: 'model', value: 'fixture-beta-medium' }), /frozen/);
  bridge.session(id).child = undefined;
  await bridge.close();

  const failed = catalogSpawn('', { code: 1, stderr: 'token sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' });
  const blind = new AgyBridge({ cliPath: 'C:/vendor/agy.exe', spawnProcess: failed.spawnProcess, stopProcess: async () => {} });
  await blind.loadVendorModels();
  assert.equal(blind.modelChoices, undefined);
  assert.equal(blind.modelDiagnostic, 'AGY model catalog probe failed');
  const blindId = (await blind.newSession({ cwd, mcpServers: [] })).sessionId;
  assert.equal(configOptions(blind.session(blindId)).some(option => option.category === 'model'), false);
  assert.throws(() => blind.setConfig({ sessionId: blindId, configId: 'model', value: 'fixture-alpha-high' }), /catalog is unavailable/);
  await blind.close();

  const empty = catalogSpawn('model\n');
  const none = new AgyBridge({ cliPath: 'C:/vendor/agy.exe', spawnProcess: empty.spawnProcess, stopProcess: async () => {} });
  await none.loadVendorModels();
  assert.deepEqual(none.modelChoices, []);
  const noneId = (await none.newSession({ cwd, mcpServers: [] })).sessionId;
  assert.deepEqual(configOptions(none.session(noneId)).find(option => option.id === 'model').options, []);
  assert.throws(() => none.setConfig({ sessionId: noneId, configId: 'model', value: 'fixture-alpha-high' }), /not in the vendor catalog/);
  none.setConfig({ sessionId: noneId, configId: 'model', value: 'engine-default' });
  await none.close();
});


void test('native MCP load retains the exact compact or legacy namespace from its own audit', async () => {
  const { mkdtemp, readFile, rm, appendFile } = await import('node:fs/promises');
  for (const legacy of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'agy-mcp-load-'));
    const auditDir = join(root, 'audit');
    const first = bridge('gemini-3.8-flash-medium'); first.auditDir = auditDir;
    const loaded = bridge('gemini-3.8-flash-medium'); loaded.auditDir = auditDir;
    const mcpServers = [{ name: 'fixture', command: process.execPath, args: [], env: [] }];
    const id = (await first.newSession({ cwd: root, mcpServers })).sessionId;
    if (legacy) first.session(id).mcpNamespace = `kiki-acp-${id}`;
    try {
      await turn(first, id, 'initial fixture', []);
      const namespace = first.session(id).mcpPlugin.name;
      await first.close();
      await loaded.loadSession({ sessionId: id, cwd: root, mcpServers });
      assert.equal(loaded.session(id).mcpNamespace, namespace);
      await turn(loaded, id, 'continued fixture', []);
      assert.equal(loaded.session(id).mcpPlugin.name, namespace);
      assert.equal(launchArgs(loaded.session(id)).includes('--agent'), false);
      await loaded.close();
      const auditPath = join(auditDir, `${id}.ndjson`);
      const registrations = (await readFile(auditPath, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.type === 'mcp_plugin_registered');
      assert.deepEqual(registrations.map(row => row.name), [namespace, namespace]);
      await appendFile(auditPath, JSON.stringify({ type: 'mcp_plugin_registered', servers: ['fixture'] }) + '\n');
      const missing = bridge(); missing.auditDir = auditDir;
      await assert.rejects(missing.loadSession({ sessionId: id, cwd: root, mcpServers }), /no audited MCP plugin namespace/);
      await missing.close();
      await assert.rejects(readFile(join(auditDir, `${id}.resume-lock`)), { code: 'ENOENT' });
    } finally { await first.close(); await loaded.close(); await rm(root, { recursive: true, force: true }); }
  }
});

void test('legacy MCP recovery preserves live leases, validates namespaces and recovers only the exact owned plugin', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const { registerProjectMcpPlugin, recoverProjectMcpPlugin } = await import('./agy-mcp-plugin.mjs');
  const root = await mkdtemp(join(tmpdir(), 'agy-legacy-plugin-'));
  const sessionId = randomUUID();
  const options = { cwd: root, sessionId, namespace: `kiki-acp-${sessionId}`, nodePath: process.execPath,
    handlerPath: fileURLToPath(new URL('./agy-cli-acp.mjs', import.meta.url)), servers: [] };
  try {
    await assert.rejects(registerProjectMcpPlugin({ ...options, namespace: `kiki-acp-${randomUUID()}` }), /does not match its owning session/);
    await assert.rejects(registerProjectMcpPlugin({ ...options, sessionId: '-'.repeat(36) }), /Invalid AGY MCP session ID/);
    const legacy = await registerProjectMcpPlugin(options);
    assert.equal((await recoverProjectMcpPlugin({ cwd: root, sessionId })).status, 'owned-session-still-live');
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((done, reject) => { dead.once('error', reject); dead.once('close', done); });
    const receiptPath = join(legacy.path, '.kiki-mcp-owner.json');
    const state = JSON.parse(await readFile(receiptPath, 'utf8'));
    state.adapterPid = dead.pid;
    await writeFile(receiptPath, JSON.stringify(state));
    const compact = await registerProjectMcpPlugin({ ...options, namespace: undefined });
    await assert.rejects(recoverProjectMcpPlugin({ cwd: root, sessionId }), /Multiple AGY MCP ownership receipts/);
    await compact.close();
    assert.deepEqual(await recoverProjectMcpPlugin({ cwd: root, sessionId }), { status: 'owned-registration-recovered', path: legacy.path });
    await assert.rejects(readFile(receiptPath), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});


void test('session MCP bootstrap closes after spawn failure or early exit even while its caller keeps stdin open', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  for (const missing of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), 'agy-bootstrap-exit-'));
    const b = bridge();
    let child;
    try {
      const id = (await b.newSession({ cwd: root, mcpServers: [{ name: 'fixture', command: missing ? join(root, 'missing-cli.exe') : process.execPath, args: missing ? [] : ['-e', 'process.exit(7)'], env: [] }] })).sessionId;
      const s = b.session(id);
      await b.syncPermissionHook(s); await b.registerMcpPlugin(s);
      const key = Object.keys(s.mcpPlugin.env)[0];
      child = spawn(process.execPath, [fileURLToPath(new URL('./agy-cli-acp.mjs', import.meta.url)), '--mcp-stdio', key], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...s.permissionIdentity, ...s.mcpPlugin.env } });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const ended = new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
      const timer = setTimeout(() => { child.kill(); }, 5000);
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
        assert.equal(await ended, missing ? 1 : 7);
        assert.equal(stdout, '');
        if (missing) assert.match(stderr, /spawn .*missing-cli\.exe ENOENT/);
        else assert.equal(stderr, '');
        assert.equal(s.mcpBound.size, 1);
        assert.equal(s.mcpReady.size, 0);
      } finally { clearTimeout(timer); }
    } finally { child?.stdin.destroy(); await b.close(); await rm(root, { recursive: true, force: true }); }
  }
});
