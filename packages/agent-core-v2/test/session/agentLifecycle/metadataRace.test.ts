import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { WireService } from '#/wire/wireService';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentRunHandle } from '#/session/subagent/subagent';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ErrorCodes } from '#/errors';
import { appServices, sessionServices, testAgent, type TestAgentContext } from '../../harness';

const hosts: TestAgentContext[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const ctx of hosts.splice(0)) {
    const lifecycle = ctx.get(IAgentLifecycleService);
    await Promise.all(lifecycle.list().map((handle) => lifecycle.remove(handle.id)));
    await ctx.dispose();
  }
});

async function fixture() {
  let ctx: TestAgentContext;
  ctx = testAgent(sessionServices((reg) => reg.define(IAgentLifecycleService, AgentLifecycleService)),
    appServices((reg) => reg.defineInstance(IRuntimeResolver, {
      _serviceBrand: undefined,
      inspect: () => ctx.get(IAgentRuntimeService).inspect(),
      acquire: (_binding, required) => ctx.get(IAgentRuntimeService).acquire(required),
    })));
  hosts.push(ctx);
  await ctx.ready;
  return { ctx, metadata: ctx.get(ISessionMetadata), lifecycle: ctx.get(IAgentLifecycleService) };
}

function sealGate() {
  const seal = WireService.prototype.seal;
  let release!: () => void;
  let enter!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  vi.spyOn(WireService.prototype, 'seal').mockImplementationOnce(async function (this: WireService) { enter(); await gate; await seal.call(this); });
  return { entered, release };
}

function createInput(model = 'mock-model') {
  return { agentId: 'race-child', delegator: { kind: 'agent' as const, agentId: 'main' },
    labels: { original: 'saved', declared: 'legal', profileName: 'example-role' },
    binding: { model, resolvedProfile: normalizeAgentProfile({ name: 'example-role', tools: [], systemPrompt: () => 'Test role.' }) } };
}

async function completePriorRun(ctx: TestAgentContext) {
  const requester: IAgentScopeHandle = { kind: 'agent', id: 'main', accessor: { get: (id) => ctx.get(id) }, dispose: () => {} };
  await mirrorAgentRun(requester, { agentId: 'race-child', turn: {} as AgentRunHandle['turn'],
    completion: Promise.resolve({ summary: 'New completed result' }) },
    { profileName: 'example-role', signal: new AbortController().signal });
}

const prior: AgentMeta = { type: 'sub', parentAgentId: 'main', delegator: { kind: 'agent', agentId: 'main' },
  model: 'prior-model', status: 'failed', resultSummary: 'Old result',
  labels: { original: 'saved', declared: 'old', profileName: 'example-role' } };

describe('lifecycle metadata replacement race', () => {
  it.each(['success', 'failure'] as const)('preserves completion and labels arriving during a cold create %s', async (outcome) => {
    const { ctx, metadata, lifecycle } = await fixture();
    await metadata.registerAgent('race-child', prior);
    const { entered, release } = sealGate();
    const creating = lifecycle.create(createInput(outcome === 'failure' ? 'unavailable-model' : 'mock-model'));
    await Promise.race([entered, creating.then(() => { throw new Error('The seal gate was not reached'); })]);
    await completePriorRun(ctx);
    await metadata.updateAgent('race-child', (current) => ({ ...current, model: 'mock-model', contextTokens: 44,
      labels: { ...current.labels, original: 'concurrent', declared: 'concurrent', profileName: 'concurrent', newer: 'concurrent-label' } }));
    expect((await metadata.read()).agents?.['race-child']).toMatchObject({ status: 'completed', resultSummary: 'New completed result', labels: { newer: 'concurrent-label' } });
    release();
    if (outcome === 'failure') await expect(creating).rejects.toThrow();
    else await creating;
    expect((await metadata.read()).agents?.['race-child']).toMatchObject({ status: 'completed', resultSummary: 'New completed result',
      model: 'mock-model', contextTokens: 44, parentAgentId: 'main', labels: { original: 'concurrent', newer: 'concurrent-label',
        declared: outcome === 'success' ? 'legal' : 'concurrent', profileName: outcome === 'success' ? 'example-role' : 'concurrent' } });
  });

  it('does not restore an existing metadata entry unregistered while create waits', async () => {
    const { metadata, lifecycle } = await fixture();
    await metadata.registerAgent('race-child', prior);
    const register = vi.spyOn(metadata, 'registerAgent');
    const { entered, release } = sealGate();
    const creating = lifecycle.create(createInput());
    await entered;
    await metadata.unregisterAgent!('race-child');
    release();
    await expect(creating).rejects.toMatchObject({ code: ErrorCodes.AGENT_REMOVED });
    expect((await metadata.read()).agents?.['race-child']).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    expect(lifecycle.get('race-child')).toBeUndefined();
  });

  it('retains first-create registration and cleans a first-create bootstrap failure', async () => {
    const { metadata, lifecycle } = await fixture();
    const register = vi.spyOn(metadata, 'registerAgent');
    await expect(lifecycle.create(createInput('unavailable-model'))).rejects.toThrow();
    expect((await metadata.read()).agents?.['race-child']).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    await lifecycle.create(createInput());
    expect(register).toHaveBeenCalledOnce();
    expect((await metadata.read()).agents?.['race-child']).toMatchObject({ model: 'mock-model', type: 'sub', labels: { declared: 'legal' } });
  });

  it('propagates identity Store failure without replacing the concurrent terminal result or labels', async () => {
    const { ctx, metadata, lifecycle } = await fixture();
    await metadata.registerAgent('race-child', prior);
    const { entered, release } = sealGate();
    const creating = lifecycle.create(createInput());
    await entered;
    await completePriorRun(ctx);
    await metadata.updateAgent('race-child', (current) => ({ ...current, labels: { ...current.labels, newer: 'concurrent-label' } }));
    const store = ctx.get(IAtomicDocumentStore);
    const set = store.set.bind(store);
    let failures = 0;
    vi.spyOn(store, 'set').mockImplementation(async (scope, key, value) => {
      const child = (value as { agents?: Record<string, AgentMeta> }).agents?.['race-child'];
      if (child?.homedir !== undefined && failures === 0) { failures++; throw new Error('Identity Store failed'); }
      await set(scope, key, value);
    });
    release();
    await expect(creating).rejects.toThrow('Identity Store failed');
    expect(failures).toBe(1);
    expect((await metadata.read()).agents?.['race-child']).toMatchObject({ model: 'prior-model', status: 'completed',
      resultSummary: 'New completed result', labels: { original: 'saved', declared: 'old', newer: 'concurrent-label' } });
    expect((await metadata.read()).agents?.['race-child']?.homedir).toBeUndefined();
    expect(lifecycle.get('race-child')).toBeUndefined();
  });

  it('rolls back only still-owned fields after a committed identity acknowledgement fails', async () => {
    const { metadata, lifecycle } = await fixture();
    await metadata.registerAgent('race-child', prior);
    const update = metadata.updateAgent.bind(metadata);
    let changed = false;
    vi.spyOn(metadata, 'updateAgent').mockImplementation(async (agentId, updater) => {
      await update(agentId, updater);
      if (changed || (await metadata.read()).agents?.[agentId]?.homedir === undefined) return;
      changed = true;
      await update(agentId, (current) => ({ ...current, status: 'completed', resultSummary: 'Later result', userLabel: 'Later label',
        labels: { ...current.labels, declared: 'later', newer: 'later' } }));
      throw new Error('Identity acknowledgement failed');
    });
    await expect(lifecycle.create(createInput())).rejects.toThrow('Identity acknowledgement failed');
    expect((await metadata.read()).agents?.['race-child']).toMatchObject({ model: 'prior-model', userLabel: 'Later label',
      status: 'completed', resultSummary: 'Later result', labels: { declared: 'later', newer: 'later' } });
    expect((await metadata.read()).agents?.['race-child']?.homedir).toBeUndefined();
  });
});
