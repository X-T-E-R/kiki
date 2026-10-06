import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentHooksInspectSchema } from '@kiki/protocol';
import { closeSessionById, getLiveSessionById, IAgentLifecycleService, IEventDispatcher } from '@kiki/agent-core-v2';
import { ContextAppendLoopEvent } from '@kiki/agent-core-v2/agent/contextMemory/contextEvents';
import { HookRulesConfigured, HookStepPrepared, hookStateKey, semanticRevision } from '@kiki/agent-core-v2/features/externalHooks/agent/hookState';
import { IHookRulesSession } from '@kiki/agent-core-v2/features/externalHooks/session/hookRules';
import { IAgentStateService } from '@kiki/agent-core-v2/agent/state/agentState';
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
    const session = getLiveSessionById(server.core.accessor, created.data.id)!;
    const agent = session.accessor.get(IAgentLifecycleService).get('main')!;
    const rule = session.accessor.get(IHookRulesSession).snapshot().rules[0]!;
    const dispatcher = agent.accessor.get(IEventDispatcher);
    await dispatcher.dispatch(new HookRulesConfigured({ rules: [{ id: rule.id, semanticHash: rule.semanticHash, counterScope: 'agent' }] }));
    const revision = semanticRevision(agent.accessor.get(IAgentStateService).get(hookStateKey).rules[rule.id]!);
    await dispatcher.dispatch(new HookStepPrepared({ stepId: 'step-1', logicalStepId: 'step-1', turnId: 1, modelId: 'test', targets: [{ id: rule.id, partition: 'test', semanticRevision: revision }] }));
    await dispatcher.dispatch(new ContextAppendLoopEvent({ event: { type: 'step.end', uuid: 'step-1', finishReason: 'stop' } }));
    const warm = agentHooksInspectSchema.parse((await read()).data);
    expect(warm.rules[0]?.completedSteps).toBe(1);
    await closeSessionById(server.core.accessor, created.data.id);
    const cold = await read();
    expect(cold.code).toBe(0);
    const coldView = agentHooksInspectSchema.parse(cold.data);
    expect(coldView.rules).toEqual(warm.rules);
    expect(coldView.binding).toEqual(warm.binding);
    expect(coldView.sources).toEqual(warm.sources);
    expect(coldView.diagnostics).toEqual(warm.diagnostics);
    expect(coldView.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(getLiveSessionById(server.core.accessor, created.data.id)?.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
    await mkdir(join(home, '.kiki'), { recursive: true });
    await writeFile(join(home, '.kiki', 'hooks.toml'), 'not [valid toml');
    const invalid = await read();
    expect(invalid.code).toBe(0);
    const invalidView = agentHooksInspectSchema.parse(invalid.data);
    expect(invalidView.sources).toContainEqual({ namespace: 'workspace', path: join(home, '.kiki', 'hooks.toml'), status: 'invalid' });
    expect(invalidView.rules).toEqual(warm.rules);
    expect(invalidView.diagnostics).toHaveLength(1);
  } finally { await server.close(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});
