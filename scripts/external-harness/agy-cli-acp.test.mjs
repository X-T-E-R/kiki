import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgyBridge, consumeAccountEnvironment, launchArgs, promptText } from './agy-cli-acp.mjs';

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

void test('one-time native SessionStart guidance explains rg stdin without gating or rewriting tools', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { commandGuidanceHookOutput } = await import('./agy-permission-hook.mjs');
  const root = await mkdtemp(join(tmpdir(), 'agy-guidance-'));
  const b = bridge(); let launches = 0;
  const originalSpawn = b.spawnProcess;
  b.spawnProcess = (...args) => { launches++; return originalSpawn(...args); };
  try {
    assert.deepEqual(commandGuidanceHookOutput({}), {});
    const id = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
    const messages = [];
    assert.deepEqual(await turn(b, id, 'command-guidance', messages), { stopReason: 'end_turn' });
    const output = JSON.parse(messages.find(message => message.update.sessionUpdate === 'agent_message_chunk').update.content.text);
    assert.deepEqual(Object.keys(output), ['injectSteps']);
    assert.match(output.injectSteps[0].systemMessage.systemMessage, /rg -n "pattern" \./);
    assert.match(output.injectSteps[0].systemMessage.systemMessage, /explicit - input path/);
    assert.equal(launches, 1);
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    await turn(b, id, 'same session', []);
    assert.equal(launches, 1);
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});

void test('guidance is absent on continuation, permission restart and exact native load; foreign hook off choices survive', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'agy-guidance-resume-'));
  const path = join(root, '.agents', 'hooks.json');
  await mkdir(join(root, '.agents'));
  const original = '{\r\n  "foreign": { "enabled": false, "SessionStart": [] }\r\n}\r\n';
  await writeFile(path, original);
  const b = bridge('fixture-alpha-high'); b.auditDir = join(root, 'audit');
  let loaded;
  const registrations = [];
  const register = b.registerSteeringHook.bind(b);
  b.registerSteeringHook = async s => {
    await register(s);
    registrations.push(Boolean(s.commandGuidanceRegistration));
    assert.equal(JSON.parse(await readFile(path, 'utf8')).foreign.enabled, false);
  };
  try {
    const id = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
    await turn(b, id, 'first', []);
    await turn(b, id, 'continuation', []);
    await b.setConfig({ sessionId: id, configId: 'permission-mode', value: 'manual' });
    await turn(b, id, 'same conversation after restart', []);
    assert.deepEqual(registrations, [true, false, false]);
    await b.close();
    assert.equal(await readFile(path, 'utf8'), original);
    loaded = bridge('fixture-alpha-high'); loaded.auditDir = b.auditDir;
    await loaded.loadSession({ sessionId: id, cwd: root, mcpServers: [] });
    const resumedRegister = loaded.registerSteeringHook.bind(loaded);
    loaded.registerSteeringHook = async s => {
      await resumedRegister(s);
      assert.equal(s.commandGuidanceRegistration, undefined);
      assert.equal(JSON.parse(await readFile(path, 'utf8'))['kiki-agy-command-guidance'], undefined);
    };
    await turn(loaded, id, 'loaded', []);
    await loaded.close();
    assert.equal(await readFile(path, 'utf8'), original);
  } finally { await b.close(); await loaded?.close(); await rm(root, { recursive: true, force: true }); }
});

void test('an explicit native command-guidance off choice stays off without blocking launch', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'agy-guidance-off-'));
  const path = join(root, '.agents', 'hooks.json');
  await mkdir(join(root, '.agents'));
  const original = '{"kiki-agy-command-guidance":{"enabled":false}}\n';
  await writeFile(path, original);
  const b = bridge();
  const register = b.registerSteeringHook.bind(b);
  b.registerSteeringHook = async s => {
    await register(s);
    assert.equal(s.commandGuidanceRegistration, undefined);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8'))['kiki-agy-command-guidance'], { enabled: false });
  };
  try {
    const id = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
    assert.deepEqual(await turn(b, id, 'hello', []), { stopReason: 'end_turn' });
    assert.equal(await readFile(path, 'utf8'), original);
    await assert.rejects(readFile(join(root, '.agents', '.kiki-agy-command-guidance-ownership.json')), { code: 'ENOENT' });
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});

void test('launch maps engine-default, manual, auto and yolo to exact native argv', () => {
  const base = { model: 'engine-default', effort: 'engine-default', additionalDirectories: [] };
  assert.deepEqual(launchArgs(base), ['--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert.deepEqual(launchArgs({ ...base, permissionMode: 'manual' }), [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--settings',
    JSON.stringify({ toolPermission: 'request-review', agentMode: 'default' }),
  ]);
  assert.deepEqual(launchArgs({ ...base, permissionMode: 'auto' }), [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--settings',
    JSON.stringify({ toolPermission: 'request-review', agentMode: 'auto' }),
  ]);
  assert.deepEqual(launchArgs({ ...base, permissionMode: 'yolo' }), [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--settings',
    JSON.stringify({ toolPermission: 'always-proceed', agentMode: 'accept-edits', allowNonWorkspaceAccess: true, enableTerminalSandbox: false }),
  ]);
  assert.deepEqual(launchArgs({ ...base, permissionMode: 'engine-default' }), launchArgs(base));
});

void test('the shipped bridge advertises plugin-account support without changing its ordinary version', () => {
  const entry = fileURLToPath(new URL('./agy-cli-acp.mjs', import.meta.url));
  for (const flag of ['--version', '--kiki-harness-account-version']) {
    const result = spawnSync(process.execPath, [entry, flag], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'agy-cli-acp 0.2.0');
  }
});

void test('account launch data is consumed once and cannot fall through to the global bridge', () => {
  const env = { GEMINI_API_KEY: 'fixture-capability', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9999',
    KIKI_AGY_ACCOUNT_MODELS: '["fixture-model"]', AGY_CLI_PATH: 'unchanged' };
  assert.deepEqual(consumeAccountEnvironment(env), { apiKey: 'fixture-capability', baseUrl: 'http://127.0.0.1:9999', modelIds: ['fixture-model'] });
  assert.deepEqual(env, { AGY_CLI_PATH: 'unchanged' });
  assert.throws(() => consumeAccountEnvironment(env), /no global AGY fallback/);
});

void test('review permission mode is explicitly unsupported rather than silently mapped', async () => {
  const b = bridge(); const id = await session(b);
  try { await assert.rejects(b.setConfig({ sessionId: id, configId: 'permission-mode', value: 'review' }), /unsupported/); }
  finally { await b.close(); }
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
    await b.setConfig({ sessionId: id, configId: 'effort', value: 'high' });
    assert.equal((await turn(b, id, 'writer fixture', [])).stopReason, 'end_turn');
    assert.equal(resolve(b.session(id).init.init.cwd), resolve(writer));
    assert.equal(launch.cwd, writer);
    assert.deepEqual(launch.args.slice(1), ['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--model', 'claude-opus-5-5-high', '--add-dir', materials]);
    assert.equal(process.cwd(), parentCwd);
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
    await b.setConfig({ sessionId: id, configId: 'effort', value: 'medium' });
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
      const report = () => process.stderr.write(errors[name] ?? '', () => {
        if (name !== 'hang') process.exit(1);
      });
      if (name === 'hang' || name === 'tool-lost') {
        process.stdout.write(JSON.stringify({ event: 'step_update', conversation_id: name,
          step_update: { step_type: 'tool', step_index: 1, state: 'ACTIVE', tool_name: 'run_command' } }) + '\\n', report);
      } else report();
    });
    process.stdin.once('end', () => process.exit(0));
    process.stdin.resume();
  `;
  const adapterScript = `import { runBridge } from ${JSON.stringify(new URL('./agy-cli-acp.mjs', import.meta.url).href)}; await runBridge(${JSON.stringify({ sdkPath, cliPath: process.execPath, cliPrefix: ['-e', vendorScript, '--'] })});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', adapterScript], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
  const responses = new Map();
  const updates = [];
  let cancellationReady;
  const ready = new Promise(done => { cancellationReady = done; });
  child.stderr.resume();
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.method === 'session/update') {
      updates.push(frame.params);
      if (frame.params.update.toolCallId === 'agy-hang-1' && frame.params.update.sessionUpdate === 'tool_call') cancellationReady();
    }
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
    for (const name of ['known', 'secret', 'empty', 'bounded', 'truncated', 'hang', 'tool-lost']) ids[name] = (await request('session/new', { cwd, mcpServers: [] })).result.sessionId;
    const failed = await Promise.all(['known', 'secret', 'empty', 'bounded', 'truncated', 'tool-lost'].map(async name => {
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
    assert.match(errors['tool-lost'].message, /execution state is unknown; do not replay/);
    assert.equal(errors['tool-lost'].data.details.unresolvedTools[0].toolCallId, 'agy-tool-lost-1');
    const pending = request('session/prompt', { sessionId: ids.hang, prompt: [{ type: 'text', text: 'hang' }] });
    await ready;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: ids.hang } }) + '\n');
    assert.equal((await pending).result.stopReason, 'cancelled');
    for (const name of ['tool-lost', 'hang']) {
      const terminal = updates.filter(event => event.sessionId === ids[name] && event.update.sessionUpdate === 'tool_call_update');
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].update.status, 'failed');
      assert.match(terminal[0].update.content[0].content.text, /execution state is unknown; do not replay/);
      assert.equal(terminal[0].update.toolCallId, `agy-${name}-1`);
    }
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

void test('cancellation retains tool terminals already received behind an ACP notification', { timeout: 10000 }, async () => {
  const b = bridge(); const id = await session(b);
  let release;
  const blocked = new Promise(done => { release = done; });
  let received;
  const buffered = new Promise(done => { received = done; });
  b.audit = async (_session, type, data) => {
    if (type === 'native_frame_received' && data.event === 'result') received();
  };
  const messages = [];
  const pending = b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'background-events' }] }, {
    notify: async (_method, event) => {
      messages.push(event.update);
      if (event.update.sessionUpdate === 'tool_call') await blocked;
    },
  });
  pending.catch(() => {});
  try {
    await Promise.race([buffered, pending]);
    const cancelled = b.cancel({ sessionId: id });
    release();
    await cancelled;
    assert.deepEqual(await pending, { stopReason: 'cancelled' });
    assert.deepEqual(messages.filter(update => update.sessionUpdate === 'tool_call_update').map(update => [update.toolCallId, update.status, update.rawOutput]), [
      ['agy-fixture-conversation-52', 'failed', 'native failure'],
      ['agy-fixture-conversation-42', 'completed', 'native output'],
    ]);
    assert.deepEqual(messages.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content.text), ['native final']);
  } finally { release(); await b.close(); }
});

void test('cancellation during final message delivery cannot publish terminal success', { timeout: 10000 }, async () => {
  const b = bridge(); const id = await session(b);
  let release;
  const blocked = new Promise(done => { release = done; });
  let delivering;
  const ready = new Promise(done => { delivering = done; });
  const pending = b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'command-guidance' }] }, {
    notify: async () => { delivering(); await blocked; },
  });
  pending.catch(() => {});
  try {
    await Promise.race([ready, pending]);
    const cancelled = b.cancel({ sessionId: id });
    release();
    await cancelled;
    assert.deepEqual(await pending, { stopReason: 'cancelled' });
  } finally { release(); await b.close(); }
});

void test('a failed cancellation retains unknown execution and rejects its prompt instead of claiming process exit', async () => {
  const b = new AgyBridge({ cliPath: process.execPath, cliPrefix: [fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url))] });
  const id = await session(b);
  let started;
  const ready = new Promise(done => { started = done; });
  const messages = [];
  const records = [];
  b.audit = async (_session, type, data) => { records.push({ type, ...data }); };
  const pending = b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'tool-hang' }] }, {
    notify: async (_method, event) => { messages.push(event); if (event.update?.sessionUpdate === 'tool_call') started(); },
  });
  pending.catch(() => {});
  await Promise.race([ready, pending]);
  const { child, cwd } = b.session(id);
  const systemRoot = process.env.SystemRoot;
  const kill = child.kill;
  let timer;
  try {
    if (process.platform === 'win32') process.env.SystemRoot = join(cwd, 'missing-system-root');
    else child.kill = () => false;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stop failure left cancellation pending')), 2000); });
    await assert.rejects(Promise.race([b.cancel({ sessionId: id }), deadline]), /Could not stop the owned AGY process/);
    await assert.rejects(pending, error => {
      assert.match(error.message, /Could not stop the owned AGY process/);
      assert.equal(error.details.unresolvedTools[0].name, 'run_command');
      return true;
    });
    assert.match(messages.at(-1).update.content[0].content.text, /execution state is unknown; do not replay/);
    assert.equal(records.some(record => record.type === 'cancel' && record.processEnded), false);
    assert.equal(records.find(record => record.type === 'cancel_failed').unresolvedTools.length, 1);
    assert.equal(child.exitCode, null);
    await assert.rejects(turn(b, id, 'again', []), /do not replay/);
  } finally {
    clearTimeout(timer);
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
    child.kill = kill;
    await b.close();
  }
});

void test('cancel still stops the owned CLI when persisting the cancellation request fails', { timeout: 10000 }, async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-cancel-audit-'));
  try {
    for (const stopFails of [false, true]) {
      const first = bridge('fixture-alpha-high'); first.auditDir = root;
      const loaded = bridge('fixture-alpha-high'); loaded.auditDir = root;
      const params = { cwd: root, mcpServers: [] };
      const id = (await first.newSession(params)).sessionId;
      const diskFull = Object.assign(new Error('cancel_requested append failed'), { code: 'ENOSPC' });
      const stopFailure = Object.assign(new Error('owned stopper failed'), { code: 'FIXTURE_STOP_FAILED' });
      const stop = first.stopProcess;
      let stops = 0;
      first.stopProcess = async child => {
        stops++;
        assert.equal(child, first.session(id).child);
        if (stopFails) throw stopFailure;
        await stop(child);
      };
      let received, release, writingFailure, releaseAudit;
      const buffered = new Promise(done => { received = done; });
      const blocked = new Promise(done => { release = done; });
      const beforeFailureRecord = new Promise(done => { writingFailure = done; });
      const blockedAudit = new Promise(done => { releaseAudit = done; });
      const audit = first.audit.bind(first);
      first.audit = async (session, type, data) => {
        if (type === 'cancel_requested') throw diskFull;
        if (type === 'cancel_failed') { writingFailure(); await blockedAudit; }
        await audit(session, type, data);
        if (!stopFails && type === 'native_frame_received' && data.event === 'result') received();
      };
      const updates = [];
      const pending = first.prompt({ sessionId: id, prompt: [{ type: 'text', text: stopFails ? 'tool-hang' : 'background-events' }] }, {
        notify: async (_method, event) => {
          updates.push(event.update);
          if (event.update.sessionUpdate === 'tool_call') { if (stopFails) received(); await blocked; }
        },
      });
      pending.catch(() => {});
      let cancelled;
      try {
        await Promise.race([buffered, pending]);
        cancelled = first.cancel({ sessionId: id }).catch(error => error);
        release();
        await Promise.race([beforeFailureRecord, cancelled]);
        assert.equal(stops, 1);
        assert.equal(first.session(id).child.exitCode, stopFails ? null : 0);
        if (!stopFails) await assert.rejects(loaded.loadSession({ ...params, sessionId: id }), { code: 'AGY_SESSION_UNCONFIRMED' });
        releaseAudit();
        assert.equal(await cancelled, diskFull);
        await assert.rejects(pending, error => {
          assert.equal(error, diskFull);
          assert.equal(error.message, 'cancel_requested append failed');
          assert.equal(error.details.processEnded, !stopFails);
          assert.equal(error.details.exitCode, stopFails ? null : 0);
          return true;
        });
        const terminals = updates.filter(update => update.sessionUpdate === 'tool_call_update');
        if (stopFails) {
          assert.deepEqual(diskFull.details.cancelError, { code: stopFailure.code, message: stopFailure.message });
          assert.match(terminals[0].content[0].content.text, /execution state is unknown; do not replay/);
        } else {
          assert.deepEqual(terminals.map(update => [update.status, update.rawOutput]), [['failed', 'native failure'], ['completed', 'native output']]);
          await assert.rejects(loaded.loadSession({ ...params, sessionId: id }), { code: 'AGY_SESSION_RETIRED' });
        }
        const records = (await readFile(join(root, `${id}.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(records.find(record => record.type === 'cancel_failed').processEnded, !stopFails);
        assert.equal(records.some(record => record.type === 'cancel_requested' || record.type === 'cancel'), false);
      } finally { release(); releaseAudit(); await cancelled; first.stopProcess = stop; await first.close(); await loaded.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

void test('a failed stop drains queued native tool terminals without waiting for the live child', { timeout: 10000 }, async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  const child = new EventEmitter();
  Object.assign(child, { pid: process.pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
  const tool = (step_index, state, output) => ({ event: 'step_update', conversation_id: 'stop-race',
    step_update: { step_type: 'tool', step_index, tool_name: 'run_command', state, tool_info: { output } } });
  const emit = (...frames) => child.stdout.write(frames.map(JSON.stringify).join('\n') + '\n');
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      queueMicrotask(() => emit({ event: 'init', conversation_id: 'stop-race', init: { cwd } },
        tool(1, 'ACTIVE'), tool(1, 'ERROR', 'authoritative native failure'), tool(2, 'ACTIVE'),
        { event: 'result', result: { conversation_id: 'stop-race', status: 'ERROR', error: 'native turn failure' } }));
      done();
    },
    final(done) { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0, null)); done(); },
  });
  const b = bridge(); const id = await session(b);
  b.spawnProcess = () => child;
  let attempted;
  const stopAttempt = new Promise(done => { attempted = done; });
  b.stopProcess = async () => { attempted(); throw new Error('injected stop failure while child is alive'); };
  let release, received;
  const blocked = new Promise(done => { release = done; });
  const buffered = new Promise(done => { received = done; });
  const records = [];
  b.audit = async (_session, type, data) => {
    records.push({ type, ...data });
    if (type === 'native_frame_received' && data.event === 'result') received();
  };
  const messages = [];
  const pending = b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'fixture frame only' }] }, {
    notify: async (_method, event) => {
      messages.push(event.update);
      if (event.update.sessionUpdate === 'tool_call' && event.update.toolCallId === 'agy-stop-race-1') await blocked;
    },
  });
  pending.catch(() => {});
  try {
    await Promise.race([buffered, pending]);
    const cancelled = assert.rejects(b.cancel({ sessionId: id }), /injected stop failure/);
    await stopAttempt;
    await new Promise(done => setImmediate(done));
    emit(tool(2, 'DONE', 'late frame after stop failure'));
    release();
    await cancelled;
    assert.equal(child.exitCode, null);
    const terminals = messages.filter(update => update.sessionUpdate === 'tool_call_update');
    assert.deepEqual(terminals.map(update => [update.toolCallId, update.status, update.rawOutput]), [
      ['agy-stop-race-1', 'failed', 'authoritative native failure'], ['agy-stop-race-2', 'failed', undefined],
    ]);
    assert.match(terminals[1].content[0].content.text, /execution state is unknown; do not replay/);
    await assert.rejects(pending, error => {
      assert.match(error.message, /injected stop failure/);
      assert.deepEqual(error.details.unresolvedTools.map(tool => tool.toolCallId), ['agy-stop-race-2']);
      return true;
    });
    assert.deepEqual(records.find(record => record.type === 'cancel_failed').unresolvedTools.map(tool => tool.toolCallId), ['agy-stop-race-2']);
    assert.equal(records.some(record => record.type === 'cancel'), false);
  } finally { release(); await b.close(); }
});

void test('native disconnect and invalid frames settle pending tools as execution unknown without replay', async () => {
  for (const [input, expected] of [['tool-disconnect', /exited before terminal result/], ['tool-invalid-frame', /invalid NDJSON/]]) {
    const b = bridge(); const id = await session(b); const messages = [];
    try {
      await assert.rejects(turn(b, id, input, messages), error => {
        assert.match(error.message, expected);
        assert.equal(error.details.unresolvedTools[0].name, 'run_command');
        return true;
      });
      const updates = messages.filter(message => message.update?.sessionUpdate === 'tool_call_update');
      assert.equal(updates.length, 1);
      assert.equal(updates[0].update.status, 'failed');
      assert.match(updates[0].update.content[0].content.text, /execution state is unknown; do not replay/);
      await assert.rejects(turn(b, id, 'again', []), /fresh session/);
    } finally { await b.close(); }
  }
});

void test('the captured native ERROR interrupted result is cancellation with unknown tool execution', async () => {
  const b = bridge(); const id = await session(b); const messages = [];
  try {
    assert.deepEqual(await turn(b, id, 'native-interrupted', messages), { stopReason: 'cancelled' });
    assert.match(messages.at(-1).update.content[0].content.text, /execution state is unknown; do not replay/);
    await assert.rejects(turn(b, id, 'again', []), /do not replay/);
  } finally { await b.close(); }
});

void test('cancel recovers an export-stalled fixture process without completing or rerunning its native commands', { timeout: 15000 }, async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'agy-export-stall-'));
  const b = new AgyBridge({ cliPath: process.execPath, cliPrefix: [fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url))] });
  try {
    const id = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
    let started;
    const ready = new Promise(done => { started = done; });
    const messages = [];
    const pending = b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'export-hang' }] }, {
      notify: async (_method, event) => { messages.push(event); if (event.update?.sessionUpdate === 'tool_call') started(); },
    });
    await Promise.race([ready, pending]);
    const { earlyPid, response } = JSON.parse(await readFile(join(root, 'native-export-state.json'), 'utf8'));
    assert.equal(response, 'produced but not exported');
    process.kill(earlyPid, 0);
    assert.equal(await readFile(join(root, 'native-executions.txt'), 'utf8'), 'early\nlater\n');
    const child = b.session(id).child;
    const writes = [];
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (...args) => { writes.push(args[0]); return write(...args); };
    await b.cancel({ sessionId: id });
    assert.deepEqual(await pending, { stopReason: 'cancelled' });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(earlyPid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      await new Promise(done => setTimeout(done, 10));
    }
    assert.throws(() => process.kill(earlyPid, 0), { code: 'ESRCH' });
    assert.deepEqual(writes, []);
    assert.equal(await readFile(join(root, 'native-executions.txt'), 'utf8'), 'early\nlater\n');
    assert.equal(messages.some(message => message.update?.sessionUpdate === 'agent_message_chunk'), false);
    assert.match(messages.at(-1).update.content[0].content.text, /execution state is unknown; do not replay/);
    await assert.rejects(turn(b, id, 'again', []), /fresh session/);
    const nextId = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
    const next = [];
    assert.deepEqual(await turn(b, nextId, 'new independent turn', next), { stopReason: 'end_turn' });
    assert.equal(next.some(message => message.update?.toolCallId), false);
    assert.equal(await readFile(join(root, 'native-executions.txt'), 'utf8'), 'early\nlater\n');
  } finally {
    await b.close();
    await rm(root, { recursive: true, force: true });
  }
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

void test('later native tool and text events pass an unfinished background tool without replaying commands', async () => {
  const b = bridge(); const id = await session(b); const messages = [];
  try {
    assert.equal((await turn(b, id, 'background-events', messages)).stopReason, 'end_turn');
    assert.deepEqual(messages.map(message => [message.update.sessionUpdate, message.update.toolCallId, message.update.status]), [
      ['tool_call', 'agy-fixture-conversation-42', 'in_progress'],
      ['tool_call', 'agy-fixture-conversation-52', 'in_progress'],
      ['tool_call_update', 'agy-fixture-conversation-52', 'failed'],
      ['agent_message_chunk', undefined, undefined],
      ['tool_call_update', 'agy-fixture-conversation-42', 'completed'],
    ]);
    assert.equal(messages[2].update.rawOutput, 'native failure');
    assert.equal(messages[3].update.content.text, 'native final');
    assert.equal(messages[4].update.rawOutput, 'native output');
  } finally { await b.close(); }
});

void test('ingress audit receives later frames while ACP notification is blocked', { timeout: 10000 }, async () => {
  const b = bridge(); const id = await session(b);
  let receivedResult;
  const received = new Promise(done => { receivedResult = done; });
  let release;
  const blocked = new Promise(done => { release = done; });
  const records = [];
  b.audit = async (_session, type, data) => {
    records.push({ type, ...data });
    if (type === 'native_frame_received' && data.event === 'result') receivedResult();
  };
  const messages = [];
  const pending = b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'background-events' }] }, {
    notify: async (_method, event) => {
      messages.push(event);
      if (event.update?.toolCallId === 'agy-fixture-conversation-42' && event.update.sessionUpdate === 'tool_call') await blocked;
    },
  });
  pending.catch(() => {});
  try {
    await received;
    const incoming = records.filter(record => record.type === 'native_frame_received');
    assert.deepEqual(incoming.map(record => record.sequence), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(incoming.at(-1).status, 'SUCCESS');
    assert.ok(incoming.every(record => typeof record.receivedAt === 'string'));
    assert.equal(JSON.stringify(incoming).includes('native-owned-background-command'), false);
    assert.equal(JSON.stringify(incoming).includes('native final'), false);
    assert.equal(records.some(record => record.type === 'native_frame_delivered' && record.sequence > 1), false);
    assert.equal(messages.length, 1);
    release();
    assert.deepEqual(await pending, { stopReason: 'end_turn' });
    await new Promise(done => setImmediate(done));
    assert.deepEqual(records.filter(record => record.type === 'native_frame_delivered').map(record => record.sequence), [1, 2, 3, 4, 5, 6, 7]);
  } finally { release(); await b.close(); }
});

void test('stdout limits each NDJSON frame, not a coalesced burst of later events', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  for (const size of [600_000, 1_048_577]) {
    const b = bridge(); const id = await session(b);
    const child = new EventEmitter();
    Object.assign(child, { pid: process.pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin = new Writable({
      write(_chunk, _encoding, done) {
        const frames = [
          { event: 'init', conversation_id: 'fixture-conversation', init: { cwd } },
          { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'x'.repeat(size) } },
          { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'y'.repeat(size) } },
          { event: 'result', result: { status: 'SUCCESS' } },
        ];
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(frames.map(JSON.stringify).join('\n') + '\n')));
        done();
      },
      final(done) { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0, null)); done(); },
    });
    b.spawnProcess = () => child;
    const messages = [];
    try {
      if (size > 1_048_576) await assert.rejects(turn(b, id, 'oversized', messages), /frame exceeds 1 MiB/);
      else {
        assert.deepEqual(await turn(b, id, 'burst', messages), { stopReason: 'end_turn' });
        assert.deepEqual(messages.map(message => message.update.content.text.length), [size, size]);
      }
    } finally { await b.close(); }
  }
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


void test('legacy permission metadata is inert and never installs a native tool approval hook', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'agy-legacy-permission-meta-'));
  const b = bridge();
  try {
    for (const permission of [{ hostGate: true }, { version: 2, override: { mode: 'yolo', source: 'legacy-meta' } }]) {
      const id = (await b.newSession({ cwd: root, mcpServers: [], _meta: { 'kiki.permission': permission } })).sessionId;
      const s = b.session(id);
      assert.equal(s.permissionMode ?? 'engine-default', 'engine-default');
      assert.equal((await b.requestPermission(s, { toolCall: { name: 'unknown-native-tool', args: {} } })).decision, 'ask');
      await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
      assert.equal((await turn(b, id, 'hello', [])).stopReason, 'end_turn');
      assert.deepEqual(launchArgs(s).filter(value => value === '--settings' || value === '--dangerously-skip-permissions'), []);
      await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    }
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
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


void test('fixture native tools complete real reads, writes, command, search and unknown task without Kiki approval', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'agy-native-tools-'));
  const image = Buffer.from([0, 1, 2, 127, 128, 255]);
  await writeFile(join(root, 'native-text.txt'), 'native fixture text 中文\n');
  await writeFile(join(root, 'native-image.bin'), image);
  await writeFile(join(root, 'native-edit.txt'), 'before edit\n');
  await writeFile(join(root, 'native-search.txt'), 'first\nneedle in second\nlast\n');
  const b = bridge();
  const messages = []; let permissionCalls = 0;
  b.requestPermission = async () => { permissionCalls++; return { decision: 'deny' }; };
  try {
    const id = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
    assert.equal((await turn(b, id, 'native-tools', messages)).stopReason, 'end_turn');
    assert.equal(permissionCalls, 0);
    const calls = messages.filter(message => message.update?.sessionUpdate === 'tool_call');
    assert.deepEqual(calls.map(message => message.update.title), ['read_file', 'read_file', 'write_file', 'edit_file', 'run_command', 'search', 'manage_task']);
    const updates = messages.filter(message => message.update?.sessionUpdate === 'tool_call_update');
    assert.equal(updates.length, calls.length);
    assert.equal(updates.every(message => message.update.status === 'completed'), true);
    assert.equal(updates[0].update.rawOutput, 'native fixture text 中文\n');
    assert.deepEqual(updates[1].update.rawOutput, { type: 'Buffer', data: [...image] });
    assert.equal(updates[2].update.rawOutput, 'written');
    assert.equal(updates[3].update.rawOutput, 'modified');
    assert.equal(updates[4].update.rawOutput, 'command completed');
    assert.deepEqual(updates[5].update.rawOutput, { matches: [{ line: 2, text: 'needle in second' }] });
    assert.deepEqual(updates[6].update.rawOutput, { status: 'completed', taskId: 'native-fixture-task' });
    assert.equal(await readFile(join(root, 'native-write.txt'), 'utf8'), 'native write\n');
    assert.equal(await readFile(join(root, 'native-edit.txt'), 'utf8'), 'after edit\n');
    assert.equal(await readFile(join(root, 'native-command.txt'), 'utf8'), 'command output\n');
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});


void test('permission mode changes refuse active turns and hot-switch an idle native conversation', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'agy-permission-hot-switch-'));
  const b = bridge(); const launches = []; const originalSpawn = b.spawnProcess;
  b.spawnProcess = (exe, args, options) => { launches.push(args); return originalSpawn(exe, args, options); };
  try {
    const activeId = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
    await b.setConfig({ sessionId: activeId, configId: 'permission-mode', value: 'manual' });
    let started;
    const nativeTool = new Promise(done => { started = done; });
    const pending = b.prompt({ sessionId: activeId, prompt: [{ type: 'text', text: 'tool-hang' }] }, {
      notify: async (_method, event) => { if (event.update?.sessionUpdate === 'tool_call') started(); },
    });
    pending.catch(() => {});
    await nativeTool;
    await assert.rejects(b.setConfig({ sessionId: activeId, configId: 'permission-mode', value: 'auto' }), /active turn/);
    await b.cancel({ sessionId: activeId });
    assert.deepEqual(await pending, { stopReason: 'cancelled' });

    const id = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
    await b.setConfig({ sessionId: id, configId: 'permission-mode', value: 'manual' });
    assert.equal((await turn(b, id, 'hello', [])).stopReason, 'end_turn');
    const conversation = b.session(id).init.conversation_id;
    const initial = launches.at(-1);
    assert.equal(JSON.parse(initial[initial.indexOf('--settings') + 1]).agentMode, 'default');
    await b.setConfig({ sessionId: id, configId: 'permission-mode', value: 'engine-default' });
    assert.equal(b.session(id).child, undefined);
    assert.equal(b.session(id).conversationId, conversation);
    assert.equal((await turn(b, id, 'after withdraw', [])).stopReason, 'end_turn');
    const resumed = launches.at(-1);
    assert.equal(resumed[resumed.indexOf('--conversation') + 1], conversation);
    assert.equal(resumed.includes('--settings'), false);
    assert.equal(resumed.includes('--dangerously-skip-permissions'), false);
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});

void test('a live legacy permission hook lease survives native launch and still answers ask, not an empty object', async () => {
  const { mkdtemp, mkdir, readFile, rm } = await import('node:fs/promises');
  const { registerProjectHook, hookCommand } = await import('./agy-hook-registration.mjs');
  const root = await mkdtemp(join(tmpdir(), 'agy-legacy-hook-'));
  await mkdir(join(root, '.agents'));
  const handlerPath = fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url));
  const lease = await registerProjectHook({ cwd: root, nodePath: process.execPath, handlerPath, sessionId: 'other-vendor-process' });
  const b = bridge(); let permissionCalls = 0;
  b.requestPermission = async () => { permissionCalls++; return { decision: 'deny' }; };
  const command = hookCommand(process.execPath, handlerPath);
  try {
    const id = (await b.newSession({ cwd: root, mcpServers: [] })).sessionId;
    await turn(b, id, 'hello', []);
    assert.equal(permissionCalls, 0);
    const hooks = JSON.parse(await readFile(join(root, '.agents', 'hooks.json'), 'utf8'));
    assert.ok(hooks['kiki-agy-permission-bridge']);
    const shell = process.platform === 'win32' ? process.env.ComSpec : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KIKI_AGY_PERMISSION_')));
    const child = spawn(shell, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    child.stdin.end(JSON.stringify({ toolCall: { name: 'native-tool', args: {} } }));
    assert.equal(await closed, 0);
    assert.deepEqual(JSON.parse(output), { decision: 'ask' });
    await b.close();
    const after = JSON.parse(await readFile(join(root, '.agents', 'hooks.json'), 'utf8'));
    assert.ok(after['kiki-agy-permission-bridge']);
  } finally { await lease.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
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

void test('hook UTF8 split bytes preserve raw Chinese tool input through the compatibility channel', async () => {
  const { createConnection, createServer } = await import('node:net');
  const { openPermissionChannel, requestHookPermission, permissionChannelIdentity } = await import('./agy-permission-hook.mjs');
  const input = { conversationId: 'fixture-chinese', stepIdx: 1, toolCall: { name: 'run_command', args: {
    CommandLine: 'Get-ChildItem -Path "C:/example/中文材料"', Cwd: 'C:/example/中文工作区' } } };
  const channel = await openPermissionChannel(value => ({ decision: 'ask', received: value }));
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
    const output = await response;
    assert.equal(output.decision, 'ask');
    assert.deepEqual(output.received, input);
    await once(socket, 'close');
  } finally { await channel.close(); }
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

void test('authenticated compatibility hook accepts over 1MiB args intact; bad nonce and cancellation never allow', { timeout: 15000 }, async () => {
  const { createHash } = await import('node:crypto');
  const { openPermissionChannel, requestHookPermission } = await import('./agy-permission-hook.mjs');
  const raw = { TargetFile: 'C:/example/中文原稿.txt', CodeContent: '完整中文正文'.repeat(100000) };
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) > 1024 * 1024);
  const expectedHash = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
  let calls = 0; let received;
  const channel = await openPermissionChannel(async input => { calls++; received = input; return { decision: 'ask' }; });
  try {
    assert.equal((await requestHookPermission(raw, { ...channel.env, KIKI_AGY_PERMISSION_TOKEN: 'bad-nonce' }, 2000)).decision, 'deny');
    assert.equal(calls, 0);
    assert.equal((await requestHookPermission(raw, channel.env, 5000)).decision, 'ask');
    assert.equal(calls, 1);
    assert.equal(createHash('sha256').update(JSON.stringify(received)).digest('hex'), expectedHash);
    let entered; const waiting = new Promise(done => { entered = done; });
    const waitingChannel = await openPermissionChannel(async () => { entered(); return new Promise(() => {}); });
    const pending = requestHookPermission(raw, waitingChannel.env, 2000);
    await waiting;
    await waitingChannel.close();
    assert.equal((await pending).decision, 'deny');
    await waitingChannel.close();
  } finally { await channel.close(); }
});


void test('Windows registered hook command survives native shell quoting and returns compatibility ask', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { mkdtemp, mkdir, cp, readFile, rm } = await import('node:fs/promises');
  const { registerProjectHook } = await import('./agy-hook-registration.mjs');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-shell-'));
  const input = { conversationId: 'fixture-windows-shell', stepIdx: 3, toolCall: { name: 'native_tool', args: { Path: 'C:/example/中文材料/原稿.txt' } } };
  async function shell(command) {
    const child = spawn(process.env.ComSpec, ['/d', '/s', '/c', command], {
      cwd: root, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KIKI_AGY_PERMISSION_'))), stdio: ['pipe', 'pipe', 'pipe'],
    });
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
    assert.equal(old.stdout.trim(), '');
    const spaced = join(root, '中文 空格'); await mkdir(spaced);
    const spacedNode = join(spaced, 'node runner.exe'); const spacedHandler = join(spaced, "permission 中文's hook.mjs");
    await cp(exactNode, spacedNode); await cp(sourceHandler, spacedHandler);
    for (const [nodePath, handlerPath] of [[exactNode, sourceHandler], [spacedNode, spacedHandler]]) {
      const registration = await registerProjectHook({ cwd: root, nodePath, handlerPath, sessionId: `fixture-${nodePath.length}` });
      try {
        const hooks = JSON.parse(await readFile(join(root, '.agents', 'hooks.json'), 'utf8'));
        const command = hooks['kiki-agy-permission-bridge'].PreToolUse[0].hooks[0].command;
        const result = await shell(command);
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { decision: 'ask' });
      } finally { await registration.close(); }
    }
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(root, '.agents', '.kiki-agy-hook-ownership.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
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
  await opus.setConfig({ sessionId: opusId, configId: 'effort', value: 'high' });
  assert.deepEqual(configOptions(opus.session(opusId))[0].options.map(option => option.value), ['engine-default', 'high']);
  assert.deepEqual(launchArgs(opus.session(opusId)), ['--input-format', 'stream-json', '--output-format', 'stream-json',
    '--model', 'claude-opus-5-5-high']);
  const gemini = bridge('gemini-3.8-flash-high');
  const geminiId = await session(gemini);
  await gemini.setConfig({ sessionId: geminiId, configId: 'effort', value: 'high' });
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
    await b.setConfig({ sessionId: id, configId: 'effort', value: effort });
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
      await first.setConfig({ sessionId: id, configId: 'effort', value: 'high' });
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
        const legacyRecords = records.filter(record => record.type !== 'native_turn_pending' && record.type !== 'native_turn_reconciled');
        await writeFile(auditPath, legacyRecords.map(record => JSON.stringify(record)).join('\n') + '\n');
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
    await first.setConfig({ sessionId: id, configId: 'effort', value: 'medium' });
    await turn(first, id, 'original user prompt', []);
    await assert.rejects(loaded.loadSession({ sessionId: id, cwd: root, mcpServers: [] }), /owned process/);
    await first.close();
    await assert.rejects(loaded.loadSession({ sessionId: id, cwd, mcpServers: [] }), /workspace differs/);
    const otherModel = bridge('claude-opus-5-5-high'); otherModel.auditDir = auditDir;
    await assert.rejects(otherModel.loadSession({ sessionId: id, cwd: root, mcpServers: [] }), /model differs/);
    await loaded.loadSession({ sessionId: id, cwd: root, mcpServers: [] });
    assert.equal(loaded.initialize(1).agentCapabilities.loadSession, true);
    assert.equal(loaded.session(id).effort, 'medium');
    await loaded.setConfig({ sessionId: id, configId: 'permission-mode', value: 'auto' });
    await assert.rejects(competitor.loadSession({ sessionId: id, cwd: root, mcpServers: [] }), /already being loaded/);
    const args = launchArgs(loaded.session(id));
    assert.equal(args[args.indexOf('--conversation') + 1], 'fixture-conversation');
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { toolPermission: 'request-review', agentMode: 'auto' });
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

void test('native load refuses retired or unreconciled sessions across adapter instances', { timeout: 10000 }, async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'agy-retired-load-'));
  const auditDir = join(root, 'audit');
  const first = bridge('fixture-alpha-high'); first.auditDir = auditDir;
  const loaded = bridge('fixture-alpha-high'); loaded.auditDir = auditDir;
  const params = { cwd: root, mcpServers: [] };
  const id = (await first.newSession(params)).sessionId;
  let started, writingCancel, release;
  const ready = new Promise(done => { started = done; });
  const beforeCancelRecord = new Promise(done => { writingCancel = done; });
  const blocked = new Promise(done => { release = done; });
  const audit = first.audit.bind(first);
  first.audit = async (session, type, data) => {
    if (type === 'cancel') { writingCancel(); await blocked; }
    await audit(session, type, data);
  };
  const pending = first.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'tool-hang' }] }, {
    notify: async (_method, event) => { if (event.update.sessionUpdate === 'tool_call') started(); },
  });
  pending.catch(() => {});
  const refusal = { code: 'AGY_SESSION_RETIRED', message: /inspect the native outcome.*do not replay/ };
  const path = join(auditDir, `${id}.ndjson`);
  let stopping;
  try {
    await Promise.race([ready, pending]);
    stopping = first.cancel({ sessionId: id });
    await Promise.race([beforeCancelRecord, stopping]);
    assert.equal(first.session(id).child.exitCode, 0);
    await assert.rejects(loaded.loadSession({ ...params, sessionId: id }), refusal);
    release();
    await stopping;
    assert.deepEqual(await pending, { stopReason: 'cancelled' });
    await first.close();
    await assert.rejects(loaded.loadSession({ ...params, sessionId: id }), refusal);
    const records = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
    const cancellation = records.find(record => record.type === 'cancel');
    assert.equal(cancellation.resumeSupported, false);
    assert.equal(cancellation.unresolvedTools.length, 1);
    const original = records.filter(record => !record.type.startsWith('cancel'));
    for (const legacy of [cancellation, { type: 'cancel_failed', unresolvedTools: cancellation.unresolvedTools },
      { type: 'tool_terminal_missing', tools: cancellation.unresolvedTools }]) {
      await writeFile(path, [...original, legacy].map(record => JSON.stringify(record)).join('\n') + '\n');
      await assert.rejects(loaded.loadSession({ ...params, sessionId: id }), refusal);
    }
    await assert.rejects(readFile(join(auditDir, `${id}.resume-lock`)), { code: 'ENOENT' });
    assert.equal(loaded.sessions.size, 0);
    assert.equal(records.filter(record => record.type === 'launch').length, 1);
    assert.equal(records.filter(record => record.type === 'prompt_sent').length, 1);
    const closing = bridge('fixture-alpha-high'); closing.auditDir = auditDir;
    try {
      const closedId = (await closing.newSession(params)).sessionId;
      let delivered;
      const active = new Promise(done => { delivered = done; });
      const interrupted = closing.prompt({ sessionId: closedId, prompt: [{ type: 'text', text: 'tool-hang' }] }, {
        notify: async (_method, event) => { if (event.update.sessionUpdate === 'tool_call') delivered(); },
      });
      interrupted.catch(() => {});
      await active;
      await closing.close();
      await assert.rejects(interrupted, /ACP connection closed/);
      await assert.rejects(loaded.loadSession({ ...params, sessionId: closedId }), refusal);
    } finally { await closing.close(); }
  } finally { release(); await stopping?.catch(() => {}); await first.close(); await loaded.close(); await rm(root, { recursive: true, force: true }); }
});

void test('native load refuses an exited CLI turn until its queued tool events are reconciled', { timeout: 10000 }, async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-exit-draining-'));
  try {
    for (const input of ['tool-disconnect', 'tool-complete-exit']) {
      const first = bridge('fixture-alpha-high'); first.auditDir = root;
      const loaded = bridge('fixture-alpha-high'); loaded.auditDir = root;
      const params = { cwd: root, mcpServers: [] };
      const id = (await first.newSession(params)).sessionId;
      await first.setConfig({ sessionId: id, configId: 'effort', value: 'high' });
      let delivered, release;
      const ready = new Promise(done => { delivered = done; });
      const blocked = new Promise(done => { release = done; });
      const pending = first.prompt({ sessionId: id, prompt: [{ type: 'text', text: input }] }, {
        notify: async (_method, event) => { if (event.update.sessionUpdate === 'tool_call') { delivered(); await blocked; } },
      });
      pending.catch(() => {});
      try {
        await Promise.race([ready, pending]);
        const native = first.session(id);
        await native.exited;
        assert.equal(native.child.exitCode, input === 'tool-disconnect' ? 9 : 0);
        await assert.rejects(loaded.loadSession({ ...params, sessionId: id }), { code: 'AGY_SESSION_UNCONFIRMED' });
        await assert.rejects(readFile(join(root, `${id}.resume-lock`)), { code: 'ENOENT' });
        release();
        if (input === 'tool-disconnect') {
          await assert.rejects(pending, { code: 'AGY_EARLY_EXIT', message: /execution state is unknown/ });
          await native.cleanup;
          await assert.rejects(loaded.loadSession({ ...params, sessionId: id }), { code: 'AGY_SESSION_RETIRED' });
        } else {
          assert.deepEqual(await pending, { stopReason: 'end_turn' });
          await native.cleanup;
          await loaded.loadSession({ ...params, sessionId: id });
          assert.deepEqual(launchArgs(loaded.session(id)).slice(4), ['--conversation', 'fixture-conversation', '--model', 'fixture-alpha-high', '--effort', 'high']);
        }
      } finally { release(); await first.close(); await loaded.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
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


void test('legacy AGY load verifies the saved native binding without an old audit or prompt replay', { timeout: 15000 }, async () => {
  const { mkdir, mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'agy-legacy-native-load-'));
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const conversationId = '22222222-2222-4222-8222-222222222222';
  const model = 'claude-opus-5-5-high';
  const proof = { version: 1, sessionId, conversationId, model, effort: 'high', tools: [{ stepIndex: 2, name: 'read_file' }] };
  const params = { sessionId, cwd: root, mcpServers: [], _meta: { 'kiki.agyLegacyRecovery': proof } };
  const auditDir = join(root, 'audit');
  const b = bridge(model); b.auditDir = auditDir; b.nativeHome = root;
  const c = bridge(model); c.auditDir = auditDir; c.nativeHome = root;
  const dbPath = join(root, 'conversations', `${conversationId}.db`);
  const transcriptDir = join(root, 'brain', conversationId, '.system_generated', 'logs');
  const varint = value => {
    const bytes = [];
    while (value >= 128) { bytes.push((value & 127) | 128); value >>>= 7; }
    return Buffer.from([...bytes, value]);
  };
  const field = (number, value) => {
    const bytes = Buffer.from(value);
    return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
  };
  const setStatus = status => {
    const db = new DatabaseSync(dbPath);
    try { db.prepare('UPDATE steps SET status = ? WHERE idx = 2').run(status); } finally { db.close(); }
  };
  const launches = [];
  const originalSpawn = c.spawnProcess;
  c.spawnProcess = (cmd, args, opts) => { launches.push(args); return originalSpawn(cmd, args, opts); };
  try {
    await mkdir(join(root, 'conversations'));
    await mkdir(transcriptDir, { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE trajectory_metadata_blob(id TEXT, data BLOB); CREATE TABLE gen_metadata(idx INTEGER, data BLOB); CREATE TABLE steps(idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB)');
      db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Buffer.concat([field(6, conversationId), field(7, pathToFileURL(root).href)]));
      db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, field(1, field(19, model)));
      db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, Buffer.concat([field(1, Buffer.alloc(0)), field(4, Buffer.alloc(360_000))]));
      const step = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)');
      [14, 15, 132, 17].forEach((type, index) => step.run(index, type, 3, index === 3
        ? field(24, field(3, field(1, 'There was a network issue connecting to the server, please try again.'))) : Buffer.alloc(0)));
    } finally { db.close(); }
    await writeFile(join(transcriptDir, 'transcript_full.jsonl'), [
      { type: 'USER_INPUT', content: 'do not replay original prompt' },
      { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file' }] },
      { type: 'GENERIC', content: 'completed tool' },
      { type: 'ERROR_MESSAGE' },
    ].map((row, index) => JSON.stringify({ ...row, status: 'DONE', step_index: index })).join('\n'));
    await assert.rejects(b.loadSession({ ...params, _meta: undefined }), { code: 'ENOENT' });
    await assert.rejects(b.loadSession({ ...params, cwd }), /workspace differs/);
    await assert.rejects(b.loadSession({ ...params, _meta: { 'kiki.agyLegacyRecovery': { ...proof, model: 'other-model-high' } } }), /native model is not available/);
    await assert.rejects(b.loadSession({ ...params, _meta: { 'kiki.agyLegacyRecovery': { ...proof, tools: [{ stepIndex: 1, name: 'read_file' }] } } }), /native tools differ/);
    setStatus(2);
    await assert.rejects(b.loadSession(params), /unresolved steps/);
    setStatus(3);
    const failedDb = new DatabaseSync(dbPath);
    try {
      const terminal = failedDb.prepare('UPDATE steps SET step_payload = ? WHERE idx = 3');
      for (const error of ['429 quota exhausted', 'Invalid authentication', 'UNKNOWN']) {
        terminal.run(field(24, field(3, field(1, error))));
        await assert.rejects(b.loadSession(params), /no confirmed terminal network failure/);
      }
      terminal.run(field(24, field(3, field(1, 'There was a network issue connecting to the server, please try again.'))));
      failedDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(4, 14, 3, Buffer.alloc(0));
      await assert.rejects(b.loadSession(params), /unknown steering/);
      failedDb.prepare('DELETE FROM steps WHERE idx = 4').run();
    } finally { failedDb.close(); }
    await assert.rejects(readFile(join(auditDir, `${sessionId}.ndjson`)), { code: 'ENOENT' });
    assert.equal((await b.loadSession(params)).configOptions[0].currentValue, 'high');
    assert.equal(b.session(sessionId).child, undefined);
    await assert.rejects(c.loadSession(params), /already being loaded/);
    await b.close();
    await c.loadSession({ ...params, _meta: undefined });
    assert.deepEqual(launches, []);
    assert.deepEqual(await turn(c, sessionId, 'new input only', []), { stopReason: 'end_turn' });
    assert.equal(c.session(sessionId).init.conversation_id, conversationId);
    assert.equal(launches.length, 1);
    assert.equal(launches[0][launches[0].indexOf('--conversation') + 1], conversationId);
    const rows = (await readFile(join(auditDir, `${sessionId}.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.some(row => row.type === 'session_new'), false);
    assert.equal(rows.filter(row => row.type === 'legacy_native_recovered').length, 1);
    assert.equal(rows.filter(row => row.type === 'prompt_sent').length, 1);
  } finally { await b.close(); await c.close(); await rm(root, { recursive: true, force: true }); }
});

void test('legacy AGY load reconciles Gemini base/provider-effort models, multi-root bindings, settled failed tools and two-step terminal errors while rejecting mismatches', { timeout: 15000 }, async () => {
  const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'agy-legacy-gemini-load-'));
  const extraA = join(root, 'extra-a');
  const extraB = join(root, 'extra-b');
  const unapproved = join(root, 'visited-outside');
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const conversationId = '44444444-4444-4444-8444-444444444444';
  const model = 'gemini-4-argon-high';
  const terminalError = 'There was a network issue connecting to the server, please try again.';
  const streamError = 'API error (attempt 1): doRequest: wsarecv: An existing connection was forcibly closed by the remote host.';
  const proof = {
    version: 1,
    sessionId,
    conversationId,
    model,
    effort: 'high',
    terminalError,
    additionalDirectories: [extraA, extraB],
    tools: [
      { stepIndex: 2, name: 'read_file', failed: true, error: 'file does not exist' },
      { stepIndex: 3, name: 'edit_file' },
      { stepIndex: 4, name: 'run_command' },
    ],
  };
  const params = { sessionId, cwd: root, additionalDirectories: [extraA, extraB], mcpServers: [], _meta: { 'kiki.agyLegacyRecovery': proof } };
  const auditDir = join(root, 'audit');
  const b = bridge(model); b.auditDir = auditDir; b.nativeHome = root;
  const dbPath = join(root, 'conversations', `${conversationId}.db`);
  const transcriptDir = join(root, 'brain', conversationId, '.system_generated', 'logs');
  const varint = value => {
    const bytes = [];
    while (value >= 128) { bytes.push((value & 127) | 128); value >>>= 7; }
    return Buffer.from([...bytes, value]);
  };
  const field = (number, value) => {
    const bytes = Buffer.from(value);
    return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
  };
  try {
    await mkdir(join(root, 'conversations'));
    await mkdir(transcriptDir, { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE trajectory_metadata_blob(id TEXT, data BLOB); CREATE TABLE gen_metadata(idx INTEGER, data BLOB); CREATE TABLE executor_metadata(idx INTEGER, data BLOB); CREATE TABLE steps(idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB)');
      const sortedUris = [extraA, extraB, root].map(dir => pathToFileURL(dir).href);
      db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Buffer.concat([
        field(6, conversationId),
        ...sortedUris.map(uri => field(7, uri)),
      ]));
      db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, field(1, field(19, 'gemini-4-argon')));
      db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, field(3, field(28, `gemini-api://models/${model}`)));
      db.prepare('INSERT INTO executor_metadata VALUES (?, ?)').run(0, field(10, field(1, field(28, `gemini-api://models/${model}`))));
      const step = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)');
      step.run(0, 14, 3, field(19, field(12, Buffer.concat(sortedUris.map(uri => field(12, uri))))));
      step.run(1, 15, 3, Buffer.alloc(0));
      step.run(2, 132, 7, Buffer.concat([field(5, field(4, field(2, 'read_file'))), field(31, field(2, 'file does not exist'))]));
      step.run(3, 132, 3, field(5, field(4, field(2, 'edit_file'))));
      step.run(4, 132, 3, Buffer.concat([field(5, field(4, field(2, 'run_command'))), field(140, field(2, field(6, field(2, field(7, extraA)))))]));
      step.run(5, 17, 3, field(24, field(3, field(2, streamError))));
      step.run(6, 17, 3, field(24, field(3, Buffer.concat([
        field(1, terminalError),
        field(2, 'agent executor error: dial tcp 127.0.0.1:54555: connectex: actively refused'),
      ]))));
    } finally { db.close(); }
    const writeTranscript = rows => writeFile(join(transcriptDir, 'transcript_full.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    const validTranscript = [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'prompt' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file' }, { name: 'edit_file' }, { name: 'run_command' }] },
      { step_index: 2, type: 'GENERIC', status: 'ERROR', error: 'file does not exist' },
      { step_index: 3, type: 'GENERIC', status: 'DONE' },
      { step_index: 4, type: 'GENERIC', status: 'DONE' },
      { step_index: 5, type: 'ERROR_MESSAGE', status: 'DONE', error: streamError },
    ];
    await writeTranscript(validTranscript);

    await assert.rejects(b.loadSession({ ...params, cwd: unapproved, additionalDirectories: [extraA, extraB] }), /workspace differs/);
    await assert.rejects(b.loadSession({ ...params, cwd: extraA, additionalDirectories: [] }), /workspace differs/);

    const mutateDb = fn => {
      const mdb = new DatabaseSync(dbPath);
      try { fn(mdb); } finally { mdb.close(); }
    };
    mutateDb(mdb => {
      mdb.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 1').run(field(3, field(28, 'gemini-api://models/gemini-4-argon-medium')));
    });
    await assert.rejects(b.loadSession(params), /native model differs/);
    mutateDb(mdb => {
      mdb.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 1').run(field(1, field(19, 'gemini-4-argon')));
      mdb.prepare('DELETE FROM executor_metadata').run();
    });
    await assert.rejects(b.loadSession(params), /native model differs/);
    mutateDb(mdb => {
      mdb.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 1').run(field(3, field(28, `gemini-api://models/${model}`)));
      mdb.prepare('INSERT INTO executor_metadata VALUES (?, ?)').run(0, field(10, field(1, field(28, `gemini-api://models/${model}`))));
    });

    await assert.rejects(b.loadSession({
      ...params,
      _meta: { 'kiki.agyLegacyRecovery': { ...proof, tools: [{ stepIndex: 2, name: 'read_file' }, proof.tools[1], proof.tools[2]] } },
    }), /native tools differ/);

    mutateDb(mdb => {
      mdb.prepare('UPDATE steps SET step_payload = ? WHERE idx = 2').run(
        Buffer.concat([field(5, field(4, field(2, 'read_file'))), field(31, field(2, 'tool call denied by pre-tool hook: rejected'))]),
      );
    });
    await assert.rejects(b.loadSession(params), /native tools differ/);
    mutateDb(mdb => {
      mdb.prepare('UPDATE steps SET step_payload = ? WHERE idx = 2').run(
        Buffer.concat([field(5, field(4, field(2, 'read_file'))), field(31, field(2, 'file does not exist'))]),
      );
    });

    assert.equal((await b.loadSession(params)).configOptions[0].currentValue, 'high');
    assert.deepEqual(b.session(sessionId).additionalDirectories, [extraA, extraB]);
    assert.equal(b.session(sessionId).conversationId, conversationId);
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});

void test('terminal quota or auth vendor failure stops the owned CLI process and releases its lease so another account can load the exact conversation', { timeout: 15000 }, async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-terminal-account-load-'));
  const auditDir = join(root, 'audit');
  const first = new AgyBridge({ cliPath: process.execPath, cliPrefix: [fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url))],
    model: 'fixture-alpha-high', auditDir, account: { apiKey: 'acct-a-key', baseUrl: 'https://a.example.test', modelIds: ['fixture-alpha-high'] } });
  const second = new AgyBridge({ cliPath: process.execPath, cliPrefix: [fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url))],
    model: 'fixture-alpha-high', auditDir, account: { apiKey: 'acct-b-key', baseUrl: 'https://b.example.test', modelIds: ['fixture-alpha-high'] } });
  try {
    await first.loadVendorModels();
    await second.loadVendorModels();
    const id = (await first.newSession({ cwd: root, mcpServers: [] })).sessionId;
    await first.setConfig({ sessionId: id, configId: 'effort', value: 'high' });
    await assert.rejects(turn(first, id, 'quota-terminal', []), /AGY terminal status ERROR: 429 Too Many Requests/);
    assert.notEqual(first.session(id).child.exitCode, null);
    await first.session(id).cleanup;
    await assert.rejects(readFile(join(auditDir, `${id}.resume-lock`)), { code: 'ENOENT' });
    const loaded = await second.loadSession({ sessionId: id, cwd: root, mcpServers: [] });
    assert.equal(loaded.configOptions[0].currentValue, 'high');
    assert.equal(second.session(id).conversationId, 'fixture-conversation');
    const messages = [];
    assert.deepEqual(await turn(second, id, 'continue on account B', messages), { stopReason: 'end_turn' });
    assert.equal(second.session(id).init.conversation_id, 'fixture-conversation');
    assert.equal(messages.map(m => m.update.content?.text ?? '').join(''), 'turn-1');
    const records = (await readFile(join(auditDir, `${id}.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.filter(r => r.type === 'agy_init').map(r => r.conversationId), ['fixture-conversation', 'fixture-conversation']);
    assert.equal(records.filter(r => r.type === 'prompt_sent').length, 2);

    const unfinishedId = (await first.newSession({ cwd: root, mcpServers: [] })).sessionId;
    await assert.rejects(turn(first, unfinishedId, 'quota-terminal-unfinished-tool', []), /execution state is unknown/);
    assert.notEqual(first.session(unfinishedId).child.exitCode, null);
    await first.session(unfinishedId).cleanup;
    await assert.rejects(second.loadSession({ sessionId: unfinishedId, cwd: root, mcpServers: [] }), { code: 'AGY_SESSION_RETIRED' });

    const interruptedId = (await first.newSession({ cwd: root, mcpServers: [] })).sessionId;
    assert.deepEqual(await turn(first, interruptedId, 'native-interrupted', []), { stopReason: 'cancelled' });
    assert.notEqual(first.session(interruptedId).child.exitCode, null);
    await first.session(interruptedId).cleanup;
    await assert.rejects(second.loadSession({ sessionId: interruptedId, cwd: root, mcpServers: [] }), { code: 'AGY_SESSION_RETIRED' });

    const completedLateErrId = (await first.newSession({ cwd: root, mcpServers: [] })).sessionId;
    const completedUpdates = [];
    assert.deepEqual(await turn(first, completedLateErrId, 'complete-response-late-wsarecv', completedUpdates), { stopReason: 'end_turn' });
    assert.equal(completedUpdates.filter(u => u.update.sessionUpdate === 'agent_message_chunk').map(u => u.update.content.text).join(''), 'final-delivery-1');
    assert.notEqual(first.session(completedLateErrId).child.exitCode, null);
    await first.session(completedLateErrId).cleanup;
    await assert.rejects(readFile(join(auditDir, `${completedLateErrId}.resume-lock`)), { code: 'ENOENT' });
    const completedAudit = (await readFile(join(auditDir, `${completedLateErrId}.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(completedAudit.some(r => r.type === 'post_response_terminal_error' && r.status === 'ERROR'), true);
    assert.equal(completedAudit.some(r => r.type === 'native_turn_reconciled' && r.preservedCompletedResponse === true), true);
    await second.loadSession({ sessionId: completedLateErrId, cwd: root, mcpServers: [] });
    assert.equal(second.session(completedLateErrId).conversationId, 'fixture-conversation');
    const resumedAfterLateErr = [];
    assert.deepEqual(await turn(second, completedLateErrId, 'follow up after late wsarecv', resumedAfterLateErr), { stopReason: 'end_turn' });
    assert.equal(resumedAfterLateErr.map(u => u.update.content?.text ?? '').join(''), 'turn-1');

    for (const [promptName, expectedPattern] of [
      ['partial-response-late-wsarecv', /AGY terminal status ERROR:.*wsarecv/],
      ['post-tool-error-late-wsarecv', /AGY terminal status ERROR:.*wsarecv/],
      ['complete-response-late-429', /AGY terminal status ERROR:.*429 Too Many Requests/],
      ['complete-response-late-auth', /AGY terminal status ERROR:.*401 Unauthorized/],
      ['complete-response-unknown-status', /AGY terminal status UNKNOWN:/],
    ]) {
      const partialId = (await first.newSession({ cwd: root, mcpServers: [] })).sessionId;
      const partialUpdates = [];
      await assert.rejects(turn(first, partialId, promptName, partialUpdates), expectedPattern);
      assert.notEqual(first.session(partialId).child.exitCode, null);
      await first.session(partialId).cleanup;
      await assert.rejects(readFile(join(auditDir, `${partialId}.resume-lock`)), { code: 'ENOENT' });
      const partialAudit = (await readFile(join(auditDir, `${partialId}.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(partialAudit.some(r => r.type === 'post_response_terminal_error'), false);
    }
  } finally { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
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
    const legacy = await first.request('session/new', { cwd: root, mcpServers: [], _meta: { 'kiki.permission': { hostGate: true } } });
    assert.ok(legacy.result, JSON.stringify(legacy));
    const version2 = await first.request('session/new', { cwd: root, mcpServers: [], _meta: { 'kiki.permission': { version: 2, override: { mode: 'yolo' } } } });
    assert.ok(version2.result, JSON.stringify(version2));
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
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
    assert.equal((await readdir(auditDir)).length, 3);
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
    const script = `import { registerProjectHook, AGY_STEERING_HOOK_KEY, AGY_COMMAND_GUIDANCE_HOOK_KEY } from ${JSON.stringify(new URL('./agy-hook-registration.mjs', import.meta.url).href)};
      import { registerProjectMcpPlugin } from ${JSON.stringify(new URL('./agy-mcp-plugin.mjs', import.meta.url).href)};
      const base = ${JSON.stringify({ cwd: root, nodePath: process.execPath, handlerPath })};
      await registerProjectHook({ ...base, sessionId: ${JSON.stringify(killedSession)} });
      await registerProjectHook({ ...base, sessionId: ${JSON.stringify(killedSession)}, key: AGY_STEERING_HOOK_KEY, args: ['--steering'] });
      await registerProjectHook({ ...base, sessionId: ${JSON.stringify(killedSession)}, key: AGY_COMMAND_GUIDANCE_HOOK_KEY, args: ['--command-guidance'] });
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
      assert.equal(Object.hasOwn(after, 'kiki-agy-command-guidance'), false);
      await assert.rejects(readFile(join(root, '.agents', '.kiki-agy-command-guidance-ownership.json')), { code: 'ENOENT' });
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
  await bridge.setConfig({ sessionId: id, configId: 'model', value: 'fixture-alpha-high' });
  assert.equal(launchArgs(bridge.session(id))[launchArgs(bridge.session(id)).indexOf('--model') + 1], 'fixture-alpha-high');
  assert.throws(() => bridge.setConfig({ sessionId: id, configId: 'model', value: 'not-a-vendor-model' }), /not in the vendor catalog/);
  assert.equal(bridge.session(id).model, 'fixture-alpha-high');
  assert.throws(() => bridge.setConfig({ sessionId: id, configId: 'effort', value: 'max' }), /conflicts with effort/);
  await bridge.setConfig({ sessionId: id, configId: 'model', value: 'engine-default' });
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
  await none.setConfig({ sessionId: noneId, configId: 'model', value: 'engine-default' });
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

void test('vendor-native permissions need no Kiki tool projection or PreToolUse hook in Full access', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'agy-native-permission-'));
  await writeFile(join(root, 'native-text.txt'), 'red-test text\n');
  await writeFile(join(root, 'native-image.bin'), Buffer.from([3, 4, 5]));
  await writeFile(join(root, 'native-edit.txt'), 'before\n');
  await writeFile(join(root, 'native-search.txt'), 'needle\n');
  const b = bridge(); let permissionCalls = 0;
  const requestPermission = b.requestPermission.bind(b);
  b.requestPermission = async () => { permissionCalls++; return { decision: 'deny' }; };
  try {
    const created = await b.newSession({ cwd: root, mcpServers: [], _meta: { 'kiki.permission': {
      version: 2, override: { mode: 'yolo', source: 'harness-settings' } } } });
    const s = b.session(created.sessionId);
    await b.setConfig({ sessionId: s.id, configId: 'permission-mode', value: 'yolo' });
    const args = launchArgs(s);
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), {
      toolPermission: 'always-proceed', agentMode: 'accept-edits', allowNonWorkspaceAccess: true, enableTerminalSandbox: false,
    });
    assert.equal(args.includes('--dangerously-skip-permissions'), true);
    const updates = [];
    assert.equal((await turn(b, s.id, 'native-tools', updates)).stopReason, 'end_turn');
    const toolCalls = updates.map(item => item.update).filter(update => update?.sessionUpdate === 'tool_call');
    const toolUpdates = updates.map(item => item.update).filter(update => update?.sessionUpdate === 'tool_call_update');
    assert.equal(toolCalls.some(call => call.name === 'read_file' && call.rawInput?.Path === join(root, 'native-text.txt')), true);
    assert.equal(toolCalls.some(call => call.name === 'edit_file' && call.rawInput?.Replace === 'before' && call.rawInput?.With === 'after'), true);
    assert.equal(toolUpdates.some(update => update.name === 'run_command' && update.rawInput?.CommandLine?.includes('native-command')), true);
    assert.equal(permissionCalls, 0);
    assert.equal(await readFile(join(root, 'native-write.txt'), 'utf8'), 'native write\n');
    assert.equal(await readFile(join(root, 'native-command.txt'), 'utf8'), 'command output\n');
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    assert.deepEqual(await requestPermission(s, { toolCall: { name: 'vendor_new_tool', args: {} } }), { decision: 'ask' });
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});

void test('forwards late AGY tool parameters on in-progress and terminal step updates without re-reading files', async () => {
  const b = bridge();
  const id = await session(b);
  const s = b.session(id);
  const updates = [];
  s.init = { conversation_id: 'conv-late' };
  s.active = { text: '', steering: [], client: { notify: async (_method, payload) => updates.push(payload.update) }, resolve: () => {}, reject: () => {} };
  try {
    await b.event(s, { event: 'step_update', conversation_id: 'conv-late', step_update: { step_type: 'tool', step_index: 3, state: 'PENDING', tool_name: 'replace_file_content' } });
    await b.event(s, { event: 'step_update', conversation_id: 'conv-late', step_update: { step_type: 'tool', step_index: 3, state: 'ACTIVE', tool_name: 'replace_file_content', tool_info: { parameters: { TargetFile: '/workspace/example/a.ts', TargetContent: 'old', ReplacementContent: 'new' } } } });
    await b.event(s, { event: 'step_update', conversation_id: 'conv-late', step_update: { step_type: 'tool', step_index: 3, state: 'DONE', tool_name: 'replace_file_content', tool_info: { result: 'applied' } } });
    assert.deepEqual(updates, [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'agy-conv-late-3',
        title: 'replace_file_content',
        name: 'replace_file_content',
        kind: 'other',
        status: 'in_progress',
        rawInput: undefined,
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agy-conv-late-3',
        title: 'replace_file_content',
        name: 'replace_file_content',
        status: 'in_progress',
        rawInput: { TargetFile: '/workspace/example/a.ts', TargetContent: 'old', ReplacementContent: 'new' },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agy-conv-late-3',
        title: 'replace_file_content',
        name: 'replace_file_content',
        status: 'completed',
        rawInput: { TargetFile: '/workspace/example/a.ts', TargetContent: 'old', ReplacementContent: 'new' },
        rawOutput: 'applied',
        content: [{ type: 'content', content: { type: 'text', text: 'applied' } }],
      },
    ]);
  } finally {
    s.active = undefined;
    await b.close();
  }
});
