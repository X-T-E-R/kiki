import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { ISessionManager } from '@kiki/agent-core-v2/app/sessionManager/sessionManager';
import { IAgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { IAgentProfileService } from '@kiki/agent-core-v2/agent/profile/profile';
import { IAgentPromptService } from '@kiki/agent-core-v2/agent/prompt/prompt';
import { IAgentRuntimeService } from '@kiki/agent-core-v2/agent/runtimeBinding/agentRuntime';
import { ISessionDispatchService } from '@kiki/agent-core-v2/session/dispatch/dispatch';
import { IRecipeSourceReader } from '@kiki/agent-core-v2/app/recipes/recipes';
import { createKlient } from '@kiki/klient/http';
import type { Klient } from '@kiki/klient';
import { stringify } from 'smol-toml';
import type { RecipeDetail, RecipePreview } from '@kiki/protocol';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

let home: string | undefined;
let server: RunningServer | undefined;
let client: Klient | undefined;
afterEach(async () => { await server?.close(); if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

it('installs over the real API, applies with model CAS, inherits and updates atomically, then disables without losing original prompts', async () => {
  home = await mkdtemp(join(tmpdir(), 'kiki-recipe-api-'));
  const source = join(home, 'package'); await mkdir(source);
  const upstream = (system: string) => stringify({ schema_version: 1, id: 'example', name: 'Example', version: '1.0.0', model: { parameters: { temperature: 0.65, service_tier: 'priority' }, auto_compact: 4096 }, options: { research: { name: 'Research', description: 'Include research guidance', default: false, append: { main: { system: { text: 'OPTION GUIDANCE' } } } } }, prompts: { system: { text: system }, steering: { text: 'COMMON STEERING' }, main: { system: { file: 'main.md' }, steering: { text: 'MAIN STEERING' } }, independent: 'off' } });
  await writeFile(join(source, 'recipe.toml'), upstream('COMMON')); await writeFile(join(source, 'main.md'), 'ORIGINAL MAIN');
  await writeFile(join(home, 'config.toml'), stringify({ search_backend: 'minidb', search: { enabled: false }, experimental: { recipes: true, persistence_minidb_readmodel: false }, recipes: { markets: [] },
    default_provider: 'example', default_model: 'sample', providers: { example: { type: 'openai', base_url: 'https://example.test/v1', api_key: 'EXAMPLE_TEST_KEY' } },
    models: { sample: { provider: 'example', model: 'sample', max_context_size: 32768, parameters: { temperature: 0.1 }, cognition: { overlay: 'missing-original.md' }, prompt_overrides: { fields: { 'system.language': 'SAVED ORIGINAL' } } } } }));
  server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  const base = `http://127.0.0.1:${server.port}`;
  client = createKlient({ endpoint: base, token: server.localOwnerToken });
  const response = await authedFetch(server, base, '/api/recipes:preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: { locator: source } }) });
  const envelope = await response.json() as { code: number; msg: string; data: RecipePreview };
  expect(envelope.code, envelope.msg).toBe(0);
  const installed = await client.global.recipes.install({ preview_id: envelope.data.preview_id });
  expect(installed.revision).toBe(envelope.data.digest);
  const defaults = await client.global.recipes.get(installed.installation_id);
  const selected = await client.global.recipes.get(installed.installation_id, { research: true });
  const diagnostic = await client.global.recipes.get(installed.installation_id, { research: true, removed: true });
  expect(defaults?.resolved.branches.main.system).toBe('ORIGINAL MAIN');
  expect(defaults?.resolved.options).toEqual([{ id: 'research', name: 'Research', description: 'Include research guidance', default: false }]);
  expect(defaults?.resolved.option_values).toEqual({ research: false });
  expect(selected?.resolved.branches.main.system).toContain('OPTION GUIDANCE');
  expect(selected?.resolved.options).toEqual(defaults?.resolved.options);
  expect(selected?.resolved.option_values).toEqual({ research: true });
  expect(diagnostic?.resolved.diagnostics).toEqual([expect.objectContaining({ code: 'recipe-option-unknown', path: 'recipe_options.removed' })]);
  expect(selected?.resolved.revision).not.toBe(defaults?.resolved.revision);
  const restSelected = await authedFetch(server, base, `/api/recipes/${installed.installation_id}?recipe_options=${encodeURIComponent(JSON.stringify({ research: true }))}`);
  const restSelectedEnvelope = await restSelected.json() as { code: number; msg: string; data: RecipeDetail };
  expect(restSelectedEnvelope.code, restSelectedEnvelope.msg).toBe(0);
  expect(restSelectedEnvelope.data).toEqual(selected);
  expect(restSelectedEnvelope.data.resolved.branches.main.system).toBe(selected?.resolved.branches.main.system);
  expect(restSelectedEnvelope.data.resolved.options).toEqual(selected?.resolved.options);
  expect(restSelectedEnvelope.data.resolved.option_values).toEqual(selected?.resolved.option_values);
  expect(restSelectedEnvelope.data.resolved.revision).toBe(selected?.resolved.revision);
  const model = await client.global.kosong.readModel('sample');
  const applied = await client.global.kosong.updateModel('sample', { recipe: installed.installation_id, recipe_options: { research: true }, base_revision: model.revision });
  expect(applied.recipe).toBe(installed.installation_id); expect(applied.recipe_options).toEqual({ research: true });
  expect(applied.issues.some((issue) => issue.code === 'recipe-selected')).toBe(true);
  expect(applied.parameters?.temperature).toBe(0.1); expect(applied.effective_parameters.temperature).toBe(0.65);
  expect(applied.parameter_sources['temperature']).toContain('Recipe example@1.0.0');
  expect(applied.recipe_model_binding).toMatchObject({ installation_id: installed.installation_id, revision: selected?.resolved.revision, model: { autoCompact: 4096 },
    options: [{ id: 'research', name: 'Research', description: 'Include research guidance', default: false }], option_values: { research: true } });
  expect(applied.recipe_model_binding?.diagnostics).toBeUndefined();
  expect((await client.global.kosong.readModel('sample')).recipe_options).toEqual({ research: true });
  await expect(client.global.kosong.updateModel('sample', { display_name: 'Concurrent', base_revision: model.revision })).rejects.toThrow();
  const diagnosticApplied = await client.global.kosong.updateModel('sample', { recipe_options: { research: true, removed: true }, base_revision: applied.revision });
  expect(diagnosticApplied.recipe_options).toEqual({ research: true, removed: true });
  expect(diagnosticApplied.recipe_model_binding).toMatchObject({ installation_id: installed.installation_id, revision: diagnostic?.resolved.revision,
    options: [{ id: 'research', name: 'Research', description: 'Include research guidance', default: false }], option_values: { research: true },
    diagnostics: [expect.objectContaining({ code: 'recipe-option-unknown', path: 'recipe_options.removed' })] });
  expect((await client.global.kosong.readModel('sample')).recipe_options).toEqual({ research: true, removed: true });
  const replaced = await client.global.kosong.updateModel('sample', { recipe_options: { research: false }, base_revision: diagnosticApplied.revision });
  expect(replaced.recipe_options).toEqual({ research: false });
  expect(replaced.recipe_model_binding).toMatchObject({ installation_id: installed.installation_id, revision: installed.revision, option_values: { research: false },
    options: [{ id: 'research', name: 'Research', description: 'Include research guidance', default: false }] });
  expect(replaced.recipe_model_binding?.diagnostics).toBeUndefined();
  const retainedOptions = await client.global.kosong.updateModel('sample', { display_name: 'Retained', base_revision: replaced.revision });
  expect(retainedOptions.recipe_options).toEqual({ research: false });
  expect((await client.global.kosong.readModel('sample')).recipe_options).toEqual({ research: false });
  const clearedOptions = await client.global.kosong.updateModel('sample', { recipe_options: null, base_revision: retainedOptions.revision });
  expect(clearedOptions.recipe_options).toBeUndefined();
  expect(clearedOptions.recipe_model_binding).toMatchObject({ installation_id: installed.installation_id, revision: installed.revision, option_values: { research: false },
    options: [{ id: 'research', name: 'Research', description: 'Include research guidance', default: false }] });
  expect((await client.global.kosong.readModel('sample')).recipe_options).toBeUndefined();
  const fork = await client.global.recipes.fork({ installation_id: installed.installation_id, mode: 'extend', id: 'custom', name: 'Custom' });
  const edited = await client.global.recipes.saveLocal({ installation_id: fork.summary.installation_id, expected_revision: fork.summary.revision,
    files: { 'recipe.toml': stringify({ schema_version: 1, id: 'custom', name: 'Custom', version: '1.0.0', extends: { source: installed.source.locator }, prompts: { main: { steering: { text: 'LOCAL STEERING' } } } }) } });
  await writeFile(join(source, 'main.md'), 'UPDATED MAIN');
  const updated = await client.global.recipes.update({ installation_id: edited.summary.installation_id, expected_revision: edited.summary.revision });
  const detail = await client.global.recipes.get(updated.installation_id);
  expect(detail?.resolved.branches.main).toMatchObject({ system: 'UPDATED MAIN', steering: 'LOCAL STEERING' });
  await writeFile(join(source, 'main.md'), 'BROKEN'); await writeFile(join(source, 'recipe.toml'), upstream('NEW') + '\nunknown_key = true\n');
  await expect(client.global.recipes.update({ installation_id: updated.installation_id })).rejects.toThrow();
  const retained = await client.global.recipes.get(updated.installation_id);
  expect(retained?.summary).toMatchObject({ revision: updated.revision, health: 'ready' }); expect(retained?.summary.last_error).toBeDefined();
  const restored = await client.global.kosong.updateModel('sample', { recipe: null, base_revision: clearedOptions.revision });
  expect(restored.recipe).toBeUndefined(); expect(restored.cognition?.overlay).toBe('missing-original.md'); expect(restored.prompt_overrides?.fields?.['system.language']).toBe('SAVED ORIGINAL');
  const restDetail = await authedFetch(server, base, `/api/recipes/${installed.installation_id}`);
  expect((await restDetail.json() as { data: RecipeDetail }).data.summary.installation_id).toBe(installed.installation_id);
});


it('exports portable files over REST and klient without installing or changing the model', async () => {
  home = await mkdtemp(join(tmpdir(), 'kiki-recipe-export-'));
  const source = join(home, 'package'); await mkdir(source);
  await writeFile(join(source, 'recipe.toml'), stringify({ schema_version: 1, id: 'example', name: 'Example', version: '1.0.0', model: { parameters: { temperature: 0.65 } }, prompts: { system: { text: 'PORTABLE BODY' }, steering_interval_steps: 2 } }));
  await writeFile(join(home, 'config.toml'), stringify({ search_backend: 'minidb', search: { enabled: false }, experimental: { recipes: true, persistence_minidb_readmodel: false }, default_provider: 'example', default_model: 'sample', providers: { example: { type: 'openai', base_url: 'https://example.test/v1', api_key: 'EXAMPLE_TEST_KEY' } }, models: { sample: { provider: 'example', model: 'sample', max_context_size: 32768 } } }));
  server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  const base = `http://127.0.0.1:${server.port}`;
  client = createKlient({ endpoint: base, token: server.localOwnerToken });
  const preview = await client.global.recipes.preview({ source: { locator: source } });
  const installed = await client.global.recipes.install({ preview_id: preview.preview_id });
  const local = await client.global.recipes.fork({ installation_id: installed.installation_id, mode: 'copy', id: 'local', name: 'Local' });
  const custom = await client.global.recipes.fork({ installation_id: local.summary.installation_id, mode: 'extend', id: 'custom', name: 'Custom' });
  const before = await client.global.recipes.list(); const model = await client.global.kosong.readModel('sample');
  const exported = await client.global.recipes.export(custom.summary.installation_id);
  const response = await authedFetch(server, base, `/api/recipes/${custom.summary.installation_id}/export`);
  const envelope = await response.json() as { code: number; data: typeof exported };
  expect(envelope.code).toBe(0); expect(envelope.data).toEqual(exported);
  expect(exported.name).toBe('custom-1.0.0.zip'); expect(exported.revision).toBe(custom.summary.revision);
  expect(exported.files['recipe.toml']).toContain('PORTABLE BODY'); expect(exported.files['recipe.toml']).not.toContain('installation:');
  expect(await client.global.recipes.list()).toEqual(before); expect(await client.global.kosong.readModel('sample')).toEqual(model);
});


it('binds profile installation, relative file, and installed market Recipes across new, resume, switch, and dispatch requests', async () => {
  home = await mkdtemp(join(tmpdir(), 'kiki-profile-recipe-api-'));
  const root = home;
  const requests: string[] = [];
  const provider = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    requests.push(JSON.stringify(body.messages));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  try {
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('Provider fixture did not listen');
    await mkdir(join(root, 'agents'));
    await mkdir(join(root, 'package'));
    const content = stringify({ schema_version: 1, id: 'profile-example', name: 'Profile example', version: '1.0.0',
      options: { research: { name: 'Research', default: false } },
      prompts: { system: { text: 'PROFILE RECIPE SYSTEM', when: 'research' }, steering: { text: 'PROFILE RECIPE CUE' } } });
    await writeFile(join(root, 'package/recipe.toml'), content);
    await writeFile(join(root, 'config.toml'), stringify({ search: { enabled: false }, recipes: { markets: [] },
      default_provider: 'example', default_model: 'sample',
      providers: { example: { type: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'EXAMPLE_TEST_KEY' } },
      models: Object.fromEntries(['sample', 'other'].map((name) => [name, { provider: 'example', model: name, max_context_size: 32768 }])) }));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: root, logLevel: 'silent' });
    client = createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken });
    const local = await client.global.recipes.preview({ source: { locator: join(root, 'package') } });
    const installed = await client.global.recipes.install({ preview_id: local.preview_id, update_mode: 'pinned' });
    const reader = server.core.accessor.get(IRecipeSourceReader);
    const marketUrl = 'https://example.test/recipes/catalog.json';
    const marketSource = 'https://example.test/recipes/profile-example/recipe.toml';
    vi.spyOn(reader, 'catalog').mockResolvedValue({ version: 1, recipes: [{ id: 'profile-example', displayName: 'Profile example', version: '1.0.0', source: marketSource }] });
    const open = reader.open.bind(reader);
    vi.spyOn(reader, 'open').mockImplementation(async (source, base) => source.locator === marketSource
      ? { source, read: async () => content } : open(source, base));
    await client.global.recipes.markets.add({ id: 'example', name: 'Example', url: marketUrl, enabled: true });
    const market = (await client.global.recipes.markets.list()).find((value) => value.id === 'example')!;
    expect(market.offline).toBe(false);
    const marketPreview = await client.global.recipes.preview({ source: { locator: market.catalog!.recipes[0]!.source } });
    const marketInstalled = await client.global.recipes.install({ preview_id: marketPreview.preview_id, update_mode: 'pinned' });
    const references = [
      ['installation', `installation:${installed.installation_id}`],
      ['file', '../package/recipe.toml'],
      ['market', marketInstalled.installation_id],
    ];
    const sessions = server.core.accessor.get(ISessionManager);
    for (const [kind, reference] of references) {
      const profileName = `recipe-${kind}`;
      let session = await sessions.create({ workDir: root });
      const workspace = (await client.global.workspaces.list()).find((entry) => entry.root === root)!;
      await client.rest.agents.create({ workspace_id: workspace.id, name: profileName, scope: 'user', description: 'Example recipe role', prompt: 'PROFILE ROLE BODY', pinned_model_alias: 'sample', recipe: reference, recipe_options: { research: true } });
      let agent = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main', binding: { profile: profileName, model: 'sample', thinking: 'off' } });
      const check = async (scenario: string) => {
        const profile = agent.accessor.get(IAgentProfileService);
        const binding = await profile.getCognitionBinding();
        expect(binding.recipe?.resolved.layers?.[0]?.surface, `${kind}:${scenario}`).toBe('profile');
        expect(binding.recipe?.resolved.layers?.[0]?.resolved.option_values).toEqual({ research: true });
        expect(binding.slots.steering).toBe('PROFILE RECIPE CUE');
        const diagnostics = await profile.getPromptDiagnostics();
        expect(diagnostics.recipe_model_binding?.references?.[0]).toMatchObject({ surface: 'profile', name: 'Profile example' });
        expect(diagnostics.channels.find((channel) => channel.id === 'recipe.profile.steering')).toMatchObject({ state: 'effective', recipe: { name: 'Profile example', content: 'PROFILE RECIPE CUE' } });
        expect((await agent.accessor.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: `Check ${scenario}` }] })).state).toBe('completed');
        expect(requests.at(-1), `${kind}:${scenario}`).toContain('PROFILE RECIPE SYSTEM');
        expect(requests.at(-1)).toContain('PROFILE ROLE BODY');
        expect(requests.at(-1)).toContain('PROFILE RECIPE CUE');
      };
      await check('new');
      await sessions.close(session.id);
      session = (await sessions.resume(session.id))!;
      agent = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
      await agent.accessor.get(IAgentProfileService).syncBindingMetadata();
      await check('resume');
      await agent.accessor.get(IAgentProfileService).setModel('other');
      await check('switch');
      const run = await session.accessor.get(ISessionDispatchService).launch({
        delegator: { kind: 'agent', agentId: 'main' }, requesterAgentId: 'main', profileName,
        message: 'Return ok', modelAlias: 'sample', thinkingEffort: 'off',
        runtime: agent.accessor.get(IAgentRuntimeService).inspect(), workDir: root, signal: new AbortController().signal,
      });
      await (await run.started).completion;
      agent = run.child.agent;
      await check('dispatch');
      await sessions.close(session.id);
    }
  } finally {
    vi.restoreAllMocks();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
}, 60_000);
