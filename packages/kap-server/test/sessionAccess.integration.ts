import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { getLiveSessionById, IAgentLifecycleService, IAgentLoopService, IWorkAdmissionService } from '@kiki/agent-core-v2';
import { describe, expect, it } from 'vitest';
import { startServer } from '../src/start';
import { bearerToken } from './helpers/auth';
import { type Envelope, usePromptFixture } from './helpers/promptFixture';
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
      `/api/sessions/${sessionId}/approvals?status=pending`,
      `/api/sessions/${sessionId}/questions?status=pending`,
    ];
    for (const path of allowedReads) {
      const result = await request('GET', path, token.token);
      expect(result.status, path).toBe(200);
      expect(result.body.code, `${path}: ${result.body.msg}`).toBe(0);
    }

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
      await request('GET', '/api/session-access', token.token),
      await request('POST', `/api/sessions/${sessionId}/prompts`, token.token, { content: [{ type: 'text', text: 'not allowed' }] }),
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
      agent_id: 'child', content: [{ type: 'text', text: 'Only main may be targeted.' }],
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
