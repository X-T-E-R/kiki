import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline';
import { setTimeout as pause } from 'node:timers/promises';

const [transport, scenario, observation] = process.argv.slice(2);
assert.ok(observation === undefined || observation === 'observe', 'Optional observation must be observe');
assert.ok(['stream', 'acp'].includes(transport), 'Choose stream or acp');
assert.ok(['hold', 'pathless', 'explicit', 'interactive', 'cancel', 'account-model'].includes(scenario), 'Choose hold, pathless, explicit, interactive, cancel or account-model');
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 1000);
assert.deepEqual(Object.keys(networkInterfaces()), ['lo']);
assert.equal((await readFile('/proc/net/route', 'utf8')).trim().split('\n').length, 1);
for (const socket of ['/run/dbus/system_bus_socket', '/run/user/1000/bus']) await assert.rejects(access(socket));

const home = '/tmp/agy-home';
const cwd = '/tmp/agy-workspace';
const appData = `${home}/.gemini/antigravity-cli`;
const accountModel = scenario === 'account-model';
const fileSearch = accountModel || scenario === 'explicit';
const model = accountModel ? 'claude-opus-5-5-high' : 'gemini-3.1-pro-low';
const generationPath = `/v1beta/models/${accountModel ? model : 'gemini-3.1-pro-preview'}:streamGenerateContent`;
const key = 'offline-fixture-only';
const settings = { modelProvider: 'gemini', toolPermission: 'always-proceed', agentMode: 'accept-edits', enableTerminalSandbox: false };
if (accountModel) {
  settings.model = model;
  settings.customModelsConfig = { customModels: { [model]: { modelName: `gemini-api://models/${model}`, toolFormatterType: 'TOOL_FORMATTER_TYPE_NONE' } } };
}
await mkdir(appData, { recursive: true });
await mkdir(cwd);
await writeFile(`${appData}/settings.json`, JSON.stringify(settings));
await writeFile(`${cwd}/input.txt`, 'needle explicit path\n');
if (observation) {
  await writeFile('/tmp/observe-hook.mjs', `import { appendFile, readFile } from 'node:fs/promises';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
let transcript, transcriptError;
try { transcript = await readFile(input.transcriptPath, 'utf8'); }
catch (error) { transcriptError = { code: error.code, message: error.message }; }
await appendFile('/tmp/agy-workspace/hook-events.ndjson', JSON.stringify({ at: Date.now(), hook: process.argv[2], input, transcript, transcriptError }) + '\\n');
process.stdout.write(process.argv[2] === 'Stop' ? '{"decision":"stop"}' : '{}');
`);
  const handler = hook => ({ type: 'command', command: `node /tmp/observe-hook.mjs ${hook}`, timeout: 5 });
  await mkdir(`${cwd}/.agents`);
  await writeFile(`${cwd}/.agents/hooks.json`, JSON.stringify({ 'offline-observation': {
    SessionStart: [handler('SessionStart')],
    PostToolUse: [{ matcher: '*', hooks: [handler('PostToolUse')] }],
    PostInvocation: [handler('PostInvocation')],
    Stop: [handler('Stop')],
  } }));
}

const output = [];
const start = Date.now();
const record = (kind, data) => output.push({ ms: Date.now() - start, kind, data });
const early = fileSearch ? '/rg -n needle input.txt'
  : scenario === 'interactive' ? 'timeout --foreground 12s /rg --line-buffered -n needle - > interactive-output'
    : scenario === 'pathless' ? 'timeout 12s /rg -n needle' : 'sleep 12 | /rg -n needle';
const command = (CommandLine, WaitMsBeforeAsync) => call('run_command', { CommandLine, toolSummary: 'Offline command fixture', WaitMsBeforeAsync });
const call = (name, args) => ({ functionCall: { name, args } });
const earlyCall = command(`printf x >> early-count; ${early}; code=$?; printf %s "$code" > early-exit; exit "$code"`, 500);
const laterCall = command("printf x >> later-count; printf 'needle pipe\\n' | /rg -n needle -", 500);
const finalText = 'fixture first turn final';
const nextText = 'fixture second turn final';
let requests = 0;
let laterOutput;
let firstOutput;
let nextTurn = false;
let nextReply = false;
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
  else if (req.headers['x-goog-api-key'] === key && path === generationPath) {
    const n = ++requests;
    if (nextTurn && !nextReply) { nextReply = true; part = { text: nextText }; }
    else if (nextTurn && scenario === 'hold' && n === 5) part = { text: 'fixture background task settled' };
    else if (n === 1) part = earlyCall;
    else if (n === 2 && scenario === 'interactive') {
      const task = JSON.stringify(replies).match(/[0-9a-f-]{36}\/task-\d+/u)?.[0];
      if (task) part = call('manage_task', { Action: 'send_input', TaskId: task, Input: 'needle explicit stdin\n\u0004' });
    } else if (n === (scenario === 'interactive' ? 3 : 2)) {
      firstOutput = JSON.stringify(replies);
      part = laterCall;
    } else if (n === (scenario === 'interactive' ? 4 : 3)) {
      laterOutput = JSON.stringify(replies);
      if (scenario === 'cancel') return; // The fixture leaves this request pending until the harness cancels.
      part = { text: finalText };
    } else if (transport === 'stream' && (scenario === 'hold' || scenario === 'interactive') && n === (scenario === 'interactive' ? 5 : 4)) {
      // Headless starts a follow-up model call when the background task finishes.
      part = { text: 'fixture background task settled' };
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
const version = spawnSync('/agy', ['--version'], { cwd, env, encoding: 'utf8', timeout: 15000 });
assert.equal(version.status, 0, JSON.stringify({ error: version.error?.message, signal: version.signal, stderr: version.stderr }));
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
    const value = await predicate();
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
    rpc(10, 'authenticate', { methodId: 'gemini-api-key' });
    const authenticated = await response(10);
    assert.ok(authenticated?.result, JSON.stringify(authenticated));
    rpc(2, 'session/new', { cwd, mcpServers: [] });
    const opened = await response(2);
    sessionId = opened?.result?.sessionId;
    assert.ok(sessionId, JSON.stringify(opened));
    rpc(11, 'session/set_model', { sessionId, modelId: model });
    const selected = await response(11);
    assert.ok(selected?.result, JSON.stringify(selected));
  }
  prompt(0, sessionId, 'offline first turn');
  assert.match(await waitFor(() => laterOutput, 8000) ?? '', /needle pipe/u, 'AGY must have executed the later tool before measuring export');
  await pause(300);
  beforeRelease = { ms: Date.now() - start, frameCount: frames.length, earlyCount: await optional('early-count'), earlyExit: await optional('early-exit') };
  if (observation) {
    const hooks = await optional('hook-events.ndjson');
    record('observation_before_release', hooks);
    assert.ok(hooks, 'no public observation hook ran');
  }
  assert.equal(beforeRelease.earlyCount, 'x', 'early command must have started once');
  if (scenario === 'hold' || scenario === 'cancel') assert.equal(beforeRelease.earlyExit, undefined, 'early command must still be waiting for input');
  if (scenario === 'interactive') assert.match(await waitFor(async () => {
    const text = await optional('interactive-output');
    return text?.includes('needle explicit stdin') ? text : undefined;
  }, 2000) ?? '', /needle explicit stdin/u, 'native input must reach the waiting command');
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
    else {
      assert.equal(first.result?.status, 'SUCCESS', JSON.stringify(first));
      assert.ok(first.result.response.includes(finalText));
    }
    if (fileSearch) assert.match(firstOutput ?? '', /needle explicit path/u);
  }
  if (scenario !== 'cancel' || transport === 'acp') {
    nextTurn = true;
    const nextStart = frames.length;
    prompt(1, sessionId, 'offline second turn');
    second = await result(1, 6000);
    assert.equal(transport === 'acp' ? second?.result?.stopReason : second?.result?.status, transport === 'acp' ? 'end_turn' : 'SUCCESS', 'next native turn must settle');
    assert.doesNotMatch(JSON.stringify(frames.slice(nextStart)), /fixture first turn final|early-count|later-count/u, 'first turn leaked into next turn');
    assert.match(JSON.stringify(frames.slice(nextStart)), new RegExp(nextText));
  }
  if (scenario === 'hold' && transport === 'acp') {
    assert.notEqual(await waitFor(() => optional('early-exit'), 13_000), undefined, 'held command must exit during observation');
    await pause(300);
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
  const acpToolId = marker => frames.find(frame => frame.params?.update?.sessionUpdate === 'tool_call' && frame.params.update.rawInput?.CommandLine?.includes(marker))?.params.update.toolCallId;
  const earlyTool = acpToolId('early-count');
  const laterTool = acpToolId('later-count');
  const laterComplete = frame => frame.step_update?.state === 'DONE' && frame.step_update.tool_info?.output?.includes('needle pipe') ||
    laterTool !== undefined && frame.params?.update?.toolCallId === laterTool && frame.params.update.status === 'completed';
  const earlyTerminal = frame => transport === 'stream'
    ? ['DONE', 'ERROR'].includes(frame.step_update?.state) && frame.step_update.tool_info?.parameters?.CommandLine?.includes('early-count')
    : earlyTool !== undefined && frame.params?.update?.toolCallId === earlyTool && ['completed', 'failed'].includes(frame.params.update.status);
  const terminal = frame => transport === 'acp' ? frame.id === 3 : frame.event === 'result';
  const laterToolBeforeRelease = prefix.some(laterComplete);
  const textBeforeRelease = JSON.stringify(prefix).includes(finalText);
  const terminalBeforeRelease = prefix.some(terminal);
  const earlyExit = await optional('early-exit');
  const timing = {
    modelSawLaterOutputMs: output.find(entry => entry.kind === 'model_request' && JSON.stringify(entry.data.replies).includes('needle pipe'))?.ms,
    laterToolCompleteMs: output.find(entry => entry.kind === 'stdout' && laterComplete(entry.data))?.ms,
    firstTextMs: output.find(entry => entry.kind === 'stdout' && JSON.stringify(entry.data).includes(finalText))?.ms,
    firstTerminalMs: output.find(entry => entry.kind === 'stdout' && terminal(entry.data))?.ms,
    earlyExitedMs: earlyExit === undefined ? undefined : Math.round((await stat(`${cwd}/early-exit`)).mtimeMs - start),
    earlyToolTerminalMs: output.find(entry => entry.kind === 'stdout' && earlyTerminal(entry.data))?.ms,
  };
  const hooks = observation ? (await optional('hook-events.ndjson'))?.trim().split('\n').map(JSON.parse) : undefined;
  const summary = { version: version.stdout.trim(), rgVersion: rgVersion.stdout.split('\n')[0], transport, scenario, observation, model, generationPath, beforeRelease, timing, laterToolBeforeRelease, textBeforeRelease, terminalBeforeRelease, earlyExit, first, second, failure, exit, requests };
  await writeFile('/out/report.json', JSON.stringify({ summary, output, hooks }, null, 2));
  console.log(JSON.stringify(summary));
  if (failure) process.exitCode = 1;
}
