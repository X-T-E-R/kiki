import { expect, it, vi } from 'vitest';
import { IRequestGovernance, type Scope } from '@kiki/agent-core-v2';
import { requestGovernanceSnapshotSchema } from '@kiki/protocol';
import { registerV2UsageRoutes } from '../src/routes/v2/usage';

type Handler = Parameters<Parameters<typeof registerV2UsageRoutes>[0]['get']>[2];

it('reads realtime request state from the App authority without scanning historical usage or resuming sessions', async () => {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, _options: unknown, handler: Handler) => { routes.set(path, handler); },
    put: () => undefined,
  };
  const snapshot = requestGovernanceSnapshotSchema.parse({
    domainId: 'this-service', runtimeEpoch: 'epoch-example', seq: 4, asOf: '2026-01-01T00:00:00Z',
    active: 2, queued: 1, coverage: { native: 'managed', external: 'unmanaged' },
    dimensions: [{ dimension: 'model', id: 'model-example', active: 2, queued: 1 }],
    rules: [], waiting: [],
  });
  const get = vi.fn((token: unknown) => { expect(token).toBe(IRequestGovernance); return { snapshot: () => snapshot }; });
  const core = { accessor: { get } } as unknown as Scope;
  registerV2UsageRoutes(app, core);
  expect(get).not.toHaveBeenCalled();
  let response: unknown;
  await routes.get('/usage/realtime')!({ id: 'request-example', query: {}, params: {} }, { send: (value) => { response = value; } });
  expect(response).toMatchObject({ code: 0, request_id: 'request-example', data: snapshot });
  expect(get).toHaveBeenCalledTimes(1);
});
