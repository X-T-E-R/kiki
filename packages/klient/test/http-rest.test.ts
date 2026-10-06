import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HTTP_TRANSPORT_TIMEOUT_REASON, HttpChannel } from '../src/transports/http/channel.js';
import { createConnectionKlient } from '../src/transports/http/index.js';
import { createConnectionTransport } from '../src/transports/http/connections.js';
import { RPCError } from '../src/core/errors.js';
import { threadCommunicationMessageSchema } from '../src/contract/global/threads.js';

function jsonRequestBody(body: unknown): unknown {
  expect(body).toEqual(expect.any(String));
  if (typeof body !== 'string') throw new Error('Expected a JSON request body.');
  return JSON.parse(body);
}

function envelope(data: unknown, code = 0): Response {
  return new Response(JSON.stringify({ code, msg: code === 0 ? 'success' : 'failed', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HTTP REST domains', () => {
  it('reads validated owner-aware metadata pages through authenticated REST without opening an agent', async () => {
    const page = { items: [{ id: 'test-00000001', session_id: 'session/example', owner_agent_id: 'owner', agent_id: 'target',
      source: 'live', kind: 'subagent', description: 'example dispatch', status: 'running', created_at: '2026-06-04T10:00:00.000Z' }],
      owners: [{ owner_agent_id: 'owner', source: 'live', state: 'pending' }],
      coverage: { total_owners: 1, completed_owners: 0, failed_owners: 0, pending_owners: 1, inventory_complete: true, complete: false, failures: [] },
      has_more: true, next_page_token: 'next', partial: false, consistency: 'incremental', started_at: '2026-06-04T10:00:00.000Z', observed_at: '2026-06-04T10:00:00.000Z' };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/sessions/session%2Fexample/agent-tasks');
      expect(url.searchParams.get('page_size')).toBe('1');
      expect(url.searchParams.get('page_token')).toBe('opaque');
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
      return envelope(page);
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      const result = await channel.rest.sessions.listAgentTasks('session/example', { page_size: 1, page_token: 'opaque' }, { timeoutMs: 1000 });
      expect(result).toEqual(page);
      expect(result.items[0]).toMatchObject({ owner_agent_id: 'owner', agent_id: 'target' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(channel.rest.sessions.listAgentTasks('session/example', { page_size: 101 })).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await channel.close(); }
  });
  it('rejects incomplete or contradictory agent-tasks response contracts rather than reporting empty coverage', async () => {
    const responses = [{ items: [] }, { items: [], owners: [],
      coverage: { total_owners: 3, completed_owners: 3, failed_owners: 0, pending_owners: 0, inventory_complete: true, complete: true, failures: [] },
      has_more: false, partial: false, consistency: 'incremental', started_at: '2026-06-04T10:00:00.000Z', observed_at: '2026-06-04T10:00:00.000Z' }];
    const fetchMock = vi.fn(async () => envelope(responses.shift()));
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.sessions.listAgentTasks('session')).rejects.toThrow();
      await expect(channel.rest.sessions.listAgentTasks('session')).rejects.toThrow();
    } finally { await channel.close(); }
  });
  it('omits missing bearer credentials from Cookie broker call, download and upload requests', async () => {
    const captured: RequestInit[] = [];
    const transport = createConnectionTransport({ endpoint: 'http://example.test', connectionId: '11111111-1111-4111-8111-111111111111', fetch: (async (_input, init) => { captured.push(init!); return envelope({}); }) as typeof fetch });
    await transport.fetch('http://remote.test/api/sessions');
    await transport.fetch('http://remote.test/api/files/example');
    await transport.fetch('http://remote.test/api/files', { method: 'POST', body: new FormData() });
    expect(captured).toHaveLength(3);
    for (const init of captured) expect(new Headers(init.headers).has('authorization')).toBe(false);
    const bearer = createConnectionTransport({ endpoint: 'http://example.test', token: 'legacy-secret', connectionId: '11111111-1111-4111-8111-111111111111', fetch: (async (_input, init) => { expect(new Headers(init!.headers).get('authorization')).toBe('Bearer legacy-secret'); return envelope({}); }) as typeof fetch });
    await bearer.fetch('http://remote.test/api/sessions');
  });
  it('reads nb-search key usage only through an explicit authenticated POST, with instance identity in the body', async () => {
    const view = { provider_instance_id: 'account-two', provider_id: 'exa', balance_supported: false, keys: [{ key_index: 1, state: 'unknown' }] };
    const calls: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/nb-search/keys/usage');
      expect(new URL(String(input)).search).toBe('');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
      calls.push(JSON.parse(init.body));
      return envelope(view);
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(channel.rest.nbSearch.keyUsage('account-two')).resolves.toEqual(view);
      await expect(channel.rest.nbSearch.keyUsage('account-two', true)).resolves.toEqual(view);
      expect(calls).toEqual([{ instance_id: 'account-two', refresh: false }, { instance_id: 'account-two', refresh: true }]);
    } finally { await channel.close(); }
  });
  it('reads and explicitly applies persona settings through typed authenticated session routes', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const projected = { personaId: 'example', boundRevision: 'old', latestRevision: 'new', hasUpdate: true, overrides: { model: 'chosen' } };
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ path: new URL(inputUrl).pathname, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : jsonRequestBody(init.body) });
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
      return envelope(projected);
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.sessions.getPersonaSettings('session/example')).resolves.toEqual(projected);
      await channel.rest.sessions.applyPersonaSettings('session/example');
      await channel.rest.sessions.applyPersonaSettings('session/example', { restoreDefaults: true });
      expect(calls).toEqual([
        { path: '/api/sessions/session%2Fexample/persona-settings', method: 'GET', body: undefined },
        { path: '/api/sessions/session%2Fexample/persona-settings', method: 'POST', body: {} },
        { path: '/api/sessions/session%2Fexample/persona-settings', method: 'POST', body: { restoreDefaults: true } },
      ]);
    } finally { await channel.close(); }
  });
  it('previews unsaved model menus through the typed authenticated agent REST facade', async () => {
    const request = { workspace_id: 'workspace', draft: { pinned_model_alias: 'fast', model_profiles: [{ alias: 'premium' }], restrict_models_to_menu: true } };
    const projected = { restrict_models_to_menu: true,
      declared_model_menu: { aliases: ['premium'], default_alias: 'fast', identities: ['provider/premium', 'provider/fast'] },
      effective_model_aliases: ['fast'], added_model_identities: ['provider/fast'], removed_model_identities: ['provider/old'] };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/agents/example%2Fhelper/model-menu:preview');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
      expect(jsonRequestBody(init?.body)).toEqual(request);
      return envelope(projected);
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.agents.previewModelMenu('example/helper', request)).resolves.toEqual(projected);
    } finally { await channel.close(); }
  });
  it('lists presets and creates a derived space through the authenticated homes facade', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
      return path.endsWith('/presets') ? envelope({ items: [{ id: 'kiki', name: 'Kiki', description: 'General-purpose space' }] }) : envelope({ id: 'h-example', name: 'Kiki', preset: 'kiki', path: 'C:/example/kiki' });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      expect((await channel.rest.homes.presets()).items[0]?.id).toBe('kiki');
      await expect(channel.rest.homes.create({ preset: 'kiki', path: 'C:/example/kiki' })).resolves.toMatchObject({ preset: 'kiki' });
      expect(calls).toEqual([
        { path: '/api/homes/presets', method: 'GET', body: undefined },
        { path: '/api/homes', method: 'POST', body: { preset: 'kiki', path: 'C:/example/kiki' } },
      ]);
    } finally { await channel.close(); }
  });
  it('inspects a workspace path through the authenticated REST facade', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? 'GET', body: jsonRequestBody(init?.body) });
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
      return envelope({ isGit: true });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.workspaces.inspect('C:/example/project')).resolves.toEqual({ isGit: true });
      expect(calls).toEqual([{ path: '/api/workspaces:inspect', method: 'POST', body: { root: 'C:/example/project' } }]);
    } finally { await channel.close(); }
  });
  it('lists room rows and sends pin, archive, rename and delete through authenticated room routes', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
      if (path === '/api/rooms/items') return envelope([]);
      if (path === '/api/rooms/missing') return envelope(null, 40001);
      return envelope({ deleted: true });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.rooms.listItems()).resolves.toEqual([]);
      const body = { name: 'Renamed', pinned: true, archived: false };
      await channel.rest.rooms.update('example', body);
      await channel.rest.rooms.delete('example');
      await expect(channel.rest.rooms.update('missing', { archived: true })).rejects.toMatchObject({ code: 40001 });
      expect(calls).toEqual([
        { path: '/api/rooms/items', method: 'GET', body: undefined },
        { path: '/api/rooms/example', method: 'PATCH', body },
        { path: '/api/rooms/example', method: 'DELETE', body: undefined },
        { path: '/api/rooms/missing', method: 'PATCH', body: { archived: true } },
      ]);
    } finally { await channel.close(); }
  });
  it('reads repeated pricing model ids and writes overrides through the shared authenticated transport', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname + url.search, method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : jsonRequestBody(init.body) });
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
      return envelope({ items: [], overrides: {} });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    const update = { overrides: { 'proxy/model': { input_cost_per_token: 0.1, output_cost_per_token: 0.2, currency: 'USD' } } };
    try {
      await channel.rest.usagePricing.get(['proxy/model', 'unknown']);
      await channel.rest.usagePricing.set(update);
      expect(calls).toEqual([
        { path: '/api/usage/pricing?model=proxy%2Fmodel&model=unknown', method: 'GET', body: undefined },
        { path: '/api/usage/pricing', method: 'PUT', body: update },
      ]);
    } finally { await channel.close(); }
  });
  it('exposes shortcut read, replacement and scoped reset with explicit client platform', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ path: new URL(String(input)).pathname + new URL(String(input)).search, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : jsonRequestBody(init.body) });
      return envelope({ preferences: { version: 1, overrides: {} }, bindings: {}, conflicts: [] });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await channel.rest.shortcuts.read('macos');
      await channel.rest.shortcuts.write('windows', { version: 1, overrides: {} });
      await channel.rest.shortcuts.reset('macos', { platform: 'windows', action: 'switcher' });
      expect(calls).toEqual([
        { path: '/api/gui/shortcuts?platform=macos', method: 'GET', body: undefined },
        { path: '/api/gui/shortcuts?platform=windows', method: 'PUT', body: { preferences: { version: 1, overrides: {} } } },
        { path: '/api/gui/shortcuts/reset?platform=macos', method: 'POST', body: { platform: 'windows', action: 'switcher' } },
      ]);
    } finally { await channel.close(); }
  });
  it('exposes catalog listing/import and standalone managed quota, preserving business errors', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname + url.search, body: init?.body === undefined ? undefined : jsonRequestBody(init.body) });
      if (url.pathname === '/api/catalog/providers') return envelope({ items: [] });
      if (url.pathname === '/api/oauth/usage') return envelope({ kind: 'error', message: 'Not signed in' });
      if (url.pathname === '/api/providers:import_catalog') return envelope({ provider: { id: 'example' }, models_imported: 2 });
      if (url.pathname === '/api/providers:import_registry') return envelope(null, 40001);
      throw new Error('unexpected path');
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.catalog.list()).resolves.toEqual({ items: [] });
      await expect(channel.rest.catalog.importProvider({ catalog_id: 'example', id: 'local', base_url: 'https://example.test', api_key: 'YOUR_API_KEY' })).resolves.toMatchObject({ models_imported: 2 });
      await expect(channel.rest.catalog.importRegistry({ url: 'https://example.test/api.json' })).rejects.toMatchObject({ code: 40001 });
      await expect(channel.rest.oauth.usage('example')).resolves.toEqual({ kind: 'error', message: 'Not signed in' });
      expect(calls).toEqual([
        { path: '/api/catalog/providers', body: undefined },
        { path: '/api/providers:import_catalog', body: { catalog_id: 'example', id: 'local', base_url: 'https://example.test', api_key: 'YOUR_API_KEY' } },
        { path: '/api/providers:import_registry', body: { url: 'https://example.test/api.json' } },
        { path: '/api/oauth/usage?provider=example', body: undefined },
      ]);
    } finally { await channel.close(); }
  });

  it('uses the auth-exempt unversioned health endpoint', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/healthz');
      expect(init?.method).toBe('GET');
      expect(init?.headers).not.toHaveProperty('authorization');
      return envelope({ ok: true });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.healthz()).resolves.toBe(true);
    } finally {
      await channel.close();
    }
  });

  it('routes unversioned session and runtime domains through /api', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/sessions') {
        return envelope({ items: [], has_more: false });
      }
      if (url.pathname === '/api/mcp/runtime/servers') {
        return envelope({ servers: [] });
      }
      throw new Error(`unexpected path: ${url.pathname}`);
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.sessions.list()).resolves.toEqual({ items: [], has_more: false });
      await expect(channel.rest.runtime.listMcpServers()).resolves.toEqual({ servers: [] });
      expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
        '/api/sessions',
        '/api/mcp/runtime/servers',
      ]);
    } finally {
      await channel.close();
    }
  });

  it('uses typed space management, override restoration and explicit SSH credential copying routes', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : jsonRequestBody(init.body) });
      if (path === '/api/homes' && init?.method === 'GET') return envelope({ items: [{ id: 'main', name: 'Main space', path: '/main', primary: true }] });
      if (path === '/api/homes' || path === '/api/homes:attach') return envelope({ id: 'h-abc', name: 'Secret', path: '/space' });
      if (path.endsWith('/ssh-copy-candidates')) return envelope({ hosts: [{ hostId: 'prod', name: 'Production', credential_kinds: ['password'] }] });
      if (path.startsWith('/api/homes/') && init?.method === 'PATCH') return envelope({ space: { id: 'h-abc', name: 'Secret', path: '/space', credentials_shared: false }, restart_required: true, copied_ssh_entries: 1 });
      if (path.startsWith('/api/homes/')) return envelope({ items: [] });
      if (path === '/api/config/overrides:remove') return envelope({ providers: {} });
      if (path === '/api/ssh/credentials:copy-to-isolated') return envelope({ hosts: [{ hostId: 'prod', copied: 1 }] });
      throw new Error(`unexpected path: ${path}`);
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.homes.list()).resolves.toMatchObject({ items: [{ id: 'main' }] });
      await channel.rest.homes.create({ name: 'Secret', path: '/space', inherit: { credentials: 'isolated' } });
      await channel.rest.homes.attach({ path: '/space' });
      await expect(channel.rest.homes.sshCopyCandidates('h-abc')).resolves.toMatchObject({ hosts: [{ hostId: 'prod' }] });
      await expect(channel.rest.homes.update('h-abc', { inherit: { credentials: 'isolated' }, copy_ssh_credentials: { hosts: [{ hostId: 'prod' }] } })).resolves.toMatchObject({ restart_required: true, copied_ssh_entries: 1 });
      await channel.rest.homes.remove('h-abc');
      await channel.rest.homes.erase('h-abc', { confirm_name: 'Secret' });
      await channel.rest.config.removeOverride({ domain: 'default_permission_mode', key_path: [] });
      await channel.rest.ssh.copySharedCredentialsToIsolated({ hosts: [{ hostId: 'prod' }] });
      expect(calls).toEqual([
        { path: '/api/homes', method: 'GET', body: undefined },
        { path: '/api/homes', method: 'POST', body: { name: 'Secret', path: '/space', inherit: { credentials: 'isolated' } } },
        { path: '/api/homes:attach', method: 'POST', body: { path: '/space' } },
        { path: '/api/homes/h-abc/ssh-copy-candidates', method: 'GET', body: undefined },
        { path: '/api/homes/h-abc', method: 'PATCH', body: { inherit: { credentials: 'isolated' }, copy_ssh_credentials: { hosts: [{ hostId: 'prod' }] } } },
        { path: '/api/homes/h-abc', method: 'DELETE', body: undefined },
        { path: '/api/homes/h-abc:delete', method: 'POST', body: { confirm_name: 'Secret' } },
        { path: '/api/config/overrides:remove', method: 'POST', body: { domain: 'default_permission_mode', key_path: [] } },
        { path: '/api/ssh/credentials:copy-to-isolated', method: 'POST', body: { hosts: [{ hostId: 'prod' }] } },
      ]);
    } finally {
      await channel.close();
    }
  });

  it('browses and attaches local sessions using encoded source IDs and typed REST requests', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname + url.search, method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : jsonRequestBody(init.body) });
      return envelope(url.pathname.endsWith('/resume') ? { session_id: 'session-kiki', executor_id: 'claude-acp', created: true }
        : url.search ? { root: '/vendor/projects', exists: true, items: [], truncated: false, unreadable_files: 0, resume_enabled: true }
          : { summary: { id: 'external:claude:source' }, messages: [], warnings: ['transcript_sampled'] });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.executors.listLocalSessions('claude-acp', { limit: 10 })).resolves.toMatchObject({ items: [] });
      await expect(channel.rest.executors.getLocalSession('claude-acp', 'external:claude:source')).resolves.toMatchObject({ warnings: ['transcript_sampled'] });
      await expect(channel.rest.executors.resumeLocalSession('claude-acp', 'external:claude:source', { source_home: '/vendor' })).resolves.toMatchObject({ session_id: 'session-kiki', created: true });
      expect(calls).toEqual([
        { path: '/api/executors/claude-acp/local-sessions?limit=10', method: 'GET', body: undefined },
        { path: '/api/executors/claude-acp/local-sessions/external%3Aclaude%3Asource', method: 'GET', body: undefined },
        { path: '/api/executors/claude-acp/local-sessions/external%3Aclaude%3Asource/resume', method: 'POST', body: { source_home: '/vendor' } },
      ]);
    } finally { await channel.close(); }
  });

  it('posts typed rendered-prompt previews to an encoded agent profile path', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/agents/reviewer%2Fcodex/executor-prompt:preview');
      expect(init?.method).toBe('POST');
      expect(jsonRequestBody(init?.body)).toEqual({ executor: 'codex-app-server', workspace: 'wd-1' });
      return envelope({ executor: 'codex-app-server', delivery: { requested: 'append', actual: 'append', downgraded: false },
        blocks: [{ id: 'body', text: 'Review code' }], text: 'Review code' });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.agents.previewExecutorPrompt('reviewer/codex', {
        executor: 'codex-app-server', workspace: 'wd-1',
      })).resolves.toMatchObject({ blocks: [{ id: 'body', text: 'Review code' }] });
    } finally {
      await channel.close();
    }
  });

  it('routes managed worktree methods with encoded ids and loss confirmation', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url: url.pathname + url.search, method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : jsonRequestBody(init.body) });
      if (url.pathname.endsWith(':gc')) return envelope({ candidates: [] });
      if (url.pathname.endsWith(':remove')) return envelope({ outcome: 'removed' });
      if (url.pathname.endsWith(':inspect')) return envelope({ failed: false });
      if (url.pathname === '/api/worktrees') return envelope({ worktrees: [] });
      return envelope({ id: 'wt/a' });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await channel.rest.worktrees.list({ workspace_id: 'workspace-1', state: 'ready' });
      await channel.rest.worktrees.get('wt/a');
      await channel.rest.worktrees.inspect('wt/a');
      await channel.rest.worktrees.remove('wt/a', { confirmLoss: { dirty: true, ignored: false, unpushed: false } });
      await channel.rest.worktrees.gc(true);
      expect(calls).toEqual([
        { url: '/api/worktrees?workspace_id=workspace-1&state=ready', method: 'GET', body: undefined },
        { url: '/api/worktrees/wt%2Fa', method: 'GET', body: undefined },
        { url: '/api/worktrees/wt%2Fa:inspect', method: 'POST', body: {} },
        { url: '/api/worktrees/wt%2Fa:remove', method: 'POST', body: { confirmLoss: { dirty: true, ignored: false, unpushed: false } } },
        { url: '/api/worktrees:gc', method: 'POST', body: { dryRun: true } },
      ]);
    } finally {
      await channel.close();
    }
  });

  it('routes SSH management through typed authenticated REST methods', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url: url.pathname + url.search, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : jsonRequestBody(init.body) });
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-token');
      if (url.pathname.endsWith(':status')) return envelope({ hostId: 'dev', state: 'idle', generation: 0 });
      if (url.pathname === '/api/ssh/connection-approval') return envelope({ enabled: init?.method !== 'PUT' });
      if (url.pathname.includes('/ssh/approvals/')) return envelope({ resolved: true });
      if (url.pathname.endsWith('/ssh/hosts/dev') && init?.method === 'PUT') return envelope({ host: { id: 'dev', name: 'Dev', source: 'kiki' } });
      if (url.pathname.endsWith('/ssh/hosts/dev') && init?.method === 'DELETE') return envelope({ removed: true });
      return envelope({ hosts: [] });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'server-token', fetch: fetchMock as typeof fetch });
    try {
      await channel.rest.ssh.list('workspace-1');
      await expect(channel.rest.ssh.upsert('dev', { name: 'Dev', roots: ['/home/tester'] }, 'workspace-1'))
        .resolves.toMatchObject({ host: { id: 'dev', name: 'Dev' } });
      await expect(channel.rest.ssh.status('dev')).resolves.toMatchObject({ state: 'idle', generation: 0 });
      await expect(channel.rest.ssh.connectionApproval()).resolves.toEqual({ enabled: true });
      await expect(channel.rest.ssh.setConnectionApproval(false)).resolves.toEqual({ enabled: false });
      await expect(channel.rest.ssh.sessionHosts('session/one')).resolves.toEqual({ hosts: [] });
      await expect(channel.rest.ssh.addSessionHost('session/one', 'dev')).resolves.toMatchObject({ host: { id: 'dev' } });
      await expect(channel.rest.ssh.removeSessionHost('session/one', 'dev')).resolves.toEqual({ removed: true });
      await expect(channel.rest.ssh.submitApproval('session/one', 'approval/one', {
        decision: 'approved', credential: { password: 'TEST_SECRET', save: 'session' },
      })).resolves.toEqual({ resolved: true });
      expect(calls).toEqual([
        { url: '/api/ssh/hosts?workspace_id=workspace-1', method: 'GET', body: undefined },
        { url: '/api/ssh/hosts/dev?workspace_id=workspace-1', method: 'PUT', body: { name: 'Dev', roots: ['/home/tester'] } },
        { url: '/api/ssh/hosts/dev:status', method: 'GET', body: undefined },
        { url: '/api/ssh/connection-approval', method: 'GET', body: undefined },
        { url: '/api/ssh/connection-approval', method: 'PUT', body: { enabled: false } },
        { url: '/api/sessions/session%2Fone/ssh/hosts', method: 'GET', body: undefined },
        { url: '/api/sessions/session%2Fone/ssh/hosts/dev', method: 'PUT', body: {} },
        { url: '/api/sessions/session%2Fone/ssh/hosts/dev', method: 'DELETE', body: undefined },
        { url: '/api/sessions/session%2Fone/ssh/approvals/approval%2Fone', method: 'POST',
          body: { decision: 'approved', credential: { password: 'TEST_SECRET', save: 'session' } } },
      ]);
    } finally {
      await channel.close();
    }
  });

  it('reads built-in skill content by name without passing its URI to the file endpoint', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(new URL(String(input)).pathname).toBe('/api/skills/kiki%2Fops:content');
      return envelope({ name: 'kiki/ops', content: '# Built-in instructions' });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.skills.readBuiltinContent('kiki/ops')).resolves.toEqual({
        name: 'kiki/ops', content: '# Built-in instructions',
      });
    } finally {
      await channel.close();
    }
  });

  it('reads one encoded provider entry from the model directory', async () => {
    const catalog = { id: 'edge/gateway', models: [] };
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(new URL(String(input)).pathname).toBe('/api/catalog/providers/edge%2Fgateway');
      return envelope(catalog);
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.catalog.provider('edge/gateway')).resolves.toEqual(catalog);
    } finally {
      await channel.close();
    }
  });

  it('posts unsaved provider probes through the authenticated HTTP transport', async () => {
    const draft = { type: 'anthropic' as const, base_url: 'https://api.example.test/v1', api_key: 'draft-key' };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/providers:probe');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual(draft);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-token');
      return envelope({ ok: true, models: ['claude-example'] });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'server-token', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.providers.probe(draft)).resolves.toEqual({ ok: true, models: ['claude-example'] });
    } finally {
      await channel.close();
    }
  });

  it('routes saved provider tests, health history and executor listings over authenticated REST', async () => {
    const seen: Array<{ path: string; method: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-token');
      const path = new URL(String(input)).pathname;
      seen.push({ path, method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : jsonRequestBody(init.body) });
      return envelope(path === '/api/executors' ? { items: [] }
        : path.endsWith(':health') ? { items: [] }
          : { provider_id: 'gateway/one', ok: true, checked_at: 1, duration_ms: 1 });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'server-token', fetch: fetchMock as typeof fetch });
    try {
      await channel.rest.providers.test('gateway/one');
      await channel.rest.providers.health();
      await channel.rest.executors.list();
      expect(seen).toEqual([
        { path: '/api/providers/gateway%2Fone:test', method: 'POST', body: {} },
        { path: '/api/providers:health', method: 'GET', body: undefined },
        { path: '/api/executors', method: 'GET', body: undefined },
      ]);
    } finally {
      await channel.close();
    }
  });

  it('requires bearer and affirmative confirmation in the model migration REST facade', async () => {
    const revision = 'a'.repeat(64);
    const backup = 'config.toml.generation-backup-123e4567-e89b-42d3-a456-426614174000';
    const seen: Array<{ path: string; method: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-token');
      const path = new URL(String(input)).pathname;
      seen.push({ path, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body as string) });
      return envelope(path.endsWith('/apply') ? { backup_key: backup, revision } : path.endsWith('/restore') ? { revision } : { revision, changes: [], needs_review: [], backups: [] });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'server-token', fetch: fetchMock as typeof fetch });
    try {
      await channel.rest.config.previewModelGenerationMigration();
      await channel.rest.config.applyModelGenerationMigration(revision);
      await channel.rest.config.restoreModelGenerationMigration(backup, revision);
      expect(seen).toEqual([
        { path: '/api/config/model-generation-migration', method: 'GET', body: undefined },
        { path: '/api/config/model-generation-migration/apply', method: 'POST', body: { revision, confirmed: true } },
        { path: '/api/config/model-generation-migration/restore', method: 'POST', body: { backup_key: backup, revision, confirmed: true } },
      ]);
    } finally {
      await channel.close();
    }
  });

  it('reads full cron details and sends create/update bodies with separate source and target sessions', async () => {
    const calls: { path: string; method: string; body: unknown; session: string | null }[] = [];
    const task = { id: 'task/example', prompt: 'full prompt' };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : jsonRequestBody(init.body), session: url.searchParams.get('session_id') });
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
      return envelope({ task });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      expect((await channel.rest.cron.get('task/example', { session_id: 'source' })).task.prompt).toBe('full prompt');
      await channel.rest.cron.create({ session_id: 'target', cron: '0 * * * *', prompt: 'new' });
      await channel.rest.cron.update('task/example', { session_id: 'target', prompt: 'edit' }, { session_id: 'source' });
      expect(calls).toEqual([
        { path: '/api/cron/task%2Fexample', method: 'GET', body: undefined, session: 'source' },
        { path: '/api/cron', method: 'POST', body: { session_id: 'target', cron: '0 * * * *', prompt: 'new' }, session: null },
        { path: '/api/cron/task%2Fexample', method: 'PATCH', body: { session_id: 'target', prompt: 'edit' }, session: 'source' },
      ]);
    } finally { await channel.close(); }
  });

  it('routes cron list and task actions through /api/cron with the disambiguating session query', async () => {
    const seen: { pathname: string; method: string; sessionId: string | null }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({
        pathname: url.pathname,
        method: init?.method ?? 'GET',
        sessionId: url.searchParams.get('session_id'),
      });
      if (url.pathname === '/api/cron') return envelope({ items: [] });
      if (url.pathname.endsWith(':pause') || url.pathname.endsWith(':resume')) {
        return envelope({ task: { id: 'task-1' } });
      }
      if (url.pathname.endsWith(':run')) return envelope({ triggered: true });
      return envelope({ deleted: true });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.cron.list()).resolves.toEqual({ items: [] });
      await expect(channel.rest.cron.list({ session_id: 'session-1' })).resolves.toEqual({ items: [] });
      await channel.rest.cron.pause('task-1', { session_id: 'session-1' });
      await channel.rest.cron.resume('task-1');
      await channel.rest.cron.run('task-1', { session_id: 'session-1' });
      await channel.rest.cron.remove('task-1', { session_id: 'session-1' });
      expect(seen).toEqual([
        { pathname: '/api/cron', method: 'GET', sessionId: null },
        { pathname: '/api/cron', method: 'GET', sessionId: 'session-1' },
        { pathname: '/api/cron/task-1:pause', method: 'POST', sessionId: 'session-1' },
        { pathname: '/api/cron/task-1:resume', method: 'POST', sessionId: null },
        { pathname: '/api/cron/task-1:run', method: 'POST', sessionId: 'session-1' },
        { pathname: '/api/cron/task-1', method: 'DELETE', sessionId: 'session-1' },
      ]);
    } finally {
      await channel.close();
    }
  });

  it('sends the owning agent id when reading task details', async () => {
    const task = { id: 'task-1', output_preview: 'child output' };
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/sessions/session-1/tasks/task-1');
      expect(url.searchParams.get('with_output')).toBe('true');
      expect(url.searchParams.get('agent_id')).toBe('agent-a');
      return envelope(task);
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(
        channel.rest.sessions.getTask('session-1', 'task-1', {
          with_output: true,
          agent_id: 'agent-a',
        }),
      ).resolves.toEqual(task);
    } finally {
      await channel.close();
    }
  });

  it('sends lease ids in the REST body and returns the server lease', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return envelope({ lease_id: 'lease_test', expires_at: 123 });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.renewLease({})).resolves.toEqual({ lease_id: 'lease_test', expires_at: 123 });
      await expect(channel.rest.renewLease({ lease_id: 'lease_test' })).resolves.toEqual({
        lease_id: 'lease_test',
        expires_at: 123,
      });
      expect(bodies).toEqual([{}, { lease_id: 'lease_test' }]);
    } finally {
      await channel.close();
    }
  });

  it('uses the dedicated runtime MCP restart action without a version alias', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/mcp/runtime/servers/server%2Fone:restart');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({});
      return envelope({ restarting: true });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.runtime.restartMcpServer('server/one')).resolves.toEqual({ restarting: true });
    } finally {
      await channel.close();
    }
  });

  it('preserves raw attachment bytes, MIME, and server filename', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => new Response(new Uint8Array([0, 255, 7]), {
      status: 200,
      headers: {
        'content-type': 'image/png; charset=binary',
        'content-disposition': "inline; filename*=UTF-8''diagram%20final.png",
      },
    }));
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      const result = await channel.rest.sessions.media('session one', 'file/diagram');
      expect([...result.bytes]).toEqual([0, 255, 7]);
      expect(result.mime).toBe('image/png');
      expect(result.name).toBe('diagram final.png');
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
        '/api/sessions/session%20one/media/file%2Fdiagram',
      );
    } finally {
      await channel.close();
    }
  });

  it('requests bounded text and validates cached media with conditional headers', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/fs:content')) {
        expect(init?.headers).toMatchObject({ range: 'bytes=0-7' });
        return new Response('abcdefgh', { status: 206, headers: { 'content-range': 'bytes 0-7/100' } });
      }
      expect(init?.headers).toMatchObject({ 'if-none-match': '"cached"' });
      return new Response(null, { status: 304, headers: { etag: '"cached"' } });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.filesystem.previewHostFile('/tmp/large.txt', 8)).resolves.toEqual({
        text: 'abcdefgh', truncated: true,
      });
      const media = await channel.rest.sessions.media('s1', 'f1', { ifNoneMatch: '"cached"' });
      expect(media.notModified).toBe(true);
      expect(media.bytes.byteLength).toBe(0);
    } finally {
      await channel.close();
    }
  });

  it('keeps valid JSON files as raw bytes, even when they resemble an envelope', async () => {
    const envelopeShaped = '{"code":50001,"msg":"file document","data":{"ok":true}}';
    const ordinaryJson = '{"items":[1,2,3]}';
    const fetchMock = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      const body = path.includes('/media/') ? envelopeShaped : ordinaryJson;
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      const media = await channel.rest.sessions.media('s1', 'document.json');
      const hostFile = await channel.rest.filesystem.readHostFileBytes('/tmp/document.json');
      expect([...media.bytes]).toEqual([...new TextEncoder().encode(envelopeShaped)]);
      expect(media.mime).toBe('application/json');
      expect([...hostFile.bytes]).toEqual([...new TextEncoder().encode(ordinaryJson)]);
      expect(hostFile.mime).toBe('application/json');
    } finally {
      await channel.close();
    }
  });

  it('keeps archive JSON errors and non-2xx errors on the error path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 50001,
        msg: 'archive.failed',
        data: { archive: 'missing' },
        request_id: 'req-archive',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 40101,
        msg: 'auth.required',
        data: { route: 'export' },
        request_id: 'req-auth',
      }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.sessions.export('s1')).rejects.toMatchObject({
        name: 'RPCError',
        code: 50001,
        requestId: 'req-archive',
        data: { archive: 'missing' },
      });
      await expect(channel.rest.sessions.export('s1')).rejects.toMatchObject({
        name: 'RPCError',
        code: 40101,
        requestId: 'req-auth',
        data: { route: 'export' },
      });
    } finally {
      await channel.close();
    }
  });

  it('propagates envelope errors with request metadata', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 40410,
      msg: 'workspace.not_found',
      data: { workspace_id: 'missing' },
      request_id: 'req-rest',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.workspaces.remove('missing')).rejects.toMatchObject({
        name: 'RPCError',
        code: 40410,
        requestId: 'req-rest',
        data: { workspace_id: 'missing' },
      });
    } finally {
      await channel.close();
    }
  });
});

describe('native HTTP response lifecycle', () => {
  const server = createServer((_request, response) => handler(response));
  let handler: (response: ServerResponse) => void;
  let channel: HttpChannel;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function later(action: () => void, delay: number): void {
    timers.add(setTimeout(action, delay));
  }

  beforeEach(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing TCP address');
    channel = new HttpChannel({ endpoint: `http://127.0.0.1:${address.port}`, timeoutMs: 100 });
  });

  afterEach(async () => {
    await channel.close();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  });

  it('rejects oversized UTF-8 requests before opening a connection and preserves the input', async () => {
    let reached = false;
    handler = (response) => {
      reached = true;
      response.end(JSON.stringify({ code: 0, msg: 'success', data: null }));
    };
    const input = { text: '文'.repeat(4 * 1024 * 1024) };
    await expect(channel.call({}, 'example', 'write', [input], { timeoutMs: 0 })).rejects.toMatchObject({ code: 40001, message: expect.stringContaining('size limit') });
    expect(reached).toBe(false);
    expect(input.text.length).toBe(4 * 1024 * 1024);
  });

  it.each(['json', 'binary'] as const)('bounds a stalled %s body after headers on a real socket', async (kind) => {
    handler = (response) => {
      response.writeHead(200, { 'content-type': kind === 'json' ? 'application/json' : 'application/octet-stream' });
      response.write(kind === 'json' ? '{"code":0,' : 'partial file');
    };
    const operation = kind === 'json' ? channel.rest.meta() : channel.rest.sessions.media('s', 'f');
    await expect(operation).rejects.toMatchObject({ code: 50001, reason: HTTP_TRANSPORT_TIMEOUT_REASON });
  });

  it.each(['json', 'binary'] as const)('reports a severed %s body as connection failure, not malformed JSON or timeout', async (kind) => {
    handler = (response) => {
      response.writeHead(200, { 'content-type': kind === 'json' ? 'application/json' : 'application/octet-stream', 'content-length': '1024' });
      response.write(kind === 'json' ? '{"code":0,' : 'partial file');
      later(() => response.destroy(), 15);
    };
    const operation = kind === 'json' ? channel.rest.meta() : channel.rest.sessions.media('s', 'f');
    await expect(operation).rejects.toMatchObject({ name: 'RPCError', code: -1 });
  });

  it('distinguishes a complete malformed document from a server failure envelope', async () => {
    handler = (response) => response.end('{broken');
    await expect(channel.rest.meta()).rejects.toMatchObject({ code: 200, message: 'HTTP 200 — non-JSON response' });
    handler = (response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 50001, msg: 'upstream failed', request_id: 'server-failure' }));
    };
    await expect(channel.rest.meta()).rejects.toMatchObject({ code: 50001, message: 'upstream failed', reason: undefined, requestId: 'server-failure' });
  });

  it('does not accept an HTTP failure merely because its JSON claims success', async () => {
    handler = (response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, msg: 'success', data: { ok: true } }));
    };
    await expect(channel.rest.meta()).rejects.toMatchObject({ code: 503 });
  });

  it.each(['skill', 'preview', 'original'] as const)('applies explicit reading deadlines and body cancellation to %s text reads', async (kind) => {
    const read = (options: import('../src/index.js').HttpRestRequestOptions) => kind === 'skill'
      ? channel.rest.skills.readBuiltinContent('example', options)
      : kind === 'preview' ? channel.rest.filesystem.previewHostFile('/example', 8, options)
        : channel.rest.filesystem.readHostFile('/example', options);
    const document = kind === 'skill' ? JSON.stringify({ code: 0, msg: 'success', data: { name: 'example', content: '# instructions' } }) : 'preview!';
    handler = (response) => {
      response.writeHead(kind === 'preview' ? 206 : 200, { 'content-type': kind === 'skill' ? 'application/json' : 'text/plain', 'content-range': 'bytes 0-7/24' });
      response.write(document.slice(0, 1));
      later(() => response.end(document.slice(1)), 180);
    };
    const result = await read({ timeoutMs: 0 });
    expect(result).toEqual(kind === 'skill' ? { name: 'example', content: '# instructions' } : kind === 'preview' ? { text: 'preview!', truncated: true } : 'preview!');
    await expect(read({ timeoutMs: 10 })).rejects.toMatchObject({ reason: HTTP_TRANSPORT_TIMEOUT_REASON });
    let notifyHeaders!: () => void;
    const headers = new Promise<void>((resolve) => { notifyHeaders = resolve; });
    let disconnected = false;
    handler = (response) => {
      response.once('close', () => { disconnected = true; });
      response.writeHead(200, { 'content-type': kind === 'skill' ? 'application/json' : 'text/plain' });
      response.write(document.slice(0, 1));
      notifyHeaders();
    };
    const controller = new AbortController();
    const operation = read({ signal: controller.signal, timeoutMs: 0 }).catch((error: unknown) => error);
    await headers;
    controller.abort();
    expect(await operation).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(disconnected).toBe(true));
  });

  it('keeps long export body consumption alive without the default deadline', async () => {
    handler = (response) => {
      response.writeHead(200, { 'content-type': 'application/zip' });
      response.write('archive-');
      later(() => response.end('complete'), 180);
    };
    const archive = await channel.rest.sessions.export('s');
    expect(await archive.blob.text()).toBe('archive-complete');
  });

  it('cancels the ignored body of an optional missing route instead of leaving its socket active', async () => {
    let disconnected = false;
    handler = (response) => {
      response.once('close', () => { disconnected = true; });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.write('{"code":40401,');
    };
    await channel.rest.renewLease({});
    await vi.waitFor(() => expect(disconnected).toBe(true), { timeout: 300 });
  });

  it.each(['caller', 'close'] as const)('keeps %s cancellation attached until the native response body finishes', async (action) => {
    let notifyHeaders!: () => void;
    const headersSent = new Promise<void>((resolve) => { notifyHeaders = resolve; });
    handler = (response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"code":0,');
      notifyHeaders();
    };
    const controller = new AbortController();
    const operation = channel.call({}, 'example', 'read', [], { signal: controller.signal, timeoutMs: 0 }).catch((error: unknown) => error);
    await headersSent;
    if (action === 'caller') controller.abort();
    else await channel.close();
    const failure = await operation;
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toMatchObject({ reason: HTTP_TRANSPORT_TIMEOUT_REASON });
    if (action === 'close') expect(failure).toMatchObject({ message: 'http closed' });
    await channel.close();
  });

  it('preserves envelope-shaped JSON host files exactly on native fetch', async () => {
    const document = '{"code":40111,"msg":"document, not error","data":null}\n';
    handler = (response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(document);
    };
    expect(await channel.rest.filesystem.readHostFile('/document.json')).toBe(document);
    expect(new TextDecoder().decode((await channel.rest.filesystem.readHostFileBytes('/document.json')).bytes)).toBe(document);
  });
});

describe('communication history REST', () => {
  it('preserves failure codes and diagnostics in REST and validates the facade enum', async () => {
    const endpoint = { ref: { host_id: 'host', workspace_id: 'workspace', session_id: 'target' }, deleted: false, archived: false };
    const item = { message_id: 'message', source: { kind: 'thread', thread: endpoint }, target: endpoint,
      content: 'handoff', accepted_at: 1, target_seq: 1, delivery: 'undeliverable',
      reason_code: 'thread_archived', reason_detail: 'diagnostic', reason: 'diagnostic' };
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: vi.fn(async () => envelope({ items: [item] })) as typeof fetch });
    try {
      expect((await channel.rest.threads.messages({})).items).toEqual([item]);
    } finally { await channel.close(); }
    const ref = { hostId: 'host', workspaceId: 'workspace', sessionId: 'target' };
    const target = { ref, deleted: false, archived: false };
    const facade = { messageId: 'message', source: { kind: 'thread', thread: target }, target,
      content: 'handoff', acceptedAt: 1, targetSeq: 1, delivery: 'undeliverable',
      reasonCode: 'thread_archived', reasonDetail: 'diagnostic', reason: 'diagnostic' };
    expect(threadCommunicationMessageSchema.parse(facade)).toEqual(facade);
    expect(threadCommunicationMessageSchema.safeParse({ ...facade, reasonCode: 'unregistered_failure' }).success).toBe(false);
  });
  it('preserves history preparation and coverage generation through the typed endpoint', async () => {
    const page = { items: [], incomplete: 'history_preparing', history: { generation: 'example-generation', state: 'error',
      processedMessages: 3, completedShards: 1, totalShards: 16, pending: 'all', error: 'example failure' } };
    const fetchMock = vi.fn(async () => envelope(page));
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try { expect(await channel.rest.threads.messages({})).toEqual(page); }
    finally { await channel.close(); }
  });
  it('preserves workspace, pair and cursor filters on the typed read endpoint', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/threads/messages');
      expect(Object.fromEntries(url.searchParams)).toEqual({ workspace_id: 'ws-a', session_id: 'a',
        peer_session_id: 'b', cursor: 'page-2', limit: '1' });
      return envelope({ items: [], next_cursor: 'page-3', incomplete: 'scan_budget' });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      expect(await channel.rest.threads.messages({ workspace_id: 'ws-a', session_id: 'a',
        peer_session_id: 'b', cursor: 'page-2', limit: 1 })).toEqual({ items: [], next_cursor: 'page-3', incomplete: 'scan_budget' });
    } finally { await channel.close(); }
  });
});


describe('typed browser settings transport', () => {
  it('keeps tab and capability reads separate from lifecycle actions and only requests schemas explicitly', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const status = { browser: 'work', state: 'ready', executionHost: 'local', generation: 1 };
    const tabs = { browser: 'work', status, tabs: [{ tabId: 'target-1', targetId: 'target-1', title: 'Example' }] };
    const catalog = { browser: 'work', status, backendToolCount: 156, contextIsolation: 'opaque-context-through-window',
      capabilities: [{ name: 'agent_browser_snapshot', description: 'Read the page', group: 'page', surface: 'operation' }] };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.body !== undefined && typeof init.body !== 'string') throw new Error('Expected a JSON request body');
      calls.push({ path: url.pathname + url.search, method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(init.body) });
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
      if (url.pathname.endsWith(':tabs')) return envelope(tabs);
      if (url.pathname.endsWith(':catalog')) return envelope(catalog);
      return envelope(status);
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.browser.tabs('work')).resolves.toEqual(tabs);
      await expect(channel.rest.browser.catalog('work')).resolves.toEqual(catalog);
      await channel.rest.browser.catalog('work', { includeSchema: true });
      await channel.rest.browser.check('work');
      await channel.rest.browser.connect('work');
      await channel.rest.browser.disconnect('work');
      expect(calls).toEqual([
        { path: '/api/browser/connections/work:tabs', method: 'GET', body: undefined },
        { path: '/api/browser/connections/work:catalog', method: 'GET', body: undefined },
        { path: '/api/browser/connections/work:catalog?includeSchema=true', method: 'GET', body: undefined },
        { path: '/api/browser/connections/work:check', method: 'POST', body: {} },
        { path: '/api/browser/connections/work:connect', method: 'POST', body: {} },
        { path: '/api/browser/connections/work:disconnect', method: 'POST', body: {} },
      ]);
    } finally { await channel.close(); }
  });

  it('preserves structured disabled reasons and disconnected failures rather than inventing empty tabs', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const disconnected = new URL(String(input)).pathname.endsWith(':tabs');
      return new Response(JSON.stringify({ code: 40001, msg: 'Read failed', data: null,
        details: disconnected ? { code: 'browser.disconnected' } : { code: 'browser.disabled', reason: 'feature_disabled' } }),
      { headers: { 'content-type': 'application/json' } });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.browser.tabs('work')).rejects.toMatchObject({ code: 40001, details: { code: 'browser.disconnected' } });
      await expect(channel.rest.browser.connect('work')).rejects.toMatchObject({ code: 40001, details: { code: 'browser.disabled', reason: 'feature_disabled' } });
    } finally { await channel.close(); }
  });
});


describe('S5 typed SSH settings transport', () => {
  it('reads and saves the actual sync settings and reads saved host keys with workspace identity', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    let enabled = false;
    const keys = { hostId: 'dev', workspaceId: 'workspace/example', hostname: 'example.test', port: 2200,
      label: '[example.test]:2200', state: 'unrecorded', records: [], files: [{ path: '/fixture/known_hosts', state: 'missing', reason: 'ENOENT' }] };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.body !== undefined && typeof init.body !== 'string') throw new Error('Expected a JSON request body');
      const body = init?.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ path: url.pathname + url.search, method: init?.method ?? 'GET', body });
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
      if (init?.method === 'PUT') enabled = body.enabled;
      return envelope(url.pathname.endsWith(':host-keys') ? keys : { enabled, source: 'home' });
    });
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.ssh.configSync()).resolves.toEqual({ enabled: false, source: 'home' });
      await expect(channel.rest.ssh.setConfigSync(true)).resolves.toEqual({ enabled: true, source: 'home' });
      await expect(channel.rest.ssh.configSync()).resolves.toEqual({ enabled: true, source: 'home' });
      await expect(channel.rest.ssh.hostKeys('dev', 'workspace/example')).resolves.toEqual(keys);
      expect(calls).toEqual([
        { path: '/api/ssh/config-sync', method: 'GET', body: undefined },
        { path: '/api/ssh/config-sync', method: 'PUT', body: { enabled: true } },
        { path: '/api/ssh/config-sync', method: 'GET', body: undefined },
        { path: '/api/ssh/hosts/dev:host-keys?workspace_id=workspace%2Fexample', method: 'GET', body: undefined },
      ]);
    } finally { await channel.close(); }
  });

  it('propagates read failures rather than inventing enabled settings or trust state', async () => {
    const fetchMock = vi.fn(async () => envelope(null, 50001));
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.rest.ssh.configSync()).rejects.toMatchObject({ code: 50001 });
      await expect(channel.rest.ssh.hostKeys('dev')).rejects.toMatchObject({ code: 50001 });
    } finally { await channel.close(); }
  });
});


describe('fixed connection transport error normalization', () => {
  const connectionId = '00000000-0000-4000-8000-000000000001';
  it('preserves the production adapter typed denial and message before any source request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createConnectionKlient({ endpoint: 'http://example.test', token: 'local-capability', connectionId, fetch: fetchMock });
    try {
      const caught: unknown = await client.rest!.browser.list().catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(RPCError);
      expect(caught).toMatchObject({ code: 40301, message: 'Operation is not available to a remote space' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });
  it.each([
    new TypeError('network offline'),
    Object.assign(new Error('untyped adapter failure'), { name: 'RPCError', code: 40301 }),
  ])('keeps non-RPCError failures as network code -1: %s', async (failure) => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe(`http://example.test/api/remote-connections/${connectionId}/call`);
      expect(init?.redirect).toBe('error');
      throw failure;
    });
    const client = createConnectionKlient({ endpoint: 'http://example.test', token: 'local-capability', connectionId, fetch: fetchMock });
    try {
      await expect(client.rest!.meta()).rejects.toMatchObject({ code: -1, message: failure.message });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { await client.close(); }
  });
});


describe('guided browser setup HTTP facade', () => {
  it('uses typed preset routes and explicit preparation consent without rewriting browser connections', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const status = { preset: 'kimi-webbridge', state: 'needs_user_action' };
    const fetchMock: typeof fetch = async (input, init) => {
      const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ path: new URL(inputUrl).pathname, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : jsonRequestBody(init.body) });
      return envelope(status);
    };
    const channel = new HttpChannel({ endpoint: 'http://example.test', token: 'fixture', fetch: fetchMock });
    try {
      await channel.rest.browser.setupPresets();
      await channel.rest.browser.setupStatus('kimi-webbridge');
      await channel.rest.browser.prepare('kimi-webbridge', { consent: true });
      await channel.rest.browser.connectPreset('kimi-webbridge');
      await channel.rest.browser.connectPreset('independent-browser', { connectionId: 'work', name: 'Work', setDefault: true });
      await channel.rest.browser.cancelSetup('independent-browser');
      expect(calls).toEqual([
        { path: '/api/browser/setup', method: 'GET', body: undefined },
        { path: '/api/browser/setup/kimi-webbridge', method: 'GET', body: undefined },
        { path: '/api/browser/setup/kimi-webbridge:prepare', method: 'POST', body: { consent: true } },
        { path: '/api/browser/setup/kimi-webbridge:connect', method: 'POST', body: {} },
        { path: '/api/browser/setup/independent-browser:connect', method: 'POST', body: { connectionId: 'work', name: 'Work', setDefault: true } },
        { path: '/api/browser/setup/independent-browser:cancel', method: 'POST', body: {} },
      ]);
    } finally { await channel.close(); }
  });
});
