// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTION_PROTOCOL, type MetaResponse, type RemoteConnection, type Session } from '@kiki/protocol';
import type { HostAdapter } from '../host';
import type { ConnectionSelection } from '../state/connectionConfig';
import { createRemoteSpaceClient, KikiClient } from './client';
import { createScopeConnectionAdapter } from './navScopeConnection';
import { consumeScopeReload, markScopeReload, pendingScopeReloadScope } from './navScope';
import { configureSpaceStorage, spaceStorage } from './spaceStorage';

const id = '11111111-1111-4111-8111-111111111111';
const secondId = '33333333-3333-4333-8333-333333333333';
const targetHome = '22222222-2222-4222-8222-222222222222';
const scope = { homeId: `remote:${id}`, scopeId: `remote:${id}` };
const identity = (homeId: string): MetaResponse => ({ server_home_id: homeId, server_id: 'example-instance', server_version: '0.1.0',
  dangerous_bypass_auth: false, started_at: '2026-01-01T00:00:00Z', open_in_apps: [],
  capabilities: { websocket: true, file_upload: true, fs_query: true, mcp: true, tasks: true } });
const record = (overrides: Partial<RemoteConnection> = {}): RemoteConnection => ({ id, label: 'Example remote', endpoint: 'https://remote.example.test',
  target: { homeId: targetHome, hostId: 'example-host', protocol: CONNECTION_PROTOCOL }, credentialRef: 'example-reference',
  enabled: true, backgroundSummary: false, purposes: ['gui'], state: 'online', activeLeases: 0, ...overrides });
const reply = (data: unknown) => Response.json({ code: 0, msg: 'success', data });
const clients: KikiClient[] = [];

function setup(records: RemoteConnection[] = [record()], homeId = targetHome) {
  const selection: ConnectionSelection = { config: { url: 'http://source.example.test', token: 'source-token' }, persist: false, source: 'desktop', scopeId: 'local' };
  const commit = vi.fn(); const reload = vi.fn(); const nativePrepare = vi.fn();
  const created: KikiClient[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === 'http://source.example.test/api/remote-connections') return reply(records);
    expect(url).toBe(`http://source.example.test/api/remote-connections/${id}/call`);
    expect(JSON.parse(init?.body as string)).toMatchObject({ operation: 'meta' });
    return reply(identity(homeId));
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new KikiClient({ baseUrl: selection.config.url, token: selection.config.token }); clients.push(client);
  const source = { scope: { homeId: 'main', scopeId: 'local' }, selection, client };
  const adapter = createScopeConnectionAdapter({ host: { prepareSpace: nativePrepare, connection: {} } as unknown as HostAdapter,
    active: () => source, local: () => source, control: () => source, commit, reload,
    createClient: (next) => {
      expect(next.source).toBe('remote');
      const remote = createRemoteSpaceClient({ endpoint: next.config.url, token: next.config.token, connectionId: next.connectionId! });
      vi.spyOn(remote.klient, 'close');
      vi.spyOn(remote, 'getSession').mockResolvedValue({ id: 'same-session' } as Session);
      created.push(remote); clients.push(remote); return remote;
    },
  });
  return { adapter, commit, reload, source, created, fetchMock, nativePrepare };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.klient.close()));
  vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); configureSpaceStorage(null);
});

describe('remote scope identity gate', () => {
  it.each([
    { kind: 'network', transport: undefined },
    { kind: 'ssh', transport: { kind: 'ssh' as const, profile: { id: 'example-ssh', label: 'Example SSH', target: { kind: 'alias' as const, alias: 'example-host' },
      releaseChannel: 'stable' as const, remoteHome: '/srv/example', remoteExecutable: 'kiki', remoteShell: 'posix' as const } } },
  ])('enters a $kind record through source control and the same broker before commit', async ({ transport }) => {
    const test = setup([record({ transport })]);
    const original = test.source.selection;
    const prepared = await test.adapter.prepare(scope, new AbortController().signal);
    expect(test.commit).not.toHaveBeenCalled();
    expect(test.source.selection).toBe(original);
    expect(test.nativePrepare).not.toHaveBeenCalled();
    expect(prepared.scope).toEqual({ ...scope, serverHomeId: targetHome, connectionRef: id });
    await prepared.validate('/s/same-session', new AbortController().signal);
    expect(test.created[0]!.getSession).toHaveBeenCalledWith('same-session');
    await prepared.commit();
    expect(test.commit).toHaveBeenCalledWith({ config: original.config, persist: false, source: 'remote', scopeId: scope.scopeId,
      connectionId: id, serverHomeId: targetHome }, test.created[0], identity(targetHome));
    expect(test.reload).toHaveBeenCalledOnce();
    expect(test.commit.mock.invocationCallOrder[0]).toBeLessThan(test.reload.mock.invocationCallOrder[0]!);
    expect(test.fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'http://source.example.test/api/remote-connections', `http://source.example.test/api/remote-connections/${id}/call`,
    ]);
  });

  it('fails closed on persistent home identity mismatch and disposes the candidate', async () => {
    const test = setup([record()], '44444444-4444-4444-8444-444444444444');
    await expect(test.adapter.prepare(scope, new AbortController().signal)).rejects.toMatchObject({ reason: 'identity-mismatch' });
    expect(test.created[0]!.klient.close).toHaveBeenCalledOnce();
    expect(test.commit).not.toHaveBeenCalled(); expect(test.reload).not.toHaveBeenCalled();
    expect(test.source.selection.source).toBe('desktop');
  });

  it.each([
    { name: 'absent', records: [], reason: 'scope-invalid' },
    { name: 'disabled flag', records: [record({ enabled: false })], reason: 'identity-mismatch' },
    { name: 'disabled state', records: [record({ state: 'disabled' })], reason: 'identity-mismatch' },
    { name: 'protocol mismatch', records: [record({ target: { homeId: targetHome, hostId: 'example-host', protocol: 2 as unknown as typeof CONNECTION_PROTOCOL } })], reason: 'identity-mismatch' },
  ])('rejects $name before creating or committing a remote client', async ({ records, reason }) => {
    const test = setup(records);
    await expect(test.adapter.prepare(scope, new AbortController().signal)).rejects.toMatchObject({ reason });
    expect(test.created).toHaveLength(0); expect(test.commit).not.toHaveBeenCalled(); expect(test.reload).not.toHaveBeenCalled();
    expect(test.fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    { homeId: 'remote:bad', scopeId: 'remote:bad' },
    { homeId: 'main', scopeId: scope.scopeId },
    { homeId: scope.homeId, scopeId: 'local' },
  ])('rejects malformed or inconsistent remote discriminator %j without network', async (invalid) => {
    const test = setup();
    await expect(test.adapter.prepare(invalid, new AbortController().signal)).rejects.toMatchObject({ reason: 'scope-invalid' });
    expect(test.fetchMock).not.toHaveBeenCalled(); expect(test.commit).not.toHaveBeenCalled();
  });

  it('returns from remote to its retained browser control without preparing a native remote home', async () => {
    const controlSelection: ConnectionSelection = { config: { url: 'http://source.example.test', token: 'source-token' }, persist: false, source: 'stored', scopeId: 'direct:http://source.example.test' };
    const control = new KikiClient({ baseUrl: controlSelection.config.url }); clients.push(control);
    vi.spyOn(control, 'meta').mockResolvedValue(identity('source-home'));
    const remote = createRemoteSpaceClient({ endpoint: controlSelection.config.url, token: controlSelection.config.token, connectionId: id }); clients.push(remote);
    const nativePrepare = vi.fn(); const commit = vi.fn(); const reload = vi.fn();
    const local = { selection: controlSelection, client: control };
    const adapter = createScopeConnectionAdapter({ host: { connection: {}, prepareSpace: nativePrepare } as unknown as HostAdapter,
      active: () => ({ scope, selection: { ...controlSelection, source: 'remote', connectionId: id, scopeId: scope.scopeId }, client: remote }),
      local: () => local, control: () => local, commit, reload });
    const prepared = await adapter.prepare({ homeId: 'main', scopeId: controlSelection.scopeId! }, new AbortController().signal);
    await prepared.commit();
    expect(nativePrepare).not.toHaveBeenCalled(); expect(reload).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it('closes a cancelled prepared candidate once and leaves the source unchanged', async () => {
    const test = setup(); const controller = new AbortController();
    const prepared = await test.adapter.prepare(scope, controller.signal);
    controller.abort();
    expect(() => prepared.commit()).toThrow();
    await prepared.dispose(); await prepared.dispose();
    expect(test.created[0]!.klient.close).toHaveBeenCalledOnce();
    expect(test.commit).not.toHaveBeenCalled(); expect(test.reload).not.toHaveBeenCalled();
    expect(test.source.selection.source).toBe('desktop');
  });
});

describe('remote reload handoff', () => {
  it('peeks the same handoff without consuming, then retains the credential-free boot scope in memory', () => {
    window.history.replaceState({ key: 'remote-visit' }, '', '/s/same-session');
    markScopeReload({ ...scope, serverHomeId: targetHome, connectionRef: id }, '/s/same-session', 'remote-visit');
    expect(pendingScopeReloadScope()).toEqual({ ...scope, serverHomeId: targetHome, connectionRef: id });
    expect(sessionStorage.length).toBe(1);
    expect(consumeScopeReload(scope.homeId)).toBe(true);
    expect(sessionStorage.length).toBe(0);
    expect(pendingScopeReloadScope()?.scopeId).toBe(scope.scopeId);
    window.history.replaceState({ key: 'next-visit' }, '', '/new');
    expect(pendingScopeReloadScope()).toBeNull();
  });

  it('does not return a stale route/key handoff', () => {
    window.history.replaceState({ key: 'actual' }, '', '/new');
    markScopeReload(scope, '/s/same-session', 'wrong');
    expect(pendingScopeReloadScope()).toBeNull();
    expect(consumeScopeReload(scope.homeId)).toBe(false);
  });

  it('isolates same-session drafts and reading state for two connection ids', () => {
    const key = 'kiki.sessionDraft.same-session';
    configureSpaceStorage({ homeId: scope.homeId }); spaceStorage.setItem(key, 'first draft');
    spaceStorage.setItem('kiki.lastSession', 'same-session');
    configureSpaceStorage({ homeId: `remote:${secondId}` });
    expect(spaceStorage.getItem(key)).toBeNull(); expect(spaceStorage.getItem('kiki.lastSession')).toBeNull();
    spaceStorage.setItem(key, 'second draft');
    configureSpaceStorage({ homeId: scope.homeId }); expect(spaceStorage.getItem(key)).toBe('first draft');
  });
});
