import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline';
import { setTimeout as pause } from 'node:timers/promises';

const [transport, scenario] = process.argv.slice(2);
assert.ok(['stream', 'acp'].includes(transport), 'Choose stream or acp');
assert.ok(['hold', 'explicit', 'interactive', 'cancel'].includes(scenario), 'Choose hold, explicit, interactive or cancel');
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 1000);
assert.deepEqual(Object.keys(networkInterfaces()), ['lo']);
assert.equal((await readFile('/proc/net/route', 'utf8')).trim().split('\n').length, 1);
for (const socket of ['/run/dbus/system_bus_socket', '/run/user/1000/bus']) await assert.rejects(access(socket));

const home = '/tmp/agy-home';
const cwd = '/tmp/agy-workspace';
const appData = `${home}/.gemini/antigravity-cli`;
const model = 'claude-opus-5-5-high';
const key = 'offline-fixture-only';
const settings = {
  modelProvider: 'gemini', model,
  toolPermission: 'always-proceed', agentMode: 'accept-edits', enableTerminalSandbox: false,
  customModelsConfig: { customModels: { [model]: { modelName: `gemini-api://models/${model}`, toolFormatterType: 'TOOL_FORMATTER_TYPE_NONE' } } },
};
await mkdir(appData, { recursive: true });
await mkdir(cwd);
await writeFile(`${appData}/settings.json`, JSON.stringify(settings));
await writeFile(`${cwd}/input.txt`, 'needle explicit path\n');

const output = [];
const start = Date.now();
const record = (kind, data) => output.push({ ms: Date.now() - start, kind, data });
const early = scenario === 'explicit' ? '/rg -n needle input.txt'
  : scenario === 'interactive' ? 'timeout 12s /rg --line-buffered -n needle - | tee interactive-output'
    : 'timeout 12s /rg -n needle';
const command = (CommandLine, WaitMsBeforeAsync) => call('run_command', { CommandLine, Cwd: cwd, WaitMsBeforeAsync });
const call = (name, args) => ({ functionCall: { name, args } });
const earlyCall = command(`printf x >> early-count; ${early}; code=$?; printf %s "$code" > early-exit; exit "$code"`, scenario === 'explicit' ? 500 : 25);
const laterCall = command("printf x >> later-count; printf 'needle pipe\\n' | /rg -n needle -", 500);
const finalText = 'fixture first turn final';
const nextText = 'fixture second turn final';
let requests = 0;
let laterOutput;
let firstOutput;
let nextTurn = false;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const title = path.includes('gemini-3.1-flash-lite') || body.systemInstruction?.parts?.some(part => part.text?.startsWith('You are a conversation title generator.'));
  const replies = body.contents?.flatMap(content => content.parts ?? []).flatMap(part => part.functionResponse ? [part.functionResponse] : []) ?? [];
  const tools = body.tools?.flatMap(tool => tool.functionDeclarations ?? []).filter(tool => /^(run_command|manage_task)$/.test(tool.name));
  record('model_request', { path, title: Boolean(title), replies, tools: requests === 0 ? tools : undefined });
  let part;
  if (req.headers['x-goog-api-key'] === key && title) part = { text: 'Offline AGY fixture' };
  else if (req.headers['x-goog-api-key'] === key && path === `/v1beta/models/${model}:streamGenerateContent`) {
    const n = ++requests;
    if (nextTurn) part = { text: nextText };
    else if (n === 1) part = earlyCall;
    else if (n === 2 && scenario === 'interactive') {
      const task = JSON.stringify(replies).match(/[0-9a-f-]{36}\/task-\d+/u)?.[0];
      if (task) part = call('manage_task', { Action: 'send_input', TaskId: task, Input: 'needle explicit stdin\n' });
    } else if (n === (scenario === 'interactive' ? 3 : 2)) {
      firstOutput = JSON.stringify(replies);
      part = laterCall;
    } else if (n === (scenario === 'interactive' ? 4 : 3)) {
      laterOutput = JSON.stringify(replies);
      if (scenario === 'cancel') return; // The fixture leaves this request pending until the harness cancels.
      part = { text: finalText };
    }
  }
  if (!part) {
    res.writeHead(418, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 418, message: 'unexpected offline fixture request', status: 'UNKNOWN' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [part] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } })}\n\n`);
});
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, TERM: 'dumb', GEMINI_API_KEY: key,
  XDG_CONFIG_HOME: `${home}/.config`, XDG_DATA_HOME: `${home}/.local/share`, XDG_CACHE_HOME: `${home}/.cache`,
};
const version = spawnSync('/agy', ['--version'], { cwd, env, encoding: 'utf8', timeout: 5000 });
assert.equal(version.status, 0, version.stderr);
assert.match(version.stdout.trim(), /^1\.5\.\d+$/u);
const rgVersion = spawnSync('/rg', ['--version'], { cwd, env, encoding: 'utf8', timeout: 5000 });
assert.equal(rgVersion.status, 0, rgVersion.stderr);
await new Promise(done => server.listen(0, '127.0.0.1', done));
env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const args = transport === 'acp' ? ['acp', '--dangerously-skip-permissions', '--disable-telemetry']
  : ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model, '--dangerously-skip-permissions', '--settings', JSON.stringify(settings)];
const child = spawn('/agy', args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
const ended = new Promise(done => child.once('close', (code, signal) => done({ code, signal })));
child.on('error', error => record('spawn_error', error.message));
child.stdin.on('error', error => record('stdin_error', error.code));
child.stderr.on('data', chunk => record('stderr', chunk.toString()));
const frames = [];
createInterface({ input: child.stdout }).on('line', line => {
  try { const frame = JSON.parse(line); frames.push(frame); record('stdout', frame); }
  catch { record('invalid_stdout', line); }
});
const send = frame => { record('stdin', frame); child.stdin.write(JSON.stringify(frame) + '\n'); };
const rpc = (id, method, params) => send({ jsonrpc: '2.0', id, method, params });
async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  do {
    const value = predicate();
    if (value) return value;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await pause(20);
  } while (Date.now() < deadline);
}
const response = (id, ms = 6000) => waitFor(() => frames.find(frame => frame.id === id), ms);
const result = (index, ms) => transport === 'acp' ? response(index + 3, ms)
  : waitFor(() => frames.filter(frame => frame.event === 'result')[index], ms);
const prompt = (index, sessionId, text) => {
  if (transport === 'acp') rpc(index + 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  else send({ event: 'user', message: { content: text } });
};
async function optional(name) {
  try { return await readFile(`${cwd}/${name}`, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

let beforeRelease, first, second, failure;
try {
  let sessionId;
  if (transport === 'acp') {
    rpc(1, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'isolated-fixture', version: '1' } });
    assert.equal((await response(1))?.result?.protocolVersion, 1, 'ACP initialization');
    rpc(2, 'session/new', { cwd, mcpServers: [] });
    const opened = await response(2);
    sessionId = opened?.result?.sessionId;
    assert.ok(sessionId, JSON.stringify(opened));
  }
  prompt(0, sessionId, 'offline first turn');
  assert.match(await waitFor(() => laterOutput, 8000) ?? '', /needle pipe/u, 'AGY must have executed the later tool before measuring export');
  await pause(300);
  beforeRelease = { ms: Date.now() - start, frameCount: frames.length, earlyCount: await optional('early-count'), earlyExit: await optional('early-exit') };
  assert.equal(beforeRelease.earlyCount, 'x', 'early command must have started once');
  if (scenario === 'hold' || scenario === 'cancel') assert.equal(beforeRelease.earlyExit, undefined, 'early command must still be waiting for input');
  if (scenario === 'interactive') assert.match(await optional('interactive-output') ?? '', /needle explicit stdin/u, 'native input must reach the waiting command');
  if (scenario === 'cancel') {
    record('cancel', null);
    if (transport === 'acp') rpc(undefined, 'session/cancel', { sessionId });
    else process.kill(child.pid, 'SIGINT');
  }
  first = await result(0, 15_000);
  assert.ok(first, 'no native terminal response');
  if (scenario === 'cancel') {
    if (transport === 'acp') assert.equal(first.result?.stopReason, 'cancelled', JSON.stringify(first));
    else assert.ok(['INTERRUPTED', 'CANCELED'].includes(first.result?.status) || first.result?.error === 'interrupted' || first.result?.finished_reason === 'interrupted', JSON.stringify(first));
  } else {
    if (transport === 'acp') assert.equal(first.result?.stopReason, 'end_turn', JSON.stringify(first));
    else assert.equal(first.result?.response?.trim(), finalText);
    if (scenario === 'explicit') assert.match(firstOutput ?? '', /needle explicit path/u);
  }
  if (scenario !== 'cancel' || transport === 'acp') {
    nextTurn = true;
    const nextStart = frames.length;
    prompt(1, sessionId, 'offline second turn');
    second = await result(1, 6000);
    assert.ok(second, 'next native turn must settle');
    assert.doesNotMatch(JSON.stringify(frames.slice(nextStart)), /fixture first turn final|early-count|later-count/u, 'first turn leaked into next turn');
    assert.match(JSON.stringify(frames.slice(nextStart)), new RegExp(nextText));
  }
  assert.equal(await optional('early-count'), 'x');
  assert.equal(await optional('later-count'), 'x');
} catch (error) { failure = error.message; }
finally {
  child.stdin.end();
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, 2500);
  const exit = await ended;
  clearTimeout(timer);
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  const prefix = frames.slice(0, beforeRelease?.frameCount ?? 0);
  const laterTool = prefix.find(frame => frame.params?.update?.sessionUpdate === 'tool_call' && JSON.stringify(frame.params.update).includes('later-count'))?.params.update.toolCallId;
  const laterToolBeforeRelease = prefix.some(frame => frame.step_update?.state === 'DONE' && JSON.stringify(frame.step_update).includes('needle pipe') ||
    laterTool !== undefined && frame.params?.update?.toolCallId === laterTool && frame.params.update.status === 'completed');
  const textBeforeRelease = JSON.stringify(prefix).includes(finalText);
  const terminalBeforeRelease = prefix.some(frame => transport === 'acp' ? frame.id === 3 : frame.event === 'result');
  const summary = { version: version.stdout.trim(), transport, scenario, beforeRelease, laterToolBeforeRelease, textBeforeRelease, terminalBeforeRelease, first, second, failure, exit, requests };
  await writeFile('/out/report.json', JSON.stringify({ summary, output }, null, 2));
  console.log(JSON.stringify(summary));
  if (failure) process.exitCode = 1;
}
