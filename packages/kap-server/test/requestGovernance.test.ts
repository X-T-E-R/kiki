import { expect, it, vi } from 'vitest';
import { IAppendLogStore, IFileSystemStorageService, IInstantiationService, IRequestGovernance, type Scope } from '@kiki/agent-core-v2';
import { agentActivitySnapshotSchema, requestGovernanceSnapshotSchema } from '@kiki/protocol';
import { registerV2UsageRoutes } from '../src/routes/v2/usage';

type Handler = Parameters<Parameters<typeof registerV2UsageRoutes>[0]['get']>[2];

it('reads realtime request state from the App authority without scanning historical usage or resuming sessions', async () => {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, _options: unknown, handler: Handler) => { routes.set(path, handler); },
    put: () => undefined,
    post: () => undefined,
  };
  const snapshot = requestGovernanceSnapshotSchema.parse({
    domainId: 'this-service', runtimeEpoch: 'epoch-example', seq: 4, asOf: '2026-01-01T00:00:00Z',
    active: 2, queued: 1, coverage: { native: 'managed', external: 'unmanaged' },
    dimensions: [{ dimension: 'model', id: 'model-example', active: 2, queued: 1 }],
    rules: [], waiting: [],
  });
  const agents = agentActivitySnapshotSchema.parse({
    domainId: 'this-service', runtimeEpoch: 'epoch-example', seq: 4, asOf: '2026-01-01T00:00:00Z',
    coverage: 'this_process', unit: 'agent_execution', active: 3, queued: 0, main: 1, subagent: 1, independent: 1,
    queuedMain: 0, queuedSubagent: 0, queuedIndependent: 0, dimensions: [], agents: [], waiting: [], rules: [],
  });
  const get = vi.fn((token: unknown) => {
    if (token === IRequestGovernance) return { snapshot: () => snapshot, agentSnapshot: () => agents };
    if (token === IFileSystemStorageService) return { pathFor: () => undefined };
    if (token === IAppendLogStore) return { onDidWrite: () => ({ dispose() {} }) };
    if (token === IInstantiationService) return { onWillDispose: () => {} };
    throw new Error('realtime usage read resolved an unexpected service');
  });
  const core = { accessor: { get } } as unknown as Scope;
  registerV2UsageRoutes(app, core);
  const governanceReads = () => get.mock.calls.filter((call) => call[0] === IRequestGovernance).length;
  expect(governanceReads()).toBe(0);
  let response: unknown;
  await routes.get('/usage/realtime')!({ id: 'request-example', query: {}, params: {} }, { send: (value) => { response = value; } });
  expect(response).toMatchObject({ code: 0, request_id: 'request-example', data: snapshot });
  expect(governanceReads()).toBe(1);
  await routes.get('/usage/realtime/agents')!({ id: 'agent-example', query: {}, params: {} }, { send: (value) => { response = value; } });
  expect(response).toMatchObject({ code: 0, request_id: 'agent-example', data: agents });
  expect(governanceReads()).toBe(2);
});
