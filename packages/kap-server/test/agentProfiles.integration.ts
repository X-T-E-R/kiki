import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_WIRE_RECORD_KEY,
  AgentProfileSourceDiagnosticCodes,
  IAgentExecutorRegistry,
  IAgentLifecycleService,
  IAgentProfileRegistry,
  IAgentProfileService,
  IAgentUsageService,
  IAppendLogStore,
  IConfigService,
  ILogService,
  IModelService,
  ISessionAgentProfileCatalog,
  ISessionContext,
  ISessionInteractionService,
  ISessionManager,
  ISessionMetadata,
  ISubagentTool,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  normalizeAgentProfile,
  type AgentProfileCatalogSnapshot,
  type AgentProfileRegistration,
} from '@kiki/agent-core-v2';
import { IAgentPlanService } from '@kiki/agent-core-v2/features/plan/plan';
import { ISessionDispatchService } from '@kiki/agent-core-v2/session/dispatch/dispatch';
import { evaluateDispatchAdmission } from '@kiki/agent-core-v2/session/dispatch/launchPolicy';
import { SHIPPED_AGENT_PROFILE_TEMPLATES } from '@kiki/agent-core-v2/app/shippedAgentProfiles/shippedAgentProfiles';
import { ErrorCode, listNamedAgentProfilesResponseSchema, agentCapabilitiesResponseSchema, listShippedAgentProfilesResponseSchema } from '@kiki/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKlient } from '@kiki/klient/http';
import { type RunningServer, startServer } from '../src/start';
import { registerAgentProfilesRoute } from '../src/routes/agentProfiles';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { panelSkills } from '../src/routes/agentPanelCapabilities';
import { acquireWorkspaceProfileCatalog } from '../src/routes/agentProfileCapabilities';
import {
  saveSubagentProfileToolSettings,
  searchSubagentToolCatalog,
  subagentProfileToolDraft,
  subagentProfileToolFields,
  subagentSessionToolStates,
} from '../../session-core/src/settings/subagentToolSettings';
import { isToolActiveComposed } from '@kiki/agent-core-v2/agent/toolPolicy/evaluate';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('GET /api/agents', () => {
  it('projects skill origins and invocation restrictions without returning skill bodies', () => {
    const shared = { name: 'example', description: 'Example skill', path: '/fixture/skills/example', dir: '/fixture/skills', content: 'PRIVATE SKILL BODY' };
    const skills = panelSkills([
      { ...shared, source: 'project', metadata: { disableModelInvocation: true } },
      { ...shared, name: 'global-example', source: 'user', metadata: {} },
      { ...shared, name: 'global-extra', source: 'extra', sourceRoot: '/configured/skills', metadata: {} },
      { ...shared, name: 'plugin-example', source: 'extra', plugin: { id: 'example-plugin' }, metadata: {} },
    ], true);
    expect(skills).toMatchObject([
      { scope: 'workspace', source: 'project', source_kind: 'project', state: 'disabled', disable_model_invocation: true,
        unavailable_reason_code: 'skill_model_invocation_disabled' },
      { scope: 'global', source: 'user', source_kind: 'user', state: 'enabled' },
      { scope: 'global', source: 'extra', source_kind: 'extra', source_root: '/configured/skills' },
      { scope: 'global', source: 'extra', source_kind: 'plugin' },
    ]);
    expect(JSON.stringify(skills)).not.toContain('PRIVATE SKILL BODY');
    expect(panelSkills([{ ...shared, source: 'builtin', metadata: { argumentHint: 'arg1' } }], false)[0]).toMatchObject({
      state: 'disabled',
      argument_hint: 'arg1',
      unavailable_reason_code: 'skill_tool_inactive',
    });
  });

  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-agent-profiles-'));
  });

  afterEach(async () => {
    if (server !== undefined) await server.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('saves and re-reads subagent tool settings without overriding global or parent restrictions', async () => {
    const configText = '[tools]\ndisabled = ["Bash"]\n';
    await writeFile(join(home!, 'config.toml'), configText);
    await mkdir(join(home!, 'agents'), { recursive: true });
    const path = join(home!, 'agents', 'example-tool-reader.md');
    await writeFile(path, [
      '---', 'name: example-tool-reader', 'description: Fixture tool reader',
      'tools: [Bash, Read, AskUserQuestion]', 'disallowedTools: [Write]',
      'spawn_constraints:', '  disallowed_tools: [Edit]', '---', 'Keep this fixture prompt.', '',
    ].join('\n'));
    await writeFile(join(home!, 'agents', 'example-external.md'), [
      '---', 'name: example-external', 'description: Fixture external executor', 'executor: claude-acp',
      'tools: [Bash]', 'disallowedTools: [Read]', '---', 'External fixture prompt.', '',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const klient = createKlient({ endpoint: base, token: server.localOwnerToken });
    try {
      const rest = klient.rest;
      if (rest === undefined) throw new Error('HTTP client has no REST capability');
      const initialCatalog = await rest.agents.list({ cwd: home, effective: true });
      const initial = initialCatalog.items.find((item) => item.name === 'example-tool-reader')!;
      expect(initial).toMatchObject({ source: 'user', source_file: path.replaceAll('\\', '/'), tools: ['Bash', 'Read', 'AskUserQuestion'] });
      const external = initialCatalog.items.find((item) => item.name === 'example-external')!;
      expect(subagentProfileToolFields(external)).toMatchObject([
        { field: 'tools', executor: 'claude-acp', applicability: 'ignored', reason: 'Tools are controlled by the external executor' },
        { field: 'disallowed_tools', applicability: 'ignored', reason: 'Tools are controlled by the external executor' },
      ]);
      const client = {
        updateNamedAgentProfile: rest.agents.update,
        listNamedAgentProfiles: rest.agents.list,
      };
      const denied = await saveSubagentProfileToolSettings(client, initial, {
        tools: initial.tools!, disallowedTools: ['Write', 'Bash'],
      });
      expect(denied.disallowed_tools).toEqual(['Write', 'Bash']);
      expect(denied.tools).toEqual(initial.tools);
      const allowed = await saveSubagentProfileToolSettings(client, denied, {
        tools: ['Read', 'Bash'], disallowedTools: ['Write'],
      });
      expect(allowed.tools).toEqual(['Read', 'Bash']);
      expect(allowed.disallowed_tools).toEqual(['Write']);
      const catalog = await rest.agents.list({ workspace_id: initial.workspace_id });
      expect(catalog.items.find((item) => item.source_file === initial.source_file)).toMatchObject({ tools: ['Read', 'Bash'], disallowed_tools: ['Write'] });
      const fileText = await readFile(path, 'utf8');
      expect(fileText).toContain('Keep this fixture prompt.');
      expect(fileText).toContain('spawn_constraints:');
      expect(fileText).toContain('Edit');
      expect(await readFile(join(home!, 'config.toml'), 'utf8')).toBe(configText);
      const panel = await klient.global.agentPanel.read({ workspace_id: initial.workspace_id!, profile: initial.name });
      expect(panel.context).toBe('draft');
      expect(panel.tools?.find((tool) => tool.name === 'Bash')).toMatchObject({ state: 'disabled', unavailable_reason_code: 'draft_policy_disabled' });
      expect(subagentSessionToolStates(panel, undefined)).toBeUndefined();
      expect(subagentSessionToolStates(panel, 'main')).toBeUndefined();
      const layers = { profile: { tools: allowed.tools, disallowedTools: allowed.disallowed_tools }, global: { disabled: ['Bash'] },
        subagent: { explicitProfileTools: allowed.tools, allowedTools: ['AskUserQuestion', 'BoardRead'] } };
      expect(isToolActiveComposed(layers, 'Bash')).toBe(false);
      expect(isToolActiveComposed({ ...layers, profile: { tools: ['AskUserQuestion'] } }, 'AskUserQuestion')).toBe(true);
      expect(isToolActiveComposed({ ...layers, profile: { tools: ['AskUserQuestion'] } }, 'MemoryWrite')).toBe(false);
      expect(isToolActiveComposed({ ...layers, profile: { tools: ['AskUserQuestion'] }, global: { disabled: ['AskUserQuestion'] } }, 'AskUserQuestion')).toBe(false);
      expect(isToolActiveComposed({ ...layers, global: undefined, sessionDisabledTools: ['Bash'] }, 'Bash')).toBe(false);
      const empty = await saveSubagentProfileToolSettings(client, allowed, { tools: [], disallowedTools: [] });
      expect(subagentProfileToolDraft(empty)).toEqual({ tools: [], disallowedTools: [] });
      const inherited = await saveSubagentProfileToolSettings(client, empty, { tools: null, disallowedTools: null });
      expect(subagentProfileToolDraft(inherited)).toEqual({ tools: null, disallowedTools: null });
      expect(searchSubagentToolCatalog((await rest.runtime.listTools()).tools, 'Bash')).toEqual([]);
    } finally {
      await klient.close();
    }
  });

  it('previews unsaved canonical menu changes and keeps live and cold model domains frozen', async () => {
    await writeFile(join(home!, 'config.toml'), [
      'default_model = "fixture/a"', '[providers.stub]', 'type = "openai"',
      'base_url = "http://127.0.0.1:9999"', 'api_key = "YOUR_API_KEY"',
      ...['a', 'b', 'c'].flatMap((alias) => [`[models."fixture/${alias}"]`, 'provider = "stub"', `model = "${alias}"`, 'max_context_size = 1000']),
      '[subagent]', 'deny_models = ["fixture/a"]',
    ].join('\n'));
    await mkdir(join(home!, 'agents'), { recursive: true });
    const path = join(home!, 'agents', 'menu-main.md');
    const text = [
      '---', 'name: menu-main', 'description: Menu main', 'main: true',
      'model_alias: a', 'restrict_models_to_menu: true',
      'model_profiles:', '  - alias: b', '    when: advisory only', '    deny_models: [b]', '---', 'Prompt.', '',
    ].join('\n');
    await writeFile(path, text);
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const list = async () => {
      const response = await authedFetch(server!, base, `/api/agents?cwd=${encodeURIComponent(home!)}&effective=true`);
      const body = await response.json() as Envelope<unknown>;
      expect(body.code).toBe(0);
      return listNamedAgentProfilesResponseSchema.parse(body.data).items.find((item) => item.name === 'menu-main')!;
    };
    const initial = await list();
    expect(initial).toMatchObject({
      restrict_models_to_menu: true,
      declared_model_menu: { aliases: ['b'], default_alias: 'a', identities: ['fixture/b', 'fixture/a'] },
      effective_model_aliases: ['fixture/a', 'a'],
    });
    const preview = async (draft: import('@kiki/protocol').AgentModelMenuDraft) => {
      const response = await authedFetch(server!, base, '/api/agents/menu-main/model-menu:preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: initial.workspace_id, source_file: initial.source_file, draft }),
      });
      const body = await response.json() as Envelope<import('@kiki/protocol').AgentModelMenuPreviewResponse>;
      expect(body.code).toBe(0);
      return body.data;
    };
    expect(await preview({ pinned_model_alias: 'fixture/a' })).toMatchObject({ added_model_identities: [], removed_model_identities: [] });
    const draft = { pinned_model_alias: 'c', model_profiles: [{ alias: 'b' }] };
    expect(await preview(draft)).toEqual({
      restrict_models_to_menu: true,
      declared_model_menu: { aliases: ['b'], default_alias: 'c', identities: ['fixture/b', 'fixture/c'] },
      effective_model_aliases: ['fixture/c', 'c'],
      model_constraints_active: true,
      added_model_identities: ['fixture/c'], removed_model_identities: ['fixture/a'],
    });
    expect((await preview({ main: false })).effective_model_aliases).toEqual([]);
    expect(await preview({ pinned_model_alias: null, model_profiles: [] })).toMatchObject({
      effective_model_aliases: [], added_model_identities: [], removed_model_identities: ['fixture/b', 'fixture/a'],
    });
    expect(await readFile(path, 'utf8')).toBe(text);
    const created = await (await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'menu-main', model: 'fixture/c' } }),
    })).json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const manager = server.core.accessor.get(ISessionManager);
    const mainBinding = manager.get(created.data.id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService);
    expect(mainBinding.data()).toMatchObject({ modelAlias: 'fixture/c', bindingAdvisories: [expect.objectContaining({
      code: 'model_not_allowed', ruleSource: 'profile:menu-main.restrict_models_to_menu',
    })] });
    await mainBinding.setModel('fixture/b');
    expect(mainBinding.data()).toMatchObject({ modelAlias: 'fixture/b', bindingAdvisories: [expect.objectContaining({ code: 'model_denied' })] });
    await mainBinding.setModel('fixture/a');
    expect(mainBinding.data().bindingAdvisories).toEqual([]);
    const update = await authedFetch(server, base, '/api/agents/menu-main', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: initial.workspace_id, scope: 'user', source_file: initial.source_file, ...draft }),
    });
    expect((await update.json() as Envelope<unknown>).code).toBe(0);
    expect((await list()).effective_model_aliases).toEqual(['fixture/c', 'c']);
    const frozen = async () => {
      const response = await authedFetch(server!, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`);
      const body = await response.json() as Envelope<unknown>;
      expect(body.code).toBe(0);
      const data = agentCapabilitiesResponseSchema.parse(body.data);
      const klient = createKlient({ endpoint: base, token: server!.localOwnerToken });
      try {
        const typed = await klient.global.agentPanel.read({ session_id: created.data.id, agent_id: 'main' });
        expect(typed.profile).toEqual(data.profile);
        expect(typed.live).toBe(data.live);
      } finally {
        await klient.close();
      }
      return data;
    };
    expect((await frozen()).profile).toMatchObject({
      restrict_models_to_menu: true,
      declared_model_menu: initial.declared_model_menu,
      effective_model_aliases: initial.effective_model_aliases,
    });
    await manager.close(created.data.id);
    const cold = await frozen();
    expect(cold.live).toBe(false);
    expect(cold.profile).toMatchObject({ declared_model_menu: initial.declared_model_menu, effective_model_aliases: initial.effective_model_aliases });
    expect(manager.get(created.data.id)).toBeUndefined();
  });

  it('round-trips identity prompts through REST and exposes bound diagnostics through the typed panel facade', async () => {
    await writeFile(join(home!, 'config.toml'), 'default_model = "stub"\n[providers.stub]\ntype = "openai"\nbase_url = "http://127.0.0.1:9999"\napi_key = "YOUR_API_KEY"\n[models.stub]\nprovider = "stub"\nmodel = "stub"\nmax_context_size = 1000\n');
    await mkdir(join(home!, 'agents'), { recursive: true });
    await writeFile(join(home!, 'agents', 'prompt-main.md'), '---\nname: prompt-main\ndescription: Prompt main\nmain: true\nmodel_alias: stub\n---\nRole body.\n');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const created = await (await authedFetch(server, base, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'prompt-main' } }) })).json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const klient = createKlient({ endpoint: base, token: server.localOwnerToken });
    try {
      const list = async () => listNamedAgentProfilesResponseSchema.parse((await (await authedFetch(server!, base, `/api/agents?cwd=${encodeURIComponent(home!)}`)).json() as Envelope<unknown>).data).items.find((item) => item.name === 'prompt-main')!;
      const initial = await list();
      const patch = async (changes: Record<string, unknown>) => (await (await authedFetch(server!, base, '/api/agents/prompt-main', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: initial.workspace_id, scope: 'user', ...changes }) })).json() as Envelope<unknown>);
      const model = { alias: 'stub', prompt_mode: 'append', prompt: 'COMMON BODY', main: { prompt_mode: 'append', prompt: 'MAIN BODY' }, independent: 'off', prompt_overrides: { fields: { 'system.shared': 'MODEL FIELD' }, main: 'off' } };
      expect(await patch({ prompt_overrides: { files: ['missing-common.toml'], fields: { 'system.shared': 'ROLE FIELD' }, main: { fields: { 'system.shared': 'MAIN FIELD' } } }, model_profiles: [model], allowed_subagents: [{ name: 'explore', model_prompts: 'replace', model_profiles: [{ alias: 'stub', prompt_overrides: { fields: { 'system.shared': 'LEASE FIELD' } } }] }] })).toMatchObject({ code: 0 });
      expect(await list()).toMatchObject({ prompt_overrides: { main: { fields: { 'system.shared': 'MAIN FIELD' } } }, model_profiles: [model], allowed_subagents: [{ name: 'explore', model_prompts: 'replace', model_profiles: [{ prompt_overrides: { fields: { 'system.shared': 'LEASE FIELD' } } }] }] });
      expect(await patch({ model_profiles: [{ alias: 'stub', when: 'Updated menu only' }] })).toMatchObject({ code: 0 });
      expect((await list()).model_profiles?.[0]).toMatchObject(model);
      const unchecked = await klient.global.agentPanel.read({ session_id: created.data.id, agent_id: 'main' });
      expect(unchecked.prompt?.file_checks).toBeUndefined();
      const checked = await klient.global.agentPanel.read({ session_id: created.data.id, agent_id: 'main', check_all_prompt_files: true });
      expect(checked.prompt?.file_checks).toMatchObject([{ surface: 'profile', branch: 'common', path: 'missing-common.toml', status: 'error' }]);
      expect(checked.prompt?.binding_revision).toBe(unchecked.prompt?.binding_revision);
      const rawCheck = await (await authedFetch(server, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=main&check_all_prompt_files=true`)).json() as Envelope<unknown>;
      expect(rawCheck.code).toBe(0);
      expect(agentCapabilitiesResponseSchema.parse(rawCheck.data).prompt?.file_checks).toEqual(checked.prompt?.file_checks);
      expect(await patch({ model_profiles: [{ alias: 'stub', prompt: null }] })).not.toMatchObject({ code: 0 });
      expect(await patch({ model_profiles: [{ alias: 'stub', main: null, independent: null, prompt_mode: null, prompt: null, prompt_overrides: null }], prompt_overrides: null, allowed_subagents: [{ name: 'explore', model_prompts: 'preserve' }] })).toMatchObject({ code: 0 });
      const cleared = await list();
      expect(cleared.prompt_overrides).toBeUndefined();
      expect(cleared.model_profiles?.[0]).toMatchObject({ alias: 'stub', when: 'Updated menu only' });
      for (const field of ['main', 'independent', 'prompt', 'prompt_mode', 'prompt_overrides']) expect(cleared.model_profiles?.[0]).not.toHaveProperty(field);
      expect(cleared.allowed_subagents?.[0]).toMatchObject({ name: 'explore', model_prompts: 'preserve' });
      const live = await klient.global.agentPanel.read({ session_id: created.data.id, agent_id: 'main' });
      expect(live.prompt).toMatchObject({ identity: { delegation_position: 'main', model_alias: 'stub', executor: 'native' }, apply_on: 'next-binding-or-context-rebuild' });
      expect(live.prompt?.binding_revision).toBeTruthy();
      expect(live.prompt?.request).toBeUndefined();
      await server.core.accessor.get(ISessionManager).close(created.data.id);
      const cold = await klient.global.agentPanel.read({ session_id: created.data.id, agent_id: 'main', check_all_prompt_files: true });
      expect(cold.live).toBe(false);
      expect(cold.prompt?.binding_revision).toBe(live.prompt?.binding_revision);
      expect(cold.prompt?.request).toBeUndefined();
      expect(cold.prompt?.file_checks).toEqual([]);
    } finally { await klient.close(); }
  });

  it('persists explicit context groups and removes the opt-in through REST', async () => {
    await mkdir(join(home!, 'agents'), { recursive: true });
    const path = join(home!, 'agents', 'context-main.md');
    await writeFile(path, '---\nname: context-main\ndescription: External main\nmain: true\nexecutor: claude-acp\n---\nPrompt.\n');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const created = await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    expect((await created.json() as Envelope<unknown>).code).toBe(0);
    const list = async () => {
      const response = await authedFetch(server!, base, '/api/agents');
      const body = await response.json() as Envelope<unknown>;
      return listNamedAgentProfilesResponseSchema.parse(body.data).items.find((profile) => profile.name === 'context-main');
    };
    const initial = await list();
    expect(initial).toBeDefined();
    expect(initial?.kiki_context).toBeUndefined();
    for (const groups of [['memory', 'board', 'cron', 'threads', 'history', 'hooks'], [], null]) {
      const response = await authedFetch(server, base, '/api/agents/context-main', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'user', workspace_id: initial!.workspace_id, kiki_context: groups }),
      });
      expect(await response.json()).toMatchObject({ code: 0 });
      expect((await list())?.kiki_context).toEqual(groups ?? undefined);
      if (groups === null) expect(await readFile(path, 'utf8')).not.toContain('kiki_context:');
      else expect(await readFile(path, 'utf8')).toContain('kiki_context:');
    }
  });

  it('lists managed adapter releases without installing and rejects unknown adapter IDs', async () => {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const response = await authedFetch(server, base, '/api/executors/installations');
    expect(response.status).toBe(200);
    const listed = await response.json() as Envelope<{
      items: Array<{ id: string; release: { version: string }; phase: string; active?: unknown }>;
    }>;
    expect(listed.code).toBe(0);
    expect(listed.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'claude-acp', release: expect.objectContaining({ version: '0.84.0' }), phase: 'idle' }),
      expect.objectContaining({ id: 'codex-acp', release: expect.objectContaining({ version: '2.0.0' }), phase: 'idle' }),
    ]));
    expect(listed.data.items.every((item) => item.active === undefined)).toBe(true);

    const unknown = await authedFetch(server, base, '/api/executors/constructor/install', { method: 'POST' });
    expect((await unknown.json() as Envelope<unknown>).code).toBe(ErrorCode.AGENT_PROFILE_NOT_FOUND);
  });

  it('previews user profiles before any workspace exists and binds them in an automatic workspace', async () => {
    await writeFile(join(home!, 'config.toml'), [
      'default_model = "stub"', '[providers.stub]', 'type = "openai"',
      'base_url = "http://127.0.0.1:9999"', 'api_key = "YOUR_API_KEY"',
      '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
    ].join('\n'));
    await mkdir(join(home!, 'agents'), { recursive: true });
    await writeFile(join(home!, 'agents', 'auto-lead.md'), [
      '---', 'name: auto-lead', 'description: Automatic workspace lead', 'main: true',
      'model_alias: stub', '---', 'Lead the task.', '',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    const readPreview = async () => listNamedAgentProfilesResponseSchema.parse(
      ((await (await authedFetch(server!, base, '/api/agents?unscoped=true')).json()) as Envelope<unknown>).data,
    );
    const preview = await readPreview();
    expect(preview.complete).toBe(true);
    expect(preview.items.find((item) => item.name === 'auto-lead')).toMatchObject({
      source: 'user', main: true, disabled: false, pinned_model_alias: 'stub',
    });
    expect(preview.items.every((item) => item.workspace_id === undefined && item.workspace_ids === undefined)).toBe(true);
    const workspaces = await (await authedFetch(server, base, '/api/workspaces')).json() as Envelope<{ items: unknown[] }>;
    expect(workspaces.data.items).toEqual([]);
    expect(server.core.accessor.get(IWorkspaceInstanceManager).list()).toEqual([]);
    const created = await (await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_config: { profile: 'auto-lead' } }),
    })).json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const session = server.core.accessor.get(ISessionManager).get(created.data.id)!;
    expect(session.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService).data().profileName).toBe('auto-lead');
    const cwd = join(home!, 'manual-project');
    await mkdir(join(cwd, '.kiki', 'agents'), { recursive: true });
    await writeFile(join(cwd, '.kiki', 'agents', 'project-only.md'), '---\nname: project-only\ndescription: Project lead\nmain: true\n---\nProject only.\n');
    const scoped = await (await authedFetch(server, base, `/api/agents?cwd=${encodeURIComponent(cwd)}&effective=true`)).json() as Envelope<unknown>;
    expect(listNamedAgentProfilesResponseSchema.parse(scoped.data).items.some((item) => item.name === 'project-only')).toBe(true);
    const manual = await (await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd }, agent_config: { profile: 'project-only' } }),
    })).json() as Envelope<{ id: string }>;
    expect(manual.code).toBe(0);
    expect(server.core.accessor.get(ISessionManager).get(manual.data.id)!.accessor.get(IAgentLifecycleService)
      .get('main')!.accessor.get(IAgentProfileService).data().profileName).toBe('project-only');
    expect((await readPreview()).items.some((item) => item.name === 'project-only')).toBe(false);
  });

  it('probes draft directories without registration or Programs and registers once on submit', async () => {
    await writeFile(join(home!, 'config.toml'), [
      'default_model = "stub"', '[providers.stub]', 'type = "openai"',
      'base_url = "http://127.0.0.1:9999"', 'api_key = "YOUR_API_KEY"',
      '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
    ].join('\n'));
    const cwd = join(home!, 'draft-project');
    await mkdir(join(cwd, '.kiki', 'agents'), { recursive: true });
    await mkdir(join(cwd, '.kiki', 'skills', 'draft-skill'), { recursive: true });
    await writeFile(join(cwd, '.kiki', 'agents', 'draft-lead.md'), '---\nname: draft-lead\ndescription: Draft lead\nmain: true\n---\nLead the task.\n');
    await writeFile(join(cwd, '.kiki', 'skills', 'draft-skill', 'SKILL.md'), '---\nname: draft-skill\ndescription: Draft skill\n---\nUse this skill.\n');
    await writeFile(join(cwd, 'example.txt'), 'example');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0,
      homeDir: home, instancesDir: join(home!, 'instances'), logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    const registry = server.core.accessor.get(IWorkspaceService);
    const touched = vi.spyOn(registry, 'createOrTouch');
    const manager = server.core.accessor.get(IWorkspaceInstanceManager);
    const before = await registry.list();
    const read = async (path: string) => (await (await authedFetch(server!, base, path)).json()) as Envelope<unknown>;
    const post = async (path: string, body: unknown) => (await (await authedFetch(server!, base, path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).json()) as Envelope<unknown>;
    for (const root of [home!, cwd]) {
      const catalog = await read(`/api/agents?cwd=${encodeURIComponent(root)}&effective=true`);
      expect(catalog.code).toBe(0);
      const panel = await read(`/api/agents/capabilities?cwd=${encodeURIComponent(root)}&profile=${root === cwd ? 'draft-lead' : 'agent'}`);
      expect(panel.code).toBe(0);
      if (root === cwd) expect(agentCapabilitiesResponseSchema.parse(panel.data).skills?.some((skill) => skill.name === 'draft-skill')).toBe(true);
      const files = await post('/api/workspace/fs:search', { workspace: root, query: 'example' });
      expect(files.code).toBe(0);
      expect((await post('/api/workspace/fs:suggest', { workspace: root, query: 'example' })).code).toBe(0);
      expect((await post(`/api/sessions/${encodeURIComponent(root)}/fs:search`, { query: 'example' })).code).toBe(0);
    }
    expect(touched).not.toHaveBeenCalled();
    expect(await registry.list()).toEqual(before);
    expect(manager.list()).toHaveLength(0);
    const missing = await read(`/api/agents?cwd=${encodeURIComponent(join(cwd, 'missing'))}&effective=true`);
    expect(missing.code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
    expect((await read(`/api/agents?cwd=${encodeURIComponent(join(cwd, 'example.txt'))}&effective=true`)).code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
    expect((await post('/api/workspace/fs:suggest', { workspace: join(cwd, 'missing'), query: 'example' })).code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
    expect(touched).not.toHaveBeenCalled();
    const created = await post('/api/sessions', { metadata: { cwd }, agent_config: { profile: 'draft-lead' } });
    expect(created.code).toBe(0);
    expect(touched).toHaveBeenCalledTimes(1);
    const registered = (await registry.list()).find((workspace) => workspace.root === cwd)!;
    expect(registered).toBeDefined();
    expect(manager.list()).toHaveLength(1);
    const equivalentCwd = process.platform === 'win32' ? `${cwd.toUpperCase().replaceAll('\\', '/')}/` : `${cwd}/`;
    expect((await post('/api/sessions', { workspace_id: registered.id, metadata: { cwd: equivalentCwd } })).code).toBe(0);
    expect((await post('/api/sessions', { workspace_id: registered.id, metadata: { cwd: join(cwd, 'other') } })).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(touched).toHaveBeenCalledTimes(2);
  });

  it('keeps unscoped previews effective across SYSTEM.md, global extras, disable state and private profiles', async () => {
    const extra = join(home!, 'global-agents');
    await writeFile(join(home!, 'config.toml'), [
      `extra_agent_dirs = [${JSON.stringify(extra.replaceAll('\\', '/'))}, "relative-agents"]`,
      'skip_builtin_profile_installation = ["agent"]',
      'disabled_named_profiles = ["disabled-lead", "agent"]',
    ].join('\n'));
    const file = (name: string, fields = '') => `---\nname: ${name}\ndescription: Example lead\nmain: true\n${fields}---\nLead the task.\n`;
    await mkdir(join(home!, 'agents'), { recursive: true });
    await mkdir(extra, { recursive: true });
    await mkdir(join(home!, 'relative-agents'), { recursive: true });
    await writeFile(join(home!, 'SYSTEM.md'), '---\ndescription: User default\nmain: true\n---\nUser default instructions.\n');
    await writeFile(join(home!, 'agents', 'shared-lead.md'), file('shared-lead'));
    await writeFile(join(home!, 'agents', 'disabled-lead.md'), file('disabled-lead'));
    await writeFile(join(home!, 'agents', 'private-lead.md'), file('private-lead', 'private: true\n'));
    await writeFile(join(extra, 'shared-lead.md'), file('shared-lead'));
    await writeFile(join(extra, 'extra-lead.md'), file('extra-lead'));
    await writeFile(join(home!, 'relative-agents', 'relative-lead.md'), file('relative-lead'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const read = async () => listNamedAgentProfilesResponseSchema.parse(
      ((await (await authedFetch(server!, base, '/api/agents?unscoped=true')).json()) as Envelope<unknown>).data,
    );
    const preview = await read();
    expect(preview.items.filter((item) => item.name === 'shared-lead')).toMatchObject([{ source: 'extra' }]);
    expect(preview.items.find((item) => item.name === 'extra-lead')).toMatchObject({ source: 'extra' });
    expect(preview.items.find((item) => item.name === 'agent')).toMatchObject({ source: 'user', main: true, disabled: false });
    expect(preview.items.some((item) => ['disabled-lead', 'private-lead', 'relative-lead'].includes(item.name))).toBe(false);
    expect(server.core.accessor.get(IWorkspaceInstanceManager).list()).toEqual([]);
    expect(server.core.accessor.get(IAgentProfileRegistry).entries().some((entry) => entry.workspaceKey === '__unscoped_profile_preview__')).toBe(false);
    await writeFile(join(home!, 'agents', 'new-lead.md'), file('new-lead'));
    await vi.waitFor(async () => {
      expect((await read()).items.some((item) => item.name === 'new-lead')).toBe(true);
    }, { timeout: 5000 });
  });

  it('lists executor capabilities and round-trips a file profile spawn constraint patch', async () => {
    await mkdir(join(home!, 'agents'), { recursive: true });
    const profilePath = join(home!, 'agents', 'reviewer.md');
    await writeFile(profilePath, '---\nname: reviewer\ndescription: Reviews changes\nexecutor: codex-app-server\n---\nReview changes.\n');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const executors = (await (await authedFetch(server, base, '/api/executors')).json()) as Envelope<{
      items: Array<{ id: string; label: string; protocol: string; status: string }>;
    }>;
    expect(executors.code).toBe(0);
    expect(executors.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'native', label: 'Kiki', status: 'ready' }),
      expect.objectContaining({ id: 'codex-app-server', label: 'Codex', protocol: 'codex-app-server' }),
    ]));
    const listed = await authedFetch(server, base, `/api/agents?cwd=${encodeURIComponent(home!)}&effective=true`);
    const profiles = listNamedAgentProfilesResponseSchema.parse(((await listed.json()) as Envelope<unknown>).data);
    const reviewer = profiles.items.find((item) => item.name === 'reviewer')!;
    expect(reviewer.executor_fields).toMatchObject({
      prompt: { state: 'mapped' }, pinned_model_alias: { state: 'mapped' },
      tools: { state: 'ignored' }, spawn_constraints: { state: 'applied' },
    });
    const patched = (await (await authedFetch(server, base, '/api/agents/reviewer', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: reviewer.workspace_id, scope: 'user',
        spawn_constraints: { allowed_models: ['provider/model'], disallowed_tools: ['Bash'] } }),
    })).json()) as Envelope<unknown>;
    expect(patched.code).toBe(0);
    expect(patched.data).toMatchObject({ spawn_constraints: {
      allowed_models: ['provider/model'], disallowed_tools: ['Bash'],
    } });
    expect(await readFile(profilePath, 'utf8')).toContain('spawn_constraints:');
    const cleared = (await (await authedFetch(server, base, '/api/agents/reviewer', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: reviewer.workspace_id, scope: 'user', spawn_constraints: null }),
    })).json()) as Envelope<unknown>;
    expect(cleared.code).toBe(0);
    expect(cleared.data).not.toHaveProperty('spawn_constraints');
  });

  it('preserves inherited and explicit subagent policies in the profile projection', async () => {
    await mkdir(join(home!, 'agents'), { recursive: true });
    await writeFile(join(home!, 'agents', 'inherited-policy.md'), [
      '---', 'name: inherited-policy', 'description: Inherits the configured policy', '---',
      'Use the configured subagent policy.', '',
    ].join('\n'));
    await writeFile(join(home!, 'agents', 'strict-policy.md'), [
      '---', 'name: strict-policy', 'description: Preset boundary',
      'allowed_subagents: [explore]', '---', 'Dispatch only the listed profile.', '',
    ].join('\n'));
    await writeFile(join(home!, 'agents', 'advisory-policy.md'), [
      '---', 'name: advisory-policy', 'description: Recommended presets',
      'preferred_subagents: [explore]', '---', 'Recommend the listed profile.', '',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;

    const response = await authedFetch(server, base, `/api/agents?cwd=${encodeURIComponent(home!)}&effective=true`);
    const body = await response.json() as Envelope<unknown>;
    expect(body.code).toBe(0);
    const profiles = listNamedAgentProfilesResponseSchema.parse(body.data).items;
    const find = (name: string) => profiles.find((profile) => profile.name === name);
    const inherited = find('inherited-policy');
    const strict = find('strict-policy');
    const advisory = find('advisory-policy');
    expect(inherited).toBeDefined();
    expect(inherited).not.toHaveProperty('subagent_policy');
    expect(strict).toMatchObject({ allowed_subagents: ['explore'] });
    expect(advisory).toMatchObject({ preferred_subagents: ['explore'] });
    expect(advisory).not.toHaveProperty('allowed_subagents');
  });

  it('previews actual ordered external prompt text and resolved delivery without launching an engine', async () => {
    await mkdir(join(home!, 'agents'), { recursive: true });
    await writeFile(join(home!, 'AGENTS.md'), 'Workspace policy for preview.\n');
    await writeFile(join(home!, 'agents', 'reviewer.md'), [
      '---', 'name: reviewer', 'description: Reviews changes', 'executor: codex-app-server',
      'executor_prompt:', '  delivery: replace', '  include: [agents_md, workspace_info]',
      '  body: Codex-only instructions', '  append: Final instruction', '---', 'Profile fallback.', '',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const listed = await authedFetch(server, base, `/api/agents?cwd=${encodeURIComponent(home!)}&effective=true`);
    const reviewer = listNamedAgentProfilesResponseSchema.parse(((await listed.json()) as Envelope<unknown>).data)
      .items.find((item) => item.name === 'reviewer')!;
    const response = await authedFetch(server, base, '/api/agents/reviewer/executor-prompt:preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: reviewer.workspace_id }),
    });
    const result = await response.json() as Envelope<import('@kiki/protocol').ExecutorPromptPreviewResponse>;
    expect(result.code).toBe(0);
    expect(result.data.delivery).toEqual({ requested: 'replace', actual: 'replace', downgraded: false });
    expect(result.data.blocks.map((block) => block.id)).toEqual(['body', 'append', 'agents_md', 'workspace_info']);
    expect(result.data.blocks[0]?.text).toBe('Codex-only instructions');
    expect(result.data.blocks[2]?.text).toContain('Workspace policy for preview.');
    expect(result.data.text).toBe(result.data.blocks.map((block) => block.text).join('\n\n'));
    const fallback = await authedFetch(server, base, '/api/agents/reviewer/executor-prompt:preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: reviewer.workspace_id, executor: 'claude-acp' }),
    });
    const downgraded = await fallback.json() as Envelope<import('@kiki/protocol').ExecutorPromptPreviewResponse>;
    expect(downgraded.code).toBe(0);
    expect(downgraded.data.delivery).toEqual({ requested: 'replace', actual: 'preamble', downgraded: true });
    expect(downgraded.data.blocks[0]?.text).toBe('Codex-only instructions');
    const rejected = await authedFetch(server, base, '/api/agents/reviewer/executor-prompt:preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: reviewer.workspace_id, executor: 'native' }),
    });
    expect((await rejected.json() as Envelope<unknown>).code).toBe(ErrorCode.VALIDATION_FAILED);
    const wrongSuffix = await authedFetch(server, base, '/api/agents/reviewer/executor-prompt:anything', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: reviewer.workspace_id }),
    });
    expect((await wrongSuffix.json() as Envelope<unknown>).code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('reuses draft catalog projections until workspace close without retaining a workspace lease', async () => {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const info = vi.spyOn(server.core.accessor.get(ILogService), 'info');
    const [first, second] = await Promise.all([
      acquireWorkspaceProfileCatalog(server.core, { cwd: home! }),
      acquireWorkspaceProfileCatalog(server.core, { cwd: home! }),
    ]);
    const cached = await acquireWorkspaceProfileCatalog(server.core, { cwd: home! });
    expect(first?.catalog).toBe(second?.catalog);
    expect(first?.catalog).toBe(cached?.catalog);
    expect(info).toHaveBeenCalledWith('workspace profile catalog acquisition completed',
      expect.objectContaining({ cache_state: 'hit', outcome: 'ready', duration_ms: expect.any(Number) }));
    await first?.dispose();
    await second?.dispose();
    await cached?.dispose();
    const manager = server.core.accessor.get(IWorkspaceInstanceManager);
    expect(manager.referenceCount(first!.workspaceId)).toBe(0);
    await manager.close(first!.workspaceId);
    const reopened = await acquireWorkspaceProfileCatalog(server.core, { cwd: home! });
    expect(reopened?.catalog).not.toBe(first?.catalog);
    await reopened?.dispose();
  });

  it.each(['---\ndescription: Custom default\npreferred_subagents: [explore]\n---\nCustom upgraded prompt.'])('keeps SYSTEM main profiles available when subagent discovery is disabled: %s', async (text) => {
    await writeFile(join(home!, 'SYSTEM.md'), text);
    await writeFile(join(home!, 'config.toml'), [
      'disabled_named_profiles = ["agent"]', 'skip_builtin_profile_installation = ["agent"]',
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const query = `cwd=${encodeURIComponent(home!)}`;
    const response = await authedFetch(server, base, `/api/agents?${query}&effective=true`);
    const body = await response.json() as Envelope<unknown>;
    expect(body.code).toBe(0);
    const profile = listNamedAgentProfilesResponseSchema.parse(body.data).items.find((item) => item.name === 'agent');
    expect(profile).toMatchObject({ main: true, disabled: false, source: 'user', source_file: join(home!, 'SYSTEM.md').replaceAll('\\', '/') });
    const capabilities = await authedFetch(server, base, `/api/agents/capabilities?${query}&profile=agent`);
    const capabilityBody = await capabilities.json() as Envelope<unknown>;
    expect(capabilityBody.code).toBe(0);
    const data = agentCapabilitiesResponseSchema.parse(capabilityBody.data);
    expect(data.available).toBe(true);
    expect(data.targets.find((target) => target.profile === 'explore')).toMatchObject({
      recommendation_status: 'preferred', dispatch_policy: 'fixed',
    });
    expect(data.targets.find((target) => target.profile === 'general')).toMatchObject({
      recommendation_status: 'allowed_nonpreferred',
    });
    expect(data.targets.some((target) => target.profile === 'agent')).toBe(false);
    const configured = await authedFetch(server, base, '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subagent: { main_dispatch_policy: 'strict', subagent_dispatch_policy: 'advisory' } }),
    });
    const configBody = await configured.json() as Envelope<unknown>;
    expect(configBody.code).not.toBe(0);
    const refreshedResponse = await authedFetch(server, base, `/api/agents/capabilities?${query}&profile=agent`);
    const refreshed = agentCapabilitiesResponseSchema.parse((await refreshedResponse.json() as Envelope<unknown>).data);
    expect(refreshed.profile?.preferred_subagents).toEqual(['explore']);
    expect(refreshed.targets.find((target) => target.profile === 'general')).toMatchObject({
      recommendation_status: 'allowed_nonpreferred', dispatch_policy: 'fixed',
    });
    const createdResponse = await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'agent', model: 'stub' } }),
    });
    const created = await createdResponse.json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const lifecycle = server.core.accessor.get(ISessionManager).get(created.data.id)!.accessor.get(IAgentLifecycleService);
    expect(lifecycle.get('main')!.accessor.get(IAgentProfileService).data().systemPrompt).toContain(text.split('\n').at(-1));
    expect(lifecycle.list()).toHaveLength(1);
  });

  it('answers capabilities for a cold session without resuming it', async () => {
    await writeFile(join(home!, 'config.toml'), [
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const create = await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'agent', model: 'stub' } }),
    });
    const created = await create.json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const manager = server.core.accessor.get(ISessionManager);
    expect(manager.get(created.data.id)).toBeDefined();
    await manager.close(created.data.id);
    expect(manager.get(created.data.id)).toBeUndefined();
    const response = await authedFetch(server, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`);
    const body = await response.json() as Envelope<unknown>;
    expect(body.code).toBe(0);
    const data = agentCapabilitiesResponseSchema.parse(body.data);
    expect(data).toMatchObject({
      live: false, available: false, unavailable_reason_code: 'session_or_agent_not_live',
    });
    expect(data.unavailable_reason).toContain('not live');
    expect(manager.get(created.data.id)).toBeUndefined();
  });

  it('keeps live capability projection on the real-time path', async () => {
    await writeFile(join(home!, 'config.toml'), [
      'default_model = "stub"',
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"',
      'max_context_size = 1000', 'capabilities = ["thinking"]', 'support_efforts = ["low", "high"]', 'default_effort = "high"',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const created = await (await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'agent', model: 'stub', thinking: 'low' } }),
    })).json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const response = await authedFetch(server, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`);
    const body = await response.json() as Envelope<unknown>;
    expect(body.code).toBe(0);
    const data = agentCapabilitiesResponseSchema.parse(body.data);
    expect(data).toMatchObject({
      context: 'live', live: true,
      owner: { agent_id: 'main', profile: 'agent' },
      profile: {
        name: 'agent', source: 'user', model: 'stub', model_source: 'profile',
        thinking_effort: 'low', effort_source: 'model', can_spawn_subagents: true,
      },
    });
    expect(data.profile?.source_file?.replaceAll('\\', '/')).toMatch(/agents\/builtin\/agent\.md$/);
    expect(data.tools?.length).toBeGreaterThan(0);
  });

  it('returns a durable capability snapshot after a child agent is disposed', async () => {
    await writeFile(join(home!, 'config.toml'), [
      'default_model = "stub"', '[subagent]', 'subagent_dispatch_policy = "advisory"',
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"',
      'max_context_size = 1000', 'capabilities = ["thinking"]', 'support_efforts = ["low", "high"]', 'default_effort = "high"',
      '[models.stub-alt]', 'provider = "stub"', 'model = "stub-alt"', 'max_context_size = 1000',
      'capabilities = ["thinking"]', 'support_efforts = ["low", "high"]', 'default_effort = "high"',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const created = await (await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'agent', model: 'stub' } }),
    })).json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const manager = server.core.accessor.get(ISessionManager);
    const session = manager.get(created.data.id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({
      agentId: 'agent-snapshot',
      delegator: { kind: 'agent', agentId: 'main' },
      binding: { profile: 'explore', model: 'stub', thinking: 'low' },
    });
    const profile = child.accessor.get(IAgentProfileService);
    expect((await session.accessor.get(ISessionMetadata).read()).agents?.['agent-snapshot']).toMatchObject({
      model: 'stub', thinkingEffort: 'low',
    });
    await profile.setModel('stub-alt');
    profile.setThinking('high');
    const readCapabilities = async () => {
      const response = await authedFetch(server!, base,
        `/api/agents/capabilities?session_id=${created.data.id}&agent_id=agent-snapshot`);
      const body = await response.json() as Envelope<unknown>;
      expect(body.code).toBe(0);
      return agentCapabilitiesResponseSchema.parse(body.data);
    };
    const live = await readCapabilities();
    expect(live).toMatchObject({ context: 'live', live: true, profile: {
      name: 'explore', source: 'user', model: 'stub-alt', thinking_effort: 'high', can_spawn_subagents: false,
    } });
    await lifecycle.remove('agent-snapshot');
    expect(lifecycle.get('agent-snapshot')).toBeUndefined();
    expect(manager.get(created.data.id)).toBe(session);
    const snapshot = await readCapabilities();
    expect(snapshot).toMatchObject({
      context: 'live', live: false, available: true,
      owner: { agent_id: 'agent-snapshot', profile: 'explore' },
      profile: {
        name: 'explore', source: 'user', model: 'stub-alt', model_source: 'profile',
        thinking_effort: 'high', effort_source: 'model', can_spawn_subagents: false,
      },
    });
    expect(snapshot.profile?.source_file).toBe(live.profile?.source_file);
    expect(snapshot.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        launch_allowed: false, launch_unavailable_reason: expect.stringContaining('not live'),
        launch_unavailable_reason_code: 'snapshot_launch_unavailable',
      }),
    ]));
    expect(snapshot.tools?.length).toBeGreaterThan(0);
    expect(snapshot.tools?.every((tool) => tool.state === 'unknown' || tool.state === 'disabled')).toBe(true);
  });

  it('keeps board and main-only tools disabled for an unrestricted child on live and snapshot paths', async () => {
    await mkdir(join(home!, 'agents'), { recursive: true });
    await writeFile(join(home!, 'agents', 'board-default.md'), '---\nname: board-default\ndescription: Default tools\n---\nWork with the default tool policy.');
    await writeFile(join(home!, 'config.toml'), [
      'default_model = "stub"',
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const created = await (await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'agent', model: 'stub' } }),
    })).json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const session = server.core.accessor.get(ISessionManager).get(created.data.id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    await lifecycle.create({
      agentId: 'child-optin',
      delegator: { kind: 'agent', agentId: 'main' },
      binding: { profile: 'board-default', model: 'stub' },
    });
    const readTools = async () => {
      const response = await authedFetch(server!, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=child-optin`);
      const body = await response.json() as Envelope<unknown>;
      expect(body.code).toBe(0);
      return agentCapabilitiesResponseSchema.parse(body.data).tools ?? [];
    };

    const liveDefault = await readTools();
    expect(liveDefault.find((tool) => tool.name === 'BoardRead')?.state).toBe('disabled');
    expect(liveDefault.find((tool) => tool.name === 'BoardWrite')?.state).toBe('disabled');
    expect(liveDefault.find((tool) => tool.name === 'AskUserQuestion')?.state).toBe('disabled');
    expect(liveDefault.find((tool) => tool.name === 'Read')?.state).toBe('enabled');

    await lifecycle.remove('child-optin');
    const snapshot = await readTools();
    expect(snapshot.find((tool) => tool.name === 'BoardRead')?.state).toBe('disabled');
    expect(snapshot.find((tool) => tool.name === 'BoardWrite')?.state).toBe('disabled');
    expect(snapshot.find((tool) => tool.name === 'AskUserQuestion')?.state).toBe('disabled');
    expect(snapshot.find((tool) => tool.name === 'Read')?.state).toBe('unknown');
  });

  it.each(['server', 'profile'] as const)('allows child BoardRead through %s opt-in on the live and snapshot paths', async (optIn) => {
    await mkdir(join(home!, 'agents'), { recursive: true });
    await writeFile(join(home!, 'agents', 'board-reader.md'), [
      '---', 'name: board-reader', 'description: Board reader',
      ...(optIn === 'profile' ? ['tools: [Read, BoardRead]'] : []),
      '---', 'Read authorized board cards.',
    ].join('\n'));
    await writeFile(join(home!, 'config.toml'), [
      'default_model = "stub"',
      '[subagent]', `allowed_tools = ${optIn === 'server' ? '["BoardRead"]' : '[]'}`,
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const created = await (await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'agent', model: 'stub' } }),
    })).json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const session = server.core.accessor.get(ISessionManager).get(created.data.id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    await lifecycle.create({
      agentId: 'child-allowed',
      delegator: { kind: 'agent', agentId: 'main' },
      binding: { profile: 'board-reader', model: 'stub' },
    });
    const readTools = async () => {
      const response = await authedFetch(server!, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=child-allowed`);
      const body = await response.json() as Envelope<unknown>;
      expect(body.code).toBe(0);
      return agentCapabilitiesResponseSchema.parse(body.data).tools ?? [];
    };
    const live = await readTools();
    expect(live.find((tool) => tool.name === 'BoardRead')?.state).toBe('enabled');
    expect(live.find((tool) => tool.name === 'BoardWrite')?.state).toBe('disabled');
    expect(live.find((tool) => tool.name === 'AskUserQuestion')?.state).toBe('disabled');

    await lifecycle.remove('child-allowed');
    const snapshot = await readTools();
    expect(snapshot.find((tool) => tool.name === 'BoardRead')?.state).toBe('unknown');
    expect(snapshot.find((tool) => tool.name === 'BoardWrite')?.state).toBe('disabled');
    expect(snapshot.find((tool) => tool.name === 'AskUserQuestion')?.state).toBe('disabled');
  });

  it('writes the winning SYSTEM source rather than a same-name user file and refreshes draft capabilities', async () => {
    const systemPath = join(home!, 'SYSTEM.md');
    const agentPath = join(home!, 'agents', 'agent.md');
    await mkdir(join(home!, 'agents'), { recursive: true });
    const shadowText = '---\nname: agent\ndescription: Shadow default\noverride: true\n---\nShadow prompt.';
    await writeFile(agentPath, shadowText);
    await writeFile(systemPath, '---\ndescription: Legacy main\n---\nLegacy main prompt.');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const query = `cwd=${encodeURIComponent(home!)}`;
    const listed = await authedFetch(server, base, `/api/agents?${query}&effective=true`);
    const initial = listNamedAgentProfilesResponseSchema.parse((await listed.json() as Envelope<unknown>).data).items.find((item) => item.name === 'agent')!;
    const patch = async (fields: Record<string, unknown>) => {
      const response = await authedFetch(server!, base, '/api/agents/agent', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: initial.workspace_id, scope: 'user', ...fields }),
      });
      return await response.json() as Envelope<unknown>;
    };
    const updated = await patch({ description: 'Edited default' });
    expect(updated.code).toBe(0);
    expect(updated.data).toMatchObject({ main: true, source_file: systemPath.replaceAll('\\', '/'), description: 'Edited default' });
    expect(await readFile(agentPath, 'utf8')).toBe(shadowText);
    expect(await readFile(systemPath, 'utf8')).toContain('Legacy main prompt.');
    const raw = await patch({ raw_text: '---\ndescription: Restricted default\ndisallowedTools: [AgentRun]\n---\nRestricted main prompt.' });
    expect(raw.code).toBe(0);
    const capabilities = await authedFetch(server, base, `/api/agents/capabilities?${query}&profile=agent`);
    const capabilityBody = await capabilities.json() as Envelope<unknown>;
    expect(capabilityBody.code).toBe(0);
    expect(agentCapabilitiesResponseSchema.parse(capabilityBody.data)).toMatchObject({ available: false, targets: expect.arrayContaining([expect.objectContaining({ launch_allowed: false })]) });
    const locator = await patch({ source_file: agentPath.replaceAll('\\', '/'), description: 'Edited shadow' });
    expect(locator.code).toBe(0);
    expect(await readFile(agentPath, 'utf8')).toContain('Edited shadow');
    expect(await readFile(systemPath, 'utf8')).toContain('Restricted main prompt.');
    expect((await patch({ source_file: join(home!, 'unregistered.md'), description: 'Do not create' })).code).toBe(ErrorCode.AGENT_PROFILE_NOT_FOUND);
    const replaced = await patch({ raw_text: '---\ndescription: Edited default\n---\nEdited system prompt.\r\n' });
    expect(replaced.code).toBe(0);
    expect(replaced.data).toMatchObject({ main: true, source_file: systemPath.replaceAll('\\', '/') });
    expect(await readFile(systemPath)).toEqual(Buffer.from('---\ndescription: Edited default\n---\nEdited system prompt.\r\n'));
  });

  it.each(['---\ntools: [Read\n---\nBroken.', '---\ntools: [Read]\nBroken.', '---\n- Read\n---\nBroken.'])('R1 rejects malformed SYSTEM management writes without changing restrictions: %s', async (rawText) => {
    const path = join(home!, 'SYSTEM.md');
    const original = '---\r\ndescription: Restricted default\r\ntools: [Read]\r\nallowed_subagents: []\r\n---\r\nRestricted prompt.\r\n';
    await writeFile(path, original);
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const read = async () => {
      const response = await authedFetch(server!, base, `/api/agents?cwd=${encodeURIComponent(home!)}&effective=true`);
      return listNamedAgentProfilesResponseSchema.parse((await response.json() as Envelope<unknown>).data).items.find((item) => item.name === 'agent')!;
    };
    const before = await read();
    expect(before).toMatchObject({ source: 'user', tools: ['Read'], allowed_subagents: [] });
    const response = await authedFetch(server, base, '/api/agents/agent', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: before.workspace_id, scope: 'user', source_file: before.source_file, raw_text: rawText }),
    });
    expect((await response.json() as Envelope<unknown>).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await readFile(path)).toEqual(Buffer.from(original));
    expect(await read()).toEqual(before);
  });

  it('creates an external main session without a Kiki model pin', async () => {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const executors = server.core.accessor.get(IAgentExecutorRegistry);
    const resolve = executors.resolveExecutable.bind(executors);
    vi.spyOn(executors, 'resolveExecutable').mockImplementation(async (id, options) => id === 'grok-acp'
      ? { descriptor: { ...executors.get(id)!, command: process.execPath, revision: 'fixture' }, options: executors.resolve(id, options ?? {}).options,
        provider: { id: 'fixture-acp', protocol: 'acp-v1', validateOptions: (value) => value as Record<string, string | number | boolean>,
          validateBinding: (binding) => ({ ok: true, binding }), create: () => { throw new Error('Fixture does not launch an external engine'); } } }
      : resolve(id, options));
    server.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'external-main-fixture', priority: 50,
      contribution: { profiles: [normalizeAgentProfile({
        name: 'external-main', definitionId: 'external-main-fixture', main: true,
        executor: 'grok-acp', systemPrompt: () => '',
      })] },
    });
    const response = await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'external-main' } }),
    });
    const created = await response.json() as Envelope<{ id: string }>;
    expect(created.code, JSON.stringify(created)).toBe(0);
    const main = server.core.accessor.get(ISessionManager).get(created.data.id)!
      .accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService);
    expect(main.data()).toMatchObject({ executorId: 'grok-acp', thinkingLevel: 'off', systemPrompt: '' });
    expect(main.data().modelAlias).toBeUndefined();
    expect(main.isRunnable()).toBe(true);
  });

  it.each([undefined, false, true])('preserves effective main on an external executor write: main=%s', async (main) => {
    const path = join(home!, 'agents', 'agent.md');
    await mkdir(join(home!, 'agents'), { recursive: true });
    const original = '---\nname: agent\ndescription: Restricted override\noverride: true\ntools: [Read]\nallowed_subagents: []\n---\nRestricted prompt.';
    await writeFile(path, original);
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    expect(server.core.accessor.get(IAgentExecutorRegistry).get('grok-acp')).toBeDefined();
    const read = async () => {
      const response = await authedFetch(server!, base, `/api/agents?cwd=${encodeURIComponent(home!)}&effective=true`);
      return listNamedAgentProfilesResponseSchema.parse((await response.json() as Envelope<unknown>).data).items.find((item) => item.name === 'agent')!;
    };
    const before = await read();
    expect(before).toMatchObject({ main: true, source: 'user', tools: ['Read'], allowed_subagents: [] });
    const rawText = original.replace('override: true', `override: true\nexecutor: grok-acp${main === undefined ? '' : `\nmain: ${main}`}`);
    const response = await authedFetch(server, base, '/api/agents/agent', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: before.workspace_id, scope: 'user', source_file: before.source_file, raw_text: rawText }),
    });
    const result = await response.json() as Envelope<unknown>;
    expect(result.code).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(rawText);
    expect(await read()).toMatchObject({ main: main !== false, source: 'user', executor: 'grok-acp', tools: ['Read'], allowed_subagents: [] });
  });

  it('projects caller leases and frozen live targets without launching children or exposing private configuration', async () => {
    await writeFile(join(home!, 'config.toml'), [
      'disabled_named_profiles = ["disabled-helper"]',
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"',
      'max_context_size = 1000', '[experimental]', '"agent-profile-routes" = true',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const registry = server.core.accessor.get(IAgentProfileRegistry);
    const helper = (name: string, modelAlias?: string) => normalizeAgentProfile({
      name, definitionId: `definition:${name}`, modelAlias, systemPrompt: () => 'PRIVATE_PROMPT',
    });
    const scoped = helper('private-helper');
    const lead = normalizeAgentProfile({
      name: 'lead', definitionId: 'definition:lead', main: true, tools: ['AgentRun'],
      allowedSubagents: ['leased-helper', 'unbound-helper', 'disabled-helper', 'blocked-helper', 'private-helper', 'missing-helper'],
      subagentLeases: {
        'leased-helper': { name: 'leased-helper', modelAlias: 'stub', thinkingEffort: 'off', allowedModels: ['stub'] },
        'blocked-helper': { name: 'blocked-helper', allowedModels: [] },
        'private-helper': { name: 'private-helper', source: './_private/helper.md', modelAlias: 'stub' },
        'missing-helper': { name: 'missing-helper', source: './_private/missing.md' },
      },
      systemPrompt: () => 'Coordinate work.',
    });
    const registration = registry.register({ sourceId: 'example', priority: 50, contribution: {
      profiles: [lead, helper('leased-helper'), helper('unbound-helper'), helper('disabled-helper'), helper('blocked-helper'), helper('hidden-helper')],
      routes: ['stub', 'denied'].map((modelAlias) => ({
        id: `leased-helper.${modelAlias}`, profile: 'leased-helper', description: 'Route example',
        promptMode: 'inherit' as const, prompt: '', modelAlias, thinkingEffort: 'off',
        overriddenFields: ['modelAlias', 'thinkingEffort'], path: `/example/${modelAlias}.md`,
      })),
      scopedBindings: new Map([[lead.definitionId!, new Map([
        ['private-helper', { parentDefinitionId: lead.definitionId!, alias: 'private-helper', source: './_private/helper.md', lease: { name: 'private-helper', source: './_private/helper.md', modelAlias: 'stub' }, status: 'ready' as const, profile: scoped, sourceDefinitionId: scoped.definitionId }],
        ['missing-helper', { parentDefinitionId: lead.definitionId!, alias: 'missing-helper', source: './_private/missing.md', lease: { name: 'missing-helper', source: './_private/missing.md' }, status: 'unavailable' as const }],
      ])]]),
    } });
    try {
      const create = await authedFetch(server, base, '/api/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'lead', model: 'stub' } }),
      });
      const created = await create.json() as Envelope<{ id: string }>;
      expect(created.code).toBe(0);
      const lifecycle = server.core.accessor.get(ISessionManager).get(created.data.id)!.accessor.get(IAgentLifecycleService);
      const tool = lifecycle.get('main')!.accessor.get(ISubagentTool);
      const description = tool.description;
      const response = await authedFetch(server, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`);
      const body = await response.json() as Envelope<{ targets: Array<{ profile: string; route?: string; defaults_available: boolean; model_alias?: string; model_source?: string; thinking_effort?: string; unavailable_reason?: string }> }>;
      expect(body.code).toBe(0);
      expect(body.data.targets.map((target) => target.route ?? target.profile).toSorted()).toEqual([
        'blocked-helper',
        'explore',
        'general',
        'hidden-helper',
        'leased-helper',
        'leased-helper.denied',
        'leased-helper.stub',
        'private-helper',
        'unbound-helper',
      ]);
      expect(body.data.targets.find((target) => target.route === 'leased-helper.stub')).toMatchObject({ defaults_available: true, model_alias: 'stub', model_source: 'route', thinking_effort: 'off' });
      expect(body.data.targets.find((target) => target.profile === 'leased-helper')).toMatchObject({ defaults_available: true, model_alias: 'stub', model_source: 'caller-lease', thinking_effort: 'off' });
      expect(body.data.targets.find((target) => target.profile === 'private-helper')).toMatchObject({ defaults_available: true, model_alias: 'stub' });
      expect(body.data.targets.find((target) => target.profile === 'unbound-helper')).toMatchObject({
        defaults_available: false, unavailable_reason: expect.stringContaining('No default model'),
        unavailable_reason_code: 'model_not_configured',
      });
      for (const name of ['leased-helper', 'unbound-helper', 'blocked-helper', 'private-helper']) expect(description).toContain(name);
      for (const name of ['hidden-helper', 'explore', 'general']) expect(description).not.toContain(`- ${name}:`);
      expect(JSON.stringify(body.data)).not.toMatch(/PRIVATE_PROMPT|_private|sourceDefinitionId|YOUR_API_KEY/);
      expect(lifecycle.list()).toHaveLength(1);
      await registration.dispose();
      const after = await authedFetch(server, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`);
      const afterBody = await after.json() as Envelope<typeof body.data>;
      expect(afterBody.code).toBe(0);
      expect(afterBody.data.targets.map((target) => target.route ?? target.profile).toSorted()).toEqual(['explore', 'general']);
      expect(tool.description).toBe(description);
    } finally {
      await registration.dispose();
    }
  });

  it('projects live launch admission from the pure dispatch policy without changing defaults or draft previews', async () => {
    await writeFile(join(home!, 'config.toml'), [
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const runningServer = server;
    base = `http://127.0.0.1:${server.port}`;
    const registration = server.core.accessor.get(IAgentProfileRegistry).register({ sourceId: 'admission-example', priority: 50, contribution: {
      profiles: [
        normalizeAgentProfile({ name: 'lead', main: true, tools: ['AgentRun'], allowedSubagents: ['native-helper', 'external-helper'], systemPrompt: () => '' }),
        ...['native', 'external'].map((executor) => normalizeAgentProfile({
          name: `${executor}-helper`, executor, modelAlias: 'stub', systemPrompt: () => '',
        })),
      ],
    } });
    try {
      const create = await authedFetch(server, base, '/api/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'lead', model: 'stub' } }),
      });
      const created = await create.json() as Envelope<{ id: string }>;
      expect(created.code).toBe(0);
      const session = server.core.accessor.get(ISessionManager).get(created.data.id)!;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const agent = lifecycle.get('main')!;
      const dispatch = session.accessor.get(ISessionDispatchService);
      const read = async (query = `session_id=${created.data.id}&agent_id=main`) => {
        const response = await authedFetch(runningServer, base, `/api/agents/capabilities?${query}`);
        const body = await response.json() as Envelope<unknown>;
        expect(body.code).toBe(0);
        return agentCapabilitiesResponseSchema.parse(body.data);
      };
      const before = await read();
      expect(before.targets.find((target) => target.executor === 'native')).toMatchObject({ launch_allowed: true });
      expect(before.targets.find((target) => target.executor === 'external')).toMatchObject({ launch_allowed: true });
      expect(before.targets.filter((target) => !['native-helper', 'external-helper'].includes(target.profile)).every((target) => target.launch_allowed === false)).toBe(true);
      const interactions = session.accessor.get(ISessionInteractionService);
      const pending = interactions.enqueue({ kind: 'approval', origin: { agentId: 'main' }, payload: { toolName: 'AgentRun' } });
      expect((await read()).tools?.find((tool) => tool.name === 'AgentRun')).toMatchObject({
        state: 'approval-required', unavailable_reason_code: 'approval_pending',
      });
      interactions.respond(pending.id, { decision: 'cancelled' });
      const usage = agent.accessor.get(IAgentUsageService);
      usage.record('unpriced-fixture-model', { inputOther: 10, inputCacheRead: 3, inputCacheCreation: 2, output: 5 }, undefined, { usageKnown: true });
      expect((await read()).metrics?.['main']).toMatchObject({ inputTokens: 15, totalTokens: 20, totalCostUsd: null });
      usage.record('unpriced-fixture-model', { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0 }, undefined, { usageKnown: false });
      const plan = agent.accessor.get(IAgentPlanService);
      await plan.enter();
      const launch = vi.spyOn(dispatch, 'launch');
      const registerReader = vi.spyOn(dispatch, 'registerPlanStateReader');
      const executable = vi.spyOn(server.core.accessor.get(IAgentExecutorRegistry), 'resolveExecutable');
      const policy = dispatch.readLaunchPolicy(agent.id);
      expect(policy.planActive).toBe(true);
      const planned = await read();
      for (const target of planned.targets.filter((item) => ['native-helper', 'external-helper'].includes(item.profile))) {
        const expected = evaluateDispatchAdmission(policy, 'spawn', target.executor);
        expect(target.launch_allowed).toBe(expected.allowed);
        expect(target.launch_unavailable_reason).toBe(expected.reason);
        expect(target.launch_unavailable_reason_code).toBe(expected.reasonCode);
        expect(target.execution_restriction).toBe(expected.executionRestriction);
        expect(target.defaults_available).toBe(before.targets.find((item) => item.profile === target.profile)?.defaults_available);
      }
      expect(planned.targets.find((target) => target.executor === 'native')).toMatchObject({
        launch_allowed: true, defaults_available: true, execution_restriction: 'research-readonly',
      });
      expect(planned.targets.find((target) => target.executor === 'external')).toMatchObject({ launch_allowed: false });
      const draft = await read(`workspace_id=${session.accessor.get(ISessionContext).workspaceId}&profile=lead`);
      expect(draft.context).toBe('draft');
      expect(draft.targets.map((target) => target.profile).toSorted()).toEqual(
        before.targets.map((target) => target.profile).toSorted(),
      );
      expect(draft.targets.every((target) => target.execution_restriction === undefined)).toBe(true);
      expect(draft.targets.filter((target) => ['native-helper', 'external-helper'].includes(target.profile)).every((target) => target.launch_allowed === undefined)).toBe(true);
      expect(draft.targets.filter((target) => !['native-helper', 'external-helper'].includes(target.profile)).every((target) => target.launch_allowed === false)).toBe(true);
      const profile = agent.accessor.get(IAgentProfileService);
      const data = profile.data();
      vi.spyOn(profile, 'data').mockReturnValue({ ...data, executionRestriction: 'research-readonly' });
      const readonly = await read();
      expect(readonly).toMatchObject({ available: false, targets: expect.arrayContaining([expect.objectContaining({ launch_allowed: false })]),
        unavailable_reason: evaluateDispatchAdmission(dispatch.readLaunchPolicy(agent.id), 'spawn').reason,
        unavailable_reason_code: evaluateDispatchAdmission(dispatch.readLaunchPolicy(agent.id), 'spawn').reasonCode });
      expect(readonly.tools?.find((tool) => tool.name === 'AgentRun')).toMatchObject({ state: 'disabled' });
      expect(readonly.profile).toMatchObject({ name: 'lead', execution_restriction: 'research-readonly' });
      expect(readonly.metrics?.['main']).toMatchObject({
        inputTokens: 15, outputTokens: 5, totalTokens: 20, totalCostUsd: null,
        contextTokens: expect.any(Number), contextLimit: expect.any(Number), compactionCount: expect.any(Number),
        usagePartial: true, costPartial: true, usageSource: 'live',
      });
      expect(launch).not.toHaveBeenCalled();
      expect(registerReader).not.toHaveBeenCalled();
      expect(executable).not.toHaveBeenCalled();
      expect(lifecycle.list()).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      await registration.dispose();
    }
  });

  it('projects file-backed profiles with source paths and route model pins', async () => {
    const agentsDir = join(home as string, 'agents');
    const routeDir = join(agentsDir, '.routes', 'reviewer');
    await mkdir(routeDir, { recursive: true });
    const profilePath = join(agentsDir, 'reviewer.md');
    const routePath = join(routeDir, 'fast.md');
    await writeFile(
      join(home as string, 'config.toml'),
      [
        'disabled_named_profiles = ["reviewer", "explore"]',
        '',
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000',
        '',
        '[experimental]',
        '"agent-profile-routes" = true',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      profilePath,
      [
        '---',
        'name: reviewer',
        'description: Reviews changes',
        'whenToUse: Review important changes',
        'main: true',
        'model_alias: provider/pinned',
        'thinking_effort: high',
        'service_tier: priority',
        'context_budget: 4096',
        'max_completion_tokens: 512',
        'request_params:',
        '  temperature: 0.4',
        'tools: [Read, Bash]',
        'disallowedTools: [Write]',
        'model_profiles:',
        '  - alias: provider/fast',
        '    when: Use for quick reviews',
        '    context_budget: 2048',
        '    max_completion_tokens: 256',
        '    service_tier: flex',
        '    request_params:',
        '      temperature: 0.2',
        '    thinking_effort: low',
        '    allowed_efforts: [low, medium]',
        'spawn_constraints:',
        '  allowed_models: [provider/pinned]',
        '  deny_models: [provider/blocked]',
        '  allowed_efforts: [high]',
        '  disallowed_tools: [Write]',
        'allowed_subagents:',
        '  - explore',
        '  - name: reviewer-helper',
        '    description: Assists reviews',
        '    model_alias: provider/fast',
        '    thinking_effort: low',
        '    allowed_models: [provider/fast]',
        '    tools: ["*"]',
        '    allowed_subagents: ["*"]',
        '    delegation_notice: off',
        '    service_tier: flex',
        '    request_params:',
        '      temperature: 0.2',
        '    model_profiles:',
        '      - alias: provider/fast',
        '        when: Use for review assistance',
        '        context_budget: 1024',
        '        max_completion_tokens: 128',
        '        service_tier: flex',
        '        request_params:',
        '          temperature: 0.1',
        '---',
        '',
        'Review the change.',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      routePath,
      [
        '---',
        'id: reviewer.fast',
        'profile: reviewer',
        'description: Fast review route',
        'prompt_mode: prepend',
        'model_alias: provider/route',
        '---',
        '',
        'Prioritize speed.',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(agentsDir, 'm3-worker.md'),
      '---\nname: m3-worker\ndescription: Private worker\nprivate: true\n---\n\nPrivate worker prompt.\n',
      'utf-8',
    );

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const create = await authedFetch(server, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home }, agent_config: { model: 'stub' } }),
    });
    const created = (await create.json()) as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const otherWorkspace = join(home as string, 'other-workspace');
    await mkdir(otherWorkspace, { recursive: true });
    const createOther = await authedFetch(server, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: otherWorkspace } }),
    });
    expect(((await createOther.json()) as Envelope<{ id: string }>).code).toBe(0);

    const response = await authedFetch(server, base, '/api/agents');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    expect(body.code).toBe(0);
    const data = listNamedAgentProfilesResponseSchema.parse(body.data);
    expect(data.items.some((profile) => profile.name === 'm3-worker')).toBe(false);
    const reviewer = data.items.find((profile) => profile.name === 'reviewer' && profile.source === 'user');
    expect(reviewer).toEqual({
      name: 'reviewer',
      description: 'Reviews changes',
      when_to_use: 'Review important changes',
      source: 'user',
      workspace_id: expect.any(String),
      workspace_ids: [expect.any(String), expect.any(String)],
      source_file: profilePath.replaceAll('\\', '/'),
      prompt: 'Review the change.',
      main: true,
      executor: 'native',
      executor_protocol: 'native',
      pinned_model_alias: 'provider/pinned',
      restrict_models_to_menu: false,
      declared_model_menu: { aliases: ['provider/fast'], default_alias: 'provider/pinned', identities: [] },
      effective_model_aliases: ['stub'],
      model_constraints_active: false,
      thinking_effort: 'high',
      service_tier: 'priority',
      request_params: { temperature: 0.4 },
      context_budget: 4096,
      max_completion_tokens: 512,
      tools: ['Read', 'Bash'],
      disallowed_tools: ['Write'],
      model_profiles: [{
        alias: 'provider/fast',
        when: 'Use for quick reviews',
        context_budget: 2048,
        max_completion_tokens: 256,
        service_tier: 'flex',
        request_params: { temperature: 0.2 },
        thinking_effort: 'low',
        allowed_efforts: ['low', 'medium'],
      }],
      spawn_constraints: {
        allowed_models: ['provider/pinned'],
        deny_models: ['provider/blocked'],
        allowed_efforts: ['high'],
        disallowed_tools: ['Write'],
      },
      allowed_subagents: [
        'explore',
        {
          name: 'reviewer-helper',
          description: 'Assists reviews',
          model_alias: 'provider/fast',
          thinking_effort: 'low',
          allowed_models: ['provider/fast'],
          tools: null,
          delegation_notice: 'off',
          service_tier: 'flex',
          request_params: { temperature: 0.2 },
          model_profiles: [{
            alias: 'provider/fast',
            when: 'Use for review assistance',
            context_budget: 1024,
            max_completion_tokens: 128,
            service_tier: 'flex',
            request_params: { temperature: 0.1 },
          }],
        },
      ],
      disabled: true,
      routes: [{
        id: 'reviewer.fast',
        description: 'Fast review route',
        model_alias: 'provider/route',
        source_file: routePath.replaceAll('\\', '/'),
      }],
    });
    expect(data.items.filter((profile) =>
      profile.name === 'reviewer' && profile.source_file === profilePath.replaceAll('\\', '/')
    )).toHaveLength(1);
    const shippedCopy = (name: string, fileName: string) => data.items.find((profile) =>
      profile.name === name
      && (profile.source_file?.replaceAll('\\', '/') ?? '').endsWith(`agents/builtin/${fileName}`));
    expect(shippedCopy('explore', 'explore.md')).toMatchObject({ source: 'user', disabled: true });
    expect(shippedCopy('agent', 'agent.md')).toMatchObject({ source: 'user', main: true, disabled: false });

    const expandedResponse = await authedFetch(server, base, '/api/agents?expand=1');
    expect(expandedResponse.status).toBe(200);
    const expandedBody = (await expandedResponse.json()) as Envelope<unknown>;
    expect(expandedBody.code).toBe(0);
    const expanded = listNamedAgentProfilesResponseSchema.parse(expandedBody.data);
    const expandedReviewers = expanded.items.filter((profile) =>
      profile.name === 'reviewer'
      && profile.source === 'user'
      && profile.source_file === profilePath.replaceAll('\\', '/')
    );
    expect(expandedReviewers).toHaveLength(2);
    expect(expandedReviewers.every((profile) => profile.workspace_ids === undefined)).toBe(true);
    expect(new Set(expandedReviewers.map((profile) => profile.workspace_id)).size).toBe(2);
    expect(expandedReviewers.every((profile) => profile.disabled)).toBe(true);

    const patchedResponse = await authedFetch(server, base, '/api/agents/reviewer', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        workspace_id: reviewer?.workspace_id,
        description: 'Reviews changes carefully',
        when_to_use: 'Use for final review',
        pinned_model_alias: 'provider/updated',
        thinking_effort: 'medium',
        service_tier: 'flex',
        tools: ['Read'],
        disallowed_tools: null,
        routes: [{ id: 'reviewer.fast', model_alias: 'provider/route-updated' }],
      }),
    });
    const patched = (await patchedResponse.json()) as Envelope<{
      description?: string;
      pinned_model_alias?: string;
      routes: Array<{ id: string; model_alias?: string }>;
    }>;
    expect(patched.code).toBe(0);
    expect(patched.data).toMatchObject({
      name: 'reviewer',
      description: 'Reviews changes carefully',
      when_to_use: 'Use for final review',
      source: 'user',
      workspace_id: reviewer?.workspace_id,
      pinned_model_alias: 'provider/updated',
      thinking_effort: 'medium',
      service_tier: 'flex',
      request_params: { temperature: 0.4 },
      context_budget: 4096,
      max_completion_tokens: 512,
      model_profiles: [{
        alias: 'provider/fast',
        when: 'Use for quick reviews',
        context_budget: 2048,
        max_completion_tokens: 256,
        service_tier: 'flex',
        request_params: { temperature: 0.2 },
        thinking_effort: 'low',
        allowed_efforts: ['low', 'medium'],
      }],
      tools: ['Read'],
      disabled: true,
      routes: [{ id: 'reviewer.fast', model_alias: 'provider/route-updated' }],
    });
    expect(await readFile(profilePath, 'utf8')).toContain('description: "Reviews changes carefully"');
    expect(await readFile(routePath, 'utf8')).toContain('model_alias: "provider/route-updated"');

    const rawText = [
      '---',
      'name: reviewer',
      'description: Raw REST update',
      'context_budget: 3072',
      'max_completion_tokens: 384',
      'service_tier: default',
      'request_params:',
      '  top_p: 0.8',
      'model_profiles:',
      '  - alias: provider/fast',
      '    context_budget: 1024',
      '    max_completion_tokens: 128',
      '    service_tier: flex',
      '    request_params:',
      '      temperature: 0.1',
      '    thinking_effort: low',
      '---',
      '',
      'Raw body.',
      '',
    ].join('\n');
    const rawResponse = await authedFetch(server, base, '/api/agents/reviewer', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        workspace_id: reviewer?.workspace_id,
        raw_text: rawText,
      }),
    });
    const raw = (await rawResponse.json()) as Envelope<{
      description?: string;
      context_budget?: number;
      max_completion_tokens?: number;
      service_tier?: string;
      request_params?: Record<string, string | number | boolean>;
      model_profiles?: Array<{
        alias: string;
        when?: string;
        context_budget?: number;
        max_completion_tokens?: number;
        service_tier?: string;
        request_params?: Record<string, string | number | boolean>;
      }>;
    }>;
    expect(raw.code).toBe(0);
    expect(raw.data).toMatchObject({
      description: 'Raw REST update',
      context_budget: 3072,
      max_completion_tokens: 384,
      service_tier: 'default',
      request_params: { top_p: 0.8 },
      model_profiles: [{
        alias: 'provider/fast',
        context_budget: 1024,
        max_completion_tokens: 128,
        service_tier: 'flex',
        request_params: { temperature: 0.1 },
        thinking_effort: 'low',
      }],
    });
    expect(await readFile(profilePath, 'utf8')).toBe(rawText);
    const rereadResponse = await authedFetch(server, base, '/api/agents');
    const rereadBody = (await rereadResponse.json()) as Envelope<unknown>;
    const reread = listNamedAgentProfilesResponseSchema.parse(rereadBody.data);
    const rereadReviewer = reread.items.find((profile) => profile.name === 'reviewer' && profile.source === 'user');
    expect(rereadReviewer).toMatchObject({
      context_budget: 3072,
      max_completion_tokens: 384,
      service_tier: 'default',
      request_params: { top_p: 0.8 },
      model_profiles: [{
        alias: 'provider/fast',
        context_budget: 1024,
        max_completion_tokens: 128,
        service_tier: 'flex',
        request_params: { temperature: 0.1 },
      }],
    });
    expect(rereadReviewer?.model_profiles?.[0]).not.toHaveProperty('when');

    const mixedResponse = await authedFetch(server, base, '/api/agents/reviewer', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        workspace_id: reviewer?.workspace_id,
        raw_text: rawText,
        description: 'mixed',
      }),
    });
    expect(((await mixedResponse.json()) as Envelope<null>).code).toBe(40001);
  });

  it('keeps configured global extras in scope and resolves listed targets with their caller', async () => {
    const workspaceA = join(home!, 'workspace-a');
    const workspaceB = join(home!, 'workspace-b');
    const extraAgents = join(home!, 'configured-agents');
    const extraSkills = join(home!, 'configured-skills');
    const skillText = '---\nname: global-example\ndescription: Global example\n---\nGlobal skill body.\n';
    for (const workspace of [workspaceA, workspaceB]) {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, '.kiki', 'agents'), { recursive: true });
      await mkdir(join(workspace, '.kiki', 'skills'), { recursive: true });
    }
    await mkdir(extraAgents);
    await mkdir(join(extraSkills, 'global-example'), { recursive: true });
    await writeFile(join(extraAgents, 'paper-architect.md'),
      '---\nname: paper-architect\ndescription: Configured global helper\n---\nHelp with papers.\n');
    await writeFile(join(extraSkills, 'global-example', 'SKILL.md'), skillText);
    await writeFile(join(workspaceB, '.kiki', 'agents', 'other-helper.md'),
      '---\nname: other-helper\ndescription: Only workspace B\n---\nB.\n');
    await mkdir(join(workspaceB, '.kiki', 'skills', 'other-skill'), { recursive: true });
    await writeFile(join(workspaceB, '.kiki', 'skills', 'other-skill', 'SKILL.md'), skillText.replaceAll('global-example', 'other-skill'));
    await writeFile(join(home!, 'config.toml'), [
      `extra_agent_dirs = [${JSON.stringify(extraAgents.replaceAll('\\', '/'))}]`,
      `extra_skill_dirs = [${JSON.stringify(extraSkills.replaceAll('\\', '/'))}]`,
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const cwd = `cwd=${encodeURIComponent(workspaceA)}`;
    const listed = await (await authedFetch(server, base, `/api/agents?${cwd}&effective=true`)).json() as Envelope<unknown>;
    expect(listed.code).toBe(0);
    const items = listNamedAgentProfilesResponseSchema.parse(listed.data).items;
    expect(items.find((item) => item.name === 'paper-architect')).toMatchObject({ source: 'extra', main: false });
    expect(items.some((item) => item.name === 'other-helper')).toBe(false);
    const main = await (await authedFetch(server, base, `/api/agents/capabilities?${cwd}&profile=agent`)).json() as Envelope<unknown>;
    expect(main.code).toBe(0);
    const capabilities = agentCapabilitiesResponseSchema.parse(main.data);
    expect(capabilities.targets.find((target) => target.profile === 'paper-architect')).toMatchObject({
      caller_profile: 'agent', source: 'extra', source_root: extraAgents.replaceAll('\\', '/'),
      source_file: join(extraAgents, 'paper-architect.md').replaceAll('\\', '/'),
    });
    expect(capabilities.targets.some((target) => target.profile === 'other-helper')).toBe(false);
    expect(capabilities.skills?.find((skill) => skill.name === 'global-example')).toMatchObject({
      source: 'extra', source_kind: 'extra', source_root: extraSkills.replaceAll('\\', '/'), scope: 'global',
    });
    expect(capabilities.skills?.some((skill) => skill.name === 'other-skill')).toBe(false);
    const detail = await (await authedFetch(server, base,
      `/api/agents/capabilities?${cwd}&profile=paper-architect&caller_profile=agent`)).json() as Envelope<unknown>;
    expect(detail.code).toBe(0);
    expect(agentCapabilitiesResponseSchema.parse(detail.data)).toMatchObject({
      context: 'draft', owner: { profile: 'paper-architect' }, profile: { source: 'extra' },
    });
    const missing = await (await authedFetch(server, base,
      `/api/agents/capabilities?${cwd}&profile=other-helper&caller_profile=agent`)).json() as Envelope<unknown>;
    expect(missing.code).toBe(ErrorCode.AGENT_PROFILE_NOT_FOUND);
  });

  it('isolates workspace dispatch targets for drafts and live sessions', async () => {
    const workspaceA = join(home as string, 'workspace-a');
    const workspaceB = join(home as string, 'workspace-b');
    const agentsA = join(workspaceA, '.kiki', 'agents');
    const agentsB = join(workspaceB, '.kiki', 'agents');
    await mkdir(agentsA, { recursive: true });
    await mkdir(agentsB, { recursive: true });
    await mkdir(join(workspaceA, '.git'));
    await mkdir(join(workspaceB, '.git'));
    await writeFile(
      join(agentsA, 'workspace-choice.md'),
      '---\nname: workspace-choice\ndescription: Workspace A choice\nmain: true\n---\n\nUse workspace A.\n',
      'utf-8',
    );
    await writeFile(
      join(agentsB, 'workspace-choice.md'),
      '---\nname: workspace-choice\ndescription: Workspace B helper\nmain: false\n---\n\nUse workspace B.\n',
      'utf-8',
    );
    await writeFile(
      join(agentsB, 'workspace-main.md'),
      '---\nname: workspace-main\ndescription: Workspace B main\nmain: true\n---\n\nUse workspace B.\n',
      'utf-8',
    );

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const runningServer = server;
    const registerWorkspace = async (root: string): Promise<string> => {
      const response = await authedFetch(runningServer, base, '/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root }),
      });
      const body = (await response.json()) as Envelope<{ id: string }>;
      expect(body.code).toBe(0);
      return body.data.id;
    };
    const workspaceAId = await registerWorkspace(workspaceA);
    const workspaceBId = await registerWorkspace(workspaceB);
    expect(server.core.accessor.get(ISessionManager).list()).toHaveLength(0);

    const listScoped = async (workspaceId: string) => {
      const response = await authedFetch(
        runningServer,
        base,
        `/api/agents?workspace_id=${encodeURIComponent(workspaceId)}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Envelope<unknown>;
      expect(body.code).toBe(0);
      return listNamedAgentProfilesResponseSchema.parse(body.data);
    };

    const scopedA = await listScoped(workspaceAId);
    expect(scopedA.complete).toBe(true);
    expect(scopedA.items.find((profile) =>
      profile.name === 'workspace-choice' && profile.source === 'workspace'
    )).toMatchObject({
      description: 'Workspace A choice',
      workspace_id: workspaceAId,
      main: true,
    });
    expect(scopedA.items.some((profile) => profile.description === 'Workspace B helper')).toBe(false);

    const scopedB = await listScoped(workspaceBId);
    expect(scopedB.items.find((profile) =>
      profile.name === 'workspace-choice' && profile.source === 'workspace'
    )).toMatchObject({
      description: 'Workspace B helper',
      workspace_id: workspaceBId,
      main: false,
    });
    expect(scopedB.items.some((profile) => profile.description === 'Workspace A choice')).toBe(false);

    for (const query of [
      `workspace_id=${encodeURIComponent(workspaceAId)}`,
      `cwd=${encodeURIComponent(workspaceA)}`,
    ]) {
      const response = await authedFetch(runningServer, base, `/api/agents?effective=true&${query}`);
      const body = await response.json() as Envelope<unknown>;
      expect(body.code).toBe(0);
      expect(listNamedAgentProfilesResponseSchema.parse(body.data).items.filter((item) => item.name === 'workspace-choice'))
        .toMatchObject([{ main: true, description: 'Workspace A choice', disabled: false }]);
      const capabilities = await authedFetch(runningServer, base,
        `/api/agents/capabilities?${query}&profile=workspace-choice`);
      const capabilityBody = await capabilities.json() as Envelope<{ context: string; owner: { profile: string }; targets: { profile: string }[] }>;
      expect(capabilityBody.code).toBe(0);
      expect(capabilityBody.data).toMatchObject({ context: 'draft', owner: { profile: 'workspace-choice' } });
      expect(capabilityBody.data.targets.some((target) => target.profile === 'workspace-choice')).toBe(false);
    }
    const capabilitiesB = await authedFetch(runningServer, base,
      `/api/agents/capabilities?workspace_id=${encodeURIComponent(workspaceBId)}&profile=workspace-main`);
    const scopedTargetsB = await capabilitiesB.json() as Envelope<{ targets: { profile: string }[] }>;
    expect(scopedTargetsB.code).toBe(0);
    expect(scopedTargetsB.data.targets.some((target) => target.profile === 'workspace-choice')).toBe(true);

    const scopedAAgain = await listScoped(workspaceAId);
    expect(scopedAAgain.items.find((profile) =>
      profile.name === 'workspace-choice' && profile.source === 'workspace'
    )?.main).toBe(true);
    expect(server.core.accessor.get(ISessionManager).list()).toHaveLength(0);
    const instances = server.core.accessor.get(IWorkspaceInstanceManager);
    expect(instances.referenceCount(workspaceAId)).toBe(0);
    expect(instances.referenceCount(workspaceBId)).toBe(0);

    const createdResponse = await authedFetch(runningServer, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: workspaceA } }),
    });
    const created = await createdResponse.json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const liveCapabilities = await authedFetch(runningServer, base,
      `/api/agents/capabilities?session_id=${encodeURIComponent(created.data.id)}&agent_id=main`);
    const live = await liveCapabilities.json() as Envelope<{ context: string; targets: { profile: string }[] }>;
    expect(live.code).toBe(0);
    expect(live.data.context).toBe('live');
    expect(live.data.targets.some((target) => target.profile === 'workspace-choice')).toBe(false);

    const missingResponse = await authedFetch(
      runningServer,
      base,
      '/api/agents?workspace_id=wd_missing',
    );
    const missing = (await missingResponse.json()) as Envelope<null>;
    expect(missing.code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
  });

  it('projects scoped source leases without exposing private definitions or absolute paths', async () => {
    const agentsDir = join(home as string, 'agents');
    const privateDir = join(agentsDir, '_private', 'research');
    await mkdir(privateDir, { recursive: true });
    const parentPath = join(agentsDir, 'research-lead.md');
    const childPath = join(privateDir, 'writer.md');
    await writeFile(
      parentPath,
      [
        '---',
        'name: research-lead',
        'description: Coordinates research',
        'allowed_subagents:',
        '  - name: research-writer',
        '    source: ./_private/research/writer.md',
        '    description: Writes research summaries',
        '  - name: missing-writer',
        '    source: ./_private/research/missing.md',
        '---',
        '',
        'Coordinate research.',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      childPath,
      [
        '---',
        'name: private-research-writer',
        'description: Internal research writer',
        '---',
        '',
        'Write the research summary.',
        '',
      ].join('\n'),
      'utf-8',
    );

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const create = await authedFetch(server, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    expect(((await create.json()) as Envelope<{ id: string }>).code).toBe(0);

    const response = await authedFetch(server, base, '/api/agents');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    expect(body.code).toBe(0);
    const data = listNamedAgentProfilesResponseSchema.parse(body.data);
    const parent = data.items.find((profile) =>
      profile.name === 'research-lead' && profile.source === 'user'
    );
    expect(parent?.allowed_subagents).toEqual([
      {
        name: 'research-writer',
        source: './_private/research/writer.md',
        scope: 'private',
        status: 'ready',
        description: 'Writes research summaries',
      },
      {
        name: 'missing-writer',
        source: './_private/research/missing.md',
        scope: 'private',
        status: 'unavailable',
        diagnostic: 'Source profile is unavailable',
        diagnostic_code: AgentProfileSourceDiagnosticCodes.UNAVAILABLE,
      },
    ]);
    expect(data.items.some((profile) => profile.name === 'private-research-writer')).toBe(false);
    const projectedLeases = JSON.stringify(parent?.allowed_subagents);
    expect(projectedLeases).not.toContain(childPath.replaceAll('\\', '/'));
    expect(projectedLeases).not.toContain((home as string).replaceAll('\\', '/'));
    expect(projectedLeases).not.toContain('sourceDefinitionId');
    const caller = `cwd=${encodeURIComponent(home!)}&profile=research-lead`;
    const targets = await (await authedFetch(server, base, `/api/agents/capabilities?${caller}`)).json() as Envelope<unknown>;
    expect(targets.code).toBe(0);
    expect(agentCapabilitiesResponseSchema.parse(targets.data).targets.find((target) =>
      target.profile === 'research-writer')).toMatchObject({
      caller_profile: 'research-lead', source: 'user', source_root: agentsDir.replaceAll('\\', '/'),
    });
    const detail = await (await authedFetch(server, base,
      `/api/agents/capabilities?cwd=${encodeURIComponent(home!)}&profile=research-writer&caller_profile=research-lead`))
      .json() as Envelope<unknown>;
    expect(detail.code).toBe(0);
    expect(agentCapabilitiesResponseSchema.parse(detail.data).profile).toMatchObject({
      name: 'research-writer', description: 'Internal research writer', source: 'user',
    });
    const unavailable = await (await authedFetch(server, base,
      `/api/agents/capabilities?cwd=${encodeURIComponent(home!)}&profile=missing-writer&caller_profile=research-lead`))
      .json() as Envelope<unknown>;
    expect(unavailable.code).toBe(ErrorCode.AGENT_PROFILE_NOT_FOUND);
    const privateDetail = await (await authedFetch(server, base,
      `/api/agents/capabilities?cwd=${encodeURIComponent(home!)}&profile=private-research-writer`))
      .json() as Envelope<unknown>;
    expect(privateDetail.code).toBe(ErrorCode.AGENT_PROFILE_NOT_FOUND);
  });

  it('projects scoped source status from a loaded workspace without a live session', async () => {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const parentDefinitionId = 'definition:offline-lead';
    const readyLease = { name: 'offline-writer', source: './_private/writer.md' } as const;
    const unavailableLease = { name: 'missing-writer', source: './_private/missing.md' } as const;
    const profile = normalizeAgentProfile({
      name: 'offline-lead',
      definitionId: parentDefinitionId,
      allowedSubagents: [readyLease.name, unavailableLease.name],
      subagentLeases: {
        [readyLease.name]: readyLease,
        [unavailableLease.name]: unavailableLease,
      },
      systemPrompt: () => 'Coordinate offline research.',
    });
    const registration = server.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'workspace',
      priority: 30,
      workspaceKey: 'wd_offline',
      contribution: {
        profiles: [profile],
        scopedBindings: new Map([
          [parentDefinitionId, new Map([
            [readyLease.name, {
              parentDefinitionId,
              alias: readyLease.name,
              source: readyLease.source,
              lease: readyLease,
              status: 'ready' as const,
              sourceDefinitionId: 'C:/Users/private/_private/writer.md',
            }],
            [unavailableLease.name, {
              parentDefinitionId,
              alias: unavailableLease.name,
              source: unavailableLease.source,
              lease: unavailableLease,
              status: 'unavailable' as const,
              diagnostic: {
                code: AgentProfileSourceDiagnosticCodes.UNAVAILABLE,
                severity: 'error' as const,
                message: 'Scoped source C:/Users/private/_private/missing.md is unavailable',
                path: 'C:/Users/private/_private/missing.md',
              },
            }],
          ])],
        ]),
      },
    });
    expect(server.core.accessor.get(ISessionManager).list()).toHaveLength(0);

    const response = await authedFetch(server, base, '/api/agents');
    await registration.dispose();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    const data = listNamedAgentProfilesResponseSchema.parse(body.data);
    const parent = data.items.find((item) =>
      item.name === 'offline-lead' && item.source === 'workspace'
    );
    expect(parent?.allowed_subagents).toEqual([
      {
        name: 'offline-writer',
        source: './_private/writer.md',
        scope: 'private',
        status: 'ready',
      },
      {
        name: 'missing-writer',
        source: './_private/missing.md',
        scope: 'private',
        status: 'unavailable',
        diagnostic: 'Source profile is unavailable',
        diagnostic_code: AgentProfileSourceDiagnosticCodes.UNAVAILABLE,
      },
    ]);
    const projectedLeases = JSON.stringify(parent?.allowed_subagents);
    expect(projectedLeases).not.toContain('C:/Users/private');
    expect(projectedLeases).not.toContain('sourceDefinitionId');
  });

  it('keeps private profiles out of every listing while still resolving them by name and lease', async () => {
    await writeFile(join(home!, 'config.toml'), [
      '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
      'api_key = "YOUR_API_KEY"', '[models.stub]', 'provider = "stub"', 'model = "stub"',
      'max_context_size = 1000', '[experimental]', '"agent-profile-routes" = true',
    ].join('\n'));
    const agentsDir = join(home as string, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'm3-worker.md'),
      '---\nname: m3-worker\ndescription: Private worker\nprivate: true\n---\n\nPrivate worker prompt.\n',
      'utf-8',
    );
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
    const registry = server.core.accessor.get(IAgentProfileRegistry);
    const helper = normalizeAgentProfile({
      name: 'helper', definitionId: 'definition:helper', private: true, modelAlias: 'stub',
      systemPrompt: () => 'PRIVATE_HELPER_PROMPT',
    });
    const lead = normalizeAgentProfile({
      name: 'agent', definitionId: 'definition:private-main', main: true, private: true, override: true,
      tools: ['AgentRun'], allowedSubagents: ['helper'],
      subagentLeases: { helper: { name: 'helper', source: './_private/helper.md', modelAlias: 'stub' } },
      systemPrompt: () => 'PRIVATE_MAIN_PROMPT',
    });
    const registration = registry.register({ sourceId: 'example', priority: 50, contribution: {
      profiles: [lead, helper],
      scopedBindings: new Map([[lead.definitionId!, new Map([
        ['helper', { parentDefinitionId: lead.definitionId!, alias: 'helper', source: './_private/helper.md', lease: { name: 'helper', source: './_private/helper.md', modelAlias: 'stub' }, status: 'ready' as const, profile: helper, sourceDefinitionId: helper.definitionId }],
      ])]]),
    } });
    try {
      const create = await authedFetch(server, base, '/api/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: { cwd: home }, agent_config: { profile: 'agent', model: 'stub' } }),
      });
      const created = (await create.json()) as Envelope<{ id: string }>;
      expect(created.code).toBe(0);
      const workspaceId = server.core.accessor.get(ISessionManager).get(created.data.id)!.accessor.get(ISessionContext).workspaceId;
      const query = `workspace_id=${workspaceId}`;

      const plain = listNamedAgentProfilesResponseSchema.parse(
        ((await (await authedFetch(server, base, '/api/agents')).json()) as Envelope<unknown>).data,
      );
      expect(plain.items.some((profile) => profile.source === 'example')).toBe(false);
      expect(plain.items.some((profile) => profile.name === 'm3-worker' || profile.name === 'helper')).toBe(false);
      const shippedExplore = plain.items.find((profile) => profile.name === 'explore');
      expect(shippedExplore?.source).toBe('user');
      expect(shippedExplore?.source_file?.replaceAll('\\', '/')).toMatch(/agents\/builtin\/explore\.md$/);

      const expanded = listNamedAgentProfilesResponseSchema.parse(
        ((await (await authedFetch(server, base, `/api/agents?${query}&expand=true`)).json()) as Envelope<unknown>).data,
      );
      expect(expanded.items.some((profile) => profile.source === 'example')).toBe(false);
      expect(expanded.items.some((profile) => profile.name === 'helper')).toBe(false);

      const effective = listNamedAgentProfilesResponseSchema.parse(
        ((await (await authedFetch(server, base, `/api/agents?${query}&effective=true`)).json()) as Envelope<unknown>).data,
      );
      const effectiveLead = effective.items.find((profile) => profile.name === 'agent' && profile.source === 'example');
      expect(effectiveLead?.allowed_subagents).toEqual([
        expect.objectContaining({ name: 'helper', source: './_private/helper.md', scope: 'private', status: 'ready' }),
      ]);
      expect(effective.items.some((profile) => profile.name === 'helper')).toBe(false);

      const capabilities = await authedFetch(server, base, `/api/agents/capabilities?${query}&profile=agent`);
      const caps = (await capabilities.json()) as Envelope<{ targets: Array<{ profile: string }> }>;
      expect(caps.code).toBe(0);
      expect(caps.data.targets.map((target) => target.profile)).toContain('helper');
    } finally {
      await registration.dispose();
    }
  });

  it('projects the override flag so clients can show which same-name profile wins', async () => {
    const agentsDir = join(home as string, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'agent.md'), '---\nname: agent\ndescription: File main override\noverride: true\ntools: [Read]\n---\nCustom file main.');
    await writeFile(
      join(agentsDir, 'explore.md'),
      [
        '---',
        'name: explore',
        'description: User-scoped exploration profile',
        'override: true',
        '---',
        '',
        'Explore carefully.',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(agentsDir, 'reviewer.md'),
      [
        '---',
        'name: reviewer',
        'description: User reviewer without override',
        '---',
        '',
        'Review carefully.',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    await authedFetch(server, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });

    const listed = (await (await authedFetch(server, base, '/api/agents')).json()) as Envelope<unknown>;
    const data = listNamedAgentProfilesResponseSchema.parse(listed.data);
    const exploreRows = data.items.filter((profile) => profile.name === 'explore');
    expect(exploreRows).toHaveLength(1);
    const userExplore = exploreRows[0];
    expect(userExplore?.source).toBe('user');
    expect(userExplore?.source_file?.replaceAll('\\', '/')).toMatch(/agents\/explore\.md$/);
    expect(userExplore?.override).toBe(true);
    const userReviewer = data.items.find((profile) => profile.name === 'reviewer' && profile.source === 'user');
    expect(userReviewer?.override).toBeUndefined();
    expect(data.items.find((profile) => profile.name === 'agent' && profile.source === 'user')).toMatchObject({ main: true, tools: ['Read'] });
    const query = `cwd=${encodeURIComponent(home!)}`;
    const effectiveResponse = await authedFetch(server, base, `/api/agents?${query}&effective=true`);
    const effective = listNamedAgentProfilesResponseSchema.parse((await effectiveResponse.json() as Envelope<unknown>).data);
    expect(effective.items.filter((profile) => profile.name === 'agent')).toMatchObject([{ main: true, source: 'user', tools: ['Read'] }]);
    const capabilities = await authedFetch(server, base, `/api/agents/capabilities?${query}&profile=agent`);
    expect((await capabilities.json() as Envelope<unknown>).data).toMatchObject({ available: false, targets: expect.arrayContaining([expect.objectContaining({ launch_allowed: false })]) });
  });

  it('edits a materialized shipped profile copy and reports it as custom until restored', async () => {
    const agentsDir = join(home as string, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'reviewer.md'),
      '---\nname: reviewer\ndescription: reviewer\n---\n\nReview.\n',
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    await authedFetch(server, base, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    const listed = (await (await authedFetch(server, base, '/api/agents')).json()) as Envelope<unknown>;
    const data = listNamedAgentProfilesResponseSchema.parse(listed.data);
    const shippedAgent = data.items.find((profile) =>
      profile.name === 'agent' && (profile.source_file?.replaceAll('\\', '/') ?? '').endsWith('agents/builtin/agent.md'));
    expect(shippedAgent).toMatchObject({ source: 'user', main: true });

    const response = await authedFetch(server, base, '/api/agents/agent', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        workspace_id: shippedAgent?.workspace_id,
        description: 'edited shipped copy',
      }),
    });
    const body = (await response.json()) as Envelope<{ source_file?: string }>;
    expect(body.code).toBe(0);
    expect(body.data).toMatchObject({
      name: 'agent',
      description: 'edited shipped copy',
      source: 'user',
      source_file: expect.stringMatching(/agents[\\/]builtin[\\/]agent\.md$/),
    });
    const activePath = join(home as string, 'agents', 'builtin', 'agent.md');
    expect(await readFile(activePath, 'utf8')).toContain('edited shipped copy');

    const shipped = (await (await authedFetch(server, base, '/api/agents/shipped')).json()) as Envelope<unknown>;
    expect(shipped.code).toBe(0);
    expect(listShippedAgentProfilesResponseSchema.parse(shipped.data).items
      .find((item) => item.template_id === 'agent')).toMatchObject({ managed: true, status: 'custom' });

    const restored = await authedFetch(server, base, '/api/agents/shipped/agent:restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const restoredBody = (await restored.json()) as Envelope<{ status: string }>;
    expect(restoredBody.code).toBe(0);
    expect(restoredBody.data.status).toBe('clean');
    expect(await readFile(activePath, 'utf8')).toBe(
      SHIPPED_AGENT_PROFILE_TEMPLATES.find((template) => template.id === 'agent')?.text,
    );
  });

  it('creates, rejects collisions and invalid names, duplicates a template, and round-trips prompt edits', async () => {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const session = await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    expect(((await session.json()) as Envelope<unknown>).code).toBe(0);
    const listed = (await (await authedFetch(server, base, '/api/agents')).json()) as Envelope<unknown>;
    const workspaceId = listNamedAgentProfilesResponseSchema.parse(listed.data).items
      .find((profile) => profile.source === 'user')?.workspace_id;
    expect(workspaceId).toBeTruthy();
    const post = async (body: Record<string, unknown>) => {
      const response = await authedFetch(server!, base, '/api/agent-profiles', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, scope: 'user', ...body }),
      });
      return (await response.json()) as Envelope<unknown>;
    };
    const created = await post({
      name: 'custom-reviewer', description: 'Review carefully', when_to_use: 'After changes',
      main: false, pinned_model_alias: 'inherit', tools: ['Read'], prompt: 'Inspect the candidate.',
    });
    expect(created.code).toBe(0);
    expect(created.data).toMatchObject({
      name: 'custom-reviewer', source: 'user', main: false, prompt: 'Inspect the candidate.',
      tools: ['Read'], when_to_use: 'After changes',
    });
    const path = join(home!, 'agents', 'custom-reviewer.md');
    const original = await readFile(path, 'utf8');
    expect(original).toContain('model_alias: "inherit"');
    expect((await post({ name: 'custom-reviewer', description: 'overwrite', prompt: 'No' })).code)
      .toBe(ErrorCode.AGENT_PROFILE_ALREADY_EXISTS);
    expect((await post({ name: '../escape', description: 'invalid', prompt: 'No' })).code)
      .toBe(ErrorCode.VALIDATION_FAILED);
    expect(await readFile(path, 'utf8')).toBe(original);

    const duplicated = await post({ name: 'custom-copy', template: 'duplicate:custom-reviewer' });
    expect(duplicated.code).toBe(0);
    expect(duplicated.data).toMatchObject({ name: 'custom-copy', prompt: 'Inspect the candidate.', tools: ['Read'] });
    const copiedText = await readFile(join(home!, 'agents', 'custom-copy.md'), 'utf8');
    expect(copiedText).toContain('name: "custom-copy"');
    expect(copiedText).toContain('tools: ["Read"]');

    const patch = await authedFetch(server, base, '/api/agents/custom-reviewer', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId, scope: 'user', prompt: 'Revised\nsecond line.' }),
    });
    const patched = (await patch.json()) as Envelope<unknown>;
    expect(patched.code).toBe(0);
    expect(patched.data).toMatchObject({ prompt: 'Revised\nsecond line.', description: 'Review carefully' });
    const after = await readFile(path, 'utf8');
    expect(after.slice(0, after.indexOf('---\n\n'))).toBe(original.slice(0, original.indexOf('---\n\n')));
    const reread = (await (await authedFetch(server, base, '/api/agents')).json()) as Envelope<unknown>;
    expect(listNamedAgentProfilesResponseSchema.parse(reread.data).items.find((profile) => profile.name === 'custom-reviewer'))
      .toMatchObject({ prompt: 'Revised\nsecond line.' });
  });

  it('returns field details when the PATCH body requests non-editable fields', async () => {
    await mkdir(join(home!, 'agents'), { recursive: true });
    await writeFile(join(home!, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviewer\n---\nReview changes.\n');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const listed = await authedFetch(server, base, `/api/agents?cwd=${encodeURIComponent(home!)}&effective=true`);
    const profile = listNamedAgentProfilesResponseSchema.parse((await listed.json() as Envelope<unknown>).data)
      .items.find((item) => item.name === 'reviewer');
    expect(profile).toBeDefined();

    const response = await authedFetch(server, base, '/api/agents/reviewer', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'user',
        workspace_id: profile?.workspace_id,
        executor_fields: { tools: { state: 'applied' } },
      }),
    });
    const body = (await response.json()) as Envelope<null> & {
      details?: Array<{ path: string; message: string }>;
    };
    expect(body.code).toBe(40001);
    expect(body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/executor_fields|^$/) }),
    ]));
  });

  it('patches main, role models, subagents and model profiles and projects them back', async () => {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const session = await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    expect(((await session.json()) as Envelope<unknown>).code).toBe(0);
    const listed = (await (await authedFetch(server, base, '/api/agents')).json()) as Envelope<unknown>;
    const workspaceId = listNamedAgentProfilesResponseSchema.parse(listed.data).items
      .find((profile) => profile.source === 'user')?.workspace_id;
    expect(workspaceId).toBeTruthy();
    const created = await authedFetch(server, base, '/api/agent-profiles', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId, scope: 'user', name: 'team-lead', description: 'Lead', prompt: 'Lead the team.' }),
    });
    expect(((await created.json()) as Envelope<unknown>).code).toBe(0);
    const patch = await authedFetch(server, base, '/api/agents/team-lead', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: workspaceId, scope: 'user', main: true, restrict_models_to_menu: true,
        allowed_models: ['fixture/a'], allowed_efforts: ['max'], can_spawn_subagents: true, preferred_subagents: ['explore'], deny_subagents: ['blocked'],
        allowed_subagents: ['explore', { name: 'reviewer', model_alias: 'fixture/b', thinking_effort: 'high' }],
        model_profiles: [{ alias: 'fixture/a', when: 'long tasks', thinking_effort: 'max' }],
      }),
    });
    const patched = (await patch.json()) as Envelope<unknown>;
    expect(patched.code).toBe(0);
    expect(patched.data).toMatchObject({
      main: true, restrict_models_to_menu: true, allowed_models: ['fixture/a'], allowed_efforts: ['max'], can_spawn_subagents: true, preferred_subagents: ['explore'], deny_subagents: ['blocked'],
      model_profiles: [{ alias: 'fixture/a', when: 'long tasks', thinking_effort: 'max' }],
    });
    const subagents = (patched.data as { allowed_subagents?: unknown[] }).allowed_subagents;
    expect(subagents?.[0]).toBe('explore');
    expect(subagents?.[1]).toMatchObject({ name: 'reviewer', model_alias: 'fixture/b', thinking_effort: 'high' });
    const text = await readFile(join(home!, 'agents', 'team-lead.md'), 'utf8');
    expect(text).toContain('main: true');
    expect(text).toContain('restrict_models_to_menu: true');
    expect(text.trimEnd().endsWith('Lead the team.')).toBe(true);
  });

  it('reads only the selected agent wire when restoring persisted usage after restart', async () => {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const response = await authedFetch(server, base, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    const created = await response.json() as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const session = server.core.accessor.get(ISessionManager).get(created.data.id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const main = lifecycle.get('main') ?? await lifecycle.create({ agentId: 'main' });
    main.accessor.get(IAgentUsageService).record('priced-fixture', {
      inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0,
    }, undefined, { usageKnown: true });
    main.accessor.get(IAgentUsageService).record('priced-fixture', {
      inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0,
    }, undefined, { usageKnown: false });
    const child = await lifecycle.create({ agentId: 'agent-7' });
    child.accessor.get(IAgentUsageService).record('priced-fixture', {
      inputOther: 20, output: 10, inputCacheRead: 5, inputCacheCreation: 0,
    }, undefined, { usageKnown: true });
    await lifecycle.remove('agent-7');
    await server.close();
    server = undefined;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const wireRead = vi.spyOn(server.core.accessor.get(IAppendLogStore), 'read');
    const restored = await authedFetch(server, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`);
    const data = agentCapabilitiesResponseSchema.parse((await restored.json() as Envelope<unknown>).data);
    expect(data.metrics?.['main']).toMatchObject({ totalTokens: 15, inputTokens: 10, outputTokens: 5, usagePartial: true, costPartial: true, usageSource: 'persisted' });
    expect(data.metrics?.['agent-7']).toBeUndefined();
    const scannedScopes = wireRead.mock.calls.filter(([_scope, key]) => key === AGENT_WIRE_RECORD_KEY)
      .map(([scope]) => scope);
    expect(scannedScopes.length).toBeGreaterThan(0);
    expect(scannedScopes.every((scope) => scope.includes('main'))).toBe(true);
    wireRead.mockClear();
    const childResponse = await authedFetch(server, base, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=agent-7`);
    const childData = agentCapabilitiesResponseSchema.parse((await childResponse.json() as Envelope<unknown>).data);
    expect(childData.metrics?.['agent-7']).toMatchObject({ totalTokens: 35, inputTokens: 25, outputTokens: 10, usagePartial: false, usageSource: 'persisted' });
  });
});

describe('GET /agents named resolution', () => {
  it('resolves a profile hidden from the catalog public view through its resolvable view', async () => {
    const helper = normalizeAgentProfile({
      name: 'hidden-helper', definitionId: 'definition:hidden-helper', systemPrompt: () => '',
    });
    const lead = normalizeAgentProfile({
      name: 'hidden-lead', definitionId: 'definition:hidden-lead',
      allowedSubagents: ['hidden-helper'],
      subagentLeases: { 'hidden-helper': { name: 'hidden-helper', source: './_private/helper.md' } },
      systemPrompt: () => '',
    });
    const exposed = normalizeAgentProfile({ name: 'exposed', definitionId: 'definition:exposed', systemPrompt: () => '' });
    const snapshot = {
      publicProfiles: new Map([[exposed.name, exposed]]),
      resolvableProfiles: new Map([
        [exposed.name, exposed], [lead.name, lead], [helper.name, helper],
      ]),
      routes: new Map(),
      scopedBindings: new Map([[lead.definitionId!, new Map([
        ['hidden-helper', { parentDefinitionId: lead.definitionId!, alias: 'hidden-helper', source: './_private/helper.md', lease: { name: 'hidden-helper', source: './_private/helper.md' }, status: 'ready' as const, profile: helper, sourceDefinitionId: helper.definitionId }],
      ])]]),
      sourceDefinitions: new Map([[helper.definitionId!, helper]]),
      dependencyIndex: new Map(),
      diagnostics: [],
    } as unknown as AgentProfileCatalogSnapshot;
    const catalog = {
      ready: Promise.resolve(),
      get: (name: string) => snapshot.publicProfiles.get(name),
      snapshot: () => snapshot,
    } as unknown as ISessionAgentProfileCatalog;
    const session = {
      accessor: {
        get: (token: unknown) => token === ISessionContext ? { workspaceId: 'wd_named' } : catalog,
      },
    };
    const registration: AgentProfileRegistration = {
      sourceId: 'user', priority: 50, contribution: { profiles: [lead, exposed] },
    };
    const handlers = new Map<string, (req: unknown, reply: { send(payload: unknown): unknown }) => unknown>();
    const app = {
      get: (path: string, _options: unknown, handler: never) => { handlers.set(path, handler); },
      post: () => {},
      patch: () => {},
    };
    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token === IAgentProfileRegistry) return { entries: () => [registration] };
          if (token === IAgentExecutorRegistry) return { get: () => undefined };
          if (token === IModelService) return { list: () => ({}), resolveId: () => undefined };
          if (token === IConfigService) return { ready: Promise.resolve(), get: () => undefined };
          if (token === ISessionManager) return { list: () => [session] };
          throw new Error('unexpected token');
        },
      },
    };

    registerAgentProfilesRoute(
      app as unknown as Parameters<typeof registerAgentProfilesRoute>[0],
      core as unknown as Parameters<typeof registerAgentProfilesRoute>[1],
    );
    let sent: unknown;
    await handlers.get('/agents')!(
      { id: 'req', query: {} },
      { send: (payload) => { sent = payload; } },
    );

    const body = sent as { code: number; data: { items: Array<{ name: string; allowed_subagents?: unknown }> } };
    expect(body.code).toBe(0);
    expect(body.data.items.map((item) => item.name).toSorted()).toEqual(['exposed', 'hidden-lead']);
    expect(body.data.items.find((item) => item.name === 'hidden-lead')?.allowed_subagents).toEqual([
      expect.objectContaining({ name: 'hidden-helper', scope: 'private', status: 'ready' }),
    ]);
  });
});

describe('shipped agent profiles', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-shipped-profiles-'));
  });

  afterEach(async () => {
    if (server !== undefined) await server.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function boot(): Promise<void> {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home!);
    base = `http://127.0.0.1:${server.port}`;
  }

  async function listShipped(): Promise<Array<{ template_id: string; status: string; managed: boolean; active_path?: string }>> {
    const response = await authedFetch(server as RunningServer, base, '/api/agents/shipped');
    expect(response.status).toBe(200);
    const body = await response.json() as Envelope<unknown>;
    expect(body.code).toBe(0);
    return listShippedAgentProfilesResponseSchema.parse(body.data).items;
  }

  async function restore(tail: string): Promise<Envelope<unknown>> {
    const response = await authedFetch(server as RunningServer, base, `/api/agents/shipped/${tail}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    return await response.json() as Envelope<unknown>;
  }

  it('lists materialized templates, tracks edits and removal, and restores the bundled original', async () => {
    await boot();
    const items = await listShipped();
    const managed = items.filter((item) => item.managed);
    expect(managed.map((item) => item.template_id).toSorted()).toEqual(['agent', 'explore', 'general']);
    for (const item of managed) expect(item.status).toBe('clean');

    const general = managed.find((item) => item.template_id === 'general');
    expect(general?.active_path?.replaceAll('\\', '/')).toMatch(/agents\/builtin\/general\.md$/);
    const activePath = general?.active_path as string;
    const originalText = await readFile(activePath, 'utf8');
    expect(originalText).toBe(SHIPPED_AGENT_PROFILE_TEMPLATES.find((template) => template.id === 'general')?.text);

    await writeFile(activePath, `${originalText}\nlocal tweak\n`);
    expect((await listShipped()).find((item) => item.template_id === 'general')?.status).toBe('custom');

    const restored = await restore('general:restore');
    expect(restored.code).toBe(0);
    expect((restored.data as { status: string }).status).toBe('clean');
    expect(await readFile(activePath, 'utf8')).toBe(originalText);
    const backups = await readdir(join(home as string, 'agent-profile-state', 'backups'));
    expect(backups.some((name) => name.includes('general'))).toBe(true);

    await rm(activePath);
    expect((await listShipped()).find((item) => item.template_id === 'general')?.status).toBe('removed');
    const revived = await restore('general:restore');
    expect(revived.code).toBe(0);
    expect(await readFile(activePath, 'utf8')).toBe(originalText);
    expect((await listShipped()).find((item) => item.template_id === 'general')?.status).toBe('clean');
  });

  it('rejects unknown templates and unsupported actions with 40001', async () => {
    await boot();
    expect((await restore('nope:restore')).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect((await restore('general:frobnicate')).code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});
