import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  isSessionIndexBuildingError,
  isSessionNotFoundMessage,
  KikiClient,
  type AgentTranscriptResponse,
} from './client';

describe('isSessionNotFoundMessage', () => {
  it('matches the wire envelope message for a missing session', () => {
    const error = new ApiError({ code: 40401, msg: 'session.not_found', data: null });
    expect(isSessionNotFoundMessage(error.message)).toBe(true);
  });

  it('matches on the numeric code even when the msg text differs', () => {
    expect(isSessionNotFoundMessage('Could not load session (code 40401)')).toBe(true);
  });

  it('rejects other load failures', () => {
    expect(isSessionNotFoundMessage('prompt.not_found (code 40402)')).toBe(false);
    expect(isSessionNotFoundMessage('request timed out (code -2)')).toBe(false);
    expect(isSessionNotFoundMessage('Could not load session')).toBe(false);
  });
});

describe('isSessionIndexBuildingError', () => {
  it('matches only the session index building business code', () => {
    expect(
      isSessionIndexBuildingError(
        new ApiError({ code: 40939, msg: 'session index is building', data: null }),
      ),
    ).toBe(true);
    expect(
      isSessionIndexBuildingError(new ApiError({ code: 50001, msg: 'internal', data: null })),
    ).toBe(false);
    expect(isSessionIndexBuildingError(new Error('network'))).toBe(false);
  });
});

describe('KikiClient.refreshProvider', () => {
  it('posts the existing /providers/{id}:refresh action', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('http://127.0.0.1:8080/api/v1/providers/example:refresh');
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: { changed: [], unchanged: ['example'], failed: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
    const result = await client.refreshProvider('example');
    expect(result.unchanged).toEqual(['example']);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0] === undefined
      ? undefined
      : (fetchMock.mock.calls[0] as unknown as [string | URL, RequestInit?])[1];
    expect(init?.method).toBe('POST');
    vi.unstubAllGlobals();
  });
});

describe('KikiClient config responses', () => {
  const stubConfigResponse = (data: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, msg: 'success', data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends server-file settings through the kap-server config API', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8080/api/v1/config');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        agents: { enabled: false },
        model_catalog: { refresh_on_start: true },
      });
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          providers: {},
          agents: { enabled: false },
          model_catalog: { refreshOnStart: true },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    const result = await client.patchConfig({
      agents: { enabled: false },
      model_catalog: { refresh_on_start: true },
    });

    expect(result.agents?.enabled).toBe(false);
    expect(result.model_catalog?.refreshOnStart).toBe(true);
    expect(result.disabled_builtin_profiles).toEqual([]);
    expect(result.disabled_named_profiles).toEqual([]);
  });

  it('rejects a null patch echo without replacing the existing config cache', async () => {
    stubConfigResponse(null);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });
    const queryClient = new QueryClient();
    const cached = { providers: {}, disabled_builtin_profiles: ['explore'] };
    queryClient.setQueryData(['config'], cached);

    await expect(
      client.patchConfig({ disabled_builtin_profiles: ['agent'] }).then((echoed) => {
        queryClient.setQueryData(['config'], echoed);
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryData(['config'])).toBe(cached);
  });

  it('rejects a string config root from GET', async () => {
    stubConfigResponse('not-a-config');
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });
    await expect(client.getConfig()).rejects.toBeInstanceOf(ApiError);
  });

  it('normalizes legacy null and single-string list fields', async () => {
    stubConfigResponse({
      providers: {},
      disabled_builtin_profiles: null,
      disabled_named_profiles: 'reviewer',
      extra_agent_dirs: 'C:/agents',
      tools: { enabled: ['Read', 'Read'], disabled: null },
      future_domain: { preserved: true },
    });
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });

    const result = await client.patchConfig({});

    expect(result.disabled_builtin_profiles).toEqual([]);
    expect(result.disabled_named_profiles).toEqual(['reviewer']);
    expect(result.extra_agent_dirs).toEqual(['C:/agents']);
    expect(result.tools).toEqual({ enabled: ['Read'], disabled: [] });
    expect(result).toHaveProperty('future_domain', { preserved: true });
  });

  it('rejects object-valued disabled profile lists', async () => {
    stubConfigResponse({ providers: {}, disabled_builtin_profiles: { explore: true } });
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });
    await expect(client.patchConfig({})).rejects.toBeInstanceOf(ApiError);
  });

  it('sends explicit global request identity replacement and clear payloads', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: { providers: {} },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    await client.patchConfig({
      request_identity: { overrides: { client: { user_agent: 'host' } } },
    });
    await client.patchConfig({ request_identity: null });

    expect(bodies).toEqual([
      { request_identity: { overrides: { client: { user_agent: 'host' } } } },
      { request_identity: null },
    ]);
    vi.unstubAllGlobals();
  });
});

describe('KikiClient.listNamedAgentProfiles', () => {
  it('gets the additive /agents catalog endpoint', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8080/api/v1/agents');
      expect(init?.method).toBe('GET');
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          items: [{
            name: 'reviewer',
            source: 'user',
            source_file: '/agents/reviewer.md',
            pinned_model_alias: 'provider/fast',
            disabled: false,
            routes: [],
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    const result = await client.listNamedAgentProfiles();

    expect(result.items[0]?.pinned_model_alias).toBe('provider/fast');
    vi.unstubAllGlobals();
  });
});

describe('KikiClient.updateNamedAgentProfile', () => {
  it('PATCHes editable fields and returns the server echo used by the settings cache', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8080/api/v1/agents/reviewer%20ui');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(init?.body as string)).toEqual({
        scope: 'project',
        workspace_id: 'wd_test',
        description: 'Updated reviewer',
        when_to_use: 'Use for UI review',
        pinned_model_alias: 'provider/profile',
        thinking_effort: 'high',
        service_tier: 'priority',
        tools: ['Read'],
        disallowed_tools: null,
        routes: [{ id: 'reviewer-ui.fast', model_alias: null }],
      });
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          name: 'reviewer ui',
          description: 'Updated reviewer',
          source: 'workspace',
          workspace_id: 'wd_test',
          source_file: '/workspace/reviewer-ui.md',
          pinned_model_alias: 'provider/profile',
          thinking_effort: 'high',
          service_tier: 'priority',
          tools: ['Read'],
          disabled: false,
          routes: [{
            id: 'reviewer-ui.fast',
            source_file: '/workspace/.routes/reviewer-ui/fast.md',
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    const result = await client.updateNamedAgentProfile('reviewer ui', {
      scope: 'project',
      workspace_id: 'wd_test',
      description: 'Updated reviewer',
      when_to_use: 'Use for UI review',
      pinned_model_alias: 'provider/profile',
      thinking_effort: 'high',
      service_tier: 'priority',
      tools: ['Read'],
      disallowed_tools: null,
      routes: [{ id: 'reviewer-ui.fast', model_alias: null }],
    });

    expect(result.description).toBe('Updated reviewer');
    expect(result.source).toBe('workspace');
    vi.unstubAllGlobals();
  });
});

describe('KikiClient.readHostFile', () => {
  it('reads raw file content from the fs:content endpoint', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/v1/fs:content');
      expect(parsed.searchParams.get('path')).toBe('C:/agents/reviewer ui.md');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer token');
      return new Response('---\nname: reviewer\n---\n', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    await expect(client.readHostFile('C:/agents/reviewer ui.md')).resolves.toContain('name: reviewer');
    vi.unstubAllGlobals();
  });
});

describe('KikiClient.readHostFileBytes', () => {
  it('reads binary content with the response MIME from the fs:content endpoint', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/v1/fs:content');
      expect(parsed.searchParams.get('path')).toBe('/work/shots/home.png');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer token');
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    const result = await client.readHostFileBytes('/work/shots/home.png');
    expect(result.mime).toBe('image/png');
    expect([...result.bytes]).toEqual([1, 2, 3]);
    vi.unstubAllGlobals();
  });
});

describe('KikiClient.readSessionMediaBytes', () => {
  it('reads canonical session media with auth, MIME, and server filename', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/v1/sessions/session%20one/media/file%2Fdiagram');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer token');
      return new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: {
          'content-type': 'image/png; charset=binary',
          'content-disposition': 'inline; filename="diagram final.png"',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    const result = await client.readSessionMediaBytes('session one', 'file/diagram');
    expect(result.mime).toBe('image/png');
    expect(result.name).toBe('diagram final.png');
    expect([...result.bytes]).toEqual([4, 5, 6]);
    vi.unstubAllGlobals();
  });
});

describe('KikiClient MCP management plane', () => {
  it('addresses /api/v2/mcp with a cwd, and puts the name in the path not the body', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      if (init?.method === 'GET') {
        expect(parsed.pathname).toBe('/api/v2/mcp/servers');
        expect(parsed.searchParams.get('cwd')).toBe('/wd test');
      } else if (init?.method === 'POST') {
        expect(parsed.pathname).toBe('/api/v2/mcp/servers');
        expect(parsed.searchParams.get('cwd')).toBe('/wd test');
        expect(JSON.parse(init.body as string)).toEqual({
          name: 'local server',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
        });
      } else if (init?.method === 'PUT') {
        expect(parsed.pathname).toBe('/api/v2/mcp/servers/local%20server');
        expect(JSON.parse(init.body as string)).toEqual({
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
        });
      } else {
        expect(init?.method).toBe('DELETE');
        expect(parsed.pathname).toBe('/api/v2/mcp/servers/local%20server');
        expect(parsed.searchParams.get('cwd')).toBe('/wd test');
      }
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    await client.listManagedMcpServers('/wd test');
    await client.addManagedMcpServer(
      { name: 'local server', transport: 'stdio', command: 'node', args: ['server.js'] },
      '/wd test',
    );
    await client.updateManagedMcpServer(
      'local server',
      { transport: 'stdio', command: 'node', args: ['server.js'] },
      '/wd test',
    );
    await client.removeManagedMcpServer('local server', '/wd test');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.unstubAllGlobals();
  });

  it('probes a draft config through the test endpoint without persisting', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(init?.method).toBe('POST');
      expect(parsed.pathname).toBe('/api/v2/mcp/servers::test');
      expect(JSON.parse(init?.body as string)).toEqual({
        server: { name: 'probe', transport: 'http', url: 'https://mcp.example.com' },
        cwd: '/wd',
      });
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: { success: true, output: 'listed 3 tools' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    const result = await client.testManagedMcpServer({
      server: { name: 'probe', transport: 'http', url: 'https://mcp.example.com' },
      cwd: '/wd',
    });

    expect(result).toEqual({ success: true, output: 'listed 3 tools' });
    vi.unstubAllGlobals();
  });
});

function envelope(data: unknown): Response {
  return {
    json: async () => ({ code: 0, msg: 'ok', data, request_id: 'req_test' }),
  } as Response;
}

function captureFetch(): { calls: URL[]; restore: () => void } {
  const calls: URL[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(input instanceof URL ? input : new URL(String(input)));
    return envelope({ agent_id: 'main', items: [], has_more: false });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe('KikiClient.listSessions', () => {
  it('passes workspace_id through to the query string', async () => {
    const captured = captureFetch();
    try {
      const client = new KikiClient({ baseUrl: 'http://example.test' });
      await client.listSessions({ workspace_id: 'wd_demo_000000000000', page_size: 20 });
      const params = captured.calls[0]!.searchParams;
      expect(params.get('workspace_id')).toBe('wd_demo_000000000000');
      expect(params.get('page_size')).toBe('20');
      // Non-workspace filters stay empty rather than `?busy=undefined`.
      expect(params.has('busy')).toBe(false);
      expect(params.has('include_archive')).toBe(false);
    } finally {
      captured.restore();
    }
  });
});

describe('KikiClient workspace lifecycle', () => {
  it('PATCHes the rename route and returns the server echo', async () => {
    const original = globalThis.fetch;
    const echo = {
      id: 'wd_demo_000000000000',
      root: 'C:/demo',
      name: 'Renamed',
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
      session_count: 0,
      pinned: false,
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v1/workspaces/wd_demo_000000000000');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(init?.body as string)).toEqual({ name: 'Renamed' });
      return envelope(echo);
    }) as typeof fetch;
    try {
      const client = new KikiClient({ baseUrl: 'http://example.test' });
      const result = await client.renameWorkspace('wd_demo_000000000000', 'Renamed');
      expect(result.name).toBe('Renamed');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('PATCHes only `pinned` when pinning a workspace', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v1/workspaces/wd_demo_000000000000');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(init?.body as string)).toEqual({ pinned: true });
      return envelope({
        id: 'wd_demo_000000000000',
        root: 'C:/demo',
        name: 'demo',
        created_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
        session_count: 0,
        pinned: true,
      });
    }) as typeof fetch;
    try {
      const client = new KikiClient({ baseUrl: 'http://example.test' });
      const result = await client.setWorkspacePinned('wd_demo_000000000000', true);
      expect(result.pinned).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('DELETEs the unregister route', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v1/workspaces/wd_demo_000000000000');
      expect(init?.method).toBe('DELETE');
      return envelope({ deleted: true });
    }) as typeof fetch;
    try {
      const client = new KikiClient({ baseUrl: 'http://example.test' });
      await expect(client.removeWorkspace('wd_demo_000000000000')).resolves.toEqual({ deleted: true });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('KikiClient.getAgentTranscript', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the full agents roster including parentAgentId and sibling wire fields', async () => {
    const payload: AgentTranscriptResponse = {
      agent_id: 'child-1',
      items: [],
      has_more: false,
      interactions: [
        {
          interactionId: 'appr-1',
          interactionKind: 'approval',
          state: 'pending',
          toolCallId: 'tc-1',
        },
      ],
      agents: [
        { agentId: 'main', type: 'main', createdAt: '2026-01-01T00:00:00.000Z' },
        {
          agentId: 'child-1',
          type: 'sub',
          parentAgentId: 'main',
          delegator: { kind: 'agent', agentId: 'main' },
          label: 'Inspector',
          createdAt: '2026-01-01T00:01:00.000Z',
          disposedAt: '2026-01-01T00:02:00.000Z',
        },
      ],
      tasks: [
        {
          taskId: 'task-1',
          kind: 'subagent',
          state: 'running',
          detached: false,
          agentId: 'child-1',
          outputTail: '',
          usage: { inputOther: 11, output: 7, inputCacheRead: 3, inputCacheCreation: 1 },
        },
      ],
      todos: [{ todoId: 'todo-1', items: [{ title: 'Inspect', status: 'in_progress' }] }],
      prompts: [
        {
          promptId: 'p1',
          status: 'running',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      meta: {
        activity: 'turn',
        agent: {
          model: 'kimi-k2',
          usage: {
            currentTurn: { inputOther: 4, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
            total: { inputOther: 20, output: 9, inputCacheRead: 5, inputCacheCreation: 1 },
          },
          phase: { kind: 'streaming', turnId: 3, step: 1, stepId: 'step-1', stream: 'assistant', since: 1_700_000_000_000 },
        },
      },
      pending_interactions: ['appr-1'],
      seq: 42,
      attachments: [{ attachmentId: 'att-1', mediaType: 'image/png', name: 'shot.png' }],
    };
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => envelope(payload)) as typeof fetch;
    try {
      const client = new KikiClient({ baseUrl: 'http://example.test' });
      const response = await client.getAgentTranscript('sess-1', 'child-1');
      expect(response.agent_id).toBe('child-1');
      expect(response.seq).toBe(42);
      expect(response.pending_interactions).toEqual(['appr-1']);
      expect(response.tasks?.[0]?.agentId).toBe('child-1');
      expect(response.tasks?.[0]?.usage).toEqual({
        inputOther: 11,
        output: 7,
        inputCacheRead: 3,
        inputCacheCreation: 1,
      });
      expect(response.todos?.[0]?.todoId).toBe('todo-1');
      expect(response.prompts?.[0]?.promptId).toBe('p1');
      expect(response.meta?.activity).toBe('turn');
      expect(response.meta?.agent?.usage?.total?.output).toBe(9);
      expect(response.meta?.agent?.usage?.currentTurn?.inputOther).toBe(4);
      expect(response.meta?.agent?.phase?.kind).toBe('streaming');
      expect(response.meta?.agent?.phase?.['stream']).toBe('assistant');
      expect(response.attachments?.[0]?.attachmentId).toBe('att-1');
      const child = response.agents?.find((agent) => agent.agentId === 'child-1');
      expect(child).toMatchObject({
        type: 'sub',
        parentAgentId: 'main',
        label: 'Inspector',
        createdAt: '2026-01-01T00:01:00.000Z',
        disposedAt: '2026-01-01T00:02:00.000Z',
      });
      expect(child?.delegator).toEqual({ kind: 'agent', agentId: 'main' });
      // Gap: interaction entities have no origin / parentAgentId on the wire.
      expect(response.interactions?.[0]).not.toHaveProperty('parentAgentId');
      expect(response.interactions?.[0]).not.toHaveProperty('origin');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('accepts a compact legacy body that only has agent_id / items / has_more', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      envelope({
        agent_id: 'main',
        items: [{ kind: 'marker', markerId: 'm1', marker: 'compaction' }],
        has_more: true,
      }),
    ) as typeof fetch;
    try {
      const client = new KikiClient({ baseUrl: 'http://example.test' });
      const response = await client.getAgentTranscript('sess-1', 'main');
      expect(response).toEqual({
        agent_id: 'main',
        items: [{ kind: 'marker', markerId: 'm1', marker: 'compaction' }],
        has_more: true,
      });
      expect(response.agents).toBeUndefined();
      expect(response.seq).toBeUndefined();
      expect(response.pending_interactions).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps the two-arg call compatible and defaults page_size to 100', async () => {
    const captured = captureFetch();
    try {
      const client = new KikiClient({ baseUrl: 'http://example.test' });
      await client.getAgentTranscript('sess-1', 'main');
      expect(captured.calls).toHaveLength(1);
      const url = captured.calls[0]!;
      expect(url.pathname).toBe('/api/v1/sessions/sess-1/transcript');
      expect(url.searchParams.get('agent_id')).toBe('main');
      expect(url.searchParams.get('page_size')).toBe('100');
      expect(url.searchParams.has('before_turn')).toBe(false);
      expect(url.searchParams.has('after_turn')).toBe(false);
    } finally {
      captured.restore();
    }
  });

  it('sends before_turn and page_size without after_turn', async () => {
    const captured = captureFetch();
    try {
      const client = new KikiClient({ baseUrl: 'http://example.test' });
      await client.getAgentTranscript('sess-1', 'child-1', {
        beforeTurn: 'turn-9',
        pageSize: 20,
      });
      const params = captured.calls[0]!.searchParams;
      expect(params.get('agent_id')).toBe('child-1');
      expect(params.get('before_turn')).toBe('turn-9');
      expect(params.get('page_size')).toBe('20');
      expect(params.has('after_turn')).toBe(false);
    } finally {
      captured.restore();
    }
  });

  it('sends after_turn without before_turn', async () => {
    const captured = captureFetch();
    try {
      const client = new KikiClient({ baseUrl: 'http://example.test' });
      await client.getAgentTranscript('sess-1', 'main', { afterTurn: 'turn-3' });
      const params = captured.calls[0]!.searchParams;
      expect(params.get('after_turn')).toBe('turn-3');
      expect(params.has('before_turn')).toBe(false);
      expect(params.get('page_size')).toBe('100');
    } finally {
      captured.restore();
    }
  });

  it('rejects mutually exclusive beforeTurn and afterTurn without fetching', async () => {
    const captured = captureFetch();
    try {
      const client = new KikiClient({ baseUrl: 'http://example.test' });
      await expect(
        client.getAgentTranscript('sess-1', 'main', {
          beforeTurn: 'turn-1',
          afterTurn: 'turn-2',
        }),
      ).rejects.toThrow('beforeTurn and afterTurn are mutually exclusive');
      expect(captured.calls).toHaveLength(0);
    } finally {
      captured.restore();
    }
  });
});

describe('KikiClient message-closure routes', () => {
  const okResponse = (data: unknown) =>
    new Response(JSON.stringify({ code: 0, msg: 'success', data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('posts :edit with full-replacement content and the expected cursor', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        'http://127.0.0.1:8080/api/v1/sessions/s1/messages/m1:edit',
      );
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        content: [{ type: 'text', text: 'rewritten' }],
        expected_cursor: { seq: 42, epoch: 'ep1' },
      });
      return okResponse({
        prompt_id: 'p1',
        user_message_id: 'm2',
        status: 'running',
        content: [{ type: 'text', text: 'rewritten' }],
        created_at: '2026-01-01T00:00:00.000Z',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
    const result = await client.editMessage('s1', 'm1', {
      content: [{ type: 'text', text: 'rewritten' }],
      expected_cursor: { seq: 42, epoch: 'ep1' },
    });
    expect(result.prompt_id).toBe('p1');
    vi.unstubAllGlobals();
  });

  it('posts :regenerate with the expected cursor', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        'http://127.0.0.1:8080/api/v1/sessions/s1/messages/m9:regenerate',
      );
      expect(JSON.parse(init?.body as string)).toEqual({
        expected_cursor: { seq: 7 },
      });
      return okResponse({
        prompt_id: 'p2',
        user_message_id: 'm8',
        status: 'running',
        content: [],
        created_at: '2026-01-01T00:00:00.000Z',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
    await client.regenerateMessage('s1', 'm9', { expected_cursor: { seq: 7 } });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('sends the fork truncation pair on :fork', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8080/api/v1/sessions/s1:fork');
      expect(JSON.parse(init?.body as string)).toEqual({
        through_message_id: 'm3',
        expected_cursor: { seq: 11, epoch: 'ep1' },
      });
      return okResponse({ id: 's2' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
    const fork = await client.forkSession('s1', {
      through_message_id: 'm3',
      expected_cursor: { seq: 11, epoch: 'ep1' },
    });
    expect(fork.id).toBe('s2');
    vi.unstubAllGlobals();
  });

  it('surfaces a 40937 cursor mismatch as an ApiError code', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 40937, msg: 'session.cursor_mismatch', data: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
    const failure = await client
      .regenerateMessage('s1', 'm9', { expected_cursor: { seq: 1 } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe(40937);
    vi.unstubAllGlobals();
  });
});

describe('KikiClient.replacePrompt', () => {
  it('posts replacement content to the queued prompt action', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        'http://127.0.0.1:8080/api/v1/sessions/s1/prompts/prompt%20one:replace',
      );
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        content: [{ type: 'text', text: 'replacement' }],
      });
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          prompt_id: 'prompt one',
          user_message_id: 'prompt one',
          status: 'queued',
          content: [{ type: 'text', text: 'replacement' }],
          created_at: '2026-01-01T00:00:00.000Z',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    const result = await client.replacePrompt('s1', 'prompt one', {
      content: [{ type: 'text', text: 'replacement' }],
    });

    expect(result.prompt_id).toBe('prompt one');
    expect(result.status).toBe('queued');
    vi.unstubAllGlobals();
  });
});

describe('KikiClient transcript protocol', () => {
  it('reads /meta.capabilities.transcript', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          server_version: '0.31.1-fixture',
          capabilities: {
            websocket: true,
            file_upload: true,
            fs_query: true,
            mcp: true,
            tasks: true,
            terminal: true,
            transcript: true,
          },
          server_id: 'fixture-server',
          started_at: '2026-01-01T00:00:00.000Z',
          open_in_apps: [],
          dangerous_bypass_auth: false,
          backend: 'v2',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
    const meta = await client.meta();
    expect(meta.capabilities.transcript).toBe(true);
    vi.unstubAllGlobals();
  });

  it('exposes GET /sessions/{id}/transcript/ops catch-up', async () => {
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
    expect(client).toHaveProperty('getTranscriptOps');
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/api/v1/sessions/s1/transcript/ops');
      expect(String(url)).toContain('agent_id=main');
      expect(String(url)).toContain('since_seq=3');
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          session_id: 's1',
          agent_id: 'main',
          epoch: 'e1',
          batches: [],
          through_seq: 3,
          complete: true,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await client.getTranscriptOps('s1', 'main', { seq: 3, epoch: 'e1' });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
