// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentCapabilitiesResponse } from '@kiki/protocol';
import { useAgentPanelCatalog } from './useAgentPanelCatalog';

const source = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  const read = vi.fn();
  let ready: Promise<void> = Promise.resolve();
  const events = { on: (name: string, listener: () => void) => {
    let group = listeners.get(name);
    if (group === undefined) { group = new Set(); listeners.set(name, group); }
    group.add(listener);
    return { ready, dispose: () => { group.delete(listener); } };
  } };
  const connection = { spaceKey: 'local', scopeId: 'scope-a', meta: { server_id: 'server-a' }, wsStatus: 'open',
    klient: { global: { agentPanel: { read } }, events, session: () => ({ events }) } };
  return {
    connection,
    read,
    listeners,
    emit: (name: string) => { for (const listener of listeners.get(name) ?? []) listener(); },
    setReady: (next: Promise<void>) => { ready = next; },
  };
});
vi.mock('../../state/connection', () => ({ useOptionalConnection: () => source.connection }));

function answer(name = 'initial'): AgentCapabilitiesResponse {
  return { context: 'live', owner: { agent_id: 'main', profile: name }, available: true, targets: [], tools: [], skills: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let root: Root;
let element: HTMLDivElement;
let queries: QueryClient;
beforeEach(() => {
  source.listeners.clear(); source.read.mockReset(); source.setReady(Promise.resolve());
  source.connection.scopeId = 'scope-a'; source.connection.meta.server_id = 'server-a';
  source.connection.wsStatus = 'open';
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); queries.clear(); element.remove();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
function Consumer({ id, open, revision }: { id: string; open: boolean; revision?: string }) {
  const result = useAgentPanelCatalog({ session_id: 'session-a', agent_id: 'main' }, open, revision);
  return <div data-consumer={id}>{result.data?.owner.profile ?? result.status}</div>;
}
async function render(first: boolean, second = false, revision = '', secondRevision = revision) {
  await act(async () => {
    root.render(<QueryClientProvider client={queries}>
      <Consumer id="first" open={first} revision={revision} /><Consumer id="second" open={second} revision={secondRevision} />
    </QueryClientProvider>);
  });
  for (let index = 0; index < 3; index++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}
async function renderOne(open: boolean, revision = '') {
  await act(async () => {
    root.render(<QueryClientProvider client={queries}><Consumer id="first" open={open} revision={revision} /></QueryClientProvider>);
  });
  for (let index = 0; index < 3; index++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

it('keeps folded catalogs idle, shares a scoped read and aborts only after the last open consumer leaves', async () => {
  const ready = deferred<void>();
  source.setReady(ready.promise);
  const pending = deferred<AgentCapabilitiesResponse>();
  source.read.mockReturnValue(pending.promise);
  await render(false);
  expect(source.read).not.toHaveBeenCalled();
  await render(true, true);
  expect(source.read).toHaveBeenCalledTimes(1);
  const signal: AbortSignal = source.read.mock.calls[0]![1].signal;
  await render(false, true);
  expect(signal.aborted).toBe(false);
  await render(false);
  expect(signal.aborted).toBe(true);
  source.read.mockResolvedValue(answer());
  await render(true);
  expect(source.read).toHaveBeenCalledTimes(2);
  expect(element.querySelector('[data-consumer=first]')?.textContent).toBe('initial');
  pending.resolve(answer('abandoned'));
});

it('starts and displays the HTTP read while global subscription readiness is pending', async () => {
  const ready = deferred<void>();
  source.setReady(ready.promise);
  source.read.mockResolvedValue(answer('pending-ready'));
  await render(true);
  expect(source.read).toHaveBeenCalledTimes(1);
  expect(element.querySelector('[data-consumer=first]')?.textContent).toBe('pending-ready');
});

it('revalidates once when the current subscription batch acknowledges after the read', async () => {
  const ready = deferred<void>();
  source.setReady(ready.promise);
  source.read.mockResolvedValue(answer('initial'));
  await renderOne(true);
  expect(source.read).toHaveBeenCalledTimes(1);
  source.read.mockResolvedValue(answer('acknowledged'));
  ready.resolve();
  await renderOne(true);
  expect(source.read).toHaveBeenCalledTimes(2);
  expect(element.querySelector('[data-consumer=first]')?.textContent).toBe('acknowledged');
});

it('still reads when global subscription readiness rejects', async () => {
  source.setReady(Promise.reject(new Error('subscription unavailable')));
  source.read.mockResolvedValue(answer('rejected-ready'));
  await renderOne(true);
  expect(source.read).toHaveBeenCalledTimes(1);
  expect(element.querySelector('[data-consumer=first]')?.textContent).toBe('rejected-ready');
});

it('does not reread when the old subscription batch acknowledges after the root unmounts', async () => {
  const ready = deferred<void>();
  source.setReady(ready.promise);
  source.read.mockResolvedValue(answer('before-unmount'));
  await render(true);
  expect(source.read).toHaveBeenCalledTimes(1);
  await act(async () => { root.unmount(); });
  ready.resolve();
  await act(async () => { await Promise.resolve(); });
  expect(source.read).toHaveBeenCalledTimes(1);
});

it('rereads the scoped catalog on reconnect without waiting for the original subscription batch', async () => {
  const ready = deferred<void>();
  source.setReady(ready.promise);
  source.read.mockResolvedValue(answer('initial'));
  await renderOne(true);
  expect(source.read).toHaveBeenCalledTimes(1);
  source.connection.wsStatus = 'connecting';
  await renderOne(true);
  source.read.mockResolvedValue(answer('reconnected'));
  source.connection.wsStatus = 'open';
  await renderOne(true);
  expect(source.read).toHaveBeenCalledTimes(2);
  expect(element.querySelector('[data-consumer=first]')?.textContent).toBe('reconnected');
});

it('marks an all-folded catalog stale on reconnect and profile changes without reading until expansion', async () => {
  source.read.mockResolvedValue(answer('initial'));
  await render(true, true);
  expect(source.read).toHaveBeenCalledTimes(1);
  await render(false);
  source.connection.wsStatus = 'connecting';
  await render(false);
  source.connection.wsStatus = 'open';
  await render(false);
  source.read.mockResolvedValue(answer('profile'));
  await render(false, false, 'changed-binding');
  expect(source.read).toHaveBeenCalledTimes(1);
  await render(true, false, 'changed-binding');
  expect(source.read).toHaveBeenCalledTimes(2);
  expect(element.querySelector('[data-consumer=first]')?.textContent).toBe('profile');
});

it('shares reads across a binding revision consumer and a default drawer consumer', async () => {
  source.read.mockResolvedValue(answer('binding-a'));
  await render(true, false, 'binding-a', '');
  expect(source.read).toHaveBeenCalledTimes(1);
  await render(true, true, 'binding-a', '');
  expect(source.read).toHaveBeenCalledTimes(1);
  source.read.mockResolvedValue(answer('binding-b'));
  await render(true, true, 'binding-b', '');
  expect(source.read).toHaveBeenCalledTimes(2);
  expect(element.querySelector('[data-consumer=first]')?.textContent).toBe('binding-b');
});

it('reuses an unchanged catalog across folds and rereads real config/model/plugin/profile revisions in the same scope', async () => {
  source.read.mockResolvedValue(answer());
  await render(true, true);
  await render(false);
  await render(true);
  expect(source.read).toHaveBeenCalledTimes(1);
  source.read.mockResolvedValue(answer('config'));
  await act(async () => { source.emit('config.changed'); });
  await render(true);
  expect(source.read).toHaveBeenCalledTimes(2);
  expect(element.querySelector('[data-consumer=first]')?.textContent).toBe('config');
  await render(false);
  source.read.mockResolvedValue(answer('model'));
  await act(async () => { source.emit('kosong.models.changed'); });
  expect(source.read).toHaveBeenCalledTimes(2);
  await render(true);
  expect(source.read).toHaveBeenCalledTimes(3);
  source.read.mockResolvedValue(answer('plugin'));
  await act(async () => { source.emit('plugins.reloaded'); });
  await render(true);
  expect(source.read).toHaveBeenCalledTimes(4);
  source.read.mockResolvedValue(answer('profile'));
  await render(true, false, 'changed-binding');
  expect(source.read).toHaveBeenCalledTimes(5);
  source.read.mockResolvedValue(answer('other-server'));
  source.connection.meta.server_id = 'server-b';
  await render(true, false, 'changed-binding');
  expect(source.read).toHaveBeenCalledTimes(6);
  expect(element.querySelector('[data-consumer=first]')?.textContent).toBe('other-server');
});

it('discards a response invalidated while its catalog read was in flight', async () => {
  const old = deferred<AgentCapabilitiesResponse>();
  source.read.mockReturnValueOnce(old.promise).mockResolvedValue(answer('current'));
  await render(true, true);
  await act(async () => { source.emit('config.changed'); old.resolve(answer('superseded')); });
  await render(true, true);
  expect(source.read).toHaveBeenCalledTimes(2);
  expect(element.textContent).not.toContain('superseded');
  expect(element.querySelector('[data-consumer=first]')?.textContent).toBe('current');
});
