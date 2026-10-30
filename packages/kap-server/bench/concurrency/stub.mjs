import { createServer } from 'node:http';
import { join } from 'node:path';

const config = JSON.parse(process.env.PERF_STUB_CONFIG ?? '{}');
const ttftMs = config.ttftMs ?? 400;
const ttftJitter = config.ttftJitter ?? 0.5;
const tokensPerSec = config.tokensPerSec ?? 120;
const thinkingTokens = config.thinkingTokens ?? 120;
const stepsPerTurn = config.stepsPerTurn ?? 6;
const subagentEvery = config.subagentEvery ?? 3;
const longOutputEvery = config.longOutputEvery ?? 4;
const longOutputTokens = config.longOutputTokens ?? 3000;
const workspaceOf = (session) => config.workspaces[Number(session.slice(1)) % config.workspaces.length];
const records = [];
let stopped = false;
let active = 0;
let maxActive = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const words = 'the quick brown fox jumps over a lazy dog while kiki measures latency under load '.split(' ');
const text = (tokens, seed) => Array.from({ length: tokens }, (_, i) => words[(i + seed) % words.length]).join(' ');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
  return '';
}

function classify(messages) {
  let marker;
  let userCount = 0;
  let stepInTurn = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      const body = textOf(message.content);
      const match = /\[perf (S\d+)(?: (sub\d+))?\]/.exec(body);
      if (match) {
        marker ??= { session: match[1], sub: match[2] };
        userCount += 1;
        stepInTurn = 0;
      }
    } else if (message.role === 'assistant') {
      stepInTurn += 1;
    }
  }
  return marker === undefined ? undefined : { ...marker, turn: userCount, step: stepInTurn };
}

const editCounters = new Map();

function plan(info) {
  const key = info.sub === undefined ? info.session : `${info.session}/${info.sub}`;
  const root = workspaceOf(info.session);
  const id = (name) => `${key.replace('/', '_')}_t${info.turn}_s${info.step}_${name}`;
  const call = (name, args) => ({ id: id(name), name, args });
  if (stopped) return { tools: [], output: 'Stopping.', thinking: 20 };
  if (info.sub !== undefined) {
    if (info.step === 0) return { tools: [
      call('Read', { path: join(root, 'src', `module${info.turn % 20}.ts`), n_lines: 40 }),
      call('Grep', { pattern: 'export function', path: join(root, 'src'), output_mode: 'files_with_matches', head_limit: 10 }),
    ], thinking: thinkingTokens };
    return { tools: [], output: `Subagent summary for ${key}: ${text(80, info.turn)}`, thinking: 40 };
  }
  const cycle = info.step % 3;
  if (info.step >= stepsPerTurn) {
    const long = longOutputEvery > 0 && info.turn % longOutputEvery === 0;
    return { tools: [], output: text(long ? longOutputTokens : 120, info.turn), thinking: thinkingTokens };
  }
  const bigRead = config.bigFile !== undefined && config.bigReadEvery > 0 && info.step === 0 && Number(info.session.slice(1)) % config.bigReadEvery === 0
    ? [call('BigRead', { path: config.bigFile, line_offset: Math.max(1, config.bigFileLines - 300 - ((info.turn * 7919 + Number(info.session.slice(1)) * 104729) % 2000)), n_lines: 20 })]
    : [];
  if (cycle === 0) return { tools: [
    ...bigRead.map((tool) => ({ ...tool, name: 'Read' })),
    call('Read', { path: join(root, 'src', `module${(info.turn + info.step) % 20}.ts`), n_lines: 60 }),
    call('Grep', { pattern: 'value', path: join(root, 'src'), output_mode: 'content', head_limit: 20 }),
    call('Glob', { pattern: '**/*.ts', path: root, head_limit: 30 }),
    call('Read', { path: join(root, 'notes', `${info.session}.md`) }),
  ], thinking: thinkingTokens };
  if (cycle === 1) {
    const file = join(root, 'notes', `${info.session}.md`);
    const counter = editCounters.get(info.session) ?? 0;
    editCounters.set(info.session, counter + 1);
    return { tools: [
      call('TodoList', { todos: [{ title: `Turn ${info.turn} step ${info.step}`, status: 'in_progress' }, { title: 'Verify', status: 'pending' }] }),
      call('Edit', { path: file, old_string: `value-${counter}`, new_string: `value-${counter + 1}` }),
    ], thinking: thinkingTokens };
  }
  if (subagentEvery > 0 && info.turn % subagentEvery === 0 && info.step === 2) return { tools: [
    call('AgentRun', { description: 'Inspect module', profile: 'explore', background: false, prompt: `[perf ${info.session} sub${info.turn}] Inspect the module files and summarize.` }),
  ], thinking: thinkingTokens };
  return { tools: [call('Bash', { command: 'echo perf-probe', timeout: 30 })], thinking: thinkingTokens };
}

function chunk(id, delta, finish = null, usage) {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1790000000, model: 'stub', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
}

async function stream(response, info, body) {
  const action = info === undefined ? { tools: [], output: 'ok', thinking: 0 } : plan(info);
  const id = `cmpl-${records.length}`;
  const tokenDelay = 1000 / tokensPerSec;
  const perChunk = 8;
  const jitter = 1 + (Math.random() * 2 - 1) * ttftJitter;
  await delay(Math.max(0, ttftMs * jitter));
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const firstByteAt = performance.now();
  response.write(chunk(id, { role: 'assistant', content: '' }));
  for (let sent = 0; sent < action.thinking; sent += perChunk) {
    response.write(chunk(id, { reasoning_content: text(Math.min(perChunk, action.thinking - sent), sent) + ' ' }));
    await delay(tokenDelay * perChunk);
  }
  if (action.output !== undefined) {
    const parts = action.output.split(' ');
    for (let i = 0; i < parts.length; i += perChunk) {
      response.write(chunk(id, { content: parts.slice(i, i + perChunk).join(' ') + ' ' }));
      await delay(tokenDelay * perChunk);
    }
  }
  action.tools.forEach((tool, index) => {
    const args = JSON.stringify(tool.args);
    const half = Math.ceil(args.length / 2);
    response.write(chunk(id, { tool_calls: [{ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: args.slice(0, half) } }] }));
    response.write(chunk(id, { tool_calls: [{ index, function: { arguments: args.slice(half) } }] }));
  });
  const promptTokens = Math.ceil(body.length / 4);
  response.write(chunk(id, {}, action.tools.length > 0 ? 'tool_calls' : 'stop', { prompt_tokens: promptTokens, completion_tokens: 200, total_tokens: promptTokens + 200 }));
  response.end('data: [DONE]\n\n');
  return { firstByteAt, tools: action.tools.map((tool) => ({ id: tool.id, name: tool.name })) };
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (data) => chunks.push(data));
  request.on('end', () => {
    const requestAt = performance.now();
    const raw = Buffer.concat(chunks).toString('utf8');
    let info;
    try { info = classify(JSON.parse(raw).messages ?? []); } catch { info = undefined; }
    active += 1;
    maxActive = Math.max(maxActive, active);
    stream(response, info, raw).then(({ firstByteAt, tools }) => {
      records.push({ session: info?.session, sub: info?.sub, turn: info?.turn, step: info?.step, requestAt, firstByteAt, responseAt: performance.now(), bytesIn: raw.length, tools });
    }, (error) => {
      records.push({ session: info?.session, sub: info?.sub, error: String(error), requestAt, responseAt: performance.now() });
      response.destroy();
    }).finally(() => { active -= 1; });
  });
});

server.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', port: server.address().port, clock: performance.timeOrigin });
});

process.on('message', (message) => {
  if (message.type === 'stop-tools') stopped = true;
  if (message.type === 'collect') process.send({ type: 'records', records, maxActive, clock: performance.timeOrigin });
  if (message.type === 'exit') server.close(() => process.exit(0));
});
