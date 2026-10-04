// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTION_PROTOCOL } from '@kiki/protocol';
import { ConnectionProvider, useConnection } from './connection';
import { consumeScopeReload, markScopeReload, stageRemoteSpaceBoot } from '../lib/navScope';
import { configureSpaceStorage } from '../lib/spaceStorage';

const first = '11111111-1111-4111-8111-111111111111';
const second = '33333333-3333-4333-8333-333333333333';
const homeId = '22222222-2222-4222-8222-222222222222';
const remoteScope = (id: string) => ({ homeId: `remote:${id}`, scopeId: `remote:${id}` });
const mocks = vi.hoisted(() => ({ kind: 'browser' as 'browser' | 'tauri', discover: vi.fn(), remote: vi.fn(), list: vi.fn(), meta: vi.fn(), clients: [] as Array<{ baseUrl: string; connectionId?: string; close: ReturnType<typeof vi.fn> }> }));
vi.mock('../host', () => {
  const host = { get kind() { return mocks.kind; }, connection: { discover: mocks.discover,
    takeScopeConnection: async () => null, onBackendStage: async () => () => {} } };
  return { useHost: () => host };
});
vi.mock('../host/vscode', () => ({ isVscodeWebview: () => false }));
vi.mock('../i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));
vi.mock('../components/ConnectScreen', () => ({ ConnectScreen: () => <div data-connecting /> }));
vi.mock('../lib/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/client')>();
  class Client {
    readonly baseUrl: string;
    readonly connectionId?: string;
    readonly klient;
    constructor(options: { baseUrl: string; connectionId?: string }) {
      this.baseUrl = options.baseUrl; this.connectionId = options.connectionId;
      const close = vi.fn(async () => {});
      this.klient = { close, rest: { connections: { list: mocks.list } },
        events: { on: () => ({ ready: Promise.resolve(), dispose: () => {} }) },
        terminal: { nudge: () => {}, onStatus: () => () => {} } };
      mocks.clients.push({ baseUrl: this.baseUrl, connectionId: this.connectionId, close });
    }
    meta() { return mocks.meta(this.connectionId); }
    getSession(id: string) { return Promise.resolve({ id }); }
    renewLease() { return Promise.resolve(); }
  }
  return { ...actual, KikiClient: Client, createRemoteSpaceClient: (options: { endpoint: string; connectionId: string }) => {
    mocks.remote(options); return new Client({ baseUrl: options.endpoint, connectionId: options.connectionId });
  } };
});

let current: ReturnType<typeof useConnection>;
let queries: QueryClient;
let root: Root | undefined;
let container: HTMLDivElement;
function Surface() {
  current = useConnection(); queries = useQueryClient();
  return <><span data-scope>{current.scopeId}</span><input data-draft defaultValue="source draft" /></>;
}
async function mount() {
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<ConnectionProvider><Surface /></ConnectionProvider>); });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear(); localStorage.clear(); consumeScopeReload('main'); configureSpaceStorage(null);
  window.history.replaceState({ key: 'example-visit' }, '', '/new');
  localStorage.setItem('kiki.connection', JSON.stringify({ url: 'http://source.example.test', token: 'source-token' }));
  mocks.kind = 'browser';
  mocks.discover.mockReset().mockResolvedValue({ config: { url: 'http://source.example.test', token: 'source-token' }, persist: false });
  mocks.clients.length = 0; mocks.remote.mockReset(); mocks.list.mockReset(); mocks.meta.mockReset();
  mocks.list.mockResolvedValue([first, second].map((id) => ({ id, label: 'Example', endpoint: 'https://remote.example.test',
    enabled: true, state: 'online', target: { homeId, protocol: CONNECTION_PROTOCOL, hostId: 'example-host' } })));
  mocks.meta.mockImplementation(async (id?: string) => ({ server_home_id: id ? homeId : 'source-home' }));
});
afterEach(async () => {
  await act(async () => { root?.unmount(); }); root = undefined; container?.remove();
  sessionStorage.clear(); consumeScopeReload('main'); configureSpaceStorage(null);
});

describe('remote ConnectionProvider consumption', () => {
  it('stages broker selection, retains local control, and isolates QueryClients for identical ids', async () => {
    await mount(); const sourceQueries = queries; const sourceScope = current.scopeId;
    sourceQueries.setQueryData(['session', 'same-session'], 'source');
    let prepared = await current.scopeAdapter.prepare(remoteScope(first), new AbortController().signal);
    expect(current.scopeId).toBe(sourceScope);
    expect(container.querySelector<HTMLInputElement>('[data-draft]')?.value).toBe('source draft');
    await act(async () => { await prepared.commit(); });
    expect(mocks.remote).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'http://source.example.test', token: 'source-token', connectionId: first }));
    expect(current.connectionId).toBe(first); expect(current.spaceKey).toBe(`remote:${first}`);
    expect(current.localClient?.baseUrl).toBe('http://source.example.test');
    expect(current.client).not.toBe(current.localClient); expect(current.needsScopeReload).toBe(true);
    expect(queries).not.toBe(sourceQueries); expect(queries.getQueryData(['session', 'same-session'])).toBeUndefined();
    const firstQueries = queries; queries.setQueryData(['session', 'same-session'], 'first');
    prepared = await current.scopeAdapter.prepare(remoteScope(second), new AbortController().signal);
    await act(async () => { await prepared.commit(); });
    expect(current.connectionId).toBe(second); expect(current.spaceKey).toBe(`remote:${second}`);
    expect(queries).not.toBe(firstQueries); expect(queries.getQueryData(['session', 'same-session'])).toBeUndefined();
    prepared = await current.scopeAdapter.prepare(remoteScope(first), new AbortController().signal);
    await act(async () => { await prepared.commit(); });
    expect(queries).toBe(firstQueries); expect(queries.getQueryData(['session', 'same-session'])).toBe('first');
    expect(localStorage.getItem('kiki.connection')).toBe(JSON.stringify({ url: 'http://source.example.test', token: 'source-token' }));
    expect(mocks.clients.every((client) => client.baseUrl === 'http://source.example.test')).toBe(true);
  });

  it('keeps source client, cache, DOM and draft when remote identity fails', async () => {
    await mount(); const source = current; const sourceQueries = queries;
    const input = container.querySelector<HTMLInputElement>('[data-draft]')!; input.value = 'unsaved source';
    mocks.meta.mockResolvedValue({ server_home_id: 'wrong-home' });
    await expect(current.scopeAdapter.prepare(remoteScope(first), new AbortController().signal)).rejects.toMatchObject({ reason: 'identity-mismatch' });
    expect(current.client).toBe(source.client); expect(current.scopeId).toBe(source.scopeId);
    expect(queries).toBe(sourceQueries); expect(container.querySelector('[data-draft]')).toBe(input);
    expect(input.value).toBe('unsaved source'); expect(current.connectionId).toBeNull();
    expect(mocks.clients.find((client) => client.connectionId === first)?.close).toHaveBeenCalledOnce();
  });

  it('resolves a new native window connection-id-only intent through source control and the broker client', async () => {
    mocks.kind = 'tauri'; localStorage.removeItem('kiki.connection');
    expect(stageRemoteSpaceBoot(first)).toBe(true);
    configureSpaceStorage({ homeId: `remote:${first}` });
    expect(consumeScopeReload(`remote:${first}`)).toBe(true);
    await mount();
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.remote).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'http://source.example.test', token: 'source-token', connectionId: first }));
    expect(current.connectionId).toBe(first); expect(current.needsScopeReload).toBe(false);
    expect(mocks.discover).toHaveBeenCalledOnce();
    expect(mocks.clients.every((client) => client.baseUrl === 'http://source.example.test')).toBe(true);
  });

  it('reselects a remote from the consumed reload handoff without mounting local content or requesting a second reload', async () => {
    markScopeReload({ ...remoteScope(first), serverHomeId: homeId, connectionRef: first }, '/new', 'example-visit');
    configureSpaceStorage({ homeId: `remote:${first}` });
    expect(consumeScopeReload(`remote:${first}`)).toBe(true);
    await mount();
    expect(current.connectionId).toBe(first); expect(current.spaceKey).toBe(`remote:${first}`);
    expect(current.needsScopeReload).toBe(false); expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.remote).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'http://source.example.test', connectionId: first }));
    expect(container.querySelector('[data-scope]')?.textContent).toBe(`remote:${first}`);
  });
});
