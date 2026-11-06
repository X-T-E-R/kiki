import { expect, it, vi } from 'vitest';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { createServices } from '#/_base/di/test';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentTaskService } from '#/agent/task/task';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionExecutionControl } from '#/session/executionControl/executionControl';
import { SessionExecutionControl } from '#/session/executionControl/executionControlService';

it.each(['resume', 'cancelPause', 'legacy'] as const)('cold %s preserves necessary owners and skips idle history when indexed', async mode => {
  const documents = new Map<string, unknown>();
  const agents = { owner: { parentAgentId: null }, queued: { parentAgentId: 'owner' }, finite: { parentAgentId: null }, late: { parentAgentId: null } };
  const disposables = new DisposableStore();
  const handles = new Map<string, IAgentScopeHandle>();
  let control!: ISessionExecutionControl;
  const create = vi.fn(async ({ agentId }: { agentId?: string }) => {
    if (agentId === undefined) throw new Error('Explicit identity required');
    control.register(agentId, { pause: async () => undefined, resume: async () => undefined });
    return handles.get(agentId)!;
  });
  const prompt = (queued: boolean): IAgentPromptService => ({ hasQueuedWork: () => queued } as IAgentPromptService);
  for (const id of ['owner', 'queued', 'finite', 'late', ...Array.from({ length: 100 }, (_, index) => `idle-${index}`)]) {
    const service = prompt(id === 'queued');
    handles.set(id, { kind: 'agent', id, accessor: { get: token => {
      if (token === IAgentPromptService) return service as never;
      if (token === IAgentTaskService) return { hasUnfinishedWork: (restoring?: boolean) => restoring || id === 'finite' } as never;
      throw new Error('Only work ownership is inspected');
    } }, dispose: () => {} });
  }
  const services = () => createServices(disposables, { additionalServices: reg => {
    reg.definePartialInstance(IAtomicDocumentStore, {
      get: async <T>(_scope: string, key: string) => documents.get(key) as T | undefined,
      set: async (_scope, key, value) => { documents.set(key, structuredClone(value)); },
    });
    reg.definePartialInstance(ISessionContext, makeSessionContext({ sessionId: 'fixture-session', workspaceId: 'fixture-workspace', sessionScope: 'sessions/fixture', sessionDir: '/fixture', cwd: '/fixture' }));
    reg.definePartialInstance(ISessionMetadata, { update: async () => {}, snapshot: () => ({ id: 'fixture-session', createdAt: 0, updatedAt: 0, archived: false, agents }) });
    reg.definePartialInstance(IAgentLifecycleService, { list: () => [...handles.values()], get: id => handles.get(id), create });
    reg.define(ISessionExecutionControl, SessionExecutionControl);
  } });
  try {
    control = services().get(ISessionExecutionControl);
    const registrations = [...handles.keys()].map(id => control.register(id, { pause: async () => undefined, resume: async () => undefined }));
    await control.pause({ operationId: 'pause-owners' });
    await vi.waitFor(async () => expect((await control.read()).phase).toBe('paused'));
    await control.retainAgent('late');
    expect(documents.get('execution-control.json')).toMatchObject({ requiredAgents: ['queued', 'finite', 'late'] });
    if (mode === 'legacy') {
      const document = documents.get('execution-control.json') as Record<string, unknown>;
      delete document['requiredAgents'];
    }
    await Promise.all(registrations.map(registration => registration.dispose()));
    handles.clear();
    control = services().get(ISessionExecutionControl);
    await control.ready();
    const action = mode === 'legacy' ? 'resume' : mode;
    await expect(control[action]({ operationId: 'release-owners', pauseOperationId: 'pause-owners' })).resolves.toMatchObject({ phase: 'running' });
    const owners = ['owner', 'queued', 'finite', 'late'];
    const expected = mode === 'legacy' ? [...owners, ...Array.from({ length: 100 }, (_, index) => `idle-${index}`)] : owners;
    expect(create.mock.calls.map(([input]) => input.agentId)).toEqual(expected);
    expect(create).toHaveBeenCalledTimes(mode === 'legacy' ? 104 : 4);
  } finally { await disposables.dispose(); }
});
