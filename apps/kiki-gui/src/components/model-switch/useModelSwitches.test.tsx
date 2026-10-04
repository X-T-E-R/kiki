// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KikiClient, type AgentModelSwitchEvent, type QueuedModelSwitch } from '../../lib/client';
import { useModelSwitches, type ModelSwitchesHandle } from './useModelSwitches';

const connection = vi.hoisted(() => ({ scopeId: 'scope-a', identity: {}, list: vi.fn(), subscribe: vi.fn() }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({
  scopeId: connection.scopeId,
  client: { klient: connection.identity, listAgentModelSwitches: connection.list, subscribeAgentModelSwitches: connection.subscribe },
}) }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function entry(id: string, state: QueuedModelSwitch['receipt']['state'] = 'pending', queueIndex = 0): QueuedModelSwitch {
  return { input: { operationId: id, model: `model/${id}`, mode: 'direct' }, revision: 0,
    receipt: { operationId: id, agentId: 'child', state, fromModel: 'model/old', toModel: `model/${id}`, mode: 'direct' },
    originalBinding: { model: 'model/old', thinking: '' }, queueIndex };
}
let root: Root;
let node: HTMLDivElement;
let handle: ModelSwitchesHandle;
let listeners: Array<(event: AgentModelSwitchEvent) => void>;
let ready: ReturnType<typeof deferred<void>>;
function Probe({ session = 's1' }: { session?: string }) { handle = useModelSwitches(session, 'child'); return null; }
async function render(session = 's1') { await act(async () => { root.render(<Probe session={session} />); }); }
async function emit(event: AgentModelSwitchEvent) { await act(async () => { listeners.at(-1)!(event); }); }
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); connection.scopeId = 'scope-a'; connection.identity = {};
  listeners = []; ready = deferred<void>();
  connection.subscribe.mockImplementation((_session, _agent, listener) => { listeners.push(listener); return { ready: ready.promise, dispose: vi.fn() }; });
  connection.list.mockResolvedValue([]);
  node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => { await act(async () => { root.unmount(); }); });

it('does not let an old session list write into the new generation', async () => {
  const old = deferred<readonly QueuedModelSwitch[]>();
  connection.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce([entry('new')]);
  await render(); await render('s2');
  await act(async () => { old.resolve([entry('old')]); });
  expect(handle.switches.map((item) => item.input.operationId)).toEqual(['new']);
});
it.each(['scope', 'client'])('rebinds on true %s identity changes but not per-render wrappers', async (kind) => {
  const old = deferred<readonly QueuedModelSwitch[]>();
  connection.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce([entry('new')]);
  await render(); await render(); expect(connection.subscribe).toHaveBeenCalledTimes(1);
  if (kind === 'scope') connection.scopeId = 'scope-b'; else connection.identity = {};
  await render(); expect(connection.subscribe).toHaveBeenCalledTimes(2);
  await act(async () => { old.resolve([entry('old')]); });
  expect(handle.switches.map((item) => item.input.operationId)).toEqual(['new']);
});
it('does not allow an older list to overwrite a later refresh', async () => {
  const old = deferred<readonly QueuedModelSwitch[]>(); const latest = deferred<readonly QueuedModelSwitch[]>();
  connection.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  await render(); await act(async () => { handle.refresh(); });
  await act(async () => { latest.resolve([entry('new')]); });
  await act(async () => { old.resolve([entry('old')]); });
  expect(handle.switches.map((item) => item.input.operationId)).toEqual(['new']);
});
it('replays queued and completed events newer than an in-flight list', async () => {
  const list = deferred<readonly QueuedModelSwitch[]>(); connection.list.mockReturnValueOnce(list.promise);
  await render(); await emit({ kind: 'queued', entry: entry('one'), queueIndex: 2 });
  await emit({ kind: 'status', operationId: 'one', receipt: entry('one', 'completed').receipt });
  await act(async () => { list.resolve([]); });
  expect(handle.switches).toMatchObject([{ queueIndex: -1, receipt: { state: 'completed' } }]);
});
it('reconciles an unknown status with the list without rolling the status back', async () => {
  const first = deferred<readonly QueuedModelSwitch[]>(); const second = deferred<readonly QueuedModelSwitch[]>();
  connection.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await render(); await emit({ kind: 'status', operationId: 'one', receipt: entry('one', 'completed').receipt });
  await act(async () => { second.resolve([entry('one')]); });
  expect(handle.switches[0]?.receipt.state).toBe('completed');
});
it('does not retain the failed operation old slot when retry enters pending at a new slot', async () => {
  const refreshed = deferred<readonly QueuedModelSwitch[]>();
  connection.list.mockResolvedValueOnce([entry('one', 'failed', 0), entry('two', 'pending', 1)]).mockReturnValueOnce(refreshed.promise);
  await render(); await emit({ kind: 'status', operationId: 'one', receipt: entry('one').receipt });
  expect(handle.switches.find((item) => item.input.operationId === 'one')?.queueIndex).toBe(-1);
  expect(connection.list).toHaveBeenCalledTimes(2);
  await act(async () => { refreshed.resolve([entry('one', 'pending', 3), entry('two', 'pending', 1)]); });
  expect(handle.switches.map((item) => item.input.operationId)).toEqual(['two', 'one']);
});
it('ends failed initial loading with an explicit error and supports an actual retry', async () => {
  connection.list.mockRejectedValueOnce(new Error('list unavailable')).mockResolvedValueOnce([entry('retry')]);
  await render(); expect(handle.loading).toBe(false);
  expect(handle).toMatchObject({ error: { message: 'list unavailable' } });
  await act(async () => { handle.refresh(); });
  expect(handle).toMatchObject({ error: undefined, loading: false });
  expect(handle.switches[0]?.input.operationId).toBe('retry');
});
it('uses the queue tail for future sends and the first operation only for current display', async () => {
  connection.list.mockResolvedValue([entry('running', 'preparing', -1), entry('first', 'pending', 0), entry('last', 'pending', 2)]);
  await render(); expect(handle.active?.input.operationId).toBe('first');
  expect(handle).toMatchObject({ dependency: { input: { operationId: 'last' } } });
});

it('uses the authoritative slot when the first known fact was a pending status', async () => {
  const first = deferred<readonly QueuedModelSwitch[]>(); const second = deferred<readonly QueuedModelSwitch[]>();
  connection.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await render(); await emit({ kind: 'status', operationId: 'retry', receipt: entry('retry').receipt });
  await act(async () => { second.resolve([entry('retry', 'pending', 4)]); });
  expect(handle.switches[0]?.queueIndex).toBe(4);
});
it('keeps the last known list on a refresh failure without hiding the error', async () => {
  connection.list.mockResolvedValueOnce([entry('known')]).mockRejectedValueOnce(new Error('refresh unavailable'));
  await render(); await act(async () => { handle.refresh(); });
  expect(handle.loading).toBe(false); expect(handle.error?.message).toBe('refresh unavailable');
  expect(handle.switches[0]?.input.operationId).toBe('known');
});
it('ignores detached events and the old ready handshake after rebinding', async () => {
  connection.list.mockResolvedValue([entry('new')]);
  await render(); const oldListener = listeners[0]!;
  connection.scopeId = 'scope-b'; await render();
  await act(async () => { oldListener({ kind: 'queued', entry: entry('old'), queueIndex: 0 }); });
  expect(handle.switches.map((item) => item.input.operationId)).toEqual(['new']);
  await act(async () => { ready.resolve(); });
  expect(connection.list).toHaveBeenCalledTimes(3);
});

it('carries the second pending operation selected by the hook through the real GUI client and typed submit to HTTP', async () => {
  connection.list.mockResolvedValue([entry('first-operation', 'pending', 0), entry('second-operation', 'pending', 2)]);
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    if (String(url).endsWith('/api/klient/call')) {
      if (body.procedure.method === 'resume') return Response.json({ code: 0, msg: 'success', data: { id: 's1', kind: 'session' } });
      expect(body.procedure.method).toBe('read');
      return Response.json({ code: 0, msg: 'success', data: { id: 's1', createdAt: 1, updatedAt: 1, archived: false,
        agents: { child: { type: 'sub', executor: 'native' } } } });
    }
    expect(new URL(url).pathname).toBe('/api/sessions/s1/prompts');
    requests.push(body);
    return Response.json({ code: 0, msg: 'success', data: { prompt_id: 'dependent-message', user_message_id: 'dependent-message',
      status: 'queued', content: body.content, created_at: '2026-01-01T00:00:00.000Z' } });
  }));
  const client = new KikiClient({ baseUrl: 'http://example.test' });
  try {
    await render();
    expect(handle.active?.input.operationId).toBe('first-operation');
    await client.sendAgentMessage('s1', 'child', 'continue', [{ type: 'text', text: 'continue' }], 'dependent-message', handle.dependency?.input.operationId);
    expect(requests).toEqual([{ agent_id: 'child', content: [{ type: 'text', text: 'continue' }],
      prompt_id: 'dependent-message', after_model_switch: 'second-operation' }]);
  } finally { await client.klient.close(); vi.unstubAllGlobals(); }
});
