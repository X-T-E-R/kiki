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
 * step lists the server plays on a trigger (`onPrompt`, a plain list or a
 * `(text, sessionId) => steps` function); steps:
 *   { delay, frame: { type, payload, volatile?, offset? } }  emit a frame
 *   { waitFor: 'approval' | 'question' | 'abort' | 'release' } pause
 *   { commit: Message }                                    journal a message
 *   { spam: { count, frame, paceMs? } } emit count copies of frame in dense
 *                                   500-frame chunks (`$I` binds the index;
 *                                   paceMs stretches the storm across chunks)
 * `{ waitFor: 'approval' }` resumes when the approval is resolved through the
 * REST route, exactly like a real agent blocked on a human.
 *
 * Prompt scheduling mirrors kap-server: a second POST while a turn runs parks
 * in `queuedPrompts` (reply status 'queued'), `GET /sessions/:id/prompts`
 * reports {active, queued}, a finished turn promotes the oldest queued prompt,
 * and `:abort` on a queued id just dequeues it.
 *
 * Control endpoint (not under /api): POST /__control
 *   { action: 'scenario', name }        switch scenario (resets state, drops WS)
 *   { action: 'drop_ws' }               terminate all WS connections abnormally
 *   { action: 'resync', session_id }    bump epoch + send resync_required
 *   { action: 'release', session_id }   resolve { waitFor: 'release' } steps
 *   { action: 'burst', session_id, count, frame? }  on-demand frame storm
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

function fixtureProviderFromBody(id, body, previousHasKey = false) {
  const hasApiKey = body.api_key === undefined ? previousHasKey : body.api_key !== '';
  const aliases = (body.models ?? []).map((model) => `${id}/${model.model}`);
  return {
    id,
    type: body.type,
    base_url: body.base_url,
    default_model: body.default_model === undefined ? aliases[0] : `${id}/${body.default_model}`,
    has_api_key: hasApiKey,
    status: hasApiKey || body.type === 'kimi' ? 'connected' : 'unconfigured',
    models: aliases,
  };
}

function fixtureModelsFromBody(providerId, models) {
  return models.map((model) => ({
    provider: providerId,
    model: `${providerId}/${model.model}`,
    display_name: model.display_name ?? model.model,
    max_context_size: model.max_context_size,
    capabilities: model.capabilities,
    support_efforts: model.support_efforts,
  }));
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

/** Deep-replace `$I` with the spam index; `$I-text` suffixes become `<i>-text`. */
function bindIndex(value, index) {
  if (typeof value === 'string') {
    if (value === '$I') return index;
    return value.includes('$I') ? value.replaceAll('$I', String(index)) : value;
  }
  if (Array.isArray(value)) return value.map((item) => bindIndex(item, index));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bindIndex(v, index)]));
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
    this.subagents = [...(scenarioData.subagents ?? [])];
    this.agentTranscripts = scenarioData.agent_transcripts ?? {};
    this.goal = scenarioData.goal ?? null;
    this.lastPromptSubmission = null;
    this.seq = scenarioData.as_of_seq ?? this.messages.length;
    this.epoch = scenarioData.epoch ?? 'ep_fixture_1';
    this.scriptRunning = false;
    this.abortRequested = false;
    this.waiters = []; // [{kind, resolve, payload?}]
    this.releaseArmed = false; // one-shot gate for { waitFor: 'release' }
    // Prompt queue mirroring kap-server's {active, queued} scheduler surface.
    this.activePrompt = null; // PromptItem while a turn runs
    this.queuedPrompts = []; // PromptItem[]
  }
}

class FixtureServer {
  constructor() {
    this.scenario = null; // { name, data }
    this.config = {};
    this.providers = [];
    this.models = [];
    this.auth = null;
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
    this.config = structuredClone(data.config ?? {
      default_model: 'fixture/kiki-pro',
      default_permission_mode: 'manual',
      providers: {},
    });
    this.providers = structuredClone(data.providers ?? []);
    this.models = structuredClone(data.models ?? []);
    this.auth = structuredClone(data.auth ?? null);
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
      // routing stamps from the broadcaster. Scenarios can select the emitting
      // agent to prove client-side transcript scoping.
      payload: {
        type: partial.type,
        ...partial.payload,
        agentId: partial.agentId ?? partial.payload?.agentId ?? 'main',
        sessionId,
      },
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
  /** Steps for a prompt: `onPrompt` may be a plain step list or a function of
   * the prompt text (queued prompts get their own script on promotion). */
  scriptFor(session, text) {
    const onPrompt = this.scenario?.data.onPrompt;
    if (typeof onPrompt === 'function') return onPrompt(text, session.record.id);
    return Array.isArray(onPrompt) ? onPrompt : null;
  }

  /** Launch the script for a submitted/promoted prompt item. */
  startPrompt(session, item) {
    this.debug(`promote/start ${item.prompt_id} ("${item.text}")`);
    session.activePrompt = item;
    session.record.busy = true;
    const steps = this.scriptFor(session, item.text);
    if (steps !== null) {
      void this.runScript(session.record.id, bindPrompt(bind(steps, session.record.id), item.prompt_id));
    }
  }

  debug(...args) {
    if (process.env.KIKI_FIXTURE_DEBUG !== undefined) console.log('[fixture:debug]', ...args);
  }

  /** A finished turn promotes the oldest queued prompt, like the real
   * scheduler: queued → running, and the new turn's frames start flowing. */
  promoteNext(session) {
    session.activePrompt = null;
    if (session.queuedPrompts.length === 0) {
      session.record.busy = false;
      return;
    }
    const next = session.queuedPrompts.shift();
    this.startPrompt(session, next);
  }

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
          // The release gate is one-shot: a release that arrives before the
          // script parks arms it, and the gate consumes the arm as it passes.
          if (step.waitFor === 'release' && session.releaseArmed === true) {
            session.releaseArmed = false;
            continue;
          }
          await new Promise((resolve) => session.waiters.push({ kind: step.waitFor, resolve }));
          continue;
        }
        if (step.commit !== undefined) {
          session.messages.push({ ...step.commit, id: nextId('msg'), session_id: sessionId, created_at: now() });
          session.record.message_count += 1;
          continue;
        }
        if (step.spam !== undefined) {
          // A dense frame storm ({count, frame, paceMs?}); $I in the template
          // binds the index. Chunks of 500 are emitted back-to-back (no delay
          // inside a chunk — the client still sees uncoalesced bursts); an
          // optional paceMs between chunks stretches the storm so a walker can
          // act deterministically mid-flood. Yields keep HTTP/WS peers serviced.
          const { count, frame, paceMs } = step.spam;
          for (let i = 0; i < count; i += 1) {
            if (session.abortRequested) return;
            this.emit(sessionId, bindIndex(frame, i));
            if (i % 500 === 499) {
              if (paceMs !== undefined) await sleep(paceMs);
              else await new Promise((resolve) => setImmediate(resolve));
            }
          }
          continue;
        }
        if (step.frame !== undefined) {
          this.applySideEffects(session, step.frame);
          this.emit(sessionId, step.frame);
        }
      }
    } finally {
      session.scriptRunning = false;
      this.promoteNext(session);
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
        if ((frame.agentId ?? payload.agentId ?? 'main') === 'main') {
          session.record.busy = false;
          session.record.pending_interaction = 'none';
        }
        break;
      case 'goal.updated':
        session.goal = payload.snapshot ?? null;
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
    const body = (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')
      ? await this.readBody(req)
      : undefined;
    try {
      this.route(res, path, url.searchParams, body, req.method);
    } catch (error) {
      console.error('[fixture] route error', path, error);
      this.envelope(res, null, 50001, String(error));
    }
  }

  route(res, path, query, body, method) {
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
    if (path === '/config' && method === 'POST') {
      this.config = { ...this.config, ...(body ?? {}) };
      return this.envelope(res, this.config);
    }
    if (path === '/config') {
      return this.envelope(res, this.config);
    }
    if (path === '/models') {
      return this.envelope(res, {
        items: this.models.length > 0 ? this.models : [
          { provider: 'fixture', model: 'fixture/kiki-pro', display_name: 'Kiki Pro', max_context_size: 262144, support_efforts: ['low', 'high'], default_effort: 'high' },
          { provider: 'fixture', model: 'fixture/kiki-lite', display_name: 'Kiki Lite', max_context_size: 131072 },
        ],
      });
    }
    const setDefaultModelMatch = /^\/models\/([^/]+):set_default$/.exec(path);
    if (setDefaultModelMatch !== null && method === 'POST') {
      const modelId = decodeURIComponent(setDefaultModelMatch[1]);
      const model = this.models.find((item) => item.model === modelId) ?? {
        provider: modelId.split('/')[0] ?? 'fixture',
        model: modelId,
        display_name: modelId,
        max_context_size: 262144,
      };
      this.config.default_model = modelId;
      if (this.auth !== null) this.auth.default_model = modelId;
      return this.envelope(res, { default_model: modelId, model });
    }
    if (path === '/auth') {
      return this.envelope(res, this.auth ?? {
        ready: true,
        providers_count: 0,
        default_model: null,
        managed_provider: null,
      });
    }
    if (path === '/providers' && method === 'POST' && body !== undefined) {
      const provider = fixtureProviderFromBody(body.id, body);
      this.providers.push(provider);
      this.models.push(...fixtureModelsFromBody(provider.id, body.models ?? []));
      this.config.providers = { ...(this.config.providers ?? {}), [provider.id]: {
        type: provider.type,
        base_url: provider.base_url,
        default_model: provider.default_model,
        has_api_key: provider.has_api_key,
      } };
      if (this.auth !== null) this.auth.providers_count = this.providers.length;
      return this.envelope(res, provider);
    }
    const providerMatch = /^\/providers\/([^/]+)$/.exec(path);
    if (providerMatch !== null && method === 'PUT' && body !== undefined) {
      const currentId = decodeURIComponent(providerMatch[1]);
      const nextId = body.new_id ?? currentId;
      const current = this.providers.find((provider) => provider.id === currentId);
      if (current === undefined) return this.envelope(res, null, 40413, 'provider.not_found');
      const provider = fixtureProviderFromBody(nextId, body, current.has_api_key);
      this.providers = this.providers.map((entry) => entry.id === currentId ? provider : entry);
      this.models = [
        ...this.models.filter((model) => model.provider !== currentId),
        ...fixtureModelsFromBody(nextId, body.models ?? []),
      ];
      const providers = { ...(this.config.providers ?? {}) };
      delete providers[currentId];
      providers[nextId] = {
        type: provider.type,
        base_url: provider.base_url,
        default_model: provider.default_model,
        has_api_key: provider.has_api_key,
      };
      this.config.providers = providers;
      return this.envelope(res, { provider });
    }
    if (providerMatch !== null && method === 'DELETE') {
      const providerId = decodeURIComponent(providerMatch[1]);
      this.providers = this.providers.filter((provider) => provider.id !== providerId);
      this.models = this.models.filter((model) => model.provider !== providerId);
      const providers = { ...(this.config.providers ?? {}) };
      delete providers[providerId];
      this.config.providers = providers;
      if (this.auth !== null) this.auth.providers_count = this.providers.length;
      return this.envelope(res, null);
    }
    if (path === '/providers') {
      return this.envelope(res, { items: this.providers });
    }
    if (path === '/oauth/login') {
      if (method === 'GET') {
        return this.envelope(res, this.scenario?.data.oauth ?? null);
      }
      if (method === 'POST') {
        return this.envelope(res, this.scenario?.data.oauthStart ?? {
          flow_id: nextId('oauth'),
          provider: 'fixture',
          status: 'authenticated',
        });
      }
      if (method === 'DELETE') {
        return this.envelope(res, { cancelled: true, status: 'cancelled' });
      }
    }
    if (path === '/oauth/logout' && body !== undefined) {
      return this.envelope(res, {
        logged_out: true,
        provider: body.provider ?? 'fixture',
      });
    }
    if (path === '/tools') {
      return this.envelope(res, {
        tools: this.scenario?.data.tools ?? [],
      });
    }
    if (path === '/mcp/servers') {
      return this.envelope(res, {
        servers: this.scenario?.data.mcpServers ?? [],
      });
    }
    const mcpRestartMatch = /^\/mcp\/servers\/([^/]+):restart$/.exec(path);
    if (mcpRestartMatch !== null && body !== undefined) {
      return this.envelope(res, { restarting: true });
    }
    const workspaceSkillsMatch = /^\/workspaces\/([^/]+)\/skills$/.exec(path);
    if (workspaceSkillsMatch !== null) {
      return this.envelope(res, {
        skills: this.scenario?.data.workspaceSkills?.[workspaceSkillsMatch[1]] ?? [],
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
        subagents: session.subagents,
        pending_approvals: session.pendingApprovals,
        pending_questions: session.pendingQuestions,
      });
    }
    if (tail === '/goal') {
      return this.envelope(res, session.goal);
    }
    if (tail === '/transcript') {
      const agentId = query.get('agent_id');
      const transcript = agentId === null ? undefined : session.agentTranscripts[agentId];
      if (transcript === undefined) {
        return this.envelope(res, null, 40402, 'agent.not_found');
      }
      return this.envelope(res, transcript);
    }
    if (tail === '/messages') {
      const beforeId = query.get('before_id');
      const pageSize = Math.min(Number(query.get('page_size') ?? 50), 100);
      const all = [...session.older, ...session.messages];
      const desc = [...all].reverse();
      let pivotIndex = -1;
      if (beforeId !== null) {
        pivotIndex = desc.findIndex((m) => m.id === beforeId);
      }
      const slice = pivotIndex >= 0 ? desc.slice(pivotIndex + 1) : desc;
      const items = slice.slice(0, pageSize);
      const hasMore = slice.length > pageSize;
      return this.envelope(res, { items, has_more: hasMore });
    }
    if (tail === '/prompts' && body !== undefined) {
      // v2 currently uses one stable id for the prompt, user message, and
      // durable context message. Keep the stand-in aligned with that graph.
      const promptId = nextId('msg');
      const userMessageId = promptId;
      const createdAt = now();
      const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      session.messages.push({ id: userMessageId, session_id: session.record.id, role: 'user', content: body.content, created_at: createdAt, prompt_id: promptId });
      session.record.message_count += 1;
      session.record.last_prompt = text;
      session.lastPromptSubmission = body;
      const item = { prompt_id: promptId, user_message_id: userMessageId, status: 'running', content: body.content, created_at: createdAt, text };
      // A parked turn owns the session — park behind it like the real server.
      if (session.scriptRunning || session.activePrompt !== null) {
        session.queuedPrompts.push(item);
        this.debug(`prompt "${text}" queued as ${promptId} (active=${session.activePrompt?.prompt_id ?? 'none'}, queue=${session.queuedPrompts.length})`);
        return this.envelope(res, { prompt_id: promptId, user_message_id: userMessageId, status: 'queued', content: body.content, created_at: createdAt });
      }
      this.debug(`prompt "${text}" running as ${promptId}`);
      // Real v2 publishes turn.started before the HTTP reply. Scenarios use this
      // hook to reproduce that cross-transport race deterministically.
      const beforeResponse = this.scenario?.data.onSubmitBeforeResponse;
      if (Array.isArray(beforeResponse)) {
        for (const frame of bindPrompt(bind(beforeResponse, session.record.id), promptId)) {
          this.applySideEffects(session, frame);
          this.emit(session.record.id, frame);
        }
      }
      this.startPrompt(session, item);
      return this.envelope(res, { prompt_id: promptId, user_message_id: userMessageId, status: 'running', content: body.content, created_at: createdAt });
    }
    if (tail === '/prompts') {
      const strip = (item, status) => ({
        prompt_id: item.prompt_id,
        user_message_id: item.user_message_id,
        status,
        content: item.content,
        created_at: item.created_at,
      });
      this.debug(`GET prompts → active=${session.activePrompt?.prompt_id ?? 'null'} queued=[${session.queuedPrompts.map((p) => p.prompt_id).join(',')}]`);
      return this.envelope(res, {
        active: session.activePrompt === null ? null : strip(session.activePrompt, 'running'),
        queued: session.queuedPrompts.map((item) => strip(item, 'queued')),
      });
    }
    const abortMatch = /^\/prompts\/([^/]+):abort$/.exec(tail);
    if (abortMatch !== null) {
      const promptId = abortMatch[1];
      const queuedIndex = session.queuedPrompts.findIndex((item) => item.prompt_id === promptId);
      if (queuedIndex >= 0) {
        session.queuedPrompts.splice(queuedIndex, 1);
        this.emit(session.record.id, { type: 'prompt.aborted', payload: { promptId, abortedAt: now() } });
        return this.envelope(res, { aborted: true, at_seq: session.seq });
      }
      if (session.activePrompt?.prompt_id === promptId || session.scriptRunning) {
        session.abortRequested = true;
        this.resolveWaiters(session, 'abort');
        if (session.scriptRunning) {
          this.emit(session.record.id, {
            type: 'turn.ended',
            payload: { turnId: 1, reason: 'cancelled' },
          });
        }
        this.emit(session.record.id, { type: 'prompt.aborted', payload: { promptId, abortedAt: now() } });
        session.record.busy = false;
        return this.envelope(res, { aborted: true, at_seq: session.seq });
      }
      return this.envelope(res, { aborted: false, at_seq: session.seq }, 40903, 'prompt.already_completed');
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
      case 'session': {
        const session = this.sessions.get(body.session_id);
        if (session === undefined) return this.envelope(res, null, 40401, 'session.not_found');
        return this.envelope(res, {
          record: session.record,
          goal: session.goal,
          last_prompt_submission: session.lastPromptSubmission,
        });
      }
      case 'drop_ws':
        for (const ws of this.sockets) {
          try { ws.terminate(); } catch { /* closing */ }
        }
        return this.envelope(res, { dropped: this.sockets.size });
      case 'release': {
        // Unblock steps parked on { waitFor: 'release' } (queue/abort pacing).
        // With none parked yet, arm the one-shot gate for the next one.
        const session = this.sessions.get(body.session_id);
        if (session === undefined) return this.envelope(res, null, 40401, 'session.not_found');
        const parked = session.waiters.filter((w) => w.kind === 'release').length;
        if (parked > 0) this.resolveWaiters(session, 'release');
        else session.releaseArmed = true;
        return this.envelope(res, { released: parked, armed: parked === 0 });
      }
      case 'burst': {
        // On-demand no-delay frame storm (default: child-agent tool deltas) so
        // a walker can stress the client pipeline at a moment it chooses.
        const session = this.sessions.get(body.session_id);
        if (session === undefined) return this.envelope(res, null, 40401, 'session.not_found');
        const count = Number(body.count ?? 2000);
        const template = body.frame ?? {
          type: 'tool.call.delta',
          agentId: body.agentId ?? 'agent-hidden',
          payload: { turnId: 900, toolCallId: 'burst-call', name: 'Write', argumentsPart: '$I ' },
        };
        for (let i = 0; i < count; i += 1) {
          this.emit(session.record.id, bindIndex(template, i));
          if (i % 500 === 499) await new Promise((resolve) => setImmediate(resolve));
        }
        return this.envelope(res, { emitted: count });
      }
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
