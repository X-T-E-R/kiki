import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { Session } from '@kiki/protocol';
import { buildConversationInbox } from '@kiki/session-core/sessions';
import { createKlient } from '@kiki/klient/http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  API_CODES,
  ApiError,
  isSessionIndexBuildingError,
  isSessionNotFoundMessage,
  KikiClient,
  MEMORY_REVISION_CONFLICT,
  NativeChildPromptConflictError,
  type AgentTranscriptResponse,
} from './client';
import {
  isMemoryToolName,
  parseMemoryReadResult,
  parseMemorySearchSummary,
  parseMemoryWriteResult,
} from '../components/MemoryToolRow';
import { memoryApplicability } from '../components/memory/memoryReceipt';
import { refreshSessionAttention } from '../state/connection';

function transcriptView(sessionId: string, validate = false) {
  return createKlient({ endpoint: 'http://example.test', validate }).session(sessionId).view;
}

function resumeResponse(url: string | URL, init?: RequestInit): Response | undefined {
  if (!String(url).endsWith('/api/klient/call')) return undefined;
  const body = JSON.parse(init?.body as string);
  if (body.procedure.method !== 'resume') return undefined;
  expect(body).toEqual({ procedure: { scope: 'core', service: 'sessionManager', method: 'resume' }, params: ['s1'] });
  return Response.json({ code: 0, msg: 'success', data: { id: 's1', kind: 'session' } });
}

describe('KikiClient reading deadline options', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('defaults to unlimited reading without browser storage', async () => {
    vi.stubGlobal('localStorage', undefined);
    const client = new KikiClient({ baseUrl: 'http://example.test' });
    try { expect(client.readingOptions()).toEqual({ timeoutMs: 0 }); }
    finally { await client.klient.close(); }
  });
  it('reads changed browser deadlines on the existing client', async () => {
    let stored = '{}';
    vi.stubGlobal('localStorage', { getItem: () => stored });
    const client = new KikiClient({ baseUrl: 'http://example.test' });
    try {
      expect(client.readingOptions()).toEqual({ timeoutMs: 0 });
      stored = JSON.stringify({ readingTimeoutSeconds: 3600 });
      expect(client.readingOptions()).toEqual({ timeoutMs: 3600000 });
      stored = JSON.stringify({ readingTimeoutSeconds: 0 });
      expect(client.readingOptions()).toEqual({ timeoutMs: 0 });
    } finally { await client.klient.close(); }
  });
});

describe('KikiClient skill and text preview reading options', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('samples the live reading setting and forwards cancellation without changing existing read arguments', async () => {
    let stored = '{}';
    vi.stubGlobal('localStorage', { getItem: () => stored });
    const client = new KikiClient({ baseUrl: 'http://example.test' });
    const rest = client.klient.rest;
    if (rest === undefined) throw new Error('HTTP client must expose its REST facade');
    const builtin = vi.spyOn(rest.skills, 'readBuiltinContent').mockResolvedValue({ name: 'example', content: '# skill' });
    const preview = vi.spyOn(rest.filesystem, 'previewHostFile').mockResolvedValue({ text: 'preview', truncated: true });
    const original = vi.spyOn(rest.filesystem, 'readHostFile').mockResolvedValue('complete');
    const controller = new AbortController();
    try {
      await expect(client.readBuiltinSkill('example')).resolves.toBe('# skill');
      expect(builtin).toHaveBeenLastCalledWith('example', { timeoutMs: 0 });
      await client.previewHostFile('/example');
      expect(preview).toHaveBeenLastCalledWith('/example', 512001, { timeoutMs: 0 });
      stored = JSON.stringify({ readingTimeoutSeconds: 2 });
      await client.readBuiltinSkill('example', { signal: controller.signal });
      expect(builtin).toHaveBeenLastCalledWith('example', { timeoutMs: 2000, signal: controller.signal });
      await client.previewHostFile('/example', 8, { signal: controller.signal });
      expect(preview).toHaveBeenLastCalledWith('/example', 8, { timeoutMs: 2000, signal: controller.signal });
      await client.readHostFile('/example', { signal: controller.signal, timeoutMs: 0 });
      expect(original).toHaveBeenLastCalledWith('/example', { timeoutMs: 0, signal: controller.signal });
    } finally { await client.klient.close(); }
  });
});

describe('KikiClient cold-session actions', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const actions = [
    { path: '/prompts', invoke: (client: KikiClient) => client.submitPrompt('s1', { content: [{ type: 'text', text: 'hello' }] }),
      result: { prompt_id: 'p1', user_message_id: 'p1', status: 'queued', content: [{ type: 'text', text: 'hello' }], created_at: '2026-01-01T00:00:00.000Z' } },
    { path: '/approvals/a1', invoke: (client: KikiClient) => client.resolveApproval('s1', 'a1', { decision: 'approved' }),
      result: { resolved: true, resolved_at: '2026-01-01T00:00:00.000Z' } },
    { path: '/prompts/p1:steer', invoke: (client: KikiClient) => client.steerPrompt('s1', 'p1'),
      result: { steered: true, prompt_ids: ['p1'] } },
  ];
  it.each(actions)('resumes before POST $path', async ({ path, invoke, result }) => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push(new URL(url).pathname);
      const resumed = resumeResponse(url, init);
      if (resumed !== undefined) return resumed;
      expect(calls).toEqual(['/api/klient/call', `/api/sessions/s1${path}`]);
      expect(init?.method).toBe('POST');
      return Response.json({ code: 0, msg: 'success', data: result });
    }));
    const client = new KikiClient({ baseUrl: 'http://example.test' });
    try { await expect(invoke(client)).resolves.toEqual(result); }
    finally { await client.klient.close(); }
  });
  it.each(actions)('does not POST $path when resume fails', async ({ invoke }) => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(resumeResponse(url, init)).toBeDefined();
      return Response.json({ code: 40901, msg: 'session locked', data: null });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://example.test' });
    try {
      await expect(invoke(client)).rejects.toMatchObject({ code: 40901 });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { await client.klient.close(); }
  });
});

describe('sidebar activity mutation refresh', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  type Mutations = Pick<KikiClient, 'resolveApproval' | 'resolveQuestion' | 'dismissQuestion' | 'submitPrompt'>;
  const actions = [
    { name: 'approve', invoke: (client: Mutations) => client.resolveApproval('s1', 'a1', { decision: 'approved' }), result: { resolved: true, resolved_at: '2026-01-01T00:00:00Z' } },
    { name: 'reject', invoke: (client: Mutations) => client.resolveApproval('s1', 'a1', { decision: 'rejected' }), result: { resolved: true, resolved_at: '2026-01-01T00:00:00Z' } },
    { name: 'answer', invoke: (client: Mutations) => client.resolveQuestion('s1', 'q1', { answers: {}, method: 'click' }), result: { resolved: true, resolved_at: '2026-01-01T00:00:00Z' } },
    { name: 'dismiss', invoke: (client: Mutations) => client.dismissQuestion('s1', 'q1'), result: { dismissed: true, dismissed_at: '2026-01-01T00:00:00Z' } },
    { name: 'reply', invoke: (client: Mutations) => client.submitPrompt('s1', { content: [{ type: 'text', text: 'hello' }] }), result: { prompt_id: 'p1', user_message_id: 'p1', status: 'queued', content: [{ type: 'text', text: 'hello' }], created_at: '2026-01-01T00:00:00Z' } },
  ];
  const cases = actions.flatMap((action) => ['facade', 'controller transport'].map((source) => ({ ...action, source })));

  it.each(cases)('refreshes the cached bell/inbox immediately after $name via $source succeeds, without advancing the poll clock', async ({ invoke, result, source }) => {
    vi.useFakeTimers();
    const start = Date.now();
    let pending = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const resumed = resumeResponse(url, init);
      if (resumed !== undefined) return resumed;
      pending = false;
      return Response.json({ code: 0, msg: 'success', data: result });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const read = vi.fn(async () => ({ items: [{ id: 's1', title: 'Example', workspace_id: 'example', updated_at: '2026-01-01T00:00:00Z', busy: true, pending_interaction: pending ? 'approval' : 'none', last_seq: 4 } as Session] }));
    const observer = new QueryObserver(queryClient, { queryKey: ['sessions', false], queryFn: read });
    const unsubscribe = observer.subscribe(() => {});
    const client = new KikiClient({ baseUrl: 'http://example.test', onSessionMutation: (id) => { refreshSessionAttention(queryClient, id); } });
    const inbox = () => buildConversationInbox(observer.getCurrentResult().data?.items ?? [], [], { s1: 4 });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(inbox().total).toBe(1);
      await invoke(source === 'facade' ? client : client.sessions);
      await vi.advanceTimersByTimeAsync(0);
      expect(inbox().total).toBe(0);
      expect(read).toHaveBeenCalledTimes(2);
      expect(Date.now()).toBe(start);
    } finally {
      unsubscribe();
      queryClient.clear();
      await client.klient.close();
    }
  });

  it.each(actions)('does not refresh or clear activity when $name fails', async ({ invoke }) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const resumed = resumeResponse(url, init);
      return resumed ?? Response.json({ code: 40001, msg: 'request failed', data: null });
    }));
    const onSessionMutation = vi.fn();
    const client = new KikiClient({ baseUrl: 'http://example.test', onSessionMutation });
    try {
      await expect(invoke(client)).rejects.toBeInstanceOf(ApiError);
      expect(onSessionMutation).not.toHaveBeenCalled();
    } finally { await client.klient.close(); }
  });
});

describe('KikiClient capability plan', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads the server plan and sends the confirmed digest through the validated klient call', async () => {
    const sha256 = 'a'.repeat(64);
    const status = {
      id: 'kimi-webbridge', displayName: 'WebBridge', description: 'Browser', supported: true,
      state: 'partial', steps: [{ id: 'extension', state: 'missing' }], install: { running: false },
      plan: { artifact: { version: 'v2.0.22', url: 'https://example.test/daemon',
        sha256, metadataUrl: 'https://example.test/version.json', maxBytes: 1024 },
      destination: '/home/example/bin', note: 'Publisher metadata' },
    };
    const calls: Array<{ method: string; params: unknown[] }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        procedure: { method: string }; params: unknown[];
      };
      calls.push({ method: body.procedure.method, params: body.params });
      return Response.json({ code: 0, msg: 'success', data: status });
    }));
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'test-token' });
    expect((await client.getCapability('kimi-webbridge')).plan?.artifact.sha256).toBe(sha256);
    await client.installCapability('kimi-webbridge', sha256);
    expect(calls).toEqual([
      { method: 'getCapability', params: ['kimi-webbridge'] },
      { method: 'installCapability', params: ['kimi-webbridge', sha256] },
    ]);
  });
});

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

  it('passes a draft key only to the targeted provider refresh procedure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({
        procedure: { scope: 'core', service: 'providerDiscovery', method: 'refreshProviderModels' },
        params: [{ providerId: 'example', apiKey: 'sk-draft' }],
      });
      return Response.json({ code: 0, msg: 'success', data: { changed: [], unchanged: ['example'], failed: [] } });
    }));
    try {
      await new KikiClient({ baseUrl: 'http://127.0.0.1:8080' }).refreshProvider('example', 'sk-draft');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('KikiClient.probeProviderDraft', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes the unsaved form values through the server endpoint', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8080/api/providers:probe');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        type: 'kimi',
        base_url: 'https://api.kimi.com/coding/v1',
        api_key: 'sk-draft',
      });
      return Response.json({ code: 0, msg: 'success', data: { ok: true, models: ['kimi-for-coding', 'kimi-k2-0711-preview'] } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });

    const drafts = await client.probeProviderDraft({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-draft',
    });

    expect(drafts.map((draft) => draft.remoteId)).toEqual(['kimi-for-coding', 'kimi-k2-0711-preview']);
    expect(drafts[0]?.maxContextSize).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('surfaces a structured probe failure as-is, never falling back', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      code: 0,
      msg: 'success',
      data: { ok: false, error: { kind: 'unauthorized', message: 'invalid API key', status: 401 } },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });

    const failure = await client
      .probeProviderDraft({ type: 'kimi', baseUrl: 'https://api.kimi.com/coding/v1', apiKey: 'sk-bad' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('invalid API key');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('falls back to the browser-direct fetch when the server lacks the route', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href === 'http://127.0.0.1:8080/api/providers:probe') {
        return Response.json({ code: 40404, msg: 'no route', data: null });
      }
      if (href === 'https://provider.test/v1/models') {
        return Response.json({ data: [{ id: 'kimi-for-coding' }] });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });

    const drafts = await client.probeProviderDraft({
      type: 'kimi',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'sk-draft',
    });

    expect(drafts.map((draft) => draft.remoteId)).toEqual(['kimi-for-coding']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('KikiClient.sendAgentMessage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the user mailbox for a persisted external agent and refuses to silently drop attachments', async () => {
    const calls: Array<{ service: string; method: string; params: unknown[] }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8080/api/klient/call');
      const body = JSON.parse(init?.body as string) as { procedure: { service: string; method: string }; params: unknown[] };
      calls.push({ service: body.procedure.service, method: body.procedure.method, params: body.params });
      if (body.procedure.method === 'read') return Response.json({
        code: 0, msg: 'success', data: { id: 's1', createdAt: 1, updatedAt: 1, archived: false,
          agents: { child: { type: 'sub', executor: 'grok-acp' } } },
      });
      if (body.procedure.method === 'sendUserMessage') return Response.json({
        code: 0, msg: 'success', data: {
          message: { messageId: 'message-1', sessionId: 's1', sourceAgentId: 'main', sourceTaskName: 'user',
            senderKind: 'user', targetAgentId: 'child', targetTaskName: 'child', content: 'next step',
            acceptedAt: 1, targetSeq: 1 },
          deduplicated: false, delivery: 'delivered', payloadConflict: false,
        },
      });
      throw new Error(`unexpected procedure: ${body.procedure.method}`);
    }));
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });
    const receipt = await client.sendAgentMessage('s1', 'child', 'next step', [{ type: 'text', text: 'next step' }], 'submission-1', 'tail-operation');
    expect(receipt).toMatchObject({ delivery: 'delivered', deduplicated: false, payloadConflict: false });
    expect(receipt?.message).toMatchObject({ messageId: 'message-1', targetAgentId: 'child', senderKind: 'user' });
    expect(calls.map((call) => [call.service, call.method])).toEqual([
      ['sessionMetadata', 'read'], ['agentCollaborationMessagingService', 'sendUserMessage'],
    ]);
    expect(calls[1]?.params[0]).toEqual({ targetAgentId: 'child', content: 'next step',
      idempotencyKey: 'submission-1' });
    await expect(client.sendAgentMessage('s1', 'child', 'next step', [
      { type: 'text', text: 'next step' },
      { type: 'file', file_id: 'file-1', name: 'file.txt', media_type: 'text/plain', size: 1 },
    ], 'submission-2')).rejects.toThrow('External agent messages support text only');
    expect(calls.map((call) => call.method)).toEqual(['read', 'sendUserMessage', 'read']);
  });

  it('retains the prompt route and attachments for a native child', async () => {
    const content = [{ type: 'text' as const, text: 'look' },
      { type: 'file' as const, file_id: 'file-1', name: 'file.txt', media_type: 'text/plain', size: 1 }];
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      const resumed = resumeResponse(url, init);
      if (resumed !== undefined) return resumed;
      if (String(url).endsWith('/api/klient/call')) return Response.json({
        code: 0, msg: 'success', data: { id: 's1', createdAt: 1, updatedAt: 1, archived: false,
          agents: { child: { type: 'sub', executor: 'native' } } },
      });
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ agent_id: 'child', content });
      expect(body).not.toHaveProperty('prompt_id');
      return Response.json({ code: 0, msg: 'success', data: {
        prompt_id: 'p1', user_message_id: 'p1', status: 'running', content,
        created_at: '2026-01-01T00:00:00.000Z',
      } });
    }));
    const receipt = await new KikiClient({ baseUrl: 'http://127.0.0.1:8080' })
      .sendAgentMessage('s1', 'child', 'look', content, 'native-submission');
    // Attachments retain the ordinary prompt route and have no replay guarantee.
    expect(receipt).toBeNull();
    expect(urls).toEqual(['http://127.0.0.1:8080/api/klient/call', 'http://127.0.0.1:8080/api/klient/call', 'http://127.0.0.1:8080/api/sessions/s1/prompts']);
  });

  it('sends one native child text key to the prompt route and treats replay as a prompt, not a mailbox delivery', async () => {
    const accepted = new Map<string, string>();
    const requests: Array<Record<string, unknown>> = [];
    let loseFirstResponse = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const resumed = resumeResponse(url, init);
      if (resumed !== undefined) return resumed;
      if (String(url).endsWith('/api/klient/call')) return Response.json({
        code: 0, msg: 'success', data: { id: 's1', createdAt: 1, updatedAt: 1, archived: false,
          agents: { child: { type: 'sub', executor: 'native' } } },
      });
      expect(String(url)).toBe('http://127.0.0.1:8080/api/sessions/s1/prompts');
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      requests.push(body);
      const key = body['prompt_id'] as string;
      const content = JSON.stringify(body['content']);
      const earlier = accepted.get(key);
      if (earlier !== undefined && earlier !== content) return Response.json({
        code: 40938, msg: 'prompt.id_conflict', data: null,
      });
      accepted.set(key, content);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error('response lost after acceptance');
      }
      return Response.json({ code: 0, msg: 'success', data: {
        prompt_id: key, user_message_id: key, status: 'running', content: body['content'],
        created_at: '2026-01-01T00:00:00.000Z',
      } });
    }));
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });
    const send = (text: string, key: string) => client.sendAgentMessage('s1', 'child', text, [
      { type: 'text', text },
    ], key);
    await expect(send('next step', 'native-key-1')).rejects.toThrow();
    expect(await send('next step', 'native-key-1')).toBeNull();
    expect(accepted.size).toBe(1);
    await expect(send('changed step', 'native-key-1')).rejects.toBeInstanceOf(NativeChildPromptConflictError);
    expect(requests).toEqual([
      { agent_id: 'child', prompt_id: 'native-key-1', content: [{ type: 'text', text: 'next step' }] },
      { agent_id: 'child', prompt_id: 'native-key-1', content: [{ type: 'text', text: 'next step' }] },
      { agent_id: 'child', prompt_id: 'native-key-1', content: [{ type: 'text', text: 'changed step' }] },
    ]);
  });

  it.each(['GUI native text', 'GUI native attachment', 'typed facade'])(
    'preserves the switch dependency through commands.submit for %s', async (source) => {
      const content = source === 'GUI native attachment'
        ? [{ type: 'text' as const, text: 'continue' }, { type: 'file' as const, file_id: 'file-1', name: 'example.txt', media_type: 'text/plain', size: 1 }]
        : [{ type: 'text' as const, text: 'continue' }];
      const requests: unknown[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
        const resumed = resumeResponse(url, init);
        if (resumed !== undefined) return resumed;
        if (String(url).endsWith('/api/klient/call')) return Response.json({
          code: 0, msg: 'success', data: { id: 's1', createdAt: 1, updatedAt: 1, archived: false,
            agents: { child: { type: 'sub', executor: 'native' } } },
        });
        expect(new URL(url).pathname).toBe('/api/sessions/s1/prompts');
        const body = JSON.parse(init?.body as string);
        requests.push(body);
        return Response.json({ code: 0, msg: 'success', data: {
          prompt_id: 'child-key', user_message_id: 'child-key', status: 'queued', content,
          created_at: '2026-01-01T00:00:00.000Z',
        } });
      }));
      const client = new KikiClient({ baseUrl: 'http://example.test' });
      try {
        if (source === 'typed facade') await client.klient.session('s1').commands.submit({
          agent_id: 'child', prompt_id: 'child-key', content, after_model_switch: 'tail-operation',
        });
        else await client.sendAgentMessage('s1', 'child', 'continue', content, 'child-key', 'tail-operation');
        expect(requests).toEqual([{
          agent_id: 'child', content, after_model_switch: 'tail-operation',
          ...(source === 'GUI native attachment' ? {} : { prompt_id: 'child-key' }),
        }]);
      } finally { await client.klient.close(); }
    },
  );

  it('does not attach a child replay key to a main prompt', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const resumed = resumeResponse(url, init);
      if (resumed !== undefined) return resumed;
      if (String(url).endsWith('/api/klient/call')) return Response.json({
        code: 0, msg: 'success', data: { id: 's1', createdAt: 1, updatedAt: 1, archived: false, agents: {} },
      });
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ agent_id: 'main', content: [{ type: 'text', text: 'main message' }] });
      return Response.json({ code: 0, msg: 'success', data: {
        prompt_id: 'main-prompt', user_message_id: 'main-prompt', status: 'queued',
        content: body.content, created_at: '2026-01-01T00:00:00.000Z',
      } });
    }));
    await expect(new KikiClient({ baseUrl: 'http://127.0.0.1:8080' })
      .sendAgentMessage('s1', 'main', 'main message', [{ type: 'text', text: 'main message' }], 'child-key'))
      .resolves.toBeNull();
  });
});

describe('KikiClient transport error mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not reinterpret a server INTERNAL_ERROR 50001 as a timeout', async () => {
    const data = { request: 'server-error', retryable: false };
    const details = { conflicts: [{ platform: 'windows', actions: ['switcher', 'find'], kind: 'duplicate', key: 'f' }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 50001,
      msg: 'server.internal_error',
      data,
      request_id: 'req-server-50001',
      reason: 'server.internal_error',
      details,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });

    const failure = await client.meta().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe(50001);
    expect((failure as ApiError).message).toContain('server.internal_error');
    expect((failure as ApiError).data).toEqual(data);
    // Structured error context is the only machine-readable part of a
    // failure; it has to survive the RPCError -> ApiError hop.
    expect((failure as ApiError).details).toEqual(details);
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

  it('forwards a session snapshot abort signal to the dedicated HTTP request', async () => {
    const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080' });
    const controller = new AbortController();
    const pending = client.sessionView('s1').snapshot({ signal: controller.signal });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(requestSignal?.aborted).toBe(false);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(requestSignal?.aborted).toBe(true);
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
  it('shares a source preview request and cancels only the departing reader', async () => {
    let complete!: (response: Response) => void;
    let sharedSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sharedSignal = init?.signal;
      return new Promise<Response>((resolve) => { complete = resolve; });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'fixture-token' });
    const first = new AbortController();
    const second = new AbortController();
    try {
      const leaving = client.readSessionMediaPreviewBytes('s1', 'image', { signal: first.signal });
      const staying = client.readSessionMediaPreviewBytes('s1', 'image', { signal: second.signal });
      const rejected = expect(leaving).rejects.toThrow();
      first.abort();
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sharedSignal?.aborted).toBe(false);
      complete(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png', etag: 'fixture-v2' } }));
      expect((await staying).bytes).toEqual(new Uint8Array([1, 2]));
    } finally { await client.klient.close(); vi.unstubAllGlobals(); }
  });

  it('does not retain failed shared preview requests and permits retry', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('temporary transport failure')).mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'fixture-token' });
    try {
      await expect(client.readSessionMediaPreviewBytes('s1', 'image')).rejects.toThrow('temporary transport failure');
      expect((await client.readSessionMediaPreviewBytes('s1', 'image')).bytes.byteLength).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { await client.klient.close(); vi.unstubAllGlobals(); }
  });
  it('revalidates a bounded image thumbnail without downloading the original', async () => {
    const thumbnail = new Uint8Array(64 * 1024);
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/sessions/s1/media/image/preview');
      expect(parsed.searchParams.get('media_type')).toBe('image/png');
      expect(init?.method).toBe('GET');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer token');
      if (fetchMock.mock.calls.length > 1) {
        expect(headers.get('if-none-match')).toBe('"image-v1"');
        return new Response(null, { status: 304, headers: { etag: '"image-v1"' } });
      }
      expect(headers.has('if-none-match')).toBe(false);
      return new Response(thumbnail, {
        status: 200, headers: { 'content-type': 'image/png', etag: '"image-v1"' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
    try {
      const first = await client.readSessionMediaPreviewBytes('s1', 'image', { mediaType: 'image/png' });
      const second = await client.readSessionMediaPreviewBytes('s1', 'image', { mediaType: 'image/png' });
      expect(first.bytes.byteLength).toBe(64 * 1024);
      expect(first.mime).toBe('image/png');
      expect(second.bytes).toBe(first.bytes);
      expect(second.mime).toBe(first.mime);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await client.klient.close();
      vi.unstubAllGlobals();
    }
  });

  it('reads an 8 MiB canonical image with auth, MIME, and server filename', async () => {
    const image = new Uint8Array(8 * 1024 * 1024);
    image.set([4, 5, 6]);
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/sessions/session%20one/media/file%2Fdiagram');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer token');
      return new Response(image, {
        status: 200,
        headers: {
          'content-type': 'image/png; charset=binary',
          'content-disposition': 'inline; filename="diagram final.png"',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
    try {
      const result = await client.readSessionMediaBytes('session one', 'file/diagram');
      expect(result.mime).toBe('image/png');
      expect(result.name).toBe('diagram final.png');
      expect(result.bytes.byteLength).toBe(8 * 1024 * 1024);
      expect([...result.bytes.subarray(0, 3)]).toEqual([4, 5, 6]);
      expect(result.bytes.subarray(3).every((byte) => byte === 0)).toBe(true);
    } finally {
      await client.klient.close();
      vi.unstubAllGlobals();
    }
  });
});

function envelope(data: unknown): Response {
  return Response.json({ code: 0, msg: 'ok', data, request_id: 'req_test' });
}

function captureFetch(): { calls: URL[]; restore: () => void } {
  const calls: URL[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(input instanceof URL ? input : new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
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
      expect(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname).toBe('/api/leases');
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
      expect(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname).toBe('/api/leases');
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
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
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
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
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
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
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
    globalThis.fetch = vi.fn(async () => envelope({ ...payload, transcript_coverage_version: 2 })) as typeof fetch;
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

  it('rejects a compact legacy body that only has agent_id / items / has_more', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      envelope({
        agent_id: 'main',
        items: [{ kind: 'marker', markerId: 'm1', marker: 'compaction' }],
        has_more: true,
      }),
    ) as typeof fetch;
    try {
      await expect(transcriptView('sess-1', true).transcript.page({ agentId: 'main' })).rejects.toThrow(
        'output validation failed for session.view.transcript.page',
      );
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
      ).rejects.toThrow('beforeTurn, beforeItem, afterTurn and afterItem are mutually exclusive');
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
      const resumed = resumeResponse(url, init);
      if (resumed !== undefined) return resumed;
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
      const resumed = resumeResponse(url, init);
      if (resumed !== undefined) return resumed;
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) =>
      resumeResponse(url, init) ?? new Response(
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
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const resumed = resumeResponse(url, init);
        const responseTimer = setTimeout(() => {
          resolve(resumed ?? new Response(JSON.stringify({
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

describe('memory client surface', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('carries page coverage and scope while continuing with only cursor, and forwards cancellation', async () => {
    const seen: URL[] = [];
    const controller = new AbortController();
    const page = { items: [], next_cursor: 'opaque-example', coverage: { scopes: [{ kind: 'persona_workspace', workspaceId: 'wd_a_0123456789ab', personaId: 'example-role' }], statuses: ['pending'], complete: false, exhausted: false, warnings: ['1 invalid memory record'] } };
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push(new URL(String(url)));
      expect(init?.signal?.aborted).toBe(controller.signal.aborted);
      return new Response(JSON.stringify({ code: 0, msg: 'success', data: page }));
    }));
    const api = new KikiClient({ baseUrl: 'http://example.test' });
    const target = { scope: 'persona_workspace' as const, workspaceId: 'wd_a_0123456789ab', personaId: 'example-role' };
    expect(await api.listMemory(target, { mode: 'list', statuses: ['pending'], page_size: 2 }, controller.signal)).toEqual(page);
    expect(seen[0]!.searchParams.get('statuses')).toBe('pending');
    await api.listMemory(target, { cursor: 'opaque-example' }, controller.signal);
    expect([...seen[1]!.searchParams.keys()].sort()).toEqual(['cursor', 'persona_id', 'workspace_id']);
    expect(await api.memoryInbox(target, { cursor: 'opaque-example' }, controller.signal)).toEqual(page);
    expect([...seen[2]!.searchParams.keys()].sort()).toEqual(['cursor', 'persona_id', 'workspace_id']);
    controller.abort();
    await api.memoryInbox(target, {}, controller.signal);
  });

  const client = () => new KikiClient({ baseUrl: 'http://127.0.0.1:8080', token: 'token' });
  const envelope = (data: unknown, code = 0, msg = 'success') =>
    new Response(JSON.stringify({ code, msg, data, request_id: 'req_1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('carries the workspace scope as a query param and unwraps the envelope', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      seen.push(String(url));
      return envelope({ items: [] });
    }));
    await client().listMemory({ scope: 'workspace', workspaceId: 'wd_a_0123456789ab' }, { query: 'pnpm', type: 'project', include_inactive: true });
    expect(seen[0]).toContain('/api/memory/workspace');
    expect(seen[0]).toContain('workspace_id=wd_a_0123456789ab');
    expect(seen[0]).toContain('query=pnpm');
    expect(seen[0]).toContain('type=project');
    expect(seen[0]).toContain('include_inactive=true');
  });

  it('omits the workspace param for the global scope and blank filters', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      seen.push(String(url));
      return envelope({ items: [] });
    }));
    await client().listMemory({ scope: 'global' }, { query: '   ' });
    expect(seen[0]).not.toContain('workspace_id');
    expect(seen[0]).not.toContain('query=');
    expect(seen[0]).not.toContain('include_inactive');
  });

  it('sends a PUT with the body and surfaces a revision conflict as ApiError 40944', async () => {
    let method: string | undefined;
    let sent: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      method = init?.method;
      expect(typeof init?.body).toBe('string');
      sent = JSON.parse(init?.body as string);
      return envelope(null, MEMORY_REVISION_CONFLICT, 'memory.revision_conflict');
    }));
    await expect(client().putMemory({ scope: 'global' }, 'm_1', {
      type: 'project', title: 't', body: 'b', reason: 'r', expected_revision: 'rev',
    })).rejects.toMatchObject({ code: MEMORY_REVISION_CONFLICT });
    expect(method).toBe('PUT');
    expect(sent).toMatchObject({ expected_revision: 'rev', title: 't' });
  });

  it('guards a delete with expected_revision', async () => {
    const seen: { url: string; method?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method });
      return envelope({ operation_id: 'op_1' });
    }));
    const result = await client().deleteMemory({ scope: 'global' }, 'm_1', 'rev_9');
    expect(seen[0]?.method).toBe('DELETE');
    expect(seen[0]?.url).toContain('expected_revision=rev_9');
    expect(result.operation_id).toBe('op_1');
  });

  it('preserves metadata omission versus explicit validity null and reads an unchanged null operation', async () => {
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sent.push(JSON.parse(init?.body as string));
      return envelope({ entry: { id: 'm_1' }, outcome: 'unchanged', operationId: null });
    }));
    const fields = { action: 'update' as const, type: 'project' as const, title: 'Rule', body: 'Keep the current condition.', reason: 'Reviewed.', expected_revision: 'r1' };
    const result = await client().putMemory({ scope: 'global' }, 'm_1', fields);
    expect(sent[0]).not.toHaveProperty('basis');
    expect(sent[0]).not.toHaveProperty('validity');
    expect(result).toMatchObject({ outcome: 'unchanged', operationId: null });
    const basis = { kind: 'human' as const, note: 'An explicit current requirement.' };
    await client().putMemory({ scope: 'global' }, 'm_1', { ...fields, basis, validity: null });
    expect(sent[1]).toMatchObject({ basis, validity: null });
    expect(sent[1]?.['basis']).not.toBeNull();
  });

  it('sends covered-by expected_revision on archive and keeps the stored revision response', async () => {
    let sent: Record<string, unknown> | undefined;
    const covered = { id: 'm_kept', expected_revision: 'kept-r1' };
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sent = JSON.parse(init?.body as string);
      return envelope({ entry: { id: 'm_retired', covered_by: { id: covered.id, revision: covered.expected_revision } }, outcome: 'applied', operationId: 'op_archive' });
    }));
    const result = await client().putMemory({ scope: 'global' }, 'm_retired', { action: 'archive', type: 'project', title: 'Old rule', body: 'Stored rule.', reason: 'Covered by the retained rule.', expected_revision: 'r1', covered_by: covered });
    expect(sent?.['covered_by']).toEqual(covered);
    expect(sent?.['covered_by']).not.toHaveProperty('revision');
    expect(result.entry.covered_by).toEqual({ id: 'm_kept', revision: 'kept-r1' });
  });

  it('rejects a non-envelope response instead of returning undefined data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>nope</html>', { status: 502 })));
    await expect(client().getMemorySettings()).rejects.toMatchObject({ code: API_CODES.INVALID_RESPONSE });
  });
});

describe('memory timeline rows', () => {
  it('claims only the three memory tools', () => {
    expect(isMemoryToolName('MemoryWrite')).toBe(true);
    expect(isMemoryToolName('MemoryRead')).toBe(true);
    expect(isMemoryToolName('MemorySearch')).toBe(true);
    expect(isMemoryToolName('Write')).toBe(false);
    expect(isMemoryToolName('TodoList')).toBe(false);
  });

  it('parses a MemoryWrite result and ignores anything that is not one', () => {
    const output = JSON.stringify({
      id: 'm_1', title: 'Use pnpm', scope: 'workspace', status: 'active',
      revision: 'rev_1', operation_id: 'op_1',
    });
    // A pre-`outcome` receipt still reads as `applied`: the payload it carries
    // is the whole truth about what happened.
    expect(parseMemoryWriteResult(output)).toMatchObject({
      id: 'm_1', title: 'Use pnpm', scope: 'workspace', status: 'active',
      revision: 'rev_1', operation_id: 'op_1', outcome: 'applied',
      target: { scope: 'workspace', id: 'm_1', expected_revision: 'rev_1' },
    });
    // A running call, a plain string, and a foreign shape all yield undefined.
    expect(parseMemoryWriteResult(undefined)).toBeUndefined();
    expect(parseMemoryWriteResult('Memory is disabled.')).toBeUndefined();
    expect(parseMemoryWriteResult(JSON.stringify({ id: 'm_1', title: 't', scope: 'elsewhere' }))).toBeUndefined();
    expect(parseMemoryWriteResult(JSON.stringify([{ id: 'm_1' }]))).toBeUndefined();
  });

  it('defaults the optional result fields so a partial payload still renders', () => {
    const parsed = parseMemoryWriteResult(JSON.stringify({ id: 'm_2', title: 'T', scope: 'global' }));
    expect(parsed).toMatchObject({ status: 'active', revision: '', operation_id: null, outcome: 'applied' });
  });

  it('gives a receipt its real owning scope, so a persona entry is not read as the session workspace', () => {
    const parsed = parseMemoryWriteResult(JSON.stringify({
      id: 'm_3', title: 'Publish confirmation', scope: 'persona_workspace',
      owner_scope: { kind: 'persona_workspace', workspaceId: 'wd_home', personaId: 'lin-lan' },
      target: { scope: 'persona_workspace', id: 'm_3', expected_revision: 'rev_3' },
      status: 'active', revision: 'rev_3', operation_id: 'op_3', outcome: 'applied',
    }));
    expect(parsed?.owner_scope).toEqual({ scope: 'persona_workspace', workspaceId: 'wd_home', personaId: 'lin-lan' });
  });

  it('reads a no-op write as unchanged and withholds the operation it never created', () => {
    const parsed = parseMemoryWriteResult(JSON.stringify({
      id: 'm_4', title: 'Already said', scope: 'global', status: 'active',
      revision: 'rev_4', operation_id: null, outcome: 'unchanged',
    }));
    // There is nothing to replay, so Undo must not be offered.
    expect(parsed?.outcome).toBe('unchanged');
    expect(parsed?.operation_id).toBeNull();
  });

  it('reads both search shapes, and a short page as a partial one rather than an absence', () => {
    expect(parseMemorySearchSummary(JSON.stringify([{ id: 'm_1' }, { id: 'm_2' }])))
      .toEqual({ count: 2, hasMore: false, partial: false, warnings: [] });
    expect(parseMemorySearchSummary(JSON.stringify({
      items: [{ id: 'm_1' }],
      mode: 'list',
      next_cursor: 'next-page',
      coverage: { scopes: [{ kind: 'global' }], statuses: ['active'], exhausted: false, complete: true, warnings: [] },
    }))).toMatchObject({ count: 1, hasMore: true, partial: false });
    expect(parseMemorySearchSummary(JSON.stringify({
      items: [{ id: 'm_1' }],
      coverage: { scopes: [{ kind: 'global' }], statuses: ['active'], exhausted: true, complete: false, warnings: ['1 unreadable'] },
    }))).toMatchObject({ count: 1, partial: true });
  });

  it('reads a read result as full entries with their own scope, target and applicability', () => {
    const read = parseMemoryReadResult(JSON.stringify([{
      id: 'm_5', type: 'project', title: 'GPU schedule', body: 'Check the schedule first.',
      status: 'active', revision: 'rev_5', complete: true,
      scope: { kind: 'persona', personaId: 'lin-lan' },
      target: { scope: 'persona', id: 'm_5', expected_revision: 'rev_5' },
      applicability: 'expired',
      validity: { check: 'check the schedule', until: '2026-01-01T00:00:00Z' },
    }]));
    expect(read?.complete).toBe(true);
    expect(read?.items[0]?.applicability).toBe('expired');
    expect(read?.items[0]?.owner_scope).toEqual({ scope: 'persona', workspaceId: undefined, personaId: 'lin-lan' });
    // An entry with no validity reads as unrecorded, which is not permanence.
    expect(memoryApplicability(undefined)).toBe('unrecorded');
    expect(memoryApplicability({ check: 'c' })).toBe('recheck');
  });

  it('reports an id the read could not resolve instead of dropping it', () => {
    const read = parseMemoryReadResult(JSON.stringify([
      { id: 'm_6', missing: true, reason: 'not_found', recovery: 'Locate it in a visible scope.' },
    ]));
    expect(read?.items).toEqual([]);
    expect(read?.missing).toEqual([{ id: 'm_6', reason: 'not_found' }]);
  });
});
