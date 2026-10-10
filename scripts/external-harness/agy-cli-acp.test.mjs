import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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


test('official permission hook preserves raw command, cwd and identity; only the host selected allow permits it', async () => {
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
  assert.deepEqual(await b.requestPermission(s, input), {});
  s.active.client.request = async () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
  assert.equal((await b.requestPermission(s, input)).decision, 'deny');
  assert.equal((await b.requestPermission(s, { ...input, conversationId: 'other-session' })).decision, 'deny');
  s.active = undefined;
  assert.equal((await b.requestPermission(s, input)).decision, 'deny');
});

test('owned permission channel rejects bad nonce and disconnects, unrelated AGY keeps default policy', async () => {
  const { openPermissionChannel, requestHookPermission } = await import('./agy-permission-hook.mjs');
  assert.deepEqual(await requestHookPermission({}, {}), {});
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

test('project hook registration leases restore original bytes and preserve concurrent foreign hooks', async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
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


test('fixture follows project PreToolUse through the owned hook and host ACP decision, including cancel and cleanup', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
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


test('inherit starts without host hook, even with legacy ambient mode; clearing override is a fresh vendor session', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
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
      assert.deepEqual(await b.requestPermission(b.session(id), {}), {});
      assert.equal(launches.at(-1).env.KIKI_AGY_PERMISSION_ENDPOINT, b.session(id).permissionIdentity.KIKI_AGY_PERMISSION_ENDPOINT);
      assert.deepEqual(launches.at(-1).args.slice(1), ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'claude-opus-5-5-high']);
      await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    }
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});

test('vendor-default host outcome crosses owned channel as empty default, never as allow', async () => {
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
    assert.deepEqual(await requestHookPermission(input, channel.env), {});
    optionId = 'reject_once';
    assert.equal((await requestHookPermission(input, channel.env)).decision, 'deny');
  } finally { s.active = undefined; await channel.close(); }
});

test('scoped hook recovery preserves live owner and restores dead owner original bytes without foreign loss', async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
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

test('real ACP permission request carries raw tool metadata and vendor-default ID, then EOF closes owned resources', { timeout: 15000 }, async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-acp-permission-'));
  const sdkPath = process.env.AGY_TEST_ACP_SDK_PATH;
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


test('turn snapshot switches inherit to explicit and back without replacing native process, model or history', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
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
    assert.deepEqual(await requestHookPermission({}, b.session(other).permissionIdentity), {});
    assert.equal(requests, 1);
    const inherited = { version: 1, hostGate: false, policyIdentity: 'fixture-cleared', workspace: { cwd: root, additionalDirectories: [] } };
    assert.equal((await b.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'again' }], _meta: { 'kiki.permission': inherited } }, client)).stopReason, 'end_turn');
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    assert.deepEqual(await requestHookPermission({}, b.session(id).permissionIdentity), {});
    assert.equal(b.session(id).child.pid, pid);
    assert.equal(b.session(id).init.conversation_id, conversation);
    assert.equal(b.session(id).init.init.model, 'gemini-3.8-flash-medium');
    assert.equal(b.session(id).init.init.permission_mode, 'request-review');
    assert.equal(requests, 1);
  } finally { await b.close(); await rm(root, { recursive: true, force: true }); }
});


test('hook UTF8 split bytes preserve raw Chinese command and path through stdin, server and client pipes', async () => {
  const { createConnection, createServer } = await import('node:net');
  const { once } = await import('node:events');
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

test('authenticated hook accepts over 1MiB Write args intact through real ACP host; bad nonce and cancellation never allow', { timeout: 15000 }, async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { once } = await import('node:events');
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
  const sdkPath = process.env.AGY_TEST_ACP_SDK_PATH;
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


test('Windows registered hook command survives native shell quoting for exact node path and Chinese spaced paths', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { mkdtemp, mkdir, cp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
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
  const exactNode = 'C:/nvm4w/nodejs/node.exe';
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
          if (expected === undefined) assert.deepEqual(output, {}); else assert.equal(output.decision, expected);
        }
      } finally { await registration.close(); }
    }
    assert.equal(calls, 6);
    await assert.rejects(readFile(join(root, '.agents', 'hooks.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(root, '.agents', '.kiki-agy-hook-ownership.json')), { code: 'ENOENT' });
  } finally { s.active = undefined; await channel.close(); await rm(root, { recursive: true, force: true }); }
});


test('per-call resources cross downstream vendor command and write checks without retaining approval on clear', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
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


test('raw model effort suffix is authoritative, not the generic CLI effort menu', async () => {
  const { configOptions } = await import('./agy-cli-acp.mjs');
  for (const [model, effort] of [['claude-opus-5-5-high', 'high'], ['gemini-3.8-flash-medium', 'medium'], ['example-model-xhigh', 'xhigh']]) {
    const b = bridge(model); const id = await session(b);
    assert.deepEqual(configOptions(b.session(id))[0].options.map(option => option.value), ['engine-default', effort]);
    const before = b.session(id).effort;
    assert.throws(() => b.setConfig({ sessionId: id, configId: 'effort', value: effort === 'max' ? 'low' : 'max' }), /conflicts with effort/);
    assert.equal(b.session(id).effort, before);
    assert.equal(b.session(id).child, undefined);
    b.setConfig({ sessionId: id, configId: 'effort', value: effort });
    assert.ok(launchArgs(b.session(id)).includes(effort));
    await b.close();
  }
  assert.deepEqual(configOptions({ model: 'engine-default', effort: 'engine-default' })[0].options.map(option => option.value), ['engine-default']);
  assert.throws(() => launchArgs({ model: 'claude-opus-5-5-high', effort: 'max', additionalDirectories: [] }), /conflicts with effort/);
});

test('native load uses only exact audited conversation and binding, owns a lease, and never copies history', async () => {
  const { mkdtemp, readFile, rm, appendFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
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

test('native denial after exact host approval retains failed tool receipt and names the vendor layer', async () => {
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


test('pre-tool hook denial cannot become successful work when native result omits denied_actions', async () => {
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

test('shared Windows hook calls inherited channel with empty decision before any host admission', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
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
    assert.deepEqual(await run(), {});
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
    assert.equal(calls, 3);
  } finally { s.active = undefined; await channel.close(); await b.close(); }
});

test('real ACP session/load restores exact native argv after adapter EOF without handoff replay', { timeout: 15000 }, async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(process.env.AGY_TEST_WORKSPACE ?? tmpdir(), 'agy-acp-load-'));
  const auditDir = join(root, 'audit');
  const sdkPath = process.env.AGY_TEST_ACP_SDK_PATH;
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
