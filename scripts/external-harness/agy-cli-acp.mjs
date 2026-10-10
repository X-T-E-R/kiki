import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, open, unlink } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerProjectHook, recoverProjectHook } from './agy-hook-registration.mjs';
import { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { openPermissionChannel, permissionChannelIdentity } from './agy-permission-hook.mjs';

const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT = 'engine-default';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export function launchArgs(session) {
  validateEffort(session.model, session.effort);
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (session.conversationId) args.push('--conversation', session.conversationId);
  if (session.model !== DEFAULT) args.push('--model', session.model);
  if (session.effort !== DEFAULT) args.push('--effort', session.effort);
  for (const dir of session.additionalDirectories) args.push('--add-dir', dir);
  return args;
}

export function canonicalTool(name, args, cwd) {
  if (name === 'run_command') return { name: 'Bash', kind: 'execute', input: { command: args.CommandLine, cwd: args.Cwd ?? cwd } };
  if (name === 'view_file') return { name: 'Read', kind: 'read', input: { path: args.AbsolutePath } };
  if (name === 'write_to_file') return { name: 'Write', kind: 'edit', input: { path: args.TargetFile } };
  if (name === 'replace_file_content' || name === 'multi_replace_file_content') return { name: 'Edit', kind: 'edit', input: { path: args.TargetFile } };
  if (name === 'find_by_name') return { name: 'Glob', kind: 'search', input: { path: args.SearchDirectory, pattern: args.Pattern } };
  if (name === 'list_dir') return { name: 'Glob', kind: 'search', input: { path: args.DirectoryPath } };
  if (name === 'grep_search') return { name: 'Grep', kind: 'search', input: { path: args.SearchPath, pattern: args.Query } };
  return { name, kind: 'other', input: args };
}

/** Official PreToolUse resource strings for this call only; never a cached grant. */
export function toolPermissionResources(name, args) {
  let action; let target;
  if (name === 'run_command') { action = 'command'; target = args.CommandLine; }
  else if (['write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(name)) { action = 'write_file'; target = args.TargetFile; }
  else if (name === 'view_file') { action = 'read_file'; target = args.AbsolutePath; }
  else if (name === 'list_dir') { action = 'read_file'; target = args.DirectoryPath; }
  else if (name === 'find_by_name') { action = 'read_file'; target = args.SearchDirectory; }
  else if (name === 'grep_search') { action = 'read_file'; target = args.SearchPath; }
  return action && typeof target === 'string' && target.length > 0 ? [`${action}(${target})`] : undefined;
}

export function promptText(blocks) {
  if (!Array.isArray(blocks) || blocks.some(b => b.type !== 'text' || typeof b.text !== 'string')) {
    throw new Error('AGY CLI accepts text prompts only; image/audio/resource blocks are unsupported');
  }
  const text = blocks.map(b => b.text).join('\n');
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES / 2) throw new Error('AGY prompt exceeds the adapter frame limit');
  return text;
}

export function encodedEffort(model) {
  return EFFORTS.find(effort => model.endsWith(`-${effort}`));
}

export function validateEffort(model, effort) {
  if (![DEFAULT, ...EFFORTS].includes(effort)) throw new Error('Unsupported AGY effort selection');
  const encoded = encodedEffort(model);
  if (effort !== DEFAULT && encoded && effort !== encoded) {
    throw new Error(`AGY model ID ${model} encodes effort ${encoded} and conflicts with effort ${effort}; select the corresponding raw AGY model ID instead`);
  }
}

export function configOptions(session) {
  const effort = encodedEffort(session.model);
  return [{ id: 'effort', name: 'AGY effort', category: 'thought_level', type: 'select', currentValue: session.effort,
    options: [{ value: DEFAULT, name: 'Follow AGY settings' }, ...(effort ? [{ value: effort, name: effort }] : [])] }];
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
      agentCapabilities: { loadSession: Boolean(this.auditDir), promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false }, sessionCapabilities: { additionalDirectories: {} } },
      authMethods: [] };
  }

  async requestPermission(session, input) {
    if (!session.hostGate) return {};
    const active = session.active;
    const reject = reason => ({ decision: 'deny', reason });
    if (!active || session.broken || typeof active.client.request !== 'function') return reject('Kiki AGY permission gate is unavailable for this turn');
    if (!input || typeof input.conversationId !== 'string' || !Number.isSafeInteger(input.stepIdx) || input.stepIdx < 0
      || !input.toolCall || typeof input.toolCall.name !== 'string' || !input.toolCall.args || typeof input.toolCall.args !== 'object') {
      return reject('Invalid AGY PreToolUse payload');
    }
    if (!session.init || input.conversationId !== session.init.conversation_id) return reject('AGY permission conversation identity does not match this session');
    const id = `agy-${input.conversationId}-${input.stepIdx}`;
    const name = input.toolCall.name;
    const args = input.toolCall.args;
    const canonical = canonicalTool(name, args, session.cwd);
    await this.audit(session, 'permission_request', { toolCallId: id, name, policyIdentity: session.permission.policyIdentity, override: session.permission.override });
    const controller = new AbortController();
    session.permissionRequests.add(controller);
    let response;
    try {
      response = await active.client.request('session/request_permission', {
        sessionId: session.id,
        toolCall: { toolCallId: id, title: name, kind: canonical.kind, status: 'in_progress', rawInput: args },
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
          { optionId: 'kiki.vendor_default', name: 'Use vendor permissions', kind: 'allow_once' }],
        _meta: { 'kiki.tool': { name: canonical.name, input: canonical.input } },
      }, { signal: controller.signal });
    } finally { session.permissionRequests.delete(controller); }
    if (session.active !== active || session.broken) return reject('Kiki AGY turn ended while awaiting permission');
    if (response?.outcome?.outcome === 'selected' && response.outcome.optionId === 'kiki.vendor_default') {
      await this.audit(session, 'permission_decision', { toolCallId: id, decision: 'vendor_default' });
      return {};
    }
    const allow = response?.outcome?.outcome === 'selected' && ['allow_once', 'allow_always'].includes(response.outcome.optionId);
    const permissionOverrides = allow ? toolPermissionResources(name, args) : undefined;
    if (allow) (active.hostApproved ??= new Set()).add(id);
    await this.audit(session, 'permission_decision', { toolCallId: id, decision: allow ? 'allow' : 'deny', permissionOverrides });
    return allow ? { decision: 'allow', reason: 'Approved by the current Kiki permission gate', permissionOverrides }
      : reject('The current Kiki permission gate rejected or cancelled this action');
  }

  async newSession(params, id = randomUUID(), event = 'session_new') {
    if (params.mcpServers?.length) throw new Error('AGY MCP forwarding is not supported; retain AGY own configured MCP');
    if (params._meta?.systemPromptOverride !== undefined) throw new Error('System replacement is unsupported; use explicit Kiki preamble delivery');
    if (!isAbsolute(params.cwd)) throw new Error('AGY workspace must be absolute');
    const dirs = params.additionalDirectories ?? [];
    if (!Array.isArray(dirs) || dirs.some(d => typeof d !== 'string' || !isAbsolute(d))) throw new Error('Additional directories must be absolute');
    const session = { id, cwd: params.cwd, additionalDirectories: dirs, model: this.model, effort: DEFAULT,
      permission: undefined, hostGate: false, permissionIdentity: permissionChannelIdentity(),
      permissionRequests: new Set(), permissionChannel: undefined, permissionRegistration: undefined,
      child: undefined, active: undefined, broken: false, init: undefined, exited: undefined, toolIds: new Map() };
    this.permissionSnapshot(session, params._meta?.['kiki.permission']);
    this.sessions.set(session.id, session);
    await this.audit(session, event, { cwd: session.cwd, additionalDirectories: dirs, delivery: event === 'session_new' ? 'first_user_preamble' : 'native_conversation', systemOverride: false });
    return { sessionId: session.id, configOptions: configOptions(session) };
  }

  async loadSession(params) {
    if (!this.auditDir) throw new Error('AGY native load requires the existing adapter audit directory');
    if (!/^[0-9a-f-]{36}$/i.test(params.sessionId)) throw new Error('Invalid AGY adapter session ID');
    if (this.sessions.has(params.sessionId)) throw new Error('AGY session is already owned by this connection');
    const records = (await readFile(resolve(this.auditDir, `${params.sessionId}.ndjson`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const workspace = records.find(record => record.type === 'session_new');
    const launch = records.findLast(record => record.type === 'launch');
    const init = records.findLast(record => record.type === 'agy_init');
    if (!workspace || !launch || !init?.conversationId || records.indexOf(init) < records.indexOf(launch)) {
      throw new Error('AGY session has no confirmed native conversation to load; retain the failed attempt and create a new session');
    }
    if (resolve(params.cwd) !== resolve(workspace.cwd)
      || JSON.stringify(params.additionalDirectories ?? []) !== JSON.stringify(workspace.additionalDirectories ?? [])) {
      throw new Error('AGY native load workspace differs from its original binding');
    }
    const argValue = name => { const index = launch.args.lastIndexOf(name); return index < 0 ? DEFAULT : launch.args[index + 1]; };
    const model = argValue('--model') === DEFAULT ? init.model : argValue('--model');
    if (typeof model !== 'string' || !model || this.model !== DEFAULT && model !== this.model) throw new Error('AGY native load model differs from its original binding or was not confirmed');
    const effort = argValue('--effort');
    validateEffort(model, effort);
    if (processAlive(launch.pid)) throw new Error('AGY native conversation still has an owned process; close it before loading');
    const path = resolve(this.auditDir, `${params.sessionId}.resume-lock`);
    const claim = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    let file;
    try { file = await open(path, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readFile(path, 'utf8');
      if (processAlive(JSON.parse(previous).pid)) throw new Error('AGY native conversation is already being loaded');
      throw new Error(`AGY native load lease is stale; recover only this exact owned lease after confirming no live adapter: ${path}`);
    }
    await file.writeFile(claim);
    await file.close();
    const release = async () => {
      try { if (await readFile(path, 'utf8') === claim) await unlink(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    try {
      await this.newSession(params, params.sessionId, 'session_loaded');
      const session = this.session(params.sessionId);
      session.model = model;
      session.effort = effort;
      session.conversationId = init.conversationId;
      session.releaseResume = release;
      return { configOptions: configOptions(session) };
    } catch (error) { await release(); this.sessions.delete(params.sessionId); throw error; }
  }

  session(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Unknown AGY session; use session/load for exact audited native recovery. Fork is unsupported');
    return session;
  }

  setConfig(params) {
    const session = this.session(params.sessionId);
    const key = params.configId === 'effort' ? 'effort' : undefined;
    if (!key) throw new Error('Unsupported AGY config option; model is selected by argv in its own namespace');
    if (session.child && session[key] !== params.value) throw new Error('AGY model/effort is frozen after process launch; select a fresh session');
    validateEffort(session.model, params.value);
    session[key] = params.value;
    return { configOptions: configOptions(session) };
  }

  permissionSnapshot(session, permission) {
    const hostGate = permission?.hostGate === true;
    if (hostGate && (permission.version !== 1
      || permission.override !== undefined && (!['manual', 'auto', 'review', 'yolo'].includes(permission.override.mode)
        || typeof permission.override.source !== 'string' || !permission.override.source)
      || typeof permission.policyIdentity !== 'string' || !permission.policyIdentity
      || permission.workspace?.cwd !== session.cwd
      || JSON.stringify(permission.workspace?.additionalDirectories ?? []) !== JSON.stringify(session.additionalDirectories))) {
      throw new Error('AGY permission bridge requires a matching frozen Kiki permission context');
    }
    session.permission = permission === undefined ? undefined : structuredClone(permission);
    session.hostGate = hostGate;
  }

  /**
   * A native child cannot receive new environment variables mid-session. Its random
   * channel identity is fixed at launch; inherited turns return the vendor's empty
   * default and do not register a project hook. The per-turn hostGate snapshot
   * controls only the owned project key, preserving the native process and history.
   */
  async syncPermissionHook(session) {
    session.permissionChannel ??= await openPermissionChannel(input => this.requestPermission(session, input), session.permissionIdentity);
    if (!session.hostGate) {
      await session.permissionRegistration?.close();
      session.permissionRegistration = undefined;
      return;
    }
    session.permissionRegistration ??= await registerProjectHook({ cwd: session.cwd, nodePath: process.execPath,
      handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)), sessionId: session.id });
  }

  async start(session) {
    const args = [...this.cliPrefix, ...launchArgs(session)];
    const env = { ...process.env, ...session.permissionIdentity };
    let child;
    try {
      child = this.spawnProcess(this.cliPath, args, { cwd: session.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    } catch (error) {
      await session.permissionChannel?.close();
      await session.permissionRegistration?.close();
      throw error;
    }
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
      session.cleanup = delivery.finally(async () => {
        session.broken = true;
        if (session.active) {
          session.active.reject(new Error(`AGY exited before terminal result (${code ?? signal})`));
          session.active = undefined;
        }
        for (const controller of session.permissionRequests) controller.abort(new Error('AGY process ended'));
        await session.permissionChannel?.close();
        await session.permissionRegistration?.close();
        await session.releaseResume?.();
      });
      session.cleanup.catch(error => { process.stderr.write(`AGY owned permission cleanup failed: ${error.message}\n`); });
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
      if (session.conversationId && event.conversation_id !== session.conversationId) throw new Error('AGY init conversation does not match the exact native resume binding');
      session.init = event;
      await this.audit(session, 'agy_init', { conversationId: event.conversation_id, model: init?.model,
        agent: init?.agent, cwd: init?.cwd, permissionMode: init?.permission_mode, tools: init?.tools });
      return;
    }
    const active = session.active;
    if (!active && session.broken) return;
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
        await this.audit(session, 'tool_state', { toolCallId: id, name: step.tool_name ?? step.tool_info?.name, state: step.state });
        if ((step.state === 'DONE' || step.state === 'ERROR') && session.toolIds.get(id) === 'pending') {
          const failed = step.state === 'ERROR' || Boolean(step.tool_info?.error);
          const error = step.tool_info?.error ?? step.error;
          const errorText = typeof error === 'string' ? error : error?.message;
          const output = step.tool_info?.output ?? errorText ?? (failed ? 'AGY tool reported an error' : undefined);
          if (failed && /^tool call denied by pre-tool hook:/i.test(String(errorText ?? output ?? '').trimStart())) {
            (active.preToolDenied ??= new Set()).add(id);
            await this.audit(session, 'pre_tool_hook_denied', { toolCallId: id, error: errorText ?? output });
          }
          if (failed && active.hostApproved?.has(id) && /permission.*(?:denied|failed)|vendor resource permission denied/i.test(errorText ?? output ?? '')) {
            (active.vendorRejected ??= new Set()).add(id);
            await this.audit(session, 'vendor_denied_after_host_allow', { toolCallId: id, error: errorText ?? output });
          }
          await active.client.notify('session/update', { sessionId: session.id,
            update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: failed ? 'failed' : 'completed',
              rawOutput: output, content: typeof output === 'string'
                ? [{ type: 'content', content: { type: 'text', text: output } }] : undefined } });
          session.toolIds.set(id, 'settled');
        }
      }
      return;
    }
    if (event.event !== 'result' || !event.result) throw new Error(`Unsupported AGY event: ${event.event}`);
    const result = event.result;
    await this.audit(session, 'agy_result', { conversationId: result.conversation_id, status: result.status,
      numTurns: result.num_turns, usage: result.usage, deniedActions: result.denied_actions,
      responseSha256: createHash('sha256').update(result.response ?? '').digest('hex') });
    if (session.denied || result.denied_actions?.length || active.preToolDenied?.size) {
      session.denied = false;
      const actions = [...new Set((result.denied_actions ?? []).map(action => typeof action?.action === 'string' ? action.action : 'unknown'))];
      const message = `AGY permission denied${actions.length ? ` for ${actions.join(', ')}` : ''}; ${active.preToolDenied?.size
        ? 'a PreToolUse hook rejected a tool before execution; retain the denial and repair the hook admission contract before retrying; terminal SUCCESS is not evidence that the requested work ran'
        : active.vendorRejected?.size
          ? 'the native AGY permission engine rejected a tool after Kiki approved this exact call; retain the denial and restore the vendor approval contract before retrying'
          : 'the native AGY permission policy did not approve the action'}`;
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
      if (Object.hasOwn(params._meta ?? {}, 'kiki.permission')) this.permissionSnapshot(session, params._meta['kiki.permission']);
      await this.syncPermissionHook(session);
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
    for (const controller of session.permissionRequests) controller.abort(new Error('AGY turn cancelled'));
    if (active) await this.settlePendingTools(session, active, 'failed', 'AGY turn cancelled');
    await session.permissionChannel?.close();
    await this.stopProcess(session.child);
    await session.cleanup;
    await session.permissionRegistration?.close();
    await this.audit(session, 'cancel', { pid: session.child?.pid, processEnded: true, resumeSupported: false });
    active?.resolve({ stopReason: 'cancelled' });
  }

  close() {
    this.closePromise ??= Promise.all([...this.sessions.values()].map(async session => {
      const active = session.active; session.active = undefined; session.broken = true;
      for (const controller of session.permissionRequests) controller.abort(new Error('ACP connection closed'));
      try {
        if (active) await this.settlePendingTools(session, active, 'failed', 'ACP connection closed');
      } finally {
        active?.reject(new Error('ACP connection closed'));
        await session.permissionChannel?.close();
        if (session.child && session.child.exitCode === null && session.child.signalCode === null) {
          session.child.stdin.end();
          const timer = setTimeout(() => { void this.stopProcess(session.child); }, 3000);
          try { await session.exited; } finally { clearTimeout(timer); }
        }
        await session.cleanup;
        await session.permissionRegistration?.close();
        await session.releaseResume?.();
        await this.audit(session, 'close', { pid: session.child?.pid, processEnded: true });
      }
    }));
    return this.closePromise;
  }
}

export async function runBridge({ sdkPath, cliPath, cliPrefix = [], auditDir, model = DEFAULT } = {}) {
  if (!isAbsolute(sdkPath ?? '')) throw new Error('Pass an installed ACP SDK absolute path');
  const acp = await import(pathToFileURL(sdkPath).href);
  const bridge = new AgyBridge({ cliPath, cliPrefix, auditDir, model });
  const connection = acp.agent({ name: 'agy-cli-acp', version: '0.1.0' })
    .onRequest('initialize', () => bridge.initialize(acp.PROTOCOL_VERSION))
    .onRequest('session/new', ctx => bridge.newSession(ctx.params))
    .onRequest('session/load', ctx => bridge.loadSession(ctx.params))
    .onRequest('session/set_config_option', ctx => bridge.setConfig(ctx.params))
    .onRequest('session/prompt', async ctx => {
      try { return await bridge.prompt(ctx.params, ctx.client); }
      catch (error) {
        throw new acp.RequestError(-32000, error instanceof Error ? error.message : String(error));
      }
    })
    .onNotification('session/cancel', ctx => bridge.cancel(ctx.params))
    .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void bridge.close().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.stdin.once('end', shutdown);
  try { await connection.closed; } finally { await bridge.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes('--version')) console.log('agy-cli-acp 0.1.0');
  else {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === '--recover-project-hook') {
      if (!isAbsolute(args[1])) throw Error('AGY hook recovery workspace must be absolute');
      recoverProjectHook({ cwd: args[1], nodePath: process.execPath,
        handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)) })
        .then(result => console.log(JSON.stringify(result)))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
    } else {
      if (args.length && (args.length !== 2 || args[0] !== '--model')) throw new Error('Only --model <AGY model ID> or --recover-project-hook <workspace> is supported');
      runBridge({ sdkPath: process.env.AGY_ACP_SDK_PATH, cliPath: process.env.AGY_CLI_PATH,
        auditDir: process.env.AGY_BRIDGE_AUDIT_DIR, model: args[1] ?? DEFAULT })
        .catch(error => { console.error(error.message); process.exitCode = 1; });
    }
  }
}
