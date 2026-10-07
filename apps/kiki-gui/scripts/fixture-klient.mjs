import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
import { filterOpsForGrade, gradeFor, redactSnapshotForGrade } from './fixture-transcript.mjs';
import { browseFolder } from './fixture-worktrees.mjs';
import { callImportService } from './fixture-plugin-import.mjs';
import { callAgentMediaService, callMediaService } from './fixture-media.mjs';

function now() { return new Date().toISOString(); }

// Load the production wire validators, not the engine/dispatcher or a user home.
/** Stable digest for the ids and revisions the fixture mints. */
const fixtureHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The resolved projection a fixture package reports; prose lives in the files map. */
const fixtureRecipeResolved = (summary) => ({
  revision: summary.revision,
  branches: {
    main: { system: 'Ship the result and name the evidence.', steering: 'Take the next useful step.', steering_on_turn: true, steering_on_input: true, steering_interval_steps: 0, fields: {} },
    sub: { system: 'Ship the result and name the evidence.', steering: 'Take the next useful step.', fields: {} },
    independent: { fields: {} },
  },
  dependencies: [],
  origins: [
    { position: 'main', slot: 'system', source: summary.source.locator, manifest_id: summary.manifest_id, version: summary.version, file: 'main.md' },
    { position: 'main', slot: 'steering', source: summary.source.locator, manifest_id: summary.manifest_id, version: summary.version, file: 'steer.md' },
  ],
  model: { temperature: 0.2 },
  model_origins: { temperature: { source: summary.source.locator, manifest_id: summary.manifest_id, version: summary.version } },
});

/** A minimal canonical manifest, so the author workbench has real TOML to edit. */
const fixtureRecipeToml = (summary) => [
  'schema_version = 1',
  `id = "${summary.manifest_id}"`,
  `name = "${summary.name}"`,
  `version = "${summary.version}"`,
  '',
  '[prompts]',
  'system = { file = "main.md" }',
  'steering = { file = "steer.md" }',
  '',
  '[model]',
  'temperature = 0.2',
  '',
].join('\n');

const codec = await tsImport('../../../packages/klient/src/transports/codec.ts', import.meta.url);
const view = await tsImport('../../../packages/klient/src/contract/session/view.ts', import.meta.url);
const { globalContract } = await tsImport('../../../packages/klient/src/contract/index.ts', import.meta.url);
const { globalEvents } = await tsImport('../../../packages/klient/src/contract/global/events.ts', import.meta.url);
const { agentEvents } = await tsImport('../../../packages/klient/src/contract/agent/events.ts', import.meta.url);
const busEvents = new Map(Object.values(globalEvents).filter((event) => event.kind === 'bus').map((event) => [event.type, event.schema]));
const agentStreamEvents = new Map(Object.values(agentEvents).filter((event) => event.kind === 'stream').map((event) => [event.type, event.schema]));
const terminalWire = await tsImport('../../../packages/protocol/src/ws-control.ts', import.meta.url);
// The production bounded-content functions: a fixture that cuts a body must cut
// it exactly the way kap-server does, and read segments back the same way.
const bounded = await tsImport('../../../packages/kap-server/src/transport/klient/boundedContent.ts', import.meta.url);
const terminalControls = {
  terminal_attach: terminalWire.terminalAttachMessageSchema,
  terminal_detach: terminalWire.terminalDetachMessageSchema,
  terminal_input: terminalWire.terminalInputMessageSchema,
  terminal_resize: terminalWire.terminalResizeMessageSchema,
};

const GOAL_AGENT_PANEL = {
  context: 'live',
  owner: { profile: 'agent', agent_id: 'main' },
  available: true,
  profile: {
    name: 'agent',
    description: 'Fixture release coordinator.',
    source: 'builtin',
    model: 'fixture/kiki-pro',
    thinking_effort: 'high',
    profile_source: 'registered',
    subagent_policy: 'advisory',
  },
  targets: [
    {
      profile: 'researcher',
      route: 'researcher',
      description: 'Research release evidence.',
      executor: 'native',
      model_alias: 'fixture/kiki-lite',
      model_source: 'profile',
      thinking_effort: 'low',
      effort_source: 'model',
      dispatch_policy: 'advisory',
      recommendation_status: 'preferred',
      advisory_deviation: false,
      defaults_available: true,
      launch_allowed: true,
    },
    {
      profile: 'reviewer',
      route: 'reviewer',
      description: 'Review release evidence.',
      executor: 'native',
      model_alias: 'fixture/kiki-pro',
      model_source: 'profile',
      thinking_effort: 'high',
      effort_source: 'profile',
      dispatch_policy: 'strict',
      recommendation_status: 'allowed_nonpreferred',
      advisory_deviation: true,
      defaults_available: true,
      launch_allowed: true,
    },
  ],
  tools: [],
  skills: [],
};

function invalid(message, code = 40001) { return Object.assign(new Error(message), { code }); }
/**
 * A machine with nothing signed in: the answer a scenario gets for free, so a
 * scenario that wants to show a stored credential seeds only the fields it
 * cares about. Never invents an account — an unknown account stays unknown.
 */
function originalProbeDefaults(request) {
  return {
    provider: request?.provider,
    home_dir: request?.home_dir ?? '/home/fixture/.original',
    storage_backend: null,
    state: 'signed_out',
    account: { state: 'unknown' },
    can_connect: false,
  };
}
function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(parsed.error.message);
  return parsed.data;
}

function catchUp(session, agentId, since) {
  const result = session.transcript.catchup(agentId, since.seq);
  // The legacy projector asks for an entry *at* since; ordered views only need
  // consecutive entries after it, including a baseline not present in the journal.
  let next = since.seq;
  const complete = (since.epoch === undefined || since.epoch === result.epoch)
    && since.seq <= result.through_seq
    && result.batches.every((batch) => batch.seq === ++next)
    && next === result.through_seq;
  return { ...result, complete, batches: complete ? result.batches : [] };
}


/**
 * Re-derives `usage_effective` / `usage_sources` from the stored branches using
 * the engine's own rule: a branch value applies unless it would widen the
 * shared cap, in which case the shared value stands. This is the projection the
 * read path reports, not a second place where usage is decided.
 */
function resolveUsageProjection(model) {
  const shared = {
    thinking_effort: model.parameters?.thinking_effort,
    service_tier: model.parameters?.service_tier ?? model.service_tier,
    max_completion_tokens: model.parameters?.max_completion_tokens,
    auto_compact: model.overrides?.autoCompact ?? model.auto_compact,
    context_budget: model.overrides?.contextBudget ?? model.context_budget,
  };
  const positions = {
    sub: {},
    main: model.usage?.main,
    independent: model.usage?.independent,
  };
  for (const position of ['main', 'sub', 'independent']) {
    const values = {};
    const sources = {};
    for (const key of Object.keys(shared)) {
      if (shared[key] !== undefined) {
        values[key] = shared[key];
        sources[key] = key === 'auto_compact' ? '[models.*.auto_compact]'
          : key === 'context_budget' ? '[models.*.context_budget]'
          : '[models.*.parameters]';
      }
    }
    for (const key of Object.keys(shared)) {
      const value = positions[position]?.[key];
      if (value === undefined) continue;
      if ((key === 'context_budget' || key === 'max_completion_tokens')
        && typeof value === 'number' && typeof shared[key] === 'number' && shared[key] < value) continue;
      values[key] = value;
      sources[key] = `[models.*.usage.${position}.${key}]`;
    }
    model.usage_effective = { ...model.usage_effective, [position]: values };
    model.usage_sources = { ...model.usage_sources, [position]: sources };
  }
}

/**
 * The usage policy patch merges field by field, the way the engine stores it:
 * a `null` field clears that one difference, a `null` branch clears every
 * difference for that position, and a `null` `usage` clears the whole layer.
 * Nothing else about the model is touched, so one branch can be edited without
 * disturbing the other.
 */
function mergeUsagePolicy(model, patch) {
  if (patch === undefined || patch === null) {
    if (patch === null) delete model.usage;
    return;
  }
  const usage = { ...(model.usage ?? {}) };
  for (const [position, branch] of Object.entries(patch)) {
    if (branch === null) { delete usage[position]; continue; }
    const next = { ...(usage[position] ?? {}) };
    for (const [field, value] of Object.entries(branch)) {
      if (value === null) delete next[field];
      else next[field] = value;
    }
    usage[position] = next;
  }
  model.usage = usage;
}

/**
 * The two prompt objects are whole objects with a branch per identity, and the
 * engine reads four states apart. A patch therefore replaces the object it
 * names and leaves the other one alone; a `null` clears only what it names.
 */
function applyPromptObjects(model, patch) {
  for (const key of ['cognition', 'prompt_overrides']) {
    if (patch[key] === undefined) continue;
    if (patch[key] === null) delete model[key];
    else model[key] = structuredClone(patch[key]);
  }
}

const COGNITION_SLOTS = ['overlay', 'steering', 'anchor'];
const COGNITION_CHANNELS = {
  overlay: 'cognition_overlay',
  steering: 'cognition_steering',
  anchor: 'cognition_anchor',
};

/** The author files a fixture model already refers to; a real home reads them. */
function fixtureCognitionFileSources(model) {
  return model.__cognition_files ?? {};
}

function cognitionSlotBody(slot, value, files) {
  const channel = COGNITION_CHANNELS[slot];
  if (value === undefined) {
    return { channel, source: 'unset', writable: true, source_read_only: false };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    // `{text}` is a body stored on the model; an empty string is an explicit
    // empty body, not an absent one.
    return { channel, source: 'inline', text: value.text, writable: true, source_read_only: false };
  }
  const refs = Array.isArray(value) ? value : [value];
  const resolved = refs.map((ref) => {
    const file = files[ref];
    return file === undefined
      ? { path: ref, text: '', error: 'The referenced file could not be read.' }
      : { path: ref, text: file };
  });
  const failed = resolved.some((file) => file.error !== undefined);
  return {
    channel,
    source: 'files',
    text: resolved.map((file) => file.text).join('\n'),
    files: resolved,
    // `writable` means "may be edited into a body stored on the model", not
    // "the referenced file may be written" — that stays read-only always. A
    // slot whose file could not be read is never a save target, because an
    // empty box would look like a decision the person made.
    writable: !failed,
    source_read_only: true,
    ...(failed ? { error: 'The referenced file could not be read.' } : {}),
  };
}

/**
 * The manual prompt bodies, projected from what the model stores.
 *
 * This is the saved manual text, not the aggregate a Recipe or a profile
 * produces: the effective source of a channel is the resolver's answer, not this
 * projection's. Each identity picks a declared source — its own content, the
 * shared level, or nothing — and the identity that was actually chosen is what
 * `source_scope` reports.
 */
function projectCognitionBodies(model) {
  const files = fixtureCognitionFileSources(model);
  const cognition = model.cognition ?? {};
  const common = {};
  for (const slot of COGNITION_SLOTS) {
    common[slot] = cognitionSlotBody(slot, cognition[slot], files);
  }
  const branches = { common: { selection: 'common', source_scope: 'common', slots: common } };
  for (const position of ['main', 'independent']) {
    const branch = cognition[position];
    if (branch === 'off' || branch === undefined && !hasCommonSlot(cognition)) {
      branches[position] = {
        selection: 'off',
        source_scope: position,
        slots: Object.fromEntries(COGNITION_SLOTS.map((slot) => [slot, cognitionSlotBody(slot, undefined, files)])),
      };
      continue;
    }
    if (branch === undefined) {
      branches[position] = { selection: 'common', source_scope: 'common', slots: common };
      continue;
    }
    // A custom branch is a whole object: a slot it does not declare stays unset
    // rather than quietly falling back to the shared value.
    branches[position] = {
      selection: 'custom',
      source_scope: position,
      slots: Object.fromEntries(COGNITION_SLOTS.map((slot) => [slot, cognitionSlotBody(slot, branch[slot], files)])),
    };
  }
  return { revision: revisionOf(model), branches };
}

const hasCommonSlot = (cognition) => COGNITION_SLOTS.some((slot) => cognition[slot] !== undefined);

/**
 * A Recipe binding is a reference plus the snapshot that reference resolved to.
 *
 * `null` removes the reference and the snapshot with it: turning a recipe off
 * withdraws that package's contribution and nothing else, so any value the model
 * saved itself is left exactly as it was.
 */
function applyRecipeBinding(model, recipe, recipes) {
  if (recipe === undefined) return;
  if (recipe === null) {
    delete model.recipe;
    delete model.recipe_model_binding;
    return;
  }
  const found = recipes.find((entry) => entry.summary.installation_id === recipe);
  if (found === undefined) throw invalid('recipe.not_installed', 40414);
  model.recipe = recipe;
  model.recipe_model_binding = {
    installation_id: recipe,
    revision: found.resolved.revision,
    model: structuredClone(found.resolved.model),
    model_origins: structuredClone(found.resolved.model_origins),
    references: [{ surface: 'model', installation_id: recipe, revision: found.resolved.revision }],
  };
}

function revisionOf(value) {
  // Derived projections are the server's own answer rather than stored state, so
  // they must not move the revision: two reads of the same model have to produce
  // the same base_revision or every CAS would conflict with itself.
  const { usage_effective: _effective, usage_sources: _sources, revision: _revision, ...stored } = value;
  return revisionOfValue(stored);
}

function revisionOfValue(value) {
  const canonical = (entry) => {
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(',')}]`;
    if (entry !== null && typeof entry === 'object') {
      return `{${Object.entries(entry)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .sort()
        .join(',')}}`;
    }
    return JSON.stringify(entry) ?? 'null';
  };
  return canonical(value);
}

const MODEL_SWITCH_METHODS = new Set([
  'listModelSwitches', 'switchModel', 'getModelSwitch', 'updateModelSwitch',
  'cancelModelSwitch', 'recoverModelSwitch',
]);

function modelSwitchSeed(server, sessionId, agentId) {
  const seeded = server.scenario?.data.modelSwitches?.[sessionId]
    ?? server.scenario?.data.model_switches?.[sessionId];
  if (Array.isArray(seeded)) return seeded;
  if (seeded !== null && typeof seeded === 'object') {
    return seeded[agentId] ?? seeded.main ?? [];
  }
  return [];
}

function modelSwitchStore(server, session, agentId) {
  session.modelSwitches ??= new Map();
  let store = session.modelSwitches.get(agentId);
  if (store !== undefined) return store;
  store = new Map();
  for (const entry of modelSwitchSeed(server, session.record.id, agentId)) {
    if (entry?.input?.operationId !== undefined) store.set(entry.input.operationId, structuredClone(entry));
  }
  session.modelSwitches.set(agentId, store);
  return store;
}

function modelSwitchBinding(input, server) {
  const model = typeof input.selectedFromModel === 'string' && input.selectedFromModel !== ''
    ? input.selectedFromModel
    : typeof server.config.default_model === 'string' && server.config.default_model !== ''
      ? server.config.default_model
      : 'fixture/kiki-pro';
  return { model, thinking: input.thinking ?? 'high' };
}

function nextModelSwitchQueueIndex(session, store) {
  const operationIndexes = [...store.values()]
    .map((entry) => entry.queueIndex)
    .filter((index) => Number.isInteger(index) && index >= 0);
  const promptIndexes = (session.queuedPrompts ?? [])
    .map((entry) => entry.queue_position ?? entry.queuePosition)
    .filter((index) => Number.isInteger(index) && index >= 0);
  return Math.max(-1, ...operationIndexes, ...promptIndexes) + 1;
}

/** The canonical body of one scenario entity, reused by every read of it. */
export function canonicalEntity(session, key, entity) {
  const existing = session.boundedCanonical.get(key);
  if (existing !== undefined) return existing;
  session.boundedCanonical.set(key, entity);
  return entity;
}

/**
 * Cut the entities a scenario asked for with the production `boundedEntity`,
 * keeping one canonical body per entity so every preview and every segment
 * read agrees on the same revision. Entities outside the scenario's list pass
 * through untouched.
 */
export function boundScenarioEntities(session, snapshot) {
  const spec = session.boundedContent;
  if (spec === null || spec === undefined) return snapshot;
  const frames = new Set(spec.frames ?? []);
  const turns = new Set(spec.turns ?? []);
  const tasks = new Set(spec.tasks ?? []);
  const items = snapshot.items.map((item) => {
    if (item.kind !== 'turn') return item;
    const steps = item.steps.map((step) => ({
      ...step,
      frames: step.frames.map((frame) => frames.has(frame.frameId)
        ? bounded.boundedEntity(canonicalEntity(session, `frame:${frame.frameId}`, frame), { kind: 'frame', id: frame.frameId, turnId: item.turnId, stepId: step.stepId })
        : frame),
    }));
    const rebuilt = { ...item, steps };
    if (!turns.has(item.turnId)) return rebuilt;
    return bounded.boundedEntity(canonicalEntity(session, `turn:${item.turnId}`, rebuilt), { kind: 'turn', id: item.turnId });
  });
  return {
    ...snapshot,
    items,
    tasks: snapshot.tasks.map((task) => tasks.has(task.taskId)
      ? bounded.boundedEntity(canonicalEntity(session, `task:${task.taskId}`, task), { kind: 'task', id: task.taskId })
      : task),
  };
}

/**
 * The session snapshot is a bounded entity of its own: its root fields arrive
 * as previews with their refs, and the rest of a cut field is read through the
 * same content route. A scenario opts in with `bounded_content.root`.
 */
export function boundScenarioSnapshot(session, snapshot) {
  if (session.boundedContent?.root !== true) return snapshot;
  return bounded.boundedEntity(
    canonicalEntity(session, 'snapshot:root', snapshot),
    { kind: 'snapshot', id: '' },
    24 * 1024,
  );
}

export class FixtureKlient {
  constructor(server) { this.server = server; this.connections = new Map(); }

  /** The canonical entity a ref addresses, by the same source the ref names. */
  canonicalFor(session, ref) {
    const source = ref.source;
    if (source.kind === 'snapshot') return session.boundedCanonical.get('snapshot:root');
    if (source.kind === 'frame' || source.kind === 'turn' || source.kind === 'task') {
      return session.boundedCanonical.get(`${source.kind}:${source.id}`);
    }
    return undefined;
  }

  route(res, url, body, method) {
    const server = this.server;
    try {
      if (url.pathname === '/api/klient/call' && method === 'POST') {
        const { procedure, params } = codec.parseKlientCallRequest(body);
        const agentPanelRead =
          procedure.scope === 'agent' &&
          procedure.service === 'agentPanelService' &&
          procedure.method === 'read';
        const agentPlanStatus =
          procedure.scope === 'agent' &&
          procedure.service === 'agentPlanService' &&
          procedure.method === 'status';
        const agentModelSwitchCall =
          procedure.scope === 'agent' &&
          procedure.service === 'agentPromptService' &&
          MODEL_SWITCH_METHODS.has(procedure.method);
        // `/btw`: the side-agent fork plus the metadata read its first send uses.
        const sessionSideQuestion =
          procedure.scope === 'session' &&
          ((procedure.service === 'sessionBtwService' && procedure.method === 'start') ||
            (procedure.service === 'sessionMetadata' && procedure.method === 'read'));
        // Media: the global surface is core-scoped like every other global
        // service, but a job's stop and resume belong to the session and agent
        // that own it, so the agent-scoped pair is admitted here.
        const agentMediaCall =
          procedure.scope === 'agent' && procedure.service === 'agentPluginMediaService';
        if (procedure.scope !== 'core' && !agentPanelRead && !agentPlanStatus && !agentModelSwitchCall && !sessionSideQuestion && !agentMediaCall) {
          throw invalid(`Unsupported fixture procedure scope: ${procedure.scope}`, 40401);
        }
        const serviceContract = globalContract[procedure.service];
        const contract = serviceContract?.[procedure.method];
        if (contract === undefined || contract.chunk !== undefined) {
          throw invalid(`Unsupported fixture procedure: ${procedure.service}.${procedure.method}`, 40401);
        }
        const input = parse(contract.input, params);
        const result = this.callGlobal(procedure, input);
        // A fixture that wants a call to arrive late says so by returning a
        // marker: the response is written when the timer fires, so the browser
        // genuinely has an open request. That is the only way a synchronous
        // fixture can show an in-flight write — and it is the situation a
        // read-back-as-proof cannot survive.
        if (result !== null && typeof result === 'object' && result.__deferred === true) {
          const settled = parse(contract.output, result.settled);
          setTimeout(() => { server.envelope(res, settled); }, result.delayMs);
          return true;
        }
        return server.envelope(res, parse(contract.output, result));
      }
      const contentMatch = /^\/api\/klient\/session-view\/([^/]+)\/transcript\/content$/.exec(url.pathname);
      if (contentMatch !== null) {
        if (method !== 'POST') throw invalid(`Unsupported fixture route: ${method} ${url.pathname}`, 40401);
        const contentSession = server.sessions.get(decodeURIComponent(contentMatch[1]));
        if (contentSession === undefined) throw invalid('session not found', 40401);
        const input = parse(view.sessionViewTranscriptContentInputSchema, body);
        const canonical = this.canonicalFor(contentSession, input.ref);
        if (canonical === undefined) return server.envelope(res, null, 40401, 'content unavailable');
        return server.envelope(res, parse(view.sessionViewTranscriptContentOutputSchema, bounded.readContentSegment(canonical, input.ref)));
      }
      const match = /^\/api\/klient\/session-view\/([^/]+)\/(snapshot|transcript|transcript\/catch-up)$/.exec(url.pathname);
      if (match === null || method !== 'GET') throw invalid(`Unsupported fixture route: ${method} ${url.pathname}`, 40401);
      const sessionId = decodeURIComponent(match[1]);
      const session = server.sessions.get(sessionId);
      if (session === undefined) throw invalid('session not found', 40401);
      const query = url.searchParams;
      let suffix = match[2];
      let schema = view.sessionViewSnapshotOutputSchema;
      if (suffix === 'transcript') {
        parse(view.sessionViewTranscriptPageInputSchema, { agentId: query.get('agent_id'), beforeTurn: query.get('before_turn') ?? undefined,
          afterTurn: query.get('after_turn') ?? undefined, pageSize: query.has('page_size') ? Number(query.get('page_size')) : undefined });
        schema = view.sessionViewTranscriptPageOutputSchema;
      } else if (suffix === 'transcript/catch-up') {
        parse(view.sessionViewTranscriptCatchUpInputSchema, { agentId: query.get('agent_id'), since: { epoch: query.get('epoch'), seq: Number(query.get('since_seq')) }, grade: query.get('grade') ?? undefined });
        suffix = 'transcript/ops';
        schema = view.sessionViewTranscriptCatchUpOutputSchema;
      }
      if (suffix !== 'snapshot' && query.get('transcript_coverage_version') !== '2') {
        throw invalid('Transcript coverage requires a newer client; upgrade Kiki before reading transcripts.');
      }
      // Reuse the existing routes/projector, validating their projection at the new boundary.
      const response = { writeHead() {}, end: (raw) => {
        const envelope = JSON.parse(raw);
        if (envelope.code !== 0) return server.envelope(res, null, envelope.code, envelope.msg);
        let data = envelope.data;
        if (suffix === 'snapshot') data = boundScenarioSnapshot(session, { ...data, messages: { items: [], has_more: false } });
        if (suffix === 'transcript') {
          const turns = data.items.filter((item) => item.kind === 'turn');
          data = boundScenarioEntities(session, { ...data, session_id: sessionId, cursor: { seq: data.seq, epoch: session.transcript.epoch },
            coverage: data.has_more ? { kind: 'tail', hasMoreOlder: true, fromTurnId: turns[0]?.turnId, throughTurnId: turns.at(-1)?.turnId } : { kind: 'full', hasMoreOlder: false } });
        }
        if (suffix === 'transcript/ops') {
          data = catchUp(session, query.get('agent_id'), { epoch: query.get('epoch') ?? undefined, seq: Number(query.get('since_seq')) });
          data = { ...data, batches: data.batches.map((batch) => ({ ...batch, ops: filterOpsForGrade(query.get('grade') ?? 'delta', batch.ops) })).filter((batch) => batch.ops.length > 0) };
        }
        const validated = parse(schema, data);
        server.envelope(res, suffix === 'snapshot' ? validated : { ...validated, transcript_coverage_version: 2 });
      } };
      return server.route(response, `/sessions/${encodeURIComponent(sessionId)}/${suffix}`, query, undefined, 'GET');
    } catch (error) {
      return server.envelope(res, null, error.code ?? 50001, error.message, error.details);
    }
  }

  callGlobal(procedure, input) {
    const server = this.server;
    const args = Array.isArray(input) ? input : [];
    const modelItems = () => structuredClone(server.models.length > 0 || server.modelsDeclared ? server.models : [
      { id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', display_name: 'Kiki Pro', max_context_size: 262144, support_efforts: ['low', 'high'], default_effort: 'high' },
      { id: 'fixture/kiki-lite', provider_id: 'fixture', remote_id: 'kiki-lite', display_name: 'Kiki Lite', max_context_size: 131072 },
    ]);
    const providerItems = () => structuredClone(server.providers);
    const timestamp = (value) => {
      const parsed = typeof value === 'number' ? value : Date.parse(value ?? '');
      return Number.isFinite(parsed) ? parsed : Date.now();
    };
    const workspaceItems = () => structuredClone(server.workspaces).map((workspace) => ({
      id: workspace.id,
      root: workspace.root,
      name: workspace.name,
      createdAt: timestamp(workspace.created_at ?? workspace.createdAt),
      lastOpenedAt: timestamp(workspace.last_opened_at ?? workspace.lastOpenedAt),
      pinned: workspace.pinned === true,
    }));
    const key = `${procedure.service}.${procedure.method}`;
    switch (key) {
      case 'agentPromptService.listModelSwitches': {
        const session = server.sessions.get(procedure.sessionId);
        if (session === undefined) throw invalid('session not found', 40401);
        const store = modelSwitchStore(server, session, procedure.agentId);
        return [...store.values()].map((entry) => structuredClone(entry));
      }
      case 'agentPromptService.getModelSwitch': {
        const session = server.sessions.get(procedure.sessionId);
        if (session === undefined) throw invalid('session not found', 40401);
        const store = modelSwitchStore(server, session, procedure.agentId);
        return structuredClone(store.get(args[0])?.receipt ?? null);
      }
      case 'agentPromptService.switchModel': {
        const session = server.sessions.get(procedure.sessionId);
        if (session === undefined) throw invalid('session not found', 40401);
        const store = modelSwitchStore(server, session, procedure.agentId);
        const input = args[0];
        const existing = store.get(input.operationId);
        if (existing !== undefined) return structuredClone(existing.receipt);
        const originalBinding = modelSwitchBinding(input, server);
        const receipt = {
          operationId: input.operationId,
          agentId: procedure.agentId,
          state: 'pending',
          fromModel: originalBinding.model,
          toModel: input.model,
          mode: input.mode,
        };
        const entry = { input: structuredClone(input), receipt, revision: 0, originalBinding, queueIndex: nextModelSwitchQueueIndex(session, store) };
        store.set(input.operationId, entry);
        this.emitAgentModelSwitch(procedure.sessionId, procedure.agentId, 'prompt.model_switch_queued', {
          entry: { input: structuredClone(entry.input), receipt: structuredClone(entry.receipt), revision: entry.revision, originalBinding: structuredClone(entry.originalBinding) },
          queueIndex: entry.queueIndex,
        });
        this.emitAgentModelSwitch(procedure.sessionId, procedure.agentId, 'prompt.model_switch_status', {
          operationId: input.operationId,
          receipt: structuredClone(entry.receipt),
        });
        return structuredClone(receipt);
      }
      case 'agentPromptService.updateModelSwitch': {
        const session = server.sessions.get(procedure.sessionId);
        if (session === undefined) throw invalid('session not found', 40401);
        const store = modelSwitchStore(server, session, procedure.agentId);
        const input = args[0];
        const entry = store.get(input.operationId);
        if (entry === undefined) throw invalid('model_switch.not_found', 40402);
        const expectedRevision = args[1];
        if (expectedRevision !== undefined && expectedRevision !== entry.revision) throw invalid('model_switch.revision_conflict', 40941);
        entry.input = structuredClone(input);
        entry.revision += 1;
        entry.receipt = {
          ...entry.receipt,
          state: 'pending',
          toModel: input.model,
          mode: input.mode,
          error: undefined,
        };
        if (entry.queueIndex < 0) entry.queueIndex = nextModelSwitchQueueIndex(session, store);
        this.emitAgentModelSwitch(procedure.sessionId, procedure.agentId, 'prompt.model_switch_status', {
          operationId: input.operationId,
          receipt: structuredClone(entry.receipt),
        });
        return structuredClone(entry.receipt);
      }
      case 'agentPromptService.cancelModelSwitch': {
        const session = server.sessions.get(procedure.sessionId);
        if (session === undefined) throw invalid('session not found', 40401);
        const store = modelSwitchStore(server, session, procedure.agentId);
        const operationId = args[0];
        const entry = store.get(operationId);
        if (entry === undefined) throw invalid('model_switch.not_found', 40402);
        entry.receipt = { ...entry.receipt, state: 'cancelled', error: undefined };
        entry.queueIndex = -1;
        this.emitAgentModelSwitch(procedure.sessionId, procedure.agentId, 'prompt.model_switch_status', {
          operationId,
          receipt: structuredClone(entry.receipt),
        });
        return structuredClone(entry.receipt);
      }
      case 'agentPromptService.recoverModelSwitch': {
        const session = server.sessions.get(procedure.sessionId);
        if (session === undefined) throw invalid('session not found', 40401);
        const store = modelSwitchStore(server, session, procedure.agentId);
        const operationId = args[0];
        const action = args[1];
        const mode = args[2];
        const entry = store.get(operationId);
        if (entry === undefined) throw invalid('model_switch.not_found', 40402);
        if (action === 'retry' && mode !== undefined) entry.input = { ...entry.input, mode };
        entry.receipt = {
          ...entry.receipt,
          state: 'pending',
          toModel: entry.input.model,
          mode: entry.input.mode,
          error: undefined,
        };
        if (entry.queueIndex < 0) entry.queueIndex = nextModelSwitchQueueIndex(session, store);
        this.emitAgentModelSwitch(procedure.sessionId, procedure.agentId, 'prompt.model_switch_status', {
          operationId,
          receipt: structuredClone(entry.receipt),
        });
        return structuredClone(entry.receipt);
      }
      case 'agentPlanService.status':
        return null;
      case 'sessionBtwService.start': {
        const session = server.sessions.get(procedure.sessionId);
        if (session === undefined) throw invalid('session not found', 40401);
        session.sideAgents ??= [];
        const agentId = `btw-${session.sideAgents.length + 1}`;
        session.sideAgents.push(agentId);
        return agentId;
      }
      // App-scope session lifecycle, as far as the client's transport needs it:
      // every runtime action (prompt submit, edit, regenerate, steer, approval)
      // resumes the session first. A fixture session is already live, so a known
      // id answers its own handle — the engine's `{ id, kind }` — and an unknown
      // id answers the contract's empty case, which the caller reads as "this
      // session does not exist" instead of a failed fixture procedure.
      case 'sessionManager.resume': {
        const [sessionId] = args;
        return server.sessions.has(sessionId) ? { id: sessionId, kind: 'session' } : null;
      }
      case 'sessionMetadata.read': {
        const session = server.sessions.get(procedure.sessionId);
        if (session === undefined) throw invalid('session not found', 40401);
        const agents = { main: { type: 'main' } };
        for (const id of session.sideAgents ?? []) agents[id] = { type: 'sub', parentAgentId: 'main', displayName: 'btw', executor: 'native' };
        return {
          id: session.record.id,
          title: session.record.title,
          createdAt: Date.parse(session.record.created_at) || Date.now(),
          updatedAt: Date.parse(session.record.updated_at) || Date.now(),
          archived: session.record.archived === true,
          agents,
        };
      }
      case 'agentPanelService.read': {
        const [query] = args;
        const session = query.session_id === undefined ? undefined : server.sessions.get(query.session_id);
        if (query.session_id !== undefined && session === undefined) throw invalid('session not found', 40401);
        const seeded = server.scenario?.data.agentPanel;
        if (seeded !== undefined) return seeded;
        if (server.scenario?.name === 'goal') return GOAL_AGENT_PANEL;
        return {
          context: session === undefined ? 'draft' : 'live',
          owner: { profile: query.profile, agent_id: query.agent_id },
          available: false,
          unavailable_reason: 'This fixture does not seed agent capability policy.',
          profile: {
            name: query.profile ?? 'agent',
            description: 'Fixture general-purpose agent.',
            source: 'builtin',
            model: 'fixture/kiki-pro',
            thinking_effort: 'high',
            profile_source: 'registered',
            subagent_policy: 'advisory',
          },
          targets: [],
        };
      }
      case 'modelResolver.listModels':
        return modelItems();
      case 'modelResolver.listProviders':
        return providerItems();
      case 'modelResolver.getProvider': {
        const [providerId] = args;
        const provider = providerItems().find((entry) => entry.id === providerId);
        if (provider === undefined) throw invalid('provider.not_found', 40413);
        return provider;
      }
      case 'modelResolver.setDefaultModel': {
        const [modelId] = args;
        const model = modelItems().find((entry) => entry.id === modelId);
        if (model === undefined) throw invalid('model.not_found', 40412);
        server.config.default_model = modelId;
        if (server.auth !== null) server.auth.default_model = modelId;
        return { default_model: modelId, model };
      }
      case 'modelCatalogMutation.readModel': {
        const [modelId] = args;
        const item = modelItems().find((entry) => entry.id === modelId);
        if (item === undefined) throw invalid('model.not_found', 40413);
        return {
          effective_parameters: {},
          parameter_sources: {},
          ...item,
          max_input_size: item.max_input_size,
          issues: [],
          revision: revisionOf(item),
          provider_source: 'provider',
          cognition_bodies: projectCognitionBodies(item),
        };
      }
      case 'modelCatalogMutation.updateModel': {
        const [modelId, patch] = args;
        const items = modelItems();
        const index = items.findIndex((entry) => entry.id === modelId);
        if (index === -1) throw invalid('model.not_found', 40413);
        const current = items[index];
        if (patch.base_revision !== undefined && patch.base_revision !== revisionOf(current)) {
          throw invalid('model_catalog.revision_conflict', 40941);
        }
        const next = { ...current };
        if (patch.remote_id !== undefined) next.remote_id = patch.remote_id;
        if (patch.display_name !== undefined) next.display_name = patch.display_name ?? undefined;
        if (patch.max_context_size !== undefined) next.max_context_size = patch.max_context_size ?? 0;
        if (patch.capabilities !== undefined) next.capabilities = patch.capabilities ?? undefined;
        if (patch.support_efforts !== undefined) next.support_efforts = patch.support_efforts ?? undefined;
        if (patch.auto_compact !== undefined) {
          if (patch.auto_compact === null) delete next.auto_compact;
          else next.auto_compact = patch.auto_compact;
        }
        mergeUsagePolicy(next, patch.usage);
        applyPromptObjects(next, patch);
        applyRecipeBinding(next, patch.recipe, server.recipes);
        // The resolved projection is the server's own answer, so it has to move
        // with the branch that was just saved. Leaving the seeded value in place
        // makes a correct write look like it did not take.
        resolveUsageProjection(next);
        items[index] = next;
        server.models = items;
        server.modelsDeclared = true;
        return { effective_parameters: {}, parameter_sources: {}, ...next, issues: [], revision: revisionOf(next), provider_source: 'provider', cognition_bodies: projectCognitionBodies(next) };
      }
      case 'modelCatalogMutation.createModel': {
        const [input] = args;
        const id = input.id ?? `${input.provider_id}/${input.remote_id}`;
        const items = modelItems();
        if (items.some((entry) => entry.id === id)) throw invalid('model.already_exists', 40942);
        const created = {
          id,
          provider_id: input.provider_id,
          remote_id: input.remote_id,
          display_name: input.display_name,
          max_context_size: input.max_context_size ?? 0,
          capabilities: input.capabilities,
          support_efforts: input.support_efforts,
        };
        server.models = [...items, created];
        server.modelsDeclared = true;
        return { ...created, issues: [], revision: revisionOf(created), provider_source: 'provider' };
      }
      case 'modelCatalogMutation.deleteModel': {
        const [modelId] = args;
        server.models = modelItems().filter((entry) => entry.id !== modelId);
        server.modelsDeclared = true;
        return undefined;
      }
      case 'modelCatalogMutation.readProvider': {
        const [providerId] = args;
        const provider = providerItems().find((entry) => entry.id === providerId);
        if (provider === undefined) throw invalid('provider.not_found', 40412);
        return { ...provider, revision: revisionOf(provider) };
      }
      case 'modelCatalogMutation.updateProvider': {
        const [providerId, patch] = args;
        const index = server.providers.findIndex((entry) => entry.id === providerId);
        if (index === -1) throw invalid('provider.not_found', 40412);
        const current = server.providers[index];
        if (patch.base_revision !== undefined && patch.base_revision !== revisionOf(current)) {
          throw invalid('model_catalog.revision_conflict', 40941);
        }
        const next = { ...current };
        if (patch.type !== undefined) next.type = patch.type;
        if (patch.base_url !== undefined) next.base_url = patch.base_url ?? undefined;
        if (patch.default_model !== undefined) next.default_model = patch.default_model ?? undefined;
        if (patch.api_key !== undefined) next.has_api_key = patch.api_key !== '';
        if (patch.model_source !== undefined) next.model_source = patch.model_source ?? undefined;
        // Header/env values are write-only: keep only the names, like kap-server.
        for (const [field, keys] of [['custom_headers', 'custom_header_keys'], ['env', 'env_keys']]) {
          if (patch[field] === undefined) continue;
          const names = new Set(next[keys] ?? []);
          for (const [name, value] of Object.entries(patch[field])) value === null ? names.delete(name) : names.add(name);
          next[keys] = names.size === 0 ? undefined : [...names];
        }
        server.providers[index] = next;
        return { ...next, revision: revisionOf(next) };
      }
      case 'modelCatalogMutation.createProvider': {
        const [input] = args;
        if (server.providers.some((entry) => entry.id === input.id)) throw invalid('provider.already_exists', 40921);
        const provider = {
          id: input.id,
          type: input.type,
          base_url: input.base_url,
          default_model: input.default_model === undefined ? undefined : `${input.id}/${input.default_model}`,
          has_api_key: input.api_key !== undefined && input.api_key !== '',
          status: 'connected',
          models: (input.models ?? []).map((entry) => `${input.id}/${entry.remote_id}`),
        };
        server.providers.push(provider);
        if ((input.models ?? []).length > 0) {
          server.models = [
            ...modelItems(),
            ...input.models.map((entry) => ({
              id: `${input.id}/${entry.remote_id}`,
              provider_id: input.id,
              remote_id: entry.remote_id,
              display_name: entry.display_name,
              max_context_size: entry.max_context_size ?? 0,
              capabilities: entry.capabilities,
              support_efforts: entry.support_efforts,
            })),
          ];
          server.modelsDeclared = true;
        }
        // Mirror kap-server's modelCatalogMutationService.createProvider: the
        // first provider with models seeds the global default model (an empty
        // string counts as unset); an existing default is never modified.
        const firstEntry = (input.models ?? [])[0];
        if ((server.config.default_model === undefined || server.config.default_model === '') && firstEntry !== undefined) {
          server.config.default_model = provider.default_model ?? `${input.id}/${firstEntry.remote_id}`;
          if (server.auth !== null) server.auth.default_model = server.config.default_model;
        }
        if (server.auth !== null) server.auth.providers_count = server.providers.length;
        return { ...provider, revision: revisionOf(provider) };
      }
      case 'modelCatalogMutation.deleteProvider': {
        const [providerId] = args;
        server.providers = server.providers.filter((entry) => entry.id !== providerId);
        server.models = modelItems().filter((entry) => entry.provider_id !== providerId);
        server.modelsDeclared = true;
        return undefined;
      }
      case 'providerDiscovery.refreshProviderModels': {
        const [options] = args;
        const seeded = server.scenario?.data.refreshProviderModels;
        if (seeded !== undefined) return structuredClone(seeded);
        const selected = options?.providerId === undefined
          ? providerItems().map((entry) => entry.id)
          : providerItems().filter((entry) => entry.id === options.providerId).map((entry) => entry.id);
        return { changed: [], unchanged: selected, failed: [] };
      }
      case 'providerDiscovery.listDiscoveredModels':
        return { items: structuredClone(server.scenario?.data.discoveredModels ?? []) };
      case 'oauthService.listMethods': {
        // The contract requires `account` / `quota`; older scenario seeds omit
        // them, which reads as unknown (the real server's answer when it
        // cannot tell).
        const unknown = { state: 'unknown' };
        const methods = server.scenario?.data.oauthMethods ?? [
          { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: false },
          { id: 'github-copilot', label: 'GitHub Copilot', provider: 'managed:github-copilot', protocol: 'openai', signed_in: false },
          { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses', signed_in: false },
        ];
        return structuredClone(methods).map((method) => {
          // A connection attached to the machine's own sign-in reports where it
          // came from, so the row reads the real source back rather than the one
          // it optimistically wrote.
          const attached = server.originalConnected?.provider === method.id ? server.originalConnected : undefined;
          const base = {
            account: unknown, quota: unknown, ...method,
            ...(attached === undefined ? {} : {
              signed_in: true,
              connection_state: 'ready',
              account: attached.account,
              auth_source: { kind: 'local_original', home_dir: attached.home_dir, storage_backend: attached.storage_backend, source_state: attached.state },
            }),
          };
          return base;
        });
      }
      // Recipe packages: the installed set is scenario data, and every write
      // here goes through the same list the GUI reads back, so browsing a
      // package cannot drift from what a later apply would send.
      case 'recipeService.list': {
        return structuredClone(server.recipes.map((entry) => entry.summary));
      }
      case 'recipeService.get': {
        const [installationId] = args;
        const found = server.recipes.find((entry) => entry.summary.installation_id === installationId);
        if (found === undefined) return undefined;
        /*
          A read that fails on request. This is the one failure mode a save has
          to be able to survive on its own: the write landed, and only the read
          that would bring the editor up to date did not.
        */
        if (server.recipeReadFailures > 0) {
          server.recipeReadFailures -= 1;
          throw Object.assign(new Error('The recipe could not be read right now.'), { code: 50001 });
        }
        const usedBy = server.models.filter((model) => model.recipe === installationId).map((model) => model.id);
        return { ...structuredClone(found), used_by: usedBy };
      }
      case 'recipeService.preview': {
        const [{ source, installation_id: targetId, expected_revision: expectedRevision, files }] = args;
        const match = server.recipes.find((entry) => entry.summary.source.locator === source.locator);
        const shared = match === undefined ? server.sharedHookPackages.get(source.locator) : undefined;
        // A preview of something not installed yet still resolves: it reports
        // what the source would provide, which is what the import screen shows.
        const summary = match?.summary ?? {
          installation_id: `preview-${fixtureHash(source.locator)}`,
          manifest_id: source.locator.split('/').pop()?.replace(/\.toml$/u, '') ?? 'recipe',
          name: shared?.name ?? source.locator.split('/').pop()?.replace(/\.toml$/u, '') ?? 'Recipe',
          version: '1.0.0',
          revision: `sha256:${'0'.repeat(64)}`,
          source,
          update_mode: 'follow',
          health: 'ready',
        };
        const resolved = match?.resolved ?? {
          revision: summary.revision,
          branches: {
            main: { fields: {}, steering_on_turn: true, steering_on_input: true, steering_interval_steps: 0 },
            sub: { fields: {} },
            independent: { fields: {} },
          },
          dependencies: [],
          origins: [],
          model: {},
          model_origins: {},
        };
        /*
          Script hooks are the one thing a preview has to decide about. A package
          whose commands this machine already trusts reports the fingerprint it
          matched and asks for nothing; anything else reports the commands with
          their sizes and digests, and asks for consent.
        */
        const declared = match?.hooks ?? shared?.hooks;
        /*
          A targeted preview carries the edited files, so what it reports has to
          come from those files rather than from what is installed. Editing a
          command changes what would run, which is the whole reason this path
          exists at all — a preview that answered from the installed copy would
          ask about commands the person is not trying to save.
        */
        const targeted = targetId === undefined ? undefined : server.recipes.find((entry) => entry.summary.installation_id === targetId);
        const baseScripts = targeted?.hooks?.scripts ?? declared?.scripts;
        const hooks = baseScripts === undefined
          ? undefined
          : {
            // A targeted preview is asking about content that is not installed
            // yet, so it has no fingerprint to match against this machine's
            // trust and always asks. Trust is what the install records, not
            // something a preview can claim on the package's behalf.
            fingerprint: targetId === undefined ? declared.fingerprint : undefined,
            // Trust is keyed on the exact execution content. Content this machine
            // has a fingerprint for and trusts is silent; content it has never
            // authorized — including a shared package, which arrives with no
            // fingerprint at all — is what has to ask.
            consent_required: targetId !== undefined
              ? true
              : declared.fingerprint !== undefined
                ? !server.trustedHookFingerprints.has(declared.fingerprint)
                : true,
            scripts: baseScripts,
          };
        const candidate = {
          preview_id: `preview-${fixtureHash(JSON.stringify({ source, targetId, files: files ?? null }))}`,
          digest: summary.revision,
          summary: targetId === undefined ? summary : { ...summary, installation_id: targetId },
          resolved,
          diagnostics: [],
          ...(hooks === undefined ? {} : { hooks }),
        };
        /*
          The whole candidate is cached, not just its id: installing publishes
          the bytes that were previewed, so nothing is re-resolved and no new
          content is fetched at install time.
        */
        server.recipePreviews.set(candidate.preview_id, { candidate, match, files, expectedRevision, targetId });
        return structuredClone(candidate);
      }
      case 'recipeService.install': {
        const [{ preview_id: previewId, consent }] = args;
        const cached = server.recipePreviews.get(previewId);
        // A candidate is consumed when it publishes. Replaying one must fail
        // rather than resolve: a second publish of the same candidate is exactly
        // the duplicate authorization this path is shaped to prevent, and an
        // unknown id must not quietly mint another installation either.
        if (cached === undefined && previewId.startsWith('preview-')) {
          throw Object.assign(new Error('That preview is no longer available.'), { code: 40001 });
        }
        if (cached?.candidate.hooks?.consent_required === true && consent !== true) {
          // The rule the whole surface exists for: untrusted execution content is
          // refused until the same request carries the explicit agreement.
          throw Object.assign(new Error('Confirm installation to authorize new Recipe scripts'), {
            code: 40001, details: { code: 'recipe-hook-consent-required', path: 'hooks' },
          });
        }
        // A targeted preview names the installation it publishes into; anything
        // else resolves through the source the candidate was read from. Looking
        // the target up by id is what makes an edited local package update in
        // place instead of appearing as a second installation.
        const existing = (cached?.targetId === undefined
          ? cached?.match
          : server.recipes.find((entry) => entry.summary.installation_id === cached.targetId))
          ?? server.recipes.find((entry) => entry.summary.revision === previewId || entry.previewId === previewId);
        const summary = existing?.summary ?? {
          installation_id: `inst-${fixtureHash(previewId)}`,
          manifest_id: 'imported-recipe',
          name: 'Imported recipe',
          version: '1.0.0',
          revision: `sha256:${'1'.repeat(64)}`,
          source: { locator: 'https://example.com/recipes/imported/recipe.toml' },
          update_mode: 'follow',
          health: 'ready',
        };
        if (existing === undefined) {
          server.recipes.push({ previewId, summary, resolved: fixtureRecipeResolved(summary), files: { 'recipe.toml': fixtureRecipeToml(summary) }, history: [], editable: true });
        } else if (cached?.targetId !== undefined) {
          // A targeted install publishes in place: the same installation, at the
          // revision the candidate resolved, with the files that were previewed.
          if (cached.expectedRevision !== undefined && cached.expectedRevision !== existing.summary.revision) {
            throw Object.assign(new Error('That revision is no longer the installed one.'), { code: 40001 });
          }
          if (cached.files !== undefined) {
            existing.files = structuredClone(cached.files);
            // Content revision follows the files, exactly as a real publish does:
            // a save that changed bytes moves the installation to a new revision.
            const digest = `sha256:${fixtureHash(JSON.stringify(cached.files))}`;
            existing.summary = { ...existing.summary, revision: digest };
            existing.resolved = { ...existing.resolved, revision: digest };
            existing.history = [...new Set([...existing.history, digest])];
          }
        }
        /*
          Consent is what makes execution content trusted on this machine, so it
          is recorded for whichever installation the candidate resolved to. A
          targeted candidate has no fingerprint of its own — it is asking about
          content that is not installed — so what gets trusted is the fingerprint
          of the content that was actually published, which is the only thing a
          later preview of that installation can match against.
        */
        if (consent === true) {
          const fingerprint = cached?.candidate.hooks?.fingerprint
            ?? (existing !== undefined ? existing.hooks?.fingerprint : undefined);
          if (fingerprint !== undefined) {
            server.trustedHookFingerprints.add(fingerprint);
            if (existing !== undefined && existing.hooks !== undefined) {
              existing.summary = { ...existing.summary, hooks_fingerprint: fingerprint };
            }
          }
        }
        server.recipePreviews.delete(previewId);
        return structuredClone(summary);
      }

      case 'recipeService.checkUpdates': {
        return structuredClone(server.recipes.map((entry) => entry.summary));
      }
      case 'recipeService.update': {
        const [input] = args;
        const found = server.recipes.find((entry) => entry.summary.installation_id === input.installation_id);
        if (found === undefined) return undefined;
        // A failed update keeps the accepted copy: the summary stays usable and
        // records why, which is exactly what the row has to render.
        if (input.revision !== undefined && input.revision !== found.summary.revision) {
          found.summary.last_error = { code: 'recipe.update_unavailable', message: 'That revision is not available from the source.' };
          return structuredClone(found.summary);
        }
        if (input.update_mode !== undefined) found.summary.update_mode = input.update_mode;
        delete found.summary.last_error;
        return structuredClone(found.summary);
      }
      case 'recipeService.fork': {
        const [{ installation_id: installationId, mode, id, name }] = args;
        const source = server.recipes.find((entry) => entry.summary.installation_id === installationId);
        if (source === undefined) return undefined;
        const summary = {
          ...structuredClone(source.summary),
          installation_id: `inst-${fixtureHash(id + mode)}`,
          manifest_id: id,
          name,
          revision: `sha256:${fixtureHash(id + mode)}`,
          source: { locator: `installation:${fixtureHash(id + mode)}` },
          copied_from: source.summary.manifest_id,
        };
        delete summary.update_available;
        delete summary.last_error;
        const resolved = fixtureRecipeResolved(summary);
        // A copy is self-contained; an extend keeps the parent's chain, which is
        // the difference a reader has to be able to see. The chain belongs to
        // the resolved content, matching the detail schema the GUI reads.
        resolved.dependencies = mode === 'extend'
          ? [{ source: source.summary.source, manifest_id: source.summary.manifest_id, version: source.summary.version, revision: source.summary.revision }]
          : [];
        const forked = {
          summary,
          resolved,
          files: { 'recipe.toml': fixtureRecipeToml(summary) },
          history: [],
          editable: true,
        };
        server.recipes.push(forked);
        return { ...structuredClone(forked), used_by: [] };
      }
      case 'recipeService.saveLocal': {
        const [{ installation_id: installationId, files }] = args;
        const found = server.recipes.find((entry) => entry.summary.installation_id === installationId);
        if (found === undefined) return undefined;
        /*
          A save that would publish script content this machine has not
          authorized is refused, exactly as the real service refuses it: the
          draft is left alone, and the GUI has to come back through the same
          preview and confirmation rather than writing around the question.
        */
        const manifest = files['recipe.toml'];
        if (typeof manifest === 'string' && found.hooks !== undefined && !server.trustedHookFingerprints.has(found.hooks.fingerprint)) {
          // Compare decoded commands, not their TOML spelling: `\"` in the file is
          // one quote in the command, and a refusal that turned on quoting style
          // would block a save that changed nothing executable.
          const commands = [...manifest.matchAll(/^command\s*=\s*"((?:[^"\\]|\\.)*)"/gmu)]
            .map((match) => match[1].replaceAll('\\"', '"').replaceAll('\\\\', '\\'));
          const unchanged = commands.length === found.hooks.scripts.length
            && commands.every((command, index) => command === found.hooks.scripts[index].command);
          if (commands.length > 0 && (!unchanged || server.forceHookConsentRefusal)) {
            throw Object.assign(new Error('Confirm installation to authorize new Recipe scripts'), {
              code: 40001, details: { code: 'recipe-hook-consent-required', path: 'hooks' },
            });
          }
        }
        found.files = structuredClone(files);
        found.summary.revision = `sha256:${fixtureHash(JSON.stringify(files))}`;
        found.resolved = fixtureRecipeResolved(found.summary);
        found.history = [...found.history, found.summary.revision];
        return { ...structuredClone(found), used_by: [] };
      }
      case 'recipeService.remove': {
        const [{ installation_id: installationId, disable_models: disableModels }] = args;
        const index = server.recipes.findIndex((entry) => entry.summary.installation_id === installationId);
        if (index >= 0) server.recipes.splice(index, 1);
        // Removing a package a model still points at would leave a dangling
        // reference; the caller says explicitly whether to detach first.
        if (disableModels === true) {
          for (const model of server.models) {
            if (model.recipe === installationId) delete model.recipe;
          }
        }
        return undefined;
      }
      case 'recipeService.export': {
        const [installationId] = args;
        const found = server.recipes.find((entry) => entry.summary.installation_id === installationId);
        if (found === undefined) return undefined;
        return {
          name: `${found.summary.manifest_id}-${found.summary.version}`,
          revision: found.summary.revision,
          files: structuredClone(found.files),
        };
      }
      case 'recipeService.listMarkets': {
        return structuredClone(server.recipeMarkets);
      }
      case 'recipeService.addMarket': {
        const [input] = args;
        const market = { ...input, offline: false };
        server.recipeMarkets.push(market);
        return structuredClone(market);
      }
      case 'recipeService.updateMarket': {
        const [input] = args;
        const index = server.recipeMarkets.findIndex((entry) => entry.id === input.id);
        if (index < 0) return undefined;
        server.recipeMarkets[index] = { ...server.recipeMarkets[index], ...input };
        return structuredClone(server.recipeMarkets[index]);
      }
      case 'recipeService.removeMarket': {
        const [id] = args;
        server.recipeMarkets = server.recipeMarkets.filter((entry) => entry.id !== id);
        return undefined;
      }
      // Config service: only the domains the Defaults card writes directly
      // (`subagent.defaultModel`, `fastModel`), mirrored into the REST config
      // projection so GET /config reads them back.
      case 'configService.inspect': {
        const [domain] = args;
        const value = domain === 'subagent' ? server.config.subagent : domain === 'fastModel' ? server.config.fast_model : undefined;
        return { value: structuredClone(value), userValue: structuredClone(value) };
      }
      case 'configService.set': {
        const [domain, patch] = args;
        if (domain !== 'subagent') throw invalid(`fixture: config.set(${domain}) is not mocked`, 40001);
        server.config.subagent = { ...(server.config.subagent ?? {}), ...patch };
        return undefined;
      }
      case 'configService.replace': {
        const [domain, value] = args;
        if (domain === 'fastModel') {
          if (value === null || value === undefined) delete server.config.fast_model;
          else server.config.fast_model = value;
          return undefined;
        }
        if (domain === 'subagent') {
          if (value === null || value === undefined) delete server.config.subagent;
          else server.config.subagent = structuredClone(value);
          return undefined;
        }
        throw invalid(`fixture: config.replace(${domain}) is not mocked`, 40001);
      }
      case 'oauthService.getFlow': {
        const [requested] = args;
        const current = server.oauthOverride ?? server.scenario?.data.oauth ?? null;
        return requested !== undefined && current?.provider !== requested ? null : structuredClone(current);
      }
      case 'oauthService.startLogin': {
        const [provider] = args;
        const started = structuredClone(server.scenario?.data.oauthStart ?? {
          flow_id: 'flow_fixture_default',
          provider: provider ?? 'fixture',
          status: 'authenticated',
        });
        if (provider !== undefined) started.provider = provider.startsWith('managed:') ? provider : `managed:${provider}`;
        server.oauthOverride = started;
        return started;
      }
      case 'oauthService.cancelLogin': {
        const [provider] = args;
        const current = server.oauthOverride ?? server.scenario?.data.oauth;
        if (current === undefined || current === null) return { cancelled: false, status: 'cancelled' };
        server.oauthOverride = { ...structuredClone(current), provider: provider ?? current.provider, status: 'cancelled' };
        return { cancelled: true, status: 'cancelled' };
      }
      case 'oauthService.logout': {
        const [provider] = args;
        return { logged_out: true, provider: provider ?? 'fixture' };
      }
      // Reusing the original vendor's sign-in on this machine. The scenario
      // seeds the answer so a scenario can show each of the states; a seed may
      // be keyed by `provider` alone or by `provider@home_dir`, so a scenario
      // can have the default directory hold one credential and another hold a
      // different one. Connecting refuses an account the server no longer
      // reports, which is the whole point of carrying expected_account_id.
      case 'oauthService.probeOriginal': {
        const [request] = args;
        const seeds = server.scenario?.data.oauthOriginal ?? {};
        const directed = request?.home_dir === undefined ? undefined : seeds[`${request.provider}@${request.home_dir}`];
        const seeded = directed ?? seeds[request?.provider];
        const probe = { ...originalProbeDefaults(request), ...(seeded ?? {}) };
        return { ...structuredClone(probe), provider: request?.provider };
      }
      case 'oauthService.connectOriginal': {
        const [request] = args;
        const seeds = server.scenario?.data.oauthOriginal ?? {};
        const directed = request?.home_dir === undefined ? undefined : seeds[`${request.provider}@${request.home_dir}`];
        const seeded = directed ?? seeds[request?.provider];
        const probe = { ...originalProbeDefaults(request), ...(seeded ?? {}) };
        if (request?.expected_account_id !== undefined && probe.account?.id !== request.expected_account_id) {
          throw invalid('fixture: the account on this machine changed since it was probed', 40012);
        }
        server.originalConnected = { ...structuredClone(probe), provider: request?.provider };
        return structuredClone(server.originalConnected);
      }
      case 'pluginService.listPlugins':
        return structuredClone(server.plugins);
      case 'pluginService.checkUpdates':
        // GitHub installs only, like the real manager; scenario data decides the answer.
        return structuredClone((server.scenario?.data.pluginGithubUpdates ?? [])
          .filter((status) => server.plugins.some((plugin) => plugin.id === status.id && plugin.source === 'github')));
      case 'pluginService.getPluginInfo': {
        const [inputValue] = args;
        const pluginId = inputValue.id;
        const plugin = server.plugins.find((entry) => entry.id === pluginId)
          ?? server.scenario?.data.pluginInfos?.[pluginId];
        if (plugin === undefined) throw invalid('plugin.not_found', 40419);
        return structuredClone(server.scenario?.data.pluginInfos?.[pluginId] ?? {
          ...plugin,
          root: plugin.originalSource ?? `C:/fixture/plugins/${plugin.id}`,
          installedAt: '2026-01-01T00:00:00.000Z',
          mcpServers: [],
          diagnostics: [],
        });
      }
      case 'pluginService.installPlugin': {
        const source = String(args[0].source ?? '').trim();
        if (source === 'https://example.test/broken.zip') throw invalid('Plugin marketplace zip returned HTTP 404', 40001);
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
        server.plugins = server.plugins.filter((entry) => entry.id !== id);
        server.plugins.push(plugin);
        return structuredClone(plugin);
      }
      case 'pluginService.setPluginEnabled': {
        const [inputValue] = args;
        const plugin = server.plugins.find((entry) => entry.id === inputValue.id);
        if (plugin === undefined) throw invalid('plugin.not_found', 40419);
        plugin.enabled = inputValue.enabled === true;
        return undefined;
      }
      case 'pluginService.removePlugin': {
        const [inputValue] = args;
        const index = server.plugins.findIndex((entry) => entry.id === inputValue.id);
        if (index < 0) throw invalid('plugin.not_found', 40419);
        server.plugins.splice(index, 1);
        return undefined;
      }
      // Bootstrap scalars: the frozen startup snapshot the GUI reads for host
      // facts (the computer-control page's machine line). Unseeded stays
      // unsupported, like every other unseeded domain in this fixture.
      case 'bootstrapService.platform':
      case 'bootstrapService.arch':
      case 'bootstrapService.cwd':
      case 'bootstrapService.osHomeDir':
      case 'bootstrapService.homeDir':
      case 'bootstrapService.configPath':
      case 'bootstrapService.sessionsDir':
      case 'bootstrapService.blobsDir':
      case 'bootstrapService.storeDir':
      case 'bootstrapService.cacheDir':
      case 'bootstrapService.logsDir': {
        const value = server.scenario?.data.bootstrap?.[procedure.method];
        if (typeof value !== 'string') throw invalid(`no fixture bootstrap scalar for ${procedure.method}`, 40404);
        return value;
      }
      case 'bootstrapService.clientIdentity':
        return {
          productName: 'kiki',
          version: '0.31.1-fixture',
          platform: server.scenario?.data.bootstrap?.platform ?? 'linux',
        };
      case 'capabilityService.listCapabilities': {
        const capability = server.scenario?.data.computerCapability;
        return capability === undefined ? [] : [structuredClone(capability)];
      }
      case 'capabilityService.getCapability': {
        const [id] = args;
        const capability = server.scenario?.data.computerCapability;
        if (capability === undefined || id !== capability.id) throw invalid(`no fixture capability for ${String(id)}`, 40404);
        return structuredClone(capability);
      }
      case 'capabilityService.installCapability': {
        const capability = server.scenario?.data.computerCapability;
        if (capability === undefined) throw invalid('no fixture capability to install', 40404);
        const binary = capability.plan?.destination;
        // The managed install has two effects the page has to notice: the files
        // are verified, and the global connection now exists.
        if (typeof binary === 'string' && !server.mcpManaged.some((entry) => entry.name === 'kiki-computer')) {
          server.mcpManaged.push({
            name: 'kiki-computer',
            config: { transport: 'stdio', command: binary, args: ['mcp'], executor: 'local' },
            source: 'global',
            origin: 'C:/Users/fixture/.kimi/mcp.json',
            mutable: true,
          });
        }
        server.scenario.data.computerCapability = {
          ...capability,
          state: 'ready',
          version: capability.plan?.artifact.version,
          steps: [
            { id: 'binary', state: 'ok', detail: binary },
            { id: 'mcp', state: 'ok', detail: 'Global MCP entry kiki-computer' },
            { id: 'desktop-access', state: 'missing', detail: 'Not checked during install', optional: true },
          ],
        };
        return structuredClone(server.scenario.data.computerCapability);
      }
      case 'mcpManagementService.stopServer': {
        const [target] = args;
        const entry = server.mcpManaged.find((candidate) => candidate.name === target.name);
        if (entry === undefined) throw invalid('mcp.server_not_found', 40408);
        // The real service disables an editable global entry as part of stopping
        // and says so in `output`; a read-only source is left alone.
        const persistence = entry.mutable
          ? 'The global MCP configuration is disabled; all other fields were preserved.'
          : 'Read-only configuration was not changed; this stop applies only to this service process.';
        if (entry.mutable) entry.config = { ...entry.config, enabled: false };
        return {
          state: server.scenario?.data.stopState ?? 'stopped',
          output: `${server.scenario?.data.stopOutput ?? 'cua-driver exited'}\n${persistence}`,
        };
      }
      case 'mcpManagementService.listServers':
        return server.managedMcpServers();
      case 'mcpManagementService.getServer': {
        const [name] = args;
        const entry = server.mcpManaged.find((candidate) => candidate.name === name);
        if (entry === undefined) throw invalid('mcp.server_not_found', 40408);
        return structuredClone(entry);
      }
      case 'mcpManagementService.addServer': {
        const [config] = args;
        if (server.mcpManaged.some((entry) => entry.name === config.name)) {
          throw invalid(`MCP server "${config.name}" already exists`, 40001);
        }
        const { name, ...serverConfig } = config;
        server.mcpManaged.push({ name, config: structuredClone(serverConfig), source: 'global', origin: '/home/fixture/mcp.json', mutable: true });
        return server.managedMcpServers();
      }
      case 'mcpManagementService.updateServer': {
        const [config] = args;
        const index = server.mcpManaged.findIndex((entry) => entry.name === config.name);
        if (index < 0) throw invalid('mcp.server_not_found', 40408);
        if (!server.mcpManaged[index].mutable) throw invalid('MCP server is read-only', 40001);
        const { name, ...serverConfig } = config;
        server.mcpManaged[index] = { ...server.mcpManaged[index], config: structuredClone(serverConfig) };
        return server.managedMcpServers();
      }
      case 'mcpManagementService.removeServer': {
        const [name] = args;
        const index = server.mcpManaged.findIndex((entry) => entry.name === name);
        if (index < 0) throw invalid('mcp.server_not_found', 40408);
        if (!server.mcpManaged[index].mutable) throw invalid('MCP server is read-only', 40001);
        server.mcpManaged.splice(index, 1);
        return server.managedMcpServers();
      }
      case 'mcpManagementService.testServer': {
        const [target] = args;
        const name = target.name ?? target.server?.name ?? 'server';
        return { success: true, output: `fixture probe reached ${name}` };
      }
      case 'hostFolderBrowser.browse':
        return browseFolder(server, args[0]);
      case 'workspaceService.list':
        return workspaceItems();
      case 'workspaceService.get': {
        const [workspaceId] = args;
        return workspaceItems().find((workspace) => workspace.id === workspaceId);
      }
      case 'workspaceService.createOrTouch': {
        const [root, name] = args;
        let workspace = server.workspaces.find((entry) => entry.root === root);
        if (workspace === undefined) {
          workspace = { id: `wd_fixture_${Date.now().toString(36)}`, root, name: name ?? root, created_at: now(), last_opened_at: now(), session_count: 0, pinned: false };
          server.workspaces.push(workspace);
        } else {
          workspace.last_opened_at = now();
          if (name !== undefined) workspace.name = name;
        }
        return workspaceItems().find((entry) => entry.id === workspace.id);
      }
      case 'workspaceService.update': {
        const [workspaceId, patch] = args;
        const workspace = server.workspaces.find((entry) => entry.id === workspaceId);
        if (workspace === undefined) return undefined;
        if (patch.name !== undefined) workspace.name = patch.name;
        if (patch.pinned !== undefined) workspace.pinned = patch.pinned;
        return workspaceItems().find((entry) => entry.id === workspaceId);
      }
      case 'workspaceService.delete': {
        const [workspaceId] = args;
        server.workspaces = server.workspaces.filter((entry) => entry.id !== workspaceId);
        return undefined;
      }
      case 'fileService.save': {
        const [base64, filename, options] = args;
        const bytes = Buffer.from(base64, 'base64');
        const meta = {
          id: `file_fixture_${++server.fileCounter}`,
          name: options.name ?? filename,
          media_type: options.mimeType ?? 'application/octet-stream',
          size: bytes.length,
          created_at: now(),
        };
        server.files.set(meta.id, { meta, bytes });
        server.lastFileUpload = meta;
        return meta;
      }
      case 'fileService.get': {
        const [fileId] = args;
        const file = server.files.get(fileId);
        if (file === undefined) throw invalid('file.not_found', 40409);
        return { meta: structuredClone(file.meta), data: file.bytes.toString('base64') };
      }
      case 'fileService.delete': {
        const [fileId] = args;
        if (!server.files.delete(fileId)) throw invalid('file.not_found', 40409);
        return undefined;
      }
      // Contract-level task-board mock: a scenario seeds `taskBoard`
      // ({ storage, cards, detail? }) and every board read is served from it in
      // the real BoardResult / BoardPage / BoardCard shapes, so the production
      // GlobalTaskBoard → TaskBoardContainer path renders without special
      // casing. No board data seeded → the board reports an empty, valid page.
      case 'taskBoardService.read': {
        const [input] = args;
        const board = server.scenario?.data.taskBoard ?? { storage: undefined, cards: [], detail: {} };
        const ok = (value) => ({ ok: true, value });
        const summary = (entry) => structuredClone(entry);
        const cardsFor = (workspaceId) => (board.cards ?? []).filter((entry) => workspaceId === undefined || entry.workspaceId === workspaceId);
        if (input.action === 'preview') {
          return ok({
            mode: 'auto',
            workspaceId: input.workspaceId ?? cardsFor(undefined)[0]?.workspaceId ?? 'wd_unknown',
            root: board.storage?.root ?? 'C:/fixture',
            tasksDirectory: `${board.storage?.root ?? 'C:/fixture'}/.kiki/tasks`,
            existing: true,
            kind: board.storage?.kind ?? 'workspace',
            storageId: board.storage?.storageId,
            selectionOnly: true,
          });
        }
        if (input.action === 'list') {
          const workspaceId = input.workspaceId ?? board.cards?.[0]?.workspaceId ?? server.workspaces[0]?.id;
          const cards = cardsFor(workspaceId).map(summary);
          return ok({ workspaceId: workspaceId ?? 'wd_unknown', storage: structuredClone(board.storage), cards, issues: [] });
        }
        if (input.action === 'show') {
          const entry = (board.cards ?? []).find((row) => row.id === input.id && row.workspaceId === input.workspaceId);
          if (entry === undefined) return { ok: false, error: { code: 'BOARD_CARD_NOT_FOUND', message: `no card ${input.id}` } };
          const detail = board.detail?.[input.id] ?? { description: '', prd: '' };
          return ok({ ...summary(entry), description: detail.description ?? '', prd: detail.prd ?? '', handoff: detail.handoff });
        }
        if (input.action === 'overview') {
          const workspaceIds = input.workspaceIds ?? [];
          return ok(workspaceIds.map((workspaceId) => ({
            workspaceId,
            result: { ok: true, value: { workspaceId, storage: structuredClone(board.storage), cards: cardsFor(workspaceId).map(summary), issues: [] } },
          })));
        }
        return { ok: false, error: { code: 'BOARD_UNSUPPORTED', message: `unsupported read action ${input.action}` } };
      }
      case 'taskBoardService.write': {
        const [input] = args;
        const board = server.scenario?.data.taskBoard ?? { cards: [], detail: {} };
        board.cards ??= [];
        const ok = (value) => ({ ok: true, value });
        if (input.action === 'create') {
          const entry = {
            id: `board_fixture_${board.cards.length + 1}`,
            workspaceId: input.workspaceId ?? board.cards[0]?.workspaceId ?? 'wd_unknown',
            storage: structuredClone(board.storage),
            title: input.title,
            priority: input.priority ?? 'P2',
            status: 'active',
            revision: 1,
            createdAt: now(),
            updatedAt: now(),
            completedAt: null,
            archived: false,
            category: input.category ?? '',
            sessionIds: input.sessionIds ?? [],
            executionIds: [],
          };
          board.cards.push(entry);
          board.detail ??= {};
          board.detail[entry.id] = { description: input.description ?? '', prd: '' };
          return ok({ ...structuredClone(entry), description: input.description ?? '', prd: '' });
        }
        if (input.action === 'update') {
          const entry = (board.cards ?? []).find((row) => row.id === input.id);
          if (entry === undefined) return { ok: false, error: { code: 'BOARD_CARD_NOT_FOUND', message: `no card ${input.id}` } };
          const { description, ...summaryPatch } = input.patch;
          Object.assign(entry, { ...summaryPatch, revision: input.expectedRevision + 1, updatedAt: now() });
          // Writes answer with a full BoardCard (summary + detail), like `show`.
          board.detail ??= {};
          const detail = board.detail[input.id] ?? { description: '', prd: '' };
          if (description !== undefined) board.detail[input.id] = { ...detail, description };
          const current = board.detail[input.id] ?? detail;
          return ok({ ...structuredClone(entry), description: current.description ?? '', prd: current.prd ?? '', handoff: current.handoff });
        }
        return { ok: false, error: { code: 'BOARD_UNSUPPORTED', message: `unsupported write action ${input.action}` } };
      }
      case 'taskBoardService.overview': {
        const board = server.scenario?.data.taskBoard ?? { storage: undefined, cards: [] };
        // Cover every registered workspace so a multi-workspace board reads as a
        // healthy (possibly empty) overview instead of a per-workspace failure.
        const workspaceIds = [...new Set([
          ...(board.cards ?? []).map((entry) => entry.workspaceId),
          ...server.workspaces.map((workspace) => workspace.id),
        ])];
        return {
          ok: true,
          value: workspaceIds.map((workspaceId) => ({
            workspaceId,
            result: { ok: true, value: { workspaceId, storage: structuredClone(board.storage), cards: (board.cards ?? []).filter((entry) => entry.workspaceId === workspaceId).map((entry) => structuredClone(entry)), issues: [] } },
          })),
        };
      }
      case 'pluginImportService.sources':
      case 'pluginImportService.discover':
      case 'pluginImportService.preview':
      case 'pluginImportService.start':
      case 'pluginImportService.jobs':
      case 'pluginImportService.job':
      case 'pluginImportService.cancel':
      case 'pluginImportService.resume':
      case 'pluginImportService.archives':
      case 'pluginImportService.read': {
        // The import surface is a whole page, so its ten methods are answered
        // in one place rather than ten switch arms.
        return callImportService(server, procedure.method, args).data;
      }
      // Media: the whole source list and the four writes that change it, the
      // installed provider list, the discovery roster, and the on-demand
      // capability/voice reads. The agent-scoped pair is answered through the
      // job's own session and agent, so the fixture can prove the GUI reaches
      // them the way the contract requires.
      case 'pluginMediaService.sources':
      case 'pluginMediaService.setSources':
      case 'pluginMediaService.catalog':
      case 'pluginMediaService.providers':
      case 'pluginMediaService.managedSources':
      case 'pluginMediaService.sourceSettings':
      case 'pluginMediaService.updateSource':
      case 'pluginMediaService.addScriptSource':
      case 'pluginMediaService.capabilities':
      case 'pluginMediaService.voices':
      case 'pluginMediaService.jobs':
      case 'pluginMediaService.job': {
        return callMediaService(server, procedure.method, args);
      }
      case 'agentPluginMediaService.cancel':
      case 'agentPluginMediaService.resume': {
        return callAgentMediaService(server, procedure.method, args, procedure.sessionId, procedure.agentId);
      }
      default:
        throw invalid(`Unsupported fixture procedure: ${procedure.service}.${procedure.method}`, 40401);
    }
  }

  connect(socket) {
    const state = { views: new Map(), subscriptions: new Map(), terminals: new Map(), lastInbound: Date.now() };
    this.connections.set(socket, state);
    this.server.sockets.add(socket);
    const send = (frame) => this.server.sendFrame(socket, frame);
    const heartbeat = setInterval(() => {
      if (Date.now() - state.lastInbound > 30_000) return socket.terminate();
      send({ type: 'ping', data: { nonce: String(Date.now()), heartbeatMs: 10_000 } });
    }, 10_000);
    socket.on('close', () => {
      clearInterval(heartbeat);
      for (const [terminal, sink] of state.terminals) terminal.attachments.delete(sink);
      state.terminals.clear();
      this.connections.delete(socket);
      this.server.sockets.delete(socket);
    });
    socket.on('message', (raw) => {
      state.lastInbound = Date.now();
      const frame = codec.decodeJsonFrame(String(raw));
      if (frame === undefined) return;
      this.server.wsInbound.push(frame);
      if (this.server.wsInbound.length > 400) this.server.wsInbound.shift();
      try {
        if (frame.type === 'pong') return;
        if (typeof frame.id !== 'string' || frame.id.length === 0) throw invalid('id required');
        if (Object.hasOwn(terminalControls, frame.type)) { this.terminalControl(socket, state, frame); return; }
        if (frame.type === 'view_detach') { state.views.delete(frame.id); return; }
        if (frame.type === 'unsubscribe') { state.subscriptions.delete(frame.id); return; }
        if (frame.type === 'subscribe') {
          const coreEvents = frame.scope === 'core' && frame.service === undefined && frame.event === 'events';
          const agentEvents = frame.scope === 'agent' && frame.service === undefined && frame.event === 'events'
            && typeof frame.sessionId === 'string' && typeof frame.agentId === 'string';
          if (!coreEvents && !agentEvents) throw invalid(`Unsupported fixture subscription: ${frame.scope}.${frame.service ?? ''}.${frame.event}`, 40401);
          if (state.subscriptions.has(frame.id)) throw invalid('id already in use');
          state.subscriptions.set(frame.id, frame);
          send({ type: 'subscribed', id: frame.id });
          return;
        }
        if (frame.type !== 'view_attach') throw invalid(`Unsupported fixture frame: ${frame.type}`, 40401);
        const input = parse(view.sessionViewSubscribeInputSchema, frame.data?.input);
        const generation = frame.data?.generation;
        if (!Number.isInteger(generation) || generation < 0) throw invalid('invalid generation');
        const coverageVersion = frame.data?.transcript_coverage_version;
        if (Object.values(input.transcriptGrades).some((grade) => grade !== 'off') && coverageVersion !== 2) {
          throw invalid('Transcript coverage requires a newer client; upgrade Kiki before reading transcripts.');
        }
        const session = this.server.sessions.get(frame.sessionId);
        if (session === undefined) throw invalid('session not found', 40401);
        const previous = state.views.get(frame.id);
        const active = { id: frame.id, sessionId: frame.sessionId, input, generation, coverageVersion };
        state.views.set(frame.id, active);
        const currentSessionCursor = { seq: session.seq, epoch: session.epoch };
        const cursor = input.sessionCursor;
        const reason = cursor.epoch !== undefined && cursor.epoch !== session.epoch ? 'epoch_changed'
          : cursor.seq > session.seq ? 'session_recreated'
          : cursor.seq < (session.journal[0]?.seq ?? session.seq + 1) - 1 ? 'buffer_overflow' : undefined;
        if (reason !== undefined) this.signal(socket, active, { type: 'resyncRequired', reason, currentSessionCursor });
        else for (const entry of session.journal) if (entry.seq > cursor.seq) this.deliver(socket, active, entry.frame);
        for (const agentId of session.transcript.agents.keys()) {
          const grade = gradeFor(input.transcriptGrades, agentId);
          if (grade === 'off') continue;
          const since = input.transcriptSince?.[agentId];
          const ranks = { off: 0, turn: 1, block: 2, delta: 3 };
          const upgraded = previous?.sessionId === frame.sessionId && ranks[grade] > ranks[gradeFor(previous.input.transcriptGrades, agentId)];
          const catchup = since === undefined || upgraded ? undefined : catchUp(session, agentId, since);
          if (catchup?.complete) {
            for (const batch of catchup.batches) this.signal(socket, active, { type: 'transcript', event: session.transcript.opsEvent(agentId, { seq: batch.seq, ops: filterOpsForGrade(grade, batch.ops) }) });
          } else {
            const event = session.transcript.resetEvent(agentId, grade);
            // Same two steps as a REST answer: the grade's redaction, then the
            // scenario's bounded entities.
            this.signal(socket, active, { type: 'transcript', event: { ...event, snapshot: boundScenarioEntities(session, redactSnapshotForGrade(grade, event.snapshot)) } });
          }
        }
        this.signal(socket, active, { type: 'ready', currentSessionCursor, reconnected: frame.data?.reconnected === true });
      } catch (error) {
        if (frame.type === 'view_attach') state.views.delete(frame.id);
        send({ type: frame.type === 'view_attach' ? 'view_error' : frame.type === 'stream' ? 'stream_error' : frame.type.startsWith('terminal_') ? 'terminal_ack' : 'error', id: frame.id, code: error.code ?? 50001, msg: error.message });
      }
    });
  }

  terminalControl(socket, state, frame) {
    const { payload } = parse(terminalControls[frame.type], { type: frame.type, id: frame.id, payload: frame.data });
    const session = this.server.sessions.get(payload.session_id);
    if (session === undefined) throw invalid('session.not_found', 40401);
    const terminal = session.terminals.get(payload.terminal_id);
    if (terminal === undefined) throw invalid('terminal.not_found', 40414);
    const ack = (data = {}) => this.server.sendFrame(socket, { type: 'terminal_ack', id: frame.id, code: 0, msg: 'success', data });
    if (frame.type === 'terminal_input') { terminal.write(payload.data); return; }
    if (frame.type === 'terminal_resize') { terminal.resize(payload.cols, payload.rows); return; }
    if (frame.type === 'terminal_detach') {
      terminal.attachments.delete(state.terminals.get(terminal));
      state.terminals.delete(terminal);
      ack();
      return;
    }
    const sink = state.terminals.get(terminal) ?? {
      get readyState() { return socket.readyState; },
      send: (raw) => {
        const output = JSON.parse(raw);
        this.server.sendFrame(socket, { type: output.type, data: output });
        if (output.type === 'terminal_exit') {
          terminal.attachments.delete(sink);
          state.terminals.delete(terminal);
        }
      },
    };
    state.terminals.set(terminal, sink);
    terminal.attachments.add(sink);
    const sinceSeq = payload.since_seq ?? 0;
    const earliestSeq = terminal.buffer[0]?.seq ?? null;
    let replayed = 0;
    for (const output of terminal.buffer) if (output.seq > sinceSeq) {
      sink.send(JSON.stringify(output));
      replayed += 1;
    }
    if (terminal.record.status === 'exited') sink.send(JSON.stringify(terminal.exitFrame()));
    ack({ replayed, earliest_seq: earliestSeq, truncated: earliestSeq !== null && sinceSeq + 1 < earliestSeq });
  }

  signal(socket, active, signal) {
    const data = parse(view.sessionViewSignalSchema, { ...signal, generation: active.generation });
    this.server.sendFrame(socket, { type: 'view_signal', id: active.id,
      data: active.coverageVersion === 2 ? { ...data, transcript_coverage_version: 2 } : data });
  }

  deliver(socket, active, frame) {
    if (frame.volatile) return;
    const cursor = { seq: frame.seq, epoch: frame.epoch };
    const payload = frame.payload;
    if (frame.type === 'event.session.history_rewritten') {
      this.signal(socket, active, { type: 'historyRewritten', reason: payload.reason, targetMessageId: payload.target_message_id, cursor });
    } else this.signal(socket, active, { type: 'sessionCursorAdvanced', cursor });
  }

  emit(sessionId, frame) {
    const schema = busEvents.get(frame.type);
    const payload = frame.type === 'session.meta.updated'
      ? { ...frame.payload, patch: frame.payload.patch ?? { title: frame.payload.title } } : frame.payload;
    const data = schema === undefined ? undefined : { type: frame.type, payload: parse(schema, payload) };
    for (const [socket, state] of this.connections) {
      for (const active of state.views.values()) if (active.sessionId === sessionId) this.deliver(socket, active, frame);
      if (data !== undefined) for (const [id, subscription] of state.subscriptions) {
        if (subscription.scope === 'core') this.server.sendFrame(socket, { type: 'event', id, data });
      }
    }
  }

  /** A global bus fact (`{ type, payload }`) to every core `events` subscriber, validated like the real server's. */
  emitGlobal(type, payload) {
    const schema = busEvents.get(type);
    if (schema === undefined) throw new Error(`Unknown global bus event: ${type}`);
    const data = { type, payload: parse(schema, payload) };
    for (const [socket, state] of this.connections) {
      for (const [id, subscription] of state.subscriptions) {
        if (subscription.scope === 'core') this.server.sendFrame(socket, { type: 'event', id, data });
      }
    }
  }

  emitAgentModelSwitch(sessionId, agentId, type, payload) {
    const schema = agentStreamEvents.get(type);
    if (schema === undefined) throw new Error(`Unknown agent event: ${type}`);
    const data = parse(schema, { type, time: Date.now(), ...payload });
    for (const [socket, state] of this.connections) {
      for (const [id, subscription] of state.subscriptions) {
        if (subscription.scope !== 'agent' || subscription.event !== 'events'
          || subscription.sessionId !== sessionId || subscription.agentId !== agentId) continue;
        this.server.sendFrame(socket, { type: 'event', id, data });
      }
    }
  }

  resync(session) {
    for (const [socket, state] of this.connections) for (const active of state.views.values()) {
      if (active.sessionId === session.record.id) this.signal(socket, active, { type: 'resyncRequired', reason: 'epoch_changed', currentSessionCursor: { seq: session.seq, epoch: session.epoch } });
    }
  }

  transcript(session, agentId, batch) {
    for (const [socket, state] of this.connections) for (const active of state.views.values()) {
      if (active.sessionId !== session.record.id) continue;
      const grade = gradeFor(active.input.transcriptGrades, agentId);
      if (grade === 'off') continue;
      const event = batch === undefined ? session.transcript.resetEvent(agentId, grade)
        : session.transcript.opsEvent(agentId, { seq: batch.seq, ops: filterOpsForGrade(grade, batch.ops) });
      // A snapshot pushed to a view gets the same two steps as one served over
      // REST: the grade's redaction, then the scenario's bounded entities.
      this.signal(socket, active, { type: 'transcript', event: batch === undefined
        ? { ...event, snapshot: boundScenarioEntities(session, redactSnapshotForGrade(grade, event.snapshot)) }
        : event });
    }
  }
}
