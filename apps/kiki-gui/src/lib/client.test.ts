import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
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

describe('KikiClient.patchConfig', () => {
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

describe('KikiClient MCP JSON management', () => {
  it('uses the list, upsert, and remove endpoints with workspace scope', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      if (init?.method === 'GET') {
        expect(parsed.pathname).toBe('/api/v1/mcp/config/servers');
        expect(parsed.searchParams.get('workspace_id')).toBe('wd test');
      } else if (init?.method === 'PUT') {
        expect(parsed.pathname).toBe('/api/v1/mcp/servers/local%20server');
        expect(JSON.parse(init.body as string)).toEqual({
          workspace_id: 'wd test',
          scope: 'project',
          config: { transport: 'stdio', command: 'node', args: ['server.js'] },
        });
      } else {
        expect(init?.method).toBe('DELETE');
        expect(parsed.pathname).toBe('/api/v1/mcp/servers/local%20server');
        expect(parsed.searchParams.get('workspace_id')).toBe('wd test');
        expect(parsed.searchParams.get('scope')).toBe('project');
      }
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: { entries: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    await client.listMcpJsonServers('wd test');
    await client.upsertMcpJsonServer('local server', {
      workspace_id: 'wd test',
      scope: 'project',
      config: { transport: 'stdio', command: 'node', args: ['server.js'] },
    });
    await client.removeMcpJsonServer('local server', 'wd test', 'project');

    expect(fetchMock).toHaveBeenCalledTimes(3);
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
