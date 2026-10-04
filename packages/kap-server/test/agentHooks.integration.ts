import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentHooksInspectSchema } from '@kiki/protocol';
import { startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

it('exposes agent hook sources and effective rules through the typed read-only REST route', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-hooks-inspect-'));
  await writeFile(join(home, 'config.toml'), [
    'default_model = "test"', '[search]', 'enabled = false', '[providers.example]', 'type = "openai"', 'api_key = "test-key"',
    '[models.test]', 'provider = "example"', 'model = "test"', 'max_context_size = 10000',
    '[hooks]', 'schema_version = 2', '[[hooks.rules]]', 'id = "focus"', 'event = "step.before"',
    '[hooks.rules.action]', 'type = "inject"', 'text = "Inspect evidence before choosing"', '',
  ].join('\n'));
  const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: authHeaders(server, { 'content-type': 'application/json' }), body: JSON.stringify({ metadata: { cwd: home }, agent_config: { model: 'test' } }) }).then((response) => response.json()) as { code: number; data: { id: string } };
    expect(created.code).toBe(0);
    const read = async (agent = 'main') => fetch(`${base}/api/sessions/${created.data.id}/agents/${agent}/hooks`, { headers: authHeaders(server) }).then((response) => response.json()) as Promise<{ code: number; data: unknown }>;
    const response = await read();
    expect(response.code).toBe(0);
    const view = agentHooksInspectSchema.parse(response.data);
    expect(view.binding).toMatchObject({ executorId: 'native', modelId: 'test' });
    expect(view.rules).toContainEqual(expect.objectContaining({ id: 'user/focus', path: join(home, 'config.toml'), event: 'step.before', action: { type: 'inject' }, active: true, order: 0, completedSteps: 0 }));
    expect(view.sources).toContainEqual({ namespace: 'user', path: join(home, 'config.toml'), status: 'loaded' });
    expect(agentHooksInspectSchema.parse((await read()).data)).toEqual(view);
    expect((await read('missing')).code).not.toBe(0);
  } finally { await server.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});
