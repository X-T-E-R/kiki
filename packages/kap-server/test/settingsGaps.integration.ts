import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
}

const SEED_TOML = [
  'default_provider = "p"',
  'default_model = "p/m"',
  '',
  '[providers.p]',
  'type = "openai"',
  'base_url = "https://x.test/v1"',
  '',
  '[models."p/m"]',
  'provider = "p"',
  'model = "m"',
  'max_context_size = 100000',
  '',
].join('\n');

// Settings keys that already exist in the engine config but used to be
// rejected or silently dropped by the REST wire: each one must now survive a
// write → config.toml → read round trip.
describe('settings wire round trips', () => {
  let server: RunningServer | undefined;
  let home: string;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-settings-gaps-'));
    await writeFile(join(home, 'config.toml'), SEED_TOML, 'utf-8');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function send<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(server as RunningServer, body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    } as never);
    return (await res.json()) as Envelope<T>;
  }
  const postConfig = (body: unknown) => send<Record<string, unknown>>('POST', '/api/config', body);
  const getConfig = async () => (await send<Record<string, unknown>>('GET', '/api/config')).data;
  const toml = async () => parseToml(await readFile(join(home, 'config.toml'), 'utf-8')) as Record<string, any>;
  const rawToml = () => readFile(join(home, 'config.toml'), 'utf-8');

  it('writes worktree policy and reads it back', async () => {
    const res = await postConfig({
      worktree: { enabled: false, branch_prefix: 'agent/', default_base: 'fresh', git_timeout_ms: 45_000, cleanup: { auto: false, after_days: 3, disposable_ignored: ['node_modules'] } },
    });
    expect(res.code).toBe(0);
    expect((await toml())["worktree"]).toMatchObject({ enabled: false, branch_prefix: 'agent/', default_base: 'fresh', git_timeout_ms: 45_000, cleanup: { auto: false, after_days: 3, disposable_ignored: ['node_modules'] } });
    expect((await getConfig())['worktree']).toMatchObject({ enabled: false, branchPrefix: 'agent/', defaultBase: 'fresh', gitTimeoutMs: 45_000, cleanup: { auto: false, afterDays: 3, disposableIgnored: ['node_modules'] } });
    expect((await postConfig({ worktree: { branch_prefix: 'Bad Prefix' } })).code).not.toBe(0);
    const file = await rawToml();
    expect(file).not.toContain('afterDays');
    expect(file).not.toContain('disposableIgnored');
  });

  it('writes session residency and reads it back', async () => {
    expect((await postConfig({ session_residency: { idle_ttl_ms: 120_000, max_live_sessions: 4, max_queued_restores: 2 } })).code).toBe(0);
    expect((await toml())['session_residency']).toEqual({ idle_ttl_ms: 120_000, max_live_sessions: 4, max_queued_restores: 2 });
    expect((await getConfig())['session_residency']).toMatchObject({ idleTtlMs: 120_000, maxLiveSessions: 4, maxQueuedRestores: 2 });
    expect((await postConfig({ session_residency: { max_live_sessions: 0 } })).code).not.toBe(0);
  });

  it('writes agents.delegation and task.bash_file_tool_hints without dropping them', async () => {
    expect((await postConfig({ agents: { delegation: { sub: false, independent: true } }, task: { bash_file_tool_hints: false } })).code).toBe(0);
    const file = await toml();
    expect(file['agents']).toMatchObject({ delegation: { sub: false, independent: true } });
    expect(file['task']).toMatchObject({ bash_file_tool_hints: false });
    const read = await getConfig();
    expect(read['agents']).toMatchObject({ delegation: { sub: false, independent: true } });
    expect(read['task']).toMatchObject({ bashFileToolHints: false });
  });

  it('accepts loop_control in replace_domains and keeps sibling keys on a merge', async () => {
    expect((await postConfig({ loop_control: { max_steps_per_turn: 40, subagent_context_strategy: 'fresh' } })).code).toBe(0);
    expect((await postConfig({ loop_control: { max_attempts_per_step: 2 } })).code).toBe(0);
    expect((await toml())['loop_control']).toMatchObject({ max_steps_per_turn: 40, max_attempts_per_step: 2, subagent_context_strategy: 'fresh' });
    const replaced = await postConfig({ loop_control: { max_steps_per_turn: 10 }, replace_domains: ['loop_control'] });
    expect(replaced.code).toBe(0);
    expect((await toml())['loop_control']).toEqual({ max_steps_per_turn: 10 });
    expect((await getConfig())['loop_control']).toMatchObject({ maxStepsPerTurn: 10 });
  });

  it('writes retry and thinking.keep and reads them back', async () => {
    const retry = { max_attempts: 4, policies: [{ match: '429', max_attempts: 6, backoff: 1500, retry: true }] };
    expect((await postConfig({ retry, replace_domains: ['retry'], thinking: { keep: 'none' } })).code).toBe(0);
    const file = await toml();
    expect(file['retry']).toMatchObject(retry);
    expect(file['thinking']).toMatchObject({ keep: 'none' });
    const read = await getConfig();
    expect(read['retry']).toMatchObject({ maxAttempts: 4, policies: [{ match: '429', maxAttempts: 6, backoff: 1500, retry: true }] });
    expect(read['thinking']).toMatchObject({ keep: 'none' });
  });

  it('patches advanced model fields through /models and clears them with null', async () => {
    const entity = (await send<{ revision: string }>('GET', '/api/models/p%2Fm')).data;
    const patch = {
      base_revision: entity.revision,
      aliases: ['fast'],
      reasoning_key: 'reasoning_content',
      off_effort: 'none',
      context_budget: 80_000,
      max_input_size: 90_000,
      max_output_size: 8_000,
      adaptive_thinking: true,
      request_params: { store: false, top_k: 20 },
      cognition: { overlay: 'cog/overlay.md', overlay_mode: 'wrap', anchor_steps: 3, anchor_scope: 'turn' },
      prompt_overrides: { fields: { tone: 'terse' } },
      overrides: { max_output_size: 4_000 },
    };
    const updated = await send<Record<string, unknown>>('PATCH', '/api/models/p%2Fm', patch);
    expect(updated.code).toBe(0);
    const { base_revision: _revision, ...fields } = patch;
    expect(updated.data).toMatchObject(fields);
    const model = (await toml())['models']['p/m'];
    expect(model).toMatchObject({
      aliases: ['fast'], reasoning_key: 'reasoning_content', off_effort: 'none', context_budget: 80_000,
      max_input_size: 90_000, max_output_size: 8_000, adaptive_thinking: true,
      request_params: { store: false, top_k: 20 },
      cognition: { overlay: 'cog/overlay.md', overlay_mode: 'wrap', anchor_steps: 3, anchor_scope: 'turn' },
      prompt_overrides: { fields: { tone: 'terse' } },
      overrides: { max_output_size: 4_000 },
    });
    expect((await send<Record<string, unknown>>('GET', '/api/models/p%2Fm')).data).toMatchObject(fields);

    const cleared = await send<Record<string, unknown>>('PATCH', '/api/models/p%2Fm', {
      aliases: null, cognition: null, request_params: null, prompt_overrides: null, overrides: null, context_budget: null,
    });
    expect(cleared.code).toBe(0);
    const after = (await toml())['models']['p/m'];
    for (const key of ['aliases', 'cognition', 'request_params', 'prompt_overrides', 'overrides', 'context_budget']) {
      expect(after).not.toHaveProperty(key);
    }
    expect(after).toMatchObject({ reasoning_key: 'reasoning_content', max_input_size: 90_000 });
  });

  it('writes provider headers and env as write-only values and never reads them back', async () => {
    const res = await send<Record<string, unknown>>('PATCH', '/api/providers/p', {
      model_source: 'discover',
      custom_headers: { 'X-Team': 'blue', Authorization: 'Bearer header-secret' },
      env: { PROXY_TOKEN: 'env-secret' },
    });
    expect(res.code).toBe(0);
    expect(res.data['provider']).toMatchObject({ model_source: 'discover', custom_header_keys: ['X-Team', 'Authorization'], env_keys: ['PROXY_TOKEN'] });
    const provider = (await send<Record<string, unknown>>('GET', '/api/providers/p')).data;
    expect(provider).toMatchObject({ model_source: 'discover', custom_header_keys: ['X-Team', 'Authorization'], env_keys: ['PROXY_TOKEN'] });
    const wire = JSON.stringify([provider, await getConfig()]);
    expect(wire).not.toContain('header-secret');
    expect(wire).not.toContain('env-secret');
    expect(wire).not.toContain('blue');
    // Stored as before: config.toml plus the credential split for secret-looking names.
    const stored = `${await rawToml()}\n${await readFile(join(home, 'credentials', 'credentials.toml'), 'utf-8').catch(() => '')}`;
    expect(stored).toContain('header-secret');
    expect(stored).toContain('env-secret');
    expect((await toml())['providers']['p']).toMatchObject({ model_source: 'discover', custom_headers: { 'X-Team': 'blue' } });

    const removed = await send<Record<string, unknown>>('PATCH', '/api/providers/p', { custom_headers: { 'X-Team': null }, env: { PROXY_TOKEN: null }, model_source: null });
    expect(removed.code).toBe(0);
    const removedProvider = removed.data['provider'] as Record<string, unknown>;
    expect(removedProvider['custom_header_keys']).toEqual(['Authorization']);
    expect(removedProvider).not.toHaveProperty('env_keys');
    expect(removedProvider).not.toHaveProperty('model_source');
  });
});
