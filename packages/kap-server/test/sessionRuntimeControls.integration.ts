import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileService,
  IModelCatalogMutationService,
  ISessionApprovalService,
  ISessionInteractionService,
  getLiveSessionById,
} from '@kiki/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';
import { createKlient } from '@kiki/klient/http';
import { bearerToken } from './helpers/auth';
import { promiseGate, usePromptFixture } from './helpers/promptFixture';

describe('live session runtime controls', () => {
  const fixture = usePromptFixture();

  it.each(['auto', 'review', 'yolo', 'plan'] as const)('applies %s during a running turn before the next tool admission', async (control) => {
    const received = promiseGate<void>();
    const release = promiseGate<void>();
    let requests = 0;
    const provider = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        const first = requests++ === 0;
        if (first) received.resolve();
        void (async () => {
          if (first) await release.promise;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const delta = first ? { tool_calls: [{ index: 0, id: 'live-write', type: 'function', function: {
            name: 'Write', arguments: JSON.stringify({ path: 'live-control.txt', content: 'applied live' }),
          } }] } : { content: 'Done.' };
          response.end(`data: ${JSON.stringify({ id: 'runtime-control', choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
        })();
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    let loop: IAgentLoopService | undefined;
    try {
      const mutations = fixture.server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
      await mutations.updateModel('stub', { max_context_size: 100000 });
      const created = await fixture.call<{ id: string }>('POST', '/api/sessions', {
        metadata: { cwd: fixture.home },
        agent_config: { execution: { executor: 'native', profile: 'agent' }, permission_mode: 'manual' },
      });
      expect(created.body.code, created.body.msg).toBe(0);
      const id = created.body.data.id;
      const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
      const main = session.accessor.get(IAgentLifecycleService).get('main')!;
      loop = main.accessor.get(IAgentLoopService);
      const binding = main.accessor.get(IAgentProfileService).data().execution;
      const bind = vi.spyOn(main.accessor.get(IAgentProfileService), 'bind');
      const submitted = await fixture.call('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'Write the marker.' }],
      });
      expect(submitted.body.code, submitted.body.msg).toBe(0);
      await received.promise;
      expect(loop.status().state).toBe('running');
      const updated = await fixture.call('POST', `/api/sessions/${id}/profile`, {
        agent_config: control === 'plan' ? { plan_mode: true } : { permission_mode: control },
      });
      expect(updated.body.code, updated.body.msg).toBe(0);
      expect(bind).not.toHaveBeenCalled();
      expect(main.accessor.get(IAgentProfileService).data().execution).toBe(binding);
      release.resolve();
      await loop.settled();
      expect(loop.status()).toMatchObject({ state: 'idle', lastTurnResult: 'completed' });
      expect(session.accessor.get(ISessionApprovalService).listPending()).toEqual([]);
      if (control === 'plan') {
        await expect(readFile(join(fixture.home!, 'live-control.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(await readFile(join(fixture.home!, 'live-control.txt'), 'utf8')).toBe('applied live');
        expect(main.accessor.get(IAgentPermissionModeService).externalOverride).toBe(control);
      }
      expect(requests).toBe(2);
    } finally {
      release.resolve();
      loop?.cancel();
      await loop?.settled();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    }
  });

  it('broadcasts live changes to children without raising their permission ceiling', async () => {
    const id = await fixture.createSession(fixture.home!);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({ agentId: 'child' });
    const limited = await lifecycle.create({ agentId: 'limited' });
    limited.accessor.get(IAgentPermissionModeService).setModeCeiling('manual');
    const changed = await fixture.call('POST', `/api/sessions/${id}/profile`, { agent_config: { permission_mode: 'yolo' } });
    expect(changed.body.code, changed.body.msg).toBe(0);
    expect(child.accessor.get(IAgentPermissionModeService).mode).toBe('yolo');
    expect(limited.accessor.get(IAgentPermissionModeService).mode).toBe('manual');
  });

  it('addresses child modes through the HTTP facade without changing its parent or sibling', async () => {
    const id = await fixture.createSession(fixture.home!);
    const lifecycle = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({ agentId: 'child' });
    const sibling = await lifecycle.create({ agentId: 'sibling' });
    const parentPermission = lifecycle.get('main')!.accessor.get(IAgentPermissionModeService).mode;
    const siblingPermission = sibling.accessor.get(IAgentPermissionModeService).mode;
    child.accessor.get(IAgentPermissionModeService).setModeCeiling('manual');
    const klient = createKlient({ endpoint: fixture.base!, token: bearerToken(fixture.server!) });
    try {
      const agent = klient.session(id).agent('child');
      await agent.setPermission('yolo', { broadcast: false });
      expect(await agent.getPermission()).toBe('manual');
      expect(lifecycle.get('main')!.accessor.get(IAgentPermissionModeService).mode).toBe(parentPermission);
      expect(sibling.accessor.get(IAgentPermissionModeService).mode).toBe(siblingPermission);
      await agent.enterPlan();
      expect(await agent.getPlan()).not.toBeNull();
      expect(await lifecycle.get('main')!.accessor.get(IAgentPlanService).status()).toBeNull();
      await agent.exitPlan();
      expect(await agent.getPlan()).toBeNull();
    } finally { await klient.close(); }
  });

  it('accepts an effort reset through the standalone REST model-switch route', async () => {
    const id = await fixture.createSession(fixture.home!);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const profile = main.accessor.get(IAgentProfileService);
    await profile.bind({ profile: 'agent', model: 'stub', thinking: 'low' });
    const changed = await fixture.call('POST', `/api/sessions/${id}/agents/main/model-switches`, {
      operationId: 'rest-effort-default', model: 'stub', thinking: null, mode: 'direct',
    });
    expect(changed.body.code, changed.body.msg).toBe(0);
    expect(changed.body.data).toMatchObject({ state: 'completed', binding: { model: 'stub', thinking: 'high' } });
    expect(profile.getEffectiveThinkingLevel()).toBe('high');
  });

  it.each(['free', 'gated'] as const)('applies the %s plan gate when creating a session', async (plan_gate) => {
    const created = await fixture.call<{ id: string }>('POST', '/api/sessions', {
      metadata: { cwd: fixture.home },
      agent_config: { plan_gate },
    });
    expect(created.body.code, created.body.msg).toBe(0);
    const id = created.body.data.id;
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    expect(main.accessor.get(IAgentPlanService).planGate).toBe(plan_gate);
    const snapshot = await fixture.call<{ session: { agent_config: { plan_gate: string } } }>('GET', `/api/sessions/${id}/snapshot`);
    expect(snapshot.body.data.session.agent_config.plan_gate).toBe(plan_gate);
  });

  it('updates the active plan gate without another prompt', async () => {
    const id = await fixture.createSession(fixture.home!);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const plan = session.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentPlanService);
    await plan.enter();
    plan.setGate('gated');
    expect(plan.planGate).toBe('gated');
    const changed = await fixture.call('POST', `/api/sessions/${id}/profile`, { agent_config: { plan_gate: 'free' } });
    expect(changed.body.code, changed.body.msg).toBe(0);
    expect(plan.planGate).toBe('free');
    const snapshot = await fixture.call<{ session: { agent_config: { plan_gate: string } } }>('GET', `/api/sessions/${id}/snapshot`);
    expect(snapshot.body.data.session.agent_config.plan_gate).toBe('free');
    expect(await plan.status()).not.toBeNull();
  });

  it.each(['auto', 'yolo'] as const)('keeps an already pending approval explicit after switching to %s', async (mode) => {
    const id = await fixture.createSession(fixture.home!);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const interaction = session.accessor.get(ISessionInteractionService);
    interaction.acquireConsumer('runtime-control-test');
    const approval = session.accessor.get(ISessionApprovalService);
    const response = approval.request({ id: 'pending-live', agentId: 'main', turnId: 1,
      toolCallId: 'pending-call', toolName: 'Write', action: 'Write marker',
      display: { kind: 'generic', summary: 'Write marker' } });
    expect(approval.listPending()).toHaveLength(1);
    const changed = await fixture.call('POST', `/api/sessions/${id}/profile`, { agent_config: { permission_mode: mode } });
    expect(changed.body.code, changed.body.msg).toBe(0);
    expect(approval.listPending().map(item => item.id)).toEqual(['pending-live']);
    approval.decide('pending-live', { decision: 'approved' });
    expect(await response).toEqual({ decision: 'approved' });
    interaction.releaseConsumer('runtime-control-test');
  });
});
