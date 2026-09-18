/**
 * kiki-gui fixture server — a deterministic stand-in for kap-server so every
 * GUI state can be rendered and screenshotted without a live model.
 *
 *   node scripts/fixture-server.mjs [--port 58901] [--scenario basic-stream]
 *
 * Serves the exact `/api` REST routes the GUI consumes plus the `/api/ws`
 * handshake and `session_event` frames in the real envelope shapes (WS
 * protocol v2: server_hello → client_hello → subscribe ack with {seq, epoch}
 * cursors; durable frames advance seq, volatile frames carry it + `offset`).
 * Current GUI views use `/api/klient/session-view/*` and `/api/klient/events`
 * via fixture-klient.mjs: production schemas, ordered replay, independent
 * transcript checkpoints, heartbeat and reconnect. The core event bus and
 * typed global facade calls used by the GUI are supported; unseeded capability
 * policy is explicitly unavailable. Shared-socket terminal attach/input/resize/
 * detach reuse FakeTerminal with replay and session isolation. Unsupported
 * facade calls and frames reject. Run `node scripts/fixture-klient-proof.mjs`
 * for isolated first-open/reconnect screenshots under `.tmp/fixture-klient-proof`.
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
 * `:abort` on a queued id just dequeues it, and `:steer` merges a queued id
 * into the running turn (prompt.steered; 40402 without one).
 *
 * Control endpoint (not under /api): POST /__control
 *   { action: 'scenario', name }        switch scenario (resets state, drops WS)
 *   { action: 'drop_ws' }               terminate all WS connections abnormally
 *   { action: 'resync', session_id }    bump epoch + send resync_required
 *   { action: 'release', session_id }   resolve { waitFor: 'release' } steps
 *   { action: 'burst', session_id, count, frame? }  on-demand frame storm
 *   { action: 'list' }                  list scenario names + active one
 *   { action: 'skip_seq', session_id, agent_id?, count? }  jump transcript seq
 *   { action: 'emit_transcript', session_id, agent_id, ops }  inject ops
 *   { action: 'rewrite', session_id, ids? }  transcript items.remove / reset
 *
 * Transcript protocol: `/meta.capabilities.transcript=true`. Scenario
 * `session_event` steps still run; the server also journals `transcript.reset`
 * / `transcript.ops` per agent and serves `subscribe_v2` / `unsubscribe_v2`
 * plus `GET .../transcript/ops` catch-up. Legacy `subscribe` is unchanged.
 *
 * Terminals: `/sessions/{id}/terminals*` REST plus the `terminal_*` WS control
 * frames are served by FakeTerminal, a line-oriented echo shell (`echo`, `pwd`,
 * `clear`, `exit [n]`) with PTY-style echo, a 2000-frame replay buffer, and
 * attach/detach/input/resize/close acks. A scenario can seed running PTYs via
 * a snapshot entry's `terminals: [{shell?, cwd?, cols?, rows?, banner?}]`.
 */

import { createServer } from 'node:http';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocketServer } from 'ws';
import { FixtureKlient } from './fixture-klient.mjs';

import {
  TranscriptProjector,
  filterOpsForGrade,
  gradeFor,
  redactSnapshotForGrade,
  seedMessages,
  seedSnapshotEntities,
  transcriptEnvelope,
} from './fixture-transcript.mjs';

export const FIXTURE_TOKEN = 'kiki-fixture-token';
const DEFAULT_PORT = 58901;

/**
 * nb-search fallback when a scenario does not seed the domain: the runtime
 * defaults with nothing configured — WebSearch fails closed (no default
 * lane), FetchURL is ready on the built-in direct.fetch → jina.reader chain.
 * Mirrors a real `createNbSearchRuntime({ env: {}, config: undefined })`
 * capabilities read, trimmed to the built-ins the settings leaf renders.
 */
const NB_SEARCH_EMPTY_CAPABILITIES = {
  schema_version: '3.0',
  revision: 'config-fixture-empty',
  providers: {
    descriptors: [
      { provider_id: 'exa', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'optional' }, option_keys: [] },
      { provider_id: 'searxng', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'none', endpoint: 'required' }, option_keys: [] },
      { provider_id: 'direct-http', adapter_version: '1', query_operations: [], fetch_operations: [], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
    ],
    instances: [
      { id: 'exa.default', provider_id: 'exa', enabled: true, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }, { code: 'LANE_NOT_CONFIGURED' }], credential: { requirement: 'required', configured: false, slot_id: 'exa.default' }, endpoint: { requirement: 'optional', configured: false } },
      { id: 'searxng.default', provider_id: 'searxng', enabled: true, availability: 'unavailable', issues: [{ code: 'ENDPOINT_NOT_CONFIGURED' }], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'required', configured: false } },
      { id: 'direct-http.default', provider_id: 'direct-http', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
    ],
  },
  search: {
    lanes: [
      { id: 'exa.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: [], availability: 'unavailable', issues: [{ code: 'LANE_NOT_CONFIGURED' }], latency: 'fast', cost: 'cheap' },
      { id: 'searxng.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: [], availability: 'unavailable', issues: [{ code: 'ENDPOINT_NOT_CONFIGURED' }], latency: 'medium', cost: 'free' },
      { id: 'github.repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [{ code: 'RATE_LIMIT_UNAUTHENTICATED' }], latency: 'fast', cost: 'free' },
    ],
    presets: [],
    limits: { max_queries: 64, max_results: 100, max_timeout_ms: 3_600_000, max_inline_bytes: 65_536 },
  },
  fetch: {
    default_representation: 'markdown',
    inputs: [{ kind: 'url', enabled: true, max_bytes: 2_097_152 }],
    chains: [{ input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] }],
    pipelines: [
      { id: 'direct.fetch', input_kinds: ['url'], media_types: ['text/html', 'text/plain'], representations: ['markdown', 'text'], execution_modes: ['sync', 'async'], egress: 'url', stages: [{ id: 'direct-http', role: 'acquire' }], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
      { id: 'jina.reader', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: ['sync', 'async'], egress: 'url', stages: [{ id: 'jina-reader', role: 'reader' }], availability: 'ready', issues: [], latency: 'medium', cost: 'free' },
    ],
    limits: { max_source_bytes: 2_097_152, max_response_bytes: 2_097_152, max_content_chars: 200_000, max_redirects: 5, max_timeout_ms: 60_000, max_inline_bytes: 65_536 },
  },
  jobs: { result_ttl_seconds: 259_200, cancel_supported: true },
};

const NB_SEARCH_EMPTY_TEST = {
  revision: 'config-fixture-empty',
  search: { configured: false, available: false, issues: ['DEFAULT_NOT_CONFIGURED'] },
  fetch: { configured: true, available: true, selection: 'direct.fetch -> jina.reader', issues: [] },
};

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

function fixtureProviderFromBody(id, body, previousHasKey = false, previousRequestIdentity) {
  const hasApiKey = body.api_key === undefined ? previousHasKey : body.api_key !== '';
  const aliases = (body.models ?? []).map((model) => `${id}/${model.remote_id}`);
  const requestIdentity = body.request_identity === null
    ? undefined
    : (body.request_identity ?? previousRequestIdentity);
  return {
    id,
    type: body.type,
    base_url: body.base_url,
    default_model: body.default_model === undefined ? aliases[0] : `${id}/${body.default_model}`,
    request_identity: requestIdentity,
    has_api_key: hasApiKey,
    status: hasApiKey || body.type === 'kimi' ? 'connected' : 'unconfigured',
    models: aliases,
  };
}

function fixtureModelsFromBody(providerId, models) {
  return models.map((model) => ({
    id: `${providerId}/${model.remote_id}`,
    provider_id: providerId,
    remote_id: model.remote_id,
    display_name: model.display_name ?? model.remote_id,
    max_context_size: model.max_context_size,
    capabilities: model.capabilities,
    support_efforts: model.support_efforts,
    request_identity: model.request_identity === null ? undefined : model.request_identity,
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

/**
 * Default skill-activation turn: the real route renders the skill prompt into
 * a user message and starts a turn with a `skill_activation` origin. Scenarios
 * override this with `onSkill(name, args, sessionId)` when they need more.
 */
function defaultSkillSteps(name, args, sessionId) {
  const slashText = `/${name}${args !== '' ? ` ${args}` : ''}`;
  const replyText = `Skill /${name} ran in the fixture${args !== '' ? ` with args "${args}"` : ''}.`;
  return [
    { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'skill_activation' }, prompt: slashText } } },
    { frame: { type: 'event.session.work_changed', payload: { busy: true, pending_interaction: 'none' } } },
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    { delay: 150 },
    { frame: { type: 'assistant.delta', offset: 0, payload: { turnId: 1, delta: replyText } } },
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
    { commit: { id: 'placeholder', session_id: sessionId, role: 'user', content: [{ type: 'text', text: slashText }], created_at: now() } },
    { commit: { id: 'placeholder', session_id: sessionId, role: 'assistant', content: [{ type: 'text', text: replyText }], created_at: now() } },
    { frame: { type: 'turn.ended', payload: { turnId: 1, reason: 'completed', durationMs: 300 } } },
    { frame: { type: 'event.session.work_changed', payload: { busy: false, pending_interaction: 'none' } } },
  ];
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
    this.transcript = new TranscriptProjector(record.id, this.agentTranscripts, this.epoch);
    if ((scenarioData.messages ?? []).length > 0 || (scenarioData.older ?? []).length > 0) {
      seedMessages(this.transcript, this.messages, {
        older: this.older,
        hasMore: this.hasMore,
      });
    }
    seedSnapshotEntities(this.transcript, scenarioData);
    this.goal = scenarioData.goal ?? null;
    this.lastPromptSubmission = null;
    this.lastSkillActivation = null; // {name, args, attachments} — walker assertions
    this.lastFsSearch = null; // last fs:search body
    this.lastMessageAction = null; // {action: 'edit'|'regenerate', message_id, body}
    this.seq = scenarioData.as_of_seq ?? this.messages.length;
    this.epoch = scenarioData.epoch ?? 'ep_fixture_1';
    this.scriptRunning = false;
    this.abortRequested = false;
    this.waiters = []; // [{kind, resolve, payload?}]
    this.releaseArmed = false; // one-shot gate for { waitFor: 'release' }
    // Prompt queue mirroring kap-server's {active, queued} scheduler surface.
    // Scenarios may seed a running/queued backlog for list-prompts consumers:
    // snapshot entries `active_prompt` / `queued_prompts` carry the PromptItem
    // wire fields plus the internal `text` used by onPrompt script selection.
    this.activePrompt = scenarioData.active_prompt ?? null; // PromptItem while a turn runs
    this.queuedPrompts = [...(scenarioData.queued_prompts ?? [])]; // PromptItem[]
    // Durable frames journaled for subscribe replay (getBufferedSince model).
    this.journal = []; // [{seq, frame}]
    // interactionId → resolved state, so /transcript interactions stay honest.
    this.resolvedInteractions = new Map();
    // Fake PTYs (terminal domain). Scenario seeds: snapshot entry `terminals:
    // [{shell?, cwd?, cols?, rows?, banner?}]` — a banner line proves attach
    // replay without any typing.
    this.terminals = new Map(); // terminal_id → FakeTerminal
    for (const seed of scenarioData.terminals ?? []) {
      const term = new FakeTerminal(this, seed);
      if (typeof seed.banner === 'string') term.emit(`${seed.banner}\r\n`);
      this.terminals.set(term.record.id, term);
    }
  }
}

/**
 * FakeTerminal — a line-oriented echo shell behind the terminal wire verbs.
 * PTY-style: input chars echo back, CR runs the line buffer, backspace erases
 * (`\b \b`), Ctrl+C (`ETX`) cancels the line. Commands: `echo …`, `exit [n]`,
 * `clear`, `pwd`; anything else is "command not found". Output frames carry a
 * per-terminal seq and buffer (cap 2000) for attach replay, exactly like the
 * engine's SessionTerminalService; the exit frame replays unconditionally.
 */
class FakeTerminal {
  constructor(session, options = {}) {
    this.session = session;
    this.record = {
      id: nextId('term'),
      session_id: session.record.id,
      cwd: options.cwd ?? session.record.metadata?.cwd ?? 'C:/fixture',
      shell: options.shell ?? '/bin/sh',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      status: 'running',
      created_at: now(),
    };
    this.buffer = []; // output frames, capped like the engine's 2000
    this.nextSeq = 0;
    this.line = '';
    this.attachments = new Set(); // ws connections attached to this terminal
    this.emit('$ ');
  }

  frame(data) {
    return {
      type: 'terminal_output',
      seq: (this.nextSeq += 1),
      session_id: this.record.session_id,
      terminal_id: this.record.id,
      timestamp: now(),
      payload: { data },
    };
  }

  exitFrame() {
    return {
      type: 'terminal_exit',
      session_id: this.record.session_id,
      terminal_id: this.record.id,
      timestamp: now(),
      payload: { exit_code: this.record.exit_code ?? null },
    };
  }

  emit(data) {
    const frame = this.frame(data);
    this.buffer.push(frame);
    if (this.buffer.length > 2000) this.buffer.splice(0, this.buffer.length - 2000);
    for (const ws of this.attachments) {
      if (ws.readyState === 1) ws.send(JSON.stringify(frame));
    }
  }

  /** Add output while simulating a disconnected client (proof-only gap). */
  emitBuffered(data) {
    const frame = this.frame(data);
    this.buffer.push(frame);
    if (this.buffer.length > 2000) this.buffer.splice(0, this.buffer.length - 2000);
  }

  write(data) {
    if (this.record.status !== 'running') return;
    for (const char of String(data)) {
      const code = char.codePointAt(0);
      if (code === 13) {
        // CR: run the buffered line (PTYs deliver \r for Enter).
        const line = this.line;
        this.line = '';
        this.emit('\r\n');
        this.run(line);
        if (this.record.status === 'running') this.emit('$ ');
      } else if (code === 127 || code === 8) {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.emit('\b \b');
        }
      } else if (code === 3) {
        this.line = '';
        this.emit('^C\r\n$ ');
      } else if (code >= 32) {
        this.line += char;
        this.emit(char);
      }
      // other control bytes are swallowed, like a raw-mode-less shell
    }
  }

  run(line) {
    const trimmed = line.trim();
    if (trimmed === '') return;
    if (trimmed === 'echo') {
      this.emit('\r\n');
      return;
    }
    if (trimmed.startsWith('echo ')) {
      this.emit(`${trimmed.slice(5)}\r\n`);
      return;
    }
    if (trimmed === 'pwd') {
      this.emit(`${this.record.cwd}\r\n`);
      return;
    }
    if (trimmed === 'clear') {
      this.emit(`${String.fromCharCode(27)}[H${String.fromCharCode(27)}[2J`);
      return;
    }
    if (trimmed === 'exit' || trimmed.startsWith('exit ')) {
      const code = trimmed === 'exit' ? 0 : Number(trimmed.slice(5).trim());
      this.close(Number.isFinite(code) ? code : 0);
      return;
    }
    this.emit(`sh: ${trimmed.split(' ')[0]}: command not found\r\n`);
  }

  resize(cols, rows) {
    this.record.cols = cols;
    this.record.rows = rows;
  }

  /** Kill the PTY (engine semantics: exit_code null on close). */
  close(exitCode = null) {
    if (this.record.status === 'exited') return;
    this.record.status = 'exited';
    this.record.exited_at = now();
    this.record.exit_code = exitCode;
    const frame = this.exitFrame();
    for (const ws of this.attachments) {
      if (ws.readyState === 1) ws.send(JSON.stringify(frame));
    }
  }
}

class FixtureServer {
  constructor() {
    this.scenario = null; // { name, data }
    this.config = {};
    this.providers = [];
    this.models = [];
    this.modelsDeclared = false;
    this.auth = null;
    this.sessions = new Map();
    this.sockets = new Set();
    this.lastSearchBody = null; // last POST /search body (walker assertions)
    this.lastFileUpload = null; // last POST /files meta (walker assertions)
    this.lastFsWrite = null; // last POST /fs:write body (walker assertions)
    this.fileCounter = 0;
    this.files = new Map(); // global file facade uploads: id → { meta, bytes }
    this.workspaces = []; // mutable registered workspaces (PATCH/DELETE editable)
    this.agentProfiles = []; // expanded named-agent rows; GET /agents merges them
    this.mcpManaged = []; // mutable /mcp/servers management catalog
    this.plugins = []; // mutable /plugins catalog
    this.oauthOverride = null; // mutable OAuth flow state (POST/DELETE /oauth/login)
    this.wsInbound = [];
    this.wsOutbound = [];
    this.http = createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.klient = new FixtureKlient(this);
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
    // A scenario that declares `models: []` means an unconfigured server, not
    // "unset" — without this the /models fallback below makes an empty catalog
    // unrepresentable (first-run guidance can never be exercised).
    this.modelsDeclared = Array.isArray(data.models);
    this.auth = structuredClone(data.auth ?? null);
    this.sessions.clear();
    this.workspaces = structuredClone(data.workspaces ?? []);
    this.agentProfiles = structuredClone(data.agentProfiles ?? [
      { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
    ]);
    this.mcpManaged = structuredClone(data.mcpManagedServers ?? []);
    this.plugins = structuredClone(data.plugins ?? []);
    this.usageV2 = data.usageV2 ?? null;
    for (const session of data.sessions ?? []) {
      const bound = bind(session, session.id);
      this.sessions.set(session.id, new FixtureSession(bound, bind(data.snapshots?.[session.id] ?? {}, session.id)));
    }
    for (const ws of this.sockets) {
      try { ws.terminate(); } catch { /* closing */ }
    }
    this.sockets.clear();
    this.files.clear();
    this.lastSearchBody = null;
    this.lastFileUpload = null;
    this.lastFsWrite = null;
    this.oauthOverride = null;
    this.wsInbound = [];
    this.wsOutbound = [];
    console.log(`[fixture] scenario "${name}" loaded (${this.sessions.size} sessions)`);
  }

  // /agents helpers: disabled synthesis and effective winner selection mirror
  // the server's config channels and profile source priorities.
  agentProfilesWithDisabled(workspaceId) {
    const disabledBuiltin = new Set(this.config.disabled_builtin_profiles ?? []);
    const disabledNamed = new Set(this.config.disabled_named_profiles ?? []);
    return this.agentProfiles
      .filter((profile) => workspaceId === undefined || profile.workspace_id === undefined || profile.workspace_id === workspaceId)
      .map((profile) => ({
        routes: [],
        ...profile,
        disabled: profile.disabled === true || (profile.source === 'builtin' ? disabledBuiltin : disabledNamed).has(profile.name),
      }));
  }

  profilePriority(profile) {
    if (Number.isFinite(profile.priority)) return profile.priority;
    return { builtin: 0, extra: 10, user: 20, workspace: 30 }[profile.source] ?? 0;
  }

  effectiveAgentProfiles(workspaceId) {
    const byName = new Map();
    for (const profile of this.agentProfilesWithDisabled(workspaceId)) {
      const entries = byName.get(profile.name) ?? [];
      entries.push(profile);
      byName.set(profile.name, entries);
    }
    const winners = [];
    for (const entries of byName.values()) {
      const enabled = entries.filter((profile) => !profile.disabled);
      const builtin = enabled.find((profile) => profile.source === 'builtin');
      const files = enabled
        .filter((profile) => profile.source !== 'builtin')
        .toSorted((left, right) => this.profilePriority(right) - this.profilePriority(left) || String(left.source_file ?? '').localeCompare(String(right.source_file ?? '')));
      const winner = files.find((profile) => profile.override === true) ?? builtin ?? files[0];
      const defaultMain = entries.find((profile) => profile.name === 'agent' && profile.source === 'builtin' && profile.main === true);
      if (winner !== undefined) {
        winners.push(winner.name === 'agent' && winner.main === true ? { ...winner, disabled: false } : winner);
      } else if (defaultMain !== undefined) {
        winners.push({ ...defaultMain, disabled: false });
      }
    }
    return winners;
  }

  mergedAgentProfiles(workspaceId) {
    const merged = [];
    const indexByKey = new Map();
    for (const profile of this.agentProfilesWithDisabled(workspaceId)) {
      const key = `${profile.name}\n${profile.source}\n${profile.source_file ?? ''}`;
      const ids = profile.workspace_ids ?? (profile.workspace_id === undefined ? [] : [profile.workspace_id]);
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        indexByKey.set(key, merged.length);
        merged.push({ ...profile, workspace_ids: ids });
        continue;
      }
      const existing = merged[existingIndex];
      merged[existingIndex] = {
        ...existing,
        workspace_ids: [...new Set([...existing.workspace_ids, ...ids])],
        disabled: existing.disabled || profile.disabled,
      };
    }
    return merged;
  }

  // ------------------------------------------------------------- WS fan-out
  sendFrame(connection, frame) {
    this.wsOutbound.push({ type: frame.type, payload: frame.payload, session_id: frame.session_id, seq: frame.seq });
    if (this.wsOutbound.length > 400) this.wsOutbound.splice(0, this.wsOutbound.length - 400);
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
      // Journal durable frames for subscribe replay; the advertised buffer
      // bound (1000) caps how far back a resubscribe can reach.
      session.journal.push({ seq: session.seq, frame });
      if (session.journal.length > 1000) session.journal.splice(0, session.journal.length - 1000);
    }
    for (const connection of this.sockets) {
      if (connection.subscriptions?.has(sessionId)) this.sendFrame(connection, frame);
    }
    this.klient.emit(sessionId, frame);
    // Rewrite routes ingest locally, reseed the journal user, start the new
    // prompt, then fanout a single transcript.reset. Fanout here would push
    // items.remove before that reset, wiping the GUI's previous user so the
    // regenerate identity stamp cannot keep edit/fork settled.
    if (partial.type !== 'event.session.history_rewritten') {
      this.emitTranscriptFromFrame(session, frame);
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

  emitTranscriptFromFrame(session, frame, extras = {}) {
    const active = session.activePrompt;
    const merged = {
      promptId: extras.promptId ?? active?.prompt_id,
      userMessageId: extras.userMessageId ?? active?.user_message_id,
      content: extras.content ?? active?.content,
      ...extras,
    };
    const batches = session.transcript.ingestFrame(frame, merged) ?? [];
    for (const batch of batches) {
      // Fixture state merges interaction patches; the shared wire upsert replaces
      // the entire entity. Journal the full fact at this revision, not a patch.
      const interactions = session.transcript.snapshot(batch.agentId).interactions;
      for (const op of batch.ops) if (op.op === 'interaction.upsert') {
        op.interaction = structuredClone(interactions.find((entry) => entry.interactionId === op.interaction.interactionId));
      }
      this.fanoutTranscriptOps(session, batch.agentId, batch);
    }
  }

  fanoutTranscriptOps(session, agentId, batch) {
    this.klient.transcript(session, agentId, batch);
    for (const connection of this.sockets) {
      const spec = connection.transcriptGrades?.get(session.record.id);
      if (spec === undefined) continue;
      const grade = gradeFor(spec, agentId);
      if (grade === 'off') continue;
      const ops = filterOpsForGrade(grade, batch.ops);
      if (ops.length === 0) continue;
      this.sendFrame(connection, transcriptEnvelope(
        session.record.id,
        session.transcript.opsEvent(agentId, { seq: batch.seq, ops }),
        session.seq,
        session.epoch,
      ));
    }
  }

  fanoutTranscriptReset(session, agentId) {
    this.klient.transcript(session, agentId);
    const payload = session.transcript.resetEvent(agentId);
    for (const connection of this.sockets) {
      const spec = connection.transcriptGrades?.get(session.record.id);
      if (spec === undefined) continue;
      const grade = gradeFor(spec, agentId);
      if (grade === 'off') continue;
      this.sendFrame(connection, transcriptEnvelope(
        session.record.id,
        { ...payload, grade, snapshot: redactSnapshotForGrade(grade, payload.snapshot) },
        session.seq,
        session.epoch,
      ));
    }
  }

  attachTranscript(connection, session, spec, since) {
    connection.transcriptGrades ??= new Map();
    connection.transcriptGrades.set(session.record.id, spec);
    for (const agentId of session.transcript.agents.keys()) {
      const grade = gradeFor(spec, agentId);
      if (grade === 'off') continue;
      const raw = since?.[agentId];
      const cursorSeq = typeof raw === 'number' ? raw : raw?.seq;
      if (cursorSeq === undefined) {
        const payload = session.transcript.resetEvent(agentId, grade);
        this.sendFrame(connection, transcriptEnvelope(
          session.record.id,
          { ...payload, snapshot: redactSnapshotForGrade(grade, payload.snapshot) },
          session.seq,
          session.epoch,
        ));
        continue;
      }
      const catchup = session.transcript.catchup(agentId, cursorSeq);
      if (!catchup.complete) {
        const payload = session.transcript.resetEvent(agentId, grade);
        this.sendFrame(connection, transcriptEnvelope(
          session.record.id,
          { ...payload, snapshot: redactSnapshotForGrade(grade, payload.snapshot) },
          session.seq,
          session.epoch,
        ));
        continue;
      }
      for (const batch of catchup.batches) {
        const ops = filterOpsForGrade(grade, batch.ops);
        if (ops.length === 0) continue;
        this.sendFrame(connection, transcriptEnvelope(
          session.record.id,
          session.transcript.opsEvent(agentId, { seq: batch.seq, ops }),
          session.seq,
          session.epoch,
        ));
      }
    }
  }

  // ------------------------------------------------------------- scripts
  /** Steps for a prompt: `onPrompt` may be a plain step list or a function of
   * the prompt text (queued prompts get their own script on promotion). */
  scriptFor(session, text) {
    const onPrompt = this.scenario?.data.onPrompt;
    if (typeof onPrompt === 'function') {
      return onPrompt.length >= 3
        ? onPrompt(text, session.record.id, session)
        : onPrompt(text, session.record.id);
    }
    return Array.isArray(onPrompt) ? onPrompt : null;
  }

  /** Launch the script for a submitted/promoted prompt item. */
  startPrompt(session, item) {
    this.debug(`promote/start ${item.prompt_id} ("${item.text}")`);
    session.activePrompt = item;
    session.record.busy = true;
    this.emitTranscriptFromFrame(session, {
      type: 'prompt.submitted',
      payload: {
        type: 'prompt.submitted',
        promptId: item.prompt_id,
        userMessageId: item.user_message_id,
        content: item.content,
        createdAt: item.created_at,
      },
    }, { promptId: item.prompt_id, userMessageId: item.user_message_id, content: item.content });
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
          const committed = { ...step.commit, id: nextId('msg'), session_id: sessionId, created_at: now() };
          session.messages.push(committed);
          session.record.message_count += 1;
          if (committed.role === 'assistant') {
            const batch = session.transcript.bindAssistantMessageId('main', committed.id);
            if (batch !== undefined) this.fanoutTranscriptOps(session, 'main', batch);
          }
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
          task.status = payload.info.status === 'killed' ? 'cancelled' : payload.info.status;
          task.completed_at = now();
          task.stop_reason = payload.info.stopReason;
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

  /**
   * `fs:search` for both the session route and the session-less workspace
   * route: scenario-seeded entries, empty query → top-level entries only
   * (dirs first), otherwise a case-insensitive substring match on the path.
   */
  replyFsSearch(res, session, body) {
    const entries = this.scenario?.data.fsEntries ?? [];
    const q = String(body?.query ?? '').toLowerCase();
    if (session !== null) session.lastFsSearch = body ?? null;
    const matched = q === ''
      ? entries.filter((entry) => !entry.path.includes('/'))
      : entries.filter((entry) => entry.path.toLowerCase().includes(q));
    matched.sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'directory' ? -1 : 1));
    const limit = Math.min(Number(body?.limit ?? 50), 200);
    const items = matched.slice(0, limit).map((entry) => ({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      score: 1,
      match_positions: [],
    }));
    return this.envelope(res, { items, truncated: matched.length > items.length });
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
      res.setHeader('access-control-allow-headers', 'Content-Type, Authorization, x-api-key, anthropic-version');
      // The export download's filename rides Content-Disposition; browsers
      // hide it from cross-origin fetch unless it is exposed.
      res.setHeader('access-control-expose-headers', 'Content-Disposition');
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

    if (url.pathname === '/api/healthz') {
      this.envelope(res, { ok: true });
      return;
    }

    // Mock upstream provider endpoint for the settings "pull models" flow: the
    // GUI fetches `{baseUrl}/models` directly (browser fetch, no /api proxy),
    // so this route sits outside the fixture-token auth check and instead
    // demands whatever API key the form sent as a Bearer token.
    if (url.pathname === '/provider-mock/v1/models') {
      // Anthropic-flavoured clients send x-api-key, openai-flavoured send a
      // Bearer token — the mock accepts either as proof the form key was sent.
      const credential = req.headers.authorization ?? req.headers['x-api-key'];
      if (typeof credential !== 'string' || credential === '') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'missing API key', type: 'authentication_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'mock-pro', object: 'model' }, { id: 'mock-lite', object: 'model' }],
      }));
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${FIXTURE_TOKEN}`) {
      this.envelope(res, null, 40101, 'Unauthorized');
      return;
    }

    if (url.pathname.startsWith('/api/klient/')) {
      const body = req.method === 'POST' ? await this.readBody(req) : undefined;
      return this.klient.route(res, url, body, req.method);
    }

    // Multipart upload: the real server streams the bytes into its file store
    // and answers FileMeta; the fixture keeps the meta (plus the multipart
    // byte count as a size stand-in) for walker assertions.
    if (url.pathname === '/api/files' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const head = raw.subarray(0, 4096).toString('latin1');
      const nameMatch = /filename="([^"]*)"/.exec(head);
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(head);
      const meta = {
        id: `file_fixture_${++this.fileCounter}`,
        name: nameMatch?.[1] ?? 'attachment',
        media_type: typeMatch?.[1]?.trim() ?? 'application/octet-stream',
        size: raw.length,
        created_at: now(),
      };
      this.lastFileUpload = meta;
      return this.envelope(res, meta);
    }

    if (!url.pathname.startsWith('/api/')) {
      return this.envelope(res, null, 40404, `fixture: no route ${url.pathname}`);
    }
    const path = url.pathname.slice('/api'.length);
    const body = (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')
      ? await this.readBody(req)
      : undefined;
    try {
      // The unified path keeps the former advanced-session, usage, and MCP
      // management domains distinct from the flat session/runtime routes.
      const advanced = path === '/usage'
        || path === '/sessions/query'
        || path === '/mcp/servers'
        || path.startsWith('/mcp/servers/')
        || path.startsWith('/mcp/servers:');
      if (advanced) this.routeV2(res, path, url.searchParams, body, req.method);
      else this.route(res, path, url.searchParams, body, req.method);
    } catch (error) {
      console.error('[fixture] route error', path, error);
      this.envelope(res, null, 50001, String(error));
    }
  }

  /** Unified advanced-session, usage, and MCP management routes. */
  routeV2(res, path, query, body, method) {
    if (path === '/sessions/query' && method === 'GET') {
      return this.querySessionsResponse(res, query);
    }
    if (path === '/usage' && method === 'GET') {
      return this.usageV2Response(res, query);
    }
    if (path === '/mcp/servers' && method === 'GET') {
      return this.envelope(res, this.managedMcpServers());
    }
    if (path === '/mcp/servers' && method === 'POST' && body !== undefined) {
      const { name, ...config } = body;
      if (this.mcpManaged.some((entry) => entry.name === name)) {
        return this.envelope(res, null, 40001, `MCP server "${name}" already exists`);
      }
      this.mcpManaged.push({ name, config, source: 'global', origin: '/home/fixture/mcp.json', mutable: true });
      return this.envelope(res, this.managedMcpServers());
    }
    const namedMatch = /^\/mcp\/servers\/([^/:]+)$/.exec(path);
    if (namedMatch !== null && (method === 'PUT' || method === 'DELETE')) {
      const name = decodeURIComponent(namedMatch[1]);
      const index = this.mcpManaged.findIndex((entry) => entry.name === name);
      if (index === -1) {
        return this.envelope(res, null, 40408, `MCP server "${name}" was not found`);
      }
      if (!this.mcpManaged[index].mutable) {
        return this.envelope(res, null, 40001, `MCP server "${name}" is read-only`);
      }
      if (method === 'DELETE') this.mcpManaged.splice(index, 1);
      else this.mcpManaged[index] = { ...this.mcpManaged[index], config: body ?? {} };
      return this.envelope(res, this.managedMcpServers());
    }
    if (path === '/mcp/servers::test' && method === 'POST') {
      const name = body?.name ?? body?.server?.name ?? 'server';
      return this.envelope(res, { success: true, output: `fixture probe reached ${name}` });
    }
    return this.envelope(res, null, 40404, `no fixture advanced route for ${method} ${path}`);
  }

  querySessionsResponse(res, query) {
    const workspaceIds = query.getAll('workspace.id');
    const statuses = query.getAll('activity.status');
    const archived = query.get('meta.archived') ?? 'false';
    const sort = query.get('sort') ?? 'meta.updated_at_desc';
    const fields = new Set((query.get('fields') ?? '').split(',').map((value) => value.trim()).filter(Boolean));
    const projection = fields.size > 0;
    if (!['false', 'true', 'all'].includes(archived)
      || !['meta.updated_at_desc', 'meta.updated_at_asc', 'meta.created_at_desc'].includes(sort)
      || (projection && !(fields.size === 2 && fields.has('id') && fields.has('archived')))) {
      return this.envelope(res, null, 40001, 'invalid advanced session query');
    }
    let records = [...this.sessions.values()].map((session) => session.record);
    if (workspaceIds.length > 0) records = records.filter((record) => workspaceIds.includes(record.workspace_id));
    if (archived !== 'all') records = records.filter((record) => (record.archived === true ? 'true' : 'false') === archived);
    if (statuses.length > 0) records = records.filter((record) => {
      const status = record.pending_interaction === 'approval'
        ? 'approval'
        : record.pending_interaction === 'question'
          ? 'question'
          : record.busy === true
            ? 'running'
            : 'idle';
      return statuses.includes(status);
    });
    const timestamp = (value) => {
      const parsed = Date.parse(value ?? '');
      return Number.isFinite(parsed) ? parsed : 0;
    };
    records.sort((left, right) => {
      const leftTime = timestamp(sort === 'meta.created_at_desc' ? left.created_at : left.updated_at);
      const rightTime = timestamp(sort === 'meta.created_at_desc' ? right.created_at : right.updated_at);
      const order = sort === 'meta.updated_at_asc' ? leftTime - rightTime : rightTime - leftTime;
      return order || (sort === 'meta.updated_at_asc' ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id));
    });
    const pageSize = Math.max(1, Number(query.get('page_size') ?? 50) || 50);
    const pageToken = query.get('page_token');
    const pageNumber = query.get('page');
    const offset = pageToken !== null
      ? Number(pageToken)
      : pageNumber === null
        ? 0
        : (Number(pageNumber) - 1) * pageSize;
    if (!Number.isInteger(offset) || offset < 0) return this.envelope(res, null, 40922, 'page_token is invalid');
    const page = records.slice(offset, offset + pageSize);
    const workspace = (record) => {
      const item = this.workspaces.find((candidate) => candidate.id === record.workspace_id);
      return { id: record.workspace_id, cwd: item?.root ?? record.metadata?.cwd ?? null };
    };
    const items = page.map((record) => {
      if (projection) return { id: record.id, archived: record.archived === true };
      const item = {
        id: record.id,
        workspace: workspace(record),
        meta: {
          title: record.title || null,
          last_prompt: record.last_prompt ?? null,
          created_at: timestamp(record.created_at),
          updated_at: timestamp(record.updated_at),
          archived: record.archived === true,
          archived_at: record.archived_at === undefined || record.archived_at === null ? null : timestamp(record.archived_at),
        },
        activity: {
          status: record.pending_interaction === 'approval'
            ? 'approval'
            : record.pending_interaction === 'question'
              ? 'question'
              : record.busy === true
                ? 'running'
                : 'idle',
        },
      };
      if (query.get('include')?.split(',').map((value) => value.trim()).includes('git')) {
        item.git = { branch: null, pull_request: null };
      }
      return item;
    });
    const hasMore = offset + page.length < records.length;
    return this.envelope(res, {
      items,
      total: records.length,
      has_more: hasMore,
      next_page_token: hasMore ? String(offset + page.length) : null,
    });
  }

  managedMcpServers() {
    return this.mcpManaged.map((entry) => ({ ...entry, config: { ...entry.config } }));
  }

  /**
   * `GET /api/usage` — serves the scenario's prebuilt usage seed. The
   * seed carries per-granularity trends (plus an agent-dimension variant);
   * the handler echoes the requested axes, honors `range=today` with the
   * smaller summary, and paginates session items by numeric offset tokens so
   * load-more flows are exercisable. Scenarios without a seed get a 40404.
   */
  usageV2Response(res, query) {
    const seed = this.usageV2;
    if (seed === null || seed === undefined) {
      return this.envelope(res, null, 40404, 'no usage fixture for this scenario');
    }
    const granularity = query.get('granularity') ?? 'day';
    const dimension = query.get('dimension') ?? 'model';
    const range = query.get('range') ?? 'all';
    const includeArchived = query.get('include_archived') !== 'false';
    const workspace = query.get('workspace.id');
    const pageSize = Math.min(100, Math.max(1, Number(query.get('page_size') ?? 25) || 25));
    const offset = Math.max(0, Number(query.get('page_token') ?? 0) || 0);

    let items = range === 'today' ? (seed.sessionsToday ?? seed.sessions) : seed.sessions;
    if (!includeArchived) items = items.filter((item) => item.archived !== true);
    if (workspace !== null) items = items.filter((item) => item.workspace_id === workspace);
    const pageItems = items.slice(offset, offset + pageSize);
    const hasMore = offset + pageItems.length < items.length;

    const timezoneOffset = Number(query.get('timezone_offset_minutes') ?? 0) || 0;
    const dayMs = 24 * 60 * 60 * 1000;
    const todayStart = Math.floor((Date.now() + timezoneOffset * 60_000) / dayMs) * dayMs - timezoneOffset * 60_000;
    const dimensionTrend = seed.trendByDimension?.[dimension];
    const allTrend = dimensionTrend?.[granularity] ?? seed.trend[granularity] ?? seed.trend.day ?? [];
    const trend = range === 'today'
      ? allTrend.filter((bucket) => bucket.end_at > todayStart && bucket.start_at < todayStart + dayMs)
      : allTrend;

    return this.envelope(res, {
      query: {
        granularity,
        range: {
          preset: range,
          start_at: range === 'today' ? todayStart : query.get('start_at') !== null ? Number(query.get('start_at')) : null,
          end_at: range === 'today' ? todayStart + dayMs : query.get('end_at') !== null ? Number(query.get('end_at')) : null,
          defaulted_to_all_history: query.get('range') === null,
        },
        dimension,
        workspace_ids: workspace !== null ? [workspace] : [],
        include_archived: includeArchived,
        timezone_offset_minutes: Number(query.get('timezone_offset_minutes') ?? 0) || 0,
      },
      summary: range === 'today' ? seed.summaryToday : { ...seed.summary, session_count: items.length },
      trend,
      sessions: {
        items: pageItems,
        total: items.length,
        has_more: hasMore,
        next_page_token: hasMore ? String(offset + pageItems.length) : null,
      },
      reliability: seed.reliability,
    });
  }

  route(res, path, query, body, method) {
    const sessions = [...this.sessions.values()];
    // Action suffixes bind tighter than the tail: `/sessions/{id}:undo`,
    // mirroring kap-server's parseActionSuffix (session ids never contain
    // ':' or '/'); `/sessions/{id}/prompts/{pid}:abort` keeps its tail form.
    const sessionMatch = /^\/sessions\/([^/:]+)(?::([^/]+))?(\/.*)?$/.exec(path);
    const sessionId = sessionMatch?.[1];
    const action = sessionMatch?.[2];
    const tail = action !== undefined ? `:${action}` : (sessionMatch?.[3] ?? '');
    const session = sessionId !== undefined ? this.sessions.get(sessionId) : undefined;

    if (path === '/meta') {
      return this.envelope(res, {
        server_version: '0.31.1-fixture',
        capabilities: { websocket: true, file_upload: true, fs_query: true, mcp: true, tasks: true, terminal: true, transcript: true },
        server_id: 'fixture-server',
        started_at: now(),
        open_in_apps: [],
        dangerous_bypass_auth: false,
        backend: 'v2',
      });
    }
    if (path === '/config' && method === 'POST') {
      const patch = { ...(body ?? {}) };
      if (patch.request_identity === null) delete patch.request_identity;
      this.config = { ...this.config, ...patch };
      if (body?.request_identity === null) delete this.config.request_identity;
      if (patch.plugins !== undefined) {
        const url = patch.plugins.marketplace_url ?? patch.plugins.marketplaceUrl;
        this.config.plugins = typeof url === 'string' && url.trim() !== ''
          ? { marketplaceUrl: url.trim() }
          : {};
      }
      return this.envelope(res, this.config);
    }
    if (path === '/config') {
      return this.envelope(res, this.config);
    }
    // nb-search: secret-free capabilities + on-demand readiness, seeded per
    // scenario (`nbSearchCapabilities` / `nbSearchTest`). A seed shaped
    // `{ __error: 'message' }` makes the route fail so error states render.
    // Everything is static — no real search or fetch ever leaves this server.
    // A scenario that seeds `config_source` additionally follows the saved
    // `nb_search_source.reuse_local_config` toggle: off means the local file
    // and credentials read as ignored, layers lose the local tier, and
    // credentials come from the server environment alone. No files are read.
    if (path === '/nb-search/capabilities') {
      const seed = this.scenario?.data.nbSearchCapabilities ?? NB_SEARCH_EMPTY_CAPABILITIES;
      if (seed.__error !== undefined) return this.envelope(res, null, 50000, seed.__error);
      if (seed.config_source === undefined) return this.envelope(res, seed);
      const reuse = this.config?.nb_search_source?.reuse_local_config ?? true;
      if (reuse) return this.envelope(res, seed);
      return this.envelope(res, {
        ...seed,
        config_source: {
          ...seed.config_source,
          reuse_local_config: false,
          layers: seed.config_source.layers.filter((layer) => layer !== 'local'),
          local_config: 'ignored',
          local_credentials: 'ignored',
          credential_source: 'environment',
          availability: 'ready',
          issues: [],
        },
      });
    }
    if (path === '/nb-search/test') {
      const seed = this.scenario?.data.nbSearchTest ?? NB_SEARCH_EMPTY_TEST;
      if (seed.__error !== undefined) return this.envelope(res, null, 50000, seed.__error);
      return this.envelope(res, seed);
    }
    // Named agent profiles: the raw directory keeps every row and its
    // disabled flag; `effective=true` returns only the enabled same-name
    // winners for the requested workspace or cwd.
    if (path === '/agents') {
      let workspaceId;
      const requestedWorkspace = query.get('workspace_id');
      if (requestedWorkspace !== null) workspaceId = requestedWorkspace;
      const cwd = query.get('cwd');
      if (cwd !== null) {
        const normalize = (value) => String(value).replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase();
        const normalizedCwd = normalize(cwd);
        const workspace = this.workspaces.find((candidate) => {
          const root = normalize(candidate.root);
          return normalizedCwd === root || normalizedCwd.startsWith(`${root}/`);
        });
        if (workspace !== undefined) workspaceId = workspace.id;
        else {
          const sessionWorkspace = [...this.sessions.values()].find((session) => {
            const root = normalize(session.record.metadata?.cwd);
            return normalizedCwd === root || normalizedCwd.startsWith(`${root}/`);
          });
          if (sessionWorkspace !== undefined) workspaceId = sessionWorkspace.record.workspace_id;
          else if (this.workspaces.length === 0 && normalizedCwd.startsWith('c:/fixture')) workspaceId = 'wd_fixture_000000000000';
          else return this.envelope(res, null, 40410, 'workspace.not_found');
        }
      }
      const items = query.get('effective') === 'true'
        ? this.effectiveAgentProfiles(workspaceId)
        : query.get('expand') === '1'
          ? this.agentProfilesWithDisabled()
          : this.mergedAgentProfiles();
      return this.envelope(res, { items });
    }
    const agentMatch = /^\/agents\/([^/]+)$/.exec(path);
    if (agentMatch !== null && method === 'PATCH') {
      const name = decodeURIComponent(agentMatch[1]);
      const patch = body ?? {};
      const target = this.agentProfiles.find((profile) =>
        profile.name === name
        && (patch.workspace_id === undefined || profile.workspace_id === patch.workspace_id));
      if (target === undefined) return this.envelope(res, null, 40404, `fixture: no agent ${name}`);
      for (const profile of this.agentProfiles) {
        if (profile.name !== name) continue;
        if (patch.workspace_id !== undefined && profile.workspace_id !== patch.workspace_id) continue;
        for (const [key, value] of Object.entries(patch)) {
          if (key === 'scope' || key === 'workspace_id') continue;
          if (value === null || value === undefined) delete profile[key];
          else profile[key] = value;
        }
      }
      const disabled = (target.source === 'builtin'
        ? (this.config.disabled_builtin_profiles ?? [])
        : (this.config.disabled_named_profiles ?? [])).includes(target.name);
      return this.envelope(res, { routes: [], ...target, disabled });
    }
    if (path === '/models') {
      return this.envelope(res, {
        items: this.models.length > 0 || this.modelsDeclared ? this.models : [
          { id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', display_name: 'Kiki Pro', max_context_size: 262144, support_efforts: ['low', 'high'], default_effort: 'high' },
          { id: 'fixture/kiki-lite', provider_id: 'fixture', remote_id: 'kiki-lite', display_name: 'Kiki Lite', max_context_size: 131072 },
        ],
      });
    }
    const setDefaultModelMatch = /^\/models\/([^/]+):set_default$/.exec(path);
    if (setDefaultModelMatch !== null && method === 'POST') {
      const modelId = decodeURIComponent(setDefaultModelMatch[1]);
      const model = this.models.find((item) => item.id === modelId) ?? {
        id: modelId,
        provider_id: modelId.split('/')[0] ?? 'fixture',
        remote_id: modelId.slice(modelId.lastIndexOf('/') + 1),
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
      const provider = fixtureProviderFromBody(nextId, body, current.has_api_key, current.request_identity);
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
        return this.envelope(res, this.oauthOverride ?? this.scenario?.data.oauth ?? null);
      }
      if (method === 'POST') {
        const started = this.scenario?.data.oauthStart ?? {
          flow_id: nextId('oauth'),
          provider: 'fixture',
          status: 'authenticated',
        };
        this.oauthOverride = started;
        return this.envelope(res, started);
      }
      if (method === 'DELETE') {
        this.oauthOverride = { status: 'cancelled' };
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
    if (path === '/mcp/runtime/servers' && method === 'GET') {
      return this.envelope(res, {
        servers: this.scenario?.data.mcpServers ?? [],
      });
    }
    if (path === '/plugins/marketplace') {
      const source = this.config.plugins?.marketplaceUrl;
      if (typeof source !== 'string' || source.trim() === '') {
        return this.envelope(res, { configured: false, entries: [] });
      }
      return this.envelope(res, {
        configured: true,
        source,
        entries: this.scenario?.data.pluginMarketplace ?? [],
      });
    }
    if (path === '/plugins' && method === 'POST' && body !== undefined) {
      const source = String(body.source ?? '').trim();
      if (source === 'https://example.test/broken.zip') {
        return this.envelope(res, null, 40001, 'Plugin marketplace zip returned HTTP 404');
      }
      const id = source.includes('catalog-notes') ? 'catalog-notes' : 'installed-from-source';
      const plugin = {
        id,
        displayName: id,
        version: '1.0.0',
        enabled: false,
        state: 'ok',
        skillCount: 0,
        mcpServerCount: 0,
        enabledMcpServerCount: 0,
        hookCount: 0,
        commandCount: 0,
        hasErrors: false,
        source: source.startsWith('http') ? 'zip-url' : 'local-path',
        originalSource: source,
      };
      this.plugins = this.plugins.filter((entry) => entry.id !== id);
      this.plugins.push(plugin);
      return this.envelope(res, plugin);
    }
    const pluginActionMatch = /^\/plugins\/([^/]+):(enable|disable|remove)$/.exec(path);
    if (pluginActionMatch !== null && method === 'POST') {
      const pluginId = decodeURIComponent(pluginActionMatch[1]);
      const action = pluginActionMatch[2];
      const index = this.plugins.findIndex((entry) => entry.id === pluginId);
      if (index < 0) return this.envelope(res, null, 40419, 'plugin.not_found');
      if (action === 'remove') this.plugins.splice(index, 1);
      else this.plugins[index].enabled = action === 'enable';
      return this.envelope(res, { ok: true });
    }
    const pluginInfoMatch = /^\/plugins\/([^/]+)$/.exec(path);
    if (pluginInfoMatch !== null && method === 'GET') {
      const pluginId = decodeURIComponent(pluginInfoMatch[1]);
      const plugin = this.plugins.find((entry) => entry.id === pluginId)
        ?? this.scenario?.data.pluginInfos?.[pluginId];
      if (plugin === undefined) return this.envelope(res, null, 40419, 'plugin.not_found');
      const info = this.scenario?.data.pluginInfos?.[pluginId];
      return this.envelope(res, info ?? {
        ...plugin,
        root: plugin.originalSource ?? `C:/fixture/plugins/${plugin.id}`,
        installedAt: '2026-01-01T00:00:00.000Z',
        mcpServers: [],
        diagnostics: [],
      });
    }
    if (path === '/plugins') {
      return this.envelope(res, {
        plugins: this.plugins,
      });
    }
    const mcpRestartMatch = /^\/mcp\/runtime\/servers\/([^/]+):restart$/.exec(path);
    if (mcpRestartMatch !== null && method === 'POST' && body !== undefined) {
      const serverId = decodeURIComponent(mcpRestartMatch[1]);
      const server = (this.scenario?.data.mcpServers ?? []).find((entry) => entry.id === serverId);
      if (server === undefined) return this.envelope(res, null, 40408, `MCP server "${serverId}" was not found`);
      return this.envelope(res, { restarting: true });
    }
    const workspaceSkillsMatch = /^\/workspaces\/([^/]+)\/skills$/.exec(path);
    if (workspaceSkillsMatch !== null) {
      return this.envelope(res, {
        skills: this.scenario?.data.workspaceSkills?.[workspaceSkillsMatch[1]] ?? [],
      });
    }
    if (path === '/workspaces') {
      const items =
        this.workspaces.length > 0
          ? this.workspaces
          : this.scenario?.data.workspaces ?? [
              { id: 'wd_fixture_000000000000', root: 'C:/fixture', name: 'fixture', created_at: now(), last_opened_at: now(), session_count: sessions.length, pinned: false },
            ];
      return this.envelope(res, { items });
    }
    const workspaceMatch = /^\/workspaces\/([^/]+)$/.exec(path);
    if (workspaceMatch !== null && method === 'PATCH') {
      const target = this.workspaces.find((ws) => ws.id === workspaceMatch[1]);
      if (target === undefined) {
        return this.envelope(res, null, 40410, 'workspace.not_found');
      }
      if (body?.name !== undefined) target.name = String(body.name);
      if (body?.pinned !== undefined) target.pinned = body.pinned === true;
      return this.envelope(res, target);
    }
    if (workspaceMatch !== null && method === 'DELETE') {
      const index = this.workspaces.findIndex((ws) => ws.id === workspaceMatch[1]);
      if (index < 0) {
        return this.envelope(res, null, 40410, 'workspace.not_found');
      }
      this.workspaces.splice(index, 1);
      return this.envelope(res, { deleted: true });
    }
    if (path === '/workspace/fs:search' && method === 'POST') {
      return this.replyFsSearch(res, null, body);
    }
    // Raw host file bytes (transcript media thumbnails / file preview pane).
    // Like the real route: absolute path in, raw bytes + sniffed MIME out —
    // NOT envelope-wrapped. Scenario-seeded via `fsFiles`.
    if (path === '/fs:content' && method === 'GET') {
      const filePath = query.get('path') ?? '';
      const file = this.scenario?.data.fsFiles?.[filePath];
      if (file === undefined) {
        return this.envelope(res, null, 40409, 'fs.path_not_found');
      }
      const bytes =
        file.base64 !== undefined
          ? Buffer.from(file.base64, 'base64')
          : Buffer.from(file.content ?? '', 'utf8');
      res.writeHead(200, {
        'content-type': file.mime ?? 'text/plain',
        'content-length': bytes.length,
      });
      res.end(bytes);
      return;
    }
    // Host-file write mock for the preview workspace editor. The REAL
    // kap-server deliberately has no unconfined write endpoint (fs:content is
    // read-only), so the GUI writes via tauri-plugin-fs on desktop; this
    // fixture route exists so the save/conflict flows can be exercised in
    // proofs once a server endpoint lands. Body: { path, content }.
    if (path === '/fs:write' && method === 'POST' && body !== undefined) {
      const filePath = String(body.path ?? '');
      const files = this.scenario?.data.fsFiles;
      if (files === undefined || files[filePath] === undefined) {
        return this.envelope(res, null, 40409, 'fs.path_not_found');
      }
      const content = String(body.content ?? '');
      const next = { ...files[filePath], content };
      delete next.base64;
      files[filePath] = next;
      this.lastFsWrite = { path: filePath, content };
      return this.envelope(res, { written: true, path: filePath });
    }
    // Global full-text search — hits are scenario-seeded and substring-matched.
    if (path === '/search' && method === 'POST') {
      const q = String(body?.query ?? '').toLowerCase();
      this.lastSearchBody = body ?? null;
      let hits = (this.scenario?.data.searchHits ?? []).filter((hit) =>
        q === '' ||
        hit.snippet.toLowerCase().includes(q) ||
        hit.session_title.toLowerCase().includes(q));
      // Optional cursor "pagination": `SEARCH_PAGE_SIZE` controls the page, and
      // `page_token` (any non-empty string) advances to the following page.
      const pageSize = this.scenario?.data.searchPageSize ?? hits.length;
      const requestedPage = body?.page_token === undefined ? 0 : 1;
      const start = requestedPage * pageSize;
      const page = hits.slice(start, start + pageSize);
      const hasMore = hits.length > start + pageSize;
      const pageToken =
        requestedPage === 0 && hasMore ? 'page-2' : requestedPage === 1 && hasMore ? 'page-3' : undefined;
      return this.envelope(res, {
        items: page,
        has_more: hasMore,
        page_token: pageToken,
        index_state: {
          state: 'ready',
          indexed_sessions: this.sessions.size,
          total_sessions: this.sessions.size,
          documents: hits.length,
        },
        source: 'index',
      });
    }
    if (path === '/sessions' && body === undefined) {
      let items = sessions.map((s) => s.record);
      if (query.get('include_archive') !== 'true') items = items.filter((s) => s.archived !== true);
      if (query.get('archived_only') === 'true') items = items.filter((s) => s.archived === true);
      const workspaceId = query.get('workspace_id');
      if (workspaceId !== null && workspaceId !== '') {
        items = items.filter((s) => s.workspace_id === workspaceId);
      }
      items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      // Keyset pagination like the real route: before_id pages older than the
      // cursor, after_id newer; page_size bounds the wire page (default 20).
      const beforeId = query.get('before_id');
      const afterId = query.get('after_id');
      if (beforeId !== null) {
        const index = items.findIndex((s) => s.id === beforeId);
        if (index >= 0) items = items.slice(index + 1);
      } else if (afterId !== null) {
        const index = items.findIndex((s) => s.id === afterId);
        if (index >= 0) items = items.slice(0, index);
      }
      const pageSize = Math.min(Number(query.get('page_size') ?? 20), 100);
      const page = items.slice(0, pageSize);
      return this.envelope(res, { items: page, has_more: items.length > pageSize });
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
        agent_config: {
          model: body.agent_config?.model ?? '',
          ...(body.agent_config?.profile !== undefined
            ? { profile: body.agent_config.profile }
            : {}),
        },
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
      // Mirror the real `updateSessionProfile`: a metadata patch merges onto
      // the existing custom document (pin flags survive renames that omit it).
      if (body.metadata !== undefined && typeof body.metadata === 'object' && body.metadata !== null) {
        const merged = {};
        for (const [key, value] of Object.entries(session.record.metadata ?? {})) {
          if (key !== 'cwd') merged[key] = value;
        }
        Object.assign(merged, body.metadata);
        session.record.metadata = { ...merged, cwd: session.record.metadata?.cwd ?? 'C:/fixture' };
      }
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
    // Session skill catalog (slash menu) + activation. Activation starts a
    // turn with a skill_activation origin, like the real route.
    if (tail === '/skills' && body === undefined) {
      const skills = this.scenario?.data.sessionSkills?.[session.record.id]
        ?? this.scenario?.data.skills
        ?? [];
      return this.envelope(res, { skills });
    }
    const skillActivateMatch = /^\/skills\/([^/]+):activate$/.exec(tail);
    if (skillActivateMatch !== null && method === 'POST') {
      const name = decodeURIComponent(skillActivateMatch[1]);
      const skills = this.scenario?.data.sessionSkills?.[session.record.id]
        ?? this.scenario?.data.skills
        ?? [];
      const skill = skills.find((entry) => entry.name === name);
      if (skill === undefined) return this.envelope(res, null, 40415, 'skill.not_found');
      if (skill.type === 'reference') return this.envelope(res, null, 40912, 'skill.not_activatable');
      const args = typeof body?.args === 'string' ? body.args : '';
      session.lastSkillActivation = { name, args, attachments: body?.attachments ?? null };
      const custom = this.scenario?.data.onSkill;
      const steps = typeof custom === 'function'
        ? custom(name, args, session.record.id)
        : defaultSkillSteps(name, args, session.record.id);
      if (Array.isArray(steps) && steps.length > 0) {
        void this.runScript(session.record.id, bind(steps, session.record.id));
      }
      return this.envelope(res, { activated: true, skill_name: name });
    }
    if (tail === '/fs:search' && method === 'POST') {
      return this.replyFsSearch(res, session, body);
    }
    if (tail === ':fork') {
      // Message-closure extension: an expected_cursor that lags the journal
      // fails the fork (40937); through_message_id truncates the copy's
      // history right after that message (open tail — nothing runs in it).
      const forkCursor = body?.expected_cursor;
      if (
        forkCursor !== undefined &&
        (forkCursor.seq !== session.seq ||
          (forkCursor.epoch !== undefined && forkCursor.epoch !== session.epoch))
      ) {
        return this.envelope(res, null, 40937, 'session.cursor_mismatch');
      }
      let forkMessages = structuredClone(session.messages);
      if (typeof body?.through_message_id === 'string') {
        const combined = [...session.older, ...session.messages];
        const throughIndex = combined.findIndex((m) => m.id === body.through_message_id);
        if (throughIndex < 0) {
          return this.envelope(res, null, 40936, 'message.action_unavailable');
        }
        forkMessages = structuredClone(combined.slice(0, throughIndex + 1));
      }
      const id = nextId('session');
      const record = {
        ...structuredClone(session.record),
        id,
        title: typeof body?.title === 'string'
          ? body.title
          : session.record.title !== ''
            ? `${session.record.title} (fork)`
            : 'Forked session',
        created_at: now(),
        updated_at: now(),
        busy: false,
        pending_interaction: 'none',
        archived: false,
        message_count: forkMessages.length,
      };
      this.sessions.set(id, new FixtureSession(record, {
        messages: forkMessages,
      }));
      return this.envelope(res, record);
    }
    if (tail === ':undo') {
      const all = [...session.older, ...session.messages];
      let lastUserIndex = -1;
      for (let i = all.length - 1; i >= 0; i -= 1) {
        if (all[i].role === 'user') { lastUserIndex = i; break; }
      }
      if (lastUserIndex === -1) {
        return this.envelope(res, null, 40911, 'session.undo_unavailable');
      }
      const keep = all.slice(0, lastUserIndex);
      session.older = [];
      session.messages = keep;
      session.record.message_count = keep.length;
      // Mirror the real undo path (context.undo → items.remove fanout): the
      // transcript store must lose the truncated turns, then a reset pushes
      // the rebased snapshot so open views converge without waiting on the
      // client's follow-up resync.
      session.transcript.ingestFrame(
        { type: 'event.session.history_rewritten', payload: { reason: 'edit_resend', target_message_id: all[lastUserIndex].id } },
        {},
      );
      seedMessages(session.transcript, session.messages, { older: session.older, hasMore: session.hasMore });
      this.fanoutTranscriptReset(session, 'main');
      return this.envelope(res, {
        messages: { items: keep.slice(-50), has_more: keep.length > 50 },
        status: {
          busy: false,
          thinking_level: 'high',
          permission: 'manual',
          plan_mode: false,
          swarm_mode: false,
          context_tokens: 0,
          context_usage: 0,
        },
      });
    }
    if (tail === ':compact') {
      if (session.record.busy || session.activePrompt !== null || session.scriptRunning) {
        return this.envelope(res, null, 40901, 'session.busy');
      }
      if (session.messages.length + session.older.length === 0) {
        return this.envelope(res, null, 40910, 'compaction.unable');
      }
      return this.envelope(res, {});
    }
    // Raw binary (no envelope), mirroring kap-server's zip stream.
    if (tail === '/export' && method === 'POST') {
      const payload = Buffer.from(JSON.stringify({
        fixture: true,
        exported_at: now(),
        session: session.record,
        messages: session.messages,
      }, null, 2));
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="kiki-${session.record.id}-export.zip"`,
        'content-length': payload.length,
      });
      res.end(payload);
      return undefined;
    }
    if (tail === '/transcript') {
      const agentId = query.get('agent_id');
      if (agentId === null) return this.envelope(res, null, 40402, 'agent.not_found');
      const live = session.transcript.snapshot(agentId);
      const seeded = session.agentTranscripts[agentId];
      const snapshot = live.items.length > 0 || seeded === undefined ? live : {
        items: [...(seeded.items ?? [])],
        tasks: [...(seeded.tasks ?? live.tasks)],
        interactions: [...(seeded.interactions ?? live.interactions)],
        attachments: [...(seeded.attachments ?? live.attachments)],
        todos: [...(seeded.todos ?? live.todos)],
        prompts: [...(seeded.prompts ?? live.prompts)],
        meta: { ...(seeded.meta ?? live.meta) },
        hasMoreOlder: seeded.has_more === true || live.hasMoreOlder,
      };
      if (Array.isArray(snapshot.interactions) && session.resolvedInteractions.size > 0) {
        snapshot.interactions = snapshot.interactions.map((interaction) => {
          const outcome = session.resolvedInteractions.get(interaction.interactionId);
          return outcome === undefined ? interaction : { ...interaction, state: outcome };
        });
      }
      const beforeTurn = query.get('before_turn');
      const afterTurn = query.get('after_turn');
      const pageSize = Math.min(Number(query.get('page_size') ?? 20), 100);
      let items = snapshot.items;
      if (beforeTurn !== null) {
        const index = items.findIndex((item) => item.kind === 'turn' && item.turnId === beforeTurn);
        items = index >= 0 ? items.slice(0, index) : items;
      } else if (afterTurn !== null) {
        const index = items.findIndex((item) => item.kind === 'turn' && item.turnId === afterTurn);
        items = index >= 0 ? items.slice(index + 1) : items;
      }
      const turns = items.filter((item) => item.kind === 'turn');
      const windowTurns = turns.slice(-pageSize);
      const firstTurnId = windowTurns[0]?.turnId;
      const start = firstTurnId === undefined
        ? items.length
        : items.findIndex((item) => item.kind === 'turn' && item.turnId === firstTurnId);
      const page = items.slice(start);
      return this.envelope(res, {
        agent_id: agentId,
        items: page,
        has_more: start > 0,
        tasks: snapshot.tasks,
        interactions: snapshot.interactions,
        attachments: snapshot.attachments,
        todos: snapshot.todos,
        prompts: snapshot.prompts,
        meta: snapshot.meta,
        agents: [...session.transcript.agents.keys()].map((id) => ({ agentId: id, type: id === 'main' ? 'main' : 'sub' })),
        pending_interactions: snapshot.interactions.filter((i) => i.state === 'pending').map((i) => i.interactionId),
        seq: session.transcript.latestSeq(agentId),
      });
    }
    if (tail === '/transcript/ops') {
      const agentId = query.get('agent_id');
      if (agentId === null) return this.envelope(res, null, 40402, 'agent.not_found');
      const since = Number(query.get('since_seq') ?? query.get('since') ?? 0);
      const epoch = query.get('epoch');
      const catchup = session.transcript.catchup(agentId, since);
      if (epoch !== null && epoch !== '' && epoch !== catchup.epoch) {
        return this.envelope(res, { ...catchup, complete: false, batches: [] });
      }
      return this.envelope(res, catchup);
    }
    // Message-closure routes: full-replacement edit of a user message, and
    // regenerate of an assistant reply. Both truncate the journal from the
    // target onward, emit the durable history_rewritten signal, and rerun the
    // turn through the scenario's onPrompt script — the GUI then resyncs.
    const messageActionMatch = /^\/messages\/([^/]+):(edit|regenerate)$/.exec(tail);
    if (messageActionMatch !== null && method === 'POST') {
      const messageId = decodeURIComponent(messageActionMatch[1]);
      const actionName = messageActionMatch[2];
      if (session.record.busy || session.activePrompt !== null || session.scriptRunning) {
        return this.envelope(res, null, 40901, 'session.busy');
      }
      const expected = body?.expected_cursor;
      if (
        expected !== undefined &&
        (expected.seq !== session.seq ||
          (expected.epoch !== undefined && expected.epoch !== session.epoch))
      ) {
        return this.envelope(res, null, 40937, 'session.cursor_mismatch');
      }
      const combined = [...session.older, ...session.messages];
      const targetIndex = combined.findIndex((m) => m.id === messageId);
      const target = targetIndex >= 0 ? combined[targetIndex] : undefined;
      if (target === undefined) {
        return this.envelope(res, null, 40936, 'message.action_unavailable');
      }
      const truncateBefore = (count) => {
        if (count <= session.older.length) {
          session.older = session.older.slice(0, count);
          session.messages = [];
        } else {
          session.messages = session.messages.slice(0, count - session.older.length);
        }
      };
      const textOf = (content) =>
        (content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (actionName === 'edit') {
        if (target.role !== 'user' || !Array.isArray(body?.content)) {
          return this.envelope(res, null, 40936, 'message.action_unavailable');
        }
        session.lastMessageAction = { action: actionName, message_id: messageId, body };
        truncateBefore(targetIndex);
        // Mirror kap-server reconcileAfterRewrite: the rewrite rotates the
        // transcript ops epoch (the session journal epoch stays), so a client
        // holding a rewrite-hold accepts the reset below as post-rewrite truth.
        session.transcript.epoch = `ep_fixture_tx_${Date.now().toString(36)}`;
        const promptId = nextId('msg');
        const createdAt = now();
        session.messages.push({
          id: promptId,
          session_id: session.record.id,
          role: 'user',
          content: body.content,
          created_at: createdAt,
          prompt_id: promptId,
        });
        session.record.message_count = session.older.length + session.messages.length;
        this.emit(session.record.id, {
          type: 'event.session.history_rewritten',
          payload: { reason: 'edit_resend', target_message_id: messageId },
        });
        const item = {
          prompt_id: promptId,
          user_message_id: promptId,
          status: 'running',
          content: body.content,
          created_at: createdAt,
          text: textOf(body.content),
        };
        session.transcript.ingestFrame(
          { type: 'event.session.history_rewritten', payload: { reason: 'edit_resend', target_message_id: messageId } },
          { promptId, userMessageId: promptId },
        );
        seedMessages(session.transcript, session.messages, { older: session.older, hasMore: session.hasMore });
        this.startPrompt(session, item);
        this.fanoutTranscriptReset(session, 'main');
        return this.envelope(res, {
          prompt_id: promptId,
          user_message_id: promptId,
          status: 'running',
          content: body.content,
          created_at: createdAt,
        });
      }
      // regenerate
      if (target.role !== 'assistant') {
        return this.envelope(res, null, 40936, 'message.action_unavailable');
      }
      const kept = combined.slice(0, targetIndex);
      const anchor = [...kept].reverse().find((m) => m.role === 'user');
      if (anchor === undefined) {
        return this.envelope(res, null, 40936, 'message.action_unavailable');
      }
      truncateBefore(targetIndex);
      session.transcript.epoch = `ep_fixture_tx_${Date.now().toString(36)}`;
      session.record.message_count = session.older.length + session.messages.length;
      session.lastMessageAction = { action: actionName, message_id: messageId, body };
      this.emit(session.record.id, {
        type: 'event.session.history_rewritten',
        payload: { reason: 'regenerate', target_message_id: messageId },
      });
      const regenPromptId = nextId('msg');
      const regenAt = now();
      const regenItem = {
        prompt_id: regenPromptId,
        user_message_id: anchor.id,
        status: 'running',
        content: anchor.content,
        created_at: regenAt,
        text: textOf(anchor.content),
      };
      session.transcript.ingestFrame(
        { type: 'event.session.history_rewritten', payload: { reason: 'regenerate', target_message_id: messageId } },
        { promptId: regenPromptId, userMessageId: anchor.id },
      );
      seedMessages(session.transcript, session.messages, { older: session.older, hasMore: session.hasMore });
      this.startPrompt(session, regenItem);
      this.fanoutTranscriptReset(session, 'main');
      return this.envelope(res, {
        prompt_id: regenPromptId,
        user_message_id: anchor.id,
        status: 'running',
        content: anchor.content,
        created_at: regenAt,
      });
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
      // A distinct `profile` on the submission rebinds the session before the
      // prompt runs (mirrors kap-server); the record echo is the only place
      // the GUI can read the new binding back.
      if (typeof body.profile === 'string' && body.profile !== '') {
        session.record.agent_config = {
          ...session.record.agent_config,
          profile: body.profile,
          ...(typeof body.model === 'string' && body.model !== '' ? { model: body.model } : {}),
        };
        session.record.updated_at = now();
      }
      const item = { prompt_id: promptId, user_message_id: userMessageId, status: 'running', content: body.content, created_at: createdAt, text };
      // A parked turn owns the session — park behind it like the real server.
      if (session.scriptRunning || session.activePrompt !== null) {
        session.queuedPrompts.push(item);
        this.debug(`prompt "${text}" queued as ${promptId} (active=${session.activePrompt?.prompt_id ?? 'none'}, queue=${session.queuedPrompts.length})`);
        this.emitTranscriptFromFrame(session, {
          type: 'prompt.queued',
          payload: {
            type: 'prompt.queued',
            promptId,
            userMessageId,
            content: body.content,
            createdAt,
          },
        }, { promptId, userMessageId, content: body.content });
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
        const [aborted] = session.queuedPrompts.splice(queuedIndex, 1);
        this.emit(session.record.id, {
          type: 'prompt.aborted',
          payload: {
            promptId,
            userMessageId: aborted?.user_message_id ?? promptId,
            abortedAt: now(),
          },
        });
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
    const steerMatch = /^\/prompts\/([^/]+):steer$/.exec(tail);
    if (steerMatch !== null) {
      // Mirrors kap-server: the queued prompt leaves the queue and its content
      // merges into the RUNNING turn (prompt.steered); the turn keeps running
      // and the steered prompt settles with it. Without an active prompt the
      // real route answers PROMPT_NOT_FOUND (40402).
      const promptId = steerMatch[1];
      const queuedIndex = session.queuedPrompts.findIndex((item) => item.prompt_id === promptId);
      if (queuedIndex < 0 || session.activePrompt === null) {
        return this.envelope(res, null, 40402, 'prompt.not_found');
      }
      const [item] = session.queuedPrompts.splice(queuedIndex, 1);
      this.emit(session.record.id, {
        type: 'prompt.steered',
        payload: {
          activePromptId: session.activePrompt.prompt_id,
          promptIds: [promptId],
          content: item.content,
          steeredAt: now(),
        },
      });
      return this.envelope(res, { steered: true, prompt_ids: [promptId] });
    }
    const replaceMatch = /^\/prompts\/([^/]+):replace$/.exec(tail);
    if (replaceMatch !== null) {
      // Mirrors kap-server: in-place content swap for a QUEUED prompt — the row
      // keeps its queue slot (prompt.replaced) and the route answers the
      // updated PromptItem. Replacing a missing/running prompt is PROMPT_NOT_FOUND.
      const promptId = replaceMatch[1];
      const item = session.queuedPrompts.find((entry) => entry.prompt_id === promptId);
      if (item === undefined || body === undefined || !Array.isArray(body.content)) {
        return this.envelope(res, null, 40402, 'prompt.not_found');
      }
      item.content = body.content;
      item.text = body.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      this.emit(session.record.id, {
        type: 'prompt.replaced',
        payload: { promptId, content: body.content, replacedAt: now() },
      });
      return this.envelope(res, {
        prompt_id: item.prompt_id,
        user_message_id: item.user_message_id,
        status: 'queued',
        content: item.content,
        created_at: item.created_at,
      });
    }
    const moveMatch = /^\/prompts\/([^/]+):move$/.exec(tail);
    if (moveMatch !== null) {
      // Mirrors kap-server: `target_index` counts the queue AFTER the row is
      // lifted out (splice-out-then-insert); the route answers the new order
      // and prompt.moved carries it to the transcript projection.
      const promptId = moveMatch[1];
      const targetIndex = body?.target_index;
      const fromIndex = session.queuedPrompts.findIndex((entry) => entry.prompt_id === promptId);
      if (fromIndex < 0 || typeof targetIndex !== 'number') {
        return this.envelope(res, null, 40402, 'prompt.not_found');
      }
      const [item] = session.queuedPrompts.splice(fromIndex, 1);
      const clamped = Math.max(0, Math.min(Math.trunc(targetIndex), session.queuedPrompts.length));
      session.queuedPrompts.splice(clamped, 0, item);
      const queuedPromptIds = session.queuedPrompts.map((entry) => entry.prompt_id);
      this.emit(session.record.id, {
        type: 'prompt.moved',
        payload: { promptId, targetIndex: clamped, queuedPromptIds, movedAt: now() },
      });
      return this.envelope(res, {
        moved: true,
        prompt_id: promptId,
        target_index: clamped,
        queued_prompt_ids: queuedPromptIds,
      });
    }
    if (tail === '/approvals') {
      return this.envelope(res, { items: session.pendingApprovals });
    }
    const approvalMatch = /^\/approvals\/([^/]+)$/.exec(tail);
    if (approvalMatch !== null && body !== undefined) {
      const approval = session.pendingApprovals.find((a) => a.approval_id === approvalMatch[1]);
      // A second resolve (or an unknown id) reports already-resolved, exactly
      // like the real server's 40902 — never a bare not-found.
      if (approval === undefined) {
        return this.envelope(res, { resolved: false }, 40902, 'approval.already_resolved');
      }
      session.pendingApprovals = session.pendingApprovals.filter((a) => a.approval_id !== approval.approval_id);
      session.record.pending_interaction = 'none';
      session.resolvedInteractions.set(
        approval.approval_id,
        body.decision === 'approved' ? 'approved' : body.decision === 'cancelled' ? 'cancelled' : 'rejected',
      );
      this.emit(session.record.id, {
        type: 'event.approval.resolved',
        // Echo the origin agent so both the main store and the child's
        // sub-store mark their cards resolved.
        agentId: approval.agentId ?? 'main',
        payload: { approval_id: approval.approval_id, tool_call_id: approval.tool_call_id, decision: body.decision, scope: body.scope, resolved_at: now() },
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
      if (question === undefined) return this.envelope(res, { resolved: false }, 40902, 'question.already_resolved');
      session.pendingQuestions = session.pendingQuestions.filter((q) => q.question_id !== question.question_id);
      session.record.pending_interaction = 'none';
      if (questionMatch[2] === ':dismiss') {
        session.resolvedInteractions.set(question.question_id, 'dismissed');
        this.emit(session.record.id, { type: 'event.question.dismissed', agentId: question.agentId ?? 'main', payload: { question_id: question.question_id, dismissed_at: now() } });
        this.resolveWaiters(session, 'question');
        return this.envelope(res, { dismissed: true, dismissed_at: now() }, 40909, 'question.dismissed');
      }
      session.resolvedInteractions.set(question.question_id, 'answered');
      this.emit(session.record.id, { type: 'event.question.answered', agentId: question.agentId ?? 'main', payload: { question_id: question.question_id, answers: body.answers ?? {}, resolved_at: now() } });
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
    // Terminal lifecycle (kap-server's /sessions/{id}/terminals REST surface).
    if (tail === '/terminals' && body === undefined) {
      return this.envelope(res, { items: [...session.terminals.values()].map((t) => t.record) });
    }
    if (tail === '/terminals' && body !== undefined) {
      const term = new FakeTerminal(session, {
        cwd: body.cwd,
        shell: body.shell,
        cols: body.cols,
        rows: body.rows,
      });
      session.terminals.set(term.record.id, term);
      return this.envelope(res, term.record);
    }
    const terminalMatch = /^\/terminals\/([^/:]+)(?::(close))?$/.exec(tail);
    if (terminalMatch !== null) {
      const term = session.terminals.get(terminalMatch[1]);
      if (term === undefined) return this.envelope(res, null, 40414, 'terminal.not_found');
      if (terminalMatch[2] === 'close') {
        term.close(null);
        return this.envelope(res, { closed: true });
      }
      return this.envelope(res, term.record);
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
          last_skill_activation: session.lastSkillActivation,
          last_fs_search: session.lastFsSearch,
          last_message_action: session.lastMessageAction,
          message_ids: session.messages.map((m) => m.id),
          terminals: [...session.terminals.values()].map((t) => t.record),
        });
      }
      case 'state':
        return this.envelope(res, { last_search: this.lastSearchBody, last_file_upload: this.lastFileUpload, last_fs_write: this.lastFsWrite ?? null });
      case 'ws_log':
        return this.envelope(res, { inbound: this.wsInbound, outbound: this.wsOutbound });
      case 'drop_ws':
        for (const ws of this.sockets) {
          try { ws.terminate(); } catch { /* closing */ }
        }
        return this.envelope(res, { dropped: this.sockets.size });
      case 'terminal_gap': {
        const session = this.sessions.get(body.session_id);
        if (session === undefined) return this.envelope(res, null, 40401, 'session.not_found');
        const term = session.terminals.get(body.terminal_id);
        if (term === undefined) return this.envelope(res, null, 40414, 'terminal.not_found');
        for (const ws of this.sockets) {
          try { ws.terminate(); } catch { /* closing */ }
        }
        const count = Number(body.count ?? 2001);
        for (let i = 0; i < count; i += 1) {
          term.emitBuffered(`gap-output-${i + 1}\r\n`);
        }
        return this.envelope(res, {
          emitted: count,
          earliest_seq: term.buffer[0]?.seq ?? null,
          latest_seq: term.buffer.at(-1)?.seq ?? null,
        });
      }
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
        session.transcript.epoch = session.epoch;
        this.klient.resync(session);
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
      case 'skip_seq': {
        const session = this.sessions.get(body.session_id);
        if (session === undefined) return this.envelope(res, null, 40401, 'session.not_found');
        const agentId = body.agent_id ?? 'main';
        const seq = session.transcript.skipSeq(agentId, Number(body.count ?? 1));
        return this.envelope(res, { agent_id: agentId, seq });
      }
      case 'emit_transcript': {
        const session = this.sessions.get(body.session_id);
        if (session === undefined) return this.envelope(res, null, 40401, 'session.not_found');
        const agentId = body.agent_id ?? 'main';
        const batch = session.transcript.commit(agentId, body.ops ?? []);
        if (batch !== undefined) this.fanoutTranscriptOps(session, agentId, batch);
        return this.envelope(res, { agent_id: agentId, seq: batch?.seq ?? session.transcript.latestSeq(agentId) });
      }
      case 'rewrite': {
        const session = this.sessions.get(body.session_id);
        if (session === undefined) return this.envelope(res, null, 40401, 'session.not_found');
        const ids = body.ids ?? session.transcript.snapshot('main').items.map((item) => (
          item.kind === 'turn' ? item.turnId : item.kind === 'marker' ? item.markerId : item.refId
        ));
        const batch = session.transcript.commit('main', ids.length > 0 ? [{ op: 'items.remove', ids }] : []);
        if (batch !== undefined) this.fanoutTranscriptOps(session, 'main', batch);
        this.fanoutTranscriptReset(session, 'main');
        return this.envelope(res, { rewritten: ids });
      }
      default:
        return this.envelope(res, null, 40001, 'unknown control action');
    }
  }

  handleUpgrade(req, socket, head) {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    if (path !== '/api/ws' && path !== '/api/klient/events') {
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
      if (path === '/api/klient/events') this.klient.connect(ws);
      else this.onConnection(ws);
    });
  }

  onConnection(ws) {
    ws.subscriptions = new Set();
    this.sockets.add(ws);
    ws.on('close', () => {
      this.sockets.delete(ws);
      // A dead connection detaches from every terminal stream.
      for (const session of this.sessions.values()) {
        for (const term of session.terminals.values()) term.attachments.delete(ws);
      }
    });
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
      this.wsInbound.push({ type: message.type, payload: message.payload, id: message.id });
      if (this.wsInbound.length > 400) this.wsInbound.splice(0, this.wsInbound.length - 400);
      const ack = (payload) => this.sendFrame(ws, { type: 'ack', id: message.id, code: 0, msg: 'success', payload });
      switch (message.type) {
        case 'client_hello':
          ack({ accepted_subscriptions: [], resync_required: [], cursors: {} });
          break;
        case 'subscribe': {
          const ids = message.payload?.session_ids ?? [];
          const offeredCursors = message.payload?.cursors ?? {};
          const accepted = ids.filter((id) => this.sessions.has(id));
          const resyncRequired = [];
          for (const id of accepted) {
            ws.subscriptions.add(id);
            const session = this.sessions.get(id);
            // Replay like kap-server's getBufferedSince: epoch/foreign-cursor
            // mismatch and journal overflow force resync_required; otherwise
            // journaled durable frames newer than the cursor replay in order,
            // before the ack.
            const cursor = offeredCursors[id];
            if (cursor !== undefined && cursor.epoch !== undefined && cursor.epoch !== session.epoch) {
              resyncRequired.push(id);
              this.sendFrame(ws, {
                type: 'resync_required',
                timestamp: now(),
                payload: { session_id: id, reason: 'epoch_changed', current_seq: session.seq, epoch: session.epoch },
              });
            } else if (cursor !== undefined && cursor.seq > session.seq) {
              resyncRequired.push(id);
              this.sendFrame(ws, {
                type: 'resync_required',
                timestamp: now(),
                payload: { session_id: id, reason: 'epoch_changed', current_seq: session.seq, epoch: session.epoch },
              });
            } else if (cursor !== undefined && session.seq - cursor.seq > session.journal.length) {
              resyncRequired.push(id);
              this.sendFrame(ws, {
                type: 'resync_required',
                timestamp: now(),
                payload: { session_id: id, reason: 'buffer_overflow', current_seq: session.seq, epoch: session.epoch },
              });
            } else if (cursor !== undefined) {
              for (const entry of session.journal) {
                if (entry.seq > cursor.seq) this.sendFrame(ws, entry.frame);
              }
            }
          }
          const cursors = {};
          for (const id of accepted) {
            const session = this.sessions.get(id);
            cursors[id] = { seq: session.seq, epoch: session.epoch };
          }
          ack({ accepted, not_found: ids.filter((id) => !this.sessions.has(id)), resync_required: resyncRequired, cursors });
          break;
        }
        case 'unsubscribe':
          for (const id of message.payload?.session_ids ?? []) {
            ws.subscriptions.delete(id);
            ws.transcriptGrades?.delete(id);
          }
          ack({ accepted: [], not_found: [], resync_required: [], cursors: {} });
          break;
        case 'subscribe_v2': {
          const sessionId = message.payload?.session_id;
          const session = this.sessions.get(sessionId);
          if (session === undefined) {
            ack({ accepted: [], not_found: [sessionId], resync_required: [], cursors: {} });
            break;
          }
          ws.subscriptions.add(sessionId);
          this.attachTranscript(ws, session, message.payload?.transcript ?? { '*': 'turn' }, message.payload?.transcript_since);
          ack({
            accepted: [sessionId],
            not_found: [],
            resync_required: [],
            cursors: { [sessionId]: { seq: session.seq, epoch: session.epoch } },
          });
          break;
        }
        case 'unsubscribe_v2': {
          const sessionId = message.payload?.session_id;
          const agentIds = message.payload?.agent_ids;
          const spec = ws.transcriptGrades?.get(sessionId);
          if (spec === undefined) {
            ack({ accepted: sessionId === undefined ? [] : [sessionId], not_found: [], resync_required: [], cursors: {} });
            break;
          }
          if (agentIds === undefined || agentIds.length === 0) {
            ws.transcriptGrades.delete(sessionId);
          } else {
            const next = { ...spec };
            for (const agentId of agentIds) next[agentId] = 'off';
            ws.transcriptGrades.set(sessionId, next);
          }
          ack({ accepted: [sessionId], not_found: [], resync_required: [], cursors: {} });
          break;
        }
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
        // ── terminal IO channel (kap-server WS control frames) ──
        case 'terminal_attach': {
          const payload = message.payload ?? {};
          const term = this.sessions.get(payload.session_id)?.terminals.get(payload.terminal_id);
          if (term === undefined) {
            this.sendFrame(ws, { type: 'ack', id: message.id, code: 40414, msg: 'terminal.not_found', payload: {} });
            break;
          }
          term.attachments.add(ws);
          let replayed = 0;
          const sinceSeq = Number(payload.since_seq ?? 0);
          const earliestSeq = term.buffer[0]?.seq ?? null;
          for (const frame of term.buffer) {
            if (frame.seq > sinceSeq) {
              this.sendFrame(ws, frame);
              replayed += 1;
            }
          }
          // The exit frame always replays (the engine ranks it +∞), so a
          // late attacher still learns the terminal is dead.
          if (term.record.status === 'exited') this.sendFrame(ws, term.exitFrame());
          ack({
            attached: true,
            replayed,
            earliest_seq: earliestSeq,
            truncated: earliestSeq !== null && sinceSeq + 1 < earliestSeq,
          });
          break;
        }
        case 'terminal_detach': {
          const payload = message.payload ?? {};
          const term = this.sessions.get(payload.session_id)?.terminals.get(payload.terminal_id);
          if (term !== undefined) term.attachments.delete(ws);
          ack({ detached: true });
          break;
        }
        case 'terminal_input': {
          const payload = message.payload ?? {};
          const term = this.sessions.get(payload.session_id)?.terminals.get(payload.terminal_id);
          if (term !== undefined) term.write(payload.data ?? '');
          ack({ accepted: true });
          break;
        }
        case 'terminal_resize': {
          const payload = message.payload ?? {};
          const term = this.sessions.get(payload.session_id)?.terminals.get(payload.terminal_id);
          if (term !== undefined) term.resize(Number(payload.cols), Number(payload.rows));
          ack({ resized: true });
          break;
        }
        case 'terminal_close': {
          const payload = message.payload ?? {};
          const term = this.sessions.get(payload.session_id)?.terminals.get(payload.terminal_id);
          if (term === undefined) {
            this.sendFrame(ws, { type: 'ack', id: message.id, code: 40414, msg: 'terminal.not_found', payload: {} });
            break;
          }
          term.close(null);
          ack({ closed: true });
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
