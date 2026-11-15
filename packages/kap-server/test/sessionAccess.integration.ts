import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { getLiveSessionById, IAgentLifecycleService, IAgentLoopService, IAgentProfileService, IModelService, ISessionAgentProfileCatalog, SessionAgentProfileCatalogService, AGENT_PROFILE_SOURCE_PRIORITY, ISessionMediaStore, ISessionContext, IBlobStore, IBootstrapService, agentScopeOf, sessionScopeOf, workspacePersistenceScope, IAgentExecutorRegistry, closeSessionById, IWorkAdmissionService } from '@kiki/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/start';
import { bearerToken } from './helpers/auth';
import { type Envelope, usePromptFixture, promiseGate } from './helpers/promptFixture';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface SessionAccessIssue {
  token: string;
  expires_at: number;
  session_id: string;
  scopes: string[];
  server_id: string;
  server_version: string;
  session_access: 1;
}

interface SessionAccessListing {
  version: 1;
  enabled: boolean;
  terminal_handoff: boolean;
  server_id: string;
  tokens: Array<{
    id: string;
    session_id: string;
    scopes: string[];
    client: { name: string; version?: string };
    channel: 'owner' | 'terminal';
    issued_at: number;
    expires_at: number;
  }>;
}

interface PromptReceipt {
  prompt_id: string;
  user_message_id: string;
  status: 'running' | 'queued';
}

interface Message {
  id: string;
  role: string;
  metadata?: Record<string, unknown>;
}

interface MessagePage {
  items: Message[];
  has_more: boolean;
}

function findContentRef(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findContentRef(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object['revision'] === 'string' && Array.isArray(object['path']) &&
    typeof object['kind'] === 'string' && object['source'] !== null && typeof object['source'] === 'object') return object;
  for (const child of Object.values(object)) {
    const found = findContentRef(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe('server-v2 session access REST integration', () => {
  const fixture = usePromptFixture();

  async function request<T>(
    method: string,
    path: string,
    token: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: Envelope<T> }> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...extraHeaders };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${fixture.base}${path}`, init);
    return { status: response.status, body: (await response.json()) as Envelope<T> };
  }

  async function rawRequest(
    method: string,
    path: string,
    token: string,
  ): Promise<{ status: number; body: string }> {
    const target = new URL(fixture.base);
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: target.hostname,
        port: Number(target.port),
        method,
        path,
        headers: { authorization: `Bearer ${token}` },
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function issueToken(
    sessionId: string,
    scopes: Array<'read' | 'prompt' | 'abort'>,
    clientName = 'rest-fixture',
    ttlSeconds?: number,
  ): Promise<SessionAccessIssue> {
    const body: Record<string, unknown> = {
      session_id: sessionId,
      scopes,
      client: { name: clientName, version: '1' },
    };
    if (ttlSeconds !== undefined) body['ttl_seconds'] = ttlSeconds;
    const issued = await request<SessionAccessIssue>('POST', '/api/session-access/tokens', bearerToken(fixture.server!), body);
    expect(issued.status).toBe(200);
    expect(issued.body.code, issued.body.msg).toBe(0);
    expect(issued.body.data).toMatchObject({ session_id: sessionId, scopes, server_id: expect.any(String), server_version: expect.any(String), session_access: 1 });
    expect(issued.body.data.token).toMatch(/^ksa_[A-Za-z0-9_-]{43}$/);
    return issued.body.data;
  }

  it('issues, lists, revokes one token, and revokes all tokens through owner-only management routes', async () => {
    const sessionId = await fixture.createSession(fixture.home!);
    const first = await issueToken(sessionId, ['read']);
    const second = await issueToken(sessionId, ['read', 'prompt']);

    const listed = await request<SessionAccessListing>('GET', '/api/session-access', bearerToken(fixture.server!));
    expect(listed.body.code).toBe(0);
    expect(listed.body.data).toMatchObject({ version: 1, enabled: true, terminal_handoff: true });
    expect(listed.body.data.tokens).toHaveLength(2);
    expect(listed.body.data.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringMatching(/^sat_/), session_id: sessionId, scopes: ['read'], client: { name: 'rest-fixture', version: '1' }, channel: 'owner' }),
      expect.objectContaining({ id: expect.stringMatching(/^sat_/), session_id: sessionId, scopes: ['read', 'prompt'], channel: 'owner' }),
    ]));
    expect(JSON.stringify(listed.body.data)).not.toContain(first.token);

    const revoked = await request<{ revoked: number }>('DELETE', `/api/session-access/tokens/${listed.body.data.tokens.find((token) => token.scopes.length === 1)!.id}`, bearerToken(fixture.server!));
    expect(revoked.body).toMatchObject({ code: 0, data: { revoked: 1 } });
    expect((await request('GET', `/api/sessions/${sessionId}`, first.token)).body.code).toBe(40101);
    expect((await request('GET', `/api/sessions/${sessionId}`, second.token)).body.code).toBe(0);

    const revokeAll = await request<{ revoked: number }>('DELETE', '/api/session-access/tokens', bearerToken(fixture.server!));
    expect(revokeAll.body).toMatchObject({ code: 0, data: { revoked: 1 } });
    const after = await request<SessionAccessListing>('GET', '/api/session-access', bearerToken(fixture.server!));
    expect(after.body.data.tokens).toEqual([]);
  });

  it('allows the bound read routes, submits a text prompt, reads its owner via, and aborts the turn', async () => {
    const sessionId = await fixture.createSession(fixture.home!);
    await fixture.createHeldMainAgent(sessionId);
    const token = await issueToken(sessionId, ['read', 'prompt', 'abort']);
    const submitted = await request<PromptReceipt>('POST', `/api/sessions/${sessionId}/prompts?receipt=true`, token.token, {
      prompt_id: 'session-access-text-prompt',
      content: [{ type: 'text', text: 'A text prompt sent with a session access token.' }],
    });
    expect(submitted.body).toMatchObject({ code: 0, data: { prompt_id: 'session-access-text-prompt' } });

    const messages = await request<MessagePage>('GET', `/api/sessions/${sessionId}/messages`, token.token);
    expect(messages.body.code).toBe(0);
    const userMessage = messages.body.data.items.find((item) => item.id === submitted.body.data.user_message_id);
    expect(userMessage).toBeDefined();
    expect(userMessage).toMatchObject({
      role: 'user',
      metadata: { origin: { kind: 'user', via: { client: 'rest-fixture', channel: 'owner' } } },
    });

    const allowedReads = [
      `/api/sessions/${sessionId}`,
      `/api/sessions/${sessionId}/status`,
      `/api/sessions/${sessionId}/snapshot`,
      `/api/sessions/${sessionId}/messages/${submitted.body.data.user_message_id}`,
      `/api/sessions/${sessionId}/transcript?agent_id=main&transcript_coverage_version=2`,
      `/api/sessions/${sessionId}/transcript/ops?agent_id=main&since_seq=0&transcript_coverage_version=2`,
      `/api/sessions/${sessionId}/transcript/detail?agent_id=main&kind=prompt&id=${submitted.body.data.prompt_id}`,
      `/api/sessions/${sessionId}/transcript/details?agent_id=main&kind=prompt`,
      `/api/sessions/${sessionId}/transcript/plan?agent_id=main`,
      `/api/sessions/${sessionId}/transcript/user-messages?agent_id=main`,
      `/api/sessions/${sessionId}/prompts`,
      `/api/sessions/${sessionId}/children`,
      `/api/sessions/${sessionId}/tasks`,
      `/api/sessions/${sessionId}/agent-tasks`,
      `/api/sessions/${sessionId}/goal`,
      `/api/sessions/${sessionId}/warnings`,
      `/api/sessions/${sessionId}/profile`,
      `/api/sessions/${sessionId}/runtime`,
      `/api/sessions/${sessionId}/skills`,
      `/api/usage/sessions/${sessionId}/accounting`,
      `/api/sessions/${sessionId}/approvals?status=pending`,
      `/api/sessions/${sessionId}/questions?status=pending`,
    ];
    for (const path of allowedReads) {
      const result = await request('GET', path, token.token);
      expect(result.status, path).toBe(200);
      expect(result.body.code, `${path}: ${result.body.msg}`).toBe(0);
    }

    const savedPrompt = await request('GET', `/api/sessions/${sessionId}/prompts/example-prompt?admission=durable`, token.token);
    expect(savedPrompt.status).toBe(200);
    expect(savedPrompt.body.code).toBe(40402);
    const aborted = await request<{ aborted: boolean }>('POST', `/api/sessions/${sessionId}:abort`, token.token, {});
    expect(aborted.body).toMatchObject({ code: 0, data: { aborted: true } });
    const session = getLiveSessionById(fixture.server!.core.accessor, sessionId)!;
    const loop = session.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentLoopService);
    await loop.settled();
    expect(loop.status()).toMatchObject({ state: 'idle', lastTurnResult: 'cancelled' });
  });

  it('stores a terminal-channel prompt as a user message with its terminal via', async () => {
    const sessionId = await fixture.createSession(fixture.home!);
    await fixture.createHeldMainAgent(sessionId);
    const holder_id = randomBytes(16).toString('base64url');
    const presence = await fetch(`${fixture.base}/api/session-access/holders/${holder_id}/presence`, {
      headers: { authorization: `Bearer ${bearerToken(fixture.server!)}` },
    });
    expect(presence.status).toBe(200);
    const reader = presence.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
      const verifier = randomBytes(32).toString('base64url');
      const ticket = await fixture.call<{ ticket: string }>('POST', '/api/session-access/tickets', {
        session_id: sessionId, holder_id, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
      });
      expect(ticket.body.code).toBe(0);
      const exchanged = await fetch(`${fixture.base}/api/session-access/exchange`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: ticket.body.data.ticket, verifier, client: { name: 'terminal-fixture' } }),
      });
      const issued = await exchanged.json() as Envelope<SessionAccessIssue>;
      expect(issued.code).toBe(0);
      const submitted = await request<PromptReceipt>('POST', `/api/sessions/${sessionId}/prompts?receipt=true`, issued.data.token, {
        prompt_id: 'terminal-channel-prompt', content: [{ type: 'text', text: 'A terminal prompt.' }],
      });
      expect(submitted.body.code).toBe(0);
      const messages = await request<MessagePage>('GET', `/api/sessions/${sessionId}/messages`, issued.data.token);
      expect(messages.body.data.items).toContainEqual(expect.objectContaining({
        id: submitted.body.data.user_message_id, role: 'user',
        metadata: { origin: { kind: 'user', via: { client: 'terminal-fixture', channel: 'terminal' } } },
      }));
      expect((await request('POST', `/api/sessions/${sessionId}:abort`, issued.data.token, {})).body.code).toBe(0);
    } finally {
      await reader.cancel();
    }
  });

  it('rejects another session, out-of-scope operations, foreign content references, and Origin-bearing token requests', async () => {
    const sessionId = await fixture.createSession(fixture.home!);
    const otherSessionId = await fixture.createSession(fixture.home!);
    await fixture.createHeldMainAgent(otherSessionId);
    const foreignPrompt = await fixture.call<PromptReceipt>('POST', `/api/sessions/${otherSessionId}/prompts`, {
      prompt_id: 'foreign-content-reference',
      content: [{ type: 'text', text: 'foreign content '.repeat(20_000) }],
    });
    expect(foreignPrompt.body.code).toBe(0);
    const foreignTranscript = await fixture.call<Record<string, unknown>>('GET', `/api/sessions/${otherSessionId}/transcript?agent_id=main&transcript_coverage_version=2`);
    expect(foreignTranscript.body.code).toBe(0);
    const foreignRef = findContentRef(foreignTranscript.body.data);
    expect(foreignRef).toBeDefined();

    const otherToken = await issueToken(otherSessionId, ['read']);
    const content = await request('POST', `/api/klient/session-view/${otherSessionId}/transcript/content`, otherToken.token, { agentId: 'main', ref: foreignRef });
    expect(content.body.code, content.body.msg).toBe(0);

    const token = await issueToken(sessionId, ['read']);
    const foreignRefOnOwnPath = await request('POST', `/api/klient/session-view/${sessionId}/transcript/content`, token.token, { agentId: 'main', ref: foreignRef });
    expect(foreignRefOnOwnPath.body.code).toBe(40401);
    const denied = [
      await request('GET', `/api/sessions/${otherSessionId}/snapshot`, token.token),
      await request('GET', '/api/sessions', token.token),
      await request('GET', `/api/usage/sessions/${otherSessionId}/accounting`, token.token),
      await request('GET', `/api/sessions/${sessionId}/fs/list`, token.token),
      await request('GET', `/api/sessions/${sessionId}/terminals`, token.token),
      await request('POST', `/api/sessions/${sessionId}/approvals/example:approve`, token.token, {}),
      await request('GET', '/api/session-access', token.token),
      await request('POST', `/api/sessions/${sessionId}/prompts`, token.token, { content: [{ type: 'text', text: 'not allowed' }] }),
      await request('POST', `/api/sessions/${sessionId}/prompts:steer`, token.token, { content: [{ type: 'text', text: 'not allowed' }] }),
      await request('POST', `/api/sessions/${sessionId}/prompts/example:cancel`, token.token, {}),
      await request('POST', `/api/sessions/${sessionId}:abort`, token.token, {}),
      await request('POST', `/api/klient/session-view/${otherSessionId}/transcript/content`, token.token, { agentId: 'main', ref: foreignRef }),
    ];
    for (const result of denied) {
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ code: 40101, msg: 'session_access_scope' });
    }

    const withOrigin = await request('GET', `/api/sessions/${sessionId}/snapshot`, token.token, undefined, { origin: 'http://example.test' });
    expect(withOrigin.status).toBe(401);
    expect(withOrigin.body.code).toBe(40101);

    const withFetchSite = await request('GET', `/api/sessions/${sessionId}/snapshot`, token.token, undefined, { 'sec-fetch-site': 'cross-site' });
    expect(withFetchSite.status).toBe(401);
    expect(withFetchSite.body.code).toBe(40101);
  });

  it('rejects unsafe raw paths and HEAD before route matching', async () => {
    const sessionId = await fixture.createSession(fixture.home!);
    const token = await issueToken(sessionId, ['read']);
    const paths = [
      `/api/sessions/${sessionId}/snapshot%2f`,
      `/api//sessions/${sessionId}/snapshot`,
      `/api/sessions/${sessionId}/./snapshot`,
      `/api/sessions/${sessionId}/../snapshot`,
      `/api/sessions/${sessionId}/snapshot/`,
    ];
    for (const path of paths) {
      const result = await rawRequest('GET', path, token.token);
      expect(result.status, path).toBe(403);
    }
    const head = await rawRequest('HEAD', `/api/sessions/${sessionId}/snapshot`, token.token);
    expect(head.status).toBe(403);
  });

  it('reports every forbidden prompt field and non-text presentation as a validation error', async () => {
    const sessionId = await fixture.createSession(fixture.home!);
    const token = await issueToken(sessionId, ['prompt']);
    const forbidden = [
      'model', 'thinking', 'permission_mode', 'plan_mode', 'plan_gate', 'profile', 'execution',
      'disabled_tools', 'skills', 'goal_objective', 'goal_control', 'goal_follow_up_timing',
      'goal_initial_status', 'delivery_mode', 'admission', 'append_timing', 'after_model_switch',
      'model_switch_mode', 'persona_greeting_reply',
    ];
    for (const field of forbidden) {
      const body: Record<string, unknown> = {
        prompt_id: `forbidden-${field}`,
        content: [{ type: 'text', text: 'This request must not be silently narrowed.' }],
      };
      body[field] = 'forbidden';
      const result = await request('POST', `/api/sessions/${sessionId}/prompts`, token.token, body);
      expect(result.body.code, field).toBe(40001);
      expect(result.body.msg, field).toContain(field);
    }
    const presentation = await request('POST', `/api/sessions/${sessionId}/prompts`, token.token, {
      content: [{ type: 'text', text: 'presentation is not allowed', presentation: { kind: 'fixture' } }],
    });
    expect(presentation.body.code).toBe(40001);
    expect(presentation.body.msg).toContain('content.0.presentation');

    const otherAgent = await request('POST', `/api/sessions/${sessionId}/prompts`, token.token, {
      agent_id: 'child', content: [{ type: 'text', text: 'Unknown agents cannot be targeted.' }],
    });
    expect(otherAgent.body.code).toBe(40001);
    expect(otherAgent.body.msg).toContain('agent_id');
  });

  it('does not route a fenced token prompt into the existing durable outbox fallback', async () => {
    const sessionId = await fixture.createSession(fixture.home!);
    const token = await issueToken(sessionId, ['prompt']);
    fixture.server!.core.accessor.get(IWorkAdmissionService).fence('session-access-switch');
    const result = await request('POST', `/api/sessions/${sessionId}/prompts`, token.token, {
      prompt_id: 'fenced-session-access-prompt',
      content: [{ type: 'text', text: 'A fenced token prompt is not admitted.' }],
    });
    expect(result.body).toMatchObject({ code: 40950, details: { operationId: 'session-access-switch' } });
  });

  it('projects the effective pre-turn model and display name without creating or binding main', async () => {
    const core = fixture.server!.core;
    await core.accessor.get(IModelService).set('stub', { ...core.accessor.get(IModelService).get('stub'), displayName: 'Example Model' });
    const sessionId = await fixture.createSession(fixture.home!, false);
    const lifecycle = getLiveSessionById(core.accessor, sessionId)!.accessor.get(IAgentLifecycleService);
    expect(lifecycle.get('main')).toBeUndefined();
    const token = await issueToken(sessionId, ['read']);
    expect((await request('GET', `/api/sessions/${sessionId}/status`, token.token)).body).toMatchObject({ code: 0, data: { model: 'stub', model_name: 'Example Model' } });
    expect((await request('GET', `/api/sessions/${sessionId}`, token.token)).body).toMatchObject({ code: 0, data: { agent_config: { model: 'stub' } } });
    expect(lifecycle.get('main')).toBeUndefined();
    const catalog = getLiveSessionById(core.accessor, sessionId)!.accessor.get(ISessionAgentProfileCatalog) as SessionAgentProfileCatalogService;
    catalog.setContribution('example-profile', { profiles: [{ ...catalog.getDefault(), modelAlias: 'stub-alt' }] }, AGENT_PROFILE_SOURCE_PRIORITY.explicit);
    expect((await request('GET', `/api/sessions/${sessionId}/status`, token.token)).body).toMatchObject({ code: 0, data: { model: 'stub-alt', model_name: null } });
    expect((await request('GET', `/api/sessions/${sessionId}`, token.token)).body).toMatchObject({ code: 0, data: { agent_config: { model: 'stub-alt' } } });
    expect(lifecycle.get('main')).toBeUndefined();
    catalog.removeContribution('example-profile');
    const main = await lifecycle.create({ agentId: 'main' });
    expect(main.accessor.get(IAgentProfileService).getModel()).toBe('');
    expect((await request('GET', `/api/sessions/${sessionId}/status`, token.token)).body).toMatchObject({ code: 0, data: { model: 'stub', model_name: 'Example Model' } });
    expect(main.accessor.get(IAgentProfileService).getModel()).toBe('');
    catalog.setContribution('example-budget', { profiles: [{ ...catalog.getDefault(), contextBudget: 100 }] }, AGENT_PROFILE_SOURCE_PRIORITY.explicit);
    await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub-alt', thinking: 'high' });
    expect((await request('GET', `/api/sessions/${sessionId}/status`, token.token)).body).toMatchObject({ code: 0, data: { model: 'stub-alt', model_name: null, max_context_tokens: 100, thinking_level: 'high' } });
    await core.accessor.get(IModelService).delete('stub-alt');
    const removed = await request<Record<string, unknown>>('GET', `/api/sessions/${sessionId}/status`, token.token);
    expect(removed.body).toMatchObject({ code: 0, data: { model: 'stub-alt', model_name: null, thinking_level: 'high' } });
    expect(removed.body.data['max_context_tokens']).toBeUndefined();
  });

  it('does not assign a native default model to a bound external harness without a model selection', async () => {
    const sessionId = await fixture.createSession(fixture.home!, false);
    const core = fixture.server!.core;
    const session = getLiveSessionById(core.accessor, sessionId)!;
    const executors = core.accessor.get(IAgentExecutorRegistry);
    const resolve = vi.spyOn(executors, 'resolveExecutable').mockResolvedValue({
      descriptor: { id: 'example-acp', protocol: 'acp-v1', command: 'fixture', args: [], revision: 'fixture' },
      options: {}, provider: { id: 'example-provider', protocol: 'acp-v1', validateOptions: () => ({}), validateBinding: binding => ({ ok: true, binding }), create: () => { throw new Error('This read must not launch an executor.'); } },
    });
    const validate = vi.spyOn(executors, 'validateBinding').mockImplementation((_id, _options, binding) => ({ ok: true, binding }));
    try {
      const main = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
      const profile = main.accessor.get(IAgentProfileService);
      await profile.bind({ execution: { executor: 'example-acp', profile: 'agent' } });
      expect(profile.getModel()).toBe('');
      const token = await issueToken(sessionId, ['read']);
      const status = await request<Record<string, unknown>>('GET', `/api/sessions/${sessionId}/status`, token.token);
      expect(status.body).toMatchObject({ code: 0, data: { model_name: null } });
      expect(status.body.data['model']).toBeUndefined();
      expect(status.body.data['max_context_tokens']).toBeUndefined();
      const binding = JSON.parse(JSON.stringify(profile.data().execution));
      const read = () => request('GET', `/api/sessions/${sessionId}`, token.token);
      expect((await read()).body).toMatchObject({ code: 0, data: { agent_config: { model: '', execution: binding } } });
      await closeSessionById(core.accessor, sessionId);
      expect((await read()).body).toMatchObject({ code: 0, data: { agent_config: { model: '', execution: binding } } });
      expect(getLiveSessionById(core.accessor, sessionId)).toBeUndefined();
    } finally { resolve.mockRestore(); validate.mockRestore(); }
  });

  it('serves canonical media and colon-delimited blobrefs while refusing host paths and cross-session reads', async () => {
    const sessionId = await fixture.createSession(fixture.home!);
    const otherId = await fixture.createSession(fixture.home!);
    const token = await issueToken(sessionId, ['read']);
    const session = getLiveSessionById(fixture.server!.core.accessor, sessionId)!;
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
    await session.accessor.get(ISessionMediaStore).materialize({ fileId: 'f_example-image', name: 'example.png', size: bytes.byteLength, mimeType: 'image/png', stream: () => Readable.from([bytes]) });
    const core = fixture.server!.core;
    const workspaceId = session.accessor.get(ISessionContext).workspaceId;
    const scope = `${agentScopeOf(sessionScopeOf(workspacePersistenceScope(core.accessor.get(IBootstrapService).scope('sessions'), workspaceId), sessionId), 'main')}/blobs`;
    const hash = createHash('sha256').update(bytes).digest('hex');
    await core.accessor.get(IBlobStore).put(scope, hash, bytes);
    for (const fileId of ['f_example-image', `blobref:main:${hash}`]) {
      const root = `/api/sessions/${sessionId}/media/${fileId}`;
      const downloaded = await fetch(`${fixture.base}${root}`, { headers: { authorization: `Bearer ${token.token}` } });
      expect(downloaded.status, fileId).toBe(200);
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
      const preview = await fetch(`${fixture.base}${root}/preview?media_type=image/png`, { headers: { authorization: `Bearer ${token.token}` } });
      expect(preview.status, fileId).toBe(200);
      expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect((await request('GET', `/api/sessions/${otherId}/media/${fileId}`, token.token)).status).toBe(403);
    }
    for (const fileId of ['raw:example', 'inline-content:example', 'C:private.png']) {
      expect((await request('GET', `/api/sessions/${sessionId}/media/${fileId}`, token.token)).status).toBe(403);
    }
    for (const suffix of ['fs/list', 'terminals', 'document-preview', 'media-playback']) {
      expect((await request('GET', `/api/sessions/${sessionId}/${suffix}`, token.token)).status).toBe(403);
    }
  });

  it('steers inline image content with via, cancels only queued prompts, and confines agent targets to the bound session', async () => {
    const sessionId = await fixture.createSession(fixture.home!);
    const release = promiseGate<void>();
    await fixture.createHeldMainAgent(sessionId, release.promise);
    const token = await issueToken(sessionId, ['read', 'prompt', 'abort'], 'companion-panel');
    const mainPath = `/api/sessions/${sessionId}/prompts`;
    const active = await request<PromptReceipt>('POST', mainPath, token.token, { prompt_id: 'active-prompt', content: [{ type: 'text', text: 'Start a held turn.' }] });
    expect(active.body.code).toBe(0);
    const queued = await request<PromptReceipt>('POST', mainPath, token.token, { prompt_id: 'queued-prompt', content: [{ type: 'text', text: 'Cancel this queued prompt.' }] });
    expect(queued.body).toMatchObject({ code: 0, data: { status: 'queued' } });
    expect((await request('POST', `${mainPath}/${queued.body.data.prompt_id}:cancel`, token.token, {})).body).toMatchObject({ code: 0, data: { aborted: true } });
    expect((await request('POST', `${mainPath}/${active.body.data.prompt_id}:cancel`, token.token, {})).body).toMatchObject({ code: 0, data: { aborted: false } });
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
    const steered = await request<PromptReceipt>('POST', `${mainPath}:steer`, token.token, { prompt_id: 'steered-prompt', content: [{ type: 'text', text: 'Inspect the inline image.' }, { type: 'image_url', image_url: { url: image } }] });
    expect(steered.body.code, steered.body.msg).toBe(0);
    release.resolve();
    await vi.waitFor(async () => {
      const messages = await request<MessagePage>('GET', `/api/sessions/${sessionId}/messages`, token.token);
      expect(messages.body.data.items).toContainEqual(expect.objectContaining({ id: steered.body.data.user_message_id, metadata: { origin: { kind: 'user', via: { client: 'companion-panel', channel: 'owner' } } } }));
    });
    const child = await fixture.createHeldChild(sessionId);
    const childPrompt = await request('POST', mainPath, token.token, { agent_id: child.id, content: [{ type: 'text', text: 'An existing child is a valid target.' }, { type: 'image_url', image_url: { url: image } }] });
    expect(childPrompt.body.code, childPrompt.body.msg).toBe(0);
    expect((await request('POST', `${mainPath}:steer`, token.token, { agent_id: child.id, content: [{ type: 'text', text: 'Steer the existing child.' }] })).body.code).toBe(0);
    const tasks = await request<{ items: Array<{ id: string }> }>('GET', `/api/sessions/${sessionId}/tasks`, token.token);
    expect(tasks.body.data.items.length).toBeGreaterThan(0);
    expect((await request('GET', `/api/sessions/${sessionId}/tasks/${tasks.body.data.items[0]!.id}`, token.token)).body.code).toBe(0);
    const otherSession = await fixture.createSession(fixture.home!);
    const foreign = await getLiveSessionById(fixture.server!.core.accessor, otherSession)!.accessor.get(IAgentLifecycleService).create({ agentId: 'foreign-child', binding: { profile: 'agent', model: 'stub' } });
    for (const path of [mainPath, `${mainPath}:steer`]) {
      const denied = await request('POST', path, token.token, { agent_id: foreign.id, content: [{ type: 'text', text: 'A foreign child cannot be addressed.' }] });
      expect(denied.body).toMatchObject({ code: 40001, msg: expect.stringContaining('agent_id') });
      for (const url of ['file:///private/image.png', 'http://127.0.0.1/image.png', 'https://example.test/image.png', 'C:/private/image.png', 'data:text/plain;base64,SGVsbG8=', 'data:image/png;base64,@@@']) {
        expect((await request('POST', path, token.token, { content: [{ type: 'image_url', image_url: { url } }] })).body).toMatchObject({ code: 40001 });
      }
    }
    for (const suffix of ['approvals/example:approve', 'questions/example:answer', 'prompts/example:replace', 'prompts/example:abort', 'model', 'permission_mode']) {
      expect((await request('POST', `/api/sessions/${sessionId}/${suffix}`, token.token, {})).status).toBe(403);
    }
  });

  it('expires owner-issued tokens using the injectable session-access clock', async () => {
    await fixture.server!.close();
    let now = Date.now();
    fixture.server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: fixture.home!,
      logLevel: 'silent',
      sessionAccessClock: () => now,
    });
    fixture.base = `http://127.0.0.1:${fixture.server.port}`;
    const sessionId = await fixture.createSession(fixture.home!);
    const token = await issueToken(sessionId, ['read'], 'expiring-rest-fixture', 60);
    now += 60_001;
    const rejected = await request('GET', `/api/sessions/${sessionId}`, token.token);
    expect(rejected.status).toBe(401);
    expect(rejected.body.code).toBe(40101);
  });
});
