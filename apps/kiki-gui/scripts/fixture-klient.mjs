import { tsImport } from 'tsx/esm/api';
import { filterOpsForGrade, gradeFor, redactSnapshotForGrade } from './fixture-transcript.mjs';

function now() { return new Date().toISOString(); }

// Load the production wire validators, not the engine/dispatcher or a user home.
const codec = await tsImport('../../../packages/klient/src/transports/codec.ts', import.meta.url);
const view = await tsImport('../../../packages/klient/src/contract/session/view.ts', import.meta.url);
const { globalContract } = await tsImport('../../../packages/klient/src/contract/index.ts', import.meta.url);
const { globalEvents } = await tsImport('../../../packages/klient/src/contract/global/events.ts', import.meta.url);
const busEvents = new Map(Object.values(globalEvents).filter((event) => event.kind === 'bus').map((event) => [event.type, event.schema]));
const terminalWire = await tsImport('../../../packages/protocol/src/ws-control.ts', import.meta.url);
const terminalControls = {
  terminal_attach: terminalWire.terminalAttachMessageSchema,
  terminal_detach: terminalWire.terminalDetachMessageSchema,
  terminal_input: terminalWire.terminalInputMessageSchema,
  terminal_resize: terminalWire.terminalResizeMessageSchema,
};

const GOAL_SWARM_AGENT_PANEL = {
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

function revisionOf(value) {
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

export class FixtureKlient {
  constructor(server) { this.server = server; this.connections = new Map(); }

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
        if (procedure.scope !== 'core' && !agentPanelRead && !agentPlanStatus) {
          throw invalid(`Unsupported fixture procedure scope: ${procedure.scope}`, 40401);
        }
        const serviceContract = globalContract[procedure.service];
        const contract = serviceContract?.[procedure.method];
        if (contract === undefined || contract.chunk !== undefined) {
          throw invalid(`Unsupported fixture procedure: ${procedure.service}.${procedure.method}`, 40401);
        }
        const input = parse(contract.input, params);
        const result = this.callGlobal(procedure, input);
        return server.envelope(res, parse(contract.output, result));
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
      // Reuse the existing routes/projector, validating their projection at the new boundary.
      const response = { writeHead() {}, end: (raw) => {
        const envelope = JSON.parse(raw);
        if (envelope.code !== 0) return server.envelope(res, null, envelope.code, envelope.msg);
        let data = envelope.data;
        if (suffix === 'snapshot') data = { ...data, messages: { items: [], has_more: false } };
        if (suffix === 'transcript') {
          const turns = data.items.filter((item) => item.kind === 'turn');
          data = { ...data, session_id: sessionId, cursor: { seq: data.seq, epoch: session.transcript.epoch },
            coverage: data.has_more ? { kind: 'tail', hasMoreOlder: true, fromTurnId: turns[0]?.turnId, throughTurnId: turns.at(-1)?.turnId } : { kind: 'full', hasMoreOlder: false } };
        }
        if (suffix === 'transcript/ops') {
          data = catchUp(session, query.get('agent_id'), { epoch: query.get('epoch') ?? undefined, seq: Number(query.get('since_seq')) });
          data = { ...data, batches: data.batches.map((batch) => ({ ...batch, ops: filterOpsForGrade(query.get('grade') ?? 'delta', batch.ops) })).filter((batch) => batch.ops.length > 0) };
        }
        server.envelope(res, parse(schema, data));
      } };
      return server.route(response, `/sessions/${encodeURIComponent(sessionId)}/${suffix}`, query, undefined, 'GET');
    } catch (error) {
      return server.envelope(res, null, error.code ?? 50001, error.message);
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
      case 'agentPlanService.status':
        return null;
      case 'agentPanelService.read': {
        const [query] = args;
        const session = query.session_id === undefined ? undefined : server.sessions.get(query.session_id);
        if (query.session_id !== undefined && session === undefined) throw invalid('session not found', 40401);
        const seeded = server.scenario?.data.agentPanel;
        if (seeded !== undefined) return seeded;
        if (server.scenario?.name === 'goal-swarm') return GOAL_SWARM_AGENT_PANEL;
        return {
          context: session === undefined ? 'draft' : 'live',
          owner: { profile: query.profile, agent_id: query.agent_id },
          available: false,
          unavailable_reason: 'This fixture does not seed agent capability policy.',
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
        return { ...item, max_input_size: item.max_input_size, issues: [], revision: revisionOf(item), provider_source: 'provider' };
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
        items[index] = next;
        server.models = items;
        server.modelsDeclared = true;
        return { ...next, issues: [], revision: revisionOf(next), provider_source: 'provider' };
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
      case 'oauthService.getFlow':
        return structuredClone(server.oauthOverride ?? server.scenario?.data.oauth ?? null);
      case 'oauthService.startLogin': {
        const [provider] = args;
        const started = structuredClone(server.scenario?.data.oauthStart ?? {
          flow_id: 'flow_fixture_default',
          provider: provider ?? 'fixture',
          status: 'authenticated',
        });
        if (provider !== undefined) started.provider = provider;
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
      case 'pluginService.listPlugins':
        return structuredClone(server.plugins);
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
          return ok(structuredClone(entry));
        }
        if (input.action === 'update') {
          const entry = (board.cards ?? []).find((row) => row.id === input.id);
          if (entry === undefined) return { ok: false, error: { code: 'BOARD_CARD_NOT_FOUND', message: `no card ${input.id}` } };
          Object.assign(entry, { ...input.patch, revision: input.expectedRevision + 1, updatedAt: now() });
          return ok(structuredClone(entry));
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
          if (frame.scope !== 'core' || frame.service !== undefined || frame.event !== 'events') throw invalid(`Unsupported fixture subscription: ${frame.scope}.${frame.service ?? ''}.${frame.event}`, 40401);
          if (state.subscriptions.has(frame.id)) throw invalid('id already in use');
          state.subscriptions.set(frame.id, frame);
          send({ type: 'subscribed', id: frame.id });
          return;
        }
        if (frame.type !== 'view_attach') throw invalid(`Unsupported fixture frame: ${frame.type}`, 40401);
        const input = parse(view.sessionViewSubscribeInputSchema, frame.data?.input);
        const generation = frame.data?.generation;
        if (!Number.isInteger(generation) || generation < 0) throw invalid('invalid generation');
        const session = this.server.sessions.get(frame.sessionId);
        if (session === undefined) throw invalid('session not found', 40401);
        const previous = state.views.get(frame.id);
        const active = { id: frame.id, sessionId: frame.sessionId, input, generation };
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
            this.signal(socket, active, { type: 'transcript', event: { ...event, snapshot: redactSnapshotForGrade(grade, event.snapshot) } });
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
    this.server.sendFrame(socket, { type: 'view_signal', id: active.id, data: parse(view.sessionViewSignalSchema, { ...signal, generation: active.generation }) });
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
      if (data !== undefined) for (const id of state.subscriptions.keys()) this.server.sendFrame(socket, { type: 'event', id, data });
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
      this.signal(socket, active, { type: 'transcript', event: batch === undefined ? { ...event, snapshot: redactSnapshotForGrade(grade, event.snapshot) } : event });
    }
  }
}
