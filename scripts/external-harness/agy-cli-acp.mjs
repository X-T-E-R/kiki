import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, open, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { registerProjectMcpPlugin, recoverProjectMcpPlugin, recoverDeadProjectMcpPlugins } from './agy-mcp-plugin.mjs';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerProjectHook, recoverProjectHook, AGY_STEERING_HOOK_KEY } from './agy-hook-registration.mjs';
import { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { openPermissionChannel, permissionChannelIdentity, requestHookPermission } from './agy-permission-hook.mjs';

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
  if (session.effort !== DEFAULT && !session.model.startsWith('claude-')) args.push('--effort', session.effort);
  if (session.hostGate && session.permission?.override?.mode === 'yolo') args.push('--dangerously-skip-permissions');
  for (const dir of session.additionalDirectories) args.push('--add-dir', dir);
  return args;
}

function readUrlTarget(args) {
  if (!args || Object.keys(args).some(key => key !== 'Url') || typeof args.Url !== 'string' ||
    !/^https?:\/\//iu.test(args.Url) || /[\s\\\u0000-\u001F\u007F]/u.test(args.Url)) throw new Error('AGY URL reads require one credential-free HTTP(S) Url');
  let url;
  try { url = new URL(args.Url); } catch { throw new Error('AGY URL reads require one credential-free HTTP(S) Url'); }
  if (!url.hostname || url.username || url.password) throw new Error('AGY URL reads require one credential-free HTTP(S) Url');
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1);
  return url;
}

export function canonicalTool(name, args, cwd) {
  if (name === 'read_url_content') return { name: 'FetchURL', nativeName: name, kind: 'fetch', input: { url: readUrlTarget(args).href } };
  if (name === 'manage_task' && Object.keys(args).every(key => ['Action', 'TaskId', 'Input'].includes(key)) &&
    ['TaskId', 'Input'].every(key => args[key] === undefined || typeof args[key] === 'string')) {
    if (args.Action === 'list') return { name: 'TaskList', nativeName: name, kind: 'read', input: args };
    if (args.Action === 'status' && typeof args.TaskId === 'string' && args.TaskId.length > 0) {
      return { name: 'TaskOutput', nativeName: name, kind: 'read', input: args };
    }
  }
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
  if (name === 'read_url_content') return [`read_url(${readUrlTarget(args).hostname})`];
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
    throw new Error('This AGY ACP adapter accepts text prompts only; CLI rich-input support has not been verified');
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
  if (effort === DEFAULT) return;
  if (encoded === undefined) {
    throw new Error(`AGY model ID ${model} does not embed an effort; effort ${effort} is not an advertised config for this id`);
  }
  if (effort !== encoded) {
    throw new Error(`AGY model ID ${model} encodes effort ${encoded} and conflicts with effort ${effort}; select the corresponding raw AGY model ID instead`);
  }
}

const CATALOG_TIMEOUT_MS = 20_000;
const CATALOG_MAX_BYTES = 65_536;

/** First whitespace token of each `agy models` row. Header and comment rows are not ids. */
export function vendorModelIds(output) {
  const values = [];
  const seen = new Set();
  for (const line of String(output).split(/\r?\n/u)) {
    const first = (line.trim().split(/\s+/u)[0] ?? '').trim();
    if (first === '' || first.startsWith('#') || /^(?:id|model|models|name)$/iu.test(first)) continue;
    if (first.length > 256 || /\s/u.test(first) || seen.has(first)) continue;
    seen.add(first);
    values.push(first);
  }
  return values;
}

function safeDiagnosticLine(text) {
  const line = text.trim();
  if (line.length === 0 || /(?:token|bearer|api[_-]?key|secret|authorization|password)/iu.test(line) || /[A-Za-z0-9+/_-]{32,}={0,2}/u.test(line) || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(line)) return undefined;
  return line.slice(0, 180);
}

export function catalogDiagnostic(text) {
  const line = String(text).split(/\r?\n/u).map(part => part.trim()).find(Boolean) ?? '';
  return safeDiagnosticLine(line) ?? 'AGY model catalog probe failed';
}

export function readVendorModelCatalog({ cliPath, cliPrefix = [], spawnProcess = spawn, stopProcess, timeoutMs = CATALOG_TIMEOUT_MS, maxOutputBytes = CATALOG_MAX_BYTES } = {}) {
  return new Promise(resolveCatalog => {
    let child;
    let settled = false;
    let overflow = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCatalog(result);
    };
    const timer = setTimeout(() => {
      const stopping = child === undefined ? undefined : Promise.resolve(stopProcess ? stopProcess(child) : child.kill?.()).catch(() => {});
      void Promise.resolve(stopping).finally(() => finish({ ok: false, diagnostic: 'AGY model catalog probe timed out' }));
    }, timeoutMs);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    try {
      child = spawnProcess(cliPath, [...cliPrefix, 'models'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish({ ok: false, diagnostic: catalogDiagnostic(error instanceof Error ? error.message : String(error)) });
      return;
    }
    const take = (current, chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const next = Buffer.concat([current, bytes]);
      if (next.length > maxOutputBytes) {
        overflow = true;
        child.kill?.();
        return next.subarray(0, maxOutputBytes);
      }
      return next;
    };
    child.stdout?.on('data', chunk => { stdout = take(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = take(stderr, chunk); });
    child.once?.('error', error => finish({ ok: false, diagnostic: catalogDiagnostic(error instanceof Error ? error.message : String(error)) }));
    child.once?.('close', code => {
      if (overflow) finish({ ok: false, diagnostic: 'AGY model catalog probe exceeded the output limit' });
      else if (code !== 0) finish({ ok: false, diagnostic: catalogDiagnostic(stderr.toString('utf8') || `AGY model catalog probe exited ${code}`) });
      else finish({ ok: true, ids: vendorModelIds(stdout.toString('utf8')) });
    });
  });
}

export function configOptions(session) {
  const effort = encodedEffort(session.model);
  const options = [{ id: 'effort', name: 'AGY effort', category: 'thought_level', type: 'select', currentValue: session.effort,
    options: [{ value: DEFAULT, name: 'Follow AGY settings' }, ...(effort ? [{ value: effort, name: effort }] : [])] }];
  if (Array.isArray(session.modelChoices)) {
    options.push({ id: 'model', name: 'AGY model', category: 'model', type: 'select', currentValue: session.model,
      options: session.modelChoices.length === 0 ? [] : [{ value: DEFAULT, name: 'Follow AGY settings' },
        ...session.modelChoices.map(id => ({ value: id, name: id }))] });
  }
  options.push({ id: 'native-agent', name: 'AGY native agent', category: 'native_agent', type: 'select',
    currentValue: DEFAULT, options: [{ value: DEFAULT, name: 'Follow AGY default agent' }] });
  return options;
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
      authMethods: [], _meta: { steering: { supported: true } } };
  }

  async requestPermission(session, input) {
    if (!session.hostGate) return { decision: 'ask' };
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
    const { kind, ...permissionTool } = canonicalTool(name, args, session.cwd);
    await this.audit(session, 'permission_request', { toolCallId: id, name, policyIdentity: session.permission.policyIdentity, override: session.permission.override });
    const controller = new AbortController();
    session.permissionRequests.add(controller);
    let response;
    try {
      response = await active.client.request('session/request_permission', {
        sessionId: session.id,
        toolCall: { toolCallId: id, title: name, kind, status: 'in_progress', rawInput: args },
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
          { optionId: 'kiki.vendor_default', name: 'Use vendor permissions', kind: 'allow_once' }],
        _meta: { 'kiki.tool': permissionTool },
      }, { signal: controller.signal });
    } finally { session.permissionRequests.delete(controller); }
    if (session.active !== active || session.broken) return reject('Kiki AGY turn ended while awaiting permission');
    if (response?.outcome?.outcome === 'selected' && response.outcome.optionId === 'kiki.vendor_default') {
      await this.audit(session, 'permission_decision', { toolCallId: id, decision: 'vendor_default' });
      return { decision: 'ask' };
    }
    const allow = response?.outcome?.outcome === 'selected' && ['allow_once', 'allow_always'].includes(response.outcome.optionId);
    const permissionOverrides = allow ? toolPermissionResources(name, args) : undefined;
    if (allow) (active.hostApproved ??= new Set()).add(id);
    else (active.hostDenied ??= new Set()).add(id);
    await this.audit(session, 'permission_decision', { toolCallId: id, decision: allow ? 'allow' : 'deny', permissionOverrides });
    if (!allow) await this.settleTool(session, active, id, 'failed', 'The current Kiki permission gate rejected or cancelled this action before execution');
    return allow ? { decision: 'allow', reason: 'Approved by the current Kiki permission gate', permissionOverrides }
      : reject('The current Kiki permission gate rejected or cancelled this action');
  }

  async newSession(params, id = randomUUID(), event = 'session_new') {
    const mcpServers = params.mcpServers ?? [];
    if (!Array.isArray(mcpServers) || mcpServers.some(server => !server || typeof server.name !== 'string' ||
      !server.name || typeof server.command !== 'string' || !server.command ||
      !Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string') ||
      !Array.isArray(server.env) || server.env.some(entry => typeof entry.name !== 'string' || typeof entry.value !== 'string'))) {
      throw new Error('AGY session MCP requires named stdio servers with command, args and env');
    }
    if (params._meta?.systemPromptOverride !== undefined) throw new Error('System replacement is unsupported; use explicit Kiki preamble delivery');
    if (!isAbsolute(params.cwd)) throw new Error('AGY workspace must be absolute');
    const dirs = params.additionalDirectories ?? [];
    if (!Array.isArray(dirs) || dirs.some(d => typeof d !== 'string' || !isAbsolute(d))) throw new Error('Additional directories must be absolute');
    const session = { id, cwd: params.cwd, additionalDirectories: dirs, model: this.model, effort: DEFAULT,
      modelChoices: this.modelChoices,
      mcpServers: structuredClone(mcpServers), mcpPlugin: undefined, mcpBound: new Set(), mcpReady: new Set(),
      permission: undefined, hostGate: false, permissionIdentity: permissionChannelIdentity(),
      permissionRequests: new Set(), permissionChannel: undefined, permissionRegistration: undefined,
      child: undefined, active: undefined, broken: false, init: undefined, exited: undefined, toolIds: new Map(), toolDetails: new Map() };
    this.permissionSnapshot(session, params._meta?.['kiki.permission']);
    this.sessions.set(session.id, session);
    try {
      await this.recoverDeadOwnedResources(session);
      if (session.hostGate && session.permission.override && typeof session.permission.requestId === 'string' && session.permission.requestId.length > 0) {
        await this.syncPermissionHook(session);
        session.permissionReceipt = { version: 1, sessionId: session.id, openMode: event === 'session_new' ? 'new' : 'load',
          gate: 'pre-tool-hook', applied: structuredClone(session.permission) };
      }
      await this.audit(session, event, { cwd: session.cwd, additionalDirectories: dirs, delivery: event === 'session_new' ? 'first_user_preamble' : 'native_conversation', systemOverride: false });
      return { sessionId: session.id, configOptions: configOptions(session), _meta: { 'kiki.permission': session.permissionReceipt } };
    } catch (error) {
      await session.permissionChannel?.close();
      await session.permissionRegistration?.close();
      await this.closeSteeringHook(session).catch(() => {});
      this.sessions.delete(session.id);
      throw error;
    }
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
    if (records.some(record => record.type === 'mcp_agent_registered')) {
      throw new Error('This native conversation used the former custom MCP agent; retain its original adapter for recovery or create a new native main session');
    }
    const mcpBinding = records.findLast(record => record.type === 'mcp_plugin_registered');
    if (mcpBinding && typeof mcpBinding.name !== 'string') throw new Error('AGY native load has no audited MCP plugin namespace; preserve its original adapter for recovery');
    if (mcpBinding && JSON.stringify(params.mcpServers?.map(server => server.name) ?? []) !== JSON.stringify(mcpBinding.servers)) {
      throw new Error('AGY native load requires fresh MCP connections matching its original server names');
    }
    const argValue = name => { const index = launch.args.lastIndexOf(name); return index < 0 ? DEFAULT : launch.args[index + 1]; };
    const model = argValue('--model') === DEFAULT ? init.model : argValue('--model');
    if (typeof model !== 'string' || !model || this.model !== DEFAULT && model !== this.model) throw new Error('AGY native load model differs from its original binding or was not confirmed');
    const effort = launch.effort ?? argValue('--effort');
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
      session.mcpNamespace = mcpBinding?.name;
      session.releaseResume = release;
      return { configOptions: configOptions(session), _meta: { 'kiki.permission': session.permissionReceipt } };
    } catch (error) { await release(); this.sessions.delete(params.sessionId); throw error; }
  }

  session(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Unknown AGY session; use session/load for exact audited native recovery. Fork is unsupported');
    return session;
  }

  async loadVendorModels() {
    try {
      const result = await readVendorModelCatalog({
        cliPath: this.cliPath, cliPrefix: this.cliPrefix, spawnProcess: this.spawnProcess, stopProcess: this.stopProcess,
      });
      this.modelChoices = result.ok ? result.ids : undefined;
      this.modelDiagnostic = result.ok ? undefined : result.diagnostic;
    } catch (error) {
      this.modelChoices = undefined;
      this.modelDiagnostic = catalogDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  setModel(session, value) {
    if (typeof value !== 'string' || value.length === 0 || /\s/u.test(value)) throw new Error('AGY model must be a nonempty engine ID');
    if (session.child && session.model !== value) throw new Error('AGY model/effort is frozen after process launch; select a fresh session');
    if (!Array.isArray(session.modelChoices)) throw new Error('AGY model catalog is unavailable; model is selected by argv in its own namespace');
    if (value !== DEFAULT && value !== session.model && !session.modelChoices.includes(value)) {
      throw new Error(`AGY model ID ${value} is not in the vendor catalog`);
    }
    validateEffort(value, session.effort);
    session.model = value;
    return { configOptions: configOptions(session) };
  }

  setConfig(params) {
    const session = this.session(params.sessionId);
    if (params.configId === 'model') return this.setModel(session, params.value);
    if (params.configId === 'native-agent') {
      if (params.value !== DEFAULT) throw Error('AGY adapter supports only the native default agent; other native agents have not been discovered');
      return { configOptions: configOptions(session) };
    }
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
    if (session.nativePermissionBypass && (!hostGate || permission?.override?.mode !== 'yolo')) {
      session.permission = permission === undefined ? undefined : structuredClone(permission);
      session.hostGate = true;
      throw new Error('AGY was launched with explicit permission bypass; close this process and load its native conversation before restoring vendor permissions');
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
    session.permissionChannel ??= await openPermissionChannel(input => ['mcp_bootstrap', 'mcp_ready'].includes(input?.type)
      ? this.bindMcpBootstrap(session, input) : input?.type === 'steer_poll' ? this.pollSteering(session, input)
        : this.requestPermission(session, input), session.permissionIdentity);
    if (!session.hostGate) {
      await session.permissionRegistration?.close();
      session.permissionRegistration = undefined;
      return;
    }
    session.permissionRegistration ??= await registerProjectHook({ cwd: session.cwd, nodePath: process.execPath,
      handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)), sessionId: session.id });
  }

  async registerMcpPlugin(session) {
    if (!session.mcpServers.length || session.mcpPlugin) return;
    session.mcpPlugin = await registerProjectMcpPlugin({ cwd: session.cwd, sessionId: session.id, namespace: session.mcpNamespace,
      nodePath: process.execPath, handlerPath: fileURLToPath(import.meta.url), servers: session.mcpServers });
    await this.audit(session, 'mcp_plugin_registered', { name: session.mcpPlugin.name, path: session.mcpPlugin.path,
      servers: session.mcpServers.map(server => server.name), nativeAgent: 'engine-default' });
  }

  async bindMcpBootstrap(session, input) {
    if (!session.mcpPlugin || !Object.hasOwn(session.mcpPlugin.env, input.key) || session.broken) {
      return { decision: 'deny', reason: 'The MCP bootstrap does not belong to this active session' };
    }
    if (input.type === 'mcp_ready') {
      if (!session.mcpBound.has(input.key)) return { decision: 'deny', reason: 'The MCP bootstrap has not been admitted' };
      session.mcpReady.add(input.key);
    } else session.mcpBound.add(input.key);
    await this.audit(session, input.type === 'mcp_ready' ? 'mcp_stdio_ready' : 'mcp_stdio_bound',
      { server: session.mcpServers[Object.keys(session.mcpPlugin.env).indexOf(input.key)].name });
    return { decision: 'allow' };
  }

  /**
   * A previous adapter killed before its close ran can leave its owned hook keys and MCP
   * plugin in this workspace. Before this session registers its own, recover only those
   * whose every recorded owner process has exited; live leases, edited files and foreign
   * entries are preserved and reported in the audit instead of failing the session.
   */
  async recoverDeadOwnedResources(session) {
    if (session.ownedRecoveryDone) return;
    session.ownedRecoveryDone = true;
    const results = {};
    try {
      results.hooks = (await recoverProjectHook({ cwd: session.cwd, nodePath: process.execPath,
        handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)) })).status;
    } catch (error) { results.hooks = { status: 'preserved', reason: error instanceof Error ? error.message : String(error) }; }
    try { results.plugins = await recoverDeadProjectMcpPlugins({ cwd: session.cwd }); }
    catch (error) { results.plugins = { status: 'preserved', reason: error instanceof Error ? error.message : String(error) }; }
    if (results.hooks !== 'no-owned-registration' || results.plugins.length) this.auditQuietly(session, 'owned_recovery', results);
  }

  async registerSteeringHook(session) {
    session.steeringRegistration ??= await registerProjectHook({ cwd: session.cwd, nodePath: process.execPath,
      handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)), sessionId: session.id,
      key: AGY_STEERING_HOOK_KEY, args: ['--steering'] });
  }

  /**
   * Removes this turn's owned PostInvocation key. A failed removal keeps the registration
   * on the session so the next turn end, cancel or close retries it; the turn result is
   * never replaced by the cleanup error.
   */
  async closeSteeringHook(session) {
    const registration = session.steeringRegistration;
    if (!registration) return;
    try {
      await registration.close();
      if (session.steeringRegistration === registration) session.steeringRegistration = undefined;
    } catch (error) {
      this.auditQuietly(session, 'steering_hook_close_failed', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  auditQuietly(session, type, data) {
    this.audit(session, type, data).catch(() => {});
  }

  /**
   * Accepts one steering message for the running native turn. The text waits in this
   * session until AGY's next PostInvocation hook drains it into the same invocation loop.
   * An idle session returns `promptRequired` so the host submits a normal prompt instead.
   */
  async steer(params) {
    const session = this.session(params.sessionId);
    const active = session.active;
    if (!active || session.broken || !session.steeringRegistration) return { outcome: 'promptRequired', reason: 'noRunningTurn' };
    const text = promptText(params.prompt);
    const id = randomUUID();
    await this.audit(session, 'steer_queued', { steerId: id, sha256: createHash('sha256').update(text).digest('hex') });
    if (session.active !== active || session.broken || !session.steeringRegistration) {
      this.auditQuietly(session, 'steer_not_delivered', { steerIds: [id] });
      return { outcome: 'promptRequired', reason: 'turnEnded' };
    }
    return new Promise(resolveSteer => active.steering.push({ id, text, resolve: resolveSteer }));
  }

  releaseSteering(session, active) {
    const pending = active.steering.splice(0);
    if (pending.length) this.auditQuietly(session, 'steer_not_delivered', { steerIds: pending.map(item => item.id) });
    for (const item of pending) item.resolve({ outcome: 'promptRequired', reason: 'turnEnded' });
  }

  async pollSteering(session, input) {
    const active = session.active;
    if (!active || session.broken || !session.init || input.conversationId !== session.init.conversation_id) {
      return { decision: 'deny', reason: 'AGY steering poll does not belong to the running turn' };
    }
    if (active.steering.length === 0) return { decision: 'allow', steering: { injectSteps: [] } };
    const batch = active.steering.splice(0);
    this.auditQuietly(session, 'steer_delivering', { steerIds: batch.map(item => item.id), invocationNum: input.invocationNum });
    let settled = false;
    const settle = (outcome, type) => {
      if (settled) return;
      settled = true;
      this.auditQuietly(session, type, { steerIds: batch.map(item => item.id) });
      for (const item of batch) item.resolve({ outcome });
    };
    return { decision: 'allow', steering: { injectSteps: batch.map(item => ({ userMessage: item.text })) },
      afterWrite: () => settle('injected', 'steer_delivered'),
      afterFailure: () => settle('deliveryUnknown', 'steer_delivery_unknown') };
  }

  async start(session) {
    await this.registerMcpPlugin(session);
    const args = [...this.cliPrefix, ...launchArgs(session)];
    const env = { ...process.env, ...session.permissionIdentity };
    for (const key of Object.keys(env)) if (key.startsWith('KIKI_AGY_MCP_')) delete env[key];
    Object.assign(env, session.mcpPlugin?.env);
    let child;
    try {
      await session.mcpPlugin?.beforeLaunch();
      child = this.spawnProcess(this.cliPath, args, { cwd: session.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    } catch (error) {
      await session.permissionChannel?.close();
      await session.permissionRegistration?.close();
      await this.closeSteeringHook(session).catch(() => {});
      await session.mcpPlugin?.close();
      throw error;
    }
    session.child = child;
    session.nativePermissionBypass = args.includes('--dangerously-skip-permissions');
    session.exited = new Promise(done => child.once('close', done));
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let stderr = Buffer.alloc(0);
    let stderrTruncated = false;
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
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrTruncated ||= stderr.length + bytes.length > 8192;
      const tail = Buffer.concat([stderr, bytes.subarray(Math.max(0, bytes.length - 8192))]);
      stderr = tail.subarray(Math.max(0, tail.length - 8192));
      process.stderr.write(chunk);
    });
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.once('close', (code, signal) => {
      const lines = stderr.toString('utf8').split(/\r?\n/u);
      if (stderrTruncated) lines.shift();
      const diagnostic = lines.map(safeDiagnosticLine).findLast(line => line !== undefined);
      stderr = Buffer.alloc(0);
      session.cleanup = (async () => {
        try {
          await delivery;
        } finally {
          session.broken = true;
          if (session.active) {
            const message = `AGY exited before terminal result (code: ${code ?? 'none'}, signal: ${signal ?? 'none'})${diagnostic === undefined ? '' : `: ${diagnostic}`}`;
            const error = new Error(message);
            error.code = 'AGY_EARLY_EXIT';
            error.details = { exitCode: code ?? null, signal: signal ?? null, diagnostic };
            session.failure = message;
            session.active.reject(error);
            session.active = undefined;
          }
          for (const controller of session.permissionRequests) controller.abort(new Error('AGY process ended'));
          await session.permissionChannel?.close();
          await session.permissionRegistration?.close();
          await this.closeSteeringHook(session).catch(() => {});
          await session.mcpPlugin?.close();
          await session.releaseResume?.();
        }
      })();
      session.cleanup.catch(error => { process.stderr.write(`AGY owned permission cleanup failed: ${error.message}\n`); });
    });
    try { await session.mcpPlugin?.launched(child.pid); }
    catch (error) { await this.stopProcess(child); await session.cleanup; throw error; }
    return this.audit(session, 'launch', { cliPath: this.cliPath, args, effort: session.effort, pid: child.pid, cwd: session.cwd });
  }

  async settleTool(session, active, toolCallId, status, message) {
    if (session.toolIds.get(toolCallId) !== 'pending') return;
    session.toolIds.set(toolCallId, 'settled');
    await active.client.notify('session/update', { sessionId: session.id,
      update: { sessionUpdate: 'tool_call_update', toolCallId, status, content: [{ type: 'content', content: { type: 'text', text: message } }] } });
  }

  async settlePendingTools(session, active, status, message) {
    for (const toolCallId of session.toolIds.keys()) await this.settleTool(session, active, toolCallId, status, message);
  }

  async event(session, event) {
    if (!event || typeof event !== 'object') throw new Error('Invalid AGY event');
    if (event.event === 'init') {
      if (session.init) throw new Error('AGY sent duplicate init');
      const init = event.init;
      const sameWorkspace = typeof init?.cwd === 'string' &&
        (process.platform === 'win32'
          ? resolve(init.cwd).toLowerCase() === resolve(session.cwd).toLowerCase()
          : resolve(init.cwd) === resolve(session.cwd));
      if (!sameWorkspace) throw new Error('AGY init cwd does not match the frozen workspace binding; do not run tools in another project');
      if (session.model !== DEFAULT && init?.model !== session.model) throw new Error('AGY init model does not match the explicit binding');
      if (session.conversationId && event.conversation_id !== session.conversationId) throw new Error('AGY init conversation does not match the exact native resume binding');
      session.init = event;
      await this.audit(session, 'agy_init', { conversationId: event.conversation_id, model: init?.model,
        agent: init?.agent, cwd: init?.cwd, projectId: init?.project_id ?? event.project_id, permissionMode: init?.permission_mode, tools: init?.tools });
      return;
    }
    const active = session.active;
    if (!active && session.broken) return;
    if (!active) throw new Error('AGY event arrived outside an active turn');
    if (event.event === 'step_update') {
      const step = event.step_update;
      if (!step || typeof step.step_type !== 'string') throw new Error('Malformed AGY step');
      if (step.step_type === 'user_input' && step.state === 'DONE') await this.audit(session, 'prompt_consumed', { stepIndex: step.step_index });
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
        const detail = { name: step.tool_name ?? step.tool_info?.name ?? session.toolDetails.get(id)?.name, state: step.state };
        session.toolDetails.set(id, detail);
        await this.audit(session, 'tool_state', { toolCallId: id, ...detail });
        if ((step.state === 'DONE' || step.state === 'ERROR') && session.toolIds.get(id) === 'pending') {
          const failed = step.state === 'ERROR' || Boolean(step.tool_info?.error);
          const error = step.tool_info?.error ?? step.error;
          const errorText = typeof error === 'string' ? error : error?.message;
          const output = step.tool_info?.output ?? errorText ?? (failed ? 'AGY tool reported an error' : undefined);
          if (failed && /^tool call denied by pre-tool hook:/i.test(String(errorText ?? output ?? '').trimStart())) {
            (active.preToolDenied ??= new Set()).add(id);
            await this.audit(session, 'pre_tool_hook_denied', { toolCallId: id, error: errorText ?? output });
          }
          if (failed && active.hostApproved?.has(id) && /\bpermissions?\s+(?:check\s+)?(?:denied|failed)\b|\b(?:user|resource)\s+denied\s+permission\b/i.test(errorText ?? output ?? '')) {
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
    if (result.status === 'SUCCESS' && session.mcpServers.length !== session.mcpReady.size) {
      throw new Error('AGY did not activate and initialize the requested session MCP plugin; preserve native plugin/MCP off settings and review the connection instead of switching agents');
    }
    for (const toolCallId of active.hostDenied ?? []) {
      await this.settleTool(session, active, toolCallId, 'failed', 'The current Kiki permission gate rejected or cancelled this action before execution');
    }
    const unresolved = [...session.toolIds].filter(([, status]) => status === 'pending')
      .map(([toolCallId]) => ({ toolCallId, ...session.toolDetails.get(toolCallId) }));
    const unresolvedMessage = unresolved.length
      ? `AGY terminal result arrived before a tool terminal update: ${unresolved.map(tool => `${tool.toolCallId} (${tool.name ?? 'unknown tool'}, ${tool.state ?? 'unknown state'})`).join(', ')}; execution state is unknown; do not replay these calls or reuse this session until their native state is reconciled`
      : undefined;
    if (unresolved.length) {
      session.broken = true;
      session.failure = unresolvedMessage;
      await this.audit(session, 'tool_terminal_missing', { conversationId: result.conversation_id, nativeStatus: result.status, tools: unresolved });
    }
    if (session.denied || result.denied_actions?.length || active.preToolDenied?.size || active.hostDenied?.size) {
      session.denied = false;
      const actions = [...new Set((result.denied_actions ?? []).map(action => typeof action?.action === 'string' ? action.action : 'unknown'))];
      const message = `AGY permission denied${actions.length ? ` for ${actions.join(', ')}` : ''}; ${active.hostDenied?.size
        ? `Kiki rejected ${[...active.hostDenied].join(', ')} before execution; retain the decision; native SUCCESS does not override it`
        : active.preToolDenied?.size
          ? 'a PreToolUse hook rejected a tool before execution; retain the denial; terminal SUCCESS is not evidence that the requested work ran'
          : active.vendorRejected?.size
            ? 'the native AGY permission engine rejected a tool after Kiki approved this exact call; retain the denial and restore the vendor approval contract before retrying'
            : 'the native AGY permission policy did not approve the action'}${unresolvedMessage ? `; ${unresolvedMessage}` : ''}`;
      await this.settlePendingTools(session, active, 'failed', message);
      process.stderr.write(`${message}\n`);
      const error = new Error(message);
      error.code = 'AGY_PERMISSION_DENIED';
      error.details = { deniedToolCallIds: [...new Set([...(active.hostDenied ?? []), ...(active.preToolDenied ?? [])])], unresolvedTools: unresolved };
      active.reject(error);
    } else if (result.status === 'CANCELED' || result.status === 'INTERRUPTED') {
      await this.settlePendingTools(session, active, 'failed', unresolvedMessage ?? `AGY turn ${result.status.toLowerCase()}`);
      active.resolve({ stopReason: 'cancelled' });
    } else if (result.status !== 'SUCCESS') {
      const message = `AGY terminal status ${result.status}: ${result.error ?? 'no success result'}`;
      await this.settlePendingTools(session, active, 'failed', unresolvedMessage ?? message);
      active.reject(new Error(unresolvedMessage ? `${message}; ${unresolvedMessage}` : message));
    } else if (unresolvedMessage) {
      await this.settlePendingTools(session, active, 'failed', unresolvedMessage);
      const error = new Error(unresolvedMessage);
      error.code = 'AGY_TOOL_TERMINAL_MISSING';
      error.details = { conversationId: result.conversation_id, unresolvedTools: unresolved };
      active.reject(error);
    } else {
      if (!active.text && result.response) await active.client.notify('session/update', { sessionId: session.id,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.response } } });
      active.resolve({ stopReason: 'end_turn' });
    }
    session.active = undefined;
  }

  async prompt(params, client) {
    const session = this.session(params.sessionId);
    if (session.broken) throw new Error(session.failure ?? 'AGY process ended; create a fresh session (no implicit resume/history handoff)');
    if (session.active) throw new Error('AGY session already has an active turn');
    const content = promptText(params.prompt);
    const promise = new Promise((resolveTurn, rejectTurn) => {
      const active = { client, text: '', steering: [],
        resolve: value => { this.releaseSteering(session, active); this.closeSteeringHook(session).catch(() => {}).then(() => resolveTurn(value)); },
        reject: error => { this.releaseSteering(session, active); this.closeSteeringHook(session).catch(() => {}).then(() => rejectTurn(error)); } };
      session.active = active;
    });
    promise.catch(() => {});
    try {
      if (Object.hasOwn(params._meta ?? {}, 'kiki.permission')) this.permissionSnapshot(session, params._meta['kiki.permission']);
      session.preparing = (async () => {
        await this.recoverDeadOwnedResources(session);
        await this.syncPermissionHook(session);
        await this.registerSteeringHook(session);
        if (!session.broken && !session.child) await this.start(session);
      })();
      try { await session.preparing; } finally { session.preparing = undefined; }
      if (session.broken) return await promise;
      const frame = JSON.stringify({ event: 'user', message: { content } }) + '\n';
      try {
        await new Promise((done, reject) => session.child.stdin.write(frame, error => error ? reject(error) : done()));
      } catch (error) {
        if (session.broken) return await promise;
        throw error;
      }
      await this.audit(session, 'prompt_sent', { bytes: Buffer.byteLength(frame),
        promptSha256: createHash('sha256').update(content).digest('hex'),
        frameSha256: createHash('sha256').update(frame).digest('hex'), delivery: 'unchanged_user_text' });
      return await promise;
    } catch (error) {
      if (session.active) { this.releaseSteering(session, session.active); session.active = undefined; }
      await this.closeSteeringHook(session).catch(() => {});
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
    await session.preparing?.catch(() => {});
    await session.permissionChannel?.close();
    await this.stopProcess(session.child);
    await session.cleanup;
    await session.permissionRegistration?.close();
    await this.closeSteeringHook(session).catch(() => {});
    await session.mcpPlugin?.close();
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
        await session.preparing?.catch(() => {});
        await session.permissionChannel?.close();
        if (session.child && session.child.exitCode === null && session.child.signalCode === null) {
          session.child.stdin.end();
          const timer = setTimeout(() => { void this.stopProcess(session.child); }, 3000);
          try { await session.exited; } finally { clearTimeout(timer); }
        }
        await session.cleanup;
        await session.permissionRegistration?.close();
        await this.closeSteeringHook(session).catch(() => {});
        await session.mcpPlugin?.close();
        await session.releaseResume?.();
        await this.audit(session, 'close', { pid: session.child?.pid, processEnded: true });
      }
    }));
    return this.closePromise;
  }
}

export async function runSessionMcp(key) {
  if (!/^KIKI_AGY_MCP_[a-f0-9_]+_[0-9]+$/.test(key)) throw new Error('Invalid session MCP environment key');
  if (process.env[key] === undefined) {
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (!Object.hasOwn(request, 'id')) continue;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'kiki-unbound-session', version: '1' } };
      else if (request.method === 'tools/list') result = { tools: [] };
      else if (request.method === 'resources/list') result = { resources: [] };
      else if (request.method === 'resources/templates/list') result = { resourceTemplates: [] };
      else if (request.method === 'prompts/list') result = { prompts: [] };
      else if (request.method === 'ping') result = {};
      process.stdout.write(JSON.stringify(result === undefined
        ? { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'No Kiki session lease is bound to this process' } }
        : { jsonrpc: '2.0', id: request.id, result }) + '\n');
    }
    return;
  }
  const server = JSON.parse(process.env[key]);
  if (!server || typeof server.command !== 'string' || !Array.isArray(server.args) || !Array.isArray(server.env)) {
    throw new Error('Session MCP launch context is invalid');
  }
  const admission = await requestHookPermission({ type: 'mcp_bootstrap', key }, process.env, 10_000);
  if (admission.decision !== 'allow') throw new Error('The session MCP bootstrap was not admitted by its owning adapter');
  const env = { ...process.env, ...Object.fromEntries(server.env.map(entry => [entry.name, entry.value])) };
  for (const name of Object.keys(env)) if (name.startsWith('KIKI_AGY_')) delete env[name];
  const child = spawn(server.command, server.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = new Promise(done => child.once('close', done));
  const output = createInterface({ input: child.stdout });
  let failure;
  const fail = error => { failure ??= error; output.close(); };
  child.once('error', fail);
  child.stdin.on('error', fail);
  const lists = new Set();
  const input = createInterface({ input: process.stdin });
  input.on('line', line => {
    try { const frame = JSON.parse(line); if (frame.method === 'tools/list' && frame.id !== undefined) lists.add(frame.id); } catch {}
    child.stdin.write(line + '\n');
  });
  input.once('close', () => child.stdin.end());
  child.stderr.pipe(process.stderr);
  const stop = () => { void terminate(child); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    let ready = false;
    for await (const line of output) {
      let frame;
      try { frame = JSON.parse(line); } catch {}
      if (!ready && lists.has(frame?.id) && Array.isArray(frame?.result?.tools)) {
        const acknowledged = await requestHookPermission({ type: 'mcp_ready', key }, process.env, 10_000);
        if (acknowledged.decision !== 'allow') throw Error('The session MCP readiness was not admitted by its owning adapter');
        ready = true;
      }
      process.stdout.write(line + '\n');
    }
    if (failure instanceof Error) throw new Error(failure.message, { cause: failure });
    if (failure) throw new Error('AGY session MCP child failed', { cause: failure });
    process.exitCode = await closed ?? 1;
  } finally {
    input.close();
    process.stdin.pause();
    output.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (child.pid !== undefined) await terminate(child);
    await closed;
  }
}

export async function runBridge({ sdkPath, cliPath, cliPrefix = [], auditDir, model = DEFAULT } = {}) {
  if (!isAbsolute(sdkPath ?? '')) throw new Error('Pass an installed ACP SDK absolute path');
  const acp = await import(pathToFileURL(sdkPath).href);
  const bridge = new AgyBridge({ cliPath, cliPrefix, auditDir, model });
  await bridge.loadVendorModels();
  const sessionRequest = handler => async ctx => {
    try { return await handler(ctx); }
    catch (error) {
      throw new acp.RequestError(-32603, error instanceof Error ? error.message : String(error),
        { adapterCode: error?.code, details: error?.details });
    }
  };
  const connection = acp.agent({ name: 'agy-cli-acp', version: '0.1.0' })
    .onRequest('initialize', () => bridge.initialize(acp.PROTOCOL_VERSION))
    .onRequest('session/new', sessionRequest(ctx => bridge.newSession(ctx.params)))
    .onRequest('session/load', sessionRequest(ctx => bridge.loadSession(ctx.params)))
    .onRequest('session/set_config_option', ctx => bridge.setConfig(ctx.params))
    .onRequest('session/prompt', sessionRequest(ctx => bridge.prompt(ctx.params, ctx.client)))
    .onRequest('_session/steering', params => params, sessionRequest(ctx => bridge.steer(ctx.params)))
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
    if (args.length === 2 && args[0] === '--mcp-stdio') {
      runSessionMcp(args[1]).catch(error => { console.error(error.message); process.exitCode = 1; });
    } else if (args.length === 3 && args[0] === '--recover-project-mcp') {
      if (!isAbsolute(args[1])) throw Error('AGY MCP recovery workspace must be absolute');
      recoverProjectMcpPlugin({ cwd: args[1], sessionId: args[2] })
        .then(result => console.log(JSON.stringify(result)))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
    } else if (args.length === 2 && args[0] === '--recover-project-hook') {
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
