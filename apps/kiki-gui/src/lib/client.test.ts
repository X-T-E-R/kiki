import { QueryClient } from '@tanstack/react-query';
import { createKlient } from '@kiki/klient/http';

function transcriptView(sessionId: string, validate = false) {
  return createKlient({ endpoint: 'http://example.test', validate }).session(sessionId).view;
}
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  API_CODES,
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
  it('uses the shared provider discovery facade for refresh', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8080/api/klient/call');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        procedure: { scope: 'core', service: 'providerDiscovery', method: 'refreshProviderModels' },
        params: [{ providerId: 'example' }],
      });
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

describe('KikiClient transport error mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not reinterpret a server INTERNAL_ERROR 50001 as a timeout', async () => {
    const data = { request: 'server-error', retryable: false };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 50001,
      msg: 'server.internal_error',
      data,
      request_id: 'req-server-50001',
      reason: 'server.internal_error',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });

    const failure = await client.meta().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe(50001);
    expect((failure as ApiError).message).toContain('server.internal_error');
    expect((failure as ApiError).data).toEqual(data);
    expect((failure as ApiError).requestId).toBe('req-server-50001');
  });

  it('maps an actual transport deadline to the GUI timeout code and text', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', timeoutMs: 5 });
    const pending = client.meta().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5);
    const failure = await pending;

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe(API_CODES.TIMEOUT);
    expect((failure as ApiError).message).toContain('Request timed out after 5ms');
  });

  it('keeps the initial session snapshot loading beyond the generic request deadline', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        expect(String(url)).toBe('http://127.0.0.1:8080/api/klient/session-view/s1/snapshot');
        resolveFetch = resolve;
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', timeoutMs: 5 });
    const pending = client.sessionView('s1').snapshot();

    await vi.advanceTimersByTimeAsync(50);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

    resolveFetch(new Response(JSON.stringify({
      code: 0,
      msg: 'success',
      data: {
        as_of_seq: 0,
        epoch: 'ep_01ABC',
        session: {
          id: 's1',
          workspace_id: 'wd_example_0123456789ab',
          title: 'Example',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          busy: false,
          metadata: { cwd: '/tmp/example' },
          agent_config: { model: 'example/model' },
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            total_cost_usd: 0,
            context_tokens: 0,
            context_limit: 0,
            turn_count: 0,
          },
          permission_rules: [],
          message_count: 0,
          last_seq: 0,
        },
        messages: { items: [], has_more: false },
        in_flight_turn: null,
        pending_approvals: [],
        pending_questions: [],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(pending).resolves.toMatchObject({ as_of_seq: 0, session: { id: 's1' } });
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
      expect(String(url)).toBe('http://127.0.0.1:8080/api/config');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        agents: { enabled: false },
        builtin_product_skills: false,
      });
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          providers: {},
          agents: { enabled: false },
          builtin_product_skills: false,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    const result = await client.patchConfig({
      agents: { enabled: false },
      builtin_product_skills: false,
    });

    expect(result.agents?.enabled).toBe(false);
    expect(result.builtin_product_skills).toBe(false);
    expect(result.skip_builtin_profile_installation).toEqual([]);
    expect(result.disabled_named_profiles).toEqual([]);
  });

  it('rejects a null patch echo without replacing the existing config cache', async () => {
    stubConfigResponse(null);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });
    const queryClient = new QueryClient();
    const cached = { providers: {}, skip_builtin_profile_installation: ['explore'] };
    queryClient.setQueryData(['config'], cached);

    await expect(
      client.patchConfig({ skip_builtin_profile_installation: ['agent'] }).then((echoed) => {
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
      skip_builtin_profile_installation: null,
      disabled_named_profiles: 'reviewer',
      extra_agent_dirs: 'C:/agents',
      tools: { enabled: ['Read', 'Read'], disabled: null },
      future_domain: { preserved: true },
    });
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });

    const result = await client.patchConfig({});

    expect(result.skip_builtin_profile_installation).toEqual([]);
    expect(result.disabled_named_profiles).toEqual(['reviewer']);
    expect(result.extra_agent_dirs).toEqual(['C:/agents']);
    expect(result.tools).toEqual({ enabled: ['Read'], disabled: [] });
    expect(result).toHaveProperty('future_domain', { preserved: true });
  });

  it('rejects object-valued disabled profile lists', async () => {
    stubConfigResponse({ providers: {}, skip_builtin_profile_installation: { explore: true } });
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
      expect(String(url)).toBe('http://127.0.0.1:8080/api/agents');
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

  it('scopes the catalog to the requested workspace id', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        'http://127.0.0.1:8080/api/agents?workspace_id=wd_workspace%2Fmain',
      );
      expect(init?.method).toBe('GET');
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: { items: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });

    await client.listNamedAgentProfiles('wd_workspace/main');

    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe('KikiClient agent capability queries', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves launch admission separately from default binding availability', async () => {
    const data = { context: 'live', owner: { profile: 'lead', agent_id: 'main' }, available: true,
      targets: [{ profile: 'helper', executor: 'external', defaults_available: true,
        launch_allowed: false, launch_unavailable_reason: 'Research-readonly dispatch requires the native executor.',
        execution_restriction: 'research-readonly' }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0, msg: 'success', data }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
    const response = await client.getAgentCapabilities({ session_id: 'session', agent_id: 'main' });
    expect(response).toEqual(data);
    expect(response.targets[0]?.launch_allowed).toBe(false);
    expect(response.targets[0]?.defaults_available).toBe(true);
  });

  it('sends effective cwd and live caller queries without creating a session', async () => {
    const urls: URL[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      urls.push(new URL(String(url)));
      const isPanel = init?.method === 'POST';
      if (isPanel) bodies.push(JSON.parse(init.body as string));
      const data = isPanel ? { context: 'live', owner: { agent_id: 'main' }, available: false, targets: [] } : { items: [] };
      return new Response(JSON.stringify({ code: 0, msg: 'success', data }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
    await client.listNamedAgentProfiles({ cwd: 'C:/workspace one', effective: true });
    await client.getAgentCapabilities({ session_id: 'session/one', agent_id: 'main' });
    expect(urls[0]?.pathname).toBe('/api/agents');
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({ cwd: 'C:/workspace one', effective: 'true' });
    expect(urls[1]?.pathname).toBe('/api/klient/call');
    expect(bodies).toEqual([{ procedure: { scope: 'core', service: 'agentPanelService', method: 'read' }, params: [{ session_id: 'session/one', agent_id: 'main' }] }]);
    await client.klient.close();
  });
});

describe('KikiClient.updateNamedAgentProfile', () => {
  it('PATCHes editable fields and returns the server echo used by the settings cache', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8080/api/agents/reviewer%20ui');
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
      expect(parsed.pathname).toBe('/api/fs:content');
      expect(parsed.searchParams.get('path')).toBe('C:/agents/reviewer ui.md');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer token');
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
      expect(parsed.pathname).toBe('/api/fs:content');
      expect(parsed.searchParams.get('path')).toBe('/work/shots/home.png');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer token');
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
      expect(parsed.pathname).toBe('/api/sessions/session%20one/media/file%2Fdiagram');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer token');
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

describe('KikiClient.renewLease', () => {
  it('creates and renews an instance-local server lease without sending legacy keys', async () => {
    const original = globalThis.fetch;
    const bodies: unknown[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/leases');
      expect(init?.method).toBe('POST');
      bodies.push(JSON.parse(init?.body as string));
      call += 1;
      if (call === 4) {
        return new Response(JSON.stringify({
          code: 40001,
          msg: 'leases.invalid',
          data: { field: 'lease_id' },
          request_id: 'req-lease-invalid',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const leaseId = call % 2 === 0 ? 'lease-b' : 'lease-a';
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: { lease_id: leaseId, expires_at: 123 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const first = new KikiClient({ baseUrl: 'http://example.test', token: 'home-token' });
      const second = new KikiClient({ baseUrl: 'http://example.test', token: 'home-token' });

      await expect(first.renewLease({ clientId: 'gui-first', kind: 'gui' })).resolves.toBeUndefined();
      await expect(second.renewLease({ clientId: 'gui-second', kind: 'gui' })).resolves.toBeUndefined();
      await expect(first.renewLease({ clientId: 'gui-first', kind: 'gui' })).resolves.toBeUndefined();
      const failure = await first.renewLease({ clientId: 'gui-first', kind: 'gui' }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({
        code: 40001,
        data: { field: 'lease_id' },
        requestId: 'req-lease-invalid',
      });
      expect((failure as ApiError).message).toBe('leases.invalid (code 40001)');
      await expect(first.renewLease({ clientId: 'gui-first', kind: 'gui' })).resolves.toBeUndefined();
      await expect(second.renewLease({ clientId: 'gui-second', kind: 'gui' })).resolves.toBeUndefined();

      expect(bodies).toEqual([
        {},
        {},
        { lease_id: 'lease-a' },
        { lease_id: 'lease-a' },
        { lease_id: 'lease-a' },
        { lease_id: 'lease-b' },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('treats an older server 404 as unsupported after sending an empty body', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/leases');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer home-token' });
      expect(JSON.parse(init?.body as string)).toEqual({});
      return new Response(JSON.stringify({ statusCode: 404 }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const client = new KikiClient({ baseUrl: 'http://example.test', token: 'home-token' });
      await expect(client.renewLease({ clientId: 'gui-window', kind: 'gui' })).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = original;
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
      expect(url.pathname).toBe('/api/workspaces/wd_demo_000000000000');
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
      expect(url.pathname).toBe('/api/workspaces/wd_demo_000000000000');
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
      expect(url.pathname).toBe('/api/workspaces/wd_demo_000000000000');
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
      tool_call_count: 37,
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
      const response = await transcriptView('sess-1').transcript.page({ agentId: 'child-1' }) as unknown as AgentTranscriptResponse;
      expect(response.agent_id).toBe('child-1');
      expect(response.tool_call_count).toBe(37);
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
      await expect(transcriptView('sess-1', true).transcript.page({ agentId: 'main' })).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('uses the Klient session view route and its server default page size', async () => {
    const captured = captureFetch();
    try {
      await transcriptView('sess-1').transcript.page({ agentId: 'main' });
      expect(captured.calls).toHaveLength(1);
      const url = captured.calls[0]!;
      expect(url.pathname).toBe('/api/klient/session-view/sess-1/transcript');
      expect(url.searchParams.get('agent_id')).toBe('main');
      expect(url.searchParams.has('page_size')).toBe(false);
      expect(url.searchParams.has('before_turn')).toBe(false);
      expect(url.searchParams.has('after_turn')).toBe(false);
    } finally {
      captured.restore();
    }
  });

  it('sends before_turn and page_size without after_turn', async () => {
    const captured = captureFetch();
    try {
      await transcriptView('sess-1').transcript.page({
        agentId: 'child-1',
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
      await transcriptView('sess-1').transcript.page({ agentId: 'main', afterTurn: 'turn-3' });
      const params = captured.calls[0]!.searchParams;
      expect(params.get('after_turn')).toBe('turn-3');
      expect(params.has('before_turn')).toBe(false);
      expect(params.has('page_size')).toBe(false);
    } finally {
      captured.restore();
    }
  });

  it('rejects mutually exclusive beforeTurn and afterTurn without fetching', async () => {
    const captured = captureFetch();
    try {
      await expect(
        transcriptView('sess-1', true).transcript.page({
          agentId: 'main',
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
        'http://127.0.0.1:8080/api/sessions/s1/messages/m1:edit',
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
        'http://127.0.0.1:8080/api/sessions/s1/messages/m9:regenerate',
      );
      expect(JSON.parse(init?.body as string)).toEqual({
        expected_cursor: { seq: 7, epoch: 'epoch-1' },
      });
      return okResponse({
        prompt_id: 'p2',
        user_message_id: 'm8',
        status: 'running',
        content: [{ type: 'text', text: 'rerun' }],
        created_at: '2026-01-01T00:00:00.000Z',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
    await client.regenerateMessage('s1', 'm9', { expected_cursor: { seq: 7, epoch: 'epoch-1' } });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('sends the fork truncation pair on :fork', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8080/api/sessions/s1:fork');
      expect(JSON.parse(init?.body as string)).toEqual({
        through_message_id: 'm3',
        expected_cursor: { seq: 11, epoch: 'ep1' },
      });
      return okResponse({
        id: 's2', workspace_id: 'wd_test_000000000000', title: 'Fork',
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
        busy: false, metadata: { cwd: '/workspace' }, agent_config: { model: 'example' },
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0 },
        permission_rules: [], message_count: 0, last_seq: 0,
      });
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
      .regenerateMessage('s1', 'm9', { expected_cursor: { seq: 1, epoch: 'stale-epoch' } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe(40937);
    vi.unstubAllGlobals();
  });
});

describe('KikiClient.submitPrompt', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('waits for a slow submission acknowledgement beyond the generic request deadline', async () => {
    const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const responseTimer = setTimeout(() => {
          resolve(new Response(JSON.stringify({
            code: 0,
            msg: 'success',
            data: {
              prompt_id: 'p-slow',
              user_message_id: 'm-slow',
              status: 'running',
              content: [{ type: 'text', text: 'slow prompt' }],
              created_at: '2026-01-01T00:00:00.000Z',
            },
          }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }, 40);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(responseTimer);
          reject(new Error('request aborted'));
        }, { once: true });
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', timeoutMs: 5 });

    await expect(client.submitPrompt('s1', {
      content: [{ type: 'text', text: 'slow prompt' }],
    })).resolves.toMatchObject({ prompt_id: 'p-slow', status: 'running' });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal?.aborted).toBe(false);
  });

  it('still surfaces a connection failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused');
    }));
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', timeoutMs: 5 });

    const failure = await client.submitPrompt('s1', {
      content: [{ type: 'text', text: 'prompt' }],
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe(-1);
    expect((failure as ApiError).message).toContain('connection refused');
  });

  it('still surfaces an explicit server rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        code: 40401,
        msg: 'session.not_found',
        data: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', timeoutMs: 5 });

    const failure = await client.submitPrompt('missing', {
      content: [{ type: 'text', text: 'prompt' }],
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe(40401);
  });
});

describe('KikiClient.replacePrompt', () => {
  it('posts replacement content to the queued prompt action', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        'http://127.0.0.1:8080/api/sessions/s1/prompts/prompt%20one:replace',
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

  it('uses the Klient transcript catch-up route', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/api/klient/session-view/s1/transcript/catch-up');
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
    await transcriptView('s1', true).transcript.catchUp({ agentId: 'main', since: { seq: 3, epoch: 'e1' } });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
