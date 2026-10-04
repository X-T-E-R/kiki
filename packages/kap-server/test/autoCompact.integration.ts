import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutoCompactStatus, AutoCompactWriteResult } from '@kiki/protocol';
import { getLiveSessionById, IAgentLifecycleService } from '@kiki/agent-core-v2';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
}

const config = [
  'default_model = "test"',
  '[providers.openai]',
  'type = "openai"',
  'api_key = "sk-test"',
  '[models.test]',
  'provider = "openai"',
  'model = "test"',
  'max_context_size = 550000',
  '[models.small]',
  'provider = "openai"',
  'model = "small"',
  'max_context_size = 200000',
  '[loop_control]',
  'compaction_trigger_ratio = 0.85',
  'compaction_soft_context_size = 0',
  '',
].join('\n');

describe('automatic compaction REST contract', () => {
  let home: string;
  let server: RunningServer | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-autocompact-'));
    await writeFile(join(home, 'config.toml'), config);
    await mkdir(join(home, 'agents'), { recursive: true });
    await writeFile(join(home, 'agents', 'custom.md'), '---\nname: custom\ndescription: Custom agent\n---\n\nYou are helpful.\n');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0,
      homeDir: home, logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server?.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<Envelope<T>> {
    const init: RequestInit = {
      method, headers: authHeaders(server!, body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const response = await fetch(`${base}${path}`, init);
    expect(response.status).toBe(200);
    return response.json() as Promise<Envelope<T>>;
  }

  async function create(profile = 'agent'): Promise<string> {
    const result = await request<{ id: string }>('/api/sessions', 'POST', {
      metadata: { cwd: home }, agent_config: { profile, model: 'test' },
    });
    expect(result.code, result.msg).toBe(0);
    return result.data.id;
  }

  it('accepts a 95% session override without changing the inherited reserve ceiling', async () => {
    const id = await create();
    const path = `/api/sessions/${id}/agents/main/auto-compact`;
    const chosen = await request<AutoCompactWriteResult>(path, 'PATCH', { tokens: 522_500 });
    expect(chosen.code, chosen.msg).toBe(0);
    expect(chosen.data).toMatchObject({
      effective: { source: 'session', tokens: 522_500, reservedContextTokens: 50_000 },
      default: { source: 'legacy', tokens: 467_500 },
    });
    expect((await request<AutoCompactStatus>(path)).data.tokens).toBe(522_500);
    expect((await request<AutoCompactWriteResult>(path, 'PATCH', { tokens: 550_000 })).data.effective.tokens).toBe(522_500);
    const saved = await request<AutoCompactWriteResult>(path, 'PATCH', { tokens: 522_500, save: 'model' });
    expect(saved.data).toMatchObject({
      overrideCleared: false,
      effective: { source: 'session', tokens: 522_500 },
      default: { source: 'model', tokens: 500_000 },
    });
    const reset = await request<AutoCompactWriteResult>(path, 'PATCH', { tokens: null });
    expect(reset.data.effective).toMatchObject({ source: 'model', tokens: 500_000 });
  });

  it('persists a per-model session override and promotes model and global defaults', async () => {
    const id = await create();
    const path = `/api/sessions/${id}/agents/main/auto-compact`;
    const initial = await request<AutoCompactStatus>(path);
    expect(initial.data).toMatchObject({ source: 'legacy', tokens: 467_500, effectiveMaxContextTokens: 550_000 });

    const chosen = await request<AutoCompactWriteResult>(path, 'PATCH', { tokens: 400_000 });
    expect(chosen.data.effective).toMatchObject({ source: 'session', tokens: 400_000 });
    const invalid = await request<unknown>(path, 'PATCH', { tokens: '73%' });
    expect(invalid.code).not.toBe(0);
    expect((await request<AutoCompactStatus>(path)).data.tokens).toBe(400_000);

    const model = await request<AutoCompactWriteResult>(path, 'PATCH', { tokens: 400_000, save: 'model' });
    expect(model.data).toMatchObject({ savedAs: 400_000, overrideCleared: true, effective: { source: 'model', tokens: 400_000 } });
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('auto_compact = 400000');
    const models = await request<{ items: Array<{ id: string; auto_compact?: number }> }>('/api/models');
    expect(models.data.items.find((item) => item.id === 'test')).toMatchObject({ auto_compact: 400_000 });

    const global = await request<AutoCompactWriteResult>(path, 'PATCH', { tokens: 420_000, save: 'global' });
    expect(global.data).toMatchObject({ savedAs: '76.36363636%', overrideCleared: false, effective: { source: 'session', tokens: 420_000 }, default: { source: 'model', tokens: 400_000 } });
    const migrated = await readFile(join(home, 'config.toml'), 'utf8');
    expect(migrated).toContain('auto_compact = "76.36363636%"');
    expect(migrated).not.toContain('compaction_trigger_ratio');
    expect(migrated).not.toContain('compaction_soft_context_size');
    await request<AutoCompactWriteResult>(path, 'PATCH', { tokens: null });
    expect((await request<AutoCompactStatus>(path)).data).toMatchObject({ source: 'model', tokens: 400_000 });
  });

  it('restores separate model overrides after switching models and restarting the server', async () => {
    const id = await create();
    const path = `/api/sessions/${id}/agents/main/auto-compact`;
    expect((await request<AutoCompactWriteResult>(path, 'PATCH', { tokens: 350_000 })).data.effective.source).toBe('session');
    const switched = await request<unknown>(`/api/sessions/${id}/profile`, 'POST', { agent_config: { model: 'small' } });
    expect(switched.code, switched.msg).toBe(0);
    expect((await request<AutoCompactStatus>(path)).data).toMatchObject({ source: 'legacy', tokens: 150_000 });
    expect((await request<AutoCompactWriteResult>(path, 'PATCH', { tokens: 120_000 })).data.effective).toMatchObject({ source: 'session', tokens: 120_000 });
    await server?.close();
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    const resumed = await request<unknown>(`/api/sessions/${id}`);
    expect(resumed.code, resumed.msg).toBe(0);
    expect((await request<AutoCompactStatus>(path)).data).toMatchObject({ source: 'session', tokens: 120_000 });
    const switchedBack = await request<unknown>(`/api/sessions/${id}/profile`, 'POST', { agent_config: { model: 'test' } });
    expect(switchedBack.code, switchedBack.msg).toBe(0);
    expect((await request<AutoCompactStatus>(path)).data).toMatchObject({ source: 'session', tokens: 350_000 });
  });

  it('keeps a child Agent override separate even when it uses the parent model', async () => {
    const id = await create();
    const parentPath = `/api/sessions/${id}/agents/main/auto-compact`;
    await request<AutoCompactWriteResult>(parentPath, 'PATCH', { tokens: 330_000 });
    const live = getLiveSessionById(server!.core.accessor, id)!;
    const child = await live.accessor.get(IAgentLifecycleService).create({
      delegator: { kind: 'agent', agentId: 'main' },
      binding: { profile: 'custom', model: 'test' },
    });
    const childPath = `/api/sessions/${id}/agents/${child.id}/auto-compact`;
    expect((await request<AutoCompactStatus>(childPath)).data).toMatchObject({ source: 'legacy', tokens: 467_500 });
    expect((await request<AutoCompactWriteResult>(childPath, 'PATCH', { tokens: 300_000 })).data.effective).toMatchObject({ source: 'session', tokens: 300_000 });
    expect((await request<AutoCompactStatus>(parentPath)).data).toMatchObject({ source: 'session', tokens: 330_000 });
  });

  it('reloads a file-backed profile without overwriting its prompt or model config', async () => {
    const id = await create('custom');
    const path = `/api/sessions/${id}/agents/main/auto-compact`;
    const saved = await request<AutoCompactWriteResult>(path, 'PATCH', { tokens: 320_000, save: 'profile' });
    expect(saved.data).toMatchObject({ overrideCleared: true, effective: { source: 'profile', tokens: 320_000 } });
    const file = await readFile(join(home, 'agents', 'custom.md'), 'utf8');
    expect(file).toContain('auto_compact: 320000');
    expect(file).toContain('You are helpful.');
    expect((await request<AutoCompactStatus>(path)).data).toMatchObject({ source: 'profile', tokens: 320_000 });
  });
});
