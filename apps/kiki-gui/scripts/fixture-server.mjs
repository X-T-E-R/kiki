/**
 * Replay one captured usage response, echoing the query the GUI actually sent.
 *
 * The capture carries its own `query` block; the echo lets the page assert the
 * dimensions, filters and window it asked for while every number stays the one
 * the server recorded. A narrower window inside a recording is projected from
 * the buckets it covers, so a selected day or a source row's trace answers from
 * the recording. A request no recording covers is an unsupported combination
 * and is reported as such, never answered with a borrowed total or a measured
 * zero.
 */
/**
 * One recording, read through a narrower window: keep the buckets the window
 * actually covers and sum their own recorded groups.
 */
function projectUsageResponse(capture, window, query) {
  const trend = capture.trend.filter(
    (bucket) => bucket.start_at >= window.startAt && bucket.start_at < window.endAt,
  );
  const groups = trend.flatMap((bucket) => bucket.groups);
  const summary = {
    tokens: groups.reduce(
      (acc, group) => ({
        input_other: acc.input_other + group.tokens.input_other,
        output: acc.output + group.tokens.output,
        input_cache_read: acc.input_cache_read + group.tokens.input_cache_read,
        input_cache_creation: acc.input_cache_creation + group.tokens.input_cache_creation,
      }),
      { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
    ),
    cost_usd_estimated: groups.reduce((sum, group) => sum + group.cost_usd_estimated, 0),
    cost_unknown: groups.some((group) => group.cost_unknown === true),
    session_count: new Set(trend.flatMap((bucket) => bucket.drilldown.sessions.map((entry) => entry.session_id))).size,
  };
  const windowedSessions = trend.flatMap((bucket) => bucket.drilldown.sessions.map((entry) => entry.session_id));
  const recorded = capture.sessions.items.filter((item) => windowedSessions.includes(item.id));
  const pageSize = Math.min(100, Math.max(1, Number(query.get('page_size') ?? 25) || 25));
  const offset = Math.max(0, Number(query.get('page_token') ?? 0) || 0);
  const page = recorded.slice(offset, offset + pageSize);
  const hasMore = offset + page.length < recorded.length;
  return {
    query: replayUsageResponse(capture, query).query,
    summary,
    trend,
    sessions: {
      items: page,
      total: recorded.length,
      has_more: hasMore,
      next_page_token: hasMore ? String(offset + page.length) : null,
    },
    reliability: capture.reliability,
  };
}

function replayUsageResponse(capture, query) {
  const pageSize = Math.min(100, Math.max(1, Number(query.get('page_size') ?? 25) || 25));
  const offset = Math.max(0, Number(query.get('page_token') ?? 0) || 0);
  const items = capture.sessions.items;
  const page = items.slice(offset, offset + pageSize);
  const hasMore = offset + page.length < items.length;
  return {
    query: {
      granularity: query.get('granularity') ?? capture.query.granularity,
      range: {
        preset: query.get('range') ?? capture.query.range.preset,
        start_at: query.get('start_at') !== null ? Number(query.get('start_at')) : capture.query.range.start_at,
        end_at: query.get('end_at') !== null ? Number(query.get('end_at')) : capture.query.range.end_at,
        defaulted_to_all_history: query.get('range') === null && capture.query.range.preset === 'all',
      },
      dimension: query.get('dimension') ?? capture.query.dimension,
      models: query.getAll('model'),
      providers: query.getAll('provider'),
      profiles: query.getAll('profile'),
      agent_ids: query.getAll('agent.id'),
      workspace_ids: query.getAll('workspace.id'),
      include_archived: query.get('include_archived') !== 'false',
      timezone_offset_minutes: Number(query.get('timezone_offset_minutes') ?? 0) || 0,
    },
    summary: capture.summary,
    trend: capture.trend,
    sessions: {
      items: page,
      total: capture.sessions.total,
      has_more: hasMore,
      next_page_token: hasMore ? String(offset + page.length) : null,
    },
    reliability: capture.reliability,
  };
}

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
 *   { action: 'emit_event', session_id, frame }  apply + emit a session frame
 *   { action: 'rewrite', session_id, ids? }  transcript items.remove / reset
 *
 * Transcript protocol: `/meta.capabilities.transcript=true`. Scenario
 * `session_event` steps still run; the server also journals `transcript.reset`
 * / `transcript.ops` per agent and serves `subscribe_v2` / `unsubscribe_v2`
 * plus `GET .../transcript/ops` catch-up. Legacy `subscribe` is unchanged.
 *
 * Memory: `/memory/*` is served from scenario state (`memory`, `memoryEntries`,
 * `memoryJournal`). Writes mutate that state and append journal records, so the
 * page's save / delete / undo / inbox and the 40944 revision conflict are all
 * exercisable; `approval: 'review'` makes new entries land in the inbox.
 * Persona scopes key as `persona:<id>` and `workspace:<wd>/persona:<id>`.
 *
 * Bots / rooms: `/bots*` and `/rooms*` are served by fixture-bot-rooms.mjs
 * from scenario `bots` / `rooms` (see that file for the seed shape).
 *
 * Personas: `/personas*` is served by fixture-personas.mjs from scenario
 * `personas` / `personaImport` (see that file).
 *
 * Request identity: `/request-identity*` is served by fixture-request-identity.mjs
 * from scenario `requestIdentity` (see that file).
 *
 * Terminals: `/sessions/{id}/terminals*` REST plus the `terminal_*` WS control
 * frames are served by FakeTerminal, a line-oriented echo shell (`echo`, `pwd`,
 * `clear`, `exit [n]`) with PTY-style echo, a 2000-frame replay buffer, and
 * attach/detach/input/resize/close acks. A scenario can seed running PTYs via
 * a snapshot entry's `terminals: [{shell?, cwd?, cols?, rows?, banner?}]`.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocketServer } from 'ws';
import { boundScenarioEntities, FixtureKlient } from './fixture-klient.mjs';
import { sessionMediaBytes } from './fixture-media.mjs';
import { handleAppearance } from './fixture-appearance.mjs';
import { handlePersonas, resetPersonas } from './fixture-personas.mjs';
import { handleRequestIdentity, resetRequestIdentity } from './fixture-request-identity.mjs';
import { handleUsageExport, resetUsageExport } from './fixture-usage-export.mjs';
import { resetImportHistory, importedSessionMessages } from './fixture-plugin-import.mjs';
import { handleBotRooms, resetBotRooms } from './fixture-bot-rooms.mjs';
import { handleAutoCompact } from './fixture-auto-compact.mjs';
import { handleAgentHooks } from './fixture-agent-hooks.mjs';
import { handleContextStrategy, resetContextStrategy } from './fixture-context-strategy.mjs';
import { handlePlugins, marketplaceWithState, pluginSkins } from './fixture-plugins.mjs';
import { createWorktreeForSession, handleWorktrees, loadWorktrees } from './fixture-worktrees.mjs';
import { handleSsh } from './fixture-ssh.mjs';
import { antigravityCheck, antigravityLogin, handleAntigravity } from './fixture-antigravity.mjs';
import { handleGuiEntries } from './fixture-gui-entries.mjs';
import { handleSpaces, spaceConfig, spaceConfigWrite, spaceCurrentHome, spacesControl } from './fixture-spaces.mjs';
import { handleNotifications, resetNotifications, revealNotificationCredential } from './fixture-notifications.mjs';
import { browserEndpointSecret, handleBrowser } from './fixture-browser.mjs';
import { handleWebAccess, webCookiePresent } from './fixture-web-access.mjs';

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
const fixtureHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Five cron fields, the same shape the engine's parser accepts. */
const FIXTURE_CRON_PATTERN = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;
const FIXTURE_CRON_PROMPT_PREVIEW = 120;

/**
 * A cron row in kap-server's wire shape, so the fixture answers detail,
 * create and update with the same row the list route would serve. The
 * engine's own `human_schedule` is reproduced here only so the list has a
 * plausible fallback; the GUI prefers its localized reading of `cron`.
 */
function fixtureCronTask({ id, session_id: sessionId, cron, prompt, recurring, paused, workspace_id: workspaceId, delivery_mode: deliveryMode }) {
  const now = Date.now();
  return {
    id,
    session_id: sessionId,
    workspace_id: workspaceId ?? 'wd_fixture_000000000000',
    cron,
    human_schedule: fixtureHumanSchedule(cron),
    prompt,
    prompt_preview: prompt.length > FIXTURE_CRON_PROMPT_PREVIEW
      ? `${prompt.slice(0, FIXTURE_CRON_PROMPT_PREVIEW)}…(truncated)`
      : prompt,
    next_fire_at: paused === true ? null : new Date(now + 42 * 60_000).toISOString(),
    recurring,
    // kap-server always emits the effective mode, and a create without one is
    // stored as the default, exactly as the route does.
    delivery_mode: deliveryMode ?? 'idle',
    paused: paused === true,
    age_days: 3,
    stale: false,
    created_at: new Date(now - 3 * 24 * 60 * 60_000).toISOString(),
    last_fired_at: new Date(now - 18 * 60 * 60_000).toISOString(),
  };
}

function fixtureHumanSchedule(cron) {
  const [minute, hour, dom, month, dow] = String(cron).trim().split(/\s+/);
  if (minute === '0' && hour === '*') return 'every hour';
  if (hour === '*') return `every hour at minute ${minute}`;
  if (dom === '*' && dow === '*' && month === '*') return `at ${hour}:${String(minute).padStart(2, '0')} every day`;
  return cron;
}

function fixtureSearchCredentialBinding(config, instanceId) {
  const instance = config?.nb_search?.provider_instances?.[instanceId];
  const slotId = instance?.credential_slot_id;
  const slot = config?.nb_search?.credential_slots?.[slotId];
  if (slotId === undefined || slot === undefined || slot.provider_id !== instance.provider_id) return null;
  const consumers = Object.entries(config.nb_search.provider_instances)
    .filter(([, candidate]) => candidate?.credential_slot_id === slotId)
    .map(([id, candidate]) => ({ id, provider_id: candidate.provider_id, base_url: candidate.base_url ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { slotId, binding: fixtureHash({ slotId, slot, consumers }) };
}

function fixtureSearchActiveKeys(server, instanceId) {
  const target = fixtureSearchCredentialBinding(server.config, instanceId);
  const saved = target === null ? undefined : server.nbSearchCredentials.get(target.slotId);
  if (saved === undefined || saved.binding !== target.binding) return [];
  return saved.value.split(',').map((key) => key.trim()).filter((key) => key !== '');
}

function fixtureSearchCapabilities(server, seed) {
  const capabilities = structuredClone(seed);
  const config = server.config.nb_search ?? {};
  const descriptors = new Map(capabilities.providers.descriptors.map((descriptor) => [descriptor.provider_id, descriptor]));
  const inherited = capabilities.inherited_configuration;
  const instances = new Map(capabilities.providers.instances.map((instance) => [instance.id, instance]));
  for (const [id, override] of Object.entries(config.provider_instances ?? {})) {
    if (override === null) continue;
    const existing = instances.get(id);
    const providerId = override.provider_id ?? existing?.provider_id;
    if (providerId === undefined) continue;
    const descriptor = descriptors.get(providerId);
    // An absent descriptor means unknown requirements, not a keyless provider.
    const credentialRequirement = descriptor?.activation.credential ?? 'unknown';
    const endpointRequirement = descriptor?.activation.endpoint ?? 'unknown';
    const configured = fixtureSearchActiveKeys(server, id).length > 0;
    instances.set(id, {
      ...existing,
      id, provider_id: providerId, enabled: override.enabled ?? existing?.enabled ?? true,
      availability: credentialRequirement === 'none' || configured ? 'ready' : 'unavailable',
      issues: [],
      credential: { requirement: credentialRequirement, configured, slot_id: override.credential_slot_id ?? id },
      endpoint: { requirement: endpointRequirement, configured: typeof override.base_url === 'string' && override.base_url !== '' },
    });
  }
  capabilities.providers.instances = [...instances.values()];
  if (inherited !== undefined) {
    const lanes = { ...inherited.lanes };
    const presets = { ...inherited.presets };
    for (const [id, lane] of Object.entries(config.lanes ?? {})) {
      if (lane === null) delete lanes[id]; else lanes[id] = structuredClone(lane);
    }
    for (const [id, preset] of Object.entries(config.presets ?? {})) {
      if (preset === null) delete presets[id]; else presets[id] = structuredClone(preset);
    }
    const configuration = {
      lanes, presets, provider_instance_ids: [...instances.keys()],
      default_search_lane: config.defaults?.search_lane ?? inherited.default_search_lane,
      // donor replaces this array as a whole; there is no per-group overlay.
      fetch_chains: structuredClone(config.defaults?.fetch_chain ?? inherited.fetch_chains),
      file_scopes: structuredClone(config.fetch?.file_scopes ?? inherited.file_scopes),
    };
    capabilities.configuration = configuration;
    capabilities.search.default_lane = configuration.default_search_lane;
    capabilities.fetch.chains = configuration.fetch_chains;
    const searchLanes = new Map(capabilities.search.lanes.filter((lane) => lanes[lane.id] !== undefined).map((lane) => [lane.id, lane]));
    const pipelines = new Map(capabilities.fetch.pipelines.filter((pipeline) => lanes[pipeline.id] !== undefined).map((pipeline) => [pipeline.id, pipeline]));
    for (const [id, lane] of Object.entries(lanes)) {
      const instance = instances.get(lane.provider_instance_id);
      const descriptor = descriptors.get(instance?.provider_id);
      const query = descriptor?.query_operations.find((operation) => operation.operation_id === lane.operation_id);
      const fetch = descriptor?.fetch_operations.find((operation) => operation.operation_id === lane.operation_id);
      if (query !== undefined) {
        const previous = searchLanes.get(id);
        const localInstance = config.provider_instances?.[lane.provider_instance_id] != null;
        const availability = localInstance ? instance.availability : previous?.availability ?? instance?.availability ?? 'unavailable';
        searchLanes.set(id, {
          ...previous, id, output: query.output,
          execution_modes: availability === 'ready' ? previous?.execution_modes ?? ['sync', 'async'] : [],
          availability,
          issues: localInstance ? [] : previous?.issues ?? [], latency: lane.latency, cost: lane.cost,
        });
        pipelines.delete(id);
      } else if (fetch !== undefined) {
        const previous = pipelines.get(id) ?? capabilities.fetch.pipelines.find((pipeline) =>
          inherited.lanes[pipeline.id]?.operation_id === lane.operation_id
          && inherited.lanes[pipeline.id]?.provider_instance_id === lane.provider_instance_id);
        if (previous !== undefined) pipelines.set(id, { ...previous, id, latency: lane.latency, cost: lane.cost });
        searchLanes.delete(id);
      }
    }
    capabilities.search.lanes = [...searchLanes.values()];
    capabilities.fetch.pipelines = [...pipelines.values()];
    capabilities.search.presets = Object.entries(presets).map(([name, preset]) => {
      const ready = preset.lanes.every((id) => searchLanes.get(id)?.availability === 'ready');
      return { name, lanes: preset.lanes, execution_modes: ready ? ['sync', 'async'] : [], availability: ready ? 'ready' : 'unavailable', issues: [] };
    });
  }
  capabilities.revision = `config-fixture-${fixtureHash({ config, instances: capabilities.providers.instances }).slice(0, 16)}`;
  return capabilities;
}

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

/**
 * What a stored `validity` means right now, matching the store's own reading:
 * a check with no endpoint is one to re-run, a passed one is a lead, and no
 * record at all is not a claim of permanence.
 */
function memoryEntryApplicability(entry) {
  if (entry.validity === undefined) return 'unrecorded';
  const until = entry.validity.until === undefined ? undefined : Date.parse(entry.validity.until);
  return until !== undefined && !Number.isNaN(until) && until <= Date.now() ? 'expired' : 'recheck';
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

/**
 * Scenarios seed models in config shape (`provider` + `model` alias), but both
 * the `/models` REST route and the `modelResolver` RPC serve the wire shape
 * (`id` / `provider_id` / `remote_id`) and the fixture validates RPC output
 * against the production schema. Normalize at load so both paths agree.
 */
function normalizeFixtureModel(entry) {
  if (entry === null || typeof entry !== 'object') return entry;
  if (typeof entry.id === 'string' && typeof entry.provider_id === 'string') return entry;
  const alias = typeof entry.model === 'string' ? entry.model : entry.id;
  if (typeof alias !== 'string') return entry;
  const { provider, model, ...rest } = entry;
  return {
    id: alias,
    provider_id: provider ?? alias.split('/')[0] ?? 'fixture',
    remote_id: alias.slice(alias.lastIndexOf('/') + 1),
    ...rest,
  };
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
    // Bounded structures the window did not carry: the snapshot's own fields
    // (a cut title) and roster entries. Served on `/snapshot` exactly as the real
    // route does, so the remainder outlet reads real refs, not fixture-shaped
    // stand-ins.
    this.contentRefs = [...(scenarioData.content_refs ?? scenarioData.contentRefs ?? [])];
    this.agentTranscripts = scenarioData.agent_transcripts ?? {};
    // Bounded-content scenarios: which entities the fixture cuts with the
    // production `boundedEntity` when it serves this session's transcript.
    this.boundedContent = scenarioData.bounded_content ?? null;
    // key (`frame:`/`turn:`/`task:` + id) → the unbounded canonical entity the
    // segment route reads from, so a read continues what the preview showed.
    this.boundedCanonical = new Map();
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
    // Prompts whose `:steer` was accepted while a turn ran. The receipt only
    // clears the queue row; the message becomes durable context at the running
    // turn's next step boundary (see deliverPendingSteers).
    this.pendingSteers = []; // [{promptId, userMessageId, content, origin, turnId}]
    this.activeTurnId = undefined; // turn the running script currently owns
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

/**
 * A scenario module is imported once per process and cached, so every fixture
 * server in that process would otherwise share one mutable data object: a walk
 * that writes through a route (a board card's status, a created task) would
 * leak into the next job for the same scenario — even a later job of the same
 * scenario with a different locale. Hand each server its own copy instead.
 * Scripted callbacks (`onPrompt` and friends) come along by reference: they are
 * stateless frame scripts and are not cloneable.
 */
function cloneScenarioData(value) {
  if (Array.isArray(value)) return value.map(cloneScenarioData);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Map) return new Map([...value].map(([key, entry]) => [key, cloneScenarioData(entry)]));
  if (value instanceof Set) return new Set([...value].map(cloneScenarioData));
  if (value === null || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = cloneScenarioData(entry);
  return copy;
}

/** One config-wire object with snake_case keys → the camel shape the snapshot serves. */
function snakeToCamelKeys(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    out[key.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())] = entry;
  }
  return out;
}

class FixtureServer {
  constructor() {
    this.scenario = null; // { name, data }
    this.config = {};
    this.nbSearchCredentials = new Map();
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
    this.shippedAgentProfiles = []; // shipped (built-in) template status rows
    this.mcpManaged = []; // mutable /mcp/servers management catalog
    this.plugins = []; // mutable /plugins catalog
    this.recipes = []; // installed Recipe packages; mutable through recipeService
    this.recipeMarkets = [];
    this.autoCompactOverrides = new Map(); // `${sessionId}:${agentId}` → { [modelId]: tokens }
    this.oauthOverride = null; // mutable OAuth flow state (POST/DELETE /oauth/login)
    this.providerHealth = null; // persisted /providers/{id}:test results (null = scenario seed)
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
    this.scenario = { name, data: cloneScenarioData(data) };
    this.hostSkillStaleOnce = undefined;
    this.config = structuredClone(data.config ?? {
      default_model: 'fixture/kiki-pro',
      default_permission_mode: 'manual',
      providers: {},
    });
    this.nbSearchCredentials = new Map();
    for (const [slotId, value] of Object.entries(data.nbSearchManagedCredentials ?? {})) {
      const instanceId = Object.entries(this.config.nb_search?.provider_instances ?? {})
        .find(([, instance]) => instance.credential_slot_id === slotId)?.[0];
      const target = fixtureSearchCredentialBinding(this.config, instanceId);
      if (target !== null) this.nbSearchCredentials.set(slotId, { value, binding: target.binding, version: fixtureHash({ value, binding: target.binding }) });
    }
    this.recipes = structuredClone(data.recipes ?? []);
    this.recipeMarkets = structuredClone(data.recipeMarkets ?? []);
    this.providers = structuredClone(data.providers ?? []);
    this.models = structuredClone(data.models ?? []).map(normalizeFixtureModel);
    // A scenario that declares `models: []` means an unconfigured server, not
    // "unset" — without this the /models fallback below makes an empty catalog
    // unrepresentable (first-run guidance can never be exercised).
    this.modelsDeclared = Array.isArray(data.models);
    this.auth = structuredClone(data.auth ?? null);
    this.sessions.clear();
    this.localAttachments = undefined;
    this.workspaces = structuredClone(data.workspaces ?? []);
    loadWorktrees(this, data);
    this.agentProfiles = structuredClone(data.agentProfiles ?? [
      { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
    ]);
    this.shippedAgentProfiles = structuredClone(data.shippedAgentProfiles ?? []);
    this.mcpManaged = structuredClone(data.mcpManagedServers ?? []);
    this.catalogPrices = structuredClone(data.catalogPrices ?? {});
    this.priceOverrides = structuredClone(data.priceOverrides ?? {});
    this.plugins = structuredClone(data.plugins ?? []);
    this.autoCompactOverrides = new Map();
    resetContextStrategy(this);
    resetNotifications(this);
    this.autoCompactAgents = structuredClone(data.autoCompact?.agents ?? {});
    this.usageV2 = data.usageV2 ?? null;
    // `/usage-export`: the destinations panel projects this instead of holding
    // its own copy, so the add → preview → consent → read-back loop runs
    // against real route behaviour. A scenario without `usageExport` reports the
    // feature as absent, exactly like a server with the flag off.
    this.usageExport = null;
    this.usageExportEnabled = false;
    resetUsageExport(this, data);
    // `/plugin-import`: scenario `pluginImport` seeds the sources, homes, jobs
    // and archives. A scenario without it reports the feature as disabled,
    // exactly like a server whose `plugin_import` flag is off.
    resetImportHistory(this, data);
    // A native import's result is a session in this server's own store, so a
    // seeded one has to be a real session here too — otherwise `Open session`
    // would navigate to an id nothing answers for.
    for (const job of Object.values(this.importJobs ?? {})) {
      if (job.destination?.kind === 'native-session' && job.sessionId) this.addImportedSession(job);
    }
    // `/usage/realtime`: the request-governance snapshot. Rule edits through
    // `POST /config` rewrite `this.requestGovernance.rules`, so the Limits
    // panel's add / edit / toggle / delete all read back like the real server.
    this.requestGovernance = structuredClone(data.requestGovernance ?? null);
    // Memory (`/api/memory/*`): `memory` seeds the settings section and the
    // per-scope entry stores; `memoryJournal` seeds undoable operations. Writes
    // mutate this state and append journal records, so the page's save / delete
    // / undo / inbox paths are all exercisable against the real wire shapes.
    this.memory = structuredClone(data.memory ?? { enabled: true, approval: 'auto', budget: 2_000, workspaces: {} });
    this.memoryEntries = new Map(
      Object.entries(structuredClone(data.memoryEntries ?? {})).map(([scope, entries]) => [scope, entries]),
    );
    this.memoryJournal = new Map(
      Object.entries(structuredClone(data.memoryJournal ?? {})).map(([scope, records]) => [scope, records]),
    );
    this.memoryOpCounter = 0;
    resetPersonas(this, data);
    resetRequestIdentity(this, data);
    resetBotRooms(this, data);
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
    this.searchRetries = 0;
    this.searchRecovered = false;
    this.lastFileUpload = null;
    this.lastFsWrite = null;
    this.oauthOverride = null;
    this.shortcutPreferences = null;
    this.providerHealth = null;
    this.executorLogin = null;
    this.wsInbound = [];
    this.wsOutbound = [];
    console.log(`[fixture] scenario "${name}" loaded (${this.sessions.size} sessions)`);
  }

  /**
   * Create the session a native import committed. It is a real `FixtureSession`
   * carrying the turns the parser read, so the imported conversation is opened,
   * read and continued the way any other session in this store is — which is
   * exactly what the `native-session` destination promises a reader.
   */
  addImportedSession(job) {
    const sessionId = job.sessionId;
    if (this.sessions.has(sessionId)) return;
    const messages = importedSessionMessages(this, job);
    this.sessions.set(sessionId, new FixtureSession(
      bind({
        id: sessionId,
        // The workspace is a fact of this server, not something the import may
        // invent: the session's own working directory is its `cwd`, and a
        // folder that is not a registered workspace still opens — exactly as
        // a session started in an unopened folder does.
        workspace_id: [...this.sessions.values()][0]?.record.workspace_id ?? 'wd_fixture_000000000000',
        title: job.title,
        created_at: new Date(job.createdAt).toISOString(),
        updated_at: new Date(now()).toISOString(),
        busy: false,
        pending_interaction: 'none',
        archived: false,
        metadata: { cwd: job.destination.workDir },
        agent_config: { model: '' },
        usage: {
          input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
          total_cost_usd: 0, context_tokens: 0, context_limit: 262_144, turn_count: 0,
        },
        permission_rules: [],
        message_count: messages.length,
        last_seq: messages.length,
      }, sessionId),
      bind({ messages, has_more: false }, sessionId),
    ));
  }

  /** Scope key for the memory stores: `global` or `workspace:<wd>`. */
  memoryScopeKey(scope, workspaceId, personaId) {
    if (scope === 'persona') return `persona:${personaId ?? ''}`;
    if (scope === 'persona_workspace') return `workspace:${workspaceId ?? ''}/persona:${personaId ?? ''}`;
    return scope === 'global' ? 'global' : `workspace:${workspaceId ?? ''}`;
  }

  memoryList(key) {
    if (!this.memoryEntries.has(key)) this.memoryEntries.set(key, []);
    return this.memoryEntries.get(key);
  }

  memoryLog(key, record) {
    if (!this.memoryJournal.has(key)) this.memoryJournal.set(key, []);
    this.memoryJournal.get(key).push(record);
  }

  /**
   * Deterministic revision so `expected_revision` round-trips like the store.
   * Content metadata is part of what a write changes, so it moves the revision
   * too: a save that only rewrites the basis is a new version.
   */
  memoryRevision(entry) {
    return fixtureHash({
      title: entry.title, body: entry.body, type: entry.type, status: entry.status, pinned: entry.pinned,
      basis: entry.basis, validity: entry.validity, covered_by: entry.covered_by,
    });
  }

  /** The namespace a scope query names, in the shape the tools emit. */
  memoryOwnerScope(scope, workspaceId, personaId) {
    if (scope === 'persona') return { kind: 'persona', personaId };
    if (scope === 'persona_workspace') return { kind: 'persona_workspace', workspaceId, personaId };
    return scope === 'global' ? { kind: 'global' } : { kind: 'workspace', workspaceId };
  }

  /**
   * The copyable field group for an existing entry, as `MemorySearch` /
   * `MemoryRead` return it.
   */
  memoryTarget(scope, workspaceId, personaId, entry) {
    return { scope, id: entry.id, expected_revision: this.memoryRevision(entry) };
  }

  /**
   * Undo restores a journal record's before-image. A newer write to the same
   * entry since then is a real concurrent change, so it is kept and the
   * refusal is reported instead of the newer content being replaced.
   */
  memoryEntrySnapshot(entry) {
    const { body, revision: _revision, ...metadata } = entry;
    return `---\n${JSON.stringify(metadata)}\n---\n${body}\n`;
  }

  /** The entry a journal before-image restores: frontmatter plus body, or nothing. */
  memoryBeforeImage(raw) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
    if (match === null) return undefined;
    try {
      const meta = JSON.parse(match[1]);
      if (typeof meta.id !== 'string' || typeof meta.title !== 'string') return undefined;
      return { ...meta, body: match[2].replace(/\r?\n$/, '') };
    } catch { return undefined; }
  }

  memoryRestore(entry, record) {
    if (entry === undefined) return { restored: false, reason: 'not_found' };
    const current = this.memoryRevision(entry);
    if (record.afterRevision !== null && current !== record.afterRevision) {
      return { restored: false, reason: 'changed_since', entry };
    }
    return { restored: true, entry };
  }

  /**
   * `/api/memory/*` — settings, per-workspace switch, entry CRUD, journal,
   * inbox and undo. Returns true when the path was handled.
   */
  routeMemory(res, path, query, body, method) {
    if (!path.startsWith('/memory')) return false;
    const settings = () => ({ ...this.memory, effective_enabled: this.memory.enabled === true });

    if (path === '/memory/settings') {
      if (method === 'PATCH') {
        for (const field of ['enabled', 'approval', 'budget']) {
          if (body?.[field] !== undefined) this.memory[field] = body[field];
        }
      }
      this.envelope(res, settings());
      return true;
    }
    const wsMatch = /^\/memory\/workspaces\/([^/]+)\/settings$/.exec(path);
    if (wsMatch !== null) {
      const workspaceId = wsMatch[1];
      const known = (this.workspaces.length > 0 ? this.workspaces : this.scenario?.data.workspaces ?? [])
        .some((workspace) => workspace.id === workspaceId);
      if (!known) {
        this.envelope(res, null, 40410, 'workspace.not_found');
        return true;
      }
      if (method === 'PATCH') {
        this.memory.workspaces ??= {};
        if (body?.enabled === null) delete this.memory.workspaces[workspaceId];
        else this.memory.workspaces[workspaceId] = body?.enabled === true;
      }
      const override = this.memory.workspaces?.[workspaceId];
      this.envelope(res, {
        workspace_id: workspaceId,
        enabled: override === undefined ? null : override,
        effective_enabled: this.memory.enabled === true && override !== false,
      });
      return true;
    }

    const scopeMatch = /^\/memory\/(global|workspace|persona_workspace|persona)(?:\/(.+))?$/.exec(path);
    if (scopeMatch === null) return false;
    const key = this.memoryScopeKey(scopeMatch[1], query.get('workspace_id') ?? undefined, query.get('persona_id') ?? undefined);
    const tail = scopeMatch[2];
    const entries = this.memoryList(key);
    const withRevision = (entry) => ({ ...structuredClone(entry), revision: this.memoryRevision(entry) });

    if (tail === undefined && method === 'GET') {
      const search = (query.get('query') ?? '').trim().toLowerCase();
      const type = query.get('type');
      const includeInactive = query.get('include_inactive') === 'true';
      const items = entries
        .filter((entry) => includeInactive || entry.status === 'active' || entry.status === 'pending')
        .filter((entry) => type === null || entry.type === type)
        .filter((entry) => search === '' || `${entry.title} ${entry.body}`.toLowerCase().includes(search))
        .toSorted((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated.localeCompare(a.updated))
        .map(withRevision);
      const owner = this.memoryOwnerScope(scopeMatch[1], query.get('workspace_id') ?? undefined, query.get('persona_id') ?? undefined);
      const statusFilter = (query.get('statuses') ?? '').split(',').filter((value) => value !== '');
      const statuses = statusFilter.length > 0 ? statusFilter : includeInactive ? ['active', 'pending', 'superseded', 'archived'] : ['active', 'pending'];
      const pageSize = Number(query.get('page_size') ?? 20);
      const offset = Number(query.get('offset') ?? 0);
      const withOwner = items.map((entry) => ({
        ...entry,
        scope: owner,
        applicability: memoryEntryApplicability(entry),
        target: this.memoryTarget(scopeMatch[1], owner.workspaceId, owner.personaId, entry),
      }));
      const page = withOwner.slice(offset, offset + pageSize);
      this.envelope(res, {
        items: page,
        mode: query.get('query') === null ? 'list' : 'search',
        next_cursor: offset + pageSize < withOwner.length ? fixtureHash({ offset: offset + pageSize, count: withOwner.length }) : null,
        coverage: {
          scopes: [owner],
          statuses,
          exhausted: offset + pageSize >= withOwner.length,
          // A record the store could not read is counted, not hidden: a short
          // list must never read as proof that nothing else is there.
          complete: true,
          warnings: [],
        },
      });
      return true;
    }
    if (tail === 'inbox' && method === 'GET') {
      this.envelope(res, entries.filter((entry) => entry.status === 'pending').map(withRevision));
      return true;
    }
    if (tail === 'journal' && method === 'GET') {
      const id = query.get('id');
      const records = (this.memoryJournal.get(key) ?? []).filter((record) => id === null || record.id === id);
      this.envelope(res, structuredClone(records));
      return true;
    }
    if (tail === 'undo' && method === 'POST') {
      const records = (this.memoryJournal.get(key) ?? []).filter((record) => record.operationId === body?.operation_id);
      if (records.length === 0) {
        this.envelope(res, null, 40423, 'memory.not_found');
        return true;
      }
      let restored = null;
      // Newest first, and a record whose content moved on since is refused: an
      // undo must not replace a newer version with an older before-image.
      for (const record of [...records].reverse()) {
        const index = entries.findIndex((entry) => entry.id === record.id);
        if (index >= 0 && record.afterRevision !== null && this.memoryRevision(entries[index]) !== record.afterRevision) {
          this.envelope(res, { entry: null, reason: 'changed_since', revision: this.memoryRevision(entries[index]) }, 40944, 'memory.revision_conflict');
          return true;
        }
        if (record.before === null) {
          if (index >= 0) entries.splice(index, 1);
        } else {
          // A journal before-image is the stored document (JSON frontmatter
          // plus body), not a JSON blob, so it is read the way the page reads
          // a version rather than parsed as a bare object.
          const before = this.memoryBeforeImage(record.before);
          if (before === undefined) continue;
          if (index >= 0) entries[index] = before;
          else entries.push(before);
          restored ??= before;
        }
      }
      this.memoryLog(key, { operationId: `op_undo_${++this.memoryOpCounter}`, action: 'undo', id: records[0].id, at: now(), writer: 'user', before: null, beforeRevision: null, afterRevision: null });
      this.envelope(res, { entry: restored === null ? null : withRevision(restored) });
      return true;
    }

    const id = tail;
    const index = entries.findIndex((entry) => entry.id === id);
    if (method === 'GET') {
      if (index < 0) {
        this.envelope(res, null, 40423, 'memory.not_found');
        return true;
      }
      this.envelope(res, withRevision(entries[index]));
      return true;
    }
    if (method === 'PUT') {
      if (id === 'new') {
        const operationId = `op_fixture_${++this.memoryOpCounter}`;
        const entry = {
          id: `m_20260928_${String(this.memoryOpCounter).padStart(6, '0')}`,
          type: body?.type ?? 'project',
          title: body?.title ?? '',
          body: body?.body ?? '',
          status: this.memory.approval === 'review' ? 'pending' : 'active',
          pinned: body?.pinned === true,
          created: now(),
          updated: now(),
          source: { writer: 'user' },
          reason: body?.reason ?? '',
          basis: body?.basis === undefined ? undefined : structuredClone(body.basis),
          validity: body?.validity === null ? undefined : (body?.validity === undefined ? undefined : structuredClone(body.validity)),
        };
        entries.push(entry);
        this.memoryLog(key, { operationId, action: 'create', id: entry.id, at: now(), writer: 'user', before: null, beforeRevision: null, afterRevision: this.memoryRevision(entry) });
        this.envelope(res, { entry: withRevision(entry), operationId, outcome: entry.status === 'pending' ? 'pending' : 'applied' });
        return true;
      }
      if (index < 0) {
        this.envelope(res, null, 40423, 'memory.not_found');
        return true;
      }
      const current = entries[index];
      if (body?.expected_revision !== undefined && body.expected_revision !== this.memoryRevision(current)) {
        this.envelope(res, null, 40944, 'memory.revision_conflict');
        return true;
      }
      const archive = body?.action === 'archive';
      const next = {
        ...current,
        type: body?.type ?? current.type,
        title: body?.title ?? current.title,
        body: body?.body ?? current.body,
        status: archive ? 'archived' : current.status === 'pending' ? 'active' : current.status,
        pinned: body?.pinned ?? current.pinned,
        reason: body?.reason ?? current.reason,
        // Content metadata rides the same save. Omitting it preserves what is
        // held; `validity: null` clears the check on purpose.
        basis: body?.basis === undefined ? current.basis : structuredClone(body.basis),
        validity: body?.validity === null ? undefined : (body?.validity === undefined ? current.validity : structuredClone(body.validity)),
        covered_by: archive
          ? (body?.covered_by === undefined ? current.covered_by : { id: body.covered_by.id, revision: body.covered_by.expected_revision })
          : current.covered_by,
        updated: now(),
      };
      // A save whose content, state and metadata all match is not a change:
      // no new revision, no journal record, and no operation to undo.
      const unchanged = !archive
        && next.title === current.title
        && next.body === current.body
        && next.type === current.type
        && next.pinned === current.pinned
        && next.status === current.status
        && JSON.stringify(next.basis) === JSON.stringify(current.basis)
        && JSON.stringify(next.validity) === JSON.stringify(current.validity);
      if (unchanged) {
        this.envelope(res, { entry: withRevision(current), operationId: null, outcome: 'unchanged' });
        return true;
      }
      const operationId = `op_fixture_${++this.memoryOpCounter}`;
      const before = this.memoryEntrySnapshot(current);
      entries[index] = next;
      this.memoryLog(key, { operationId, action: body?.action ?? 'update', id: next.id, at: now(), writer: 'user', before, beforeRevision: this.memoryRevision(current), afterRevision: this.memoryRevision(next) });
      this.envelope(res, { entry: withRevision(next), operationId, outcome: next.status === 'pending' ? 'pending' : 'applied' });
      return true;
    }
    if (method === 'DELETE') {
      if (index < 0) {
        this.envelope(res, null, 40423, 'memory.not_found');
        return true;
      }
      const current = entries[index];
      if (query.get('expected_revision') !== this.memoryRevision(current)) {
        this.envelope(res, null, 40944, 'memory.revision_conflict');
        return true;
      }
      const operationId = `op_fixture_${++this.memoryOpCounter}`;
      this.memoryLog(key, { operationId, action: 'delete', id: current.id, at: now(), writer: 'user', before: this.memoryEntrySnapshot(current), beforeRevision: this.memoryRevision(current), afterRevision: null });
      entries.splice(index, 1);
      this.envelope(res, { operation_id: operationId });
      return true;
    }
    return false;
  }

  // /agents helpers: disabled synthesis and effective winner selection mirror
  // the server's config channels and profile source priorities. Every profile
  // source disables by name through disabled_named_profiles (the separate
  // builtin channel was removed with the legacy agent compatibility).
  /** `GET /executors` items with login status from the last check this scenario ran. */
  executorItems() {
    const items = structuredClone(this.scenario?.data.executors ?? [
      { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
    ]);
    return items.map((item) => {
      const login = item.id === 'antigravity-acp' ? antigravityLogin(this) ?? this.executorLogin?.[item.id] : this.executorLogin?.[item.id];
      return item.connection !== undefined && login !== undefined
        ? { ...item, connection: { ...item.connection, login_status: login } }
        : item;
    });
  }

  /**
   * 0.3.3 external clients. The scenario owns the state; this route applies
   * the one write the GUI can make from the settings page (create, update,
   * revoke, respond) to that state, so a screenshot walk exercises the real
   * request shape rather than a frozen list. Timestamps are epoch
   * milliseconds, as the facade reports them.
   */
  externalClientsRoute(res, path, method, body) {
    const data = this.scenario?.data.externalClients ?? {};
    const errors = data.errors ?? {};
    const failure = errors[`${method} ${path}`];
    if (failure !== undefined) return this.envelope(res, null, failure.code ?? 50000, failure.msg ?? 'Fixture failure');
    const connections = structuredClone(data.connections ?? []);
    const listener = structuredClone(data.listener ?? { enabled: false, state: 'stopped' });
    const now = Date.now();
    const rest = path.slice('/external-clients'.length) || '/';

    if (rest === '/' && method === 'GET') {
      return this.envelope(res, { connections, listener });
    }
    if (rest === '/' && method === 'POST') {
      const created = {
        id: `conn_${(data.nextConnectionNumber ?? connections.length + 1)}`,
        name: body?.name ?? 'Client',
        workspace: body?.workspace ?? '',
        mode: body?.mode ?? 'auto',
        tools: body?.tools ?? data.defaultTools ?? [],
        allowCommands: body?.allowCommands === true,
        memoryScopes: body?.memoryScopes ?? ['workspace'],
        historyScope: body?.historyScope ?? 'current',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      this.externalClientState = { connections: [...(this.externalClientState?.connections ?? connections), created], listener };
      return this.envelope(res, { connection: created, stdio: structuredClone(data.stdio ?? { command: 'kiki', args: ['mcp', '--client', created.id, '--tools'] }) });
    }
    if (rest === '/authorizations' && method === 'GET') {
      return this.envelope(res, { authorizations: structuredClone(data.authorizations ?? []) });
    }
    const authorizationMatch = /^\/authorizations\/([^/]+)\/respond$/.exec(rest);
    if (authorizationMatch !== null && method === 'POST') {
      const id = decodeURIComponent(authorizationMatch[1]);
      const pending = structuredClone(data.authorizations ?? []).filter((entry) => entry.id !== id);
      this.externalClientState = { ...(this.externalClientState ?? { connections, listener }), authorizations: pending };
      return this.envelope(res, { approved: body?.approved === true });
    }
    if (rest === '/listener' && method === 'GET') return this.envelope(res, listener);
    if (rest === '/listener' && method === 'PUT') {
      const enabled = body?.enabled === true;
      const next = {
        ...listener,
        enabled,
        state: enabled ? 'listening' : 'stopped',
        origin: enabled ? (listener.origin ?? '127.0.0.1:59412') : undefined,
        publicUrl: body?.publicUrl ?? listener.publicUrl,
        discovery: enabled ? (listener.discovery ?? 'unchecked') : 'unchecked',
      };
      this.externalClientState = { connections: this.currentExternalConnections(connections), listener: next };
      return this.envelope(res, next);
    }
    const stdioMatch = /^\/([^/]+)\/stdio$/.exec(rest);
    if (stdioMatch !== null && method === 'POST') {
      const id = decodeURIComponent(stdioMatch[1]);
      return this.envelope(res, structuredClone(data.stdio ?? { command: 'kiki', args: ['mcp', '--client', id, '--tools'] }));
    }
    const materialsMatch = /^\/sessions\/([^/]+)\/materials$/.exec(rest);
    if (materialsMatch !== null && method === 'GET') {
      const id = decodeURIComponent(materialsMatch[1]);
      const seed = (data.materials ?? {})[id];
      if (seed === undefined) {
        return this.envelope(res, {
          state: 'unloaded', sessionId: id, items: [],
          coverage: { complete: false, bytesRead: 0, recordsRead: 0, reason: 'no fixture seed' },
        });
      }
      return this.envelope(res, structuredClone(seed));
    }
    const sessionsMatch = /^\/([^/]+)\/sessions$/.exec(rest);
    if (sessionsMatch !== null && method === 'GET') {
      const id = decodeURIComponent(sessionsMatch[1]);
      return this.envelope(res, { sessions: structuredClone((data.sessions ?? {})[id] ?? []) });
    }
    const idMatch = /^\/([^/]+)$/.exec(rest);
    if (idMatch !== null) {
      const id = decodeURIComponent(idMatch[1]);
      const current = this.currentExternalConnections(connections);
      const found = current.find((entry) => entry.id === id);
      if (found === undefined) return this.envelope(res, null, 40404, 'External client connection not found');
      if (method === 'DELETE') {
        const revoked = { ...found, status: 'revoked', updatedAt: now };
        this.externalClientState = { ...(this.externalClientState ?? { listener }), connections: current.map((entry) => (entry.id === id ? revoked : entry)) };
        return this.envelope(res, { connection: revoked });
      }
      if (method === 'PATCH') {
        const updated = {
          ...found,
          ...(body?.name === undefined ? {} : { name: body.name }),
          ...(body?.workspace === undefined ? {} : { workspace: body.workspace }),
          ...(body?.mode === undefined ? {} : { mode: body.mode }),
          ...(body?.tools === undefined ? {} : { tools: body.tools }),
          ...(body?.allowCommands === undefined ? {} : { allowCommands: body.allowCommands === true }),
          ...(body?.memoryScopes === undefined ? {} : { memoryScopes: body.memoryScopes }),
          ...(body?.historyScope === undefined ? {} : { historyScope: body.historyScope }),
          // `enabled` is the pause switch: false keeps the grant, and only a
          // revoke ends it.
          ...(body?.enabled === undefined ? {} : { status: body.enabled ? 'active' : 'paused' }),
          updatedAt: now,
        };
        this.externalClientState = { ...(this.externalClientState ?? { listener }), connections: current.map((entry) => (entry.id === id ? updated : entry)) };
        return this.envelope(res, { connection: updated });
      }
    }
    return this.envelope(res, null, 40404, 'External client route not found');
  }

  /** Connections as the last write left them, so a walk can mutate and reread. */
  currentExternalConnections(fallback) {
    return this.externalClientState?.connections ?? structuredClone(fallback);
  }

  agentProfilesWithDisabled(workspaceId) {
    const disabledNamed = new Set(this.config.disabled_named_profiles ?? []);
    return this.agentProfiles
      .filter((profile) => workspaceId === undefined || profile.workspace_id === undefined || profile.workspace_id === workspaceId)
      .map((profile) => ({
        routes: [],
        ...profile,
        disabled: profile.disabled === true || disabledNamed.has(profile.name),
      }));
  }

  profilePriority(profile) {
    if (Number.isFinite(profile.priority)) return profile.priority;
    return { builtin: 0, extra: 10, user: 20, workspace: 30 }[profile.source] ?? 0;
  }

  effectiveAgentProfiles(workspaceId, unscoped = false) {
    const byName = new Map();
    for (const profile of this.agentProfilesWithDisabled(workspaceId)) {
      if (unscoped && (profile.source === 'workspace' || profile.private === true)) continue;
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
    // A step beginning is where an accepted steer becomes durable context.
    if (partial.type === 'turn.step.started') this.deliverPendingSteers(session, frame);
    // keep the session record honest for the polling sidebar
    if (partial.type === 'event.session.work_changed') {
      Object.assign(session.record, {
        busy: partial.payload.busy ?? session.record.busy,
        pending_interaction: partial.payload.pending_interaction ?? session.record.pending_interaction,
        updated_at: now(),
      });
    }
  }

  /** A side-agent frame: its own transcript only, no main-session bookkeeping. */
  emitSideFrame(session, agentId, frame, extras) {
    const stamped = { ...frame, agentId, payload: { type: frame.type, ...frame.payload, agentId, sessionId: session.record.id } };
    this.emitTranscriptFromFrame(session, stamped, extras);
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

  /**
   * Flush the steers the running turn accepted into the step boundary that just
   * opened. The engine parks an accepted steer and lets the next step's context
   * append deliver it (a managed `turn.steer` is only the header), so the
   * fixture emits the canonical `context.append_message` delivery here, as a
   * transcript fact rather than a session event.
   */
  deliverPendingSteers(session, boundary) {
    if (session.pendingSteers.length === 0) return;
    const pending = session.pendingSteers;
    session.pendingSteers = [];
    const turnId = boundary.payload?.turnId;
    const step = boundary.payload?.step ?? 1;
    const boundaryAgent = boundary.payload?.agentId ?? 'main';
    for (const steer of pending) {
      // Another agent's or another turn's boundary is not this steer's delivery point.
      if ((steer.agentId ?? 'main') !== boundaryAgent
        || (steer.turnId !== undefined && turnId !== undefined && steer.turnId !== turnId)) {
        session.pendingSteers.push(steer);
        continue;
      }
      const deliver = boundaryAgent === 'main'
        ? (frame) => this.emitTranscriptFromFrame(session, frame)
        : (frame) => this.emitSideFrame(session, boundaryAgent, frame, { promptId: steer.promptId, userMessageId: steer.userMessageId, content: steer.content });
      deliver({
        type: 'context.append_message',
        payload: {
          message: {
            id: steer.userMessageId,
            role: 'user',
            content: steer.content,
            origin: steer.origin,
          },
          delivery: {
            deliveryId: nextId('dlv'),
            messageId: steer.userMessageId,
            turnId,
            step,
            deliveredAt: now(),
            // The queue→steer path hands its step request the `queue` delivery
            // origin (promptService), which the context append then records.
            origin: 'queue',
          },
        },
      });
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
        { ...this.boundedResetSnapshot(session, grade, payload), grade },
        session.seq,
        session.epoch,
      ));
    }
  }

  /**
   * The reset snapshot a client may hold: the grade's redaction, then the
   * scenario's bounded entities — the same two steps the server applies before
   * answering, so the store and the REST page agree on refs and revisions.
   */
  boundedResetSnapshot(session, grade, payload) {
    return { ...payload, snapshot: boundScenarioEntities(session, redactSnapshotForGrade(grade, payload.snapshot)) };
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
          this.boundedResetSnapshot(session, grade, payload),
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
          this.boundedResetSnapshot(session, grade, payload),
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
    // Edit hold (mirrors the engine): the prompt being edited and everything
    // queued behind it wait; with the hold at the head, nothing promotes.
    const heldAtHead = session.editHoldPromptId !== undefined &&
      session.queuedPrompts[0]?.prompt_id === session.editHoldPromptId;
    if (session.queuedPrompts.length === 0 || heldAtHead) {
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
      case 'turn.started': {
        const agentId = frame.agentId ?? payload.agentId ?? 'main';
        if (agentId !== 'main') {
          // A native child's running turn: prompts to it park and can steer.
          (session.childTurns ??= {})[agentId] = payload.turnId;
          break;
        }
        session.record.busy = true;
        session.activeTurnId = payload.turnId;
        break;
      }
      case 'turn.ended':
        if ((frame.agentId ?? payload.agentId ?? 'main') !== 'main') {
          const agentId = frame.agentId ?? payload.agentId;
          delete session.childTurns?.[agentId];
          session.pendingSteers = session.pendingSteers.filter((steer) => steer.agentId !== agentId);
        }
        if ((frame.agentId ?? payload.agentId ?? 'main') === 'main') {
          session.record.busy = false;
          session.record.pending_interaction = 'none';
          // A turn that ends before its next step never accepts its steers: the
          // engine drops unlaunched steer requests, so a stale prompt must not
          // land in an unrelated later turn.
          session.pendingSteers = session.pendingSteers.filter((steer) => (steer.agentId ?? 'main') !== 'main');
          session.activeTurnId = undefined;
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
  envelope(res, data, code = 0, msg = 'success', details) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code, msg, data, request_id: nextId('req'), ...(details === undefined ? {} : { details }) }));
  }

  /**
   * An envelope with the HTTP status the real route would use. A failure that
   * arrives as a 200 is a success to every client, so a fixture that answers a
   * missing or forbidden file this way leaves the product's own error handling
   * untestable: kap-server sends 404 for a missing path and 403 for a denied
   * one, and the client only raises on a non-OK status.
   */
  failureEnvelope(res, status, code, msg, details) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code, msg, data: null, request_id: nextId('req'), ...(details === undefined ? {} : { details }) }));
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
    // The browser's own three routes are reached with a session cookie and no
    // bearer credential — they are how a browser *acquires* one. The real
    // service exempts exactly these; a blanket gate here would make the
    // one-time exchange untestable and would misstate the contract.
    const webSessionPath = new Set(['/api/web-access/session', '/api/web-access/exchange', '/api/web-access/logout']);
    if (auth !== `Bearer ${FIXTURE_TOKEN}` && !webSessionPath.has(url.pathname) && !webCookiePresent(req)) {
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
    if (handleAppearance(this, req, res, path)) return;
    if (await handlePersonas(this, req, res, path, url.searchParams)) return;
    if (await handleRequestIdentity(this, req, res, path)) return;
    if (await handleBotRooms(this, req, res, path, url.searchParams)) return;
    const body = (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')
      ? await this.readBody(req)
      : undefined;
    try {
      // The unified path keeps the former advanced-session, usage, and MCP
      // management domains distinct from the flat session/runtime routes.
      if (handleUsageExport(this, res, path, req.method, body)) return;
      const advanced = path === '/usage'
        || path === '/usage/pricing'
        || path === '/usage/realtime'
        || path === '/usage/rescan'
        || path === '/sessions/query'
        || path === '/mcp/servers'
        || path.startsWith('/mcp/servers/')
        || path.startsWith('/mcp/servers:');
      if (advanced) this.routeV2(res, path, url.searchParams, body, req.method);
      else this.route(res, path, url.searchParams, body, req.method, req);
    } catch (error) {
      console.error('[fixture] route error', path, error);
      this.envelope(res, null, 50001, String(error));
    }
  }

  /**
   * `GET/PUT /api/usage/pricing` in the production shape: one row per
   * configured model, override and requested model; overrides win, catalog
   * prices come from the scenario's `catalogPrices` (source `litellm-cache`).
   */
  usagePricingResponse(requested = []) {
    const keys = new Set([...requested, ...this.models.map((model) => model.id), ...Object.keys(this.priceOverrides)]);
    const items = [...keys].toSorted().map((model) => {
      const configured = this.models.find((entry) => entry.id === model);
      const override = this.priceOverrides[model];
      const catalogKey = configured?.pricing_model ?? configured?.remote_id ?? model;
      const catalog = this.catalogPrices[catalogKey];
      const identity = { model, pricing_model: configured?.pricing_model ?? null };
      if (override !== undefined) return { ...identity, matched_key: model, source: 'override', prices: override };
      if (catalog !== undefined) return { ...identity, matched_key: catalogKey, source: 'litellm-cache', prices: { currency: 'USD', ...catalog } };
      return { ...identity, matched_key: null, source: 'unknown', prices: null };
    });
    return { items, overrides: structuredClone(this.priceOverrides) };
  }

  /** Unified advanced-session, usage, and MCP management routes. */
  routeV2(res, path, query, body, method) {
    if (path === '/sessions/query' && method === 'GET') {
      return this.querySessionsResponse(res, query);
    }
    if (path === '/usage' && method === 'GET') {
      return this.usageV2Response(res, query);
    }
    if (path === '/usage/realtime' && method === 'GET') {
      if (this.requestGovernance === null) {
        return this.envelope(res, null, 40404, 'no request governance fixture for this scenario');
      }
      return this.envelope(res, { ...structuredClone(this.requestGovernance), asOf: new Date().toISOString() });
    }
    if (path === '/usage/pricing' && method === 'GET') {
      return this.envelope(res, this.usagePricingResponse(query.getAll('model')));
    }
    if (path === '/usage/rescan' && method === 'GET') {
      // The usage page polls this for the "Rescan all" affordance. Without the
      // route the request 404s and the page shows its red "Progress
      // unavailable. Reconnecting…" alert on every capture. Idle is the real
      // resting state of UsageAggregationService.rescan, so the frame shows a
      // page that is not mid-rescan rather than one that cannot ask.
      if (this.usageV2 === null) {
        return this.envelope(res, null, 40404, 'no usage fixture for this scenario');
      }
      return this.envelope(res, {
        state: 'idle', scanned_sessions: 0, total_sessions: 0, scanned_records: 0,
        started_at: null, finished_at: null, error: null,
      });
    }
    if (path === '/usage/rescan' && method === 'POST') {
      if (this.usageV2 === null) {
        return this.envelope(res, null, 40404, 'no usage fixture for this scenario');
      }
      return this.envelope(res, {
        state: 'completed', scanned_sessions: 12, total_sessions: 12, scanned_records: 418,
        started_at: this.scenario?.data.startedAt ?? null, finished_at: null, error: null,
      });
    }
    if (path === '/usage/pricing' && method === 'PUT' && body !== undefined) {
      for (const [model, price] of Object.entries(body.overrides ?? {})) {
        if (price === null) delete this.priceOverrides[model];
        else this.priceOverrides[model] = price;
      }
      return this.envelope(res, this.usagePricingResponse(Object.keys(body.overrides ?? {})));
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
    // A captured-response scenario answers from the record itself, so the
    // window, the bars and the amounts on screen are the server's own answer
    // for exactly those conditions rather than a hand-laid-out stand-in.
    if (typeof seed.matchCapture === 'function') {
      const matched = seed.matchCapture(query);
      // No recording covers these conditions. Answering with a complete empty
      // response would claim the period measured nothing, which is a different
      // statement from "this combination was never recorded" — and it would
      // make a comparison read as a real zero. The unsupported combination is
      // reported instead, so the page keeps the current period and shows the
      // prior one as unavailable with a retry.
      if (matched === null) {
        return this.envelope(res, null, 40404, 'no recorded usage response for these conditions');
      }
      // A narrower window inside a recording is projected from it: only the
      // buckets inside the request, with their own real groups.
      if (matched.capture !== undefined) {
        return this.envelope(res, projectUsageResponse(matched.capture, matched.window, query));
      }
      return this.envelope(res, replayUsageResponse(matched, query));
    }
    const granularity = query.get('granularity') ?? 'day';
    const dimension = query.get('dimension') ?? 'model';
    const range = query.get('range') ?? 'all';
    const includeArchived = query.get('include_archived') !== 'false';
    const workspace = query.get('workspace.id');
    const modelFilter = query.getAll('model');
    const providerFilter = query.getAll('provider');
    const profileFilter = query.getAll('profile');
    const pageSize = Math.min(100, Math.max(1, Number(query.get('page_size') ?? 25) || 25));
    const offset = Math.max(0, Number(query.get('page_token') ?? 0) || 0);

    const timezoneOffset = Number(query.get('timezone_offset_minutes') ?? 0) || 0;
    const dayMs = 24 * 60 * 60 * 1000;
    const todayStart = Math.floor((Date.now() + timezoneOffset * 60_000) / dayMs) * dayMs - timezoneOffset * 60_000;

    // One filter set (summary, trend and sessions) narrows every part of the
    // response, the way the record-level server does.
    let items = range === 'today' ? (seed.sessionsToday ?? seed.sessions) : seed.sessions;
    if (!includeArchived) items = items.filter((item) => item.archived !== true);
    if (workspace !== null) items = items.filter((item) => item.workspace_id === workspace);
    if (modelFilter.length > 0) items = items.filter((item) => modelFilter.includes(item.primary_model ?? ''));
    if (providerFilter.length > 0) items = items.filter((item) => providerFilter.includes(seed.providerByModel?.[item.primary_model ?? ''] ?? ''));
    if (profileFilter.length > 0) items = items.filter((item) => item.profile_names?.some((name) => profileFilter.includes(name)));
    const pageItems = items.slice(offset, offset + pageSize);
    const hasMore = offset + pageItems.length < items.length;

    const dimensionTrend = seed.trendByDimension?.[dimension];
    const startAtParam = query.get('start_at') !== null ? Number(query.get('start_at')) : null;
    // An explicit window that ends before the seeded range asks for the prior
    // period; the scenario seeds that span so a comparison has real numbers.
    const wantsPrior = startAtParam !== null && startAtParam < firstSeedStart();
    const priorTrend = wantsPrior ? seed.trendByDimension?.[`prior${dimension === 'provider' || dimension === 'profile' ? dimension : ''}${dimension === 'provider' || dimension === 'profile' ? '' : capitalize(granularity)}`] : undefined;
    const priorGranularity = seed.trendByDimension?.[`prior${capitalize(granularity)}`]?.[granularity];
    let allTrend = wantsPrior
      ? (priorTrend?.[granularity] ?? priorGranularity ?? [])
      : dimensionTrend?.[granularity] ?? seed.trend[granularity] ?? seed.trend.day ?? [];

    function capitalize(value) {
      return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
    }
    function firstSeedStart() {
      const seeded = seed.trend[granularity] ?? seed.trend.day ?? [];
      return seeded.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...seeded.map((bucket) => bucket.start_at));
    }
    if (modelFilter.length > 0) {
      allTrend = allTrend.map((bucket) => ({
        ...bucket,
        groups: bucket.groups.filter((entry) => modelFilter.includes(entry.model_alias ?? '')),
      }));
    }
    if (providerFilter.length > 0) {
      allTrend = allTrend.map((bucket) => ({
        ...bucket,
        groups: bucket.groups.filter((entry) => providerFilter.includes(entry.provider ?? '')),
      }));
    }
    if (profileFilter.length > 0) {
      allTrend = allTrend.map((bucket) => ({
        ...bucket,
        groups: bucket.groups.filter((entry) => profileFilter.includes(entry.profile_name ?? '')),
      }));
    }
    // An explicit window narrows the buckets the way a record-level server
    // would, so a prior-period read returns that period and not the whole range.
    const startAt = query.get('start_at') !== null ? Number(query.get('start_at')) : null;
    const endAt = query.get('end_at') !== null ? Number(query.get('end_at')) : null;
    let trend = range === 'today'
      ? allTrend.filter((bucket) => bucket.end_at > todayStart && bucket.start_at < todayStart + dayMs)
      : allTrend;
    if (startAt !== null && endAt !== null) {
      trend = allTrend.filter((bucket) => bucket.start_at >= startAt && bucket.start_at < endAt);
    }

    return this.envelope(res, {
      query: {
        granularity,
        range: {
          preset: range,
          start_at: range === 'today' ? todayStart : startAt,
          end_at: range === 'today' ? todayStart + dayMs : endAt,
          defaulted_to_all_history: query.get('range') === null,
        },
        dimension,
        models: modelFilter,
        providers: providerFilter,
        profiles: profileFilter,
        agent_ids: query.getAll('agent.id'),
        workspace_ids: workspace !== null ? [workspace] : [],
        include_archived: includeArchived,
        timezone_offset_minutes: Number(query.get('timezone_offset_minutes') ?? 0) || 0,
      },
      summary: range === 'today'
        ? seed.summaryToday
        : { ...seed.summary, session_count: items.length },
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

  route(res, path, query, body, method, req) {
    // Native SSH surface (scripts/fixture-ssh.mjs) — ahead of the session tail routes.
    if ((path.startsWith('/ssh/') || /^\/sessions\/[^/:]+\/ssh\//.test(path)) && handleSsh(this, res, path, query, method, body)) return;
    // Browser connections (scripts/fixture-browser.mjs) — the browser REST domain.
    if (path.startsWith('/browser/') && handleBrowser(this, res, path, query, method, body)) return;
    // Web access (scripts/fixture-web-access.mjs) — the browser entry point surface.
    if (handleWebAccess(this, res, path, method, body, req)) return;
    // Antigravity ACP binary cache + sign-in (scripts/fixture-antigravity.mjs).
    if (path.startsWith('/executors/antigravity-acp/') && handleAntigravity(this, res, path, method, body)) return;
    // Spaces (scripts/fixture-spaces.mjs): homes.json management and per-key config origins.
    if ((path.startsWith('/homes') || path === '/config/overrides:remove') && handleSpaces(this, res, path, method, body)) return;
    // GUI entry contracts (scripts/fixture-gui-entries.mjs): shortcuts, models.dev directory, account quota.
    if (handleGuiEntries(this, res, path, query, body, method)) return;
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
        // The space whose backend this `/api` is, as the desktop project would
        // report it: the main backend answers `main`, a space answers its own id.
        current_space_id: spaceCurrentHome(this),
        started_at: now(),
        open_in_apps: [],
        dangerous_bypass_auth: false,
        backend: 'v2',
        experimental_flags: {
          auto_session_title: true,
          'tool-select': false,
          task_wait: true,
          search_worker: true,
          local_session_resume: true,
          // The import routes only exist when the flag is on.
          plugin_import: this.importEnabled === true,
          // Scenario-specific flags (e.g. native_ssh) layer on top.
          ...(this.scenario?.data.experimentalFlags ?? {}),
        },
      });
    }
    if (path === '/config' && method === 'POST' && spaceConfigWrite(this, body)) {
      return this.envelope(res, spaceConfig(this));
    }
    if (path === '/config' && method === 'POST') {
      const patch = { ...(body ?? {}) };
      if (patch.request_identity === null) delete patch.request_identity;
      // request_governance rules are the Limits panel's whole-list write; the
      // realtime snapshot reflects them on the next poll, like the live
      // config-section re-read on the real server.
      if (patch.request_governance !== undefined && this.requestGovernance !== null) {
        this.requestGovernance.rules = (patch.request_governance.rules ?? []).map((rule) => ({
          resource: 'model_request', scope: 'global', subagentsOnly: false, overflow: 'queue', enabled: true,
          ...snakeToCamelKeys(rule),
        }));
      }
      delete patch.request_governance;
      // subagent keys arrive snake_cased and merge field-wise (the real server
      // converts and echoes the resolved section); keep them out of the
      // wholesale spread below.
      const subagentPatch = patch.subagent;
      delete patch.subagent;
      // The interaction section arrives snake_cased and merges field-wise: its
      // two decisions (whether a waiting question blocks, and the question
      // frequency guard) are independent, and the guard's own keys are
      // converted on the way in, the way the real server's response schema
      // serves them.
      const interactionPatch = patch.interaction;
      delete patch.interaction;
      // `session_title` merges the same way on the real route: one field per
      // write, `null` clears that field, and the two metadata fields are
      // derived on every response rather than stored.
      const sessionTitlePatch = patch.session_title;
      delete patch.session_title;
      // replace_domains is an instruction, not config; a replaced domain is
      // already the whole value the spread below stores.
      delete patch.replace_domains;
      // `[agent_executor_overrides]` merges per engine on the real server, so a
      // patch that sets one engine's field must not erase another's entries —
      // nor another field of the same engine. The section is a free-form record
      // on the wire, so it is stored exactly as it arrives.
      const executorPatch = patch.agent_executor_overrides;
      delete patch.agent_executor_overrides;
      this.config = { ...this.config, ...patch };
      if (executorPatch !== null && typeof executorPatch === 'object' && !Array.isArray(executorPatch)) {
        const previous = this.config.agent_executor_overrides;
        const merged = {
          ...(typeof previous === 'object' && previous !== null && !Array.isArray(previous) ? previous : {}),
        };
        for (const [id, entry] of Object.entries(executorPatch)) {
          const base = merged[id];
          merged[id] = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
            ? {
              ...(typeof base === 'object' && base !== null && !Array.isArray(base) ? base : {}),
              ...entry,
            }
            : entry;
        }
        this.config.agent_executor_overrides = merged;
      }
      // `[agent_executor_display]` is its own section, not a key in the
      // overrides map. `null` clears the stored value, which the server resolves
      // back to the default (`externals_visible: true`) — so a cleared switch
      // reads as absent rather than as a stored `false`.
      const displayPatch = patch.agent_executor_display;
      delete patch.agent_executor_display;
      if (displayPatch !== null && typeof displayPatch === 'object' && !Array.isArray(displayPatch)) {
        const previous = this.config.agent_executor_display;
        const base = typeof previous === 'object' && previous !== null && !Array.isArray(previous) ? previous : {};
        const merged = { ...base };
        for (const [key, value] of Object.entries(displayPatch)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        this.config.agent_executor_display = merged;
      }
      if (body?.request_identity === null) delete this.config.request_identity;
      if (patch.plugins !== undefined) {
        const url = patch.plugins.marketplace_url ?? patch.plugins.marketplaceUrl;
        this.config.plugins = typeof url === 'string' && url.trim() !== ''
          ? { marketplaceUrl: url.trim() }
          : {};
      }
      if (subagentPatch !== undefined) {
        const subagent = { ...(this.config.subagent ?? {}) };
        for (const [key, value] of Object.entries(subagentPatch)) {
          const camel = key.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
          if (value === null || value === undefined) delete subagent[camel];
          else subagent[camel] = value;
        }
        this.config.subagent = subagent;
      }
      if (interactionPatch !== undefined) {
        const interaction = { ...(this.config.interaction ?? {}) };
        for (const [key, value] of Object.entries(interactionPatch)) {
          const camel = key.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
          // The guard is one level deeper, and its own keys are snake_cased
          // on the wire too.
          if (value === null || value === undefined) delete interaction[camel];
          else if (camel === 'askUserQuestionGuard' && typeof value === 'object') {
            const guard = { ...(interaction[camel] ?? {}) };
            for (const [inner, innerValue] of Object.entries(value)) {
              const innerCamel = inner.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
              if (innerValue === null || innerValue === undefined) delete guard[innerCamel];
              else guard[innerCamel] = innerValue;
            }
            interaction[camel] = guard;
          } else interaction[camel] = value;
        }
        this.config.interaction = interaction;
      }
      if (sessionTitlePatch !== undefined) {
        const title = { ...(this.config.session_title ?? {}) };
        for (const [key, value] of Object.entries(sessionTitlePatch)) {
          if (value === null || value === undefined) delete title[key];
          else title[key] = value;
        }
        this.config.session_title = title;
      }
      // The built-in body and the source are answered facts, never stored
      // config: what is in force follows from whether an override is there.
      if (this.config.session_title !== undefined) {
        const title = this.config.session_title;
        title.default_prompt = title.default_prompt
          ?? 'You name conversations. Answer with the title only: one line, at most 8 words, no quotes, no trailing punctuation, in the language of the conversation.';
        title.prompt_source = typeof title.prompt === 'string' && title.prompt !== '' ? 'custom' : 'default';
      }
      return this.envelope(res, this.config);
    }
    if (path === '/config') {
      return this.envelope(res, spaceConfig(this));
    }
    // Scheduled tasks (the GlobalCronPanel's aggregate surface). Scenario-seeded
    // via `cronTasks`; the wire shape is kap-server's `GET /api/cron` row, the
    // ordering is its `compareCronTasks` (soonest fire first, paused plans
    // last), and `session_id` narrows before paging exactly as the real route
    // does — a page is a page of that conversation's own tasks. Row actions
    // mutate the seeded list so Pause/Resume/Run/Delete are exercisable without
    // a second mock surface.
    if (path === '/cron' && method === 'GET') {
      const sessionId = query.get('session_id');
      const scoped = [...(this.scenario?.data.cronTasks ?? [])]
        .filter((task) => sessionId === null || task.session_id === sessionId);
      scoped.sort((left, right) => {
        if (left.next_fire_at === null && right.next_fire_at !== null) return 1;
        if (left.next_fire_at !== null && right.next_fire_at === null) return -1;
        const byNext = left.next_fire_at === null || right.next_fire_at === null
          ? 0
          : left.next_fire_at.localeCompare(right.next_fire_at);
        return byNext !== 0 ? byNext : right.created_at.localeCompare(left.created_at);
      });
      const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0);
      const pageSize = Math.max(1, Number(query.get('page_size') ?? 100) || 100);
      const hasMore = scoped.length > offset + pageSize;
      return this.envelope(res, {
        items: scoped.slice(offset, offset + pageSize).map((task) => structuredClone(task)),
        has_more: hasMore,
        next_offset: hasMore ? offset + pageSize : undefined,
      });
    }
    // Create: the same request/response shape as kap-server's `POST /cron`.
    // `cronFailures` lets a scenario make the next write fail so the panel's
    // real-failure path is exercisable against a mock, not a guess.
    if (path === '/cron' && method === 'POST') {
      const rows = this.scenario?.data.cronTasks;
      if (rows === undefined || typeof body?.cron !== 'string' || body.cron.trim() === '') {
        return this.envelope(res, null, 40001, 'cron expression is invalid');
      }
      if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
        return this.envelope(res, null, 40001, 'prompt must not be blank');
      }
      if (this.consumeScenarioFlag('cronFailNextWrite')) {
        return this.envelope(res, null, 40001, 'cron tasks can only be rebound within the same workspace');
      }
      const id = `cron_fixture_created_${rows.length + 1}`;
      rows.push(fixtureCronTask({
        id,
        session_id: body.session_id,
        cron: body.cron,
        prompt: body.prompt,
        recurring: body.recurring !== false,
        paused: body.paused === true,
        delivery_mode: body.delivery_mode,
      }));
      const created = rows[rows.length - 1];
      return this.envelope(res, { task: structuredClone(created) });
    }
    const cronTaskMatch = /^\/cron\/([^/:]+)(?::([a-z]+))?$/.exec(path);
    if (cronTaskMatch !== null) {
      const rows = this.scenario?.data.cronTasks;
      const task = (rows ?? []).find((entry) => entry.id === cronTaskMatch[1]);
      if (task === undefined) return this.envelope(res, null, 40406, 'task.not_found');
      const action = cronTaskMatch[2];
      // Detail: the list row's preview plus the prompt in full.
      if (action === undefined && method === 'GET') {
        return this.envelope(res, { task: structuredClone(task) });
      }
      // Edit: `session_id` in the body is the target binding, and a target in
      // another workspace is refused exactly as the real route refuses it.
      if (action === undefined && method === 'PATCH') {
        if (this.consumeScenarioFlag('cronFailNextWrite')) {
          return this.envelope(res, null, 40001, 'cron tasks can only be rebound within the same workspace');
        }
        if (typeof body.cron === 'string' && !FIXTURE_CRON_PATTERN.test(body.cron.trim())) {
          return this.envelope(res, null, 40001, 'cron expression is invalid');
        }
        if (body.session_id !== undefined) {
          const target = (this.scenario?.data.sessions ?? []).find((entry) => entry.id === body.session_id);
          if (target === undefined) return this.envelope(res, null, 40408, 'target session does not exist');
          if (target.workspace_id !== undefined && task.workspace_id !== undefined
            && target.workspace_id !== task.workspace_id) {
            return this.envelope(res, null, 40001, 'cron tasks can only be rebound within the same workspace');
          }
          task.session_id = body.session_id;
        }
        if (typeof body.cron === 'string') {
          task.cron = body.cron;
          task.human_schedule = fixtureHumanSchedule(body.cron);
        }
        if (typeof body.prompt === 'string') {
          task.prompt = body.prompt;
          task.prompt_preview = body.prompt.length > 120 ? `${body.prompt.slice(0, 120)}…(truncated)` : body.prompt;
        }
        if (typeof body.recurring === 'boolean') task.recurring = body.recurring;
        // Absent means "keep what the task has", the same as the real route's
        // `deliveryMode: delivery_mode ?? current.deliveryMode`.
        if (['queue', 'steer', 'idle'].includes(body.delivery_mode)) task.delivery_mode = body.delivery_mode;
        return this.envelope(res, { task: structuredClone(task) });
      }
      if (action === 'pause') {
        task.paused = true;
        task.next_fire_at = null;
        return this.envelope(res, { task: structuredClone(task) });
      }
      if (action === 'resume') {
        task.paused = false;
        task.next_fire_at = new Date(Date.now() + 5 * 60_000).toISOString();
        return this.envelope(res, { task: structuredClone(task) });
      }
      if (action === 'run') {
        return this.envelope(res, { triggered: true });
      }
      if (action === undefined && method === 'DELETE' && rows !== undefined) {
        rows.splice(rows.indexOf(task), 1);
        return this.envelope(res, { deleted: true });
      }
    }
    const memoryHandled = this.routeMemory(res, path, query, body, method);
    if (memoryHandled) return undefined;
    // nb-IM notifications (scripts/fixture-notifications.mjs).
    if (handleNotifications(this, res, path, query, method, body)) return undefined;
    if (path === '/secrets:reveal' && method === 'POST' && body?.ref?.kind === 'browser_endpoint') {
      const value = browserEndpointSecret(this, body.ref.browser_id);
      return this.envelope(res, value === undefined ? { source: 'none' } : { source: 'kiki', value });
    }
    if (path === '/secrets:reveal' && method === 'POST' && body?.ref?.kind === 'notification_credential') {
      const value = revealNotificationCredential(this, body.ref.slot_id);
      return this.envelope(res, value === undefined ? { source: 'none' } : { source: 'kiki', value });
    }
    if (path === '/nb-search/keys/usage' && method === 'POST') {
      if (typeof body?.instance_id !== 'string' || body.instance_id.length === 0 || body.instance_id.length > 256
        || (body.refresh !== undefined && typeof body.refresh !== 'boolean')
        || Object.keys(body).some((key) => !['instance_id', 'refresh'].includes(key))) {
        return this.envelope(res, null, 40001, 'Invalid nb-search key usage request.');
      }
      const usageSeeds = this.scenario?.data.nbSearchKeyUsage ?? {};
      const seed = usageSeeds[body.instance_id];
      const failure = usageSeeds.__error ?? seed?.__error;
      if (failure !== undefined) return this.envelope(res, null, 50000, failure);
      const capsSeed = this.scenario?.data.nbSearchCapabilities ?? NB_SEARCH_EMPTY_CAPABILITIES;
      if (capsSeed.__error !== undefined) return this.envelope(res, null, 50000, capsSeed.__error);
      const instance = fixtureSearchCapabilities(this, capsSeed).providers.instances.find((entry) => entry.id === body.instance_id);
      if (instance === undefined) return this.envelope(res, null, 40441, 'Unknown nb-search provider instance.');
      const keys = fixtureSearchActiveKeys(this, instance.id);
      if (keys.length > 32) return this.envelope(res, null, 40001, 'Fixture credential exceeds 32 keys.');
      return this.envelope(res, {
        provider_instance_id: instance.id, provider_id: instance.provider_id,
        balance_supported: seed?.balance_supported ?? false,
        keys: keys.map((_, index) => {
          const seeded = seed?.keys?.find((entry) => entry.key_index === index + 1);
          return seeded === undefined ? { key_index: index + 1, state: 'unknown' } : structuredClone(seeded);
        }),
      });
    }
    if ((path === '/nb-search/credentials/read' || path === '/nb-search/credentials/write') && method === 'POST') {
      const target = fixtureSearchCredentialBinding(this.config, body?.instance_id);
      if (target === null) return this.envelope(res, null, 40001, 'Unknown nb-search credential slot.');
      const current = this.nbSearchCredentials.get(target.slotId);
      const version = current?.version ?? 'none';
      if (path.endsWith('/write')) {
        if (typeof body.expected_binding !== 'string' || !/^[a-f0-9]{64}$/.test(body.expected_binding)
          || (body.value !== null && (typeof body.value !== 'string' || body.value.trim() === ''))
          || typeof body.expected_version !== 'string') return this.envelope(res, null, 40001, 'Invalid managed credential request.');
        if (body.expected_binding !== target.binding || body.expected_version !== version) {
          return this.envelope(res, null, 40941, 'Managed nb-search credential or binding changed; reload.');
        }
        if (body.value === null) this.nbSearchCredentials.delete(target.slotId);
        else this.nbSearchCredentials.set(target.slotId, {
          value: body.value,
          binding: target.binding,
          version: fixtureHash({ value: body.value, binding: target.binding }),
        });
        // One-shot: the control arms this so the status read that follows a
        // landed write is the one that fails. Nothing else about the run
        // changes, so the page renders a key that really is stored next to a
        // status refresh that really did fail.
        if (this.nbSearchCapsStallOnWrite === true) {
          this.nbSearchCapsStallOnWrite = false;
          this.nbSearchCapsStallOnce = true;
        }
      }
      const saved = this.nbSearchCredentials.get(target.slotId);
      const active = saved !== undefined && saved.binding === target.binding;
      return this.envelope(res, {
        instance_id: body.instance_id, slot_id: target.slotId, stored: saved !== undefined,
        active, source: active ? 'managed' : 'none', version: saved?.version ?? 'none',
        binding_version: target.binding,
        value: path.endsWith('/read') && body.reveal === true && active ? saved.value : undefined,
      });
    }
    // nb-search: secret-free capabilities + on-demand readiness, seeded per
    // scenario (`nbSearchCapabilities` / `nbSearchTest`). A seed shaped
    // `{ __error: 'message' }` makes the route fail so error states render.
    // Saved config is projected locally; no real search or fetch leaves this server.
    // A scenario that seeds `config_source` additionally follows the saved
    // `nb_search_source.reuse_local_config` toggle: off means the local file
    // and credentials read as ignored, layers lose the local tier, and
    // credentials come from the server environment alone. No files are read.
    if (path === '/nb-search/capabilities') {
      if (this.nbSearchCapsStallOnce === true) {
        this.nbSearchCapsStallOnce = false;
        return this.envelope(res, null, 50000, 'fixture: nb-search capabilities are still catching up');
      }
      const seed = this.scenario?.data.nbSearchCapabilities ?? NB_SEARCH_EMPTY_CAPABILITIES;
      if (seed.__error !== undefined) return this.envelope(res, null, 50000, seed.__error);
      const capabilities = fixtureSearchCapabilities(this, seed);
      if (seed.config_source === undefined) return this.envelope(res, capabilities);
      const reuse = this.config?.nb_search_source?.reuse_local_config ?? true;
      if (reuse) return this.envelope(res, capabilities);
      return this.envelope(res, {
        ...capabilities,
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
      if (query.get('unscoped') === 'true') {
        const items = this.effectiveAgentProfiles(undefined, true)
          .map((profile) => ({ ...profile, workspace_id: undefined, workspace_ids: undefined }));
        return this.envelope(res, { items, complete: true });
      }
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
      // `complete` is required by the wire schema and by callers that treat a
      // partial catalog as "do not trust this list" (e.g. the subagent tool
      // save re-reads the file it just wrote).
      return this.envelope(res, { items, complete: true });
    }
    // One profile file: apply the structured patch to it so a save can be read
    // back through the same GET /agents projection the GUI reloads.
    const agentUpdateMatch = /^\/agents\/([^/]+)$/.exec(path);
    if (agentUpdateMatch !== null && method === 'PATCH') {
      const name = decodeURIComponent(agentUpdateMatch[1]);
      const input = body ?? {};
      const source = { user: 'user', project: 'workspace', extra: 'extra' }[input.scope];
      const index = this.agentProfiles.findIndex((profile) => profile.name === name
        && profile.source === source
        && (input.scope === 'user' || input.source_file === undefined || profile.source_file === input.source_file));
      if (source === undefined || index === -1) {
        return this.envelope(res, null, 40404, `fixture: no writable agent profile ${name}`);
      }
      const current = { ...this.agentProfiles[index] };
      const next = { ...current };
      for (const [key, value] of Object.entries(input)) {
        if (['scope', 'workspace_id', 'source_file'].includes(key)) continue;
        if (value === null) delete next[key];
        else next[key] = value;
      }
      this.agentProfiles[index] = next;
      return this.envelope(res, next);
    }
    // Shipped (built-in) profile templates: a static per-scenario status list;
    // the restore action flips the entry back to clean so the badge and the
    // confirmation dialog stay walkable end to end.
    if (path === '/agents/shipped') {
      return this.envelope(res, { items: this.shippedAgentProfiles });
    }
    const shippedRestoreMatch = /^\/agents\/shipped\/([^/]+):restore$/.exec(path);
    if (shippedRestoreMatch !== null && method === 'POST') {
      const id = decodeURIComponent(shippedRestoreMatch[1]);
      const entry = this.shippedAgentProfiles.find((item) => item.template_id === id);
      if (entry === undefined) return this.envelope(res, null, 40001, `fixture: no shipped agent profile ${id}`);
      entry.status = 'clean';
      return this.envelope(res, entry);
    }
    if (path === '/agent-profiles' && method === 'POST') {
      const input = body ?? {};
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name ?? '') || !['user', 'project'].includes(input.scope)) {
        return this.envelope(res, null, 40001, 'fixture: invalid agent profile name or scope');
      }
      const source = input.scope === 'project' ? 'workspace' : 'user';
      if (this.agentProfiles.some((profile) => profile.name === input.name
        && (profile.source === 'builtin' || (profile.source === source
          && (source === 'user' || profile.workspace_id === input.workspace_id))))) {
        return this.envelope(res, null, 40943, `fixture: agent profile ${input.name} already exists`);
      }
      const duplicateName = typeof input.template === 'string' && input.template.startsWith('duplicate:')
        ? input.template.slice('duplicate:'.length) : undefined;
      const template = duplicateName === undefined ? undefined
        : this.agentProfiles.find((profile) => profile.name === duplicateName);
      if (duplicateName !== undefined && template === undefined) {
        return this.envelope(res, null, 40001, `fixture: no agent profile ${duplicateName}`);
      }
      if ((input.template === undefined || input.template === 'blank') && (!input.description || !String(input.prompt ?? '').trim())) {
        return this.envelope(res, null, 40001, 'fixture: description and prompt required');
      }
      const defaults = input.template === 'implementer'
        ? { description: 'Engineering owner', prompt: 'Own and verify the engineering objective.', pinned_model_alias: 'inherit' }
        : input.template === 'reviewer'
          ? { description: 'Independent reviewer', prompt: 'Review the candidate and report findings.', pinned_model_alias: 'inherit' }
          : {};
      const created = {
        ...defaults, ...template,
        name: input.name,
        source,
        workspace_id: input.workspace_id,
        source_file: `${source === 'user' ? '/fixture/home/agents' : '/fixture/project/.kiki/agents'}/${input.name}.md`,
        description: input.description ?? template?.description ?? defaults.description,
        when_to_use: input.when_to_use ?? template?.when_to_use,
        pinned_model_alias: input.pinned_model_alias ?? template?.pinned_model_alias ?? defaults.pinned_model_alias,
        thinking_effort: input.thinking_effort ?? template?.thinking_effort,
        tools: input.tools ?? template?.tools,
        prompt: input.prompt ?? template?.prompt ?? defaults.prompt,
        main: input.main ?? template?.main ?? false,
        disabled: false,
        routes: [],
      };
      this.agentProfiles.push(created);
      return this.envelope(res, created);
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
      const disabled = (this.config.disabled_named_profiles ?? []).includes(target.name);
      return this.envelope(res, { routes: [], ...target, disabled });
    }
    if (path === '/models') {
      return this.envelope(res, {
        items: this.models.length > 0 || this.modelsDeclared ? this.models : [
          { id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', display_name: 'Kiki Pro', max_context_size: 262144, support_efforts: ['low', 'high'], default_effort: 'high' },
          { id: 'fixture/kiki-lite', provider_id: 'fixture', remote_id: 'kiki-lite', display_name: 'Kiki Lite', max_context_size: 131072 },
          { id: 'kimi-code/k3', provider_id: 'kimi-code', remote_id: 'k3', display_name: 'K3', max_context_size: 262144, support_efforts: ['low', 'high'], default_effort: 'high' },
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
      // Inside a space the default lands in the space's own layer.
      if (!spaceConfigWrite(this, { default_model: modelId })) this.config.default_model = modelId;
      if (this.auth !== null) this.auth.default_model = modelId;
      return this.envelope(res, { default_model: modelId, model });
    }
    // kap-server `GET /providers:health` / `POST /providers/{id}:test` /
    // `GET /executors`. Seeded per scenario (`providerHealth`,
    // `providerTests` keyed by provider id, `executors`); a test result is
    // persisted into the health list like the real route.
    if (path === '/providers:health' && method === 'GET') {
      return this.envelope(res, { items: structuredClone(this.providerHealth ?? this.scenario?.data.providerHealth ?? []) });
    }
    const providerTestMatch = /^\/providers\/([^/]+):test$/.exec(path);
    if (providerTestMatch !== null && method === 'POST') {
      const providerId = decodeURIComponent(providerTestMatch[1]);
      if (!this.providers.some((provider) => provider.id === providerId)) return this.envelope(res, null, 40413, 'provider.not_found');
      const seeded = this.scenario?.data.providerTests?.[providerId];
      const modelId = this.models.find((model) => model.provider_id === providerId)?.id;
      const result = seeded !== undefined
        ? { ...structuredClone(seeded), provider_id: providerId, checked_at: Date.now() }
        : modelId === undefined
          ? { provider_id: providerId, ok: false, checked_at: Date.now(), duration_ms: 2, error_code: 'model_not_configured', error: 'Add a model to this connection before testing it.' }
          : { provider_id: providerId, model_id: modelId, ok: true, checked_at: Date.now(), duration_ms: 412 };
      const delay = this.scenario?.data.providerTestDelayMs ?? 900;
      this.providerHealth = [...(this.providerHealth ?? this.scenario?.data.providerHealth ?? []).filter((item) => item.provider_id !== providerId), result];
      setTimeout(() => this.envelope(res, result), delay);
      return;
    }
    // kap-server `GET /threads/messages`: scenario `threadMessages` (newest
    // first, wire shape). Filters mirror the route; pages are `limit` rows and
    // a scenario `threadMessagesEmptyPages` count prepends scan-budget pages
    // (empty, with a cursor) so the reader's "an empty page is not the end"
    // path is exercised.
    if (path === '/threads/messages' && method === 'GET') {
      const workspaceId = query.get('workspace_id') ?? undefined;
      const sessionId = query.get('session_id') ?? undefined;
      const peerId = query.get('peer_session_id') ?? undefined;
      const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 50) || 50));
      const cursor = query.get('cursor') ?? undefined;
      const all = (this.scenario?.data.threadMessages ?? []).filter((item) => {
        const source = item.source.kind === 'thread' ? item.source.thread.ref : undefined;
        const ends = [source, item.target.ref].filter(Boolean);
        if (workspaceId !== undefined && !ends.some((ref) => ref.workspace_id === workspaceId)) return false;
        if (sessionId !== undefined && !ends.some((ref) => ref.session_id === sessionId)) return false;
        if (peerId !== undefined && !ends.some((ref) => ref.session_id === peerId)) return false;
        return true;
      });
      const empties = this.scenario?.data.threadMessagesEmptyPages ?? 0;
      const [kind, value] = (cursor ?? 'e:0').split(':');
      if (kind === 'e' && Number(value) < empties) {
        return this.envelope(res, { items: [], next_cursor: `e:${Number(value) + 1}`, incomplete: 'scan_budget' });
      }
      const offset = kind === 'o' ? Number(value) : 0;
      const items = all.slice(offset, offset + limit);
      const next = offset + limit < all.length ? `o:${offset + limit}` : undefined;
      return this.envelope(res, { items: structuredClone(items), next_cursor: next });
    }
    if (path === '/executors' && method === 'GET') {
      return this.envelope(res, { items: this.executorItems() });
    }
    // 0.3.3 external clients: the one connection authorization and the
    // restricted listener. Scenario `externalClients` seeds
    // { connections, listener, authorizations, sessions, stdio, errors };
    // `errors` maps a method+path fragment to an envelope code so a failure
    // state is reachable without inventing a second scenario.
    if (path.startsWith('/external-clients')) {
      return this.externalClientsRoute(res, path, method, body);
    }
    // kap-server local executor sessions: scenario `localSessions[executorId]`
    // = { root, exists, truncated, unreadable_files, resume_enabled, items,
    // details: { [localId]: { messages, warnings } } }. Resume mints a Kiki
    // session once per local id (`created: false` afterwards, like the
    // deterministic server id) and `localSessionErrors[localId]` forces one.
    const localMatch = /^\/executors\/([^/]+)\/local-sessions(?:\/([^/]+)(\/resume)?)?$/.exec(path);
    if (localMatch !== null) {
      const executorId = decodeURIComponent(localMatch[1]);
      const catalog = this.scenario?.data.localSessions?.[executorId];
      if (catalog === undefined) return this.envelope(res, null, 40404, 'Local session catalog is unavailable for this executor');
      const { details = {}, ...directory } = catalog;
      if (localMatch[2] === undefined && method === 'GET') {
        return this.envelope(res, structuredClone({ root: '', exists: true, truncated: false, unreadable_files: 0, resume_enabled: true, ...directory, items: directory.items ?? [] }));
      }
      const localId = decodeURIComponent(localMatch[2]);
      const summary = (directory.items ?? []).find((item) => item.id === localId);
      if (summary === undefined) return this.envelope(res, null, 40401, 'Local session was not found');
      if (localMatch[3] === undefined && method === 'GET') {
        const detail = details[localId] ?? { messages: [], warnings: [] };
        return setTimeout(() => this.envelope(res, structuredClone({ summary, ...detail })), 250);
      }
      if (localMatch[3] !== undefined && method === 'POST') {
        const forced = this.scenario?.data.localSessionErrors?.[localId];
        if (forced !== undefined) return this.envelope(res, null, forced.code, forced.msg);
        if (catalog.resume_enabled === false || !summary.resume.supported) return this.envelope(res, null, 40925, summary.resume.reason ?? 'Local session continuation is disabled');
        if (body?.source_home !== summary.source_home) return this.envelope(res, null, 40001, 'Local session source home changed');
        this.localAttachments ??= new Map(Object.entries(this.scenario?.data.localAttachmentsSeed ?? {})
          .map(([local, sessionId]) => [local, { session_id: sessionId, executor_id: executorId }]));
        const existing = this.localAttachments.get(localId);
        if (existing !== undefined) return this.envelope(res, { ...existing, created: false });
        const id = `session_fixture_local_${[...this.localAttachments.values()].filter((entry) => entry.session_id.startsWith('session_fixture_local_') && /_\d+$/.test(entry.session_id)).length + 1}`;
        const record = {
          id, workspace_id: this.workspaces[0]?.id ?? 'wd_fixture_000000000000',
          title: summary.title ?? summary.last_prompt ?? '', created_at: now(), updated_at: now(),
          busy: false, pending_interaction: 'none', archived: false,
          metadata: { cwd: summary.cwd ?? 'C:/fixture' }, agent_config: { model: '', executor: executorId },
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0 },
          permission_rules: [], message_count: 0, last_seq: 0,
        };
        this.sessions.set(id, new FixtureSession(record, {}));
        const result = { session_id: id, executor_id: executorId };
        this.localAttachments.set(localId, result);
        return setTimeout(() => this.envelope(res, { ...result, created: true }), 400);
      }
    }
    // `GET /executors/{id}` and `POST /executors/{id}/check`: a check result
    // comes from the scenario's `executorChecks[id]` (or is derived from the
    // descriptor) and, like the real 60s preflight cache, feeds its login
    // status back into later GETs.
    const executorMatch = /^\/executors\/([^/]+)(\/check)?$/.exec(path);
    if (executorMatch !== null) {
      const executorId = decodeURIComponent(executorMatch[1]);
      const item = this.executorItems().find((entry) => entry.id === executorId);
      if (item === undefined) return this.envelope(res, null, 40404, 'Executor not found');
      if (executorMatch[2] === undefined && method === 'GET') return this.envelope(res, item);
      if (executorMatch[2] !== undefined && method === 'POST') {
        const seeded = (executorId === 'antigravity-acp' ? antigravityCheck(this) : undefined) ?? this.scenario?.data.executorChecks?.[executorId];
        const result = seeded !== undefined ? { id: executorId, ...structuredClone(seeded) } : {
          id: executorId,
          status: item.status === 'ready' ? 'ready' : 'unavailable',
          version: item.version,
          command: item.connection?.command ?? executorId,
          selected_source: item.connection?.source,
          resolved_args: item.connection?.default_args ?? [],
          login_status: 'unknown',
          diagnostics: item.status === 'ready' ? [] : [{ severity: 'error', message: `${item.connection?.command ?? executorId} was not found on PATH.` }],
        };
        this.executorLogin = { ...(this.executorLogin ?? {}), [executorId]: result.login_status };
        setTimeout(() => this.envelope(res, result), this.scenario?.data.executorCheckDelayMs ?? 700);
        return;
      }
    }
    if (path === '/auth') {
      return this.envelope(res, this.auth ?? {
        ready: true,
        providers_count: 0,
        default_model: null,
        managed_provider: null,
      });
    }
    // kap-server `POST /providers:probe` — tests UNSAVED connection fields
    // (onboarding's "Test connection") and answers bare remote ids; nothing is
    // persisted. The wire shape is probeProviderResponseSchema's union.
    if (path === '/providers:probe' && method === 'POST' && body !== undefined) {
      if (typeof body.base_url !== 'string' || body.base_url.trim() === '') {
        return this.envelope(res, { ok: false, error: { kind: 'endpoint', message: 'base_url is required' } });
      }
      const models = body.type === 'kimi'
        ? ['kimi-for-coding', 'kimi-k2-0711-preview']
        : ['fixture-probe-model'];
      return this.envelope(res, { ok: true, models });
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
      // Mirror kap-server: a fresh setup seeds the global default model from
      // the new provider's default (or first) model — already in alias form;
      // an existing default is never modified.
      const seededDefault = provider.default_model
        ?? this.models.find((model) => model.provider_id === provider.id)?.id;
      if ((this.config.default_model === undefined || this.config.default_model === '') && seededDefault !== undefined) {
        this.config.default_model = seededDefault;
      }
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
        ...this.models.filter((model) => model.provider_id !== currentId),
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
      this.models = this.models.filter((model) => model.provider_id !== providerId);
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
    // GUI skin files (`<KIKI_HOME>/themes/`). The fixture holds the raw file
    // contents and applies the same accept/skip rule the real server does:
    // `kind: 'kiki-skin'` and no unknown top-level keys.
    if (path === '/skins' && method === 'GET') {
      const files = this.scenario?.data.skinFiles ?? {};
      const items = [];
      const skipped = [];
      for (const [id, file] of Object.entries(files)) {
        if (file?.kind !== 'kiki-skin') {
          skipped.push({ file: `${id}.json`, reason: 'not a kiki-skin file (missing kind)' });
          continue;
        }
        const allowed = new Set(['$schema', 'kind', 'version', 'id', 'name', 'description', 'author', 'variants', '$plugin']);
        const extra = Object.keys(file).filter((key) => !allowed.has(key));
        if (extra.length > 0) {
          skipped.push({ file: `${id}.json`, reason: `unrecognized key: ${extra[0]}` });
          continue;
        }
        items.push({
          id: file.id ?? id,
          name: file.name,
          ...(file.description !== undefined ? { description: file.description } : {}),
          ...(file.author !== undefined ? { author: file.author } : {}),
          variants: ['light', 'dark'].filter((variant) => file.variants?.[variant] !== undefined),
          // `$plugin` marks a fixture skin as plugin-contributed (`/skins` `plugin`).
          ...(file.$plugin !== undefined ? { plugin: file.$plugin } : {}),
        });
      }
      items.push(...pluginSkins(this));
      return this.envelope(res, {
        items,
        directory: this.scenario?.data.skinsDirectory ?? '/home/fixture/.kiki/themes',
        skipped,
      });
    }
    const skinMatch = /^\/skins\/([a-z0-9_:-]+)$/.exec(decodeURIComponent(path));
    if (skinMatch !== null && method === 'GET') {
      const file = this.scenario?.data.skinFiles?.[skinMatch[1]];
      if (file === undefined || file.kind !== 'kiki-skin') {
        return this.envelope(res, null, 40409, 'skin not found');
      }
      const { $plugin, ...skin } = file;
      return this.envelope(res, { skin, warnings: [], ...($plugin !== undefined ? { plugin: $plugin } : {}) });
    }
    if (path === '/mcp/runtime/servers' && method === 'GET') {
      return this.envelope(res, {
        servers: this.scenario?.data.mcpServers ?? [],
      });
    }
    if (path.startsWith('/plugins') && handlePlugins(this, res, path, method, body)) return;
    if (path === '/plugins/marketplace') {
      const source = this.config.plugins?.marketplaceUrl;
      // No address configured is the normal case, not a broken one: a real
      // server answers with its bundled official catalog, so the fixture does
      // too. Only a scenario that explicitly wants an empty market sets one.
      if (typeof source !== 'string' || source.trim() === '') {
        return this.envelope(res, {
          configured: true,
          source: 'builtin:kiki-official-plugins',
          entries: marketplaceWithState(this),
        });
      }
      return this.envelope(res, {
        configured: true,
        source,
        entries: marketplaceWithState(this),
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
    // External-host skill install: `claude` already has a copy (overwrite),
    // the others are new. The fixture never writes anything.
    const hostSkillMatch = /^\/skills\/kiki-as-subagent:(preview-install|install)$/.exec(path);
    if (hostSkillMatch !== null && method === 'POST') {
      const host = String(body?.host ?? '');
      const dirs = { claude: '.claude', codex: '.codex', grok: '.grok', agents: '.agents' };
      if (!(host in dirs)) return this.envelope(res, null, 40001, 'Unknown host');
      const directory = `C:\\Users\\fixture\\${dirs[host]}\\skills`;
      const preview = { host, directory, path: `${directory}\\kiki-as-subagent\\SKILL.md`, overwrites: host === 'claude', revision: `rev-${host}` };
      // `grok` loses the race once: its first install finds the target changed.
      this.hostSkillStaleOnce ??= new Set(['grok']);
      const staleOnce = hostSkillMatch[1] === 'install' && this.hostSkillStaleOnce.delete(host);
      if (hostSkillMatch[1] === 'install' && (staleOnce || body?.confirmed !== true || body?.revision !== preview.revision)) {
        return this.envelope(res, null, 40001, 'Skill target changed; preview again before installing.');
      }
      return this.envelope(res, preview);
    }
    const workspaceSkillsMatch = /^\/workspaces\/([^/]+)\/skills$/.exec(path);
    if (workspaceSkillsMatch !== null) {
      return this.envelope(res, {
        skills: this.scenario?.data.workspaceSkills?.[workspaceSkillsMatch[1]] ?? [],
      });
    }
    if (path === '/workspaces:inspect' && method === 'POST') {
      const root = String(body?.root ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
      return this.envelope(res, { isGit: this.gitRoots.has(root) });
    }
    if (path === '/workspaces') {
      const items =
        this.workspaces.length > 0
          ? this.workspaces
          : this.scenario?.data.workspaces ?? [
              { id: 'wd_fixture_000000000000', root: 'C:/fixture', name: 'fixture', created_at: now(), last_opened_at: now(), session_count: sessions.length, pinned: false },
            ];
      return this.envelope(res, { items: items.map((workspace) => ({
        ...workspace,
        isGit: this.gitRoots.has(String(workspace.root).replaceAll('\\', '/').replace(/\/+$/, '')),
      })) });
    }
    const workspaceMatch = /^\/workspaces\/([^/]+)$/.exec(path);
    if (workspaceMatch !== null && method === 'PATCH') {
      const target = this.workspaces.find((ws) => ws.id === workspaceMatch[1]);
      if (target === undefined) {
        return this.envelope(res, null, 40410, 'workspace.not_found');
      }
      if (body?.name !== undefined) target.name = String(body.name);
      if (body?.pinned !== undefined) target.pinned = body.pinned === true;
      return this.envelope(res, {
        ...target,
        isGit: this.gitRoots.has(String(target.root).replaceAll('\\', '/').replace(/\/+$/, '')),
      });
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
        return this.failureEnvelope(res, 404, 40409, 'fs.path_not_found');
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
    // Session media bytes: a generated artifact's original and its compressed
    // preview, served raw like /fs:content above rather than envelope-wrapped,
    // because the klient reads these as binary. Scenario-seeded via
    // `mediaFiles`, keyed by the `file_id` an artifact carries. Answered in
    // fixture-media.mjs so the media fixture stays in one file.
    const sessionMedia = /^\/sessions\/([^/]+)\/media\/([^/]+)(\/preview)?$/.exec(path);
    if (sessionMedia !== null && method === 'GET') {
      const [, sessionId, fileId, preview] = sessionMedia;
      try {
        const file = sessionMediaBytes(this, decodeURIComponent(sessionId), decodeURIComponent(fileId), preview === undefined ? 'original' : 'preview');
        res.writeHead(200, {
          'content-type': file.mime,
          'content-length': file.bytes.length,
        });
        res.end(file.bytes);
      } catch (failure) {
        return this.envelope(res, null, 40409, failure instanceof Error ? failure.message : 'media.not_found');
      }
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
    // A scenario's `searchOutage: { reason }` answers like kap-server with the
    // indexer down (e.g. `memory_budget` after repeated OOM exits); the retry
    // route counts calls and, with `recoverOnRetry`, brings the index back.
    if (path === '/search/retry' && method === 'POST') {
      this.searchRetries = (this.searchRetries ?? 0) + 1;
      if (this.scenario?.data.searchOutage?.recoverOnRetry === true) this.searchRecovered = true;
      return this.envelope(res, { retried: true });
    }
    const outage = this.searchRecovered === true ? undefined : this.scenario?.data.searchOutage;
    if (path === '/search' && method === 'POST' && outage !== undefined) {
      this.lastSearchBody = body ?? null;
      return this.envelope(res, {
        items: [],
        has_more: false,
        index_state: {
          state: 'unavailable',
          reason: outage.reason,
          stale: true,
          indexed_sessions: outage.indexedSessions ?? 0,
          total_sessions: this.sessions.size,
          documents: 0,
        },
        source: 'index',
      });
    }
    // Global full-text search — hits are scenario-seeded and substring-matched.
    if (path === '/search' && method === 'POST') {
      const q = String(body?.query ?? '').toLowerCase();
      this.lastSearchBody = body ?? null;
      const workspaceId = body?.workspace_id;
      let hits = (this.scenario?.data.searchHits ?? []).filter((hit) =>
        (q === '' ||
          hit.snippet.toLowerCase().includes(q) ||
          hit.session_title.toLowerCase().includes(q)) &&
        (workspaceId === undefined || hit.workspace_id === workspaceId));
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
      // D5: the persona filter kap-server applies server-side. The GUI is not
      // allowed to re-derive attribution from a partially projected row, so the
      // fixture has to do the same job the real route does: the binding first,
      // then the compatibility metadata.
      const personaId = query.get('persona');
      if (personaId !== null && personaId !== '') {
        const personaOf = (record) => {
          const bound = record.agent_config?.persona?.id;
          if (typeof bound === 'string' && bound !== '') return bound;
          const custom = record.metadata ?? {};
          return typeof custom.bot_persona_id === 'string' ? custom.bot_persona_id
            : typeof custom.room_persona_id === 'string' ? custom.room_persona_id
              : undefined;
        };
        items = items.filter((s) => personaOf(s) === personaId);
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
    if (handleWorktrees(this, res, path, query, body, method)) return;
    if (path === '/sessions' && body !== undefined) {
      const id = nextId('session');
      // `isolation: {kind:'worktree'}` — the session runs in a new checkout of
      // its source workspace (fixture-worktrees.mjs); workspace_id stays the source.
      const isolated = body.isolation?.kind === 'worktree'
        ? createWorktreeForSession(this, id, this.workspaces.find((ws) => ws.id === body.workspace_id)
          ?? this.workspaces.find((ws) => ws.root === body.metadata?.cwd)
          ?? { id: body.workspace_id ?? 'wd_fixture_000000000000', root: body.metadata?.cwd ?? 'C:/fixture' }, body.isolation)
        : undefined;
      this.lastSessionCreate = body;
      const record = {
        id,
        workspace_id: body.workspace_id ?? 'wd_fixture_000000000000',
        title: body.title ?? '',
        created_at: now(),
        updated_at: now(),
        busy: false,
        pending_interaction: 'none',
        archived: false,
        metadata: isolated !== undefined ? { ...body.metadata, cwd: isolated.cwd } : body.metadata ?? { cwd: 'C:/fixture' },
        ...(isolated !== undefined ? { worktree: isolated.worktree } : {}),
        agent_config: {
          model: body.agent_config?.model ?? '',
          ...(body.agent_config?.profile !== undefined
            ? { profile: body.agent_config.profile }
            : {}),
          // kap-server echoes the bound persona as avatar data.
          ...(typeof body.persona === 'string' && this.personas?.has(body.persona)
            ? { persona: {
                id: body.persona,
                name: this.personas.get(body.persona).definition.name,
                ...(this.personas.get(body.persona).avatar !== undefined ? { avatarUrl: `/api/personas/${body.persona}/avatar` } : {}),
              } }
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
      if (body.delivery === 'reply' || body.delivery === 'message') session.record.delivery = body.delivery;
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
    // Persona settings for a conversation (D8): the copy this conversation was
    // created with against the persona as it is now. Scenario state seeds the
    // reading under `metadata.persona_settings` (`{boundRevision, latestRevision,
    // overrides}`); without it there is a persona and nothing to compare. An
    // apply moves the bound revision onto the latest one and, with
    // `restoreDefaults`, drops the conversation's own overrides — the reading
    // the real route returns after the same request.
    if (tail === '/persona-settings') {
      const personaId = session.record.agent_config?.persona?.id;
      // The real route refuses while the conversation is busy (REQUEST_INVALID)
      // and puts nothing back later: no queueing, no applying at the next idle
      // boundary. The mock refuses the same way so the GUI cannot be built
      // against a fiction.
      if (body !== undefined && session.record.busy === true) {
        return this.envelope(res, null, 40001, 'Wait for this conversation to become idle before applying persona settings.');
      }
      if (body !== undefined) {
        const current = session.record.metadata?.persona_settings;
        if (current !== undefined) {
          const applied = { ...current, boundRevision: current.latestRevision };
          if (body.restoreDefaults === true) delete applied.overrides;
          session.record.metadata = { ...(session.record.metadata ?? {}), persona_settings: applied };
        }
      }
      const bound = session.record.metadata?.persona_settings;
      return this.envelope(res, {
        ...(personaId === undefined ? {} : { personaId }),
        ...(bound?.boundRevision === undefined ? {} : { boundRevision: bound.boundRevision }),
        ...(bound?.latestRevision === undefined ? {} : { latestRevision: bound.latestRevision }),
        hasUpdate: bound !== undefined && bound.boundRevision !== bound.latestRevision,
        ...(bound?.overrides === undefined ? {} : { overrides: structuredClone(bound.overrides) }),
      });
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
        ...(session.contentRefs.length > 0 ? { contentRefs: session.contentRefs } : {}),
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
          context_tokens: 0,
          context_usage: 0,
        },
      });
    }
    if (handleAutoCompact(this, res, session, tail, body, method)) return;
    if (handleContextStrategy(this, res, session, tail, body, method)) return;
    if (handleAgentHooks(this, res, session, tail)) return;
    if (tail === ':compact') {
      if (session.record.busy || session.activePrompt !== null || session.scriptRunning) {
        return this.envelope(res, null, 40901, 'session.busy');
      }
      const seeded = session.transcript.snapshot('main').items.length > 0;
      if (session.messages.length + session.older.length === 0 && !seeded) {
        return this.envelope(res, null, 40910, 'compaction.unable');
      }
      // A strategy-bearing request lands its compaction marker on the
      // timeline the way the engine's context.apply_compaction does.
      if (body?.strategy === 'relay' || body?.strategy === 'summarize') {
        const batch = session.transcript.commit('main', [{
          op: 'marker.upsert',
          item: { kind: 'marker', markerId: `fixture-compaction-${Date.now()}`, marker: 'compaction', at: now(), payload: { strategy: body.strategy, shapeVersion: 1 } },
        }]);
        if (batch !== undefined) this.fanoutTranscriptOps(session, 'main', batch);
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
    if (tail === '/prompts' && body !== undefined && (session.sideAgents ?? []).includes(body.agent_id)) {
      // A `/btw` side agent answers on its own transcript; the main turn,
      // queue and busy state never see it.
      const agentId = body.agent_id;
      const promptId = body.prompt_id ?? nextId('msg');
      const createdAt = now();
      const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const reply = this.scenario?.data.btwReply ?? 'Answered from the conversation so far; the main turn keeps running.';
      const turnId = (session.sideTurns ??= {})[agentId] = (session.sideTurns[agentId] ?? 0) + 1;
      const extras = { promptId, userMessageId: promptId, content: body.content };
      this.emitTranscriptFromFrame(session, { type: 'prompt.submitted', agentId, payload: { type: 'prompt.submitted', agentId, promptId, userMessageId: promptId, content: body.content, createdAt } }, extras);
      void (async () => {
        await sleep(120);
        const frames = [
          { type: 'turn.started', payload: { turnId, origin: { kind: 'user' }, prompt: text } },
          { type: 'turn.step.started', payload: { turnId, step: 1 } },
          ...Array.from({ length: Math.ceil(reply.length / 32) }, (_, index) => ({ type: 'assistant.delta', offset: index * 32, payload: { turnId, delta: reply.slice(index * 32, index * 32 + 32) } })),
          { type: 'turn.ended', payload: { turnId, reason: 'completed', durationMs: 900 } },
        ];
        for (const frame of frames) {
          await sleep(20);
          this.emitSideFrame(session, agentId, frame, extras);
        }
      })();
      return this.envelope(res, { prompt_id: promptId, user_message_id: promptId, status: 'running', content: body.content, created_at: createdAt });
    }
    if (tail === '/prompts' && body !== undefined && typeof body.agent_id === 'string'
      && body.agent_id !== 'main' && session.childTurns?.[body.agent_id] !== undefined) {
      // A native child mid-turn parks the prompt in ITS queue (agent-scoped
      // like kap-server); `:steer?agent_id=` then hands it to that turn.
      const agentId = body.agent_id;
      const promptId = typeof body.prompt_id === 'string' && body.prompt_id !== '' ? body.prompt_id : nextId('msg');
      const createdAt = now();
      const item = { prompt_id: promptId, user_message_id: promptId, content: body.content, created_at: createdAt };
      ((session.childQueues ??= {})[agentId] ??= []).push(item);
      this.emitSideFrame(session, agentId, {
        type: 'prompt.queued',
        payload: { promptId, userMessageId: promptId, content: body.content, createdAt },
      }, { promptId, userMessageId: promptId, content: body.content });
      return this.envelope(res, { ...item, status: 'queued' });
    }
    if (tail === '/prompts' && body !== undefined) {
      // v2 currently uses one stable id for the prompt, user message, and
      // durable context message. Keep the stand-in aligned with that graph;
      // a client-chosen `prompt_id` is that id, as on kap-server.
      const promptId = typeof body.prompt_id === 'string' && body.prompt_id !== '' ? body.prompt_id : nextId('msg');
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
      // An `execution` selection commits the same way and opens a new
      // generation. Without this echo a switched session reads back as the
      // engine it left, so every later message would be projected against the
      // old binding.
      if (body.execution !== undefined && body.execution !== null) {
        const previous = session.record.agent_config?.execution;
        const selection = body.execution;
        session.record.agent_config = {
          ...session.record.agent_config,
          execution: {
            version: previous?.version ?? 1,
            selection,
            // The server resolves effective values; the fixture keeps whatever
            // the engine would report and only tracks the generation.
            effective: { ...(previous?.effective ?? {}) },
            sources: { ...(previous?.sources ?? {}) },
            generation: (previous?.generation ?? 0) + 1,
          },
        };
        session.record.updated_at = now();
      }
      const item = { prompt_id: promptId, user_message_id: userMessageId, status: 'running', content: body.content, created_at: createdAt, text };
      // A parked turn owns the session — park behind it like the real server.
      if (session.scriptRunning || session.activePrompt !== null) {
        // kap-server stamps the requested defer timing onto the parked item;
        // the queue surface reads it back from the transcript projection.
        if (typeof body.append_timing === 'string') {
          item.append_timing = body.append_timing;
          item.revision = 0;
        }
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
            ...(item.append_timing !== undefined
              ? { appendTiming: item.append_timing, revision: item.revision }
              : {}),
          },
        }, { promptId, userMessageId, content: body.content });
        return this.envelope(res, {
          prompt_id: promptId,
          user_message_id: userMessageId,
          status: 'queued',
          content: body.content,
          created_at: createdAt,
          ...(item.append_timing !== undefined ? { append_timing: item.append_timing, revision: item.revision } : {}),
        });
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
        // Mirror the engine's PromptAborted for a pending prompt: the session
        // event and the transcript fact both carry beforeStart.
        const frame = {
          type: 'prompt.aborted',
          payload: {
            promptId,
            userMessageId: aborted?.user_message_id ?? promptId,
            abortedAt: now(),
            beforeStart: true,
          },
        };
        this.emit(session.record.id, frame);
        this.emitTranscriptFromFrame(session, frame, { promptId, userMessageId: aborted?.user_message_id ?? promptId });
        return this.envelope(res, { aborted: true, at_seq: session.seq });
      }
      if (session.activePrompt?.prompt_id === promptId || session.scriptRunning) {
        session.abortRequested = true;
        this.resolveWaiters(session, 'abort');
        if (session.scriptRunning) {
          this.emit(session.record.id, {
            type: 'turn.ended',
            // The engine names an explicit stop on the wire; the transcript
            // projector turns it into the turn tail's `cancellation: user`.
            payload: { turnId: 1, reason: 'cancelled', interruptReason: 'user_cancelled' },
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
      // merges into the RUNNING turn (prompt.steered). The receipt is queue
      // bookkeeping only — the content is not context yet; the running turn's
      // next step boundary delivers it (deliverPendingSteers), so the transcript
      // gains its user frame there and not one frame earlier. The turn keeps
      // running and the steered prompt settles with it. Without an active
      // prompt the real route answers PROMPT_NOT_FOUND (40402).
      // A scenario can hold the receipt so the walker sees the in-flight
      // phase of "send now" (the request is on the wire, not yet accepted).
      const replyDelay = this.scenario?.data.steerReplyDelayMs ?? 0;
      if (replyDelay > 0 && body?.__held !== true) {
        setTimeout(() => { this.route(res, path, query, { ...(body ?? {}), __held: true }, method, req); }, replyDelay);
        return undefined;
      }
      const promptId = steerMatch[1];
      const steerAgent = query.get('agent_id');
      if (steerAgent !== null && steerAgent !== 'main') {
        // Agent-scoped steer: the child's parked prompt joins the child's
        // running turn at its next step boundary, same as main.
        const queue = session.childQueues?.[steerAgent] ?? [];
        const index = queue.findIndex((item) => item.prompt_id === promptId);
        const turnId = session.childTurns?.[steerAgent];
        if (index < 0 || turnId === undefined) return this.envelope(res, null, 40402, 'prompt.not_found');
        const [item] = queue.splice(index, 1);
        this.emitSideFrame(session, steerAgent, {
          type: 'prompt.steered',
          payload: { promptIds: [promptId], content: item.content, steeredAt: now() },
        });
        session.pendingSteers.push({
          agentId: steerAgent,
          promptId,
          userMessageId: item.user_message_id,
          content: item.content,
          origin: { kind: 'user' },
          turnId,
        });
        this.resolveWaiters(session, 'advance');
        return this.envelope(res, { steered: true, prompt_ids: [promptId] });
      }
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
      session.pendingSteers.push({
        promptId,
        userMessageId: item.user_message_id,
        content: item.content,
        origin: { kind: 'user' },
        turnId: session.activeTurnId,
      });
      // An accepted steer is what opens the running turn's next step.
      this.resolveWaiters(session, 'advance');
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
    const holdMatch = /^\/prompts\/([^/]+):hold$/.exec(tail);
    if (holdMatch !== null) {
      // Mirrors kap-server's edit hold: `held` parks the prompt and the ones
      // behind it; releasing resumes the queue when the session is idle.
      const promptId = holdMatch[1];
      const held = body?.held === true;
      if (held) {
        if (!session.queuedPrompts.some((entry) => entry.prompt_id === promptId)) {
          return this.envelope(res, null, 40402, 'prompt.not_found');
        }
        session.editHoldPromptId = promptId;
      } else if (session.editHoldPromptId === promptId) {
        session.editHoldPromptId = undefined;
        if (session.activePrompt === null && !session.scriptRunning) this.promoteNext(session);
      }
      return this.envelope(res, { prompt_id: promptId, held });
    }
    const timingMatch = /^\/prompts\/([^/]+):timing$/.exec(tail);
    if (timingMatch !== null) {
      // Mirrors kap-server: re-time a QUEUED prompt. The reply is the updated
      // PromptItem and prompt.timing_changed carries the same values to the
      // transcript projection. A stale expected_revision answers 40001 with
      // the authoritative item so the caller can reseed instead of guessing.
      const promptId = timingMatch[1];
      const item = session.queuedPrompts.find((entry) => entry.prompt_id === promptId);
      if (item === undefined || body === undefined || typeof body.append_timing !== 'string') {
        return this.envelope(res, null, 40402, 'prompt.not_found');
      }
      const revision = item.revision ?? 0;
      if (body.expected_revision !== undefined && body.expected_revision !== revision) {
        return this.envelope(
          res,
          {
            prompt_id: item.prompt_id,
            user_message_id: item.user_message_id,
            status: 'queued',
            content: item.content,
            created_at: item.created_at,
            append_timing: item.append_timing ?? 'agent_idle',
            revision,
          },
          40001,
          'request.invalid',
        );
      }
      item.append_timing = body.append_timing;
      item.revision = revision + 1;
      this.emit(session.record.id, {
        type: 'prompt.timing_changed',
        payload: { promptId, appendTiming: item.append_timing, revision: item.revision, changedAt: now() },
      });
      return this.envelope(res, {
        prompt_id: item.prompt_id,
        user_message_id: item.user_message_id,
        status: 'queued',
        content: item.content,
        created_at: item.created_at,
        append_timing: item.append_timing,
        revision: item.revision,
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
    // Task detail (`GET …/tasks/{id}?with_output=true`). The row already
    // carries the list preview; `with_output` keeps it, matching what
    // TasksPage/rail expanders read for the tail-of-log.
    const taskDetail = /^\/tasks\/([^/:]+)$/.exec(tail);
    if (taskDetail !== null && method === 'GET') {
      const task = session.tasks.find((t) => t.id === taskDetail[1]);
      if (task === undefined) return this.envelope(res, null, 40406, 'task.not_found');
      return this.envelope(res, { ...task });
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

  /** Reads and clears a one-shot failure armed by `__control`. */
  consumeScenarioFlag(name) {
    if (!this[name]) return false;
    this[name] = false;
    return true;
  }

  async handleControl(body, res) {
    switch (body.action) {
      case 'cron_fail_next_write':
        // Arms a one-shot refusal of the next cron create/update, so the
        // panel's real-failure path (draft kept, panel open) is walkable
        // against the mock rather than asserted in the abstract.
        this.cronFailNextWrite = true;
        return this.envelope(res, { armed: true });
      case 'list': {        const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
        const files = await readdir(dir);
        return this.envelope(res, {
          scenarios: files.filter((f) => f.endsWith('.scenario.mjs')).map((f) => f.replace('.scenario.mjs', '')),
          active: this.scenario?.name ?? null,
        });
      }
      case 'scenario':
        await this.loadScenario(body.name);
        this.ssh = undefined; // fixture-ssh.mjs reseeds from the scenario
        this.spaces = undefined; // fixture-spaces.mjs reseeds too
        this.webAccess = undefined; // fixture-web-access.mjs reseeds too
        return this.envelope(res, { active: body.name });
      case 'nb_search_caps_stall_after_write':
        // Arms a one-shot capabilities failure for the read that a landed
        // managed-credential write triggers, without resetting the scenario.
        this.nbSearchCapsStallOnWrite = true;
        return this.envelope(res, { armed: true });
      case 'nb_search_write_credential': {
        // Stands in for another client changing the same slot, so the version
        // the page is holding really is stale.
        const target = fixtureSearchCredentialBinding(this.config, body.instance_id);
        if (target === null) return this.envelope(res, null, 40001, 'Unknown nb-search credential slot.');
        this.nbSearchCredentials.set(target.slotId, {
          value: body.value,
          binding: target.binding,
          version: fixtureHash({ value: body.value, binding: target.binding }),
        });
        return this.envelope(res, { slot_id: target.slotId });
      }
      case 'nb_search_credential_state': {
        const target = fixtureSearchCredentialBinding(this.config, body.instance_id);
        if (target === null) return this.envelope(res, null, 40001, 'Unknown nb-search credential slot.');
        const saved = this.nbSearchCredentials.get(target.slotId);
        return this.envelope(res, { stored: saved !== undefined, value: saved?.value });
      }
      case 'space':
      case 'space_state':
        return this.envelope(res, spacesControl(this, body));
      case 'ssh-submissions':
        // Redacted shapes only (secret lengths, never values).
        return this.envelope(res, { submissions: this.sshSubmissions ?? [] });
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
        // A release also lets a turn parked on its next step move on, so a
        // scenario's hold gate never outlives the operator's release.
        this.resolveWaiters(session, 'advance');
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
      case 'emit_event': {
        // Proof hook: apply a scenario-style session frame (e.g. goal.updated)
        // to fixture state and fan it out, like a scripted step would.
        const session = this.sessions.get(body.session_id);
        if (session === undefined) return this.envelope(res, null, 40401, 'session.not_found');
        this.applySideEffects(session, body.frame);
        this.emit(body.session_id, body.frame);
        return this.envelope(res, { emitted: body.frame?.type ?? null });
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
