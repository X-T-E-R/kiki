import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
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
  const upstream = (system: string) => stringify({ schema_version: 1, id: 'example', name: 'Example', version: '1.0.0', model: { parameters: { temperature: 0.65, service_tier: 'priority' }, auto_compact: 4096 }, prompts: { system: { text: system }, steering: { text: 'COMMON STEERING' }, main: { system: { file: 'main.md' }, steering: { text: 'MAIN STEERING' } }, independent: 'off' } });
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
  const model = await client.global.kosong.readModel('sample');
  const applied = await client.global.kosong.updateModel('sample', { recipe: installed.installation_id, base_revision: model.revision });
  expect(applied.recipe).toBe(installed.installation_id); expect(applied.issues.some((issue) => issue.code === 'recipe-selected')).toBe(true);
  expect(applied.parameters?.temperature).toBe(0.1); expect(applied.effective_parameters.temperature).toBe(0.65);
  expect(applied.parameter_sources['temperature']).toContain('Recipe example@1.0.0');
  expect(applied.recipe_model_binding).toMatchObject({ installation_id: installed.installation_id, revision: installed.revision, model: { autoCompact: 4096 } });
  await expect(client.global.kosong.updateModel('sample', { display_name: 'Concurrent', base_revision: model.revision })).rejects.toThrow();
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
  const restored = await client.global.kosong.updateModel('sample', { recipe: null, base_revision: applied.revision });
  expect(restored.recipe).toBeUndefined(); expect(restored.cognition?.overlay).toBe('missing-original.md'); expect(restored.prompt_overrides?.fields?.['system.language']).toBe('SAVED ORIGINAL');
  const restDetail = await authedFetch(server, base, `/api/recipes/${installed.installation_id}`);
  expect((await restDetail.json() as { data: RecipeDetail }).data.summary.installation_id).toBe(installed.installation_id);
});
