import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT = 'engine-default';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function launchArgs(session) {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (session.model !== DEFAULT) args.push('--model', session.model);
  if (session.effort !== DEFAULT) args.push('--effort', session.effort);
  for (const dir of session.additionalDirectories) args.push('--add-dir', dir);
  return args;
}

export function promptText(blocks) {
  if (!Array.isArray(blocks) || blocks.some(b => b.type !== 'text' || typeof b.text !== 'string')) {
    throw new Error('AGY CLI accepts text prompts only; image/audio/resource blocks are unsupported');
  }
  const text = blocks.map(b => b.text).join('\n');
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES / 2) throw new Error('AGY prompt exceeds the adapter frame limit');
  return text;
}

export function configOptions(session) {
  return [{ id: 'effort', name: 'AGY effort', category: 'thought_level', type: 'select', currentValue: session.effort,
    options: [{ value: DEFAULT, name: 'Follow AGY settings' }, ...EFFORTS.map(value => ({ value, name: value }))] }];
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  if (process.platform === 'win32') {
    const killer = spawn(resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise(done => { killer.once('error', done); killer.once('close', done); });
  } else child.kill('SIGTERM');
  await closed;
}

export class AgyBridge {
  constructor({ cliPath, cliPrefix = [], auditDir, model = DEFAULT, spawnProcess = spawn, stopProcess = terminate } = {}) {
    this.stopProcess = stopProcess;
    if (!isAbsolute(cliPath ?? '')) throw new Error('Pass the exact absolute AGY executable path');
    if (typeof model !== 'string' || !model || /\s/.test(model)) throw new Error('AGY model must be a nonempty engine ID');
    this.model = model;
    this.cliPath = cliPath;
    this.cliPrefix = cliPrefix;
    this.auditDir = auditDir;
    this.spawnProcess = spawnProcess;
    this.sessions = new Map();
  }

  async audit(session, type, data) {
    if (!this.auditDir) return;
    await mkdir(this.auditDir, { recursive: true });
    await appendFile(resolve(this.auditDir, `${session.id}.ndjson`), JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n');
  }

  initialize(version) {
    return { protocolVersion: version, agentInfo: { name: 'agy-cli-acp', version: '0.1.0' },
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false }, sessionCapabilities: { additionalDirectories: {} } },
      authMethods: [] };
  }

  async newSession(params) {
    if (params.mcpServers?.length) throw new Error('AGY MCP forwarding is not supported; retain AGY own configured MCP');
    if (params._meta?.systemPromptOverride !== undefined) throw new Error('System replacement is unsupported; use explicit Kiki preamble delivery');
    if (!isAbsolute(params.cwd)) throw new Error('AGY workspace must be absolute');
    const dirs = params.additionalDirectories ?? [];
    if (!Array.isArray(dirs) || dirs.some(d => typeof d !== 'string' || !isAbsolute(d))) throw new Error('Additional directories must be absolute');
    const session = { id: randomUUID(), cwd: params.cwd, additionalDirectories: dirs, model: this.model, effort: DEFAULT,
      child: undefined, active: undefined, broken: false, init: undefined, exited: undefined, toolIds: new Map() };
    this.sessions.set(session.id, session);
    await this.audit(session, 'session_new', { cwd: session.cwd, additionalDirectories: dirs, delivery: 'first_user_preamble', systemOverride: false });
    return { sessionId: session.id, configOptions: configOptions(session) };
  }

  session(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Unknown AGY session; resume/load/fork are unsupported');
    return session;
  }

  setConfig(params) {
    const session = this.session(params.sessionId);
    const key = params.configId === 'effort' ? 'effort' : undefined;
    if (!key || ![DEFAULT, ...EFFORTS].includes(params.value)) throw new Error('Unsupported AGY effort selection; model is selected by argv in its own namespace');
    if (session.child && session[key] !== params.value) throw new Error('AGY model/effort is frozen after process launch; select a fresh session');
    session[key] = params.value;
    return { configOptions: configOptions(session) };
  }

  start(session) {
    const args = [...this.cliPrefix, ...launchArgs(session)];
    const child = this.spawnProcess(this.cliPath, args, { cwd: session.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    session.child = child;
    session.exited = new Promise(done => child.once('close', done));
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let delivery = Promise.resolve();
    const fail = error => {
      session.broken = true;
      if (session.active) { session.active.reject(error); session.active = undefined; }
      void this.stopProcess(child).catch(() => {});
    };
    child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { fail(new Error('AGY stdout frame exceeds 1 MiB')); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        delivery = delivery.then(async () => {
          let event;
          try { event = JSON.parse(line); } catch { throw new Error('AGY emitted invalid NDJSON'); }
          await this.event(session, event);
        }).catch(fail);
      }
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      if (/auto-denied|soft.denied|permission.*denied/i.test(text)) session.denied = true;
      process.stderr.write(chunk);
    });
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.once('close', (code, signal) => {
      delivery.finally(() => {
        session.broken = true;
        if (session.active) {
          session.active.reject(new Error(`AGY exited before terminal result (${code ?? signal})`));
          session.active = undefined;
        }
      }).catch(() => {});
    });
    return this.audit(session, 'launch', { cliPath: this.cliPath, args, pid: child.pid, cwd: session.cwd });
  }

  async settlePendingTools(session, active, status, message) {
    for (const [toolCallId, toolStatus] of session.toolIds) {
      if (toolStatus !== 'pending') continue;
      session.toolIds.set(toolCallId, 'settled');
      await active.client.notify('session/update', { sessionId: session.id,
        update: { sessionUpdate: 'tool_call_update', toolCallId, status, content: [{ type: 'content', content: { type: 'text', text: message } }] } });
    }
  }

  async event(session, event) {
    if (!event || typeof event !== 'object') throw new Error('Invalid AGY event');
    if (event.event === 'init') {
      if (session.init) throw new Error('AGY sent duplicate init');
      const init = event.init;
      if (session.model !== DEFAULT && init?.model !== session.model) throw new Error('AGY init model does not match the explicit binding');
      session.init = event;
      await this.audit(session, 'agy_init', { conversationId: event.conversation_id, model: init?.model,
        agent: init?.agent, cwd: init?.cwd, permissionMode: init?.permission_mode, tools: init?.tools });
      return;
    }
    const active = session.active;
    if (!active) throw new Error('AGY event arrived outside an active turn');
    if (event.event === 'step_update') {
      const step = event.step_update;
      if (!step || typeof step.step_type !== 'string') throw new Error('Malformed AGY step');
      if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
        active.text += step.text_delta;
        await active.client.notify('session/update', { sessionId: session.id,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.text_delta } } });
      }
      if (step.step_type === 'tool') {
        const id = `agy-${event.conversation_id ?? session.init?.conversation_id}-${step.step_index}`;
        if (!session.toolIds.has(id)) {
          session.toolIds.set(id, 'pending');
          await active.client.notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'tool_call',
            toolCallId: id, title: step.tool_name ?? step.tool_info?.name ?? 'AGY tool', kind: 'other', status: 'in_progress', rawInput: step.tool_info?.parameters } });
        }
        if (step.state === 'DONE' && session.toolIds.get(id) === 'pending') {
          session.toolIds.set(id, 'settled');
          await active.client.notify('session/update', { sessionId: session.id,
            update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: step.tool_info?.error ? 'failed' : 'completed',
              rawOutput: step.tool_info?.output, content: typeof step.tool_info?.output === 'string'
                ? [{ type: 'content', content: { type: 'text', text: step.tool_info.output } }] : undefined } });
        }
      }
      return;
    }
    if (event.event !== 'result' || !event.result) throw new Error(`Unsupported AGY event: ${event.event}`);
    const result = event.result;
    await this.audit(session, 'agy_result', { conversationId: result.conversation_id, status: result.status,
      numTurns: result.num_turns, usage: result.usage, deniedActions: result.denied_actions,
      responseSha256: createHash('sha256').update(result.response ?? '').digest('hex') });
    if (session.denied || result.denied_actions?.length) {
      session.denied = false;
      const actions = [...new Set((result.denied_actions ?? []).map(action => typeof action?.action === 'string' ? action.action : 'unknown'))];
      const message = `AGY permission denied${actions.length ? ` for ${actions.join(', ')}` : ''}; no permission bridge or automatic approval is available`;
      await this.settlePendingTools(session, active, 'failed', message);
      process.stderr.write(`${message}\n`);
      const error = new Error(message);
      error.code = 'AGY_PERMISSION_DENIED';
      active.reject(error);
    } else if (result.status === 'CANCELED' || result.status === 'INTERRUPTED') {
      await this.settlePendingTools(session, active, 'failed', `AGY turn ${result.status.toLowerCase()}`);
      active.resolve({ stopReason: 'cancelled' });
    } else if (result.status !== 'SUCCESS') {
      const message = `AGY terminal status ${result.status}: ${result.error ?? 'no success result'}`;
      await this.settlePendingTools(session, active, 'failed', message);
      active.reject(new Error(message));
    } else {
      if ([...session.toolIds.values()].some(status => status === 'pending')) {
        const message = 'AGY terminal result arrived before a tool terminal update';
        await this.settlePendingTools(session, active, 'failed', message);
        active.reject(new Error(message));
      } else {
        if (!active.text && result.response) await active.client.notify('session/update', { sessionId: session.id,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.response } } });
        active.resolve({ stopReason: 'end_turn' });
      }
    }
    session.active = undefined;
  }

  async prompt(params, client) {
    const session = this.session(params.sessionId);
    if (session.broken) throw new Error('AGY process ended; create a fresh session (no implicit resume/history handoff)');
    if (session.active) throw new Error('AGY session already has an active turn');
    const content = promptText(params.prompt);
    const promise = new Promise((resolveTurn, reject) => { session.active = { resolve: resolveTurn, reject, client, text: '' }; });
    promise.catch(() => {});
    try {
      if (!session.child) await this.start(session);
      const frame = JSON.stringify({ event: 'user', message: { content } }) + '\n';
      await this.audit(session, 'prompt_sent', { bytes: Buffer.byteLength(frame),
        promptSha256: createHash('sha256').update(content).digest('hex'),
        frameSha256: createHash('sha256').update(frame).digest('hex'), delivery: 'unchanged_user_text' });
      await new Promise((done, reject) => session.child.stdin.write(frame, error => error ? reject(error) : done()));
      return await promise;
    } catch (error) {
      if (session.active) { session.active = undefined; }
      throw error;
    }
  }

  async cancel(params) {
    const session = this.session(params.sessionId);
    const active = session.active;
    session.active = undefined;
    session.broken = true;
    if (active) await this.settlePendingTools(session, active, 'failed', 'AGY turn cancelled');
    await this.stopProcess(session.child);
    await this.audit(session, 'cancel', { pid: session.child?.pid, processEnded: true, resumeSupported: false });
    active?.resolve({ stopReason: 'cancelled' });
  }

  async close() {
    await Promise.all([...this.sessions.values()].map(async session => {
      const active = session.active; session.active = undefined; session.broken = true;
      active?.reject(new Error('ACP connection closed'));
      if (session.child && session.child.exitCode === null && session.child.signalCode === null) {
        session.child.stdin.end();
        const timer = setTimeout(() => { void this.stopProcess(session.child); }, 3000);
        await session.exited;
        clearTimeout(timer);
      }
    }));
  }
}

export async function runBridge({ sdkPath, cliPath, auditDir, model = DEFAULT } = {}) {
  if (!isAbsolute(sdkPath ?? '')) throw new Error('Pass an installed ACP SDK absolute path');
  const acp = await import(pathToFileURL(sdkPath).href);
  const bridge = new AgyBridge({ cliPath, auditDir, model });
  const connection = acp.agent({ name: 'agy-cli-acp', version: '0.1.0' })
    .onRequest('initialize', () => bridge.initialize(acp.PROTOCOL_VERSION))
    .onRequest('session/new', ctx => bridge.newSession(ctx.params))
    .onRequest('session/set_config_option', ctx => bridge.setConfig(ctx.params))
    .onRequest('session/prompt', async ctx => {
      try { return await bridge.prompt(ctx.params, ctx.client); }
      catch (error) {
        if (error?.code === 'AGY_PERMISSION_DENIED') throw new acp.RequestError(-32000, error.message);
        throw error;
      }
    })
    .onNotification('session/cancel', ctx => bridge.cancel(ctx.params))
    .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
  const shutdown = () => { void bridge.close().finally(() => process.exit(0)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await connection.closed;
  await bridge.close();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes('--version')) console.log('agy-cli-acp 0.1.0');
  else {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--model')) throw new Error('Only --model <AGY model ID> is supported');
    runBridge({ sdkPath: process.env.AGY_ACP_SDK_PATH, cliPath: process.env.AGY_CLI_PATH,
      auditDir: process.env.AGY_BRIDGE_AUDIT_DIR, model: args[1] ?? DEFAULT })
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
