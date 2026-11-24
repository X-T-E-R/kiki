import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { getLiveSessionById, IAgentLifecycleService, IAgentLoopService, IAgentProfileService, IModelService, IProviderService, ISessionAgentProfileCatalog, SessionAgentProfileCatalogService, AGENT_PROFILE_SOURCE_PRIORITY, ISessionMediaStore, ISessionContext, IBlobStore, IBootstrapService, agentScopeOf, sessionScopeOf, workspacePersistenceScope, IAgentExecutorRegistry, closeSessionById, IWorkAdmissionService, IFileSystemStorageService, IAgentContextMemoryService, IAgentTokenCountingService, ISessionApprovalService, ISessionInteractionService, ISessionQuestionService, IAgentFullCompactionService, IAgentConversationUndoService } from '@kiki/agent-core-v2';
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
  session_access: 2;
}

interface SessionAccessListing {
  version: 2;
  enabled: boolean;
  terminal_handoff: boolean;
  terminal_control: boolean;
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
    scopes: Array<'read' | 'prompt' | 'abort' | 'interact' | 'control'>,
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
    expect(issued.body.data).toMatchObject({ session_id: sessionId, scopes, server_id: expect.any(String), server_version: expect.any(String), session_access: 2 });
    expect(issued.body.data.token).toMatch(/^ksa_[A-Za-z0-9_-]{43}$/);
    return issued.body.data;
  }

  it('issues, lists, revokes one token, and revokes all tokens through owner-only management routes', async () => {
    const sessionId = await fixture.createSession(fixture.home!);
    const first = await issueToken(sessionId, ['read']);
    const second = await issueToken(sessionId, ['read', 'prompt']);

    const listed = await request<SessionAccessListing>('GET', '/api/session-access', bearerToken(fixture.server!));
    expect(listed.body.code).toBe(0);
    expect(listed.body.data).toMatchObject({ version: 2, enabled: true, terminal_handoff: true, terminal_control: true });
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
      `/api/sessions/${sessionId}/models`,
      `/api/sessions/${sessionId}/agents/main/model-switches`,
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
    expect(foreignRefOnOwnPath.body.code, JSON.stringify(foreignRefOnOwnPath.body)).toBe(40401);
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
      `/api/sessions/${sessionId}/%2e/snapshot`,
      `/api/sessions/${sessionId}/%2e%2e/snapshot`,
      `/api/sessions/${sessionId}/snapshot%5cstatus`,
      `/api/sessions/${sessionId}/snapshot%00`,
      `/api/sessions/${sessionId}/snapshot%0d`,
      `/api/sessions/${sessionId}/snapshot%zz`,
      `/api/sessions/${sessionId}/snapshot%252fstatus`,
      `/api/sessions/${sessionId}/snapshot%252e%252e`,
    ];
    for (const path of paths) {
      const result = await rawRequest('GET', path, token.token);
      expect([400, 403], path).toContain(result.status);
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

  it.each([false, true])('inspects a pre-turn session without restoring it (permission pinned: %s)', async (pinned) => {
    const core = fixture.server!.core;
    const models = core.accessor.get(IModelService);
    await models.set('stub', { ...models.get('stub'), displayName: 'Example Model', usage: { main: { contextBudget: 80 } } });
    const sessionId = await fixture.createSession(fixture.home!, pinned);
    const session = getLiveSessionById(core.accessor, sessionId)!;
    const workspaceId = session.accessor.get(ISessionContext).workspaceId;
    const scope = sessionScopeOf(workspacePersistenceScope(core.accessor.get(IBootstrapService).scope('sessions'), workspaceId), sessionId);
    const storage = core.accessor.get(IFileSystemStorageService);
    const token = await issueToken(sessionId, ['read']);
    const path = `/api/sessions/${sessionId}`;
    expect((await request('GET', `${path}/status`, token.token)).body).toMatchObject({ code: 0, data: { max_context_tokens: 80 } });
    if (!pinned) {
      expect((await request('GET', `${path}/tasks`, token.token)).body.code).toBe(0);
      expect((await request('GET', `${path}/runtime`, token.token)).body).toMatchObject({ code: 0, data: { workspace_id: workspaceId, runtime_id: 'local' } });
      expect((await request('GET', `${path}/warnings`, token.token)).body).toMatchObject({ code: 0, data: { warnings: [] } });
      expect(session.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
    }
    await closeSessionById(core.accessor, sessionId);
    const before = await storage.read(scope, 'state.json');
    expect(JSON.parse(Buffer.from(before!).toString()).agents?.main !== undefined).toBe(pinned);
    expect((await request('GET', `${path}/status`, token.token)).body).toMatchObject({ code: 0, data: {
      busy: false, model: 'stub', model_name: 'Example Model', permission: pinned ? 'manual' : 'auto', plan_mode: false, context_tokens: 0, max_context_tokens: 80,
    } });
    expect((await request('GET', `${path}/warnings`, token.token)).body).toMatchObject({ code: 0, data: { warnings: [] } });
    expect((await request('GET', `${path}/runtime`, token.token)).body).toMatchObject({ code: 0, data: { workspace_id: workspaceId, runtime_id: 'local' } });
    expect((await request('GET', `${path}/tasks`, token.token)).body.code).toBe(0);
    expect((await request('GET', path, token.token)).body).toMatchObject({ code: 0, data: { agent_config: { model: 'stub' } } });
    expect(getLiveSessionById(core.accessor, sessionId)).toBeUndefined();
    expect(await storage.read(scope, 'state.json')).toEqual(before);
    if (!pinned) expect(await storage.size(agentScopeOf(scope, 'main'), 'wire.jsonl')).toBeUndefined();
  });

  it('preserves bound status facts across cold inspection without restoring the session', async () => {
    const core = fixture.server!.core;
    const models = core.accessor.get(IModelService);
    await models.set('stub-alt', { ...models.get('stub-alt'), usage: { main: { contextBudget: 80 } } });
    const sessionId = await fixture.createSession(fixture.home!);
    const session = getLiveSessionById(core.accessor, sessionId)!;
    const catalog = session.accessor.get(ISessionAgentProfileCatalog) as SessionAgentProfileCatalogService;
    catalog.setContribution('example-budget', { profiles: [{ ...catalog.getDefault(), contextBudget: 100 }] }, AGENT_PROFILE_SOURCE_PRIORITY.explicit);
    const main = session.accessor.get(IAgentLifecycleService).get('main')!;
    await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub-alt', thinking: 'high' });
    const context = main.accessor.get(IAgentContextMemoryService);
    context.append({ role: 'user', content: [{ type: 'text', text: 'A saved user message' }], toolCalls: [] });
    main.accessor.get(IAgentTokenCountingService).measured(context.get(), [], { inputOther: 60, inputCacheRead: 0, inputCacheCreation: 0, output: 5 });
    context.append({ role: 'assistant', content: [{ type: 'text', text: 'A saved response' }], toolCalls: [] });
    const owner = bearerToken(fixture.server!);
    const path = `/api/sessions/${sessionId}`;
    expect((await request('POST', `${path}/profile`, owner, { agent_config: { plan_mode: true } })).body.code).toBe(0);
    const token = await issueToken(sessionId, ['read']);
    const before = await request<Record<string, unknown>>('GET', `${path}/status`, token.token);
    expect(before.body).toMatchObject({ code: 0, data: { model: 'stub-alt', thinking_level: 'high', permission: 'manual', plan_mode: true, max_context_tokens: 80 } });
    expect(before.body.data['context_tokens']).toBeGreaterThan(65);
    const { context_breakdown: breakdown, ...persisted } = before.body.data;
    expect(breakdown).toBeDefined();
    await closeSessionById(core.accessor, sessionId);
    const cold = (await request<Record<string, unknown>>('GET', `${path}/status`, token.token)).body.data;
    expect(cold).toEqual(persisted);
    expect(cold['context_breakdown']).toBeUndefined();
    expect((await request('GET', `${path}/status`, token.token)).body.data).toEqual(persisted);
    expect(getLiveSessionById(core.accessor, sessionId)).toBeUndefined();
  });

  it.each([
    [false, undefined], [false, 'harness-id'], [true, undefined], [true, 'harness-id'],
  ] as const)('keeps the external default profile model opaque before Turn 1 (pinned: %s, model: %s)', async (pinned, model) => {
    const core = fixture.server!.core;
    const models = core.accessor.get(IModelService);
    await models.set('stub', { ...models.get('stub'), displayName: 'Example Model' });
    await writeFile(join(fixture.home!, 'SYSTEM.md'), `---\nexecutor: example-acp\n${model === undefined ? '' : `model_alias: ${model}\n`}---\nExternal default profile`);
    const sessionId = await fixture.createSession(fixture.home!, pinned);
    const lifecycle = getLiveSessionById(core.accessor, sessionId)!.accessor.get(IAgentLifecycleService);
    const main = lifecycle.get('main');
    expect(main !== undefined).toBe(pinned);
    const token = await issueToken(sessionId, ['read']);
    const path = `/api/sessions/${sessionId}`;
    const inspect = async () => {
      expect((await request('GET', path, token.token)).body).toMatchObject({ code: 0, data: {
        executor_id: 'example-acp', agent_config: { model: model ?? '' },
      } });
      const status = await request<Record<string, unknown>>('GET', `${path}/status`, token.token);
      expect(status.body).toMatchObject({ code: 0, data: { model_name: null } });
      expect(status.body.data['model']).toBe(model);
      expect(status.body.data['max_context_tokens']).toBeUndefined();
    };
    await inspect();
    expect(lifecycle.get('main')).toBe(main);
    expect(main?.accessor.get(IAgentProfileService).getModel()).toBe(pinned ? '' : undefined);
    await closeSessionById(core.accessor, sessionId);
    await inspect();
    expect(getLiveSessionById(core.accessor, sessionId)).toBeUndefined();
  });

  it.each(['stub', 'harness-id'])('keeps native defaults, aliases, and display names out of external harness inspection (%s)', async (model) => {
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
      const models = core.accessor.get(IModelService);
      await models.set('stub', { ...models.get('stub'), displayName: 'Example Model' });
      await models.set('fixture/harness-id', { ...models.get('stub'), displayName: 'Example Colliding Model' });
      expect(models.resolveId('harness-id')).toBe('fixture/harness-id');
      const catalog = session.accessor.get(ISessionAgentProfileCatalog) as SessionAgentProfileCatalogService;
      catalog.setContribution('example-harness', { profiles: [{ ...catalog.getDefault(), executor: 'example-acp' }] }, AGENT_PROFILE_SOURCE_PRIORITY.explicit);
      const token = await issueToken(sessionId, ['read']);
      const path = `/api/sessions/${sessionId}`;
      const read = () => request('GET', path, token.token);
      const status = () => request<Record<string, unknown>>('GET', `${path}/status`, token.token);
      expect((await read()).body).toMatchObject({ code: 0, data: { agent_config: { model: '' } } });
      const unbound = await status();
      expect(unbound.body).toMatchObject({ code: 0, data: { model_name: null } });
      expect(unbound.body.data['model']).toBeUndefined();
      expect(unbound.body.data['max_context_tokens']).toBeUndefined();
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      expect(lifecycle.get('main')).toBeUndefined();
      catalog.removeContribution('example-harness');
      const main = await lifecycle.create({ agentId: 'main' });
      const profile = main.accessor.get(IAgentProfileService);
      const execution = { executor: 'example-acp', profile: 'agent' } as const;
      await profile.bind({ execution });
      expect((await read()).body).toMatchObject({ code: 0, data: { agent_config: { model: '' } } });
      expect((await status()).body.data['model']).toBeUndefined();
      await profile.bind({ execution: { ...execution, overrides: { model } } });
      const binding = JSON.parse(JSON.stringify(profile.data().execution));
      const expectHarnessModel = async () => {
        expect((await read()).body).toMatchObject({ code: 0, data: { agent_config: { model, execution: binding } } });
        const bound = await status();
        expect(bound.body).toMatchObject({ code: 0, data: { model, model_name: null } });
        expect(bound.body.data['max_context_tokens']).toBeUndefined();
      };
      await expectHarnessModel();
      await closeSessionById(core.accessor, sessionId);
      await expectHarnessModel();
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
    const encodedBlobRef = await rawRequest('GET', `/api/sessions/${sessionId}/media/blobref%3Amain%3A${hash}`, token.token);
    expect(encodedBlobRef.status).toBe(200);
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

  it('supports v2 terminal-exchanged dialog controls end-to-end without leaking secrets or resuming cold sessions', async () => {
    const core = fixture.server!.core;
    const providers = core.accessor.get(IProviderService);
    const models = core.accessor.get(IModelService);
    const secretApiKey = 'sk-super-secret-fixture-key-987654321';
    const privateBaseUrl = 'https://private-gateway.internal.example.test/v1';
    await providers.set('fixture-secret-provider', {
      type: 'openai',
      baseUrl: privateBaseUrl,
      apiKey: secretApiKey,
      customHeaders: { 'x-internal-secret': 'header-secret-token' },
    });
    await models.set('stub', {
      ...models.get('stub'),
      provider: 'fixture-secret-provider',
      displayName: 'Stub Primary',
      supportEfforts: ['off', 'medium', 'high'],
      capabilities: ['thinking', 'tool_use'],
    });
    await models.set('stub-alt', {
      ...models.get('stub-alt'),
      provider: 'fixture-secret-provider',
      displayName: 'Stub Alternate',
      supportEfforts: ['off', 'low', 'high'],
      capabilities: ['thinking', 'image_in'],
    });

    const sessionId = await fixture.createSession(fixture.home!, false);
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
        session_id: sessionId,
        holder_id,
        challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
      });
      expect(ticket.body.code).toBe(0);
      const exchanged = await fetch(`${fixture.base}/api/session-access/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: ticket.body.data.ticket, verifier, client: { name: 'terminal-v2-fixture' } }),
      });
      const issued = await exchanged.json() as Envelope<SessionAccessIssue>;
      expect(issued.code).toBe(0);
      expect(issued.data.session_access).toBe(2);
      expect(issued.data.scopes).toEqual(['read', 'prompt', 'abort', 'interact', 'control']);
      const token = issued.data.token;

      const session = getLiveSessionById(core.accessor, sessionId)!;
      expect(session.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
      const preTurnModels = await request<{
        executor_id: string;
        current: { model: string | null; model_name: string | null; thinking: boolean | null; thinking_effort: string | null; permission_mode: string | null; plan_mode: boolean };
        models: Array<{ id: string; name: string; provider_id?: string; capabilities: string[]; supports_thinking: boolean; thinking_efforts: string[]; context_length?: number }>;
        quota_summary: unknown;
      }>('GET', `/api/sessions/${sessionId}/models`, token);
      expect(preTurnModels.status).toBe(200);
      expect(preTurnModels.body.code, preTurnModels.body.msg).toBe(0);
      expect(preTurnModels.body.data.executor_id).toBe('native');
      expect(preTurnModels.body.data.current).toMatchObject({
        model: 'stub',
        model_name: 'Stub Primary',
        plan_mode: false,
      });
      expect(preTurnModels.body.data.models).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'stub',
          name: 'Stub Primary',
          provider_id: 'fixture-secret-provider',
          supports_thinking: true,
          thinking_efforts: ['off', 'medium', 'high'],
        }),
        expect.objectContaining({
          id: 'stub-alt',
          name: 'Stub Alternate',
          provider_id: 'fixture-secret-provider',
          supports_thinking: true,
          thinking_efforts: ['off', 'low', 'high'],
        }),
      ]));
      const serializedModels = JSON.stringify(preTurnModels.body.data);
      expect(serializedModels).not.toContain(secretApiKey);
      expect(serializedModels).not.toContain(privateBaseUrl);
      expect(serializedModels).not.toContain('header-secret-token');
      expect(session.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();

      const preTurnCatalog = session.accessor.get(ISessionAgentProfileCatalog) as SessionAgentProfileCatalogService;
      preTurnCatalog.setContribution('v2-model-deny', {
        profiles: [{ ...preTurnCatalog.getDefault(), denyModels: ['stub-alt'] }],
      }, AGENT_PROFILE_SOURCE_PRIORITY.explicit);
      const restrictedModels = await request<typeof preTurnModels.body.data>('GET', `/api/sessions/${sessionId}/models`, token);
      expect(restrictedModels.body.code).toBe(0);
      expect(restrictedModels.body.data.models.map((item) => item.id)).toContain('stub');
      expect(restrictedModels.body.data.models.map((item) => item.id)).not.toContain('stub-alt');
      preTurnCatalog.removeContribution('v2-model-deny');
      expect(session.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();

      await closeSessionById(core.accessor, sessionId);
      expect(getLiveSessionById(core.accessor, sessionId)).toBeUndefined();
      const coldModels = await request<typeof preTurnModels.body.data>('GET', `/api/sessions/${sessionId}/models`, token);
      expect(coldModels.status).toBe(200);
      expect(coldModels.body.code).toBe(0);
      expect(coldModels.body.data.current.model).toBe('stub');
      expect(JSON.stringify(coldModels.body.data)).not.toContain(secretApiKey);
      expect(JSON.stringify(coldModels.body.data)).not.toContain(privateBaseUrl);
      expect(getLiveSessionById(core.accessor, sessionId)).toBeUndefined();

      const coldSwitchList = await request<unknown[]>('GET', `/api/sessions/${sessionId}/agents/main/model-switches`, token);
      expect(coldSwitchList.body, coldSwitchList.body.msg).toMatchObject({ code: 0, data: [] });
      const coldSwitchGet = await request<unknown>('GET', `/api/sessions/${sessionId}/agents/main/model-switches/missing-op`, token);
      expect(coldSwitchGet.body, coldSwitchGet.body.msg).toMatchObject({ code: 0, data: null });
      expect(getLiveSessionById(core.accessor, sessionId)).toBeUndefined();

      const updatedProfile = await request<Record<string, unknown>>('POST', `/api/sessions/${sessionId}/profile`, token, {
        agent_config: {
          model: 'stub-alt',
          thinking_effort: 'high',
          permission_mode: 'manual',
          plan_mode: true,
        },
      });
      expect(updatedProfile.status).toBe(200);
      expect(updatedProfile.body.code, updatedProfile.body.msg).toBe(0);
      const afterProfileModels = await request<typeof preTurnModels.body.data>('GET', `/api/sessions/${sessionId}/models`, token);
      expect(afterProfileModels.body.code).toBe(0);
      expect(afterProfileModels.body.data.current).toMatchObject({
        model: 'stub-alt',
        model_name: 'Stub Alternate',
        thinking: true,
        thinking_effort: 'high',
        permission_mode: 'manual',
        plan_mode: true,
      });

      const queuedSwitch = await request<{ operationId: string; toModel: string; state: string }>(
        'POST',
        `/api/sessions/${sessionId}/agents/main/model-switches`,
        token,
        { operationId: 'v2-switch-1', model: 'stub', mode: 'direct', thinking: 'medium' },
      );
      expect(queuedSwitch.status).toBe(200);
      expect(queuedSwitch.body.code, queuedSwitch.body.msg).toBe(0);
      expect(queuedSwitch.body.data).toMatchObject({ operationId: 'v2-switch-1', toModel: 'stub' });
      const switchRead = await request<{ operationId: string; toModel: string }>(
        'GET',
        `/api/sessions/${sessionId}/agents/main/model-switches/v2-switch-1`,
        token,
      );
      expect(switchRead.body).toMatchObject({ code: 0, data: { operationId: 'v2-switch-1', toModel: 'stub' } });
      const switchList = await request<Array<{ input: { operationId: string } }>>(
        'GET',
        `/api/sessions/${sessionId}/agents/main/model-switches`,
        token,
      );
      expect(switchList.body.code).toBe(0);

      const liveSession = getLiveSessionById(core.accessor, sessionId)!;
      liveSession.accessor.get(ISessionInteractionService).acquireConsumer('session-access-v2-test');

      const approvalDecision = liveSession.accessor.get(ISessionApprovalService).request({
        id: 'v2-approve-1',
        toolCallId: 'tc-v2-approve',
        toolName: 'Bash',
        action: 'run',
        display: { kind: 'command', command: 'echo ok' },
      });
      const resolvedApproval = await request<{ resolved: boolean }>(
        'POST',
        `/api/sessions/${sessionId}/approvals/v2-approve-1`,
        token,
        { decision: 'approved' },
      );
      expect(resolvedApproval.status).toBe(200);
      expect(resolvedApproval.body).toMatchObject({ code: 0, data: { resolved: true } });
      await expect(approvalDecision).resolves.toMatchObject({ decision: 'approved' });

      const answerResult = liveSession.accessor.get(ISessionQuestionService).request({
        id: 'q-v2-answer',
        toolCallId: 'tc-q-answer',
        questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      });
      const answered = await request<{ resolved: boolean }>(
        'POST',
        `/api/sessions/${sessionId}/questions/q-v2-answer`,
        token,
        { answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } } },
      );
      expect(answered.status).toBe(200);
      expect(answered.body).toMatchObject({ code: 0, data: { resolved: true } });
      await expect(answerResult).resolves.toMatchObject({ answers: { 'Proceed?': 'Yes' } });

      const dismissResult = liveSession.accessor.get(ISessionQuestionService).request({
        id: 'q-v2-dismiss',
        toolCallId: 'tc-q-dismiss',
        questions: [{ question: 'Cancel me?', options: [{ label: 'A' }] }],
      });
      const dismissed = await request<{ dismissed: boolean }>(
        'POST',
        `/api/sessions/${sessionId}/questions/q-v2-dismiss:dismiss`,
        token,
        {},
      );
      expect(dismissed.status).toBe(200);
      expect(dismissed.body.data).toMatchObject({ dismissed: true });
      await expect(dismissResult).resolves.toBeNull();

      const main = liveSession.accessor.get(IAgentLifecycleService).get('main')!;
      const compactSpy = vi.spyOn(main.accessor.get(IAgentFullCompactionService), 'begin').mockReturnValue(true);
      const compacted = await request<{ accepted: boolean; source: string }>(
        'POST',
        `/api/sessions/${sessionId}:compact`,
        token,
        { instruction: 'Keep key decisions', strategy: 'summarize' },
      );
      expect(compacted.status).toBe(200);
      expect(compacted.body).toMatchObject({ code: 0, data: { accepted: true, source: 'manual' } });
      expect(compactSpy).toHaveBeenCalledWith({ source: 'manual', instruction: 'Keep key decisions', strategy: 'summarize' });
      compactSpy.mockRestore();

      const undoSpy = vi.spyOn(main.accessor.get(IAgentConversationUndoService), 'undo').mockResolvedValue(undefined as never);
      const undone = await request<{ messages: unknown; status: unknown }>(
        'POST',
        `/api/sessions/${sessionId}:undo`,
        token,
        { count: 1 },
      );
      expect(undone.status).toBe(200);
      expect(undone.body.code, undone.body.msg).toBe(0);
      expect(undoSpy).toHaveBeenCalledWith(1);
      undoSpy.mockRestore();
    } finally {
      await reader.cancel();
    }
  });

  it('enforces v2 negative security boundaries for scopes, cross-session isolation, profile allowlists, SSH approvals, and dangerous actions', async () => {
    const sessionId = await fixture.createSession(fixture.home!);
    const otherSessionId = await fixture.createSession(fixture.home!);
    const fullToken = await issueToken(sessionId, ['read', 'prompt', 'abort', 'interact', 'control']);
    const readOnlyToken = await issueToken(sessionId, ['read']);
    const interactOnlyToken = await issueToken(sessionId, ['interact']);
    const controlOnlyToken = await issueToken(sessionId, ['control']);

    const crossSessionDenied = [
      await request('GET', `/api/sessions/${otherSessionId}/models`, fullToken.token),
      await request('POST', `/api/sessions/${otherSessionId}/profile`, fullToken.token, { agent_config: { plan_mode: true } }),
      await request('GET', `/api/sessions/${otherSessionId}/agents/main/model-switches`, fullToken.token),
      await request('POST', `/api/sessions/${otherSessionId}/agents/main/model-switches`, fullToken.token, { operationId: 'x', model: 'stub', mode: 'direct' }),
      await request('POST', `/api/sessions/${otherSessionId}/approvals/example`, fullToken.token, { decision: 'approved' }),
      await request('POST', `/api/sessions/${otherSessionId}/questions/example`, fullToken.token, { answers: {} }),
      await request('POST', `/api/sessions/${otherSessionId}:compact`, fullToken.token, {}),
      await request('POST', `/api/sessions/${otherSessionId}:undo`, fullToken.token, {}),
    ];
    for (const res of crossSessionDenied) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 40101, msg: 'session_access_scope' });
    }

    const missingScopeDenied = [
      await request('POST', `/api/sessions/${sessionId}/profile`, readOnlyToken.token, { agent_config: { plan_mode: true } }),
      await request('POST', `/api/sessions/${sessionId}/approvals/example`, readOnlyToken.token, { decision: 'approved' }),
      await request('POST', `/api/sessions/${sessionId}/questions/example`, readOnlyToken.token, { answers: {} }),
      await request('POST', `/api/sessions/${sessionId}/agents/main/model-switches`, readOnlyToken.token, { operationId: 'x', model: 'stub', mode: 'direct' }),
      await request('POST', `/api/sessions/${sessionId}:compact`, readOnlyToken.token, {}),
      await request('POST', `/api/sessions/${sessionId}:undo`, readOnlyToken.token, {}),
      await request('POST', `/api/sessions/${sessionId}/profile`, interactOnlyToken.token, { agent_config: { plan_mode: true } }),
      await request('POST', `/api/sessions/${sessionId}:compact`, interactOnlyToken.token, {}),
      await request('POST', `/api/sessions/${sessionId}:undo`, interactOnlyToken.token, {}),
      await request('POST', `/api/sessions/${sessionId}/approvals/example`, controlOnlyToken.token, { decision: 'approved' }),
      await request('POST', `/api/sessions/${sessionId}/questions/example`, controlOnlyToken.token, { answers: {} }),
    ];
    for (const res of missingScopeDenied) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 40101, msg: 'session_access_scope' });
    }

    const alwaysRefused = [
      await request('POST', `/api/sessions/${sessionId}/ssh/approvals/example`, fullToken.token, { decision: 'approved' }),
      await request('POST', `/api/sessions/${sessionId}:fork`, fullToken.token, {}),
      await request('POST', `/api/sessions/${sessionId}:archive`, fullToken.token, {}),
      await request('POST', `/api/sessions/${sessionId}:restore`, fullToken.token, {}),
      await request('POST', `/api/sessions/${sessionId}:delete-archived`, fullToken.token, {}),
      await request('POST', `/api/sessions/${sessionId}:btw`, fullToken.token, {}),
      await request('POST', `/api/sessions/${sessionId}:branch`, fullToken.token, {}),
      await request('GET', '/api/models', fullToken.token),
      await request('GET', '/api/providers', fullToken.token),
      await request('GET', '/api/config', fullToken.token),
      await request('GET', '/api/session-access', fullToken.token),
    ];
    for (const res of alwaysRefused) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 40101, msg: 'session_access_scope' });
    }

    const forbiddenProfileBodies: Array<[Record<string, unknown>, string]> = [
      [{ title: 'hijack' }, 'title'],
      [{ private: true }, 'private'],
      [{ metadata: { cwd: '/tmp' } }, 'metadata'],
      [{ delivery: 'message' }, 'delivery'],
      [{ permission_rules: [] }, 'permission_rules'],
      [{}, 'agent_config'],
      [{ agent_config: {} }, 'agent_config'],
      [{ agent_config: { profile: 'other' } }, 'agent_config.profile'],
      [{ agent_config: { executor: 'codex' } }, 'agent_config.executor'],
      [{ agent_config: { execution: { executor: 'codex' } } }, 'agent_config.execution'],
      [{ agent_config: { additional_dirs: ['/etc'] } }, 'agent_config.additional_dirs'],
      [{ agent_config: { plan_gate: 'free' } }, 'agent_config.plan_gate'],
      [{ agent_config: { goal_objective: 'nope' } }, 'agent_config.goal_objective'],
    ];
    for (const [body, expectedField] of forbiddenProfileBodies) {
      const res = await request('POST', `/api/sessions/${sessionId}/profile`, fullToken.token, body);
      expect(res.status, expectedField).toBe(200);
      expect(res.body.code, expectedField).toBe(40001);
      expect(res.body.msg, expectedField).toContain(expectedField);
    }

    const badSwitchBody = await request('POST', `/api/sessions/${sessionId}/agents/main/model-switches`, fullToken.token, {
      operationId: 'bad-1',
      model: 'stub',
      mode: 'direct',
      profile: 'evil',
    });
    expect(badSwitchBody.status).toBe(200);
    expect(badSwitchBody.body.code).toBe(40001);
    expect(badSwitchBody.body.msg).toContain('profile');

    const foreignAgentSwitch = await request('POST', `/api/sessions/${sessionId}/agents/unknown_child/model-switches`, fullToken.token, {
      operationId: 'bad-agent',
      model: 'stub',
      mode: 'direct',
    });
    expect(foreignAgentSwitch.body.code).toBe(40001);
    expect(foreignAgentSwitch.body.msg).toContain('agent_id');

    const badCompactBody = await request('POST', `/api/sessions/${sessionId}:compact`, fullToken.token, { unexpected: true });
    expect(badCompactBody.body.code).toBe(40001);
    expect(badCompactBody.body.msg).toContain('unexpected');

    const badUndoBody = await request('POST', `/api/sessions/${sessionId}:undo`, fullToken.token, { unexpected: true });
    expect(badUndoBody.body.code).toBe(40001);
    expect(badUndoBody.body.msg).toContain('unexpected');

    const withOrigin = await request('POST', `/api/sessions/${sessionId}/profile`, fullToken.token, { agent_config: { plan_mode: true } }, { origin: 'http://example.test' });
    expect(withOrigin.status).toBe(401);
    expect(withOrigin.body.code).toBe(40101);
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
