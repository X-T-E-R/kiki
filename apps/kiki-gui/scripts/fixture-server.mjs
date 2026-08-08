/**
 * kiki-gui fixture server — a deterministic stand-in for kap-server so every
 * GUI state can be rendered and screenshotted without a live model.
 *
 *   node scripts/fixture-server.mjs [--port 58901] [--scenario basic-stream]
 *
 * Serves the exact subset of `/api/v1` the GUI consumes plus the `/api/v1/ws`
 * handshake and `session_event` frames in the real envelope shapes (WS
 * protocol v2: server_hello → client_hello → subscribe ack with {seq, epoch}
 * cursors; durable frames advance seq, volatile frames carry it + `offset`).
 * Bearer auth accepts the fixed token `kiki-fixture-token` (also via the
 * `kimi-code.bearer.*` WS subprotocol, like kap-server).
 *
 * Scenarios are data modules in ../fixtures/*.scenario.mjs. Event scripts are
 * step lists the server plays on a trigger (`onPrompt`); steps:
 *   { delay, frame: { type, payload, volatile?, offset? } }  emit a frame
 *   { waitFor: 'approval' | 'question' | 'abort' }           pause until REST
 *   { commit: Message }                                    journal a message
 * `{ waitFor: 'approval' }` resumes when the approval is resolved through the
 * REST route, exactly like a real agent blocked on a human.
 *
 * Control endpoint (not under /api): POST /__control
 *   { action: 'scenario', name }        switch scenario (resets state, drops WS)
 *   { action: 'drop_ws' }               terminate all WS connections abnormally
 *   { action: 'resync', session_id }    bump epoch + send resync_required
 *   { action: 'list' }                  list scenario names + active one
 */

import { createServer } from 'node:http';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocketServer } from 'ws';

export const FIXTURE_TOKEN = 'kiki-fixture-token';
const DEFAULT_PORT = 58901;

/** Volatile frame types — mirrors kap-server's VOLATILE_SIGNAL_TYPES. */
const VOLATILE_TYPES = new Set([
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.progress',
  'shell.started',
  'shell.output',
  'shell.completed',
  'agent.status.updated',
]);

let idCounter = 0;
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}_fixture_${String(idCounter).padStart(4, '0')}`;
}
function now() {
  return new Date().toISOString();
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deep-replace the `$SID` placeholder with the concrete session id. */
function bind(value, sessionId) {
  if (typeof value === 'string') return value === '$SID' ? sessionId : value;
  if (Array.isArray(value)) return value.map((item) => bind(item, sessionId));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bind(v, sessionId)]));
  }
  return value;
}

/** Deep-replace `$PROMPT` with the server-issued prompt id (called per prompt). */
function bindPrompt(value, promptId) {
  if (typeof value === 'string') return value === '$PROMPT' ? promptId : value;
  if (Array.isArray(value)) return value.map((item) => bindPrompt(item, promptId));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bindPrompt(v, promptId)]));
  }
  return value;
}

class FixtureSession {
  constructor(record, scenarioData) {
    this.record = record; // Session wire record
    this.messages = [...(scenarioData.messages ?? [])];
    this.hasMore = scenarioData.has_more === true;
    this.older = [...(scenarioData.older ?? [])]; // messages before the snapshot page
    this.tasks = [...(scenarioData.tasks ?? [])];
    this.pendingApprovals = [...(scenarioData.pending_approvals ?? [])];
    this.pendingQuestions = [...(scenarioData.pending_questions ?? [])];
    this.inFlightTurn = scenarioData.in_flight_turn ?? null;
    this.seq = scenarioData.as_of_seq ?? this.messages.length;
    this.epoch = scenarioData.epoch ?? 'ep_fixture_1';
    this.scriptRunning = false;
    this.abortRequested = false;
    this.waiters = []; // [{kind, resolve, payload?}]
  }
}

class FixtureServer {
  constructor() {
    this.scenario = null; // { name, data }
    this.sessions = new Map();
    this.sockets = new Set();
    this.http = createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
  }

  async loadScenario(name) {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', `${name}.scenario.mjs`);
    const module = await import(pathToFileURL(file).href);
    const data = module.default;
    this.scenario = { name, data };
    this.sessions.clear();
    for (const session of data.sessions ?? []) {
      const bound = bind(session, session.id);
      this.sessions.set(session.id, new FixtureSession(bound, bind(data.snapshots?.[session.id] ?? {}, session.id)));
    }
    for (const ws of this.sockets) {
      try { ws.terminate(); } catch { /* closing */ }
    }
    this.sockets.clear();
    console.log(`[fixture] scenario "${name}" loaded (${this.sessions.size} sessions)`);
  }

  // ------------------------------------------------------------- WS fan-out
  sendFrame(connection, frame) {
    if (connection.readyState === 1) connection.send(JSON.stringify(frame));
  }

  /** Emit a session_event frame to every connection subscribed to the session. */
  emit(sessionId, partial) {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    const volatile = partial.volatile ?? VOLATILE_TYPES.has(partial.type);
    const frame = {
      type: partial.type,
      seq: 0,
      session_id: sessionId,
      timestamp: now(),
      // The wire payload IS the event object — it carries its own `type`
      // (sessionEventMessageSchema wraps eventSchema), plus agent/session
      // routing stamps from the broadcaster.
      payload: { type: partial.type, ...partial.payload, agentId: 'main', sessionId },
    };
    if (volatile) {
      session.seq += 0; // volatile frames carry the current watermark
      frame.seq = session.seq;
      frame.volatile = true;
      if (partial.offset !== undefined) frame.offset = partial.offset;
    } else {
      session.seq += 1;
      frame.seq = session.seq;
      frame.epoch = session.epoch;
    }
    for (const connection of this.sockets) {
      if (connection.subscriptions?.has(sessionId)) this.sendFrame(connection, frame);
    }
    // keep the session record honest for the polling sidebar
    if (partial.type === 'event.session.work_changed') {
      Object.assign(session.record, {
        busy: partial.payload.busy ?? session.record.busy,
        pending_interaction: partial.payload.pending_interaction ?? session.record.pending_interaction,
        updated_at: now(),
      });
    }
  }

  // ------------------------------------------------------------- scripts
  async runScript(sessionId, steps) {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.scriptRunning) return;
    session.scriptRunning = true;
    session.abortRequested = false;
    try {
      // Engine-startup latency: lets the REST submit result (and the client's
      // local echo) land before the first frames, like a real agent.
      await sleep(80);
      for (const step of steps) {
        if (session.abortRequested) return;
        if (step.delay !== undefined) await sleep(step.delay);
        if (session.abortRequested) return;
        if (step.waitFor !== undefined) {
          await new Promise((resolve) => session.waiters.push({ kind: step.waitFor, resolve }));
          continue;
        }
        if (step.commit !== undefined) {
          session.messages.push({ ...step.commit, id: nextId('msg'), session_id: sessionId, created_at: now() });
          session.record.message_count += 1;
          continue;
        }
        if (step.frame !== undefined) {
          this.applySideEffects(session, step.frame);
          this.emit(sessionId, step.frame);
        }
      }
    } finally {
      session.scriptRunning = false;
    }
  }

  /** Server-side bookkeeping a real agent would do for these frames. */
  applySideEffects(session, frame) {
    const payload = frame.payload ?? {};
    switch (frame.type) {
      case 'event.approval.requested':
        session.pendingApprovals.push({ ...payload });
        session.record.pending_interaction = 'approval';
        break;
      case 'event.question.requested':
        session.pendingQuestions.push({ ...payload });
        session.record.pending_interaction = 'question';
        break;
      case 'turn.started':
        session.record.busy = true;
        break;
      case 'turn.ended':
        session.record.busy = false;
        session.record.pending_interaction = 'none';
        break;
      case 'task.started':
        session.tasks.push({
          id: payload.info.taskId,
          session_id: session.record.id,
          kind: payload.info.kind === 'agent' ? 'subagent' : 'bash',
          description: payload.info.description,
          status: 'running',
          command: payload.info.command,
          created_at: now(),
          started_at: now(),
        });
        break;
      case 'task.terminated': {
        const task = session.tasks.find((t) => t.id === payload.info.taskId);
        if (task !== undefined) {
          task.status = payload.info.status === 'completed' ? 'completed' : 'failed';
          task.completed_at = now();
        }
        break;
      }
      default:
        break;
    }
  }

  resolveWaiters(session, kind) {
    const pending = session.waiters.filter((w) => w.kind === kind);
    session.waiters = session.waiters.filter((w) => w.kind !== kind);
    for (const waiter of pending) waiter.resolve();
  }

  // ------------------------------------------------------------- HTTP
  envelope(res, data, code = 0, msg = 'success') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code, msg, data, request_id: nextId('req') }));
  }

  async readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return undefined;
    }
  }

  async handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://fixture');
    // CORS: reflect any origin (loopback dev tool, mirrors kap-server's
    // loopback allowance); preflights short-circuit.
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('access-control-allow-headers', 'Content-Type, Authorization');
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/__control') {
      const body = await this.readBody(req);
      await this.handleControl(body ?? {}, res);
      return;
    }

    if (url.pathname === '/api/v1/healthz') {
      this.envelope(res, { ok: true });
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${FIXTURE_TOKEN}`) {
      this.envelope(res, null, 40101, 'Unauthorized');
      return;
    }

    const path = url.pathname.replace(/^\/api\/v1/, '');
    const body = req.method === 'POST' ? await this.readBody(req) : undefined;
    try {
      this.route(res, path, url.searchParams, body);
    } catch (error) {
      console.error('[fixture] route error', path, error);
      this.envelope(res, null, 50001, String(error));
    }
  }

  route(res, path, query, body) {
    const sessions = [...this.sessions.values()];
    const sessionMatch = /^\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    const sessionId = sessionMatch?.[1];
    const tail = sessionMatch?.[2] ?? '';
    const session = sessionId !== undefined ? this.sessions.get(sessionId) : undefined;

    if (path === '/meta') {
      return this.envelope(res, {
        server_version: '0.31.1-fixture',
        capabilities: { websocket: true, file_upload: true, fs_query: true, mcp: true, tasks: true, terminal: true },
        server_id: 'fixture-server',
        started_at: now(),
        open_in_apps: [],
        dangerous_bypass_auth: false,
        backend: 'v2',
      });
    }
    if (path === '/config') {
      return this.envelope(res, this.scenario?.data.config ?? {
        default_model: 'fixture/kiki-pro',
        default_permission_mode: 'manual',
        providers: {},
      });
    }
    if (path === '/models') {
      return this.envelope(res, {
        items: this.scenario?.data.models ?? [
          { provider: 'fixture', model: 'fixture/kiki-pro', display_name: 'Kiki Pro', max_context_size: 262144, support_efforts: ['low', 'high'], default_effort: 'high' },
          { provider: 'fixture', model: 'fixture/kiki-lite', display_name: 'Kiki Lite', max_context_size: 131072 },
        ],
      });
    }
    if (path === '/workspaces') {
      return this.envelope(res, {
        items: this.scenario?.data.workspaces ?? [
          { id: 'wd_fixture_000000000000', root: 'C:/fixture', name: 'fixture', created_at: now(), last_opened_at: now(), session_count: sessions.length },
        ],
      });
    }
    if (path === '/sessions' && body === undefined) {
      let items = sessions.map((s) => s.record);
      if (query.get('include_archive') !== 'true') items = items.filter((s) => s.archived !== true);
      if (query.get('archived_only') === 'true') items = items.filter((s) => s.archived === true);
      items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return this.envelope(res, { items, has_more: false });
    }
    if (path === '/sessions' && body !== undefined) {
      const id = nextId('session');
      const record = {
        id,
        workspace_id: body.workspace_id ?? 'wd_fixture_000000000000',
        title: body.title ?? '',
        created_at: now(),
        updated_at: now(),
        busy: false,
        pending_interaction: 'none',
        archived: false,
        metadata: body.metadata ?? { cwd: 'C:/fixture' },
        agent_config: { model: '' },
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0 },
        permission_rules: [],
        message_count: 0,
        last_seq: 0,
      };
      this.sessions.set(id, new FixtureSession(record, {}));
      return this.envelope(res, record);
    }
    if (session === undefined) {
      return this.envelope(res, null, 40401, 'session.not_found');
    }
    if (tail === '' ) return this.envelope(res, session.record);
    if (tail === '/profile' && body !== undefined) {
      if (typeof body.title === 'string') session.record.title = body.title;
      session.record.updated_at = now();
      this.emit(session.record.id, { type: 'session.meta.updated', payload: { title: session.record.title } });
      return this.envelope(res, session.record);
    }
    if (tail === ':archive') {
      session.record.archived = true;
      return this.envelope(res, { archived: true });
    }
    if (tail === ':restore') {
      session.record.archived = false;
      return this.envelope(res, session.record);
    }
    if (tail === '/snapshot') {
      return this.envelope(res, {
        as_of_seq: session.seq,
        epoch: session.epoch,
        session: session.record,
        messages: { items: session.messages.slice(-50), has_more: session.hasMore || session.messages.length > 50 },
        in_flight_turn: session.inFlightTurn,
        pending_approvals: session.pendingApprovals,
        pending_questions: session.pendingQuestions,
      });
    }
    if (tail === '/messages') {
      const beforeId = query.get('before_id');
      const pageSize = Math.min(Number(query.get('page_size') ?? 50), 100);
      const all = [...session.older, ...session.messages];
      let end = all.length;
      if (beforeId !== null) {
        const index = all.findIndex((m) => m.id === beforeId);
        if (index >= 0) end = index;
      }
      const items = all.slice(Math.max(0, end - pageSize), end);
      return this.envelope(res, { items, has_more: end - pageSize > 0 });
    }
    if (tail === '/prompts' && body !== undefined) {
      const promptId = nextId('msg');
      const userMessageId = nextId('msg');
      const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      session.messages.push({ id: userMessageId, session_id: session.record.id, role: 'user', content: body.content, created_at: now(), prompt_id: promptId });
      session.record.message_count += 1;
      session.record.last_prompt = text;
      // A parked script owns the turn — queue like the real server.
      if (session.scriptRunning) {
        return this.envelope(res, { prompt_id: promptId, user_message_id: userMessageId, status: 'queued', content: body.content, created_at: now() });
      }
      session.record.busy = true;
      const steps = this.scenario?.data.onPrompt;
      if (Array.isArray(steps)) {
        void this.runScript(session.record.id, bindPrompt(bind(steps, session.record.id), promptId));
      }
      return this.envelope(res, { prompt_id: promptId, user_message_id: userMessageId, status: 'running', content: body.content, created_at: now() });
    }
    const abortMatch = /^\/prompts\/([^/]+):abort$/.exec(tail);
    if (abortMatch !== null) {
      session.abortRequested = true;
      this.resolveWaiters(session, 'abort');
      if (session.scriptRunning) {
        this.emit(session.record.id, {
          type: 'turn.ended',
          payload: { turnId: 1, reason: 'cancelled' },
        });
      }
      this.emit(session.record.id, { type: 'prompt.aborted', payload: { promptId: abortMatch[1], abortedAt: now() } });
      session.record.busy = false;
      return this.envelope(res, { aborted: true, at_seq: session.seq });
    }
    if (tail === '/approvals') {
      return this.envelope(res, { items: session.pendingApprovals });
    }
    const approvalMatch = /^\/approvals\/([^/]+)$/.exec(tail);
    if (approvalMatch !== null && body !== undefined) {
      const approval = session.pendingApprovals.find((a) => a.approval_id === approvalMatch[1]);
      if (approval === undefined) return this.envelope(res, { resolved: false }, 40404, 'approval.not_found');
      session.pendingApprovals = session.pendingApprovals.filter((a) => a.approval_id !== approval.approval_id);
      session.record.pending_interaction = 'none';
      this.emit(session.record.id, {
        type: 'event.approval.resolved',
        payload: { approval_id: approval.approval_id, decision: body.decision, scope: body.scope, resolved_at: now() },
      });
      this.resolveWaiters(session, 'approval');
      return this.envelope(res, { resolved: true, resolved_at: now() });
    }
    if (tail === '/questions') {
      return this.envelope(res, { items: session.pendingQuestions });
    }
    const questionMatch = /^\/questions\/([^/]+)(:dismiss)?$/.exec(tail);
    if (questionMatch !== null && body !== undefined) {
      const question = session.pendingQuestions.find((q) => q.question_id === questionMatch[1]);
      if (question === undefined) return this.envelope(res, { resolved: false }, 40405, 'question.not_found');
      session.pendingQuestions = session.pendingQuestions.filter((q) => q.question_id !== question.question_id);
      session.record.pending_interaction = 'none';
      if (questionMatch[2] === ':dismiss') {
        this.emit(session.record.id, { type: 'event.question.dismissed', payload: { question_id: question.question_id, dismissed_at: now() } });
        this.resolveWaiters(session, 'question');
        return this.envelope(res, { dismissed: true, dismissed_at: now() }, 40909, 'question.dismissed');
      }
      this.emit(session.record.id, { type: 'event.question.answered', payload: { question_id: question.question_id, answers: body.answers ?? {}, resolved_at: now() } });
      this.resolveWaiters(session, 'question');
      return this.envelope(res, { resolved: true, resolved_at: now() });
    }
    if (tail === '/tasks') {
      return this.envelope(res, { items: session.tasks });
    }
    const taskCancel = /^\/tasks\/([^/]+):cancel$/.exec(tail);
    if (taskCancel !== null) {
      const task = session.tasks.find((t) => t.id === taskCancel[1]);
      if (task === undefined) return this.envelope(res, null, 40406, 'task.not_found');
      task.status = 'cancelled';
      task.completed_at = now();
      return this.envelope(res, { cancelled: true });
    }
    return this.envelope(res, null, 40404, `fixture: no route ${path}`);
  }

  async handleControl(body, res) {
    switch (body.action) {
      case 'list': {
        const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
        const files = await readdir(dir);
        return this.envelope(res, {
          scenarios: files.filter((f) => f.endsWith('.scenario.mjs')).map((f) => f.replace('.scenario.mjs', '')),
          active: this.scenario?.name ?? null,
        });
      }
      case 'scenario':
        await this.loadScenario(body.name);
        return this.envelope(res, { active: body.name });
      case 'drop_ws':
        for (const ws of this.sockets) {
          try { ws.terminate(); } catch { /* closing */ }
        }
        return this.envelope(res, { dropped: this.sockets.size });
      case 'resync': {
        const session = this.sessions.get(body.session_id);
        if (session === undefined) return this.envelope(res, null, 40401, 'session.not_found');
        session.epoch = `ep_fixture_${Date.now().toString(36)}`;
        for (const connection of this.sockets) {
          if (connection.subscriptions?.has(session.record.id)) {
            this.sendFrame(connection, {
              type: 'resync_required',
              timestamp: now(),
              payload: { session_id: session.record.id, reason: 'epoch_changed', current_seq: session.seq, epoch: session.epoch },
            });
          }
        }
        return this.envelope(res, { epoch: session.epoch });
      }
      default:
        return this.envelope(res, null, 40001, 'unknown control action');
    }
  }

  handleUpgrade(req, socket, head) {
    if (!req.url?.startsWith('/api/v1/ws')) {
      socket.destroy();
      return;
    }
    const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    const bearer = protocols.find((p) => p.startsWith('kimi-code.bearer.'));
    if (bearer !== `kimi-code.bearer.${FIXTURE_TOKEN}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.subprotocol = bearer;
      this.onConnection(ws);
    });
  }

  onConnection(ws) {
    ws.subscriptions = new Set();
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    this.sendFrame(ws, {
      type: 'server_hello',
      timestamp: now(),
      payload: {
        ws_connection_id: nextId('conn'),
        protocol_version: 2,
        max_event_buffer_size: 1000,
        capabilities: { event_batching: false, compression: false },
      },
    });
    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      const ack = (payload) => this.sendFrame(ws, { type: 'ack', id: message.id, code: 0, msg: 'success', payload });
      switch (message.type) {
        case 'client_hello':
          ack({ accepted_subscriptions: [], resync_required: [], cursors: {} });
          break;
        case 'subscribe': {
          const ids = message.payload?.session_ids ?? [];
          const accepted = ids.filter((id) => this.sessions.has(id));
          for (const id of accepted) ws.subscriptions.add(id);
          const cursors = {};
          for (const id of accepted) {
            const session = this.sessions.get(id);
            cursors[id] = { seq: session.seq, epoch: session.epoch };
          }
          ack({ accepted, not_found: ids.filter((id) => !this.sessions.has(id)), resync_required: [], cursors });
          break;
        }
        case 'unsubscribe':
          for (const id of message.payload?.session_ids ?? []) ws.subscriptions.delete(id);
          ack({ accepted: [], not_found: [], resync_required: [], cursors: {} });
          break;
        case 'abort': {
          const session = this.sessions.get(message.payload?.session_id);
          if (session !== undefined) {
            session.abortRequested = true;
            this.resolveWaiters(session, 'abort');
            session.record.busy = false;
          }
          ack({ aborted: session !== undefined, at_seq: session?.seq ?? 0 });
          break;
        }
        case 'pong':
          break;
        default:
          break;
      }
    });
  }

  async start(port, scenarioName) {
    await this.loadScenario(scenarioName);
    this.http.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    await new Promise((resolve) => this.http.listen(port, '127.0.0.1', resolve));
    console.log(`[fixture] listening on http://127.0.0.1:${port} (token: ${FIXTURE_TOKEN})`);
    return this;
  }

  async stop() {
    for (const ws of this.sockets) {
      try { ws.terminate(); } catch { /* closing */ }
    }
    await new Promise((resolve) => this.http.close(resolve));
  }
}

export async function startFixtureServer({ port = DEFAULT_PORT, scenario = 'basic-stream' } = {}) {
  const server = new FixtureServer();
  return server.start(port, scenario);
}

// Run standalone: node scripts/fixture-server.mjs [--port N] [--scenario name]
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
  };
  await startFixtureServer({
    port: Number(flag('port', DEFAULT_PORT)),
    scenario: flag('scenario', 'basic-stream'),
  });
}
